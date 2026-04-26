import { useMemo, useState } from 'react'
import { useMap, Source, Layer, Marker } from 'react-map-gl/maplibre'
import {
  AlertTriangle,
  Cloud,
  CloudSnow,
  Mountain,
  Plane,
  Play,
  Pause,
  Wind as WindIcon,
  X,
  Zap,
} from 'lucide-react'

export interface Waypoint {
  lon: number
  lat: number
  fl: number
  time: string
  dist_nm: number
}

export interface RouteEvent {
  kind: string
  family: string
  label: string
  near_waypoint_idx: number
  distance_nm: number
  fir?: string
  waypoint_time: string
  validity_start?: string
  validity_end?: string
  waypoint_in_range: boolean
  properties?: Record<string, unknown>
}

export interface RoutePlan {
  dep: { icao: string; lon: number; lat: number }
  arr: { icao: string; lon: number; lat: number }
  fl: number
  gs_kt: number
  dep_time: string
  arr_time: string
  distance_nm: number
  duration_min: number
  waypoints: Waypoint[]
  events?: RouteEvent[]
}

interface FlightPlanProps {
  plan: RoutePlan | null
  onPlan: (plan: RoutePlan | null) => void
  // Position courante de l'avion (interpolée par le master slider).
  // -1 si aucun (pas de master slider lié au vol).
  cursorIdx: number
  playing: boolean
  onTogglePlay: () => void
  onCursorChange: (idx: number) => void
}

export default function FlightPlan({
  plan,
  onPlan,
  cursorIdx,
  playing,
  onTogglePlay,
  onCursorChange,
}: FlightPlanProps) {
  const { current: mapRef } = useMap()
  const map = mapRef?.getMap()

  const [dep, setDep] = useState('LFPG')
  const [arr, setArr] = useState('LFBO')
  const [fl, setFL] = useState(370)
  const [gs, setGS] = useState(450)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setLoading(true)
    setError(null)
    try {
      const url = `/api/route?dep=${encodeURIComponent(dep.toUpperCase())}&arr=${encodeURIComponent(arr.toUpperCase())}&fl=${fl}&gs=${gs}&events=1`
      const r = await fetch(url)
      if (!r.ok) {
        const txt = await r.text()
        throw new Error(txt.trim() || `HTTP ${r.status}`)
      }
      const p: RoutePlan = await r.json()
      onPlan(p)
      // Centre la carte sur la trajectoire
      if (map) {
        const lons = [p.dep.lon, p.arr.lon, ...p.waypoints.map((w) => w.lon)]
        const lats = [p.dep.lat, p.arr.lat, ...p.waypoints.map((w) => w.lat)]
        map.fitBounds(
          [
            [Math.min(...lons), Math.min(...lats)],
            [Math.max(...lons), Math.max(...lats)],
          ],
          { padding: 80, duration: 600 },
        )
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const clear = () => {
    onPlan(null)
    setError(null)
  }

  // GeoJSON LineString de la trajectoire.
  const lineGeo = useMemo<GeoJSON.FeatureCollection | null>(() => {
    if (!plan) return null
    return {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: plan.waypoints.map((w) => [w.lon, w.lat]),
          },
          properties: {},
        },
      ],
    }
  }, [plan])

  const cur = plan && cursorIdx >= 0 && cursorIdx < plan.waypoints.length
    ? plan.waypoints[cursorIdx]
    : null

  // Bearing pour orienter l'icône avion (de cur vers prochain waypoint).
  const bearing = useMemo(() => {
    if (!plan || !cur) return 0
    const next = plan.waypoints[Math.min(plan.waypoints.length - 1, cursorIdx + 1)]
    if (!next || (next.lon === cur.lon && next.lat === cur.lat)) return 0
    return bearingDeg(cur.lat, cur.lon, next.lat, next.lon)
  }, [plan, cur, cursorIdx])

  return (
    <>
      {/* Form en haut-gauche, sous la sidebar WFS */}
      <div
        className={`absolute z-10 px-3 py-3 rounded-xl border backdrop-blur-md shadow-2xl transition ${
          plan
            ? 'top-4 left-[19rem] w-72 border-emerald-400/40 bg-slate-950/85'
            : 'top-4 left-[19rem] w-72 border-slate-800/70 bg-slate-950/80'
        }`}
      >
        <div className="flex items-center gap-2 mb-2">
          <Plane className="size-4 text-emerald-300" />
          <div className="text-sm font-medium">Plan de vol</div>
          {plan && (
            <button
              onClick={clear}
              className="ml-auto text-slate-500 hover:text-slate-200 transition"
              title="Effacer"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
        {!plan && (
          <div className="flex flex-col gap-2 text-[11px]">
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-0.5">
                <span className="text-slate-500 uppercase tracking-wider text-[9px]">Départ</span>
                <input
                  value={dep}
                  onChange={(e) => setDep(e.target.value.toUpperCase())}
                  maxLength={4}
                  className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800 text-slate-200 font-mono uppercase focus:outline-none focus:border-emerald-500/50"
                  placeholder="LFPG"
                />
              </label>
              <label className="flex flex-col gap-0.5">
                <span className="text-slate-500 uppercase tracking-wider text-[9px]">Arrivée</span>
                <input
                  value={arr}
                  onChange={(e) => setArr(e.target.value.toUpperCase())}
                  maxLength={4}
                  className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800 text-slate-200 font-mono uppercase focus:outline-none focus:border-emerald-500/50"
                  placeholder="LFBO"
                />
              </label>
              <label className="flex flex-col gap-0.5">
                <span className="text-slate-500 uppercase tracking-wider text-[9px]">FL</span>
                <input
                  type="number"
                  value={fl}
                  onChange={(e) => setFL(Number(e.target.value))}
                  className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800 text-slate-200 font-mono focus:outline-none focus:border-emerald-500/50"
                />
              </label>
              <label className="flex flex-col gap-0.5">
                <span className="text-slate-500 uppercase tracking-wider text-[9px]">GS (kt)</span>
                <input
                  type="number"
                  value={gs}
                  onChange={(e) => setGS(Number(e.target.value))}
                  className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800 text-slate-200 font-mono focus:outline-none focus:border-emerald-500/50"
                />
              </label>
            </div>
            <button
              onClick={submit}
              disabled={loading}
              className="mt-1 px-3 py-1.5 rounded-md bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-400/40 text-emerald-100 text-[11px] transition disabled:opacity-50"
            >
              {loading ? 'Calcul…' : 'Tracer la route'}
            </button>
            {error && (
              <div className="text-[10px] text-red-400 leading-snug">{error}</div>
            )}
          </div>
        )}
        {plan && (
          <>
            <div className="text-[11px] text-slate-200 font-mono space-y-0.5">
              <div className="flex justify-between">
                <span className="text-emerald-300">{plan.dep.icao}</span>
                <span className="text-slate-500">→</span>
                <span className="text-emerald-300">{plan.arr.icao}</span>
              </div>
              <div className="flex justify-between text-[10px] text-slate-400">
                <span>{plan.distance_nm.toFixed(0)} NM</span>
                <span>FL{plan.fl.toString().padStart(3, '0')}</span>
                <span>{plan.gs_kt.toFixed(0)} kt</span>
                <span>{Math.round(plan.duration_min)} min</span>
              </div>
            </div>
            {cur && (
              <div className="mt-2 pt-2 border-t border-slate-800/60 font-mono space-y-1">
                <div className="flex items-baseline justify-between">
                  <span className="text-emerald-200 text-base font-semibold tracking-tight tabular-nums">
                    FL{cur.fl.toString().padStart(3, '0')}
                  </span>
                  <span className="text-[10px] text-slate-400">
                    {cur.time.replace('T', ' ').replace('Z', ' UTC')}
                  </span>
                </div>
                <div className="flex justify-between text-[10px] text-slate-500">
                  <span>
                    {cur.lat.toFixed(2)}°N {cur.lon.toFixed(2)}°E
                  </span>
                  <span>{cur.dist_nm.toFixed(0)} NM</span>
                </div>
              </div>
            )}
            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={onTogglePlay}
                className="size-7 rounded bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 flex items-center justify-center transition"
              >
                {playing ? (
                  <Pause className="size-3.5 text-emerald-200" />
                ) : (
                  <Play className="size-3.5 text-emerald-200 translate-x-[1px]" />
                )}
              </button>
              <input
                type="range"
                min={0}
                max={plan.waypoints.length - 1}
                value={cursorIdx >= 0 ? cursorIdx : 0}
                onChange={(e) => onCursorChange(Number(e.target.value))}
                className="flex-1 accent-emerald-400 h-1"
              />
              <span className="text-[10px] font-mono tabular-nums w-10 text-right text-slate-400">
                {cursorIdx + 1}/{plan.waypoints.length}
              </span>
            </div>

            {plan.events && plan.events.length > 0 && (
              <EventsList
                events={plan.events}
                cursorIdx={cursorIdx}
                onJump={(i) => onCursorChange(i)}
              />
            )}
          </>
        )}
      </div>

      {/* Trajectoire + markers DEP/ARR + avion sur la carte */}
      {plan && lineGeo && (
        <Source id="metgate-route-src" type="geojson" data={lineGeo}>
          <Layer
            id="metgate-route-glow"
            type="line"
            paint={{
              'line-color': '#10b981',
              'line-width': 6,
              'line-opacity': 0.25,
              'line-blur': 2,
            }}
          />
          <Layer
            id="metgate-route-line"
            type="line"
            paint={{
              'line-color': '#10b981',
              'line-width': 2,
              'line-opacity': 0.95,
            }}
          />
        </Source>
      )}
      {plan && (
        <>
          <Marker longitude={plan.dep.lon} latitude={plan.dep.lat} anchor="center">
            <div className="size-3 rounded-full bg-emerald-400 border-2 border-emerald-200 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
          </Marker>
          <Marker longitude={plan.arr.lon} latitude={plan.arr.lat} anchor="center">
            <div className="size-3 rounded-full bg-rose-400 border-2 border-rose-200 shadow-[0_0_8px_rgba(244,63,94,0.5)]" />
          </Marker>
          {cur && (
            <Marker longitude={cur.lon} latitude={cur.lat} anchor="center">
              <div
                className="text-emerald-200 drop-shadow-[0_0_6px_rgba(16,185,129,0.7)]"
                style={{ transform: `rotate(${bearing}deg)` }}
              >
                <Plane className="size-6" fill="currentColor" />
              </div>
            </Marker>
          )}
        </>
      )}
    </>
  )
}

// bearingDeg : cap initial entre deux points en degrés (0=N, 90=E).
function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = (lat1 * Math.PI) / 180
  const p2 = (lat2 * Math.PI) / 180
  const dl = ((lon2 - lon1) * Math.PI) / 180
  const y = Math.sin(dl) * Math.cos(p2)
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)
  const b = (Math.atan2(y, x) * 180) / Math.PI
  return (b + 360) % 360
}

// ============================================================================
// Liste des événements rencontrés (Phase B)
// ============================================================================

function EventsList({
  events,
  cursorIdx,
  onJump,
}: {
  events: RouteEvent[]
  cursorIdx: number
  onJump: (idx: number) => void
}) {
  return (
    <div className="mt-2 pt-2 border-t border-slate-800/60">
      <div className="flex items-center justify-between text-[9px] uppercase tracking-wider text-slate-500 mb-1.5">
        <span>Événements rencontrés</span>
        <span className="font-mono">{events.length}</span>
      </div>
      <ul className="max-h-44 overflow-y-auto space-y-0.5 pr-1">
        {events.map((ev, i) => (
          <EventRow
            key={i}
            ev={ev}
            active={cursorIdx === ev.near_waypoint_idx}
            onClick={() => onJump(ev.near_waypoint_idx)}
          />
        ))}
      </ul>
    </div>
  )
}

function EventRow({
  ev,
  active,
  onClick,
}: {
  ev: RouteEvent
  active: boolean
  onClick: () => void
}) {
  const Icon = iconForKind(ev.kind)
  const color = colorForKind(ev.kind)
  const t = ev.waypoint_time.match(/T(\d{2}:\d{2})/)?.[1] ?? ''
  const tac = ev.properties?.tac as string | undefined
  const intensity = ev.properties?.intensity as string | undefined
  const top = ev.properties?.top as string | undefined
  const bottom = ev.properties?.bottom as string | undefined

  return (
    <li>
      <button
        onClick={onClick}
        className={`w-full text-left px-2 py-1 rounded text-[10px] transition border ${
          active
            ? 'border-emerald-400/40 bg-emerald-500/10'
            : 'border-transparent hover:bg-slate-800/40'
        }`}
        title={tac || ev.label}
      >
        <div className="flex items-center gap-1.5">
          <Icon className={`size-3 shrink-0 ${color}`} />
          <span className="font-mono text-slate-300 flex-shrink-0">{t}</span>
          <span className="font-medium text-slate-200 truncate">{ev.label}</span>
          {ev.distance_nm > 0 && (
            <span className="ml-auto text-slate-500 font-mono shrink-0">
              {ev.distance_nm.toFixed(0)} NM
            </span>
          )}
        </div>
        {(intensity || top || bottom) && (
          <div className="text-[9px] text-slate-500 font-mono pl-4 mt-0.5">
            {intensity && `int=${intensity}`}{' '}
            {bottom && top && `${(parseInt(bottom) / 0.3048 / 100).toFixed(0)}–${(parseInt(top) / 0.3048 / 100).toFixed(0)} FL`}
          </div>
        )}
      </button>
    </li>
  )
}

function iconForKind(k: string) {
  if (k === 'METAR' || k === 'SPECI') return Cloud
  if (k === 'TAF') return CloudSnow
  if (k.includes('SIGMET') || k.includes('AIRMET')) return AlertTriangle
  if (k === 'CAT_EURAT01') return WindIcon
  if (k === 'GIVRAGE_EURAT01') return CloudSnow
  if (k === 'RDT_MSG') return Zap
  if (k.includes('Volcanic')) return Mountain
  return Cloud
}

function colorForKind(k: string) {
  if (k === 'METAR' || k === 'SPECI') return 'text-sky-400'
  if (k === 'TAF') return 'text-violet-400'
  if (k.includes('SIGMET')) return 'text-rose-400'
  if (k.includes('AIRMET')) return 'text-amber-400'
  if (k === 'CAT_EURAT01') return 'text-fuchsia-400'
  if (k === 'GIVRAGE_EURAT01') return 'text-cyan-300'
  if (k === 'RDT_MSG') return 'text-pink-400'
  if (k.includes('Volcanic')) return 'text-orange-400'
  return 'text-slate-400'
}
