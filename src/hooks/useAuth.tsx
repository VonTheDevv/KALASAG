import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from 'react'
import { supabase, type EmergencyProfile, fetchEmergencyProfile } from '../lib/supabase'
import type { Session, User, AuthError } from '@supabase/supabase-js'
import {
  confirmNativeDrivingStopped,
  getNativeDrivingStatus,
  stopNativeDriving,
} from '../lib/nativeDriving'
import { stopMyFamilyDrivingForSignOut } from '../lib/familySafety'
import {
  resumePendingPushPrivacyCleanup,
  unregisterFamilyPushForSignOut,
} from '../lib/pushNotifications'
import {
  CURRENT_PRIVACY_VERSION,
  CURRENT_TERMS_VERSION,
  type SignupConsent,
} from '../types/legalConsent'

interface AuthContextValue {
  session: Session | null
  user: User | null
  profile: EmergencyProfile | null
  loading: boolean
  signUp: (
    email: string,
    password: string,
    consent: SignupConsent,
  ) => Promise<AuthError | null>
  signIn: (email: string, password: string) => Promise<AuthError | null>
  signOut: () => Promise<void>
  refreshProfile: () => Promise<void>
}

/**
 * Extracts and normalizes error messages from Supabase/API error objects.
 * Safely parses stringified JSON structures, handles empty objects ({}), and provides fallback.
 */
function parseAuthErrorMessage(error: any): string {
  if (!error) return 'An unexpected error occurred. Please try again.'

  let message = ''
  if (typeof error === 'string') {
    message = error
  } else if (error && typeof error.message === 'string') {
    message = error.message
  } else if (error && typeof error.error_description === 'string') {
    message = error.error_description
  } else if (error && typeof error.error === 'string') {
    message = error.error
  } else if (error && typeof error.msg === 'string') {
    message = error.msg
  } else if (error && typeof error.toString === 'function') {
    message = error.toString()
  }

  message = message.trim()

  // Try to parse if it is a stringified JSON object (e.g. "{}" or '{"message": "..."}')
  if (message.startsWith('{') && message.endsWith('}')) {
    try {
      const parsed = JSON.parse(message)
      if (parsed) {
        const nestedMsg = parsed.message || parsed.msg || parsed.error || parsed.error_description
        if (typeof nestedMsg === 'string' && nestedMsg.trim().length > 0) {
          return nestedMsg.trim()
        }
      }
      return 'An unexpected error occurred. Please try again.'
    } catch {
      // Ignore parse failure and keep raw message
    }
  }

  if (message === '{}' || message === '[]' || message.length === 0 || message === '[object Object]') {
    return 'An unexpected error occurred. Please try again.'
  }

  return message
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<EmergencyProfile | null>(null)
  const [loading, setLoading] = useState(true)
  // Track whether we've done the initial session check
  const [initialized, setInitialized] = useState(false)

  const loadProfile = useCallback(async (userId: string) => {
    const p = await fetchEmergencyProfile(userId)
    setProfile(p)
  }, [])

  const refreshProfile = useCallback(async () => {
    if (user) await loadProfile(user.id)
  }, [user, loadProfile])

  // Initialize: get existing session ONCE
  useEffect(() => {
    let cancelled = false

    // A failed offline token rotation is a device-privacy cleanup and must
    // resume even on the logged-out/auth screens.
    void resumePendingPushPrivacyCleanup()

    void supabase.auth.getSession()
      .then(({ data: { session: s } }) => {
        if (cancelled) return
        setSession(s)
        setUser(s?.user ?? null)
        if (s?.user) {
          void loadProfile(s.user.id)
        }
        setInitialized(true)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        // A provider or storage failure must not trap the native entry screen
        // on its loading animation. Continue logged out and let the user retry
        // authentication from the welcome screen.
        setSession(null)
        setUser(null)
        setProfile(null)
        setInitialized(true)
        setLoading(false)
      })

    // Listen for auth state changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s)
      setUser(s?.user ?? null)
      if (s?.user) {
        loadProfile(s.user.id)
      } else {
        setProfile(null)
      }
    })

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [loadProfile])

  const signUp = useCallback(
    async (
      email: string,
      password: string,
      consent: SignupConsent,
    ): Promise<AuthError | null> => {
      try {
        // Keep this runtime check even though SignupConsent is intentionally
        // strict. JavaScript callers and stale/native bundles do not receive
        // TypeScript's compile-time protection.
        if (
          consent?.termsAccepted !== true
          || consent?.privacyAcknowledged !== true
          || consent?.termsVersion !== CURRENT_TERMS_VERSION
          || consent?.privacyVersion !== CURRENT_PRIVACY_VERSION
        ) {
          return {
            name: 'LegalConsentRequired',
            message:
              'Accept the current Terms of Service and Privacy Notice before creating an account.',
            status: 400,
          } as AuthError
        }

        const { data, error } = await supabase.auth.signUp({ 
          email, 
          password,
          options: {
            emailRedirectTo: new URL('/auth/confirm', window.location.origin).toString(),
            data: {
              terms_accepted: true,
              privacy_acknowledged: true,
              terms_version: consent.termsVersion,
              privacy_version: consent.privacyVersion,
            },
          }
        })

        if (error) {
          // User already exists — tell them to sign in instead
          if (
            error.message?.includes('already registered') ||
            error.message?.includes('already exists') ||
            error.message?.includes('already been registered') ||
            error.message?.includes('User already')
          ) {
            return {
              name: 'AlreadyRegistered',
              message:
                'An account with this email already exists. Please sign in instead.',
              status: 409,
            } as AuthError
          }
          // Normalize: ensure we always return a readable message string
          const errorMessage = parseAuthErrorMessage(error)
          return {
            name: error.name || 'AuthError',
            message: errorMessage,
            status: error.status || 500,
          } as AuthError
        }

        // Email confirmation required — user exists but can't sign in yet
        if (!data.session && data.user) {
          return {
            name: 'EmailConfirmationRequired',
            message:
              'Account created! Please check your email and click the confirmation link before signing in.',
            status: 200,
          } as AuthError
        }

        // Success with immediate session (email confirmation disabled)
        if (data.session) return null

        // Fallback: shouldn't reach here
        return {
          name: 'UnknownSignUpError',
          message: 'Sign up failed. Please try again.',
          status: 400,
        } as AuthError
      } catch (err) {
        console.error('signUp exception:', err)
        return {
          name: 'NetworkError',
          message: 'Could not connect to authentication server. Check your internet connection.',
          status: 0,
        } as AuthError
      }
    },
    []
  )

  const signIn = useCallback(
    async (email: string, password: string): Promise<AuthError | null> => {
      try {
        const { data, error } = await supabase.auth.signInWithPassword({
          email,
          password,
        })

        // Critical: verify we actually got a session back
        if (!error && (!data.session || !data.user)) {
          return {
            name: 'NoSessionReturned',
            message: 'Invalid email or password. Please try again.',
            status: 401,
          } as AuthError
        }

        if (error) {
          if (error.message?.includes('Email not confirmed')) {
            return {
              ...error,
              message:
                'Please check your email and click the confirmation link first. Check your spam folder too.',
            } as AuthError
          }
          if (
            error.message?.includes('Invalid login') ||
            error.message?.includes('Invalid email')
          ) {
            return {
              ...error,
              message: 'Invalid email or password. Please try again.',
            } as AuthError
          }
          // Normalize: ensure we always return a readable message string
          const errorMessage = parseAuthErrorMessage(error)
          return {
            name: error.name || 'AuthError',
            message: errorMessage,
            status: error.status || 500,
          } as AuthError
        }

        // Success — session/user are set by onAuthStateChange listener
        return null
      } catch (err) {
        console.error('signIn exception:', err)
        return {
          name: 'NetworkError',
          message: 'Could not connect to authentication server. Check your internet connection.',
          status: 0,
        } as AuthError
      }
    },
    []
  )

  const signOut = useCallback(async () => {
    // Stop device-side collection before any network cleanup. The Android
    // plugin retains only its encrypted, stop-only capability if offline and
    // durably retries revocation without uploading another coordinate.
    window.dispatchEvent(new CustomEvent('kalasag:signing-out'))

    let nativeSessionId: string | undefined
    try {
      const status = await getNativeDrivingStatus()
      nativeSessionId = status.sessionId
    } catch {
      // stopNativeDriving below remains the authoritative local stop request.
    }
    try {
      const stop = await stopNativeDriving()
      nativeSessionId = stop.sessionId ?? nativeSessionId
    } catch {
      // Continue with authenticated server cleanup. If the plugin is available
      // again, its persisted stop request resumes on the next service start.
    }

    if (user) {
      try {
        const cleanup = await stopMyFamilyDrivingForSignOut(user.id, nativeSessionId)
        if (nativeSessionId && cleanup.stoppedSessionIds.includes(nativeSessionId)) {
          await confirmNativeDrivingStopped(nativeSessionId)
        }
      } catch {
        // Native capability revocation remains durable; browser location
        // watching was already stopped by the signing-out event.
      }
    }

    // This RPC must use the still-valid JWT. If it cannot reach Supabase, the
    // helper invalidates the platform token instead and persists a retry.
    await unregisterFamilyPushForSignOut()

    const { error } = await supabase.auth.signOut()
    if (error) throw error
    setProfile(null)
  }, [user])

  const value: AuthContextValue = {
    session,
    user,
    profile,
    loading: loading || !initialized,
    signUp,
    signIn,
    signOut,
    refreshProfile,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth must be used within an <AuthProvider>')
  }
  return ctx
}
