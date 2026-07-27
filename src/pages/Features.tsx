import { useState, type ComponentType } from 'react'
import {
  ChevronDown,
  CloudLightning,
  ContactRound,
  Mountain,
  Plane,
  Ship,
  Waves,
  type LucideProps,
} from 'lucide-react'
import WebsiteLayout from '../components/WebsiteLayout'
import { Panel } from '../components/ui/primitives'
import { cx } from '../lib/cx'
import {
  MARITIME_MONITORING_AVAILABLE,
  MARITIME_MONITORING_NOTICE,
} from '../lib/featureAvailability'

type Icon = ComponentType<LucideProps>

const FEATURES: Array<{ title: string; description: string; icon: Icon; tone: string; unavailable?: boolean }> = [
  {
    title: 'Aviation telemetry',
    description: 'Maps available aircraft state vectors, route context, altitude, speed, and flight-path information across the monitored region.',
    icon: Plane,
    tone: 'text-[var(--action)] bg-[var(--action-soft)]',
  },
  {
    title: 'Maritime tracking',
    description: MARITIME_MONITORING_AVAILABLE
      ? 'Displays available AIS vessel positions, headings, speeds, identities, and navigation context across Philippine waters.'
      : 'Live vessel positions are temporarily disabled while reliable Philippine maritime coverage is unavailable.',
    icon: Ship,
    tone: 'text-[var(--color-teal)] bg-[color-mix(in_srgb,var(--color-teal)_12%,transparent)]',
    unavailable: !MARITIME_MONITORING_AVAILABLE,
  },
  {
    title: 'Volcanic advisories',
    description: 'Presents published volcano alert information and monitored advisory details with clear status and update context.',
    icon: Mountain,
    tone: 'text-[var(--color-orange)] bg-[color-mix(in_srgb,var(--color-orange)_12%,transparent)]',
  },
  {
    title: 'Seismic monitoring',
    description: 'Ingests live earthquake feeds and maps event magnitude, epicenter, depth, age, and regional relevance.',
    icon: Waves,
    tone: 'text-[var(--color-red-alert)] bg-[color-mix(in_srgb,var(--color-red-alert)_12%,transparent)]',
  },
  {
    title: 'Typhoon tracker',
    description: 'Organizes active storm positions, observed trails, forecast context, wind profiles, and PAR relevance when data is available.',
    icon: CloudLightning,
    tone: 'text-[var(--info)] bg-[var(--info-soft)]',
  },
  {
    title: 'Emergency directory',
    description: 'Keeps critical national and regional contact information available in a compact, mobile-first directory.',
    icon: ContactRound,
    tone: 'text-[var(--success)] bg-[var(--success-soft)]',
  },
]

const FAQ = [
  {
    question: 'What remains available when the network is unstable?',
    answer: 'The installed web application can retain its core interface and previously cached static resources. Live layers clearly report when fresh upstream data cannot be reached; they are not replaced with simulated events.',
  },
  {
    question: 'Where do aircraft and vessel positions come from?',
    answer: MARITIME_MONITORING_AVAILABLE
      ? 'Aviation and maritime modules use available live telemetry. Coverage depends on receiver density, credentials, service limits, and whether a current position exists in the monitored area.'
      : 'Aviation uses available live telemetry. Maritime monitoring is temporarily disabled because current live vessel coverage for Philippine waters is unavailable; no simulated vessel positions are substituted.',
  },
  {
    question: 'Does the dashboard generate sample disasters?',
    answer: 'No. Operational layers are intended to show live or published data. When a feed is unavailable, the interface identifies that state rather than inventing a replacement event.',
  },
]

export default function Features() {
  const [openAccordion, setOpenAccordion] = useState<number | null>(0)

  return (
    <WebsiteLayout>
      <section className="bg-[var(--surface)] py-14 sm:py-20">
        <div className="mx-auto max-w-[1200px] px-5 sm:px-6">
          <header className="mx-auto mb-12 max-w-3xl text-center animate-smooth-slide-up">
            <h1 className="text-4xl font-extrabold tracking-[-0.03em] text-[var(--text)] sm:text-5xl">Operational information, organized for action.</h1>
            <p className="mx-auto mt-5 max-w-2xl text-sm leading-7 text-[var(--text-soft)] sm:text-[15px]">
              Every module is designed to make availability, freshness, and meaning easy to understand on desktop and mobile without altering established map symbols.
            </p>
            {!MARITIME_MONITORING_AVAILABLE && (
              <p role="status" className="mx-auto mt-5 w-fit rounded-full bg-[var(--warning-soft)] px-4 py-2 text-xs font-semibold text-[var(--warning)]">
                {MARITIME_MONITORING_NOTICE}
              </p>
            )}
          </header>

          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ title, description, icon: FeatureIcon, tone, unavailable }) => (
              <Panel key={title} className="website-card-hover min-h-52 p-5">
                <div className="mb-7 flex items-start justify-between gap-3">
                  <span className={cx('grid h-10 w-10 place-items-center rounded-[var(--radius-md)]', tone)}>
                    <FeatureIcon size={20} aria-hidden="true" />
                  </span>
                  {unavailable && (
                    <span className="rounded-full bg-[var(--warning-soft)] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-[var(--warning)]">
                      Currently unavailable
                    </span>
                  )}
                </div>
                <h2 className="text-lg font-bold text-[var(--text)]">{title}</h2>
                <p className="mt-2 text-[13px] leading-6 text-[var(--text-soft)]">{description}</p>
              </Panel>
            ))}
          </div>

          <div className="mx-auto mt-16 max-w-3xl border-t border-[var(--border)] pt-12">
            <div className="mb-6">
              <h2 className="text-2xl font-extrabold text-[var(--text)]">Questions about live and offline operation</h2>
            </div>
            <div className="space-y-2">
              {FAQ.map((item, index) => {
                const isOpen = openAccordion === index
                const answerId = `feature-answer-${index}`
                return (
                  <Panel key={item.question} className="overflow-hidden p-0 shadow-none">
                    <button
                      type="button"
                      onClick={() => setOpenAccordion(isOpen ? null : index)}
                      aria-expanded={isOpen}
                      aria-controls={answerId}
                      className="ui-control flex w-full items-center justify-between gap-4 p-4 text-left hover:bg-[var(--panel-elevated)]"
                    >
                      <span className="text-sm font-semibold text-[var(--text)] sm:text-[15px]">{item.question}</span>
                      <ChevronDown size={18} className={cx('shrink-0 text-[var(--muted)] transition-transform duration-200', isOpen && 'rotate-180')} />
                    </button>
                    {isOpen && (
                      <div id={answerId} className="animate-fade-in border-t border-[var(--border)] bg-[var(--panel-elevated)] px-4 py-4 text-sm leading-6 text-[var(--text-soft)]">
                        {item.answer}
                      </div>
                    )}
                  </Panel>
                )
              })}
            </div>
          </div>
        </div>
      </section>
    </WebsiteLayout>
  )
}
