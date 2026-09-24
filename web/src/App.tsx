import { useCallback, useEffect, useState } from 'react'
import { WalletProvider } from './lib/wallet.tsx'
import { SessionProvider } from './lib/session.tsx'
import { readLaunches, type Launch } from './lib/launchpad.ts'
import { useRoute } from './lib/router.ts'
import { Header } from './components/Header.tsx'
import { Hero } from './components/Hero.tsx'
import { HowItWorks } from './components/HowItWorks.tsx'
import { HowItWorksPage } from './components/HowItWorksPage.tsx'
import { LaunchForm } from './components/LaunchForm.tsx'
import { Launches } from './components/Launches.tsx'
import { Explore } from './components/Explore.tsx'
import { MyTokens } from './components/MyTokens.tsx'
import { AccountClaim } from './components/AccountClaim.tsx'
import { TokenPage } from './components/TokenPage.tsx'
import { Footer } from './components/Footer.tsx'

function Site() {
  const route = useRoute()
  const [launches, setLaunches] = useState<Launch[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(() => {
    /* ⚠ Block-bodied: a concise arrow hands React the promise as a cleanup function, and React 19
       renders a blank page with no error. */
    void (async () => {
      try {
        setLaunches(await readLaunches())
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  useEffect(() => { refresh() }, [refresh])

  return (
    <>
      <Header route={route} />
      <main>
        {route.name === 'token' ? (
          <TokenPage address={route.address} />
        ) : route.name === 'mine' ? (
          <MyTokens launches={launches} loading={loading} />
        ) : route.name === 'claim' ? (
          <section className="page">
            <div className="wrap">
              <div className="chead">
                <p className="eyebrow" style={{ justifyContent: 'center' }}>Claim</p>
                <h1 className="chead__h">Claim your fees</h1>
                <p className="chead__sub">Sign in with your account to claim its share of the fees.</p>
              </div>
              <div className="claimwrap"><AccountClaim launches={launches} /></div>
            </div>
          </section>
        ) : route.name === 'how' ? (
          <HowItWorksPage />
        ) : route.name === 'explore' ? (
          <Explore launches={launches} loading={loading} />
        ) : route.name === 'launch' ? (
          <LaunchForm onLaunched={refresh} launches={launches} loading={loading} />
        ) : (
          <>
            <Hero launches={launches} loading={loading} />
            <HowItWorks />
            <Launches launches={launches} loading={loading} />
          </>
        )}
      </main>
      <Footer />
    </>
  )
}

export default function App() {
  return (
    <WalletProvider>
      {/* ⚠ Inside the wallet provider: the claim page needs both at once, an ACCOUNT proves the
          share is yours and a WALLET is where it gets paid. */}
      <SessionProvider>
        <Site />
      </SessionProvider>
    </WalletProvider>
  )
}
