import type { EmergencyProfile } from './supabase'

export interface EmergencyFormData {
  firstName: string
  middleName: string
  lastName: string
  nameExtension: string
  bloodType: string
  allergies: string
  medications: string
  conditions: string
  contactFirstName: string
  contactMiddleName: string
  contactLastName: string
  contactNumber: string
  contactRelation: string
  streetAddress: string
  city: string
  postalCode: string
}

export type EmergencyFormErrors = Partial<Record<keyof EmergencyFormData, string>>

export const EMPTY_EMERGENCY_FORM: EmergencyFormData = {
  firstName: '',
  middleName: '',
  lastName: '',
  nameExtension: '',
  bloodType: '',
  allergies: '',
  medications: '',
  conditions: '',
  contactFirstName: '',
  contactMiddleName: '',
  contactLastName: '',
  contactNumber: '',
  contactRelation: '',
  streetAddress: '',
  city: '',
  postalCode: '',
}

const stringValue = (value: unknown) => typeof value === 'string' ? value : ''

export function splitLegacyName(value: unknown) {
  const parts = stringValue(value).trim().split(/\s+/).filter(Boolean)
  return {
    firstName: parts[0] || '',
    middleName: parts.length >= 3 ? parts.slice(1, -1).join(' ') : '',
    lastName: parts.length >= 2 ? parts[parts.length - 1] : '',
  }
}

export function emergencyContactName(form: EmergencyFormData) {
  return [form.contactFirstName, form.contactMiddleName, form.contactLastName]
    .map(value => value.trim())
    .filter(Boolean)
    .join(' ')
}

export function emergencyContactAddress(form: EmergencyFormData) {
  return [form.streetAddress, form.city, form.postalCode]
    .map(value => value.trim())
    .filter(Boolean)
    .join(', ')
}

export const isValidMobileNumber = (value: string) => /^\d{11}$/.test(value)
export const isValidPostalCode = (value: string) => /^\d{4}$/.test(value)

export function validateEmergencyForm(form: EmergencyFormData): EmergencyFormErrors {
  const errors: EmergencyFormErrors = {}
  if (!form.firstName.trim()) errors.firstName = 'First name is required.'
  if (!form.lastName.trim()) errors.lastName = 'Last name is required.'
  if (!form.bloodType) errors.bloodType = 'Blood type is required.'
  if (!form.allergies.trim()) errors.allergies = 'Allergies are required. Enter NONE if there are none.'
  if (!form.medications.trim()) errors.medications = 'Active medications are required. Enter NONE if there are none.'
  if (!form.conditions.trim()) errors.conditions = 'Medical conditions are required. Enter NONE if there are none.'
  if (!form.contactFirstName.trim()) errors.contactFirstName = 'Contact first name is required.'
  if (!form.contactLastName.trim()) errors.contactLastName = 'Contact last name is required.'
  if (!form.contactRelation) errors.contactRelation = 'Relationship is required.'
  if (!isValidMobileNumber(form.contactNumber)) errors.contactNumber = 'Enter exactly 11 digits.'
  if (!form.streetAddress.trim()) errors.streetAddress = 'Street address is required.'
  if (!form.city.trim()) errors.city = 'City is required.'
  if (!isValidPostalCode(form.postalCode)) errors.postalCode = 'Enter a 4-digit Philippine postal code.'
  return errors
}

export function isEmergencyFormComplete(form: EmergencyFormData) {
  return Object.keys(validateEmergencyForm(form)).length === 0
}

export function cloudToEmergencyForm(cloud: EmergencyProfile): EmergencyFormData {
  const legacyContact = splitLegacyName(cloud.contact_name)
  return {
    firstName: cloud.first_name || '',
    middleName: cloud.middle_name || '',
    lastName: cloud.last_name || '',
    nameExtension: cloud.name_extension || '',
    bloodType: cloud.blood_type || '',
    allergies: cloud.allergies || '',
    medications: cloud.medications || '',
    conditions: cloud.conditions || '',
    contactFirstName: cloud.contact_first_name || legacyContact.firstName,
    contactMiddleName: cloud.contact_middle_name || legacyContact.middleName,
    contactLastName: cloud.contact_last_name || legacyContact.lastName,
    contactNumber: cloud.contact_number || '',
    contactRelation: cloud.contact_relation || '',
    streetAddress: cloud.street_address || '',
    city: cloud.city || '',
    postalCode: cloud.postal_code || '',
  }
}

export function migrateEmergencyForm(legacy: Record<string, unknown>): EmergencyFormData {
  const personal = typeof legacy.firstName === 'string'
    ? {
        firstName: stringValue(legacy.firstName),
        middleName: stringValue(legacy.middleName),
        lastName: stringValue(legacy.lastName),
      }
    : splitLegacyName(legacy.fullName)
  const legacyContact = splitLegacyName(legacy.contactName)

  return {
    ...personal,
    nameExtension: stringValue(legacy.nameExtension),
    bloodType: stringValue(legacy.bloodType),
    allergies: stringValue(legacy.allergies),
    medications: stringValue(legacy.medications),
    conditions: stringValue(legacy.conditions),
    contactFirstName: stringValue(legacy.contactFirstName) || legacyContact.firstName,
    contactMiddleName: stringValue(legacy.contactMiddleName) || legacyContact.middleName,
    contactLastName: stringValue(legacy.contactLastName) || legacyContact.lastName,
    contactNumber: stringValue(legacy.contactNumber),
    contactRelation: stringValue(legacy.contactRelation),
    streetAddress: stringValue(legacy.streetAddress),
    city: stringValue(legacy.city),
    postalCode: stringValue(legacy.postalCode),
  }
}
