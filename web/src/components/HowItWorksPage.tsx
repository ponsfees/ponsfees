import { addrUrl, short } from '../lib/chain.ts'
import { CLAIMS, LAUNCHPAD, PONS_FACTORY, isLive } from '../lib/launchpad.ts'

const RHC = (a: string) => ({ href: addrUrl(a), label: short(a, 6) })

function ContractRow({ name, chain, what, link }: {
  name: string; chain: string; what: string; link: { href: string; label: string }
}) {
  return (
    <div className="ctr">
      <div className="ctr__id">
        <span className="ctr__name">{name}</span>
        <span className="ctr__chain">{chain}</span>
      </div>
      <p className="ctr__what">{what}</p>
      <a className="ctr__addr mono" href={link.href} target="_blank" rel="noreferrer noopener">{link.label}</a>
    </div>
  )
}

/**
 * The full explanation. ⚠⚠ Every sentence is a claim about the contracts; keep it that way.
 */
export function HowItWorksPage() {
  return (
    <section className="page">
      <div className="wrap">
        <div className="chead">
          <p className="eyebrow" style={{ justifyContent: 'center' }}>How it works</p>
          <h1 className="chead__h">How fee sharing works</h1>
          <p className="chead__sub">
            Launch a Pons V2 token and route its trading fees to X, Twitch and GitHub accounts or a
            combination of them.
          </p>
        </div>

        <div className="hiw">
          <div className="steps">
            <div className="step">
              <div className="step__n">01</div>
              <h3>Launch a token</h3>
              <p>
                Choose your token, its paired asset and fee recipients.
                <br /><br />
                An account is looked up when you add it and recorded by its permanent numeric id, not
                its name, so a renamed account keeps its share and a new owner of an old name gets
                nothing. One transaction deploys the fee splitter and launches the token with the
                splitter as its fee recipient.
              </p>
            </div>

            <div className="step">
              <div className="step__n">02</div>
              <h3>Every trade generates fees</h3>
              <p>
                Pons charges 1% on every buy and sell, and 0.70% of the volume goes to the creator
                side. A creator tax, if you set one, is added on top and goes to the creator side in
                full.
                <br /><br />
                Fees are paid in the paired asset.
              </p>
            </div>

            <div className="step">
              <div className="step__n">03</div>
              <h3>Fee distribution</h3>
              <p>
                Every 15 minutes, accumulated fees are swept into the splitter and distributed according
                to the recipients set at launch. Fee recipients have their share credited to the claims
                contract.
              </p>
            </div>

            <div className="step">
              <div className="step__n">04</div>
              <h3>Claim</h3>
              <p>
                Fee recipients sign in with their X, GitHub or Twitch account and choose any wallet to
                receive their fees. An approval is created for exactly the amount that account has
                accumulated, and the recipient submits the transaction themselves. Unclaimed fees remain
                assigned to the account on chain until they are claimed.
              </p>
            </div>
          </div>

          <h2 className="hiw__h">Contracts</h2>
          <div className="ctrs">
            {isLive() && (
              <ContractRow
                name="Fees launchpad" chain="Robinhood Chain" link={RHC(LAUNCHPAD)}
                what="Deploys a fee splitter and launches the token in one transaction and keeps the register of every launch."
              />
            )}
            {/^0x[0-9a-fA-F]{40}$/.test(CLAIMS) && (
              <ContractRow
                name="Claims" chain="Robinhood Chain" link={RHC(CLAIMS)}
                what="Holds each account's share, separately per launch and per account."
              />
            )}
            <ContractRow
              name="Pons V2 factory" chain="Robinhood Chain" link={RHC(PONS_FACTORY)}
              what="Pons's own launch factory. It creates the token and the bonding curve, and holds the fee escrow."
            />
          </div>
        </div>
      </div>
    </section>
  )
}
