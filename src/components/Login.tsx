import { useEffect, useRef, useState } from 'react'
import { Lock, LogIn, Mail } from 'lucide-react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useEntranceSlide } from '../hooks/useEntranceSlide'
import AuthShell from './AuthShell'
import AnimatedInput from './ui/AnimatedInput'
import { Button, ErrorBanner, Skeleton } from './ui/primitives'

export default function Login() {
  const { signIn, user, loading } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const prefilledEmail = (location.state as { email?: string })?.email || ''
  const [email, setEmail] = useState(prefilledEmail)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const navigationTimer = useRef<number | null>(null)
  const slideRef = useEntranceSlide()

  useEffect(() => {
    if (!loading && user && !submitting && !leaving) navigate('/app', { replace: true })
  }, [leaving, loading, navigate, submitting, user])

  useEffect(() => () => {
    if (navigationTimer.current !== null) window.clearTimeout(navigationTimer.current)
  }, [])

  const validateEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  const validatePassword = (value: string) => value.length >= 6

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    setLeaving(false)
    setSubmitting(true)

    try {
      const authError = await signIn(email, password)
      if (authError) {
        let displayError = authError.message?.trim() || ''
        if (displayError.startsWith('{') && displayError.endsWith('}')) {
          try {
            const parsed = JSON.parse(displayError)
            displayError = parsed.message || parsed.msg || parsed.error || parsed.error_description || ''
          } catch {
            // Retain the authentication provider's plain-text error.
          }
        }
        setError(
          !displayError || displayError === '{}' || displayError === '[]' || displayError === '[object Object]'
            ? 'Sign-in could not be completed. Check your details and try again.'
            : displayError,
        )
        return
      }

      setLeaving(true)
      navigationTimer.current = window.setTimeout(() => {
        navigate('/app', { replace: true })
        navigationTimer.current = null
      }, 260)
    } catch (caughtError: unknown) {
      setError(caughtError instanceof Error ? caughtError.message : 'Sign-in could not be completed. Try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div role="status" aria-label="Checking account session" className="grid h-full place-items-center bg-[var(--surface)] px-4">
        <div className="w-full max-w-md rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--panel)] p-6 shadow-[var(--shadow-sm)]">
          <Skeleton variant="block" className="mb-3 h-10 w-10" />
          <Skeleton variant="line" className="mb-8 h-5 w-40" />
          <Skeleton variant="block" className="mb-4 h-11 w-full" />
          <Skeleton variant="block" className="mb-6 h-11 w-full" />
          <Skeleton variant="block" className="h-11 w-full" />
          <span className="sr-only">Checking session</span>
        </div>
      </div>
    )
  }

  return (
    <AuthShell
      backTo="/"
      backLabel="Back to home"
      title="Login"
      showBrandIntro={true}
      contentRef={slideRef}
      animateTitle={true}
      isAnimatingOut={leaving}
      footer={
        <>
          New to KALASAG?{' '}
          <Link
            to="/signup"
            className="inline-flex min-h-8 items-center font-semibold text-[var(--action)] hover:text-[var(--action-hover)]"
          >
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={handleLogin} className="space-y-5" noValidate>
        <AnimatedInput
          label="Email address"
          type="email"
          icon={<Mail size={16} />}
          required
          autoComplete="email"
          value={email}
          onChange={event => setEmail(event.target.value)}
          placeholder="you@email.com"
          showValidation
          isValid={email.length > 0 ? validateEmail(email) : null}
          errorMessage="Enter a valid email address"
        />
        <AnimatedInput
          label="Password"
          type="password"
          icon={<Lock size={16} />}
          required
          autoComplete="current-password"
          value={password}
          onChange={event => setPassword(event.target.value)}
          placeholder="Enter your password"
          showValidation
          isValid={password.length > 0 ? validatePassword(password) : null}
          errorMessage="Password must be at least 6 characters"
        />

        <div className="text-right">
          <Link
            to="/forgot-password"
            className="inline-flex min-h-8 items-center text-xs font-semibold text-[var(--action)] hover:text-[var(--action-hover)]"
          >
            Forgot password?
          </Link>
        </div>

        {error && <ErrorBanner>{error}</ErrorBanner>}

        <Button
          type="submit"
          busy={submitting || leaving}
          disabled={loading || leaving || !validateEmail(email) || !validatePassword(password)}
          leadingIcon={<LogIn size={16} />}
          className="w-full"
        >
          {submitting || leaving ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </AuthShell>
  )
}
