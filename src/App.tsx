import { lazy, Suspense, useCallback, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import Layout from './components/Layout'
import HazardMap from './components/HazardMap'
import HotlinesList from './components/HotlinesList'
import EmergencyID from './components/EmergencyID'
import BackgroundSafetyCheck from './components/BackgroundSafetyCheck'
import SplashScreen from './components/SplashScreen'
import HazardsHub from './components/HazardsHub'
import RoadTraffic from './components/RoadTraffic'
import EmergencyQRGate from './components/EmergencyQRGate'
import { ReloadPrompt } from './components/ReloadPrompt'
import FamilyDashboard from './components/FamilyDashboard'
import FamilyChat from './components/FamilyChat'
import { Skeleton } from './components/ui/primitives'
import { FamilySafetyProvider } from './hooks/FamilySafetyProvider'
import { NewsProvider } from './hooks/NewsProvider'

const EarthquakeInfo = lazy(() => import('./components/EarthquakeInfo'))
const TyphoonInfo = lazy(() => import('./components/TyphoonInfo'))
const WeatherInfo = lazy(() => import('./components/WeatherInfo'))
const VolcanoInfo = lazy(() => import('./components/VolcanoInfo'))
const DamStatusPanel = lazy(() => import('./components/hazards/DamStatusPanel'))
const NewsFeed = lazy(() => import('./components/NewsFeed'))

export type TabId =
  | 'map'
  | 'news'
  | 'hotlines'
  | 'qrid'
  | 'hazards'
  | 'earthquake'
  | 'typhoon'
  | 'weather'
  | 'volcano'
  | 'traffic'
  | 'dams'
  | 'family'
  | 'familyChat'

function ModuleSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading module"
      className="h-full overflow-hidden bg-[var(--surface)] p-4 sm:p-6"
    >
      <div className="mx-auto max-w-5xl space-y-5">
        <div className="space-y-3">
          <Skeleton variant="line" className="h-5 w-44" />
          <Skeleton variant="line" className="w-72 max-w-full" />
        </div>
        <Skeleton variant="block" className="h-44 w-full" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Skeleton variant="block" className="h-32" />
          <Skeleton variant="block" className="h-32" />
          <Skeleton variant="block" className="h-32" />
        </div>
      </div>
      <span className="sr-only">Loading module</span>
    </div>
  )
}

function App() {
  const [activeTab, setActiveTab] = useState<TabId>('map')
  const [showSplash, setShowSplash] = useState(() => {
    if (Capacitor.isNativePlatform()) return false

    try {
      return window.sessionStorage.getItem('kalasag_splash_seen') !== '1'
    } catch {
      return true
    }
  })
  const [contentKey, setContentKey] = useState(0)

  const handleSplashFinished = useCallback(() => {
    try {
      window.sessionStorage.setItem('kalasag_splash_seen', '1')
    } catch {
      // Session storage may be unavailable in hardened browser contexts.
    }
    setShowSplash(false)
  }, [])

  const handleTabChange = useCallback(
    (tab: TabId) => {
      if (tab === activeTab) return
      setActiveTab(tab)
      setContentKey(key => key + 1)
    },
    [activeTab],
  )

  if (showSplash) {
    return <SplashScreen onFinished={handleSplashFinished} />
  }

  return (
    <>
      <ReloadPrompt />
      <EmergencyQRGate>
        <FamilySafetyProvider onNavigate={handleTabChange}>
          <NewsProvider>
            <Layout activeTab={activeTab} setActiveTab={handleTabChange}>
              <BackgroundSafetyCheck />
              <div key={contentKey} className="h-full animate-smooth-slide-up">
                {activeTab === 'map' && <HazardMap />}
                {activeTab === 'family' && <FamilyDashboard onNavigate={handleTabChange} />}
                {activeTab === 'familyChat' && <FamilyChat onBack={() => handleTabChange('family')} />}
                {activeTab === 'hotlines' && <HotlinesList />}
                {activeTab === 'qrid' && <EmergencyID />}
                {activeTab === 'hazards' && <HazardsHub onNavigate={handleTabChange} />}
                {activeTab === 'traffic' && <RoadTraffic />}

                <Suspense fallback={<ModuleSkeleton />}>
                  {activeTab === 'news' && <NewsFeed />}
                  {activeTab === 'earthquake' && <EarthquakeInfo />}
                  {activeTab === 'typhoon' && <TyphoonInfo />}
                  {activeTab === 'weather' && <WeatherInfo />}
                  {activeTab === 'volcano' && <VolcanoInfo />}
                  {activeTab === 'dams' && <DamStatusPanel />}
                </Suspense>
              </div>
            </Layout>
          </NewsProvider>
        </FamilySafetyProvider>
      </EmergencyQRGate>
    </>
  )
}

export default App
