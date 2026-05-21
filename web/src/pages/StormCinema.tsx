import { useEffect, useMemo, useRef, useState } from 'react'
import { Map as MapGL, Source, Layer } from 'react-map-gl/maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'
import {
  AlertTriangle,
  Globe,
  MapPin,
  Pause,
  Play,
  RefreshCw,
  Wind as WindIcon,
  Zap,
} from 'lucide-react'
import WindLayer from '../components/WindLayer'
import LightningLayer from '../components/LightningLayer'
import FirLayer from '../components/FirLayer'

const DARK = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'

const VIEWS = {
  france: { longitude: 2.5, latitude: 46.5, zoom: 5.2 },
  europe: { longitude: 10,  latitude: 49,   zoom: 3.5 },
}

const STEPS = [0, 15, 30, 45, 60] as const

// Couleur par pas de prévision : T+0 (actuel) → T+60 (fantôme)
const STEP_STYLE: Record<number, { fill: string; line: string; baseOp: number }> = {
  0:  { fill: '#f472b6', line: '#ec4899', baseOp: 0.75 }, // rose    — actuel
  15: { fill: '#fb923c', line: '#f97316', baseOp: 0.50 }, // orange  — T+15
  30: { fill: '#facc15', line: '#eab308', baseOp: 0.32 }, // jaune   — T+30
  45: { fill: '#4ade80', line: '#22c55e', baseOp: 0.18 }, // vert    — T+45
  60: { fill: '#22d3ee', line: '#06b6d4', baseOp: 0.09 }, // cyan    — T+60 fantôme
}

function filterByForecast(
  geo: GeoJSON.FeatureCollection,
  stepMin: number,
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: geo.features.filter((f) => {
      const ft = (f.properties as Record<string, unknown>)?.forecasttime
      if (ft === undefined || ft === null || ft === '') return false
      const n = typeof ft === 'string' ? parseFloat(ft) : (ft as number)
      return Math.abs(n - stepMin) < 1
    }),
  }
}

export default function StormCinema() {
  const [mode, setMode] = useState<'france' | 'europe'>('france')
  const [rdt, setRdt]       = useState<GeoJSON.FeatureCollection | null>(null)
  const [sigmet, setSigmet] = useState<GeoJSON.FeatureCollection | null>(null)
  const [loading, setLoading] = useState(false)
  const [lastFetch, setLastFetch] = useState<Date | null>(null)

  const [playing, setPlaying] = useState(true)
  const [stepIdx, setStepIdx] = useState(0)

  const [showLightning, setShowLightning] = useState(true)
  const [showWind,      setShowWind]      = useState(false)
  const [showSIGMET,    setShowSIGMET]    = useState(true)
  const [showFIR,       setShowFIR]       = useState(true)

  // Pulsation du halo (0→1→0 en 2 s)
  const [pulse, setPulse] = useState(0)
  const rafRef = useRef<number>(0)
  useEffect(() => {
    const start = performance.now()
    const tick = (now: number) => {
      const t = ((now - start) % 2000) / 2000
      setPulse(Math.sin(t * Math.PI) ** 2)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [])

  // Fetch RDT + SIGMET
  const fetchData = () => {
    setLoading(true)
    Promise.all([
      fetch('/api/feature?type=RDT_MSG_last&count=2000').then(r => r.ok ? r.json() : null),
      fetch('/api/feature?type=SIGMET_last&count=200').then(r => r.ok ? r.json() : null),
    ]).then(([rdtData, sigmetData]) => {
      if (rdtData)   setRdt(rdtData)
      if (sigmetData) setSigmet(sigmetData)
      setLastFetch(new Date())
    }).catch(() => {}).finally(() => setLoading(false))
  }

  useEffect(() => { fetchData() }, [])

  // Rafraîchissement auto toutes les 5 min
  useEffect(() => {
    const id = window.setInterval(fetchData, 5 * 60 * 1000)
    return () => clearInterval(id)
  }, [])

  // Animation T+0→T+60
  useEffect(() => {
    if (!playing) return
    const id = window.setInterval(() => setStepIdx(i => (i + 1) % STEPS.length), 1100)
    return () => clearInterval(id)
  }, [playing])

  // GeoJSON filtré par pas de prévision
  const stepGeos = useMemo(() => {
    if (!rdt) return {}
    const out: Record<number, GeoJSON.FeatureCollection> = {}
    for (const s of STEPS) out[s] = filterByForecast(rdt, s)
    return out
  }, [rdt])

  const activeStep = STEPS[stepIdx]
  const activeCells = stepGeos[0]?.features.length ?? 0
  const previewCells = stepGeos[activeStep]?.features.length ?? 0
  const s = STEP_STYLE[activeStep]

  const fmtTime = (d: Date) =>
    d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) + ' UTC'

  return (
    <div className="relative h-[calc(100vh-72px)] w-full overflow-hidden bg-slate-950">
      <MapGL
        key={mode}
        initialViewState={VIEWS[mode]}
        mapStyle={DARK}
        style={{ width: '100%', height: '100%' }}
        attributionControl={{ compact: true }}
      >
        {/* ── FIR ── */}
        <FirLayer enabled={showFIR} />

        {/* ── SIGMET zones ── */}
        {showSIGMET && sigmet && (
          <Source id="sigmet-cinema" type="geojson" data={sigmet}>
            <Layer id="sc-sigmet-fill" type="fill"
              filter={['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]]}
              paint={{ 'fill-color': '#ef4444', 'fill-opacity': 0.07 }}
            />
            <Layer id="sc-sigmet-line" type="line"
              filter={['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]]}
              paint={{ 'line-color': '#ef4444', 'line-width': 1, 'line-opacity': 0.35, 'line-dasharray': [5, 3] }}
            />
          </Source>
        )}

        {/* ── Fantômes des pas futurs (du plus loin au plus proche) ── */}
        {([60, 45, 30, 15] as const).map((step) => {
          const data = stepGeos[step]
          if (!data || data.features.length === 0) return null
          const st = STEP_STYLE[step]
          return (
            <Source key={`ghost-${step}`} id={`rdt-ghost-${step}`} type="geojson" data={data}>
              <Layer id={`sc-ghost-fill-${step}`} type="fill"
                filter={['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]]}
                paint={{ 'fill-color': st.fill, 'fill-opacity': st.baseOp * 0.6 }}
              />
              <Layer id={`sc-ghost-line-${step}`} type="line"
                filter={['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]]}
                paint={{ 'line-color': st.line, 'line-width': 0.8, 'line-opacity': st.baseOp }}
              />
            </Source>
          )
        })}

        {/* ── Cellules actives (pas courant) avec halo pulsant ── */}
        {stepGeos[activeStep] && stepGeos[activeStep].features.length > 0 && (
          <Source id="rdt-active" type="geojson" data={stepGeos[activeStep]}>
            {/* Halo extérieur pulsant */}
            <Layer id="sc-active-halo" type="fill"
              filter={['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]]}
              paint={{ 'fill-color': s.fill, 'fill-opacity': 0.04 + pulse * 0.12 }}
            />
            {/* Remplissage principal */}
            <Layer id="sc-active-fill" type="fill"
              filter={['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]]}
              paint={{ 'fill-color': s.fill, 'fill-opacity': s.baseOp * (0.75 + pulse * 0.15) }}
            />
            {/* Bordure lumineuse floutée */}
            <Layer id="sc-active-glow" type="line"
              filter={['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]]}
              paint={{ 'line-color': s.line, 'line-width': 6, 'line-opacity': 0.15 + pulse * 0.2, 'line-blur': 4 }}
            />
            {/* Bordure nette */}
            <Layer id="sc-active-line" type="line"
              filter={['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]]}
              paint={{ 'line-color': s.line, 'line-width': 1.5, 'line-opacity': 0.95 }}
            />
          </Source>
        )}

        <LightningLayer enabled={showLightning} />

        <WindLayer
          enabled={showWind}
          dataset="WIND"
          level={30000}
          linkedInstant={null}
          onTimesLoaded={() => {}}
          onLoadingChange={() => {}}
        />
      </MapGL>

      {/* ── Barre supérieure ── */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2">
        {/* Mode France / Europe */}
        <div className="flex rounded-lg border border-slate-700/60 bg-slate-950/90 backdrop-blur-md overflow-hidden shadow-xl">
          {(['france', 'europe'] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)}
              className={`flex items-center gap-1.5 px-4 py-2 text-sm transition font-medium ${
                mode === m
                  ? 'bg-pink-500/25 text-pink-200 shadow-inner'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
              }`}
            >
              {m === 'france' ? <MapPin className="size-3.5" /> : <Globe className="size-3.5" />}
              {m === 'france' ? 'France' : 'Europe'}
            </button>
          ))}
        </div>

        {/* Toggles overlay */}
        {[
          { label: 'Foudre', Icon: Zap,           active: showLightning, toggle: () => setShowLightning(v => !v), color: 'rgb(250,204,21)' },
          { label: 'SIGMET', Icon: AlertTriangle,  active: showSIGMET,    toggle: () => setShowSIGMET(v => !v),   color: 'rgb(239,68,68)' },
          { label: 'Vent',   Icon: WindIcon,        active: showWind,      toggle: () => setShowWind(v => !v),     color: 'rgb(34,211,238)' },
          { label: 'FIR',    Icon: Globe,           active: showFIR,       toggle: () => setShowFIR(v => !v),      color: 'rgb(129,140,248)' },
        ].map(({ label, Icon, active, toggle, color }) => (
          <button key={label} onClick={toggle}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border backdrop-blur-md text-sm transition shadow-xl"
            style={active ? {
              borderColor: color.replace(')', ',0.5)').replace('rgb', 'rgba'),
              background:  color.replace(')', ',0.15)').replace('rgb', 'rgba'),
              color: 'white',
            } : {
              borderColor: 'rgb(51,65,85)',
              background: 'rgba(15,23,42,0.8)',
              color: 'rgb(148,163,184)',
            }}
          >
            <Icon className="size-3.5" />
            {label}
          </button>
        ))}

        {/* Rafraîchir */}
        <button onClick={fetchData} disabled={loading}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-700/60 bg-slate-950/80 text-slate-400 hover:text-slate-200 transition shadow-xl disabled:opacity-40"
          title="Rafraîchir les données"
        >
          <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* ── Compteur cellules — haut gauche ── */}
      <div className="absolute top-4 left-4 z-10 rounded-xl border border-pink-900/40 bg-slate-950/85 backdrop-blur-md px-4 py-3 shadow-2xl"
        style={{ boxShadow: `0 0 40px ${s.fill}22` }}
      >
        <div className="text-[0.5625rem] uppercase tracking-wider text-pink-400 font-semibold mb-1">
          Convection active
        </div>
        <div className="text-4xl font-bold tabular-nums leading-none" style={{ color: s.fill }}>
          {activeCells}
        </div>
        <div className="text-[0.625rem] text-slate-500 mt-0.5">cellules T+0</div>

        {activeStep > 0 && (
          <div className="mt-2 pt-2 border-t border-slate-800/50 text-[0.625rem] text-slate-400 flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ backgroundColor: s.fill }} />
            <span>T+{activeStep} min :</span>
            <span className="font-mono font-semibold" style={{ color: s.line }}>{previewCells}</span>
            <span>prévues</span>
          </div>
        )}

        {lastFetch && (
          <div className="mt-1.5 text-[0.5rem] text-slate-600">
            màj {fmtTime(lastFetch)}
          </div>
        )}
      </div>

      {/* ── Légende des pas — bas gauche ── */}
      <div className="absolute bottom-20 left-4 z-10 flex flex-col gap-1 rounded-lg border border-slate-800/60 bg-slate-950/80 backdrop-blur-md px-3 py-2 shadow-xl text-[0.5625rem]">
        {STEPS.map((step) => {
          const st = STEP_STYLE[step]
          return (
            <div key={step} className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-sm border" style={{ backgroundColor: st.fill + '66', borderColor: st.line }} />
              <span className="text-slate-400 w-8">T+{step}</span>
              <span className="text-slate-500">{step === 0 ? 'maintenant' : `+${step} min`}</span>
              <span className="tabular-nums text-slate-600 ml-auto pl-2">{stepGeos[step]?.features.length ?? 0}</span>
            </div>
          )
        })}
      </div>

      {/* ── Timeline animation — bas centre ── */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-10 flex items-center gap-3 rounded-xl border border-slate-800/70 bg-slate-950/90 backdrop-blur-md px-4 py-2.5 shadow-2xl">
        <button
          onClick={() => setPlaying(p => !p)}
          className="size-9 rounded-lg border flex items-center justify-center transition"
          style={{
            backgroundColor: s.fill + '22',
            borderColor: s.fill + '55',
          }}
        >
          {playing
            ? <Pause className="size-4" style={{ color: s.line }} />
            : <Play  className="size-4 translate-x-px" style={{ color: s.line }} />}
        </button>

        <div className="flex items-center gap-1">
          {STEPS.map((step, i) => {
            const st = STEP_STYLE[step]
            const isActive = i === stepIdx
            return (
              <button
                key={step}
                onClick={() => { setStepIdx(i); setPlaying(false) }}
                className="px-3 py-1.5 rounded-md text-[0.6875rem] font-mono tabular-nums transition border"
                style={isActive ? {
                  backgroundColor: st.fill + '28',
                  borderColor:     st.line,
                  color:           st.line,
                  boxShadow:       `0 0 14px ${st.fill}55`,
                } : {
                  backgroundColor: 'transparent',
                  borderColor:     'rgb(51,65,85)',
                  color:           'rgb(100,116,139)',
                }}
              >
                T+{step}
              </button>
            )
          })}
        </div>

        <div className="text-[0.625rem] text-slate-500 min-w-[90px] text-right">
          {activeStep === 0 ? '⬤ Maintenant' : `⊕ Dans ${activeStep} min`}
        </div>
      </div>
    </div>
  )
}
