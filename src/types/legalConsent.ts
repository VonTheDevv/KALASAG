export const CURRENT_TERMS_VERSION = '2026-07-18' as const
export const CURRENT_PRIVACY_VERSION = '2026-07-18' as const

export type SignupConsent = Readonly<{
  termsAccepted: true
  privacyAcknowledged: true
  termsVersion: typeof CURRENT_TERMS_VERSION
  privacyVersion: typeof CURRENT_PRIVACY_VERSION
}>
