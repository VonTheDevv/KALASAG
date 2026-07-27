import { ExternalLink, Globe2, MonitorSmartphone, ShieldCheck, Smartphone } from 'lucide-react'
import { Link } from 'react-router-dom'
import WebsiteLayout from '../components/WebsiteLayout'
import { Button, Panel } from '../components/ui/primitives'

export default function Downloads() {
  return (
    <WebsiteLayout>
      <section className="bg-[var(--surface)] py-14 sm:py-20">
        <div className="mx-auto max-w-[1000px] px-5 sm:px-6">
          <header className="mx-auto mb-12 max-w-3xl text-center animate-smooth-slide-up">
            <h1 className="text-4xl font-extrabold tracking-[-0.03em] text-[var(--text)] sm:text-5xl">Use the workspace on the device you have.</h1>
            <p className="mx-auto mt-5 max-w-2xl text-sm leading-7 text-[var(--text-soft)] sm:text-[15px]">
              The responsive web application works across modern desktop and Android browsers. An installable Android package will appear here only when a signed build is available.
            </p>
          </header>

          <div className="grid gap-5 md:grid-cols-2">
            <Panel className="flex min-h-[330px] flex-col p-6 sm:p-7">
              <span className="grid h-11 w-11 place-items-center rounded-[var(--radius-md)] bg-[var(--action-soft)] text-[var(--action)]"><Globe2 size={22} /></span>
              <h2 className="mt-7 text-xl font-bold text-[var(--text)]">Responsive web application</h2>
              <p className="mt-3 text-sm leading-6 text-[var(--text-soft)]">
                Open the full hazard workspace in a current browser. The interface adapts to desktop, tablet, and Android phone widths without changing operational map symbols.
              </p>
              <ul className="mt-5 space-y-2 text-xs text-[var(--muted)]">
                <li className="flex gap-2"><ShieldCheck size={14} className="mt-0.5 shrink-0 text-[var(--success)]" />No separate installer required</li>
                <li className="flex gap-2"><MonitorSmartphone size={14} className="mt-0.5 shrink-0 text-[var(--action)]" />Designed for desktop and mobile browsers</li>
              </ul>
              <div className="mt-auto pt-7">
                <Link to="/app" className="ui-control inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-[var(--radius-md)] bg-[var(--action)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--action-hover)]">
                  Open web application <ExternalLink size={16} />
                </Link>
              </div>
            </Panel>

            <Panel className="flex min-h-[330px] flex-col p-6 sm:p-7">
              <span className="grid h-11 w-11 place-items-center rounded-[var(--radius-md)] bg-[var(--panel-elevated)] text-[var(--muted)]"><Smartphone size={22} /></span>
              <h2 className="mt-7 text-xl font-bold text-[var(--text)]">Signed Android package</h2>
              <p className="mt-3 text-sm leading-6 text-[var(--text-soft)]">
                A direct APK is not currently included in this project. The download action remains disabled until a signed and verified build exists.
              </p>
              <div className="mt-auto pt-7">
                <Button variant="secondary" disabled className="w-full">APK unavailable</Button>
              </div>
            </Panel>
          </div>
        </div>
      </section>
    </WebsiteLayout>
  )
}
