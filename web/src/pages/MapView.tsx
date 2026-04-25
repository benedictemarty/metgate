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
import { Layers as LayersIcon, Loader2, X } from 'lucide-react'
import type { Aggregate, Family } from '../types'

interface MapViewProps {
  data: Aggregate | null
}

// MetGate WFS ne sort que du GML et on ne convertit pour l'instant que les
// Points en GeoJSON. On filtre les familles dont la géométrie est ponctuelle
// (aérodromes / observations / advisories).
//
// Les noms ici sont des *familles* (sortie de /api/products) — pas des
// FeatureTypes WFS. Le typeName réel envoyé à MetGate vient de family.latest
// (ex: "METAR_last").
const POINT_FAMILIES = new Set([
  'METAR',
  'SPECI',
  'TAF',
  'AIRMET',
  'LocalReport',
  'SIGMET',
  'VolcanicAshAdvisory',
  'VolcanicAshSIGMET',
  'TropicalCycloneAdvisory',
  'TropicalCycloneSIGMET',
  'SpaceWeatherAdvisory',
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
  data: GeoJSON.FeatureCollection
  count: number
}

interface PopupState {
  lng: number
  lat: number
  family: string
  props: Record<string, unknown>
}

export default function MapView({ data }: MapViewProps) {
  const [active, setActive] = useState<Set<string>>(() => new Set(['METAR_last']))
  const [loaded, setLoaded] = useState<Record<string, FetchedLayer>>({})
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [popup, setPopup] = useState<PopupState | null>(null)

  const candidates: Family[] = useMemo(() => {
    if (!data) return []
    // On veut que la famille soit dans la liste des points connus ET
    // qu'elle dispose d'une version interrogeable (latest non vide).
    return data.wfs.families.filter(
      (f) => POINT_FAMILIES.has(f.name) && Boolean(f.latest),
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
        const r = await fetch(
          `/api/feature?type=${encodeURIComponent(typeName)}&count=500`,
        )
        if (!r.ok) {
          const detail = await r.text()
          throw new Error(`HTTP ${r.status}: ${detail.slice(0, 80)}`)
        }
        const geo = (await r.json()) as GeoJSON.FeatureCollection
        setLoaded((prev) => ({
          ...prev,
          [name]: { data: geo, count: geo.features?.length ?? 0 },
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

  const interactiveLayerIds = useMemo(
    () => Array.from(active).map((name) => `${name}-circle`),
    [active],
  )

  const handleMapClick = (e: MapLayerMouseEvent) => {
    const f = e.features?.[0]
    if (!f) {
      setPopup(null)
      return
    }
    const layerId = f.layer?.id ?? ''
    const family = layerId.replace(/-circle$/, '')
    const geom = f.geometry as GeoJSON.Point | undefined
    const [lng, lat] = geom?.coordinates ?? [e.lngLat.lng, e.lngLat.lat]
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
              <Layer
                id={`${name}-glow`}
                type="circle"
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
    </div>
  )
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
  const icao = (props.locationIndicatorICAO as string | undefined) ?? '—'
  const obsTime = props.observationTime as string | undefined
  const tac = props.tac as string | undefined
  const status = props.status as string | undefined
  const cavok = props.cavok === true
  const fields: Array<[string, string]> = []
  const push = (label: string, key: string, suffix = '') => {
    const v = props[key]
    if (typeof v === 'string' && v !== '') fields.push([label, v + suffix])
  }
  push('T', 'airTemperature_C', '°C')
  push('Td', 'dewpointTemperature_C', '°C')
  push('QNH', 'qnh_hPa', ' hPa')
  push('Wind dir', 'windDirection_deg', '°')
  push('Wind speed', 'windSpeed_kt', ' kt')

  const s = styleFor(family)

  return (
    <div className="font-sans">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div>
          <div
            className="text-base font-semibold tracking-tight"
            style={{ color: s.color }}
          >
            {icao}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-slate-400">
            {family.replace(/_last$/, '')}
            {obsTime && ' · ' + obsTime.replace('T', ' ').replace('Z', ' UTC')}
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
      {fields.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 mt-2 text-[11px]">
          {fields.map(([k, v]) => (
            <div key={k} className="flex justify-between">
              <dt className="text-slate-500">{k}</dt>
              <dd className="text-slate-200 font-mono">{v}</dd>
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
                      <span className="text-[11px] tabular-nums text-slate-500">
                        {layer.count}
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
