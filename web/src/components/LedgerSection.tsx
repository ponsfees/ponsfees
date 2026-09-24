import { useMemo } from 'react'
import { type Launch } from '../lib/launchpad.ts'
import { TokenCard } from './TokenCard.tsx'

export type Sort = 'newest' | 'raised'
export const SORTS: { id: Sort; label: string }[] = [
  { id: 'newest', label: 'Newest' },
  { id: 'raised', label: 'Highest' },
]

/**
 * ⭐ "Highest" = by USD market cap, so launches priced in different assets compare honestly.
 * ⚠ A launch with no price right now (graduating, or an unpriceable pair) sorts last rather than as
 * zero dollars, and is never shown a figure it does not have. Ties fall back to newest.
 */
export function applySort(rows: Launch[], sort: Sort): Launch[] {
  const c = [...rows]
  if (sort === 'raised') {
    const v = (l: Launch) => l.marketCapUsd ?? -1n
    return c.sort((a, b) => (v(b) > v(a) ? 1 : v(b) < v(a) ? -1 : Number(b.launchedAt) - Number(a.launchedAt)))
  }
  return c
}

/**
 * A grid of launch cards.
 *
 * ⚠⚠ THIS WAS A RULED TABLE, AND THE TABLE WAS THE WRONG OBJECT. Seven columns of #, token, market
 * cap, charity, split, paid and age is a ledger: it is for reading down a column and comparing, and
 * it gives the token's own art a 34px square. A launchpad is browsed, not audited, and what somebody
 * is doing on this page is choosing which token to look at, which the art does most of the work for.
 *
 * ⭐ So it is cards, the same shape Pons's own launchpad uses. Every figure the table carried is
 * still here; the ones that decide a click are just larger than the ones that do not.
 */
export function Ledger({ rows, loading, empty }: { rows: Launch[]; loading: boolean; empty: string }) {
  if (loading) return <div className="empty">Reading the chain</div>
  if (rows.length === 0) return <div className="empty">{empty}</div>
  return (
    <div className="tgrid">
      {rows.map((l) => <TokenCard key={l.token} l={l} />)}
    </div>
  )
}

/** A titled register with its own sort control and count. */
export function LedgerSection({
  title, blurb, rows, loading, empty, sort, onSort,
}: {
  title: string; blurb: string; rows: Launch[]; loading: boolean; empty: string
  sort: Sort; onSort: (s: Sort) => void
}) {
  const shown = useMemo(() => applySort(rows, sort), [rows, sort])

  return (
    <div className="sect">
      <div className="sect__head">
        <div>
          <h3 className="sect__title">
            {title}
            {!loading && <span className="sect__count">{rows.length}</span>}
          </h3>
          <p className="sect__blurb">{blurb}</p>
        </div>
        <div className="chips">
          {SORTS.map((s) => (
            <button key={s.id} className="chip" aria-pressed={sort === s.id} onClick={() => onSort(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
      </div>


      <Ledger rows={shown} loading={loading} empty={empty} />
    </div>
  )
}
