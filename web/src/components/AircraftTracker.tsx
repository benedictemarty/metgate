import { useEffect, useState } from 'react'
import { useMap, Marker } from 'react-map-gl/maplibre'
import { ChevronDown, Plane, Radio, X, Search } from 'lucide-react'
import type { RoutePlan } from './FlightPlan'

export interface AircraftState {
  icao24: string
  callsign: string
  origin_country: string
  time_position: number
  last_contact: number
  lon: number
  lat: number
  baro_alt_m: number
  on_ground: boolean
  velocity_ms: number
  true_track_deg: number
  vertical_rate_ms: number
  geo_alt_m: number
  squawk: string
  gs_kt: number
  baro_alt_ft: number
  fl: number
  time_iso: string
}

interface SearchResp {
  query: string
  authenticated: boolean
  count: number
  states: AircraftState[]
}

const POLL_INTERVAL_MS = 15000

interface AircraftTrackerProps {
  selected: AircraftState | null
  onSelect: (s: AircraftState | null) => void
  onLivePlan: (plan: RoutePlan | null) => void
  onClose?: () => void
}

export default function AircraftTracker({
  selected,
  onSelect,
  onLivePlan,
  onClose,
}: AircraftTrackerProps) {
  const { current: mapRef } = useMap()
  const map = mapRef?.getMap()

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<AircraftState[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [authenticated, setAuthenticated] = useState(false)
  const [destOverride, setDestOverride] = useState('')
  const [planLoading, setPlanLoading] = useState(false)

  // Recherche
  const search = async (q: string) => {
    if (!q.trim()) return
    setSearching(true)
    setError(null)
    try {
      const r = await fetch(`/api/aircraft/search?cs=${encodeURIComponent(q.trim())}`)
      if (!r.ok) {
        const t = await r.text()
        throw new Error(t.trim() || `HTTP ${r.status}`)
      }
      const data: SearchResp = await r.json()
      setResults(data.states)
      setAuthenticated(data.authenticated)
      if (data.states.length === 0) setError(`Aucun avion pour "${q}"`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSearching(false)
    }
  }

  // Polling de l'avion sélectionné
  useEffect(() => {
    if (!selected) return
    const tick = async () => {
      try {
        const r = await fetch(`/api/aircraft/${selected.icao24}`)
        if (!r.ok) return
        const s: AircraftState = await r.json()
        onSelect(s)
      } catch {
        /* ignore transient errors */
      }
    }
    const id = window.setInterval(tick, POLL_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [selected?.icao24, onSelect])

  // Centre la carte sur l'avion à la sélection
  useEffect(() => {
    if (!selected || !map) return
    map.easeTo({
      center: [selected.lon, selected.lat],
      duration: 800,
      zoom: Math.max(map.getZoom(), 5),
    })
  }, [selected?.icao24, map])

  // Génère le plan synthétique pour l'avion suivi (projection +60 min ou
  // jusqu'à la dest auto/manuelle), avec events et profil vent. Branche
  // tout le pipeline produits/triangles/wind/WCS sur l'avion réel.
  const buildLivePlan = async () => {
    if (!selected) return
    setPlanLoading(true)
    try {
      const params = new URLSearchParams({ dur: '60', events: '1', wind: '1' })
      if (destOverride.trim()) params.set('dest', destOverride.trim().toUpperCase())
      const r = await fetch(`/api/aircraft/${selected.icao24}/route?${params}`)
      if (!r.ok) return
      const p: RoutePlan = await r.json()
      onLivePlan(p)
    } finally {
      setPlanLoading(false)
    }
  }

  // Auto-build du plan synthétique au moment de la sélection / changement de
  // destination override / repolling de l'avion.
  useEffect(() => {
    if (!selected) {
      onLivePlan(null)
      return
    }
    buildLivePlan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.icao24, destOverride])

  return (
    <>
      {/* Panneau Suivi : colonne juste à droite de la sidebar WFS (la même
          que le Plan de vol), mais en bas pour ne pas se chevaucher.
          La sidebar WFS occupe la colonne 0 (left-4 → bottom-4), le Plan de
          vol prend left-[19rem] top-4, on prend left-[19rem] bottom-4. */}
      <div className="absolute bottom-4 left-[19rem] z-10 w-72 px-3 py-3 rounded-xl border border-rose-400/30 bg-slate-950/85 backdrop-blur-md shadow-2xl">
        <div className="flex items-center gap-2 mb-2">
          <Radio className="size-4 text-rose-300" />
          <div className="text-sm font-medium">Suivi avion (ADS-B)</div>
          <div
            className={`ml-auto size-1.5 rounded-full ${
              authenticated ? 'bg-emerald-400' : 'bg-amber-400'
            }`}
            title={authenticated ? 'OpenSky authentifié' : 'OpenSky anonymous (100 req/jour)'}
          />
          {selected && (
            <button
              onClick={() => {
                onSelect(null)
                setResults([])
                setQuery('')
              }}
              className="text-slate-500 hover:text-slate-200"
              title="Arrêter le suivi"
            >
              <X className="size-4" />
            </button>
          )}
          {onClose && (
            <button
              onClick={onClose}
              className="text-slate-600 hover:text-slate-300 transition"
              title="Réduire"
            >
              <ChevronDown className="size-4" />
            </button>
          )}
        </div>

        {!selected && (
          <>
            <div className="flex gap-2">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === 'Enter' && search(query)}
                placeholder="Callsign (ex: AFR1234)"
                className="flex-1 px-2 py-1 rounded bg-slate-900/60 border border-slate-800 text-slate-200 font-mono text-[0.6875rem] focus:outline-none focus:border-rose-500/50"
              />
              <button
                onClick={() => search(query)}
                disabled={searching || !query.trim()}
                className="px-2 rounded bg-rose-500/20 hover:bg-rose-500/30 border border-rose-400/40 text-rose-100 disabled:opacity-40"
                title="Chercher"
              >
                <Search className="size-3.5" />
              </button>
            </div>
            {error && (
              <div className="mt-2 text-[0.625rem] text-amber-400 leading-snug">{error}</div>
            )}
            {results.length > 0 && (
              <ul className="mt-2 max-h-48 overflow-y-auto space-y-0.5">
                {results.map((s) => (
                  <li key={s.icao24}>
                    <button
                      onClick={() => onSelect(s)}
                      className="w-full text-left px-2 py-1 rounded hover:bg-slate-800/60 text-[0.6875rem] font-mono"
                    >
                      <div className="flex justify-between">
                        <span className="text-rose-200">{s.callsign || '—'}</span>
                        <span className="text-slate-500">{s.icao24}</span>
                      </div>
                      <div className="flex justify-between text-[0.625rem] text-slate-500">
                        <span>{s.origin_country}</span>
                        <span>
                          FL{s.fl.toString().padStart(3, '0')} · {s.gs_kt.toFixed(0)} kt
                        </span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {selected && (
          <div className="text-[0.6875rem] font-mono">
            <div className="flex justify-between mb-1">
              <span className="text-rose-200 text-base font-semibold">
                {selected.callsign || '—'}
              </span>
              <span className="text-slate-500 text-[0.625rem] mt-1">
                {selected.icao24}
              </span>
            </div>
            <div className="text-[0.625rem] text-slate-400 mb-2">{selected.origin_country}</div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[0.625rem]">
              <div className="flex justify-between">
                <dt className="text-slate-500">FL</dt>
                <dd className="text-slate-200">
                  {selected.fl.toString().padStart(3, '0')}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">GS</dt>
                <dd className="text-slate-200">{selected.gs_kt.toFixed(0)} kt</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Track</dt>
                <dd className="text-slate-200">
                  {selected.true_track_deg.toFixed(0)}°
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">V/S</dt>
                <dd
                  className={
                    selected.vertical_rate_ms > 0.5
                      ? 'text-emerald-300'
                      : selected.vertical_rate_ms < -0.5
                        ? 'text-rose-300'
                        : 'text-slate-200'
                  }
                >
                  {(selected.vertical_rate_ms * 196.85).toFixed(0)} fpm
                </dd>
              </div>
              <div className="flex justify-between col-span-2">
                <dt className="text-slate-500">Pos</dt>
                <dd className="text-slate-200">
                  {selected.lat.toFixed(3)}°N {selected.lon.toFixed(3)}°E
                </dd>
              </div>
              {selected.squawk && (
                <div className="flex justify-between col-span-2">
                  <dt className="text-slate-500">Squawk</dt>
                  <dd className="text-slate-200">{selected.squawk}</dd>
                </div>
              )}
            </dl>
            <div className="mt-1 text-[0.5625rem] text-slate-500">
              màj {selected.time_iso?.replace('T', ' ').replace('Z', ' UTC')}
            </div>
            <div className="mt-2 pt-2 border-t border-slate-800/60 flex items-center gap-1">
              <input
                value={destOverride}
                onChange={(e) => setDestOverride(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === 'Enter' && buildLivePlan()}
                placeholder="Dest ICAO (auto si vide)"
                maxLength={4}
                className="flex-1 px-2 py-1 rounded bg-slate-900/60 border border-slate-800 text-slate-200 font-mono text-[0.625rem] focus:outline-none focus:border-rose-500/50"
              />
              <button
                onClick={buildLivePlan}
                disabled={planLoading}
                className="px-2 py-1 rounded bg-rose-500/20 hover:bg-rose-500/30 border border-rose-400/40 text-rose-100 text-[0.625rem] disabled:opacity-40"
                title="Régénérer le plan synthétique"
              >
                {planLoading ? '…' : '↻'}
              </button>
            </div>
            <div className="mt-1 text-[0.5625rem] text-slate-500 leading-snug">
              Plan synthétique : projection +60 min au cap, ou grand cercle vers
              dest si renseignée. Les produits / WCS s'allument autour de l'avion.
            </div>
          </div>
        )}
      </div>

      {/* Avion sur la carte */}
      {selected && (
        <Marker longitude={selected.lon} latitude={selected.lat} anchor="center">
          <div
            className="text-rose-300 drop-shadow-[0_0_8px_rgba(244,63,94,0.7)]"
            style={{ transform: `rotate(${selected.true_track_deg}deg)` }}
          >
            <Plane className="size-7" fill="currentColor" strokeWidth={2} />
          </div>
        </Marker>
      )}
    </>
  )
}
