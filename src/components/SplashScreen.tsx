import { useEffect, useState } from 'react'

interface SplashScreenProps {
  onFinished: () => void
}

export default function SplashScreen({ onFinished }: SplashScreenProps) {
  const [fadeOut, setFadeOut] = useState(false)

  useEffect(() => {
    const fadeTimer = window.setTimeout(() => setFadeOut(true), 680)
    const finishTimer = window.setTimeout(onFinished, 960)

    return () => {
      window.clearTimeout(fadeTimer)
      window.clearTimeout(finishTimer)
    }
  }, [onFinished])

  return (
    <div
      className={`fixed inset-0 z-[99999] grid place-items-center bg-[var(--surface)] ${fadeOut ? 'splash-fade-out' : ''}`}
      role="status"
      aria-label="Opening KALASAG"
    >
      <div className="flex flex-col items-center gap-5 animate-scale-in">
        <div className="grid h-20 w-20 place-items-center rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--panel)] shadow-[var(--shadow-md)]">
          <img src="/favicon.png" alt="" className="h-14 w-14 object-contain" />
        </div>
        <div className="text-center">
          <h1 className="text-2xl font-extrabold tracking-[0.08em] text-[var(--text)]">KALASAG</h1>
          <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--muted)]">Civic emergency operations</p>
        </div>
        <div className="h-1 w-28 overflow-hidden rounded-full bg-[var(--surface-alt)]">
          <span className="block h-full w-2/3 rounded-full bg-[var(--action)] animate-pulse" />
        </div>
      </div>
      <span className="sr-only">Opening KALASAG</span>
    </div>
  )
}
