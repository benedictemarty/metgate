import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

// Bbox fixe (lonMin, latMin, lonMax, latMax) couvrant le domaine d'intérêt.
const TROPO_BBOX: [number, number, number, number] = [-60, -40, 60, 75]

interface TropoLayerProps {
  enabled: boolean
  linkedInstant?: string | null
  onTimesLoaded?: (times: string[]) => void
}

export default function TropoLayer({ enabled, linkedInstant, onTimesLoaded }: TropoLayerProps) {
  const { current: mapRef } = useMap()
  const map = mapRef?.getMap()
  const [grid, setGrid] = useState<TropoGrid | null>(null)
  const [stepIdx, setStepIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [info, setInfo] = useState<{ status: 'idle' | 'loading' | 'error'; msg?: string }>({ status: 'idle' })
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Fetch unique au mount / activation.
  useEffect(() => {
    if (!enabled || !map) return
    let aborted = false
    const [lonMin, latMin, lonMax, latMax] = TROPO_BBOX
    setInfo({ status: 'loading' })
    fetch(`/api/tropo?bbox=${lonMin},${latMin},${lonMax},${latMax}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then((g: TropoGrid) => {
        if (aborted) return
        setGrid(g)
        setStepIdx(g.current_idx ?? 0)
        if (onTimesLoaded) onTimesLoaded(g.steps?.map((s) => s.time) ?? [])
        setInfo({ status: 'idle' })
      })
      .catch((e) => { if (!aborted) setInfo({ status: 'error', msg: String(e) }) })
    return () => { aborted = true }
  }, [enabled, map])

  // Auto-play.
  useEffect(() => {
    if (!playing || !grid?.steps?.length) return
    const id = window.setInterval(() => setStepIdx((i) => (i + 1) % grid.steps.length), 1400)
    return () => window.clearInterval(id)
  }, [playing, grid?.steps?.length])

  // Index effectif du step.
  const effectiveStepIdx = useMemo(() => {
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
  }, [grid, stepIdx, linkedInstant])

  // Rendu canvas : chaque pixel écran est projeté en geo via map.unproject(),
  // puis interpolé bilinéairement dans la grille. Pixel-perfect à tous les zooms.
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
    const altMin = step.alt_min_m
    const altMax = step.alt_max_m
    const span = Math.max(1, altMax - altMin)
    const cW = canvas.width
    const cH = canvas.height

    const img = ctx.createImageData(cW, cH)
    const data = img.data

    // Pas de 3 px : réduit le coût 9× sans perte visuelle (grille basse résolution).
    const STEP = 3

    for (let py = 0; py < cH; py += STEP) {
      for (let px = 0; px < cW; px += STEP) {
        const lngLat = map.unproject([px / dpr, py / dpr])
        const lon = lngLat.lng
        const lat = lngLat.lat

        if (lon < lonMin || lon > lonMax || lat < latMin || lat > latMax) continue

        // Position fractionnaire dans la grille (lat inversée : row 0 = latMax)
        const gx = ((lon - lonMin) / (lonMax - lonMin)) * (gridW - 1)
        const gy = ((latMax - lat) / (latMax - latMin)) * (gridH - 1)

        const gxi = Math.min(Math.floor(gx), gridW - 2)
        const gyi = Math.min(Math.floor(gy), gridH - 2)
        const fx = gx - gxi
        const fy = gy - gyi

        const a00 = step.alt[gyi * gridW + gxi]
        const a10 = step.alt[gyi * gridW + gxi + 1]
        const a01 = step.alt[(gyi + 1) * gridW + gxi]
        const a11 = step.alt[(gyi + 1) * gridW + gxi + 1]

        const v00 = isNaN(a00) ? null : a00
        const v10 = isNaN(a10) ? v00 : a10
        const v01 = isNaN(a01) ? v00 : a01
        const v11 = isNaN(a11) ? (v10 ?? v01) : a11

        if (v00 === null) continue

        const alt =
          (v00 ?? 0) * (1 - fx) * (1 - fy) +
          (v10 ?? 0) * fx * (1 - fy) +
          (v01 ?? 0) * (1 - fx) * fy +
          (v11 ?? 0) * fx * fy

        const t = Math.max(0, Math.min(1, (alt - altMin) / span))
        const [r, g, b] = palette(t)

        // Rempli le bloc STEP×STEP
        for (let dy = 0; dy < STEP && py + dy < cH; dy++) {
          for (let dx = 0; dx < STEP && px + dx < cW; dx++) {
            const k = ((py + dy) * cW + (px + dx)) * 4
            data[k] = r; data[k + 1] = g; data[k + 2] = b; data[k + 3] = 155
          }
        }
      }
    }
    ctx.putImageData(img, 0, 0)
  }, [enabled, grid, effectiveStepIdx, map])

  // Déclenche le rendu et s'abonne aux événements carte.
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
        style={{
          position: 'absolute', top: 0, left: 0, pointerEvents: 'none',
          mixBlendMode: 'screen', zIndex: 1,
        }}
      />
      {info.status === 'loading' && !grid && (
        <div className="absolute top-4 right-44 z-10 px-2 py-1 rounded bg-slate-950/80 backdrop-blur text-[0.625rem] text-slate-400 border border-slate-800/60">
          chargement tropopause…
        </div>
      )}
      {grid && step && (
        <div className="absolute bottom-44 right-4 z-10 px-3 py-2 rounded-lg bg-slate-950/85 backdrop-blur-md border border-slate-800/70 text-[0.625rem] text-slate-300 shadow-2xl flex flex-col gap-2 min-w-[260px]">
          <div className="flex items-center gap-2">
            <span className="text-slate-500">Tropopause</span>
            <span className="font-mono">
              {(step.alt_min_m / 1000).toFixed(1)}–{(step.alt_max_m / 1000).toFixed(1)} km
            </span>
          </div>
          <div className="text-[0.5625rem] text-slate-500 font-mono truncate">
            {grid.coverage_id} · {step.time.replace('T', ' ').replace('Z', ' UTC')}
          </div>
          {grid.steps.length > 1 && !linkedInstant && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPlaying((p) => !p)}
                className="size-6 rounded bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 flex items-center justify-center"
                aria-label={playing ? 'Pause' : 'Play'}
              >
                {playing ? <Pause className="size-3 text-amber-200" /> : <Play className="size-3 text-amber-200 translate-x-[1px]" />}
              </button>
              <input
                type="range" min={0} max={grid.steps.length - 1} value={stepIdx}
                onChange={(e) => { setPlaying(false); setStepIdx(Number(e.target.value)) }}
                className="flex-1 accent-amber-400 h-1"
              />
              <span className="font-mono tabular-nums text-[0.625rem] w-10 text-right">
                {stepIdx + 1}/{grid.steps.length}
              </span>
            </div>
          )}
          {linkedInstant && step && (
            <div className="text-[0.5625rem] text-amber-300/70 italic flex items-center justify-between gap-2">
              <span>synchro · step {effectiveStepIdx + 1}/{grid.steps.length}</span>
              <span className="text-amber-300/60 font-mono normal-case">
                Δ{tropoDeltaMin(linkedInstant, step.time)} min
              </span>
            </div>
          )}
          <div className="flex items-center gap-1 mt-1">
            <span className="text-[0.5625rem] text-slate-500 w-9 text-right">
              {(step.alt_min_m / 1000).toFixed(1)}km
            </span>
            <div
              className="flex-1 h-2 rounded-sm"
              style={{ background: 'linear-gradient(to right, rgb(200,60,60), rgb(240,140,60), rgb(240,220,80), rgb(120,200,100), rgb(60,130,200))' }}
            />
            <span className="text-[0.5625rem] text-slate-500 w-9">
              {(step.alt_max_m / 1000).toFixed(1)}km
            </span>
          </div>
        </div>
      )}
    </>
  )
}

function tropoDeltaMin(linked: string, stepTime: string): string {
  const a = Date.parse(linked), b = Date.parse(stepTime)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '?'
  const d = Math.round((a - b) / 60_000)
  return d === 0 ? '0' : d > 0 ? `+${d}` : `${d}`
}

function palette(t: number): [number, number, number] {
  const stops: Array<[number, [number, number, number]]> = [
    [0.0, [200, 60, 60]],
    [0.25, [240, 140, 60]],
    [0.5, [240, 220, 80]],
    [0.75, [120, 200, 100]],
    [1.0, [60, 130, 200]],
  ]
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1], [t1, c1] = stops[i]
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
