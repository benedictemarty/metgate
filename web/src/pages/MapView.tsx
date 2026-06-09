import { useEffect, useMemo, useRef, useState } from 'react'
import type { MapLayerMouseEvent } from 'maplibre-gl'
import {
  Map as MapGL,
  NavigationControl,
  Popup,
  ScaleControl,
  Source,
  Layer,
} from 'react-map-gl/maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'
import {
  Clock,
  Layers as LayersIcon,
  Loader2,
  Pause,
  Plane,
  Play,
  Radio,
  Sparkles,
  Wind as WindIcon,
  X,
} from 'lucide-react'
import WindLayer, { type WindProbeFn } from '../components/WindLayer'
import TropoLayer from '../components/TropoLayer'
import QvacisLayer, { QVACIS_FLS, type QvacisDataset } from '../components/QvacisLayer'
import LightningLayer, { LIGHTNING_LAYER_DOT, LIGHTNING_LAYER_HALO } from '../components/LightningLayer'
import SatRasterLayer from '../components/SatRasterLayer'
import CloudTopLayer from '../components/CloudTopLayer'
import FlightPlan, { type RoutePlan } from '../components/FlightPlan'
import AircraftTracker, { type AircraftState } from '../components/AircraftTracker'
import { AlertTriangle, Box, ChevronDown, ChevronUp, CloudCog, CloudFog, CloudLightning, Filter, Globe2, Landmark, Link2, Link2Off, Mountain, Radar, Satellite, Settings, Zap } from 'lucide-react'
import type { Aggregate, Family } from '../types'
import { displayFamilyName } from '../familyDisplay'
import OGCFilterPanel, { type OGCFilter } from '../components/OGCFilterPanel'
import FirLayer from '../components/FirLayer'
import CountriesLayer from '../components/CountriesLayer'
import ConfigPanel, { type MapLanguageCode } from '../components/ConfigPanel'
import BasemapLanguage from '../components/BasemapLanguage'
import DraggableShell from '../components/DraggableShell'
import DraggableWindow from '../components/DraggableWindow'
import Pitch3D from '../components/Pitch3D'
import RadarLayer from '../components/RadarLayer'
import AirportAlertsLayer from '../components/AirportAlertsLayer'

interface MapViewProps {
  data: Aggregate | null
  theme?: 'dark' | 'light'
}

// Familles WFS qu'on sait afficher sur la carte. Géométries supportées par
// le backend : Point, Polygon, MultiPolygon.
//
// Les noms ici sont des *familles* (sortie de /api/products) — pas des
// FeatureTypes WFS. Le typeName réel envoyé à MetGate vient de family.latest
// (ex: "METAR_last").
// Familles OPMET stricto sensu (OACI Annexe 3, Doc 8896) : observations,
// prévisions et avis officiels couverts par les services de notification météo
// aéronautique.
const OPMET_FAMILIES = new Set([
  'METAR',
  'SPECI',
  'TAF',
  'LocalReport',
  'WL', // Aerodrome Warning (= MAA Météo France)
  'AIRMET',
  'SIGMET',
  'VolcanicAshSIGMET',
  'TropicalCycloneSIGMET',
  'VolcanicAshAdvisory',
  'TropicalCycloneAdvisory',
  'SpaceWeatherAdvisory',
])

// Familles WFS exploitées par le portail mais qui NE sont PAS OPMET : produits
// dérivés, situationnels ou support de prévision (Météo-France, EUMETSAT, VAAC).
const SITUATIONAL_FAMILIES = new Set([
  'CAT_EURAT01',
  'GIVRAGE_EURAT01',
  'RDT_MSG',
  'OPIC_GTD',
  'QVACIS',
])

const MAPPABLE_FAMILIES = new Set([...OPMET_FAMILIES, ...SITUATIONAL_FAMILIES])

interface LayerStyle {
  color: string
  glow: string
}

const LAYER_STYLES: Record<string, LayerStyle> = {
  METAR: { color: '#38bdf8', glow: '#0ea5e9' },
  SPECI: { color: '#22d3ee', glow: '#06b6d4' },
  TAF: { color: '#a78bfa', glow: '#8b5cf6' },
  AIRMET: { color: '#fbbf24', glow: '#f59e0b' },
  SIGMET: { color: '#f87171', glow: '#ef4444' },
  LocalReport: { color: '#34d399', glow: '#10b981' },
  Volcanic: { color: '#fb923c', glow: '#f97316' },
  Tropical: { color: '#f472b6', glow: '#ec4899' },
  Space: { color: '#c084fc', glow: '#a855f7' },
  CAT: { color: '#c084fc', glow: '#a855f7' },
  GIVRAGE: { color: '#7dd3fc', glow: '#38bdf8' },
  RDT: { color: '#f472b6', glow: '#ec4899' },
  OPIC: { color: '#94a3b8', glow: '#64748b' },
  QVACIS: { color: '#fb923c', glow: '#f97316' },
}

// Familles dont les features proviennent de deux sources distinctes (IWXXM XML
// principal + produit plat TAC en complément). On colore et filtre par source.
const SOURCE_AWARE_FAMILIES = new Set(['METAR', 'TAF'])

interface SourceStyle { iwxxm: LayerStyle; tac: LayerStyle }
const SOURCE_STYLES: Record<string, SourceStyle> = {
  METAR: {
    iwxxm: { color: '#38bdf8', glow: '#0ea5e9' },
    tac:   { color: '#fbbf24', glow: '#f59e0b' },
  },
  TAF: {
    iwxxm: { color: '#a78bfa', glow: '#8b5cf6' },
    tac:   { color: '#34d399', glow: '#10b981' },
  },
}

// Couleurs et libellés des statuts IWXXM (permissibleUsage). NORMAL et
// OPERATIONAL = état nominal ; les autres marquent un message non-opérationnel.
const STATUS_STYLES: Record<string, { color: string; label: string }> = {
  NORMAL:            { color: '#22c55e', label: 'OPER' },
  OPERATIONAL:       { color: '#22c55e', label: 'OPER' },
  TEST:              { color: '#fbbf24', label: 'TEST' },
  EXERCISE:          { color: '#38bdf8', label: 'EXER' },
  'NON-OPERATIONAL': { color: '#fb923c', label: 'N-OP' },
}
const STATUS_ORDER = ['NORMAL', 'OPERATIONAL', 'EXERCISE', 'TEST', 'NON-OPERATIONAL']

function statusHistogram(fc: GeoJSON.FeatureCollection): Array<[string, number]> {
  const counts: Record<string, number> = {}
  for (const f of fc.features) {
    const s = (f.properties as Record<string, unknown> | null)?.status
    const k = typeof s === 'string' && s !== '' ? s : 'UNKNOWN'
    counts[k] = (counts[k] ?? 0) + 1
  }
  const entries = Object.entries(counts)
  entries.sort((a, b) => {
    const ia = STATUS_ORDER.indexOf(a[0])
    const ib = STATUS_ORDER.indexOf(b[0])
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
  })
  return entries
}

const styleFor = (familyName: string): LayerStyle => {
  const stripped = familyName.replace(/_last$/, '')
  for (const key of Object.keys(LAYER_STYLES)) {
    if (stripped.startsWith(key)) return LAYER_STYLES[key]
  }
  return { color: '#94a3b8', glow: '#64748b' }
}


const MAP_STYLE_DARK  = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
const MAP_STYLE_LIGHT = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json'

interface FetchedLayer {
  rawData: GeoJSON.FeatureCollection // brut, contient tous les slots temporels
  data: GeoJSON.FeatureCollection // filtré selon le slot courant
  count: number
  total: number
  filterXml: string | null // filtre OGC utilisé lors du fetch (pour invalider le cache)
}

// MetGate publie pour beaucoup de produits prévisionnels (RDT_MSG, CAT,
// GIVRAGE...) plusieurs features par cellule/zone, une par fenêtre de
// validité [validitystarttime, validityendtime). Le slider sélectionne un
// instant T, et on affiche les features dont la fenêtre contient T. Les
// features sans validitystarttime (METAR/TAF/SIGMET/...) sont toujours
// affichées quel que soit l'instant choisi.
// Les SIGMET/AIRMET IWXXM utilisent begin_position/end_position ;
// les autres produits (RDT_MSG, CAT…) utilisent validitystarttime/validityendtime.
function featureValiditySlot(f: GeoJSON.Feature): string | null {
  const p = f.properties as Record<string, unknown> | null
  const v = p?.validitystarttime ?? p?.begin_position
  if (typeof v !== 'string' || v === '') return null
  return v
}

function featureValidityEnd(f: GeoJSON.Feature): string | null {
  const p = f.properties as Record<string, unknown> | null
  const v = p?.validityendtime ?? p?.end_position
  if (typeof v !== 'string' || v === '') return null
  return v
}

// Vrai si la feature est valide à l'instant donné (ISO string lex-comparable).
// Les features sans start sont toujours valides ; sans end on assume une
// fenêtre ouverte (visible dès lors que start <= instant).
function isValidAt(f: GeoJSON.Feature, instant: string): boolean {
  const start = featureValiditySlot(f)
  if (start === null) return true
  if (start > instant) return false
  const end = featureValidityEnd(f)
  if (end !== null && end <= instant) return false
  return true
}

// Calcule l'opacité dégressive selon forecasttime (en minutes, 0..60+).
// Précalculer en JS et stocker dans les properties est plus robuste que de
// passer par des expressions MapLibre `case`/`interpolate` qui ont posé pb.
function trailParamsFor(ftMin: number): {
  fill: number
  line: number
  width: number
} {
  const t = Math.min(60, Math.max(0, ftMin)) / 60 // 0..1
  return {
    fill: 0.30 - t * 0.25, // 0.30 → 0.05
    line: 0.95 - t * 0.77, // 0.95 → 0.18
    width: 2 - t * 1.3, // 2 → 0.7
  }
}

// Familles dont les polygones sont extrudables verticalement quand le mode 3D
// est actif. Limité aux produits qui transportent une plage d'altitudes fiable.
const EXTRUDABLE_FAMILIES = new Set([
  'RDT_MSG',
  'CAT_EURAT01',
  'GIVRAGE_EURAT01',
  'SIGMET',
  'AIRMET',
  'VolcanicAshSIGMET',
  'TropicalCycloneSIGMET',
])

const FL_TO_METERS = 30.48 // 1 FL = 100 ft = 30,48 m

function pickNum(props: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = props[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  }
  return undefined
}

// Calcule les limites verticales d'un feature (`base_m`, `top_m` en mètres MSL),
// à partir des conventions IWXXM / MetGate observées.
function featureFLMeters(props: Record<string, unknown>): { base_m: number; top_m: number } | null {
  // RDT_MSG : limites en mètres directement.
  const lowM = pickNum(props, ['lowerboundary'])
  const topM = pickNum(props, ['unbiasedforecastupperboundary', 'upperboundary'])
  if (typeof topM === 'number') {
    return { base_m: typeof lowM === 'number' ? Math.max(0, lowM) : 0, top_m: topM }
  }
  // SIGMET/AIRMET (parsés depuis le decoded) puis CAT/GIVRAGE (champs scalaires).
  const flMax = pickNum(props, ['parsed_fl_max', 'fl_max', 'upper_limit_fl', 'upper_fl'])
  const flMin = pickNum(props, ['parsed_fl_min', 'fl_min', 'lower_limit_fl', 'lower_fl'])
  if (typeof flMax === 'number') {
    return {
      base_m: (typeof flMin === 'number' ? Math.max(0, flMin) : 0) * FL_TO_METERS * 100,
      top_m: flMax * FL_TO_METERS * 100,
    }
  }
  return null
}

function decorateFLFeature(f: GeoJSON.Feature): GeoJSON.Feature {
  const props = (f.properties ?? {}) as Record<string, unknown>
  const fl = featureFLMeters(props)
  if (!fl) return f
  return {
    ...f,
    properties: { ...props, _base_m: fl.base_m, _top_m: fl.top_m },
  }
}

function decorateTrailFeature(f: GeoJSON.Feature): GeoJSON.Feature {
  const props = (f.properties ?? {}) as Record<string, unknown>
  const raw = props.forecasttime
  const n = typeof raw === 'string' ? parseFloat(raw) : (raw as number)
  const ft = Number.isFinite(n) ? n : 0
  const p = trailParamsFor(ft)
  return {
    ...f,
    properties: {
      ...props,
      _fillOp: p.fill,
      _lineOp: p.line,
      _lineW: p.width,
    },
  }
}

function filterBySlot(
  geo: GeoJSON.FeatureCollection,
  slot: string | null,
  showTrails: boolean,
): GeoJSON.FeatureCollection {
  const base = (() => {
    if (slot === null && !showTrails) return geo.features
    return geo.features.filter((f) => {
      const props = f.properties as Record<string, unknown> | null
      const ftRaw = props?.forecasttime
      const hasForecast = ftRaw !== undefined && ftRaw !== null && ftRaw !== ''
      if (showTrails && hasForecast) return true
      if (slot === null) return true
      return isValidAt(f, slot)
    })
  })()

  // En mode trails, on injecte les paramètres d'opacité comme properties
  // pour chaque feature ; MapLibre n'a plus qu'à lire ['get', '_fillOp'].
  const trailed = showTrails ? base.map(decorateTrailFeature) : base
  // Décoration FL (toujours) : pose `_base_m`/`_top_m` sur les features qui
  // transportent une plage d'altitudes — utilisé par le mode 3D (extrusion).
  const features = trailed.map(decorateFLFeature)

  return { ...geo, features }
}

// True dès qu'au moins une couche ACTIVE (chargée + cochée) a des features
// avec forecasttime > 0 (typiquement RDT_MSG). Le bouton Trails se cache
// quand la couche est désactivée.
function hasTrailableLayer(
  layers: Record<string, FetchedLayer>,
  active: Set<string>,
): boolean {
  for (const [name, l] of Object.entries(layers)) {
    if (!active.has(name)) continue
    for (const f of l.rawData.features) {
      const ft = (f.properties as Record<string, unknown> | null)?.forecasttime
      if (ft === undefined || ft === null || ft === '') continue
      const n = typeof ft === 'string' ? parseFloat(ft) : (ft as number)
      if (Number.isFinite(n) && n > 0) return true
    }
  }
  return false
}

function collectSlots(
  layers: Record<string, FetchedLayer>,
  active: Set<string>,
): string[] {
  const set = new Set<string>()
  for (const [name, l] of Object.entries(layers)) {
    if (!active.has(name)) continue
    for (const f of l.rawData.features) {
      const v = featureValiditySlot(f)
      if (v !== null) set.add(v)
    }
  }
  return Array.from(set).sort()
}

// Choisit comme slot par défaut celui dont validitystarttime <= now le plus
// récent (= fenêtre courante). À défaut, le 1er slot.
function pickDefaultSlot(slots: string[]): string | null {
  if (slots.length === 0) return null
  const nowIso = new Date().toISOString()
  let best: string | null = null
  for (const s of slots) {
    if (s <= nowIso) best = s
    else break
  }
  return best ?? slots[0]
}

function fmtSlotLabel(slot: string, isFirst: boolean): { primary: string; secondary?: string } {
  // ISO → HH:mm UTC, suffixé +1d si c'est demain par rapport au 1er slot
  const m = slot.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  if (!m) return { primary: slot }
  const [, y, mo, d, hh, mm] = m
  const primary = `${hh}:${mm}`
  if (isFirst) return { primary }
  return { primary, secondary: `${y}-${mo}-${d}` }
}

interface PopupItem {
  family: string
  props: Record<string, unknown>
}

interface PopupState {
  lng: number
  lat: number
  items: PopupItem[]
  idx: number
}

export default function MapView({ data, theme = 'dark' }: MapViewProps) {
  const [active, setActive] = useState<Set<string>>(new Set())
  // Filtre par source (IWXXM/TAC) pour les familles SOURCE_AWARE. Clé = nom de
  // famille. Défaut implicite : les deux sources affichées.
  const [sourceFilter, setSourceFilter] = useState<Record<string, { iwxxm: boolean; tac: boolean }>>({})
  const [loaded, setLoaded] = useState<Record<string, FetchedLayer>>({})
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [popup, setPopup] = useState<PopupState | null>(null)
  // Probe vent : MapView interroge la grille gérée par WindLayer au clic carte.
  const windProbeRef = useRef<WindProbeFn | null>(null)
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [showTrails, setShowTrails] = useState(false)
  const [windEnabled, setWindEnabled] = useState(false)
  const [windDataset, setWindDataset] = useState<'WIND' | 'JET'>('WIND')
  const [windLevelPa, setWindLevelPa] = useState(85000) // 850 hPa par défaut
  const [tropoEnabled, setTropoEnabled] = useState(false)
  const [qvacisEnabled, setQvacisEnabled] = useState(false)
  const [lightningEnabled, setLightningEnabled] = useState(false)
  const [radarEnabled, setRadarEnabled]         = useState(false)
  const [alertsEnabled, setAlertsEnabled]       = useState(false)
  const [satIREnabled, setSatIREnabled] = useState(false)
  const [satCTHEnabled] = useState(false) // CTH WMS legacy (raster instable, remplacé par CTH NetCDF)
  const [satConvEnabled, setSatConvEnabled] = useState(false)
  const [cthEnabled, setCthEnabled] = useState(false) // CTH backend NetCDF + slider FL
  const [cthMinFL, setCthMinFL] = useState(250)
  const [qvacisDataset, setQvacisDataset] = useState<QvacisDataset>('DETERMINISTIC')
  const [qvacisFL, setQvacisFL] = useState(325)
  const [showFlightPlan, setShowFlightPlan] = useState(true)
  const [showTracker, setShowTracker] = useState(true)
  const [ogcPanelOpen, setOgcPanelOpen] = useState(false)
  const [ogcFilterXml, setOgcFilterXml] = useState<string | null>(null)
  const [ogcFilter, setOgcFilter] = useState<OGCFilter | null>(null)
  const [firEnabled, setFirEnabled] = useState(false)
  const [countriesEnabled, setCountriesEnabled] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [extrude3D, setExtrude3D] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem('metgate.extrude3D') === '1'
  })
  useEffect(() => {
    try { window.localStorage.setItem('metgate.extrude3D', extrude3D ? '1' : '0') } catch { /* no-op */ }
  }, [extrude3D])
  const [mapLanguage, setMapLanguage] = useState<MapLanguageCode>(() => {
    const saved = typeof window !== 'undefined' ? window.localStorage.getItem('metgate.mapLanguage') : null
    return (saved as MapLanguageCode | null) ?? 'fr'
  })
  useEffect(() => {
    try { window.localStorage.setItem('metgate.mapLanguage', mapLanguage) } catch { /* no-op */ }
  }, [mapLanguage])
  const [windLoading, setWindLoading] = useState(false)
  const [tropoLoading, setTropoLoading] = useState(false)
  const [qvacisLoading, setQvacisLoading] = useState(false)
  const [cthLoading, setCthLoading] = useState(false)

  // Mode synchronisé : un slider maître pilote toutes les couches WCS actives.
  // Chaque WCS layer remonte ses timestamps via onTimesLoaded ; le master
  // calcule l'union, et chaque layer mappe l'instant master sur son step le
  // plus proche.
  const [wcsLinked, setWcsLinked] = useState(false)
  const [windTimes, setWindTimes] = useState<string[]>([])
  const [tropoTimes, setTropoTimes] = useState<string[]>([])
  const [qvacisTimes, setQvacisTimes] = useState<string[]>([])
  const [masterInstant, setMasterInstant] = useState<string | null>(null)
  const [masterPlaying, setMasterPlaying] = useState(false)

  // Plan de vol : si défini, prend la priorité sur le master slider WCS et
  // pilote l'instant via l'index du curseur (waypoint courant).
  const [manualPlan, setManualPlan] = useState<RoutePlan | null>(null)
  const [livePlan, setLivePlan] = useState<RoutePlan | null>(null)
  const routePlan = livePlan ?? manualPlan
  const isLivePlan = livePlan !== null
  const [routeCursor, setRouteCursor] = useState(0)
  const [routePlaying, setRoutePlaying] = useState(false)
  const [trackedAircraft, setTrackedAircraft] = useState<AircraftState | null>(null)

  // Quand un avion est suivi et que la couche Vent est sur le dataset WIND
  // multi-niveau, on aligne automatiquement le niveau de pression sur le FL
  // courant de l'avion (snap au niveau MetGate le plus proche). Le user peut
  // toujours override via le sélecteur ; le snap se redéclenchera au prochain
  // changement de FL de l'avion (montée/descente).
  useEffect(() => {
    if (!trackedAircraft || trackedAircraft.fl <= 0) return
    let best = WIND_PRESSURE_LEVELS[0]
    for (const l of WIND_PRESSURE_LEVELS) {
      if (Math.abs(l.fl - trackedAircraft.fl) < Math.abs(best.fl - trackedAircraft.fl)) {
        best = l
      }
    }
    setWindLevelPa(best.pa)
    setWindDataset('WIND')
  }, [trackedAircraft?.fl])

  useEffect(() => {
    if (!routePlan) {
      setRouteCursor(0)
      setRoutePlaying(false)
    } else {
      // En mode live (avion suivi), positionner le curseur sur la position
      // courante (= 1er waypoint après le passé accumulé). Sinon début.
      setRouteCursor(routePlan.current_idx ?? 0)
    }
  }, [routePlan])

  useEffect(() => {
    if (!routePlaying || !routePlan) return
    const id = window.setInterval(() => {
      setRouteCursor((i) => (i + 1) % routePlan.waypoints.length)
    }, 80)
    return () => window.clearInterval(id)
  }, [routePlaying, routePlan])

  // Quand une couche est désactivée, on retire ses timestamps pour ne pas
  // les laisser dans la timeline maître.
  useEffect(() => {
    if (!windEnabled) setWindTimes([])
  }, [windEnabled])
  useEffect(() => {
    if (!tropoEnabled) setTropoTimes([])
  }, [tropoEnabled])
  useEffect(() => {
    if (!qvacisEnabled) setQvacisTimes([])
  }, [qvacisEnabled])

  // Timeline maître = union triée des timestamps des couches WCS actives.
  const masterTimeline = useMemo(() => {
    const set = new Set<string>()
    for (const t of windTimes) set.add(t)
    for (const t of tropoTimes) set.add(t)
    for (const t of qvacisTimes) set.add(t)
    return Array.from(set).sort()
  }, [windTimes, tropoTimes, qvacisTimes])

  // Auto-sélection initiale (instant le plus récent <= now).
  useEffect(() => {
    if (!wcsLinked) return
    if (masterTimeline.length === 0) {
      if (masterInstant !== null) setMasterInstant(null)
      return
    }
    if (!masterInstant || !masterTimeline.includes(masterInstant)) {
      const now = new Date().toISOString()
      let best = masterTimeline[0]
      for (const t of masterTimeline) {
        if (t <= now) best = t
        else break
      }
      setMasterInstant(best)
    }
  }, [wcsLinked, masterTimeline, masterInstant])

  // Auto-play global pour le master.
  useEffect(() => {
    if (!wcsLinked || !masterPlaying || masterTimeline.length < 2) return
    const id = window.setInterval(() => {
      setMasterInstant((prev) => {
        if (prev === null) return masterTimeline[0]
        const i = masterTimeline.indexOf(prev)
        return masterTimeline[(i + 1) % masterTimeline.length]
      })
    }, 1100)
    return () => window.clearInterval(id)
  }, [wcsLinked, masterPlaying, masterTimeline])

  // Quand un plan de vol est actif, l'instant qui pilote les couches WCS est
  // celui du waypoint courant (vue 4D). Sinon, mode master classique.
  const routeInstant =
    routePlan && routePlan.waypoints[routeCursor]
      ? routePlan.waypoints[routeCursor].time
      : null
  const linkedInstantForLayers = routeInstant ?? (wcsLinked ? masterInstant : null)
  const showWcsMasterSlider = wcsLinked && masterTimeline.length > 1
  const wcsActiveCount =
    (windEnabled ? 1 : 0) + (tropoEnabled ? 1 : 0) + (qvacisEnabled ? 1 : 0)

  const candidates: Family[] = useMemo(() => {
    if (!data) return []
    // On veut que la famille soit dans la liste des points connus ET
    // qu'elle dispose d'une version interrogeable (latest non vide).
    return data.wfs.families.filter(
      (f) => MAPPABLE_FAMILIES.has(f.name) && Boolean(f.latest),
    )
  }, [data])

  // Map family.name → family.latest (le typeName WFS réel à interroger).
  const typeNameOf = useMemo(() => {
    const m: Record<string, string> = {}
    for (const f of candidates) {
      if (f.latest) m[f.name] = f.latest
    }
    return m
  }, [candidates])

  useEffect(() => {
    // Produits plats MetGate (format `id`+`tac`) enrichissant les flux IWXXM.
    // Chargés en arrière-plan pour ne pas retarder l'affichage du produit principal.
    const FLAT_FALLBACKS: Record<string, string[]> = {
      METAR: ['SA_last'],
      SPECI: ['SP_last'],
      TAF:   ['FT_last', 'FC_last'],
    }

    // Familles dont le produit principal WFS est lui-même un produit plat (champ 'id')
    // et non IWXXM (champ 'locationIndicatorICAO'). Le filtre OGC doit utiliser 'id'.
    const FLAT_MAIN_FAMILIES = new Set(['WL', 'WS', 'WA'])

    // Normalise une feature SA/FT/FC vers le format IWXXM (locationIndicatorICAO).
    // Mappe aussi `pressure` → `qnh_hPa` (MetGate SA_last utilise ce nom de champ).
    const normFlat = (f: GeoJSON.Feature): GeoJSON.Feature => {
      const p = f.properties ?? {}
      const qnh =
        p.qnh_hPa != null
          ? undefined
          : p.pressure != null
            ? { qnh_hPa: Math.round(parseFloat(String(p.pressure))).toString() }
            : undefined
      // `visi` (mètres, float string) → visibility_m pour normalisation avec IWXXM
      const vis = p.visibility_m != null ? undefined : p.visi != null ? { visibility_m: String(p.visi) } : undefined
      // cavok est une string "true"/"false" dans les produits plats
      const cavokNorm = p.cavok != null ? { cavok: p.cavok === true || p.cavok === 'true' } : undefined
      return {
        ...f,
        properties: {
          ...p,
          locationIndicatorICAO: p.id,
          observationTime: p.analysis_time,
          ...qnh,
          ...vis,
          ...cavokNorm,
          _src: 'tac',
        },
      }
    }

    // Tag chaque feature avec sa source (IWXXM) pour pouvoir filtrer/colorer
    // par origine. N'altère pas les autres familles.
    const tagIwxxm = (geo: GeoJSON.FeatureCollection): GeoJSON.FeatureCollection => ({
      ...geo,
      features: (geo.features ?? []).map((f) => ({
        ...f,
        properties: { ...(f.properties ?? {}), _src: 'iwxxm' },
      })),
    })

    active.forEach(async (name) => {
      const typeName = typeNameOf[name]
      // Invalider si le filtre OGC courant diffère de celui utilisé lors du dernier fetch.
      const staleFilter = !!(loaded[name] && loaded[name].filterXml !== ogcFilterXml)
      // Si le filtre a changé : ignorer l'erreur et le cache précédent.
      if (!typeName || loading.has(name)) return
      if (!staleFilter && loaded[name]) return
      if (!staleFilter && errors[name]) return
      setLoading((prev) => new Set(prev).add(name))
      try {
        // 1. Charge et affiche le produit principal (IWXXM) immédiatement.
        // Les familles plates (WL, WS, WA) utilisent 'id' au lieu de 'locationIndicatorICAO'.
        const icaoField = FLAT_MAIN_FAMILIES.has(name) ? 'id' : 'locationIndicatorICAO'
        const filterXmlForFamily = ogcFilterXml
          ? ogcFilterXml.replace(/locationIndicatorICAO/g, icaoField)
          : null
        const filterParam = filterXmlForFamily ? `&filter=${encodeURIComponent(filterXmlForFamily)}` : ''
        const r = await fetch(`/api/feature?type=${encodeURIComponent(typeName)}&count=2000${filterParam}`)
        if (!r.ok) {
          const detail = await r.text()
          throw new Error(`HTTP ${r.status}: ${detail.slice(0, 80)}`)
        }
        const geoRaw = (await r.json()) as GeoJSON.FeatureCollection
        const geo = SOURCE_AWARE_FAMILIES.has(name) ? tagIwxxm(geoRaw) : geoRaw
        const filtered = filterBySlot(geo, selectedSlot, showTrails)
        setLoaded((prev) => ({
          ...prev,
          [name]: { rawData: geo, data: filtered, count: filtered.features.length, total: geo.features?.length ?? 0, filterXml: ogcFilterXml },
        }))

        // 2. Enrichit avec les produits plats en arrière-plan (SA_last, FT_last…).
        //    Ne bloque pas l'affichage initial — ajoute les stations manquantes dès qu'elles arrivent.
        //    Les produits plats utilisent 'id' comme champ ICAO (≠ locationIndicatorICAO des IWXXM).
        //    On génère donc un filtre dédié avec 'id' + guard client-side par sécurité.
        const flatFilterXml = ogcFilterXml
          ? ogcFilterXml.replace(/locationIndicatorICAO/g, 'id')
          : null
        const flatFilterParam = flatFilterXml ? `&filter=${encodeURIComponent(flatFilterXml)}` : ''
        // Pré-compile le pattern ICAO pour le guard client-side (ex: 'ED*' → /^ED.*$/i)
        const icaoRe = ogcFilter?.icaoPattern
          ? new RegExp('^' + ogcFilter.icaoPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i')
          : null
        const flatTypes = FLAT_FALLBACKS[name] ?? []
        for (const flatType of flatTypes) {
          fetch(`/api/feature?type=${flatType}&count=2000${flatFilterParam}`)
            .then((res) => (res.ok ? res.json() : null))
            .then((geoFlat: GeoJSON.FeatureCollection | null) => {
              if (!geoFlat) return
              setLoaded((prev) => {
                const cur = prev[name]
                if (!cur) return prev
                const known = new Set(
                  (cur.rawData.features ?? []).map((f) => f.properties?.locationIndicatorICAO as string),
                )
                const added = (geoFlat.features ?? []).filter((f) => {
                  const id = f.properties?.id as string | undefined
                  if (!id || known.has(id)) return false
                  // Guard client-side : si un pattern ICAO est actif, vérifier que
                  // la station correspond (défense si le filtre WFS ne comprend pas 'id').
                  if (icaoRe && !icaoRe.test(id)) return false
                  return true
                }).map(normFlat)
                if (added.length === 0) return prev
                const merged: GeoJSON.FeatureCollection = {
                  ...cur.rawData,
                  features: [...(cur.rawData.features ?? []), ...added],
                }
                const filteredMerged = filterBySlot(merged, selectedSlot, showTrails)
                return {
                  ...prev,
                  [name]: { rawData: merged, data: filteredMerged, count: filteredMerged.features.length, total: merged.features.length, filterXml: cur.filterXml },
                }
              })
            })
            .catch(() => {})
        }
      } catch (e) {
        setErrors((prev) => ({
          ...prev,
          [name]: e instanceof Error ? e.message : String(e),
        }))
      } finally {
        setLoading((prev) => {
          const next = new Set(prev)
          next.delete(name)
          return next
        })
      }
    })
  }, [active, typeNameOf, ogcFilterXml])

  const toggle = (name: string) => {
    let nowActive = false
    setActive((prev) => {
      const next = new Set(prev)
      if (next.has(name)) {
        next.delete(name)
        nowActive = false
      } else {
        next.add(name)
        nowActive = true
      }
      return next
    })
    // Quand on désactive : on libère la donnée chargée pour que collectSlots
    // / hasTrailableLayer ne voient plus cette couche. Un re-toggle frappera
    // le cache backend (60 s, ~30 ms) sans frais réel.
    if (!nowActive) {
      setLoaded((prev) => {
        if (!(name in prev)) return prev
        const next = { ...prev }
        delete next[name]
        return next
      })
    }
    setErrors((prev) => {
      if (!(name in prev)) return prev
      const next = { ...prev }
      delete next[name]
      return next
    })
  }

  const slots = useMemo(() => collectSlots(loaded, active), [loaded, active])

  // Sélection automatique d'un slot par défaut quand les couches arrivent ou
  // changent. Si le slot courant n'est plus dans la liste, on retombe sur
  // le slot le plus récent passé.
  useEffect(() => {
    if (slots.length === 0) {
      if (selectedSlot !== null) setSelectedSlot(null)
      return
    }
    if (selectedSlot === null || !slots.includes(selectedSlot)) {
      setSelectedSlot(pickDefaultSlot(slots))
    }
  }, [slots, selectedSlot])

  // Re-filter chaque couche quand le slot ou le mode trails change.
  // Toujours produire de nouvelles entrées : même quand le count reste
  // identique (T+0 vs T+15 = 297 features dans les deux cas), le contenu
  // a changé et la carte doit le voir pour re-render la Source.
  useEffect(() => {
    setLoaded((prev) => {
      if (Object.keys(prev).length === 0) return prev
      const next: Record<string, FetchedLayer> = {}
      for (const [name, l] of Object.entries(prev)) {
        const filtered = filterBySlot(l.rawData, selectedSlot, showTrails)
        next[name] = { ...l, data: filtered, count: filtered.features.length }
      }
      return next
    })
  }, [selectedSlot, showTrails])

  // Animation play : avance d'un slot toutes les ~1.4 s.
  useEffect(() => {
    if (!playing || slots.length < 2) return
    const id = window.setInterval(() => {
      setSelectedSlot((prev) => {
        if (prev === null) return slots[0]
        const idx = slots.indexOf(prev)
        return slots[(idx + 1) % slots.length]
      })
    }, 1400)
    return () => window.clearInterval(id)
  }, [playing, slots])

  const showTimeSlider = slots.length > 1
  const trailsAvailable = useMemo(
    () => hasTrailableLayer(loaded, active),
    [loaded, active],
  )

  const interactiveLayerIds = useMemo(() => {
    const ids: string[] = []
    active.forEach((name) => {
      ids.push(`${name}-circle`, `${name}-fill`)
    })
    // Couche foudre : ajoutée impérativement par LightningLayer, on l'inclut
    // dans la sélection pour qu'un clic produise une popup descriptive.
    if (lightningEnabled) {
      ids.push(LIGHTNING_LAYER_DOT, LIGHTNING_LAYER_HALO)
    }
    return ids
  }, [active, lightningEnabled])

  const handleMapClick = (e: MapLayerMouseEvent) => {
    // queryRenderedFeatures ±8px : capture toutes les couches actives
    // (cercles, polygones) même si plusieurs se superposent au même point.
    const px = e.point
    const allFeatures = e.target.queryRenderedFeatures(
      [[ px.x - 8, px.y - 8 ], [ px.x + 8, px.y + 8 ]],
      { layers: interactiveLayerIds },
    ) as GeoJSON.Feature[]

    const seen = new Set<string>()
    const items: PopupItem[] = []
    let lng = e.lngLat.lng
    let lat = e.lngLat.lat

    for (const f of allFeatures) {
      const layerId = (f as unknown as { layer?: { id?: string } }).layer?.id ?? ''
      // Foudre : les deux layer IDs (-halo, -dot) sont mappés à une famille unique.
      let family: string
      if (layerId === LIGHTNING_LAYER_DOT || layerId === LIGHTNING_LAYER_HALO) {
        family = 'Lightning'
      } else {
        family = layerId.replace(/-(circle|fill|line)$/, '')
      }
      const props = (f.properties ?? {}) as Record<string, unknown>
      const key = `${family}::${props.message_id ?? props.gml_id ?? props.ogc_fid ?? props.time ?? JSON.stringify(props).slice(0, 80)}`
      if (seen.has(key)) continue
      seen.add(key)
      items.push({ family, props })
      if (items.length === 1) {
        const geom = f.geometry as GeoJSON.Geometry | undefined
        if (geom?.type === 'Point') {
          ;[lng, lat] = (geom as GeoJSON.Point).coordinates
        }
      }
    }

    // Sondage vent : si la couche est active, on injecte une entrée synthétique
    // décrivant le vent au point cliqué (u,v,vitesse,direction,niveau,step).
    if (windEnabled && windProbeRef.current) {
      const probe = windProbeRef.current(e.lngLat.lng, e.lngLat.lat)
      if (probe) {
        items.push({
          family: probe.dataset === 'JET' ? 'JetStream' : 'Wind',
          props: {
            _kind: 'wind-probe',
            dataset: probe.dataset,
            level_hPa: probe.dataset === 'WIND' ? Math.round(probe.level_pa / 100) : undefined,
            windDirection_deg: probe.dir_deg.toFixed(0),
            windSpeed_kt: probe.speed_kt.toFixed(0),
            speed_ms: probe.speed_ms.toFixed(1),
            u_ms: probe.u_ms.toFixed(2),
            v_ms: probe.v_ms.toFixed(2),
            step_time: probe.step_time,
            lon: e.lngLat.lng.toFixed(3),
            lat: e.lngLat.lat.toFixed(3),
          },
        })
      }
    }

    if (items.length === 0) {
      setPopup(null)
      return
    }

    setPopup({ lng, lat, items, idx: 0 })
  }

  const isLoading = loading.size > 0 || windLoading || tropoLoading || qvacisLoading || cthLoading

  return (
    <div className="relative h-[calc(100vh-72px)] w-full overflow-hidden"
      style={{ cursor: isLoading ? 'wait' : undefined }}>
      <MapGL
        initialViewState={{ longitude: 6, latitude: 47, zoom: 4 }}
        mapStyle={theme === 'light' ? MAP_STYLE_LIGHT : MAP_STYLE_DARK}
        style={{ width: '100%', height: '100%' }}
        attributionControl={{ compact: true }}
        interactiveLayerIds={interactiveLayerIds}
        onClick={handleMapClick}
        cursor={isLoading ? 'wait' : interactiveLayerIds.length > 0 ? 'pointer' : 'grab'}
      >
        <NavigationControl position="bottom-right" />
        <ScaleControl position="bottom-left" />

        {Array.from(active).map((name) => {
          const layer = loaded[name]
          if (!layer) return null
          const s = styleFor(name)
          // Filtrage par source (IWXXM/TAC) pour les familles SOURCE_AWARE.
          // Si l'utilisateur a décoché une source, on l'enlève du rendu sans
          // toucher au cache `rawData`.
          const srcStyle = SOURCE_AWARE_FAMILIES.has(name) ? SOURCE_STYLES[name] : null
          const srcSel = sourceFilter[name]
          const layerData = (srcStyle && srcSel && (!srcSel.iwxxm || !srcSel.tac))
            ? {
                ...layer.data,
                features: layer.data.features.filter((f) => {
                  const src = (f.properties as Record<string, unknown> | null)?._src
                  if (src === 'tac') return srcSel.tac
                  if (src === 'iwxxm') return srcSel.iwxxm
                  return true
                }),
              }
            : layer.data
          // Expression de couleur cercle dépendant de la source si applicable.
          const circleColorExpr = srcStyle
            ? ['case',
                ['==', ['get', 'status'], 'TEST'],     '#fbbf24',
                ['==', ['get', 'status'], 'EXERCISE'], '#38bdf8',
                ['==', ['get', '_src'], 'tac'],        srcStyle.tac.color,
                srcStyle.iwxxm.color,
              ] as unknown as string
            : ['case',
                ['==', ['get', 'status'], 'TEST'],     '#fbbf24',
                ['==', ['get', 'status'], 'EXERCISE'], '#38bdf8',
                s.color,
              ] as unknown as string
          const glowColorExpr = srcStyle
            ? ['case',
                ['==', ['get', '_src'], 'tac'], srcStyle.tac.glow,
                srcStyle.iwxxm.glow,
              ] as unknown as string
            : (s.glow as unknown as string)
          // Mode trails : on lit directement les properties précalculées
          // (_fillOp, _lineOp, _lineW) injectées par decorateTrailFeature.
          const fillOpacity = showTrails ? (['get', '_fillOp'] as unknown as number) : 0.18
          const lineOpacity = showTrails ? (['get', '_lineOp'] as unknown as number) : 0.85
          const lineWidth = showTrails ? (['get', '_lineW'] as unknown as number) : 1.5

          const extrudable = extrude3D && EXTRUDABLE_FAMILIES.has(name)
          return (
            <Source key={name} id={`src-${name}`} type="geojson" data={layerData}>
              {/* Polygones / multipolygones : remplissage + bordure.
                  Les features TEST/EXERCISE reçoivent une couleur distincte. */}
              <Layer
                id={`${name}-fill`}
                type="fill"
                filter={['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]]}
                paint={{
                  'fill-color': ['case',
                    ['==', ['get', 'status'], 'TEST'],     '#fbbf24',
                    ['==', ['get', 'status'], 'EXERCISE'], '#38bdf8',
                    s.color,
                  ] as unknown as string,
                  // En mode 3D, on garde le fill 2D très atténué (1/3 de l'opacité)
                  // pour repérer l'emprise au sol sous le volume extrudé.
                  'fill-opacity': extrudable
                    ? (typeof fillOpacity === 'number' ? fillOpacity / 3 : 0.06)
                    : fillOpacity,
                }}
              />
              {extrudable && (
                <Layer
                  id={`${name}-extrusion`}
                  type="fill-extrusion"
                  filter={['all',
                    ['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]],
                    ['has', '_top_m'],
                  ] as unknown as never}
                  paint={{
                    'fill-extrusion-color': ['case',
                      ['==', ['get', 'status'], 'TEST'],     '#fbbf24',
                      ['==', ['get', 'status'], 'EXERCISE'], '#38bdf8',
                      s.color,
                    ] as unknown as string,
                    'fill-extrusion-base': ['get', '_base_m'] as unknown as number,
                    'fill-extrusion-height': ['get', '_top_m'] as unknown as number,
                    'fill-extrusion-opacity': 0.55,
                  }}
                />
              )}
              <Layer
                id={`${name}-line`}
                type="line"
                filter={['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]]}
                paint={{
                  'line-color': ['case',
                    ['==', ['get', 'status'], 'TEST'],     '#fbbf24',
                    ['==', ['get', 'status'], 'EXERCISE'], '#38bdf8',
                    s.color,
                  ] as unknown as string,
                  'line-width': lineWidth,
                  'line-opacity': lineOpacity,
                  'line-dasharray': ['case',
                    ['any',
                      ['==', ['get', 'status'], 'TEST'],
                      ['==', ['get', 'status'], 'EXERCISE'],
                    ], ['literal', [6, 3]],
                    ['literal', [1]],
                  ] as unknown as number[],
                }}
              />
              {/* Points : halo + cercle */}
              <Layer
                id={`${name}-glow`}
                type="circle"
                filter={['==', ['geometry-type'], 'Point']}
                paint={{
                  'circle-radius': 12,
                  'circle-color': glowColorExpr,
                  'circle-opacity': 0.15,
                  'circle-blur': 0.7,
                }}
              />
              <Layer
                id={`${name}-circle`}
                type="circle"
                filter={['==', ['geometry-type'], 'Point']}
                paint={{
                  'circle-radius': 4.5,
                  'circle-color': circleColorExpr,
                  'circle-stroke-color': '#0f172a',
                  'circle-stroke-width': 1.5,
                  'circle-opacity': 0.95,
                }}
              />
            </Source>
          )
        })}

        <WindLayer
          enabled={windEnabled}
          dataset={windDataset}
          level={windLevelPa}
          linkedInstant={linkedInstantForLayers}
          onTimesLoaded={setWindTimes}
          onLoadingChange={setWindLoading}
          probeRef={windProbeRef}
        />
        <TropoLayer
          enabled={tropoEnabled}
          linkedInstant={linkedInstantForLayers}
          onTimesLoaded={setTropoTimes}
          onLoadingChange={setTropoLoading}
        />
        <QvacisLayer
          enabled={qvacisEnabled}
          dataset={qvacisDataset}
          fl={qvacisFL}
          linkedInstant={linkedInstantForLayers}
          onTimesLoaded={setQvacisTimes}
          onLoadingChange={setQvacisLoading}
        />
        <FirLayer enabled={firEnabled} />
        <CountriesLayer enabled={countriesEnabled} language={mapLanguage} />
        <BasemapLanguage language={mapLanguage} />
        <Pitch3D enabled={extrude3D} />
        <RadarLayer
          enabled={radarEnabled}
          linkedInstant={masterInstant}
        />
        <LightningLayer enabled={lightningEnabled} />
        <AirportAlertsLayer enabled={alertsEnabled} />
        <SatRasterLayer
          enabled={satIREnabled}
          id="ir105"
          wmsLayer="mtg_fd:ir105_hrfi"
          wmsStyle="mtg_fd:mtg_fd_ir105_hrfi_grayscale"
          opacity={0.65}
        />
        <SatRasterLayer
          enabled={satCTHEnabled}
          id="cth"
          wmsLayer="msg_fes:cth"
          wmsStyle="msg_cth"
          opacity={0.6}
        />
        <SatRasterLayer
          enabled={satConvEnabled}
          id="conv"
          wmsLayer="msg_fes:rgb_convection"
          opacity={0.7}
        />
        <CloudTopLayer
          enabled={cthEnabled}
          minFL={cthMinFL}
          onMinFLChange={setCthMinFL}
          opacity={0.65}
          onLoadingChange={setCthLoading}
        />

        <FlightPlan
          plan={routePlan}
          onPlan={isLivePlan ? () => {} : setManualPlan}
          cursorIdx={routePlan ? routeCursor : -1}
          playing={routePlaying}
          onTogglePlay={() => setRoutePlaying((p) => !p)}
          onCursorChange={(i) => {
            setRouteCursor(i)
            setRoutePlaying(false)
          }}
          onClose={() => setShowFlightPlan(false)}
          visible={showFlightPlan}
        />

        <AircraftTracker
          selected={trackedAircraft}
          onSelect={setTrackedAircraft}
          onLivePlan={setLivePlan}
          onClose={() => setShowTracker(false)}
          visible={showTracker}
        />

        {popup && (() => {
          // Détecte si tous les items partagent le même ICAO → vue aéroport groupée.
          const icaos = popup.items.map(it =>
            (it.props.locationIndicatorICAO ?? it.props.id ?? '') as string
          )
          const sameAirport = icaos.length > 1 && icaos.every(c => c !== '' && c === icaos[0])
          return (
            <Popup
              longitude={popup.lng}
              latitude={popup.lat}
              offset={14}
              closeOnClick={false}
              closeButton={false}
              onClose={() => setPopup(null)}
              maxWidth="420px"
              className="metgate-popup"
            >
              <DraggableShell>
                {sameAirport ? (
                  <AirportPopup
                    icao={icaos[0]}
                    items={popup.items}
                    onClose={() => setPopup(null)}
                  />
                ) : (
                  <FeaturePopup
                    family={popup.items[popup.idx].family}
                    props={popup.items[popup.idx].props}
                    total={popup.items.length}
                    current={popup.idx + 1}
                    onPrev={popup.items.length > 1 ? () => setPopup(p => p ? { ...p, idx: (p.idx - 1 + p.items.length) % p.items.length } : null) : undefined}
                    onNext={popup.items.length > 1 ? () => setPopup(p => p ? { ...p, idx: (p.idx + 1) % p.items.length } : null) : undefined}
                    onClose={() => setPopup(null)}
                  />
                )}
              </DraggableShell>
            </Popup>
          )
        })()}

        {ogcPanelOpen && (
          <OGCFilterPanel
            onFilterChange={(xml, filter) => { setOgcFilterXml(xml); setOgcFilter(filter) }}
            onClose={() => setOgcPanelOpen(false)}
          />
        )}

        {configOpen && (
          <ConfigPanel
            language={mapLanguage}
            onLanguageChange={setMapLanguage}
            onClose={() => setConfigOpen(false)}
          />
        )}
      </MapGL>

      {/* Boutons flip-flop Plan de vol / Suivi avion — hors MapGL pour éviter l'overflow du canvas */}
      {!showFlightPlan && (
        <button
          onClick={() => setShowFlightPlan(true)}
          className="absolute top-4 left-[19rem] z-20 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-950/90 border border-emerald-400/40 text-emerald-300 text-xs font-medium backdrop-blur-md shadow-lg hover:bg-slate-900 transition"
        >
          <Plane className="size-3.5" />
          Plan de vol
        </button>
      )}
      {!showTracker && (
        <button
          onClick={() => setShowTracker(true)}
          className="absolute bottom-4 left-[19rem] z-20 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-950/90 border border-rose-400/30 text-rose-300 text-xs font-medium backdrop-blur-md shadow-lg hover:bg-slate-900 transition"
        >
          <Radio className="size-3.5" />
          Suivi avion
        </button>
      )}

      <Sidebar
        open={sidebarOpen}
        onToggle={() => setSidebarOpen((v) => !v)}
        candidates={candidates}
        active={active}
        loading={loading}
        loaded={loaded}
        errors={errors}
        onToggleLayer={toggle}
        sourceFilter={sourceFilter}
        onToggleSource={(family, src) => setSourceFilter((prev) => {
          const cur = prev[family] ?? { iwxxm: true, tac: true }
          const next = { ...cur, [src]: !cur[src] }
          // Ne pas autoriser à désactiver les deux : conserve au moins une source.
          if (!next.iwxxm && !next.tac) return prev
          return { ...prev, [family]: next }
        })}
        additionalLayers={[
          {
            key: 'wind', label: 'Vent', icon: WindIcon, color: '#22d3ee',
            enabled: windEnabled, onToggle: () => setWindEnabled(v => !v),
            title: 'Particules de vent (WCS WIND/JET)',
            extras: (
              <WindLevelSelector
                dataset={windDataset}
                value={windLevelPa}
                onSelect={(d, lvl) => { setWindDataset(d); if (d === 'WIND') setWindLevelPa(lvl) }}
              />
            ),
          },
          {
            key: 'tropo', label: 'Tropopause', icon: Mountain, color: '#fbbf24',
            enabled: tropoEnabled, onToggle: () => setTropoEnabled(v => !v),
            title: 'Altitude de la tropopause (raster colorisé)',
          },
          {
            key: 'qvacis', label: 'Cendres', icon: CloudFog, color: '#fb923c',
            enabled: qvacisEnabled, onToggle: () => setQvacisEnabled(v => !v),
            title: 'Concentration de cendres volcaniques (WCS QVACIS — VAAC Toulouse)',
            extras: (
              <QvacisSelector
                dataset={qvacisDataset}
                fl={qvacisFL}
                onDataset={setQvacisDataset}
                onFL={setQvacisFL}
              />
            ),
          },
          {
            key: 'radar', label: 'Radar OPERA', icon: Radar, color: '#4ade80',
            enabled: radarEnabled, onToggle: () => setRadarEnabled(v => !v),
            title: 'Mosaïque radar OPERA — RainViewer (situationnel, non OPMET)',
          },
          {
            key: 'lightning', label: 'Foudre', icon: Zap, color: '#facc15',
            enabled: lightningEnabled, onToggle: () => setLightningEnabled(v => !v),
            title: 'Impacts foudre — EUMETSAT MTG-LI',
          },
          {
            key: 'alerts', label: 'Alertes AD', icon: AlertTriangle, color: '#ef4444',
            enabled: alertsEnabled, onToggle: () => setAlertsEnabled(v => !v),
            title: 'Alertes aérodromes — SPECI, MAA, RDT',
          },
          {
            key: 'satIR', label: 'Sat IR', icon: Satellite, color: '#7dd3fc',
            enabled: satIREnabled, onToggle: () => setSatIREnabled(v => !v),
            title: 'Imagerie satellite IR 10.5 µm — EUMETSAT MTG-FCI',
          },
          {
            key: 'cth', label: 'CTH', icon: CloudCog, color: '#c084fc',
            enabled: cthEnabled, onToggle: () => setCthEnabled(v => !v),
            title: 'Cloud Top Height — EUMETSAT MTG-FCI CTTH',
          },
          {
            key: 'satConv', label: 'Convection', icon: CloudLightning, color: '#f472b6',
            enabled: satConvEnabled, onToggle: () => setSatConvEnabled(v => !v),
            title: 'Convection RGB — EUMETSAT MSG',
          },
          {
            key: 'fir', label: 'FIR / UIR', icon: Globe2, color: '#818cf8',
            enabled: firEnabled, onToggle: () => setFirEnabled(v => !v),
            title: 'Limites des FIR/UIR mondiales',
          },
          {
            key: 'countries', label: 'Pays', icon: Landmark, color: '#fde047',
            enabled: countriesEnabled, onToggle: () => setCountriesEnabled(v => !v),
            title: 'Contours pays (Natural Earth 50m, multilingue)',
          },
          {
            key: '3d', label: '3D (FL)', icon: Box, color: '#a78bfa',
            enabled: extrude3D, onToggle: () => setExtrude3D(v => !v),
            title: 'Affichage 3D : pitch 45° + extrusion verticale RDT / CAT / Givrage / SIGMET / AIRMET basée sur leurs FL',
          },
        ]}
      />

      {/* Actions (Config / Filtre OGC / Lien WCS) en haut à droite */}
      <div className="absolute top-4 right-4 z-10 flex flex-col items-end gap-2">
        <div className="flex gap-2">
          {wcsActiveCount >= 2 && (
            <button
              onClick={() => setWcsLinked((v) => !v)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg border backdrop-blur-md text-sm transition shadow-xl ${
                wcsLinked
                  ? 'border-violet-400/50 bg-violet-500/20 text-violet-100 shadow-[0_0_15px_rgba(167,139,250,0.25)]'
                  : 'border-slate-800 bg-slate-950/80 text-slate-300 hover:bg-slate-900/80'
              }`}
              title="Lier les sliders temporels des couches WCS actives"
            >
              {wcsLinked ? <Link2 className="size-4" /> : <Link2Off className="size-4" />}
              {wcsLinked ? 'Liés' : 'Lier'}
            </button>
          )}
          <button
            onClick={() => setConfigOpen((v) => !v)}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg border backdrop-blur-md text-sm transition shadow-xl ${
              configOpen
                ? 'border-slate-400/50 bg-slate-500/20 text-slate-100'
                : 'border-slate-800 bg-slate-950/80 text-slate-300 hover:bg-slate-900/80'
            }`}
            title="Configuration"
          >
            <Settings className="size-4" />
            Config
          </button>
          <button
            onClick={() => setOgcPanelOpen((v) => !v)}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg border backdrop-blur-md text-sm transition shadow-xl ${
              ogcFilterXml
                ? 'border-indigo-400/50 bg-indigo-500/20 text-indigo-100 shadow-[0_0_15px_rgba(99,102,241,0.25)]'
                : ogcPanelOpen
                  ? 'border-indigo-800/60 bg-indigo-900/30 text-indigo-300'
                  : 'border-slate-800 bg-slate-950/80 text-slate-300 hover:bg-slate-900/80'
            }`}
            title="Filtre OGC sur les flux OPMET"
          >
            <Filter className="size-4" />
            Filtre
            {ogcFilterXml && <span className="size-1.5 rounded-full bg-indigo-400 ml-0.5" />}
          </button>
        </div>
      </div>

      {showWcsMasterSlider && masterInstant && (
        <WcsMasterSlider
          timeline={masterTimeline}
          instant={masterInstant}
          onChange={(v) => {
            setMasterInstant(v)
            setMasterPlaying(false)
          }}
          playing={masterPlaying}
          onTogglePlay={() => setMasterPlaying((p) => !p)}
        />
      )}

      {showTimeSlider && selectedSlot && (
        <TimeSlider
          slots={slots}
          selected={selectedSlot}
          onChange={(v) => {
            setSelectedSlot(v)
            setPlaying(false)
          }}
          playing={playing}
          onTogglePlay={() => setPlaying((p) => !p)}
          trailsAvailable={trailsAvailable}
          showTrails={showTrails}
          onToggleTrails={() => setShowTrails((v) => !v)}
        />
      )}

      <Legend
        active={active}
        loaded={loaded}
        windEnabled={windEnabled}
        windDataset={windDataset}
        windLevelPa={windLevelPa}
        tropoEnabled={tropoEnabled}
        qvacisEnabled={qvacisEnabled}
        qvacisDataset={qvacisDataset}
        qvacisFL={qvacisFL}
        radarEnabled={radarEnabled}
        lightningEnabled={lightningEnabled}
        alertsEnabled={alertsEnabled}
        satIREnabled={satIREnabled}
        satConvEnabled={satConvEnabled}
        cthEnabled={cthEnabled}
        cthMinFL={cthMinFL}
        firEnabled={firEnabled}
        countriesEnabled={countriesEnabled}
        ogcFilterXml={ogcFilterXml}
        ogcFilter={ogcFilter}
      />
    </div>
  )
}

interface TimeSliderProps {
  slots: string[]
  selected: string
  onChange: (v: string) => void
  playing: boolean
  onTogglePlay: () => void
  trailsAvailable: boolean
  showTrails: boolean
  onToggleTrails: () => void
}

function TimeSlider({
  slots,
  selected,
  onChange,
  playing,
  onTogglePlay,
  trailsAvailable,
  showTrails,
  onToggleTrails,
}: TimeSliderProps) {
  const idx = slots.indexOf(selected)
  const total = slots.length
  // Indique quels slots changent de jour par rapport au précédent (pour
  // afficher la date secondaire sur ces slots-là).
  const showDateOn = useMemo(() => {
    const set = new Set<number>()
    for (let i = 0; i < slots.length; i++) {
      if (i === 0) {
        set.add(i)
        continue
      }
      const prev = slots[i - 1].slice(0, 10)
      const cur = slots[i].slice(0, 10)
      if (prev !== cur) set.add(i)
    }
    return set
  }, [slots])

  const label = (() => {
    const m = selected.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/)
    if (!m) return selected
    const date = m[1]
    const time = `${m[2]}:${m[3]}`
    const now = new Date()
    const cur = new Date(selected)
    if (cur.getTime() <= now.getTime() + 60_000 && cur.getTime() >= now.getTime() - 6 * 3600_000) {
      return `Now · ${time} UTC`
    }
    return `${date} ${time} UTC`
  })()

  return (
    <DraggableWindow
      centered
      storageKey="metgate.timeSlider.pos"
      className="absolute bottom-6 left-1/2 z-10 flex items-center gap-3 rounded-xl border border-slate-800/70 bg-slate-950/85 backdrop-blur-md px-3 py-2 shadow-2xl max-w-[90vw]"
    >
      <button
        onClick={onTogglePlay}
        disabled={total < 2}
        className="size-8 rounded-lg bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/30 flex items-center justify-center transition disabled:opacity-40"
        aria-label={playing ? 'Pause' : 'Play'}
      >
        {playing ? (
          <Pause className="size-4 text-sky-300" />
        ) : (
          <Play className="size-4 text-sky-300 translate-x-[1px]" />
        )}
      </button>

      {trailsAvailable && (
        <button
          onClick={onToggleTrails}
          className={`size-8 rounded-lg border flex items-center justify-center transition ${
            showTrails
              ? 'bg-pink-500/25 border-pink-400/50 shadow-[0_0_10px_rgba(244,114,182,0.3)]'
              : 'bg-slate-900/60 border-slate-800/60 hover:bg-slate-800/60'
          }`}
          title="Afficher la trajectoire prévisionnelle (T+0 → T+60)"
          aria-label="Toggle trails"
        >
          <Sparkles
            className={`size-4 ${showTrails ? 'text-pink-200' : 'text-slate-400'}`}
          />
        </button>
      )}

      <div className="flex flex-col gap-1.5 min-w-0">
        <div className="flex items-center gap-1.5 text-[0.6875rem] text-slate-300">
          <Clock className="size-3 text-slate-500" />
          <span className="font-medium tabular-nums">{label}</span>
          <span className="text-slate-600">·</span>
          <span className="text-slate-500 tabular-nums">
            {idx + 1}/{total}
          </span>
        </div>
        <div className="flex gap-1 overflow-x-auto pr-1">
          {slots.map((s, i) => {
            const active = s === selected
            const lab = fmtSlotLabel(s, !showDateOn.has(i))
            return (
              <button
                key={s}
                onClick={() => onChange(s)}
                className={`shrink-0 min-w-12 h-9 px-2 rounded-md text-[0.6875rem] font-mono tabular-nums transition border flex flex-col items-center justify-center leading-tight ${
                  active
                    ? 'bg-sky-500/25 text-sky-100 border-sky-400/50 shadow-[0_0_10px_rgba(56,189,248,0.25)]'
                    : 'bg-slate-900/60 text-slate-400 border-slate-800/60 hover:bg-slate-800/60 hover:text-slate-200'
                }`}
                title={s}
              >
                <span>{lab.primary}</span>
                {lab.secondary && (
                  <span className="text-[0.5625rem] opacity-60">{lab.secondary.slice(5)}</span>
                )}
              </button>
            )
          })}
        </div>
      </div>
    </DraggableWindow>
  )
}

// Champs verbeux à exclure de l'affichage générique (UUIDs, ids techniques
// MetGate, attributs déjà rendus en haut de la popup, etc.).
const POPUP_EXCLUDE_KEYS = new Set([
  'locationIndicatorICAO',
  'observationTime',
  'tac',
  'status',
  'cavok',
  'message_id',
  'gml_id',
  'ogc_fid',
  'swpid',
  'opmet_msg',
  // Doublons SA_last/FT_last (déjà mappés vers les champs structurés standard)
  'pressure',
  'wind_dir',
  'wind_speed',
  'dewpoint',
  'temperature',
  'visi',
  'id',
  'analysis_time',
])

function fmtKey(k: string): string {
  // analysistime → Analysis time, validitystarttime → Validity start time
  return k
    .replace(/_uom$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/(time|date)\b/gi, ' $1')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase())
}

function fmtVal(v: unknown, key: string, props: Record<string, unknown>): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  let s = String(v)
  // ISO date → YYYY-MM-DD HH:mm UTC
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):/)
  if (m) s = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]} UTC`
  // Apparier <key>_uom si présent (movingspeed → m/s)
  const uom = props[`${key}_uom`]
  if (typeof uom === 'string' && uom !== '') s += ' ' + uom
  return s
}

function FeaturePopup({
  family,
  props,
  total = 1,
  current = 1,
  onPrev,
  onNext,
  onClose,
}: {
  family: string
  props: Record<string, unknown>
  total?: number
  current?: number
  onPrev?: () => void
  onNext?: () => void
  onClose: () => void
}) {
  const icao = props.locationIndicatorICAO as string | undefined
  const obsTime = props.observationTime as string | undefined
  const tac = props.tac as string | undefined
  const decoded = props.decoded as string | undefined
  const status = props.status as string | undefined
  const cavok = props.cavok === true || props.cavok === 'true'

  const headerTitle = icao ?? (props.trackingid as string | undefined) ?? family.replace(/_last$/, '')
  const headerTime =
    obsTime ?? (props.timeposition as string | undefined) ?? (props.analysistime as string | undefined)

  const metarFields: Array<[string, string]> = []
  const pushMetar = (label: string, key: string, suffix = '') => {
    const v = props[key]
    if (typeof v === 'string' && v !== '') metarFields.push([label, v + suffix])
  }
  pushMetar('T', 'airTemperature_C', '°C')
  pushMetar('Td', 'dewpointTemperature_C', '°C')
  pushMetar('QNH', 'qnh_hPa', ' hPa')
  pushMetar('Wind dir', 'windDirection_deg', '°')
  pushMetar('Wind speed', 'windSpeed_kt', ' kt')

  // Visibilité : CAVOK ou valeur en mètres → texte lisible
  const visiRaw = props.visibility_m as string | undefined
  const visiText = (() => {
    if (cavok) return '≥ 10 km (CAVOK)'
    if (!visiRaw) return undefined
    const n = parseFloat(visiRaw)
    if (isNaN(n)) return visiRaw
    if (n >= 9999) return '≥ 10 km'
    if (n >= 1000) return `${+(n / 1000).toFixed(1)} km`
    return `${Math.round(n)} m`
  })()
  if (visiText) metarFields.push(['Visi', visiText])

  const cloudsDecoded = props.clouds as string | undefined
  if (cloudsDecoded) metarFields.push(['Nuages', cloudsDecoded])

  // Toutes les autres props scalaires non exclues, hors champs *_uom
  // (déjà concaténés à leur valeur principale).
  const otherFields: Array<[string, string]> = []
  for (const [k, v] of Object.entries(props)) {
    if (POPUP_EXCLUDE_KEYS.has(k)) continue
    if (k.endsWith('_uom')) continue
    if (k.startsWith('airTemperature') || k.startsWith('dewpointTemperature')) continue
    if (k.startsWith('qnh') || k.startsWith('windDirection') || k.startsWith('windSpeed')) continue
    if (k.startsWith('visibility')) continue
    if (k === 'clouds' || k === 'cloud') continue
    if (typeof v === 'object') continue
    const s = fmtVal(v, k, props)
    if (s !== '') otherFields.push([fmtKey(k), s])
  }

  const s = styleFor(family)

  return (
    <div className="font-sans">
      {/* Navigation multi-features (ex: plusieurs SIGMET superposés) */}
      {total > 1 && (
        <div className="flex items-center justify-between gap-2 mb-1.5 px-0.5">
          <button
            onClick={onPrev}
            className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-100 transition"
            aria-label="Précédent"
          >
            ‹
          </button>
          <span className="text-[0.625rem] text-slate-400 tabular-nums">
            {current} / {total}
          </span>
          <button
            onClick={onNext}
            className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-100 transition"
            aria-label="Suivant"
          >
            ›
          </button>
        </div>
      )}
      {/* Bannière TEST / EXERCISE bien visible */}
      {status && status !== 'NORMAL' && (
        <div className={`flex items-center gap-2 px-2 py-1 rounded-md mb-2 text-xs font-bold tracking-widest uppercase ${
          status === 'TEST'
            ? 'bg-amber-500/20 border border-amber-400/60 text-amber-300'
            : status === 'EXERCISE'
              ? 'bg-sky-500/20 border border-sky-400/60 text-sky-300'
              : 'bg-red-500/20 border border-red-400/60 text-red-300'
        }`}>
          <span className="size-2 rounded-full animate-pulse"
            style={{ backgroundColor: status === 'TEST' ? '#fbbf24' : status === 'EXERCISE' ? '#38bdf8' : '#f87171' }}
          />
          ⚠ {status} — message non opérationnel
        </div>
      )}
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div
            className="text-base font-semibold tracking-tight truncate"
            style={{ color: s.color }}
            title={headerTitle}
          >
            {headerTitle}
          </div>
          <div className="text-[0.625rem] uppercase tracking-wider text-slate-400 truncate">
            {family.replace(/_last$/, '')}
            {headerTime && ' · ' + fmtVal(headerTime, '_t', props)}
          </div>
        </div>
        <button
          onClick={onClose}
          className="text-slate-500 hover:text-slate-200 transition shrink-0"
          aria-label="Fermer"
        >
          <X className="size-4" />
        </button>
      </div>

      {tac && (
        <pre className="text-[0.6875rem] font-mono text-slate-200 bg-slate-950/60 border border-slate-800/60 rounded-md p-2 whitespace-pre-wrap break-words">
          {tac}
        </pre>
      )}

      {decoded && (
        <div className="mt-2 text-[0.6875rem] text-slate-200 bg-slate-950/40 border border-slate-800/50 rounded-md p-2 whitespace-pre-wrap leading-relaxed">
          <div className="text-[0.5625rem] uppercase tracking-wider text-slate-500 mb-1">Traduction</div>
          {decoded}
        </div>
      )}

      {metarFields.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 mt-2 text-[0.6875rem]">
          {metarFields.map(([k, v]) => (
            <div key={k} className="flex justify-between">
              <dt className="text-slate-500">{k}</dt>
              <dd className="text-slate-200 font-mono">{v}</dd>
            </div>
          ))}
        </dl>
      )}

      {otherFields.length > 0 && (
        <dl className="mt-2 text-[0.625rem] max-h-56 overflow-y-auto pr-1">
          {otherFields.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 py-0.5 border-b border-slate-800/40 last:border-0">
              <dt className="text-slate-500 shrink-0">{k}</dt>
              <dd className="text-slate-200 font-mono text-right truncate" title={v}>
                {v}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <div className="mt-2 flex items-center gap-2 text-[0.625rem] text-slate-500">
        {cavok && (
          <span className="px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-300 border border-emerald-800/60">
            CAVOK
          </span>
        )}
        {status && status !== 'NORMAL' && (
          <span className="px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-300 border border-amber-800/60">
            {status}
          </span>
        )}
      </div>
    </div>
  )
}

// ─── Vue aéroport groupée ─────────────────────────────────────────────────────
// Affichée quand plusieurs couches (METAR, TAF, WL…) partagent le même ICAO.

function AirportPopup({ icao, items, onClose }: { icao: string; items: PopupItem[]; onClose: () => void }) {
  const [openIdx, setOpenIdx] = useState<number | null>(0)

  return (
    <div className="font-sans min-w-[280px]">
      {/* En-tête aéroport */}
      <div className="flex items-center justify-between gap-3 mb-2">
        <div>
          <div className="text-base font-semibold tracking-tight text-sky-300">{icao}</div>
          <div className="text-[0.625rem] uppercase tracking-wider text-slate-400">
            {items.map(it => it.family.replace(/_last$/, '')).join(' · ')}
          </div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 transition shrink-0">
          <X className="size-4" />
        </button>
      </div>

      {/* Sections accordéon par couche */}
      <div className="flex flex-col gap-1">
        {items.map((item, i) => {
          const s = styleFor(item.family)
          const label = item.family.replace(/_last$/, '')
          const isOpen = openIdx === i
          return (
            <div key={i} className="rounded-md border border-slate-800/60 overflow-hidden">
              <button
                onClick={() => setOpenIdx(isOpen ? null : i)}
                className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-slate-800/40 transition"
              >
                <span className="size-2 rounded-full shrink-0" style={{ backgroundColor: s.color, boxShadow: `0 0 6px ${s.color}88` }} />
                <span className="text-[0.6875rem] font-medium flex-1" style={{ color: s.color }}>{label}</span>
                <span className="text-slate-600 text-[0.625rem]">{isOpen ? '▲' : '▼'}</span>
              </button>
              {isOpen && (
                <div className="px-2 pb-2 border-t border-slate-800/40">
                  <FeaturePopupBody props={item.props} family={item.family} />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Corps réutilisable de FeaturePopup (sans header ni bouton fermer)
function FeaturePopupBody({ props }: { props: Record<string, unknown>; family: string }) {
  const tac = props.tac as string | undefined
  const decoded = props.decoded as string | undefined
  const cavok = props.cavok === true || props.cavok === 'true'
  const status = props.status as string | undefined

  const metarFields: Array<[string, string]> = []
  const push = (label: string, key: string, suffix = '') => {
    const v = props[key]
    if (typeof v === 'string' && v !== '') metarFields.push([label, v + suffix])
  }
  push('T', 'airTemperature_C', '°C')
  push('Td', 'dewpointTemperature_C', '°C')
  push('QNH', 'qnh_hPa', ' hPa')
  push('Wind dir', 'windDirection_deg', '°')
  push('Wind speed', 'windSpeed_kt', ' kt')

  const visiRaw = props.visibility_m as string | undefined
  const visiText = (() => {
    if (cavok) return '≥ 10 km (CAVOK)'
    if (!visiRaw) return undefined
    const n = parseFloat(visiRaw)
    if (isNaN(n)) return visiRaw
    if (n >= 9999) return '≥ 10 km'
    if (n >= 1000) return `${+(n / 1000).toFixed(1)} km`
    return `${Math.round(n)} m`
  })()
  if (visiText) metarFields.push(['Visi', visiText])
  const cloudsDecoded = props.clouds as string | undefined
  if (cloudsDecoded) metarFields.push(['Nuages', cloudsDecoded])

  return (
    <div className="mt-1.5 text-[0.6875rem]">
      {status && status !== 'NORMAL' && (
        <div className={`flex items-center gap-1.5 px-1.5 py-1 rounded mb-1.5 text-[0.625rem] font-bold uppercase ${
          status === 'TEST' ? 'bg-amber-500/20 text-amber-300' : 'bg-sky-500/20 text-sky-300'
        }`}>
          ⚠ {status}
        </div>
      )}
      {tac && (
        <pre className="font-mono text-slate-200 bg-slate-950/60 border border-slate-800/40 rounded p-1.5 whitespace-pre-wrap break-words text-[0.625rem] mb-1">
          {tac}
        </pre>
      )}
      {decoded && !tac && (
        <div className="text-slate-300 bg-slate-950/40 border border-slate-800/30 rounded p-1.5 whitespace-pre-wrap leading-relaxed text-[0.625rem] mb-1">
          {decoded}
        </div>
      )}
      {metarFields.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 mt-1">
          {metarFields.map(([k, v]) => (
            <div key={k} className="flex justify-between">
              <dt className="text-slate-500">{k}</dt>
              <dd className="text-slate-200 font-mono">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {cavok && (
        <span className="inline-block mt-1 px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-300 border border-emerald-800/60 text-[0.5625rem]">CAVOK</span>
      )}
    </div>
  )
}

interface LayerToggleDef {
  key: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  enabled: boolean
  onToggle: () => void
  color: string
  title?: string
  extras?: React.ReactNode
}

interface SidebarProps {
  open: boolean
  onToggle: () => void
  candidates: Family[]
  active: Set<string>
  loading: Set<string>
  loaded: Record<string, FetchedLayer>
  errors: Record<string, string>
  onToggleLayer: (name: string) => void
  sourceFilter: Record<string, { iwxxm: boolean; tac: boolean }>
  onToggleSource: (family: string, src: 'iwxxm' | 'tac') => void
  additionalLayers: LayerToggleDef[]
}

function Sidebar({
  open,
  onToggle,
  candidates,
  active,
  loading,
  loaded,
  errors,
  onToggleLayer,
  sourceFilter,
  onToggleSource,
  additionalLayers,
}: SidebarProps) {
  if (!open) {
    return (
      <button
        onClick={onToggle}
        className="absolute top-4 left-4 z-10 flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-800 bg-slate-950/80 hover:bg-slate-900/80 backdrop-blur-md text-sm shadow-xl"
      >
        <LayersIcon className="size-4" />
        Couches ({active.size})
      </button>
    )
  }

  return (
    <div className="absolute top-4 left-4 bottom-4 w-72 z-10 flex flex-col rounded-xl border border-slate-800/70 bg-slate-950/80 backdrop-blur-md shadow-2xl">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800/70">
        <div className="flex items-center gap-2">
          <LayersIcon className="size-4 text-slate-400" />
          <div className="text-sm font-medium">Couches météo</div>
        </div>
        <button
          onClick={onToggle}
          className="text-slate-500 hover:text-slate-200 transition"
          aria-label="Fermer"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="overflow-y-auto flex-1 p-2">
        {candidates.length === 0 && (
          <div className="text-xs text-slate-500 p-3">
            Aucune famille point n'a été détectée. Recharge le catalogue depuis l'onglet Catalogue.
          </div>
        )}
        {additionalLayers.length > 0 && (
          <div className="mb-2">
            <div className="px-2 py-1 text-[0.625rem] uppercase tracking-wider text-slate-500">
              Couches météo
            </div>
            <ul className="space-y-1">
              {additionalLayers.map((t) => {
                const Icon = t.icon
                return (
                  <li key={t.key}>
                    <button
                      onClick={t.onToggle}
                      title={t.title}
                      className={`w-full text-left px-3 py-2 rounded-lg border transition flex items-center gap-2 ${
                        t.enabled
                          ? 'border-slate-700 bg-slate-900/80'
                          : 'border-transparent hover:bg-slate-900/40'
                      }`}
                    >
                      <span
                        className="size-2.5 rounded-full shrink-0"
                        style={{
                          backgroundColor: t.color,
                          boxShadow: t.enabled ? `0 0 10px ${t.color}88` : 'none',
                        }}
                      />
                      <Icon className={`size-4 shrink-0 ${t.enabled ? '' : 'text-slate-500'}`} />
                      <span className="text-sm flex-1 truncate">{t.label}</span>
                    </button>
                    {t.enabled && t.extras && (
                      <div className="mt-1 pl-3">{t.extras}</div>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        )}
        {(() => {
          const opmetFams = candidates.filter(f => OPMET_FAMILIES.has(f.name))
          const sitFams = candidates.filter(f => SITUATIONAL_FAMILIES.has(f.name))
          const renderFamilies = (fams: Family[]) => (
            <ul className="space-y-1">
              {fams.map((f) => {
                const isActive = active.has(f.name)
                const isLoading = loading.has(f.name)
                const layer = loaded[f.name]
                const err = errors[f.name]
                const s = styleFor(f.name)
                return (
                  <li key={f.name}>
                    <button
                      onClick={() => onToggleLayer(f.name)}
                      className={`w-full text-left px-3 py-2 rounded-lg border transition ${
                        isActive
                          ? 'border-slate-700 bg-slate-900/80'
                          : 'border-transparent hover:bg-slate-900/40'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className="size-2.5 rounded-full shrink-0"
                          style={{
                            backgroundColor: s.color,
                            boxShadow: isActive ? `0 0 10px ${s.glow}` : 'none',
                          }}
                        />
                        <span className="text-sm flex-1 truncate" title={f.name}>
                          {displayFamilyName(f.name)}
                        </span>
                        {isLoading && <Loader2 className="size-3 animate-spin text-slate-500" />}
                        {!isLoading && layer && isActive && (
                          <span
                            className="text-[0.6875rem] tabular-nums text-slate-500"
                            title={
                              layer.total !== layer.count
                                ? `${layer.count} affichés (analyse T+0) sur ${layer.total} reçus (incl. prévisions)`
                                : undefined
                            }
                          >
                            {layer.count}
                            {layer.total !== layer.count && (
                              <span className="text-slate-600">/{layer.total}</span>
                            )}
                          </span>
                        )}
                      </div>
                      {err && (
                        <div className="mt-1 text-[0.625rem] text-red-400 truncate" title={err}>
                          {err}
                        </div>
                      )}
                      {isActive && layer && (() => {
                        const hist = statusHistogram(layer.rawData)
                        if (hist.length === 0) return null
                        return (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {hist.map(([st, n]) => {
                              const sty = STATUS_STYLES[st] ?? { color: '#94a3b8', label: st }
                              return (
                                <span
                                  key={st}
                                  title={`${st} : ${n} bulletin${n > 1 ? 's' : ''}`}
                                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.5625rem] font-mono uppercase tracking-wider bg-slate-900/70 border border-slate-800/70"
                                  style={{ color: sty.color }}
                                >
                                  <span
                                    className="size-1.5 rounded-full"
                                    style={{ backgroundColor: sty.color, boxShadow: `0 0 4px ${sty.color}aa` }}
                                  />
                                  {sty.label}
                                  <span className="text-slate-400 tabular-nums">{n}</span>
                                </span>
                              )
                            })}
                          </div>
                        )
                      })()}
                    </button>
                    {isActive && SOURCE_AWARE_FAMILIES.has(f.name) && (() => {
                      const ss = SOURCE_STYLES[f.name]
                      const sel = sourceFilter[f.name] ?? { iwxxm: true, tac: true }
                      const SubBtn = ({ src, label, color }: { src: 'iwxxm' | 'tac'; label: string; color: string }) => {
                        const on = sel[src]
                        return (
                          <button
                            onClick={(e) => { e.stopPropagation(); onToggleSource(f.name, src) }}
                            title={`${label} — afficher/masquer`}
                            className={`flex-1 flex items-center gap-1.5 px-2 py-1 rounded-md border text-[0.625rem] uppercase tracking-wider transition ${
                              on
                                ? 'border-slate-700 bg-slate-900/60 text-slate-200'
                                : 'border-transparent text-slate-500 hover:bg-slate-900/30'
                            }`}
                          >
                            <span
                              className="size-2 rounded-full shrink-0"
                              style={{
                                backgroundColor: color,
                                boxShadow: on ? `0 0 6px ${color}cc` : 'none',
                                opacity: on ? 1 : 0.35,
                              }}
                            />
                            <span>{label}</span>
                          </button>
                        )
                      }
                      return (
                        <div className="mt-1 ml-5 flex gap-1">
                          <SubBtn src="iwxxm" label="IWXXM" color={ss.iwxxm.color} />
                          <SubBtn src="tac" label="TAC" color={ss.tac.color} />
                        </div>
                      )
                    })()}
                  </li>
                )
              })}
            </ul>
          )
          return (
            <>
              {opmetFams.length > 0 && (
                <div className="mt-3">
                  <div
                    className="px-2 py-1 text-[0.625rem] uppercase tracking-wider text-slate-500"
                    title="Observations, prévisions et avis OACI Annexe 3 (Doc 8896)"
                  >
                    Produits OPMET
                  </div>
                  {renderFamilies(opmetFams)}
                </div>
              )}
              {sitFams.length > 0 && (
                <div className="mt-3">
                  <div
                    className="px-2 py-1 text-[0.625rem] uppercase tracking-wider text-slate-500"
                    title="Produits dérivés ou support à la prévision (non OPMET)"
                  >
                    Produits situationnels
                  </div>
                  {renderFamilies(sitFams)}
                </div>
              )}
            </>
          )
        })()}
      </div>

      <div className="px-4 py-3 border-t border-slate-800/70 text-[0.625rem] text-slate-500 leading-snug">
        Fond de carte ·{' '}
        <a
          href="https://carto.com/attributions"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-slate-300"
        >
          CARTO
        </a>{' '}
        · Données ©{' '}
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-slate-300"
        >
          OpenStreetMap
        </a>
      </div>
    </div>
  )
}

// 29 niveaux de pression disponibles dans le coverage MetGate WIND, du plus
// haut (basse pression, haute altitude) vers le plus bas (haute pression, sol).
// fl = niveau de vol approximatif en centaines de pieds (ISA standard).
const WIND_PRESSURE_LEVELS: Array<{ pa: number; fl: number }> = [
  { pa: 1000, fl: 1020 },
  { pa: 2000, fl: 885 },
  { pa: 3000, fl: 800 },
  { pa: 5000, fl: 690 },
  { pa: 7000, fl: 620 },
  { pa: 10000, fl: 531 },
  { pa: 12500, fl: 487 },
  { pa: 15000, fl: 447 },
  { pa: 17500, fl: 416 },
  { pa: 20000, fl: 390 },
  { pa: 22500, fl: 361 },
  { pa: 25000, fl: 340 },
  { pa: 27500, fl: 321 },
  { pa: 30000, fl: 300 },
  { pa: 35000, fl: 265 },
  { pa: 40000, fl: 235 },
  { pa: 45000, fl: 208 },
  { pa: 50000, fl: 180 },
  { pa: 55000, fl: 160 },
  { pa: 60000, fl: 138 },
  { pa: 65000, fl: 118 },
  { pa: 70000, fl: 100 },
  { pa: 75000, fl: 80 },
  { pa: 80000, fl: 63 },
  { pa: 85000, fl: 50 },
  { pa: 90000, fl: 33 },
  { pa: 92500, fl: 25 },
  { pa: 95000, fl: 16 },
  { pa: 100000, fl: 0 },
]

// Raccourcis FL communs (pilote moyen / ATM). pa choisi parmi les 29 niveaux.
const WIND_QUICK_PRESETS: Array<{ pa: number; label: string }> = [
  { pa: 92500, label: 'FL025' },
  { pa: 85000, label: 'FL050' },
  { pa: 70000, label: 'FL100' },
  { pa: 50000, label: 'FL180' },
  { pa: 30000, label: 'FL300' },
  { pa: 25000, label: 'FL340' },
  { pa: 20000, label: 'FL390' },
]

function WindLevelSelector({
  dataset,
  value,
  onSelect,
}: {
  dataset: 'WIND' | 'JET'
  value: number
  onSelect: (dataset: 'WIND' | 'JET', level: number) => void
}) {
  // Index dans WIND_PRESSURE_LEVELS du niveau courant. Le slider va de 0
  // (haute altitude, 1 hPa) à N-1 (sol, 1000 hPa) — on inverse l'index pour
  // avoir "altitude croissante = slider vers la droite".
  const N = WIND_PRESSURE_LEVELS.length
  const findIdx = (pa: number) => {
    const i = WIND_PRESSURE_LEVELS.findIndex((l) => l.pa === pa)
    return i < 0 ? N - 1 : i
  }
  const sliderIdx = N - 1 - findIdx(value) // 0 = sol, N-1 = haute alti
  const cur = WIND_PRESSURE_LEVELS[findIdx(value)]
  return (
    <div className="flex flex-col gap-2 px-3 py-2 rounded-lg border border-slate-800/70 bg-slate-950/85 backdrop-blur-md shadow-xl min-w-[220px]">
      <div className="text-[0.5625rem] uppercase tracking-wider text-slate-500">Source</div>
      <button
        onClick={() => onSelect('JET', 0)}
        className={`flex items-center justify-between gap-3 px-2 py-1 rounded text-[0.6875rem] font-mono tabular-nums transition border ${
          dataset === 'JET'
            ? 'border-cyan-400/50 bg-cyan-500/15 text-cyan-100 shadow-[0_0_8px_rgba(34,211,238,0.2)]'
            : 'border-transparent text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'
        }`}
        title="Jet stream pré-isolé (single-level)"
      >
        <span>JET</span>
        <span className="text-[0.5625rem] text-slate-500">jet stream</span>
      </button>

      <div className="h-px bg-slate-800/60" />

      <div className="flex items-baseline justify-between text-[0.625rem]">
        <span className="text-slate-500 uppercase tracking-wider">Niveau</span>
        {dataset === 'WIND' && (
          <span className="font-mono tabular-nums text-cyan-200">
            FL{cur.fl.toString().padStart(3, '0')} ·{' '}
            <span className="text-slate-400">{(cur.pa / 100).toFixed(0)} hPa</span>
          </span>
        )}
      </div>

      <input
        type="range"
        min={0}
        max={N - 1}
        value={dataset === 'WIND' ? sliderIdx : 0}
        onChange={(e) => {
          const idx = N - 1 - Number(e.target.value)
          onSelect('WIND', WIND_PRESSURE_LEVELS[idx].pa)
        }}
        className="accent-cyan-400 h-1"
      />
      <div className="flex justify-between text-[0.5625rem] text-slate-600 font-mono tabular-nums px-0.5">
        <span>sol</span>
        <span>{Math.round(N / 2)}/29</span>
        <span>FL1020</span>
      </div>

      <div className="text-[0.5625rem] uppercase tracking-wider text-slate-500 mt-1">
        Raccourcis
      </div>
      <div className="grid grid-cols-4 gap-1">
        {WIND_QUICK_PRESETS.map((p) => {
          const active = dataset === 'WIND' && p.pa === value
          return (
            <button
              key={p.pa}
              onClick={() => onSelect('WIND', p.pa)}
              className={`px-1 py-0.5 rounded text-[0.625rem] font-mono tabular-nums transition border ${
                active
                  ? 'border-cyan-400/50 bg-cyan-500/15 text-cyan-100'
                  : 'border-transparent text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'
              }`}
            >
              {p.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function QvacisSelector({
  dataset,
  fl,
  onDataset,
  onFL,
}: {
  dataset: QvacisDataset
  fl: number
  onDataset: (d: QvacisDataset) => void
  onFL: (fl: number) => void
}) {
  return (
    <div className="flex flex-col gap-2 px-2 py-2 rounded-lg border border-orange-900/40 bg-slate-950/85 backdrop-blur-md shadow-xl">
      <div className="text-[0.5625rem] uppercase tracking-wider text-slate-500 px-1">
        Cendres
      </div>
      <div className="flex gap-1">
        <button
          onClick={() => onDataset('DETERMINISTIC')}
          className={`flex-1 px-2 py-1 rounded text-[0.625rem] transition border ${
            dataset === 'DETERMINISTIC'
              ? 'border-orange-400/50 bg-orange-500/15 text-orange-100'
              : 'border-transparent text-slate-400 hover:bg-slate-800/40'
          }`}
        >
          Déterm.
        </button>
        <button
          onClick={() => onDataset('PROBABILISTIC')}
          className={`flex-1 px-2 py-1 rounded text-[0.625rem] transition border ${
            dataset === 'PROBABILISTIC'
              ? 'border-orange-400/50 bg-orange-500/15 text-orange-100'
              : 'border-transparent text-slate-400 hover:bg-slate-800/40'
          }`}
        >
          Probab.
        </button>
      </div>
      <div className="text-[0.5625rem] uppercase tracking-wider text-slate-500 px-1">
        FL
      </div>
      <div className="grid grid-cols-3 gap-1">
        {QVACIS_FLS.map((v) => (
          <button
            key={v}
            onClick={() => onFL(v)}
            className={`px-1.5 py-1 rounded text-[0.625rem] font-mono tabular-nums transition border ${
              fl === v
                ? 'border-orange-400/50 bg-orange-500/15 text-orange-100'
                : 'border-transparent text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'
            }`}
            title={`Layer center, ~${(v / 10).toFixed(0)}k ft`}
          >
            {v}
          </button>
        ))}
      </div>
    </div>
  )
}

// Slider maître pour les couches WCS quand le mode 'lié' est actif. Pose en
// bas-centre, au-dessus du TimeSlider WFS (qui peut aussi être présent).
function WcsMasterSlider({
  timeline,
  instant,
  onChange,
  playing,
  onTogglePlay,
}: {
  timeline: string[]
  instant: string
  onChange: (v: string) => void
  playing: boolean
  onTogglePlay: () => void
}) {
  const idx = Math.max(0, timeline.indexOf(instant))
  const total = timeline.length
  const m = instant.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/)
  const label = m ? `${m[1]} ${m[2]}:${m[3]} UTC` : instant
  return (
    <DraggableWindow
      centered
      storageKey="metgate.wcsMasterSlider.pos"
      className="absolute bottom-28 left-1/2 z-10 flex items-center gap-3 rounded-xl border border-violet-400/40 bg-slate-950/85 backdrop-blur-md px-3 py-2 shadow-[0_0_30px_rgba(167,139,250,0.18)] max-w-[90vw]"
    >
      <button
        onClick={onTogglePlay}
        disabled={total < 2}
        className="size-8 rounded-lg bg-violet-500/15 hover:bg-violet-500/25 border border-violet-400/40 flex items-center justify-center transition disabled:opacity-40"
        aria-label={playing ? 'Pause' : 'Play'}
      >
        {playing ? (
          <Pause className="size-4 text-violet-200" />
        ) : (
          <Play className="size-4 text-violet-200 translate-x-[1px]" />
        )}
      </button>
      <div className="flex flex-col gap-1.5 min-w-[280px]">
        <div className="flex items-center gap-1.5 text-[0.6875rem] text-slate-300">
          <Link2 className="size-3 text-violet-300" />
          <span className="font-mono tabular-nums">{label}</span>
          <span className="text-slate-600">·</span>
          <span className="text-slate-500 tabular-nums">
            {idx + 1}/{total}
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={total - 1}
          value={idx}
          onChange={(e) => onChange(timeline[Number(e.target.value)])}
          className="accent-violet-400 h-1"
        />
      </div>
    </DraggableWindow>
  )
}

// ─── Légende ──────────────────────────────────────────────────────────────────

interface LegendProps {
  active: Set<string>
  loaded: Record<string, FetchedLayer>
  windEnabled: boolean
  windDataset: 'WIND' | 'JET'
  windLevelPa: number
  tropoEnabled: boolean
  qvacisEnabled: boolean
  qvacisDataset: QvacisDataset
  qvacisFL: number
  radarEnabled: boolean
  lightningEnabled: boolean
  alertsEnabled: boolean
  satIREnabled: boolean
  satConvEnabled: boolean
  cthEnabled: boolean
  cthMinFL: number
  firEnabled: boolean
  countriesEnabled: boolean
  ogcFilterXml: string | null
  ogcFilter: OGCFilter | null
}

function Legend({
  active, loaded,
  windEnabled, windDataset, windLevelPa,
  tropoEnabled,
  qvacisEnabled, qvacisDataset, qvacisFL,
  radarEnabled, lightningEnabled, alertsEnabled, satIREnabled, satConvEnabled,
  cthEnabled, cthMinFL,
  firEnabled, countriesEnabled,
  ogcFilterXml, ogcFilter,
}: LegendProps) {
  const [expanded, setExpanded] = useState(false)
  const windFL = (() => {
    if (!windEnabled) return ''
    if (windDataset === 'JET') return 'JET'
    const lvl = WIND_PRESSURE_LEVELS.find(l => l.pa === windLevelPa)
    return lvl ? `FL${lvl.fl.toString().padStart(3, '0')}` : ''
  })()

  type Entry = { label: string; color: string; dash?: boolean; count?: number; symbol: 'dot' | 'line' | 'fill' }
  const opmet: Entry[] = []
  const situational: Entry[] = []
  const layers: Entry[] = []

  active.forEach(name => {
    const s = styleFor(name)
    const layer = loaded[name]
    const entry: Entry = { label: displayFamilyName(name), color: s.color, count: layer?.count, symbol: 'dot' }
    if (OPMET_FAMILIES.has(name)) opmet.push(entry)
    else situational.push(entry)
  })

  if (windEnabled)      layers.push({ label: `Vent ${windFL}`, color: '#22d3ee', symbol: 'line' })
  if (tropoEnabled)     layers.push({ label: 'Tropopause', color: '#fbbf24', symbol: 'fill' })
  if (qvacisEnabled)    layers.push({ label: `Cendres FL${qvacisFL} (${qvacisDataset === 'DETERMINISTIC' ? 'dét.' : 'prob.'})`, color: '#fb923c', symbol: 'fill' })
  if (radarEnabled)     layers.push({ label: 'Radar OPERA', color: '#4ade80', symbol: 'dot' })
  if (lightningEnabled) layers.push({ label: 'Foudre MTG-LI', color: '#facc15', symbol: 'dot' })
  if (alertsEnabled)    layers.push({ label: 'Alertes AD', color: '#ef4444', symbol: 'dot' })
  if (satIREnabled)     layers.push({ label: 'Sat IR 10.5µm', color: '#7dd3fc', symbol: 'fill' })
  if (satConvEnabled)   layers.push({ label: 'Convection RGB', color: '#f472b6', symbol: 'fill' })
  if (cthEnabled)       layers.push({ label: `CTH ≥ FL${cthMinFL}`, color: '#c084fc', symbol: 'fill' })
  if (firEnabled)       layers.push({ label: 'FIR / UIR', color: '#818cf8', dash: true, symbol: 'line' })
  if (countriesEnabled) layers.push({ label: 'Pays', color: '#fde047', symbol: 'line' })

  const filterLabel = ogcFilter?.icaoPattern
    ? `Filtre : ${ogcFilter.icaoPattern}`
    : ogcFilterXml ? 'Filtre OGC actif' : null

  if (opmet.length === 0 && situational.length === 0 && layers.length === 0 && !filterLabel) return null

  const renderEntry = (e: Entry, i: number) => (
    <div key={i} className="flex items-center gap-2 py-0.5">
      {e.symbol === 'dot' && (
        <span className="size-2.5 rounded-full shrink-0" style={{ backgroundColor: e.color, boxShadow: `0 0 6px ${e.color}88` }} />
      )}
      {e.symbol === 'line' && (
        <span className="w-4 h-0.5 shrink-0 rounded" style={{
          background: e.dash
            ? `repeating-linear-gradient(90deg,${e.color} 0,${e.color} 3px,transparent 3px,transparent 6px)`
            : e.color,
        }} />
      )}
      {e.symbol === 'fill' && (
        <span className="w-4 h-2.5 shrink-0 rounded-sm" style={{ backgroundColor: e.color + '55', border: `1px solid ${e.color}99` }} />
      )}
      <span className="flex-1 truncate">{e.label}</span>
      {e.count !== undefined && (
        <span className="tabular-nums text-slate-500 shrink-0">{e.count}</span>
      )}
    </div>
  )

  return (
    <div className="absolute bottom-8 left-4 z-10 flex flex-col rounded-xl border border-slate-700/70 bg-slate-950/85 backdrop-blur-md shadow-2xl text-xs text-slate-200 min-w-[200px] max-w-[260px]">
      <button
        onClick={() => setExpanded(v => !v)}
        className="flex items-center gap-2 px-3 py-2 border-b border-slate-800/60 hover:bg-slate-900/40 transition rounded-t-xl"
        title={expanded ? 'Réduire' : 'Déplier'}
      >
        <span className="text-[0.625rem] uppercase tracking-wider text-slate-400 flex-1 text-left">
          Couches affichées
        </span>
        <span className="text-[0.6875rem] tabular-nums text-slate-500">
          {opmet.length + situational.length + layers.length}
        </span>
        {expanded ? <ChevronDown className="size-3.5 text-slate-500" /> : <ChevronUp className="size-3.5 text-slate-500" />}
      </button>

      {expanded && (
        <div className="overflow-y-auto px-3 py-1.5 max-h-[40vh]">
          {filterLabel && (
            <div className="flex items-center gap-1.5 text-indigo-300 border-b border-slate-800/60 pb-1 mb-1 text-[0.6875rem]">
              <span className="size-2 rounded-sm bg-indigo-500/40 border border-indigo-400/60 shrink-0" />
              <span className="truncate">{filterLabel}</span>
            </div>
          )}

          {opmet.length > 0 && (
            <>
              <div className="text-[0.5625rem] uppercase tracking-wider text-slate-500 mt-0.5">Produits OPMET</div>
              {opmet.map(renderEntry)}
            </>
          )}

          {situational.length > 0 && (
            <>
              <div className="text-[0.5625rem] uppercase tracking-wider text-slate-500 mt-1.5">Produits situationnels</div>
              {situational.map(renderEntry)}
            </>
          )}

          {layers.length > 0 && (
            <>
              <div className="text-[0.5625rem] uppercase tracking-wider text-slate-500 mt-1.5">Couches météo</div>
              {layers.map(renderEntry)}
            </>
          )}
        </div>
      )}
    </div>
  )
}
