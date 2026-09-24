/**
 * The home page summary. The full explanation is `/how-it-works`, and this defers to it.
 *
 * ⚠⚠ Every sentence here is a claim about what the contracts do. Custody copy that reads better
 * than the code behaves is worse than none: it is the first thing a sceptical reader checks.
 */
export function HowItWorks() {
  return (
    <section id="how" className="section--alt">
      <div className="wrap">
        <div className="head head--center">
          <p className="eyebrow">How it works</p>
          <h2>Fee Sharing on Pons</h2>
        </div>

        <div className="steps">
          <div className="step">
            <div className="step__n">01</div>
            <h3>You launch</h3>
            <p>
              Name the X, Twitch or GitHub accounts and wallets that should be paid, and their shares.
              One transaction deploys a fee splitter with those shares written in and launches your
              token on Pons with the splitter as its fee recipient. Nobody can change them afterwards.
            </p>
          </div>

          <div className="step">
            <div className="step__n">02</div>
            <h3>Fees split automatically</h3>
            <p>
              Pons charges 1% on every buy and sell, and 0.70% goes to the creator side, plus any
              creator tax you set. Every 15 minutes the fees are collected and split: wallets are paid
              directly, and each account's share is held on chain for that account.
            </p>
          </div>

          <div className="step">
            <div className="step__n">03</div>
            <h3>Accounts claim</h3>
            <p>
              The account owner signs in with X, Twitch or GitHub on the claim page and sends their
              share to any wallet. Nothing has to be set up in advance, and shares keep adding up
              until they are claimed.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
