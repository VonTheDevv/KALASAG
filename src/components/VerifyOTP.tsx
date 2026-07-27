import { useState } from 'react'
import { CheckCircle2, Lock } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { updateRecoveredPassword } from '../lib/email'
import { useEntranceSlide } from '../hooks/useEntranceSlide'
import AuthShell from './AuthShell'
import AnimatedInput from './ui/AnimatedInput'
import { Button, ErrorBanner, Toast } from './ui/primitives'

export default function VerifyOTP() {
  const navigate = useNavigate()
  const slideRef = useEntranceSlide()
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const isValid = newPassword.length >= 8 && newPassword === confirmPassword

  const handleReset = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setSubmitting(true)
    try {
      const result = await updateRecoveredPassword(newPassword)
      if (!result.success) {
        setError(result.error || 'The password could not be reset. Request a new recovery link and try again.')
        return
      }
      setSuccess('Password reset successfully. Redirecting to sign in…')
      window.setTimeout(() => navigate('/login'), 1000)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthShell
      backTo="/login"
      backLabel="Back to sign in"
      eyebrow="Recovery link"
      title="Set a new password"
      description="Choose a strong password to restore access to your account."
      icon={<CheckCircle2 size={21} />}
      contentRef={slideRef}
    >
      <form onSubmit={handleReset} className="space-y-4" noValidate>
        <AnimatedInput
          label="New password"
          type="password"
          icon={<Lock size={16} />}
          required
          autoComplete="new-password"
          value={newPassword}
          onChange={event => setNewPassword(event.target.value)}
          placeholder="At least 8 characters"
          showValidation
          isValid={newPassword.length > 0 ? newPassword.length >= 8 : null}
          errorMessage="Password must be at least 8 characters"
        />
        <AnimatedInput
          label="Confirm new password"
          type="password"
          icon={<Lock size={16} />}
          required
          autoComplete="new-password"
          value={confirmPassword}
          onChange={event => setConfirmPassword(event.target.value)}
          placeholder="Re-enter your password"
          showValidation
          isValid={confirmPassword.length > 0 ? confirmPassword === newPassword : null}
          errorMessage="Passwords do not match"
        />

        {error && <ErrorBanner>{error}</ErrorBanner>}
        {success && <Toast tone="success">{success}</Toast>}

        <Button type="submit" busy={submitting} disabled={!isValid} className="w-full">
          {submitting ? 'Saving password…' : 'Reset password'}
        </Button>
      </form>
    </AuthShell>
  )
}
