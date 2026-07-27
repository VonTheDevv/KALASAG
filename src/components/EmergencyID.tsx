import React, { useState, useRef, useEffect, useId } from 'react'
import { User, Heart, Phone, Download, RotateCcw, Shield, LogIn, MapPin, LoaderCircle } from 'lucide-react'
import { QRCodeCanvas } from 'qrcode.react'
import { useAuth } from '../hooks/useAuth'
import { upsertEmergencyProfile, logQRCode } from '../lib/supabase'
import { useOnlineStatus } from '../hooks/useOnlineStatus'
import { searchPhilippineAddresses, type AddressSuggestion } from '../lib/addressSearch'
import { Select } from './ui/primitives'
import {
  EMPTY_EMERGENCY_FORM,
  cloudToEmergencyForm,
  emergencyContactAddress,
  emergencyContactName,
  isEmergencyFormComplete,
  migrateEmergencyForm,
  validateEmergencyForm,
  type EmergencyFormData,
  type EmergencyFormErrors,
} from '../lib/emergencyProfile'

const BLOOD_TYPES = ['A+', 'A−', 'B+', 'B−', 'AB+', 'AB−', 'O+', 'O−', 'Unknown']
const RELATION_OPTIONS = ['Parent', 'Spouse', 'Sibling', 'Guardian', 'Others']
const STORAGE_KEY = 'kalasag_emergency_profile'
type AddressSearchStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error'

const toUpper = (v: string) => v.toUpperCase()
const digitsOnly = (v: string) => v.replace(/\D/g, '')

export default function EmergencyID({ onSaved }: { onSaved?: () => void }) {
  const { user, profile: cloudProfile, refreshProfile } = useAuth()
  const isOnline = useOnlineStatus()

  const [formData, setFormData] = useState<EmergencyFormData>({ ...EMPTY_EMERGENCY_FORM })
  const [isEditing, setIsEditing] = useState(false)
  const [showQR, setShowQR] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [errors, setErrors] = useState<EmergencyFormErrors>({})
  const [addressFocused, setAddressFocused] = useState(false)
  const [addressSuggestions, setAddressSuggestions] = useState<AddressSuggestion[]>([])
  const [addressSearchStatus, setAddressSearchStatus] = useState<AddressSearchStatus>('idle')
  const [addressSearchError, setAddressSearchError] = useState('')
  const [activeAddressIndex, setActiveAddressIndex] = useState(0)
  const [confirmedStreetAddress, setConfirmedStreetAddress] = useState('')
  const qrRef = useRef<HTMLDivElement>(null)
  const addressContainerRef = useRef<HTMLDivElement>(null)
  const addressInputRef = useRef<HTMLInputElement>(null)
  const addressListId = useId()
  const streetAddressInputId = useId()
  const streetAddressErrorId = useId()
  const contactRelationId = useId()
  const contactRelationErrorId = useId()

  useEffect(() => {
    if (!user) return

    const userStorageKey = `kalasag_emergency_profile_${user.id}`

    // 1. Prioritize Supabase cloud data
    if (cloudProfile && (cloudProfile.first_name || cloudProfile.last_name)) {
      const parsed = cloudToEmergencyForm(cloudProfile)
      setFormData(parsed)
      localStorage.setItem(userStorageKey, JSON.stringify(parsed))
      if (!isEditing) setShowQR(isEmergencyFormComplete(parsed))
      return
    }

    // 2. Fallback to user-scoped localStorage
    try {
      const cached = localStorage.getItem(userStorageKey)
      if (cached) {
        const parsed = migrateEmergencyForm(JSON.parse(cached))
        setFormData(parsed)
        if (!isEditing) setShowQR(isEmergencyFormComplete(parsed))
      } else {
        setFormData({ ...EMPTY_EMERGENCY_FORM })
        setShowQR(false)
      }
    } catch {
      setFormData({ ...EMPTY_EMERGENCY_FORM })
      setShowQR(false)
    }
  }, [user, cloudProfile, isEditing])

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!addressContainerRef.current?.contains(event.target as Node)) setAddressFocused(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [])

  useEffect(() => {
    const query = formData.streetAddress.replace(/\s+/g, ' ').trim()
    if (!addressFocused || query.length < 3 || query === confirmedStreetAddress) {
      setAddressSuggestions([])
      setAddressSearchStatus('idle')
      setAddressSearchError('')
      return
    }
    if (!isOnline) {
      setAddressSuggestions([])
      setAddressSearchStatus('error')
      setAddressSearchError('Address suggestions are unavailable offline. You can continue with manual entry.')
      return
    }

    setAddressSuggestions([])
    setAddressSearchStatus('loading')
    setActiveAddressIndex(0)
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      setAddressSearchError('')
      try {
        const suggestions = await searchPhilippineAddresses(query, controller.signal)
        if (controller.signal.aborted) return
        setAddressSuggestions(suggestions)
        setActiveAddressIndex(0)
        setAddressSearchStatus(suggestions.length ? 'ready' : 'empty')
      } catch (error) {
        if (controller.signal.aborted) return
        setAddressSuggestions([])
        setAddressSearchStatus('error')
        setAddressSearchError(error instanceof Error ? error.message : 'Address suggestions are temporarily unavailable')
      }
    }, 350)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [addressFocused, confirmedStreetAddress, formData.streetAddress, isOnline])

  const fullNameDisplay = [formData.firstName, formData.middleName, formData.lastName]
    .map(value => value.trim()).filter(Boolean).join(' ')
    + (formData.nameExtension && formData.nameExtension.toUpperCase() !== 'N/A' ? ` ${formData.nameExtension}` : '')
  const contactNameDisplay = emergencyContactName(formData)
  const contactAddressDisplay = emergencyContactAddress(formData)

  const qrPayload = {
    type: 'KALASAG Emergency ID',
    email: user?.email || '',
    name: fullNameDisplay,
    blood: formData.bloodType,
    allergies: formData.allergies,
    medications: formData.medications,
    conditions: formData.conditions,
    emergency_contact: `${contactNameDisplay} (${formData.contactRelation}) - ${formData.contactNumber}`,
    emergency_contact_address: contactAddressDisplay,
    generated: new Date().toISOString().slice(0, 10),
  }

  const qrTextString = `KALASAG PH - EMERGENCY ID
-------------------------
Name: ${fullNameDisplay}
Email: ${user?.email || 'N/A'}
Blood Type: ${formData.bloodType || 'N/A'}

-- MEDICAL INFO --
Allergies: ${formData.allergies || 'NONE'}
Medications: ${formData.medications || 'NONE'}
Conditions: ${formData.conditions || 'NONE'}

-- IN CASE OF EMERGENCY --
Contact: ${contactNameDisplay} (${formData.contactRelation})
Number: ${formData.contactNumber}
Address: ${contactAddressDisplay}

Generated: ${qrPayload.generated}`

  const isComplete = isEmergencyFormComplete(formData)

  const handleChange = (field: keyof EmergencyFormData, value: string) => {
    setFormData(p => ({ ...p, [field]: value }))
    if (value.trim() && errors[field]) {
      setErrors(e => { const n = { ...e }; delete n[field]; return n })
    }
  }

  const handleCapitalizedChange = (field: keyof EmergencyFormData, value: string) =>
    handleChange(field, toUpper(value))

  const handleNumberChange = (field: keyof EmergencyFormData, value: string, maxLength: number) =>
    handleChange(field, digitsOnly(value).slice(0, maxLength))

  const validate = (): boolean => {
    const errs = validateEmergencyForm(formData)
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  const selectAddressSuggestion = (suggestion: AddressSuggestion) => {
    setFormData(previous => ({
      ...previous,
      streetAddress: suggestion.streetAddress,
      city: suggestion.city || previous.city,
      postalCode: suggestion.postalCode || previous.postalCode,
    }))
    setErrors(previous => {
      const next = { ...previous }
      delete next.streetAddress
      if (suggestion.city) delete next.city
      if (suggestion.postalCode) delete next.postalCode
      return next
    })
    setConfirmedStreetAddress(suggestion.streetAddress)
    setAddressSuggestions([])
    setAddressSearchStatus('idle')
    setAddressSearchError('')
  }

  const handleAddressKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setAddressSuggestions([])
      setAddressSearchStatus('idle')
      addressInputRef.current?.blur()
      return
    }
    if (!addressSuggestions.length) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveAddressIndex(index => (index + 1) % addressSuggestions.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveAddressIndex(index => (index - 1 + addressSuggestions.length) % addressSuggestions.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      selectAddressSuggestion(addressSuggestions[activeAddressIndex])
    }
  }

  const handleSave = async () => {
    if (saving || !validate()) return
    setSaveError(null)
    setSaving(true)

    const userStorageKey = user ? `kalasag_emergency_profile_${user.id}` : STORAGE_KEY

    try {
      let dbSuccess = true
      if (user && isOnline) {
        const result = await upsertEmergencyProfile(user.id, {
          first_name: formData.firstName,
          middle_name: formData.middleName,
          last_name: formData.lastName,
          name_extension: formData.nameExtension,
          blood_type: formData.bloodType,
          allergies: formData.allergies,
          medications: formData.medications,
          conditions: formData.conditions,
          contact_name: contactNameDisplay,
          contact_first_name: formData.contactFirstName,
          contact_middle_name: formData.contactMiddleName,
          contact_last_name: formData.contactLastName,
          contact_number: formData.contactNumber,
          contact_relation: formData.contactRelation,
          street_address: formData.streetAddress,
          city: formData.city,
          postal_code: formData.postalCode,
        })
        if (result.success) {
          await logQRCode(user.id, qrPayload)
          await refreshProfile()
        } else {
          dbSuccess = false
          setSaveError(result.error || 'Failed to save to database.')
        }
      }

      if (dbSuccess) {
        localStorage.setItem(userStorageKey, JSON.stringify(formData))
        setSaved(true)
        setTimeout(() => setSaved(false), 2500)
        setShowQR(true)
        setIsEditing(false)
      }
    } catch {
      setSaveError('Emergency contact details could not be saved. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  const handleReset = () => {
    setFormData({ ...EMPTY_EMERGENCY_FORM })
    const userStorageKey = user ? `kalasag_emergency_profile_${user.id}` : STORAGE_KEY
    localStorage.removeItem(userStorageKey)
    setShowQR(false)
    setIsEditing(false)
    setErrors({})
    setConfirmedStreetAddress('')
    setAddressSuggestions([])
    setAddressSearchStatus('idle')
  }

  const handleDownload = () => {
    const canvas = qrRef.current?.querySelector('canvas')
    if (!canvas) return
    const link = document.createElement('a')
    link.download = `KALASAG_EmergencyID_${fullNameDisplay.replace(/\s+/g, '_')}.png`
    link.href = canvas.toDataURL('image/png')
    link.click()
  }

  const qrGenerated = showQR && isComplete
  const addressMenuVisible = addressFocused
    && formData.streetAddress.trim().length >= 3
    && addressSearchStatus !== 'idle'

  return (
    <div className="h-full overflow-y-auto bg-[var(--color-bg-primary)]">
      <div className="max-w-lg mx-auto px-4 py-4 space-y-4 pb-8">
        {/* ── Header ─────────────────────────── */}
        <div className="text-center py-2">
          <h1 className="text-base font-bold text-[var(--color-text-primary)]">Emergency QR ID</h1>
          <p className="text-[11px] text-[var(--color-red-alert)] font-semibold">REQUIRED</p>
        </div>

        {/* ── QR Card ────────────────────────── */}
        {qrGenerated && (
          <div className="emergency-id-surface rounded-xl bg-[var(--color-bg-card)] p-5 text-center space-y-3 animate-scale-in">
            <div className="flex items-center justify-center gap-2 text-xs font-bold text-[var(--color-teal)] uppercase tracking-widest">
              <Shield size={12} />
              KALASAG Emergency ID
            </div>
            <p className="font-bold text-lg text-[var(--color-text-primary)]">{fullNameDisplay}</p>
            <div className="flex items-center justify-center gap-3 text-xs text-[var(--color-text-secondary)]">
              <span className="px-2 py-1 rounded-md bg-[var(--color-red-alert)]/10 font-bold text-[var(--color-red-alert)] shadow-[var(--shadow-sm)]">
                {formData.bloodType || '?'} Blood
              </span>
              {formData.contactNumber && (
                <span className="text-[var(--color-text-muted)]">{contactNameDisplay}</span>
              )}
            </div>

            <div ref={qrRef} className="flex justify-center py-2">
              <div className="p-3 bg-white rounded-xl">
                <QRCodeCanvas
                  value={qrTextString}
                  size={180}
                  level="H"
                  marginSize={0}
                />
              </div>
            </div>

            <p className="text-[10px] text-[var(--color-text-muted)]">Scan to access emergency medical info</p>

            <div className="flex gap-2 justify-center">
              <button
                type="button"
                onClick={() => { setShowQR(false); setIsEditing(true); }}
                className="emergency-id-control flex items-center gap-2 px-4 py-2 rounded-lg text-[var(--color-text-secondary)] text-xs font-medium transition-all active:scale-[0.97]"
              >
                Edit Info
              </button>
              <button
                type="button"
                onClick={handleDownload}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-teal)]/10 text-[var(--color-teal)] text-xs font-medium shadow-[var(--shadow-control)] hover:bg-[var(--color-teal)]/20 hover:shadow-[var(--shadow-control-hover)] transition-all active:scale-[0.97]"
              >
                <Download size={13} />
                Save QR Image
              </button>
            </div>
            {/* ── Proceed Button ────────────────── */}
            {onSaved && (
              <button
                type="button"
                onClick={() => onSaved?.()}
                className="flex items-center justify-center gap-2 w-full mt-3 py-3 rounded-xl text-white text-sm font-bold transition-all duration-200 active:scale-[0.98] shadow-lg hover:brightness-110"
                style={{ background: 'var(--color-orange)' }}
              >
                <LogIn size={16} />
                Proceed to App
              </button>
            )}
          </div>
        )}

        {/* ── Form (hidden after QR is generated) ── */}
        {!qrGenerated && (
          <form className="space-y-4" noValidate onSubmit={e => { e.preventDefault(); handleSave(); }}>
        <div className="space-y-4">

          {/* Personal Info */}
          <section className="emergency-id-surface rounded-xl bg-[var(--color-bg-card)] px-4 py-4 space-y-3">
            <p className="text-[10px] font-bold text-[var(--color-text-muted)] uppercase tracking-widest flex items-center gap-2">
              <User size={11} className="text-[var(--color-blue-info)]" /> Personal Information
            </p>
            <Field label="First Name *" placeholder="JUAN" error={errors.firstName}>
              <input type="text" value={formData.firstName}
                onChange={e => handleCapitalizedChange('firstName', e.target.value)} />
            </Field>
            <Field label="Middle Name" placeholder="SANTOS">
              <input type="text" value={formData.middleName}
                onChange={e => handleCapitalizedChange('middleName', e.target.value)} />
            </Field>
            <Field label="Last Name *" placeholder="DELA CRUZ" error={errors.lastName}>
              <input type="text" value={formData.lastName}
                onChange={e => handleCapitalizedChange('lastName', e.target.value)} />
            </Field>
            <Field label="Name Extension (Jr, III, etc.) — put N/A if none" placeholder="N/A">
              <input type="text" value={formData.nameExtension}
                onChange={e => handleCapitalizedChange('nameExtension', e.target.value)} />
            </Field>
            <div>
              <label className={`block text-xs mb-1.5 ${errors.bloodType ? 'text-[var(--color-red-alert)]' : 'text-[var(--color-text-muted)]'}`}>
                Blood Type *
              </label>
              <div className={`flex flex-wrap gap-1.5 p-2 rounded-lg transition-all ${errors.bloodType ? 'bg-[var(--color-red-alert)]/5 shadow-[0_0_0_2px_rgb(229_62_62/0.42)]' : ''}`}>
                {BLOOD_TYPES.map(bt => (
                  <button key={bt} type="button"
                    onClick={() => { handleChange('bloodType', bt); if (errors.bloodType) setErrors(e => { const n = { ...e }; delete n.bloodType; return n }) }}
                    data-selected={formData.bloodType === bt}
                    className={`emergency-id-chip px-2.5 py-1 rounded-md text-xs font-bold transition-all duration-150 ${
                      formData.bloodType === bt
                        ? 'bg-[var(--color-red-alert)] text-white'
                        : 'bg-[var(--color-bg-elevated)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                    }`}
                  >{bt}</button>
                ))}
              </div>
            </div>
          </section>

          {/* Medical Info */}
          <section className="emergency-id-surface rounded-xl bg-[var(--color-bg-card)] px-4 py-4 space-y-3">
            <p className="text-[10px] font-bold text-[var(--color-text-muted)] uppercase tracking-widest flex items-center gap-2">
              <Heart size={11} className="text-[var(--color-red-alert)]" /> Medical Information
            </p>
            <Field label="Allergies *" placeholder="PENICILLIN, SHELLFISH, NONE" error={errors.allergies}>
              <input type="text" value={formData.allergies}
                onChange={e => handleCapitalizedChange('allergies', e.target.value)} />
            </Field>
            <Field label="Active Medications *" placeholder="METFORMIN 500MG, NONE" error={errors.medications}>
              <input type="text" value={formData.medications}
                onChange={e => handleCapitalizedChange('medications', e.target.value)} />
            </Field>
            <Field label="Medical Conditions *" placeholder="ASTHMA, DIABETES, NONE" error={errors.conditions}>
              <input type="text" value={formData.conditions}
                onChange={e => handleCapitalizedChange('conditions', e.target.value)} />
            </Field>
          </section>

          {/* Emergency Contact */}
          <section className="emergency-id-surface rounded-xl bg-[var(--color-bg-card)] px-4 py-4 space-y-3">
            <p className="text-[10px] font-bold text-[var(--color-text-muted)] uppercase tracking-widest flex items-center gap-2">
              <Phone size={11} className="text-[var(--color-green-safe)]" /> Emergency Contact
            </p>
            <Field label="First Name *" placeholder="MARIA" error={errors.contactFirstName}>
              <input type="text" value={formData.contactFirstName} maxLength={80}
                autoComplete="section-emergency-contact given-name"
                onChange={e => handleCapitalizedChange('contactFirstName', e.target.value)} />
            </Field>
            <Field label="Middle Name" placeholder="SANTOS">
              <input type="text" value={formData.contactMiddleName} maxLength={80}
                autoComplete="section-emergency-contact additional-name"
                onChange={e => handleCapitalizedChange('contactMiddleName', e.target.value)} />
            </Field>
            <Field label="Last Name *" placeholder="DELA CRUZ" error={errors.contactLastName}>
              <input type="text" value={formData.contactLastName} maxLength={80}
                autoComplete="section-emergency-contact family-name"
                onChange={e => handleCapitalizedChange('contactLastName', e.target.value)} />
            </Field>

            <div ref={addressContainerRef} className="relative">
              <label htmlFor={streetAddressInputId} className={`block text-xs mb-1.5 ${errors.streetAddress ? 'text-[var(--color-red-alert)]' : 'text-[var(--color-text-muted)]'}`}>
                Street Address *
              </label>
              <div className="relative">
                <MapPin size={15} aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
                <input
                  ref={addressInputRef}
                  id={streetAddressInputId}
                  type="text"
                  value={formData.streetAddress}
                  maxLength={180}
                  autoComplete="section-emergency-contact street-address"
                  placeholder="HOUSE NO., BUILDING, STREET"
                  role="combobox"
                  aria-autocomplete="list"
                  aria-expanded={addressMenuVisible}
                  aria-controls={addressSuggestions.length ? addressListId : undefined}
                  aria-activedescendant={addressMenuVisible && addressSuggestions.length ? `${addressListId}-${activeAddressIndex}` : undefined}
                  aria-invalid={Boolean(errors.streetAddress)}
                  aria-describedby={errors.streetAddress ? streetAddressErrorId : undefined}
                  className={`emergency-id-input w-full rounded-lg py-2 pl-9 pr-9 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] outline-none ${errors.streetAddress ? 'emergency-id-input--error' : ''}`}
                  onFocus={() => setAddressFocused(true)}
                  onChange={event => {
                    setConfirmedStreetAddress('')
                    handleChange('streetAddress', event.target.value)
                  }}
                  onKeyDown={handleAddressKeyDown}
                />
                {addressSearchStatus === 'loading' && (
                  <LoaderCircle size={15} aria-label="Searching addresses"
                    className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-[var(--color-teal)]" />
                )}
              </div>
              {errors.streetAddress && (
                <p id={streetAddressErrorId} className="mt-1 text-[11px] text-[var(--color-red-alert)]">{errors.streetAddress}</p>
              )}

              {addressMenuVisible && (
                <div data-state="open" data-side="bottom" className="custom-dropdown-content absolute inset-x-0 top-full z-40 mt-2 max-h-64 overflow-y-auto rounded-[var(--radius-lg)] bg-[var(--panel)]">
                  {addressSearchStatus === 'loading' && (
                    <div role="status" className="px-3 py-3 text-xs text-[var(--color-text-muted)]">Searching Philippine addresses...</div>
                  )}
                  {addressSearchStatus === 'empty' && (
                    <div role="status" className="px-3 py-3 text-xs text-[var(--color-text-muted)]">No matching Philippine addresses found.</div>
                  )}
                  {addressSearchStatus === 'error' && (
                    <div role="status" className="px-3 py-3 text-xs text-[var(--color-red-alert)]">{addressSearchError}</div>
                  )}
                  {addressSuggestions.length > 0 && (
                    <div id={addressListId} role="listbox" className="space-y-1 p-1.5">
                      {addressSuggestions.map((suggestion, index) => (
                        <button
                          key={suggestion.id}
                          id={`${addressListId}-${index}`}
                          type="button"
                          role="option"
                          aria-selected={activeAddressIndex === index}
                          data-active={activeAddressIndex === index}
                          onPointerDown={event => event.preventDefault()}
                          onMouseEnter={() => setActiveAddressIndex(index)}
                          onClick={() => selectAddressSuggestion(suggestion)}
                          className="custom-dropdown-item block min-h-11 w-full rounded-[var(--radius-md)] bg-transparent px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                        >
                          <span className="block text-xs font-semibold text-[var(--color-text-primary)]">{suggestion.streetAddress}</span>
                          <span className="mt-0.5 block text-[11px] text-[var(--color-text-muted)]">{suggestion.label}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {addressSearchStatus === 'ready' && (
                    <div className="px-3 py-1.5 text-[10px] text-[var(--color-text-muted)]">
                      Search by{' '}
                      <a href="https://photon.komoot.io" target="_blank" rel="noreferrer" className="underline">Photon</a>
                      . Data ©{' '}
                      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" className="underline">OpenStreetMap contributors</a>.
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_8rem]">
              <Field label="City *" placeholder="VALENZUELA" error={errors.city}>
                <input type="text" value={formData.city} maxLength={80}
                  autoComplete="section-emergency-contact address-level2"
                  onChange={e => handleCapitalizedChange('city', e.target.value)} />
              </Field>
              <Field label="Postal Code *" placeholder="1441" error={errors.postalCode}>
                <input type="text" value={formData.postalCode} inputMode="numeric"
                  autoComplete="section-emergency-contact postal-code" minLength={4} maxLength={4} pattern="[0-9]{4}"
                  onChange={e => handleNumberChange('postalCode', e.target.value, 4)} />
              </Field>
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <label htmlFor={contactRelationId} className={`block text-xs mb-1.5 ${errors.contactRelation ? 'text-[var(--color-red-alert)]' : 'text-[var(--color-text-muted)]'}`}>
                  Relationship *
                </label>
                <Select id={contactRelationId} value={formData.contactRelation || undefined}
                  options={RELATION_OPTIONS.map(option => ({ value: option, label: option }))}
                  placeholder="Select relationship"
                  onValueChange={value => { handleChange('contactRelation', value); if (errors.contactRelation) setErrors(prev => { const n = { ...prev }; delete n.contactRelation; return n }) }}
                  required
                  tone="teal"
                  aria-invalid={Boolean(errors.contactRelation)}
                  aria-describedby={errors.contactRelation ? contactRelationErrorId : undefined}
                  className="w-full"
                />
                {errors.contactRelation && (
                  <p id={contactRelationErrorId} className="mt-1 text-[11px] text-[var(--color-red-alert)]">{errors.contactRelation}</p>
                )}
              </div>
              <Field label="Mobile Number *" placeholder="09XXXXXXXXX" error={errors.contactNumber}>
                <input type="tel" value={formData.contactNumber} inputMode="numeric"
                  autoComplete="section-emergency-contact tel" minLength={11} maxLength={11} pattern="[0-9]{11}"
                  onChange={e => handleNumberChange('contactNumber', e.target.value, 11)} />
              </Field>
            </div>
          </section>
        </div>

        {saveError && (
          <div className="text-xs text-[var(--color-red-alert)] bg-[var(--color-red-alert)]/10 rounded-lg px-3.5 py-2.5 shadow-[var(--shadow-control)] animate-shake">
            {saveError}
          </div>
        )}

        {/* ── Action buttons ─────────────────── */}
        <div className="flex items-stretch gap-3 pt-1">
          <button type="button" onClick={handleReset}
            className="emergency-id-control flex min-h-11 items-center gap-2 px-4 py-2.5 rounded-lg text-[var(--color-text-muted)] text-sm hover:text-[var(--color-text-secondary)]"
          >
            <RotateCcw size={14} />
            Reset
          </button>
          <button type="submit" disabled={saving}
            className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-bold text-white shadow-[0_6px_18px_rgb(20_184_166/0.24)] transition-all duration-200 hover:-translate-y-px hover:shadow-[0_8px_22px_rgb(20_184_166/0.3)] active:translate-y-0 active:scale-[0.98] disabled:cursor-wait disabled:opacity-70"
            style={{ background: 'var(--color-teal)' }}
          >
            {saving ? 'Saving...' : saved ? '✓ Saved!' : 'Save'}
          </button>
        </div>
          </form>
        )}
      </div>
    </div>
  )
}

// ── Field wrapper ────────────────────────────────────────────────────
function Field({ label, placeholder, children, error }: {
  label: string; placeholder: string
  children: React.ReactElement<Record<string, unknown>>
  error?: string
}) {
  const fieldId = useId()
  const errorId = useId()
  const inputId = typeof children.props.id === 'string' ? children.props.id : fieldId
  return (
    <div>
      <label htmlFor={inputId} className={`block text-xs mb-1.5 ${error ? 'text-[var(--color-red-alert)]' : 'text-[var(--color-text-muted)]'}`}>
        {label}
      </label>
      {React.cloneElement(children, {
        id: inputId,
        placeholder,
        'aria-invalid': Boolean(error),
        'aria-describedby': error ? errorId : undefined,
        className: `emergency-id-input w-full rounded-lg px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] outline-none ${error ? 'emergency-id-input--error' : ''}`,
      })}
      {error && <p id={errorId} className="mt-1 text-[11px] text-[var(--color-red-alert)]">{error}</p>}
    </div>
  )
}
