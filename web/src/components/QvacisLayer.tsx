import { useEffect, useState } from 'react'
import { useMap } from 'react-map-gl/maplibre'
import { Pause, Play } from 'lucide-react'

interface QvacisStep {
  time: string
  conc_min_mg_m3: number
  conc_max_mg_m3: number
  conc: number[]
  has_ash: boolean
}

interface QvacisGrid {
  coverage_id: string
  dataset: string
  flight_level: number
  bbox: [number, number, number, number]
  width: number
  height: number
  steps: QvacisStep[]
  current_idx: number
}

const SOURCE_ID = 'metgate-qvacis-src'
const LAYER_ID = 'metgate-qvacis-layer'

export const QVACIS_FLS = [25, 75, 125, 175, 225, 275, 325, 375, 425, 475, 525, 575]
export type QvacisDataset = 'DETERMINISTIC' | 'PROBABILISTIC'

// Bbox utile = celle où MetGate publie effectivement le coverage. On ne suit
// PAS la viewport ici parce que QVACIS n'est pas global (Sahara/Atlantique).
const QVACIS_BBOX: [number, number, number, number] = [-33, 21, 36, 34]

interface QvacisLayerProps {
  enabled: boolean
  dataset: QvacisDataset
  fl: number
  linkedInstant?: string | null
  onTimesLoaded?: (times: string[]) => void
}

export default function QvacisLayer({
  enabled,
  dataset,
  fl,
  linkedInstant,
  onTimesLoaded,
}: QvacisLayerProps) {
  const { current: mapRef } = useMap()
  const map = mapRef?.getMap()
  const [grid, setGrid] = useState<QvacisGrid | null>(null)
  const [stepIdx, setStepIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [info, setInfo] = useState<{ status: 'idle' | 'loading' | 'error'; msg?: string }>({
    status: 'idle',
  })

  useEffect(() => {
    if (!enabled || !map) return
    let aborted = false
    const url = `/api/qvacis?dataset=${dataset}&fl=${fl}&bbox=${QVACIS_BBOX.join(',')}`
    setInfo({ status: 'loading' })
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((g: QvacisGrid) => {
        if (aborted) return
        setGrid(g)
        setStepIdx(g.current_idx ?? 0)
        if (onTimesLoaded) onTimesLoaded(g.steps?.map((s) => s.time) ?? [])
        setInfo({ status: 'idle' })
      })
      .catch((e) => {
        if (!aborted) setInfo({ status: 'error', msg: String(e) })
      })
    return () => {
      aborted = true
    }
  }, [enabled, map, dataset, fl])

  useEffect(() => {
    if (!playing || !grid?.steps?.length) return
    const id = window.setInterval(() => {
      setStepIdx((i) => (i + 1) % grid.steps.length)
    }, 900)
    return () => window.clearInterval(id)
  }, [playing, grid?.steps?.length])

  const effectiveStepIdx = (() => {
    if (!grid?.steps?.length) return 0
    if (linkedInstant) {
      let best = 0
      let bestDiff = Number.POSITIVE_INFINITY
      const target = Date.parse(linkedInstant)
      for (let i = 0; i < grid.steps.length; i++) {
        const d = Math.abs(Date.parse(grid.steps[i].time) - target)
        if (d < bestDiff) {
          best = i
          bestDiff = d
        }
      }
      return best
    }
    return Math.max(0, Math.min(grid.steps.length - 1, stepIdx))
  })()

  // Render image when step changes.
  useEffect(() => {
    if (!enabled || !grid || !map) return
    const step = grid.steps[effectiveStepIdx]
    if (!step) return

    const canvas = document.createElement('canvas')
    canvas.width = grid.width
    canvas.height = grid.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const img = ctx.createImageData(grid.width, grid.height)
    const d = img.data
    for (let i = 0; i < step.conc.length; i++) {
      const c = step.conc[i]
      const k = i * 4
      const px = ashColor(c)
      d[k] = px[0]
      d[k + 1] = px[1]
      d[k + 2] = px[2]
      d[k + 3] = px[3]
    }
    ctx.putImageData(img, 0, 0)
    const dataURL = canvas.toDataURL('image/png')

    const [lonMin, latMin, lonMax, latMax] = grid.bbox
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

    const src = map.getSource(SOURCE_ID) as
      | { updateImage: (o: { url: string; coordinates: typeof coords }) => void }
      | undefined
    if (src && typeof src.updateImage === 'function') {
      src.updateImage({ url: dataURL, coordinates: coords })
    } else {
      try {
        map.addSource(SOURCE_ID, {
          type: 'image',
          url: dataURL,
          coordinates: coords,
        })
        map.addLayer({
          id: LAYER_ID,
          type: 'raster',
          source: SOURCE_ID,
          paint: {
            'raster-opacity': 0.85,
            'raster-fade-duration': 0,
            'raster-resampling': 'nearest',
          },
        })
      } catch (e) {
        console.warn('qvacis layer add failed:', e)
      }
    }
  }, [enabled, grid, effectiveStepIdx, map])

  // Cleanup on disable.
  useEffect(() => {
    if (enabled || !map) return
    try {
      if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID)
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID)
    } catch {
      /* */
    }
  }, [enabled, map])

  if (!enabled) return null
  const step = grid?.steps?.[effectiveStepIdx]
  return (
    <>
      {info.status === 'loading' && !grid && (
        <div className="absolute top-4 right-72 z-10 px-2 py-1 rounded bg-slate-950/80 backdrop-blur text-[10px] text-slate-400 border border-slate-800/60">
          chargement cendres…
        </div>
      )}
      {info.status === 'error' && (
        <div className="absolute top-4 right-72 z-10 px-2 py-1 rounded bg-red-950/60 text-[10px] text-red-300 border border-red-900/60">
          QVACIS: {info.msg}
        </div>
      )}
      {grid && step && (
        <div className="absolute bottom-64 right-4 z-10 px-3 py-2 rounded-lg bg-slate-950/85 backdrop-blur-md border border-orange-900/40 text-[10px] text-slate-300 shadow-2xl flex flex-col gap-2 min-w-[280px]">
          <div className="flex items-center gap-2">
            <span className="text-orange-300/80">Cendres volcaniques</span>
            <span className="font-mono text-slate-400">FL{fl}</span>
            <span className="text-slate-600">·</span>
            <span className="font-mono">
              max {step.conc_max_mg_m3.toFixed(1)} mg/m³
            </span>
          </div>
          <div className="text-[9px] text-slate-500 font-mono truncate">
            {grid.coverage_id} · {step.time.replace('T', ' ').replace('Z', ' UTC')}
          </div>
          {grid.steps.length > 1 && !linkedInstant && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPlaying((p) => !p)}
                className="size-6 rounded bg-orange-500/15 hover:bg-orange-500/25 border border-orange-500/30 flex items-center justify-center"
                aria-label={playing ? 'Pause' : 'Play'}
              >
                {playing ? (
                  <Pause className="size-3 text-orange-200" />
                ) : (
                  <Play className="size-3 text-orange-200 translate-x-[1px]" />
                )}
              </button>
              <input
                type="range"
                min={0}
                max={grid.steps.length - 1}
                value={stepIdx}
                onChange={(e) => {
                  setPlaying(false)
                  setStepIdx(Number(e.target.value))
                }}
                className="flex-1 accent-orange-400 h-1"
              />
              <span className="font-mono tabular-nums text-[10px] w-10 text-right">
                {stepIdx + 1}/{grid.steps.length}
              </span>
            </div>
          )}
          {linkedInstant && step && (
            <div className="text-[9px] text-orange-300/70 italic flex items-center justify-between gap-2">
              <span>synchro · step {effectiveStepIdx + 1}/{grid.steps.length}</span>
              <span className="text-orange-300/60 font-mono normal-case">
                Δ{qvacisDeltaMin(linkedInstant, step.time)} min
              </span>
            </div>
          )}
          <div className="flex items-center gap-1 mt-1">
            <span className="text-[9px] text-slate-500 w-9 text-right">0.001</span>
            <div
              className="flex-1 h-2 rounded-sm"
              style={{
                background:
                  'linear-gradient(to right, rgba(255,235,80,0.4), rgb(255,180,40), rgb(240,80,40), rgb(200,40,120))',
              }}
            />
            <span className="text-[9px] text-slate-500 w-12">100 mg/m³</span>
          </div>
          <div className="text-[9px] text-slate-500">
            Seuils ICAO : 0.2 (low) · 2 (medium) · 4 (high · no-fly)
          </div>
        </div>
      )}
    </>
  )
}

function qvacisDeltaMin(linked: string, stepTime: string): string {
  const a = Date.parse(linked)
  const b = Date.parse(stepTime)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '?'
  const d = Math.round((a - b) / 60_000)
  if (d === 0) return '0'
  return d > 0 ? `+${d}` : `${d}`
}

// ashColor : palette logarithmique pour les concentrations en mg/m³
// suivant les seuils OACI. Sous 0.001 mg/m³ : transparent.
function ashColor(c: number): [number, number, number, number] {
  if (!Number.isFinite(c) || c < 0.001) return [0, 0, 0, 0]
  // Échelle log : c=0.001 → t=0, c=100 → t=1
  const t = Math.max(0, Math.min(1, (Math.log10(c) + 3) / 5))
  const stops: Array<[number, [number, number, number, number]]> = [
    [0.0, [255, 235, 80, 90]], // jaune pâle ~0.001 mg/m³
    [0.4, [255, 200, 50, 200]], // ambre ~0.2 (low)
    [0.6, [255, 130, 40, 230]], // orange ~2 (medium)
    [0.7, [240, 70, 40, 245]], // rouge ~4 (high)
    [1.0, [200, 40, 120, 250]], // magenta ~100
  ]
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1]
      const [t1, c1] = stops[i]
      const u = (t - t0) / (t1 - t0)
      return [
        Math.floor(c0[0] + (c1[0] - c0[0]) * u),
        Math.floor(c0[1] + (c1[1] - c0[1]) * u),
        Math.floor(c0[2] + (c1[2] - c0[2]) * u),
        Math.floor(c0[3] + (c1[3] - c0[3]) * u),
      ]
    }
  }
  return [200, 40, 120, 250]
}
