import { createContext, useContext } from 'react'
import type { NewsArticle, NewsSourceStatus } from '../lib/news'

export type NewsContextValue = {
  articles: NewsArticle[]
  sources: NewsSourceStatus[]
  loading: boolean
  refreshing: boolean
  error: string | null
  lastUpdatedAt: string | null
  refresh: () => Promise<void>
}

export const NewsContext = createContext<NewsContextValue | null>(null)

export function useNews() {
  const value = useContext(NewsContext)
  if (!value) throw new Error('useNews must be used within NewsProvider')
  return value
}
