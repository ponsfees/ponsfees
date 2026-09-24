export const X_URL = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_X_URL || 'https://x.com/usefeesapp'
export const SITE_URL = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_SITE_URL || 'https://ponsfees.family'
export const SITE_NAME = 'Fees'
export const GITHUB_URL = 'https://github.com/ponsfees/ponsfees'

/**
 * The `website` a launch is given when the launcher typed none.
 *
 * ⛔⛔ IT CANNOT BE THE TOKEN'S OWN PAGE. Pons's factory hashes the WHOLE `LaunchParams` into the
 * CREATE2 salt, `socials.website` included, so writing the token's address into this field changes
 * the address that gets deployed. Proven on Pons Charity. And a launched token's socials are getters
 * only, so it cannot be fixed afterwards either. The site root is true for every launch.
 */
export const defaultWebsite = (typed: string): string => typed.trim() || SITE_URL

/**
 * This site's own token, shown as a copyable strip under the hero. `CA: TBA` until it exists, and
 * never a sentence about the build. Set `VITE_TOKEN_CA` in `web/.env.production` to fill it in.
 */
export const TOKEN_CA = (
  (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_TOKEN_CA ?? ''
).trim()

export const hasTokenCa = () => /^0x[0-9a-fA-F]{40}$/.test(TOKEN_CA)
