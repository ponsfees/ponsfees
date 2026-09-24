import { useEffect, useState } from 'react'
import { formatUnits, type Address } from 'viem'
import { addrUrl, short, tokenUrl } from '../lib/chain.ts'
import { readToken, type TokenView } from '../lib/token.ts'
import { formatUsd } from '../lib/marketCap.ts'
import { PROVIDER_NAME, phaseLabel } from '../lib/launchpad.ts'
import { CLAIM, EXPLORE } from '../lib/router.ts'
import { AccountName } from './AccountName.tsx'
import { TokenImage } from './TokenImage.tsx'
import { Link } from './Link.tsx'

const fmt = (v: bigint, d: number, max = 4) => {
  const n = Number(formatUnits(v, d))
  if (n === 0) return '0'
  if (n < 0.0001) return '<0.0001'
  return n.toLocaleString('en-US', { maximumFractionDigits: max })
}

export function TokenPage({ address }: { address: Address }) {
  const [t, setT] = useState<TokenView | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading')

  useEffect(() => {
    let live = true
    setState('loading')
    void (async () => {
      const v = await readToken(address).catch(() => null)
      if (!live) return
      setT(v)
      setState(v ? 'ready' : 'missing')
    })()
    return () => { live = false }
  }, [address])

  if (state === 'loading') {
    return <section><div className="wrap"><div className="empty">Reading the chain</div></div></section>
  }

  /* ⛔ Only tokens launched here have a splitter and shares on chain. Rendering zeroes for any other
     token would present "pays nobody" as a fact about somebody else's launch. */
  if (state === 'missing' || !t) {
    return (
      <section>
        <div className="wrap">
          <div className="head head--center">
            <p className="eyebrow">Not found</p>
            <h2>No launch at this address</h2>
            <p>This page shows tokens launched through Fees, because only those have their recipients recorded on chain.</p>
          </div>
          <div style={{ textAlign: 'center' }}><Link className="btn" to={EXPLORE}>Back to explore</Link></div>
        </div>
      </section>
    )
  }

  const accounts = t.shares.filter((s) => s.provider !== 0).length
  const pct = (bps: number) => { const n = bps / 100; return n % 1 === 0 ? n : Number(n.toFixed(2)) }

  return (
    <>
      <section className="tok">
        <div className="wrap">
          <Link className="tok__back" to={EXPLORE}>Back to explore</Link>
          <div className="tok__head">
            <TokenImage uri={t.logo} symbol={t.symbol} className="tok__art" />
            <div style={{ minWidth: 0 }}>
              <div className="tok__sym mono">${t.symbol}</div>
              <h1 className="tok__name">{t.name}</h1>
            </div>
            <div className="tok__badges">
              <span className="tag tag--live">
                {accounts === 0 ? 'Pays wallets' : `Pays ${accounts} account${accounts === 1 ? '' : 's'}`}
              </span>
              <span className="tag">{phaseLabel(t.phase)}</span>
              <span className="tag">Priced in {t.pairSymbol}</span>
            </div>
          </div>

          {t.description && <p className="tok__desc">{t.description}</p>}

          <div className="figs figs--2">
            <div className="fig">
              <div className="fig__k">Market cap</div>
              <div className="fig__v">{formatUsd(t.marketCapUsd) ?? '—'}</div>
              {/* ⛔ Phase 1 has no price anywhere: the curve is drained and the pool not seeded.
                  Said plainly, because a bare dash on a graduating token reads as broken. */}
              {t.phase === 1 && <div className="fig__note">Moving to its pool</div>}
            </div>
            <div className="fig">
              <div className="fig__k">Fees paid out</div>
              <div className="fig__v">{t.external ? '—' : <>{fmt(t.paid, t.pairDecimals, 4)} <small>{t.pairSymbol}</small></>}</div>
              {/* ⭐ After graduation the pool's fees are swept by Pons itself before they reach the
                  splitter, so this lags trading by up to about an hour. Said, so a quiet figure on a
                  busy token does not read as money going missing. */}
              {t.phase === 2 && !t.external && <div className="fig__note">Pool fees arrive after Pons sweeps them, usually within the hour</div>}
            </div>
          </div>
        </div>
      </section>

      <section className="section--alt">
        <div className="wrap">
          <div className="tok__cols">
            <div>
              <p className="eyebrow" style={{ justifyContent: 'center' }}>Who gets the fees</p>
              <div className="ledger" style={{ borderTop: '1px solid var(--ink)' }}>
                {t.shares.map((s, i) => (
                  <Row key={i}
                    k={s.provider === 0
                      ? <a className="mono" href={addrUrl(s.wallet)} target="_blank" rel="noreferrer">{short(s.wallet, 6)}</a>
                      : <AccountName provider={PROVIDER_NAME[s.provider as 1 | 2 | 3]} id={s.accountId} />}
                    v={<>
                      {pct(s.bps)}%
                      {t.unclaimed[i] != null && t.unclaimed[i]! > 0n && (
                        <span className="trow__sub"> · {fmt(t.unclaimed[i]!, t.pairDecimals)} {t.pairSymbol} to claim</span>
                      )}
                    </>}
                  />
                ))}
                {/* ⛔ Not for a token launched elsewhere: Pons pays its recipient directly and nothing
                    on chain counts it, so a 0 here would be a false statement. */}
                {!t.external && <Row k="Paid to wallets" v={`${fmt(t.toWallets, t.pairDecimals)} ${t.pairSymbol}`} />}
                {!t.external && <Row k="Set aside for accounts" v={`${fmt(t.toAccounts, t.pairDecimals)} ${t.pairSymbol}`} />}
                <Row k="Trading fee" v={`${(1 + t.creatorTaxBps / 100).toFixed(2).replace(/\.00$/, '')}%`} />
              </div>
              {accounts > 0 && (
                <p className="field__h" style={{ textAlign: 'center', marginTop: 14 }}>
                  Named here? <Link to={CLAIM}>Sign in and claim your share</Link>.
                </p>
              )}
            </div>

            <div>
              <p className="eyebrow" style={{ justifyContent: 'center' }}>Token details</p>
              <div className="ledger" style={{ borderTop: '1px solid var(--ink)' }}>
                <Row k="Token" v={<a className="mono" href={tokenUrl(t.token)} target="_blank" rel="noreferrer">{short(t.token, 6)}</a>} />
                {/* ⛔ A token launched elsewhere has no splitter; its real fee recipient is shown, never a zero address. */}
                {t.external
                  ? <Row k="Fee recipient" v={<a className="mono" href={addrUrl(t.shares[0]!.wallet)} target="_blank" rel="noreferrer">{short(t.shares[0]!.wallet, 6)}</a>} />
                  : <Row k="Fee splitter" v={<a className="mono" href={addrUrl(t.splitter)} target="_blank" rel="noreferrer">{short(t.splitter, 6)}</a>} />}
                <Row k="Curve" v={<a className="mono" href={addrUrl(t.curve)} target="_blank" rel="noreferrer">{short(t.curve, 6)}</a>} />
                <Row k="Launched by" v={<a className="mono" href={addrUrl(t.creator)} target="_blank" rel="noreferrer">{short(t.creator, 6)}</a>} />
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  )
}

function Row({ k, v }: { k: React.ReactNode; v: React.ReactNode }) {
  return (
    <div className="trow">
      <span className="trow__k">{k}</span>
      <span className="trow__v">{v}</span>
    </div>
  )
}
