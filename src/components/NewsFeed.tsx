import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Clock3,
  ExternalLink,
  MapPin,
  Newspaper,
  RefreshCw,
  Search,
  UserRound,
} from 'lucide-react'
import { useNews } from '../hooks/newsContext'
import {
  newsCategoryColor,
  newsCategoryLabel,
  type NewsArticle,
  type NewsCategory,
} from '../lib/news'
import { Badge, Button, ErrorBanner, Input, Panel, Select, Skeleton } from './ui/primitives'

type CategoryFilter = 'all' | NewsCategory
const INITIAL_ARTICLE_LIMIT = 30
const LOAD_MORE_STEP = 30
const NEWS_CATEGORY_OPTIONS = [
  { value: 'all', label: 'All monitored reports' },
  { value: 'fire', label: 'Fire' },
  { value: 'flood', label: 'Flood' },
  { value: 'road-incident', label: 'Vehicle / road accidents' },
  { value: 'killing', label: 'Killings / murder' },
  { value: 'robbery-theft', label: 'Robbery / theft' },
  { value: 'typhoon', label: 'Typhoons / storms' },
  { value: 'earthquake', label: 'Earthquakes' },
  { value: 'security-conflict', label: 'Security / armed conflict' },
] as const

function exactTime(value: string) {
  return new Date(value).toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function relativeTime(value: string) {
  const elapsedSeconds = Math.round((Date.parse(value) - Date.now()) / 1000)
  const formatFallback = (amount: number, unit: string) => {
    const absolute = Math.abs(amount)
    const label = `${absolute} ${unit}${absolute === 1 ? '' : 's'}`
    return amount >= 0 ? `in ${label}` : `${label} ago`
  }
  const formatter = typeof Intl !== 'undefined' && typeof Intl.RelativeTimeFormat === 'function'
    ? new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
    : null
  const format = (amount: number, unit: Intl.RelativeTimeFormatUnit) => formatter
    ? formatter.format(amount, unit)
    : formatFallback(amount, unit)
  if (!Number.isFinite(elapsedSeconds)) return 'time unavailable'
  if (Math.abs(elapsedSeconds) < 60) return format(elapsedSeconds, 'second')
  const minutes = Math.round(elapsedSeconds / 60)
  if (Math.abs(minutes) < 60) return format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return format(hours, 'hour')
  return format(Math.round(hours / 24), 'day')
}

function verificationLabel(article: NewsArticle) {
  return article.verification === 'multiple-outlets-reported'
    ? 'Multiple outlets reported'
    : 'News-reported'
}

function NewsCard({ article }: { article: NewsArticle }) {
  const categoryColor = newsCategoryColor(article.category)
  const mappable = article.lat !== null && article.lng !== null && (article.locationConfidence ?? 0) >= 0.7
  const isInquirer = article.sourceId === 'inquirer-newsinfo'

  return (
    <Panel className="overflow-hidden p-4 sm:p-5">
      <article className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            tone={article.isHazard ? 'warning' : 'neutral'}
            style={article.isHazard ? { color: categoryColor } : undefined}
          >
            {newsCategoryLabel(article.category)}
          </Badge>
          <Badge tone={article.verification === 'multiple-outlets-reported' ? 'success' : 'info'}>
            {verificationLabel(article)}
          </Badge>
          {article.resolvedAt && <Badge tone="success">Reported resolved</Badge>}
        </div>

        <div>
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--action)]">{article.sourceName}</p>
          <h2 className="mt-1 text-lg font-bold leading-snug text-[var(--text)]">{article.title}</h2>
        </div>

        {article.summary && (
          <p className="text-sm leading-relaxed text-[var(--text-soft)]">{article.summary}</p>
        )}

        <dl className="grid gap-2 text-xs text-[var(--muted)] sm:grid-cols-2">
          <div className="flex min-w-0 items-start gap-2">
            <Clock3 size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <div>
              <dt className="sr-only">Published</dt>
              <dd title={exactTime(article.publishedAt)}>
                Published {relativeTime(article.publishedAt)} · {exactTime(article.publishedAt)}
              </dd>
            </div>
          </div>
          <div className="flex min-w-0 items-start gap-2">
            <RefreshCw size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <div>
              <dt className="sr-only">Detected by KALASAG</dt>
              <dd title={exactTime(article.firstDetectedAt)}>
                Detected {relativeTime(article.firstDetectedAt)}
              </dd>
            </div>
          </div>
          <div className="flex min-w-0 items-start gap-2">
            <UserRound size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <div>
              <dt className="sr-only">Journalist</dt>
              <dd>{article.author || 'Journalist not supplied by the publisher feed'}</dd>
            </div>
          </div>
          <div className="flex min-w-0 items-start gap-2">
            <MapPin size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <div>
              <dt className="sr-only">Location</dt>
              <dd>
                {article.locationName
                  ? `${article.locationName}${article.locationPrecision === 'locality' ? ' · approximate locality' : article.locationPrecision === 'offshore' ? ' · publisher-reported offshore coordinate' : ''}`
                  : article.isHazard
                    ? 'Location not precise enough for a map marker'
                    : 'No incident location required'}
              </dd>
            </div>
          </div>
        </dl>

        {article.isHazard && (
          <p className="rounded-[var(--radius-md)] bg-[var(--surface-alt)] px-3 py-2 text-[11px] leading-relaxed text-[var(--muted)]">
            {mappable
              ? 'This secondary marker is based on publisher metadata and is visually separated from official and satellite feeds.'
              : 'This report remains in News but is not mapped because KALASAG will not invent or guess an incident coordinate.'}
          </p>
        )}

        <div className="flex flex-col gap-2 border-t border-[var(--border)] pt-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[11px] text-[var(--muted)]">
            Source citation: {article.sourceName}.
            {isInquirer
              ? ' The following link will take you to INQUIRER.net.'
              : ' Headline and available publisher metadata remain the publisher’s work.'}
          </p>
          <a
            href={article.articleUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ui-control inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-[var(--radius-md)] bg-[var(--action)] px-4 py-2 text-sm font-semibold text-[var(--action-text)] hover:bg-[var(--action-hover)] sm:min-h-10"
          >
            {isInquirer ? 'Open on INQUIRER.net' : 'Read original'}
            <ExternalLink size={15} aria-hidden="true" />
          </a>
        </div>
      </article>
    </Panel>
  )
}

function NewsSkeleton() {
  return (
    <div className="space-y-4" role="status" aria-label="Loading latest news">
      {[0, 1, 2].map(index => (
        <Panel key={index} className="space-y-4 p-5">
          <div className="flex gap-2">
            <Skeleton variant="line" className="h-6 w-24" />
            <Skeleton variant="line" className="h-6 w-32" />
          </div>
          <Skeleton variant="line" className="h-5 w-4/5" />
          <Skeleton variant="line" className="w-full" />
          <Skeleton variant="line" className="w-3/5" />
          <Skeleton variant="block" className="h-10 w-full" />
        </Panel>
      ))}
      <span className="sr-only">Loading news</span>
    </div>
  )
}

export default function NewsFeed() {
  const { articles, sources, loading, refreshing, error, lastUpdatedAt, refresh } = useNews()
  const [category, setCategory] = useState<CategoryFilter>('all')
  const [source, setSource] = useState('all')
  const [query, setQuery] = useState('')
  const [visibleCount, setVisibleCount] = useState(INITIAL_ARTICLE_LIMIT)

  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase()
    return articles.filter(article => {
      if (category !== 'all' && article.category !== category) return false
      if (source !== 'all' && article.sourceId !== source) return false
      if (search && !`${article.title} ${article.summary ?? ''} ${article.author ?? ''} ${article.locationName ?? ''}`.toLowerCase().includes(search)) return false
      return true
    })
  }, [articles, category, source, query])

  useEffect(() => {
    setVisibleCount(INITIAL_ARTICLE_LIMIT)
  }, [category, source, query])

  const enabledSources = sources.filter(item => item.ingestionStatus === 'enabled')
  const delayedSources = enabledSources.filter(item => item.healthStatus === 'unavailable')
  const publisherOptions = [
    { value: 'all', label: 'All publishers' },
    ...enabledSources.map(item => ({ value: item.id, label: item.name })),
  ]
  const mappedCount = articles.filter(article => article.lat !== null && article.lng !== null).length
  const visibleArticles = filtered.slice(0, visibleCount)

  return (
    <div className="h-full overflow-y-auto bg-[var(--surface)]">
      <div className="mx-auto max-w-5xl space-y-5 p-4 pb-24 sm:p-6 sm:pb-8">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Newspaper size={22} className="text-[var(--action)]" aria-hidden="true" />
              <h1 className="text-2xl font-bold text-[var(--text)]">News monitoring</h1>
            </div>
            <p className="mt-1 max-w-3xl text-sm leading-relaxed text-[var(--text-soft)]">
              Publisher metadata is restricted to fire, flood, vehicle accidents, killings, robbery or theft,
              typhoons, earthquakes, terrorism, and operational armed-conflict reports.
            </p>
          </div>
          <Button
            variant="secondary"
            busy={refreshing}
            leadingIcon={<RefreshCw size={16} aria-hidden="true" />}
            onClick={() => void refresh()}
          >
            Refresh
          </Button>
        </header>

        <div className="text-sm leading-relaxed text-[var(--muted)]" role="note">
          <p className="font-semibold">Secondary information — verify before acting</p>
          <p>
            News reports do not replace official warnings. Single-source reports never trigger KALASAG proximity
            alarms, and only defensibly geocoded reports appear on the map.
          </p>
        </div>

        {error && (
          <ErrorBanner title="News monitoring is delayed">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <span>{error}</span>
              <Button variant="secondary" onClick={() => void refresh()}>Try again</Button>
            </div>
          </ErrorBanner>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <Panel className="p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Monitored reports</p>
            <p className="mt-1 text-2xl font-bold text-[var(--text)]">{articles.length}</p>
          </Panel>
          <Panel className="p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Mapped reports</p>
            <p className="mt-1 text-2xl font-bold text-[var(--warning)]">{mappedCount}</p>
          </Panel>
          <Panel className="p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Enabled publishers</p>
            <p className="mt-1 text-2xl font-bold text-[var(--success)]">{enabledSources.length}</p>
          </Panel>
        </div>

        <Panel className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-bold text-[var(--text)]">Publisher coverage</h2>
              <p className="text-xs text-[var(--muted)]">
                Centralized server polling; no publisher is polled separately by each device.
              </p>
            </div>
            {lastUpdatedAt && (
              <span className="text-[11px] text-[var(--muted)]">App checked {relativeTime(lastUpdatedAt)}</span>
            )}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {sources.map(item => (
              <a
                key={item.id}
                href={item.homeUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="ui-control flex min-h-14 items-center justify-between gap-3 rounded-[var(--radius-md)] bg-[var(--surface-alt)] px-3 py-2 hover:bg-[var(--panel-elevated)]"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-[var(--text)]">{item.name}</p>
                  <p className="line-clamp-2 text-[11px] text-[var(--muted)]">{item.detail}</p>
                </div>
                <Badge
                  tone={
                    item.healthStatus === 'live'
                      ? 'success'
                    : item.healthStatus === 'unavailable'
                        ? 'warning'
                        : 'neutral'
                  }
                  className="shrink-0"
                >
                  {item.ingestionStatus === 'disabled_pending_permission'
                    ? 'Permission needed'
                    : item.healthStatus === 'live'
                      ? 'Live'
                      : item.healthStatus === 'unavailable'
                        ? item.isStale ? 'Stale' : 'Delayed'
                        : 'Starting'}
                </Badge>
              </a>
            ))}
          </div>
          {delayedSources.length > 0 && (
            <p className="flex items-start gap-2 text-xs text-[var(--warning)]">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              {delayedSources.map(item => item.name).join(', ')} currently delayed. Other news and official hazard feeds remain active.
            </p>
          )}
        </Panel>

        <Panel className="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_12rem_12rem]">
          <label className="relative">
            <span className="sr-only">Search news</span>
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
            <Input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Search headline, place, or journalist"
              className="pl-9"
            />
          </label>
          <div>
            <span className="sr-only">Filter by category</span>
            <Select
              aria-label="Filter news by category"
              value={category}
              options={NEWS_CATEGORY_OPTIONS}
              onValueChange={value => setCategory(value as CategoryFilter)}
            />
          </div>
          <div>
            <span className="sr-only">Filter by publisher</span>
            <Select
              aria-label="Filter news by publisher"
              value={source}
              options={publisherOptions}
              onValueChange={setSource}
            />
          </div>
        </Panel>

        {loading ? (
          <NewsSkeleton />
        ) : filtered.length ? (
          <div className="space-y-4">
            {visibleArticles.map(article => <NewsCard key={article.id} article={article} />)}
            {visibleArticles.length < filtered.length && (
              <div className="flex justify-center">
                <Button variant="secondary" onClick={() => setVisibleCount(count => count + LOAD_MORE_STEP)}>
                  Load more ({filtered.length - visibleArticles.length} remaining)
                </Button>
              </div>
            )}
          </div>
        ) : (
          <Panel className="grid min-h-48 place-items-center p-6 text-center">
            <div>
              <Newspaper size={28} className="mx-auto text-[var(--muted)]" aria-hidden="true" />
              <p className="mt-3 font-semibold text-[var(--text)]">No matching articles</p>
              <p className="mt-1 text-sm text-[var(--muted)]">Try a different search or category.</p>
            </div>
          </Panel>
        )}
      </div>
    </div>
  )
}
