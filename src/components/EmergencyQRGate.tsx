import { type ReactNode, useState, useEffect, useRef, useCallback } from 'react'
import { useAuth } from '../hooks/useAuth'
import EmergencyID from './EmergencyID'
import { AlertTriangle } from 'lucide-react'
import { animate as anime } from 'animejs'
import { Skeleton } from './ui/primitives'
import { cloudToEmergencyForm, isEmergencyFormComplete, migrateEmergencyForm } from '../lib/emergencyProfile'


function checkLocalStorage(userId?: string): boolean {
  if (!userId) return false
  try {
    const raw = localStorage.getItem(`kalasag_emergency_profile_${userId}`)
    if (!raw) return false
    return isEmergencyFormComplete(migrateEmergencyForm(JSON.parse(raw)))
  } catch {
    return false
  }
}

/**
 * Forces the user to complete their Emergency QR profile before
 * accessing the rest of the app. Checks both the cloud profile
 * AND localStorage so the user isn't stuck if Supabase is slow.
 */
export default function EmergencyQRGate({ children }: { children: ReactNode }) {
  const { profile, user, loading, refreshProfile } = useAuth()
  const [checking, setChecking] = useState(true)
  const [savedLocally, setSavedLocally] = useState(false)
  const [forceShowGate, setForceShowGate] = useState(false)
  const formRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (user) {
      setSavedLocally(checkLocalStorage(user.id))
    } else {
      setSavedLocally(false)
    }
  }, [user])

  const isProfileComplete = (profile ? isEmergencyFormComplete(cloudToEmergencyForm(profile)) : false) || savedLocally

  useEffect(() => {
    // If it's done loading and the profile isn't complete yet, lock the gate open
    if (!loading && !checking && !isProfileComplete && !savedLocally) {
      setForceShowGate(true)
    }
  }, [loading, checking, isProfileComplete, savedLocally])

  // Called by EmergencyID after a successful save
  const handleProfileSaved = useCallback(() => {
    setSavedLocally(true)
    setForceShowGate(false)
    refreshProfile()
  }, [refreshProfile])

  useEffect(() => {
    const t = window.setTimeout(() => setChecking(false), 100)
    return () => clearTimeout(t)
  }, [])

  // Re-check when profile changes
  useEffect(() => {
    refreshProfile()
  }, [refreshProfile])


  // Entrance animation for the form container
  useEffect(() => {
    if (!checking && !loading && !isProfileComplete && formRef.current) {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        formRef.current.style.opacity = '1'
        formRef.current.style.transform = 'none'
        return
      }
      anime(formRef.current, {
        translateY: [16, 0],
        opacity: [0, 1],
        duration: 320,
        easing: 'easeOutCubic',
      })
    }
  }, [checking, loading, isProfileComplete])

  if (loading || checking) {
    return (
      <div role="status" aria-label="Loading emergency profile" className="grid h-full place-items-center bg-[var(--surface)] p-4">
        <div className="w-full max-w-xl space-y-4">
          <div className="flex items-center gap-3"><Skeleton variant="block" className="h-10 w-10" /><div className="flex-1 space-y-2"><Skeleton variant="line" className="w-44" /><Skeleton variant="line" className="h-2 w-64 max-w-full" /></div></div>
          <Skeleton variant="block" className="h-52 w-full" />
          <div className="grid gap-3 sm:grid-cols-2"><Skeleton variant="block" className="h-24" /><Skeleton variant="block" className="h-24" /></div>
        </div>
        <span className="sr-only">Loading emergency profile</span>
      </div>
    )
  }

  if (forceShowGate || !isProfileComplete) {
    return (
      <div className="h-full flex flex-col bg-[var(--surface)]">
        {/* Banner */}
        <div className="bg-[var(--warning-soft)] border-b border-[var(--warning-border)] px-4 py-3 shrink-0">
          <div className="max-w-xl mx-auto flex items-center gap-3">
            <AlertTriangle size={20} className="text-[var(--warning)] shrink-0" />
            <div>
              <p className="text-sm font-bold text-[var(--text)]">Complete your emergency profile</p>
              <p className="text-xs text-[var(--warning)] mt-0.5">
                Your Emergency QR ID must be filled in before you can access the dashboard.
              </p>
            </div>
          </div>
        </div>
        {/* The Emergency QR form — scrollable to fit any screen */ }
        <div ref={formRef} className="flex-1 min-h-0 overflow-y-auto">
          <EmergencyID onSaved={handleProfileSaved} />
        </div>
      </div>
    )
  }

  return <>{children}</>
}
