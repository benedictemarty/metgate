import { useEffect, useState } from 'react'
import { Source, Layer, useMap } from 'react-map-gl/maplibre'

interface Props {
  enabled: boolean
  showUIR?: boolean
}

export default function FirLayer({ enabled, showUIR = false }: Props) {
  const [geo, setGeo] = useState<GeoJSON.FeatureCollection | null>(null)
  const { current: mapRef } = useMap()

  useEffect(() => {
    if (!enabled || geo) return
    fetch('/api/fir')
      .then(r => r.ok ? r.json() : null)
      .then((d: GeoJSON.FeatureCollection | null) => { if (d) setGeo(d) })
      .catch(() => {})
  }, [enabled, geo])

  // Écoute la perte du contexte WebGL pour désarmer le nettoyage react-map-gl
  // qui appelle map.getLayer() alors que this.style est déjà undefined.
  // À la restauration, on réinitialise geo pour forcer un re-fetch et que
  // MapLibre reçoive des données fraîches après reconstruction du contexte GPU.
  const [contextLost, setContextLost] = useState(false)
  useEffect(() => {
    const map = mapRef?.getMap()
    if (!map) return
    const canvas = map.getCanvas()
    const onLost = () => setContextLost(true)
    const onRestored = () => {
      setContextLost(false)
      setGeo(null) // force re-fetch pour re-alimenter MapLibre après GPU recovery
    }
    canvas.addEventListener('webglcontextlost', onLost)
    canvas.addEventListener('webglcontextrestored', onRestored)
    return () => {
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
    }
  }, [mapRef])

  if (!enabled || !geo || contextLost) return null

  const data: GeoJSON.FeatureCollection = showUIR ? geo : {
    ...geo,
    features: geo.features.filter(f => !(f.properties as Record<string, unknown>)?.uir),
  }

  return (
    <Source id="fir-src" type="geojson" data={data}>
      <Layer
        id="fir-fill"
        type="fill"
        paint={{ 'fill-color': '#818cf8', 'fill-opacity': 0.04 }}
      />
      <Layer
        id="fir-line"
        type="line"
        paint={{
          'line-color': '#818cf8',
          'line-width': 1,
          'line-opacity': 0.5,
          'line-dasharray': [4, 3],
        }}
      />
      <Layer
        id="fir-label"
        type="symbol"
        layout={{
          'text-field': ['get', 'icao'],
          'text-size': 10,
          'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
          'text-allow-overlap': false,
          'text-ignore-placement': false,
          'symbol-placement': 'point',
        }}
        paint={{
          'text-color': '#a5b4fc',
          'text-halo-color': '#0f172a',
          'text-halo-width': 1.5,
          'text-opacity': 0.8,
        }}
      />
    </Source>
  )
}
