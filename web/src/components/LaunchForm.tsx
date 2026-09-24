import { useEffect, useMemo, useState } from 'react'
import { formatEther, formatUnits, getAddress, isAddress, parseAbi, parseUnits, type Address, type Hex } from 'viem'
import { useWallet } from '../lib/wallet.tsx'
import { useSession } from '../lib/session.tsx'
import { publicClient, short, txUrl } from '../lib/chain.ts'
import { NATIVE, PAIR_ASSETS, loadPairAssets, type PairAsset } from '../lib/pairs.ts'
import {
  LAUNCHPAD, LAUNCHPAD_ABI, LAUNCH_CONFIG_ID, isLive, previewEconomics, readFactoryState, type Launch,
} from '../lib/launchpad.ts'
import { defaultWebsite } from '../lib/brand.ts'
import { allBlank, blankRecipient, describeRecipients, effectiveRecipients, sharesError, toShares, type Recipient } from '../lib/shares.ts'
import { tokenHref } from '../lib/router.ts'
import { SharesEditor } from './SharesEditor.tsx'
import { GateModal } from './GateModal.tsx'
import { mayLaunch } from '../lib/gate.ts'
import { LogoField } from './LogoField.tsx'
import { Link } from './Link.tsx'
import { ProviderIcon } from './ConnectAccount.tsx'
import { checkLogo } from '../lib/logo.ts'

/** ⚠ Room left for the "Fees shared with …" line appended to the description. */
const DESC_MAX = 380

function parseDevBuy(raw: string, decimals: number): bigint {
  const t = raw.trim()
  if (!t) return 0n
  try {
    const v = parseUnits(t, decimals)
    return v > 0n ? v : 0n
  } catch { return 0n }
}

type Form = {
  name: string; symbol: string; logo: string; description: string
  website: string; twitter: string; telegram: string
  pair: Address; creatorTaxBps: number
  devBuy: string; exemptions: string[]
}

const BLANK: Form = {
  name: '', symbol: '', logo: '', description: '',
  website: '', twitter: '', telegram: '',
  pair: NATIVE, creatorTaxBps: 0,
  devBuy: '', exemptions: [],
}

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
])

type Result = { token: Address; splitter: Address; hash: Hex }

export function LaunchForm({ onLaunched, launches, loading }: { onLaunched: () => void; launches: Launch[]; loading: boolean }) {
  const { address, onRightChain, walletClient, switchChain } = useWallet()
  const session = useSession()
  const [f, setF] = useState<Form>(BLANK)
  const [recips, setRecips] = useState<Recipient[]>([blankRecipient('x')])
  const [fee, setFee] = useState<bigint | null>(null)
  const [maxTax, setMaxTax] = useState(1000)
  const [enabled, setEnabled] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [touched, setTouched] = useState<Set<keyof Form>>(new Set())
  const [tried, setTried] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [exemptDraft, setExemptDraft] = useState('')
  const [exemptErr, setExemptErr] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  /* ⭐ The launch gate. Shut (for everyone but the founder's wallet) until $FEES is launched from
     it, then open for everybody on its own. Still loading counts as shut. @see lib/gate.ts */
  const [gateShown, setGateShown] = useState(false)
  const launchAllowed = !loading && mayLaunch(launches, address)
  /* ⛔ A launch without an image is permanent: Pons token metadata has no setter. So it takes a
     second, deliberate click, never the same click that would have launched with one. */
  const [noLogoOk, setNoLogoOk] = useState(false)
  useEffect(() => { if (f.logo.trim()) setNoLogoOk(false) }, [f.logo])
  /* ⭐ What the chain actually recorded, read back after the launch. */
  const [landed, setLanded] = useState<{ ok: boolean; note: string } | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const s = await readFactoryState()
        if (!alive) return
        setFee(s.fee); setMaxTax(s.maxTax); setEnabled(s.enabled)
      } catch { /* the summary shows dashes */ }
    })()
    return () => { alive = false }
  }, [])

  /* ⚠ The first row defaults to X, but only if the server can resolve X. Otherwise it becomes a
     wallet row rather than a row that can never be completed. */
  useEffect(() => {
    if (session.up === null) return
    const kinds = session.providers.map((p) => p.name)
    setRecips((rs) => rs.length === 1 && !rs[0]!.value && rs[0]!.kind !== 'wallet' && !kinds.includes(rs[0]!.kind as never)
      ? [{ ...rs[0]!, kind: kinds[0] ?? 'wallet' }]
      : rs)
  }, [session.up, session.providers])

  /* ⛔ Seeded, then replaced by what the chain says: Pons approves new pair assets and a literal
     list in our repo goes stale. */
  const [assets, setAssets] = useState<PairAsset[]>(PAIR_ASSETS)
  useEffect(() => {
    let live = true
    loadPairAssets().then((a) => { if (live) setAssets(a) }).catch(() => {})
    return () => { live = false }
  }, [])
  const pair = useMemo<PairAsset>(
    () => assets.find((p) => p.address.toLowerCase() === f.pair.toLowerCase()) ?? assets[0]!,
    [f.pair, assets],
  )

  /* ⭐ Blank recipients mean "keep the fees": the launcher's wallet takes 100%. */
  const selfOnly = allBlank(recips)
  const finalRecips = effectiveRecipients(recips, address)
  const sharesBad = selfOnly && !address ? null : sharesError(finalRecips)
  const autoLine = describeRecipients(finalRecips)
  const fullDescription = [f.description.trim(), autoLine].filter(Boolean).join('\n\n')

  const errors = useMemo(() => {
    const e: Partial<Record<keyof Form, string>> = {}
    if (!f.name.trim()) e.name = 'Required'
    if (!f.symbol.trim()) e.symbol = 'Required'
    else if (!/^[A-Za-z0-9]{2,11}$/.test(f.symbol.trim())) e.symbol = '2 to 11 letters or digits'
    if (f.devBuy.trim() && parseDevBuy(f.devBuy, pair.decimals) === 0n) e.devBuy = 'Enter an amount, or leave it empty'
    if (f.exemptions.length > 8) e.exemptions = 'Pons caps how many wallets a launch can declare'
    if (f.creatorTaxBps < 0 || f.creatorTaxBps > maxTax) e.creatorTaxBps = `0 to ${maxTax / 100}%`
    const lg = checkLogo(f.logo)
    if (!lg.ok) e.logo = lg.error ?? 'Not a usable image link'
    return e
  }, [f, maxTax, pair.decimals])

  async function submit() {
    /* ⛔ Checked here as well as on the button, so no other path into submit skips it. */
    if (!launchAllowed) { setGateShown(true); return }
    if (!walletClient || !address) return
    setTried(true)
    if (Object.keys(errors).length > 0 || sharesBad) return
    if (uploading) { setErr('The image is still uploading. Launch once it has finished.'); return }
    if (!f.logo.trim() && !noLogoOk) {
      setNoLogoOk(true)
      setErr('This token has no image, and one can never be added after launch. Press launch again to go ahead without one.')
      return
    }
    setErr(null); setLanded(null); setBusy('Reading the launch terms…')
    try {
      /* ⛔ Read now, never earlier: Pons reverts a launch whose economics moved since the pin. */
      const economics = await previewEconomics(f.pair)
      const salt = ('0x' + crypto.getRandomValues(new Uint8Array(32))
        .reduce((s, b) => s + b.toString(16).padStart(2, '0'), '')) as Hex

      const params = {
        name: f.name.trim(),
        symbol: f.symbol.trim().toUpperCase(),
        logo: f.logo.trim(),
        /* ⭐ Names who is paid in the token itself, so Pons and every terminal show it. */
        description: fullDescription,
        socials: {
          twitter: f.twitter.trim(), telegram: f.telegram.trim(),
          discord: '', website: defaultWebsite(f.website), farcaster: '',
        },
        /* ⚠ Ignored: the launchpad overwrites it with the splitter it creates. */
        creatorFeeRecipient: '0x0000000000000000000000000000000000000000' as Address,
        creatorTaxBps: f.creatorTaxBps,
        buybackEnabled: false,
        expectedEconomics: economics,
        salt,
      }

      /* ⛔⛔ PERMANENT. Built by `toShares`, which throws on anything `sharesError` refuses. */
      const shares = toShares(finalRecips)

      /* ⛔⛔ The value is EXACT: `launchFee + quoteIn` on a native pair, `launchFee` alone on an
         ERC-20 one, where the buy comes out of an allowance instead. */
      const isNativePair = f.pair.toLowerCase() === NATIVE.toLowerCase()
      const buyWei = parseDevBuy(f.devBuy, pair.decimals)
      const value = (fee ?? 0n) + (isNativePair ? buyWei : 0n)
      const exemptions = f.exemptions.filter((a) => isAddress(a)) as Address[]

      if (!isNativePair && buyWei > 0n) {
        const spender = LAUNCHPAD as Address
        const [held, allowed] = await Promise.all([
          publicClient.readContract({ address: f.pair, abi: ERC20, functionName: 'balanceOf', args: [address] }),
          publicClient.readContract({ address: f.pair, abi: ERC20, functionName: 'allowance', args: [address, spender] }),
        ])
        if (held < buyWei) {
          throw new Error(`SHORT_PAIR_BALANCE:That wallet holds ${formatUnits(held, pair.decimals)} ${pair.symbol}, and the developer buy needs ${formatUnits(buyWei, pair.decimals)}.`)
        }
        if (allowed < buyWei) {
          setBusy(`Approve ${formatUnits(buyWei, pair.decimals)} ${pair.symbol} for the launchpad…`)
          const { request } = await publicClient.simulateContract({
            address: f.pair, abi: ERC20, functionName: 'approve', args: [spender, buyWei], account: address,
          })
          const approveHash = await walletClient.writeContract(request)
          setBusy('Waiting for the approval…')
          const rec = await publicClient.waitForTransactionReceipt({ hash: approveHash })
          if (rec.status !== 'success') throw new Error('The approval did not go through, so nothing was launched.')
        }
      }

      /* ⭐ Simulated first, so almost every failure is a sentence before anything is signed. */
      setBusy('Checking the launch will succeed…')
      const { request, result: out } = await publicClient.simulateContract({
        address: LAUNCHPAD as Address, abi: LAUNCHPAD_ABI, functionName: 'launch', account: address, value,
        args: [params, LAUNCH_CONFIG_ID, f.pair, shares, { quoteIn: buyWei, minTokensOut: 0n }, exemptions],
      })
      setBusy('Confirm in your wallet…')
      const hash = await walletClient.writeContract(request)
      setBusy('Waiting for the block…')
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error('The launch transaction reverted.')

      /* ⛔ Confirmed from the registry, not from the simulation: another launch landing first
         would change the addresses the simulation predicted. entryOf reverts for a token this
         launchpad did not make, so a mismatch surfaces rather than showing somebody else's. */
      const predicted = out[0] as Address
      const entry = await publicClient.readContract({
        address: LAUNCHPAD as Address, abi: LAUNCHPAD_ABI, functionName: 'entryOf', args: [predicted],
      }).catch(() => null)
      const page = entry ?? (await publicClient.readContract({
        address: LAUNCHPAD as Address, abi: LAUNCHPAD_ABI, functionName: 'page', args: [0n, 1n],
      }))[0]!
      setResult({ token: page.token, splitter: page.splitter, hash })

      /* ⛔⛔ VERIFIED OFF THE CHAIN, NOT OFF THE PARAMS WE SENT. Comparing what was submitted with
         itself proves nothing; the token's own getters are what every site and terminal will read. */
      try {
        const META = parseAbi(['function name() view returns (string)', 'function symbol() view returns (string)', 'function logo() view returns (string)'])
        const [n, sym, lg] = await Promise.all([
          publicClient.readContract({ address: page.token, abi: META, functionName: 'name' }),
          publicClient.readContract({ address: page.token, abi: META, functionName: 'symbol' }),
          publicClient.readContract({ address: page.token, abi: META, functionName: 'logo' }),
        ])
        const bad: string[] = []
        if (n !== params.name) bad.push('name')
        if (sym !== params.symbol) bad.push('symbol')
        if (lg !== params.logo) bad.push('image')
        let reachable = true
        if (lg) reachable = await fetch(lg.startsWith('ipfs://') ? `https://ipfs.filebase.io/ipfs/${lg.slice(7)}` : lg, { method: 'HEAD' })
          .then((r) => r.ok).catch(() => false)
        setLanded(bad.length
          ? { ok: false, note: `The chain recorded a different ${bad.join(', ')} than the form sent. Check the token before sharing it.` }
          : !lg ? { ok: true, note: 'Name and symbol confirmed on chain. This token has no image.' }
          : reachable ? { ok: true, note: 'Name, symbol and image confirmed on chain, and the image loads.' }
          : { ok: false, note: 'The image is recorded on chain but did not load just now. It may be slow; check the token page.' })
      } catch {
        setLanded({ ok: false, note: 'Launched, but the token could not be read back just now. Check the token page.' })
      }
      setF(BLANK); setRecips([blankRecipient(session.providers[0]?.name ?? 'wallet')])
      setTouched(new Set()); setTried(false)
      onLaunched()
    } catch (e) {
      const m = (e as Error).message ?? ''
      const reason = m.split('\n')[0]!.trim().slice(0, 160)
      setErr(
        /User rejected|denied/i.test(m) ? 'You cancelled the signature. Nothing was signed.'
          : /EconomicsMoved/.test(m) ? 'The curve terms moved while you were filling this in. Try again.'
          : /PairTokenNotApproved/.test(m) ? 'Pons does not accept that pair asset.'
          : /LaunchesClosed/.test(m) ? 'Pons is not accepting launches right now.'
          : /BadShares|BeneficiaryMismatch/.test(m) ? 'The recipients did not check out. Look them up again and retry.'
          : /SHORT_PAIR_BALANCE:/.test(m) ? m.split('SHORT_PAIR_BALANCE:')[1]!
          : /insufficient funds/i.test(m) ? 'That wallet does not hold enough ETH for the launch fee and gas.'
          : /SafeERC20FailedOperation|0x5274afe7/.test(m) ? `The launchpad could not take the ${pair.symbol} for the developer buy. Approve it and try again.`
          : `Could not complete that launch. Nothing was signed and nothing left your wallet.${reason ? ` (${reason})` : ''}`,
      )
    } finally {
      setBusy(null)
    }
  }

  const set = <K extends keyof Form>(k: K) => (v: Form[K]) => setF((p) => ({ ...p, [k]: v }))
  /* ⛔⛔ THE + BUTTON ALWAYS ANSWERS. It used to be silently disabled for anything `isAddress`
     refused, which included a real address in the wrong mixed case (strict checksum) and a paste
     with stray characters ("aa0x…"), so it looked broken. Now case is normalised, and anything
     else gets a sentence saying what is wrong with it. */
  const addExempt = () => {
    const raw = exemptDraft.trim()
    if (!raw) return
    if (!isAddress(raw, { strict: false })) {
      const inside = raw.match(/0x[0-9a-fA-F]{40}/)
      setExemptErr(inside
        ? `That has extra characters around the address. Did you mean ${inside[0].slice(0, 6)}…${inside[0].slice(-4)}?`
        : 'That is not a wallet address. It should be 0x followed by 40 characters.')
      return
    }
    const a = getAddress(raw.toLowerCase())
    if (f.exemptions.some((x) => x.toLowerCase() === a.toLowerCase())) { setExemptErr('That wallet is already on the list.'); return }
    if (f.exemptions.length >= 8) { setExemptErr('Pons caps a launch at 8 exempt wallets.'); return }
    setF((p) => ({ ...p, exemptions: [...p.exemptions, a] }))
    setExemptDraft('')
    setExemptErr(null)
  }
  const blur = (k: keyof Form) => () => setTouched((p) => new Set(p).add(k))
  const shown = (k: keyof Form) => (tried || touched.has(k) ? errors[k] : undefined)

  if (result) {
    return (
      <section className="page" id="launch">
        <div className="wrap">
          <div className="head head--center">
            <p className="eyebrow">Launched</p>
            <h2>Your token is <span className="hl">live</span></h2>
          </div>
          <div className="panel panel--pad launched">
            <div className="kv"><span className="kv__k">Token</span>
              <Link className="kv__v mono" to={tokenHref(result.token)}>{result.token}</Link></div>
            <div className="kv"><span className="kv__k">Fee splitter</span>
              <span className="kv__v mono">{result.splitter}</span></div>
            <div className="kv"><span className="kv__k">Transaction</span>
              <a className="kv__v mono" href={txUrl(result.hash)} target="_blank" rel="noreferrer">View</a></div>
            {landed && <p className={landed.ok ? 'field__h' : 'field__err'} style={{ marginTop: 12 }}>{landed.note}</p>}
            <p className="launched__note">
              The splitter is this token's fee recipient and cannot be changed. Every fee it earns is
              split between the recipients you chose, and each account claims its share by signing in.
            </p>
            <button className="btn launched__again" onClick={() => setResult(null)}>Launch another</button>
          </div>
        </div>
      </section>
    )
  }

  const pct = (bps: number) => { const n = bps / 100; return n % 1 === 0 ? n : Number(n.toFixed(1)) }

  return (
    <section className="page" id="launch">
      <div className="wrap">
        <div className="chead">
          <p className="eyebrow" style={{ justifyContent: 'center' }}>Launch</p>
          <h1 className="chead__h">Launch a token</h1>
          <p className="chead__sub">
            The recipients and their shares are written into the contract and can never be changed.
          </p>
        </div>

        {!enabled && (
          <div className="banner" style={{ marginBottom: 26 }}>
            <strong>Pons is not accepting launches at the moment.</strong> This is set on their factory. Try again shortly.
          </div>
        )}

        <div className="launch__grid">
          <div className="panel panel--pad">
            <div className="row">
              <div className="field">
                <label className="field__l" htmlFor="name">Token name</label>
                <input id="name" className="input" placeholder="Stream Coin" value={f.name}
                  onChange={(e) => set('name')(e.target.value)} onBlur={blur('name')} maxLength={64} />
                {shown('name') && <p className="field__err">{shown('name')}</p>}
              </div>
              <div className="field">
                <label className="field__l" htmlFor="symbol">Symbol</label>
                <input id="symbol" className="input mono" placeholder="STREAM" value={f.symbol}
                  onChange={(e) => set('symbol')(e.target.value.toUpperCase())} onBlur={blur('symbol')} maxLength={11} />
                {shown('symbol') && <p className="field__err">{shown('symbol')}</p>}
              </div>
            </div>

            <LogoField value={f.logo} onChange={set('logo')} error={shown('logo')} onBusy={setUploading} />

            <div className="field">
              <label className="field__l" htmlFor="desc">Description</label>
              <textarea id="desc" className="textarea" placeholder="What this token is for."
                value={f.description} onChange={(e) => set('description')(e.target.value)} maxLength={DESC_MAX} />
              {autoLine && <p className="field__h">Added to the description: {autoLine}</p>}
            </div>

            <div className="row">
              <div className="field">
                <label className="field__l" htmlFor="site">Website</label>
                <input id="site" className="input" placeholder="https://" value={f.website}
                  onChange={(e) => set('website')(e.target.value)} />
              </div>
              <div className="field">
                <label className="field__l" htmlFor="tw">X / Twitter</label>
                <input id="tw" className="input" placeholder="@handle" value={f.twitter}
                  onChange={(e) => set('twitter')(e.target.value)} />
              </div>
            </div>

            <hr className="rule" />

            <SharesEditor value={recips} onChange={setRecips} />
            {selfOnly && <p className="field__h">Left empty, all fees go to your own wallet.</p>}
            {(tried || recips.some((r) => r.value.trim())) && sharesBad && <p className="field__err">{sharesBad}</p>}

            <hr className="rule" />

            <div className="field">
              <label className="field__l" htmlFor="pair">Paired asset</label>
              <select id="pair" className="select" value={f.pair} onChange={(e) => set('pair')(e.target.value as Address)}>
                {assets.map((p) => <option key={p.address} value={p.address}>{p.symbol}</option>)}
              </select>
              <p className="field__h">Fees are earned and paid out in this asset.</p>
            </div>

            <div className="field">
              <label className="field__l" htmlFor="devbuy">
                Developer buy <span style={{ color: 'var(--text-dim)', fontWeight: 500 }}>(optional, in {pair.symbol})</span>
              </label>
              <input id="devbuy" className="input" inputMode="decimal" placeholder="0.0"
                value={f.devBuy} onChange={(e) => set('devBuy')(e.target.value)} />
              {errors.devBuy && <p className="field__err">{errors.devBuy}</p>}
            </div>

            <div className="field">
              <label className="field__l" htmlFor="exempt">Snipe tax exemptions</label>
              <div className="tagin">
                <input id="exempt" className="input" placeholder="0x wallet address" value={exemptDraft} autoComplete="off"
                  onChange={(e) => { setExemptDraft(e.target.value); setExemptErr(null) }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addExempt() } }} />
                <button type="button" className="tagin__add" onClick={addExempt}
                  aria-label="Add this wallet" disabled={!exemptDraft.trim()}>+</button>
              </div>
              {f.exemptions.length > 0 && (
                <div className="xtags">
                  {f.exemptions.map((a) => (
                    <span className="xtag" key={a}>
                      <span className="mono">{short(a, 4)}</span>
                      <button type="button" onClick={() => set('exemptions')(f.exemptions.filter((x) => x !== a))}
                        aria-label={`Remove ${a}`}>&times;</button>
                    </span>
                  ))}
                </div>
              )}
              {exemptErr && <p className="field__err">{exemptErr}</p>}
              <p className="field__h">Buys in the launch second pay 99%, decaying to zero across 3s.</p>
              {errors.exemptions && <p className="field__err">{errors.exemptions}</p>}
            </div>

            <div className="field">
              <label className="field__l" htmlFor="tax">
                Creator tax <span style={{ color: 'var(--text-dim)', fontWeight: 500 }}>({(f.creatorTaxBps / 100).toFixed(2)}%)</span>
              </label>
              <input id="tax" type="range" min={0} max={maxTax} step={25}
                value={f.creatorTaxBps} onChange={(e) => set('creatorTaxBps')(Number(e.target.value))} />
              <p className="field__h">An extra fee on every trade, paid in full to the recipients above.</p>
              {errors.creatorTaxBps && <p className="field__err">{errors.creatorTaxBps}</p>}
            </div>
          </div>

          <aside className="aside">
            <div className="panel panel--pad">
              <p className="eyebrow" style={{ marginBottom: '0.9rem' }}>What you are signing</p>
              <div className="kv"><span className="kv__k">Launch fee</span>
                <span className="kv__v mono">{fee === null ? '0' : `${formatEther(fee)} ETH`}</span></div>
              <div className="kv"><span className="kv__k">Trading fee</span>
                <span className="kv__v">{f.creatorTaxBps ? `${(1 + f.creatorTaxBps / 100).toFixed(2)}%` : '1%'}</span></div>
              <div className="kv"><span className="kv__k">Paired asset</span>
                <span className="kv__v">{pair.symbol}</span></div>
              {/* ⛔ Every destination named, as a share of the creator fees: the last thing read
                  before a signature that cannot be undone. */}
              <div style={{ marginTop: 14 }}>
                {finalRecips.map((r) => (
                  <div className="kv kv--loud" key={r.id}>
                    <span className="kv__k" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      {r.kind !== 'wallet' && <ProviderIcon provider={r.kind} />}
                      {r.kind === 'wallet'
                        ? (r.id === 'self' ? 'Your wallet' : r.value.trim() ? short(r.value.trim(), 4) : 'A wallet')
                        : r.resolved ? `@${r.resolved.handle}` : 'An account'}
                    </span>
                    <span className="kv__v">{pct(r.bps)}%</span>
                  </div>
                ))}
              </div>
            </div>

            {err && <div className="panel panel--pad"><p className="field__err" style={{ margin: 0 }}>{err}</p></div>}

            {!address ? (
              <div className="banner" style={{ margin: 0 }}>Connect a wallet to launch.</div>
            ) : !onRightChain ? (
              <button className="btn btn--lg" onClick={() => void switchChain()}>Switch to Robinhood Chain</button>
            ) : (
              /* ⚠ Enabled while the form is incomplete: pressing it marks every field so the reason
                 is on screen. A disabled button with no reason reads as a broken site. */
              <button className="btn btn--ink btn--lg" disabled={!!busy || uploading || !enabled || !isLive()} onClick={() => void submit()}>
                {busy ?? (uploading ? 'Uploading image…' : !f.logo.trim() && noLogoOk ? 'Launch without an image' : 'Launch token')}
              </button>
            )}
          </aside>
        </div>
      </div>
      {gateShown && <GateModal onClose={() => setGateShown(false)} />}
    </section>
  )
}
