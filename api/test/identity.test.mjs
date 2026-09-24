/**
 * ⛔⛔ The server, the launch form and FeeSplitter must derive the SAME beneficiary for an account,
 * or every claim is refused with the money sitting right there.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keccak256, toBytes } from 'viem'
import { beneficiary, key, PROVIDER_CODE, PROVIDERS, cleanHandle } from '../identity.mjs'
import { assetsOf } from '../claims.mjs'

test('beneficiary is keccak256("<provider>:<id>") for every provider', () => {
  for (const provider of PROVIDERS) {
    assert.equal(beneficiary({ provider, id: '12826' }), keccak256(toBytes(`${provider}:12826`)))
  }
})

test('the same number on two providers is two beneficiaries', () => {
  assert.notEqual(beneficiary({ provider: 'x', id: '7' }), beneficiary({ provider: 'twitch', id: '7' }))
  assert.equal(key({ provider: 'github', id: '7' }), 'github:7')
})

test('provider codes match FeeSplitter', () => {
  assert.deepEqual(PROVIDER_CODE, { x: 1, github: 2, twitch: 3 })
})

test('twitch links are cleaned to a login', () => {
  assert.equal(cleanHandle('https://www.twitch.tv/shroud'), 'shroud')
  assert.equal(cleanHandle('@shroud'), 'shroud')
})

test('a launch pays in native, its pair and its own token, deduplicated', () => {
  const Z = '0x0000000000000000000000000000000000000000'
  const T = '0x00000000000000000000000000000000000000Aa'
  assert.deepEqual(assetsOf(Z, T), [Z, T.toLowerCase()])
  assert.equal(assetsOf('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', T).length, 3)
})
