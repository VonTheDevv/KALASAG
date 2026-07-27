import { supabase } from './supabase'

export async function requestPasswordReset(email: string): Promise<{ success: boolean; error?: string }> {
  const redirectTo = `${window.location.origin}/reset-password`
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo })
  return error ? { success: false, error: error.message } : { success: true }
}

export async function updateRecoveredPassword(password: string): Promise<{ success: boolean; error?: string }> {
  const { data: { user }, error: userError } = await supabase.auth.getUser()
  if (userError || !user) return { success: false, error: 'This recovery link is invalid or has expired. Request a new one.' }

  const { error } = await supabase.auth.updateUser({ password })
  return error ? { success: false, error: error.message } : { success: true }
}
