/**
 * The only server FEES has.
 *
 * 1. Hosts a token's logo. A Pons V2 `logo` field is 512 bytes, so it holds a LINK; the file lives
 *    here, content addressed, OUTSIDE the site's deploy root so an `rsync --delete` never takes it.
 * 2. Proves who owns an X, GitHub or Twitch account (OAuth), and signs the voucher that lets them
 *    claim what a launch has credited that account in {FeesClaims}.
 * 3. Resolves a typed handle to the account's permanent numeric id for the launch form.
 *
 * ## ⛔⛔ WHAT IS OWED IS NEVER DECIDED HERE
 *
 * A launch's shares are its splitter's constructor arguments and what an account is owed is
 * `FeesClaims.claimable`. This server only adds the two facts a chain cannot know: who owns an
 * account, and which vouchers it has signed that nobody has spent yet.
 *
 * ## ⛔⛔ SVG IS REFUSED, AND THAT IS A SECURITY DECISION
 *
 * An SVG can carry `<script>`, and it would be served from the origin where visitors connect a
 * wallet. Magic bytes decide, never the extension.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isAddress } from 'viem'

import { beneficiary, isProvider } from './identity.mjs'
import { xProvider } from './providers/x.mjs'
import { githubProvider, handleForGithubId } from './providers/github.mjs'
import { twitchProvider, handleForTwitchId } from './providers/twitch.mjs'
import { handleForXId } from './providers/twitterapiio.mjs'
import { stubProvider } from './providers/stub.mjs'
import { makeClaims } from './claims.mjs'
import { cachedRegistry, client, ZERO } from './chain.mjs'
import { parseAbi } from 'viem'

const PORT = Number(process.env.PORT || 8810)
const DIR = process.env.LOGO_DIR || '/root/fees-logos'
const PUBLIC_URL = process.env.PUBLIC_URL ?? 'http://localhost:5240'
const PUBLIC_BASE = process.env.LOGO_PUBLIC_BASE || `${PUBLIC_URL}/logos`
const STATUS = process.env.STATUS ?? '/var/lib/fees/status.json'
/*
  ⭐ THE PLATFORM TOKEN, when it was launched somewhere other than our launchpad. Set once by the
  operator (deploy/set-ca.sh), validated ON CHAIN before it is written: a real Pons V2 launch whose
  creator fees go to the founder's wallet. Setting it opens the site's launch gate and fills the
  homepage CA. @see web/src/lib/gate.ts
*/
const PLATFORM_FILE = process.env.PLATFORM_FILE ?? '/var/lib/fees/platform.json'
const FOUNDER = (process.env.FOUNDER ?? '0xc42c1009665D9A5E465F93977B87241dEe432A22').toLowerCase()
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? ''
const PONS_FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e'
const FACTORY_READ_ABI = parseAbi([
  'function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))',
])
const MAX_BYTES = 4 * 1024 * 1024
const config = { dir: DIR, publicBase: PUBLIC_BASE }

const CLAIMS_ADDRESS = process.env.CLAIMS_ADDRESS ?? ''
const LAUNCHPAD_ADDRESS = process.env.LAUNCHPAD ?? ''
const SIGNER_KEY = process.env.CLAIM_SIGNER_KEY ?? ''

/*
  ⚠ A provider exists only when its credentials do. `/api/me` lists what can actually COMPLETE a
  sign in, and the front end offers buttons off that and nothing else.
*/
const providers = new Map()
if (process.env.X_CLIENT_ID && process.env.X_CLIENT_SECRET) {
  providers.set('x', xProvider(process.env.X_CLIENT_ID, process.env.X_CLIENT_SECRET, process.env.X_BEARER_TOKEN, process.env.TWITTERAPI_IO_KEY))
}
if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
  providers.set('github', githubProvider(process.env.GITHUB_CLIENT_ID, process.env.GITHUB_CLIENT_SECRET))
}
if (process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET) {
  providers.set('twitch', twitchProvider(process.env.TWITCH_CLIENT_ID, process.env.TWITCH_CLIENT_SECRET))
}

/*
  🔴🔴 STUB SIGN-IN IS REFUSED ON A PUBLIC ORIGIN. It authenticates anybody as anybody, so on https
  it would let a stranger sign in as any account and take its fees. The check is the origin, not a
  flag somebody has to remember to unset.
*/
if (process.env.STUB_AUTH === '1') {
  if (PUBLIC_URL.startsWith('https://')) {
    throw new Error('STUB_AUTH is set on an https origin. That would sign anybody in as anybody.')
  }
  providers.set('x', stubProvider('x', 'X'))
  providers.set('github', stubProvider('github', 'GitHub'))
  providers.set('twitch', stubProvider('twitch', 'Twitch'))
}

const claims = CLAIMS_ADDRESS && LAUNCHPAD_ADDRESS && SIGNER_KEY
  ? makeClaims({ address: CLAIMS_ADDRESS, launchpad: LAUNCHPAD_ADDRESS, signerKey: SIGNER_KEY })
  : null
const registry = LAUNCHPAD_ADDRESS ? cachedRegistry(LAUNCHPAD_ADDRESS) : null

const redirectFor = (name) => `${PUBLIC_URL}/api/auth/callback/${name}`

/*
  ⛔⛔ IN MEMORY, AND BOUNDED. `pending` is filled by an UNAUTHENTICATED GET, so without a ceiling
  anybody could grow it until the process died. Both are lost on restart, which signs everybody out:
  an inconvenience, not a loss, because nothing is owed to a session.
*/
const pending = new Map()
const sessions = new Map()
const MAX_PENDING = 5_000
const MAX_SESSIONS = 20_000
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000

const sweepOld = (map, ttl) => {
  const cutoff = Date.now() - ttl
  for (const [k, v] of map) if (v.createdAt < cutoff) map.delete(k)
}

const readCookie = (req, name) => {
  const raw = req.headers.cookie ?? ''
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return decodeURIComponent(rest.join('='))
  }
  return null
}

/* ⚠ HttpOnly so the page cannot read it, SameSite=Lax so it survives the OAuth redirect back from
   the provider — `Strict` drops the cookie on that navigation and the callback then reads no state,
   which looks exactly like a forged callback. */
const setCookie = (res, name, value, maxAgeSeconds) => {
  const bits = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ]
  if (PUBLIC_URL.startsWith('https://')) bits.push('Secure')
  const existing = res.getHeader('set-cookie')
  res.setHeader('set-cookie', existing ? [].concat(existing, bits.join('; ')) : bits.join('; '))
}

/** ⚠ Constant time. A `===` on a secret leaks it a character at a time to a patient caller. */
const sameState = (a, b) => {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

const sessionOf = (req) => {
  const token = readCookie(req, 'fees_session')
  if (!token) return null
  const found = sessions.get(token)
  if (!found) return null
  if (Date.now() - found.createdAt > SESSION_TTL_MS) { sessions.delete(token); return null }
  return found
}

const clientIp = (req) =>
  String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? 'unknown').split(',')[0].trim()

/**
 * Every launch that pays any of the visitor's connected accounts, with what each holds per asset.
 *
 * ⛔⛔ TRIED ACROSS EVERY CONNECTED IDENTITY. A person may hold a share through their X account and
 * another through their Twitch channel; checking only one made the other invisible.
 * ⛔ `beneficiary` folds the provider into the hash, so a GitHub account can never collect the fees
 * of the X account that shares its number.
 */
async function owedTo(session) {
  const users = Object.values(session.users ?? {})
  if (users.length === 0 || !registry) return []
  const byBen = new Map(users.map((u) => [beneficiary(u).toLowerCase(), u]))
  const launches = await registry()
  const rows = []
  for (const l of launches) {
    for (const [ben, user] of byBen) {
      const bps = l.shares.filter((s) => s.beneficiary === ben).reduce((n, s) => n + s.bps, 0)
      if (bps === 0) continue
      const assets = [...new Set([ZERO, l.pairToken, l.token].map((a) => a.toLowerCase()))]
      const held = await Promise.all(assets.map((a) => claims.entitlement(l.token, ben, a)))
      rows.push({
        launch: l.token,
        payee: { provider: user.provider, handle: user.handle },
        bps,
        assets: held.map((e) => ({
          asset: e.asset,
          onChain: e.onChain.toString(),
          reserved: e.reserved.toString(),
          available: e.available.toString(),
        })),
      })
    }
  }
  return rows
}

/** What a browser reliably renders as a token logo, minus SVG. ⚠ Keyed by magic bytes. */
const SIGNATURES = [
  { ext: 'png', match: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'jpg', match: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'gif', match: (b) => b.subarray(0, 6).toString('ascii').startsWith('GIF8') },
  { ext: 'webp', match: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP' },
  { ext: 'avif', match: (b) => b.subarray(4, 8).toString('ascii') === 'ftyp' && b.subarray(8, 12).toString('ascii').startsWith('avif') },
]

/* ── a crude per-caller budget ────────────────────────────────────────────────────────────────
   A public upload endpoint is a disk somebody else can fill. Content addressing means a determined
   uploader still needs a different image each time, but only just. This turns "fill the disk" into
   "fill the disk slowly and visibly". */
const RATE_WINDOW_MS = 60 * 60 * 1000
const RATE_LIMIT = 40
const seen = new Map()

export function rateLimited(who, now = Date.now(), limit = RATE_LIMIT) {
  const hits = (seen.get(who) ?? []).filter((t) => t > now - RATE_WINDOW_MS)
  /* ⛔⛔ A caller already over budget is turned away WITHOUT being recorded. Pushing first means a
     refused caller keeps growing their own array and every later request re-filters all of it, so a
     flood that is being rejected costs the server more the longer it runs. */
  if (hits.length >= limit) {
    seen.set(who, hits)
    return true
  }
  hits.push(now)
  seen.set(who, hits)
  /* ⚠ Callers whose window has lapsed are dropped, or the map keeps one key per address that ever
     asked, forever: the same unbounded growth the limiter exists to prevent, one level up. */
  if (seen.size > 5000) {
    for (const [other, times] of seen) {
      if (other !== who && !times.some((t) => t > now - RATE_WINDOW_MS)) seen.delete(other)
    }
  }
  return false
}

export async function storeLogo(body, cfg = config) {
  if (body.length === 0) return { ok: false, status: 400, error: 'the upload was empty' }
  if (body.length > MAX_BYTES) {
    return { ok: false, status: 413, error: `that is larger than the ${MAX_BYTES / 1024 / 1024} MB limit` }
  }

  const kind = SIGNATURES.find((s) => s.match(body))
  if (!kind) {
    /* ⚠ Names SVG specifically. Somebody uploading one has done nothing wrong and would otherwise
       be told their perfectly good file is "not an image". */
    const head = body.subarray(0, 512).toString('utf8').toLowerCase()
    const looksSvg = head.trimStart().startsWith('<svg') || head.includes('<svg')
    return {
      ok: false,
      status: 415,
      error: looksSvg
        ? 'An SVG can contain scripts and these are served from the same site you connect a wallet on, so it cannot be accepted. Use PNG, JPEG, GIF, WebP or AVIF.'
        : 'That does not look like a PNG, JPEG, GIF, WebP or AVIF.',
    }
  }

  const name = `${createHash('sha256').update(body).digest('hex').slice(0, 32)}.${kind.ext}`
  const url = `${cfg.publicBase}/${name}`
  const path = join(cfg.dir, name)

  try {
    mkdirSync(cfg.dir, { recursive: true })
    // ⚠ Content addressed, so an existing file is byte for byte the same file. Skipping keeps a
    // re-upload free and cannot change what an on-chain address points at.
    let exists = false
    try { exists = statSync(path).size === body.length } catch { exists = false }
    if (!exists) writeFileSync(path, body)
  } catch (err) {
    return { ok: false, status: 500, error: `could not store the image: ${err?.message ?? err}` }
  }

  /*
    ⭐⭐ Fetched back over the PUBLIC url before saying yes. Writing the file and assuming it is
    reachable is exactly how a launch ends up pointing at a logo nobody can load, and on this chain
    that mistake is permanent. A vhost not serving this directory is caught here rather than by
    whoever looks at the token afterwards.
  */
  const check = await fetch(url, { method: 'HEAD' }).catch(() => null)
  if (!check || !check.ok) {
    return {
      ok: false,
      status: 502,
      error: `Stored, but ${url} does not serve it (${check ? check.status : 'unreachable'}). Not using that address.`,
    }
  }
  return { ok: true, url, bytes: body.length }
}

/** ⚠ Bounded while reading, not after. A body cap enforced once the whole thing is buffered has
 *  already let somebody send it. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * ⛔⛔ `writeHead` REPLACES what `setHeader` put there, it does not merge — so passing
 * `cache-control` unconditionally here made every `res.setHeader('Cache-Control', …)` in this file
 * DEAD CODE. `/api/donations` has been asking for `max-age=30` since it was written and shipping
 * `no-store` on every response; the handler read correctly and the header said the opposite.
 *
 * ➤ So `no-store` is the DEFAULT, not an override: a handler that has already named a policy keeps
 * it. Defaulting closed is the right way round — an endpoint that says nothing is one nobody has
 * thought about caching for, and identity answers live behind this same helper.
 */
const json = (res, status, body) => {
  const headers = { 'content-type': 'application/json' }
  if (!res.hasHeader('Cache-Control')) headers['cache-control'] = 'no-store'
  res.writeHead(status, headers)
  res.end(JSON.stringify(body))
}

const server = createServer((req, res) => {
  void (async () => {
    const path = (req.url ?? '').split('?')[0]
    const url = new URL(req.url ?? '/', 'http://localhost')

    /* ⚠ The availability probe returns JSON, not a status code: with no service, this path is
       answered by the SPA fallback with index.html and a 200. */
    if (path === '/api/logo' && req.method === 'GET') {
      return json(res, 200, { service: 'fees-logo', upload: true, maxBytes: MAX_BYTES })
    }

    if (path === '/api/logo' && req.method === 'POST') {
      if (rateLimited(clientIp(req))) return json(res, 429, { error: 'Too many uploads from here in the last hour.' })
      let body
      try {
        body = await readBody(req, MAX_BYTES + 1024)
      } catch {
        return json(res, 413, { error: `That is larger than the ${MAX_BYTES / 1024 / 1024} MB limit.` })
      }
      const out = await storeLogo(body)
      if (!out.ok) return json(res, out.status, { error: out.error })
      return json(res, 200, { url: out.url, bytes: out.bytes })
    }

    /*
      Whether the keeper is cranking, for an uptime monitor. ⚠ Served from the file the keeper
      writes; a stale or missing file answers `unknown`, never a confident 200 or 503.
    */
    if (path === '/api/status') {
      try {
        const st = JSON.parse(await readFile(STATUS, 'utf8'))
        const age = Date.now() - Date.parse(st.at)
        if (!Number.isFinite(age) || age > 30 * 60 * 1000) {
          return json(res, 503, { level: 'stale', detail: 'the keeper has not reported in 30 minutes', at: st.at ?? null })
        }
        return json(res, 200, st)
      } catch {
        return json(res, 200, { level: 'unknown', detail: 'no keeper report yet' })
      }
    }

    /* ══ identity ═══════════════════════════════════════════════════════════════════════════ */

    if (path === '/api/me') {
      const session = sessionOf(req)
      return json(res, 200, {
        users: Object.values(session?.users ?? {}),
        providers: [...providers.values()].map((p) => ({ name: p.name, label: p.label })),
        claiming: Boolean(claims),
        stub: [...providers.values()].some((p) => p.isStub === true),
      })
    }

    if (path.startsWith('/api/auth/start/')) {
      const name = path.slice('/api/auth/start/'.length)
      if (!isProvider(name) || !providers.has(name)) return json(res, 404, { error: 'no such sign in method' })

      sweepOld(pending, 10 * 60 * 1000)
      if (pending.size > MAX_PENDING) return json(res, 503, { error: 'too many sign ins in flight' })

      const provider = providers.get(name)
      const { url: to, state, verifier } = provider.begin(redirectFor(name))
      pending.set(state, { verifier, createdAt: Date.now() })
      setCookie(res, 'fees_state', state, 600)
      res.writeHead(302, { location: to })
      return res.end()
    }

    if (path.startsWith('/api/auth/callback/')) {
      const name = path.slice('/api/auth/callback/'.length)
      if (!isProvider(name) || !providers.has(name)) return json(res, 404, { error: 'no such sign in method' })

      const provider = providers.get(name)
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const cookieState = readCookie(req, 'fees_state')

      /*
        ⚠⚠ The state has to match BOTH what we issued and what this browser was given. Checking only
        the server-side map lets any browser complete somebody else's sign in by replaying a state
        they observed; checking only the cookie lets a state we never issued through.
      */
      if (!code || !state || !cookieState || !sameState(state, cookieState) || !pending.has(state)) {
        return json(res, 400, { error: 'that sign in did not come from here' })
      }
      const { verifier } = pending.get(state)
      pending.delete(state)

      const user = await provider.complete(code, verifier, redirectFor(name))

      sweepOld(sessions, SESSION_TTL_MS)
      if (sessions.size > MAX_SESSIONS) return json(res, 503, { error: 'too many sessions' })

      /*
        ⛔⛔ ADDED TO THE EXISTING SESSION, NEVER REPLACING IT. Signing in with GitHub used to
        overwrite an X identity, so "connect the other one" silently meant "disconnect this one" —
        and a share owed to the account you just dropped became invisible with no hint why.
        ⚠ The cookie is REUSED when there is one, so both identities live under one session token.
      */
      const existing = sessionOf(req)
      const token = readCookie(req, 'fees_session') && existing
        ? readCookie(req, 'fees_session')
        : randomBytes(32).toString('hex')
      const users = { ...(existing?.users ?? {}), [user.provider]: user }
      sessions.set(token, { users, createdAt: existing?.createdAt ?? Date.now() })
      setCookie(res, 'fees_session', token, 7 * 24 * 3600)
      setCookie(res, 'fees_state', '', 0)
      res.writeHead(302, { location: '/claim' })
      return res.end()
    }

    if (path === '/api/auth/signout' && req.method === 'POST') {
      const token = readCookie(req, 'fees_session')
      const which = url.searchParams.get('provider')
      const session = token ? sessions.get(token) : null

      /* ⚠ Disconnecting ONE account must not disconnect the other. Only a signout with no provider
         named clears everything. */
      if (session && isProvider(which) && session.users[which]) {
        delete session.users[which]
        if (Object.keys(session.users).length > 0) {
          sessions.set(token, session)
          return json(res, 200, { ok: true })
        }
      }
      if (token) sessions.delete(token)
      setCookie(res, 'fees_session', '', 0)
      return json(res, 200, { ok: true })
    }

    /**
     * Resolve a typed handle to the account that currently holds it.
     *
     * ⛔⛔ THE LAUNCH FORM NEEDS THE NUMERIC ID, NOT THE HANDLE. A beneficiary is
     * `keccak256("x:<id>")` and it goes into a constructor argument that can never be changed — so
     * a launch keyed on the TEXT `@alice` pays whoever holds that name years later. This route is
     * what turns what somebody typed into what gets written down.
     *
     * 🔴🔴 RATE LIMITED, BECAUSE EVERY X CALL SPENDS THE OPERATOR'S MONEY. X's user endpoints are
     * prepaid per lookup and this is an unauthenticated proxy straight to them; a loop could empty
     * the balance. GitHub is free but rate limited by GitHub, and exhausting that breaks it for
     * everyone. ⚠ A generous ceiling — nobody filling in a form makes 120 lookups an hour.
     */
    if (path === '/api/handle') {
      const handle = url.searchParams.get('handle')
      const name = url.searchParams.get('provider')
      if (!handle) return json(res, 400, { error: 'no handle' })
      if (!isProvider(name) || !providers.has(name)) return json(res, 400, { error: 'no such provider' })

      const who = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? 'unknown').split(',')[0].trim()
      if (rateLimited(`handle:${who}`, Date.now(), 120)) {
        return json(res, 429, { error: 'that is a lot of lookups. Try again in a little while.' })
      }

      try {
        const found = await providers.get(name).lookup(handle)
        return json(res, 200, { user: found })
      } catch (err) {
        /* ⛔ A DEPLETED BALANCE IS NOT "TRY AGAIN". It is a prepaid quota only the operator can top
           up, and a generic handler tells the visitor to retry forever. 503, not 500: the route is
           temporarily unable to answer and the caller did nothing wrong. */
        if (err instanceof Error && err.message === 'X_CREDITS_DEPLETED') {
          return json(res, 503, { error: 'handle lookup is unavailable right now. Try GitHub, or try again later.' })
        }
        throw err
      }
    }

    /**
     * A numeric account id back to whoever holds it NOW, for a token page.
     *
     * ⭐⭐ A launch records the id, never the handle: every one of these services lets a name be
     * released and re-registered, so a stored handle would eventually name a different person.
     * ⚠ A lookup that cannot run answers `user: null` and the page says "an X account".
     */
    if (path === '/api/account') {
      const name = url.searchParams.get('provider')
      const id = String(url.searchParams.get('id') ?? '')
      if (!isProvider(name)) return json(res, 400, { error: 'no such provider' })
      if (!/^[0-9]{1,25}$/.test(id)) return json(res, 400, { error: 'not an account id' })
      if (rateLimited(`account:${clientIp(req)}`, Date.now(), 240)) return json(res, 429, { error: 'too many lookups' })

      try {
        let user = null
        if (name === 'github') user = await handleForGithubId(id)
        else if (name === 'twitch' && process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET) {
          user = await handleForTwitchId(process.env.TWITCH_CLIENT_ID, process.env.TWITCH_CLIENT_SECRET, id)
        } else if (name === 'x' && process.env.TWITTERAPI_IO_KEY) {
          user = await handleForXId(process.env.TWITTERAPI_IO_KEY, id)
        }
        res.setHeader('Cache-Control', 'public, max-age=600')
        return json(res, 200, { user })
      } catch {
        return json(res, 200, { user: null })
      }
    }

    /* ══ claiming ═══════════════════════════════════════════════════════════════════════════ */

    /** Everything the signed-in accounts are owed, across every launch. */
    if (path === '/api/owed' && req.method === 'GET') {
      if (!claims) return json(res, 503, { error: 'claiming is not configured on this deployment' })
      const session = sessionOf(req)
      if (!session) return json(res, 401, { error: 'sign in first' })
      return json(res, 200, { rows: await owedTo(session), contract: claims.address })
    }

    /**
     * A voucher for everything one account holds on one launch, in one asset.
     *
     * ⛔⛔ OWNERSHIP IS CHECKED HERE AND NOWHERE ELSE MATTERS. The session says which accounts this
     * is; the SPLITTER'S OWN CONSTRUCTOR ARGUMENTS say which accounts a launch pays. The browser
     * names a provider and an asset, and both are checked against those two sources.
     */
    if (path === '/api/voucher' && req.method === 'POST') {
      if (!claims) return json(res, 503, { error: 'claiming is not configured on this deployment' })
      const session = sessionOf(req)
      if (!session) return json(res, 401, { error: 'sign in first' })

      let body
      try { body = JSON.parse((await readBody(req, 8192)).toString('utf8') || '{}') } catch { return json(res, 400, { error: 'not JSON' }) }
      const launch = String(body.launch ?? '')
      const wallet = String(body.wallet ?? '')
      const asset = String(body.asset ?? '').toLowerCase()
      const provider = String(body.provider ?? '')
      if (!isAddress(launch) || !isAddress(wallet) || !isAddress(asset)) {
        return json(res, 400, { error: 'launch, wallet and asset are required' })
      }
      if (wallet.toLowerCase() === ZERO) return json(res, 400, { error: 'that is the zero address' })
      const user = session.users?.[provider]
      if (!user) return json(res, 403, { error: 'you are not signed in with that account' })

      const who = beneficiary(user)
      const share = await claims.shareOf(launch, who)
      if (!share.ok) return json(res, 403, { error: share.error })
      if (!share.assets.includes(asset)) return json(res, 400, { error: 'that launch does not pay in that asset' })

      const e = await claims.entitlement(launch, who, asset)
      if (e.available === 0n) return json(res, 400, { error: 'there is nothing available to claim right now' })

      const issued = await claims.issue({ launch, beneficiary: who, asset, recipient: wallet, amount: e.available })
      if (!issued.ok) return json(res, 400, { error: issued.error })
      return json(res, 200, { voucher: issued.voucher, contract: claims.address })
    }

    if (path === '/api/platform' && req.method === 'GET') {
      try {
        const doc = JSON.parse(await readFile(PLATFORM_FILE, 'utf8'))
        /* ⚠ 5s, not longer: this is the switch that opens the gate, and a visitor must see it flip
           within seconds of go-live. */
        res.setHeader('Cache-Control', 'public, max-age=5')
        return json(res, 200, { token: isAddress(doc?.token ?? '') ? doc.token : null })
      } catch {
        return json(res, 200, { token: null })
      }
    }

    if (path === '/api/admin/platform' && req.method === 'POST') {
      /* ⛔ Constant-time bearer check; no admin token configured means the route does not exist. */
      const given = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
      if (!ADMIN_TOKEN || !sameState(given, ADMIN_TOKEN)) return json(res, 404, { error: 'not found' })
      let body
      try { body = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}') } catch { return json(res, 400, { error: 'not JSON' }) }
      if (body.token === null) {
        writeFileSync(PLATFORM_FILE, JSON.stringify({ token: null, at: new Date().toISOString() }))
        return json(res, 200, { token: null })
      }
      const token = String(body.token ?? '')
      if (!isAddress(token)) return json(res, 400, { error: 'not an address' })
      /* ⛔⛔ VALIDATED ON CHAIN, never trusted from the request: it must be a real Pons V2 launch and
         its creator fees must go to the founder. A mistyped CA can never become the homepage CA. */
      const rec = await client.readContract({ address: PONS_FACTORY, abi: FACTORY_READ_ABI, functionName: 'getLaunchedToken', args: [token] }).catch(() => null)
      if (!rec?.exists) return json(res, 400, { error: 'that is not a Pons V2 launch' })
      if (rec.creatorFeeRecipient.toLowerCase() !== FOUNDER) {
        return json(res, 400, { error: `its fees go to ${rec.creatorFeeRecipient}, not the founder wallet` })
      }
      /* ⭐ `dry: true` validates everything and writes nothing, so go-live can be rehearsed against
         production without opening the gate. */
      if (body.dry === true) return json(res, 200, { dry: true, ok: true, token, curve: rec.curve, deployer: rec.deployer, phase: Number(rec.phase) })
      mkdirSync(dirname(PLATFORM_FILE), { recursive: true })
      writeFileSync(PLATFORM_FILE, JSON.stringify({ token, at: new Date().toISOString() }))
      return json(res, 200, { token, curve: rec.curve, deployer: rec.deployer, phase: Number(rec.phase) })
    }

    if (path === '/api/health') return json(res, 200, { ok: true })
    return json(res, 404, { error: 'not found' })
  })().catch((err) => {
    console.error(err)
    if (!res.headersSent) json(res, 500, { error: 'something went wrong on our side' })
  })
})

/* ⛔ Loopback only. Caddy is the only way in. */
if (process.env.NODE_ENV !== 'test') {
  if (claims) {
    /* ⛔⛔ The EIP-712 domain name is READ FROM THE CONTRACT, never assumed: a server signing under
       any other name produces vouchers that all revert `BadSignature`. */
    claims.assertDomain()
      .then((n) => console.log(`claims ${CLAIMS_ADDRESS} domain "${n}", signer ${claims.signer}`))
      .catch((err) => console.error(`⛔ could not read the claims domain: ${err.message}`))
  } else {
    console.log('claiming is OFF (CLAIMS_ADDRESS, LAUNCHPAD and CLAIM_SIGNER_KEY are all required)')
  }
  console.log(`sign in: ${[...providers.keys()].join(', ') || 'none configured'}`)
  server.listen(PORT, '127.0.0.1', () => console.log(`fees api on 127.0.0.1:${PORT}, logos -> ${DIR}`))
}

export { server }
