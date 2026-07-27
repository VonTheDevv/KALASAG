import { Database, Eye, RadioTower, ShieldCheck, WifiOff } from 'lucide-react'
import { Panel } from './ui/primitives'

export default function AboutSection() {
  return (
    <section id="about" aria-labelledby="about-heading" className="scroll-mt-16 bg-[#020617] py-12 sm:py-16 lg:py-20">
      <div className="mx-auto max-w-[1100px] px-4 sm:px-6">
        <header className="mx-auto mb-8 max-w-3xl text-center animate-smooth-slide-up sm:mb-12">
          <h2 id="about-heading" className="text-[30px] font-extrabold leading-[1.15] tracking-[0] text-[var(--text)] sm:text-[38px] lg:text-[48px]">A digital shield built around clear evidence.</h2>
          <p className="mx-auto mt-4 max-w-2xl text-sm leading-6 text-[var(--text-soft)] sm:mt-5 sm:text-[15px] sm:leading-7">
            Named after the Filipino shield, KALASAG is designed to help people understand nearby hazards, monitor changing conditions, and reach essential safety tools with less friction.
          </p>
        </header>

        <div className="grid gap-4 md:grid-cols-2">
          <Panel className="website-card-hover p-5 sm:p-7">
            <span className="grid h-10 w-10 place-items-center rounded-[var(--radius-md)] bg-[var(--action-soft)] text-[var(--action)]"><Eye size={20} /></span>
            <h3 className="mt-6 text-xl font-bold text-[var(--text)]">Readable under pressure</h3>
            <p className="mt-3 text-sm leading-6 text-[var(--text-soft)]">
              The interface prioritizes legibility, mobile reach, and consistent controls while preserving the hazard colors, warning symbols, trails, and map semantics that communicate urgency.
            </p>
          </Panel>
          <Panel className="website-card-hover p-5 sm:p-7">
            <span className="grid h-10 w-10 place-items-center rounded-[var(--radius-md)] bg-[var(--success-soft)] text-[var(--success)]"><ShieldCheck size={20} /></span>
            <h3 className="mt-6 text-xl font-bold text-[var(--text)]">Honest about data state</h3>
            <p className="mt-3 text-sm leading-6 text-[var(--text-soft)]">
              Live data can fail upstream. KALASAG is built to distinguish fresh observations from unavailable feeds and static reference material instead of filling gaps with simulated operational events.
            </p>
          </Panel>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-3">
          {[
            { icon: RadioTower, title: 'Live when available', copy: 'Operational feeds refresh from their current live services.' },
            { icon: Database, title: 'Context included', copy: 'Panels identify the meaning and freshness of operational information.' },
            { icon: WifiOff, title: 'Failure visible', copy: 'Unavailable data is shown as unavailable, never silently invented.' },
          ].map(({ icon: ItemIcon, title, copy }) => (
            <div key={title} className="website-card-hover rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--panel-elevated)] p-4">
              <ItemIcon size={18} className="text-[var(--muted)]" />
              <p className="mt-4 text-sm font-bold text-[var(--text)]">{title}</p>
              <p className="mt-1.5 text-xs leading-5 text-[var(--text-soft)]">{copy}</p>
            </div>
          ))}
        </div>

      </div>
    </section>
  )
}
