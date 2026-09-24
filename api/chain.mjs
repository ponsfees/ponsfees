/**
 * Robinhood Chain for the server and the keeper, plus a cached read of the whole launch registry.
 *
 * ⚠ `rpc.robinhood.com` does NOT resolve; the working host is `rpc.mainnet.chain.robinhood.com`.
 */

import { createPublicClient, http, parseAbi } from 'viem'

export const RHC_RPC = process.env.RHC_RPC ?? 'https://rpc.mainnet.chain.robinhood.com'

/**
 * ⛔⛔ The RPC is behind Cloudflare and CHALLENGES a default agent: node's own User-Agent gets an
 * HTML "Just a moment..." page that viem fails to parse, and the error names no cause.
 */
export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

export const rhc = {
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RHC_RPC] } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
}

export const ZERO = '0x0000000000000000000000000000000000000000'

export const client = createPublicClient({
  chain: rhc,
  transport: http(RHC_RPC, { fetchOptions: { headers: { 'User-Agent': BROWSER_UA } }, retryCount: 4 }),
  /* ⭐ Multicall3 is at the canonical address on RHC. Batching collapses one read per splitter
     into one request, which is the difference between a register that loads and one that 429s. */
  batch: { multicall: { batchSize: 1024, wait: 16 } },
})

export const LAUNCHPAD_ABI = parseAbi([
  'struct Entry { address token; address curve; address splitter; address creator; address pairToken; uint64 launchedAt; }',
  'function count() view returns (uint256)',
  'function page(uint256 offset, uint256 limit) view returns (Entry[])',
])

export const SPLITTER_ABI = parseAbi([
  'struct Share { uint8 provider; uint16 bps; address wallet; uint256 accountId; bytes32 beneficiary; }',
  'function shares() view returns (Share[])',
  'function pending() view returns (uint256 native, uint256 pair)',
  'function sweepCurve(uint256 minBuybackTokensOut)',
  'function sweepPool(address hook, bytes32 poolId, uint256 minConversionQuoteOut, uint256 minBuybackTokensOut)',
  'function harvestAll()',
  'function totalToWallets(address) view returns (uint256)',
  'function totalToAccounts(address) view returns (uint256)',
])

/**
 * Every launch, oldest first, with its shares.
 *
 * ⛔⛔ READS THE WHOLE REGISTRY, not a first page. Pons Charity once read `page(0, 24)` and its
 * biggest graduated launch vanished from every dashboard: a request size used as if it were the size
 * of the launchpad.
 */
export async function readRegistry(launchpad, c = client) {
  const n = Number(await c.readContract({ address: launchpad, abi: LAUNCHPAD_ABI, functionName: 'count' }))
  const PAGE = 200
  const pages = []
  for (let off = 0; off < n; off += PAGE) {
    pages.push(c.readContract({ address: launchpad, abi: LAUNCHPAD_ABI, functionName: 'page', args: [BigInt(off), BigInt(PAGE)] }))
  }
  const entries = (await Promise.all(pages)).flat().reverse()
  const shares = await Promise.all(
    entries.map((e) => c.readContract({ address: e.splitter, abi: SPLITTER_ABI, functionName: 'shares' })),
  )
  return entries.map((e, i) => ({
    token: e.token,
    curve: e.curve,
    splitter: e.splitter,
    creator: e.creator,
    pairToken: e.pairToken,
    launchedAt: Number(e.launchedAt),
    shares: shares[i].map((s) => ({
      provider: Number(s.provider),
      bps: Number(s.bps),
      wallet: s.wallet,
      accountId: s.accountId.toString(),
      beneficiary: s.beneficiary.toLowerCase(),
    })),
  }))
}

/**
 * The registry, cached. ⚠ A failed refresh serves the last good copy rather than nothing: a
 * throttled RPC must not make a signed-in account's shares disappear from the claim page.
 */
export function cachedRegistry(launchpad, ttlMs = 30_000) {
  let at = 0
  let value = null
  let inflight = null
  return async () => {
    if (value && Date.now() - at < ttlMs) return value
    if (!inflight) {
      inflight = readRegistry(launchpad)
        .then((v) => { value = v; at = Date.now(); return v })
        .catch((err) => { if (value) return value; throw err })
        .finally(() => { inflight = null })
    }
    return inflight
  }
}
