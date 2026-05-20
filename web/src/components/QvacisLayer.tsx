import { useCallback, useEffect, useRef, useState } from 'react'
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

export const QVACIS_FLS = [25, 75, 125, 175, 225, 275, 325, 375, 425, 475, 525, 575]
export type QvacisDataset = 'DETERMINISTIC' | 'PROBABILISTIC'

const QVACIS_BBOX: [number, number, number, number] = [-33, 21, 36, 34]

interface QvacisLayerProps {
  enabled: boolean
  dataset: QvacisDataset
  fl: number
  linkedInstant?: string | null
  onTimesLoaded?: (times: string[]) => void
  onLoadingChange?: (loading: boolean) => void
}

export default function QvacisLayer({ enabled, dataset, fl, linkedInstant, onTimesLoaded, onLoadingChange }: QvacisLayerProps) {
  const { current: mapRef } = useMap()
  const map = mapRef?.getMap()
  const [grid, setGrid] = useState<QvacisGrid | null>(null)
  const [stepIdx, setStepIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [info, setInfo] = useState<{ status: 'idle' | 'loading' | 'error'; msg?: string }>({ status: 'idle' })
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!enabled || !map) return
    let aborted = false
    const url = `/api/qvacis?dataset=${dataset}&fl=${fl}&bbox=${QVACIS_BBOX.join(',')}`
    setInfo({ status: 'loading' })
    onLoadingChange?.(true)
    fetch(url)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then((g: QvacisGrid) => {
        if (aborted) return
        setGrid(g)
        setStepIdx(g.current_idx ?? 0)
        if (onTimesLoaded) onTimesLoaded(g.steps?.map((s) => s.time) ?? [])
        setInfo({ status: 'idle' })
        onLoadingChange?.(false)
      })
      .catch((e) => { if (!aborted) { setInfo({ status: 'error', msg: String(e) }); onLoadingChange?.(false) } })
    return () => { aborted = true }
  }, [enabled, map, dataset, fl])

  useEffect(() => {
    if (!playing || !grid?.steps?.length) return
    const id = window.setInterval(() => setStepIdx((i) => (i + 1) % grid.steps.length), 900)
    return () => window.clearInterval(id)
  }, [playing, grid?.steps?.length])

  const effectiveStepIdx = (() => {
    if (!grid?.steps?.length) return 0
    if (linkedInstant) {
      let best = 0, bestDiff = Infinity
      const target = Date.parse(linkedInstant)
      for (let i = 0; i < grid.steps.length; i++) {
        const d = Math.abs(Date.parse(grid.steps[i].time) - target)
        if (d < bestDiff) { best = i; bestDiff = d }
      }
      return best
    }
    return Math.max(0, Math.min(grid.steps.length - 1, stepIdx))
  })()

  // Canvas overlay pixel-perfect : map.unproject() → coords geo → lookup grille.
  const renderCanvas = useCallback(() => {
    if (!enabled || !grid || !map || !canvasRef.current) return
    const step = grid.steps[effectiveStepIdx]
    if (!step) return

    const container = map.getContainer()
    const dpr = window.devicePixelRatio || 1
    const W = container.clientWidth
    const H = container.clientHeight
    const canvas = canvasRef.current

    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr)
      canvas.height = Math.round(H * dpr)
      canvas.style.width = W + 'px'
      canvas.style.height = H + 'px'
    }

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const [lonMin, latMin, lonMax, latMax] = grid.bbox
    const gridW = grid.width
    const gridH = grid.height
    const cW = canvas.width
    const cH = canvas.height

    // Rendu dans un canvas réduit, upscale bilinéaire → transitions douces.
    const SCALE = 3
    const sW = Math.ceil(cW / SCALE)
    const sH = Math.ceil(cH / SCALE)

    const small = document.createElement('canvas')
    small.width = sW
    small.height = sH
    const sCtx = small.getContext('2d')
    if (!sCtx) return
    const sImg = sCtx.createImageData(sW, sH)
    const data = sImg.data

    for (let sy = 0; sy < sH; sy++) {
      for (let sx = 0; sx < sW; sx++) {
        const px = (sx + 0.5) * SCALE
        const py = (sy + 0.5) * SCALE
        const lngLat = map.unproject([px / dpr, py / dpr])
        const lon = lngLat.lng
        const lat = lngLat.lat

        if (lon < lonMin || lon > lonMax || lat < latMin || lat > latMax) continue

        const gx = ((lon - lonMin) / (lonMax - lonMin)) * (gridW - 1)
        const gy = ((latMax - lat) / (latMax - latMin)) * (gridH - 1)
        const gxi = Math.min(Math.floor(gx), gridW - 2)
        const gyi = Math.min(Math.floor(gy), gridH - 2)
        const fx = gx - gxi
        const fy = gy - gyi

        // Interpolation bilinéaire de la concentration
        const c00 = step.conc[gyi * gridW + gxi] ?? 0
        const c10 = step.conc[gyi * gridW + gxi + 1] ?? c00
        const c01 = step.conc[(gyi + 1) * gridW + gxi] ?? c00
        const c11 = step.conc[(gyi + 1) * gridW + gxi + 1] ?? c10

        const conc =
          c00 * (1 - fx) * (1 - fy) +
          c10 * fx * (1 - fy) +
          c01 * (1 - fx) * fy +
          c11 * fx * fy

        const [r, g, b, a] = ashColor(conc)
        if (a === 0) continue
        const k = (sy * sW + sx) * 4
        data[k] = r; data[k + 1] = g; data[k + 2] = b; data[k + 3] = a
      }
    }
    sCtx.putImageData(sImg, 0, 0)

    ctx.clearRect(0, 0, cW, cH)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(small, 0, 0, cW, cH)
  }, [enabled, grid, effectiveStepIdx, map])

  useEffect(() => {
    if (!enabled || !map) return
    renderCanvas()
    map.on('move', renderCanvas)
    map.on('resize', renderCanvas)
    return () => {
      map.off('move', renderCanvas)
      map.off('resize', renderCanvas)
      if (canvasRef.current) {
        const ctx = canvasRef.current.getContext('2d')
        ctx?.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height)
      }
    }
  }, [enabled, map, renderCanvas])

  if (!enabled) return null
  const step = grid?.steps?.[effectiveStepIdx]

  return (
    <>
      <canvas
        ref={canvasRef}
        style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none', zIndex: 1 }}
      />
      {info.status === 'loading' && !grid && (
        <div className="absolute top-4 right-72 z-10 px-2 py-1 rounded bg-slate-950/80 backdrop-blur text-[0.625rem] text-slate-400 border border-slate-800/60">
          chargement cendres…
        </div>
      )}
      {info.status === 'error' && (
        <div className="absolute top-4 right-72 z-10 px-2 py-1 rounded bg-red-950/60 text-[0.625rem] text-red-300 border border-red-900/60">
          QVACIS: {info.msg}
        </div>
      )}
      {grid && step && (
        <div className="absolute bottom-64 right-4 z-10 px-3 py-2 rounded-lg bg-slate-950/85 backdrop-blur-md border border-orange-900/40 text-[0.625rem] text-slate-300 shadow-2xl flex flex-col gap-2 min-w-[280px]">
          <div className="flex items-center gap-2">
            <span className="text-orange-300/80">Cendres volcaniques</span>
            <span className="font-mono text-slate-400">FL{fl}</span>
            <span className="text-slate-600">·</span>
            <span className="font-mono">max {step.conc_max_mg_m3.toFixed(1)} mg/m³</span>
          </div>
          <div className="text-[0.5625rem] text-slate-500 font-mono truncate">
            {grid.coverage_id} · {step.time.replace('T', ' ').replace('Z', ' UTC')}
          </div>
          {grid.steps.length > 1 && !linkedInstant && (
            <div className="flex items-center gap-2">
              <button onClick={() => setPlaying((p) => !p)}
                className="size-6 rounded bg-orange-500/15 hover:bg-orange-500/25 border border-orange-500/30 flex items-center justify-center"
                aria-label={playing ? 'Pause' : 'Play'}>
                {playing ? <Pause className="size-3 text-orange-200" /> : <Play className="size-3 text-orange-200 translate-x-[1px]" />}
              </button>
              <input type="range" min={0} max={grid.steps.length - 1} value={stepIdx}
                onChange={(e) => { setPlaying(false); setStepIdx(Number(e.target.value)) }}
                className="flex-1 accent-orange-400 h-1" />
              <span className="font-mono tabular-nums text-[0.625rem] w-10 text-right">
                {stepIdx + 1}/{grid.steps.length}
              </span>
            </div>
          )}
          {linkedInstant && step && (
            <div className="text-[0.5625rem] text-orange-300/70 italic flex items-center justify-between gap-2">
              <span>synchro · step {effectiveStepIdx + 1}/{grid.steps.length}</span>
              <span className="text-orange-300/60 font-mono normal-case">
                Δ{qvacisDeltaMin(linkedInstant, step.time)} min
              </span>
            </div>
          )}
          <div className="flex items-center gap-1 mt-1">
            <span className="text-[0.5625rem] text-slate-500 w-9 text-right">0.001</span>
            <div className="flex-1 h-2 rounded-sm"
              style={{ background: 'linear-gradient(to right, rgba(255,235,80,0.4), rgb(255,180,40), rgb(240,80,40), rgb(200,40,120))' }} />
            <span className="text-[0.5625rem] text-slate-500 w-12">100 mg/m³</span>
          </div>
          <div className="text-[0.5625rem] text-slate-500">
            Seuils ICAO : 0.2 (low) · 2 (medium) · 4 (high · no-fly)
          </div>
        </div>
      )}
    </>
  )
}

function qvacisDeltaMin(linked: string, stepTime: string): string {
  const a = Date.parse(linked), b = Date.parse(stepTime)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '?'
  const d = Math.round((a - b) / 60_000)
  return d === 0 ? '0' : d > 0 ? `+${d}` : `${d}`
}

function ashColor(c: number): [number, number, number, number] {
  if (!Number.isFinite(c) || c < 0.001) return [0, 0, 0, 0]
  const t = Math.max(0, Math.min(1, (Math.log10(c) + 3) / 5))
  const stops: Array<[number, [number, number, number, number]]> = [
    [0.0, [255, 235, 80, 90]],
    [0.4, [255, 200, 50, 200]],
    [0.6, [255, 130, 40, 230]],
    [0.7, [240, 70, 40, 245]],
    [1.0, [200, 40, 120, 250]],
  ]
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1], [t1, c1] = stops[i]
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
