/**
 * The FEES mark: a chrome F, the operator's own artwork (`web/brand/F-source.png`).
 *
 * ⭐ The page's ONE shiny object, the same rule Pons Charity keeps for its chrome heart: buttons,
 * cards and panels stay flat so the metal has something to be metal against.
 * ⚠ `mark.png` is the source trimmed and centred on a transparent 512 square, so it sits the same in
 * a 26px header tile and a 200px hero without per-size nudging.
 */
export function Mark({ size, className }: { size?: number; className?: string }) {
  return (
    <img className={`fmark${className ? ` ${className}` : ''}`} src="/mark.png" alt=""
      width={size} height={size} draggable={false} />
  )
}
