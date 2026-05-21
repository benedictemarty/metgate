import { useEffect, useState } from 'react'
import { Source, Layer } from 'react-map-gl/maplibre'

interface Props {
  enabled: boolean
  showUIR?: boolean
}

export default function FirLayer({ enabled, showUIR = false }: Props) {
  const [geo, setGeo] = useState<GeoJSON.FeatureCollection | null>(null)

  useEffect(() => {
    if (!enabled || geo) return
    fetch('/api/fir')
      .then(r => r.ok ? r.json() : null)
      .then((d: GeoJSON.FeatureCollection | null) => { if (d) setGeo(d) })
      .catch(() => {})
  }, [enabled, geo])

  if (!enabled || !geo) return null

  // Filtrer FIR uniquement (pas UIR) si showUIR=false
  const data: GeoJSON.FeatureCollection = showUIR ? geo : {
    ...geo,
    features: geo.features.filter(f => !(f.properties as Record<string, unknown>)?.uir),
  }

  return (
    <Source id="fir-src" type="geojson" data={data}>
      {/* Remplissage très léger */}
      <Layer
        id="fir-fill"
        type="fill"
        paint={{ 'fill-color': '#818cf8', 'fill-opacity': 0.04 }}
      />
      {/* Bordure fine */}
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
      {/* Label au centroïde — MapLibre symbol layer avec text-field */}
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
