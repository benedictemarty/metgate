import { useEffect, useRef, useState } from 'react'
import { useMap } from 'react-map-gl/maplibre'

interface WindGrid {
  coverage_id: string
  time: string
  level_pa: number
  bbox: [number, number, number, number] // lonMin,latMin,lonMax,latMax
  width: number
  height: number
  speed_max_ms: number
  u: number[]
  v: number[]
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
  level?: number // Pa, default 85000
}

export default function WindLayer({ enabled, level = 85000 }: WindLayerProps) {
  const { current: mapWrapper } = useMap()
  const map = mapWrapper?.getMap()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const particlesRef = useRef<Particle[]>([])
  const [grid, setGrid] = useState<WindGrid | null>(null)
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
      const url = `/api/wind?bbox=${lonMin.toFixed(2)},${latMin.toFixed(2)},${lonMax.toFixed(2)},${latMax.toFixed(2)}&level=${level}`
      setInfo({ status: 'loading' })
      fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          return r.json()
        })
        .then((g: WindGrid) => {
          if (aborted) return
          setGrid(g)
          // Reset particles to spread across the new grid.
          particlesRef.current = Array.from({ length: PARTICLE_COUNT }, () =>
            spawnParticle(g),
          )
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
  }, [enabled, map, level])

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

    const step = () => {
      if (stopped) return
      const now = performance.now()
      const dt = Math.min(0.1, (now - lastT) / 1000)
      lastT = now

      // Fade : on dessine un voile semi-transparent avec destination-out
      // pour effacer les anciens traits sans assombrir le fond MapLibre.
      ctx.save()
      ctx.globalCompositeOperation = 'destination-out'
      ctx.fillStyle = `rgba(0,0,0,${FADE_ALPHA})`
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.restore()

      // Step + draw particles.
      ctx.save()
      ctx.globalCompositeOperation = 'source-over'
      ctx.lineCap = 'round'
      ctx.lineWidth = 1.1
      const speedMax = Math.max(5, grid.speed_max_ms)

      for (const p of particlesRef.current) {
        const uv = sampleUV(grid, p.lon, p.lat)
        if (!uv) {
          Object.assign(p, spawnParticle(grid))
          continue
        }
        const cosLat = Math.cos((p.lat * Math.PI) / 180)
        const dLon = (uv.u * dt * SPEED_FACTOR) / Math.max(0.1, cosLat)
        const dLat = uv.v * dt * SPEED_FACTOR

        const newLon = p.lon + dLon
        const newLat = p.lat + dLat

        // Project both points to pixels.
        let prev: { x: number; y: number }
        let next: { x: number; y: number }
        try {
          prev = map.project([p.lon, p.lat])
          next = map.project([newLon, newLat])
        } catch {
          Object.assign(p, spawnParticle(grid))
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
          newLon < grid.bbox[0] ||
          newLon > grid.bbox[2] ||
          newLat < grid.bbox[1] ||
          newLat > grid.bbox[3]
        ) {
          Object.assign(p, spawnParticle(grid))
        }
      }
      ctx.restore()

      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)

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
      {grid && (
        <div className="absolute bottom-24 right-4 z-10 px-3 py-2 rounded-lg bg-slate-950/85 backdrop-blur-md border border-slate-800/70 text-[10px] text-slate-300 shadow-2xl">
          <div className="flex items-center gap-2">
            <span className="text-slate-500">Vent</span>
            <span className="font-mono">{(level / 100).toFixed(0)} hPa</span>
            <span className="text-slate-600">·</span>
            <span className="font-mono">
              max {(grid.speed_max_ms * 1.94384).toFixed(0)} kt
            </span>
          </div>
          <div className="text-[9px] text-slate-500 mt-0.5 font-mono">
            {grid.coverage_id} · {grid.time}
          </div>
        </div>
      )}
    </>
  )
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
  // Bilinéaire sur u et v.
  const idx = (j: number, i: number) => j * g.width + i
  const u =
    g.u[idx(y, x)] * (1 - tx) * (1 - ty) +
    g.u[idx(y, x + 1)] * tx * (1 - ty) +
    g.u[idx(y + 1, x)] * (1 - tx) * ty +
    g.u[idx(y + 1, x + 1)] * tx * ty
  const v =
    g.v[idx(y, x)] * (1 - tx) * (1 - ty) +
    g.v[idx(y, x + 1)] * tx * (1 - ty) +
    g.v[idx(y + 1, x)] * (1 - tx) * ty +
    g.v[idx(y + 1, x + 1)] * tx * ty
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
