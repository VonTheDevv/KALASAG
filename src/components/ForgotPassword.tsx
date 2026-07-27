import { useEffect, useState } from 'react'
import { Mail, Send } from 'lucide-react'
import { requestPasswordReset } from '../lib/email'
import { useEntranceSlide } from '../hooks/useEntranceSlide'
import AuthShell from './AuthShell'
import AnimatedInput from './ui/AnimatedInput'
import { Button, ErrorBanner, Toast } from './ui/primitives'

export default function ForgotPassword() {
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [cooldown, setCooldown] = useState(0)
  const slideRef = useEntranceSlide()

  useEffect(() => {
    if (cooldown <= 0) return
    const timer = window.setInterval(() => setCooldown(value => Math.max(0, value - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [cooldown])

  const validateEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)

  const handleSendRecoveryLink = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    setSuccess('')
    if (!validateEmail(email)) {
      setError('Enter a valid email address.')
      return
    }

    setSubmitting(true)
    try {
      const result = await requestPasswordReset(email.trim())
      if (result.success) {
        setSuccess('If an account exists for this email, a recovery link has been sent. Open it in this browser to set a new password.')
        setCooldown(60)
      } else {
        setError(result.error || 'The recovery link could not be sent. Try again.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  const cooldownLabel = `Wait ${Math.floor(cooldown / 60)}:${String(cooldown % 60).padStart(2, '0')}`

  return (
    <AuthShell
      backTo="/login"
      backLabel="Back to sign in"
      eyebrow="Account recovery"
      title="Reset your password"
      description="Enter your email address and we’ll send a secure recovery link."
      icon={<Mail size={21} />}
      contentRef={slideRef}
    >
      <form onSubmit={handleSendRecoveryLink} className="space-y-5" noValidate>
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

        {error && <ErrorBanner>{error}</ErrorBanner>}
        {success && <Toast tone="success">{success}</Toast>}

        <Button
          type="submit"
          busy={submitting}
          disabled={!validateEmail(email) || cooldown > 0}
          leadingIcon={<Send size={16} />}
          className="w-full"
        >
          {submitting ? 'Sending recovery link…' : cooldown > 0 ? cooldownLabel : 'Send recovery link'}
        </Button>
      </form>

      <p className="mt-4 text-center text-[11px] leading-relaxed text-[var(--muted)]">
        Recovery links are securely issued by the account service and expire automatically.
      </p>
    </AuthShell>
  )
}
