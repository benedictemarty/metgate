import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Radar, Search } from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface AcState {
  lat: number; lon: number; alt: number   // ft
  hdg: number; spd: number                 // deg, kt
  callsign: string; icao24: string
  onGround: boolean
}

// ─── Constantes visuelles ─────────────────────────────────────────────────────

const RANGES = [40, 80, 160, 320]          // NM
const BG     = '#000a00'
const RING   = '#003300'
const AXIS   = '#005500'
const ROSE   = '#00aa44'
const AC_CLR = '#00ffcc'
const ROUTE  = '#ffffff'
const BEAM   = 'rgba(0,255,80,'

// Couleurs ICAO météo (comme les vrais WX radars avion)
const WX_COLORS: Record<number, string> = {
  0:  '#ff0055',   // T+0   : rouge intense — cellule active
  15: '#ff6600',   // T+15  : orange
  30: '#ffdd00',   // T+30  : jaune
  45: '#00cc44',   // T+45  : vert
  60: '#003322',   // T+60  : vert très sombre (fantôme)
}
const WX_GLOW: Record<number, string> = {
  0:  'rgba(255,0,80,',
  15: 'rgba(255,100,0,',
  30: 'rgba(255,220,0,',
  45: 'rgba(0,200,60,',
  60: 'rgba(0,80,30,',
}
const SIGMET_CLR = 'rgba(255,30,30,0.18)'
const SIGMET_LN  = '#ff2020'

// ─── Projection géographique ──────────────────────────────────────────────────

function geo2xy(lat: number, lon: number,
                clat: number, clon: number,
                _scale: number, hdg: number) {
  const e = (lon - clon) * 60 * Math.cos(clat * Math.PI / 180)
  const n = (lat - clat) * 60
  const h = -hdg * Math.PI / 180
  return {
    x:  e * Math.cos(h) - n * Math.sin(h),
    y: -(e * Math.sin(h) + n * Math.cos(h)),
  }
}

// ─── Rendu Canvas ─────────────────────────────────────────────────────────────

function drawND(
  ctx: CanvasRenderingContext2D,
  W: number, H: number,
  ac: AcState | null,
  rdt: GeoJSON.FeatureCollection | null,
  sigmet: GeoJSON.FeatureCollection | null,
  rangeNM: number,
  beamDeg: number,
  route: [number, number][] | null,    // [[lon,lat],...]
) {
  const R  = Math.min(W, H) / 2 - 4
  const cx = W / 2
  const cy = H / 2
  const SC = R / rangeNM
  const clat = ac?.lat ?? 46.5
  const clon = ac?.lon ?? 2.5
  const hdg  = ac?.hdg ?? 0

  const proj = (lat: number, lon: number) =>
    geo2xy(lat, lon, clat, clon, SC, hdg)

  ctx.clearRect(0, 0, W, H)

  // ── Fond circulaire ──
  ctx.save()
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip()
  ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H)

  // ── Anneaux de portée ──
  const rings = [rangeNM * 0.25, rangeNM * 0.5, rangeNM * 0.75, rangeNM]
  rings.forEach((r, i) => {
    const pr = r * SC
    ctx.beginPath(); ctx.arc(cx, cy, pr, 0, Math.PI * 2)
    ctx.strokeStyle = i === rings.length - 1 ? AXIS : RING
    ctx.lineWidth = i === rings.length - 1 ? 1.5 : 0.8
    ctx.setLineDash(i < rings.length - 1 ? [4, 8] : [])
    ctx.stroke(); ctx.setLineDash([])

    if (i < rings.length - 1 || true) {
      ctx.fillStyle = '#005500'
      ctx.font = `${Math.max(9, R * 0.04)}px monospace`
      ctx.textAlign = 'center'
      ctx.fillText(`${Math.round(r)}`, cx, cy - pr - 4)
    }
  })

  // ── Rose des caps (ticks + chiffres) ──
  ctx.save(); ctx.translate(cx, cy)
  for (let deg = 0; deg < 360; deg += 10) {
    const rad = (deg - hdg) * Math.PI / 180
    const isMaj = deg % 30 === 0
    const r1 = R - (isMaj ? 18 : 8)
    ctx.beginPath()
    ctx.moveTo(R * Math.sin(rad), -R * Math.cos(rad))
    ctx.lineTo(r1 * Math.sin(rad), -r1 * Math.cos(rad))
    ctx.strokeStyle = isMaj ? ROSE : RING
    ctx.lineWidth = isMaj ? 1.5 : 0.8; ctx.stroke()
    if (isMaj) {
      const label = deg === 0 ? 'N' : deg === 90 ? 'E' : deg === 180 ? 'S' : deg === 270 ? 'W' : `${deg}`
      ctx.fillStyle = label.length === 1 ? '#00ff88' : ROSE
      ctx.font = `bold ${Math.max(10, R * 0.048)}px monospace`
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      const lr = R - 30
      ctx.fillText(label, lr * Math.sin(rad), -lr * Math.cos(rad))
    }
  }
  ctx.restore()

  // ── Faisceau radar animé ──
  ctx.save(); ctx.translate(cx, cy)
  const beamRad = (beamDeg - hdg) * Math.PI / 180
  for (let i = 0; i < 40; i++) {
    const a1 = beamRad - (i * 2.5) * Math.PI / 180
    const a2 = beamRad - (i * 2.5 + 2.5) * Math.PI / 180
    const op = (1 - i / 40) * 0.18
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.arc(0, 0, R, a1 - Math.PI / 2, a2 - Math.PI / 2)
    ctx.closePath()
    ctx.fillStyle = BEAM + op + ')'
    ctx.fill()
  }
  // Trait du faisceau
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(R * Math.sin(beamRad), -R * Math.cos(beamRad))
  ctx.strokeStyle = 'rgba(0,255,100,0.6)'; ctx.lineWidth = 1; ctx.stroke()
  ctx.restore()

  // ── SIGMET zones ──
  if (sigmet) {
    ctx.save(); ctx.translate(cx, cy)
    sigmet.features.forEach(f => {
      const geom = f.geometry as GeoJSON.Geometry | null
      if (!geom || geom.type !== 'Polygon') return
      const ring = (geom as GeoJSON.Polygon).coordinates[0]
      ctx.beginPath()
      ring.forEach(([lon, lat], i) => {
        const { x, y } = proj(lat, lon)
        i === 0 ? ctx.moveTo(x * SC, y * SC) : ctx.lineTo(x * SC, y * SC)
      })
      ctx.closePath()
      ctx.fillStyle = SIGMET_CLR; ctx.fill()
      ctx.strokeStyle = SIGMET_LN; ctx.lineWidth = 1
      ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([])
    })
    ctx.restore()
  }

  // ── Cellules RDT (T+60 → T+0, plus proche au-dessus) ──
  if (rdt) {
    const steps = [60, 45, 30, 15, 0] as const
    steps.forEach(step => {
      const cells = rdt.features.filter(f => {
        const ft = (f.properties as Record<string, unknown>)?.forecasttime
        if (ft === undefined || ft === null || ft === '') return false
        return Math.abs((typeof ft === 'string' ? parseFloat(ft) : ft as number) - step) < 1
      })
      if (!cells.length) return

      ctx.save(); ctx.translate(cx, cy)
      cells.forEach(f => {
        const geom = f.geometry as GeoJSON.Geometry | null
        if (!geom) return
        const rings: number[][][] =
          geom.type === 'Polygon' ? (geom as GeoJSON.Polygon).coordinates
          : geom.type === 'MultiPolygon' ? (geom as GeoJSON.MultiPolygon).coordinates.flat()
          : []

        rings.forEach(ring => {
          ctx.beginPath()
          ring.forEach(([lon, lat], i) => {
            const { x, y } = proj(lat, lon)
            i === 0 ? ctx.moveTo(x * SC, y * SC) : ctx.lineTo(x * SC, y * SC)
          })
          ctx.closePath()

          // Glow extérieur pour T+0
          if (step === 0) {
            ctx.shadowBlur = 12
            ctx.shadowColor = WX_GLOW[step] + '0.8)'
          }
          ctx.fillStyle = WX_COLORS[step] + (step === 0 ? 'cc' : step === 15 ? 'aa' : step === 30 ? '88' : step === 45 ? '55' : '33')
          ctx.fill()
          ctx.shadowBlur = 0
          if (step <= 15) {
            ctx.strokeStyle = WX_COLORS[step]; ctx.lineWidth = step === 0 ? 1.5 : 1; ctx.stroke()
          }
        })
      })
      ctx.restore()
    })
  }

  // ── Route ──
  if (route && route.length > 1) {
    ctx.save(); ctx.translate(cx, cy)
    ctx.beginPath()
    route.forEach(([lon, lat], i) => {
      const { x, y } = proj(lat, lon)
      i === 0 ? ctx.moveTo(x * SC, y * SC) : ctx.lineTo(x * SC, y * SC)
    })
    ctx.strokeStyle = ROUTE; ctx.lineWidth = 1.2
    ctx.setLineDash([6, 6]); ctx.stroke(); ctx.setLineDash([])

    route.forEach(([lon, lat], i) => {
      const { x, y } = proj(lat, lon)
      if (i === 0 || i === route.length - 1) return
      ctx.beginPath(); ctx.arc(x * SC, y * SC, 3, 0, Math.PI * 2)
      ctx.fillStyle = '#00ccff'; ctx.fill()
    })
    ctx.restore()
  }

  ctx.restore()  // fin du clip

  // ── Symbole avion (centre, toujours droit) ──
  ctx.save(); ctx.translate(cx, cy)
  const as = R * 0.045
  ctx.strokeStyle = AC_CLR; ctx.lineWidth = 2.5; ctx.lineCap = 'round'
  ctx.shadowBlur = 8; ctx.shadowColor = AC_CLR
  // Fuselage
  ctx.beginPath(); ctx.moveTo(0, -as * 2.2); ctx.lineTo(0, as * 1.4); ctx.stroke()
  // Ailes
  ctx.beginPath(); ctx.moveTo(-as * 2, as * 0.4); ctx.lineTo(as * 2, as * 0.4); ctx.stroke()
  // Empennage
  ctx.beginPath(); ctx.moveTo(-as * 0.9, as * 1.4); ctx.lineTo(as * 0.9, as * 1.4); ctx.stroke()
  ctx.shadowBlur = 0; ctx.restore()

  // ── Bordure circulaire ──
  ctx.save()
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2)
  ctx.strokeStyle = '#009933'; ctx.lineWidth = 2.5; ctx.stroke()
  // Biseau intérieur
  ctx.beginPath(); ctx.arc(cx, cy, R - 3, 0, Math.PI * 2)
  ctx.strokeStyle = '#002211'; ctx.lineWidth = 1; ctx.stroke()
  ctx.restore()

  // ── Cap en haut du cadran ──
  ctx.save()
  ctx.fillStyle = '#00ff88'
  ctx.font = `bold ${Math.max(14, R * 0.06)}px monospace`
  ctx.textAlign = 'center'; ctx.textBaseline = 'top'
  ctx.fillText(String(Math.round(hdg)).padStart(3, '0') + '°', cx, cy - R + 8)
  ctx.restore()

  // ── Indicateur vent (coin haut gauche) ──
  if (ac) {
    const wx = cx - R + 12
    const wy = cy + R - 70
    ctx.save()
    ctx.font = `${Math.max(11, R * 0.045)}px monospace`
    ctx.textAlign = 'left'; ctx.textBaseline = 'top'
    ctx.fillStyle = '#00ccff'
    ctx.fillText(`TRK ${String(Math.round(hdg)).padStart(3, '0')}°`, wx, wy)
    ctx.fillStyle = '#00ff88'
    ctx.fillText(`${Math.round(ac.spd)} kt`, wx, wy + 18)
    ctx.fillStyle = '#aaffcc'
    ctx.fillText(`FL${String(Math.round(ac.alt / 100)).padStart(3, '0')}`, wx, wy + 36)
    ctx.restore()
  }

  // ── Mode WX + portée ──
  ctx.save()
  ctx.font = `bold ${Math.max(11, R * 0.045)}px monospace`
  ctx.textAlign = 'right'; ctx.textBaseline = 'top'
  ctx.fillStyle = '#00ff44'
  ctx.fillText('WX', cx + R - 8, cy - R + 8)
  ctx.fillStyle = '#00cc88'
  ctx.fillText(`${rangeNM} NM`, cx + R - 8, cy - R + 26)
  ctx.restore()
}

// ─── Composant principal ──────────────────────────────────────────────────────

export default function NavDisplay() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef    = useRef<number>(0)
  const beamRef   = useRef(0)
  const t0Ref     = useRef(performance.now())

  const [rangeIdx, setRangeIdx] = useState(1)         // 80 NM par défaut
  const [mode, setMode]         = useState<'real' | 'sim'>('sim')
  const [searchQ, setSearchQ]   = useState('')
  const [searching, setSearching] = useState(false)
  const [ac, setAc]             = useState<AcState | null>(null)
  const [rdt, setRdt]           = useState<GeoJSON.FeatureCollection | null>(null)
  const [sigmet, setSigmet]     = useState<GeoJSON.FeatureCollection | null>(null)
  const [route, setRoute]       = useState<[number, number][] | null>(null)
  const [depArr, setDepArr]     = useState({ dep: 'LFPG', arr: 'LFMN', fl: 350 })
  const [loading, setLoading]   = useState(false)
  const [status, setStatus]     = useState('Saisir un vol ou une route de simulation')

  const rangeNM = RANGES[rangeIdx]

  // ── Fetch météo ──
  const fetchWeather = useCallback(async () => {
    const [rdtR, sigR] = await Promise.all([
      fetch('/api/feature?type=RDT_MSG_last&count=2000').then(r => r.ok ? r.json() : null),
      fetch('/api/feature?type=SIGMET_last&count=200').then(r => r.ok ? r.json() : null),
    ])
    if (rdtR)  setRdt(rdtR)
    if (sigR)  setSigmet(sigR)
  }, [])

  useEffect(() => { fetchWeather() }, [fetchWeather])
  useEffect(() => {
    const id = setInterval(fetchWeather, 5 * 60_000)
    return () => clearInterval(id)
  }, [fetchWeather])

  // ── Mode SIM : route synthétique ──
  const loadSim = useCallback(async () => {
    setLoading(true)
    setStatus(`Calcul route ${depArr.dep}→${depArr.arr}…`)
    try {
      const r = await fetch(`/api/route?dep=${depArr.dep}&arr=${depArr.arr}&fl=${depArr.fl}&speed=460`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const plan = await r.json()
      const wps: [number, number][] = (plan.waypoints ?? []).map((w: { lon: number; lat: number }) => [w.lon, w.lat])
      setRoute(wps)
      // Départ = position initiale
      if (wps.length >= 2) {
        const [lon0, lat0] = wps[0]
        const [lon1, lat1] = wps[1]
        const hdg = Math.atan2(lon1 - lon0, lat1 - lat0) * 180 / Math.PI
        setAc({ lat: lat0, lon: lon0, alt: depArr.fl * 100, hdg: (hdg + 360) % 360, spd: 460, callsign: `${depArr.dep}→${depArr.arr}`, icao24: 'sim', onGround: false })
        setStatus(`Route ${depArr.dep}→${depArr.arr} FL${depArr.fl} — Simulation`)
      }
    } catch (e) {
      setStatus('Erreur route : ' + String(e))
    } finally { setLoading(false) }
  }, [depArr])

  // ── Mode REAL : recherche ADS-B ──
  const searchAircraft = useCallback(async () => {
    if (!searchQ.trim()) return
    setSearching(true)
    try {
      const r = await fetch(`/api/aircraft/search?cs=${encodeURIComponent(searchQ.trim())}`)
      const d = await r.json()
      const st = d.states?.[0]
      if (!st) { setStatus('Vol non trouvé'); return }
      const plan = await fetch(`/api/aircraft/${st.icao24}/route`).then(r => r.ok ? r.json() : null)
      const wps: [number, number][] = (plan?.waypoints ?? []).map((w: { lon: number; lat: number }) => [w.lon, w.lat])
      setRoute(wps.length > 0 ? wps : null)
      setAc({ lat: st.lat, lon: st.lon, alt: st.altitude ?? st.geo_altitude ?? 0, hdg: st.true_track ?? 0, spd: st.velocity ?? 0, callsign: st.callsign?.trim() ?? st.icao24, icao24: st.icao24, onGround: st.on_ground })
      setStatus(`${st.callsign?.trim() ?? st.icao24} — Live ADS-B`)
    } catch { setStatus('Erreur recherche') }
    finally { setSearching(false) }
  }, [searchQ])

  // ── Boucle de rendu Canvas ──
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const animate = (now: number) => {
      const elapsed = now - t0Ref.current
      beamRef.current = (elapsed * 60 / 1000) % 360  // 1 tour / 6 s

      const W = canvas.width
      const H = canvas.height

      drawND(ctx, W, H, ac, rdt, sigmet, rangeNM, beamRef.current, route)
      rafRef.current = requestAnimationFrame(animate)
    }
    rafRef.current = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(rafRef.current)
  }, [ac, rdt, sigmet, rangeNM, route])

  // ── Resize ──
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const resize = () => {
      const size = Math.min(canvas.parentElement!.clientWidth, canvas.parentElement!.clientHeight) - 8
      canvas.width  = size
      canvas.height = size
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas.parentElement!)
    return () => ro.disconnect()
  }, [])

  return (
    <div className="flex h-[calc(100vh-72px)] bg-slate-950 text-slate-200 overflow-hidden">

      {/* ── Panneau gauche ── */}
      <div className="w-72 shrink-0 flex flex-col gap-4 p-4 border-r border-slate-800/60 overflow-y-auto">

        {/* Mode */}
        <div>
          <div className="text-[0.5625rem] uppercase tracking-wider text-slate-500 mb-2">Mode</div>
          <div className="flex rounded-lg border border-slate-700/60 overflow-hidden">
            {(['real', 'sim'] as const).map(m => (
              <button key={m} onClick={() => setMode(m)}
                className={`flex-1 py-2 text-sm font-medium transition ${mode === m ? 'bg-green-900/40 text-green-300' : 'text-slate-400 hover:text-slate-200'}`}>
                {m === 'real' ? '⬤ Live ADS-B' : '◎ Simulation'}
              </button>
            ))}
          </div>
        </div>

        {/* Portée */}
        <div>
          <div className="text-[0.5625rem] uppercase tracking-wider text-slate-500 mb-2">Portée radar</div>
          <div className="grid grid-cols-4 gap-1">
            {RANGES.map((r, i) => (
              <button key={r} onClick={() => setRangeIdx(i)}
                className={`py-1.5 rounded text-xs font-mono transition border ${rangeIdx === i ? 'border-green-500/50 bg-green-900/30 text-green-300' : 'border-slate-700/40 text-slate-400 hover:text-slate-200'}`}>
                {r}
              </button>
            ))}
          </div>
        </div>

        {/* Saisie vol (REAL) */}
        {mode === 'real' && (
          <div>
            <div className="text-[0.5625rem] uppercase tracking-wider text-slate-500 mb-2">Callsign</div>
            <div className="flex gap-1.5">
              <input value={searchQ} onChange={e => setSearchQ(e.target.value.toUpperCase())}
                onKeyDown={e => e.key === 'Enter' && searchAircraft()}
                placeholder="AFR123 / F-GKXA"
                className="flex-1 px-2 py-1.5 rounded bg-slate-900/70 border border-slate-700/60 font-mono text-sm text-green-300 placeholder-slate-600 focus:outline-none focus:border-green-500/50" />
              <button onClick={searchAircraft} disabled={searching}
                className="px-2.5 py-1.5 rounded border border-green-700/50 bg-green-900/20 text-green-400 hover:bg-green-900/40 transition disabled:opacity-40">
                {searching ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
              </button>
            </div>
          </div>
        )}

        {/* Saisie route (SIM) */}
        {mode === 'sim' && (
          <div className="flex flex-col gap-2">
            <div className="text-[0.5625rem] uppercase tracking-wider text-slate-500">Route simulée</div>
            {[
              { key: 'dep', label: 'DEP', placeholder: 'LFPG' },
              { key: 'arr', label: 'ARR', placeholder: 'LFMN' },
            ].map(({ key, label, placeholder }) => (
              <div key={key} className="flex items-center gap-2">
                <span className="text-[0.625rem] text-slate-500 w-8">{label}</span>
                <input value={depArr[key as 'dep' | 'arr']}
                  onChange={e => setDepArr(p => ({ ...p, [key]: e.target.value.toUpperCase() }))}
                  placeholder={placeholder}
                  className="flex-1 px-2 py-1 rounded bg-slate-900/70 border border-slate-700/60 font-mono text-sm text-green-300 placeholder-slate-600 focus:outline-none focus:border-green-500/50" />
              </div>
            ))}
            <div className="flex items-center gap-2">
              <span className="text-[0.625rem] text-slate-500 w-8">FL</span>
              <input type="number" value={depArr.fl}
                onChange={e => setDepArr(p => ({ ...p, fl: parseInt(e.target.value) || 350 }))}
                className="flex-1 px-2 py-1 rounded bg-slate-900/70 border border-slate-700/60 font-mono text-sm text-green-300 focus:outline-none focus:border-green-500/50" />
            </div>
            <button onClick={loadSim} disabled={loading}
              className="mt-1 py-2 rounded border border-green-700/50 bg-green-900/20 text-green-400 hover:bg-green-900/40 transition disabled:opacity-40 text-sm font-medium flex items-center justify-center gap-2">
              {loading ? <Loader2 className="size-4 animate-spin" /> : <Radar className="size-4" />}
              {loading ? 'Calcul…' : 'Charger la route'}
            </button>
          </div>
        )}

        {/* Légende météo */}
        <div>
          <div className="text-[0.5625rem] uppercase tracking-wider text-slate-500 mb-2">Radar météo</div>
          {([
            { step: 0,  label: 'Cellules actives (T+0)' },
            { step: 15, label: 'Prévu T+15 min' },
            { step: 30, label: 'Prévu T+30 min' },
            { step: 45, label: 'Prévu T+45 min' },
            { step: 60, label: 'Fantôme T+60 min' },
          ] as const).map(({ step, label }) => (
            <div key={step} className="flex items-center gap-2 py-0.5">
              <span className="size-3 rounded-sm border" style={{ backgroundColor: WX_COLORS[step] + '88', borderColor: WX_COLORS[step] }} />
              <span className="text-[0.625rem] text-slate-400">{label}</span>
            </div>
          ))}
          <div className="flex items-center gap-2 py-0.5 mt-1">
            <span className="size-3 rounded-sm border border-red-500" style={{ backgroundColor: 'rgba(255,30,30,0.2)' }} />
            <span className="text-[0.625rem] text-slate-400">SIGMET</span>
          </div>
        </div>

        {/* Statut */}
        <div className="mt-auto pt-3 border-t border-slate-800/60">
          <div className="text-[0.5625rem] font-mono text-green-600 leading-relaxed">{status}</div>
        </div>
      </div>

      {/* ── Affichage radar ── */}
      <div className="flex-1 flex items-center justify-center bg-black p-2">
        <div className="relative w-full h-full flex items-center justify-center">
          {/* Biseau extérieur style EFIS */}
          <div className="rounded-full p-1" style={{ background: 'radial-gradient(circle, #1a2a1a 0%, #0a140a 60%, #050a05 100%)', boxShadow: '0 0 40px rgba(0,200,50,0.15), inset 0 0 20px rgba(0,0,0,0.8)' }}>
            <canvas ref={canvasRef} className="block rounded-full" style={{ imageRendering: 'pixelated' }} />
          </div>

          {/* Label mode LIVE/SIM */}
          {ac && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full border text-xs font-mono font-bold tracking-widest"
              style={{ borderColor: mode === 'real' ? '#00ff44' : '#00cc88', color: mode === 'real' ? '#00ff44' : '#00cc88', backgroundColor: 'rgba(0,20,0,0.8)' }}>
              {mode === 'real' ? `⬤ LIVE  ${ac.callsign}` : `◎ SIM  ${ac.callsign}`}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
