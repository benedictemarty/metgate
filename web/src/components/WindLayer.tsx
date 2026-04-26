import { useEffect, useMemo, useRef, useState } from 'react'
import { useMap } from 'react-map-gl/maplibre'
import { Pause, Play } from 'lucide-react'

interface WindStep {
  time: string
  speed_max_ms: number
  u: number[]
  v: number[]
}

interface WindGrid {
  coverage_id: string
  level_pa: number
  bbox: [number, number, number, number] // lonMin,latMin,lonMax,latMax
  width: number
  height: number
  steps: WindStep[]
  current_idx: number
}

interface Particle {
  lon: number
  lat: number
  age: number
  maxAge: number
}

const PARTICLE_COUNT = 1800
const FADE_ALPHA = 0.07
const SPEED_FACTOR = 0.04 // deg/sec ≈ (m/s) * SPEED_FACTOR / cos(lat) — empirique pour visu

interface WindLayerProps {
  enabled: boolean
  dataset: 'WIND' | 'JET'
  level?: number // Pa, ignored if dataset='JET'
  // Mode synchronisé : si défini, le step affiché est celui dont .time est
  // le plus proche de linkedInstant ; le slider individuel est masqué.
  linkedInstant?: string | null
  // Notifie le parent des timestamps disponibles dès que la grille est
  // chargée. Le parent les agrège pour le slider master.
  onTimesLoaded?: (times: string[]) => void
}

export default function WindLayer({
  enabled,
  dataset,
  level = 85000,
  linkedInstant,
  onTimesLoaded,
}: WindLayerProps) {
  const { current: mapWrapper } = useMap()
  const map = mapWrapper?.getMap()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const particlesRef = useRef<Particle[]>([])
  const [grid, setGrid] = useState<WindGrid | null>(null)
  const [stepIdx, setStepIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [info, setInfo] = useState<{ status: 'idle' | 'loading' | 'error'; msg?: string }>({
    status: 'idle',
  })

  // Fetch wind data on enable + on each significant view change.
  useEffect(() => {
    if (!enabled || !map) return

    let aborted = false
    let pending: number | null = null

    const fetchWind = () => {
      const b = map.getBounds()
      // Bbox limitée à -180..180, -90..90 pour rester sain.
      const lonMin = Math.max(-180, b.getWest())
      const lonMax = Math.min(180, b.getEast())
      const latMin = Math.max(-90, b.getSouth())
      const latMax = Math.min(90, b.getNorth())
      const params = new URLSearchParams({
        bbox: `${lonMin.toFixed(2)},${latMin.toFixed(2)},${lonMax.toFixed(2)},${latMax.toFixed(2)}`,
        dataset,
        allSteps: '1',
      })
      if (dataset === 'WIND') params.set('level', String(level))
      const url = `/api/wind?${params.toString()}`
      setInfo({ status: 'loading' })
      fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          return r.json()
        })
        .then((g: WindGrid) => {
          if (aborted) return
          setGrid(g)
          setStepIdx(g.current_idx ?? 0)
          particlesRef.current = Array.from({ length: PARTICLE_COUNT }, () =>
            spawnParticle(g),
          )
          if (onTimesLoaded) {
            onTimesLoaded(g.steps?.map((s) => s.time) ?? [])
          }
          setInfo({ status: 'idle' })
        })
        .catch((e) => {
          if (!aborted) setInfo({ status: 'error', msg: String(e) })
        })
    }

    const debouncedFetch = () => {
      if (pending !== null) window.clearTimeout(pending)
      pending = window.setTimeout(fetchWind, 350)
    }

    fetchWind()
    map.on('moveend', debouncedFetch)
    return () => {
      aborted = true
      if (pending !== null) window.clearTimeout(pending)
      map.off('moveend', debouncedFetch)
    }
  }, [enabled, map, level, dataset])

  // Mode lié : on dérive l'index du step depuis linkedInstant.
  const effectiveStepIdx = useMemo(() => {
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
  }, [grid, stepIdx, linkedInstant])

  const currentStep: WindStep | null = useMemo(() => {
    if (!grid?.steps?.length) return null
    return grid.steps[effectiveStepIdx]
  }, [grid, effectiveStepIdx])

  // Une ref synchronisée vers le step courant — l'animation loop ne se
  // restart pas à chaque changement de stepIdx, elle relit la ref à chaque
  // frame, ce qui rend les transitions instantanées sans reset des particules.
  const stepRef = useRef<WindStep | null>(null)
  stepRef.current = currentStep
  const gridRef = useRef<WindGrid | null>(null)
  gridRef.current = grid

  // Auto-play : avance d'un step toutes les 1.4 s.
  useEffect(() => {
    if (!playing || !grid?.steps?.length) return
    const id = window.setInterval(() => {
      setStepIdx((i) => (i + 1) % grid.steps.length)
    }, 1400)
    return () => window.clearInterval(id)
  }, [playing, grid?.steps?.length])

  // Animation loop.
  useEffect(() => {
    if (!enabled || !grid || !map || !canvasRef.current) return
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const resize = () => {
      const c = map.getCanvas()
      const dpr = window.devicePixelRatio || 1
      canvas.width = c.clientWidth * dpr
      canvas.height = c.clientHeight * dpr
      canvas.style.width = c.clientWidth + 'px'
      canvas.style.height = c.clientHeight + 'px'
      ctx.scale(dpr, dpr)
    }
    resize()
    map.on('resize', resize)

    let raf = 0
    let lastT = performance.now()
    let stopped = false

    const frame = () => {
      if (stopped) return
      const now = performance.now()
      const dt = Math.min(0.1, (now - lastT) / 1000)
      lastT = now

      ctx.save()
      ctx.globalCompositeOperation = 'destination-out'
      ctx.fillStyle = `rgba(0,0,0,${FADE_ALPHA})`
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.restore()

      const g = gridRef.current
      const step = stepRef.current
      if (!g || !step) {
        raf = requestAnimationFrame(frame)
        return
      }

      ctx.save()
      ctx.globalCompositeOperation = 'source-over'
      ctx.lineCap = 'round'
      ctx.lineWidth = 1.1
      const speedMax = Math.max(5, step.speed_max_ms)

      for (const p of particlesRef.current) {
        const uv = sampleUV(g, step, p.lon, p.lat)
        if (!uv) {
          Object.assign(p, spawnParticle(g))
          continue
        }
        const cosLat = Math.cos((p.lat * Math.PI) / 180)
        const dLon = (uv.u * dt * SPEED_FACTOR) / Math.max(0.1, cosLat)
        const dLat = uv.v * dt * SPEED_FACTOR

        const newLon = p.lon + dLon
        const newLat = p.lat + dLat

        let prev: { x: number; y: number }
        let next: { x: number; y: number }
        try {
          prev = map.project([p.lon, p.lat])
          next = map.project([newLon, newLat])
        } catch {
          Object.assign(p, spawnParticle(g))
          continue
        }

        ctx.strokeStyle = colorForSpeed(uv.speed, speedMax)
        ctx.beginPath()
        ctx.moveTo(prev.x, prev.y)
        ctx.lineTo(next.x, next.y)
        ctx.stroke()

        p.lon = newLon
        p.lat = newLat
        p.age += dt
        if (
          p.age > p.maxAge ||
          newLon < g.bbox[0] ||
          newLon > g.bbox[2] ||
          newLat < g.bbox[1] ||
          newLat > g.bbox[3]
        ) {
          Object.assign(p, spawnParticle(g))
        }
      }
      ctx.restore()

      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      map.off('resize', resize)
      // Effacer le canvas en sortie pour éviter le résidu en mode disabled.
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    }
  }, [enabled, grid, map])

  if (!enabled) return null

  return (
    <>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 pointer-events-none"
        style={{ mixBlendMode: 'screen' }}
      />
      {info.status === 'loading' && (
        <div className="absolute top-4 right-4 z-10 px-2 py-1 rounded bg-slate-950/80 backdrop-blur text-[10px] text-slate-400 border border-slate-800/60">
          chargement vent…
        </div>
      )}
      {info.status === 'error' && (
        <div className="absolute top-4 right-4 z-10 px-2 py-1 rounded bg-red-950/60 text-[10px] text-red-300 border border-red-900/60">
          vent: {info.msg}
        </div>
      )}
      {grid && currentStep && (
        <div className="absolute bottom-24 right-4 z-10 px-3 py-2 rounded-lg bg-slate-950/85 backdrop-blur-md border border-slate-800/70 text-[10px] text-slate-300 shadow-2xl flex flex-col gap-2 min-w-[260px]">
          <div className="flex items-center gap-2">
            <span className="text-slate-500">{dataset === 'JET' ? 'Jet stream' : 'Vent'}</span>
            {dataset === 'WIND' && (
              <span className="font-mono">{(level / 100).toFixed(0)} hPa</span>
            )}
            <span className="text-slate-600">·</span>
            <span className="font-mono">
              max {(currentStep.speed_max_ms * 1.94384).toFixed(0)} kt
            </span>
            {linkedInstant && (
              <span
                className="ml-1 px-1 rounded bg-rose-500/20 text-rose-200 text-[8px] uppercase tracking-wider border border-rose-400/30"
                title="Niveau et instant calés sur l'avion suivi / le plan de vol"
              >
                live
              </span>
            )}
          </div>
          <div className="text-[9px] text-slate-500 font-mono truncate">
            {grid.coverage_id} · {fmtStepTime(currentStep.time)}
          </div>
          {grid.steps.length > 1 && !linkedInstant && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPlaying((p) => !p)}
                className="size-6 rounded bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/30 flex items-center justify-center"
                aria-label={playing ? 'Pause' : 'Play'}
              >
                {playing ? (
                  <Pause className="size-3 text-cyan-200" />
                ) : (
                  <Play className="size-3 text-cyan-200 translate-x-[1px]" />
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
                className="flex-1 accent-cyan-400 h-1"
              />
              <span className="font-mono tabular-nums text-[10px] w-10 text-right">
                {stepIdx + 1}/{grid.steps.length}
              </span>
            </div>
          )}
          {linkedInstant && (
            <div className="text-[9px] text-cyan-300/70 italic flex items-center justify-between gap-2">
              <span>synchro · step {effectiveStepIdx + 1}/{grid.steps.length}</span>
              <span className="text-cyan-300/60 font-mono normal-case">
                Δ{deltaMinutes(linkedInstant, currentStep.time)} min
              </span>
            </div>
          )}
        </div>
      )}
    </>
  )
}

function fmtStepTime(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  if (!m) return iso
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]} UTC`
}

// Écart en minutes (signé) entre instant demandé et timestamp du step retenu.
// Indique si on est en interpolation/extrapolation au-delà du step idéal.
function deltaMinutes(linked: string, stepTime: string): string {
  const a = Date.parse(linked)
  const b = Date.parse(stepTime)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '?'
  const d = Math.round((a - b) / 60_000)
  if (d === 0) return '0'
  return d > 0 ? `+${d}` : `${d}`
}

function spawnParticle(g: WindGrid): Particle {
  return {
    lon: g.bbox[0] + Math.random() * (g.bbox[2] - g.bbox[0]),
    lat: g.bbox[1] + Math.random() * (g.bbox[3] - g.bbox[1]),
    age: 0,
    maxAge: 1.5 + Math.random() * 2,
  }
}

function sampleUV(
  g: WindGrid,
  step: WindStep,
  lon: number,
  lat: number,
): { u: number; v: number; speed: number } | null {
  const [lonMin, latMin, lonMax, latMax] = g.bbox
  if (lon < lonMin || lon > lonMax || lat < latMin || lat > latMax) return null
  const fx = ((lon - lonMin) / (lonMax - lonMin)) * (g.width - 1)
  // Latitude inversée : grid stockée du nord au sud.
  const fy = ((latMax - lat) / (latMax - latMin)) * (g.height - 1)
  const x = Math.floor(fx)
  const y = Math.floor(fy)
  if (x < 0 || x >= g.width - 1 || y < 0 || y >= g.height - 1) return null
  const tx = fx - x
  const ty = fy - y
  const idx = (j: number, i: number) => j * g.width + i
  const u =
    step.u[idx(y, x)] * (1 - tx) * (1 - ty) +
    step.u[idx(y, x + 1)] * tx * (1 - ty) +
    step.u[idx(y + 1, x)] * (1 - tx) * ty +
    step.u[idx(y + 1, x + 1)] * tx * ty
  const v =
    step.v[idx(y, x)] * (1 - tx) * (1 - ty) +
    step.v[idx(y, x + 1)] * tx * (1 - ty) +
    step.v[idx(y + 1, x)] * (1 - tx) * ty +
    step.v[idx(y + 1, x + 1)] * tx * ty
  return { u, v, speed: Math.hypot(u, v) }
}

// Palette inspirée d'earth.nullschool : bleu (calme) → vert → jaune → orange → rouge.
function colorForSpeed(s: number, max: number): string {
  const t = Math.max(0, Math.min(1, s / max))
  // 5 stops
  const stops: Array<[number, [number, number, number]]> = [
    [0.0, [80, 140, 220]], // bleu
    [0.25, [100, 200, 200]], // cyan
    [0.5, [120, 220, 120]], // vert
    [0.75, [240, 200, 80]], // ambre
    [1.0, [240, 100, 80]], // rouge
  ]
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1]
      const [t1, c1] = stops[i]
      const u = (t - t0) / (t1 - t0)
      const r = c0[0] + (c1[0] - c0[0]) * u
      const g = c0[1] + (c1[1] - c0[1]) * u
      const b = c0[2] + (c1[2] - c0[2]) * u
      return `rgba(${r | 0},${g | 0},${b | 0},0.85)`
    }
  }
  return 'rgba(240,100,80,0.85)'
}
