import { Car, ChevronRight, Cloud, CloudLightning, Mountain, Zap } from 'lucide-react'

interface HazardsHubProps {
  onNavigate: (tab: 'earthquake' | 'typhoon' | 'weather' | 'volcano' | 'traffic') => void
}

const CARDS = [
  {
    id: 'earthquake' as const,
    icon: Zap,
    title: 'Earthquake information',
    description: 'Live regional events, magnitudes, depths, distribution, and event map.',
    accentColor: '#f6c90e',
  },
  {
    id: 'typhoon' as const,
    icon: CloudLightning,
    title: 'Typhoon tracker',
    description: 'Active in-zone cyclones, observed history, forecast positions, and event details.',
    accentColor: '#e53e3e',
  },
  {
    id: 'weather' as const,
    icon: Cloud,
    title: 'Weather forecast',
    description: 'Current conditions, seven-day forecast, precipitation, and wind analysis.',
    accentColor: '#3b82f6',
  },
  {
    id: 'volcano' as const,
    icon: Mountain,
    title: 'Volcano status',
    description: 'Published monitored volcano records, alert levels, details, and update times.',
    accentColor: '#ff6b00',
  },
  {
    id: 'traffic' as const,
    icon: Car,
    title: 'Road traffic',
    description: 'TomTom live road flow, reported incidents, delays, and nearby conditions.',
    accentColor: '#10b981',
  },
]

export default function HazardsHub({ onNavigate }: HazardsHubProps) {
  return (
    <div className="h-full overflow-y-auto bg-[var(--surface)]">
      <div className="mx-auto max-w-3xl space-y-8 p-4 pb-8 sm:p-6">
        <header className="pt-3 animate-smooth-slide-up">
          <p className="font-data text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--action)]">Monitoring modules</p>
          <h1 className="mt-2 text-2xl font-extrabold tracking-tight text-[var(--text)] sm:text-3xl">Hazards and conditions</h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-[var(--text-soft)]">Open a module to load its current data, freshness information, and unavailable state.</p>
        </header>

        <div className="grid gap-3 sm:grid-cols-2">
          {CARDS.map(card => {
            const Icon = card.icon
            return (
              <button
                type="button"
                key={card.id}
                onClick={() => onNavigate(card.id)}
                className="ui-control elevated-panel group relative overflow-hidden rounded-[var(--radius-lg)] bg-[var(--panel)] p-4 text-left hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)]"
              >
                <span className="absolute inset-y-0 left-0 w-1" style={{ background: card.accentColor }} aria-hidden="true" />
                <div className="flex items-start gap-3">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[var(--radius-md)]" style={{ color: card.accentColor, background: `${card.accentColor}14` }}>
                    <Icon size={20} aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <h2 className="text-sm font-bold text-[var(--text)]">{card.title}</h2>
                      <ChevronRight size={15} className="shrink-0 text-[var(--muted)] transition-transform duration-150 group-hover:translate-x-0.5" />
                    </div>
                    <p className="mt-1 text-[11px] leading-5 text-[var(--text-soft)]">{card.description}</p>
                  </div>
                </div>
              </button>
            )
          })}
        </div>

        <p className="border-t border-[var(--border)] pt-5 text-center text-[10px] leading-5 text-[var(--muted)]">
          A module reports a live-data failure rather than substituting simulated operational data.
        </p>
      </div>
    </div>
  )
}
