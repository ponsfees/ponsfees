/**
 * Proves, with the SITE'S OWN CODE, what a visitor sees once the platform token is set:
 * the CA the homepage shows, the gate open, the token listed and readable, its logo loading.
 *
 *   BASE=https://ponsfees.family node --experimental-strip-types scripts/verify-platform.mjs 0x<CA>
 *   BASE=https://ponsfees.family node --experimental-strip-types scripts/verify-platform.mjs --expect-closed
 *
 * VITE_RHC_RPC / VITE_LAUNCHPAD / VITE_CLAIMS default to production. `fetch('/api/…')` in the site's
 * code is pointed at BASE, which is the only thing a browser does differently.
 */
const BASE = process.env.BASE ?? 'https://ponsfees.family'
process.env.VITE_RHC_RPC ??= 'https://rpc.mainnet.chain.robinhood.com'
process.env.VITE_LAUNCHPAD ??= '0x9051D33D639B2aa64E3a3c4Ae20d040515ce4CF2'
process.env.VITE_CLAIMS ??= '0x09C84f7cD48BC01698D4D671C7564e871FC83E9c'

const realFetch = globalThis.fetch
globalThis.fetch = (input, init) => realFetch(typeof input === 'string' && input.startsWith('/') ? BASE + input : input, init)

const { readLaunches } = await import('../src/lib/launchpad.ts')
const { readToken } = await import('../src/lib/token.ts')
const { launchesOpen, mayLaunch, platformToken, FOUNDER } = await import('../src/lib/gate.ts')
const { formatUsd } = await import('../src/lib/marketCap.ts')
const { resolveImage } = await import('../src/lib/logo.ts')

const arg = process.argv[2]
const expectClosed = arg === '--expect-closed'
const CA = expectClosed ? null : arg
const STRANGER = '0x00000000000000000000000000000000000000ab'
const t0 = Date.now()
const ms = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`
let fail = 0
const ok = (c, m) => { console.log(`${c ? '✅' : '⛔'} [${ms()}] ${m}`); if (!c) fail++ }

const api = await realFetch(`${BASE}/api/platform`, { cache: 'no-store' }).then((r) => r.json())
ok(expectClosed ? api.token === null : api.token?.toLowerCase() === CA?.toLowerCase(), `API platform CA: ${api.token}`)

const ls = await readLaunches()
const pt = platformToken(ls)
if (expectClosed) {
  ok(!launchesOpen(ls), `gate CLOSED (${ls.length} launches on the site)`)
  ok(!mayLaunch(ls, STRANGER) && mayLaunch(ls, FOUNDER), 'strangers blocked, founder allowed')
  ok(pt === null, 'homepage CA placeholder empty (TBA)')
} else {
  ok(pt?.token.toLowerCase() === CA.toLowerCase(), `homepage CA = ${pt?.token}`)
  ok(launchesOpen(ls) && mayLaunch(ls, STRANGER), 'gate OPEN for everyone')
  ok(pt?.platform === true, 'listed on Home and Explore as the platform token (no "Fees to" on its card)')
  ok(pt?.name === 'Pons Fees' && pt?.symbol === 'FEES', `name / ticker: ${pt?.name} / ${pt?.symbol}`)
  ok(pt?.marketCapUsd !== null, `market cap ${formatUsd(pt?.marketCapUsd ?? null) ?? '—'} (phase ${pt?.phase})`)
  const img = pt?.logo ? await realFetch(resolveImage(pt.logo), { method: 'HEAD' }).catch(() => null) : null
  ok(!!img?.ok && (img.headers.get('content-type') ?? '').startsWith('image/'), `logo loads: ${pt?.logo || 'NONE'}`)
  const t = await readToken(CA)
  ok(!!t && t.token.toLowerCase() === CA.toLowerCase(), `token page reads (fee recipient ${t?.shares[0]?.wallet}, trading fee ${t ? (1 + t.creatorTaxBps / 100) : '?'}%)`)
}
const page = await realFetch(`${BASE}/`).then((r) => r.status).catch(() => 0)
ok(page === 200, `site answers ${page}`)
console.log(fail === 0 ? `\nALL GOOD in ${ms()}` : `\n${fail} CHECK(S) FAILED`)
process.exit(fail === 0 ? 0 : 1)
