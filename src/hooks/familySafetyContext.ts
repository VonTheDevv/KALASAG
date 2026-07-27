import { createContext, useContext } from 'react'
import type { FamilyAlert } from '../lib/familySafety'

export type FamilySafetyContextValue = {
  refreshAlerts: () => Promise<void>
  subscribeToFamilyUpdates: (familyId: string, listener: () => void) => () => void
  activeAlert: FamilyAlert | null
  notificationReady: boolean
  notificationReason: string | null
}

export const FamilySafetyContext = createContext<FamilySafetyContextValue | null>(null)

export function useFamilySafety() {
  const context = useContext(FamilySafetyContext)
  if (!context) throw new Error('useFamilySafety must be used inside FamilySafetyProvider.')
  return context
}
