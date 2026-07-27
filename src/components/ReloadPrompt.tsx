import { Capacitor } from '@capacitor/core'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { Button } from './ui/primitives'

export function ReloadPrompt() {
  // Capacitor ships versioned local assets with the APK. Registering the web
  // PWA service worker in that environment can retain a stale website shell
  // across native updates, so native builds deliberately skip it.
  if (Capacitor.isNativePlatform()) return null

  return <WebReloadPrompt />
}

function WebReloadPrompt() {
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegistered(r: ServiceWorkerRegistration | undefined) {
      console.log('SW Registered: ' + r)
    },
    onRegisterError(error: unknown) {
      console.log('SW registration error', error)
    },
  })

  const close = () => {
    setOfflineReady(false)
    setNeedRefresh(false)
  }

  if (!offlineReady && !needRefresh) return null

  return (
    <div role="status" className="fixed bottom-20 left-3 right-3 z-[9999] max-w-sm rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--panel)] p-4 shadow-[var(--shadow-lg)] animate-slide-up sm:left-auto sm:right-4 lg:bottom-4">
      <div className="mb-3 text-sm leading-6 text-[var(--text)]">
        {offlineReady
          ? <span>KALASAG is now ready to work offline. Emergency features will remain accessible without internet.</span>
          : <span>A new update is available. Reload to apply critical changes.</span>}
      </div>
      <div className="flex gap-2">
        {needRefresh && (
          <Button
            variant="primary"
            className="flex-1 text-xs"
            onClick={() => updateServiceWorker(true)}
          >
            Reload app
          </Button>
        )}
        <Button
          variant="secondary"
          className="flex-1 text-xs"
          onClick={() => close()}
        >
          Close
        </Button>
      </div>
    </div>
  )
}
