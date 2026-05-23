import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Pause, Play, Radar, Search } from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface AcState {
  lat: number; lon: number; alt: number   // alt en pieds (baro_alt_ft)
  hdg: number; spd: number                // hdg en °, spd en kt
  vertRateFpm?: number                    // taux vertical en ft/min
  callsign: string; icao24: string
  onGround?: boolean
}

// ─── Catégorie de vol (METAR) ─────────────────────────────────────────────────

function flightCategory(props: Record<string, unknown>): 'VFR' | 'MVFR' | 'IFR' | 'LIFR' {
  if (props.cavok === true || props.cavok === 'true') return 'VFR'
  const cloudStr = String(props.cloud ?? '')
  let ceilingFt = Infinity
  for (const g of cloudStr.split(' ')) {
    const m = g.match(/^(BKN|OVC)(\d{3})/)
    if (m) { const ft = parseInt(m[2]) * 100; if (ft < ceilingFt) ceilingFt = ft }
  }
  const visiM = parseFloat(String(props.visi ?? props.visibility_m ?? '9999')) || 9999
  if (ceilingFt < 500  || visiM < 1600) return 'LIFR'
  if (ceilingFt < 1000 || visiM < 4800) return 'IFR'
  if (ceilingFt < 3000 || visiM < 8000) return 'MVFR'
  return 'VFR'
}

const FCAT_COLOR: Record<string, string> = {
  VFR:  '#00dd44',
  MVFR: '#4488ff',
  IFR:  '#ff4444',
  LIFR: '#ff44ff',
}

// ─── Couleurs ICAO radar météo ────────────────────────────────────────────────

const WX: Record<number, { fill: string; stroke: string; alpha: number }> = {
  0:  { fill: '#ff003c', stroke: '#ff4466', alpha: 0.80 },
  15: { fill: '#ff6600', stroke: '#ff8833', alpha: 0.60 },
  30: { fill: '#ffdd00', stroke: '#ffee44', alpha: 0.45 },
  45: { fill: '#00cc44', stroke: '#44ff77', alpha: 0.28 },
  60: { fill: '#005522', stroke: '#007733', alpha: 0.15 },
}

// ─── Projection inverse : pixel écran → coordonnées géo ──────────────────────
// Inverse de proj() : résout e et n à partir des coords pixels relatives au centre.
function unproj(mx: number, my: number, cx: number, cy: number, SC: number, hdgR: number, clat: number, clon: number): [number, number] {
  const u = (mx - cx) / SC
  const v = -(my - cy) / SC
  const e = u * Math.cos(hdgR) + v * Math.sin(hdgR)
  const n = v * Math.cos(hdgR) - u * Math.sin(hdgR)
  return [clat + n / 60, clon + e / (60 * Math.cos(clat * Math.PI / 180))]
}

// ─── Point dans un anneau GeoJSON ([lon,lat][]) — ray casting ────────────────
function pointInRing(lat: number, lon: number, ring: number[][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1]
    const xj = ring[j][0], yj = ring[j][1]
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)
      inside = !inside
  }
  return inside
}

function pointInPolygon(lat: number, lon: number, coords: number[][][]): boolean {
  if (!coords.length) return false
  if (!pointInRing(lat, lon, coords[0])) return false
  for (let h = 1; h < coords.length; h++) {
    if (pointInRing(lat, lon, coords[h])) return false  // dans un trou
  }
  return true
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
  lightning: GeoJSON.FeatureCollection | null,
  rangeNM: number,
  tSec: number,
  rdtStep: number,
  etaISO: string,
  etaMs: number,
  route: [number, number][] | null,
  fir: GeoJSON.FeatureCollection | null,
  countries: GeoJSON.FeatureCollection | null,
  metar: GeoJSON.FeatureCollection | null,
  cat: GeoJSON.FeatureCollection | null,
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

  // ── Carte géo (fond plein cercle, heading-up) ──
  ctx.save(); ctx.translate(cx, cy)
  if (countries) {
    countries.features.forEach(f => {
      const g = f.geometry as GeoJSON.Geometry; if (!g) return
      const polys = g.type === 'Polygon' ? [(g as GeoJSON.Polygon).coordinates]
        : g.type === 'MultiPolygon' ? (g as GeoJSON.MultiPolygon).coordinates : []
      polys.forEach(rings => {
        ctx.beginPath()
        rings.forEach(ring => {
          ring.forEach(([lon, lat], i) => {
            const [px, py] = p(lat, lon); i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)
          })
          ctx.closePath()
        })
        ctx.fillStyle = 'rgba(12,31,16,0.72)'; ctx.fill()
        ctx.strokeStyle = 'rgba(30,60,30,0.55)'; ctx.lineWidth = 0.5; ctx.stroke()
      })
    })
  }
  if (fir) {
    fir.features.forEach(f => {
      const g = f.geometry as GeoJSON.Geometry; if (!g) return
      const polys = g.type === 'Polygon' ? [(g as GeoJSON.Polygon).coordinates]
        : g.type === 'MultiPolygon' ? (g as GeoJSON.MultiPolygon).coordinates : []
      polys.forEach(([ring]) => {
        ctx.beginPath()
        ring.forEach(([lon, lat], i) => {
          const [px, py] = p(lat, lon); i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)
        })
        ctx.closePath()
        ctx.strokeStyle = 'rgba(0,110,55,0.45)'; ctx.lineWidth = 0.6
        ctx.setLineDash([3, 4]); ctx.stroke(); ctx.setLineDash([])
      })
    })
  }
  if (route && route.length >= 2) {
    ctx.beginPath()
    route.forEach(([lon, lat], i) => {
      const [px, py] = p(lat, lon); i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)
    })
    ctx.strokeStyle = 'rgba(255,255,255,0.38)'; ctx.lineWidth = 1.2
    ctx.setLineDash([6, 6]); ctx.stroke(); ctx.setLineDash([])
    const [depLon, depLat] = route[0]
    const [arrLon, arrLat] = route[route.length - 1]
    const [dpx, dpy] = p(depLat, depLon)
    const [apx, apy] = p(arrLat, arrLon)
    const mk = Math.max(4, R * 0.04)
    ctx.strokeStyle = '#88ffcc'; ctx.lineWidth = 1.4
    ctx.beginPath(); ctx.moveTo(dpx - mk, dpy); ctx.lineTo(dpx + mk, dpy)
    ctx.moveTo(dpx, dpy - mk); ctx.lineTo(dpx, dpy + mk); ctx.stroke()
    ctx.strokeStyle = '#ff8844'
    ctx.beginPath(); ctx.moveTo(apx - mk, apy); ctx.lineTo(apx + mk, apy)
    ctx.moveTo(apx, apy - mk); ctx.lineTo(apx, apy + mk); ctx.stroke()
  }
  ctx.restore()

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

  // ── CAT — turbulence en clair (violet, phase 0.10) ──
  if (cat && cat.features.length > 0) {
    const gC = glow(tSec, 0.10, 0.45)
    ctx.save(); ctx.translate(cx, cy)
    cat.features.forEach(f => {
      const geo = f.geometry as GeoJSON.Geometry; if (!geo) return
      const polys = geo.type === 'Polygon' ? [(geo as GeoJSON.Polygon).coordinates]
        : geo.type === 'MultiPolygon' ? (geo as GeoJSON.MultiPolygon).coordinates : []
      polys.forEach(([ring]) => {
        ctx.beginPath()
        ring.forEach(([lon, lat], i) => {
          const [px, py] = p(lat, lon); i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)
        })
        ctx.closePath()
        ctx.fillStyle = `rgba(170,90,255,${0.05 + gC * 0.07})`; ctx.fill()
        ctx.shadowBlur = gC * 16; ctx.shadowColor = '#cc88ff'
        ctx.strokeStyle = `rgba(180,100,255,${0.30 + gC * 0.70})`
        ctx.lineWidth = 0.6 + gC * 1.4
        ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([])
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

  // (trajet supprimé — hover sur les phénomènes pour les identifier)

  // ── Flashes de foudre — fade temporel sur 10 min ──
  if (lightning && lightning.features.length > 0) {
    const maxAgeMs = 10 * 60_000  // 10 minutes = durée du produit MTG-LI
    ctx.save(); ctx.translate(cx, cy)
    lightning.features.forEach(f => {
      const g = f.geometry as GeoJSON.Geometry
      if (!g || g.type !== 'Point') return
      const [lon, lat] = (g as GeoJSON.Point).coordinates
      const pr = f.properties as Record<string, unknown>
      const flashMs = pr?.time ? Date.parse(pr.time as string) : 0
      if (!flashMs) return
      // Âge par rapport à l'ETA (LIVE ≈ now, SIM ≈ ETA calculée)
      const ageMs = etaMs - flashMs
      if (ageMs < 0 || ageMs > maxAgeMs) return
      const freshness = 1 - ageMs / maxAgeMs  // 1 = tout frais, 0 = vieux
      const [px, py] = p(lat, lon)
      const r2 = Math.max(1.5, 3 * freshness)
      // Couleur : blanc → jaune → orange → rouge selon ancienneté
      const hue = Math.round(60 * freshness)   // 60=jaune (neuf) → 0=rouge (vieux)
      const alpha = 0.3 + freshness * 0.7
      ctx.beginPath(); ctx.arc(px, py, r2, 0, Math.PI * 2)
      ctx.fillStyle = `hsla(${hue},100%,80%,${alpha})`
      // Halo lumineux sur les flashes récents (< 2 min)
      if (ageMs < 120_000) {
        ctx.shadowBlur = 6 + freshness * 10; ctx.shadowColor = `hsl(${hue},100%,90%)`
      }
      ctx.fill(); ctx.shadowBlur = 0
    })
    ctx.restore()
  }

  // ── METAR aérodromes — points catégorie de vol ──
  if (metar && metar.features.length > 0) {
    ctx.save(); ctx.translate(cx, cy)
    const dotR = Math.max(3, R * 0.018)
    metar.features.forEach(f => {
      const geo = f.geometry as GeoJSON.Geometry
      if (!geo || geo.type !== 'Point') return
      const [lon, lat] = (geo as GeoJSON.Point).coordinates
      const [px, py] = p(lat, lon)
      if (Math.hypot(px, py) > R * 1.02) return
      const pr = f.properties as Record<string, unknown>
      const fcat = flightCategory(pr)
      const col = FCAT_COLOR[fcat]
      ctx.beginPath(); ctx.arc(px, py, dotR, 0, Math.PI * 2)
      ctx.fillStyle = col + 'bb'
      ctx.shadowBlur = 4; ctx.shadowColor = col; ctx.fill(); ctx.shadowBlur = 0
      // Petite flèche de vent
      const wdir = parseFloat(String(pr.wind_dir ?? '0'))
      const wspd = parseFloat(String(pr.wind_speed ?? '0'))
      if (wspd > 2) {
        const wrad = (wdir - hdg) * Math.PI / 180
        const wlen = dotR * 2.2
        ctx.beginPath()
        ctx.moveTo(px, py)
        ctx.lineTo(px + Math.sin(wrad) * wlen, py - Math.cos(wrad) * wlen)
        ctx.strokeStyle = col + '88'; ctx.lineWidth = 0.8; ctx.stroke()
      }
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

// ─── Composant principal ──────────────────────────────────────────────────────

const RANGES = [40, 80, 160, 320]
const SPEEDS = [1, 4, 10, 30]

export default function NavDisplay() {
  const canvasRef    = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
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
  const routeLoadTimeRef   = useRef(0)
  const totalDurationMsRef = useRef(0)
  const rdtRefTimeRef      = useRef(0)
  const modeRef            = useRef<'real' | 'sim'>('sim')
  // Refs accessibles depuis le handler souris (hors closure RAF)
  const rdtRef2      = useRef<GeoJSON.FeatureCollection | null>(null)
  const sigmetRef2   = useRef<GeoJSON.FeatureCollection | null>(null)
  const lightningRef = useRef<GeoJSON.FeatureCollection | null>(null)
  const metarRef2    = useRef<GeoJSON.FeatureCollection | null>(null)
  const catRef2      = useRef<GeoJSON.FeatureCollection | null>(null)
  const rangeNMRef   = useRef(80)

  // State React (pour UI)
  const [rangeIdx, setRangeIdx] = useState(1)
  const [mode, setMode]         = useState<'real' | 'sim'>('sim')
  const [searchQ, setSearchQ]   = useState('')
  const [searching, setSearching] = useState(false)
  const [loading, setLoading]   = useState(false)
  const [ac, setAc]             = useState<AcState | null>(null)
  const [rdt, setRdt]           = useState<GeoJSON.FeatureCollection | null>(null)
  const [sigmet, setSigmet]     = useState<GeoJSON.FeatureCollection | null>(null)
  const [lightning, setLightning] = useState<GeoJSON.FeatureCollection | null>(null)
  const [route, setRoute]       = useState<[number, number][] | null>(null)
  const [fir, setFir]           = useState<GeoJSON.FeatureCollection | null>(null)
  const [countries, setCountries] = useState<GeoJSON.FeatureCollection | null>(null)
  const [metar, setMetar]       = useState<GeoJSON.FeatureCollection | null>(null)
  const [cat, setCat]           = useState<GeoJSON.FeatureCollection | null>(null)
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
  const [progress, setProgress] = useState(0)
  const [tooltip, setTooltip]   = useState<{x:number;y:number;lines:string[]} | null>(null)
  const [lastUpdate, setLastUpdate]   = useState<Date | null>(null)
  const [wxUpdatedAt, setWxUpdatedAt] = useState<Date | null>(null)
  const [wxFetching, setWxFetching]   = useState(false)

  const rangeNM = RANGES[rangeIdx]

  // Sync state → refs
  useEffect(() => { acRef.current = ac }, [ac])
  useEffect(() => { routeRef.current = route }, [route])
  useEffect(() => { playingRef.current = playing }, [playing])
  useEffect(() => { speedIdxRef.current = speedIdx }, [speedIdx])
  useEffect(() => { modeRef.current = mode }, [mode])
  useEffect(() => { rdtRef2.current = rdt }, [rdt])
  useEffect(() => { sigmetRef2.current = sigmet }, [sigmet])
  useEffect(() => { lightningRef.current = lightning }, [lightning])
  useEffect(() => { metarRef2.current = metar }, [metar])
  useEffect(() => { catRef2.current = cat }, [cat])
  useEffect(() => { rangeNMRef.current = RANGES[rangeIdx] }, [rangeIdx])

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
    setWxFetching(true)
    try {
      const ac = acRef.current
      const deg = 12
      const bbox = ac
        ? `${(ac.lon - deg).toFixed(1)},${(ac.lat - deg * 0.7).toFixed(1)},${(ac.lon + deg).toFixed(1)},${(ac.lat + deg * 0.7).toFixed(1)}`
        : '-30,25,50,75'
      const [r1, r2, r3, r4, r5] = await Promise.all([
        fetch('/api/feature?type=RDT_MSG_last&count=2000').then(r => r.ok ? r.json() : null),
        fetch('/api/feature?type=SIGMET_last&count=200').then(r => r.ok ? r.json() : null),
        fetch(`/api/lightning?bbox=${bbox}`).then(r => r.ok ? r.json() : null),
        fetch('/api/feature?type=SA_last&count=500').then(r => r.ok ? r.json() : null),
        fetch('/api/feature?type=CAT_EURAT01_last&count=100').then(r => r.ok ? r.json() : null),
      ])
      if (r1) setRdt(r1)
      if (r2) setSigmet(r2)
      if (r3) setLightning(r3)
      if (r4) setMetar(r4)
      if (r5) setCat(r5)
      setWxUpdatedAt(new Date())
    } finally {
      setWxFetching(false)
    }
  }, [])

  // Fetch FIR + pays (mini-carte) — une seule fois au montage
  useEffect(() => {
    fetch('/api/fir').then(r => r.ok ? r.json() : null).then(d => { if (d) setFir(d) }).catch(() => {})
    fetch('/api/geo/countries').then(r => r.ok ? r.json() : null).then(d => { if (d) setCountries(d) }).catch(() => {})
  }, [])

  useEffect(() => { fetchWx() }, [fetchWx])
  useEffect(() => { const id = setInterval(fetchWx, 5 * 60_000); return () => clearInterval(id) }, [fetchWx])

  // Polling ADS-B en mode LIVE (toutes les 15 s)
  useEffect(() => {
    if (mode !== 'real') return
    const icao24 = acRef.current?.icao24
    if (!icao24 || icao24 === 'sim') return
    const poll = async () => {
      try {
        const r = await fetch(`/api/aircraft/${icao24}`)
        if (!r.ok) return
        const st = await r.json()
        if (!st || st.found === false) return
        const prev = acRef.current
        const a: AcState = {
          lat:         st.lat             ?? prev?.lat ?? 0,
          lon:         st.lon             ?? prev?.lon ?? 0,
          alt:         st.baro_alt_ft     ?? prev?.alt ?? 0,
          hdg:         st.true_track_deg  ?? prev?.hdg ?? 0,
          spd:         st.gs_kt           ?? prev?.spd ?? 0,
          vertRateFpm: st.vertical_rate_ms != null ? Math.round(st.vertical_rate_ms * 196.85) : prev?.vertRateFpm,
          onGround:    st.on_ground       ?? false,
          callsign:    prev?.callsign     ?? st.icao24,
          icao24,
        }
        acRef.current = a; setAc(a); setLastUpdate(new Date())
      } catch { /* best-effort */ }
    }
    poll() // premier appel immédiat
    const id = setInterval(poll, 15_000)
    return () => clearInterval(id)
  }, [mode, ac?.icao24]) // eslint-disable-line react-hooks/exhaustive-deps

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
        totalDurationMsRef.current = (d / (st?.gs_kt ?? 460)) * 3_600_000
      }
      if (st) {
        const a: AcState = { lat: st.lat, lon: st.lon, alt: st.baro_alt_ft ?? 0, hdg: st.true_track_deg ?? 0, spd: st.gs_kt ?? 0, vertRateFpm: st.vertical_rate_ms != null ? Math.round(st.vertical_rate_ms * 196.85) : undefined, onGround: st.on_ground ?? false, callsign: st.callsign?.trim() ?? icao24, icao24 }
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
          alt: (s.baro_alt_ft as number) ?? 0,
          hdg: (s.true_track_deg as number) ?? 0,
          spd: (s.gs_kt as number) ?? 0,
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

  // Handler souris : projection inverse + hit-test sur RDT et SIGMET
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current; if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const dpr  = window.devicePixelRatio || 1
    const mx   = (e.clientX - rect.left) * dpr
    const my   = (e.clientY - rect.top)  * dpr
    const size = sizeRef.current
    const cx   = size / 2, cy = size / 2
    const ac   = acRef.current
    const clat = ac?.lat ?? 46.5, clon = ac?.lon ?? 2.5
    const hdgR = (ac?.hdg ?? 0) * Math.PI / 180
    const R    = size / 2 - 6
    // Hors du cercle radar ?
    if (Math.hypot(mx - cx, my - cy) > R) { setTooltip(null); return }
    const SC = R / rangeNMRef.current
    const [lat, lon] = unproj(mx, my, cx, cy, SC, hdgR, clat, clon)
    const lines: string[] = []

    // Hit-test SIGMET
    sigmetRef2.current?.features.forEach(f => {
      const g = f.geometry as GeoJSON.Geometry; if (!g) return
      const pr = f.properties as Record<string, unknown>
      const polys = g.type === 'Polygon' ? [(g as GeoJSON.Polygon).coordinates]
        : g.type === 'MultiPolygon' ? (g as GeoJSON.MultiPolygon).coordinates : []
      for (const coords of polys) {
        if (pointInPolygon(lat, lon, coords as number[][][])) {
          lines.push('⚡ SIGMET')
          if (pr?.phenomenon)       lines.push(`${pr.phenomenon}`)
          if (pr?.begin_position)   lines.push(`Début : ${String(pr.begin_position).slice(11,16)}Z`)
          if (pr?.end_position)     lines.push(`Fin   : ${String(pr.end_position).slice(11,16)}Z`)
          if (pr?.lowerlimit !== undefined) lines.push(`FL${pr.lowerlimit} – FL${pr.upperlimit}`)
          return
        }
      }
    })

    // Hit-test RDT (step courant seulement)
    const flightDur = totalDurationMsRef.current || 7_200_000
    const etaMs = (routeLoadTimeRef.current || Date.now()) + progressRef.current * flightDur
    const rdtOff = rdtRefTimeRef.current > 0 ? (etaMs - rdtRefTimeRef.current) / 60_000 : 0
    const rdtStep = [0,15,30,45,60].reduce((b,s) => Math.abs(s-rdtOff)<Math.abs(b-rdtOff)?s:b, 0)
    rdtRef2.current?.features.forEach(f => {
      const ft = (f.properties as Record<string, unknown>)?.forecasttime
      if (ft === undefined || Math.abs(parseFloat(String(ft)) - rdtStep) > 1) return
      const g = f.geometry as GeoJSON.Geometry; if (!g) return
      const pr = f.properties as Record<string, unknown>
      const polys = g.type === 'Polygon' ? [(g as GeoJSON.Polygon).coordinates]
        : g.type === 'MultiPolygon' ? (g as GeoJSON.MultiPolygon).coordinates : []
      for (const coords of polys) {
        if (pointInPolygon(lat, lon, coords as number[][][])) {
          lines.push(`🌩 RDT T+${rdtStep}`)
          if (pr?.producttype)       lines.push(`Type : ${pr.producttype}`)
          if (pr?.severity !== undefined) lines.push(`Sévérité : ${pr.severity}`)
          if (pr?.movingdirection)   lines.push(`Direction : ${pr.movingdirection}°  ${pr.movingspeed} m/s`)
          if (pr?.analysistime)      lines.push(`Analyse : ${String(pr.analysistime).slice(11,16)}Z`)
          return
        }
      }
    })

    // Hit-test CAT
    catRef2.current?.features.forEach(f => {
      const g = f.geometry as GeoJSON.Geometry; if (!g) return
      const pr = f.properties as Record<string, unknown>
      const polys = g.type === 'Polygon' ? [(g as GeoJSON.Polygon).coordinates]
        : g.type === 'MultiPolygon' ? (g as GeoJSON.MultiPolygon).coordinates : []
      for (const coords of polys) {
        if (pointInPolygon(lat, lon, coords as number[][][])) {
          lines.push('💨 CAT — Turbulence en clair')
          if (pr?.lowerlimit !== undefined) lines.push(`FL${pr.lowerlimit} – FL${pr.upperlimit}`)
          if (pr?.severity)       lines.push(`Intensité : ${pr.severity}`)
          if (pr?.begin_position) lines.push(`Début : ${String(pr.begin_position).slice(11,16)}Z`)
          if (pr?.end_position)   lines.push(`Fin   : ${String(pr.end_position).slice(11,16)}Z`)
          return
        }
      }
    })

    // Hit-test METAR aérodromes (distance au point projeté)
    metarRef2.current?.features.forEach(f => {
      const g = f.geometry as GeoJSON.Geometry
      if (!g || g.type !== 'Point') return
      const [flon, flat] = (g as GeoJSON.Point).coordinates
      const [fpx, fpy] = proj(flat, flon, clat, clon, SC, hdgR)
      if (Math.hypot((mx - cx) - fpx, (my - cy) - fpy) > 10) return
      const pr = f.properties as Record<string, unknown>
      const fcat = flightCategory(pr)
      lines.push(`✈ ${pr.id ?? '?'}  ${fcat}`)
      if (pr.cavok === true || pr.cavok === 'true') {
        lines.push('CAVOK')
      } else {
        if (pr.cloud) lines.push(`Ciel : ${pr.clouds ?? pr.cloud}`)
        const vm = parseFloat(String(pr.visi ?? '0'))
        if (vm > 0) lines.push(`Visi : ${vm >= 9999 ? '>10 km' : (vm / 1000).toFixed(1) + ' km'}`)
      }
      if (pr.wind_dir != null && pr.wind_speed != null)
        lines.push(`Vent : ${pr.wind_dir}°/${pr.wind_speed}kt${pr.gust ? ` G${pr.gust}` : ''}`)
      if (pr.temperature != null) lines.push(`T : ${pr.temperature}°C  Td : ${pr.dewpoint ?? '?'}°C  QNH : ${pr.pressure ?? '?'} hPa`)
    })

    if (lines.length > 0) {
      setTooltip({ x: e.clientX, y: e.clientY, lines })
    } else {
      setTooltip(null)
    }
  }, [])

  const handleMouseLeave = useCallback(() => setTooltip(null), [])

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

      drawRadar(ctx, sizeRef.current, acRef.current, rdt, sigmetFiltered, lightning, rangeNM, tSec, rdtStep, etaISO, etaMs, routeRef.current, fir, countries, metar, cat)
      rafRef.current = requestAnimationFrame(animate)
    }
    rafRef.current = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(rafRef.current)
  }, [rdt, sigmet, lightning, rangeNM, fir, countries, metar, cat])

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

        {/* Légende CAT + METAR */}
        <div>
          <div className="text-[0.5rem] uppercase tracking-widest text-[#006622] mb-1 font-mono">AUTRES</div>
          <div className="flex items-center gap-2 py-0.5">
            <span className="size-2.5 rounded-sm" style={{backgroundColor:'#aa5aff'}}/>
            <span className="text-[0.5rem] font-mono text-[#006622]">CAT  Turbulence</span>
          </div>
          <div className="flex flex-col gap-0.5 mt-1">
            {(['VFR','MVFR','IFR','LIFR'] as const).map(c => (
              <div key={c} className="flex items-center gap-2">
                <span className="size-2 rounded-full" style={{backgroundColor:FCAT_COLOR[c]}}/>
                <span className="text-[0.45rem] font-mono text-[#006622]">{c}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-auto pt-2 border-t border-[#003311] flex flex-col gap-1">
          {/* Indicateur de mise à jour météo */}
          <div className="flex items-center gap-1.5">
            <span className={`size-1.5 rounded-full ${wxFetching ? 'bg-[#00ff88] animate-ping' : wxUpdatedAt ? 'bg-[#004411]' : 'bg-[#003311]'}`}/>
            <span className="text-[0.45rem] font-mono text-[#005522] uppercase tracking-widest">WX</span>
            {wxFetching
              ? <span className="text-[0.45rem] font-mono text-[#00aa44]">chargement…</span>
              : wxUpdatedAt
                ? <span className="text-[0.45rem] font-mono text-[#006622]">
                    {String(wxUpdatedAt.getUTCHours()).padStart(2,'0')}:{String(wxUpdatedAt.getUTCMinutes()).padStart(2,'0')}Z
                    &nbsp;·&nbsp;
                    {rdt ? `${rdt.features.filter(f=>(f.properties as Record<string,unknown>)?.forecasttime==0).length} cell.` : '—'}
                    &nbsp;·&nbsp;
                    {lightning ? `${lightning.features.length} ⚡` : '—'}
                    &nbsp;·&nbsp;
                    {metar ? `${metar.features.length} SA` : '—'}
                  </span>
                : null
            }
          </div>
          {/* Statut opération */}
          <div className="text-[0.45rem] font-mono text-[#005522] leading-relaxed truncate">{status}</div>
        </div>
      </div>

      {/* ─── Radar + timeline ─── */}
      <div className="flex-1 flex flex-col bg-[#020a04] min-h-0">
        {/* Radar — flex-1 min-h-0 pour qu'il cède de la place à la timeline */}
        <div ref={containerRef} className="flex-1 flex items-center justify-center p-2 min-h-0 overflow-hidden">
          <div className="relative" style={{width: radarSize, height: radarSize, flexShrink: 0}}>
            <canvas
              ref={canvasRef}
              className="block"
              style={{borderRadius:'50%', boxShadow:'0 0 60px rgba(0,200,60,0.18),0 0 120px rgba(0,80,20,0.12)', cursor: tooltip ? 'crosshair' : 'default'}}
              onMouseMove={handleMouseMove}
              onMouseLeave={handleMouseLeave}
            />
            {ac && (
              <div className="absolute top-2 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full border border-[#00ff88]/40 bg-[#010a03]/90 text-[#00ff88] text-[0.6rem] font-mono font-bold tracking-widest whitespace-nowrap">
                {mode==='real'?`⬤ LIVE · ${ac.callsign}`:`◎ SIM · ${ac.callsign}`}
              </div>
            )}
          </div>
        </div>

        {/* Barre inférieure : données LIVE en mode real, timeline en mode sim */}
        {mode === 'real' ? (
          <div className="shrink-0 border-t border-[#003311]/60 bg-[#010a03] px-4 py-2 flex items-center gap-4 flex-wrap">
            {/* Indicateur LIVE */}
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="size-2 rounded-full bg-red-500 animate-pulse block"/>
              <span className="text-[#00ff88] font-mono font-bold text-[0.6rem] tracking-widest">LIVE ADS-B</span>
            </div>
            {/* Données avion */}
            {ac ? (
              <div className="flex gap-4 flex-wrap">
                {([
                  ['FL',    ac.onGround ? 'SOL' : String(Math.round(ac.alt / 100)).padStart(3, '0')],
                  ['GS',    ac.spd > 0  ? `${Math.round(ac.spd)} kt` : '---'],
                  ['TRK',   !ac.onGround && ac.hdg ? `${String(Math.round(ac.hdg % 360)).padStart(3, '0')}°` : '---'],
                  ['V/S',   ac.vertRateFpm != null && !ac.onGround ? `${ac.vertRateFpm > 0 ? '+' : ''}${ac.vertRateFpm} fpm` : '---'],
                  ['LAT',   ac.lat.toFixed(4) + '°'],
                  ['LON',   ac.lon.toFixed(4) + '°'],
                ] as [string,string][]).map(([lbl, val]) => (
                  <div key={lbl} className="flex flex-col items-center">
                    <span className="text-[0.42rem] font-mono text-[#005522] uppercase tracking-widest">{lbl}</span>
                    <span className="text-[0.65rem] font-mono text-[#00ff88] font-bold tabular-nums">{val}</span>
                  </div>
                ))}
              </div>
            ) : (
              <span className="text-[#004411] font-mono text-[0.55rem]">Rechercher un callsign →</span>
            )}
            {/* Heure dernière mise à jour */}
            <div className="ml-auto text-right shrink-0">
              {lastUpdate ? (
                <>
                  <div className="text-[0.42rem] font-mono text-[#004411] uppercase">Màj</div>
                  <div className="text-[0.6rem] font-mono text-[#006622]">
                    {String(lastUpdate.getUTCHours()).padStart(2,'0')}:{String(lastUpdate.getUTCMinutes()).padStart(2,'0')}:{String(lastUpdate.getUTCSeconds()).padStart(2,'0')}Z
                  </div>
                </>
              ) : null}
            </div>
          </div>
        ) : (
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
                    <div><span className="text-[#00aa44]">{fmtTime(elapsedNM)}</span><span className="text-[#004411]"> / {fmtTime(totalDistNM)}</span></div>
                    <div className="text-[#004411]">{Math.round(remainNM)} NM</div>
                  </>
                )
              })() : <span>—</span>}
            </div>
          </div>
        )}
      </div>

      {/* ─── Tooltip phénomène météo ─── */}
      {tooltip && (
        <div className="fixed z-50 pointer-events-none" style={{ left: tooltip.x + 14, top: tooltip.y - 8 }}>
          <div className="bg-[#010d04]/95 border border-[#00ff88]/40 rounded px-2.5 py-2 shadow-lg backdrop-blur-sm">
            {tooltip.lines.map((l, i) => (
              <div key={i} className={`font-mono whitespace-nowrap ${i === 0 ? 'text-[#00ff88] font-bold text-xs mb-1' : 'text-[#00cc55] text-[0.6rem]'}`}>
                {l}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
