import { type CSSProperties, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Lock, Mail, UserPlus, X } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useEntranceSlide } from '../hooks/useEntranceSlide'
import {
  CURRENT_PRIVACY_VERSION,
  CURRENT_TERMS_VERSION,
  type SignupConsent,
} from '../types/legalConsent'
import AuthShell from './AuthShell'
import AnimatedInput from './ui/AnimatedInput'
import { Button, ErrorBanner, IconButton, Toast } from './ui/primitives'

type LegalDocument = 'terms' | 'privacy'

export default function SignUp() {
  const { signUp, loading } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [termsAccepted, setTermsAccepted] = useState(false)
  const [privacyAcknowledged, setPrivacyAcknowledged] = useState(false)
  const [consentTouched, setConsentTouched] = useState(false)
  const [openLegalDocument, setOpenLegalDocument] = useState<LegalDocument | null>(null)
  const [screen, setScreen] = useState<'form' | 'revealing' | 'confirmed' | 'leaving'>('form')
  const transitionTimer = useRef<number | null>(null)
  const legalTriggerRef = useRef<HTMLButtonElement | null>(null)
  const termsCheckboxRef = useRef<HTMLInputElement>(null)
  const privacyCheckboxRef = useRef<HTMLInputElement>(null)
  const slideRef = useEntranceSlide()

  useEffect(() => () => {
    if (transitionTimer.current !== null) window.clearTimeout(transitionTimer.current)
  }, [])

  const validateEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  const validatePassword = (value: string) => value.length >= 6
  const validateConfirm = (value: string) => value === password
  const fieldsValid = validateEmail(email) && validatePassword(password) && validateConfirm(confirmPassword)
  const consentValid = termsAccepted && privacyAcknowledged
  const consentError = consentTouched && !consentValid
    ? 'Accept the Terms of Service and acknowledge the Privacy Notice before creating your account.'
    : ''

  const showLegalDocument = (document: LegalDocument, trigger: HTMLButtonElement) => {
    legalTriggerRef.current = trigger
    setOpenLegalDocument(document)
  }

  const closeLegalDocument = () => {
    setOpenLegalDocument(null)
    window.requestAnimationFrame(() => legalTriggerRef.current?.focus())
  }

  const handleSignUp = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    setSuccess('')
    if (!fieldsValid) {
      setError('Complete every required field correctly before continuing.')
      return
    }
    if (!consentValid) {
      setConsentTouched(true)
      setError('Accept the Terms of Service and acknowledge the Privacy Notice before continuing.')
      window.requestAnimationFrame(() => {
        if (!termsAccepted) termsCheckboxRef.current?.focus()
        else privacyCheckboxRef.current?.focus()
      })
      return
    }

    setSubmitting(true)
    let confirmationStarted = false
    try {
      const consent: SignupConsent = {
        termsAccepted: true,
        privacyAcknowledged: true,
        termsVersion: CURRENT_TERMS_VERSION,
        privacyVersion: CURRENT_PRIVACY_VERSION,
      }
      const authError = await signUp(email, password, consent)
      if (!authError) {
        setSuccess('Account created. Opening your monitoring workspace…')
        window.setTimeout(() => navigate('/app'), 900)
        return
      }

      if (authError.name === 'EmailConfirmationRequired' || authError.message?.includes('confirmation')) {
        confirmationStarted = true
        setScreen('revealing')
        transitionTimer.current = window.setTimeout(() => {
          setScreen('confirmed')
          setSubmitting(false)
          transitionTimer.current = null
        }, 340)
        return
      }

      if (authError.name === 'AlreadyRegistered') {
        setSuccess(authError.message)
        window.setTimeout(() => navigate('/login', { state: { email } }), 1200)
        return
      }

      let displayError = authError.message?.trim() || ''
      if (displayError.startsWith('{') && displayError.endsWith('}')) {
        try {
          const parsed = JSON.parse(displayError)
          displayError = parsed.message || parsed.msg || parsed.error || parsed.error_description || ''
        } catch {
          // Retain the provider's plain-text error.
        }
      }
      setError(
        !displayError || displayError === '{}' || displayError === '[]' || displayError === '[object Object]'
          ? 'Account creation could not be completed. Try again.'
          : displayError,
      )
    } catch (caughtError: unknown) {
      setError(caughtError instanceof Error ? caughtError.message : 'Account creation could not be completed. Try again.')
    } finally {
      if (!confirmationStarted) setSubmitting(false)
    }
  }

  const leaveConfirmation = (destination: '/' | '/login') => {
    if (screen !== 'confirmed') return

    setScreen('leaving')
    transitionTimer.current = window.setTimeout(() => {
      navigate(destination, destination === '/login' ? { state: { email } } : undefined)
      transitionTimer.current = null
    }, 460)
  }

  const confirmationVisible = screen === 'confirmed' || screen === 'leaving'
  const title = confirmationVisible ? 'Check your email!' : 'Create your account'
  const isTitleLeaving = screen === 'revealing' || screen === 'leaving'

  return (
    <AuthShell
      backTo="/"
      backLabel="Back to home"
      title={title}
      showBrandIntro={true}
      contentRef={slideRef}
      animateTitle={true}
      isAnimatingOut={isTitleLeaving}
      titleMotionKey={screen === 'form' || screen === 'revealing' ? 'signup-form' : 'signup-confirmation'}
      onBackClick={confirmationVisible ? event => { event.preventDefault(); leaveConfirmation('/') } : undefined}
      titleAccessory={confirmationVisible ? <ConfirmationCheck leaving={screen === 'leaving'} /> : undefined}
      footer={
        confirmationVisible ? (
          <button
            type="button"
            onClick={() => leaveConfirmation('/login')}
            disabled={screen === 'leaving'}
            className="ui-control inline-flex min-h-8 items-center font-semibold text-[var(--action)] hover:text-[var(--action-hover)] disabled:pointer-events-none"
          >
            Sign in
          </button>
        ) : (
          <>
            Already have an account?{' '}
            <Link to="/login" className="font-semibold text-[var(--action)] hover:text-[var(--action-hover)]">
              Sign in
            </Link>
          </>
        )
      }
    >
      {confirmationVisible ? (
        <section
          aria-live="polite"
          className={`signup-confirmation ${screen === 'leaving' ? 'signup-confirmation--leaving' : ''}`}
        >
          <p className="text-sm leading-relaxed text-[var(--text-soft)]">
            We sent a confirmation link to <strong className="font-semibold text-[var(--text)]">{email}</strong>.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-[var(--muted)]">
            Open the link to activate your account, then return here and sign in. Check your spam folder if it does not arrive shortly.
          </p>
          <button
            type="button"
            onClick={() => leaveConfirmation('/login')}
            disabled={screen === 'leaving'}
            className="ui-control mt-6 inline-flex min-h-11 items-center justify-center rounded-[var(--radius-md)] bg-[var(--action)] px-4 text-sm font-semibold text-[var(--action-text)] shadow-[var(--shadow-sm)] hover:bg-[var(--action-hover)] disabled:pointer-events-none"
          >
            Go to sign in
          </button>
        </section>
      ) : (
      <form onSubmit={handleSignUp} className={`space-y-4 ${screen === 'revealing' ? 'signup-form--leaving' : ''}`} noValidate>
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
          autoComplete="new-password"
          value={password}
          onChange={event => setPassword(event.target.value)}
          placeholder="At least 6 characters"
          showValidation
          isValid={password.length > 0 ? validatePassword(password) : null}
          errorMessage="Password must be at least 6 characters"
        />
        <AnimatedInput
          label="Confirm password"
          type="password"
          icon={<Lock size={16} />}
          required
          autoComplete="new-password"
          value={confirmPassword}
          onChange={event => setConfirmPassword(event.target.value)}
          placeholder="Re-enter your password"
          showValidation
          isValid={confirmPassword.length > 0 ? validateConfirm(confirmPassword) : null}
          errorMessage="Passwords do not match"
        />

        <fieldset className="space-y-2" aria-describedby={consentError ? 'signup-consent-error' : 'signup-consent-help'}>
          <legend className="sr-only">Required legal acknowledgements</legend>

          <div className="divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius-md)] bg-[var(--surface-alt)] px-3 shadow-[inset_0_1px_2px_rgb(2_8_23_/_0.16)]">
            <div className="flex min-h-10 items-center gap-2.5 py-1.5">
              <input
                id="signup-terms"
                ref={termsCheckboxRef}
                name="termsAccepted"
                type="checkbox"
                required
                checked={termsAccepted}
                onChange={event => {
                  setTermsAccepted(event.target.checked)
                  setConsentTouched(true)
                }}
                onBlur={() => setConsentTouched(true)}
                aria-invalid={Boolean(consentError) || undefined}
                aria-describedby={consentError ? 'signup-consent-error' : 'signup-consent-help'}
                className="h-6 w-6 shrink-0 accent-[var(--action)]"
              />
              <p className="min-w-0 text-[11px] leading-4 text-[var(--text-soft)] sm:text-xs">
                <label htmlFor="signup-terms" className="cursor-pointer">I accept the <span className="sr-only">Terms of Service</span></label>{' '}
                <button
                  type="button"
                  className="ui-control rounded-sm font-semibold text-[var(--action)] underline decoration-transparent underline-offset-2 hover:decoration-current"
                  onClick={event => {
                    event.preventDefault()
                    event.stopPropagation()
                    showLegalDocument('terms', event.currentTarget)
                  }}
                >
                  Terms of Service
                </button>
                <span aria-hidden="true">.</span>
              </p>
            </div>

            <div className="flex min-h-10 items-center gap-2.5 py-1.5">
              <input
                id="signup-privacy"
                ref={privacyCheckboxRef}
                name="privacyAcknowledged"
                type="checkbox"
                required
                checked={privacyAcknowledged}
                onChange={event => {
                  setPrivacyAcknowledged(event.target.checked)
                  setConsentTouched(true)
                }}
                onBlur={() => setConsentTouched(true)}
                aria-invalid={Boolean(consentError) || undefined}
                aria-describedby={consentError ? 'signup-consent-error' : 'signup-consent-help'}
                className="h-6 w-6 shrink-0 accent-[var(--action)]"
              />
              <p className="min-w-0 text-[11px] leading-4 text-[var(--text-soft)] sm:text-xs">
                <label htmlFor="signup-privacy" className="cursor-pointer">I acknowledge the <span className="sr-only">Privacy Notice and Data Privacy Act statement</span></label>{' '}
                <button
                  type="button"
                  className="ui-control rounded-sm font-semibold text-[var(--action)] underline decoration-transparent underline-offset-2 hover:decoration-current"
                  onClick={event => {
                    event.preventDefault()
                    event.stopPropagation()
                    showLegalDocument('privacy', event.currentTarget)
                  }}
                >
                  Privacy Notice
                </button>
                <span aria-hidden="true">.</span>
              </p>
            </div>
          </div>

          {consentError ? (
            <p id="signup-consent-error" role="alert" className="text-xs font-medium text-[var(--danger)]">
              {consentError}
            </p>
          ) : (
            <p id="signup-consent-help" className="text-[11px] leading-relaxed text-[var(--muted)]">
              Both selections are required. Opening either document does not select its checkbox.
            </p>
          )}
        </fieldset>

        {error && <ErrorBanner>{error}</ErrorBanner>}
        {success && <Toast tone="success">{success}</Toast>}

        <Button
          type="submit"
          busy={submitting}
          disabled={loading || submitting}
          leadingIcon={<UserPlus size={16} />}
          className="w-full"
        >
          {submitting ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
      )}

      {!confirmationVisible && (
        <p className="mt-4 text-center text-[11px] leading-relaxed text-[var(--muted)]">
          Your Emergency QR ID profile is set up after your first sign-in.
        </p>
      )}

      {openLegalDocument && (
        <LegalDialog document={openLegalDocument} onClose={closeLegalDocument} />
      )}
    </AuthShell>
  )
}

function LegalDialog({ document, onClose }: { document: LegalDocument; onClose: () => void }) {
  const dialogRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const isTerms = document === 'terms'
  const effectiveVersion = isTerms ? CURRENT_TERMS_VERSION : CURRENT_PRIVACY_VERSION
  const titleId = `signup-${document}-title`
  const descriptionId = `signup-${document}-description`

  useEffect(() => {
    const previousOverflow = window.document.body.style.overflow
    window.document.body.style.overflow = 'hidden'
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0)

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      if (!focusable?.length) {
        event.preventDefault()
        dialogRef.current?.focus()
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const activeElement = window.document.activeElement
      if (!dialogRef.current?.contains(activeElement)) {
        event.preventDefault()
        const focusTarget = event.shiftKey ? last : first
        focusTarget.focus()
      } else if (event.shiftKey && (activeElement === first || activeElement === dialogRef.current)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && window.document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    window.document.addEventListener('keydown', onKeyDown)
    return () => {
      window.clearTimeout(focusTimer)
      window.document.body.style.overflow = previousOverflow
      window.document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-[4000] overflow-y-auto bg-black/70 p-3 backdrop-blur-sm sm:p-6"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className="elevated-panel mx-auto flex max-h-[calc(100dvh-1.5rem)] w-full max-w-2xl flex-col overflow-hidden rounded-[var(--radius-lg)] bg-[var(--panel)] shadow-[var(--shadow-lg)] sm:max-h-[calc(100dvh-3rem)]"
      >
        <header className="flex shrink-0 items-start gap-3 px-4 py-4 sm:px-5">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--action)]">
              {isTerms ? 'Required agreement' : 'Required privacy notice'}
            </p>
            <h2 id={titleId} className="mt-1 text-lg font-black text-[var(--text)] sm:text-xl">
              {isTerms ? 'Terms of Service' : 'Privacy Notice and Data Privacy Act Statement'}
            </h2>
            <p id={descriptionId} className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
              Read this document before selecting its separate checkbox on the sign-up form.
            </p>
            <p className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">
              Effective {new Intl.DateTimeFormat('en-PH', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${effectiveVersion}T00:00:00Z`))} · Version {effectiveVersion}
            </p>
          </div>
          <IconButton ref={closeButtonRef} variant="ghost" size="sm" onClick={onClose} aria-label={`Close ${isTerms ? 'Terms of Service' : 'Privacy Notice'}`}>
            <X size={18} aria-hidden="true" />
          </IconButton>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-[var(--border)] px-4 py-4 text-sm leading-6 text-[var(--text-soft)] sm:px-5">
          {isTerms ? <TermsContent /> : <PrivacyContent />}
        </div>

        <footer className="shrink-0 border-t border-[var(--border)] bg-[var(--panel)] px-4 py-3 sm:px-5">
          <Button variant="primary" className="w-full sm:ml-auto sm:w-auto" onClick={onClose}>Close and return</Button>
        </footer>
      </section>
    </div>,
    window.document.body,
  )
}

function TermsContent() {
  return (
    <div className="space-y-5">
      <LegalSection title="1. Purpose and acceptance">
        KALASAG provides safety coordination, disaster-awareness information, family safety features, and access to emergency resources. Creating an account means you agree to use these features responsibly and in accordance with Philippine law.
      </LegalSection>
      <LegalSection title="2. Emergency-information limitations">
        Live feeds, maps, forecasts, routes, alerts, and automated summaries may be delayed, incomplete, unavailable, or changed by their providers. KALASAG does not replace instructions from PAGASA, PHIVOLCS, NDRRMC, local government, police, fire, rescue, medical personnel, or other authorities. In an immediate emergency, contact the appropriate authority directly.
      </LegalSection>
      <LegalSection title="3. Account and family features">
        Keep your credentials secure and provide accurate information. Family membership, safety status, chat, Driving Mode, emergency alerts, and location sharing must be used only for legitimate safety coordination. Location sharing begins only through an action or safety mode described in the app and remains subject to device permissions.
      </LegalSection>
      <LegalSection title="4. Prohibited conduct">
        You must not impersonate another person, send false emergency reports, harass or track someone without authority, upload unlawful content, interfere with the service, bypass security controls, scrape protected data, or use KALASAG to cause harm.
      </LegalSection>
      <LegalSection title="5. Availability and changes">
        Features may be changed, suspended, or removed for safety, security, maintenance, legal compliance, or provider availability. No uninterrupted or error-free operation is promised. Material changes to these terms should be presented through an updated notice before they apply to continued use.
      </LegalSection>
      <LegalSection title="6. Ending use">
        You may stop using KALASAG and request account deletion subject to lawful retention requirements. Access may be restricted when necessary to protect users, the service, or the public, or when these terms are materially violated.
      </LegalSection>
    </div>
  )
}

function PrivacyContent() {
  return (
    <div className="space-y-5">
      <LegalSection title="1. Data Privacy Act commitment">
        Personal data is handled in accordance with Republic Act No. 10173, the Data Privacy Act of 2012, its implementing rules, and other applicable Philippine requirements. Processing should remain transparent, proportionate, and limited to legitimate safety and service purposes.
      </LegalSection>
      <LegalSection title="2. Information processed">
        Depending on the features you use, KALASAG may process account identifiers, email address, profile and Emergency QR information, family membership, safety status, emergency reasons, family messages, device notification tokens, approximate or precise location, Driving Mode updates, uploaded media, and security or diagnostic records.
      </LegalSection>
      <LegalSection title="3. Why information is used">
        Information is used to authenticate accounts, provide requested safety tools, deliver family and emergency alerts, display locations you choose to share, protect accounts, diagnose failures, prevent abuse, comply with law, and improve reliability. Enabling a device permission does not by itself begin family location sharing.
      </LegalSection>
      <LegalSection title="4. Disclosure and service providers">
        Information may be shown to approved members of a family when required by the feature you use. Limited data may also be processed by infrastructure, notification, mapping, storage, authentication, and monitoring providers acting to operate KALASAG. Data is not to be sold as a safety-feature condition.
      </LegalSection>
      <LegalSection title="5. Location and background controls">
        Foreground or background location is used only as described by an enabled safety function and Android permission state. Driving Mode is explicitly started and stopped by the user. Android may provide separate controls for precise location, background access, battery behavior, notifications, and accessibility support.
      </LegalSection>
      <LegalSection title="6. Retention and protection">
        Data should be retained only for as long as needed for the stated purpose, safety, security, dispute handling, or legal obligations. Administrative, technical, and organizational safeguards are used, but no internet-connected system can guarantee absolute security.
      </LegalSection>
      <LegalSection title="7. Your privacy rights">
        Subject to applicable law, you may request access, correction, deletion or blocking, object to certain processing, withdraw consent where consent is the basis, request data portability where applicable, and raise a complaint with the National Privacy Commission. Withdrawing a permission may limit the feature that depends on it without preventing use of unrelated features.
      </LegalSection>
    </div>
  )
}

function LegalSection({ title, children }: { title: string; children: string }) {
  return (
    <section>
      <h3 className="font-bold text-[var(--text)]">{title}</h3>
      <p className="mt-1">{children}</p>
    </section>
  )
}

function ConfirmationCheck({ leaving }: { leaving: boolean }) {
  return (
    <span className={`signup-confirmation-mark ${leaving ? 'signup-confirmation-mark--popping' : ''}`} aria-hidden="true">
      <span className="signup-confirmation-mark__circle"><Check size={18} strokeWidth={3} /></span>
      {Array.from({ length: 10 }, (_, index) => (
        <span key={index} className="signup-confirmation-mark__particle" style={{ '--particle-index': index } as CSSProperties} />
      ))}
    </span>
  )
}
