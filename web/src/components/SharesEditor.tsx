import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { useSession } from '../lib/session.tsx'
import { resolveHandle, type Provider } from '../lib/identityApi.ts'
import { ProviderIcon, providerLabel } from './ConnectAccount.tsx'
import {
  KIND_LABEL, MAX_RECIPIENTS, PLACEHOLDER, blankRecipient, maxSharePct, normaliseHandle, rebalance, withShare,
  type Recipient, type RecipientKind,
} from '../lib/shares.ts'

/**
 * Who this launch's fees go to: any mix of X, Twitch and GitHub accounts and wallets, adding to 100%.
 *
 * ⛔ Only providers the server can actually resolve are offered. A kind whose lookup is not
 * configured produces a row that can never be completed.
 */
export function SharesEditor({ value, onChange }: { value: Recipient[]; onChange: Dispatch<SetStateAction<Recipient[]>> }) {
  const session = useSession()
  const accountKinds = session.providers.map((p) => p.name) as RecipientKind[]
  const kinds: RecipientKind[] = [...accountKinds, 'wallet']

  /* ⛔⛔ FUNCTIONAL UPDATES, ALWAYS. A lookup resolves 500ms+ after it was typed; patching from the
     `value` it closed over would overwrite a row added or re-split in the meantime. Seen in the
     browser: add a recipient while a lookup is in flight and the new row vanished. */
  const patch = (id: string, p: Partial<Recipient>) => onChange((rs) => rs.map((x) => (x.id === id ? { ...x, ...p } : x)))
  const add = () => onChange((rs) => rebalance([...rs, blankRecipient(kinds[0] ?? 'wallet', 0)]))
  const remove = (id: string) => onChange((rs) => rebalance(rs.filter((x) => x.id !== id)))
  const maxPct = maxSharePct(value)

  return (
    <div className="field">
      <label className="field__l">Who gets the fees</label>
      {session.up === false && (
        <p className="field__h">Account lookups are unavailable right now, so only wallets can be added.</p>
      )}
      <div className="recips">
        {value.map((x) => (
          <RecipientRow
            key={x.id}
            r={x}
            kinds={session.up === false ? ['wallet'] : kinds}
            showShare={value.length > 1}
            maxPct={maxPct}
            canRemove={value.length > 1}
            onPatch={(p) => patch(x.id, p)}
            onShare={(pct) => onChange((rs) => withShare(rs, x.id, pct))}
            onRemove={() => remove(x.id)}
          />
        ))}
      </div>
      <div className="recips__foot">
        <button type="button" className="btn btn--sm" onClick={add} disabled={value.length >= MAX_RECIPIENTS}>
          Add a recipient
        </button>
      </div>
    </div>
  )
}

function RecipientRow({
  r, kinds, showShare, maxPct, canRemove, onPatch, onShare, onRemove,
}: {
  r: Recipient
  kinds: RecipientKind[]
  showShare: boolean
  maxPct: number
  canRemove: boolean
  onPatch: (p: Partial<Recipient>) => void
  onShare: (pct: number) => void
  onRemove: () => void
}) {
  const [looking, setLooking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<number | null>(null)

  /* ⚠ Debounced, and skipped when the typed handle already matches what was resolved. Every X
     lookup is prepaid from the operator's balance. */
  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current)
    if (r.kind === 'wallet') { setError(null); setLooking(false); return }
    const typed = normaliseHandle(r.value)
    if (!typed) { setError(null); setLooking(false); return }
    if (r.resolved && r.resolved.handle.toLowerCase() === typed.toLowerCase() && r.resolved.provider === r.kind) return
    setLooking(true)
    setError(null)
    timer.current = window.setTimeout(async () => {
      const found = await resolveHandle(r.kind as Provider, typed)
      setLooking(false)
      if (!found.ok) { setError(found.error); return }
      if (!found.user) { setError('No such account'); return }
      onPatch({ resolved: found.user })
    }, 500)
    return () => { if (timer.current) window.clearTimeout(timer.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.value, r.kind])

  return (
    <div className="recip">
      <div className="recip__row">
        <span className="recip__kind">
          {r.kind !== 'wallet' && <ProviderIcon provider={r.kind} />}
          {/* ⛔⛔ Changing the kind clears the value AND the resolved account: an address is not a
              handle, and an X identity must not stay attached to a row that now says Twitch. */}
          <select className="recip__sel" value={r.kind} aria-label="Recipient type"
            onChange={(e) => onPatch({ kind: e.target.value as RecipientKind, value: '', resolved: null })}>
            {kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
        </span>
        <input
          className={`input recip__val${r.kind === 'wallet' ? ' mono' : ''}`}
          placeholder={PLACEHOLDER[r.kind]}
          value={r.value}
          onChange={(e) => onPatch({ value: e.target.value, resolved: null })}
          aria-label="Recipient"
        />
        {showShare && (
          <span className="pctbox">
            <input className="pctbox__in" type="number" min={1} max={maxPct} step={1}
              value={Math.round(r.bps / 100)} onChange={(e) => onShare(Number(e.target.value))} aria-label="Share" />
            <span className="pctbox__u">%</span>
          </span>
        )}
        <button type="button" className="recip__x" onClick={onRemove} disabled={!canRemove}
          aria-label="Remove this recipient" title={canRemove ? 'Remove' : 'At least one recipient is required'}>
          ×
        </button>
      </div>
      {/* ⭐ The resolved line is the one place what was typed and what the chain records differ,
          so both are on screen. */}
      {(looking || error || r.resolved) && (
        <p className="recip__hint">
          {looking && 'Looking that up…'}
          {!looking && error && <span className="recip__err">{error}</span>}
          {!looking && !error && r.resolved && (
            <>
              <strong>{r.resolved.name}</strong> · @{r.resolved.handle} · {providerLabel(r.resolved.provider)} id {r.resolved.id}
            </>
          )}
        </p>
      )}
    </div>
  )
}
