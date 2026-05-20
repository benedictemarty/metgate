// Profil vertical d'une route : axe X = distance cumulée DEP→ARR (NM),
// axe Y = altitude (FL). Couches : tropopause, SIGMET projetés sur leur
// waypoint le plus proche, vents head/tail/cross par waypoint, profil FL
// planifié.
//
// Backend : /api/route?dep=…&arr=…&fl=…&gs=…&events=1&wind=1&tropo=1
//   - waypoints : { lon, lat, fl, time, dist_nm, tropo_alt_m? }
//   - events    : { kind, label, near_waypoint_idx, distance_nm, … }
//   - wind_profile.waypoints[i] aligné avec waypoints[i]

import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowRight, Loader2, Plane } from 'lucide-react'

// ─── Types backend ──────────────────────────────────────────────────────

interface BackendWaypoint {
  lon: number
  lat: number
  fl: number
  time: string
  dist_nm: number
  tropo_alt_m?: number
}

interface BackendWind {
  speed_kt: number
  dir_from_deg: number
  along_track_kt: number
  cross_track_kt: number
}

interface BackendEvent {
  kind: string
  family?: string
  label: string
  near_waypoint_idx: number
  distance_nm: number
  lon: number
  lat: number
  fir?: string
  waypoint_time?: string
  validity_start?: string
  validity_end?: string
  waypoint_in_range?: boolean
  properties?: Record<string, unknown>
}

interface BackendPlan {
  dep: { icao: string; lat: number; lon: number; name?: string }
  arr: { icao: string; lat: number; lon: number; name?: string }
  fl: number
  gs_kt: number
  dep_time: string
  arr_time: string
  distance_nm: number
  duration_min: number
  waypoints: BackendWaypoint[]
  events?: BackendEvent[]
  wind_profile?: {
    coverage_id: string
    level_pa: number
    waypoints: BackendWind[]
    along_mean_kt: number
    cross_mean_kt: number
    delta_min: number
    gs_kt: number
  }
}

// ─── Types display ──────────────────────────────────────────────────────

interface DisplayWaypoint {
  distNM: number
  fl: number
  lat: number
  lon: number
  etaMin: number
  windDirDeg?: number
  windSpdKt?: number
  alongTrackKt?: number
  crossTrackKt?: number
  tropoAltM?: number
}

type EventKind =
  | 'SIGMET'
  | 'AIRMET'
  | 'CAT'
  | 'GIVRAGE'
  | 'TS'
  | 'METAR'
  | 'TAF'
  | 'SPECI'
  | 'RDT'
  | 'WL'
  | 'OTHER'

// Catégories visibles par défaut. METAR/TAF/SPECI sont des observations
// ponctuelles peu pertinentes pour un profil vertical, on les masque
// initialement (l'utilisateur peut les réactiver via les toggles).
const DEFAULT_VISIBLE: EventKind[] = ['SIGMET', 'AIRMET', 'CAT', 'GIVRAGE', 'TS', 'RDT', 'WL', 'OTHER']

interface DisplayEvent {
  kind: EventKind
  label: string
  /** Plage de distance NM le long de la route. */
  distFromNM: number
  distToNM: number
  /** Plage FL (sol→FL500 si non spécifié). */
  flMin: number
  flMax: number
  /** Détails optionnels affichés au hover (top sommet, vitesse, etc.). */
  detail?: string
}

interface DisplayPlan {
  dep: string
  arr: string
  totalNM: number
  cruiseFL: number
  gsKt: number
  durMin: number
  waypoints: DisplayWaypoint[]
  events: DisplayEvent[]
}

// ─── Couleurs / styles ──────────────────────────────────────────────────

const EVENT_COLOR: Record<EventKind, { fill: string; stroke: string; text: string }> = {
  SIGMET:  { fill: 'rgba(239, 68, 68, 0.18)',  stroke: 'rgba(239, 68, 68, 0.55)',  text: '#fecaca' },
  AIRMET:  { fill: 'rgba(234, 179, 8, 0.15)',  stroke: 'rgba(234, 179, 8, 0.50)',  text: '#fde68a' },
  CAT:     { fill: 'rgba(168, 85, 247, 0.18)', stroke: 'rgba(168, 85, 247, 0.55)', text: '#e9d5ff' },
  GIVRAGE: { fill: 'rgba(56, 189, 248, 0.16)', stroke: 'rgba(56, 189, 248, 0.50)', text: '#bae6fd' },
  TS:      { fill: 'rgba(244, 114, 182, 0.18)', stroke: 'rgba(244, 114, 182, 0.55)', text: '#fbcfe8' },
  METAR:   { fill: 'rgba(34, 197, 94, 0.12)',  stroke: 'rgba(34, 197, 94, 0.45)',  text: '#bbf7d0' },
  TAF:     { fill: 'rgba(20, 184, 166, 0.12)', stroke: 'rgba(20, 184, 166, 0.45)', text: '#99f6e4' },
  SPECI:   { fill: 'rgba(14, 165, 233, 0.12)', stroke: 'rgba(14, 165, 233, 0.45)', text: '#bae6fd' },
  RDT:     { fill: 'rgba(249, 115, 22, 0.16)', stroke: 'rgba(249, 115, 22, 0.50)', text: '#fed7aa' },
  WL:      { fill: 'rgba(217, 70, 239, 0.16)', stroke: 'rgba(217, 70, 239, 0.50)', text: '#f5d0fe' },
  OTHER:   { fill: 'rgba(148, 163, 184, 0.12)', stroke: 'rgba(148, 163, 184, 0.45)', text: '#e2e8f0' },
}

// Mapping kind backend → catégorie display. Si on dispose d'un phénomène
// parsé (via enrichSIGMETLikeProps côté backend), on raffine la catégorie
// d'un SIGMET/AIRMET générique en TS / CAT / GIVRAGE — utile pour le
// filtre par catégorie (un SIGMET « turbulence forte » apparaît sous CAT).
function classifyKind(raw: string, props?: Record<string, unknown>): EventKind {
  const k = raw.toUpperCase()

  // 1. Raffinement par phénomène parsé.
  if (props) {
    const phenoRaw = props['parsed_phenomenon']
    if (typeof phenoRaw === 'string' && phenoRaw) {
      const pheno = phenoRaw.toUpperCase()
      if (
        pheno.includes('TS') ||
        pheno.includes('THUND') ||
        pheno.includes('CB ') ||
        pheno.includes('ORAGE')
      ) {
        return 'TS'
      }
      if (
        pheno.includes('TURB') ||
        pheno.includes('TURBUL') ||
        pheno.includes('CAT ')
      ) {
        return 'CAT'
      }
      if (
        pheno.includes('ICE') ||
        pheno.includes('GIVRAGE') ||
        pheno.includes('ICING')
      ) {
        return 'GIVRAGE'
      }
      if (pheno.includes('VA ') || pheno.includes('CENDRES') || pheno.includes('VOLCAN')) {
        return 'SIGMET' // VolcanicAshSIGMET reste affiché en SIGMET (couleur dédiée si on en ajoute)
      }
    }
  }

  // 2. Sinon, classification par kind brut du backend.
  if (k.includes('GIVRAGE') || k.includes('ICING')) return 'GIVRAGE'
  if (k.includes('CAT') || k.includes('TURB')) return 'CAT'
  if (k.includes('TS') || k.includes('THUNDERSTORM') || k.includes('CB')) return 'TS'
  if (k === 'METAR' || k.startsWith('METAR')) return 'METAR'
  if (k === 'TAF' || k.startsWith('TAF')) return 'TAF'
  if (k === 'SPECI' || k.startsWith('SPECI')) return 'SPECI'
  if (k.startsWith('RDT')) return 'RDT'
  if (k === 'WL' || k.startsWith('AERODROME') || k.includes('WARNING')) return 'WL'
  if (k.startsWith('AIRMET')) return 'AIRMET'
  if (k.startsWith('SIGMET')) return 'SIGMET'
  return 'OTHER'
}

// ─── Adaptation backend → display ────────────────────────────────────────

function toDisplayPlan(b: BackendPlan): DisplayPlan {
  const dep0 = b.waypoints[0]
  const depUnix = Date.parse(dep0?.time ?? b.dep_time)
  const wps: DisplayWaypoint[] = b.waypoints.map((w, i) => {
    const wind = b.wind_profile?.waypoints[i]
    return {
      distNM: w.dist_nm,
      fl: w.fl,
      lat: w.lat,
      lon: w.lon,
      etaMin: (Date.parse(w.time) - depUnix) / 60_000,
      tropoAltM: w.tropo_alt_m,
      windDirDeg: wind?.dir_from_deg,
      windSpdKt: wind?.speed_kt,
      alongTrackKt: wind?.along_track_kt,
      crossTrackKt: wind?.cross_track_kt,
    }
  })

  // Backend events : pas de plage distance/FL native. Heuristique :
  //  - distance : ±20 NM autour du waypoint le plus proche
  //  - FL : on cherche fl_min/fl_max dans properties (peu fréquent),
  //    ou bien on dérive depuis lowerboundary/unbiasedforecastupperboundary
  //    (RDT_MSG : limites verticales en m). Sinon sol→FL500.
  const totalNM = b.distance_nm
  const events: DisplayEvent[] = (b.events ?? []).map((ev) => {
    const wp = b.waypoints[ev.near_waypoint_idx] ?? b.waypoints[0]
    const center = wp?.dist_nm ?? 0
    const halfWidth = 20
    const distFromNM = Math.max(0, center - halfWidth)
    const distToNM = Math.min(totalNM, center + halfWidth)
    const props = ev.properties ?? {}
    const kind = classifyKind(ev.kind, props)

    // Limites verticales : on tente plusieurs sources, par priorité.
    let flMin = numProp(props, ['fl_min', 'lower_limit_fl', 'lower_fl']) ?? 0
    let flMax = numProp(props, ['fl_max', 'upper_limit_fl', 'upper_fl']) ?? 500
    // SIGMET / AIRMET : champs parsés du `decoded` (Plafond/Plancher).
    const parsedMin = numProp(props, ['parsed_fl_min'])
    const parsedMax = numProp(props, ['parsed_fl_max'])
    if (typeof parsedMin === 'number') flMin = parsedMin
    if (typeof parsedMax === 'number') flMax = parsedMax
    // RDT_MSG : limites en mètres (uom = m).
    const lowM = numProp(props, ['lowerboundary'])
    const topM = numProp(props, ['unbiasedforecastupperboundary'])
    if (typeof lowM === 'number') flMin = Math.max(0, lowM / 30.48 / 100)
    if (typeof topM === 'number') flMax = Math.min(500, topM / 30.48 / 100)

    const detail = buildEventDetail(kind, props)
    return {
      kind,
      label: ev.label || ev.kind,
      distFromNM,
      distToNM,
      flMin,
      flMax,
      detail,
    }
  })

  return {
    dep: b.dep.icao,
    arr: b.arr.icao,
    totalNM,
    cruiseFL: b.fl,
    gsKt: b.gs_kt,
    durMin: b.duration_min,
    waypoints: wps,
    events,
  }
}

function numProp(props: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = props[k]
    if (typeof v === 'number') return v
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  }
  return undefined
}

function strProp(props: Record<string, unknown>, key: string): string | undefined {
  const v = props[key]
  return typeof v === 'string' && v ? v : undefined
}

// buildEventDetail construit une ligne d'info compacte pour le tooltip,
// adaptée au type d'événement.
function buildEventDetail(kind: EventKind, p: Record<string, unknown>): string | undefined {
  const parts: string[] = []
  if (kind === 'RDT') {
    const top = numProp(p, ['unbiasedforecastupperboundary'])
    const topMax = numProp(p, ['maxforecastupperboundary'])
    const cl = numProp(p, ['confidencelevel'])
    const sev = numProp(p, ['severity'])
    const hail = strProp(p, 'hail')
    const ice = strProp(p, 'iceicingrisk')
    const trend = strProp(p, 'trendarea')
    const mDir = numProp(p, ['movingdirection'])
    const mSpd = numProp(p, ['movingspeed'])
    if (typeof top === 'number') parts.push(`top FL${Math.round(top / 30.48 / 100)}`)
    if (typeof topMax === 'number') parts.push(`max FL${Math.round(topMax / 30.48 / 100)}`)
    if (typeof cl === 'number') parts.push(`conf ${cl}/3`)
    if (typeof sev === 'number') parts.push(`sév ${sev}`)
    if (hail === 'true') parts.push('grêle')
    if (ice && ice !== 'unknown') parts.push(`ice ${ice}`)
    if (trend && trend !== 'constant') parts.push(trend)
    if (typeof mDir === 'number' && typeof mSpd === 'number') {
      parts.push(`${Math.round(mDir)}°/${Math.round(mSpd * 1.94384)}kt`)
    }
  } else if (kind === 'CAT' || kind === 'GIVRAGE') {
    const inten = strProp(p, 'intensity')
    const cat = strProp(p, 'cattype')
    if (inten) parts.push(inten)
    if (cat) parts.push(cat)
  } else if (kind === 'SIGMET' || kind === 'AIRMET' || kind === 'TS') {
    const fir = strProp(p, 'issuingAirTrafficServicesRegion')
    const pheno = strProp(p, 'parsed_phenomenon')
    const evol = strProp(p, 'parsed_evolution')
    const dir = numProp(p, ['parsed_movement_dir_deg'])
    const spd = numProp(p, ['parsed_movement_speed_kt'])
    const sev = strProp(p, 'severity') ?? numProp(p, ['severity'])
    if (fir) parts.push(`FIR ${fir}`)
    if (pheno) parts.push(pheno)
    if (typeof dir === 'number' && typeof spd === 'number') {
      parts.push(`${Math.round(dir)}°/${Math.round(spd)}kt`)
    }
    if (evol) parts.push(evol)
    if (sev !== undefined) parts.push(`sév ${sev}`)
  } else if (kind === 'METAR' || kind === 'SPECI' || kind === 'TAF') {
    const tac = strProp(p, 'tac')
    if (tac) return tac.length > 80 ? tac.slice(0, 77) + '…' : tac
  }
  return parts.length > 0 ? parts.join(' · ') : undefined
}

// ─── Composant page ─────────────────────────────────────────────────────

export default function RouteProfile() {
  const [dep, setDep] = useState('LFPG')
  const [arr, setArr] = useState('LFBO')
  const [cruiseFL, setCruiseFL] = useState(370)
  const [gsKt, setGsKt] = useState(450)
  // Heure de départ : par défaut "maintenant" arrondi au quart d'heure
  // suivant. Format datetime-local (heure locale du navigateur, sans
  // timezone). On la convertit en ISO UTC au moment du fetch.
  const [depTime, setDepTime] = useState(() => {
    const d = new Date()
    d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  })
  const [plan, setPlan] = useState<DisplayPlan | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hover, setHover] = useState<{ x: number; y: number; wp: DisplayWaypoint } | null>(null)
  const [enabledKinds, setEnabledKinds] = useState<Set<EventKind>>(
    () => new Set(DEFAULT_VISIBLE),
  )
  const reqIdRef = useRef(0)

  const fetchPlan = async () => {
    const myId = ++reqIdRef.current
    setLoading(true)
    setError(null)
    try {
      // datetime-local est en heure locale ; on convertit en ISO UTC pour
      // le backend (RFC3339).
      let depTimeISO = ''
      if (depTime) {
        const t = new Date(depTime)
        if (!Number.isNaN(t.getTime())) depTimeISO = t.toISOString()
      }
      const url =
        `/api/route?dep=${encodeURIComponent(dep)}&arr=${encodeURIComponent(arr)}` +
        `&fl=${cruiseFL}&gs=${gsKt}&events=1&wind=1&tropo=1` +
        (depTimeISO ? `&dep_time=${encodeURIComponent(depTimeISO)}` : '')
      const r = await fetch(url)
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`)
      const data = (await r.json()) as BackendPlan
      if (myId !== reqIdRef.current) return // requête obsolète, on a déjà relancé
      setPlan(toDisplayPlan(data))
    } catch (e) {
      if (myId !== reqIdRef.current) return
      setError(e instanceof Error ? e.message : String(e))
      setPlan(null)
    } finally {
      if (myId === reqIdRef.current) setLoading(false)
    }
  }

  // Premier tracé au montage.
  useEffect(() => {
    fetchPlan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <main className="max-w-[1400px] mx-auto px-6 py-6">
      <div className="mb-4 flex items-end gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Profil vertical de route</h1>
          <p className="text-xs text-slate-400">
            Coupe altitude × distance · vent, tropopause et hazards projetés sur la trajectoire
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3 text-xs">
          <Field label="Départ" value={dep} onChange={setDep} width="w-20" />
          <Field label="Arrivée" value={arr} onChange={setArr} width="w-20" />
          <NumField label="FL cruise" value={cruiseFL} onChange={setCruiseFL} step={10} min={0} max={500} />
          <NumField label="GS (kt)" value={gsKt} onChange={setGsKt} step={10} min={100} max={600} />
          <label className="flex flex-col gap-0.5">
            <span className="text-[0.625rem] uppercase tracking-wider text-slate-500">
              Heure départ (locale)
            </span>
            <input
              type="datetime-local"
              value={depTime}
              onChange={(e) => setDepTime(e.target.value)}
              className="px-2 py-1 rounded bg-slate-900 border border-slate-800 text-slate-100 font-mono text-sm focus:outline-none focus:border-emerald-500/50"
            />
          </label>
          <button
            onClick={fetchPlan}
            disabled={loading}
            className="px-3 py-1.5 rounded-md bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-200 transition disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="size-3 inline mr-1 animate-spin" />
            ) : (
              <Plane className="size-3 inline mr-1" />
            )}
            Tracer
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-red-900/50 bg-red-950/30 px-4 py-3 text-sm text-red-300">
          <AlertTriangle className="size-4 inline mr-2" />
          {error}
        </div>
      )}

      {plan && (
        <KindFilters
          plan={plan}
          enabled={enabledKinds}
          onToggle={(k) => {
            const next = new Set(enabledKinds)
            if (next.has(k)) next.delete(k)
            else next.add(k)
            setEnabledKinds(next)
          }}
          onAll={() => setEnabledKinds(new Set(plan.events.map((e) => e.kind)))}
          onNone={() => setEnabledKinds(new Set())}
        />
      )}

      {plan ? (
        <ProfileChart plan={plan} enabledKinds={enabledKinds} hover={hover} setHover={setHover} />
      ) : !error ? (
        <div className="rounded-xl border border-slate-800/60 bg-slate-950/40 h-[520px] flex items-center justify-center text-slate-500">
          {loading ? <Loader2 className="size-6 animate-spin" /> : 'Aucun plan tracé'}
        </div>
      ) : null}

      {plan && (
        <div className="mt-3 flex items-center justify-between text-[0.6875rem] text-slate-400">
          <div className="flex items-center gap-3">
            <span className="font-mono text-slate-300">{plan.dep} → {plan.arr}</span>
            <span>·</span>
            <span>{Math.round(plan.totalNM)} NM</span>
            <span>·</span>
            <span>FL{plan.cruiseFL}</span>
            <span>·</span>
            <span>GS {plan.gsKt} kt</span>
            <span>·</span>
            <span>ETA total {Math.round(plan.durMin)} min</span>
            {plan.events.length > 0 && (
              <>
                <span>·</span>
                <span>{plan.events.length} événement(s)</span>
              </>
            )}
          </div>
          <Legend />
        </div>
      )}

      {plan && <EventsList plan={plan} enabled={enabledKinds} />}
    </main>
  )
}

// ─── Graphe SVG ─────────────────────────────────────────────────────────

interface ChartProps {
  plan: DisplayPlan
  enabledKinds: Set<EventKind>
  hover: { x: number; y: number; wp: DisplayWaypoint } | null
  setHover: (h: { x: number; y: number; wp: DisplayWaypoint } | null) => void
}

const W = 1340
const H = 520
const M = { top: 30, right: 60, bottom: 50, left: 70 }
const PLOT_W = W - M.left - M.right
const PLOT_H = H - M.top - M.bottom
const FL_MAX = 500

function ProfileChart({ plan, enabledKinds, hover, setHover }: ChartProps) {
  const visibleEvents = useMemo(
    () => plan.events.filter((e) => enabledKinds.has(e.kind)),
    [plan, enabledKinds],
  )
  const xScale = (nm: number) => M.left + (nm / Math.max(1, plan.totalNM)) * PLOT_W
  const yScale = (fl: number) => M.top + (1 - fl / FL_MAX) * PLOT_H

  const flPath = useMemo(
    () => plan.waypoints.map((w) => `${xScale(w.distNM)},${yScale(w.fl)}`).join(' '),
    [plan, xScale, yScale],
  )

  const tropoPoints = useMemo(
    () =>
      plan.waypoints.filter((w) => typeof w.tropoAltM === 'number') as Array<
        DisplayWaypoint & { tropoAltM: number }
      >,
    [plan],
  )

  const tropoPath = useMemo(
    () =>
      tropoPoints.map((w) => `${xScale(w.distNM)},${yScale((w.tropoAltM / 30.48) / 100)}`).join(' '),
    [tropoPoints, xScale, yScale],
  )

  const tropoArea = useMemo(() => {
    if (tropoPoints.length < 2) return ''
    const pts = tropoPoints.map(
      (w) => `${xScale(w.distNM)},${yScale((w.tropoAltM / 30.48) / 100)}`,
    )
    const top = `${xScale(plan.totalNM)},${yScale(FL_MAX)} ${xScale(0)},${yScale(FL_MAX)}`
    return `M ${pts.join(' L ')} L ${top} Z`
  }, [tropoPoints, plan, xScale, yScale])

  // Tick distance auto.
  const distTicks = useMemo(() => {
    const tickEvery = plan.totalNM > 600 ? 100 : plan.totalNM > 200 ? 50 : 25
    const ticks: number[] = []
    for (let d = 0; d <= plan.totalNM; d += tickEvery) ticks.push(d)
    if (ticks[ticks.length - 1] !== plan.totalNM) ticks.push(Math.round(plan.totalNM))
    return ticks
  }, [plan.totalNM])

  return (
    <div
      className="relative rounded-xl border border-slate-800/60 bg-slate-950/40 overflow-hidden"
      onMouseLeave={() => setHover(null)}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        className="w-full h-auto"
      >
        <defs>
          <linearGradient id="sky" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#0c4a6e" stopOpacity="0.45" />
            <stop offset="55%" stopColor="#0c1e3a" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#020617" stopOpacity="0.65" />
          </linearGradient>
          <linearGradient id="strato" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#1e293b" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#0c4a6e" stopOpacity="0.10" />
          </linearGradient>
          <marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 z" fill="currentColor" />
          </marker>
        </defs>

        <rect x={M.left} y={M.top} width={PLOT_W} height={PLOT_H} fill="url(#sky)" />

        {tropoArea && <path d={tropoArea} fill="url(#strato)" />}

        {[0, 100, 200, 300, 400, 500].map((fl) => (
          <g key={fl}>
            <line
              x1={M.left}
              x2={W - M.right}
              y1={yScale(fl)}
              y2={yScale(fl)}
              stroke="#1e293b"
              strokeDasharray="2 4"
            />
            <text x={M.left - 8} y={yScale(fl) + 4} textAnchor="end" fontSize="11" fill="#64748b">
              FL{fl}
            </text>
          </g>
        ))}

        {distTicks.map((d) => (
          <g key={d}>
            <line
              x1={xScale(d)}
              x2={xScale(d)}
              y1={M.top}
              y2={H - M.bottom}
              stroke="#1e293b"
              strokeDasharray="2 4"
            />
            <text
              x={xScale(d)}
              y={H - M.bottom + 16}
              textAnchor="middle"
              fontSize="11"
              fill="#64748b"
            >
              {d}
            </text>
          </g>
        ))}

        <text
          x={M.left - 50}
          y={M.top + PLOT_H / 2}
          fontSize="11"
          fill="#94a3b8"
          transform={`rotate(-90 ${M.left - 50} ${M.top + PLOT_H / 2})`}
          textAnchor="middle"
        >
          Niveau de vol
        </text>
        <text x={M.left + PLOT_W / 2} y={H - 10} fontSize="11" fill="#94a3b8" textAnchor="middle">
          Distance depuis {plan.dep} (NM)
        </text>

        {visibleEvents.map((ev, i) => {
          const x1 = xScale(ev.distFromNM)
          const x2 = xScale(ev.distToNM)
          const y1 = yScale(ev.flMax)
          const y2 = yScale(ev.flMin)
          const c = EVENT_COLOR[ev.kind]
          return (
            <g key={i}>
              <title>
                {`${ev.kind} · ${ev.label}\nFL${Math.round(ev.flMin)}–FL${Math.round(ev.flMax)}`}
                {ev.detail ? `\n${ev.detail}` : ''}
              </title>
              <rect
                x={x1}
                y={y1}
                width={Math.max(2, x2 - x1)}
                height={Math.max(2, y2 - y1)}
                fill={c.fill}
                stroke={c.stroke}
                strokeWidth="1"
                strokeDasharray="3 3"
                rx="2"
              />
              <text
                x={(x1 + x2) / 2}
                y={y1 + 12}
                fontSize="10"
                fill={c.text}
                textAnchor="middle"
                style={{ pointerEvents: 'none' }}
              >
                {ev.label.length > 26 ? `${ev.label.slice(0, 24)}…` : ev.label}
              </text>
            </g>
          )
        })}

        {tropoPath && (
          <polyline
            points={tropoPath}
            fill="none"
            stroke="#facc15"
            strokeWidth="1.5"
            strokeDasharray="6 3"
          />
        )}
        {tropoPath && tropoPoints.length > 0 && (
          <text
            x={xScale(plan.totalNM) - 4}
            y={yScale((tropoPoints[tropoPoints.length - 1].tropoAltM / 30.48) / 100) - 6}
            fontSize="10"
            fill="#facc15"
            textAnchor="end"
          >
            tropopause
          </text>
        )}

        <polyline
          points={flPath}
          fill="none"
          stroke="#34d399"
          strokeWidth="2.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {plan.waypoints.map((w, i) => {
          if (typeof w.windSpdKt !== 'number' || typeof w.windDirDeg !== 'number') return null
          if (w.windSpdKt < 5) return null
          const cx = xScale(w.distNM)
          const cy = yScale(w.fl) - 14
          const along = w.alongTrackKt ?? 0
          const len = Math.min(40, Math.abs(along) * 0.5)
          const dir = along >= 0 ? 1 : -1
          const color = along >= 0 ? '#86efac' : '#fca5a5'
          return (
            <g key={i} style={{ color }}>
              <line
                x1={cx - dir * (len / 2)}
                y1={cy}
                x2={cx + dir * (len / 2)}
                y2={cy}
                stroke={color}
                strokeWidth="2"
                markerEnd="url(#arrow)"
              />
              <text x={cx} y={cy - 6} fontSize="9" fill={color} textAnchor="middle">
                {Math.round(w.windSpdKt)}
              </text>
            </g>
          )
        })}

        {plan.waypoints.map((w, i) => (
          <circle
            key={i}
            cx={xScale(w.distNM)}
            cy={yScale(w.fl)}
            r="4"
            fill="#0f172a"
            stroke="#34d399"
            strokeWidth="2"
          />
        ))}

        <rect
          x={M.left}
          y={M.top}
          width={PLOT_W}
          height={PLOT_H}
          fill="transparent"
          onMouseMove={(e) => {
            const svg = e.currentTarget.ownerSVGElement!
            const pt = svg.createSVGPoint()
            pt.x = e.clientX
            pt.y = e.clientY
            const ctm = svg.getScreenCTM()
            if (!ctm) return
            const p = pt.matrixTransform(ctm.inverse())
            const nm = ((p.x - M.left) / PLOT_W) * plan.totalNM
            let nearest = plan.waypoints[0]
            let bestD = Number.POSITIVE_INFINITY
            for (const w of plan.waypoints) {
              const d = Math.abs(w.distNM - nm)
              if (d < bestD) {
                bestD = d
                nearest = w
              }
            }
            setHover({ x: xScale(nearest.distNM), y: yScale(nearest.fl), wp: nearest })
          }}
        />

        {hover && (
          <g>
            <line
              x1={hover.x}
              x2={hover.x}
              y1={M.top}
              y2={H - M.bottom}
              stroke="#475569"
              strokeWidth="1"
              strokeDasharray="3 3"
            />
            <circle cx={hover.x} cy={hover.y} r="6" fill="#34d399" stroke="#0f172a" strokeWidth="2" />
          </g>
        )}
      </svg>

      {hover && (
        <div
          className="absolute pointer-events-none rounded-lg border border-slate-700/80 bg-slate-950/95 backdrop-blur px-3 py-2 text-[0.6875rem] shadow-2xl"
          style={{
            left: `${(hover.x / W) * 100}%`,
            top: `${(hover.y / H) * 100}%`,
            transform: 'translate(12px, -50%)',
          }}
        >
          <div className="flex items-center gap-2 mb-1">
            <span className="font-mono text-slate-100">{Math.round(hover.wp.distNM)} NM</span>
            <span className="text-slate-500">·</span>
            <span className="font-mono text-emerald-300">FL{hover.wp.fl}</span>
            <span className="text-slate-500">·</span>
            <span className="font-mono text-slate-400">+{Math.round(hover.wp.etaMin)} min</span>
          </div>
          <div className="text-slate-400 font-mono text-[0.625rem]">
            {hover.wp.lat.toFixed(2)}°N / {hover.wp.lon.toFixed(2)}°E
          </div>
          {typeof hover.wp.windSpdKt === 'number' && (
            <div className="mt-1 flex items-center gap-2">
              <span className="text-slate-500">Vent</span>
              <span className="font-mono text-slate-200">
                {Math.round(hover.wp.windDirDeg ?? 0)}° / {Math.round(hover.wp.windSpdKt)} kt
              </span>
            </div>
          )}
          {typeof hover.wp.alongTrackKt === 'number' && (
            <div className="flex items-center gap-2 text-[0.625rem]">
              <span className="text-slate-500">Composante</span>
              <span className={`font-mono ${hover.wp.alongTrackKt >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                {hover.wp.alongTrackKt >= 0 ? '+' : ''}
                {Math.round(hover.wp.alongTrackKt)} kt {hover.wp.alongTrackKt >= 0 ? 'tail' : 'head'}
              </span>
              {typeof hover.wp.crossTrackKt === 'number' && (
                <>
                  <span className="text-slate-500">/</span>
                  <span className="font-mono text-slate-300">
                    {Math.round(hover.wp.crossTrackKt)} kt cross
                  </span>
                </>
              )}
            </div>
          )}
          {typeof hover.wp.tropoAltM === 'number' && (
            <div className="text-[0.625rem]">
              <span className="text-slate-500">Tropo </span>
              <span className="font-mono text-amber-300">
                {(hover.wp.tropoAltM / 1000).toFixed(1)} km · FL{Math.round(hover.wp.tropoAltM / 30.48 / 100)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Légende ────────────────────────────────────────────────────────────

function Legend() {
  return (
    <div className="flex items-center gap-3">
      <LegendItem color="#34d399" label="Profil FL" />
      <LegendItem color="#facc15" label="Tropopause" dashed />
      <LegendChip kind="CAT" />
      <LegendChip kind="TS" />
      <LegendChip kind="GIVRAGE" />
      <span className="flex items-center gap-1 text-[0.625rem]">
        <ArrowRight className="size-3 text-emerald-300" />
        <span className="text-slate-400">tail</span>
        <ArrowRight className="size-3 text-rose-300 rotate-180" />
        <span className="text-slate-400">head</span>
      </span>
    </div>
  )
}

function LegendItem({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="flex items-center gap-1 text-[0.625rem] text-slate-300">
      <svg width="22" height="6" className="inline">
        <line
          x1="0"
          x2="22"
          y1="3"
          y2="3"
          stroke={color}
          strokeWidth="2"
          strokeDasharray={dashed ? '4 2' : undefined}
        />
      </svg>
      {label}
    </span>
  )
}

function LegendChip({ kind }: { kind: EventKind }) {
  const c = EVENT_COLOR[kind]
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded text-[0.5625rem] font-medium"
      style={{ backgroundColor: c.fill, border: `1px solid ${c.stroke}`, color: c.text }}
    >
      {kind}
    </span>
  )
}

// ─── Liste des événements croisés ──────────────────────────────────────

function EventsList({ plan, enabled }: { plan: DisplayPlan; enabled: Set<EventKind> }) {
  const visible = plan.events.filter((e) => enabled.has(e.kind))
  if (visible.length === 0) return null
  // Tri par distance depuis le départ.
  const sorted = [...visible].sort(
    (a, b) => (a.distFromNM + a.distToNM) / 2 - (b.distFromNM + b.distToNM) / 2,
  )
  return (
    <div className="mt-4 rounded-lg border border-slate-800/60 bg-slate-950/30">
      <div className="px-3 py-2 border-b border-slate-800/60 text-[0.625rem] uppercase tracking-wider text-slate-500">
        Événements croisés ({sorted.length})
      </div>
      <div className="divide-y divide-slate-800/40 max-h-64 overflow-y-auto">
        {sorted.map((ev, i) => {
          const c = EVENT_COLOR[ev.kind]
          const center = (ev.distFromNM + ev.distToNM) / 2
          return (
            <div key={i} className="px-3 py-2 flex items-start gap-3 text-[0.6875rem] hover:bg-slate-900/30">
              <span
                className="inline-flex shrink-0 items-center px-1.5 py-0.5 rounded text-[0.5625rem] font-medium"
                style={{ backgroundColor: c.fill, border: `1px solid ${c.stroke}`, color: c.text }}
              >
                {ev.kind}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="font-medium text-slate-200">{ev.label}</span>
                  <span className="font-mono text-slate-500 text-[0.625rem]">
                    {Math.round(center)} NM · FL{Math.round(ev.flMin)}–FL{Math.round(ev.flMax)}
                  </span>
                </div>
                {ev.detail && (
                  <div className="mt-0.5 text-[0.625rem] text-slate-400">{ev.detail}</div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Filtres par catégorie de produit ──────────────────────────────────

function KindFilters({
  plan,
  enabled,
  onToggle,
  onAll,
  onNone,
}: {
  plan: DisplayPlan
  enabled: Set<EventKind>
  onToggle: (k: EventKind) => void
  onAll: () => void
  onNone: () => void
}) {
  // Compteur par catégorie présente dans le plan.
  const counts = useMemo(() => {
    const m = new Map<EventKind, number>()
    for (const ev of plan.events) m.set(ev.kind, (m.get(ev.kind) ?? 0) + 1)
    return m
  }, [plan.events])

  if (counts.size === 0) {
    return (
      <div className="mb-2 text-[0.625rem] text-slate-500">
        Aucun produit croisant la route.
      </div>
    )
  }

  // Ordre stable, hazards d'abord.
  const order: EventKind[] = [
    'SIGMET',
    'AIRMET',
    'TS',
    'CAT',
    'GIVRAGE',
    'WL',
    'RDT',
    'METAR',
    'TAF',
    'SPECI',
    'OTHER',
  ]
  const present = order.filter((k) => counts.has(k))

  return (
    <div className="mb-2 flex items-center gap-2 flex-wrap">
      <span className="text-[0.625rem] uppercase tracking-wider text-slate-500">
        Produits affichés
      </span>
      {present.map((k) => {
        const c = EVENT_COLOR[k]
        const on = enabled.has(k)
        return (
          <button
            key={k}
            onClick={() => onToggle(k)}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[0.625rem] font-medium transition"
            style={{
              backgroundColor: on ? c.fill : 'transparent',
              border: `1px solid ${on ? c.stroke : 'rgba(71, 85, 105, 0.5)'}`,
              color: on ? c.text : '#64748b',
            }}
          >
            {k}
            <span className="font-mono opacity-70">{counts.get(k)}</span>
          </button>
        )
      })}
      <span className="text-slate-700">·</span>
      <button
        onClick={onAll}
        className="text-[0.625rem] text-slate-400 hover:text-slate-200 transition"
      >
        tout
      </button>
      <button
        onClick={onNone}
        className="text-[0.625rem] text-slate-400 hover:text-slate-200 transition"
      >
        aucun
      </button>
    </div>
  )
}

// ─── Inputs ─────────────────────────────────────────────────────────────

function Field({
  label,
  value,
  onChange,
  width,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  width: string
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[0.625rem] uppercase tracking-wider text-slate-500">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        className={`${width} px-2 py-1 rounded bg-slate-900 border border-slate-800 text-slate-100 font-mono text-sm focus:outline-none focus:border-emerald-500/50`}
      />
    </label>
  )
}

function NumField({
  label,
  value,
  onChange,
  step,
  min,
  max,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  step: number
  min: number
  max: number
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[0.625rem] uppercase tracking-wider text-slate-500">{label}</span>
      <input
        type="number"
        value={value}
        step={step}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-20 px-2 py-1 rounded bg-slate-900 border border-slate-800 text-slate-100 font-mono text-sm focus:outline-none focus:border-emerald-500/50"
      />
    </label>
  )
}
