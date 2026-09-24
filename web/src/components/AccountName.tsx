import { useEffect, useState } from 'react'
import { accountById, profileUrl, type Identity, type Provider } from '../lib/identityApi.ts'
import { ProviderIcon, providerLabel } from './ConnectAccount.tsx'

const cache = new Map<string, Promise<Identity | null>>()

/**
 * An account share, named by whoever holds its id NOW.
 *
 * ⭐⭐ A launch records the permanent numeric id, never the handle: every one of these services lets
 * a name be released and taken by somebody else. So the name is looked up fresh, and when it cannot
 * be the row still says which kind of account is paid rather than hiding the share.
 * ⚠ One request per account per page load, shared across every row that names it.
 */
export function AccountName({ provider, id }: { provider: Provider; id: string }) {
  const [who, setWho] = useState<Identity | null>(null)
  useEffect(() => {
    const k = `${provider}:${id}`
    if (!cache.has(k)) cache.set(k, accountById(provider, id))
    let live = true
    void cache.get(k)!.then((u) => { if (live) setWho(u) })
    return () => { live = false }
  }, [provider, id])
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <ProviderIcon provider={provider} />
      {who
        ? <a href={profileUrl(who)} target="_blank" rel="noreferrer">@{who.handle}</a>
        : <span>{provider === 'x' ? 'An' : 'A'} {providerLabel(provider)} account <span className="mono" style={{ color: 'var(--text-faint)' }}>#{id}</span></span>}
    </span>
  )
}
