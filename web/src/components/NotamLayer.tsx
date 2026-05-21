import { useEffect, useRef, useState } from 'react'
import { Source, Layer } from 'react-map-gl/maplibre'
import { AlertTriangle, Loader2, Search, X } from 'lucide-react'

export interface NotamFeature {
  id: string
  number: string
  type: string
  location: string
  issued: string
  effectiveStart: string
  effectiveEnd: string
  text: string
  plainLang: string
  icaoMessage: string
  classification: string
  maximumFL: string
  minimumFL: string
  radius: string
}

interface Props {
  enabled: boolean
  onClose: () => void
}

interface FetchState {
  geo: GeoJSON.FeatureCollection | null
  loading: boolean
  error: string | null
  icaos: string[]
  unavailable: boolean  // 503 = pas de credentials
}

export default function NotamLayer({ enabled, onClose }: Props) {
  const [icaoInput, setIcaoInput] = useState('')
  const [state, setState] = useState<FetchState>({ geo: null, loading: false, error: null, icaos: [], unavailable: false })
  const abortRef = useRef<AbortController | null>(null)

  const fetch = async (icaos: string[]) => {
    if (icaos.length === 0) return
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac

    setState(s => ({ ...s, loading: true, error: null }))
    try {
      const params = icaos.map(c => `icao=${encodeURIComponent(c)}`).join('&')
      const r = await window.fetch(`/api/notam?${params}`, { signal: ac.signal })
      if (r.status === 503) {
        setState(s => ({ ...s, loading: false, unavailable: true }))
        return
      }
      if (!r.ok) {
        const txt = await r.text()
        setState(s => ({ ...s, loading: false, error: `HTTP ${r.status}: ${txt.slice(0, 80)}` }))
        return
      }
      const d = await r.json() as { type: string; features: GeoJSON.Feature[]; icaos: string[] }
      setState({ geo: d as unknown as GeoJSON.FeatureCollection, loading: false, error: null, icaos: d.icaos ?? icaos, unavailable: false })
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      setState(s => ({ ...s, loading: false, error: String(e) }))
    }
  }

  const submit = () => {
    const icaos = icaoInput.split(/[\s,;]+/).map(s => s.trim().toUpperCase()).filter(Boolean)
    if (icaos.length > 0) fetch(icaos)
  }

  // Cleanup à la désactivation
  useEffect(() => {
    if (!enabled) {
      abortRef.current?.abort()
      setState({ geo: null, loading: false, error: null, icaos: [], unavailable: false })
    }
  }, [enabled])

  if (!enabled) return null

  const geoWithCoords: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: (state.geo?.features ?? []).filter(f => f.geometry !== null),
  }
  const total = state.geo?.features.length ?? 0
  const withCoords = geoWithCoords.features.length

  return (
    <>
      {/* Couche cartographique (uniquement NOTAM avec coordonnées) */}
      {state.geo && (
        <Source id="notam-src" type="geojson" data={geoWithCoords}>
          <Layer
            id="notam-glow"
            type="circle"
            paint={{ 'circle-radius': 14, 'circle-color': '#f59e0b', 'circle-opacity': 0.15, 'circle-blur': 0.8 }}
          />
          <Layer
            id="notam-circle"
            type="circle"
            paint={{
              'circle-radius': 5,
              'circle-color': '#f59e0b',
              'circle-stroke-color': '#0f172a',
              'circle-stroke-width': 1.5,
              'circle-opacity': 0.95,
            }}
          />
        </Source>
      )}

      {/* Panneau de recherche */}
      <div className="absolute top-16 right-4 z-20 w-80 rounded-xl border border-amber-900/40 bg-slate-950/90 backdrop-blur-md shadow-2xl text-[0.6875rem] text-slate-200 select-none">
        {/* En-tête */}
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-slate-800/60">
          <AlertTriangle className="size-3.5 text-amber-400 shrink-0" />
          <span className="font-semibold text-amber-200 uppercase tracking-wider text-[0.625rem] flex-1">NOTAM (FAA API)</span>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200 transition">
            <X className="size-3.5" />
          </button>
        </div>

        <div className="px-3 py-2.5 flex flex-col gap-2.5">
          {state.unavailable ? (
            <div className="text-amber-400 text-[0.625rem] bg-amber-500/10 border border-amber-500/20 rounded-lg px-2 py-2">
              Credentials FAA non configurés.<br />
              Ajouter <code className="font-mono">FAA_NOTAM_CLIENT_ID</code> et <code className="font-mono">FAA_NOTAM_CLIENT_SECRET</code> dans <code className="font-mono">.env</code>.<br />
              Compte gratuit : <span className="underline">api.faa.gov/signup</span>
            </div>
          ) : (
            <>
              <div>
                <div className="text-slate-400 uppercase tracking-wider text-[0.5625rem] mb-1.5">Codes ICAO (séparés par espace ou virgule)</div>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={icaoInput}
                    onChange={e => setIcaoInput(e.target.value.toUpperCase())}
                    onKeyDown={e => e.key === 'Enter' && submit()}
                    placeholder="LFPG LFBO LFMN"
                    className="flex-1 px-2 py-1 rounded bg-slate-900/70 border border-slate-700/60 font-mono text-slate-200 placeholder-slate-600 focus:outline-none focus:border-amber-500/50 text-[0.6875rem]"
                  />
                  <button
                    onClick={submit}
                    disabled={state.loading || !icaoInput.trim()}
                    className="px-2 py-1 rounded border border-amber-500/40 bg-amber-600/20 text-amber-200 hover:bg-amber-500/30 transition disabled:opacity-40"
                  >
                    {state.loading ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
                  </button>
                </div>
              </div>

              {state.error && (
                <div className="text-red-400 text-[0.625rem] bg-red-500/10 border border-red-500/20 rounded px-2 py-1.5">
                  {state.error}
                </div>
              )}

              {state.geo && !state.loading && (
                <div className="text-slate-400 text-[0.5625rem]">
                  {total} NOTAM — {withCoords} géolocalisés
                  {state.icaos.length > 0 && ` · ${state.icaos.join(', ')}`}
                </div>
              )}

              {/* Liste des NOTAM */}
              {(state.geo?.features ?? []).length > 0 && (
                <div className="max-h-72 overflow-y-auto flex flex-col gap-1.5 pr-0.5">
                  {state.geo!.features.map((f, i) => {
                    const p = f.properties as NotamFeature
                    const hasCoords = f.geometry !== null
                    return (
                      <div key={i} className="border border-slate-800/60 rounded-lg p-2 bg-slate-900/30 hover:bg-slate-900/60 transition">
                        <div className="flex items-start justify-between gap-1 mb-1">
                          <span className="font-mono font-semibold text-amber-300 text-[0.6875rem]">
                            {p.number || p.id}
                          </span>
                          <div className="flex items-center gap-1 shrink-0">
                            {p.classification && (
                              <span className="text-[0.5rem] px-1 rounded bg-slate-800 text-slate-400 uppercase">{p.classification}</span>
                            )}
                            {!hasCoords && (
                              <span className="text-[0.5rem] px-1 rounded bg-slate-800/60 text-slate-500">sans géo</span>
                            )}
                          </div>
                        </div>
                        {(p.maximumFL || p.minimumFL) && (
                          <div className="text-[0.5625rem] text-slate-500 mb-1">
                            FL {p.minimumFL || '000'} → {p.maximumFL || '999'}
                          </div>
                        )}
                        {p.plainLang ? (
                          <div className="text-slate-300 text-[0.5625rem] leading-relaxed">{p.plainLang.slice(0, 180)}{p.plainLang.length > 180 ? '…' : ''}</div>
                        ) : (
                          <pre className="font-mono text-slate-400 text-[0.5rem] whitespace-pre-wrap break-all leading-relaxed">{p.text?.slice(0, 200)}{(p.text?.length ?? 0) > 200 ? '…' : ''}</pre>
                        )}
                        <div className="mt-1 text-[0.5rem] text-slate-600">
                          {p.effectiveStart?.slice(0, 16).replace('T', ' ')} → {p.effectiveEnd?.slice(0, 16).replace('T', ' ')} UTC
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  )
}
