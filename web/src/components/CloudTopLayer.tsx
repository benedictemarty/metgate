import { useEffect, useState } from 'react'
import { useMap } from 'react-map-gl/maplibre'
import { CloudCog } from 'lucide-react'

const SOURCE_ID = 'eumetsat-cloudtop-src'
const LAYER_ID = 'eumetsat-cloudtop-layer'

// Domaine couvert par le PNG renvoyé par /api/cloudtop. On demande Europe
// large + Méditerranée + Afrique du nord. Identique côté backend (param bbox).
const PNG_BBOX: [number, number, number, number] = [-30, 30, 50, 65]
const PNG_W = 1280
const PNG_H = 768
const POLL_MS = 5 * 60 * 1000 // produit MTG-CTTH cadence 10 min

interface CloudTopLayerProps {
  enabled: boolean
  minFL: number
  onMinFLChange: (fl: number) => void
  opacity?: number
  onLoadingChange?: (loading: boolean) => void
}

export default function CloudTopLayer({
  enabled,
  minFL,
  onMinFLChange,
  opacity = 0.65,
  onLoadingChange,
}: CloudTopLayerProps) {
  const { current: mapRef } = useMap()
  const map = mapRef?.getMap()
  const [tick, setTick] = useState(0)

  // Refresh périodique (force update l'image) sans réinstaller la source.
  useEffect(() => {
    if (!enabled) return
    const id = window.setInterval(() => setTick((t) => t + 1), POLL_MS)
    return () => window.clearInterval(id)
  }, [enabled])

  useEffect(() => {
    if (!map) return
    const cleanup = () => {
      if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID)
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID)
    }
    if (!enabled) {
      cleanup()
      return
    }
    const url = `/api/cloudtop?bbox=${PNG_BBOX.join(',')}&minfl=${minFL}&w=${PNG_W}&h=${PNG_H}&t=${tick}`
    const [lonMin, latMin, lonMax, latMax] = PNG_BBOX
    const coords: [
      [number, number],
      [number, number],
      [number, number],
      [number, number],
    ] = [
      [lonMin, latMax],
      [lonMax, latMax],
      [lonMax, latMin],
      [lonMin, latMin],
    ]

    // Signal chargement — MapLibre fetch l'image en interne (pas de fetch() JS).
    // On écoute sourcedata pour détecter la fin du chargement.
    onLoadingChange?.(true)
    const onSourceData = (e: { sourceId?: string }) => {
      if (e.sourceId === SOURCE_ID && map.isSourceLoaded(SOURCE_ID)) {
        onLoadingChange?.(false)
        map.off('sourcedata', onSourceData)
      }
    }
    map.on('sourcedata', onSourceData)

    const src = map.getSource(SOURCE_ID) as
      | { updateImage: (o: { url: string; coordinates: typeof coords }) => void }
      | undefined
    if (src && typeof src.updateImage === 'function') {
      src.updateImage({ url, coordinates: coords })
      if (map.getLayer(LAYER_ID)) {
        map.setPaintProperty(LAYER_ID, 'raster-opacity', opacity)
      }
      return
    }
    try {
      map.addSource(SOURCE_ID, {
        type: 'image',
        url,
        coordinates: coords,
      })
      const layers = map.getStyle().layers ?? []
      const firstSymbol = layers.find((l) => l.type === 'symbol')?.id
      map.addLayer(
        {
          id: LAYER_ID,
          type: 'raster',
          source: SOURCE_ID,
          paint: {
            'raster-opacity': opacity,
            'raster-fade-duration': 0,
            'raster-resampling': 'linear',
          },
        },
        firstSymbol,
      )
    } catch (e) {
      console.warn('cloudtop layer add failed:', e)
    }
  }, [map, enabled, minFL, opacity, tick])

  if (!enabled) return null

  return (
    <div className="absolute top-16 right-72 z-10 px-3 py-2 rounded-lg bg-slate-950/85 backdrop-blur-md border border-violet-900/40 text-[0.625rem] text-slate-300 shadow-2xl flex flex-col gap-2 min-w-[260px]">
      <div className="flex items-center gap-2 pb-1.5 border-b border-slate-800/60">
        <CloudCog className="size-3.5 text-violet-300" />
        <span className="font-semibold text-violet-200 uppercase tracking-wider">Cloud Top Height</span>
        <span className="ml-auto text-slate-500 font-mono">MTG-FCI</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-slate-500 font-mono w-12 shrink-0">Seuil</span>
        <input
          type="range"
          min={0}
          max={500}
          step={50}
          value={minFL}
          onChange={(e) => onMinFLChange(Number(e.target.value))}
          className="flex-1 accent-violet-400"
        />
        <span className="text-violet-200 font-mono tabular-nums w-12 text-right">FL{minFL}</span>
      </div>
      <CloudTopLegend minFL={minFL} />
      <div className="text-violet-300/60 italic leading-snug border-t border-slate-800/60 pt-1.5">
        Sommets nuageux ≥ FL{minFL}. Source EUMETSAT — situationnel,{' '}
        <span className="text-violet-200">non OPMET</span>.
      </div>
    </div>
  )
}

// Légende exportée pour affichage hors composant (panneau HUD parent).
export function CloudTopLegend({ minFL }: { minFL: number }) {
  return (
    <div className="flex flex-col gap-1 text-[0.5625rem]">
      <div className="text-slate-500 uppercase tracking-wider">Sommets ≥ FL{minFL}</div>
      <div className="flex h-1.5 rounded overflow-hidden">
        <span className="flex-1" style={{ backgroundColor: 'rgb(125,211,252)' }} />
        <span className="flex-1" style={{ backgroundColor: 'rgb(56,189,248)' }} />
        <span className="flex-1" style={{ backgroundColor: 'rgb(74,222,128)' }} />
        <span className="flex-1" style={{ backgroundColor: 'rgb(250,204,21)' }} />
        <span className="flex-1" style={{ backgroundColor: 'rgb(249,115,22)' }} />
        <span className="flex-1" style={{ backgroundColor: 'rgb(239,68,68)' }} />
        <span className="flex-1" style={{ backgroundColor: 'rgb(220,38,38)' }} />
      </div>
      <div className="flex justify-between text-slate-500 font-mono">
        <span>FL000</span>
        <span>FL200</span>
        <span>FL400+</span>
      </div>
    </div>
  )
}

// Icône réexportée pour le bouton toggle côté MapView.
export const CloudTopIcon = CloudCog
