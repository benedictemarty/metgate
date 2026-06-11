/**
 * ATCView — affichage radar style TopSky
 * Combine piste ADS-B (OpenSky/adsb.fi) et météo OPMET sur fond sombre.
 *
 * Architecture :
 *  - MapLibre (react-map-gl) : fond géo + couches météo GeoJSON + hitbox avions
 *    + ANNEAUX de distance (GeoJSON LineString → layer MapLibre, garantit la visibilité)
 *  - Canvas overlay pointer-events:none : symboles, étiquettes, traces
 *  - Panneau gauche : contrôles
 *  - Barre inférieure : détail avion sélectionné
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import MapGL, { Layer, Popup, Source, type MapRef } from 'react-map-gl/maplibre'
import DraggableShell from '../components/DraggableShell'
import 'maplibre-gl/dist/maplibre-gl.css'
import { AlertTriangle, ChevronLeft, ChevronRight, RefreshCw, TargetIcon } from 'lucide-react'

// ─── Constantes ───────────────────────────────────────────────────────────────

const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
const POLL_MS   = 15_000
const WX_MS     = 60_000
const TRACK_MAX = 10

/** Palette inspirée TopSky (fond radar sombre, éléments clairs). */
const C = {
  ac:       '#b8d4ea',
  sel:      '#ffd700',
  ground:   '#475569',
  track:    'rgba(70,110,155,0.55)',
  vector:   'rgba(55,175,75,0.75)',
  ring:     'rgba(55,165,210,0.75)',   // bleu-cyan visible sur fond noir
  ringLbl:  'rgba(100,195,230,0.95)',
} as const

const RING_RADII = [50, 100, 200] // NM

// Bordeaux — centre du département de la Gironde
const LFBB = { longitude: -0.578, latitude: 44.837, zoom: 7 }

// ─── Types ─────────────────────────────────────────────────────────────────────

interface AcState {
  icao24: string
  callsign: string
  origin_country: string
  lon: number; lat: number
  baro_alt_m: number; baro_alt_ft: number; fl: number
  velocity_ms: number; gs_kt: number
  true_track_deg: number; vertical_rate_ms: number
  squawk: string; on_ground: boolean; time_iso: string
  stale?: boolean
}

type Track = [number, number][]  // [lon, lat][]

type WxKey = 'sigmet' | 'airmet' | 'cat' | 'givrage' | 'metar' | 'rdt'

interface WxData {
  sigmet: GeoJSON.FeatureCollection | null
  airmet: GeoJSON.FeatureCollection | null
  cat:    GeoJSON.FeatureCollection | null
  givrage:GeoJSON.FeatureCollection | null
  metar:  GeoJSON.FeatureCollection | null
  rdt:    GeoJSON.FeatureCollection | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MapInstance = any  // maplibregl.Map — évite l'import explicite

// ─── Helpers canvas (symboles avions, traces) ──────────────────────────────────

function drawTrack(ctx: CanvasRenderingContext2D, map: MapInstance, track: Track) {
  for (let i = 0; i < track.length; i++) {
    const p = map.project(track[i])
    const age = i / Math.max(1, track.length - 1)
    const r = Math.max(0.8, 2 - age * 1.2)
    ctx.beginPath()
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(70,110,155,${0.75 - age * 0.55})`
    ctx.fill()
  }
}

function drawSymbol(
  ctx: CanvasRenderingContext2D,
  px: number, py: number,
  trackDeg: number,
  selected: boolean,
  onGround: boolean,
) {
  const color = selected ? C.sel : onGround ? C.ground : C.ac
  const size  = selected ? 9.5 : 7.5

  ctx.save()
  ctx.translate(px, py)
  ctx.rotate((trackDeg * Math.PI) / 180)

  if (selected) { ctx.shadowColor = C.sel; ctx.shadowBlur = 14 }

  // Silhouette avion (vue de dessus, nez en haut)
  ctx.beginPath()
  ctx.moveTo(0, -size)                         // nez
  ctx.lineTo(size * 0.68, size * 0.75)          // bout aile droite
  ctx.lineTo(size * 0.20, size * 0.40)          // empennage droit
  ctx.lineTo(0, size * 0.62)                    // queue
  ctx.lineTo(-size * 0.20, size * 0.40)
  ctx.lineTo(-size * 0.68, size * 0.75)
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()

  ctx.shadowBlur = 0
  ctx.restore()
}

function drawVector(ctx: CanvasRenderingContext2D, map: MapInstance, ac: AcState, totalMin: number) {
  if (!ac.gs_kt) return
  const p0    = map.project([ac.lon, ac.lat])
  const hdRad = (ac.true_track_deg * Math.PI) / 180
  const cosLat = Math.cos((ac.lat * Math.PI) / 180)

  const project = (nm: number) => {
    const lonD = (nm / (60 * cosLat)) * Math.sin(hdRad)
    const latD = (nm / 60) * Math.cos(hdRad)
    return map.project([ac.lon + lonD, ac.lat + latD])
  }

  const totalNm = (ac.gs_kt * totalMin) / 60
  const p1 = project(totalNm)

  // Ligne principale
  ctx.beginPath()
  ctx.moveTo(p0.x, p0.y)
  ctx.lineTo(p1.x, p1.y)
  ctx.strokeStyle = C.vector
  ctx.lineWidth = 1.1
  ctx.stroke()

  // Positions prédites — petit cercle creux à chaque minute
  for (let m = 1; m < totalMin; m++) {
    const pm = project((ac.gs_kt * m) / 60)
    ctx.beginPath()
    ctx.arc(pm.x, pm.y, 3, 0, Math.PI * 2)
    ctx.strokeStyle = C.vector
    ctx.lineWidth = 1.2
    ctx.stroke()
  }
}

function rrect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y);              ctx.lineTo(x + w - r, y)
  ctx.arcTo(x + w, y, x + w, y + r, r)
  ctx.lineTo(x + w, y + h - r)
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
  ctx.lineTo(x + r, y + h)
  ctx.arcTo(x, y + h, x, y + h - r, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + r, y, r)
  ctx.closePath()
}

/** Rendu étiquette TopSky : 3 lignes (callsign / FL+trend / GS). */
function drawLabel(
  ctx: CanvasRenderingContext2D,
  px: number, py: number,
  ac: AcState,
  selected: boolean,
  offX: number, offY: number,
) {
  const vr    = ac.vertical_rate_ms ?? 0
  const trend = vr > 0.5 ? '↑' : vr < -0.5 ? '↓' : '—'
  const cs    = (ac.callsign || ac.icao24).trim()
  const fl    = ac.on_ground ? 'GND' : `${String(ac.fl).padStart(3, '0')}${trend}`
  const gs    = ac.gs_kt > 0 ? `${Math.round(ac.gs_kt)}` : ''
  const sq    = ac.squawk && ac.squawk !== '0000' && ac.squawk !== '' ? ac.squawk : ''

  const lx = px + offX
  const ly = py + offY

  // Ligne de chef (leader line)
  ctx.beginPath()
  ctx.moveTo(px, py)
  ctx.lineTo(lx, ly)
  ctx.strokeStyle = selected ? 'rgba(255,215,0,0.4)' : 'rgba(55,95,140,0.4)'
  ctx.lineWidth = 0.65
  ctx.stroke()

  // Dimensions boîte
  ctx.font = 'bold 11px "Courier New",monospace'
  const csW = ctx.measureText(cs).width
  ctx.font = '11px "Courier New",monospace'
  const row2W = ctx.measureText(fl + (sq ? ' ' + sq : '')).width
  const row3W = ctx.measureText(gs).width
  const boxW = Math.max(csW, row2W, row3W) + 12
  const boxH = 44
  const bx = lx - 2
  const by = ly - boxH / 2

  // Fond + bordure
  rrect(ctx, bx, by, boxW, boxH, 2)
  ctx.fillStyle   = selected ? 'rgba(22,16,2,0.93)' : 'rgba(3,5,14,0.90)'
  ctx.fill()
  ctx.strokeStyle = selected ? '#ffd700' : 'rgba(38,70,105,0.85)'
  ctx.lineWidth   = selected ? 1.3 : 0.7
  ctx.stroke()

  ctx.textAlign = 'left'

  // Ligne 1 : callsign
  ctx.font      = 'bold 11px "Courier New",monospace'
  ctx.fillStyle = selected ? '#ffd700' : '#c5ddf0'
  ctx.fillText(cs, bx + 6, by + 14)

  // Ligne 2 : FL + tendance + squawk
  ctx.font      = '11px "Courier New",monospace'
  ctx.fillStyle = selected ? '#fcd34d' : '#8fbcd8'
  ctx.fillText(fl, bx + 6, by + 28)
  if (sq) {
    ctx.fillStyle = selected ? '#9a7010' : '#4a6a88'
    ctx.fillText(' ' + sq, bx + 6 + ctx.measureText(fl).width, by + 28)
  }

  // Ligne 3 : vitesse sol (kt)
  ctx.fillStyle = selected ? '#a07012' : '#4a6a88'
  ctx.fillText(gs, bx + 6, by + 41)
}

// ─── Composant principal ───────────────────────────────────────────────────────

export default function ATCView() {
  const mapRef    = useRef<MapRef>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Données avions
  const [aircraft,   setAircraft]   = useState<AcState[]>([])
  const [selected,   setSelected]   = useState<string | null>(null)
  const [history,    setHistory]    = useState<globalThis.Map<string, Track>>(new globalThis.Map())
  const [lastUpdate, setLastUpdate] = useState('')
  const [dataSource, setDataSource] = useState<'opensky' | 'adsbfi' | ''>('')
  const [errMsg,     setErrMsg]     = useState<string | null>(null)

  // Météo
  const [wx,    setWx]    = useState<WxData>({ sigmet: null, airmet: null, cat: null, givrage: null, metar: null, rdt: null })
  const [wxOn,  setWxOn]  = useState<Record<WxKey, boolean>>({
    sigmet: true, airmet: true, cat: true, givrage: false, metar: true, rdt: true,
  })
  const [firData, setFirData] = useState<GeoJSON.FeatureCollection | null>(null)
  const [wxPopup, setWxPopup] = useState<{ lng: number; lat: number; props: Record<string, unknown> } | null>(null)

  // Contrôles IHM
  const [sideOpen,   setSideOpen]   = useState(true)
  const [showRings,  setShowRings]  = useState(true)
  const [showGround, setShowGround] = useState(false)
  const [flMin,      setFlMin]      = useState(0)
  const [flMax,      setFlMax]      = useState(660)
  const [followSel,  setFollowSel]  = useState(false)
  const [is3D,       setIs3D]       = useState(false)

  // Refs stables pour la boucle d'animation (pas de re-render)
  const acRef    = useRef<AcState[]>([])
  const selRef   = useRef<string | null>(null)
  const hisRef   = useRef<globalThis.Map<string, Track>>(new globalThis.Map())
  const ringsRef = useRef(true)
  const flLoRef  = useRef(0)
  const flHiRef  = useRef(660)
  const gndRef   = useRef(false)

  acRef.current    = aircraft
  selRef.current   = selected
  hisRef.current   = history
  ringsRef.current = showRings
  flLoRef.current  = flMin
  flHiRef.current  = flMax
  gndRef.current   = showGround

  // ── FIR ────────────────────────────────────────────────────────────────────

  useEffect(() => {
    fetch('/api/fir').then(r => r.json()).then(setFirData).catch(() => {})
  }, [])

  // ── Chargement initial ──────────────────────────────────────────────────────

  const handleMapLoad = useCallback(() => {
    fetchAc()
    fetchWx()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Fetch avions ────────────────────────────────────────────────────────────

  const fetchAc = useCallback(async () => {
    const map    = mapRef.current?.getMap()
    const bounds = map?.getBounds()
    if (!bounds) return

    const bbox = [
      bounds.getWest().toFixed(2), bounds.getSouth().toFixed(2),
      bounds.getEast().toFixed(2), bounds.getNorth().toFixed(2),
    ].join(',')

    try {
      const r  = await fetch(`/api/aircraft/search?bbox=${bbox}`)
      const d  = await r.json() as { states?: AcState[]; error?: string }
      if (d.states && d.states.length > 0) {
        applyStates(d.states, 'opensky')
        setErrMsg(null)
      } else {
        // Fallback adsb.fi
        const center = map!.getCenter()
        const r2 = await fetch(
          `/api/adsb/nearby?lat=${center.lat.toFixed(3)}&lon=${center.lng.toFixed(3)}&range_nm=200`
        )
        const d2 = await r2.json() as { states?: AcState[] }
        applyStates(d2.states ?? [], 'adsbfi')
        if (d.error) setErrMsg(d.error.slice(0, 80))
      }
    } catch (e) {
      setErrMsg(String(e).slice(0, 80))
    }
  }, [])

  const applyStates = (states: AcState[], source: 'opensky' | 'adsbfi') => {
    const valid = states.filter(ac => ac.lon && ac.lat)
    setHistory(prev => {
      const next = new globalThis.Map(prev)
      for (const ac of valid) {
        const trail = next.get(ac.icao24) ?? []
        next.set(ac.icao24, [[ac.lon, ac.lat], ...trail].slice(0, TRACK_MAX) as Track)
      }
      return next
    })
    setAircraft(valid)
    setDataSource(source)
    setLastUpdate(new Date().toISOString().slice(11, 19) + 'Z')
  }

  // ── Fetch météo ─────────────────────────────────────────────────────────────

  const fetchWx = useCallback(async () => {
    const getFeature = async (type: string, count = 200): Promise<GeoJSON.FeatureCollection | null> => {
      try {
        const r = await fetch(`/api/feature?type=${type}&count=${count}`)
        return r.ok ? r.json() : null
      } catch { return null }
    }

    try {
      const prodR = await fetch('/api/products')
      const agg   = await prodR.json() as {
        wfs?: { families?: Array<{ name: string; latest?: string }> }
      }
      const fams  = agg.wfs?.families ?? []
      const find  = (kw: string) => fams.find(f => f.name.toLowerCase().includes(kw))?.latest

      const rdtFamily = fams.find(f => f.name.toUpperCase().startsWith('RDT'))?.latest
      const [sigmet, airmet, cat, givrage, metar, rdt] = await Promise.all([
        find('sigmet')  ? getFeature(find('sigmet')!)  : null,
        find('airmet')  ? getFeature(find('airmet')!)  : null,
        getFeature('CAT_EURAT01_last'),
        getFeature('GIVRAGE_EURAT01_last'),
        find('metar')   ? getFeature(find('metar')!, 2000) : null,
        rdtFamily       ? getFeature(rdtFamily)         : null,
      ])
      setWx({ sigmet, airmet, cat, givrage, metar, rdt })
    } catch { /* silent */ }
  }, [])

  useEffect(() => {
    // Polling périodique (fetchAc/fetchWx sont aussi appelés dans handleMapLoad)
    const t1 = setInterval(fetchAc, POLL_MS)
    const t2 = setInterval(fetchWx, WX_MS)
    return () => { clearInterval(t1); clearInterval(t2) }
  }, [fetchAc, fetchWx])

  // ── Suivi avion sélectionné ─────────────────────────────────────────────────

  useEffect(() => {
    if (!followSel || !selected) return
    const ac = aircraft.find(a => a.icao24 === selected)
    if (ac) mapRef.current?.flyTo({ center: [ac.lon, ac.lat], duration: 600 })
  }, [aircraft, followSel, selected])

  // ── Boucle canvas ───────────────────────────────────────────────────────────

  useEffect(() => {
    let animId: number

    const render = () => {
      const canvas = canvasRef.current
      const map    = mapRef.current?.getMap()

      if (!canvas || !map) {
        animId = requestAnimationFrame(render)
        return
      }

      // Vérifier que la carte peut faire des projections
      let canProject = false
      try { map.project([0, 0]); canProject = true } catch { /* pas prête */ }
      if (!canProject) {
        animId = requestAnimationFrame(render)
        return
      }

      const W   = canvas.offsetWidth
      const H   = canvas.offsetHeight
      if (W === 0 || H === 0) {
        animId = requestAnimationFrame(render)
        return
      }
      const dpr = window.devicePixelRatio || 1

      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
        canvas.width  = Math.round(W * dpr)
        canvas.height = Math.round(H * dpr)
      }

      const ctx = canvas.getContext('2d')!
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, W, H)

      // ── Anneaux de distance (canvas — indépendant du style MapLibre) ──
      if (ringsRef.current) {
        const center  = map.getCenter()
        const cLon    = center.lng
        const cLat    = center.lat
        const latRad  = (cLat * Math.PI) / 180
        const lonPerNm = 1 / (60 * Math.cos(latRad))
        const latPerNm = 1 / 60

        ctx.save()
        for (const nm of RING_RADII) {
          // Cercle
          ctx.beginPath()
          for (let a = 0; a <= 360; a += 2) {
            const rad = (a * Math.PI) / 180
            const p = map.project([
              cLon + Math.sin(rad) * nm * lonPerNm,
              cLat + Math.cos(rad) * nm * latPerNm,
            ])
            a === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)
          }
          ctx.setLineDash([8, 6])
          ctx.strokeStyle = '#29b6d8'
          ctx.lineWidth = 2
          ctx.globalAlpha = 1
          ctx.stroke()

          // Croix cardinale au nord
          const np = map.project([cLon, cLat + nm * latPerNm])
          ctx.setLineDash([])
          ctx.beginPath()
          ctx.moveTo(np.x - 5, np.y)
          ctx.lineTo(np.x + 5, np.y)
          ctx.strokeStyle = '#29b6d8'
          ctx.lineWidth = 1.5
          ctx.stroke()

          // Label
          ctx.font = 'bold 12px "Courier New",monospace'
          ctx.textAlign = 'center'
          ctx.fillStyle = '#29b6d8'
          ctx.globalAlpha = 1
          ctx.fillText(`${nm} NM`, np.x, np.y - 7)
        }
        ctx.restore()
      }

      const acs  = acRef.current
      const sel  = selRef.current
      const his  = hisRef.current
      const flLo = flLoRef.current
      const flHi = flHiRef.current

      const vis = acs.filter(ac =>
        (gndRef.current || !ac.on_ground) && ac.fl >= flLo && ac.fl <= flHi
      )

      // 1. Traces historiques
      for (const ac of vis) {
        const trail = his.get(ac.icao24) ?? []
        if (trail.length > 1) drawTrack(ctx, map, trail.slice(1))
      }

      // 2. Vecteurs vitesse (6 min, anneaux toutes les 1 min)
      for (const ac of vis) {
        if (!ac.on_ground) drawVector(ctx, map, ac, 6)
      }

      // En mode 3D (pitch > 0), décaler verticalement selon l'altitude
      // map.project() ne prend que [lon,lat] → on simule la hauteur en pixels
      const pitch = map.getPitch()
      const pxPerM = pitch > 0
        ? (map.project([0, 90]).y - map.project([0, 0]).y) / 10_000_000 * Math.sin((pitch * Math.PI) / 180)
        : 0

      const projAc = (ac: AcState) => {
        const p = map.project([ac.lon, ac.lat])
        return { x: p.x, y: p.y - ac.baro_alt_m * pxPerM }
      }

      // 3. Symboles avion (non-sélectionnés d'abord)
      for (const ac of vis) {
        if (ac.icao24 === sel) continue
        const p = projAc(ac)
        drawSymbol(ctx, p.x, p.y, ac.true_track_deg, false, ac.on_ground)
      }
      const selAcCanvas = vis.find(a => a.icao24 === sel)
      if (selAcCanvas) {
        const p = projAc(selAcCanvas)
        drawSymbol(ctx, p.x, p.y, selAcCanvas.true_track_deg, true, selAcCanvas.on_ground)
      }

      // 4. Étiquettes (non-sélectionnées d'abord)
      for (const ac of vis) {
        if (ac.icao24 === sel) continue
        const p = projAc(ac)
        drawLabel(ctx, p.x, p.y, ac, false, 14, -26)
      }
      if (selAcCanvas) {
        const p = projAc(selAcCanvas)
        drawLabel(ctx, p.x, p.y, selAcCanvas, true, 18, -32)
      }

      animId = requestAnimationFrame(render)
    }

    animId = requestAnimationFrame(render)
    return () => cancelAnimationFrame(animId)
  }, []) // stable — utilise uniquement les refs

  // ── GeoJSON avions pour hit-detection MapLibre ──────────────────────────────

  const aircraftGeoJSON = useMemo((): GeoJSON.FeatureCollection => ({
    type: 'FeatureCollection',
    features: aircraft
      .filter(ac => (showGround || !ac.on_ground) && ac.fl >= flMin && ac.fl <= flMax)
      .map(ac => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [ac.lon, ac.lat] },
        properties: { icao24: ac.icao24 },
      })),
  }), [aircraft, showGround, flMin, flMax])

  // ── Toggle 3D ──────────────────────────────────────────────────────────────

  const toggle3D = useCallback(() => {
    const map = mapRef.current?.getMap()
    if (!map) return
    setIs3D(prev => {
      const next = !prev
      map.easeTo({
        pitch:   next ? 60 : 0,
        bearing: next ? map.getBearing() : 0,
        duration: 700,
      })
      return next
    })
  }, [])

  // Ctrl+clic via listener natif (react-map-gl ne transmet pas originalEvent de façon fiable)
  const mapContainerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = mapContainerRef.current
    if (!el) return
    const onMouseDown = (e: MouseEvent) => {
      if (e.ctrlKey && e.button === 2) {  // Ctrl + clic droit
        e.preventDefault()
        toggle3D()
      }
    }
    const onContextMenu = (e: MouseEvent) => {
      if (e.ctrlKey) e.preventDefault()  // supprimer le menu contextuel
    }
    el.addEventListener('contextmenu', onContextMenu)
    el.addEventListener('mousedown', onMouseDown)
    return () => {
      el.removeEventListener('mousedown', onMouseDown)
      el.removeEventListener('contextmenu', onContextMenu)
    }
  }, [toggle3D])

  // Touche T → toggle 3D
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 't' || e.key === 'T') toggle3D()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggle3D])

  // ── Click MapLibre → sélection avion ou popup événement météo ─────────────

  const WX_LAYERS = [
    'ac-hitbox',
    'sigmet-fill', 'airmet-fill',
    'cat-fill', 'givrage-fill',
    'rdt-fill', 'rdt-extrusion',
    'metar-circle',
  ]

  const handleMapClick = useCallback((e: { point: { x: number; y: number }; lngLat: { lng: number; lat: number } }) => {
    const map = mapRef.current?.getMap()
    if (!map) return

    // Filtrer uniquement les layers qui existent réellement dans la carte au moment du clic
    // (certains layers météo sont conditionnels et peuvent ne pas être montés)
    const activeLayers = WX_LAYERS.filter(id => { try { return !!map.getLayer(id) } catch { return false } })
    if (!activeLayers.length) return
    const feats = map.queryRenderedFeatures([e.point.x, e.point.y], { layers: activeLayers })
    if (!feats.length) {
      setSelected(null)
      setWxPopup(null)
      return
    }

    // Avion en priorité
    const acFeat = feats.find(f => f.layer.id === 'ac-hitbox')
    if (acFeat) {
      const icao24 = acFeat.properties?.icao24 as string
      setSelected(prev => prev === icao24 ? null : icao24)
      setWxPopup(null)
      return
    }

    // Événement météo
    const wxFeat = feats[0]
    setWxPopup({
      lng: e.lngLat.lng,
      lat: e.lngLat.lat,
      props: wxFeat.properties as Record<string, unknown>,
    })
    setSelected(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selAc = aircraft.find(ac => ac.icao24 === selected) ?? null
  const airborne = aircraft.filter(a => !a.on_ground).length
  const gndCount = aircraft.filter(a => a.on_ground).length

  // ─── Rendu ─────────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 bg-black flex flex-col" style={{ top: 64 }}>
      <div className="flex flex-1 min-h-0">

        {/* ── Panneau gauche ─────────────────────────────────────────────── */}
        <div
          className="flex-shrink-0 overflow-hidden transition-all duration-200 bg-black/90 border-r border-slate-800/50"
          style={{ width: sideOpen ? 228 : 0 }}
        >
          {sideOpen && (
            <ATCSidebar
              showRings={showRings}   onShowRings={setShowRings}
              showGround={showGround} onShowGround={setShowGround}
              flMin={flMin}           onFlMin={setFlMin}
              flMax={flMax}           onFlMax={setFlMax}
              wxOn={wxOn}             onWxToggle={(k) => setWxOn(prev => ({ ...prev, [k]: !prev[k] }))}
              onRefresh={() => { fetchAc(); fetchWx() }}
              airborne={airborne}     gndCount={gndCount}
              dataSource={dataSource} errMsg={errMsg}
            />
          )}
        </div>

        {/* ── Zone carte ─────────────────────────────────────────────────── */}
        <div ref={mapContainerRef} className="flex-1 relative min-w-0">
          <MapGL
            ref={mapRef}
            initialViewState={LFBB}
            mapStyle={MAP_STYLE}
            style={{ width: '100%', height: '100%' }}
            attributionControl={false}
            maxPitch={85}
            dragRotate={true}
            pitchWithRotate={true}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onClick={handleMapClick as any}
            onLoad={handleMapLoad}
          >
            {/* FIR */}
            {firData && (
              <Source id="fir" type="geojson" data={firData}>
                <Layer id="fir-line" type="line" paint={{
                  'line-color': 'rgba(55,95,128,0.5)',
                  'line-width': 0.75,
                  'line-dasharray': [6, 6],
                }} />
              </Source>
            )}

            {/* SIGMET */}
            {wx.sigmet && wxOn.sigmet && (
              <Source id="sigmet" type="geojson" data={wx.sigmet}>
                <Layer id="sigmet-fill" type="fill" paint={{ 'fill-color': '#ef4444', 'fill-opacity': 0.11 }} />
                <Layer id="sigmet-line" type="line" paint={{ 'line-color': '#ef4444', 'line-width': 1.5 }} />
              </Source>
            )}

            {/* AIRMET */}
            {wx.airmet && wxOn.airmet && (
              <Source id="airmet" type="geojson" data={wx.airmet}>
                <Layer id="airmet-fill" type="fill" paint={{ 'fill-color': '#f59e0b', 'fill-opacity': 0.10 }} />
                <Layer id="airmet-line" type="line" paint={{ 'line-color': '#f59e0b', 'line-width': 1.2 }} />
              </Source>
            )}

            {/* CAT Turbulence */}
            {wx.cat && wxOn.cat && (
              <Source id="cat" type="geojson" data={wx.cat}>
                {/* fill toujours visible en 2D */}
                <Layer id="cat-fill" type="fill" paint={{ 'fill-color': '#a855f7', 'fill-opacity': 0.12 }} />
                <Layer id="cat-line" type="line" paint={{
                  'line-color': '#a855f7', 'line-width': 1.5, 'line-dasharray': [4, 3],
                }} />
                {/* extrusion supplémentaire en 3D (FL200–FL450) */}
                <Layer id="cat-extrusion" type="fill-extrusion" paint={{
                  'fill-extrusion-color': '#a855f7',
                  'fill-extrusion-opacity': 0.30,
                  'fill-extrusion-height': 13700,
                  'fill-extrusion-base':   0,
                }} />
              </Source>
            )}

            {/* Givrage */}
            {wx.givrage && wxOn.givrage && (
              <Source id="givrage" type="geojson" data={wx.givrage}>
                <Layer id="givrage-fill" type="fill" paint={{ 'fill-color': '#7dd3fc', 'fill-opacity': 0.10 }} />
                <Layer id="givrage-line" type="line" paint={{ 'line-color': '#7dd3fc', 'line-width': 1.1 }} />
                <Layer id="givrage-extrusion" type="fill-extrusion" paint={{
                  'fill-extrusion-color': '#7dd3fc',
                  'fill-extrusion-opacity': 0.25,
                  'fill-extrusion-height': 6000,
                  'fill-extrusion-base':   0,
                }} />
              </Source>
            )}

            {/* METAR stations */}
            {wx.metar && wxOn.metar && (
              <Source id="metar" type="geojson" data={wx.metar}>
                <Layer id="metar-circle" type="circle"
                  filter={['==', ['geometry-type'], 'Point']}
                  paint={{
                    'circle-radius': 3,
                    'circle-color': '#38bdf8',
                    'circle-opacity': 0.6,
                    'circle-stroke-width': 0.5,
                    'circle-stroke-color': '#0ea5e9',
                    'circle-stroke-opacity': 0.8,
                  }}
                />
              </Source>
            )}

            {/* RDT — cellules convectives radar */}
            {wx.rdt && wxOn.rdt && (
              <Source id="rdt" type="geojson" data={wx.rdt}>
                <Layer id="rdt-fill" type="fill"
                  filter={['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false]}
                  paint={{ 'fill-color': '#f472b6', 'fill-opacity': 0.15 }}
                />
                <Layer id="rdt-line" type="line"
                  filter={['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false]}
                  paint={{ 'line-color': '#f472b6', 'line-width': 1.4, 'line-dasharray': [3, 2] }}
                />
                <Layer id="rdt-extrusion" type="fill-extrusion"
                  filter={['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false]}
                  paint={{
                    'fill-extrusion-color': '#f472b6',
                    'fill-extrusion-opacity': 0.40,
                    'fill-extrusion-height': 12000,
                    'fill-extrusion-base': 0,
                  }}
                />
              </Source>
            )}

            {/* Hitbox invisible avions (click MapLibre) */}
            <Source id="aircraft-src" type="geojson" data={aircraftGeoJSON}>
              <Layer id="ac-hitbox" type="circle" paint={{
                'circle-radius': 14,
                'circle-opacity': 0,
                'circle-stroke-width': 0,
              }} />
            </Source>

            {/* Popup événement météo */}
            {wxPopup && (
              <Popup
                longitude={wxPopup.lng}
                latitude={wxPopup.lat}
                closeButton={true}
                closeOnClick={false}
                onClose={() => setWxPopup(null)}
                maxWidth="340px"
                className="atc-popup"
              >
                <DraggableShell>
                  <WxPopupContent props={wxPopup.props} />
                </DraggableShell>
              </Popup>
            )}
          </MapGL>

          {/* Canvas overlay (avions, étiquettes, anneaux) */}
          <canvas
            ref={canvasRef}
            className="absolute inset-0 w-full h-full pointer-events-none"
          />

          {/* Bouton bascule panneau — intérieur zone carte, bord gauche */}
          <button
            onClick={() => setSideOpen(o => !o)}
            title={sideOpen ? 'Fermer panneau' : 'Ouvrir panneau'}
            className="absolute left-0 top-1/2 -translate-y-1/2 z-20 w-5 h-14 bg-black/80 border border-slate-700/60 flex items-center justify-center text-slate-500 hover:text-slate-200 transition rounded-r"
          >
            {sideOpen ? <ChevronLeft className="size-3" /> : <ChevronRight className="size-3" />}
          </button>

          {/* Barre inférieure de statut */}
          <div className="absolute bottom-2 left-0 right-0 flex items-center justify-between px-3 pointer-events-none">
            {/* Bouton 2D/3D — bas gauche */}
            <button
              onClick={toggle3D}
              title="Basculer 2D/3D (Ctrl+clic droit ou touche T)"
              className={`pointer-events-auto px-3 py-1 rounded border font-mono text-xs font-bold transition ${
                is3D
                  ? 'border-sky-400/80 bg-sky-900/80 text-sky-200'
                  : 'border-slate-700/60 bg-black/70 text-slate-400 hover:text-slate-200'
              }`}
            >
              {is3D ? '3D' : '2D'}
            </button>

            {/* Compteur avions — bas centre */}
            <div className="font-mono text-xs text-slate-500 bg-black/75 px-2 py-1 rounded border border-slate-800/60">
              <span className="text-slate-300">{airborne}</span> airborne
              {gndCount > 0 && <> · <span className="text-slate-400">{gndCount}</span> gnd</>}
            </div>

            {/* Horloge + source + erreur — bas droite */}
            <div className="flex items-center gap-2 font-mono text-xs pointer-events-auto">
              <span className="bg-black/75 px-2 py-1 rounded border border-slate-800/60 text-slate-400">
                {lastUpdate || '--:--:--Z'}
              </span>
              {dataSource && (
                <span className="bg-black/75 px-2 py-1 rounded border border-slate-800/60 text-slate-600">
                  {dataSource === 'opensky' ? 'OpenSky' : 'adsb.fi'}
                </span>
              )}
              {errMsg && (
                <span className="bg-black/75 px-2 py-1 rounded border border-amber-900/50 text-amber-400 flex items-center gap-1">
                  <AlertTriangle className="size-3" />
                  <span className="max-w-[180px] truncate">{errMsg}</span>
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Barre inférieure : avion sélectionné ──────────────────────────── */}
      {selAc && (
        <SelectedPanel
          ac={selAc}
          follow={followSel}
          onFollow={() => setFollowSel(f => !f)}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}

// ─── Popup événement météo ─────────────────────────────────────────────────────

const SKIP_KEYS = new Set([
  'geometry', '_fillOp', '_lineOp', '_lineW', 'kind', 'nm',
  'ogc_fid', 'message_id', 'decoded', // decoded = texte long descriptif FR, affiché séparément
])

const WX_LABEL: Record<string, string> = {
  locationindicatoricao: 'Station ICAO',
  station_icao: 'Station ICAO', stationicao: 'Station ICAO',
  observationtime: 'Heure obs.', issuetime: 'Émission',
  validitystarttime: 'Début validité', validityendtime: 'Fin validité',
  effectivevaliditystart: 'Début', effectivevalidityend: 'Fin',
  originator: 'Origine', sequencenumber: 'Séquence', status: 'Statut',
  airtemperature_c: 'Temp (°C)', dewpointtemperature_c: 'Rosée (°C)',
  qnh_hpa: 'QNH (hPa)',
  windspeed_kt: 'Vent (kt)', winddirection_deg: 'Dir. vent (°)',
  windgust_kt: 'Rafale (kt)',
  visibility_m: 'Visibilité (m)', cavok: 'CAVOK',
  clouds: 'Nuages', presentweather: 'Temps présent',
  levelupper: 'Niveau sup.', levellower: 'Niveau inf.',
  intensity: 'Intensité', movement: 'Mouvement',
  type: 'Type', name: 'Nom', family: 'Famille',
}

function WxPopupContent({ props }: { props: Record<string, unknown> }) {
  const tac     = props['tac'] as string | undefined
  const decoded = props['decoded'] as string | undefined
  const icao    = (props['locationIndicatorICAO'] ?? props['station_icao'] ?? '') as string

  const entries = Object.entries(props)
    .filter(([k, v]) => !SKIP_KEYS.has(k) && k !== 'tac'
      && k !== 'locationIndicatorICAO' && k !== 'station_icao'
      && v !== null && v !== '' && v !== undefined && v !== false)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 18)

  return (
    <div className="text-xs font-mono max-h-80 overflow-y-auto space-y-2 min-w-[260px]">
      {/* En-tête station */}
      {icao && (
        <div className="text-sm font-bold text-sky-300 border-b border-slate-700 pb-1">{icao}</div>
      )}

      {/* TAC en évidence */}
      {tac && (
        <div className="bg-slate-900 rounded px-2 py-1.5 border border-slate-700">
          <div className="text-[9px] text-slate-600 mb-1 tracking-widest">TAC</div>
          <span className="text-emerald-300 break-all leading-relaxed">{tac}</span>
        </div>
      )}

      {/* Description décodée */}
      {decoded && (
        <div className="text-slate-400 italic leading-snug text-[10px]">
          {decoded.slice(0, 200)}{decoded.length > 200 ? '…' : ''}
        </div>
      )}

      {/* Autres champs */}
      {entries.length > 0 && (
        <div className="space-y-0.5 border-t border-slate-800 pt-1">
          {entries.map(([k, v]) => {
            const label = WX_LABEL[k.toLowerCase()] ?? k
            const val   = String(v)
            return (
              <div key={k} className="flex gap-1 leading-snug">
                <span className="text-slate-600 shrink-0 w-28 truncate">{label}</span>
                <span className="text-slate-300 break-all">{val.length > 80 ? val.slice(0, 80) + '…' : val}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Panneau latéral ───────────────────────────────────────────────────────────

interface SidebarProps {
  showRings: boolean;  onShowRings: (v: boolean) => void
  showGround: boolean; onShowGround: (v: boolean) => void
  flMin: number;       onFlMin: (v: number) => void
  flMax: number;       onFlMax: (v: number) => void
  wxOn: Record<WxKey, boolean>
  onWxToggle: (k: WxKey) => void
  onRefresh: () => void
  airborne: number; gndCount: number
  dataSource: string; errMsg: string | null
}

function ATCSidebar({
  showRings, onShowRings, showGround, onShowGround,
  flMin, onFlMin, flMax, onFlMax,
  wxOn, onWxToggle, onRefresh,
  airborne, gndCount, dataSource, errMsg,
}: SidebarProps) {
  return (
    <div className="w-full h-full overflow-y-auto p-3 space-y-4 text-xs text-slate-300 font-mono">

      {/* En-tête */}
      <div className="flex items-center justify-between pb-2 border-b border-slate-800/60">
        <span className="font-sans font-semibold text-[11px] uppercase tracking-widest text-slate-400">
          ATC DISPLAY
        </span>
        <button
          onClick={onRefresh}
          title="Rafraîchir"
          className="size-6 flex items-center justify-center text-slate-600 hover:text-slate-200 transition"
        >
          <RefreshCw className="size-3.5" />
        </button>
      </div>

      {/* Compteurs */}
      <div className="grid grid-cols-2 gap-1">
        <StatBox label="AIRBORNE" value={String(airborne)} color="text-slate-200" />
        <StatBox label="GND"      value={String(gndCount)} color="text-slate-500" />
      </div>
      {dataSource && (
        <div className="text-[10px] text-slate-700 text-center -mt-2">
          source: {dataSource === 'opensky' ? 'OpenSky' : 'adsb.fi'}
        </div>
      )}
      {errMsg && (
        <div className="text-[10px] text-amber-600 bg-amber-950/20 rounded px-2 py-1 border border-amber-900/30 leading-tight">
          {errMsg}
        </div>
      )}

      {/* Affichage */}
      <Section label="AFFICHAGE">
        <ToggleRow label="ANNEAUX 50/100/200 NM" value={showRings} onChange={onShowRings} />
        <ToggleRow label="AVIONS AU SOL"          value={showGround} onChange={onShowGround} />
      </Section>

      {/* Filtre FL */}
      <Section label="FILTRE FL">
        <div className="space-y-1.5">
          <NumberInput label="MIN" value={flMin} onChange={onFlMin} min={0} max={660} step={10} />
          <NumberInput label="MAX" value={flMax} onChange={onFlMax} min={0} max={660} step={10} />
        </div>
        {/* Presets */}
        <div className="grid grid-cols-2 gap-1 mt-1.5">
          {[
            { label: 'ALL',  lo: 0,   hi: 660 },
            { label: 'LO',   lo: 0,   hi: 245 },
            { label: 'UP',   lo: 250, hi: 660 },
            { label: 'HIGH', lo: 350, hi: 660 },
          ].map(p => (
            <button
              key={p.label}
              onClick={() => { onFlMin(p.lo); onFlMax(p.hi) }}
              className="px-1 py-0.5 rounded text-[10px] bg-slate-900/60 border border-slate-800/60 text-slate-500 hover:text-slate-200 hover:border-slate-600 transition"
            >
              {p.label}
            </button>
          ))}
        </div>
      </Section>

      {/* Météo */}
      <Section label="MÉTÉO">
        {([
          { key: 'sigmet',  label: 'SIGMET',    color: '#ef4444' },
          { key: 'airmet',  label: 'AIRMET',    color: '#f59e0b' },
          { key: 'cat',     label: 'CAT TURB',  color: '#a855f7' },
          { key: 'givrage', label: 'GIVRAGE',   color: '#7dd3fc' },
          { key: 'rdt',     label: 'RDT RADAR', color: '#f472b6' },
          { key: 'metar',   label: 'METAR STN', color: '#38bdf8' },
        ] as { key: WxKey; label: string; color: string }[]).map(({ key, label, color }) => (
          <ToggleRow
            key={key}
            label={label}
            value={wxOn[key]}
            onChange={() => onWxToggle(key)}
            dot={color}
          />
        ))}
      </Section>

      {/* Légende */}
      <Section label="LÉGENDE">
        <div className="space-y-1">
          {[
            { color: '#b8d4ea',               label: 'Avion en vol' },
            { color: '#ffd700',               label: 'Sélectionné' },
            { color: '#475569',               label: 'Au sol' },
            { color: 'rgba(55,175,75,0.75)',  label: 'Vecteur 2 min' },
            { color: 'rgba(70,110,155,0.55)', label: 'Trace passée' },
            { color: 'rgba(55,165,210,0.75)', label: 'Anneaux NM' },
            { color: '#ef4444',               label: 'SIGMET' },
            { color: '#f59e0b',               label: 'AIRMET' },
            { color: '#a855f7',               label: 'CAT turb.' },
            { color: '#f472b6',               label: 'RDT convectif' },
          ].map(({ color, label }) => (
            <div key={label} className="flex items-center gap-2 text-[10px] text-slate-500">
              <span className="size-2 rounded-full flex-shrink-0 border border-current/30"
                style={{ backgroundColor: color }} />
              {label}
            </div>
          ))}
        </div>
      </Section>
    </div>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[9px] text-slate-700 tracking-widest">{label}</div>
      {children}
    </div>
  )
}

function StatBox({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="bg-slate-900/50 rounded border border-slate-800/50 px-2 py-1.5 text-center">
      <div className={`text-base font-bold leading-none ${color}`}>{value}</div>
      <div className="text-[9px] text-slate-700 mt-0.5">{label}</div>
    </div>
  )
}

function ToggleRow({
  label, value, onChange, dot,
}: { label: string; value: boolean; onChange: (v: boolean) => void; dot?: string }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className={`w-full flex items-center justify-between px-2 py-1 rounded text-[11px] transition ${
        value ? 'text-slate-200 bg-slate-900/50' : 'text-slate-600'
      }`}
    >
      <span className="flex items-center gap-1.5">
        {dot && <span className="size-2 rounded-full flex-shrink-0"
          style={{ backgroundColor: value ? dot : '#1e293b' }} />}
        {label}
      </span>
      <span className={`text-[9px] tracking-wider ${value ? 'text-emerald-500' : 'text-slate-800'}`}>
        {value ? 'ON' : 'OFF'}
      </span>
    </button>
  )
}

function NumberInput({
  label, value, onChange, min, max, step,
}: { label: string; value: number; onChange: (v: number) => void; min: number; max: number; step: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-8 text-slate-600 text-[10px]">{label}</span>
      <input
        type="number" value={value} min={min} max={max} step={step}
        onChange={e => onChange(Number(e.target.value))}
        className="flex-1 bg-slate-900/60 border border-slate-800/60 rounded px-1.5 py-0.5 text-[11px] text-slate-200 text-right focus:outline-none focus:border-slate-600"
      />
      <span className="text-slate-700 text-[10px]">FL</span>
    </div>
  )
}

// ─── Panneau avion sélectionné ─────────────────────────────────────────────────

function SelectedPanel({
  ac, follow, onFollow, onClose,
}: { ac: AcState; follow: boolean; onFollow: () => void; onClose: () => void }) {
  const vr    = ac.vertical_rate_ms ?? 0
  const vrFpm = Math.round(Math.abs(vr) * 196.85)
  const trend = vr > 0.5 ? '↑' : vr < -0.5 ? '↓' : '='
  const trendColor = vr > 0.5 ? '#34d399' : vr < -0.5 ? '#f87171' : '#94a3b8'
  const flStr = ac.on_ground ? 'GND' : String(ac.fl).padStart(3, '0')

  return (
    <div className="flex items-center gap-5 px-4 py-2 bg-black/95 border-t border-slate-800/60 font-mono text-xs text-slate-300 flex-wrap">
      {/* Fermer */}
      <button onClick={onClose} className="text-slate-600 hover:text-slate-300 text-lg leading-none transition">&times;</button>

      <PanelField label="CALLSIGN" value={ac.callsign || ac.icao24} bold gold />
      <PanelField label="ICAO24"   value={ac.icao24.toUpperCase()} />
      <PanelField label="FL"       value={flStr} />

      {!ac.on_ground && (
        <>
          <PanelField label="GS"    value={`${Math.round(ac.gs_kt)} KT`} />
          <PanelField label="HDG"   value={`${Math.round(ac.true_track_deg)}°`} />
          <PanelField label="V/S"   value={`${trend} ${vrFpm} FPM`} color={trendColor} />
        </>
      )}

      {ac.squawk && ac.squawk !== '0000' && ac.squawk !== '' && (
        <PanelField label="SSR" value={ac.squawk} />
      )}
      <PanelField label="PAYS" value={ac.origin_country} />

      {/* Bouton suivi */}
      <button
        onClick={onFollow}
        title={follow ? 'Arrêter suivi' : 'Centrer sur avion'}
        className={`ml-auto flex items-center gap-1.5 px-2 py-1 rounded border transition ${
          follow
            ? 'bg-amber-950/40 border-amber-700/50 text-amber-400'
            : 'border-slate-700/50 text-slate-500 hover:text-slate-300'
        }`}
      >
        <TargetIcon className="size-3" />
        <span className="text-[10px]">{follow ? 'SUIVI' : 'SUIVRE'}</span>
      </button>

      {/* Indicateur stale */}
      {ac.stale && (
        <span className="text-amber-600 text-[10px] flex items-center gap-1">
          <AlertTriangle className="size-3" /> STALE
        </span>
      )}
    </div>
  )
}

function PanelField({
  label, value, bold, gold, color,
}: { label: string; value: string; bold?: boolean; gold?: boolean; color?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[9px] text-slate-700 tracking-widest">{label}</span>
      <span
        className={bold ? 'font-bold text-slate-100' : ''}
        style={{ color: gold ? '#ffd700' : color }}
      >
        {value}
      </span>
    </div>
  )
}
