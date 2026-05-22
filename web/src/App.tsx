import { lazy, Suspense, useEffect, useState } from 'react'
import { Cloud, FileText, Globe, Loader2, Map as MapIcon, Moon, Sun, TrendingUp, BookOpen } from 'lucide-react'
import Catalog from './pages/Catalog'
import type { Aggregate } from './types'

const MapView = lazy(() => import('./pages/MapView'))
const TowerGlobe = lazy(() => import('./pages/TowerGlobe'))
const RouteProfile = lazy(() => import('./pages/RouteProfile'))

type View = 'catalog' | 'map' | 'tower' | 'profile'

export type Theme = 'dark' | 'light'

export default function App() {
  const [view, setView] = useState<View>('catalog')
  const [data, setData] = useState<Aggregate | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [theme, setTheme] = useState<Theme>(() =>
    (localStorage.getItem('metgate-theme') as Theme | null) ?? 'dark'
  )

  useEffect(() => {
    const html = document.documentElement
    if (theme === 'light') {
      html.classList.add('light')
      html.classList.remove('dark')
    } else {
      html.classList.remove('light')
      html.classList.add('dark')
    }
    localStorage.setItem('metgate-theme', theme)
  }, [theme])

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await fetch('/api/products')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setData((await r.json()) as Aggregate)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-sky-950 text-slate-100">
      <header className="sticky top-0 z-20 border-b border-slate-800/60 bg-slate-950/80 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="size-10 rounded-xl bg-gradient-to-br from-sky-400 to-cyan-600 flex items-center justify-center shadow-lg shadow-sky-500/20">
              <Cloud className="size-5 text-slate-950" strokeWidth={2.5} />
            </div>
            <div>
              <div className="text-lg font-semibold tracking-tight">MetGate Portal</div>
              <div className="text-xs text-slate-400">ATM weather services · metgate-int</div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
              title={theme === 'dark' ? 'Passer en mode clair' : 'Passer en mode sombre'}
              className="size-8 rounded-lg border border-slate-800 bg-slate-900/40 flex items-center justify-center text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 transition"
            >
              {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </button>
            <nav className="flex items-center gap-1 p-1 rounded-lg border border-slate-800 bg-slate-900/40">
              <NavButton active={view === 'catalog'} onClick={() => setView('catalog')} icon={FileText}   label="Catalogue" />
              <NavButton active={view === 'map'}     onClick={() => setView('map')}     icon={MapIcon}    label="Carte" />
              <NavButton active={view === 'tower'}   onClick={() => setView('tower')}   icon={Globe}      label="Tour 3D" />
              <NavButton active={view === 'profile'} onClick={() => setView('profile')} icon={TrendingUp} label="Profil" />
            </nav>
            <a
              href="/api/docs"
              target="_blank"
              rel="noopener noreferrer"
              title="Documentation API (OpenAPI / Swagger)"
              className="size-8 rounded-lg border border-slate-800 bg-slate-900/40 flex items-center justify-center text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 transition"
            >
              <BookOpen className="size-4" />
            </a>
          </div>
        </div>
      </header>

      {view === 'catalog' && (
        <Catalog data={data} loading={loading} error={error} onRefresh={load} />
      )}
      {view === 'map' && (
        <Suspense fallback={<Spinner />}>
          <MapView data={data} theme={theme} />
        </Suspense>
      )}
      {view === 'tower' && (
        <Suspense fallback={<Spinner />}>
          <TowerGlobe />
        </Suspense>
      )}
      {view === 'profile' && (
        <Suspense fallback={<Spinner />}>
          <RouteProfile />
        </Suspense>
      )}
    </div>
  )
}

function Spinner() {
  return (
    <div className="flex items-center justify-center py-32 text-slate-500">
      <Loader2 className="size-7 animate-spin" />
    </div>
  )
}

interface NavButtonProps {
  active: boolean
  onClick: () => void
  icon: React.ComponentType<{ className?: string }>
  label: string
}

function NavButton({ active, onClick, icon: Icon, label }: NavButtonProps) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm transition ${
        active ? 'bg-slate-800 text-slate-100 shadow-sm' : 'text-slate-400 hover:text-slate-200'
      }`}
    >
      <Icon className="size-4" />
      {label}
    </button>
  )
}
