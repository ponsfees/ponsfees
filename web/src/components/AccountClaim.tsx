import { useCallback, useEffect, useState } from 'react'
import { formatUnits, type Hex } from 'viem'
import { publicClient, txUrl, short } from '../lib/chain.ts'
import { useWallet } from '../lib/wallet.tsx'
import { useSession } from '../lib/session.tsx'
import { owed, requestVoucher, type OwedRow, type Provider } from '../lib/identityApi.ts'
import { ConnectButtons, ProviderIcon, providerLabel } from './ConnectAccount.tsx'
import { pairBy, NATIVE } from '../lib/pairs.ts'
import { CLAIMS_ABI, type Launch } from '../lib/launchpad.ts'
import { tokenHref } from '../lib/router.ts'
import { Link } from './Link.tsx'

const fmt = (v: bigint, d: number) => {
  const n = Number(formatUnits(v, d))
  if (n === 0) return '0'
  if (n < 0.000001) return '<0.000001'
  return n.toLocaleString('en-US', { maximumFractionDigits: 6 })
}

/**
 * The claim page: everything a launch has set aside for the visitor's X, Twitch or GitHub accounts.
 *
 * ## How it is safe
 *
 * The money is held in `FeesClaims`, ring-fenced per (launch, account, asset). Signing in proves
 * the account; the server then signs a voucher for exactly what that account holds, payable to the
 * wallet the visitor names, and the visitor submits it and pays the gas. The server's key can sign
 * vouchers and nothing else.
 */
export function AccountClaim({ launches }: { launches: Launch[] }) {
  const session = useSession()
  const { address, walletClient, onRightChain, switchChain } = useWallet()
  const [rows, setRows] = useState<OwedRow[] | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<{ what: string; hash: Hex } | null>(null)

  const load = useCallback(async () => {
    if (session.users.length === 0) { setRows(null); return }
    const r = await owed()
    if (!r.ok) { setLoadErr(r.error); setRows([]); return }
    setLoadErr(null)
    setRows(r.rows)
  }, [session.users])

  useEffect(() => { void load() }, [load])

  const launchOf = (token: string) => launches.find((l) => l.token.toLowerCase() === token.toLowerCase())
  const assetMeta = (asset: string, launch: string) => {
    if (asset.toLowerCase() === NATIVE.toLowerCase()) return { symbol: 'ETH', decimals: 18 }
    if (asset.toLowerCase() === launch.toLowerCase()) return { symbol: launchOf(launch)?.symbol ?? 'tokens', decimals: 18 }
    const p = pairBy(asset)
    return { symbol: p?.symbol ?? 'tokens', decimals: p?.decimals ?? 18 }
  }

  async function claim(row: OwedRow, asset: string) {
    if (!walletClient || !address) return
    setErr(null); setDone(null)
    const key = `${row.launch}|${row.payee.provider}|${asset}`
    try {
      setBusy(key)
      const issued = await requestVoucher({ launch: row.launch, wallet: address, provider: row.payee.provider, asset })
      if (!issued.ok) { setErr(issued.error); return }
      const v = issued.voucher
      /* ⛔ The VOUCHER's own fields are sent: the signature covers exactly these values.
         ⛔ Simulated first, so an expired voucher or a paused contract is a sentence, not gas. */
      const { request } = await publicClient.simulateContract({
        address: issued.contract, abi: CLAIMS_ABI, functionName: 'claim', account: address,
        args: [v.launch, v.beneficiary, v.asset, v.recipient, BigInt(v.amount), v.salt, BigInt(v.deadline), v.signature],
      })
      const hash = await walletClient.writeContract(request)
      await publicClient.waitForTransactionReceipt({ hash })
      const m = assetMeta(asset, row.launch)
      setDone({ what: `${fmt(BigInt(v.amount), m.decimals)} ${m.symbol}`, hash })
      await load()
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      setErr(
        /User rejected|denied/i.test(m) ? 'You cancelled the signature. Nothing moved.'
          : /IsPaused/.test(m) ? 'Claiming is paused right now. Nothing is lost, try again later.'
          : /VoucherExpired/.test(m) ? 'That took too long and the approval expired. Try again.'
          : m.split('\n')[0]!,
      )
    } finally {
      setBusy(null)
    }
  }

  if (session.up === false) {
    return <div className="empty">Account sign-in is unreachable right now. Everything owed is safe on chain.</div>
  }

  if (session.users.length === 0) {
    return (
      <section className="panel panel--pad acctcard">
        <p className="eyebrow" style={{ justifyContent: 'center' }}>Fees assigned to your account</p>
        <p className="acctcard__lede">
          A launch can share its fees with an X, Twitch or GitHub account. Your share is held on
          chain for that account, and only you can claim it, by signing in with it.
        </p>
        {session.providers.length === 0
          ? <p className="field__err">Account sign-in is not available right now.</p>
          : <div className="acctcard__actions"><ConnectButtons /></div>}
      </section>
    )
  }

  /* ⭐ Singular with one account signed in, plural with more: "this account" / "these accounts". */
  const one = session.users.length === 1
  const payable = (rows ?? []).flatMap((r) => r.assets.filter((a) => BigInt(a.available) > 0n || BigInt(a.onChain) > 0n).map((a) => ({ r, a })))

  return (
    <section className="panel panel--pad acctcard">
      <p className="eyebrow" style={{ justifyContent: 'center' }}>Fees assigned to {one ? 'your account' : 'your accounts'}</p>
      <div className="acctcard__who">
        {session.users.map((u) => (
          <span className="acctchip" key={u.provider}>
            <ProviderIcon provider={u.provider} />{u.handle}
            <button type="button" className="acctchip__x" aria-label={`Disconnect ${providerLabel(u.provider)}`}
              onClick={() => void session.signOut(u.provider)}>×</button>
          </span>
        ))}
        <ConnectButtons />
      </div>

      {session.stub && (
        <p className="field__err" style={{ marginTop: 8 }}>Sign-in is stubbed on this deployment: anyone can sign in as anyone.</p>
      )}
      {loadErr && <p className="field__err" style={{ marginTop: 10 }}>{loadErr}</p>}
      {rows === null && <p className="field__h" style={{ marginTop: 10 }}>Looking…</p>}
      {rows !== null && rows.length === 0 && !loadErr && (
        <p className="field__h" style={{ marginTop: 10 }}>
          {one
            ? 'No token pays this account yet. When fees are shared to your account it appears here.'
            : 'No token pays these accounts yet. When fees are shared to your accounts they appear here.'}
        </p>
      )}
      {rows !== null && rows.length > 0 && payable.length === 0 && (() => {
        const n = new Set(rows.map((r) => r.launch.toLowerCase())).size
        return (
          <p className="field__h" style={{ marginTop: 10 }}>
            {n === 1 ? 'One token pays' : `${n} tokens pay`} {one ? 'this account' : 'these accounts'}, and nothing is waiting to be
            claimed right now. New fees are collected every 15 minutes while the token trades.
          </p>
        )
      })()}

      {payable.map(({ r, a }) => {
        const l = launchOf(r.launch)
        const m = assetMeta(a.asset, r.launch)
        const available = BigInt(a.available)
        const reserved = BigInt(a.reserved)
        const key = `${r.launch}|${r.payee.provider}|${a.asset}`
        return (
          <div className="owed" key={key}>
            <div className="kv">
              <span className="kv__k">
                <Link to={tokenHref(r.launch)}>{l ? `$${l.symbol}` : short(r.launch)}</Link>
              </span>
              <span className="kv__v mono">{fmt(available, m.decimals)} {m.symbol}</span>
            </div>
            <p className="field__h" style={{ marginTop: 4 }}>
              For <strong>@{r.payee.handle}</strong> on {providerLabel(r.payee.provider as Provider)}, {r.bps / 100}% of this launch's fees.
              {reserved > 0n && <> {fmt(reserved, m.decimals)} {m.symbol} is already approved and waiting to be claimed.</>}
            </p>
            {!address ? (
              <p className="field__h">Connect a wallet to choose where it is paid.</p>
            ) : !onRightChain ? (
              <button className="btn btn--sm" onClick={() => void switchChain()}>Switch to Robinhood Chain</button>
            ) : (
              <button className="btn btn--ink btn--sm" disabled={available === 0n || !!busy} onClick={() => void claim(r, a.asset)}>
                {busy === key ? 'Claiming…' : `Claim to ${short(address, 4)}`}
              </button>
            )}
          </div>
        )
      })}

      {err && <p className="field__err" style={{ marginTop: 12 }}>{err}</p>}
      {done && (
        <p className="field__h" style={{ marginTop: 12 }}>
          Claimed {done.what}. <a href={txUrl(done.hash)} target="_blank" rel="noreferrer">View transaction</a>
        </p>
      )}
    </section>
  )
}
