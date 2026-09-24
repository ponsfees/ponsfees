/**
 * Who somebody is, across more than one place they can prove it.
 *
 * Ported from Pons Charity's `api/identity.mjs`, itself PONSPAD's `server/src/identity.ts`, which has been paying real people since 20 Aug
 * 2026. The reasoning below is theirs and is reproduced because it is the reasoning, not decoration.
 *
 * ## ⛔⛔ AN ID IS ONLY UNIQUE WITHIN ITS PROVIDER
 *
 * X account `12345` and GitHub account `12345` are different people, and both are plain numbers. A
 * store that keys ownership on the id alone therefore lets a GitHub user collect the fees of an X
 * account that happens to share their number — and the collision is not rare or theoretical, since
 * both providers number from small integers, so early accounts on each collide with near certainty.
 *
 * ➤ So identity is a PAIR everywhere, and {@link key} is the only thing allowed to compare two of
 * them. There is no code path here that compares a bare id with a bare id.
 *
 * ## ⛔⛔ AND THE ID IS THE IDENTITY, NEVER THE HANDLE
 *
 * Both providers let a name be changed, released, and taken by somebody else. A launch tied to the
 * text `@alice` follows whoever holds that name later, so the day they rename, a stranger inherits
 * the earnings — permanently, because the beneficiary is written into a contract's constructor.
 * Both providers expose a stable numeric id that is never reissued; that is what gets hashed, and
 * the handle is display text refreshed on every sign in.
 *
 * ⚠ There is no `wallet` provider. A wallet share is paid DIRECTLY
 * by {@link FeeSplitter} rather than ring-fenced in the claims contract, so an address never
 * needs to prove itself to be paid and never appears as an identity.
 */

import { keccak256, toBytes } from 'viem'

/** @typedef {'x' | 'github' | 'twitch'} ProviderName */

export const PROVIDERS = /** @type {readonly ProviderName[]} */ (['x', 'github', 'twitch'])

/**
 * ⛔⛔ The numbers {FeeSplitter} stores for each provider. The contract rebuilds `key()` from these,
 * so a number here that disagreed with `_prefix` there would make every launch naming that provider
 * revert `BeneficiaryMismatch`, or worse, pay a hash nobody can claim.
 */
export const PROVIDER_CODE = /** @type {const} */ ({ x: 1, github: 2, twitch: 3 })
export const PROVIDER_BY_CODE = /** @type {const} */ ({ 1: 'x', 2: 'github', 3: 'twitch' })

export function isProvider(value) {
  return typeof value === 'string' && PROVIDERS.includes(value)
}

/**
 * The only correct way to compare two identities, or to key one in a store.
 *
 * ⚠ Everything that decides who owns what goes through here. A `===` on ids somewhere would
 * compile, pass every ordinary test, and hand one provider's users the other provider's money.
 */
export function key(identity) {
  return `${identity.provider}:${identity.id}`
}

/**
 * ⭐⭐ The `bytes32` {@link FeesClaims} uses to keep one recipient's share apart from another's.
 *
 * ⚠⚠ Derived from the SAME string as {@link key}, so the on-chain identity and the off-chain one
 * cannot drift apart. If these two ever disagreed the server would compute an entitlement against
 * one beneficiary and sign a voucher for another, and every claim would revert with the money
 * sitting right there.
 *
 * ⚠ The contract never interprets this. That is deliberate: adding another way of proving who you
 * are needs no contract change at all — which is exactly how GitHub was added beside X.
 */
export function beneficiary(identity) {
  return keccak256(toBytes(key(identity)))
}

/** ⚠ Display only. Strips what people paste rather than what they type. */
export function cleanHandle(handle) {
  return String(handle ?? '')
    .trim()
    .replace(/^@/, '')
    .replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '')
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/^https?:\/\/(www\.|m\.)?twitch\.tv\//i, '')
    .replace(/\/.*$/, '')
}
