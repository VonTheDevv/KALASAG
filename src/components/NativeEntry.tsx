import { useEffect, useRef, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import AuthBrandIntro from './AuthBrandIntro'

const MINIMUM_SPLASH_TIME_MS = 1100
const SPLASH_EXIT_TIME_MS = 280
const NATIVE_SPLASH_SESSION_KEY = 'kalasag_native_startup_seen'

type EntryPhase = 'loading' | 'leaving' | 'welcome'

function hasSeenNativeStartup() {
  try {
    return window.sessionStorage.getItem(NATIVE_SPLASH_SESSION_KEY) === '1'
  } catch {
    return false
  }
}

export default function NativeEntry() {
  const { loading, user } = useAuth()
  const startedAt = useRef(performance.now())
  const [phase, setPhase] = useState<EntryPhase>(() => (hasSeenNativeStartup() ? 'welcome' : 'loading'))

  useEffect(() => {
    if (loading || phase !== 'loading') return

    const elapsed = performance.now() - startedAt.current
    const remaining = Math.max(0, MINIMUM_SPLASH_TIME_MS - elapsed)
    const timer = window.setTimeout(() => setPhase('leaving'), remaining)

    return () => window.clearTimeout(timer)
  }, [loading, phase])

  useEffect(() => {
    if (phase !== 'leaving') return

    const timer = window.setTimeout(() => {
      try {
        window.sessionStorage.setItem(NATIVE_SPLASH_SESSION_KEY, '1')
      } catch {
        // A hardened WebView can block storage; the entry remains functional.
      }
      setPhase('welcome')
    }, SPLASH_EXIT_TIME_MS)
    return () => window.clearTimeout(timer)
  }, [phase])

  // Never flash the logged-out welcome screen while a restored native session
  // is still being resolved, even when this WebView has already seen the
  // startup animation during the current process.
  if (phase !== 'welcome' || loading) {
    return <NativeStartupSplash leaving={phase === 'leaving'} />
  }

  if (user) {
    return <Navigate to="/app" replace />
  }

  return <NativeWelcome />
}

function NativeStartupSplash({ leaving }: { leaving: boolean }) {
  return (
    <main
      className={`native-startup ${leaving ? 'native-startup--leaving' : ''}`}
      role="status"
      aria-label="Opening KALASAG"
      aria-busy="true"
    >
      <div className="native-startup__mark" aria-hidden="true">
        <span className="native-startup__ring" />
        <img src="/kalasag-logo.png" alt="" className="native-startup__logo" />
      </div>
    </main>
  )
}

function NativeWelcome() {
  return (
    <main className="native-welcome">
      <div className="native-welcome__map" aria-hidden="true" />
      <div className="native-welcome__shade" aria-hidden="true" />

      <section className="native-welcome__content" aria-labelledby="native-welcome-title">
        <h1 id="native-welcome-title" className="sr-only">
          KALASAG
        </h1>
        <div className="native-welcome__brand">
          <AuthBrandIntro />
        </div>
        <p className="native-welcome__description">
          Real-time Philippine air, maritime, and road monitoring with authoritative disaster alerts and immediate
          access to emergency hotlines.
        </p>
      </section>

      <nav className="native-welcome__dock" aria-label="Account access">
        <Link className="native-welcome__action native-welcome__action--primary" to="/login">
          Login
        </Link>
        <Link className="native-welcome__action native-welcome__action--secondary" to="/signup">
          Sign up
        </Link>
      </nav>
    </main>
  )
}
