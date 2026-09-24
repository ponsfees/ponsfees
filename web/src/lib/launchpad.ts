import { parseAbi, formatUnits, keccak256, encodeAbiParameters, type Address } from 'viem'
import { ENV, publicClient } from './chain.ts'
import { NATIVE, pairBy } from './pairs.ts'
import { marketCapInPair, capUsdScaled } from './marketCap.ts'
import { poolPrice } from './token.ts'
import { usdPerAsset } from './usdPrice.ts'

/**
 * The FEES launchpad on Robinhood Chain, and everything the site reads off it.
 *
 * ⭐⭐ WHY THE SITE HAS NO INDEXER. RHC makes a block roughly every 100ms and the public RPC caps
 * `eth_getLogs` at 2,000 blocks, about three minutes. `FeesLaunchpad` keeps an on-chain ARRAY, read
 * with `eth_call`: nothing to fall behind, no cursor to lose.
 */
export const LAUNCHPAD = (ENV?.VITE_LAUNCHPAD || '') as Address | ''
export const CLAIMS = (ENV?.VITE_CLAIMS || '') as Address | ''
export const PONS_FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e' as Address
export const LAUNCH_CONFIG_ID = 0n

export const isLive = () => /^0x[0-9a-fA-F]{40}$/.test(LAUNCHPAD)

export const LAUNCHPAD_ABI = parseAbi([
  'struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }',
  'struct LaunchParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }',
  'struct Share { uint8 provider; uint16 bps; address wallet; uint256 accountId; bytes32 beneficiary; }',
  'struct DevBuy { uint256 quoteIn; uint256 minTokensOut; }',
  'struct Entry { address token; address curve; address splitter; address creator; address pairToken; uint64 launchedAt; }',
  'function launch(LaunchParams params, uint256 launchConfigId, address pairToken, Share[] shares, DevBuy devBuy, address[] snipeTaxExemptions) payable returns (address token, address curve, address splitter)',
  'function count() view returns (uint256)',
  'function page(uint256 offset, uint256 limit) view returns (Entry[])',
  'function entryOf(address token) view returns (Entry)',
  'function isLaunch(address token) view returns (bool)',
  'error LaunchesClosed()',
  'error ZeroAddress()',
  'error PairTokenNotApproved(address pairToken)',
  'error EconomicsMoved(bytes32 pinned, bytes32 live)',
  'error DevBuyUnavailable()',
  'error NotOurLaunch(address token)',
  'error BadShares()',
  'error BeneficiaryMismatch(bytes32 declared, bytes32 computed)',
  'error NativeValueMismatch(uint256 supplied, uint256 expected)',
])

export const SPLITTER_ABI = parseAbi([
  'struct Share { uint8 provider; uint16 bps; address wallet; uint256 accountId; bytes32 beneficiary; }',
  'function shares() view returns (Share[])',
  'function totalToWallets(address asset) view returns (uint256)',
  'function totalToAccounts(address asset) view returns (uint256)',
  'function pending() view returns (uint256 native, uint256 pair)',
  'function harvestAll()',
  'function sweepCurve(uint256 minBuybackTokensOut)',
])

export const CLAIMS_ABI = parseAbi([
  'function claimable(address launch, bytes32 beneficiary, address asset) view returns (uint256)',
  'function claim(address launch, bytes32 beneficiary, address asset, address recipient, uint256 amount, bytes32 salt, uint256 deadline, bytes signature)',
  'error IsPaused()',
  'error VoucherExpired()',
  'error VoucherAlreadyRedeemed()',
  'error BadSignature()',
  'error ExceedsShare(uint256 wanted, uint256 available)',
])

export const FACTORY_ABI = parseAbi([
  'function launchEnabled() view returns (bool)',
  'function launchFee() view returns (uint256)',
  'function maxCreatorTaxBps() view returns (uint256)',
  'function previewLaunchEconomics(uint256 launchConfigId, address pairToken) view returns (bytes32)',
])

const CURVE_ABI = parseAbi([
  'function graduated() view returns (bool)',
  'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)',
])

const HOOK_ABI = parseAbi([
  'function launches(bytes32 poolId) view returns (bool registered, bool memecoinIsCurrency0, address memecoin, address quoteToken, address creator, address buybackCreatorRecipient, address protocolFeeRecipient, uint16 creatorTaxBps, uint16 protocolFeeShareBps, uint16 buybackBurnBps, uint16 hookFeeBps, uint16 maxInternalPriceImpactBps, bool buybackEnabled)',
])

/** Pons's V4 pool id: currencies sorted (native address(0) is always currency0), then the key. */
export function ponsPoolId(token: Address, pair: Address, fee: number, tickSpacing: number, hook: Address): `0x${string}` {
  const [c0, c1] = BigInt(pair) < BigInt(token) ? [pair, token] : [token, pair]
  return keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
    [c0, c1, fee, tickSpacing, hook],
  ))
}

/**
 * ⛔⛔ A WRONG POOL ID READS ZERO, IT DOES NOT REVERT, so a derivation that drifted would price a live
 * token at nothing and look exactly like the truth. The id is believed only when Pons's own hook
 * says it is registered AND names this memecoin.
 */
export async function verifiedPool(token: Address, pair: Address, fee: number, tickSpacing: number, hook: Address) {
  const id = ponsPoolId(token, pair, fee, tickSpacing, hook)
  const info = await publicClient.readContract({ address: hook, abi: HOOK_ABI, functionName: 'launches', args: [id] }).catch(() => null)
  return info && info[0] === true && info[2].toLowerCase() === token.toLowerCase() ? id : null
}

const CURVE_TIME_ABI = parseAbi(['function launchedAt() view returns (uint256)'])

/** The operator-set platform token, if any. ⚠ A failed read is null: fails closed. */
export async function fetchPlatformCa(): Promise<Address | null> {
  try {
    const r = await fetch('/api/platform')
    if (!r.ok) return null
    const body = (await r.json().catch(() => null)) as { token?: string | null } | null
    return body?.token && /^0x[0-9a-fA-F]{40}$/.test(body.token) ? (body.token as Address) : null
  } catch {
    return null
  }
}

/**
 * A Pons V2 launch that did not come through our launchpad, rendered exactly like one that did.
 * Everything is read off Pons's own factory and curve; nothing is invented. ⛔ `splitter` is the zero
 * address, and every page must show the real fee recipient instead of a splitter that does not exist.
 */
export async function readForeignLaunch(token: Address): Promise<Launch | null> {
  const rec = await publicClient.readContract({ address: PONS_FACTORY, abi: FACTORY_MIN_ABI, functionName: 'getLaunchedToken', args: [token] }).catch(() => null)
  if (!rec?.exists) return null
  const launchedAt = await publicClient.readContract({ address: rec.curve, abi: CURVE_TIME_ABI, functionName: 'launchedAt' }).catch(() => 0n)
  const base = await readLaunch({
    token, curve: rec.curve, splitter: '0x0000000000000000000000000000000000000000' as Address,
    creator: rec.deployer, pairToken: rec.pairToken, launchedAt,
  })
  return {
    ...base,
    shares: [{ provider: 0, bps: 10000, wallet: rec.creatorFeeRecipient, accountId: '0', beneficiary: '0x0000000000000000000000000000000000000000000000000000000000000000' }],
    paid: 0n,
    paidUsd: 0n,
    external: true,
  }
}

const FACTORY_MIN_ABI = parseAbi([
  'function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))',
  'function memeHook() view returns (address)',
])

const ERC20_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function logo() view returns (string)',
  'function description() view returns (string)',
])

/** 0 is a wallet. ⛔ Must match `FeeSplitter` and `api/identity.mjs` PROVIDER_CODE exactly. */
export type ShareProvider = 0 | 1 | 2 | 3
export const PROVIDER_NAME = { 1: 'x', 2: 'github', 3: 'twitch' } as const

export type Share = {
  provider: ShareProvider
  bps: number
  wallet: Address
  accountId: string
  beneficiary: `0x${string}`
}

export type Entry = {
  token: Address
  curve: Address
  splitter: Address
  creator: Address
  pairToken: Address
  launchedAt: bigint
}

/**
 * ⛔⛔ A LAUNCH HAS THREE PHASES, NOT A BOOLEAN. Read off `factory.getLaunchedToken().phase`:
 * 0 on the curve · 1 graduating (curve drained, the pool not seeded yet: nothing can price or trade
 * it) · 2 trading in the Uniswap V4 pool. `curve.graduated()` is true for both 1 and 2, which need
 * opposite things, so it is never the source of truth here.
 */
export const PHASE = { onCurve: 0, graduating: 1, pool: 2 } as const
export type Phase = 0 | 1 | 2

export const phaseLabel = (p: Phase) => (p === 0 ? 'On the curve' : p === 1 ? 'Graduating' : 'Trading on the pool')

export type Launch = Entry & {
  name: string
  symbol: string
  logo: string
  shares: Share[]
  /** Lifetime fees this launch has paid out, in its pair asset: wallets plus accounts. */
  paid: bigint
  /** `paid` in USD scaled by 1e6, or null when the pair asset cannot be priced right now. */
  paidUsd: bigint | null
  pairSymbol: string
  pairDecimals: number
  phase: Phase
  /** phase >= 1. Kept for sorting into sections; branch on `phase` for anything else. */
  graduated: boolean
  marketCapUsd: bigint | null
  /**
   * ⭐ The platform token when it was launched outside our launchpad (set by the operator, validated
   * on chain by the API). It has no splitter: its fees go straight to one wallet through Pons, so
   * `shares` is that wallet at 100% and `paid` is not knowable (0).
   */
  external?: boolean
  /** ⭐ The platform's own token ($FEES). Its card leaves out "Fees to". @see lib/gate.ts */
  platform?: boolean
}

export async function readFactoryState() {
  const f = { address: PONS_FACTORY, abi: FACTORY_ABI } as const
  const [enabled, fee, maxTax] = await Promise.all([
    publicClient.readContract({ ...f, functionName: 'launchEnabled' }),
    publicClient.readContract({ ...f, functionName: 'launchFee' }),
    publicClient.readContract({ ...f, functionName: 'maxCreatorTaxBps' }),
  ])
  return { enabled, fee, maxTax: Number(maxTax) }
}

/** ⚠ Read immediately before signing. A pin fetched minutes ago is stale by definition. */
export async function previewEconomics(pairToken: Address): Promise<`0x${string}`> {
  return publicClient.readContract({
    address: PONS_FACTORY, abi: FACTORY_ABI, functionName: 'previewLaunchEconomics', args: [LAUNCH_CONFIG_ID, pairToken],
  })
}

export const PAGE_SIZE = 50

/** ⛔⛔ The WHOLE registry, never a first page: Pons Charity once read `page(0, 24)` and lost its
 *  biggest launch from every dashboard. */
async function entries(): Promise<readonly Entry[]> {
  if (!isLive()) return []
  const total = (await publicClient.readContract({ address: LAUNCHPAD as Address, abi: LAUNCHPAD_ABI, functionName: 'count' })) as bigint
  if (total === 0n) return []
  const offsets: bigint[] = []
  for (let o = 0n; o < total; o += BigInt(PAGE_SIZE)) offsets.push(o)
  const pages = await Promise.all(offsets.map((o) =>
    publicClient.readContract({ address: LAUNCHPAD as Address, abi: LAUNCHPAD_ABI, functionName: 'page', args: [o, BigInt(PAGE_SIZE)] }) as Promise<readonly Entry[]>,
  ))
  return pages.flat()
}

const toShare = (s: { provider: number; bps: number; wallet: Address; accountId: bigint; beneficiary: `0x${string}` }): Share => ({
  provider: Number(s.provider) as ShareProvider,
  bps: Number(s.bps),
  wallet: s.wallet,
  accountId: s.accountId.toString(),
  beneficiary: s.beneficiary,
})

/** One launch, fully read. Shared by the register and the token page so they cannot disagree. */
export async function readLaunch(e: Entry): Promise<Launch> {
  const pair = pairBy(e.pairToken)
  const pairDec = pair?.decimals ?? 18
  const [name, symbol, logo, shares, toWallets, toAccounts, launched, totalSupply] = await Promise.all([
    publicClient.readContract({ address: e.token, abi: ERC20_ABI, functionName: 'name' }).catch(() => 'Unknown'),
    publicClient.readContract({ address: e.token, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => '???'),
    publicClient.readContract({ address: e.token, abi: ERC20_ABI, functionName: 'logo' }).catch(() => ''),
    publicClient.readContract({ address: e.splitter, abi: SPLITTER_ABI, functionName: 'shares' }).catch(() => []),
    publicClient.readContract({ address: e.splitter, abi: SPLITTER_ABI, functionName: 'totalToWallets', args: [e.pairToken] }).catch(() => 0n),
    publicClient.readContract({ address: e.splitter, abi: SPLITTER_ABI, functionName: 'totalToAccounts', args: [e.pairToken] }).catch(() => 0n),
    publicClient.readContract({ address: PONS_FACTORY, abi: FACTORY_MIN_ABI, functionName: 'getLaunchedToken', args: [e.token] }).catch(() => null),
    publicClient.readContract({ address: e.token, abi: ERC20_ABI, functionName: 'totalSupply' }).catch(() => 0n),
  ])

  /* ⭐ The factory's phase, with the curve's own flag only as a fallback when the factory read fails. */
  const curveGraduated = await publicClient.readContract({ address: e.curve, abi: CURVE_ABI, functionName: 'graduated' }).catch(() => false)
  const phase: Phase = launched?.exists ? (Math.min(2, Number(launched.phase)) as Phase) : curveGraduated ? PHASE.graduating : PHASE.onCurve
  const usdPerUnit = await usdPerAsset(e.pairToken, pairDec)

  /* ⛔⛔ THE PRICE SOURCE IS CHOSEN BY PHASE. The curve drains on graduation, so a curve-priced cap
     on a graduated launch reads a confident ZERO; phase 1 has no price at all (a dash, never $0);
     phase 2 is the V4 pool, through a pool id the hook has confirmed. */
  let capInPair: bigint | null = null
  if (phase === PHASE.onCurve) {
    const reserves = await publicClient.readContract({ address: e.curve, abi: CURVE_ABI, functionName: 'getReserves' }).catch(() => null)
    if (reserves) capInPair = marketCapInPair({ quoteReserve: reserves[0], tokenReserve: reserves[1], totalSupply, graduated: false })
  } else if (phase === PHASE.pool && launched) {
    const hook = await publicClient.readContract({ address: PONS_FACTORY, abi: FACTORY_MIN_ABI, functionName: 'memeHook' }).catch(() => null)
    const pool = hook ? await verifiedPool(e.token, e.pairToken, Number(launched.poolFee), Number(launched.tickSpacing), hook as Address) : null
    if (pool && hook) {
      const price = await poolPrice(e.token, e.pairToken, Number(launched.poolFee), Number(launched.tickSpacing), hook as Address, 18, pairDec)
      if (price !== null && totalSupply > 0n) {
        const whole = price * (Number(totalSupply) / 1e18)
        if (Number.isFinite(whole) && whole > 0) capInPair = BigInt(Math.round(whole * 10 ** pairDec))
      }
    }
  }

  return {
    ...e,
    name: name as string,
    symbol: symbol as string,
    logo: logo as string,
    shares: (shares as readonly Parameters<typeof toShare>[0][]).map(toShare),
    paid: (toWallets as bigint) + (toAccounts as bigint),
    paidUsd: capUsdScaled((toWallets as bigint) + (toAccounts as bigint), pairDec, usdPerUnit),
    pairSymbol: pair?.symbol ?? (e.pairToken.toLowerCase() === NATIVE.toLowerCase() ? 'ETH' : 'TOKEN'),
    pairDecimals: pairDec,
    phase,
    graduated: phase >= PHASE.graduating,
    marketCapUsd: capUsdScaled(capInPair, pairDec, usdPerUnit),
  }
}

/** Every launch, newest first. ⚠ A read failure returns an empty list, never a throw: each section
 *  renders its own empty state and the launch form still works. */
export async function readLaunches(): Promise<Launch[]> {
  let ours: Launch[] = []
  try {
    ours = await Promise.all((await entries()).map(readLaunch))
  } catch {
    ours = []
  }
  /* ⭐ The platform token joins the list when it was launched elsewhere, sorted in by its real
     launch time, never twice. */
  const ca = await fetchPlatformCa()
  if (ca && !ours.some((l) => l.token.toLowerCase() === ca.toLowerCase())) {
    const ext = await readForeignLaunch(ca).catch(() => null)
    if (ext) ours = [...ours, ext].sort((a, b) => Number(b.launchedAt) - Number(a.launchedAt))
  }
  /* ⭐ Mark the platform token once, here, so every surface agrees on which one it is. The rule
     lives in gate.ts; imported lazily because gate.ts imports this module's types. */
  const { platformToken } = await import('./gate.ts')
  const pt = platformToken(ours)
  return pt ? ours.map((l) => (l.token === pt.token ? { ...l, platform: true } : l)) : ours
}

export async function readEntry(token: Address): Promise<Entry | null> {
  if (!isLive()) return null
  return (await publicClient.readContract({ address: LAUNCHPAD as Address, abi: LAUNCHPAD_ABI, functionName: 'entryOf', args: [token] })
    .catch(() => null)) as Entry | null
}

export const fmtAmount = (v: bigint, decimals: number, max = 4) => {
  const s = formatUnits(v, decimals)
  const n = Number(s)
  if (n === 0) return '0'
  if (n < 0.0001) return '<0.0001'
  return n.toLocaleString('en-US', { maximumFractionDigits: max })
}
