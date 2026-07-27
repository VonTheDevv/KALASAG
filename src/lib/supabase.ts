import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY environment variables.\n' +
    'Copy .env.example to .env and fill in your Supabase project credentials.'
  )
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storage: window.localStorage,
  },
})

// ==============================================================================
// Types
// ==============================================================================

export interface UserProfile {
  id: string
  email: string | null
  created_at: string
  updated_at: string
}

export interface EmergencyProfile {
  id: string
  first_name: string
  middle_name: string
  last_name: string
  name_extension: string
  blood_type: string
  allergies: string
  medications: string
  conditions: string
  contact_name: string
  contact_first_name: string
  contact_middle_name: string
  contact_last_name: string
  contact_number: string
  contact_relation: string
  street_address: string
  city: string
  postal_code: string
  updated_at: string
}

export interface QRCode {
  id: string
  user_id: string
  qr_data: Record<string, unknown>
  generated_at: string
}

// ==============================================================================
// User Profile CRUD
// ==============================================================================

export async function fetchUserProfile(userId: string): Promise<UserProfile | null> {
  const { data, error } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('id', userId)
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null
    console.error('fetchUserProfile error:', error.message)
    return null
  }
  return data as UserProfile
}

// ==============================================================================
// Emergency Profile CRUD
// ==============================================================================

export async function fetchEmergencyProfile(userId: string): Promise<EmergencyProfile | null> {
  const { data, error } = await supabase
    .from('emergency_profiles')
    .select('*')
    .eq('id', userId)
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null
    console.error('fetchEmergencyProfile error:', error.message)
    return null
  }
  return data as EmergencyProfile
}

export async function upsertEmergencyProfile(
  userId: string,
  profile: Omit<EmergencyProfile, 'id' | 'updated_at'>
): Promise<{ success: boolean; error?: string }> {
  const { error } = await supabase
    .from('emergency_profiles')
    .upsert({
      id: userId,
      first_name: profile.first_name,
      middle_name: profile.middle_name,
      last_name: profile.last_name,
      name_extension: profile.name_extension,
      blood_type: profile.blood_type,
      allergies: profile.allergies,
      medications: profile.medications,
      conditions: profile.conditions,
      contact_name: profile.contact_name,
      contact_first_name: profile.contact_first_name,
      contact_middle_name: profile.contact_middle_name,
      contact_last_name: profile.contact_last_name,
      contact_number: profile.contact_number,
      contact_relation: profile.contact_relation,
      street_address: profile.street_address,
      city: profile.city,
      postal_code: profile.postal_code,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' })

  if (error) {
    console.error('upsertEmergencyProfile error:', error.message)
    return { success: false, error: error.message }
  }

  return { success: true }
}

// ==============================================================================
// QR Code CRUD
// ==============================================================================

export async function logQRCode(userId: string, qrData: Record<string, unknown>): Promise<void> {
  const { error } = await supabase
    .from('qr_codes')
    .insert({ user_id: userId, qr_data: qrData })

  if (error) {
    console.error('logQRCode error:', error.message)
  }
}

// ==============================================================================
// Additional App Data CRUD
// ==============================================================================

export interface EmergencyHotline {
  id: string
  category_id: string
  category_label: string
  category_color: string
  agency_id: string
  name: string
  number: string
  alt: string | null
  available: string
  description: string | null
}

export interface Volcano {
  id: string
  name: string
  lat: number
  lng: number
  alert_level: number
  status: string
  details: string
  updated_at: string
}

export async function fetchEmergencyHotlines(): Promise<EmergencyHotline[]> {
  const { data, error } = await supabase
    .from('emergency_hotlines')
    .select('*')
  if (error) {
    console.error('fetchEmergencyHotlines error:', error.message)
    return []
  }
  return data || []
}

export async function fetchVolcanoes(): Promise<Volcano[]> {
  const { data, error } = await supabase
    .from('volcanoes')
    .select('*')
  if (error) {
    console.error('fetchVolcanoes error:', error.message)
    return []
  }
  return data || []
}

export async function fetchUserPreferences(userId: string): Promise<Record<string, boolean> | null> {
  const { data, error } = await supabase
    .from('user_preferences')
    .select('settings')
    .eq('user_id', userId)
    .single()
  if (error) {
    if (error.code !== 'PGRST116') {
      console.error('fetchUserPreferences error:', error.message)
    }
    return null
  }
  return data?.settings as Record<string, boolean>
}

export async function upsertUserPreferences(userId: string, settings: Record<string, boolean>): Promise<void> {
  const { error } = await supabase
    .from('user_preferences')
    .upsert({
      user_id: userId,
      settings,
      updated_at: new Date().toISOString()
    })
  if (error) {
    console.error('upsertUserPreferences error:', error.message)
  }
}


