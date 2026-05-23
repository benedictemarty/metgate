import { useEffect, useRef, useState } from 'react'
import { Source, Layer } from 'react-map-gl/maplibre'

// Palette Rainviewer : 2 = standard météo (vert→jaune→orange→rouge)
const COLOR_SCHEME = 2
const TILE_SIZE    = 256

interface Frame {
  time: number   // Unix timestamp (s)
  path: string   // ex: "/v2/radar/48f5a4e3c569"
}

interface Props {
  enabled: boolean
  opacity?: number
  // Synchronisation avec le slider temporel de MapView
  linkedInstant?: string | null
  onTimesLoaded?: (times: string[]) => void
  onLoadingChange?: (loading: boolean) => void
}

export default function RadarLayer({
  enabled,
  opacity = 0.65,
  linkedInstant,
  onTimesLoaded,
  onLoadingChange,
}: Props) {
  const [frames, setFrames]       = useState<Frame[]>([])
  const [frameIdx, setFrameIdx]   = useState(0)
  const [loading, setLoading]     = useState(false)
  const refreshRef                = useRef<ReturnType<typeof setInterval> | null>(null)

  // Récupérer les trames disponibles depuis Rainviewer
  const fetchFrames = async () => {
    setLoading(true)
    onLoadingChange?.(true)
    try {
      const r = await fetch('https://api.rainviewer.com/public/weather-maps.json')
      if (!r.ok) return
      const d = await r.json()
      const past: Frame[]    = d?.radar?.past    ?? []
      const nowcast: Frame[] = d?.radar?.nowcast ?? []
      const all = [...past, ...nowcast]
      if (!all.length) return
      setFrames(all)
      setFrameIdx(past.length - 1)  // par défaut : dernière trame passée
      onTimesLoaded?.(all.map(f => new Date(f.time * 1000).toISOString()))
    } catch { /* best-effort */ }
    finally { setLoading(false); onLoadingChange?.(false) }
  }

  useEffect(() => {
    if (!enabled) return
    fetchFrames()
    refreshRef.current = setInterval(fetchFrames, 5 * 60_000)
    return () => { if (refreshRef.current) clearInterval(refreshRef.current) }
  }, [enabled]) // eslint-disable-line react-hooks/exhaustive-deps

  // Synchronisation avec le slider temporel
  useEffect(() => {
    if (!linkedInstant || !frames.length) return
    const target = Date.parse(linkedInstant) / 1000
    let best = 0, bestDiff = Infinity
    frames.forEach((f, i) => {
      const d = Math.abs(f.time - target)
      if (d < bestDiff) { bestDiff = d; best = i }
    })
    setFrameIdx(best)
  }, [linkedInstant, frames])

  if (!enabled || !frames.length) return null

  const frame = frames[frameIdx]
  const tileUrl = `https://tilecache.rainviewer.com${frame.path}/${TILE_SIZE}/{z}/{x}/{y}/${COLOR_SCHEME}/1_1.png`

  return (
    <>
      <Source
        key={tileUrl}
        id="radar-rainviewer"
        type="raster"
        tiles={[tileUrl]}
        tileSize={TILE_SIZE}
        attribution='<a href="https://rainviewer.com" target="_blank">RainViewer</a> · OPERA'
      />
      <Layer
        id="radar-rainviewer-layer"
        type="raster"
        source="radar-rainviewer"
        paint={{ 'raster-opacity': opacity }}
      />
      {/* Badge info */}
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-10 px-2 py-0.5 rounded bg-slate-950/80 backdrop-blur text-[0.5rem] text-slate-400 border border-slate-800/60 pointer-events-none flex items-center gap-2">
        {loading && <span className="size-1.5 rounded-full bg-sky-400 animate-pulse block"/>}
        <span className="font-mono">
          RADAR {new Date(frame.time * 1000).toISOString().slice(11, 16)}Z
          {frame.time > Date.now() / 1000 ? ' ▶ FCST' : ''}
        </span>
        <span className="text-slate-600">· RainViewer / OPERA</span>
      </div>
    </>
  )
}
