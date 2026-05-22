import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Pause, Play, Radar, Search } from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface AcState {
  lat: number; lon: number; alt: number
  hdg: number; spd: number
  callsign: string; icao24: string
}

// ─── Couleurs ICAO radar météo ────────────────────────────────────────────────

const WX: Record<number, { fill: string; stroke: string; alpha: number }> = {
  0:  { fill: '#ff003c', stroke: '#ff4466', alpha: 0.80 },
  15: { fill: '#ff6600', stroke: '#ff8833', alpha: 0.60 },
  30: { fill: '#ffdd00', stroke: '#ffee44', alpha: 0.45 },
  45: { fill: '#00cc44', stroke: '#44ff77', alpha: 0.28 },
  60: { fill: '#005522', stroke: '#007733', alpha: 0.15 },
}

// ─── Distance grand-cercle (NM) ───────────────────────────────────────────────

function distNM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 3438.45
}

// ─── Interpolation position le long de la route ───────────────────────────────

function interpolateRoute(route: [number, number][], progress: number): AcState | null {
  if (!route || route.length < 2) return null
  const dists = [0]
  for (let i = 1; i < route.length; i++) {
    dists.push(dists[i - 1] + distNM(route[i-1][1], route[i-1][0], route[i][1], route[i][0]))
  }
  const total = dists[dists.length - 1]
  const target = Math.min(total, progress * total)
  let seg = 0
  while (seg < dists.length - 2 && dists[seg + 1] < target) seg++
  const frac = dists[seg + 1] > dists[seg] ? (target - dists[seg]) / (dists[seg + 1] - dists[seg]) : 0
  const [lon0, lat0] = route[seg]
  const [lon1, lat1] = route[Math.min(route.length - 1, seg + 1)]
  const lat = lat0 + (lat1 - lat0) * frac
  const lon = lon0 + (lon1 - lon0) * frac
  const hdg = ((Math.atan2(lon1 - lon0, lat1 - lat0) * 180 / Math.PI) + 360) % 360
  return { lat, lon, alt: 35000, hdg, spd: 460, callsign: 'SIM', icao24: 'sim' }
}

// ─── Projection géo → pixels (heading-up, correction +hdg) ──────────────────

function proj(lat: number, lon: number, clat: number, clon: number, scale: number, hdgR: number): [number, number] {
  const e = (lon - clon) * 60 * Math.cos(clat * Math.PI / 180)
  const n = (lat - clat) * 60
  // Rotation +hdg : heading de l'avion pointe vers le haut
  const x =  e * Math.cos(hdgR) - n * Math.sin(hdgR)
  const y = -(e * Math.sin(hdgR) + n * Math.cos(hdgR))
  return [x * scale, y * scale]
}

// ─── Rendu Canvas radar ───────────────────────────────────────────────────────

// Pulse : 0..1, pic centré sur la phase donnée, fréquence en Hz
// Utilise un cosinus² pour une enveloppe douce (0 hors de la fenêtre de ±0.5 cycle)
function glow(tSec: number, phaseOffset: number, freqHz = 0.6): number {
  const t = (tSec * freqHz + phaseOffset) % 1  // 0..1 dans le cycle
  // Enveloppe cos² : pic à t=0, zéro à t=±0.25
  const rel = ((t + 0.5) % 1) - 0.5  // centrer sur 0
  return rel > -0.25 && rel < 0.25 ? Math.cos(rel * Math.PI * 2) ** 2 : 0
}

function drawRadar(
  ctx: CanvasRenderingContext2D, size: number,
  ac: AcState | null,
  rdt: GeoJSON.FeatureCollection | null,
  sigmet: GeoJSON.FeatureCollection | null,
  rangeNM: number,
  tSec: number,             // secondes écoulées depuis t0 (pour le pulsing)
  route: [number, number][] | null,
  rdtStep: number,          // étape RDT calée sur l'ETA de l'avion (0/15/30/45/60)
  etaISO: string,           // heure simulée à la position courante (pour HUD)
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

  // ── Fond clippé ──
  ctx.save()
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2)
  ctx.fillStyle = '#000d02'; ctx.fill(); ctx.clip()

  // ── Anneaux de portée ──
  for (let i = 1; i <= 4; i++) {
    const r = (i / 4) * R
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.strokeStyle = i === 4 ? '#008822' : '#004411'
    ctx.lineWidth = i === 4 ? 1.5 : 0.8
    ctx.setLineDash(i < 4 ? [6, 10] : []); ctx.stroke(); ctx.setLineDash([])
    ctx.fillStyle = '#006611'; ctx.font = `${Math.max(9, R * 0.036)}px monospace`
    ctx.textAlign = 'center'
    ctx.fillText(`${Math.round(rangeNM * i / 4)}`, cx, cy - r + 12)
  }

  // ── Rose des caps ──
  ctx.save(); ctx.translate(cx, cy)
  for (let deg = 0; deg < 360; deg += 10) {
    const rad = (deg - hdg) * Math.PI / 180          // position on screen
    const isMaj = deg % 30 === 0
    const r1 = R - (isMaj ? 20 : 9)
    ctx.beginPath()
    ctx.moveTo(Math.sin(rad) * R, -Math.cos(rad) * R)
    ctx.lineTo(Math.sin(rad) * r1, -Math.cos(rad) * r1)
    ctx.strokeStyle = isMaj ? '#00bb55' : '#005522'; ctx.lineWidth = isMaj ? 1.5 : 0.8; ctx.stroke()
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

  // (faisceau supprimé — les contours des objets brillent alternativement)

  // ── SIGMET — contours pulsants (phase 0, fréquence lente) ──
  if (sigmet && sigmet.features.length > 0) {
    // Phase 0 dans le cycle : les SIGMET brillent en premier
    const g0 = glow(tSec, 0, 0.55)
    const strokeAlpha = 0.35 + g0 * 0.65
    const blurAmt     = g0 * 22
    ctx.save(); ctx.translate(cx, cy)
    sigmet.features.forEach(f => {
      const geo = f.geometry as GeoJSON.Geometry
      if (!geo) return
      const polys = geo.type === 'Polygon'
        ? [(geo as GeoJSON.Polygon).coordinates]
        : geo.type === 'MultiPolygon' ? (geo as GeoJSON.MultiPolygon).coordinates : []
      polys.forEach(([ring]) => {
        ctx.beginPath()
        ring.forEach(([lon, lat], i) => {
          const [px, py] = p(lat, lon); i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)
        })
        ctx.closePath()
        ctx.fillStyle = `rgba(255,20,20,${0.08 + g0 * 0.08})`; ctx.fill()
        ctx.shadowBlur = blurAmt; ctx.shadowColor = '#ff4040'
        ctx.strokeStyle = `rgba(255,32,32,${strokeAlpha})`
        ctx.lineWidth = 0.7 + g0 * 1.4
        ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([])
        ctx.shadowBlur = 0
      })
    })
    ctx.restore()
  }

  // ── Cellules RDT — contours pulsants, phase décalée par step ──
  // Cycle à 0.55 Hz : SIGMET (ph 0) → T+0 (ph 0.25) → T+15 (ph 0.5) → T+30 (ph 0.75)
  // Chaque step a sa "tranche" de lumière ; les autres restent à l'état de base.
  if (rdt) {
    const nextStep = Math.min(60, rdtStep + 15)
    // Phase dans le cycle : T+0=0.25, T+15=0.50, T+30=0.75, T+45=1.0≡0, T+60=0.25
    const PHASE: Record<number, number> = { 0: 0.25, 15: 0.50, 30: 0.75, 45: 0.125, 60: 0.375 }
    // Dessiner fantôme d'abord, puis couche courante
    ;([nextStep, rdtStep] as const).forEach((step, pass) => {
      const isCurrent = pass === 1
      const cells = rdt.features.filter(f => {
        const ft = (f.properties as Record<string, unknown>)?.forecasttime
        if (ft === undefined || ft === null) return false
        return Math.abs((typeof ft === 'string' ? parseFloat(ft) : ft as number) - step) < 1
      })
      if (!cells.length) return
      const wc = WX[step as keyof typeof WX] ?? WX[0]
      // Pulse pour ce step (0 si fantôme, sinon déclenché sur sa phase)
      const g1  = isCurrent ? glow(tSec, PHASE[step] ?? 0.25, 0.55) : 0
      const blurAmt    = isCurrent ? 4 + g1 * 20 : 0
      const strokeW    = isCurrent ? 0.6 + g1 * 2.0 : 0
      const strokeAlpha = isCurrent ? 0.25 + g1 * 0.75 : 0
      const fillAlpha  = isCurrent ? wc.alpha : wc.alpha * 0.22
      ctx.save(); ctx.translate(cx, cy)
      cells.forEach(f => {
        const geo = f.geometry as GeoJSON.Geometry
        if (!geo) return
        const polys = geo.type === 'Polygon' ? (geo as GeoJSON.Polygon).coordinates
          : geo.type === 'MultiPolygon' ? (geo as GeoJSON.MultiPolygon).coordinates.flat() : []
        polys.forEach(ring => {
          ctx.beginPath()
          ring.forEach(([lon, lat], i) => {
            const [px, py] = p(lat, lon); i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)
          })
          ctx.closePath()
          ctx.fillStyle = wc.fill + Math.round(fillAlpha * 255).toString(16).padStart(2, '0')
          ctx.fill()
          if (isCurrent) {
            ctx.shadowBlur = blurAmt; ctx.shadowColor = wc.stroke
            ctx.strokeStyle = wc.stroke.slice(0, 7) + Math.round(strokeAlpha * 255).toString(16).padStart(2, '0')
            ctx.lineWidth = strokeW
            ctx.stroke()
            ctx.shadowBlur = 0
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
    route.forEach(([lon, lat], i) => { const [px, py] = p(lat, lon); i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py) })
    ctx.strokeStyle = 'rgba(255,255,255,0.65)'; ctx.lineWidth = 1.2; ctx.setLineDash([7, 6]); ctx.stroke(); ctx.setLineDash([])
    route.forEach(([lon, lat], i) => {
      if (i === 0 || i === route.length - 1) return
      const [px, py] = p(lat, lon)
      ctx.beginPath(); ctx.arc(px, py, 2.5, 0, Math.PI * 2); ctx.fillStyle = '#44ddff'; ctx.fill()
    })
    ;[route[0], route[route.length - 1]].forEach(([lon, lat], i) => {
      const [px, py] = p(lat, lon)
      ctx.beginPath(); ctx.moveTo(px, py - 8); ctx.lineTo(px, py + 8)
      ctx.moveTo(px - 8, py); ctx.lineTo(px + 8, py)
      ctx.strokeStyle = i === 0 ? '#88ffcc' : '#ff8844'; ctx.lineWidth = 2; ctx.stroke()
    })
    ctx.restore()
  }

  ctx.restore()  // fin clip

  // ── Symbole avion ──
  const as = R * 0.05
  ctx.save(); ctx.translate(cx, cy)
  ctx.strokeStyle = '#00ffcc'; ctx.lineWidth = 2.5; ctx.lineCap = 'round'
  ctx.shadowBlur = 10; ctx.shadowColor = '#00ffcc'
  ctx.beginPath(); ctx.moveTo(0, -as * 2.2); ctx.lineTo(0, as * 1.5); ctx.stroke()
  ctx.beginPath(); ctx.moveTo(-as * 2.1, as * 0.4); ctx.lineTo(as * 2.1, as * 0.4); ctx.stroke()
  ctx.beginPath(); ctx.moveTo(-as, as * 1.5); ctx.lineTo(as, as * 1.5); ctx.stroke()
  ctx.shadowBlur = 0; ctx.restore()

  // ── Indicateur NORD (cercle haut-gauche avec flèche N) ──
  const niR = Math.max(14, R * 0.065)
  const niX = cx - R + niR + 18
  const niY = cy - R + niR + 18
  ctx.save(); ctx.translate(niX, niY)
  ctx.beginPath(); ctx.arc(0, 0, niR, 0, Math.PI * 2)
  ctx.strokeStyle = '#005522'; ctx.lineWidth = 1; ctx.stroke()
  // Flèche vers le Nord — angle = -hdg depuis le haut
  const northAngle = -hdgR
  const nx = Math.sin(northAngle) * (niR - 3)
  const ny = -Math.cos(northAngle) * (niR - 3)
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(nx, ny)
  ctx.strokeStyle = '#00ff88'; ctx.lineWidth = 2; ctx.stroke()
  ctx.beginPath(); ctx.arc(nx, ny, 2.5, 0, Math.PI * 2); ctx.fillStyle = '#00ff88'; ctx.fill()
  // Label N
  const lx = Math.sin(northAngle) * (niR + 8)
  const ly = -Math.cos(northAngle) * (niR + 8)
  ctx.fillStyle = '#00ff88'; ctx.font = `bold ${Math.max(9, niR * 0.5)}px monospace`
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('N', lx, ly)
  ctx.restore()

  // ── Bordure ──
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2)
  ctx.strokeStyle = '#00cc44'; ctx.lineWidth = 2.5; ctx.stroke()

  // ── Infos HUD ──
  ctx.fillStyle = '#00ff88'; ctx.font = `bold ${Math.max(13, R * 0.055)}px monospace`
  ctx.textAlign = 'center'; ctx.textBaseline = 'top'
  ctx.fillText(`${String(Math.round(hdg % 360)).padStart(3, '0')}°`, cx, cy - R + 10)
  ctx.fillStyle = '#00ee44'; ctx.font = `bold ${Math.max(11, R * 0.044)}px monospace`
  ctx.textAlign = 'right'
  ctx.fillText('WX', cx + R - 10, cy - R + 10)
  ctx.fillStyle = '#00aa44'; ctx.fillText(`${rangeNM}NM`, cx + R - 10, cy - R + 28)
  // ETA courant + step RDT actif
  if (etaISO) {
    ctx.fillStyle = '#005533'; ctx.font = `${Math.max(9, R * 0.038)}px monospace`
    ctx.textAlign = 'right'
    ctx.fillText(`${etaISO}Z  T+${rdtStep}`, cx + R - 10, cy - R + 46)
  }
  if (ac) {
    const bx = cx - R + 12; const by = cy + R - 72
    ctx.textAlign = 'left'; ctx.textBaseline = 'top'
    ctx.fillStyle = '#44eeff'; ctx.fillText(`TRK ${String(Math.round(hdg % 360)).padStart(3, '0')}°`, bx, by)
    ctx.fillStyle = '#00ff88'; ctx.fillText(`GS  ${Math.round(ac.spd)} kt`, bx, by + 18)
    ctx.fillStyle = '#aaffcc'; ctx.fillText(`FL  ${String(Math.round(ac.alt / 100)).padStart(3, '0')}`, bx, by + 36)
  }
}

// ─── Rendu mini-carte ─────────────────────────────────────────────────────────

function drawMiniMap(
  ctx: CanvasRenderingContext2D, W: number, H: number,
  route: [number, number][] | null,
  ac: AcState | null,
  fir: GeoJSON.FeatureCollection | null,
  countries: GeoJSON.FeatureCollection | null,
) {
  ctx.clearRect(0, 0, W, H)
  // Fond mer
  ctx.fillStyle = '#000e1a'; ctx.fillRect(0, 0, W, H)

  if (!route || route.length < 2) {
    ctx.fillStyle = '#003311'; ctx.font = '11px monospace'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText('Charger une route', W / 2, H / 2)
    return
  }

  // Bounding box route + 20% marge
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity
  route.forEach(([lon, lat]) => {
    minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon)
    minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat)
  })
  const dLon = maxLon - minLon || 5; const dLat = maxLat - minLat || 5
  const margin = 0.22
  minLon -= dLon * margin; maxLon += dLon * margin
  minLat -= dLat * margin; maxLat += dLat * margin
  const scX = W / (maxLon - minLon); const scY = H / (maxLat - minLat)
  const sc  = Math.min(scX, scY)
  const offX = (W - (maxLon - minLon) * sc) / 2
  const offY = (H - (maxLat - minLat) * sc) / 2
  const toS = (lon: number, lat: number): [number, number] => [
    offX + (lon - minLon) * sc,
    H - offY - (lat - minLat) * sc,
  ]

  // ── Pays — fond terrestre (Natural Earth 110m) ──
  if (countries) {
    countries.features.forEach(f => {
      const g = f.geometry as GeoJSON.Geometry
      if (!g) return
      const polys = g.type === 'Polygon' ? [(g as GeoJSON.Polygon).coordinates]
        : g.type === 'MultiPolygon' ? (g as GeoJSON.MultiPolygon).coordinates : []
      polys.forEach(rings => {
        ctx.beginPath()
        rings.forEach((ring, ri) => {
          ring.forEach(([lon, lat], i) => {
            const [x, y] = toS(lon, lat)
            if (i === 0 && ri === 0) ctx.moveTo(x, y)
            else if (i === 0) ctx.moveTo(x, y)
            else ctx.lineTo(x, y)
          })
          ctx.closePath()
        })
        ctx.fillStyle = '#0c1f10'; ctx.fill()
        ctx.strokeStyle = '#1a3d1a'; ctx.lineWidth = 0.4; ctx.stroke()
      })
    })
  }

  // ── FIR boundaries (par-dessus les pays) ──
  if (fir) {
    fir.features.forEach(f => {
      const g = f.geometry as GeoJSON.Geometry
      if (!g) return
      const polys = g.type === 'Polygon' ? [(g as GeoJSON.Polygon).coordinates]
        : g.type === 'MultiPolygon' ? (g as GeoJSON.MultiPolygon).coordinates : []
      polys.forEach(([ring]) => {
        ctx.beginPath()
        ring.forEach(([lon, lat], i) => { const [x, y] = toS(lon, lat); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y) })
        ctx.closePath()
        ctx.strokeStyle = 'rgba(0,100,50,0.5)'; ctx.lineWidth = 0.5
        ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([])
      })
    })
  }

  // Route
  ctx.beginPath()
  route.forEach(([lon, lat], i) => { const [x, y] = toS(lon, lat); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y) })
  ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1.2; ctx.setLineDash([5, 5]); ctx.stroke(); ctx.setLineDash([])

  // DEP / ARR
  const [dLonV, dLatV] = route[0]; const [aLonV, aLatV] = route[route.length - 1]
  const [dx, dy] = toS(dLonV, dLatV); const [ax, ay] = toS(aLonV, aLatV)
  ctx.strokeStyle = '#88ffcc'; ctx.lineWidth = 1.5
  ctx.beginPath(); ctx.moveTo(dx - 5, dy); ctx.lineTo(dx + 5, dy); ctx.moveTo(dx, dy - 5); ctx.lineTo(dx, dy + 5); ctx.stroke()
  ctx.strokeStyle = '#ff8844'
  ctx.beginPath(); ctx.moveTo(ax - 5, ay); ctx.lineTo(ax + 5, ay); ctx.moveTo(ax, ay - 5); ctx.lineTo(ax, ay + 5); ctx.stroke()

  // Position avion
  if (ac) {
    const [acX, acY] = toS(ac.lon, ac.lat)
    ctx.save(); ctx.translate(acX, acY); ctx.rotate(ac.hdg * Math.PI / 180)
    ctx.shadowBlur = 6; ctx.shadowColor = '#00ffcc'
    ctx.beginPath(); ctx.moveTo(0, -5); ctx.lineTo(-3, 4); ctx.lineTo(3, 4); ctx.closePath()
    ctx.fillStyle = '#00ffcc'; ctx.fill()
    ctx.shadowBlur = 0; ctx.restore()
    // Ligne position → DEP/ARR (progression)
    ctx.strokeStyle = 'rgba(0,255,200,0.3)'; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(dx, dy); ctx.lineTo(acX, acY); ctx.stroke()
  }

  // Bordure
  ctx.strokeStyle = '#004411'; ctx.lineWidth = 1; ctx.strokeRect(0.5, 0.5, W - 1, H - 1)
  // Label NM restant
  if (ac) {
    const [aLon2, aLat2] = route[route.length - 1]
    const nm = Math.round(distNM(ac.lat, ac.lon, aLat2, aLon2))
    ctx.fillStyle = '#006622'; ctx.font = '9px monospace'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'
    ctx.fillText(`${nm} NM`, W - 4, H - 4)
  }
}

// ─── Composant principal ──────────────────────────────────────────────────────

const RANGES = [40, 80, 160, 320]
const SPEEDS = [1, 4, 10, 30]

export default function NavDisplay() {
  const canvasRef    = useRef<HTMLCanvasElement>(null)
  const miniRef      = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const miniContRef  = useRef<HTMLDivElement>(null)
  const rafRef       = useRef(0)
  const t0Ref        = useRef(performance.now())
  const sizeRef      = useRef(500)
  const [radarSize, setRadarSize] = useState(500)

  // Refs pour la boucle RAF (évite les re-renders)
  const acRef           = useRef<AcState | null>(null)
  const routeRef        = useRef<[number, number][] | null>(null)
  const progressRef     = useRef(0)
  const playingRef      = useRef(false)
  const speedIdxRef     = useRef(0)
  const lastFrameRef    = useRef(0)
  const lastUIRef       = useRef(0)
  // Refs pour l'alignement temporel des phénomènes météo
  const routeLoadTimeRef   = useRef(0)     // ms epoch, défini au chargement de la route
  const totalDurationMsRef = useRef(0)     // durée totale du vol en ms
  const rdtRefTimeRef      = useRef(0)     // T+0 de la dernière donnée RDT (ms epoch)
  const modeRef            = useRef<'real' | 'sim'>('sim')

  // State React (pour UI)
  const [rangeIdx, setRangeIdx] = useState(1)
  const [mode, setMode]         = useState<'real' | 'sim'>('sim')
  const [searchQ, setSearchQ]   = useState('')
  const [searching, setSearching] = useState(false)
  const [loading, setLoading]   = useState(false)
  const [ac, setAc]             = useState<AcState | null>(null)
  const [rdt, setRdt]           = useState<GeoJSON.FeatureCollection | null>(null)
  const [sigmet, setSigmet]     = useState<GeoJSON.FeatureCollection | null>(null)
  const [route, setRoute]       = useState<[number, number][] | null>(null)
  const [fir, setFir]           = useState<GeoJSON.FeatureCollection | null>(null)
  const [countries, setCountries] = useState<GeoJSON.FeatureCollection | null>(null)
  const [dep, setDep]           = useState('LFPG')
  const [arr, setArr]           = useState('LFMN')
  const [fl, setFl]             = useState(350)
  const [depTimeZ, setDepTimeZ] = useState(() => {
    const n = new Date()
    return `${String(n.getUTCHours()).padStart(2,'0')}:${String(n.getUTCMinutes()).padStart(2,'0')}`
  })
  const [status, setStatus]     = useState('Charger une route ou rechercher un vol')
  const [suggestions, setSuggestions] = useState<{icao24:string;callsign:string;lat:number;lon:number;alt:number;hdg:number;spd:number}[]>([])
  const [showSug, setShowSug]   = useState(false)
  const sugTimerRef             = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [playing, setPlaying]   = useState(false)
  const [speedIdx, setSpeedIdx] = useState(0)
  const [progress, setProgress] = useState(0)  // 0..1 pour le slider UI

  const rangeNM = RANGES[rangeIdx]

  // Sync state → refs
  useEffect(() => { acRef.current = ac }, [ac])
  useEffect(() => { routeRef.current = route }, [route])
  useEffect(() => { playingRef.current = playing }, [playing])
  useEffect(() => { speedIdxRef.current = speedIdx }, [speedIdx])
  useEffect(() => { modeRef.current = mode }, [mode])

  // Extraire l'heure de référence T+0 du dernier RDT reçu
  useEffect(() => {
    if (!rdt) return
    const t0 = rdt.features.find(f => {
      const ft = (f.properties as Record<string, unknown>)?.forecasttime
      return ft !== undefined && Math.abs(parseFloat(String(ft))) < 1
    })
    const vst = (t0?.properties as Record<string, unknown>)?.validitystarttime as string | undefined
    if (vst) {
      const t = Date.parse(vst)
      if (Number.isFinite(t)) { rdtRefTimeRef.current = t; return }
    }
    rdtRefTimeRef.current = Date.now()
  }, [rdt])

  // Fetch météo
  const fetchWx = useCallback(async () => {
    const [r1, r2] = await Promise.all([
      fetch('/api/feature?type=RDT_MSG_last&count=2000').then(r => r.ok ? r.json() : null),
      fetch('/api/feature?type=SIGMET_last&count=200').then(r => r.ok ? r.json() : null),
    ])
    if (r1) setRdt(r1); if (r2) setSigmet(r2)
  }, [])

  // Fetch FIR + pays (mini-carte) — une seule fois au montage
  useEffect(() => {
    fetch('/api/fir').then(r => r.ok ? r.json() : null).then(d => { if (d) setFir(d) }).catch(() => {})
    fetch('/api/geo/countries').then(r => r.ok ? r.json() : null).then(d => { if (d) setCountries(d) }).catch(() => {})
  }, [])

  useEffect(() => { fetchWx() }, [fetchWx])
  useEffect(() => { const id = setInterval(fetchWx, 5 * 60_000); return () => clearInterval(id) }, [fetchWx])

  // Mode SIM
  const loadSim = useCallback(async () => {
    setLoading(true); setStatus(`Calcul ${dep}→${arr}…`)
    try {
      const r = await fetch(`/api/route?dep=${dep}&arr=${arr}&fl=${fl}&speed=460`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const plan = await r.json()
      const wps: [number, number][] = (plan.waypoints ?? []).map((w: { lon: number; lat: number }) => [w.lon, w.lat])
      setRoute(wps); progressRef.current = 0; setProgress(0)
      if (wps.length >= 2) {
        // Heure de départ UTC saisie → ms epoch
        const [hh, mm] = depTimeZ.split(':').map(Number)
        const depDate = new Date()
        depDate.setUTCHours(hh, mm, 0, 0)
        // Si l'heure est déjà passée de plus de 2h, c'est un départ demain
        if (depDate.getTime() < Date.now() - 2 * 3_600_000) {
          depDate.setUTCDate(depDate.getUTCDate() + 1)
        }
        // Calculer durée totale pour l'alignement temporel des phénomènes
        let d = 0
        for (let i = 1; i < wps.length; i++) d += distNM(wps[i-1][1], wps[i-1][0], wps[i][1], wps[i][0])
        routeLoadTimeRef.current = depDate.getTime()
        totalDurationMsRef.current = (d / 460) * 3_600_000
        const [lon0, lat0] = wps[0]; const [lon1, lat1] = wps[1]
        const hdg = ((Math.atan2(lon1 - lon0, lat1 - lat0) * 180 / Math.PI) + 360) % 360
        const a = { lat: lat0, lon: lon0, alt: fl * 100, hdg, spd: 460, callsign: `${dep}→${arr}`, icao24: 'sim' }
        setAc(a); acRef.current = a
        setStatus(`${dep} → ${arr}  FL${fl}  — Prêt`)
      }
    } catch (e) { setStatus('Erreur : ' + String(e)) }
    finally { setLoading(false) }
  }, [dep, arr, fl, depTimeZ])

  // Mode REAL — chargement d'un vol sélectionné
  const loadFlight = useCallback(async (icao24: string, cs: string) => {
    setSearching(true); setShowSug(false); setSearchQ(cs); setStatus(`Chargement ${cs}…`)
    try {
      const [stateR, planR] = await Promise.all([
        fetch(`/api/aircraft/${icao24}`).then(r => r.ok ? r.json() : null),
        fetch(`/api/aircraft/${icao24}/route`).then(r => r.ok ? r.json() : null),
      ])
      const st = stateR
      const wps: [number, number][] = (planR?.waypoints ?? []).map((w: { lon: number; lat: number }) => [w.lon, w.lat])
      setRoute(wps.length > 0 ? wps : null)
      if (wps.length >= 2) {
        let d = 0
        for (let i = 1; i < wps.length; i++) d += distNM(wps[i-1][1], wps[i-1][0], wps[i][1], wps[i][0])
        routeLoadTimeRef.current = Date.now()
        totalDurationMsRef.current = (d / (st?.velocity ?? 460)) * 3_600_000
      }
      if (st) {
        const a: AcState = { lat: st.lat, lon: st.lon, alt: st.altitude ?? 0, hdg: st.true_track ?? 0, spd: st.velocity ?? 0, callsign: st.callsign?.trim() ?? icao24, icao24 }
        setAc(a); acRef.current = a
      }
      progressRef.current = 0; setProgress(0)
      setStatus(`${cs}  Live ADS-B`)
    } catch { setStatus('Erreur réseau') }
    finally { setSearching(false) }
  }, [])

  // Recherche pour suggestions (debounce 350 ms)
  const handleSearchInput = useCallback((v: string) => {
    setSearchQ(v)
    if (sugTimerRef.current) clearTimeout(sugTimerRef.current)
    if (v.trim().length < 2) { setSuggestions([]); setShowSug(false); return }
    sugTimerRef.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/aircraft/search?cs=${encodeURIComponent(v.trim())}`)
        const d = await r.json()
        const states = (d.states ?? []).slice(0, 8).map((s: Record<string, unknown>) => ({
          icao24: s.icao24 as string,
          callsign: ((s.callsign as string) ?? '').trim() || (s.icao24 as string),
          lat: s.lat as number,
          lon: s.lon as number,
          alt: (s.altitude as number) ?? 0,
          hdg: (s.true_track as number) ?? 0,
          spd: (s.velocity as number) ?? 0,
        })).filter((s: {callsign:string}) => s.callsign)
        setSuggestions(states); setShowSug(states.length > 0)
      } catch { setSuggestions([]); setShowSug(false) }
    }, 350)
  }, [])

  // Fallback search (touche Entrée sans sélection)
  const search = useCallback(async () => {
    if (!searchQ.trim()) return
    setSearching(true); setShowSug(false); setStatus(`Recherche ${searchQ}…`)
    try {
      const r = await fetch(`/api/aircraft/search?cs=${encodeURIComponent(searchQ.trim())}`)
      const d = await r.json()
      const st = d.states?.[0]
      if (!st) { setStatus('Vol non trouvé'); return }
      await loadFlight(st.icao24, (st.callsign?.trim() || st.icao24) as string)
    } catch { setStatus('Erreur réseau') }
    finally { setSearching(false) }
  }, [searchQ, loadFlight])

  // Resize canvas radar — utilise un state pour forcer le re-render du wrapper
  useEffect(() => {
    const canvas = canvasRef.current; const cont = containerRef.current
    if (!canvas || !cont) return
    const resize = () => {
      const s = Math.min(cont.clientWidth, cont.clientHeight) - 16
      if (s > 60) { canvas.width = s; canvas.height = s; sizeRef.current = s; setRadarSize(s) }
    }
    resize(); const ro = new ResizeObserver(resize); ro.observe(cont)
    return () => ro.disconnect()
  }, [])

  // Resize mini-map canvas
  useEffect(() => {
    const cont = miniContRef.current; if (!cont) return
    const resize = () => {
      const w = cont.clientWidth; if (w <= 0) return
      const h = Math.round(w * 0.68)
      const canvas = miniRef.current
      if (canvas) { canvas.width = w; canvas.height = h }
    }
    resize(); const ro = new ResizeObserver(resize); ro.observe(cont)
    return () => ro.disconnect()
  }, [])

  // Mini-map render
  useEffect(() => {
    const canvas = miniRef.current; if (!canvas) return
    const ctx = canvas.getContext('2d'); if (!ctx) return
    drawMiniMap(ctx, canvas.width, canvas.height, route, ac, fir, countries)
  }, [route, ac, fir, countries])

  // Boucle RAF
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return
    const ctx = canvas.getContext('2d'); if (!ctx) return
    const animate = (now: number) => {
      const dt = now - lastFrameRef.current; lastFrameRef.current = now

      // Avance de position si simulation en cours
      if (playingRef.current && routeRef.current && routeRef.current.length > 1) {
        // 1x = 120 secondes pour parcourir route entière, speed multiplier
        const totalSec = 120
        progressRef.current = Math.min(1, progressRef.current + (dt / 1000) * SPEEDS[speedIdxRef.current] / totalSec)
        const newAc = interpolateRoute(routeRef.current, progressRef.current)
        if (newAc) {
          newAc.callsign = acRef.current?.callsign ?? 'SIM'
          newAc.icao24 = acRef.current?.icao24 ?? 'sim'
          newAc.alt = acRef.current?.alt ?? 35000
          newAc.spd = acRef.current?.spd ?? 460
          acRef.current = newAc
        }
        if (progressRef.current >= 1) { playingRef.current = false; setPlaying(false) }
        // Update UI toutes les 150ms
        if (now - lastUIRef.current > 150) {
          lastUIRef.current = now
          if (newAc) setAc(newAc)
          setProgress(progressRef.current)
        }
      }

      const tSec = (now - t0Ref.current) / 1000

      // ── Alignement temporel des phénomènes ──
      // ETA de l'avion à la position slider courante (ms epoch)
      const flightDur = totalDurationMsRef.current || 7_200_000 // défaut 2h
      const etaMs = (routeLoadTimeRef.current || Date.now()) + progressRef.current * flightDur

      // Sélection de l'étape RDT la plus proche de l'ETA
      const rdtOffsetMin = rdtRefTimeRef.current > 0
        ? (etaMs - rdtRefTimeRef.current) / 60_000
        : 0
      const RDT_STEPS = [0, 15, 30, 45, 60]
      const rdtStep = RDT_STEPS.reduce((best, s) =>
        Math.abs(s - rdtOffsetMin) < Math.abs(best - rdtOffsetMin) ? s : best, 0)

      // Filtrage des SIGMET valides à l'ETA
      const sigmetFiltered: GeoJSON.FeatureCollection | null = sigmet ? {
        type: 'FeatureCollection' as const,
        features: sigmet.features.filter(f => {
          const pr = f.properties as Record<string, unknown>
          const begin = String(pr?.begin_position ?? pr?.validitystarttime ?? '')
          const end   = String(pr?.end_position   ?? pr?.validityendtime   ?? '')
          if (!begin) return true
          const b = Date.parse(begin)
          if (!Number.isFinite(b)) return true
          const e = end ? Date.parse(end) : Infinity
          return etaMs >= b && etaMs <= e
        }),
      } : null

      // Heure simulée formatée pour le HUD (HHmm)
      const etaDate = new Date(etaMs)
      const etaISO  = `${String(etaDate.getUTCHours()).padStart(2,'0')}${String(etaDate.getUTCMinutes()).padStart(2,'0')}`

      drawRadar(ctx, sizeRef.current, acRef.current, rdt, sigmetFiltered, rangeNM, tSec, routeRef.current, rdtStep, etaISO)
      rafRef.current = requestAnimationFrame(animate)
    }
    rafRef.current = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(rafRef.current)
  }, [rdt, sigmet, rangeNM])

  // Formatage temps estimé
  const totalDistNM = route && route.length > 1
    ? route.reduce((s, _, i) => i === 0 ? 0 : s + distNM(route[i-1][1], route[i-1][0], route[i][1], route[i][0]), 0)
    : 0
  const elapsedNM = totalDistNM * progress
  const remainNM  = totalDistNM * (1 - progress)
  const fmtTime   = (nm: number) => { const min = Math.round(nm / 460 * 60); return `${Math.floor(min/60)}h${String(min%60).padStart(2,'0')}` }

  return (
    <div className="flex h-[calc(100vh-72px)] bg-[#020a04] text-slate-200 overflow-hidden">

      {/* ─── Panneau de contrôle ─── */}
      <div className="w-56 shrink-0 border-r border-[#003311]/80 flex flex-col gap-3 p-3 overflow-y-auto bg-[#010801]">

        {/* Mini-carte */}
        <div>
          <div className="text-[0.5rem] uppercase tracking-widest text-[#006622] mb-1.5 font-mono">POSITION</div>
          <div ref={miniContRef} className="w-full">
            <canvas ref={miniRef} className="block rounded" style={{ imageRendering: 'pixelated' }} />
          </div>
        </div>

        <div>
          <div className="text-[0.5rem] uppercase tracking-widest text-[#006622] mb-1.5 font-mono">MODE</div>
          <div className="flex rounded border border-[#005522] overflow-hidden text-xs font-mono">
            {(['real','sim'] as const).map(m => (
              <button key={m} onClick={() => setMode(m)}
                className={`flex-1 py-1.5 transition font-bold ${mode === m ? 'bg-[#003311] text-[#00ff88]' : 'text-[#005522] hover:text-[#00aa44]'}`}>
                {m === 'real' ? '⬤ LIVE' : '◎ SIM'}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="text-[0.5rem] uppercase tracking-widest text-[#006622] mb-1.5 font-mono">RANGE</div>
          <div className="grid grid-cols-4 gap-1">
            {RANGES.map((r, i) => (
              <button key={r} onClick={() => setRangeIdx(i)}
                className={`py-1 rounded text-xs font-mono font-bold border transition ${rangeIdx === i ? 'border-[#00ff88] text-[#00ff88] bg-[#003311]' : 'border-[#003311] text-[#005522] hover:text-[#00aa44]'}`}>
                {r}
              </button>
            ))}
          </div>
        </div>

        {mode === 'sim' && (
          <div className="flex flex-col gap-1.5">
            <div className="text-[0.5rem] uppercase tracking-widest text-[#006622] font-mono">ROUTE SIM</div>
            {[{lbl:'DEP',val:dep,set:setDep},{lbl:'ARR',val:arr,set:setArr}].map(({lbl,val,set})=>(
              <div key={lbl} className="flex items-center gap-2">
                <span className="text-[0.5rem] font-mono text-[#006622] w-7">{lbl}</span>
                <input value={val} onChange={e=>set(e.target.value.toUpperCase())} onKeyDown={e=>e.key==='Enter'&&loadSim()}
                  className="flex-1 px-2 py-1 bg-[#010a03] border border-[#004411] rounded font-mono text-[#00ff88] text-xs focus:outline-none focus:border-[#00aa44]"/>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <span className="text-[0.5rem] font-mono text-[#006622] w-7">FL</span>
              <input type="number" value={fl} onChange={e=>setFl(parseInt(e.target.value)||350)}
                className="flex-1 px-2 py-1 bg-[#010a03] border border-[#004411] rounded font-mono text-[#00ff88] text-xs focus:outline-none focus:border-[#00aa44]"/>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[0.5rem] font-mono text-[#006622] w-7">DEP</span>
              <input
                type="time"
                value={depTimeZ}
                onChange={e => setDepTimeZ(e.target.value)}
                className="flex-1 px-2 py-1 bg-[#010a03] border border-[#004411] rounded font-mono text-[#00ff88] text-xs focus:outline-none focus:border-[#00aa44] [color-scheme:dark]"
              />
              <span className="text-[0.45rem] font-mono text-[#005522]">Z</span>
            </div>
            <button onClick={loadSim} disabled={loading}
              className="py-1.5 border border-[#005522] bg-[#011a08] text-[#00ff88] text-xs font-mono font-bold rounded hover:bg-[#003311] transition disabled:opacity-40 flex items-center justify-center gap-2">
              {loading ? <Loader2 className="size-3.5 animate-spin"/> : <Radar className="size-3.5"/>}
              {loading ? 'COMPUTING…' : 'LOAD ROUTE'}
            </button>
          </div>
        )}

        {mode === 'real' && (
          <div className="flex flex-col gap-1.5">
            <div className="text-[0.5rem] uppercase tracking-widest text-[#006622] font-mono">CALLSIGN</div>
            <div className="relative">
              <div className="flex gap-1.5">
                <input
                  value={searchQ}
                  onChange={e => handleSearchInput(e.target.value.toUpperCase())}
                  onKeyDown={e => { if (e.key === 'Enter') search(); if (e.key === 'Escape') setShowSug(false) }}
                  onFocus={() => suggestions.length > 0 && setShowSug(true)}
                  onBlur={() => setTimeout(() => setShowSug(false), 150)}
                  placeholder="AFR123"
                  className="flex-1 px-2 py-1.5 bg-[#010a03] border border-[#004411] rounded font-mono text-[#00ff88] text-xs focus:outline-none focus:border-[#00aa44] placeholder-[#004411]"
                />
                <button onClick={search} disabled={searching}
                  className="px-2 border border-[#005522] bg-[#011a08] text-[#00ff88] rounded hover:bg-[#003311] transition disabled:opacity-40">
                  {searching ? <Loader2 className="size-4 animate-spin"/> : <Search className="size-4"/>}
                </button>
              </div>
              {/* Dropdown suggestions */}
              {showSug && suggestions.length > 0 && (
                <div className="absolute top-full left-0 right-0 z-50 mt-0.5 rounded border border-[#005522] bg-[#010d04] shadow-lg overflow-hidden">
                  {suggestions.map(s => (
                    <button
                      key={s.icao24}
                      onMouseDown={() => loadFlight(s.icao24, s.callsign)}
                      className="w-full text-left px-2 py-1.5 flex items-center gap-2 hover:bg-[#003311] transition"
                    >
                      <span className="text-[#00ff88] font-mono font-bold text-xs w-16 truncate">{s.callsign}</span>
                      <span className="text-[#006622] font-mono text-[0.45rem] leading-tight">
                        FL{Math.round((s.alt || 0) / 100).toString().padStart(3,'0')}<br/>
                        {Math.round(s.spd || 0)}kt
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Légende */}
        <div>
          <div className="text-[0.5rem] uppercase tracking-widest text-[#006622] mb-1 font-mono">WX LEGEND</div>
          {([0,15,30,45,60] as const).map(step => {
            const etaMs2 = (routeLoadTimeRef.current || Date.now()) + progress * (totalDurationMsRef.current || 7_200_000)
            const rdtOff = rdtRefTimeRef.current > 0 ? (etaMs2 - rdtRefTimeRef.current) / 60_000 : 0
            const bestStep = [0,15,30,45,60].reduce((b,s) => Math.abs(s-rdtOff)<Math.abs(b-rdtOff)?s:b, 0)
            const isActive = step === bestStep
            return (
              <div key={step} className={`flex items-center gap-2 py-0.5 transition-opacity ${isActive ? 'opacity-100' : 'opacity-35'}`}>
                <span className="size-2.5 rounded-sm" style={{backgroundColor:WX[step].fill}}/>
                <span className={`text-[0.5rem] font-mono ${isActive ? 'text-[#00ff88]' : 'text-[#006622]'}`}>
                  {isActive ? '▶ ' : '  '}{step===0?'T+0  ACTUEL':`T+${step} FCST`}
                </span>
              </div>
            )
          })}
        </div>

        <div className="mt-auto pt-2 border-t border-[#003311]">
          <div className="text-[0.45rem] font-mono text-[#005522] leading-relaxed">{status}</div>
        </div>
      </div>

      {/* ─── Radar + timeline ─── */}
      <div className="flex-1 flex flex-col bg-[#020a04] min-h-0">
        {/* Radar — flex-1 min-h-0 pour qu'il cède de la place à la timeline */}
        <div ref={containerRef} className="flex-1 flex items-center justify-center p-2 min-h-0 overflow-hidden">
          <div className="relative" style={{width: radarSize, height: radarSize, flexShrink: 0}}>
            <canvas ref={canvasRef} className="block" style={{borderRadius:'50%', boxShadow:'0 0 60px rgba(0,200,60,0.18),0 0 120px rgba(0,80,20,0.12)'}}/>
            {ac && (
              <div className="absolute top-2 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full border border-[#00ff88]/40 bg-[#010a03]/90 text-[#00ff88] text-[0.6rem] font-mono font-bold tracking-widest whitespace-nowrap">
                {mode==='real'?`⬤ LIVE · ${ac.callsign}`:`◎ SIM · ${ac.callsign}`}
              </div>
            )}
          </div>
        </div>

        {/* Timeline */}
        <div className="shrink-0 border-t border-[#003311]/60 bg-[#010a03] px-4 py-2.5 flex items-center gap-3">
          {/* Play/Pause */}
          <button
            onClick={() => { setPlaying(p => !p) }}
            disabled={!route}
            className="size-8 rounded border border-[#005522] bg-[#011a08] text-[#00ff88] flex items-center justify-center hover:bg-[#003311] transition disabled:opacity-30"
          >
            {playing ? <Pause className="size-4"/> : <Play className="size-4 translate-x-px"/>}
          </button>

          {/* Vitesse */}
          <div className="flex gap-1">
            {SPEEDS.map((s, i) => (
              <button key={s} onClick={() => setSpeedIdx(i)}
                className={`px-2 py-1 rounded text-[0.55rem] font-mono font-bold border transition ${speedIdx===i?'border-[#00ff88] text-[#00ff88] bg-[#003311]':'border-[#003311] text-[#005522] hover:text-[#00aa44]'}`}>
                {s}×
              </button>
            ))}
          </div>

          {/* Slider */}
          <input type="range" min={0} max={1000} value={Math.round(progress * 1000)}
            onChange={e => {
              const v = parseInt(e.target.value) / 1000
              progressRef.current = v; setProgress(v)
              if (routeRef.current) {
                const newAc = interpolateRoute(routeRef.current, v)
                if (newAc && acRef.current) {
                  newAc.callsign = acRef.current.callsign; newAc.alt = acRef.current.alt; newAc.spd = acRef.current.spd; newAc.icao24 = acRef.current.icao24
                  acRef.current = newAc; setAc(newAc)
                }
              }
            }}
            className="flex-1 accent-[#00cc44] h-1 cursor-pointer"
            style={{ accentColor: '#00cc44' }}
          />

          {/* Temps + heure simulée */}
          <div className="shrink-0 text-[0.55rem] font-mono text-[#006622] text-right">
            {totalDistNM > 0 ? (() => {
              const etaMs3 = (routeLoadTimeRef.current || Date.now()) + progress * (totalDurationMsRef.current || 7_200_000)
              const d = new Date(etaMs3)
              const hhmm = `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}Z`
              return (
                <>
                  <div className="text-[#00ff88] font-bold">{hhmm}</div>
                  <div>
                    <span className="text-[#00aa44]">{fmtTime(elapsedNM)}</span>
                    <span className="text-[#004411]"> / {fmtTime(totalDistNM)}</span>
                  </div>
                  <div className="text-[#004411]">{Math.round(remainNM)} NM</div>
                </>
              )
            })() : <span>—</span>}
          </div>
        </div>
      </div>
    </div>
  )
}
