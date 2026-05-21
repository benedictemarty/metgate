import { useEffect, useMemo, useRef, useState } from 'react'
import { useMap } from 'react-map-gl/maplibre'
import { ChevronDown, ChevronRight, Filter, Pencil, RotateCcw, X } from 'lucide-react'
import type * as maplibregl from 'maplibre-gl'

// ─── Types ────────────────────────────────────────────────────────────────────

type DrawMode = 'off' | 'drawing' | 'done'

interface BBox { minLon: number; minLat: number; maxLon: number; maxLat: number }

export interface OGCFilter {
  icaoPattern: string
  bbox: BBox | null
}

interface Props {
  onFilterChange: (xml: string | null, filter: OGCFilter | null) => void
  onClose: () => void
}

// ─── Préréglages ──────────────────────────────────────────────────────────────

const COUNTRY_PRESETS = [
  { label: 'FR', pattern: 'LF*', title: 'France' },
  { label: 'DE', pattern: 'ED*', title: 'Allemagne' },
  { label: 'UK', pattern: 'EG*', title: 'Royaume-Uni' },
  { label: 'IT', pattern: 'LI*', title: 'Italie' },
  { label: 'ES', pattern: 'LE*', title: 'Espagne' },
  { label: 'US', pattern: 'K*',  title: 'États-Unis' },
  { label: 'CH', pattern: 'LS*', title: 'Suisse' },
  { label: 'BE', pattern: 'EB*', title: 'Belgique' },
]

const REGION_PRESETS = [
  { label: 'Europe',       bbox: { minLon: -15, minLat: 35, maxLon: 35, maxLat: 72 } },
  { label: 'France',       bbox: { minLon: -5.5, minLat: 41.3, maxLon: 9.8, maxLat: 51.5 } },
  { label: 'Méditerranée', bbox: { minLon: -6, minLat: 30, maxLon: 36, maxLat: 46 } },
  { label: 'Atl. Nord',    bbox: { minLon: -60, minLat: 40, maxLon: -10, maxLat: 65 } },
]

// ─── Générateurs OGC XML ──────────────────────────────────────────────────────

// Namespace et attributs exacts observés sur MetGate INT (cf. interface OGC Filter MetGate).
const FES = `xmlns:fes="https://www.opengis.net/fes/2.0"`
const GML = `xmlns:gml="http://www.opengis.net/gml/3.2"`
const LIKE_ATTRS = `matchCase="false" wildCard="*" singleChar="." escapeChar="!"`

function xmlICAO(pattern: string): string {
  return (
    `<fes:Filter ${FES}>` +
    `<fes:PropertyIsLike ${LIKE_ATTRS}>` +
    `<fes:PropertyName>locationIndicatorICAO</fes:PropertyName>` +
    `<fes:Literal>${pattern}</fes:Literal>` +
    `</fes:PropertyIsLike></fes:Filter>`
  )
}

function xmlBBox(b: BBox): string {
  return (
    `<fes:Filter ${FES}>` +
    `<fes:BBOX>` +
    `<gml:Envelope ${GML} srsName="CRS:84">` +
    `<gml:lowerCorner>${b.minLon} ${b.minLat}</gml:lowerCorner>` +
    `<gml:upperCorner>${b.maxLon} ${b.maxLat}</gml:upperCorner>` +
    `</gml:Envelope></fes:BBOX></fes:Filter>`
  )
}

function xmlCombined(pattern: string, b: BBox): string {
  return (
    `<fes:Filter ${FES}><fes:And>` +
    `<fes:PropertyIsLike ${LIKE_ATTRS}>` +
    `<fes:PropertyName>locationIndicatorICAO</fes:PropertyName>` +
    `<fes:Literal>${pattern}</fes:Literal>` +
    `</fes:PropertyIsLike>` +
    `<fes:BBOX>` +
    `<gml:Envelope ${GML} srsName="CRS:84">` +
    `<gml:lowerCorner>${b.minLon} ${b.minLat}</gml:lowerCorner>` +
    `<gml:upperCorner>${b.maxLon} ${b.maxLat}</gml:upperCorner>` +
    `</gml:Envelope></fes:BBOX>` +
    `</fes:And></fes:Filter>`
  )
}

function fmtCoord(n: number): string { return n.toFixed(2) }

// ─── Composant ────────────────────────────────────────────────────────────────

const SRC_ID = 'ogc-bbox-src'
const LYR_FILL = 'ogc-bbox-fill'
const LYR_LINE = 'ogc-bbox-line'

export default function OGCFilterPanel({ onFilterChange, onClose }: Props) {
  const { current: mapRef } = useMap()
  const map = mapRef?.getMap() as maplibregl.Map | undefined

  const [icaoPattern, setIcaoPattern] = useState('')
  const [bbox, setBbox] = useState<BBox | null>(null)
  const [drawMode, setDrawMode] = useState<DrawMode>('off')
  const [xmlOpen, setXmlOpen] = useState(false)
  const [applied, setApplied] = useState(false)

  const drawStartRef = useRef<{ lng: number; lat: number } | null>(null)

  // ── Dessin du rectangle sur la carte ────────────────────────────────────────
  useEffect(() => {
    if (!map || drawMode !== 'drawing') return

    map.dragPan.disable()
    map.boxZoom.disable()
    map.getCanvas().style.cursor = 'crosshair'

    const updateRect = (minLon: number, minLat: number, maxLon: number, maxLat: number) => {
      const fc: GeoJSON.FeatureCollection = {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [[[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]]],
          },
          properties: {},
        }],
      }
      const src = map.getSource(SRC_ID) as (maplibregl.GeoJSONSource & { setData: (d: GeoJSON.FeatureCollection) => void }) | undefined
      if (src) {
        src.setData(fc)
      } else {
        map.addSource(SRC_ID, { type: 'geojson', data: fc })
        map.addLayer({ id: LYR_FILL, source: SRC_ID, type: 'fill', paint: { 'fill-color': '#6366f1', 'fill-opacity': 0.15 } })
        map.addLayer({ id: LYR_LINE, source: SRC_ID, type: 'line', paint: { 'line-color': '#818cf8', 'line-width': 1.5, 'line-dasharray': [4, 2] } })
      }
    }

    const onMouseDown = (e: maplibregl.MapMouseEvent) => {
      drawStartRef.current = { lng: e.lngLat.lng, lat: e.lngLat.lat }
    }
    const onMouseMove = (e: maplibregl.MapMouseEvent) => {
      const s = drawStartRef.current
      if (!s) return
      updateRect(
        Math.min(s.lng, e.lngLat.lng), Math.min(s.lat, e.lngLat.lat),
        Math.max(s.lng, e.lngLat.lng), Math.max(s.lat, e.lngLat.lat),
      )
    }
    const onMouseUp = (e: maplibregl.MapMouseEvent) => {
      const s = drawStartRef.current
      if (!s) return
      const b: BBox = {
        minLon: Math.min(s.lng, e.lngLat.lng),
        maxLon: Math.max(s.lng, e.lngLat.lng),
        minLat: Math.min(s.lat, e.lngLat.lat),
        maxLat: Math.max(s.lat, e.lngLat.lat),
      }
      drawStartRef.current = null
      setBbox(b)
      setDrawMode('done')
    }

    map.on('mousedown', onMouseDown)
    map.on('mousemove', onMouseMove)
    map.on('mouseup', onMouseUp)

    return () => {
      map.off('mousedown', onMouseDown)
      map.off('mousemove', onMouseMove)
      map.off('mouseup', onMouseUp)
      map.dragPan.enable()
      map.boxZoom.enable()
      map.getCanvas().style.cursor = ''
    }
  }, [map, drawMode])

  // ── Overlay zone dessinée persistante ───────────────────────────────────────
  useEffect(() => {
    if (!map) return
    const cleanup = () => {
      if (map.getLayer(LYR_FILL)) map.removeLayer(LYR_FILL)
      if (map.getLayer(LYR_LINE)) map.removeLayer(LYR_LINE)
      if (map.getSource(SRC_ID)) map.removeSource(SRC_ID)
    }
    if (!bbox || drawMode === 'drawing') { if (drawMode !== 'drawing') cleanup(); return }
    const { minLon, minLat, maxLon, maxLat } = bbox
    const fc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]]] },
        properties: {},
      }],
    }
    if (map.getSource(SRC_ID)) {
      ;(map.getSource(SRC_ID) as maplibregl.GeoJSONSource & { setData: (d: GeoJSON.FeatureCollection) => void }).setData(fc)
    } else {
      map.addSource(SRC_ID, { type: 'geojson', data: fc })
      map.addLayer({ id: LYR_FILL, source: SRC_ID, type: 'fill', paint: { 'fill-color': '#6366f1', 'fill-opacity': 0.15 } })
      map.addLayer({ id: LYR_LINE, source: SRC_ID, type: 'line', paint: { 'line-color': '#818cf8', 'line-width': 2, 'line-dasharray': [4, 2] } })
    }
    return cleanup
  }, [map, bbox, drawMode])

  // ── XML OGC généré ──────────────────────────────────────────────────────────
  const generatedXml = useMemo<string | null>(() => {
    const hasIcao = icaoPattern.trim() !== ''
    const hasBbox = bbox !== null
    if (hasIcao && hasBbox) return xmlCombined(icaoPattern.trim(), bbox)
    if (hasIcao) return xmlICAO(icaoPattern.trim())
    if (hasBbox) return xmlBBox(bbox)
    return null
  }, [icaoPattern, bbox])

  const reset = () => {
    setIcaoPattern('')
    setBbox(null)
    setDrawMode('off')
    setApplied(false)
    drawStartRef.current = null
    onFilterChange(null, null)
  }

  const apply = () => {
    setApplied(true)
    onFilterChange(generatedXml, generatedXml ? { icaoPattern: icaoPattern.trim(), bbox } : null)
  }

  const hasFilter = icaoPattern.trim() !== '' || bbox !== null

  return (
    <div className="absolute top-16 right-4 z-20 w-80 rounded-xl border border-indigo-900/40 bg-slate-950/90 backdrop-blur-md shadow-2xl text-[0.6875rem] text-slate-200 select-none">
      {/* En-tête */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-slate-800/60">
        <Filter className="size-3.5 text-indigo-400 shrink-0" />
        <span className="font-semibold text-indigo-200 uppercase tracking-wider text-[0.625rem]">Filtre OPMET (OGC)</span>
        {applied && hasFilter && (
          <span className="ml-1 px-1.5 py-0.5 rounded-full bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 text-[0.5625rem]">actif</span>
        )}
        <button onClick={reset} title="Réinitialiser" className="ml-auto text-slate-500 hover:text-amber-300 transition">
          <RotateCcw className="size-3.5" />
        </button>
        <button onClick={onClose} title="Fermer" className="text-slate-500 hover:text-slate-200 transition">
          <X className="size-3.5" />
        </button>
      </div>

      <div className="px-3 py-2.5 flex flex-col gap-3">

        {/* ── Section STATIONS ─────────────────────────────────────────── */}
        <div>
          <div className="text-slate-400 uppercase tracking-wider text-[0.5625rem] mb-1.5">Stations (code ICAO)</div>
          <input
            type="text"
            value={icaoPattern}
            onChange={e => setIcaoPattern(e.target.value.toUpperCase())}
            placeholder="ex: LF* ou LFPG ou ED*"
            className="w-full px-2 py-1 rounded bg-slate-900/70 border border-slate-700/60 font-mono text-slate-200 placeholder-slate-600 focus:outline-none focus:border-indigo-500/50 text-[0.6875rem]"
          />
          <div className="flex flex-wrap gap-1 mt-1.5">
            {COUNTRY_PRESETS.map(p => (
              <button
                key={p.label}
                title={p.title}
                onClick={() => setIcaoPattern(p.pattern)}
                className={`px-1.5 py-0.5 rounded border text-[0.5625rem] font-mono transition ${
                  icaoPattern === p.pattern
                    ? 'border-indigo-500/60 bg-indigo-500/20 text-indigo-200'
                    : 'border-slate-700/60 bg-slate-900/40 text-slate-400 hover:text-slate-200 hover:border-slate-600'
                }`}
              >
                {p.label}
              </button>
            ))}
            {icaoPattern && (
              <button onClick={() => setIcaoPattern('')} className="px-1.5 py-0.5 rounded border border-slate-700/60 text-slate-500 hover:text-slate-300 transition text-[0.5625rem]">
                ✕
              </button>
            )}
          </div>
        </div>

        {/* ── Section ZONE ─────────────────────────────────────────────── */}
        <div>
          <div className="text-slate-400 uppercase tracking-wider text-[0.5625rem] mb-1.5">Zone géographique</div>

          {drawMode === 'off' && !bbox && (
            <button
              onClick={() => setDrawMode('drawing')}
              className="flex items-center gap-1.5 w-full px-2 py-1.5 rounded border border-dashed border-slate-700/60 text-slate-400 hover:border-indigo-500/50 hover:text-indigo-300 transition"
            >
              <Pencil className="size-3" />
              Cliquer-glisser sur la carte pour dessiner
            </button>
          )}

          {drawMode === 'drawing' && (
            <div className="flex items-center gap-1.5 px-2 py-1.5 rounded border border-indigo-500/40 bg-indigo-500/10 text-indigo-300 animate-pulse">
              <Pencil className="size-3" />
              Maintenir le clic et glisser sur la carte…
            </div>
          )}

          {bbox && drawMode !== 'drawing' && (
            <div className="flex items-center gap-2">
              <div className="flex-1 px-2 py-1 rounded bg-slate-900/60 border border-indigo-900/40 font-mono text-slate-300 text-[0.5625rem]">
                {fmtCoord(bbox.minLon)}°,{fmtCoord(bbox.minLat)}° → {fmtCoord(bbox.maxLon)}°,{fmtCoord(bbox.maxLat)}°
              </div>
              <button
                onClick={() => { setBbox(null); setDrawMode('off') }}
                className="text-slate-500 hover:text-slate-200 transition shrink-0"
                title="Effacer la zone"
              >
                <X className="size-3.5" />
              </button>
              <button
                onClick={() => setDrawMode('drawing')}
                className="text-slate-500 hover:text-indigo-300 transition shrink-0"
                title="Redessiner"
              >
                <Pencil className="size-3" />
              </button>
            </div>
          )}

          {/* Régions prédéfinies */}
          <div className="flex flex-wrap gap-1 mt-1.5">
            {REGION_PRESETS.map(r => (
              <button
                key={r.label}
                onClick={() => { setBbox(r.bbox); setDrawMode('done') }}
                className={`px-1.5 py-0.5 rounded border text-[0.5625rem] transition ${
                  bbox && Math.abs(bbox.minLon - r.bbox.minLon) < 0.1
                    ? 'border-indigo-500/60 bg-indigo-500/20 text-indigo-200'
                    : 'border-slate-700/60 bg-slate-900/40 text-slate-400 hover:text-slate-200 hover:border-slate-600'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {/* ── Filtre OGC XML (pliable) ─────────────────────────────────── */}
        {generatedXml && (
          <div className="border border-slate-800/60 rounded-lg overflow-hidden">
            <button
              onClick={() => setXmlOpen(v => !v)}
              className="flex items-center gap-1.5 w-full px-2 py-1.5 text-slate-500 hover:text-slate-300 transition"
            >
              {xmlOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              <span className="text-[0.5625rem] uppercase tracking-wider">Voir le filtre OGC généré</span>
            </button>
            {xmlOpen && (
              <pre className="px-2 pb-2 text-[0.5rem] font-mono text-slate-400 bg-slate-950/60 whitespace-pre-wrap break-all leading-relaxed">
                {generatedXml
                  .replace(/></g, '>\n')
                  .replace(/</g, '  <')
                  .replace(/  <\//g, '</')
                  .trim()}
              </pre>
            )}
          </div>
        )}

        {/* ── Bouton Appliquer ─────────────────────────────────────────── */}
        <button
          onClick={apply}
          disabled={!hasFilter}
          className="w-full py-1.5 rounded-lg font-medium text-[0.6875rem] transition disabled:opacity-40 disabled:cursor-not-allowed bg-indigo-600/80 hover:bg-indigo-500/80 border border-indigo-500/40 text-white"
        >
          Appliquer le filtre
        </button>
      </div>
    </div>
  )
}
