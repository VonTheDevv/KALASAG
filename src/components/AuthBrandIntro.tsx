import { useEffect, useRef, useState } from 'react'

export default function AuthBrandIntro() {
  const logoRef = useRef<HTMLImageElement>(null)
  const [isReady, setIsReady] = useState(false)

  useEffect(() => {
    if (logoRef.current?.complete) setIsReady(true)
  }, [])

  return (
    <div className={`auth-brand-intro ${isReady ? 'auth-brand-intro--ready' : ''}`}>
      <span className="sr-only">KALASAG</span>
      <div className="auth-brand-intro__stage" aria-hidden="true">
        <div className="auth-brand-intro__lockup">
          <img
            ref={logoRef}
            className="auth-brand-intro__logo"
            src="/kalasag-logo.png"
            alt=""
            loading="eager"
            fetchPriority="high"
            onLoad={() => setIsReady(true)}
            onError={() => setIsReady(true)}
          />
          <span className="auth-brand-intro__word-window">
            <span className="auth-brand-intro__word">ALASAG</span>
          </span>
        </div>
      </div>
    </div>
  )
}
