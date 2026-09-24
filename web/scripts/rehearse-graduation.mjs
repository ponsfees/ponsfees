/**
 * A launch's whole life on an anvil fork of Robinhood Chain, checked through the SITE'S OWN CODE
 * (web/src/lib) at every phase, not a copy of it:
 *
 *   launch with a real uploaded logo → phase 0 on the curve → buy until the curve completes →
 *   the KEEPER graduates it and seeds the pool → phase 2 priced from the V4 pool → a real swap in
 *   that pool through Uniswap's Universal Router → the keeper sweeps the POOL and harvests → the
 *   token page's figures move.
 *
 *   anvil --fork-url http://127.0.0.1:8899 --port 8546 --chain-id 4663
 *   (deploy with contracts/deploy.sh REHEARSAL=1, then)
 *   VITE_RHC_RPC=http://127.0.0.1:8546 VITE_LAUNCHPAD=0x… VITE_CLAIMS=0x… \
 *     node --experimental-strip-types scripts/rehearse-graduation.mjs
 *
 * ⛔ Refuses a real node (`anvil_nodeInfo` exists only on anvil).
 */

import { spawn } from 'node:child_process'
import { createPublicClient, createWalletClient, http, parseAbi, parseEther, keccak256, toBytes, encodeAbiParameters, encodePacked, encodeFunctionData, formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readLaunch, readEntry, PHASE } from '../src/lib/launchpad.ts'
import { readToken } from '../src/lib/token.ts'
import { formatUsd } from '../src/lib/marketCap.ts'
import { resolveImage } from '../src/lib/logo.ts'

const RPC = process.env.VITE_RHC_RPC
const LAUNCHPAD = process.env.VITE_LAUNCHPAD
const FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e'
const UNIVERSAL_ROUTER = '0x8876789976decbfcbbbe364623c63652db8c0904'
const LOGO = 'https://ponsfees.family/logos/d5d77ba0d694b69d32694e62171f202a.png'
const K = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
]
const WALLET_SHARE = '0x000000000000000000000000000000000000beef'
const chain = { id: 4663, name: 'fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } }
const pub = createPublicClient({ chain, transport: http(RPC) })
const walletOf = (k) => createWalletClient({ account: privateKeyToAccount(k), chain, transport: http(RPC) })

let failures = 0
const ok = (cond, msg) => { console.log(`${cond ? '✅' : '⛔'} ${msg}`); if (!cond) failures++ }

const PAD_ABI = parseAbi([
  'struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }',
  'struct LaunchParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }',
  'struct Share { uint8 provider; uint16 bps; address wallet; uint256 accountId; bytes32 beneficiary; }',
  'struct DevBuy { uint256 quoteIn; uint256 minTokensOut; }',
  'function launch(LaunchParams params, uint256 launchConfigId, address pairToken, Share[] shares, DevBuy devBuy, address[] snipeTaxExemptions) payable returns (address token, address curve, address splitter)',
  'struct Entry { address token; address curve; address splitter; address creator; address pairToken; uint64 launchedAt; }',
  'function page(uint256 offset, uint256 limit) view returns (Entry[])',
])
const FACTORY_ABI = parseAbi([
  'function launchFee() view returns (uint256)',
  'function previewLaunchEconomics(uint256, address) view returns (bytes32)',
  'function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))',
  'function memeHook() view returns (address)',
])
const CURVE_ABI = parseAbi([
  'function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256)',
  'function graduated() view returns (bool)',
])
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function logo() view returns (string)'])
const CLAIMS_ABI = parseAbi(['function claimable(address launch, bytes32 beneficiary, address asset) view returns (uint256)'])

const phaseOf = async (token) => Number((await pub.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'getLaunchedToken', args: [token] })).phase)

function keeper() {
  return new Promise((resolve, reject) => {
    const p = spawn('node', ['keeper.mjs'], {
      cwd: new URL('../../api/', import.meta.url).pathname,
      env: { ...process.env, RHC_RPC: RPC, LAUNCHPAD, KEEPER_KEY: K[0], STATUS: '/tmp/fees-grad-status.json', MIN_NATIVE_WEI: '1' },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.on('close', (code) => {
      for (const line of out.trim().split('\n')) console.log(`   keeper | ${line.slice(0, 190)}`)
      code === 0 ? resolve(out) : reject(new Error(`keeper exited ${code}`))
    })
  })
}

async function show(label, token) {
  const entry = await readEntry(token)
  const l = await readLaunch(entry)
  console.log(`   site   | ${label}: phase ${l.phase} · graduated ${l.graduated} · cap ${formatUsd(l.marketCapUsd) ?? '—'} · paid ${formatEther(l.paid)} ETH · logo ${l.logo ? 'set' : 'EMPTY'}`)
  return l
}

async function main() {
  if (!RPC || !LAUNCHPAD) throw new Error('VITE_RHC_RPC and VITE_LAUNCHPAD are required')
  if (!(await pub.request({ method: 'anvil_nodeInfo' }).catch(() => null))) throw new Error('not anvil; refusing')

  const [launcher, , trader] = K.map(walletOf)
  const xId = '44196397'
  const shares = [
    { provider: 0, bps: 3000, wallet: WALLET_SHARE, accountId: 0n, beneficiary: '0x' + '00'.repeat(32) },
    { provider: 1, bps: 7000, wallet: '0x0000000000000000000000000000000000000000', accountId: BigInt(xId), beneficiary: keccak256(toBytes(`x:${xId}`)) },
  ]
  const fee = await pub.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'launchFee' })
  const econ = await pub.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'previewLaunchEconomics', args: [0n, '0x0000000000000000000000000000000000000000'] })
  const params = {
    name: 'Graduation Rehearsal', symbol: 'GRAD', logo: LOGO, description: 'Fees shared with @jack',
    socials: { twitter: '', telegram: '', discord: '', website: 'https://ponsfees.family', farcaster: '' },
    creatorFeeRecipient: '0x0000000000000000000000000000000000000000', creatorTaxBps: 0, buybackEnabled: false,
    expectedEconomics: econ, salt: keccak256(toBytes(`grad-${Date.now()}`)),
  }
  const h = await launcher.writeContract({ address: LAUNCHPAD, abi: PAD_ABI, functionName: 'launch', args: [params, 0n, '0x0000000000000000000000000000000000000000', shares, { quoteIn: 0n, minTokensOut: 0n }, []], value: fee })
  await pub.waitForTransactionReceipt({ hash: h })
  const [entry] = await pub.readContract({ address: LAUNCHPAD, abi: PAD_ABI, functionName: 'page', args: [0n, 1n] })
  const token = entry.token

  // ── logo ─────────────────────────────────────────────────────────────────────────────────
  const onChainLogo = await pub.readContract({ address: token, abi: ERC20, functionName: 'logo' })
  ok(onChainLogo === LOGO, `logo on chain is exactly what was sent (${onChainLogo.length} bytes)`)
  const img = await fetch(resolveImage(onChainLogo))
  ok(img.ok && (img.headers.get('content-type') ?? '').startsWith('image/'), `the site resolves it and it serves an image (${img.status} ${img.headers.get('content-type')})`)

  // ── phase 0 ──────────────────────────────────────────────────────────────────────────────
  await pub.request({ method: 'evm_increaseTime', params: [10] }); await pub.request({ method: 'evm_mine', params: [] })
  await pub.waitForTransactionReceipt({ hash: await trader.writeContract({ address: entry.curve, abi: CURVE_ABI, functionName: 'buy', args: [parseEther('0.3'), 0n, trader.account.address], value: parseEther('0.3') }) })
  const p0 = await show('on the curve', token)
  ok(p0.phase === 0 && !p0.graduated, 'phase 0 reads as on the curve')
  ok(p0.marketCapUsd !== null && p0.marketCapUsd > 0n, 'market cap priced from the curve')

  // ── complete the curve ───────────────────────────────────────────────────────────────────
  const rec = await pub.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'getLaunchedToken', args: [token] })
  console.log(`   chain  | graduation threshold ${formatEther(rec.graduationThreshold)} ETH`)
  for (let i = 0; i < 12 && !(await pub.readContract({ address: entry.curve, abi: CURVE_ABI, functionName: 'graduated' })); i++) {
    const r = await trader.writeContract({ address: entry.curve, abi: CURVE_ABI, functionName: 'buy', args: [parseEther('1'), 0n, trader.account.address], value: parseEther('1') })
      .then((hash) => pub.waitForTransactionReceipt({ hash })).catch((e) => ({ status: e.shortMessage ?? e.message }))
    if (r.status !== 'success') { console.log(`   chain  | buy ${i + 1}: ${String(r.status).slice(0, 80)}`); break }
  }
  const curveDone = await pub.readContract({ address: entry.curve, abi: CURVE_ABI, functionName: 'graduated' })
  const phaseAfterBuys = await phaseOf(token)
  console.log(`   chain  | after buys: curve.graduated ${curveDone}, factory phase ${phaseAfterBuys}`)
  ok(curveDone, 'the curve completed')
  const mid = await show('curve done', token)
  ok(mid.phase === phaseAfterBuys, `the site reports the factory's phase (${mid.phase}), not the curve's flag`)
  if (mid.phase === 1) ok(mid.marketCapUsd === null, 'phase 1 shows a dash, never $0')

  // ── the keeper finishes the graduation ───────────────────────────────────────────────────
  await keeper()
  if (await phaseOf(token) !== 2) await keeper()
  const final = await phaseOf(token)
  ok(final === 2, `the keeper took it to phase 2 (pool seeded), now ${final}`)
  const p2 = await show('in the pool', token)
  ok(p2.phase === 2 && p2.graduated, 'phase 2 reads as graduated')
  ok(p2.marketCapUsd !== null && p2.marketCapUsd > 0n, 'market cap priced from the V4 pool, not zero')

  // ── a real swap in the pool, then the keeper sweeps the POOL ────────────────────────────
  const hook = await pub.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'memeHook' })
  const r2 = await pub.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'getLaunchedToken', args: [token] })
  const zero = '0x0000000000000000000000000000000000000000'
  const key = { currency0: zero, currency1: token, fee: Number(r2.poolFee), tickSpacing: Number(r2.tickSpacing), hooks: hook }
  const amountIn = parseEther('0.5')
  const POOLKEY = { type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] }
  const swap = encodeAbiParameters(
    [{ type: 'tuple', components: [{ name: 'poolKey', ...POOLKEY }, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }, { name: 'sqrtPriceLimitX96', type: 'uint160' }, { name: 'hookData', type: 'bytes' }] }],
    [{ poolKey: key, zeroForOne: true, amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n, hookData: '0x' }],
  )
  const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [zero, amountIn])
  const take = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [token, 0n])
  const input = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [encodePacked(['uint8', 'uint8', 'uint8'], [0x06, 0x0c, 0x0f]), [swap, settle, take]])
  const data = encodeFunctionData({ abi: parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']), functionName: 'execute', args: [encodePacked(['uint8'], [0x10]), [input], BigInt(Math.floor(Date.now() / 1000) + 3600 * 24 * 30)] })
  const before = await pub.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [trader.account.address] })
  const sr = await pub.waitForTransactionReceipt({ hash: await trader.sendTransaction({ to: UNIVERSAL_ROUTER, data, value: amountIn }) })
  const after = await pub.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [trader.account.address] })
  ok(sr.status === 'success' && after > before, 'a real 0.5 ETH buy in the V4 pool through the Universal Router')

  const paidBefore = p2.paid
  await keeper()
  /* ⭐ A buy in the pool charges its fee in the MEMECOIN, which makes the sweep operator-only
     (InternalSwapRequiresOperator 0x31cdb504): our splitter may not sweep it. Pons's own
     feeSweepOperator sweeps graduated pools continuously on mainnet; here we play it, impersonating
     the real operator address read off the hook. minConversionQuoteOut is 1, never 0: a conversion
     runs and 0 reverts MinimumOutputRequired (0x3672d25f). */
  const HOOK_OP = parseAbi(['function feeSweepOperator() view returns (address)', 'function sweepPoolFees(bytes32 poolId, uint256 minConversionQuoteOut, uint256 minBuybackTokensOut)'])
  const operator = await pub.readContract({ address: hook, abi: HOOK_OP, functionName: 'feeSweepOperator' })
  const poolId = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [zero, token, key.fee, key.tickSpacing, hook]))
  await pub.request({ method: 'anvil_impersonateAccount', params: [operator] })
  await pub.request({ method: 'anvil_setBalance', params: [operator, '0xDE0B6B3A7640000'] })
  const opWallet = createWalletClient({ account: operator, chain, transport: http(RPC) })
  const swr = await pub.waitForTransactionReceipt({ hash: await opWallet.writeContract({ address: hook, abi: HOOK_OP, functionName: 'sweepPoolFees', args: [poolId, 1n, 0n] }) })
  ok(swr.status === 'success', `Pons's operator (${operator.slice(0, 10)}…) swept the pool, converting the token-side fee`)
  await keeper()
  const p3 = await show('after pool trade + keeper', token)
  ok(p3.paid > paidBefore, `pool fees were swept and paid out (${formatEther(paidBefore)} → ${formatEther(p3.paid)} ETH)`)
  const xOwed = await pub.readContract({ address: process.env.VITE_CLAIMS, abi: CLAIMS_ABI, functionName: 'claimable', args: [token, keccak256(toBytes(`x:${xId}`)), zero] })
  ok(xOwed > 0n, `the X account's share is claimable (${formatEther(xOwed)} ETH)`)

  // ── the token page's own reader, at the end ─────────────────────────────────────────────
  const t = await readToken(token)
  ok(t && t.phase === 2 && t.logo === LOGO && t.unclaimed.some((u) => u && u > 0n), 'token page: phase 2, logo intact, unclaimed share shown')

  console.log(failures === 0 ? '\nGRADUATION REHEARSAL PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(`⛔ ${e.shortMessage ?? e.message}`); process.exit(1) })
