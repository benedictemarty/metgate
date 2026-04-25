import { useEffect, useMemo, useState } from 'react'
import type { MapLayerMouseEvent } from 'maplibre-gl'
import {
  Map as MapGL,
  NavigationControl,
  Popup,
  ScaleControl,
  Source,
  Layer,
} from 'react-map-gl/maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'
import { Clock, Layers as LayersIcon, Loader2, Pause, Play, X } from 'lucide-react'
import type { Aggregate, Family } from '../types'

interface MapViewProps {
  data: Aggregate | null
}

// Familles WFS qu'on sait afficher sur la carte. Géométries supportées par
// le backend : Point, Polygon, MultiPolygon.
//
// Les noms ici sont des *familles* (sortie de /api/products) — pas des
// FeatureTypes WFS. Le typeName réel envoyé à MetGate vient de family.latest
// (ex: "METAR_last").
const MAPPABLE_FAMILIES = new Set([
  // Points (aérodromes / observations / advisories)
  'METAR',
  'SPECI',
  'TAF',
  'LocalReport',
  'VolcanicAshAdvisory',
  'TropicalCycloneAdvisory',
  'SpaceWeatherAdvisory',
  // Polygones / MultiPolygones (zones)
  'AIRMET',
  'SIGMET',
  'VolcanicAshSIGMET',
  'TropicalCycloneSIGMET',
  'CAT_EURAT01',
  'GIVRAGE_EURAT01',
  'RDT_MSG',
  'OPIC_GTD',
  'QVACIS',
])

interface LayerStyle {
  color: string
  glow: string
}

const LAYER_STYLES: Record<string, LayerStyle> = {
  METAR: { color: '#38bdf8', glow: '#0ea5e9' },
  SPECI: { color: '#22d3ee', glow: '#06b6d4' },
  TAF: { color: '#a78bfa', glow: '#8b5cf6' },
  AIRMET: { color: '#fbbf24', glow: '#f59e0b' },
  SIGMET: { color: '#f87171', glow: '#ef4444' },
  LocalReport: { color: '#34d399', glow: '#10b981' },
  Volcanic: { color: '#fb923c', glow: '#f97316' },
  Tropical: { color: '#f472b6', glow: '#ec4899' },
  Space: { color: '#c084fc', glow: '#a855f7' },
  CAT: { color: '#c084fc', glow: '#a855f7' },
  GIVRAGE: { color: '#7dd3fc', glow: '#38bdf8' },
  RDT: { color: '#f472b6', glow: '#ec4899' },
  OPIC: { color: '#94a3b8', glow: '#64748b' },
  QVACIS: { color: '#fb923c', glow: '#f97316' },
}

const styleFor = (familyName: string): LayerStyle => {
  const stripped = familyName.replace(/_last$/, '')
  for (const key of Object.keys(LAYER_STYLES)) {
    if (stripped.startsWith(key)) return LAYER_STYLES[key]
  }
  return { color: '#94a3b8', glow: '#64748b' }
}

const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'

interface FetchedLayer {
  rawData: GeoJSON.FeatureCollection // brut, contient toutes les forecasttime
  data: GeoJSON.FeatureCollection // filtré selon le step temporel courant
  count: number
  total: number
}

const FORECAST_STEPS = [0, 15, 30, 45, 60] as const
type ForecastStep = (typeof FORECAST_STEPS)[number]

function featureForecastTime(f: GeoJSON.Feature): number | null {
  const ft = (f.properties as Record<string, unknown> | null)?.forecasttime
  if (ft === undefined || ft === null || ft === '') return null
  const n = typeof ft === 'string' ? parseFloat(ft) : (ft as number)
  return Number.isFinite(n) ? n : null
}

// Filtre les features pour ne garder que celles correspondant au step
// temporel demandé. Les features sans forecasttime (cas METAR/TAF/SIGMET/...)
// passent toujours, parce qu'elles ne sont pas concernées par cette logique.
function filterByForecast(
  geo: GeoJSON.FeatureCollection,
  minutes: number,
): GeoJSON.FeatureCollection {
  return {
    ...geo,
    features: geo.features.filter((f) => {
      const ft = featureForecastTime(f)
      if (ft === null) return true
      return ft === minutes
    }),
  }
}

// True dès qu'au moins une feature chargée a une forecasttime > 0 :
// dans ce cas on affiche le slider temporel.
function hasAnyForecast(layers: Record<string, FetchedLayer>): boolean {
  for (const l of Object.values(layers)) {
    for (const f of l.rawData.features) {
      const ft = featureForecastTime(f)
      if (ft !== null && ft > 0) return true
    }
  }
  return false
}

interface PopupState {
  lng: number
  lat: number
  family: string
  props: Record<string, unknown>
}

export default function MapView({ data }: MapViewProps) {
  const [active, setActive] = useState<Set<string>>(() => new Set(['METAR']))
  const [loaded, setLoaded] = useState<Record<string, FetchedLayer>>({})
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [popup, setPopup] = useState<PopupState | null>(null)
  const [forecastMinutes, setForecastMinutes] = useState<ForecastStep>(0)
  const [playing, setPlaying] = useState(false)

  const candidates: Family[] = useMemo(() => {
    if (!data) return []
    // On veut que la famille soit dans la liste des points connus ET
    // qu'elle dispose d'une version interrogeable (latest non vide).
    return data.wfs.families.filter(
      (f) => MAPPABLE_FAMILIES.has(f.name) && Boolean(f.latest),
    )
  }, [data])

  // Map family.name → family.latest (le typeName WFS réel à interroger).
  const typeNameOf = useMemo(() => {
    const m: Record<string, string> = {}
    for (const f of candidates) {
      if (f.latest) m[f.name] = f.latest
    }
    return m
  }, [candidates])

  useEffect(() => {
    active.forEach(async (name) => {
      const typeName = typeNameOf[name]
      if (!typeName || loaded[name] || loading.has(name) || errors[name]) return
      setLoading((prev) => new Set(prev).add(name))
      try {
        // On demande large car certaines familles (RDT_MSG) renvoient ~5
        // features de prévision par cellule ; on filtre ensuite T+0 côté front.
        const r = await fetch(
          `/api/feature?type=${encodeURIComponent(typeName)}&count=2000`,
        )
        if (!r.ok) {
          const detail = await r.text()
          throw new Error(`HTTP ${r.status}: ${detail.slice(0, 80)}`)
        }
        const geo = (await r.json()) as GeoJSON.FeatureCollection
        const filtered = filterByForecast(geo, forecastMinutes)
        setLoaded((prev) => ({
          ...prev,
          [name]: {
            rawData: geo,
            data: filtered,
            count: filtered.features.length,
            total: geo.features?.length ?? 0,
          },
        }))
      } catch (e) {
        setErrors((prev) => ({
          ...prev,
          [name]: e instanceof Error ? e.message : String(e),
        }))
      } finally {
        setLoading((prev) => {
          const next = new Set(prev)
          next.delete(name)
          return next
        })
      }
    })
  }, [active, typeNameOf])

  const toggle = (name: string) => {
    setActive((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
    // Réactiver la possibilité de retenter après une erreur.
    setErrors((prev) => {
      if (!(name in prev)) return prev
      const next = { ...prev }
      delete next[name]
      return next
    })
  }

  // Re-filter chaque couche dès que le step temporel change.
  useEffect(() => {
    setLoaded((prev) => {
      const next: Record<string, FetchedLayer> = {}
      let changed = false
      for (const [name, l] of Object.entries(prev)) {
        const filtered = filterByForecast(l.rawData, forecastMinutes)
        if (filtered.features.length === l.data.features.length && filtered === l.data) {
          next[name] = l
          continue
        }
        next[name] = { ...l, data: filtered, count: filtered.features.length }
        changed = true
      }
      return changed ? next : prev
    })
  }, [forecastMinutes])

  // Animation play : avance d'un step toutes les ~1.4 s.
  useEffect(() => {
    if (!playing) return
    const id = window.setInterval(() => {
      setForecastMinutes((prev) => {
        const idx = FORECAST_STEPS.indexOf(prev)
        return FORECAST_STEPS[(idx + 1) % FORECAST_STEPS.length]
      })
    }, 1400)
    return () => window.clearInterval(id)
  }, [playing])

  const showTimeSlider = useMemo(() => hasAnyForecast(loaded), [loaded])

  const interactiveLayerIds = useMemo(() => {
    const ids: string[] = []
    active.forEach((name) => {
      ids.push(`${name}-circle`, `${name}-fill`)
    })
    return ids
  }, [active])

  const handleMapClick = (e: MapLayerMouseEvent) => {
    const f = e.features?.[0]
    if (!f) {
      setPopup(null)
      return
    }
    const layerId = f.layer?.id ?? ''
    const family = layerId.replace(/-(circle|fill)$/, '')
    // Pour les Points on prend les coords de la feature ; pour les polygones,
    // on retient le clic (centroïde approximatif suffirait, mais le clic est
    // déjà l'endroit qui intéresse l'utilisateur).
    const geom = f.geometry as GeoJSON.Geometry | undefined
    let lng = e.lngLat.lng
    let lat = e.lngLat.lat
    if (geom?.type === 'Point') {
      ;[lng, lat] = (geom as GeoJSON.Point).coordinates
    }
    setPopup({
      lng,
      lat,
      family,
      props: (f.properties ?? {}) as Record<string, unknown>,
    })
  }

  return (
    <div className="relative h-[calc(100vh-72px)] w-full overflow-hidden">
      <MapGL
        initialViewState={{ longitude: 6, latitude: 47, zoom: 4 }}
        mapStyle={MAP_STYLE}
        style={{ width: '100%', height: '100%' }}
        attributionControl={{ compact: true }}
        interactiveLayerIds={interactiveLayerIds}
        onClick={handleMapClick}
        cursor={interactiveLayerIds.length > 0 ? 'pointer' : 'grab'}
      >
        <NavigationControl position="bottom-right" />
        <ScaleControl position="bottom-left" />

        {Array.from(active).map((name) => {
          const layer = loaded[name]
          if (!layer) return null
          const s = styleFor(name)
          return (
            <Source key={name} id={`src-${name}`} type="geojson" data={layer.data}>
              {/* Polygones / multipolygones : remplissage + bordure */}
              <Layer
                id={`${name}-fill`}
                type="fill"
                filter={[
                  'in',
                  ['geometry-type'],
                  ['literal', ['Polygon', 'MultiPolygon']],
                ]}
                paint={{
                  'fill-color': s.color,
                  'fill-opacity': 0.18,
                }}
              />
              <Layer
                id={`${name}-line`}
                type="line"
                filter={[
                  'in',
                  ['geometry-type'],
                  ['literal', ['Polygon', 'MultiPolygon']],
                ]}
                paint={{
                  'line-color': s.color,
                  'line-width': 1.5,
                  'line-opacity': 0.85,
                }}
              />
              {/* Points : halo + cercle */}
              <Layer
                id={`${name}-glow`}
                type="circle"
                filter={['==', ['geometry-type'], 'Point']}
                paint={{
                  'circle-radius': 12,
                  'circle-color': s.glow,
                  'circle-opacity': 0.15,
                  'circle-blur': 0.7,
                }}
              />
              <Layer
                id={`${name}-circle`}
                type="circle"
                filter={['==', ['geometry-type'], 'Point']}
                paint={{
                  'circle-radius': 4.5,
                  'circle-color': s.color,
                  'circle-stroke-color': '#0f172a',
                  'circle-stroke-width': 1.5,
                  'circle-opacity': 0.95,
                }}
              />
            </Source>
          )
        })}

        {popup && (
          <Popup
            longitude={popup.lng}
            latitude={popup.lat}
            anchor="bottom"
            offset={14}
            closeOnClick={false}
            closeButton={false}
            onClose={() => setPopup(null)}
            maxWidth="380px"
            className="metgate-popup"
          >
            <FeaturePopup
              family={popup.family}
              props={popup.props}
              onClose={() => setPopup(null)}
            />
          </Popup>
        )}
      </MapGL>

      <Sidebar
        open={sidebarOpen}
        onToggle={() => setSidebarOpen((v) => !v)}
        candidates={candidates}
        active={active}
        loading={loading}
        loaded={loaded}
        errors={errors}
        onToggleLayer={toggle}
      />

      {showTimeSlider && (
        <TimeSlider
          value={forecastMinutes}
          onChange={(v) => {
            setForecastMinutes(v)
            setPlaying(false)
          }}
          playing={playing}
          onTogglePlay={() => setPlaying((p) => !p)}
        />
      )}
    </div>
  )
}

interface TimeSliderProps {
  value: ForecastStep
  onChange: (v: ForecastStep) => void
  playing: boolean
  onTogglePlay: () => void
}

function TimeSlider({ value, onChange, playing, onTogglePlay }: TimeSliderProps) {
  const label = value === 0 ? 'Analyse · T+0' : `Prévision · T+${value} min`
  return (
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-10 flex items-center gap-3 rounded-xl border border-slate-800/70 bg-slate-950/85 backdrop-blur-md px-3 py-2 shadow-2xl">
      <button
        onClick={onTogglePlay}
        className="size-8 rounded-lg bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/30 flex items-center justify-center transition"
        aria-label={playing ? 'Pause' : 'Play'}
      >
        {playing ? (
          <Pause className="size-4 text-sky-300" />
        ) : (
          <Play className="size-4 text-sky-300 translate-x-[1px]" />
        )}
      </button>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5 text-[11px] text-slate-300">
          <Clock className="size-3 text-slate-500" />
          <span className="font-medium tabular-nums">{label}</span>
        </div>
        <div className="flex gap-1">
          {FORECAST_STEPS.map((m) => {
            const active = value === m
            return (
              <button
                key={m}
                onClick={() => onChange(m)}
                className={`min-w-12 h-7 px-2 rounded-md text-[11px] font-mono tabular-nums transition border ${
                  active
                    ? 'bg-sky-500/25 text-sky-100 border-sky-400/50 shadow-[0_0_10px_rgba(56,189,248,0.25)]'
                    : 'bg-slate-900/60 text-slate-400 border-slate-800/60 hover:bg-slate-800/60 hover:text-slate-200'
                }`}
              >
                {m === 0 ? 'Now' : `+${m}'`}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// Champs verbeux à exclure de l'affichage générique (UUIDs, ids techniques
// MetGate, attributs déjà rendus en haut de la popup, etc.).
const POPUP_EXCLUDE_KEYS = new Set([
  'locationIndicatorICAO',
  'observationTime',
  'tac',
  'status',
  'cavok',
  'message_id',
  'gml_id',
  'ogc_fid',
  'swpid',
  'opmet_msg',
])

function fmtKey(k: string): string {
  // analysistime → Analysis time, validitystarttime → Validity start time
  return k
    .replace(/_uom$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/(time|date)\b/gi, ' $1')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase())
}

function fmtVal(v: unknown, key: string, props: Record<string, unknown>): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  let s = String(v)
  // ISO date → YYYY-MM-DD HH:mm UTC
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):/)
  if (m) s = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]} UTC`
  // Apparier <key>_uom si présent (movingspeed → m/s)
  const uom = props[`${key}_uom`]
  if (typeof uom === 'string' && uom !== '') s += ' ' + uom
  return s
}

function FeaturePopup({
  family,
  props,
  onClose,
}: {
  family: string
  props: Record<string, unknown>
  onClose: () => void
}) {
  const icao = props.locationIndicatorICAO as string | undefined
  const obsTime = props.observationTime as string | undefined
  const tac = props.tac as string | undefined
  const status = props.status as string | undefined
  const cavok = props.cavok === true

  const headerTitle = icao ?? (props.trackingid as string | undefined) ?? family.replace(/_last$/, '')
  const headerTime =
    obsTime ?? (props.timeposition as string | undefined) ?? (props.analysistime as string | undefined)

  const metarFields: Array<[string, string]> = []
  const pushMetar = (label: string, key: string, suffix = '') => {
    const v = props[key]
    if (typeof v === 'string' && v !== '') metarFields.push([label, v + suffix])
  }
  pushMetar('T', 'airTemperature_C', '°C')
  pushMetar('Td', 'dewpointTemperature_C', '°C')
  pushMetar('QNH', 'qnh_hPa', ' hPa')
  pushMetar('Wind dir', 'windDirection_deg', '°')
  pushMetar('Wind speed', 'windSpeed_kt', ' kt')

  // Toutes les autres props scalaires non exclues, hors champs *_uom
  // (déjà concaténés à leur valeur principale).
  const otherFields: Array<[string, string]> = []
  for (const [k, v] of Object.entries(props)) {
    if (POPUP_EXCLUDE_KEYS.has(k)) continue
    if (k.endsWith('_uom')) continue
    if (k.startsWith('airTemperature') || k.startsWith('dewpointTemperature')) continue
    if (k.startsWith('qnh') || k.startsWith('windDirection') || k.startsWith('windSpeed')) continue
    if (typeof v === 'object') continue
    const s = fmtVal(v, k, props)
    if (s !== '') otherFields.push([fmtKey(k), s])
  }

  const s = styleFor(family)

  return (
    <div className="font-sans">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div
            className="text-base font-semibold tracking-tight truncate"
            style={{ color: s.color }}
            title={headerTitle}
          >
            {headerTitle}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-slate-400 truncate">
            {family.replace(/_last$/, '')}
            {headerTime && ' · ' + fmtVal(headerTime, '_t', props)}
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

      {tac && (
        <pre className="text-[11px] font-mono text-slate-200 bg-slate-950/60 border border-slate-800/60 rounded-md p-2 whitespace-pre-wrap break-words">
          {tac}
        </pre>
      )}

      {metarFields.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 mt-2 text-[11px]">
          {metarFields.map(([k, v]) => (
            <div key={k} className="flex justify-between">
              <dt className="text-slate-500">{k}</dt>
              <dd className="text-slate-200 font-mono">{v}</dd>
            </div>
          ))}
        </dl>
      )}

      {otherFields.length > 0 && (
        <dl className="mt-2 text-[10px] max-h-56 overflow-y-auto pr-1">
          {otherFields.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 py-0.5 border-b border-slate-800/40 last:border-0">
              <dt className="text-slate-500 shrink-0">{k}</dt>
              <dd className="text-slate-200 font-mono text-right truncate" title={v}>
                {v}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <div className="mt-2 flex items-center gap-2 text-[10px] text-slate-500">
        {cavok && (
          <span className="px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-300 border border-emerald-800/60">
            CAVOK
          </span>
        )}
        {status && status !== 'NORMAL' && (
          <span className="px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-300 border border-amber-800/60">
            {status}
          </span>
        )}
      </div>
    </div>
  )
}

interface SidebarProps {
  open: boolean
  onToggle: () => void
  candidates: Family[]
  active: Set<string>
  loading: Set<string>
  loaded: Record<string, FetchedLayer>
  errors: Record<string, string>
  onToggleLayer: (name: string) => void
}

function Sidebar({
  open,
  onToggle,
  candidates,
  active,
  loading,
  loaded,
  errors,
  onToggleLayer,
}: SidebarProps) {
  if (!open) {
    return (
      <button
        onClick={onToggle}
        className="absolute top-4 left-4 z-10 flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-800 bg-slate-950/80 hover:bg-slate-900/80 backdrop-blur-md text-sm shadow-xl"
      >
        <LayersIcon className="size-4" />
        Couches ({active.size})
      </button>
    )
  }

  return (
    <div className="absolute top-4 left-4 bottom-4 w-72 z-10 flex flex-col rounded-xl border border-slate-800/70 bg-slate-950/80 backdrop-blur-md shadow-2xl">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800/70">
        <div className="flex items-center gap-2">
          <LayersIcon className="size-4 text-slate-400" />
          <div className="text-sm font-medium">Couches WFS</div>
        </div>
        <button
          onClick={onToggle}
          className="text-slate-500 hover:text-slate-200 transition"
          aria-label="Fermer"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="overflow-y-auto flex-1 p-2">
        {candidates.length === 0 && (
          <div className="text-xs text-slate-500 p-3">
            Aucune famille point n'a été détectée. Recharge le catalogue depuis l'onglet Catalogue.
          </div>
        )}
        <ul className="space-y-1">
          {candidates.map((f) => {
            const isActive = active.has(f.name)
            const isLoading = loading.has(f.name)
            const layer = loaded[f.name]
            const err = errors[f.name]
            const s = styleFor(f.name)
            return (
              <li key={f.name}>
                <button
                  onClick={() => onToggleLayer(f.name)}
                  className={`w-full text-left px-3 py-2 rounded-lg border transition ${
                    isActive
                      ? 'border-slate-700 bg-slate-900/80'
                      : 'border-transparent hover:bg-slate-900/40'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="size-2.5 rounded-full shrink-0"
                      style={{
                        backgroundColor: s.color,
                        boxShadow: isActive ? `0 0 10px ${s.glow}` : 'none',
                      }}
                    />
                    <span className="text-sm flex-1 truncate">{f.name}</span>
                    {isLoading && <Loader2 className="size-3 animate-spin text-slate-500" />}
                    {!isLoading && layer && isActive && (
                      <span
                        className="text-[11px] tabular-nums text-slate-500"
                        title={
                          layer.total !== layer.count
                            ? `${layer.count} affichés (analyse T+0) sur ${layer.total} reçus (incl. prévisions)`
                            : undefined
                        }
                      >
                        {layer.count}
                        {layer.total !== layer.count && (
                          <span className="text-slate-600">/{layer.total}</span>
                        )}
                      </span>
                    )}
                  </div>
                  {err && (
                    <div className="mt-1 text-[10px] text-red-400 truncate" title={err}>
                      {err}
                    </div>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      </div>

      <div className="px-4 py-3 border-t border-slate-800/70 text-[10px] text-slate-500 leading-snug">
        Fond de carte ·{' '}
        <a
          href="https://carto.com/attributions"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-slate-300"
        >
          CARTO
        </a>{' '}
        · Données ©{' '}
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-slate-300"
        >
          OpenStreetMap
        </a>
      </div>
    </div>
  )
}
