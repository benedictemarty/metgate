import { useEffect, useState } from 'react'
import { useMap } from 'react-map-gl/maplibre'
import { Pause, Play } from 'lucide-react'

interface TropoStep {
  time: string
  alt_min_m: number
  alt_max_m: number
  alt: number[]
}

interface TropoGrid {
  coverage_id: string
  bbox: [number, number, number, number]
  width: number
  height: number
  steps: TropoStep[]
  current_idx: number
}

const SOURCE_ID = 'metgate-tropo-src'
const LAYER_ID = 'metgate-tropo-layer'

// Échelle d'altitude tropopause (m). Hors plage = clamp.
const ALT_MIN_M = 5500
const ALT_MAX_M = 13500

interface TropoLayerProps {
  enabled: boolean
}

export default function TropoLayer({ enabled }: TropoLayerProps) {
  const { current: mapRef } = useMap()
  const map = mapRef?.getMap()
  const [grid, setGrid] = useState<TropoGrid | null>(null)
  const [stepIdx, setStepIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [info, setInfo] = useState<{ status: 'idle' | 'loading' | 'error'; msg?: string }>({
    status: 'idle',
  })

  // Fetch on enable + on viewport change.
  useEffect(() => {
    if (!enabled || !map) return
    let aborted = false
    let pending: number | null = null

    const fetchTropo = () => {
      const b = map.getBounds()
      const lonMin = Math.max(-180, b.getWest())
      const lonMax = Math.min(180, b.getEast())
      const latMin = Math.max(-90, b.getSouth())
      const latMax = Math.min(90, b.getNorth())
      const url = `/api/tropo?bbox=${lonMin.toFixed(2)},${latMin.toFixed(2)},${lonMax.toFixed(2)},${latMax.toFixed(2)}`
      setInfo({ status: 'loading' })
      fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          return r.json()
        })
        .then((g: TropoGrid) => {
          if (aborted) return
          setGrid(g)
          setStepIdx(g.current_idx ?? 0)
          setInfo({ status: 'idle' })
        })
        .catch((e) => {
          if (!aborted) setInfo({ status: 'error', msg: String(e) })
        })
    }

    const debouncedFetch = () => {
      if (pending !== null) window.clearTimeout(pending)
      pending = window.setTimeout(fetchTropo, 350)
    }

    fetchTropo()
    map.on('moveend', debouncedFetch)
    return () => {
      aborted = true
      if (pending !== null) window.clearTimeout(pending)
      map.off('moveend', debouncedFetch)
    }
  }, [enabled, map])

  // Auto-play.
  useEffect(() => {
    if (!playing || !grid?.steps?.length) return
    const id = window.setInterval(() => {
      setStepIdx((i) => (i + 1) % grid.steps.length)
    }, 1400)
    return () => window.clearInterval(id)
  }, [playing, grid?.steps?.length])

  // Re-render image when step / grid change.
  useEffect(() => {
    if (!enabled || !grid || !map) return
    const step = grid.steps[stepIdx]
    if (!step) return

    const canvas = document.createElement('canvas')
    canvas.width = grid.width
    canvas.height = grid.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const img = ctx.createImageData(grid.width, grid.height)
    const data = img.data
    for (let i = 0; i < step.alt.length; i++) {
      const a = step.alt[i]
      const k = i * 4
      if (Number.isNaN(a)) {
        data[k] = data[k + 1] = data[k + 2] = 0
        data[k + 3] = 0
        continue
      }
      const t = Math.max(0, Math.min(1, (a - ALT_MIN_M) / (ALT_MAX_M - ALT_MIN_M)))
      const c = palette(t)
      data[k] = c[0]
      data[k + 1] = c[1]
      data[k + 2] = c[2]
      data[k + 3] = 255 // opacité gérée par raster-opacity du layer
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
            'raster-opacity': 0.55,
            'raster-fade-duration': 0,
            'raster-resampling': 'linear',
          },
        })
      } catch (e) {
        console.warn('tropo layer add failed:', e)
      }
    }
  }, [enabled, grid, stepIdx, map])

  // Cleanup on disable / unmount.
  useEffect(() => {
    if (enabled || !map) return
    try {
      if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID)
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID)
    } catch {
      /* layer absent, ignore */
    }
  }, [enabled, map])

  if (!enabled) return null
  const step = grid?.steps?.[stepIdx]

  return (
    <>
      {info.status === 'loading' && !grid && (
        <div className="absolute top-4 right-44 z-10 px-2 py-1 rounded bg-slate-950/80 backdrop-blur text-[10px] text-slate-400 border border-slate-800/60">
          chargement tropopause…
        </div>
      )}
      {grid && step && (
        <div className="absolute bottom-44 right-4 z-10 px-3 py-2 rounded-lg bg-slate-950/85 backdrop-blur-md border border-slate-800/70 text-[10px] text-slate-300 shadow-2xl flex flex-col gap-2 min-w-[260px]">
          <div className="flex items-center gap-2">
            <span className="text-slate-500">Tropopause</span>
            <span className="font-mono">
              {(step.alt_min_m / 1000).toFixed(1)}–{(step.alt_max_m / 1000).toFixed(1)} km
            </span>
          </div>
          <div className="text-[9px] text-slate-500 font-mono truncate">
            {grid.coverage_id} · {step.time.replace('T', ' ').replace('Z', ' UTC')}
          </div>
          {grid.steps.length > 1 && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPlaying((p) => !p)}
                className="size-6 rounded bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 flex items-center justify-center"
                aria-label={playing ? 'Pause' : 'Play'}
              >
                {playing ? (
                  <Pause className="size-3 text-amber-200" />
                ) : (
                  <Play className="size-3 text-amber-200 translate-x-[1px]" />
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
                className="flex-1 accent-amber-400 h-1"
              />
              <span className="font-mono tabular-nums text-[10px] w-10 text-right">
                {stepIdx + 1}/{grid.steps.length}
              </span>
            </div>
          )}
          {/* Mini-légende palette */}
          <div className="flex items-center gap-1 mt-1">
            <span className="text-[9px] text-slate-500 w-7 text-right">5.5km</span>
            <div
              className="flex-1 h-2 rounded-sm"
              style={{
                background:
                  'linear-gradient(to right, rgb(200,60,60), rgb(240,140,60), rgb(240,220,80), rgb(120,200,100), rgb(60,130,200))',
              }}
            />
            <span className="text-[9px] text-slate-500 w-8">13.5km</span>
          </div>
        </div>
      )}
    </>
  )
}

function palette(t: number): [number, number, number] {
  const stops: Array<[number, [number, number, number]]> = [
    [0.0, [200, 60, 60]], // tropo basse → rouge (turbulence/intrusion strato)
    [0.25, [240, 140, 60]], // orange
    [0.5, [240, 220, 80]], // jaune
    [0.75, [120, 200, 100]], // vert
    [1.0, [60, 130, 200]], // tropo haute → bleu
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
      ]
    }
  }
  return [60, 130, 200]
}
