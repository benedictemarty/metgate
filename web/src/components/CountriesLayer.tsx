import { useEffect, useMemo, useState } from 'react'
import { Source, Layer, useMap } from 'react-map-gl/maplibre'
import { neKeyForLang, type MapLanguageCode } from './ConfigPanel'

interface Props {
  enabled: boolean
  language: MapLanguageCode
}

type Pos = GeoJSON.Position

// Convertit Polygon/MultiPolygon en MultiLineString en :
//   - filtrant les rings entièrement au sud de -60° (Antarctique → trait
//     horizontal au pôle sud qui fait le tour de la Terre)
//   - coupant les segments qui sautent l'antiméridien (|Δlon| > 180°) pour
//     éviter les longues lignes droites traversant tout le globe (Russie,
//     Fidji, Aléoutiennes).
function polygonsToSafeLines(coords: Pos[][][]): Pos[][] {
  const out: Pos[][] = []
  for (const poly of coords) {
    for (const ring of poly) {
      if (ring.length < 2) continue
      if (ring.every(p => p[1] < -60)) continue
      let cur: Pos[] = [ring[0]]
      for (let i = 1; i < ring.length; i++) {
        const prev = ring[i - 1]
        const p = ring[i]
        if (Math.abs(p[0] - prev[0]) > 180) {
          if (cur.length >= 2) out.push(cur)
          cur = [p]
        } else {
          cur.push(p)
        }
      }
      if (cur.length >= 2) out.push(cur)
    }
  }
  return out
}

// Renvoie deux FeatureCollections : `lines` pour les contours, `labels` pour les
// points d'étiquette (Natural Earth fournit LABEL_X/LABEL_Y par feature). Les
// props sont préservées sur les labels (NAME_FR/DE/…) pour le rendu symbol.
function preprocess(fc: GeoJSON.FeatureCollection): {
  lines: GeoJSON.FeatureCollection
  labels: GeoJSON.FeatureCollection
} {
  const lineFeats: GeoJSON.Feature[] = []
  const labelFeats: GeoJSON.Feature[] = []
  for (const f of fc.features) {
    const g = f.geometry
    if (!g) continue
    let polys: Pos[][][] | null = null
    if (g.type === 'Polygon') polys = [g.coordinates as Pos[][]]
    else if (g.type === 'MultiPolygon') polys = g.coordinates as Pos[][][]
    if (!polys) continue
    const lines = polygonsToSafeLines(polys)
    if (!lines.length) continue
    const props = (f.properties ?? {}) as Record<string, unknown>
    if (typeof props.NAME === 'string' && props.NAME === 'Antarctica') continue
    lineFeats.push({
      type: 'Feature',
      properties: props,
      geometry: { type: 'MultiLineString', coordinates: lines },
    })
    const lx = Number(props.LABEL_X), ly = Number(props.LABEL_Y)
    if (Number.isFinite(lx) && Number.isFinite(ly)) {
      labelFeats.push({
        type: 'Feature',
        properties: props,
        geometry: { type: 'Point', coordinates: [lx, ly] },
      })
    }
  }
  return {
    lines:  { type: 'FeatureCollection', features: lineFeats },
    labels: { type: 'FeatureCollection', features: labelFeats },
  }
}

export default function CountriesLayer({ enabled, language }: Props) {
  const [geo, setGeo] = useState<GeoJSON.FeatureCollection | null>(null)
  const data = useMemo(() => geo ? preprocess(geo) : null, [geo])
  const { current: mapRef } = useMap()

  useEffect(() => {
    if (!enabled || geo) return
    fetch('/api/geo/countries')
      .then(r => r.ok ? r.json() : null)
      .then((d: GeoJSON.FeatureCollection | null) => { if (d) setGeo(d) })
      .catch(() => {})
  }, [enabled, geo])

  const [contextLost, setContextLost] = useState(false)
  useEffect(() => {
    const map = mapRef?.getMap()
    if (!map) return
    const canvas = map.getCanvas()
    const onLost = () => setContextLost(true)
    const onRestored = () => { setContextLost(false); setGeo(null) }
    canvas.addEventListener('webglcontextlost', onLost)
    canvas.addEventListener('webglcontextrestored', onRestored)
    return () => {
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
    }
  }, [mapRef])

  if (!enabled || !data || contextLost) return null

  const nameKey = neKeyForLang(language)

  return (
    <>
      <Source id="countries-lines-src" type="geojson" data={data.lines}>
        <Layer
          id="countries-line"
          type="line"
          paint={{
            'line-color': '#fde047',
            'line-width': 1.1,
            'line-opacity': 0.85,
          }}
        />
      </Source>
      <Source id="countries-labels-src" type="geojson" data={data.labels}>
        <Layer
          id="countries-label"
          type="symbol"
          minzoom={2.5}
          layout={{
            // Fallback NAME si la traduction est vide
            'text-field': ['coalesce', ['get', nameKey], ['get', 'NAME']],
            'text-size': ['interpolate', ['linear'], ['zoom'], 2.5, 9, 6, 13],
            'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
            'text-allow-overlap': false,
            'symbol-placement': 'point',
            'text-transform': 'uppercase',
            'text-letter-spacing': 0.08,
          }}
          paint={{
            'text-color': '#fef9c3',
            'text-halo-color': '#0f172a',
            'text-halo-width': 1.5,
            'text-opacity': 0.9,
          }}
        />
      </Source>
    </>
  )
}
