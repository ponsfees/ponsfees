/**
 * The rules FeeSplitter reverts on, checked before anything is signed.
 *   node --experimental-strip-types --test test/*.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keccak256, toBytes } from 'viem'
import {
  sharesError, toShares, withShare, rebalance, normaliseHandle, describeRecipients, PROVIDER_CODE,
} from '../src/lib/shares.ts'

const acct = (provider, id, handle, bps) => ({ id: `${provider}${id}`, kind: provider, value: handle, resolved: { provider, id: String(id), handle, name: handle, avatar: null }, bps })
const wallet = (a, bps) => ({ id: a, kind: 'wallet', value: a, resolved: null, bps })
const W = '0x00000000000000000000000000000000000000aa'

test('provider codes match FeeSplitter (x=1, github=2, twitch=3)', () => {
  assert.deepEqual(PROVIDER_CODE, { x: 1, github: 2, twitch: 3 })
})

test('an account share hashes "<provider>:<id>" exactly as the contract rebuilds it', () => {
  const [s] = toShares([acct('twitch', 12826, 'twitch', 10000)])
  assert.equal(s.provider, 3)
  assert.equal(s.accountId, 12826n)
  assert.equal(s.beneficiary, keccak256(toBytes('twitch:12826')))
  assert.equal(s.wallet, '0x0000000000000000000000000000000000000000')
})

test('shares must total exactly 100%', () => {
  assert.match(sharesError([acct('x', 1, 'a', 5000), wallet(W, 4000)]), /exactly 100%/)
  assert.equal(sharesError([acct('x', 1, 'a', 6000), wallet(W, 4000)]), null)
})

test('an unresolved account cannot be launched', () => {
  const r = { id: 'q', kind: 'x', value: 'someone', resolved: null, bps: 10000 }
  assert.match(sharesError([r]), /Find each account/)
  assert.throws(() => toShares([r]))
})

test('a row whose kind changed after lookup is refused', () => {
  const r = { ...acct('x', 5, 'a', 10000), kind: 'twitch' }
  assert.match(sharesError([r]), /again/)
})

test('the same account twice is refused', () => {
  assert.match(sharesError([acct('x', 7, 'a', 5000), { ...acct('x', 7, 'a', 5000), id: 'dup' }]), /already/)
})

test('the same id on two providers is two different people and allowed', () => {
  assert.equal(sharesError([acct('x', 7, 'a', 5000), acct('github', 7, 'a', 5000)]), null)
})

test('withShare keeps the total at 100 and every row at 1% or more', () => {
  const rs = [acct('x', 1, 'a', 3400), acct('github', 2, 'b', 3300), acct('twitch', 3, 'c', 3300)]
  for (const typed of [1, 50, 98, 99, 150, -5]) {
    const out = withShare(rs, 'x1', typed)
    assert.equal(out.reduce((n, x) => n + x.bps, 0), 10000, `typed ${typed}`)
    assert.ok(out.every((x) => x.bps >= 100))
  }
})

test('rebalance splits evenly with the first row taking the rounding', () => {
  const out = rebalance([wallet(W, 0), acct('x', 1, 'a', 0), acct('x', 2, 'b', 0)])
  assert.deepEqual(out.map((x) => x.bps), [3400, 3300, 3300])
})

test('pasted profile links become handles', () => {
  assert.equal(normaliseHandle('https://twitch.tv/Shroud'), 'Shroud')
  assert.equal(normaliseHandle('https://x.com/jack/status/20'), 'jack')
  assert.equal(normaliseHandle('@jack'), 'jack')
  assert.equal(normaliseHandle('https://github.com/torvalds'), 'torvalds')
})

test('the description line names accounts, not wallets', () => {
  assert.equal(describeRecipients([acct('x', 1, 'jack', 5000), acct('twitch', 2, 'shroud', 3000), wallet(W, 2000)]),
    'Fees shared with @jack, twitch.tv/shroud')
  assert.equal(describeRecipients([wallet(W, 10000)]), '')
})
