import { encodeAbiParameters, keccak256, parseAbi, type Address } from 'viem'
import { publicClient } from './chain.ts'
import { NATIVE } from './pairs.ts'
import { CLAIMS, CLAIMS_ABI, PONS_FACTORY, SPLITTER_ABI, fetchPlatformCa, readEntry, readForeignLaunch, readLaunch, type Launch } from './launchpad.ts'

const POOL_MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951' as Address

const PM_ABI = parseAbi(['function extsload(bytes32 slot) view returns (bytes32)'])
const ERC20_ABI = parseAbi(['function description() view returns (string)', 'function decimals() view returns (uint8)'])
const FACTORY_ABI = parseAbi([
  'function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))',
])

/* ── V4 pool price, for a graduated token ─────────────────────────────────────────────────────
   ⚠ Same maths as the seller contract: poolId is keccak of the ordered key, and the pool's slot0
   sits at keccak(poolId, 6) in the singleton's storage. ⛔ `sqrtPriceX96` is up to 2^160, so
   squaring it in JS floats loses precision fast; the ratio is taken in float only at the end, and
   only because this figure is a display value, never an input to a transaction. */
export async function poolPrice(
  token: Address, pair: Address, fee: number, tickSpacing: number, hooks: Address,
  tokenDecimals: number, pairDecimals: number,
): Promise<number | null> {
  try {
    const tokenIsZero = BigInt(token) < BigInt(pair)
    const [c0, c1] = tokenIsZero ? [token, pair] : [pair, token]
    const id = keccak256(encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
      [c0, c1, fee, tickSpacing, hooks],
    ))
    const base = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [id, 6n]))
    const word = await publicClient.readContract({ address: POOL_MANAGER, abi: PM_ABI, functionName: 'extsload', args: [base] })
    const sq = BigInt(word) & ((1n << 160n) - 1n)
    if (sq === 0n) return null
    const ratio = Number(sq) ** 2 / 2 ** 192 // token1 per token0, raw
    const [d0, d1] = tokenIsZero ? [tokenDecimals, pairDecimals] : [pairDecimals, tokenDecimals]
    const human = ratio * 10 ** (d0 - d1)
    return tokenIsZero ? human : 1 / human
  } catch {
    return null
  }
}

/** Everything a token page shows. `Launch` plus the few reads only that page needs. */
export type TokenView = Launch & {
  description: string
  creatorTaxBps: number
  /** Lifetime totals in the pair asset, split by where they went. */
  toWallets: bigint
  toAccounts: bigint
  /** What each account share currently holds unclaimed, in the pair asset, by share index. */
  unclaimed: (bigint | null)[]
}

/**
 * ⛔ Reads the registry FIRST. A token this launchpad did not create has no splitter and no shares,
 * and rendering zeroes would present "pays nobody" as a fact about somebody else's token.
 */
export async function readToken(address: Address): Promise<TokenView | null> {
  const entry = await readEntry(address)
  if (!entry) {
    /* ⭐ Not in our registry: it may still be the platform token launched elsewhere. */
    const ca = await fetchPlatformCa()
    if (!ca || ca.toLowerCase() !== address.toLowerCase()) return null
    const ext = await readForeignLaunch(address)
    if (!ext) return null
    const [description, launched] = await Promise.all([
      publicClient.readContract({ address, abi: ERC20_ABI, functionName: 'description' }).catch(() => ''),
      publicClient.readContract({ address: PONS_FACTORY, abi: FACTORY_ABI, functionName: 'getLaunchedToken', args: [address] }).catch(() => null),
    ])
    return { ...ext, description: description as string, creatorTaxBps: launched ? Number(launched.creatorTaxBps) : 0, toWallets: 0n, toAccounts: 0n, unclaimed: [null] }
  }
  const base = await readLaunch(entry)
  const [description, launched, toWallets, toAccounts] = await Promise.all([
    publicClient.readContract({ address, abi: ERC20_ABI, functionName: 'description' }).catch(() => ''),
    publicClient.readContract({ address: PONS_FACTORY, abi: FACTORY_ABI, functionName: 'getLaunchedToken', args: [address] }).catch(() => null),
    publicClient.readContract({ address: entry.splitter, abi: SPLITTER_ABI, functionName: 'totalToWallets', args: [entry.pairToken] }).catch(() => 0n),
    publicClient.readContract({ address: entry.splitter, abi: SPLITTER_ABI, functionName: 'totalToAccounts', args: [entry.pairToken] }).catch(() => 0n),
  ])
  const hasClaims = /^0x[0-9a-fA-F]{40}$/.test(CLAIMS)
  const unclaimed = await Promise.all(base.shares.map((s) =>
    s.provider === 0 || !hasClaims
      ? Promise.resolve(null)
      : publicClient.readContract({
          address: CLAIMS as Address, abi: CLAIMS_ABI, functionName: 'claimable', args: [address, s.beneficiary, entry.pairToken],
        }).catch(() => null),
  ))
  return {
    ...base,
    description: description as string,
    creatorTaxBps: launched ? Number(launched.creatorTaxBps) : 0,
    toWallets: toWallets as bigint,
    toAccounts: toAccounts as bigint,
    unclaimed,
  }
}

export const NATIVE_PAIR = NATIVE
