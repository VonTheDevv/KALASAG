import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { Skeleton } from './ui/primitives'

export default function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div role="status" aria-label="Checking session" className="flex h-full bg-[var(--surface)]">
        <aside className="hidden w-64 shrink-0 border-r border-[var(--border)] bg-[var(--panel)] p-5 lg:block">
          <div className="mb-8 flex items-center gap-3">
            <Skeleton variant="circle" className="h-9 w-9" />
            <div className="flex-1 space-y-2">
              <Skeleton variant="line" className="w-28" />
              <Skeleton variant="line" className="h-2 w-20" />
            </div>
          </div>
          <div className="space-y-3">
            {Array.from({ length: 7 }).map((_, index) => (
              <Skeleton key={index} variant="block" className="h-10 w-full" />
            ))}
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-14 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 lg:hidden">
            <Skeleton variant="circle" className="h-7 w-7" />
            <Skeleton variant="line" className="w-28" />
          </div>
          <main className="flex-1 p-4 sm:p-6">
            <div className="mx-auto max-w-5xl space-y-5">
              <Skeleton variant="line" className="h-5 w-40" />
              <Skeleton variant="block" className="h-[40vh] min-h-64 w-full" />
              <div className="grid gap-4 sm:grid-cols-3">
                <Skeleton variant="block" className="h-28" />
                <Skeleton variant="block" className="h-28" />
                <Skeleton variant="block" className="h-28" />
              </div>
            </div>
          </main>
        </div>
        <span className="sr-only">Checking session</span>
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/login" replace />
  }

  return <>{children}</>
}
