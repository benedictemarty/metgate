import { useMemo, useState } from 'react'
import { useMap, Source, Layer, Marker, Popup } from 'react-map-gl/maplibre'
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Cloud,
  CloudSnow,
  Mountain,
  Plane,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Snowflake,
  Sparkles,
  Tornado,
  Wind as WindIcon,
  X,
  Zap,
  type LucideIcon,
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
  lon: number
  lat: number
  fir?: string
  waypoint_time: string
  validity_start?: string
  validity_end?: string
  waypoint_in_range: boolean
  properties?: Record<string, unknown>
}

export interface WindAtWaypoint {
  speed_kt: number
  dir_from_deg: number
  along_track_kt: number // > 0 = vent arrière (gain)
  cross_track_kt: number // > 0 = venant de la droite
}

export interface WindProfile {
  coverage_id: string
  level_pa: number
  waypoints: WindAtWaypoint[]
  along_mean_kt: number
  cross_mean_kt: number
  delta_min: number // signé : positif = gain
  gs_kt: number
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
  wind_profile?: WindProfile
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
  const [selectedEvent, setSelectedEvent] = useState<RouteEvent | null>(null)

  const submit = async () => {
    setLoading(true)
    setError(null)
    try {
      const url = `/api/route?dep=${encodeURIComponent(dep.toUpperCase())}&arr=${encodeURIComponent(arr.toUpperCase())}&fl=${fl}&gs=${gs}&events=1&wind=1`
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
            <div className="mt-2 flex items-center gap-1">
              <CtrlBtn
                onClick={() => onCursorChange(0)}
                title="Revenir au départ"
                disabled={cursorIdx <= 0}
              >
                <SkipBack className="size-3 text-emerald-200" />
              </CtrlBtn>
              <CtrlBtn
                onClick={() => onCursorChange(Math.max(0, cursorIdx - 1))}
                title="Reculer d'un waypoint"
                disabled={cursorIdx <= 0}
              >
                <ChevronLeft className="size-3 text-emerald-200" />
              </CtrlBtn>
              <CtrlBtn
                onClick={onTogglePlay}
                title={playing ? 'Pause' : 'Play'}
                size="lg"
              >
                {playing ? (
                  <Pause className="size-3.5 text-emerald-200" />
                ) : (
                  <Play className="size-3.5 text-emerald-200 translate-x-[1px]" />
                )}
              </CtrlBtn>
              <CtrlBtn
                onClick={() =>
                  onCursorChange(
                    Math.min(plan.waypoints.length - 1, cursorIdx + 1),
                  )
                }
                title="Avancer d'un waypoint"
                disabled={cursorIdx >= plan.waypoints.length - 1}
              >
                <ChevronRight className="size-3 text-emerald-200" />
              </CtrlBtn>
              <CtrlBtn
                onClick={() => onCursorChange(plan.waypoints.length - 1)}
                title="Aller à l'arrivée"
                disabled={cursorIdx >= plan.waypoints.length - 1}
              >
                <SkipForward className="size-3 text-emerald-200" />
              </CtrlBtn>
              <input
                type="range"
                min={0}
                max={plan.waypoints.length - 1}
                value={cursorIdx >= 0 ? cursorIdx : 0}
                onChange={(e) => onCursorChange(Number(e.target.value))}
                className="flex-1 accent-emerald-400 h-1 ml-1"
              />
              <span className="text-[10px] font-mono tabular-nums w-10 text-right text-slate-400">
                {cursorIdx + 1}/{plan.waypoints.length}
              </span>
            </div>

            {plan.wind_profile && (
              <WindProfilePanel
                profile={plan.wind_profile}
                cursorIdx={cursorIdx >= 0 ? cursorIdx : 0}
              />
            )}

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
              <div className="relative">
                <div
                  className="text-emerald-200 drop-shadow-[0_0_6px_rgba(16,185,129,0.7)]"
                  style={{ transform: `rotate(${bearing}deg)` }}
                >
                  <Plane className="size-6" fill="currentColor" />
                </div>
                <CockpitWarnings events={plan.events ?? []} cursorIdx={cursorIdx} />
              </div>
            </Marker>
          )}
          {plan.events && (
            <EventMarkers
              events={plan.events}
              cursorIdx={cursorIdx >= 0 ? cursorIdx : 0}
              onSelect={setSelectedEvent}
            />
          )}
          {selectedEvent && (
            <Popup
              longitude={selectedEvent.lon}
              latitude={selectedEvent.lat}
              anchor="bottom"
              offset={14}
              closeOnClick={false}
              closeButton={false}
              onClose={() => setSelectedEvent(null)}
              maxWidth="380px"
              className="metgate-popup"
            >
              <BulletinPopup
                ev={selectedEvent}
                onClose={() => setSelectedEvent(null)}
              />
            </Popup>
          )}
        </>
      )}
    </>
  )
}

// ============================================================================
// Pictogrammes "wave" : apparaissent quand l'avion approche, fade après passage
// ============================================================================

const EVENT_WINDOW = 8 // nb de waypoints autour du cursor où l'event est visible

function EventMarkers({
  events,
  cursorIdx,
  onSelect,
}: {
  events: RouteEvent[]
  cursorIdx: number
  onSelect: (ev: RouteEvent) => void
}) {
  return (
    <>
      {events.map((ev, i) => {
        const dist = Math.abs(ev.near_waypoint_idx - cursorIdx)
        if (dist > EVENT_WINDOW) return null
        // opacité dégressive ; les pictos posés à leur position restent
        // discrets (au mieux 0.55) pour ne pas concurrencer le cluster
        // d'alertes du cockpit attaché à l'avion.
        const o = Math.max(0.1, 0.55 - dist / EVENT_WINDOW * 0.5)
        return (
          <Marker
            key={`${ev.family}-${i}`}
            longitude={ev.lon}
            latitude={ev.lat}
            anchor="bottom"
          >
            <button
              type="button"
              style={{
                opacity: o,
                transition: 'opacity 200ms ease',
              }}
              className={`${triangleColorClass(ev.kind)} cursor-pointer hover:scale-125 transition-transform`}
              title={(ev.properties?.tac as string) || `${ev.label} — clic pour détail`}
              onClick={(e) => {
                e.stopPropagation()
                onSelect(ev)
              }}
            >
              {isPointKind(ev.kind) ? <ProductDot /> : <EventTriangle />}
              <div className="text-[8px] font-mono text-center -mt-0.5 text-slate-200 leading-none whitespace-nowrap">
                {triangleLabel(ev)}
              </div>
            </button>
          </Marker>
        )
      })}
    </>
  )
}

// CockpitWarnings : HUD attaché à l'avion. Cluster de gros triangles
// d'alerte pour chaque produit *redouté* (zone de phénomène) actif au
// waypoint courant — METAR/TAF/SPECI sont exclus (ce ne sont pas des
// dangers à signaler en HUD, juste des bulletins disponibles).
function CockpitWarnings({
  events,
  cursorIdx,
}: {
  events: RouteEvent[]
  cursorIdx: number
}) {
  const COCKPIT_WINDOW = 2 // ±2 waypoints : très proche de la position
  const warnings = events.filter((ev) => {
    if (isPointKind(ev.kind)) return false
    return Math.abs(ev.near_waypoint_idx - cursorIdx) <= COCKPIT_WINDOW
  })
  if (warnings.length === 0) return null
  // Tri : sévères d'abord, ensuite par kind
  warnings.sort((a, b) => severityScore(b) - severityScore(a))
  return (
    <div className="absolute left-7 top-0 flex flex-col gap-1.5 items-start">
      {warnings.map((ev, i) => (
        <WarningSign key={`${ev.family}-${i}`} ev={ev} />
      ))}
    </div>
  )
}

// WarningSign : triangle d'alerte + icône métier dedans + badge sévérité
// LGT/MOD/SEV. Le rendu est calibré pour parler immédiatement à un pilote :
//   - triangle = alerte (norme universelle)
//   - icône = phénomène (cristal=givrage, éclair=orage, vagues=turbulence...)
//   - couleur = kind (cohérence avec le reste de la carto)
//   - badge sévérité quand l'intensité est connue (intensity=1/2/3 dans
//     les properties CAT/GIVRAGE/RDT, sinon absent)
//   - drop-shadow plus intense pour SEV
function WarningSign({ ev }: { ev: RouteEvent }) {
  const Icon = phenomenonIcon(ev.kind)
  const sev = severityLabel(ev)
  const sevTone = severityTone(sev)
  const colorCls = triangleColorClass(ev.kind)
  const glowIntensity = sev === 'SEV' ? 10 : sev === 'MOD' ? 7 : 5
  return (
    <div
      className={`${colorCls} flex items-center gap-1`}
      style={{
        filter: `drop-shadow(0 0 ${glowIntensity}px ${shadowColor(ev.kind)})`,
      }}
      title={(ev.properties?.tac as string) || ev.label}
    >
      <div className="relative size-6">
        <svg viewBox="0 0 24 24" className="absolute inset-0">
          <polygon
            points="12,2 22,21 2,21"
            fill="currentColor"
            stroke="rgba(0,0,0,0.75)"
            strokeWidth={sev === 'SEV' ? 2 : 1.5}
            strokeLinejoin="round"
          />
        </svg>
        <Icon className="absolute left-1/2 top-[58%] -translate-x-1/2 -translate-y-1/2 size-3 text-slate-950" />
      </div>
      <span className="text-[9px] font-mono font-semibold text-slate-100 bg-slate-950/80 px-1 py-0.5 rounded whitespace-nowrap border border-slate-800/60 flex items-center gap-1">
        {triangleLabel(ev)}
        {sev && (
          <span
            className={`px-1 rounded text-[8px] tracking-wide ${sevTone}`}
          >
            {sev}
          </span>
        )}
      </span>
    </div>
  )
}

// phenomenonIcon : pictogramme métier à mettre dans le triangle d'alerte
function phenomenonIcon(kind: string): LucideIcon {
  if (kind === 'CAT_EURAT01') return Activity // ondes turbulence
  if (kind === 'GIVRAGE_EURAT01') return Snowflake
  if (kind === 'RDT_MSG') return Zap
  if (kind.includes('SIGMET')) return AlertOctagon
  if (kind.includes('AIRMET')) return AlertTriangle
  if (kind.includes('Volcanic')) return Mountain
  if (kind.includes('Cyclone')) return Tornado
  if (kind.includes('Space')) return Sparkles
  return AlertTriangle
}

// severityLabel : LGT / MOD / SEV / null selon l'intensity
// (convention WMO/ICAO : 1=light, 2=moderate, 3=severe)
function severityLabel(ev: RouteEvent): 'LGT' | 'MOD' | 'SEV' | null {
  const raw =
    (ev.properties?.intensity as string | undefined) ??
    (ev.properties?.severity as string | undefined)
  if (!raw) return null
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return null
  if (n >= 3) return 'SEV'
  if (n >= 2) return 'MOD'
  if (n >= 1) return 'LGT'
  return null
}

function severityScore(ev: RouteEvent): number {
  const sev = severityLabel(ev)
  if (sev === 'SEV') return 3
  if (sev === 'MOD') return 2
  if (sev === 'LGT') return 1
  return 0
}

function severityTone(sev: 'LGT' | 'MOD' | 'SEV' | null): string {
  if (sev === 'SEV') return 'bg-red-500/30 text-red-200 border border-red-400/50'
  if (sev === 'MOD') return 'bg-amber-500/30 text-amber-200 border border-amber-400/50'
  if (sev === 'LGT') return 'bg-yellow-500/20 text-yellow-200 border border-yellow-400/40'
  return 'text-slate-400'
}

// Triangle pour les ZONES de phénomène (SIGMET/AIRMET/CAT/GIVRAGE/RDT/advisory).
function EventTriangle() {
  return (
    <svg viewBox="0 0 14 14" className="size-3.5">
      <polygon
        points="7,1 13,12 1,12"
        fill="currentColor"
        stroke="rgba(0,0,0,0.6)"
        strokeWidth="1"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// Cercle pour les BULLETINS ponctuels d'aérodrome (METAR/TAF/SPECI).
function ProductDot() {
  return (
    <svg viewBox="0 0 14 14" className="size-3.5">
      <circle
        cx="7"
        cy="7"
        r="4.5"
        fill="currentColor"
        stroke="rgba(0,0,0,0.6)"
        strokeWidth="1"
      />
    </svg>
  )
}

// True si le kind correspond à un produit ponctuel (bulletin) plutôt qu'à
// une zone de phénomène. METAR/TAF/SPECI sont publiés par aérodrome → point.
// Les advisories (volcanique, cyclone, météo spatiale) sont aussi publiés
// comme points (centroide d'aérodrome ou émetteur), donc dot.
function isPointKind(k: string): boolean {
  return (
    k === 'METAR' ||
    k === 'TAF' ||
    k === 'SPECI' ||
    k === 'LocalReport' ||
    k === 'VolcanicAshAdvisory' ||
    k === 'TropicalCycloneAdvisory' ||
    k === 'SpaceWeatherAdvisory'
  )
}

function triangleLabel(ev: RouteEvent): string {
  const icao = ev.properties?.locationIndicatorICAO as string | undefined
  if (icao) return icao
  if (ev.fir) return ev.fir
  if (ev.kind === 'CAT_EURAT01') {
    const top = ev.properties?.top as string | undefined
    if (top) {
      // top en mètres → FL (1 FL = 100 ft = 30.48 m)
      const fl = Math.round(parseFloat(top) / 30.48)
      return `CAT FL${fl}`
    }
    return 'CAT'
  }
  if (ev.kind === 'GIVRAGE_EURAT01') return 'ICE'
  if (ev.kind === 'RDT_MSG') return 'TS'
  if (ev.kind.includes('SIGMET')) return 'SIG'
  if (ev.kind.includes('AIRMET')) return 'AIR'
  return ''
}

function triangleColorClass(k: string): string {
  if (k === 'METAR' || k === 'SPECI') return 'text-sky-400'
  if (k === 'TAF') return 'text-violet-400'
  if (k.includes('SIGMET')) return 'text-rose-400'
  if (k.includes('AIRMET')) return 'text-amber-400'
  if (k === 'CAT_EURAT01') return 'text-fuchsia-400'
  if (k === 'GIVRAGE_EURAT01') return 'text-cyan-300'
  if (k === 'RDT_MSG') return 'text-pink-400'
  if (k.includes('Volcanic')) return 'text-orange-400'
  return 'text-slate-300'
}

function shadowColor(k: string): string {
  if (k === 'METAR' || k === 'SPECI') return 'rgba(56,189,248,0.6)'
  if (k === 'TAF') return 'rgba(167,139,250,0.6)'
  if (k.includes('SIGMET')) return 'rgba(244,63,94,0.7)'
  if (k.includes('AIRMET')) return 'rgba(251,191,36,0.6)'
  if (k === 'CAT_EURAT01') return 'rgba(232,121,249,0.6)'
  if (k === 'GIVRAGE_EURAT01') return 'rgba(125,211,252,0.6)'
  if (k === 'RDT_MSG') return 'rgba(244,114,182,0.7)'
  return 'rgba(148,163,184,0.5)'
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
        <span>Produits rencontrés</span>
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

function CtrlBtn({
  children,
  onClick,
  title,
  disabled,
  size = 'sm',
}: {
  children: React.ReactNode
  onClick: () => void
  title: string
  disabled?: boolean
  size?: 'sm' | 'lg'
}) {
  const dim = size === 'lg' ? 'size-7' : 'size-6'
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${dim} rounded bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 flex items-center justify-center transition disabled:opacity-30 disabled:cursor-not-allowed`}
    >
      {children}
    </button>
  )
}

// ============================================================================
// Profil vent rencontré (Phase C)
// ============================================================================

function WindProfilePanel({
  profile,
  cursorIdx,
}: {
  profile: WindProfile
  cursorIdx: number
}) {
  const cur = profile.waypoints[cursorIdx]
  const meanLabel = profile.along_mean_kt >= 0
    ? `+${profile.along_mean_kt.toFixed(0)} kt arrière`
    : `${profile.along_mean_kt.toFixed(0)} kt contraire`
  const meanColor = profile.along_mean_kt >= 0 ? 'text-emerald-300' : 'text-rose-300'
  const dt = profile.delta_min
  const dtLabel =
    Math.abs(dt) < 0.5
      ? '~ neutre'
      : dt > 0
        ? `gain ${dt.toFixed(1)} min`
        : `perte ${Math.abs(dt).toFixed(1)} min`
  const dtColor = dt > 0.5 ? 'text-emerald-300' : dt < -0.5 ? 'text-rose-300' : 'text-slate-400'

  return (
    <div className="mt-2 pt-2 border-t border-slate-800/60">
      <div className="flex items-center justify-between text-[9px] uppercase tracking-wider text-slate-500 mb-1.5">
        <span className="flex items-center gap-1">
          <WindIcon className="size-3" />
          Vent FL{(Math.round(profile.level_pa / 100)).toString()}hPa
        </span>
      </div>

      {/* Moyenne sur le parcours */}
      <div className="flex items-center justify-between text-[10px] font-mono">
        <span className={meanColor}>{meanLabel}</span>
        <span className={dtColor}>{dtLabel}</span>
      </div>

      {/* Sparkline along-track */}
      <Sparkline values={profile.waypoints.map((w) => w.along_track_kt)} cursorIdx={cursorIdx} />

      {/* Vent au waypoint courant */}
      {cur && (
        <div className="mt-1.5 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px] font-mono">
          <div className="flex justify-between col-span-2">
            <span className="text-slate-500">@ avion</span>
            <span className="text-slate-200">
              {cur.speed_kt.toFixed(0)} kt @ {cur.dir_from_deg.toFixed(0)}°
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">Along</span>
            <span
              className={
                cur.along_track_kt >= 0 ? 'text-emerald-300' : 'text-rose-300'
              }
            >
              {cur.along_track_kt >= 0 ? '+' : ''}
              {cur.along_track_kt.toFixed(0)} kt
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">Cross</span>
            <span className="text-cyan-300">
              {cur.cross_track_kt >= 0 ? '+' : ''}
              {cur.cross_track_kt.toFixed(0)} kt
              <span className="text-slate-500 ml-1">
                {cur.cross_track_kt >= 0 ? '←R' : 'L→'}
              </span>
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

// Sparkline minimaliste — montre l'évolution du long-track wind sur la route.
// La position du curseur est marquée d'un trait vertical.
function Sparkline({ values, cursorIdx }: { values: number[]; cursorIdx: number }) {
  if (values.length === 0) return null
  const w = 240
  const h = 28
  const min = Math.min(...values, -10)
  const max = Math.max(...values, 10)
  const range = Math.max(20, max - min)
  const xStep = w / (values.length - 1)
  const yOf = (v: number) => h - ((v - min) / range) * h
  // Ligne zéro
  const y0 = yOf(0)
  // Path along-track
  const d = values
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * xStep).toFixed(1)},${yOf(v).toFixed(1)}`)
    .join(' ')
  // Aire positive (gain) et négative (perte)
  const dArea = `M0,${y0} ${values
    .map((v, i) => `L${(i * xStep).toFixed(1)},${yOf(v).toFixed(1)}`)
    .join(' ')} L${((values.length - 1) * xStep).toFixed(1)},${y0} Z`
  const cursorX = (cursorIdx * xStep).toFixed(1)
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-7 mt-1">
      <defs>
        <linearGradient id="sparkGrad" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="rgb(110,231,183)" stopOpacity="0.35" />
          <stop offset={`${(y0 / h) * 100}%`} stopColor="rgb(110,231,183)" stopOpacity="0" />
          <stop offset={`${(y0 / h) * 100}%`} stopColor="rgb(244,114,128)" stopOpacity="0" />
          <stop offset="100%" stopColor="rgb(244,114,128)" stopOpacity="0.35" />
        </linearGradient>
      </defs>
      <path d={dArea} fill="url(#sparkGrad)" />
      <line
        x1="0"
        x2={w}
        y1={y0}
        y2={y0}
        stroke="rgba(148,163,184,0.4)"
        strokeWidth="0.5"
        strokeDasharray="2 2"
      />
      <path d={d} fill="none" stroke="rgba(165,243,252,0.85)" strokeWidth="1.2" />
      <line
        x1={cursorX}
        x2={cursorX}
        y1="0"
        y2={h}
        stroke="rgba(110,231,183,0.9)"
        strokeWidth="1"
      />
    </svg>
  )
}

// ============================================================================
// Popup affichant le bulletin / contenu détaillé d'un produit cliqué
// ============================================================================

const POPUP_EXCLUDE_KEYS = new Set([
  'message_id',
  'gml_id',
  'ogc_fid',
  'swpid',
  'opmet_msg',
  'tac',
  'cavok',
])

function fmtKey(k: string): string {
  return k
    .replace(/_uom$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase())
}

function fmtVal(v: unknown, key: string, props: Record<string, unknown>): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  let s = String(v)
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):/)
  if (m) s = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]} UTC`
  const uom = props[`${key}_uom`]
  if (typeof uom === 'string' && uom !== '') s += ' ' + uom
  return s
}

function BulletinPopup({
  ev,
  onClose,
}: {
  ev: RouteEvent
  onClose: () => void
}) {
  const props = (ev.properties ?? {}) as Record<string, unknown>
  const tac = props.tac as string | undefined
  const cavok = props.cavok === true
  const colorCls = triangleColorClass(ev.kind)
  const headerTitle =
    (props.locationIndicatorICAO as string | undefined) ||
    (props.trackingid as string | undefined) ||
    ev.fir ||
    ev.label

  // Champs scalaires utiles à montrer (en-dehors des UUIDs et du TAC)
  const fields: Array<[string, string]> = []
  for (const [k, v] of Object.entries(props)) {
    if (POPUP_EXCLUDE_KEYS.has(k)) continue
    if (k.endsWith('_uom')) continue
    if (typeof v === 'object') continue
    const s = fmtVal(v, k, props)
    if (s !== '') fields.push([fmtKey(k), s])
  }

  return (
    <div className="font-sans text-slate-100">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div
            className={`text-base font-semibold tracking-tight truncate ${colorCls}`}
          >
            {headerTitle}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-slate-400">
            {ev.kind.replace('_last', '')}
            {ev.fir && ev.fir !== headerTitle && ` · FIR ${ev.fir}`}
          </div>
        </div>
        <button
          onClick={onClose}
          className="text-slate-500 hover:text-slate-200 transition shrink-0"
          aria-label="Fermer"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Fenêtre de validité */}
      {(ev.validity_start || ev.validity_end) && (
        <div className="text-[10px] text-slate-400 font-mono mb-2 flex justify-between gap-2">
          <span>
            {ev.validity_start
              ? ev.validity_start.replace('T', ' ').replace('Z', '')
              : '—'}
          </span>
          <span>→</span>
          <span>
            {ev.validity_end
              ? ev.validity_end.replace('T', ' ').replace('Z', '')
              : '—'}
          </span>
        </div>
      )}

      {/* Distance / position du waypoint le plus proche */}
      <div className="text-[10px] text-slate-500 font-mono mb-2 flex justify-between">
        <span>
          passage {ev.waypoint_time.replace('T', ' ').replace('Z', ' UTC')}
        </span>
        {ev.distance_nm > 0 && <span>à {ev.distance_nm.toFixed(0)} NM</span>}
      </div>

      {/* TAC en mono si dispo */}
      {tac && (
        <pre className="text-[11px] font-mono text-slate-200 bg-slate-950/70 border border-slate-800/60 rounded-md p-2 whitespace-pre-wrap break-words mb-2">
          {tac}
        </pre>
      )}

      {/* Tableau des champs scalaires */}
      {fields.length > 0 && (
        <dl className="text-[10px] max-h-56 overflow-y-auto pr-1 mb-2">
          {fields.map(([k, v]) => (
            <div
              key={k}
              className="flex justify-between gap-3 py-0.5 border-b border-slate-800/40 last:border-0"
            >
              <dt className="text-slate-500 shrink-0">{k}</dt>
              <dd
                className="text-slate-200 font-mono text-right truncate"
                title={v}
              >
                {v}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {/* Badges status */}
      <div className="flex items-center gap-2 text-[10px]">
        {cavok && (
          <span className="px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-300 border border-emerald-800/60">
            CAVOK
          </span>
        )}
        {ev.waypoint_in_range === false && (
          <span className="px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-300 border border-amber-800/60">
            Hors fenêtre
          </span>
        )}
      </div>
    </div>
  )
}
