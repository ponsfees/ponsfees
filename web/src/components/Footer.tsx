import { addrUrl } from '../lib/chain.ts'
import { CLAIMS, LAUNCHPAD, PONS_FACTORY, isLive } from '../lib/launchpad.ts'
import { GITHUB_URL, X_URL } from '../lib/brand.ts'
import { GithubIcon, XIcon } from './Header.tsx'
import { Mark } from './Mark.tsx'

export function Footer() {
  return (
    <footer className="ftr">
      <div className="wrap">
        <div className="ftr__grid">
          <div>
            <div className="ftr__brand">
              <span className="hdr__tile"><Mark /></span>
              <span className="hdr__name">Fees</span>
            </div>
            <p style={{ fontSize: '0.9rem', maxWidth: '36ch', margin: 0 }}>
              Launch tokens on Pons V2 and share the fees with X, Twitch and GitHub accounts.
            </p>
          </div>

          <div>
            <h4>Site</h4>
            <div className="ftr__links">
              <a href="/launch">Launch</a>
              <a href="/explore">Explore</a>
              <a href="/claim">Claim</a>
              <a href="/how-it-works">How it works</a>
            </div>
          </div>

          <div>
            <h4>Contracts</h4>
            <div className="ftr__links">
              {isLive() && <a href={addrUrl(LAUNCHPAD)} target="_blank" rel="noreferrer">Launchpad</a>}
              {/^0x[0-9a-fA-F]{40}$/.test(CLAIMS) && <a href={addrUrl(CLAIMS)} target="_blank" rel="noreferrer">Claims</a>}
              <a href={addrUrl(PONS_FACTORY)} target="_blank" rel="noreferrer">Pons V2 factory</a>
              <a href="https://robinhoodchain.blockscout.com" target="_blank" rel="noreferrer">Explorer</a>
            </div>
          </div>

          <div>
            <h4>Elsewhere</h4>
            {/* ⭐ Icon + name, set exactly like the Site and Contracts columns beside it, so the
                footer reads as four lists of one kind. */}
            <div className="ftr__links">
              {X_URL && (
                <a className="soc" href={X_URL} target="_blank" rel="noreferrer noopener" aria-label="Fees on X">
                  <span className="soc__icon"><XIcon /></span>usefeesapp
                </a>
              )}
              <a className="soc" href={GITHUB_URL} target="_blank" rel="noreferrer noopener" aria-label="Fees on GitHub">
                <span className="soc__icon"><GithubIcon /></span>ponsfees
              </a>
            </div>
          </div>
        </div>
      </div>
    </footer>
  )
}
