import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { fetchNewsSnapshot, NEWS_REFRESH_INTERVAL_MS, type NewsArticle, type NewsSourceStatus } from '../lib/news'
import { supabase } from '../lib/supabase'
import { NewsContext } from './newsContext'

export function NewsProvider({ children }: { children: ReactNode }) {
  const [articles, setArticles] = useState<NewsArticle[]>([])
  const [sources, setSources] = useState<NewsSourceStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null)
  const activeRequest = useRef<Promise<void> | null>(null)
  const refreshTimer = useRef<number | null>(null)
  const lastRequestAt = useRef(0)

  const refresh = useCallback((force = false) => {
    if (activeRequest.current) return activeRequest.current
    // Realtime is a prompt to refresh, not a reason to refetch once per row.
    // The centralized poll still catches missed Realtime events.
    if (!force && Date.now() - lastRequestAt.current < NEWS_REFRESH_INTERVAL_MS) return Promise.resolve()
    lastRequestAt.current = Date.now()
    setRefreshing(true)
    const request = (async () => {
      try {
        const snapshot = await fetchNewsSnapshot()
        setArticles(snapshot.articles)
        setSources(snapshot.sources)
        setLastUpdatedAt(snapshot.fetchedAt)
        setError(null)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'News monitoring is temporarily unavailable')
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    })().finally(() => {
      if (activeRequest.current === request) activeRequest.current = null
    })
    activeRequest.current = request
    return request
  }, [])

  useEffect(() => {
    void refresh()
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible' && navigator.onLine) void refresh()
    }, NEWS_REFRESH_INTERVAL_MS)
    const refreshWhenActive = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) void refresh()
    }
    document.addEventListener('visibilitychange', refreshWhenActive)
    window.addEventListener('online', refreshWhenActive)

    const channel = supabase
      .channel('news_articles_realtime')
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'news_articles',
      }, () => {
        if (document.visibilityState !== 'visible' || !navigator.onLine) return
        if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current)
        refreshTimer.current = window.setTimeout(() => {
          refreshTimer.current = null
          void refresh()
        }, 3_000)
      })
      .subscribe()

    return () => {
      window.clearInterval(interval)
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current)
      document.removeEventListener('visibilitychange', refreshWhenActive)
      window.removeEventListener('online', refreshWhenActive)
      void supabase.removeChannel(channel)
    }
  }, [refresh])

  return (
    <NewsContext.Provider value={{
      articles,
      sources,
      loading,
      refreshing,
      error,
      lastUpdatedAt,
      refresh: async () => { await refresh(true) },
    }}>
      {children}
    </NewsContext.Provider>
  )
}
