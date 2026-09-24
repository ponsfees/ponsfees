import type { Launch } from './launchpad.ts'

/**
 * The launch gate, and the platform's own token.
 *
 * ⭐⭐ THE GATE OPENS ITSELF. Until the founder's wallet has launched $FEES through our launchpad,
 * only that wallet may launch from this site. The moment that launch is in the on-chain registry,
 * the gate is open for everyone and the homepage CA is that token. No redeploy, no flag to flip.
 *
 * ⛔ Matched on the launch's CREATOR (msg.sender, recorded by the launchpad) AND the ticker, never
 * the ticker alone: anybody can launch a token called FEES, nobody else can launch it from this
 * wallet. The earliest match wins, so a second FEES from the same wallet cannot move the CA.
 *
 * ⛔ FAILS CLOSED. An unreadable registry is an empty list, so the gate stays shut rather than
 * opening because the RPC hiccuped.
 *
 * ⚠ A WEBSITE gate, not a contract one. FeesLaunchpad has no owner by design, so a direct contract
 * call is not stopped by this; such a launch is listed, but never becomes the platform token.
 */
export const FOUNDER = '0xc42c1009665D9A5E465F93977B87241dEe432A22'
export const PLATFORM_SYMBOL = 'FEES'

export const isFounder = (address: string | null | undefined) =>
  !!address && address.toLowerCase() === FOUNDER.toLowerCase()

export function platformToken(launches: Launch[]): Launch | null {
  /* ⭐ Launched elsewhere and set by the operator: the API validated it on chain (a Pons V2 launch
     paying the founder) before it could reach this list. */
  const external = launches.find((l) => l.external)
  if (external) return external
  const hits = launches
    .filter((l) => l.creator.toLowerCase() === FOUNDER.toLowerCase() && l.symbol.toUpperCase() === PLATFORM_SYMBOL)
    .sort((a, b) => Number(a.launchedAt) - Number(b.launchedAt))
  return hits[0] ?? null
}

export const launchesOpen = (launches: Launch[]) => platformToken(launches) !== null

/** May this wallet launch from the site right now? */
export const mayLaunch = (launches: Launch[], address: string | null | undefined) =>
  launchesOpen(launches) || isFounder(address)
