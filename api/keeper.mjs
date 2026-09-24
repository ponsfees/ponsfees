/**
 * The FEES keeper: sweeps and harvests every launch's splitter so fees reach wallets and accounts
 * without anybody pressing a button.
 *
 *   node keeper.mjs            one pass (systemd `fees-keeper.timer` runs this every 15 minutes)
 *   node keeper.mjs --dry      one pass that reads everything and SENDS NOTHING
 *
 * ## What it does per launch
 *
 * 1. **Sweep**: fees sit on the bonding curve, or after graduation in Pons's V4 hook, until the
 *    launch's fee recipient sweeps them into the escrow. The splitter is that recipient.
 * 2. **Harvest**: `harvestAll()` claims the escrow and splits everything the splitter holds,
 *    pushing wallet shares and crediting account shares in {FeesClaims}.
 *
 * ## ⭐⭐ THE KEY HERE CAN MOVE NOTHING BUT GAS
 *
 * Every call it makes is permissionless on the splitter. The key only pays gas: a leaked keeper key
 * costs its own ETH balance and cannot redirect a single fee.
 *
 * ## ⛔⛔ TRAPS ALREADY PAID FOR ON PONS CHARITY
 *
 * - `sweepCurve` SUCCEEDS on an empty curve, so a simulate filters nothing. The charity keeper sent
 *   ~600 pointless transactions every pass until it asked the curve what it holds first.
 *   ⚠ Three balances, not one: fee, creator tax and pending buyback.
 * - A graduated launch's curve is dead and its fees accrue in the hook. A keeper that only knew the
 *   curve stopped harvesting the biggest launch the day it graduated, silently.
 * - One transient RPC failure aborted whole passes. Each launch is caught on its own.
 * - Only a CONFIRMED zero skips a step. A read that fails falls back to attempting it.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createWalletClient, encodeAbiParameters, formatEther, http, keccak256, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { client, readRegistry, rhc, RHC_RPC, BROWSER_UA, SPLITTER_ABI, ZERO } from './chain.mjs'

const DRY = process.argv.includes('--dry')
const LAUNCHPAD = process.env.LAUNCHPAD ?? ''
const STATUS = process.env.STATUS ?? '/var/lib/fees/status.json'
/* ⚠ A sweep or harvest below this is not worth its gas. ~0.0003 ETH is a crank on RHC. */
const MIN_NATIVE_WEI = BigInt(process.env.MIN_NATIVE_WEI ?? '500000000000000')
const LOW_GAS_WEI = BigInt(process.env.LOW_GAS_WEI ?? '20000000000000000')

export const PONS_FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e'
export const PHASE = { onCurve: 0, swept: 1, poolCreated: 2 }

const FACTORY_ABI = parseAbi([
  'function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))',
  'function memeHook() view returns (address)',
  'function graduate(address token)',
  'function createGraduatedPool(address token) returns (uint256 positionId)',
])
const CURVE_STATE_ABI = parseAbi(['function graduated() view returns (bool)'])
const HOOK_ABI = parseAbi([
  'function launches(bytes32 poolId) view returns (bool registered, bool memecoinIsCurrency0, address memecoin, address quoteToken, address creator, address buybackCreatorRecipient, address protocolFeeRecipient, uint16 creatorTaxBps, uint16 protocolFeeShareBps, uint16 buybackBurnBps, uint16 hookFeeBps, uint16 maxInternalPriceImpactBps, bool buybackEnabled)',
  'function pendingFees(bytes32 poolId, address currency) view returns (uint256)',
  'function pendingCreatorTax(bytes32 poolId, address currency) view returns (uint256)',
  'function pendingBuyback(bytes32 poolId, address currency) view returns (uint256)',
])
const CURVE_FEE_ABI = parseAbi([
  'function quoteFeeBalance() view returns (uint256)',
  'function creatorTaxBalance() view returns (uint256)',
  'function buybackQuoteBalance() view returns (uint256)',
])
const ERC20_ABI = parseAbi(['function balanceOf(address) view returns (uint256)'])

/** Pons V4 pool id: currencies sorted, then (c0, c1, fee, tickSpacing, hook). Proven on charity. */
export function poolIdFor({ token, pairToken, poolFee, tickSpacing, hook }) {
  const [c0, c1] = pairToken.toLowerCase() < token.toLowerCase() ? [pairToken, token] : [token, pairToken]
  return keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
    [c0, c1, poolFee, tickSpacing, hook],
  ))
}

/** Only a confirmed zero skips. `null` (the read failed) keeps the step. */
export const worthIt = (amount, min = 1n) => amount === null || amount >= min

/**
 * Where this launch's fees are waiting, and whether we are allowed to move them.
 *
 * ⛔ A pending buyback or token-denominated fee makes the WHOLE pool sweep operator-only, quote leg
 * included. Pons's operator sweeps those; nothing is lost, it just is not ours to move.
 */
async function sweepPlan(l) {
  const [record, hook] = await Promise.all([
    client.readContract({ address: PONS_FACTORY, abi: FACTORY_ABI, functionName: 'getLaunchedToken', args: [l.token] }).catch(() => null),
    client.readContract({ address: PONS_FACTORY, abi: FACTORY_ABI, functionName: 'memeHook' }).catch(() => null),
  ])
  const phase = record?.exists ? Number(record.phase) : null

  if (phase === PHASE.poolCreated && hook) {
    const poolId = poolIdFor({
      token: l.token, pairToken: l.pairToken, poolFee: Number(record.poolFee), tickSpacing: Number(record.tickSpacing), hook,
    })
    /* ⛔ A wrong pool id reports "no fees" without reverting, the failure that looks like success.
       Only a registered pool naming THIS memecoin is believed. */
    const info = await client.readContract({ address: hook, abi: HOOK_ABI, functionName: 'launches', args: [poolId] }).catch(() => null)
    if (!info || info[0] !== true || info[2].toLowerCase() !== l.token.toLowerCase()) {
      return { kind: 'none', note: 'graduated, but the pool id did not verify' }
    }
    const read = (currency, fn) => client.readContract({ address: hook, abi: HOOK_ABI, functionName: fn, args: [poolId, currency] }).catch(() => 0n)
    const [qFee, qTax, qBuy, mFee, mTax, mBuy] = await Promise.all([
      read(l.pairToken, 'pendingFees'), read(l.pairToken, 'pendingCreatorTax'), read(l.pairToken, 'pendingBuyback'),
      read(l.token, 'pendingFees'), read(l.token, 'pendingCreatorTax'), read(l.token, 'pendingBuyback'),
    ])
    const quote = qFee + qTax
    /* ⭐ A buy in the pool charges its fee in the MEMECOIN, which makes the whole sweep operator-only
       (InternalSwapRequiresOperator). Routine: Pons's feeSweepOperator sweeps graduated pools
       continuously, and the next pass here harvests what it credited. Noted, never an error. */
    if (qBuy > 0n || mFee + mTax + mBuy > 0n) {
      return { kind: 'none', note: 'pool fees are swept by Pons’s operator (token-side fees or a buyback pending); harvested here once credited' }
    }
    return { kind: 'pool', hook, poolId, amount: quote }
  }

  if (phase !== null && phase !== PHASE.onCurve) return { kind: 'none', note: '' }

  const amount = await Promise.all(
    ['quoteFeeBalance', 'creatorTaxBalance', 'buybackQuoteBalance'].map((fn) =>
      client.readContract({ address: l.curve, abi: CURVE_FEE_ABI, functionName: fn })),
  ).then((b) => b.reduce((a, x) => a + x, 0n)).catch(() => null)
  return { kind: 'curve', amount }
}

/** What harvesting would move: escrow ledgers plus anything already sitting in the splitter. */
async function harvestable(l) {
  const [pending, native, pairHeld, tokenHeld] = await Promise.all([
    client.readContract({ address: l.splitter, abi: SPLITTER_ABI, functionName: 'pending' }).catch(() => null),
    client.getBalance({ address: l.splitter }).catch(() => null),
    l.pairToken === ZERO ? 0n : client.readContract({ address: l.pairToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [l.splitter] }).catch(() => null),
    client.readContract({ address: l.token, abi: ERC20_ABI, functionName: 'balanceOf', args: [l.splitter] }).catch(() => null),
  ])
  if (pending === null || native === null || pairHeld === null || tokenHeld === null) return { unknown: true }
  return { native: pending[0] + native, pair: pending[1] + pairHeld, token: tokenHeld }
}

const isNativePair = (l) => l.pairToken.toLowerCase() === ZERO

export async function runPass() {
  if (!LAUNCHPAD) throw new Error('LAUNCHPAD is not set')
  const key = process.env.KEEPER_KEY
  if (!key && !DRY) throw new Error('KEEPER_KEY is not set (use --dry to read without sending)')

  const account = key ? privateKeyToAccount(key) : null
  const wallet = account
    ? createWalletClient({
        account, chain: rhc,
        transport: http(RHC_RPC, { fetchOptions: { headers: { 'User-Agent': BROWSER_UA } }, retryCount: 4 }),
      })
    : null

  const send = async (l, functionName, args, label) => {
    /* ⚠ Simulated first: a reverting transaction still costs gas. */
    const ok = await client.simulateContract({
      address: l.splitter, abi: SPLITTER_ABI, functionName, args, account: account ?? l.splitter,
    }).then(() => true).catch((err) => { console.log(`${l.token}  ${label} would revert: ${err.shortMessage ?? err.message}`); return false })
    if (!ok) return false
    if (DRY) { console.log(`${l.token}  [dry] would ${label}`); return true }
    const hash = await wallet.writeContract({ address: l.splitter, abi: SPLITTER_ABI, functionName, args })
    const receipt = await client.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`${label} reverted on chain: ${hash}`)
    console.log(`${l.token}  ${label}  ${hash}`)
    return true
  }

  const started = Date.now()
  const launches = await readRegistry(LAUNCHPAD)
  const tally = { launches: launches.length, swept: 0, harvested: 0, errors: 0, notes: [] }

  for (const l of launches) {
    /* ⛔⛔ Caught per launch. One flaky read must not abandon every launch after it. */
    try {
      /*
        ⛔⛔ GRADUATION IS TWO PERMISSIONLESS CALLS AND NOTHING MAKES ANYONE SEND THE SECOND.
        `graduate` sweeps a completed curve into the factory (phase 1); `createGraduatedPool` seeds
        the V4 pool (phase 2). Between them the token cannot be traded by anybody and has no price.
        Pons usually does both, but a launch that sits here looks graduated and is dead, so the
        keeper finishes the job for OUR launches. Simulated first: a call that would revert is
        never sent, and both are no-ops for anybody once done.
      */
      const record = await client.readContract({ address: PONS_FACTORY, abi: FACTORY_ABI, functionName: 'getLaunchedToken', args: [l.token] }).catch(() => null)
      const phase = record?.exists ? Number(record.phase) : null
      const curveDone = phase === PHASE.onCurve
        ? await client.readContract({ address: l.curve, abi: CURVE_STATE_ABI, functionName: 'graduated' }).catch(() => false)
        : false
      const step = curveDone ? 'graduate' : phase === PHASE.swept ? 'createGraduatedPool' : null
      if (step) {
        const ok = await client.simulateContract({
          address: PONS_FACTORY, abi: FACTORY_ABI, functionName: step, args: [l.token], account: account ?? l.splitter,
        }).then(() => true).catch((err) => { tally.notes.push(`${l.token}: ${step} would revert (${err.shortMessage ?? err.message})`); return false })
        if (ok && DRY) console.log(`${l.token}  [dry] would ${step}`)
        if (ok && !DRY) {
          const hash = await wallet.writeContract({ address: PONS_FACTORY, abi: FACTORY_ABI, functionName: step, args: [l.token] })
          const receipt = await client.waitForTransactionReceipt({ hash })
          console.log(`${l.token}  ${step}  ${receipt.status}  ${hash}`)
          if (receipt.status === 'success') tally.graduated = (tally.graduated ?? 0) + 1
        }
      }

      const plan = await sweepPlan(l)
      /* ⚠ The native threshold only makes sense for a native pair; an ERC-20 amount is in its own
         units, so any confirmed nonzero amount is swept. */
      const min = isNativePair(l) ? MIN_NATIVE_WEI : 1n
      if (plan.kind === 'curve' && worthIt(plan.amount, min)) {
        if (await send(l, 'sweepCurve', [0n], 'swept curve')) tally.swept++
      } else if (plan.kind === 'pool' && worthIt(plan.amount, min)) {
        if (await send(l, 'sweepPool', [plan.hook, plan.poolId, 0n, 0n], 'swept pool')) tally.swept++
      } else if (plan.note) {
        tally.notes.push(`${l.token}: ${plan.note}`)
      }

      const h = await harvestable(l)
      const due = h.unknown || h.native >= MIN_NATIVE_WEI || h.pair > 0n || h.token > 0n
      if (due && await send(l, 'harvestAll', [], 'harvested')) tally.harvested++
    } catch (err) {
      tally.errors++
      console.error(`${l.token}  ⛔ ${err.shortMessage ?? err.message}`)
    }
  }

  const gas = account ? await client.getBalance({ address: account.address }).catch(() => null) : null
  const lowGas = gas !== null && gas < LOW_GAS_WEI
  const status = {
    at: new Date().toISOString(),
    level: lowGas || tally.errors > 0 ? 'warn' : 'ok',
    detail: lowGas ? `keeper gas is low: ${formatEther(gas)} ETH` : tally.errors ? `${tally.errors} launches failed this pass` : 'cranking',
    keeper: account?.address ?? null,
    keeperGasEth: gas === null ? null : formatEther(gas),
    tookMs: Date.now() - started,
    ...tally,
  }
  if (!DRY) {
    mkdirSync(dirname(STATUS), { recursive: true })
    writeFileSync(STATUS, JSON.stringify(status, null, 2))
  }
  console.log(JSON.stringify(status))
  return status
}

/* ⚠ Configuration comes from the environment: systemd's EnvironmentFile on the box, or
   `node --env-file=.env keeper.mjs` by hand (`npm run keeper`). */
if (import.meta.url === `file://${process.argv[1]}`) {
  runPass().catch((err) => { console.error(`⛔ pass failed: ${err.message}`); process.exit(1) })
}
