import { useState, useMemo, useEffect } from 'react'
import { Phone, Search, ChevronDown, ChevronUp, Clock } from 'lucide-react'
import { fetchEmergencyHotlines } from '../lib/supabase'
import { Input, Skeleton } from './ui/primitives'

interface Agency {
  id: string
  name: string
  number: string
  alt: string | null
  available: string
  description: string
}

interface Category {
  id: string
  label: string
  color: string
  agencies: Agency[]
}

export default function HotlinesList() {
  const [query,      setQuery]      = useState('')
  const [dbHotlines, setDbHotlines] = useState<Category[]>([])
  const [expanded,   setExpanded]   = useState<string[]>([])
  const [loading,    setLoading]    = useState(true)

  useEffect(() => {
    async function load() {
      try {
        const data = await fetchEmergencyHotlines()
        if (data && data.length > 0) {
        // Group by category to match the Category interface structure
        const grouped: Record<string, Category> = {}
        data.forEach(item => {
          if (!grouped[item.category_id]) {
            grouped[item.category_id] = {
              id: item.category_id,
              label: item.category_label,
              color: item.category_color,
              agencies: []
            }
          }
          grouped[item.category_id].agencies.push({
            id: item.agency_id,
            name: item.name,
            number: item.number,
            alt: item.alt,
            available: item.available,
            description: item.description || ''
          })
        })
        const categories = Object.values(grouped)
        setDbHotlines(categories)
          setExpanded(categories.slice(0, 1).map(category => category.id))
        }
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const categories = dbHotlines

  const filtered = useMemo(() => {
    if (!query.trim()) return categories
    const q = query.toLowerCase()
    return categories
      .map(cat => ({
        ...cat,
        agencies: cat.agencies.filter(
          a => a.name.toLowerCase().includes(q) ||
               a.number.includes(q) ||
               a.description.toLowerCase().includes(q)
        ),
      }))
      .filter(cat => cat.agencies.length > 0)
  }, [query, categories])

  const toggleSection = (id: string) =>
    setExpanded(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])

  const totalAgencies = categories.reduce((s, c) => s + c.agencies.length, 0)

  return (
    <div className="h-full flex flex-col bg-[var(--color-bg-primary)]">
      {/* ── Header ─────────────────────────── */}
      <div className="px-4 pt-4 pb-3 border-b border-[var(--color-border)] shrink-0 bg-[var(--color-bg-secondary)]">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-8 h-8 rounded-lg bg-[var(--color-green-safe)]/15 border border-[var(--color-green-safe)]/25 flex items-center justify-center shrink-0">
            <Phone size={16} className="text-[var(--color-green-safe)]" />
          </div>
          <div>
            <h1 className="text-base font-bold text-[var(--color-text-primary)]">Emergency Hotlines</h1>
            <p className="text-[11px] text-[var(--color-text-muted)]">{totalAgencies} agencies · Live database</p>
          </div>
        </div>

        {/* Search */}
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <Input
            type="search"
            placeholder="Search agency or number…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            className="min-h-10 pl-8 pr-3 py-2"
          />
        </div>
      </div>

      {/* ── List ───────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {loading && (
          <div role="status" aria-label="Loading emergency hotlines" className="space-y-3">
            {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} variant="block" className="h-16 w-full" />)}
            <span className="sr-only">Loading emergency hotlines</span>
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="text-center py-16 text-[var(--color-text-muted)]">
            <Search size={32} className="mx-auto mb-3 opacity-30" />
            <p className="text-sm">{query ? `No results for "${query}"` : 'No hotline records are currently available.'}</p>
          </div>
        )}

        {!loading && filtered.map((cat, index) => {
          const isOpen = expanded.includes(cat.id)
          return (
            <div key={cat.id} className="elevated-panel rounded-[var(--radius-lg)] overflow-hidden bg-[var(--panel)] animate-stagger-in" style={{ '--stagger-index': index } as React.CSSProperties}>
              {/* Category header */}
              <button
                onClick={() => toggleSection(cat.id)}
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[var(--color-bg-elevated)] transition-colors"
              >
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: cat.color }} />
                <span className="font-semibold text-sm text-[var(--color-text-primary)] flex-1">{cat.label}</span>
                <span className="text-[11px] text-[var(--color-text-muted)] mr-2">{cat.agencies.length}</span>
                {isOpen
                  ? <ChevronUp size={14} className="text-[var(--color-text-muted)]" />
                  : <ChevronDown size={14} className="text-[var(--color-text-muted)]" />
                }
              </button>

              {/* Agencies */}
              {isOpen && (
                <div className="border-t border-[var(--color-border)] divide-y divide-[var(--color-border)]">
                  {cat.agencies.map(agency => (
                    <div key={agency.id} className="px-4 py-3 space-y-2 hover:bg-[var(--color-bg-elevated)]/50 transition-colors animate-fade-in">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-[var(--color-text-primary)] leading-tight">{agency.name}</p>
                          <p className="text-[11px] text-[var(--color-text-muted)] mt-0.5 leading-relaxed">{agency.description}</p>
                          <div className="flex items-center gap-1 mt-1 text-[10px] text-[var(--color-text-muted)]">
                            <Clock size={9} />
                            {agency.available}
                          </div>
                        </div>
                      </div>

                      {/* Call buttons */}
                      <div className="flex gap-2 flex-wrap">
                        <a
                          href={`tel:${agency.number}`}
                          className="flex-1 min-w-[100px] flex items-center justify-center gap-2 py-2.5 px-3 rounded-lg font-bold text-sm text-white transition-all duration-200 active:scale-95"
                          style={{ background: cat.color }}
                        >
                          <Phone size={14} />
                          {agency.number}
                        </a>
                        {agency.alt && (
                          <a
                            href={`tel:${agency.alt.replace(/\s/g, '')}`}
                            className="flex items-center justify-center gap-2 py-2.5 px-3 rounded-lg font-medium text-xs text-[var(--color-text-secondary)] border border-[var(--color-border-bright)] bg-[var(--color-bg-elevated)] hover:border-[var(--color-border)] transition-all duration-200 active:scale-95"
                          >
                            <Phone size={12} />
                            {agency.alt}
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}

        {/* Bottom spacer for mobile nav */}
        <div className="h-2" />
      </div>
    </div>
  )
}
