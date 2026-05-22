import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Radar, Search } from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface AcState {
  lat: number; lon: number; alt: number
  hdg: number; spd: number
  callsign: string; icao24: string
}

// ─── Couleurs ICAO radar météo ────────────────────────────────────────────────

const WX: Record<number, { fill: string; stroke: string; alpha: number }> = {
  0:  { fill: '#ff003c', stroke: '#ff4466', alpha: 0.80 },  // T+0   rouge
  15: { fill: '#ff6600', stroke: '#ff8833', alpha: 0.60 },  // T+15  orange
  30: { fill: '#ffdd00', stroke: '#ffee44', alpha: 0.45 },  // T+30  jaune
  45: { fill: '#00cc44', stroke: '#44ff77', alpha: 0.28 },  // T+45  vert
  60: { fill: '#005522', stroke: '#007733', alpha: 0.15 },  // T+60  fantôme
}

// ─── Projection géo → pixels (heading-up) ────────────────────────────────────

function proj(
  lat: number, lon: number,
  clat: number, clon: number,
  scale: number, hdgRad: number,
): [number, number] {
  const e = (lon - clon) * 60 * Math.cos(clat * Math.PI / 180)
  const n = (lat - clat) * 60
  const x =  e * Math.cos(-hdgRad) - n * Math.sin(-hdgRad)
  const y = -(e * Math.sin(-hdgRad) + n * Math.cos(-hdgRad))
  return [x * scale, y * scale]
}

// ─── Rendu Canvas ─────────────────────────────────────────────────────────────

function draw(
  ctx: CanvasRenderingContext2D,
  size: number,
  ac: AcState | null,
  rdt: GeoJSON.FeatureCollection | null,
  sigmet: GeoJSON.FeatureCollection | null,
  rangeNM: number,
  beamDeg: number,
  route: [number, number][] | null,
) {
  const R   = size / 2 - 6
  const cx  = size / 2
  const cy  = size / 2
  const SC  = R / rangeNM
  const clat = ac?.lat ?? 46.5
  const clon = ac?.lon ?? 2.5
  const hdg  = ac?.hdg ?? 0
  const hdgR = hdg * Math.PI / 180

  const p = (lat: number, lon: number) => proj(lat, lon, clat, clon, SC, hdgR)

  ctx.clearRect(0, 0, size, size)

  // ─ Fond circulaire clippé ─
  ctx.save()
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2)
  ctx.fillStyle = '#000d02'; ctx.fill()
  ctx.clip()

  // ─ Anneaux de portée ─
  for (let i = 1; i <= 4; i++) {
    const r = (i / 4) * R
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.strokeStyle = i === 4 ? '#008822' : '#004411'
    ctx.lineWidth = i === 4 ? 1.5 : 0.8
    ctx.setLineDash(i < 4 ? [6, 10] : []); ctx.stroke(); ctx.setLineDash([])
    // Labels NM
    const nmVal = Math.round(rangeNM * i / 4)
    ctx.fillStyle = '#006611'; ctx.font = `${Math.max(9, R * 0.038)}px monospace`
    ctx.textAlign = 'center'; ctx.fillText(`${nmVal}`, cx, cy - r + 12)
  }

  // ─ Rose des caps (centrée) ─
  ctx.save(); ctx.translate(cx, cy)
  for (let deg = 0; deg < 360; deg += 10) {
    const rad = (deg - hdg) * Math.PI / 180
    const isMaj = deg % 30 === 0
    const r1 = R - (isMaj ? 20 : 9)
    ctx.beginPath()
    ctx.moveTo(Math.sin(rad) * R, -Math.cos(rad) * R)
    ctx.lineTo(Math.sin(rad) * r1, -Math.cos(rad) * r1)
    ctx.strokeStyle = isMaj ? '#00bb55' : '#005522'
    ctx.lineWidth = isMaj ? 1.5 : 0.8; ctx.stroke()
    if (isMaj) {
      const label = deg === 0 ? 'N' : deg === 90 ? 'E' : deg === 180 ? 'S' : deg === 270 ? 'W' : `${deg}`
      const lr = R - 34
      ctx.fillStyle = deg === 0 ? '#00ffaa' : '#00cc66'
      ctx.font = `bold ${Math.max(11, R * 0.05)}px monospace`
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText(label, Math.sin(rad) * lr, -Math.cos(rad) * lr)
    }
  }
  ctx.restore()

  // ─ Faisceau radar animé ─
  ctx.save(); ctx.translate(cx, cy)
  const beamRad = (beamDeg - hdg) * Math.PI / 180
  for (let i = 0; i < 45; i++) {
    const a0 = beamRad - Math.PI / 2 - i * (3 * Math.PI / 180)
    const a1 = a0 - 3 * Math.PI / 180
    const op = (1 - i / 45) * 0.22
    ctx.beginPath(); ctx.moveTo(0, 0)
    ctx.arc(0, 0, R, a0, a1, true); ctx.closePath()
    ctx.fillStyle = `rgba(0,255,80,${op})`; ctx.fill()
  }
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(R * Math.sin(beamRad), -R * Math.cos(beamRad))
  ctx.strokeStyle = 'rgba(0,255,100,0.7)'; ctx.lineWidth = 1.2; ctx.stroke()
  ctx.restore()

  // ─ SIGMET (hachures rouges) ─
  if (sigmet) {
    ctx.save(); ctx.translate(cx, cy)
    sigmet.features.forEach(f => {
      const g = f.geometry as GeoJSON.Geometry
      if (!g || g.type !== 'Polygon') return
      const ring = (g as GeoJSON.Polygon).coordinates[0]
      ctx.beginPath()
      ring.forEach(([lon, lat], i) => {
        const [px, py] = p(lat, lon)
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)
      })
      ctx.closePath()
      ctx.fillStyle = 'rgba(255,20,20,0.12)'; ctx.fill()
      ctx.strokeStyle = '#ff2020'; ctx.lineWidth = 0.8
      ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([])
    })
    ctx.restore()
  }

  // ─ RDT_MSG (T+60 → T+0, plus récent au-dessus) ─
  if (rdt) {
    ;([60, 45, 30, 15, 0] as const).forEach(step => {
      const cells = rdt.features.filter(f => {
        const ft = (f.properties as Record<string, unknown>)?.forecasttime
        if (ft === undefined || ft === null) return false
        return Math.abs((typeof ft === 'string' ? parseFloat(ft) : ft as number) - step) < 1
      })
      if (!cells.length) return
      const wc = WX[step]

      ctx.save(); ctx.translate(cx, cy)
      if (step === 0) { ctx.shadowBlur = 14; ctx.shadowColor = wc.stroke }
      cells.forEach(f => {
        const g = f.geometry as GeoJSON.Geometry
        if (!g) return
        const polys: number[][][] = g.type === 'Polygon'
          ? (g as GeoJSON.Polygon).coordinates
          : g.type === 'MultiPolygon'
            ? (g as GeoJSON.MultiPolygon).coordinates.flat()
            : []
        polys.forEach(ring => {
          ctx.beginPath()
          ring.forEach(([lon, lat], i) => {
            const [px, py] = p(lat, lon)
            i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)
          })
          ctx.closePath()
          ctx.fillStyle = wc.fill + Math.round(wc.alpha * 255).toString(16).padStart(2, '0')
          ctx.fill()
          if (step <= 15) {
            ctx.strokeStyle = wc.stroke; ctx.lineWidth = step === 0 ? 1.5 : 0.8; ctx.stroke()
          }
        })
      })
      ctx.shadowBlur = 0; ctx.restore()
    })
  }

  // ─ Route ─
  if (route && route.length > 1) {
    ctx.save(); ctx.translate(cx, cy)
    ctx.beginPath()
    route.forEach(([lon, lat], i) => {
      const [px, py] = p(lat, lon)
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)
    })
    ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1.2
    ctx.setLineDash([7, 6]); ctx.stroke(); ctx.setLineDash([])
    // Points waypoints
    route.forEach(([lon, lat], i) => {
      if (i === 0 || i === route.length - 1) return
      const [px, py] = p(lat, lon)
      ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2)
      ctx.fillStyle = '#44ddff'; ctx.fill()
    })
    // Aérodromes DEP/ARR
    ;[route[0], route[route.length - 1]].forEach(([lon, lat], i) => {
      const [px, py] = p(lat, lon)
      ctx.beginPath()
      ctx.moveTo(px, py - 7); ctx.lineTo(px, py + 7)
      ctx.moveTo(px - 7, py); ctx.lineTo(px + 7, py)
      ctx.strokeStyle = i === 0 ? '#88ffcc' : '#ff8844'; ctx.lineWidth = 2; ctx.stroke()
    })
    ctx.restore()
  }

  ctx.restore()  // fin du clip

  // ─ Symbole avion (centre, non rotatif) ─
  const as = R * 0.05
  ctx.save(); ctx.translate(cx, cy)
  ctx.strokeStyle = '#00ffcc'; ctx.lineWidth = 2.5; ctx.lineCap = 'round'
  ctx.shadowBlur = 10; ctx.shadowColor = '#00ffcc'
  ctx.beginPath(); ctx.moveTo(0, -as * 2.2); ctx.lineTo(0, as * 1.5); ctx.stroke()
  ctx.beginPath(); ctx.moveTo(-as * 2.1, as * 0.4); ctx.lineTo(as * 2.1, as * 0.4); ctx.stroke()
  ctx.beginPath(); ctx.moveTo(-as, as * 1.5); ctx.lineTo(as, as * 1.5); ctx.stroke()
  ctx.shadowBlur = 0; ctx.restore()

  // ─ Bordure du cadran ─
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2)
  ctx.strokeStyle = '#00cc44'; ctx.lineWidth = 2.5; ctx.stroke()
  ctx.beginPath(); ctx.arc(cx, cy, R - 3, 0, Math.PI * 2)
  ctx.strokeStyle = '#002208'; ctx.lineWidth = 1; ctx.stroke()

  // ─ Cap haut ─
  ctx.fillStyle = '#00ff88'; ctx.font = `bold ${Math.max(13, R * 0.055)}px monospace`
  ctx.textAlign = 'center'; ctx.textBaseline = 'top'
  ctx.fillText(`${String(Math.round(hdg % 360)).padStart(3, '0')}°`, cx, cy - R + 10)

  // ─ Mode + portée haut-droite ─
  ctx.fillStyle = '#00ee44'; ctx.font = `bold ${Math.max(11, R * 0.044)}px monospace`
  ctx.textAlign = 'right'; ctx.textBaseline = 'top'
  ctx.fillText('WX', cx + R - 10, cy - R + 10)
  ctx.fillStyle = '#00aa44'; ctx.fillText(`${rangeNM}NM`, cx + R - 10, cy - R + 28)

  // ─ Données avion bas-gauche ─
  if (ac) {
    const bx = cx - R + 12
    const by = cy + R - 72
    ctx.textAlign = 'left'; ctx.textBaseline = 'top'
    ctx.fillStyle = '#44eeff'; ctx.font = `${Math.max(11, R * 0.044)}px monospace`
    ctx.fillText(`TRK ${String(Math.round(hdg % 360)).padStart(3, '0')}°`, bx, by)
    ctx.fillStyle = '#00ff88'
    ctx.fillText(`GS  ${Math.round(ac.spd)} kt`, bx, by + 18)
    ctx.fillStyle = '#aaffcc'
    ctx.fillText(`FL  ${String(Math.round(ac.alt / 100)).padStart(3, '0')}`, bx, by + 36)
  }
}

// ─── Composant ────────────────────────────────────────────────────────────────

const RANGES = [40, 80, 160, 320]

export default function NavDisplay() {
  const canvasRef   = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const rafRef      = useRef(0)
  const t0Ref       = useRef(performance.now())
  const sizeRef     = useRef(500)

  const [rangeIdx, setRangeIdx] = useState(1)
  const [mode, setMode]         = useState<'real' | 'sim'>('sim')
  const [searchQ, setSearchQ]   = useState('')
  const [searching, setSearching] = useState(false)
  const [loading, setLoading]   = useState(false)
  const [ac, setAc]             = useState<AcState | null>(null)
  const [rdt, setRdt]           = useState<GeoJSON.FeatureCollection | null>(null)
  const [sigmet, setSigmet]     = useState<GeoJSON.FeatureCollection | null>(null)
  const [route, setRoute]       = useState<[number, number][] | null>(null)
  const [dep, setDep]           = useState('LFPG')
  const [arr, setArr]           = useState('LFMN')
  const [fl, setFl]             = useState(350)
  const [status, setStatus]     = useState('Charger une route ou rechercher un vol')

  const rangeNM = RANGES[rangeIdx]

  // Fetch météo
  const fetchWx = useCallback(async () => {
    const [r1, r2] = await Promise.all([
      fetch('/api/feature?type=RDT_MSG_last&count=2000').then(r => r.ok ? r.json() : null),
      fetch('/api/feature?type=SIGMET_last&count=200').then(r => r.ok ? r.json() : null),
    ])
    if (r1) setRdt(r1)
    if (r2) setSigmet(r2)
  }, [])

  useEffect(() => { fetchWx() }, [fetchWx])
  useEffect(() => {
    const id = setInterval(fetchWx, 5 * 60_000)
    return () => clearInterval(id)
  }, [fetchWx])

  // Mode SIM
  const loadSim = useCallback(async () => {
    setLoading(true); setStatus(`Calcul ${dep}→${arr}…`)
    try {
      const r = await fetch(`/api/route?dep=${dep}&arr=${arr}&fl=${fl}&speed=460`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const plan = await r.json()
      const wps: [number, number][] = (plan.waypoints ?? []).map((w: { lon: number; lat: number }) => [w.lon, w.lat])
      setRoute(wps)
      if (wps.length >= 2) {
        const [lon0, lat0] = wps[0]; const [lon1, lat1] = wps[1]
        const hdg = ((Math.atan2(lon1 - lon0, lat1 - lat0) * 180 / Math.PI) + 360) % 360
        setAc({ lat: lat0, lon: lon0, alt: fl * 100, hdg, spd: 460, callsign: `${dep}→${arr}`, icao24: 'sim' })
        setStatus(`${dep} → ${arr}  FL${fl}  Simulation`)
      }
    } catch (e) { setStatus('Erreur : ' + String(e)) }
    finally { setLoading(false) }
  }, [dep, arr, fl])

  // Mode REAL
  const search = useCallback(async () => {
    if (!searchQ.trim()) return
    setSearching(true); setStatus(`Recherche ${searchQ}…`)
    try {
      const r = await fetch(`/api/aircraft/search?cs=${encodeURIComponent(searchQ.trim())}`)
      const d = await r.json()
      const st = d.states?.[0]
      if (!st) { setStatus('Vol non trouvé'); return }
      const plan = await fetch(`/api/aircraft/${st.icao24}/route`).then(r => r.ok ? r.json() : null)
      const wps: [number, number][] = (plan?.waypoints ?? []).map((w: { lon: number; lat: number }) => [w.lon, w.lat])
      setRoute(wps.length > 0 ? wps : null)
      setAc({ lat: st.lat, lon: st.lon, alt: st.altitude ?? 0, hdg: st.true_track ?? 0, spd: st.velocity ?? 0, callsign: st.callsign?.trim() ?? st.icao24, icao24: st.icao24 })
      setStatus(`${st.callsign?.trim() ?? st.icao24}  Live ADS-B`)
    } catch { setStatus('Erreur réseau') }
    finally { setSearching(false) }
  }, [searchQ])

  // Resize canvas
  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return
    const resize = () => {
      const s = Math.min(container.clientWidth, container.clientHeight) - 16
      if (s > 0) { canvas.width = s; canvas.height = s; sizeRef.current = s }
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(container)
    return () => ro.disconnect()
  }, [])

  // Boucle de rendu
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const animate = (now: number) => {
      const beam = ((now - t0Ref.current) / 1000 * 55) % 360
      draw(ctx, sizeRef.current, ac, rdt, sigmet, rangeNM, beam, route)
      rafRef.current = requestAnimationFrame(animate)
    }
    rafRef.current = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(rafRef.current)
  }, [ac, rdt, sigmet, rangeNM, route])

  return (
    <div className="flex h-[calc(100vh-72px)] bg-[#020a04] text-slate-200 overflow-hidden">

      {/* ─── Panneau de contrôle ─── */}
      <div className="w-64 shrink-0 border-r border-[#003311]/80 flex flex-col gap-4 p-4 overflow-y-auto bg-[#010801]">

        <div>
          <div className="text-[0.5rem] uppercase tracking-widest text-[#006622] mb-2 font-mono">MODE</div>
          <div className="flex rounded border border-[#005522] overflow-hidden text-xs font-mono">
            {(['real','sim'] as const).map(m => (
              <button key={m} onClick={() => setMode(m)}
                className={`flex-1 py-2 transition font-bold ${mode === m ? 'bg-[#003311] text-[#00ff88]' : 'text-[#005522] hover:text-[#00aa44]'}`}>
                {m === 'real' ? '⬤ LIVE' : '◎ SIM'}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="text-[0.5rem] uppercase tracking-widest text-[#006622] mb-2 font-mono">RANGE</div>
          <div className="grid grid-cols-4 gap-1">
            {RANGES.map((r, i) => (
              <button key={r} onClick={() => setRangeIdx(i)}
                className={`py-1.5 rounded text-xs font-mono font-bold transition border ${rangeIdx === i ? 'border-[#00ff88] text-[#00ff88] bg-[#003311]' : 'border-[#003311] text-[#005522] hover:text-[#00aa44]'}`}>
                {r}
              </button>
            ))}
          </div>
        </div>

        {mode === 'sim' && (
          <div className="flex flex-col gap-2">
            <div className="text-[0.5rem] uppercase tracking-widest text-[#006622] mb-1 font-mono">ROUTE SIM</div>
            {[{lbl:'DEP', val:dep, set:setDep},{lbl:'ARR', val:arr, set:setArr}].map(({lbl,val,set})=>(
              <div key={lbl} className="flex items-center gap-2">
                <span className="text-[0.5rem] font-mono text-[#006622] w-7">{lbl}</span>
                <input value={val} onChange={e => set(e.target.value.toUpperCase())}
                  className="flex-1 px-2 py-1 bg-[#010a03] border border-[#004411] rounded font-mono text-[#00ff88] text-xs focus:outline-none focus:border-[#00aa44]" />
              </div>
            ))}
            <div className="flex items-center gap-2">
              <span className="text-[0.5rem] font-mono text-[#006622] w-7">FL</span>
              <input type="number" value={fl} onChange={e => setFl(parseInt(e.target.value)||350)}
                className="flex-1 px-2 py-1 bg-[#010a03] border border-[#004411] rounded font-mono text-[#00ff88] text-xs focus:outline-none focus:border-[#00aa44]" />
            </div>
            <button onClick={loadSim} disabled={loading}
              className="py-2 border border-[#005522] bg-[#011a08] text-[#00ff88] text-xs font-mono font-bold rounded hover:bg-[#003311] transition disabled:opacity-40 flex items-center justify-center gap-2">
              {loading ? <Loader2 className="size-3.5 animate-spin"/> : <Radar className="size-3.5"/>}
              {loading ? 'COMPUTING…' : 'LOAD ROUTE'}
            </button>
          </div>
        )}

        {mode === 'real' && (
          <div className="flex flex-col gap-2">
            <div className="text-[0.5rem] uppercase tracking-widest text-[#006622] mb-1 font-mono">CALLSIGN</div>
            <div className="flex gap-1.5">
              <input value={searchQ} onChange={e => setSearchQ(e.target.value.toUpperCase())}
                onKeyDown={e => e.key === 'Enter' && search()}
                placeholder="AFR123"
                className="flex-1 px-2 py-1.5 bg-[#010a03] border border-[#004411] rounded font-mono text-[#00ff88] text-xs focus:outline-none focus:border-[#00aa44] placeholder-[#004411]" />
              <button onClick={search} disabled={searching}
                className="px-2.5 border border-[#005522] bg-[#011a08] text-[#00ff88] rounded hover:bg-[#003311] transition disabled:opacity-40">
                {searching ? <Loader2 className="size-4 animate-spin"/> : <Search className="size-4"/>}
              </button>
            </div>
          </div>
        )}

        {/* Légende */}
        <div className="mt-2">
          <div className="text-[0.5rem] uppercase tracking-widest text-[#006622] mb-2 font-mono">WEATHER</div>
          {([0,15,30,45,60] as const).map(step => (
            <div key={step} className="flex items-center gap-2 py-0.5">
              <span className="size-3 rounded-sm" style={{ backgroundColor: WX[step].fill }}/>
              <span className="text-[0.55rem] font-mono text-[#009933]">
                {step === 0 ? 'ACTUAL T+0' : `FCST  T+${step}`}
              </span>
            </div>
          ))}
          <div className="flex items-center gap-2 py-0.5 mt-1">
            <span className="size-3 rounded-sm border border-red-600" style={{background:'rgba(255,20,20,0.2)'}}/>
            <span className="text-[0.55rem] font-mono text-[#009933]">SIGMET</span>
          </div>
        </div>

        <div className="mt-auto pt-3 border-t border-[#003311]">
          <div className="text-[0.5rem] font-mono text-[#006622] leading-relaxed">{status}</div>
        </div>
      </div>

      {/* ─── Affichage radar ─── */}
      <div ref={containerRef} className="flex-1 flex items-center justify-center bg-[#020a04] p-4">
        <div className="relative" style={{width: sizeRef.current, height: sizeRef.current}}>
          <canvas ref={canvasRef} className="block" style={{borderRadius:'50%', boxShadow:'0 0 60px rgba(0,200,60,0.2), 0 0 120px rgba(0,100,30,0.15)'}} />
          {ac && (
            <div className="absolute top-2 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full border border-[#00ff88]/50 bg-[#010a03]/90 text-[#00ff88] text-[0.6rem] font-mono font-bold tracking-widest whitespace-nowrap">
              {mode === 'real' ? `⬤ LIVE · ${ac.callsign}` : `◎ SIM · ${ac.callsign}`}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
