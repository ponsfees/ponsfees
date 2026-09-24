import { useMemo, useState } from 'react'
import { type Launch } from '../lib/launchpad.ts'
import { formatUsd } from '../lib/marketCap.ts'
import { HOW, LAUNCH } from '../lib/router.ts'
import { TOKEN_CA, hasTokenCa } from '../lib/brand.ts'
import { Link } from './Link.tsx'
import { Mark } from './Mark.tsx'
import { platformToken } from '../lib/gate.ts'

/**
 * The site's own contract address, under the hero.
 *
 * ⚠⚠ A BUTTON ONLY WHEN THERE IS SOMETHING TO COPY. Rendering the copy affordance around `TBA`
 * gives people a control that does nothing, and a control that does nothing is worse than none:
 * it gets pressed, and the silence reads as the page being broken rather than as the address not
 * existing yet. With no address it is plain text.
 *
 * ⚠ `navigator.clipboard` is undefined on an insecure origin and can be refused even on a secure
 * one, so the write is guarded. A refusal leaves the label alone rather than claiming a copy that
 * did not happen.
 */
function CaStrip({ ca: fromChain }: { ca: string | null }) {
  const [copied, setCopied] = useState(false)

  /* ⭐ The env pin wins if set; otherwise the platform's own $FEES straight off the registry, so the
     strip fills itself the moment the founder launches it. @see lib/gate.ts */
  const ca = hasTokenCa() ? TOKEN_CA : fromChain

  if (!ca) {
    return (
      <p className="ca ca--tba">
        <span className="ca__k">CA:</span>
        <span className="ca__v">TBA</span>
      </p>
    )
  }

  const copy = () => {
    void navigator.clipboard?.writeText(ca).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }

  return (
    /* ⭐ THE WHOLE STRIP IS THE BUTTON. A separate copy control beside a long address is a small
       target most people never aim at and some never notice; the address itself is the thing they
       are already looking at, so it is the thing that copies.
       ⚠ `aria-live` on the confirmation, because for a screen reader the only evidence a click did
       anything is a word that changed somewhere else on the line. */
    <button type="button" className={`ca ca--btn${copied ? ' is-copied' : ''}`} onClick={copy}
      title="Copy the contract address" aria-label={`Copy the contract address ${ca}`}>
      <span className="ca__k">CA:</span>
      <span className="ca__v mono">{ca}</span>
      <span className="ca__say" aria-live="polite">{copied ? 'Copied' : ''}</span>
    </button>
  )
}

export function Hero({ launches, loading }: { launches: Launch[]; loading: boolean }) {
  /*
    ⭐ Three facts a stranger can check on chain: how many launches, how many distinct accounts they
    pay, and what they have paid out. ⛔ The total is summed in USD only across launches whose asset
    could be priced; if any could not, it is a lower bound and shows a dash rather than a short sum.
  */
  const paidUsd = useMemo(() => {
    let sum = 0n
    for (const l of launches) {
      if (l.paid === 0n) continue
      if (l.paidUsd === null) return null
      sum += l.paidUsd
    }
    return sum
  }, [launches])

  return (
    <section className="hero" id="top">
      <div className="wrap">
        <div className="hero__in">
          <span className="hero__mark"><Mark /></span>
          {/* ⚠ Visually hidden, not removed (operator, 24 Sep): the F under it is the wordmark, but the
              page still needs one h1 for screen readers and search. */}
          <h1 className="sr-only">Fees</h1>
          <p className="hero__sub">Launch a token and share its fees with X, Twitch and GitHub accounts.</p>
          <div className="hero__cta">
            <Link className="btn btn--ink btn--lg" to={LAUNCH}>Launch a token</Link>
            <Link className="btn btn--lg" to={HOW}>How it works</Link>
          </div>
          <CaStrip ca={platformToken(launches)?.token ?? null} />
        </div>

        <div className="stats stats--2">
          <div className="stat">
            <div className="stat__k">Fees paid out</div>
            <div className="stat__v">{loading || paidUsd === null ? '—' : formatUsd(paidUsd) ?? '$0'}</div>
          </div>
          <div className="stat">
            <div className="stat__k">Launches</div>
            <div className="stat__v">{loading ? '0' : launches.length}</div>
          </div>
        </div>
      </div>
    </section>
  )
}
