import { useState, type ReactNode } from 'react'
import type { TabId } from '../App'
import {
  Car,
  Cloud,
  CloudLightning,
  Grid3X3,
  LogOut,
  Map,
  Moon,
  Mountain,
  Newspaper,
  Phone,
  QrCode,
  Sun,
  User,
  Users,
  Wifi,
  WifiOff,
  Waves,
  Zap,
  X,
} from 'lucide-react'
import { useOnlineStatus } from '../hooks/useOnlineStatus'
import { useAuth } from '../hooks/useAuth'
import { useTheme } from '../hooks/useTheme'
import { Badge, IconButton } from './ui/primitives'
import { cx } from '../lib/cx'

interface LayoutProps {
  children: ReactNode
  activeTab: TabId
  setActiveTab: (tab: TabId) => void
  isTabLoading?: boolean
}

type NavItem = { id: TabId; label: string; icon: typeof Map; shortLabel: string }

const NAV_ITEMS: NavItem[] = [
  { id: 'map', label: 'Live Hazard Map', shortLabel: 'Map', icon: Map },
  { id: 'news', label: 'News', shortLabel: 'News', icon: Newspaper },
  { id: 'family', label: 'Family Hub', shortLabel: 'Family', icon: Users },
  { id: 'hotlines', label: 'Emergency Hotlines', shortLabel: 'Hotlines', icon: Phone },
  { id: 'qrid', label: 'Emergency QR ID', shortLabel: 'QR ID', icon: QrCode },
]

const HAZARD_ITEMS: NavItem[] = [
  { id: 'earthquake', label: 'Earthquake Info', shortLabel: 'Quakes', icon: Zap },
  { id: 'typhoon', label: 'Typhoon Tracker', shortLabel: 'Typhoon', icon: CloudLightning },
  { id: 'weather', label: 'Weather Forecast', shortLabel: 'Weather', icon: Cloud },
  { id: 'volcano', label: 'Active Volcanoes', shortLabel: 'Volcano', icon: Mountain },
  { id: 'traffic', label: 'Road Traffic', shortLabel: 'Traffic', icon: Car },
  { id: 'dams', label: 'Dams & Water', shortLabel: 'Dams', icon: Waves },
]

const ALL_NAV_ITEMS = [...NAV_ITEMS, ...HAZARD_ITEMS]
const PRIMARY_MOBILE_ITEMS = NAV_ITEMS.filter(item => item.id !== 'qrid')
const MOBILE_TOOL_ITEMS = [NAV_ITEMS.find(item => item.id === 'qrid')!, ...HAZARD_ITEMS]

function DesktopNavItem({
  item,
  activeTab,
  disabled,
  onSelect,
}: {
  item: NavItem
  activeTab: TabId
  disabled: boolean
  onSelect: (tab: TabId) => void
}) {
  const isActive = activeTab === item.id
  const Icon = item.icon

  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      disabled={disabled}
      aria-current={isActive ? 'page' : undefined}
      className={cx(
        'ui-control relative flex w-full items-center gap-3 rounded-[var(--radius-md)] px-3 py-2.5 text-left text-sm font-medium',
        isActive
          ? 'bg-[var(--action-soft)] text-[var(--action)]'
          : 'text-[var(--text-soft)] hover:bg-[var(--panel-elevated)] hover:text-[var(--text)]',
      )}
    >
      {isActive && <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-[var(--action)]" />}
      <Icon size={17} strokeWidth={isActive ? 2.2 : 1.8} aria-hidden="true" />
      <span>{item.label}</span>
    </button>
  )
}

function MobileNavItem({
  item,
  active,
  disabled,
  onSelect,
}: {
  item: NavItem
  active: boolean
  disabled: boolean
  onSelect: (tab: TabId) => void
}) {
  const Icon = item.icon

  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      disabled={disabled}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'ui-control relative flex min-w-0 flex-1 flex-col items-center justify-center gap-1 px-1 py-2 text-[10px] font-medium',
        active ? 'text-[var(--action)]' : 'text-[var(--muted)] hover:text-[var(--text)]',
      )}
    >
      {active && <span className="absolute top-0 h-0.5 w-7 rounded-b-full bg-[var(--action)]" />}
      <span className={cx('grid h-7 w-8 place-items-center rounded-md', active && 'bg-[var(--action-soft)]')}>
        <Icon size={19} strokeWidth={active ? 2.2 : 1.8} aria-hidden="true" />
      </span>
      <span className="max-w-full truncate">{item.shortLabel}</span>
    </button>
  )
}

export default function Layout({ children, activeTab, setActiveTab, isTabLoading = false }: LayoutProps) {
  const isOnline = useOnlineStatus()
  const { user, signOut } = useAuth()
  const { resolvedTheme, toggleTheme } = useTheme()
  const [toolsOpen, setToolsOpen] = useState(false)
  const isToolActive = MOBILE_TOOL_ITEMS.some(item => item.id === activeTab) || activeTab === 'hazards'

  const selectMobileTool = (tab: TabId) => {
    setToolsOpen(false)
    setActiveTab(tab)
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[var(--surface)] text-[var(--text)] lg:flex-row">
      <header className="safe-area-header z-40 flex shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--panel)] px-4 lg:hidden">
        <div className="flex min-w-0 items-center gap-2.5">
          <img src="/favicon.png" alt="" className="h-8 w-8 shrink-0 object-contain" />
          <p className="truncate text-xl font-extrabold tracking-wide text-[var(--text)]">KALASAG</p>
        </div>

        <div className="flex items-center gap-2">
          <Badge tone={isOnline ? 'success' : 'warning'} className="hidden min-[360px]:inline-flex">
            {isOnline ? <Wifi size={11} aria-hidden="true" /> : <WifiOff size={11} aria-hidden="true" />}
            {isOnline ? 'Online' : 'Offline'}
          </Badge>
          <IconButton
            size="sm"
            variant="secondary"
            onClick={toggleTheme}
            aria-label={`Switch to ${resolvedTheme === 'dark' ? 'light' : 'dark'} mode`}
            title={`Switch to ${resolvedTheme === 'dark' ? 'light' : 'dark'} mode`}
          >
            {resolvedTheme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </IconButton>
          {user && (
            <IconButton size="sm" variant="secondary" onClick={() => signOut()} aria-label="Sign out" title="Sign out">
              <LogOut size={16} />
            </IconButton>
          )}
        </div>
      </header>

      <aside className="z-40 hidden w-64 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--panel)] lg:flex">
        <div className="flex h-[72px] items-center gap-3 border-b border-[var(--border)] px-5">
          <div className="grid h-11 w-11 place-items-center rounded-[var(--radius-md)] bg-[var(--action-soft)]">
            <img src="/favicon.png" alt="" className="h-9 w-9 object-contain" />
          </div>
          <p className="text-2xl font-extrabold tracking-wide text-[var(--text)]">KALASAG</p>
        </div>

        {user && (
          <div className="border-b border-[var(--border)] p-4">
            <div className="flex items-center gap-3 rounded-[var(--radius-md)] bg-[var(--surface-alt)] p-3">
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--action-soft)] text-[var(--action)]">
                <User size={16} aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-semibold text-[var(--text)]">{user.email}</p>
                <p className="mt-0.5 text-[10px] text-[var(--muted)]">Authenticated account</p>
              </div>
              <IconButton size="sm" variant="ghost" onClick={() => signOut()} aria-label="Sign out" title="Sign out">
                <LogOut size={15} />
              </IconButton>
            </div>
          </div>
        )}

        <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-4" aria-label="Application navigation">
          <div className="space-y-1">
            {ALL_NAV_ITEMS.map(item => (
              <DesktopNavItem
                key={item.id}
                item={item}
                activeTab={activeTab}
                disabled={isTabLoading}
                onSelect={setActiveTab}
              />
            ))}
          </div>
        </nav>

        <div className="space-y-3 border-t border-[var(--border)] p-4">
          <button
            type="button"
            onClick={toggleTheme}
            className="ui-control flex w-full items-center justify-between rounded-[var(--radius-md)] px-3 py-2.5 text-left hover:bg-[var(--panel-elevated)]"
          >
            <span>
              <span className="block text-xs font-semibold text-[var(--text)]">Appearance</span>
              <span className="block text-[10px] capitalize text-[var(--muted)]">{resolvedTheme} mode</span>
            </span>
            {resolvedTheme === 'dark' ? <Sun size={17} className="text-[var(--muted)]" /> : <Moon size={17} className="text-[var(--muted)]" />}
          </button>
          <div className="flex items-center justify-between px-3 text-[10px] text-[var(--muted)]">
            <span>Network connection</span>
            <span className={cx('inline-flex items-center gap-1.5 font-semibold', isOnline ? 'text-[var(--success)]' : 'text-[var(--warning)]')}>
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
              {isOnline ? 'Online' : 'Offline'}
            </span>
          </div>
        </div>
      </aside>

      <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-[var(--surface)]">{children}</main>

      {toolsOpen && (
        <div className="fixed inset-0 z-50 bg-black/45 lg:hidden" onClick={() => setToolsOpen(false)}>
          <section
            className="safe-area-pb absolute inset-x-0 bottom-[58px] rounded-t-[var(--radius-lg)] bg-[var(--panel)] p-4 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-label="Application tools"
            onClick={event => event.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <div>
                <p className="text-sm font-bold text-[var(--text)]">Tools</p>
                <p className="text-[10px] text-[var(--muted)]">All safety and monitoring tools</p>
              </div>
              <IconButton variant="ghost" size="sm" onClick={() => setToolsOpen(false)} aria-label="Close tools">
                <X size={18} />
              </IconButton>
            </div>
            <div className="grid grid-cols-2 gap-2 min-[460px]:grid-cols-3">
              {MOBILE_TOOL_ITEMS.map(item => {
                const Icon = item.icon
                const active = activeTab === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    disabled={isTabLoading}
                    onClick={() => selectMobileTool(item.id)}
                    className={cx(
                      'ui-control flex min-h-16 items-center gap-3 rounded-[var(--radius-md)] bg-[var(--surface-alt)] p-3 text-left text-xs font-semibold',
                      active ? 'text-[var(--action)] shadow-[inset_3px_0_0_var(--action)]' : 'text-[var(--text-soft)]',
                    )}
                  >
                    <Icon size={19} aria-hidden="true" />
                    <span>{item.label}</span>
                  </button>
                )
              })}
            </div>
          </section>
        </div>
      )}

      <nav
        className="safe-area-pb z-40 flex shrink-0 border-t border-[var(--border)] bg-[var(--panel)] shadow-[0_-4px_14px_rgb(15_23_42_/_0.04)] lg:hidden"
        aria-label="Mobile application navigation"
      >
        {PRIMARY_MOBILE_ITEMS.map(item => (
          <MobileNavItem
            key={item.id}
            item={item}
            active={activeTab === item.id}
            disabled={isTabLoading}
            onSelect={setActiveTab}
          />
        ))}
        <MobileNavItem
          item={{ id: 'hazards', label: 'Application tools', shortLabel: 'Tools', icon: Grid3X3 }}
          active={isToolActive || toolsOpen}
          disabled={isTabLoading}
          onSelect={() => setToolsOpen(true)}
        />
      </nav>
    </div>
  )
}
