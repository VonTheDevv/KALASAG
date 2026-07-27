import { useState } from 'react'
import { ArrowRight, BookOpen, ChevronLeft, ChevronRight } from 'lucide-react'
import WebsiteLayout from '../components/WebsiteLayout'
import { Button, IconButton, Panel } from '../components/ui/primitives'
import { cx } from '../lib/cx'

interface Post {
  id: string
  title: string
  date: string
  excerpt: string
  content: string[]
}

const POSTS: Post[] = [
  {
    id: 'p1',
    title: 'Offline-first patterns for disaster-resilient web applications',
    date: 'July 5, 2026',
    excerpt: 'Why emergency tools must communicate the boundary between cached resources and live information when local connectivity fails.',
    content: [
      'During major typhoon landfalls, cellular towers and fixed internet infrastructure can lose power or physical connectivity. A safety interface should not assume that every upstream service will remain available.',
      'KALASAG installs as a progressive web application and caches its core interface. Operational modules still identify when live data cannot be reached so users do not mistake old or missing information for a current observation.',
      'The key design rule is explicit state: cached tools remain useful, while time-sensitive layers must make freshness and failure visible.',
    ],
  },
  {
    id: 'p2',
    title: 'Reading Tropical Cyclone Wind Signals',
    date: 'June 28, 2026',
    excerpt: 'A practical orientation to TCWS levels and why official local bulletins remain the authority for protective action.',
    content: [
      'The national weather authority issues Tropical Cyclone Wind Signals to communicate the expected wind threat and lead time for affected areas. The signal in force for a locality is more relevant than a storm center shown on a national map.',
      'Wind signals are only one part of risk. Rainfall, flooding, landslides, storm surge, building condition, and local evacuation orders can create serious danger beyond the wind category alone.',
      'Use KALASAG for situational context, then follow current official weather bulletins and local authority instructions for warnings and evacuation decisions.',
    ],
  },
  {
    id: 'p3',
    title: 'From a live event feed to a readable seismic map',
    date: 'June 15, 2026',
    excerpt: 'How magnitude, depth, location, age, and event metadata become a useful earthquake information panel.',
    content: [
      'Earthquakes arrive without a forecast, so the information pipeline must ingest and validate new events quickly. KALASAG reads a live earthquake feed for the Philippine monitoring region.',
      'Each usable record is transformed into map position, magnitude, depth, event time, and reporting context. The interface preserves the difference between reported values and visual emphasis added by the client.',
      'The result supports rapid awareness, but official national earthquake guidance and local government instructions remain essential when assessing local impacts and protective actions.',
    ],
  },
]

const FEATURED = [
  {
    title: 'Designing honest unavailable states for live safety data',
    excerpt: 'A feed outage should create a clear recovery path, not a blank panel or a simulated replacement event.',
    date: 'July 9, 2026',
  },
  {
    title: 'Why observed and forecast storm tracks must look different',
    excerpt: 'Separating recorded positions from forecast points helps prevent a prediction from being read as storm history.',
    date: 'July 1, 2026',
  },
]

export default function Blog() {
  const [activeFeaturedIndex, setActiveFeaturedIndex] = useState(0)
  const [expandedPostId, setExpandedPostId] = useState<string | null>(null)
  const featured = FEATURED[activeFeaturedIndex]

  const moveFeatured = (direction: -1 | 1) => {
    setActiveFeaturedIndex(index => (index + direction + FEATURED.length) % FEATURED.length)
  }

  return (
    <WebsiteLayout>
      <section className="bg-[var(--surface)] py-14 sm:py-20">
        <div className="mx-auto max-w-[1000px] px-5 sm:px-6">
          <header className="mx-auto mb-10 max-w-3xl text-center animate-smooth-slide-up">
            <h1 className="text-4xl font-extrabold tracking-[-0.03em] text-[var(--text)] sm:text-5xl">Technical notes for safer systems.</h1>
            <p className="mx-auto mt-5 max-w-2xl text-sm leading-7 text-[var(--text-soft)] sm:text-[15px]">
              Engineering decisions, telemetry context, and practical preparedness guidance behind the KALASAG workspace.
            </p>
          </header>

          <Panel className="overflow-hidden p-0 shadow-[var(--shadow-md)] animate-scale-in">
            <div className="p-5 sm:p-7">
                <div className="flex items-center justify-between gap-4 border-b border-[var(--border)] pb-4">
                  <div className="flex items-center gap-2">
                    <BookOpen size={17} className="text-[var(--action)]" />
                    <span className="font-data text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--muted)]">Featured brief</span>
                  </div>
                  <div className="flex gap-1.5" aria-label="Featured brief selection">
                    {FEATURED.map((item, index) => (
                      <button
                        type="button"
                        key={item.title}
                        onClick={() => setActiveFeaturedIndex(index)}
                        aria-label={`Show featured brief ${index + 1}`}
                        aria-pressed={index === activeFeaturedIndex}
                        className="ui-control grid h-6 w-6 place-items-center rounded-full"
                      >
                        <span
                          aria-hidden="true"
                          className={cx('h-2 rounded-full transition-all duration-200', index === activeFeaturedIndex ? 'w-6 bg-[var(--action)]' : 'w-2 bg-[var(--border-strong)]')}
                        />
                      </button>
                    ))}
                  </div>
                </div>

                <div className="min-h-44 pt-6" aria-live="polite">
                  <span className="font-data text-[10px] text-[var(--muted)]">{featured.date}</span>
                  <h2 className="mt-4 text-2xl font-extrabold leading-tight text-[var(--text)]">{featured.title}</h2>
                  <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--text-soft)]">{featured.excerpt}</p>
                </div>

                <div className="flex items-center justify-between border-t border-[var(--border)] pt-4">
                  <span className="font-data text-[10px] text-[var(--muted)]">{activeFeaturedIndex + 1} of {FEATURED.length}</span>
                  <div className="flex gap-2">
                    <IconButton size="sm" variant="secondary" onClick={() => moveFeatured(-1)} aria-label="Previous featured brief"><ChevronLeft size={17} /></IconButton>
                    <IconButton size="sm" variant="secondary" onClick={() => moveFeatured(1)} aria-label="Next featured brief"><ChevronRight size={17} /></IconButton>
                  </div>
                </div>
            </div>
          </Panel>

          <div className="mt-12 space-y-3">
            {POSTS.map(post => {
              const isExpanded = expandedPostId === post.id
              const contentId = `post-${post.id}`
              return (
                <Panel key={post.id} className="p-5 sm:p-6">
                  <article>
                    <span className="font-data text-[10px] text-[var(--muted)]">{post.date}</span>
                    <h2 className="mt-4 text-xl font-bold leading-tight text-[var(--text)] sm:text-2xl">{post.title}</h2>
                    {isExpanded ? (
                      <div id={contentId} className="mt-5 space-y-4 border-t border-[var(--border)] pt-5 animate-fade-in">
                        {post.content.map(paragraph => <p key={paragraph} className="text-sm leading-7 text-[var(--text-soft)]">{paragraph}</p>)}
                      </div>
                    ) : (
                      <p id={contentId} className="mt-3 text-sm leading-6 text-[var(--text-soft)]">{post.excerpt}</p>
                    )}
                    <div className="mt-5 flex justify-end border-t border-[var(--border)] pt-4">
                      <Button
                        variant="ghost"
                        onClick={() => setExpandedPostId(isExpanded ? null : post.id)}
                        aria-expanded={isExpanded}
                        aria-controls={contentId}
                        className="min-h-9 px-3 py-1.5"
                      >
                        {isExpanded ? 'Collapse brief' : 'Read brief'}
                        <ArrowRight size={15} className={cx('transition-transform duration-200', isExpanded && 'rotate-90')} />
                      </Button>
                    </div>
                  </article>
                </Panel>
              )
            })}
          </div>
        </div>
      </section>
    </WebsiteLayout>
  )
}
