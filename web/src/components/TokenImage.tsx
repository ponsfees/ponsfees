import { useEffect, useRef, useState } from 'react'
import { GATEWAY_COUNT, resolveImage } from '../lib/logo.ts'
import { Mark } from './Mark.tsx'

/**
 * A token's image, or a clean stand-in.
 *
 * ⛔⛔ A token's logo is a URI its creator typed. It can be missing, dead, slow, a gateway that is
 * down, or not an image at all. Every one of those has to end in something that looks deliberate,
 * because a broken image icon in a list of charities reads as a broken site.
 *
 * ⭐ An `ipfs://` URI is retried on a second gateway before giving up. One gateway being unreachable
 * is the single most common reason an IPFS image fails, and it says nothing about the token.
 */
export function TokenImage({ uri, symbol, className }: { uri?: string; symbol?: string; className?: string }) {
  const [gateway, setGateway] = useState(0)
  const [failed, setFailed] = useState(false)

  // ⚠ Reset when the token changes, or a row that failed keeps its failure after the list re-sorts.
  useEffect(() => { setGateway(0); setFailed(false) }, [uri])

  const src = failed ? null : resolveImage(uri, gateway)
  const isIpfs = (uri ?? '').trim().startsWith('ipfs://')
  const loaded = useRef(false)
  const next = () => {
    if (isIpfs && gateway + 1 < GATEWAY_COUNT) setGateway(gateway + 1)
    else setFailed(true)
  }

  /* ⛔ A hung IPFS gateway neither loads nor errors, so `onError` alone waits for ever on a blank
     square. An ipfs:// image gets 6s per gateway, then the next is tried. https images are left
     alone: our own host answers fast or 404s. ⚠ Hooks stay above the early return below. */
  useEffect(() => {
    loaded.current = false
    if (!src || !isIpfs) return
    const t = window.setTimeout(() => { if (!loaded.current) next() }, 6000)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src])

  if (!src) {
    /* ⭐ The mark, not a grey box. Every token here shares one thing, which is what the mark stands
       for, so an image-less token still looks like it belongs. */
    return (
      <span className={`timg timg--fallback ${className ?? ''}`} aria-hidden="true">
        <Mark />
      </span>
    )
  }

  return (
    <img
      className={`timg ${className ?? ''}`}
      src={src}
      alt={symbol ? `${symbol} logo` : ''}
      /*
        🔴🔴 NOT `loading="lazy"`. On the card grid Chrome evaluated laziness while the grid still
        had no layout, decided the images were not near the viewport, and NEVER RECONSIDERED: twelve
        of thirteen cards sat with `currentSrc` empty, having never issued a request, through
        scrolling in both directions and twenty seconds of waiting. Forcing `eager` on one loaded it
        instantly, and the server was answering all twelve in parallel in two seconds the whole time.
        ⚠ A token's art is the point of a card, and there are at most a couple of dozen on a page.
        There is nothing here worth deferring, and deferring it cost every card its image.
      */
      loading="eager"
      decoding="async"
      onLoad={() => { loaded.current = true }}
      onError={next}
    />
  )
}
