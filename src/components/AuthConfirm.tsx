import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import type { EmailOtpType } from '@supabase/supabase-js'
import { useLocation, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import AuthShell from './AuthShell'
import { Button, ErrorBanner, Skeleton } from './ui/primitives'

type ConfirmationState = 'verifying' | 'confirmed' | 'error'
type ConfirmationResult = { state: Exclude<ConfirmationState, 'verifying'>; message: string }
type AuthLocation = { pathname: string; search: string; hash: string }

const allowedEmailTypes = new Set<EmailOtpType>([
  'email',
  'signup',
  'invite',
  'magiclink',
  'recovery',
  'email_change',
])

function readAuthError(location: AuthLocation) {
  const search = new URLSearchParams(location.search)
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ''))
  return (
    search.get('error_description') ||
    fragment.get('error_description') ||
    search.get('error') ||
    fragment.get('error') ||
    ''
  ).replace(/\+/g, ' ')
}

const confirmationRequests = new Map<string, Promise<ConfirmationResult>>()

async function verifyConfirmation(location: AuthLocation): Promise<ConfirmationResult> {
  const redirectError = readAuthError(location)
  if (redirectError) return { state: 'error', message: redirectError }

  const params = new URLSearchParams(location.search)
  const tokenHash = params.get('token_hash')
  const type = params.get('type')

  try {
    if (tokenHash && type && allowedEmailTypes.has(type as EmailOtpType)) {
      const { error } = await supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type: type as EmailOtpType,
      })

      if (error) {
        return {
          state: 'error',
          message: error.message || 'This confirmation link is invalid or has expired.',
        }
      }
    } else {
      const { data, error } = await supabase.auth.getSession()
      if (error || !data.session) {
        return {
          state: 'error',
          message: 'This confirmation link is invalid or has expired. Request a new link and try again.',
        }
      }
    }

    return {
      state: 'confirmed',
      message: 'Your email is confirmed. Opening your KALASAG workspace…',
    }
  } catch (error) {
    return {
      state: 'error',
      message: error instanceof Error
        ? error.message
        : 'The confirmation service could not be reached. Check your connection and try again.',
    }
  }
}

function getConfirmationRequest(location: AuthLocation) {
  const key = `${location.pathname}${location.search}${location.hash}`
  const existingRequest = confirmationRequests.get(key)
  if (existingRequest) return existingRequest

  const timeoutResult = new Promise<ConfirmationResult>(resolve => {
    window.setTimeout(() => resolve({
      state: 'error',
      message: 'Email verification took too long. Check your connection, then open the confirmation link again.',
    }), 12_000)
  })
  const request = Promise.race([verifyConfirmation(location), timeoutResult])
  confirmationRequests.set(key, request)
  return request
}

export default function AuthConfirm() {
  const location = useLocation()
  const navigate = useNavigate()
  const [state, setState] = useState<ConfirmationState>('verifying')
  const [message, setMessage] = useState('Verifying your confirmation link…')

  useEffect(() => {
    let active = true
    let navigationTimer: number | undefined

    void getConfirmationRequest(location).then(result => {
      if (!active) return
      setState(result.state)
      setMessage(result.message)
      if (result.state === 'confirmed') {
        navigationTimer = window.setTimeout(() => navigate('/app', { replace: true }), 850)
      }
    })

    return () => {
      active = false
      if (navigationTimer !== undefined) window.clearTimeout(navigationTimer)
    }
  }, [location, navigate])

  return (
    <AuthShell
      backTo="/login"
      backLabel="Back to sign in"
      eyebrow="Account verification"
      title={state === 'confirmed' ? 'Email confirmed' : state === 'error' ? 'Link could not be verified' : 'Checking your email link'}
      icon={state === 'error' ? <AlertTriangle size={21} /> : <CheckCircle2 size={21} />}
    >
      {state === 'verifying' ? (
        <div role="status" aria-live="polite" className="space-y-4">
          <Skeleton variant="line" className="h-4 w-full" />
          <Skeleton variant="line" className="h-4 w-4/5" />
          <Skeleton variant="block" className="mt-6 h-11 w-full" />
          <span className="sr-only">{message}</span>
        </div>
      ) : state === 'error' ? (
        <div className="space-y-5">
          <ErrorBanner>{message}</ErrorBanner>
          <Button type="button" className="w-full" onClick={() => navigate('/signup', { replace: true })}>
            Return to sign up
          </Button>
        </div>
      ) : (
        <div role="status" aria-live="polite" className="space-y-5">
          <p className="text-sm leading-relaxed text-[var(--text-soft)]">{message}</p>
          <Button type="button" className="w-full" onClick={() => navigate('/app', { replace: true })}>
            Open KALASAG
          </Button>
        </div>
      )}
    </AuthShell>
  )
}
