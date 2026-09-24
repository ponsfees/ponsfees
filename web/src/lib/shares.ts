import { getAddress, isAddress, keccak256, toBytes, type Address } from 'viem'
import type { Identity, Provider } from './identityApi.ts'

/**
 * Who a launch's fees go to: the form's state, the rules the contract enforces, and the mapping to
 * `FeeSplitter.Share`.
 *
 * ⚠ In a `.ts` file, not beside the JSX: `node --experimental-strip-types` runs `.ts` and cannot run
 * `.tsx`, and "the shares make exactly 100%" is the rule `FeeSplitter` reverts on.
 */
export type RecipientKind = 'wallet' | Provider

export type Recipient = {
  id: string
  kind: RecipientKind
  /** What was typed: an address for a wallet, a handle for an account. */
  value: string
  /** ⛔⛔ The looked-up account. The launch records its NUMERIC ID, never the typed handle. */
  resolved: Identity | null
  bps: number
}

export const newId = () => Math.random().toString(36).slice(2, 9)

export const blankRecipient = (kind: RecipientKind = 'x', bps = 10000): Recipient =>
  ({ id: newId(), kind, value: '', resolved: null, bps })

export const KIND_LABEL: Record<RecipientKind, string> = { wallet: 'Wallet', x: 'X', github: 'GitHub', twitch: 'Twitch' }
export const PLACEHOLDER: Record<RecipientKind, string> = { wallet: '0x…', x: '@handle', github: 'username', twitch: 'channel' }

/** ⛔ Must equal `FeeSplitter`'s provider numbers and `api/identity.mjs` PROVIDER_CODE. */
export const PROVIDER_CODE: Record<Provider, 1 | 2 | 3> = { x: 1, github: 2, twitch: 3 }

/** The contract refuses more; the loop over shares runs on every distribution. */
export const MAX_RECIPIENTS = 10

export const normaliseHandle = (h: string) =>
  h.trim()
    .replace(/^@/, '')
    .replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '')
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/^https?:\/\/(www\.|m\.)?twitch\.tv\//i, '')
    .replace(/\/.*$/, '')

export const totalBps = (rs: Recipient[]) => rs.reduce((n, x) => n + (x.bps || 0), 0)

/** The first thing stopping these shares becoming a launch, or null. */
export function sharesError(rs: Recipient[]): string | null {
  if (rs.length === 0) return 'Add at least one recipient'
  if (rs.length > MAX_RECIPIENTS) return `At most ${MAX_RECIPIENTS} recipients`
  if (rs.some((x) => !x.bps)) return 'Every recipient needs a share above zero'
  const total = totalBps(rs)
  if (total !== 10000) {
    const pct = (total / 100).toFixed(total % 100 === 0 ? 0 : 1)
    return `These add up to ${pct}%, they have to make exactly 100%`
  }
  for (const x of rs) {
    /* ⚠ Not strict: a real address pasted in the wrong mixed case is still that address. */
    if (x.kind === 'wallet' && !isAddress(x.value.trim(), { strict: false })) return 'Every wallet needs a valid address'
    if (x.kind !== 'wallet' && !x.resolved) return 'Find each account first. The launch records its id, not its name'
    /* ⛔ A resolved identity must belong to the row's own provider: a row switched from X to Twitch
       with a stale X identity attached would record the wrong provider's id. */
    if (x.kind !== 'wallet' && x.resolved && x.resolved.provider !== x.kind) return 'Find each account again after changing its type'
  }
  const accounts = rs.filter((x) => x.resolved).map((x) => `${x.resolved!.provider}:${x.resolved!.id}`)
  if (new Set(accounts).size !== accounts.length) return 'That account is already in the list'
  const wallets = rs.filter((x) => x.kind === 'wallet').map((x) => x.value.trim().toLowerCase())
  if (new Set(wallets).size !== wallets.length) return 'That wallet is already in the list'
  return null
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address
const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`

/**
 * ⛔⛔ THE SHARES THAT GO ON CHAIN, FOR EVER. Throws on anything `sharesError` would refuse, so a
 * caller that skipped validation fails here rather than in a revert.
 *
 * ⚠ The beneficiary is `keccak256("<provider>:<id>")`, the exact string `FeeSplitter` rebuilds and
 * checks at construction and the API hashes on sign in.
 */
export function toShares(rs: Recipient[]) {
  const bad = sharesError(rs)
  if (bad) throw new Error(bad)
  return rs.map((x) =>
    x.kind === 'wallet'
      ? { provider: 0, bps: x.bps, wallet: getAddress(x.value.trim().toLowerCase()), accountId: 0n, beneficiary: ZERO_BYTES32 }
      : {
          provider: PROVIDER_CODE[x.kind],
          bps: x.bps,
          wallet: ZERO_ADDRESS,
          accountId: BigInt(x.resolved!.id),
          beneficiary: keccak256(toBytes(`${x.resolved!.provider}:${x.resolved!.id}`)),
        },
  )
}

/**
 * Sets one recipient's share and rebalances the others so the total stays exactly 100.
 * ⭐ Always terminates: `typed <= maxSharePct` leaves room for every other row's minimum 1%.
 */
export const maxSharePct = (rs: Recipient[]) => 100 - (rs.length - 1)

export function withShare(rs: Recipient[], id: string, typed: number): Recipient[] {
  if (rs.length <= 1) return rs
  const p = Math.max(1, Math.min(maxSharePct(rs), Math.round(typed) || 1))
  const others = rs.filter((x) => x.id !== id)
  const cur = others.map((x) => x.bps / 100)
  const sum = cur.reduce((a, b) => a + b, 0)
  const rest = 100 - p
  const alloc = others.map((_, i) => Math.max(1, Math.round(sum > 0 ? (cur[i]! / sum) * rest : rest / others.length)))
  let drift = rest - alloc.reduce((a, b) => a + b, 0)
  for (let i = 0; drift !== 0 && i < 1000; i++) {
    const j = i % alloc.length
    if (drift > 0) { alloc[j]!++; drift-- }
    else if (alloc[j]! > 1) { alloc[j]!--; drift++ }
  }
  return rs.map((x) => ({ ...x, bps: (x.id === id ? p : alloc[others.indexOf(x)]!) * 100 }))
}

/** Even split, the first row taking the rounding. Used when a row is added or removed. */
export function rebalance(rs: Recipient[]): Recipient[] {
  if (rs.length === 0) return rs
  const each = Math.floor(100 / rs.length)
  const first = 100 - each * (rs.length - 1)
  return rs.map((x, i) => ({ ...x, bps: (i === 0 ? first : each) * 100 }))
}

/**
 * ⭐ The line written into the token's own description, so Pons, explorers and terminals show who
 * is paid without reading our contracts. ⛔ Handles here are display text; the id is what pays.
 */
export function describeRecipients(rs: Recipient[]): string {
  const accounts = rs.filter((x) => x.kind !== 'wallet' && x.resolved)
  if (accounts.length === 0) return ''
  const name = (x: Recipient) =>
    x.kind === 'twitch' ? `twitch.tv/${x.resolved!.handle}`
      : x.kind === 'github' ? `github.com/${x.resolved!.handle}`
      : `@${x.resolved!.handle}`
  return `Fees shared with ${accounts.map(name).join(', ')}`
}

/**
 * ⭐ A launch does not have to share its fees. With every recipient row left blank, the launcher's
 * own wallet takes 100%, and the launch is listed on the site exactly like any other.
 */
export const allBlank = (rs: Recipient[]) => rs.every((x) => !x.value.trim())

export function effectiveRecipients(rs: Recipient[], launcher: string | null | undefined): Recipient[] {
  if (!allBlank(rs) || !launcher) return rs
  return [{ id: 'self', kind: 'wallet', value: launcher, resolved: null, bps: 10000 }]
}
