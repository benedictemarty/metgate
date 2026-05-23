import { useEffect, useRef, useState } from 'react'
import { Marker, Popup, useMap } from 'react-map-gl/maplibre'
import { AlertTriangle } from 'lucide-react'

// ─── Types ───────────────────────────────────────────────────────────────────

interface AlertSource {
  type: 'SPECI' | 'MAA' | 'RDT'
  phenomenon: string
  text: string
  forecast_min?: number
}

interface AirportAlert {
  icao: string
  lat: number
  lon: number
  level: 1 | 2 | 3 | 4
  sources: AlertSource[]
}

interface AlertsResponse {
  alerts: AirportAlert[]
  count: number
  airports_checked: number
  fetched_at: string
}

interface Props {
  enabled: boolean
}

// ─── Constantes ──────────────────────────────────────────────────────────────

const LEVEL_COLORS: Record<number, string> = {
  1: '#3b82f6', // bleu
  2: '#eab308', // jaune
  3: '#f97316', // orange
  4: '#ef4444', // rouge
}

const LEVEL_LABELS: Record<number, string> = {
  1: 'Faible',
  2: 'Modéré',
  3: 'Élevé',
  4: 'Critique',
}

const SOURCE_ICONS: Record<string, string> = {
  SPECI: '📡',
  MAA:   '⚠️',
  RDT:   '⛈',
}

const REFRESH_MS = 5 * 60_000 // 5 min

// ─── Composant ───────────────────────────────────────────────────────────────

export default function AirportAlertsLayer({ enabled }: Props) {
  // Pattern établi dans ce projet : mapWrapper?.getMap() pour l'instance MapLibre.
  const { current: mapWrapper } = useMap()
  const map = mapWrapper?.getMap()

  const [alerts, setAlerts]           = useState<AirportAlert[]>([])
  const [selected, setSelected]       = useState<AirportAlert | null>(null)
  const [status, setStatus]           = useState<'idle' | 'loading' | 'error'>('idle')
  const [lastFetch, setLastFetch]     = useState<AlertsResponse | null>(null)
  const timerRef  = useRef<ReturnType<typeof setInterval> | null>(null)
  const bboxRef   = useRef<string>('')

  const fetchAlerts = (forceMap: maplibregl.Map | null | undefined = map) => {
    if (!forceMap) return
    const b = forceMap.getBounds()
    if (!b) return
    const bbox = [
      b.getWest().toFixed(3),
      b.getSouth().toFixed(3),
      b.getEast().toFixed(3),
      b.getNorth().toFixed(3),
    ].join(',')
    if (bbox === bboxRef.current) return
    bboxRef.current = bbox

    setStatus('loading')
    fetch(`/api/alerts?bbox=${bbox}`)
      .then((r) => r.ok ? r.json() as Promise<AlertsResponse> : Promise.reject(`HTTP ${r.status}`))
      .then((d) => {
        setAlerts(d.alerts ?? [])
        setLastFetch(d)
        setStatus('idle')
      })
      .catch((e) => {
        setStatus('error')
        console.warn('AirportAlertsLayer fetch error:', e)
      })
  }

  useEffect(() => {
    if (!enabled || !map) {
      setAlerts([])
      setSelected(null)
      bboxRef.current = ''
      return
    }

    fetchAlerts(map)

    let debounce: ReturnType<typeof setTimeout> | null = null
    const onMoveEnd = () => {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        bboxRef.current = '' // forcer recalcul bbox
        fetchAlerts(map)
      }, 800)
    }
    map.on('moveend', onMoveEnd)

    timerRef.current = setInterval(() => {
      bboxRef.current = ''
      fetchAlerts(map)
    }, REFRESH_MS)

    return () => {
      map.off('moveend', onMoveEnd)
      if (debounce) clearTimeout(debounce)
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [enabled, map]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!enabled) return null

  return (
    <>
      {/* Badge de statut (toujours visible quand la couche est active) */}
      <div className="absolute top-16 left-4 z-10 px-3 py-2 rounded-lg bg-slate-950/85 backdrop-blur-md border border-red-900/40 text-[0.625rem] text-slate-300 shadow-2xl flex flex-col gap-1.5 min-w-[200px]">
        <div className="flex items-center gap-2 pb-1.5 border-b border-slate-800/60">
          <AlertTriangle className="size-3.5 text-red-300" />
          <span className="font-semibold text-red-200 uppercase tracking-wider">Alertes Aérodromes</span>
          {status === 'loading' && (
            <span className="size-1.5 rounded-full bg-sky-400 animate-pulse ml-auto" />
          )}
        </div>
        <div className="flex justify-between gap-2 font-mono">
          <span className="text-slate-500">Alertes</span>
          <span className="text-slate-200 tabular-nums font-bold">
            {alerts.length > 0
              ? <span style={{ color: LEVEL_COLORS[Math.max(...alerts.map(a => a.level))] }}>{alerts.length}</span>
              : <span className="text-slate-400">0</span>}
          </span>
        </div>
        <div className="flex justify-between gap-2 font-mono">
          <span className="text-slate-500">AD vérifiés</span>
          <span className="text-slate-300 tabular-nums">{lastFetch?.airports_checked ?? '—'}</span>
        </div>
        {lastFetch?.fetched_at && (
          <div className="flex justify-between gap-2 font-mono">
            <span className="text-slate-500">Màj</span>
            <span className="text-slate-300">{lastFetch.fetched_at.slice(11, 16)} UTC</span>
          </div>
        )}
        {status === 'error' && (
          <div className="text-red-300 italic text-[0.55rem]">Erreur de chargement</div>
        )}
        {alerts.length === 0 && status === 'idle' && lastFetch && (
          <div className="text-slate-500 italic text-[0.55rem]">Aucune alerte active</div>
        )}
        {/* Légende niveaux */}
        <div className="flex gap-2 mt-0.5 flex-wrap">
          {([4, 3, 2, 1] as const).map(l => (
            <div key={l} className="flex items-center gap-1">
              <div className="size-2 rounded-full" style={{ backgroundColor: LEVEL_COLORS[l] }} />
              <span className="text-slate-500">{LEVEL_LABELS[l]}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Marqueurs pulsants */}
      {alerts.map((alert) => {
        const color = LEVEL_COLORS[alert.level] ?? '#94a3b8'
        return (
          <Marker
            key={alert.icao}
            longitude={alert.lon}
            latitude={alert.lat}
            anchor="center"
            onClick={(e) => {
              e.originalEvent.stopPropagation()
              setSelected(selected?.icao === alert.icao ? null : alert)
            }}
          >
            <div className="relative cursor-pointer group">
              {/* Anneau pulsant externe */}
              <div
                className="absolute -inset-3 rounded-full animate-ping opacity-40 pointer-events-none"
                style={{ backgroundColor: color }}
              />
              {/* Dot central */}
              <div
                className="size-4 rounded-full border-2 border-white shadow-lg relative z-10 group-hover:scale-125 transition-transform flex items-center justify-center"
                style={{ backgroundColor: color }}
              />
              {/* Label ICAO au survol */}
              <div className="absolute -top-5 left-1/2 -translate-x-1/2 whitespace-nowrap text-[0.5rem] font-mono font-bold text-white opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none drop-shadow">
                {alert.icao}
              </div>
            </div>
          </Marker>
        )
      })}

      {/* Popup détaillée au clic */}
      {selected && (
        <Popup
          longitude={selected.lon}
          latitude={selected.lat}
          anchor="bottom"
          closeOnClick={false}
          onClose={() => setSelected(null)}
          maxWidth="220px"
        >
          <div className="p-2 text-[0.65rem] font-mono text-slate-200 bg-slate-900 rounded">
            <div className="flex items-center justify-between mb-2">
              <span className="font-bold text-sm text-white">{selected.icao}</span>
              <span
                className="px-1.5 py-0.5 rounded text-[0.6rem] font-bold"
                style={{
                  backgroundColor: LEVEL_COLORS[selected.level] + '33',
                  color: LEVEL_COLORS[selected.level],
                  border: `1px solid ${LEVEL_COLORS[selected.level]}55`,
                }}
              >
                {LEVEL_LABELS[selected.level]}
              </span>
            </div>
            <div className="space-y-1.5">
              {selected.sources.map((src, i) => (
                <div key={i} className="flex items-start gap-1.5 bg-slate-800/60 rounded px-1.5 py-1">
                  <span className="shrink-0 text-xs">{SOURCE_ICONS[src.type] ?? '•'}</span>
                  <div>
                    <div className="text-slate-300">
                      <span className="text-white font-semibold">{src.type}</span>
                      {' · '}
                      <span className="text-yellow-300">{src.phenomenon}</span>
                    </div>
                    {src.text && (
                      <div className="text-slate-400 mt-0.5">{src.text}</div>
                    )}
                    {src.forecast_min !== undefined && src.forecast_min > 0 && (
                      <div className="text-sky-400 mt-0.5">T+{src.forecast_min} min</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Popup>
      )}
    </>
  )
}
