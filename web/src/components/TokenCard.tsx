import { type Launch, PROVIDER_NAME } from '../lib/launchpad.ts'
import { formatUsd } from '../lib/marketCap.ts'
import { tokenHref } from '../lib/router.ts'
import { Link } from './Link.tsx'
import { TokenImage } from './TokenImage.tsx'
import { ProviderIcon } from './ConnectAccount.tsx'

/** Which kinds of recipient a launch pays, as icons. The token page names them. */
function Pays({ l }: { l: Launch }) {
  const providers = [...new Set(l.shares.filter((s) => s.provider !== 0).map((s) => PROVIDER_NAME[s.provider as 1 | 2 | 3]))]
  const wallets = l.shares.filter((s) => s.provider === 0).length
  const accounts = l.shares.length - wallets
  return (
    <span className="tcard__paysv" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {providers.map((p) => <ProviderIcon key={p} provider={p} />)}
      {accounts > 0 ? `${accounts} account${accounts === 1 ? '' : 's'}` : ''}
      {accounts > 0 && wallets > 0 ? ' + ' : ''}
      {wallets > 0 ? `${wallets} wallet${wallets === 1 ? '' : 's'}` : ''}
    </span>
  )
}

export function TokenCard({ l }: { l: Launch }) {
  return (
    <Link className="tcard" to={tokenHref(l.token)}>
      <div className="tcard__art">
        <TokenImage uri={l.logo} symbol={l.symbol} className="tcard__img" />
        {l.phase === 1 && <span className="tcard__badge">Graduating</span>}
        {l.phase === 2 && <span className="tcard__badge">Graduated</span>}
      </div>
      <div className="tcard__body">
        <div className="tcard__sym mono">${l.symbol}</div>
        <div className="tcard__name">{l.name}</div>
        <div className="tcard__cap">
          {formatUsd(l.marketCapUsd) ?? <span className="tcard__dash">&mdash;</span>}
          <span className="tcard__capk">Market cap</span>
        </div>
        {/* ⭐ Not on the platform's own token: it is the site's token, not a fee-sharing launch. */}
        {!l.platform && (
          <div className="tcard__pays">
            <span className="tcard__paysk">Fees to</span>
            <Pays l={l} />
          </div>
        )}
      </div>
    </Link>
  )
}
