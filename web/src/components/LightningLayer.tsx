import { useEffect, useState } from 'react'
import { useMap } from 'react-map-gl/maplibre'
import { Zap } from 'lucide-react'

const SOURCE_ID = 'eumetsat-lightning-src'
const LAYER_HALO = 'eumetsat-lightning-halo'
const LAYER_DOT = 'eumetsat-lightning-dot'

const POLL_MS = 60_000 // produit MTG-LI = 10 min cadence ; on rafraîchit large

interface LightningFC {
  type: 'FeatureCollection'
  features: GeoJSON.Feature<GeoJSON.Point>[]
  fetched_at: string
  source: string
  disclaimer: string
}

interface LightningLayerProps {
  enabled: boolean
}

export default function LightningLayer({ enabled }: LightningLayerProps) {
  const { current: mapRef } = useMap()
  const map = mapRef?.getMap()
  const [data, setData] = useState<LightningFC | null>(null)
  const [info, setInfo] = useState<{ status: 'idle' | 'loading' | 'error'; msg?: string }>({
    status: 'idle',
  })

  // Fetch périodique (toutes les minutes) pendant que la couche est activée.
  useEffect(() => {
    if (!enabled) return
    let aborted = false
    const fetchOnce = () => {
      setInfo({ status: 'loading' })
      fetch('/api/lightning?bbox=-180,-90,180,90')
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          return r.json()
        })
        .then((d: LightningFC) => {
          if (aborted) return
          setData(d)
          setInfo({ status: 'idle' })
        })
        .catch((e) => {
          if (aborted) return
          setInfo({ status: 'error', msg: String(e) })
        })
    }
    fetchOnce()
    const id = window.setInterval(fetchOnce, POLL_MS)
    return () => {
      aborted = true
      window.clearInterval(id)
    }
  }, [enabled])

  // Source + layers MapLibre (ajout/retrait selon enabled+data).
  useEffect(() => {
    if (!map) return
    const cleanup = () => {
      if (map.getLayer(LAYER_DOT)) map.removeLayer(LAYER_DOT)
      if (map.getLayer(LAYER_HALO)) map.removeLayer(LAYER_HALO)
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID)
    }
    if (!enabled || !data) {
      cleanup()
      return
    }
    // On enrichit chaque feature d'un champ _ageS (secondes depuis maintenant)
    // pour piloter les expressions paint MapLibre.
    const now = Date.now()
    const fc: GeoJSON.FeatureCollection<GeoJSON.Point> = {
      type: 'FeatureCollection',
      features: data.features.map((f) => {
        const t = (f.properties as Record<string, unknown> | null)?.time as string | undefined
        const ageS = t ? Math.max(0, (now - new Date(t).getTime()) / 1000) : 999
        return {
          ...f,
          properties: { ...(f.properties ?? {}), _ageS: ageS },
        }
      }),
    }
    const src = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined
    if (src) {
      src.setData(fc)
    } else {
      map.addSource(SOURCE_ID, { type: 'geojson', data: fc })
      map.addLayer({
        id: LAYER_HALO,
        source: SOURCE_ID,
        type: 'circle',
        paint: {
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['get', '_ageS'],
            0,
            12,
            300,
            8,
            1800,
            5,
          ],
          'circle-color': [
            'interpolate',
            ['linear'],
            ['get', '_ageS'],
            0,
            '#fef3c7', // jaune pâle (récent)
            120,
            '#fb923c', // orange
            600,
            '#dc2626', // rouge
            1800,
            '#7f1d1d', // bordeaux (vieux)
          ],
          'circle-blur': 0.6,
          'circle-opacity': [
            'interpolate',
            ['linear'],
            ['get', '_ageS'],
            0,
            0.85,
            600,
            0.45,
            1800,
            0.15,
          ],
        },
      })
      map.addLayer({
        id: LAYER_DOT,
        source: SOURCE_ID,
        type: 'circle',
        paint: {
          'circle-radius': 2.5,
          'circle-color': '#fffbeb',
          'circle-stroke-color': '#facc15',
          'circle-stroke-width': 1,
          'circle-opacity': [
            'interpolate',
            ['linear'],
            ['get', '_ageS'],
            0,
            1,
            600,
            0.6,
            1800,
            0.2,
          ],
        },
      })
    }
    return cleanup
  }, [map, enabled, data])

  if (!enabled) return null

  return (
    <div className="absolute top-16 right-4 z-10 px-3 py-2 rounded-lg bg-slate-950/85 backdrop-blur-md border border-amber-900/40 text-[0.625rem] text-slate-300 shadow-2xl flex flex-col gap-1.5 min-w-[260px]">
      <div className="flex items-center justify-between gap-3 pb-1.5 border-b border-slate-800/60">
        <div className="flex items-center gap-2">
          <Zap className="size-3.5 text-amber-300" />
          <span className="font-semibold text-amber-200 uppercase tracking-wider">Foudre MTG-LI</span>
        </div>
        <img
          src="/eumetsat-logo.png"
          alt="EUMETSAT"
          className="h-6 w-auto"
          title="Source : EUMETSAT (Meteosat Third Generation — Lightning Imager)"
        />
      </div>
      <div className="flex justify-between gap-2 font-mono">
        <span className="text-slate-500">Flashes</span>
        <span className="text-slate-200 tabular-nums">{data?.features.length ?? 0}</span>
      </div>
      {data?.fetched_at && (
        <div className="flex justify-between gap-2 font-mono">
          <span className="text-slate-500">Fetché</span>
          <span className="text-slate-300">{data.fetched_at.slice(11, 16)} UTC</span>
        </div>
      )}
      {info.status === 'loading' && <div className="text-slate-500 italic">Chargement…</div>}
      {info.status === 'error' && (
        <div className="text-red-300 leading-snug">{info.msg}</div>
      )}
      <div className="text-amber-300/70 italic leading-snug">
        Situationnel — <span className="text-amber-200">non OPMET</span> (OACI Annexe 3 / 2017/373).
      </div>
    </div>
  )
}
