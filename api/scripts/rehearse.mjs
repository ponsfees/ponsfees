/**
 * The whole product on an anvil fork of Robinhood Chain, end to end, with no browser:
 *
 *   launch (shares: wallet 20%, X 50%, Twitch 30%) → real trades on the Pons curve → the KEEPER
 *   sweeps and harvests for real → the API signs in (stub) as the X and Twitch owners → /api/owed
 *   → /api/voucher → the claim is submitted → the payee's wallet balance is checked.
 *
 *   anvil --fork-url http://127.0.0.1:8899 --port 8546 --chain-id 4663
 *   (deploy with contracts/script/Deploy.s.sol, then)
 *   RHC_RPC=http://127.0.0.1:8546 LAUNCHPAD=0x… CLAIMS_ADDRESS=0x… node scripts/rehearse.mjs
 *
 * ⛔⛔ REFUSES A REAL NODE. A fork answers chain id 4663 exactly like mainnet does, so the chain id
 * proves nothing; `anvil_nodeInfo` exists only on anvil.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createPublicClient, createWalletClient, http, parseAbi, parseEther, keccak256, toBytes, formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const RPC = process.env.RHC_RPC ?? 'http://127.0.0.1:8546'
const LAUNCHPAD = process.env.LAUNCHPAD
const CLAIMS = process.env.CLAIMS_ADDRESS
const FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e'
/* anvil's well-known dev keys: 0 launches + keeps, 1 signs vouchers, 2 trades, 3 is the payee */
const K = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
]
const chain = { id: 4663, name: 'fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } }
const pub = createPublicClient({ chain, transport: http(RPC) })
const walletOf = (k) => createWalletClient({ account: privateKeyToAccount(k), chain, transport: http(RPC) })
const WALLET_SHARE = '0x000000000000000000000000000000000000fee5'

const fail = (msg) => { console.error(`⛔ ${msg}`); process.exit(1) }
const ok = (msg) => console.log(`✅ ${msg}`)

/* Same derivation as providers/stub.mjs, so the launch names the accounts the stub signs in as. */
const stubId = (provider, handle) =>
  BigInt('0x' + createHash('sha256').update(`${provider}:${handle.toLowerCase()}`).digest('hex').slice(0, 12)).toString()

const PAD_ABI = parseAbi([
  'struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }',
  'struct LaunchParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }',
  'struct Share { uint8 provider; uint16 bps; address wallet; uint256 accountId; bytes32 beneficiary; }',
  'struct DevBuy { uint256 quoteIn; uint256 minTokensOut; }',
  'function launch(LaunchParams params, uint256 launchConfigId, address pairToken, Share[] shares, DevBuy devBuy, address[] snipeTaxExemptions) payable returns (address token, address curve, address splitter)',
  'function count() view returns (uint256)',
  'struct Entry { address token; address curve; address splitter; address creator; address pairToken; uint64 launchedAt; }',
  'function page(uint256 offset, uint256 limit) view returns (Entry[])',
])
const FACTORY_ABI = parseAbi([
  'function launchFee() view returns (uint256)',
  'function previewLaunchEconomics(uint256 launchConfigId, address pairToken) view returns (bytes32)',
])
const CURVE_ABI = parseAbi([
  'function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256)',
  'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256)',
])
const ERC20_ABI = parseAbi(['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'])
const CLAIMS_ABI = parseAbi([
  'function claimable(address launch, bytes32 beneficiary, address asset) view returns (uint256)',
  'function claim(address launch, bytes32 beneficiary, address asset, address recipient, uint256 amount, bytes32 salt, uint256 deadline, bytes signature)',
])

async function main() {
  if (!LAUNCHPAD || !CLAIMS) fail('LAUNCHPAD and CLAIMS_ADDRESS are required')
  const info = await pub.request({ method: 'anvil_nodeInfo' }).catch(() => null)
  if (!info) fail(`${RPC} is not anvil. This rehearsal only runs on a fork.`)

  const xId = stubId('x', 'alice')
  const twId = stubId('twitch', 'alice')
  const shares = [
    { provider: 0, bps: 2000, wallet: WALLET_SHARE, accountId: 0n, beneficiary: '0x' + '00'.repeat(32) },
    { provider: 1, bps: 5000, wallet: '0x0000000000000000000000000000000000000000', accountId: BigInt(xId), beneficiary: keccak256(toBytes(`x:${xId}`)) },
    { provider: 3, bps: 3000, wallet: '0x0000000000000000000000000000000000000000', accountId: BigInt(twId), beneficiary: keccak256(toBytes(`twitch:${twId}`)) },
  ]

  // ── 1. launch ────────────────────────────────────────────────────────────────────────────
  const launcher = walletOf(K[0])
  const fee = await pub.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'launchFee' })
  const economics = await pub.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'previewLaunchEconomics', args: [0n, '0x0000000000000000000000000000000000000000'] })
  const params = {
    name: 'Fees Rehearsal', symbol: 'FREH', logo: '', description: 'Fees shared with @alice on X and twitch.tv/alice',
    socials: { twitter: '', telegram: '', discord: '', website: '', farcaster: '' },
    creatorFeeRecipient: '0x0000000000000000000000000000000000000000', creatorTaxBps: 0, buybackEnabled: false,
    expectedEconomics: economics, salt: keccak256(toBytes(`rehearse-${Date.now()}`)),
  }
  const devBuy = parseEther('0.01')
  const h1 = await launcher.writeContract({
    address: LAUNCHPAD, abi: PAD_ABI, functionName: 'launch',
    args: [params, 0n, '0x0000000000000000000000000000000000000000', shares, { quoteIn: devBuy, minTokensOut: 0n }, []],
    value: fee + devBuy,
  })
  const r1 = await pub.waitForTransactionReceipt({ hash: h1 })
  if (r1.status !== 'success') fail('launch reverted')
  const [entry] = await pub.readContract({ address: LAUNCHPAD, abi: PAD_ABI, functionName: 'page', args: [0n, 1n] })
  ok(`launched ${entry.token} splitter ${entry.splitter} (gas ${r1.gasUsed})`)

  // ── 2. trade, past the 3 second snipe window ────────────────────────────────────────────
  await pub.request({ method: 'evm_increaseTime', params: [10] })
  await pub.request({ method: 'evm_mine', params: [] })
  const trader = walletOf(K[2])
  await pub.waitForTransactionReceipt({ hash: await trader.writeContract({ address: entry.curve, abi: CURVE_ABI, functionName: 'buy', args: [parseEther('0.5'), 0n, trader.account.address], value: parseEther('0.5') }) })
  const bal = await pub.readContract({ address: entry.token, abi: ERC20_ABI, functionName: 'balanceOf', args: [trader.account.address] })
  await pub.waitForTransactionReceipt({ hash: await trader.writeContract({ address: entry.token, abi: ERC20_ABI, functionName: 'approve', args: [entry.curve, bal] }) })
  await pub.waitForTransactionReceipt({ hash: await trader.writeContract({ address: entry.curve, abi: CURVE_ABI, functionName: 'sell', args: [bal / 2n, 0n, trader.account.address] }) })
  ok('traded 0.5 ETH in and half back out')

  // ── 3. the keeper, for real ─────────────────────────────────────────────────────────────
  await run('node', ['keeper.mjs'], { RHC_RPC: RPC, LAUNCHPAD, KEEPER_KEY: K[0], STATUS: '/tmp/fees-status.json', MIN_NATIVE_WEI: '1' })
  const xBen = keccak256(toBytes(`x:${xId}`))
  const twBen = keccak256(toBytes(`twitch:${twId}`))
  const zero = '0x0000000000000000000000000000000000000000'
  const [xOwed, twOwed, walletGot] = await Promise.all([
    pub.readContract({ address: CLAIMS, abi: CLAIMS_ABI, functionName: 'claimable', args: [entry.token, xBen, zero] }),
    pub.readContract({ address: CLAIMS, abi: CLAIMS_ABI, functionName: 'claimable', args: [entry.token, twBen, zero] }),
    pub.getBalance({ address: WALLET_SHARE }),
  ])
  if (xOwed === 0n || twOwed === 0n || walletGot === 0n) fail(`keeper did not distribute: x ${xOwed} twitch ${twOwed} wallet ${walletGot}`)
  ok(`keeper distributed: wallet ${formatEther(walletGot)}, X ${formatEther(xOwed)}, Twitch ${formatEther(twOwed)} ETH`)
  const again = await run('node', ['keeper.mjs'], { RHC_RPC: RPC, LAUNCHPAD, KEEPER_KEY: K[0], STATUS: '/tmp/fees-status.json', MIN_NATIVE_WEI: '1' })
  if (/harvested\s+0x|swept curve\s+0x/.test(again)) fail('a second pass with nothing to do still sent a transaction')
  ok('a second pass sent nothing (no gas spent on empty work)')

  // ── 4. the API: sign in as the X and Twitch owners, ask what is owed, claim ─────────────
  const api = spawn('node', ['server.mjs'], {
    env: { ...process.env, PORT: '8812', PUBLIC_URL: 'http://127.0.0.1:8812', STUB_AUTH: '1', STUB_HANDLE: 'alice',
      RHC_RPC: RPC, LAUNCHPAD, CLAIMS_ADDRESS: CLAIMS, CLAIM_SIGNER_KEY: K[1], LOGO_DIR: '/tmp/fees-logos', STATUS: '/tmp/fees-status.json' },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  try {
    await new Promise((r) => setTimeout(r, 1500))
    let cookies = {}
    const jar = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ')
    const call = async (path, init = {}) => {
      const res = await fetch(`http://127.0.0.1:8812${path}`, { ...init, redirect: 'manual', headers: { ...(init.headers ?? {}), cookie: jar() } })
      for (const c of res.headers.getSetCookie()) {
        const [kv] = c.split(';'); const [k, v] = kv.split('='); cookies[k] = v
      }
      return res
    }
    for (const p of ['x', 'twitch']) {
      const start = await call(`/api/auth/start/${p}`)
      const cb = new URL(start.headers.get('location'))
      const done = await call(cb.pathname + cb.search)
      if (done.status !== 302) fail(`${p} sign in failed: ${done.status} ${await done.text()}`)
    }
    const me = await (await call('/api/me')).json()
    ok(`signed in as ${me.users.map((u) => `${u.provider}:${u.handle}`).join(' + ')}`)

    const owed = await (await call('/api/owed')).json()
    if (!owed.rows || owed.rows.length !== 2) fail(`/api/owed returned ${JSON.stringify(owed)}`)
    ok(`/api/owed: ${owed.rows.map((r) => `${r.payee.provider} ${r.bps / 100}%`).join(', ')}`)

    const payee = walletOf(K[3])
    const before = await pub.getBalance({ address: payee.account.address })
    let claimed = 0n
    for (const provider of ['x', 'twitch']) {
      const res = await call('/api/voucher', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ launch: entry.token, wallet: payee.account.address, asset: zero, provider }),
      })
      const body = await res.json()
      if (!res.ok) fail(`voucher for ${provider}: ${body.error}`)
      const v = body.voucher
      const r = await pub.waitForTransactionReceipt({ hash: await payee.writeContract({
        address: CLAIMS, abi: CLAIMS_ABI, functionName: 'claim',
        args: [v.launch, v.beneficiary, v.asset, v.recipient, BigInt(v.amount), v.salt, BigInt(v.deadline), v.signature],
      }) })
      if (r.status !== 'success') fail(`claim for ${provider} reverted`)
      claimed += BigInt(v.amount)
      /* ⛔ A second voucher for the same share must be refused: nothing is left. */
      const dup = await call('/api/voucher', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ launch: entry.token, wallet: payee.account.address, asset: zero, provider }),
      })
      if (dup.ok) fail(`a second ${provider} voucher was issued after the share was claimed`)
    }
    if (claimed !== xOwed + twOwed) fail(`claimed ${claimed}, owed ${xOwed + twOwed}`)
    const after = await pub.getBalance({ address: payee.account.address })
    ok(`claimed ${formatEther(claimed)} ETH for both accounts into ${payee.account.address}`)
    /* ⚠ The balance delta is net of gas at ANVIL's default price, far above RHC's real base fee, so it
       is printed for inspection and never asserted on. */
    console.log(`   payee balance moved ${formatEther(after - before)} ETH including fork-priced gas`)

    const status = await (await call('/api/status')).json()
    ok(`/api/status: ${status.level ?? 'n/a'}`)
    console.log('\nREHEARSAL PASSED')
  } finally {
    api.kill()
  }
}

function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    p.stdout.on('data', (d) => { out += d; process.stdout.write(`   keeper | ${d}`) })
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}`))))
  })
}

main().catch((err) => fail(err.shortMessage ?? err.message))
