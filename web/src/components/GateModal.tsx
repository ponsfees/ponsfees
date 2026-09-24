import { useEffect } from 'react'
import { createPortal } from 'react-dom'

/**
 * "Launching is currently disabled", shown when the launch button is pressed while the gate is shut.
 * ⚠ Portalled to <body>: a `backdrop-filter` ancestor would otherwise become the containing block for
 * the fixed overlay and clip it (hit on Pons Charity's wallet dialog).
 */
export function GateModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev }
  }, [onClose])

  return createPortal(
    <div className="overlay" onMouseDown={onClose} role="presentation">
      <div className="modal gate" role="dialog" aria-modal="true" aria-labelledby="gate-title" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h3 id="gate-title">Launching is currently disabled</h3>
          <button className="modal__x" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
            </svg>
          </button>
        </div>
        <button className="btn btn--ink gate__close" onClick={onClose} autoFocus>Close</button>
      </div>
    </div>,
    document.body,
  )
}
