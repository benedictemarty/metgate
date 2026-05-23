import { useEffect, useRef, useState } from 'react'
import { Marker, Popup, useMap } from 'react-map-gl/maplibre'

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
  level: 1 | 2 | 3 | 4 // Blue/Yellow/Orange/Red
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
  1: '#3b82f6', // blue
  2: '#eab308', // yellow
  3: '#f97316', // orange
  4: '#ef4444', // red
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
  const { current: map } = useMap()
  const [alerts, setAlerts]     = useState<AirportAlert[]>([])
  const [selected, setSelected] = useState<AirportAlert | null>(null)
  const [fetchedAt, setFetchedAt] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const bboxRef  = useRef<string>('')

  const fetchAlerts = () => {
    if (!map) return
    const b = map.getBounds()
    if (!b) return
    const bbox = [
      b.getWest().toFixed(3),
      b.getSouth().toFixed(3),
      b.getEast().toFixed(3),
      b.getNorth().toFixed(3),
    ].join(',')
    // Éviter un re-fetch si la bbox n'a pas changé significativement.
    if (bbox === bboxRef.current) return
    bboxRef.current = bbox

    fetch(`/api/alerts?bbox=${bbox}`)
      .then((r) => r.ok ? r.json() as Promise<AlertsResponse> : Promise.reject(r.status))
      .then((d) => {
        setAlerts(d.alerts ?? [])
        setFetchedAt(d.fetched_at)
      })
      .catch(() => { /* best-effort */ })
  }

  useEffect(() => {
    if (!enabled || !map) {
      setAlerts([])
      setSelected(null)
      return
    }

    // Fetch initial puis à chaque déplacement de carte (debounced 800 ms).
    fetchAlerts()
    let debounce: ReturnType<typeof setTimeout> | null = null
    const onMoveEnd = () => {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(fetchAlerts, 800)
    }
    map.on('moveend', onMoveEnd)

    // Refresh périodique (même bbox, données météo évoluent).
    timerRef.current = setInterval(() => {
      bboxRef.current = '' // forcer le re-fetch
      fetchAlerts()
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
              {/* Anneau pulsant */}
              <div
                className="absolute -inset-2 rounded-full animate-ping opacity-50 pointer-events-none"
                style={{ backgroundColor: color }}
              />
              {/* Dot central */}
              <div
                className="size-3 rounded-full border-2 border-white shadow-md relative z-10 group-hover:scale-125 transition-transform"
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
          className="airport-alert-popup"
        >
          <div className="min-w-[180px] p-2 text-[0.65rem] font-mono text-slate-200 bg-slate-900 rounded">
            {/* En-tête */}
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
            {/* Sources d'alerte */}
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
            {/* Timestamp */}
            {fetchedAt && (
              <div className="mt-2 text-slate-600 text-[0.5rem] text-right">
                Màj {new Date(fetchedAt).toISOString().slice(11, 16)}Z
              </div>
            )}
          </div>
        </Popup>
      )}
    </>
  )
}
