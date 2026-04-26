import { lazy, Suspense, useEffect, useState } from 'react'
import { Cloud, FileText, Loader2, Map as MapIcon } from 'lucide-react'
import Catalog from './pages/Catalog'
import type { Aggregate } from './types'

// La page Carte embarque MapLibre (~1 MB de JS) ; on la lazy-load pour ne
// payer le coût qu'au premier passage sur l'onglet Carte.
const MapView = lazy(() => import('./pages/MapView'))

type View = 'catalog' | 'map'

export default function App() {
  const [view, setView] = useState<View>('catalog')
  const [data, setData] = useState<Aggregate | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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

  useEffect(() => {
    load()
  }, [])

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

          <nav className="flex items-center gap-1 p-1 rounded-lg border border-slate-800 bg-slate-900/40">
            <NavButton
              active={view === 'catalog'}
              onClick={() => setView('catalog')}
              icon={FileText}
              label="Catalogue"
            />
            <NavButton
              active={view === 'map'}
              onClick={() => setView('map')}
              icon={MapIcon}
              label="Carte"
            />
          </nav>
        </div>
      </header>

      {view === 'catalog' ? (
        <Catalog data={data} loading={loading} error={error} onRefresh={load} />
      ) : (
        <Suspense
          fallback={
            <div className="flex items-center justify-center py-32 text-slate-500">
              <Loader2 className="size-7 animate-spin" />
            </div>
          }
        >
          <MapView data={data} />
        </Suspense>
      )}
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
        active
          ? 'bg-slate-800 text-slate-100 shadow-sm'
          : 'text-slate-400 hover:text-slate-200'
      }`}
    >
      <Icon className="size-4" />
      {label}
    </button>
  )
}
