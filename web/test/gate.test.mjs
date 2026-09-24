/**
 * The launch gate: shut for everyone but the founder until the founder's $FEES is in the registry,
 * then open for all, with that token as the homepage CA.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FOUNDER, isFounder, launchesOpen, mayLaunch, platformToken } from '../src/lib/gate.ts'

const STRANGER = '0x00000000000000000000000000000000000000Ab'
const L = (creator, symbol, launchedAt, token = `0x${'1'.repeat(38)}${launchedAt.toString().padStart(2, '0')}`) =>
  ({ creator, symbol, launchedAt: BigInt(launchedAt), token })

test('shut when nothing has launched (and when the registry could not be read)', () => {
  assert.equal(launchesOpen([]), false)
  assert.equal(mayLaunch([], STRANGER), false)
  assert.equal(mayLaunch([], null), false)
  assert.equal(platformToken([]), null)
})

test('the founder may launch while it is shut, in any address case', () => {
  assert.equal(mayLaunch([], FOUNDER), true)
  assert.equal(mayLaunch([], FOUNDER.toLowerCase()), true)
  assert.equal(isFounder(FOUNDER.toUpperCase().replace('0X', '0x')), true)
})

test('a FEES launched by anybody else does NOT open it or become the CA', () => {
  const spoof = [L(STRANGER, 'FEES', 1)]
  assert.equal(launchesOpen(spoof), false)
  assert.equal(platformToken(spoof), null)
  assert.equal(mayLaunch(spoof, STRANGER), false)
})

test('another founder launch that is not FEES does not open it', () => {
  assert.equal(launchesOpen([L(FOUNDER, 'TEST', 1)]), false)
})

test("the founder's FEES opens it for everyone and is the CA", () => {
  const ls = [L(STRANGER, 'FEES', 1), L(FOUNDER.toLowerCase(), 'fees', 2)]
  assert.equal(launchesOpen(ls), true)
  assert.equal(mayLaunch(ls, STRANGER), true)
  assert.equal(mayLaunch(ls, null), true)
  assert.equal(platformToken(ls).launchedAt, 2n)
})

test('the EARLIEST founder FEES stays the CA if a second one is launched', () => {
  const ls = [L(FOUNDER, 'FEES', 9), L(FOUNDER, 'FEES', 3)]
  assert.equal(platformToken(ls).launchedAt, 3n)
})

test('a platform token launched ELSEWHERE (server-validated, external) opens it and is the CA', () => {
  const ext = { ...L(STRANGER, 'ANYTHING', 5), external: true }
  const ls = [L(STRANGER, 'FEES', 1), ext]
  assert.equal(launchesOpen(ls), true)
  assert.equal(platformToken(ls), ext)
  assert.equal(mayLaunch(ls, STRANGER), true)
})
