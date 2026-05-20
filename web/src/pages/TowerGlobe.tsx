import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, Stars } from '@react-three/drei'
import * as THREE from 'three'
import { AlertTriangle, Eye, EyeOff, RotateCcw, ArrowDown, ArrowRight, Zap } from 'lucide-react'

// ───────────────────────────────────────────────────────────────────────
// Vue tactique « boule à neige » 3D centrée sur un aérodrome.
// Étape 1 : composant fonctionnel avec données fictives identiques au
// mockup standalone tower-globe.html. La connexion aux API live (CTH,
// foudre, vents, METAR, ADS-B) viendra ensuite — l'arborescence des props
// est déjà conçue pour recevoir ces données.
// ───────────────────────────────────────────────────────────────────────

const RADIUS = 22 // rayon utile du dôme (unités de scène)

// ───────────────────────────────────────────────────────────────────────
// Rate-limiter ADS-B au niveau MODULE (singleton, survit aux re-mounts).
// Quel que soit le nombre d'instances de TowerGlobe ou de cycles de
// useEffect, on n'enverra jamais plus de 1 requête /api/aircraft/search
// toutes les 30 secondes. Sur erreur, back-off jusqu'à 5 minutes.
// ───────────────────────────────────────────────────────────────────────
const ADSB_MIN_INTERVAL_MS = 30_000
const ADSB_MAX_BACKOFF_MS = 300_000
let adsbLastAttemptAt = 0
let adsbBackoffUntil = 0
let adsbInFlight = false
let adsbErrorStreak = 0
function adsbCanFireNow(): { ok: boolean; waitMs: number } {
  const now = Date.now()
  if (adsbInFlight) return { ok: false, waitMs: 1000 }
  const sinceLast = now - adsbLastAttemptAt
  if (sinceLast < ADSB_MIN_INTERVAL_MS) {
    return { ok: false, waitMs: ADSB_MIN_INTERVAL_MS - sinceLast + 50 }
  }
  if (now < adsbBackoffUntil) {
    return { ok: false, waitMs: adsbBackoffUntil - now + 50 }
  }
  return { ok: true, waitMs: 0 }
}
function adsbMarkAttempt() {
  adsbLastAttemptAt = Date.now()
  adsbInFlight = true
}
function adsbMarkSuccess() {
  adsbInFlight = false
  adsbErrorStreak = 0
  adsbBackoffUntil = 0
}
function adsbMarkError() {
  adsbInFlight = false
  adsbErrorStreak++
  const backoff = Math.min(ADSB_MAX_BACKOFF_MS, 30_000 * 2 ** adsbErrorStreak)
  adsbBackoffUntil = Date.now() + backoff
}
// SCENE_RANGE_NM est désormais dynamique (state TowerGlobe). Choix typiques :
//  -   5 NM : vue tour / finale courte
//  -  15 NM : vue TWR + finale étendue
//  -  30 NM : vue TMA / approche
//  - 100 NM : briefing étendu / supervision
const RANGE_PRESETS_NM = [5, 15, 30, 100] as const
type RangePreset = (typeof RANGE_PRESETS_NM)[number]

// Position lat/lon des aérodromes — référence pour conversion 3D.
// À terme : remplacer par un appel /api/airport/{icao} qui interroge
// l'ICAOIndex MetGate côté backend (déjà chargé dans `internal/catalog/route.go`).
// Tous ces aéroports sont dans le disque MTG 0° (Europe/Afrique/Moyen-Orient).
const AIRPORTS: Record<string, { lat: number; lon: number; name: string }> = {
  // France
  LFPG: { lat: 49.0097, lon: 2.5479, name: 'Paris CDG' },
  LFPO: { lat: 48.7233, lon: 2.3796, name: 'Paris ORY' },
  LFBO: { lat: 43.6294, lon: 1.3638, name: 'Toulouse' },
  LFML: { lat: 43.4393, lon: 5.2214, name: 'Marseille' },
  LFLY: { lat: 45.7194, lon: 4.9442, name: 'Lyon Bron' },
  LFMN: { lat: 43.6584, lon: 7.2159, name: 'Nice' },
  // Bassin méditerranéen / Moyen-Orient (souvent actif)
  LGAV: { lat: 37.9364, lon: 23.9445, name: 'Athènes' },
  LTBA: { lat: 40.9769, lon: 28.8146, name: 'Istanbul Atatürk' },
  LCLK: { lat: 34.875, lon: 33.6249, name: 'Larnaca' },
  HECA: { lat: 30.1219, lon: 31.4056, name: 'Le Caire' },
  OEJN: { lat: 21.6797, lon: 39.1565, name: 'Jeddah' },
  // Afrique tropicale (convection quasi quotidienne, ZCIT)
  DNMM: { lat: 6.5774, lon: 3.3212, name: 'Lagos (Nigeria)' },
  FKKD: { lat: 4.0064, lon: 9.7195, name: 'Douala (Cameroun)' },
  FKKR: { lat: 9.336, lon: 13.37, name: 'Garoua (Cameroun nord)' },
  FOOL: { lat: 0.4586, lon: 9.4127, name: 'Libreville (Gabon)' },
  FCBB: { lat: -4.2517, lon: 15.253, name: 'Brazzaville (Congo)' },
  HKJK: { lat: -1.319, lon: 36.9278, name: 'Nairobi' },
  FAOR: { lat: -26.1392, lon: 28.246, name: 'Johannesburg' },
  GMMN: { lat: 33.3675, lon: -7.5898, name: 'Casablanca' },
}

// Distance en milles nautiques entre 2 points lat/lon (haversine).
function distanceNM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3440.065 // rayon Terre en NM
  const f1 = (lat1 * Math.PI) / 180
  const f2 = (lat2 * Math.PI) / 180
  const df = ((lat2 - lat1) * Math.PI) / 180
  const dl = ((lon2 - lon1) * Math.PI) / 180
  const a = Math.sin(df / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

// Cap initial entre 2 points (radians, 0 = nord, sens horaire).
function bearingRad(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const f1 = (lat1 * Math.PI) / 180
  const f2 = (lat2 * Math.PI) / 180
  const dl = ((lon2 - lon1) * Math.PI) / 180
  const y = Math.sin(dl) * Math.cos(f2)
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl)
  return Math.atan2(y, x)
}

// Convertit (lat, lon, alt_units) en (x, y, z) scène, relatif à l'aéroport.
// Convention scène : x = est, z = sud, y = haut.
// `nmToUnits` dépend du rayon scène (RADIUS / sceneRangeNm).
function toSceneCoords(
  airport: { lat: number; lon: number },
  lat: number,
  lon: number,
  yUnits: number,
  nmToUnits: number,
): [number, number, number] {
  const dist = distanceNM(airport.lat, airport.lon, lat, lon)
  const brg = bearingRad(airport.lat, airport.lon, lat, lon)
  const r = dist * nmToUnits
  const x = r * Math.sin(brg)
  const z = -r * Math.cos(brg)
  return [x, yUnits, z]
}

interface Cell {
  x: number
  z: number
  topUnits: number // hauteur en unités de scène
  fl: number
  color: number // hex
  label: string
}
interface Lightning {
  x: number
  y: number
  z: number
}
interface WindLevel {
  y: number
  dirDeg: number
  kt: number
  color: number
  label: string
}
interface Aerodrome {
  name: string
  x: number
  z: number
}

interface OpmetMessage {
  tac?: string
  decoded?: string
  time?: string
  raw: Record<string, unknown>
}

// Hauteur cap (FL) du dôme selon le cas d'usage. À 5 NM (vue TWR), inutile
// d'aller jusqu'au jet stream — on plafonne à FL100 pour zoomer sur les
// altitudes basses (circuit, brouillard, montée initiale).
function maxFLForRange(rangeNm: number): number {
  if (rangeNm <= 5) return 100
  if (rangeNm <= 15) return 200
  if (rangeNm <= 30) return 400
  return 500
}

// 1 unité de scène = X mètres, calculé pour que RADIUS unités correspondent
// à l'altitude max (FL × 30.48 m).
function metersPerUnitForRange(rangeNm: number): number {
  return (maxFLForRange(rangeNm) * 30.48) / RADIUS
}

// Altitude tropopause (FL370 = ~11280 m). Affichée seulement si elle reste
// dans le dôme (donc à partir du rayon ~30 NM).
const TROPOPAUSE_M = 11280

// Couleur palette aviation selon FL sommet.
function colorForFL(fl: number): number {
  if (fl < 100) return 0x7dd3fc
  if (fl < 200) return 0x38bdf8
  if (fl < 300) return 0x4ade80
  if (fl < 350) return 0xfacc15
  if (fl < 400) return 0xf97316
  if (fl < 450) return 0xef4444
  return 0xdc2626
}

function labelForCell(fl: number, hail: boolean, severity: number): string {
  let base: string
  if (fl >= 350) base = `Cb FL${fl}`
  else if (fl >= 200) base = `TCU FL${fl}`
  else base = `Cu FL${fl}`
  if (hail) base += ' GR'
  if (severity >= 2) base += ' SEV'
  return base
}

// Centroïde d'un polygone GeoJSON (coordinates = [[[lon,lat],...]]).
function polygonCentroid(coords: number[][][]): [number, number] | null {
  const ring = coords[0]
  if (!ring || ring.length === 0) return null
  let lonSum = 0
  let latSum = 0
  for (const p of ring) {
    lonSum += p[0]
    latSum += p[1]
  }
  return [lonSum / ring.length, latSum / ring.length]
}
// 4 niveaux vent toujours échantillonnés, adaptés au cap d'altitude scène.
// Cela évite d'avoir un mât à moitié vide en vue rapprochée tout en gardant
// l'info pertinente pour le cas d'usage.
function windLevelsForMaxFL(
  maxFL: number,
): { pa: number; label: string; altM: number; fl: number }[] {
  if (maxFL <= 100) {
    // Couche limite & basse couche — utile en TWR/finale.
    return [
      { pa: 95000, label: 'FL015', altM: 457, fl: 15 },
      { pa: 90000, label: 'FL030', altM: 914, fl: 30 },
      { pa: 85000, label: 'FL050', altM: 1525, fl: 50 },
      { pa: 70000, label: 'FL100', altM: 3048, fl: 100 },
    ]
  }
  if (maxFL <= 200) {
    return [
      { pa: 90000, label: 'FL030', altM: 914, fl: 30 },
      { pa: 80000, label: 'FL060', altM: 1829, fl: 60 },
      { pa: 70000, label: 'FL100', altM: 3048, fl: 100 },
      { pa: 50000, label: 'FL180', altM: 5486, fl: 180 },
    ]
  }
  if (maxFL <= 400) {
    return [
      { pa: 85000, label: 'FL050', altM: 1525, fl: 50 },
      { pa: 70000, label: 'FL100', altM: 3048, fl: 100 },
      { pa: 40000, label: 'FL250', altM: 7620, fl: 250 },
      { pa: 20000, label: 'FL400', altM: 12192, fl: 400 },
    ]
  }
  return [
    { pa: 85000, label: 'FL050', altM: 1525, fl: 50 },
    { pa: 70000, label: 'FL100', altM: 3048, fl: 100 },
    { pa: 40000, label: 'FL250', altM: 7620, fl: 250 },
    { pa: 15000, label: 'FL475', altM: 14478, fl: 475 },
  ]
}

function colorForWindKt(kt: number): number {
  if (kt < 30) return 0x67e8f9 // cyan calme
  if (kt < 60) return 0xfbbf24 // jaune fort
  return 0xef4444 // rouge tempête
}

// ───────────────────────────────────────────────────────────────────────
// Composants 3D
// ───────────────────────────────────────────────────────────────────────

function Dome() {
  return (
    <group>
      {/* Socle métal brossé */}
      <mesh position={[0, -2, 0]}>
        <cylinderGeometry args={[RADIUS * 1.05, RADIUS * 1.15, 4, 64]} />
        <meshStandardMaterial color={0x1e293b} roughness={0.6} metalness={0.7} />
      </mesh>
      {/* Anneau chrome */}
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
        <torusGeometry args={[RADIUS * 1.06, 0.5, 16, 64]} />
        <meshStandardMaterial color={0x9ca3af} roughness={0.2} metalness={0.95} />
      </mesh>
      {/* Verre du dôme */}
      <mesh>
        <sphereGeometry args={[RADIUS, 64, 32, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshPhysicalMaterial
          color={0xffffff}
          transmission={0.92}
          roughness={0.05}
          clearcoat={1}
          clearcoatRoughness={0.06}
          ior={1.45}
          thickness={0.3}
          transparent
          side={THREE.DoubleSide}
        />
      </mesh>
      {/* Joint verre/socle */}
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0.05, 0]}>
        <torusGeometry args={[RADIUS, 0.15, 16, 64]} />
        <meshStandardMaterial color={0x475569} roughness={0.3} metalness={0.8} />
      </mesh>
    </group>
  )
}

// CardinalRing : anneau de boussole autour du sol — N/E/S/W en gros
// (couleurs aviation : N rouge, autres cyan), graduations tous les 30° en
// gris avec valeur en degrés (030, 060, 120, ...).
function CardinalRing() {
  const headings = useMemo(() => {
    const out: { h: number; label: string; cardinal: boolean; isNorth: boolean }[] = []
    for (let h = 0; h < 360; h += 30) {
      const isCardinal = h % 90 === 0
      const label =
        h === 0
          ? 'N'
          : h === 90
            ? 'E'
            : h === 180
              ? 'S'
              : h === 270
                ? 'W'
                : String(h).padStart(3, '0')
      out.push({ h, label, cardinal: isCardinal, isNorth: h === 0 })
    }
    return out
  }, [])
  return (
    <>
      {headings.map((entry) => {
        const theta = (entry.h * Math.PI) / 180
        const r = RADIUS - 0.6
        const x = r * Math.sin(theta)
        const z = -r * Math.cos(theta)
        return (
          <CardinalLabel
            key={entry.h}
            pos={[x, 0.4, z]}
            text={entry.label}
            color={entry.isNorth ? '#fca5a5' : entry.cardinal ? '#67e8f9' : '#94a3b8'}
            large={entry.cardinal}
          />
        )
      })}
      {/* Tic-marks au sol tous les 10° pour matérialiser la rose */}
      {Array.from({ length: 36 }).map((_, i) => {
        const h = i * 10
        const theta = (h * Math.PI) / 180
        const isMajor = h % 30 === 0
        const rOuter = RADIUS - 0.05
        const rInner = isMajor ? RADIUS - 0.9 : RADIUS - 0.4
        const x1 = rInner * Math.sin(theta)
        const z1 = -rInner * Math.cos(theta)
        const x2 = rOuter * Math.sin(theta)
        const z2 = -rOuter * Math.cos(theta)
        const cx = (x1 + x2) / 2
        const cz = (z1 + z2) / 2
        const len = Math.sqrt((x2 - x1) ** 2 + (z2 - z1) ** 2)
        const angY = Math.atan2(x2 - x1, z2 - z1)
        return (
          <mesh
            key={i}
            rotation={[-Math.PI / 2, 0, angY]}
            position={[cx, 0.075, cz]}
          >
            <planeGeometry args={[isMajor ? 0.12 : 0.06, len]} />
            <meshBasicMaterial
              color={h === 0 ? 0xfca5a5 : isMajor ? 0x67e8f9 : 0x64748b}
              transparent
              opacity={isMajor ? 0.85 : 0.45}
            />
          </mesh>
        )
      })}
    </>
  )
}

function CardinalLabel({
  pos,
  text,
  color,
  large,
}: {
  pos: [number, number, number]
  text: string
  color: string
  large: boolean
}) {
  const tex = useMemo(() => {
    const cvs = document.createElement('canvas')
    cvs.width = 128
    cvs.height = 64
    const ctx = cvs.getContext('2d')!
    ctx.font = `bold ${large ? 52 : 26}px ui-monospace, monospace`
    ctx.fillStyle = color
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, cvs.width / 2, cvs.height / 2)
    return new THREE.CanvasTexture(cvs)
  }, [text, color, large])
  return (
    <sprite position={pos} scale={large ? [2.4, 1.2, 1] : [1.4, 0.7, 1]}>
      <spriteMaterial map={tex} transparent depthTest={false} />
    </sprite>
  )
}

function Ground() {
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]}>
        <circleGeometry args={[RADIUS, 64]} />
        <meshStandardMaterial color={0x0a1628} roughness={0.85} />
      </mesh>
      {[5, 10, 15, 20].map((nm) => {
        const k = (nm / 25) * RADIUS
        return (
          <mesh key={nm} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.06, 0]}>
            <ringGeometry args={[k - 0.05, k + 0.05, 64]} />
            <meshBasicMaterial color={0x334155} transparent opacity={0.5} />
          </mesh>
        )
      })}
    </group>
  )
}

interface RunwayGeo {
  leLat: number
  leLon: number
  heLat: number
  heLon: number
  lengthFt: number
  widthFt: number
  leIdent: string
  heIdent: string
}

// Cible visuelle : on veut qu'une piste apparaisse ~3 unités de long quel
// que soit le rayon scène, et au moins 0.4 de large. Le scale est calculé
// dynamiquement à partir de la longueur réelle (en unités) de chaque piste.
const TARGET_RUNWAY_LEN_UNITS = 3.0
const TARGET_RUNWAY_WIDTH_UNITS = 0.6

function Airport({
  icao,
  apLat,
  apLon,
  runways,
  nmToUnits,
}: {
  icao: string
  apLat: number
  apLon: number
  runways: RunwayGeo[]
  nmToUnits: number
}) {
  // Convertit lat/lon des seuils en coords scène, place chaque piste comme
  // un plan orienté entre les deux seuils.
  const ap = { lat: apLat, lon: apLon }
  return (
    <group>
      {runways.map((rw, i) => {
        const [x1, , z1] = toSceneCoords(ap, rw.leLat, rw.leLon, 0, nmToUnits)
        const [x2, , z2] = toSceneCoords(ap, rw.heLat, rw.heLon, 0, nmToUnits)
        const dx = x2 - x1
        const dz = z2 - z1
        const realLen = Math.sqrt(dx * dx + dz * dz)
        if (realLen < 0.01) return null
        // Cible visuelle constante : la piste apparaît ~3 unités peu importe
        // le rayon scène et la distance caméra, avec largeur min 0.6 unité.
        const realWidth = (rw.widthFt / 6076) * nmToUnits
        const lenScale = Math.max(1.0, Math.min(15, TARGET_RUNWAY_LEN_UNITS / realLen))
        const length = realLen * lenScale
        const widthUnits = Math.max(
          TARGET_RUNWAY_WIDTH_UNITS,
          realWidth * lenScale * 0.7,
        )
        const cx = (x1 + x2) / 2
        const cz = (z1 + z2) / 2
        const angY = Math.atan2(dx, dz)
        // Garantit une longueur visible minimale (1 unité) même quand le
        // scale calculé est 1 mais la piste est très courte.
        const lenVis = Math.max(1.2, length)
        return (
          <group key={i} position={[cx, 0.18, cz]} rotation={[0, angY, 0]}>
            {/* Surface piste — gris clair lumineux, en MeshBasic pour
                garantir la visibilité indépendamment de la lumière scène. */}
            <mesh rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[widthUnits, lenVis]} />
              <meshBasicMaterial color={0xb8c4d2} />
            </mesh>
            {/* Bordures sombres */}
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.005, 0]}>
              <planeGeometry args={[widthUnits * 1.05, lenVis * 1.02]} />
              <meshBasicMaterial color={0x0f172a} />
            </mesh>
            {/* Surface principale par-dessus la bordure */}
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, 0]}>
              <planeGeometry args={[widthUnits, lenVis]} />
              <meshBasicMaterial color={0x94a3b8} />
            </mesh>
            {/* Axe central pointillé blanc */}
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
              <planeGeometry args={[widthUnits * 0.08, lenVis * 0.92]} />
              <meshBasicMaterial color={0xffffff} />
            </mesh>
            <RunwayLabel position={[0, 0.6, lenVis / 2 - 0.5]} text={rw.leIdent} />
            <RunwayLabel position={[0, 0.6, -lenVis / 2 + 0.5]} text={rw.heIdent} />
          </group>
        )
      })}
      <Label3D position={[0, 1.8, 0]} text={icao} color="#22d3ee" />
    </group>
  )
}

function RunwayLabel({
  position,
  text,
}: {
  position: [number, number, number]
  text: string
  rotateY?: number
}) {
  const tex = useMemo(() => {
    const cvs = document.createElement('canvas')
    cvs.width = 128
    cvs.height = 32
    const ctx = cvs.getContext('2d')!
    ctx.fillStyle = 'rgba(15,23,42,0.7)'
    ctx.fillRect(0, 0, cvs.width, cvs.height)
    ctx.font = 'bold 22px ui-monospace, monospace'
    ctx.fillStyle = '#fde68a'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, cvs.width / 2, cvs.height / 2)
    return new THREE.CanvasTexture(cvs)
  }, [text])
  return (
    <sprite position={position} scale={[1.4, 0.4, 1]}>
      <spriteMaterial map={tex} transparent depthTest={false} />
    </sprite>
  )
}

// Texte flottant avec sprite + canvas. Toujours face caméra.
function Label3D({
  position,
  text,
  color = '#cbd5e1',
  width = 2.5,
}: {
  position: [number, number, number]
  text: string
  color?: string
  width?: number
}) {
  const texture = useMemo(() => {
    const cvs = document.createElement('canvas')
    cvs.width = 256
    cvs.height = 64
    const ctx = cvs.getContext('2d')!
    ctx.font = 'bold 32px ui-monospace, monospace'
    ctx.fillStyle = color
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, cvs.width / 2, cvs.height / 2)
    return new THREE.CanvasTexture(cvs)
  }, [text, color])
  return (
    <sprite position={position} scale={[width, width / 4, 1]}>
      <spriteMaterial map={texture} transparent depthTest={false} />
    </sprite>
  )
}

function CellMesh({ cell, hidden }: { cell: Cell; hidden: boolean }) {
  if (hidden) return null
  const segs = 8
  return (
    <group position={[cell.x, 0, cell.z]}>
      {Array.from({ length: segs }).map((_, i) => {
        const t = i / (segs - 1)
        const r = 1.4 + t * 0.4 + Math.sin(t * Math.PI) * 0.4
        return (
          <mesh key={i} position={[0, t * cell.topUnits + 0.6, 0]}>
            <sphereGeometry args={[r, 16, 12]} />
            <meshStandardMaterial
              color={cell.color}
              emissive={cell.color}
              emissiveIntensity={0.15 + t * 0.25}
              roughness={0.85}
              transparent
              opacity={0.78}
            />
          </mesh>
        )
      })}
      <CellLabel pos={[0, cell.topUnits + 1.6, 0]} text={cell.label} />
    </group>
  )
}

function CellLabel({ pos, text }: { pos: [number, number, number]; text: string }) {
  const texture = useMemo(() => {
    const cvs = document.createElement('canvas')
    cvs.width = 256
    cvs.height = 64
    const ctx = cvs.getContext('2d')!
    ctx.fillStyle = 'rgba(15,23,42,0.85)'
    ctx.fillRect(0, 0, cvs.width, cvs.height)
    ctx.strokeStyle = '#475569'
    ctx.lineWidth = 2
    ctx.strokeRect(1, 1, cvs.width - 2, cvs.height - 2)
    ctx.font = 'bold 28px ui-monospace, monospace'
    ctx.fillStyle = '#fecaca'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, cvs.width / 2, cvs.height / 2)
    return new THREE.CanvasTexture(cvs)
  }, [text])
  return (
    <sprite position={pos} scale={[4, 1, 1]}>
      <spriteMaterial map={texture} transparent depthTest={false} />
    </sprite>
  )
}

function LightningSprites({
  visible,
  flashes,
}: {
  visible: boolean
  flashes: Lightning[]
}) {
  const tex = useMemo(() => {
    const cvs = document.createElement('canvas')
    cvs.width = 64
    cvs.height = 64
    const ctx = cvs.getContext('2d')!
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
    grad.addColorStop(0, 'rgba(254,243,199,1)')
    grad.addColorStop(0.3, 'rgba(252,211,77,0.85)')
    grad.addColorStop(0.7, 'rgba(252,211,77,0.2)')
    grad.addColorStop(1, 'rgba(252,211,77,0)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, 64, 64)
    return new THREE.CanvasTexture(cvs)
  }, [])
  const phases = useMemo(
    () => flashes.map(() => Math.random() * Math.PI * 2),
    [flashes],
  )
  const refs = useRef<(THREE.Sprite | null)[]>([])
  useFrame((s) => {
    if (!visible) return
    const t = s.clock.elapsedTime
    refs.current.forEach((sp, i) => {
      if (!sp) return
      const ph = phases[i] ?? 0
      const intensity =
        0.3 + 0.7 * Math.max(0, Math.sin(t * 2.5 + ph) * Math.sin(t * 7 + ph * 3))
      const mat = sp.material as THREE.SpriteMaterial
      mat.opacity = intensity
      const k = 2 + 1.5 * intensity
      sp.scale.set(k, k, 1)
    })
  })
  if (!visible) return null
  return (
    <>
      {flashes.map((p, i) => (
        <sprite
          key={i}
          ref={(el) => {
            refs.current[i] = el
          }}
          position={[p.x, p.y, p.z]}
          scale={[3, 3, 1]}
        >
          <spriteMaterial
            map={tex}
            transparent
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </sprite>
      ))}
    </>
  )
}

// WindMast : mât central virtuel à côté du label ICAO, avec une flèche par
// niveau de pression à sa hauteur scène réelle. Profil vent vertical lisible
// d'un coup d'œil — beaucoup moins chargé que les 12 flèches précédentes.
// WindParticles : ~ 600 segments « filaments » dérivant à la vitesse et
// dans la direction du vent au niveau le plus proche. Chaque filament est
// un segment LineSegments orienté dans la direction du flux, avec un
// dégradé de couleur (head opaque → tail sombre) pour donner l'impression
// d'une traînée qui suit le mouvement. Recyclage en bord de dôme.
function WindParticles({
  visible,
  winds,
  nmToUnits,
}: {
  visible: boolean
  winds: WindLevel[]
  nmToUnits: number
}) {
  const N = 600
  const ref = useRef<THREE.LineSegments>(null)

  // Buffers : 2 vertices par particule (head + tail). Chaque vertex a 3
  // coords + 3 couleurs.
  const { positions, colors, velocities, trailLengths } = useMemo(() => {
    const pos = new Float32Array(N * 6)
    const col = new Float32Array(N * 6)
    const vel = new Float32Array(N * 3) // une vitesse par particule
    const trails = new Float32Array(N) // longueur du trail (s) par particule
    for (let i = 0; i < N; i++) {
      spawnFilament(i, pos, col, vel, trails, winds)
    }
    return { positions: pos, colors: col, velocities: vel, trailLengths: trails }
  }, [winds, nmToUnits])

  useFrame((_, dt) => {
    if (!visible || !ref.current) return
    const arr = ref.current.geometry.attributes.position.array as Float32Array
    const colArr = ref.current.geometry.attributes.color.array as Float32Array
    for (let i = 0; i < N; i++) {
      const vx = velocities[i * 3]
      const vy = velocities[i * 3 + 1]
      const vz = velocities[i * 3 + 2]
      // Avance la head (et la tail suit, restant à -velocity*trail dans
      // la direction du mouvement).
      arr[i * 6] += vx * dt
      arr[i * 6 + 1] += vy * dt
      arr[i * 6 + 2] += vz * dt
      // tail = head - velocity * trailLength
      const tl = trailLengths[i]
      arr[i * 6 + 3] = arr[i * 6] - vx * tl
      arr[i * 6 + 4] = arr[i * 6 + 1] - vy * tl
      arr[i * 6 + 5] = arr[i * 6 + 2] - vz * tl

      // Respawn si la head sort du dôme
      const x = arr[i * 6]
      const y = arr[i * 6 + 1]
      const z = arr[i * 6 + 2]
      const horizR = Math.sqrt(x * x + z * z)
      if (horizR > RADIUS - 0.3 || y > RADIUS - 0.5 || y < 0.4) {
        spawnFilament(i, arr, colArr, velocities, trailLengths, winds)
      }
    }
    ref.current.geometry.attributes.position.needsUpdate = true
    ref.current.geometry.attributes.color.needsUpdate = true
  })

  if (!visible) return null
  return (
    <lineSegments ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
      </bufferGeometry>
      <lineBasicMaterial
        vertexColors
        transparent
        opacity={0.85}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </lineSegments>
  )
}

// Place un filament (head + tail) à une position aléatoire dans le dôme,
// lui assigne la vitesse du niveau de pression le plus proche.
function spawnFilament(
  i: number,
  pos: Float32Array,
  col: Float32Array,
  vel: Float32Array,
  trails: Float32Array,
  winds: WindLevel[],
) {
  const r = Math.sqrt(Math.random()) * (RADIUS - 0.8)
  const theta = Math.random() * Math.PI * 2
  const yMax = winds.length > 0 ? Math.max(...winds.map((w) => w.y)) + 0.5 : RADIUS - 1
  const y = Math.random() * (yMax - 0.5) + 0.5
  const headX = r * Math.cos(theta)
  const headY = y
  const headZ = r * Math.sin(theta)

  // Niveau de vent le plus proche
  let closest: WindLevel | null = null
  let bestDelta = Infinity
  for (const w of winds) {
    const d = Math.abs(w.y - y)
    if (d < bestDelta) {
      closest = w
      bestDelta = d
    }
  }
  const c = closest ? new THREE.Color(closest.color) : new THREE.Color(0x67e8f9)

  // Vitesse visuelle découplée du rayon scène : on utilise une référence fixe
  // (équivalent 30 NM) pour que les traînes restent des traits visibles à
  // toutes les échelles (5/15/30/100 NM). Sans ça, à 100 NM nmToUnits=0.22
  // produit des traînes de 0.09 unités = points indiscernables.
  const VIZ_SPEED_FACTOR = 80
  const REF_NM_TO_UNITS = RADIUS / 30
  const speedUnitsPerSec = closest ? (closest.kt / 3600) * REF_NM_TO_UNITS * VIZ_SPEED_FACTOR : 0
  const towards = closest ? (closest.dirDeg + 180) % 360 : 0
  const dirRad = (towards * Math.PI) / 180
  const vx = speedUnitsPerSec * Math.sin(dirRad)
  const vz = -speedUnitsPerSec * Math.cos(dirRad)
  vel[i * 3] = vx
  vel[i * 3 + 1] = 0
  vel[i * 3 + 2] = vz

  // Trail : durée de "queue" en secondes. Trail visuel ∝ vitesse pour
  // que les vents forts laissent une plus longue traîne.
  const trailDur = 0.6 + (speedUnitsPerSec * 0.3) // 0.6 s à 1.5 s typique
  trails[i] = Math.min(2.5, trailDur)

  // Head opaque, tail à 30 % d'intensité (effet de fade)
  pos[i * 6] = headX
  pos[i * 6 + 1] = headY
  pos[i * 6 + 2] = headZ
  pos[i * 6 + 3] = headX - vx * trails[i]
  pos[i * 6 + 4] = headY
  pos[i * 6 + 5] = headZ - vz * trails[i]
  col[i * 6] = c.r
  col[i * 6 + 1] = c.g
  col[i * 6 + 2] = c.b
  col[i * 6 + 3] = c.r * 0.15
  col[i * 6 + 4] = c.g * 0.15
  col[i * 6 + 5] = c.b * 0.15
}

function WindMast({ visible, winds }: { visible: boolean; winds: WindLevel[] }) {
  if (!visible || winds.length === 0) return null
  const MAST_X = 1.5
  const MAST_Z = 0
  // Borne y pour que mât + flèche (~2.4) + label (~0.8) restent dans la sphère.
  // Distance max depuis le centre : sqrt(MAST_X² + y²) + projection label.
  // On choisit y_max tel que le point le plus éloigné reste < RADIUS.
  const Y_MAX = Math.sqrt(RADIUS * RADIUS - (MAST_X + 3) * (MAST_X + 3)) - 0.5
  const clampedWinds = winds.map((w) => ({ ...w, y: Math.min(w.y, Y_MAX) }))
  const topY = Math.max(...clampedWinds.map((w) => w.y)) + 1.5
  return (
    <group position={[MAST_X, 0, MAST_Z]}>
      {/* Mât vertical fin et discret */}
      <mesh position={[0, topY / 2, 0]}>
        <cylinderGeometry args={[0.05, 0.05, topY, 8]} />
        <meshBasicMaterial color={0x64748b} transparent opacity={0.45} />
      </mesh>
      {clampedWinds.map((w) => {
        const towards = (w.dirDeg + 180) % 360
        const dirRad = (towards * Math.PI) / 180
        const dx = Math.sin(dirRad)
        const dz = -Math.cos(dirRad)
        // Longueur cible modeste, indépendante du rayon scène : la force
        // s'exprime surtout par la couleur, pas par une flèche démesurée.
        const length = Math.min(2.4, 0.6 + w.kt / 50)
        return (
          <group key={w.label}>
            <ArrowHelperWrapper
              position={[0, w.y, 0]}
              dir={[dx, 0, dz]}
              length={length}
              color={w.color}
            />
            <WindMastLabel
              pos={[length + 0.4, w.y, 0]}
              level={w.label}
              dir={Math.round(w.dirDeg)}
              kt={Math.round(w.kt)}
              color={w.color}
            />
          </group>
        )
      })}
    </group>
  )
}

function WindMastLabel({
  pos,
  level,
  dir,
  kt,
  color,
}: {
  pos: [number, number, number]
  level: string
  dir: number
  kt: number
  color: number
}) {
  const text = `${level}  ${String(dir).padStart(3, '0')}°  ${kt} kt`
  const tex = useMemo(() => {
    const cvs = document.createElement('canvas')
    cvs.width = 256
    cvs.height = 48
    const ctx = cvs.getContext('2d')!
    ctx.fillStyle = 'rgba(15,23,42,0.7)'
    ctx.fillRect(0, 0, cvs.width, cvs.height)
    ctx.font = 'bold 22px ui-monospace, monospace'
    ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, 8, cvs.height / 2)
    return new THREE.CanvasTexture(cvs)
  }, [text, color])
  return (
    <sprite position={pos} scale={[2.6, 0.5, 1]}>
      <spriteMaterial map={tex} transparent depthTest={false} />
    </sprite>
  )
}

function ArrowHelperWrapper({
  position,
  dir,
  length,
  color,
}: {
  position: [number, number, number]
  dir: [number, number, number]
  length: number
  color: number
}) {
  const arrow = useMemo(() => {
    const a = new THREE.ArrowHelper(
      new THREE.Vector3(...dir).normalize(),
      new THREE.Vector3(...position),
      length,
      color,
      length * 0.25,
      length * 0.18,
    )
    return a
  }, [position, dir, length, color])
  return <primitive object={arrow} />
}

function Tropopause({ visible, y }: { visible: boolean; y: number }) {
  // Tropopause au-dessus du dôme = ne pas afficher (sinon on voit un disque
  // qui flotte hors-cadre).
  if (!visible || y > RADIUS - 0.5) return null
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, y, 0]}>
        <circleGeometry args={[RADIUS * 0.9, 64]} />
        <meshBasicMaterial
          color={0x38bdf8}
          transparent
          opacity={0.08}
          side={THREE.DoubleSide}
        />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, y, 0]}>
        <ringGeometry args={[RADIUS * 0.89, RADIUS * 0.9, 64]} />
        <meshBasicMaterial
          color={0x38bdf8}
          transparent
          opacity={0.5}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  )
}

function NeighborADs({ aerodromes }: { aerodromes: Aerodrome[] }) {
  return (
    <>
      {aerodromes.map((a) => (
        <group key={a.name} position={[a.x, 0.3, a.z]}>
          <mesh>
            <sphereGeometry args={[0.3, 16, 12]} />
            <meshStandardMaterial
              color={0x38bdf8}
              emissive={0x0284c7}
              emissiveIntensity={1}
            />
          </mesh>
          <Label3D position={[0, 1, 0]} text={a.name} width={2.2} />
        </group>
      ))}
    </>
  )
}

interface PlaneInstance {
  callsign: string
  x: number
  z: number
  y: number
  trackRad: number
  fl: number
  vsTrend: 'climb' | 'desc' | 'level'
  distNM: number
  // Vitesse-sol, taux de montée/descente et instant de la dernière position
  // connue, pour extrapoler la trajectoire (horizontale + verticale) entre
  // 2 updates OpenSky (toutes les 30 s).
  gsKt: number
  vrateMs: number // taux vertical en m/s (positif = montée)
  lastUpdateMs: number
}

// Échelle des avions adaptée à la distance caméra : ils restent perceptibles
// en vue large mais ne dominent pas la scène en zoom rapproché.
function planeScaleForCameraDist(d: number): number {
  if (d < 8) return 0.3
  if (d < 18) return 0.5
  if (d < 30) return 0.75
  if (d < 50) return 0.9
  return 1.0
}

function PlaneFleet({
  planes,
}: {
  planes: PlaneInstance[]
}) {
  const camera = useThree((s) => s.camera)
  const [camDist, setCamDist] = useState(50)
  useFrame(() => {
    const d = camera.position.length()
    if (Math.abs(d - camDist) > 1) setCamDist(d)
  })
  const scale = planeScaleForCameraDist(camDist)
  return (
    <>
      {planes.map((p) => (
        <Plane key={p.callsign} plane={p} scale={scale} />
      ))}
    </>
  )
}

// Plane : rendu simple à la position OpenSky (pas d'extrapolation côté client).
// Chaque fetch met à jour position + cap directement. Toute logique d'animation
// inter-fetch a été retirée (cf. CHANGELOG) : l'utilisateur préfère voir la
// position réelle ADS-B, quitte à avoir un saut à chaque update.
function Plane({
  plane,
  scale,
}: {
  plane: PlaneInstance
  scale: number
}) {
  // Couleurs selon phase de vol (climb/desc/level).
  const colors =
    plane.vsTrend === 'climb'
      ? { body: 0x4ade80, emissive: 0x16a34a }
      : plane.vsTrend === 'desc'
        ? { body: 0xfb923c, emissive: 0xc2410c }
        : { body: 0x22d3ee, emissive: 0x0891b2 }

  // Visibilité : on masque si la position sort du dôme scène.
  const horizR = Math.sqrt(plane.x * plane.x + plane.z * plane.z)
  const visible =
    horizR <= RADIUS && plane.y >= 0.3 && plane.y <= RADIUS

  return (
    <group
      position={[plane.x, plane.y, plane.z]}
      rotation={[0, plane.trackRad, 0]}
      scale={[scale, scale, scale]}
      visible={visible}
    >
      {/* Convention locale : nez vers -Z (= nord du repère parent quand
          trackRad=0). La queue (base du cone) est à +Z, l'aile sur X,
          l'empennage vertical à +Z et au-dessus. */}
      {/* Fuselage : cone effilé, pointe vers -Z après rotation X. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <coneGeometry args={[0.32, 2.4, 12]} />
        <meshBasicMaterial color={colors.body} />
      </mesh>
      {/* Aile principale, sur X, légèrement en arrière du centre fuselage. */}
      <mesh position={[0, 0, 0.15]}>
        <boxGeometry args={[3.0, 0.10, 0.55]} />
        <meshBasicMaterial color={colors.body} />
      </mesh>
      {/* Empennage horizontal (stabilo), petit, plus en arrière. */}
      <mesh position={[0, 0, 1.05]}>
        <boxGeometry args={[1.1, 0.08, 0.32]} />
        <meshBasicMaterial color={colors.body} />
      </mesh>
      {/* Dérive (empennage vertical) : repère ARRIÈRE explicite. */}
      <mesh position={[0, 0.32, 1.0]}>
        <boxGeometry args={[0.08, 0.55, 0.45]} />
        <meshBasicMaterial color={colors.body} />
      </mesh>
      {/* Halo lumineux discret pour lisibilité contre le fond noir */}
      <mesh>
        <sphereGeometry args={[0.4, 12, 8]} />
        <meshBasicMaterial color={colors.emissive} transparent opacity={0.35} />
      </mesh>
      <PlaneLabel callsign={plane.callsign} fl={plane.fl} vsTrend={plane.vsTrend} />
    </group>
  )
}

function PlaneLabel({
  callsign,
  fl,
  vsTrend,
}: {
  callsign: string
  fl: number
  vsTrend: 'climb' | 'desc' | 'level'
}) {
  const tex = useMemo(() => {
    const cvs = document.createElement('canvas')
    cvs.width = 256
    cvs.height = 48
    const ctx = cvs.getContext('2d')!
    ctx.font = 'bold 22px ui-monospace, monospace'
    const color =
      vsTrend === 'climb' ? '#86efac' : vsTrend === 'desc' ? '#fdba74' : '#67e8f9'
    const arrow = vsTrend === 'climb' ? '↑' : vsTrend === 'desc' ? '↓' : '→'
    ctx.fillStyle = color
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(
      `${callsign}  FL${String(fl).padStart(3, '0')} ${arrow}`,
      cvs.width / 2,
      cvs.height / 2,
    )
    return new THREE.CanvasTexture(cvs)
  }, [callsign, fl, vsTrend])
  return (
    <sprite position={[0, 0.6, 0]} scale={[3, 0.6, 1]}>
      <spriteMaterial map={tex} transparent depthTest={false} />
    </sprite>
  )
}

// ───────────────────────────────────────────────────────────────────────
// Page TowerGlobe
// ───────────────────────────────────────────────────────────────────────

interface TowerGlobeProps {
  // À l'avenir : icao sélectionné, données live, etc.
}

export default function TowerGlobe({}: TowerGlobeProps) {
  const [icao, setIcao] = useState('LFPG')
  const [sceneRangeNm, setSceneRangeNm] = useState<RangePreset>(30)
  const nmToUnits = RADIUS / sceneRangeNm
  const maxFL = maxFLForRange(sceneRangeNm)
  const metersPerUnit = metersPerUnitForRange(sceneRangeNm)
  const tropoY = TROPOPAUSE_M / metersPerUnit
  // 4 niveaux vent calculés dynamiquement selon le cap d'altitude.
  const windLevels = useMemo(
    () =>
      windLevelsForMaxFL(maxFL).map((l) => ({
        ...l,
        y: l.altM / metersPerUnit,
      })),
    [maxFL, metersPerUnit],
  )
  const [minFL, setMinFL] = useState(0)
  const [showTropo, setShowTropo] = useState(true)
  const [showWind, setShowWind] = useState(true)
  const [showWindParticles, setShowWindParticles] = useState(false)
  const [showLegend, setShowLegend] = useState(false)
  const [showLightning, setShowLightning] = useState(true)
  const [liveFlashes, setLiveFlashes] = useState<Lightning[]>([])
  const [flashCount, setFlashCount] = useState({ in: 0, fetched: 0 })
  const [liveCells, setLiveCells] = useState<Cell[]>([])
  const [cellCount, setCellCount] = useState({ in: 0, fetched: 0 })
  const [liveWinds, setLiveWinds] = useState<WindLevel[]>([])
  const [liveMetar, setLiveMetar] = useState<OpmetMessage | null>(null)
  const [liveTaf, setLiveTaf] = useState<OpmetMessage | null>(null)
  const [liveWl, setLiveWl] = useState<OpmetMessage | null>(null)
  const [showMetarPanel, setShowMetarPanel] = useState(true)
  const [livePlanes, setLivePlanes] = useState<PlaneInstance[]>([])
  const [airportInfo, setAirportInfo] = useState<{
    lat: number
    lon: number
    name: string
    runways: RunwayGeo[]
  } | null>(null)
  const controlsRef = useRef<typeof OrbitControls.prototype | null>(null)

  // Reset des states live à chaque changement d'aéroport ou de rayon scène
  // pour éviter d'afficher temporairement les avions/cellules/foudre du
  // précédent aéroport avec un référentiel devenu obsolète.
  // Reset des données live à chaque changement d'aéroport OU de rayon.
  // airportInfo (pistes, coords) ne dépend que de l'ICAO : on le reset uniquement
  // au changement d'aéroport pour éviter que les pistes disparaissent en changeant de rayon.
  useEffect(() => {
    setLivePlanes([])
    setLiveCells([])
    setLiveFlashes([])
    setLiveWinds([])
    setLiveMetar(null)
    setLiveTaf(null)
    setLiveWl(null)
    setFlashCount({ in: 0, fetched: 0 })
    setCellCount({ in: 0, fetched: 0 })
  }, [icao, sceneRangeNm])

  useEffect(() => {
    setAirportInfo(null)
  }, [icao])

  // Aérodromes voisins dans le rayon du dôme : on parcourt la table AIRPORTS
  // et on convertit en coords scène ceux à moins de sceneRangeNm. À terme,
  // ce calcul devrait s'appuyer sur l'ICAOIndex MetGate complet (~ 12k AD)
  // côté backend pour ne pas être limité aux 16 entrées hardcodées.
  const neighbors = useMemo<Aerodrome[]>(() => {
    const ap = airportInfo ?? AIRPORTS[icao]
    if (!ap) return []
    const out: Aerodrome[] = []
    for (const [code, info] of Object.entries(AIRPORTS)) {
      if (code === icao) continue
      const dist = distanceNM(ap.lat, ap.lon, info.lat, info.lon)
      if (dist > sceneRangeNm) continue
      const [x, , z] = toSceneCoords(ap, info.lat, info.lon, 0, nmToUnits)
      out.push({ name: code, x, z })
    }
    return out
  }, [icao, sceneRangeNm, nmToUnits, airportInfo])

  // Fetch info aérodrome (position + pistes) depuis OurAirports via backend.
  // Met à jour la position de référence pour la conversion 3D et la liste
  // des pistes à afficher.
  useEffect(() => {
    let aborted = false
    fetch(`/api/airport/${icao}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (aborted || !d) return
        const ap = d.airport
        const rwys: RunwayGeo[] = (d.runways ?? [])
          .filter(
            (r: { LeLat: number; LeLon: number; HeLat: number; HeLon: number }) =>
              r.LeLat !== 0 && r.HeLat !== 0,
          )
          .map((r: {
            LeLat: number
            LeLon: number
            HeLat: number
            HeLon: number
            LengthFt: number
            WidthFt: number
            LeIdent: string
            HeIdent: string
          }) => ({
            leLat: r.LeLat,
            leLon: r.LeLon,
            heLat: r.HeLat,
            heLon: r.HeLon,
            lengthFt: r.LengthFt,
            widthFt: r.WidthFt,
            leIdent: r.LeIdent,
            heIdent: r.HeIdent,
          }))
        setAirportInfo({
          lat: ap.Lat,
          lon: ap.Lon,
          name: ap.Name,
          runways: rwys,
        })
      })
      .catch(() => {})
    return () => {
      aborted = true
    }
  }, [icao]) // Ne pas inclure airportInfo : le mettre ici crée une boucle (setAirportInfo → re-run → setAirportInfo…)

  // Fetch live des impacts foudre EUMETSAT MTG-LI autour de l'aérodrome.
  // On demande une bbox monde (déjà filtrée à 14k flashes/10 min côté backend),
  // puis on filtre en local par rayon (25 NM = bord du dôme).
  useEffect(() => {
    const ap = airportInfo ?? AIRPORTS[icao]
    if (!ap) return
    let aborted = false
    const fetchOnce = () => {
      // bbox 5° autour de l'aéroport pour réduire la charge réseau
      const dlat = 5
      const dlon = 5 / Math.max(0.3, Math.cos((ap.lat * Math.PI) / 180))
      const bbox = `${ap.lon - dlon},${ap.lat - dlat},${ap.lon + dlon},${ap.lat + dlat}`
      fetch(`/api/lightning?bbox=${bbox}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (aborted || !d) return
          const total = d.features?.length ?? 0
          const inDome: Lightning[] = []
          for (const f of d.features ?? []) {
            const [lon, lat] = f.geometry?.coordinates ?? []
            if (typeof lat !== 'number' || typeof lon !== 'number') continue
            const dist = distanceNM(ap.lat, ap.lon, lat, lon)
            if (dist > sceneRangeNm) continue
            // Altitude du flash : pas dispo dans LFL → on positionne entre
            // FL050 (4 unités) et FL400 (15 unités) selon la radiance pour
            // donner une perception de hauteur. On variabilise aussi avec un
            // hash de la position pour ne pas tout aligner sur un même plan.
            const rad = (f.properties?.radiance as number) ?? 50
            // Altitude flash : LFL ne fournit pas la 3D verticale. On
            // positionne entre 30 % et 90 % de la hauteur du dôme selon la
            // radiance (intensité optique = grossièrement profondeur cellule).
            const radNorm = Math.min(1, Math.log10(Math.max(rad, 1)) / 2.5)
            const yBase = RADIUS * (0.3 + 0.6 * radNorm)
            const jitter = (((lat * 1000 + lon * 1000) % 7) - 3) * 0.3
            const yClamp = Math.max(1, Math.min(RADIUS - 0.5, yBase + jitter))
            const [x, y, z] = toSceneCoords(ap, lat, lon, yClamp, nmToUnits)
            inDome.push({ x, y, z })
          }
          setLiveFlashes(inDome)
          setFlashCount({ in: inDome.length, fetched: total })
        })
        .catch(() => {})
    }
    fetchOnce()
    const id = window.setInterval(fetchOnce, 60_000)
    return () => {
      aborted = true
      window.clearInterval(id)
    }
  }, [icao, sceneRangeNm, nmToUnits, airportInfo])

  // Fetch live des cellules orageuses depuis deux produits complémentaires :
  //  - RDT_MSG_last  : échelle mondiale MSG/SEVIRI, hauteurs en mètres
  //  - OPIC_GTD_last : produit local France/Europe OPIC, hauteurs en FL
  // On fusionne les deux ; le filtre par sceneRangeNm écarte les cellules hors dôme.
  useEffect(() => {
    const ap = airportInfo ?? AIRPORTS[icao]
    if (!ap) return
    let aborted = false
    const fetchOnce = async () => {
      const [rdtRes, opicRes] = await Promise.all([
        fetch('/api/feature?type=RDT_MSG_last&count=2000').then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch('/api/feature?type=OPIC_GTD_last&count=2000').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ])
      if (aborted) return
      const totalFetched = (rdtRes?.features?.length ?? 0) + (opicRes?.features?.length ?? 0)
      const inDome: Cell[] = []

      // RDT_MSG : unbiasedforecastupperboundary en mètres
      for (const f of rdtRes?.features ?? []) {
        if (f.geometry?.type !== 'Polygon') continue
        const c = polygonCentroid(f.geometry.coordinates)
        if (!c) continue
        const [lon, lat] = c
        if (distanceNM(ap.lat, ap.lon, lat, lon) > sceneRangeNm) continue
        const props = f.properties ?? {}
        const topMRaw = props.unbiasedforecastupperboundary
        const topM = typeof topMRaw === 'number' ? topMRaw : Number(topMRaw) || 0
        if (topM <= 0) continue
        const fl = Math.round(topM / 30.48 / 10) * 10
        if (topM / 30.48 > maxFL + 50) continue
        const topUnits = Math.min(RADIUS - 1, topM / metersPerUnit)
        const [x, , z] = toSceneCoords(ap, lat, lon, 0, nmToUnits)
        inDome.push({
          x, z, topUnits, fl,
          color: colorForFL(fl),
          label: labelForCell(fl, props.hail === 'true' || props.hail === true, Number(props.severity ?? 0)),
        })
      }

      // OPIC_GTD : maxforecastupperboundary en FL (ex. 400 = FL400 → 400×30.48 m)
      for (const f of opicRes?.features ?? []) {
        if (f.geometry?.type !== 'Polygon') continue
        const c = polygonCentroid(f.geometry.coordinates)
        if (!c) continue
        const [lon, lat] = c
        if (distanceNM(ap.lat, ap.lon, lat, lon) > sceneRangeNm) continue
        const props = f.properties ?? {}
        const topFLRaw = props.maxforecastupperboundary
        const topFL = typeof topFLRaw === 'number' ? topFLRaw : Number(topFLRaw) || 0
        if (topFL <= 0) continue
        const fl = Math.round(topFL / 10) * 10
        if (topFL > maxFL + 50) continue
        const topM = topFL * 30.48 // FL → m
        const topUnits = Math.min(RADIUS - 1, topM / metersPerUnit)
        const [x, , z] = toSceneCoords(ap, lat, lon, 0, nmToUnits)
        inDome.push({
          x, z, topUnits, fl,
          color: colorForFL(fl),
          label: labelForCell(fl, props.hail === 'true' || props.hail === true, Number(props.severity ?? 0)),
        })
      }

      setLiveCells(inDome)
      setCellCount({ in: inDome.length, fetched: totalFetched })
    }
    fetchOnce()
    const id = window.setInterval(fetchOnce, 5 * 60_000)
    return () => {
      aborted = true
      window.clearInterval(id)
    }
  }, [icao, sceneRangeNm, nmToUnits, airportInfo])

  // Fetch live des vents en altitude depuis WCS WIND. 4 niveaux en parallèle,
  // bbox petite autour de l'aéroport (1° lat × 1°/cos(lat) lon), valeur
  // échantillonnée au pixel central de la grille retournée.
  useEffect(() => {
    const ap = airportInfo ?? AIRPORTS[icao]
    if (!ap) return
    let aborted = false
    const fetchWinds = async () => {
      const dlat = 1
      const dlon = 1 / Math.max(0.3, Math.cos((ap.lat * Math.PI) / 180))
      const bbox = `${ap.lon - dlon},${ap.lat - dlat},${ap.lon + dlon},${ap.lat + dlat}`
      const results = await Promise.all(
        windLevels.map((lvl) =>
          fetch(`/api/wind?dataset=WIND&level=${lvl.pa}&bbox=${bbox}`)
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null),
        ),
      )
      if (aborted) return
      const winds: WindLevel[] = []
      results.forEach((res, i) => {
        if (!res || !Array.isArray(res.u) || !Array.isArray(res.v)) return
        const w = res.width
        const h = res.height
        if (!w || !h) return
        const mid = Math.floor(h / 2) * w + Math.floor(w / 2)
        const u = res.u[mid] ?? 0
        const v = res.v[mid] ?? 0
        const speedMs = Math.sqrt(u * u + v * v)
        const kt = speedMs * 1.94384
        const dirDeg = ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360
        winds.push({
          y: windLevels[i].y,
          dirDeg,
          kt,
          color: colorForWindKt(kt),
          label: windLevels[i].label,
        })
      })
      setLiveWinds(winds)
    }
    fetchWinds()
    const id = window.setInterval(fetchWinds, 5 * 60_000)
    return () => {
      aborted = true
      window.clearInterval(id)
    }
  }, [icao, sceneRangeNm, nmToUnits, windLevels, airportInfo])

  // Fetch METAR / TAF / WL pour l'aérodrome sélectionné.
  // Pour METAR : essaie d'abord METAR_last (IWXXM, couverture mondiale hors Allemagne),
  // puis fallback sur SA_last (format plat MetGate, couvre les indicateurs ED*).
  useEffect(() => {
    let aborted = false
    const fetchOpmet = async (kind: 'METAR' | 'TAF' | 'WL') => {
      const r = await fetch(`/api/feature?type=${kind}_last&count=2000`)
      if (!r.ok) return null
      const d = await r.json()
      const match = (d.features ?? []).find((f: { properties?: Record<string, unknown> }) => {
        const p = f.properties ?? {}
        return (
          p.locationIndicatorICAO === icao ||
          p.icao === icao ||
          (typeof p.tac === 'string' && (p.tac as string).includes(icao))
        )
      })
      if (match) {
        const props = match.properties ?? {}
        return {
          tac: props.tac as string | undefined,
          decoded: props.decoded as string | undefined,
          time:
            (props.observationTime as string | undefined) ??
            (props.timeposition as string | undefined) ??
            (props.validitystarttime as string | undefined),
          raw: props,
        } as OpmetMessage
      }
      // Fallback sur les produits plats MetGate (champ `id`) pour les aéroports
      // absents des flux IWXXM (ex. ED* Allemagne, K* USA, pays de l'est).
      const FLAT_FALLBACKS: Record<string, string[]> = {
        METAR: ['SA_last'],
        TAF:   ['FT_last', 'FC_last'],
      }
      const flatTypes = FLAT_FALLBACKS[kind] ?? []
      for (const flatType of flatTypes) {
        const r2 = await fetch(`/api/feature?type=${flatType}&count=2000`)
        if (!r2.ok) continue
        const d2 = await r2.json()
        const match2 = (d2.features ?? []).find(
          (f: { properties?: Record<string, unknown> }) => (f.properties ?? {}).id === icao,
        )
        if (!match2) continue
        const props2 = match2.properties ?? {}
        return {
          tac: props2.tac as string | undefined,
          decoded: undefined,
          time: props2.analysis_time as string | undefined,
          raw: props2,
        } as OpmetMessage
      }
      return null
    }
    const fetchAll = async () => {
      const [m, t, w] = await Promise.all([
        fetchOpmet('METAR'),
        fetchOpmet('TAF'),
        fetchOpmet('WL'),
      ])
      if (aborted) return
      setLiveMetar(m)
      setLiveTaf(t)
      setLiveWl(w)
    }
    fetchAll()
    const id = window.setInterval(fetchAll, 5 * 60_000)
    return () => {
      aborted = true
      window.clearInterval(id)
    }
    // METAR/TAF/WL ne dépendent que de l'ICAO (filtrage côté frontend par
    // locationIndicatorICAO) — pas besoin de re-fetcher au changement de
    // rayon scène ou de airportInfo.
  }, [icao])

  // Fetch live des avions ADS-B autour de l'aérodrome via OpenSky.
  // Bbox 1.5° (~ 90 NM en lat) pour avoir ~ tout le dôme + marge. Refresh
  // 30 s (le quota OpenSky est limité, mais 30 s reste raisonnable).
  // Refs pour permettre au polling ADS-B de lire les valeurs courantes
  // (rayon scène, conversion d'échelle) sans re-déclencher le useEffect à
  // chaque changement — sinon les cascades de re-renders au mount font
  // partir 5-10 fetches en parallèle, qui retournent tous 502 ensemble.
  const adsbCtxRef = useRef({
    ap: airportInfo ?? AIRPORTS[icao] ?? null,
    sceneRangeNm,
    nmToUnits,
    metersPerUnit,
  })
  adsbCtxRef.current = {
    ap: airportInfo ?? AIRPORTS[icao] ?? null,
    sceneRangeNm,
    nmToUnits,
    metersPerUnit,
  }

  useEffect(() => {
    let aborted = false
    let timeoutId: number | null = null
    const fetchPlanes = async () => {
      const gate = adsbCanFireNow()
      if (!gate.ok) {
        timeoutId = window.setTimeout(fetchPlanes, gate.waitMs)
        return
      }
      const ctx = adsbCtxRef.current
      const ap = ctx.ap
      if (!ap) {
        // Pas d'aéroport encore résolu : on retente bientôt sans pénalité.
        timeoutId = window.setTimeout(fetchPlanes, 1000)
        return
      }
      const dlat = 1.5
      const dlon = 1.5 / Math.max(0.3, Math.cos((ap.lat * Math.PI) / 180))
      const bbox = `${ap.lon - dlon},${ap.lat - dlat},${ap.lon + dlon},${ap.lat + dlat}`
      adsbMarkAttempt()
      try {
        const r = await fetch(`/api/aircraft/search?bbox=${bbox}`)
        if (r.ok) {
          const d = await r.json()
          if (d && typeof d.error === 'string' && d.error) {
            // Le backend répond 200 + liste vide (pour ne pas faire spammer
            // le front) mais signale une erreur amont (OpenSky 429 typique) :
            // on enclenche quand même le back-off.
            adsbMarkError()
          } else {
            adsbMarkSuccess()
          }
          if (aborted) return
          processStates(d.states ?? [])
        } else {
          adsbMarkError()
        }
      } catch {
        adsbMarkError()
      }
      if (aborted) return
      // On replanifie : le prochain tick respectera adsbCanFireNow().
      timeoutId = window.setTimeout(fetchPlanes, ADSB_MIN_INTERVAL_MS)
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const processStates = (states: any[]) => {
      const ctx = adsbCtxRef.current
      const ap = ctx.ap
      if (!ap) return
      const sceneRangeNm = ctx.sceneRangeNm
      const nmToUnits = ctx.nmToUnits
      const metersPerUnit = ctx.metersPerUnit
      const out: PlaneInstance[] = []
      for (const s of states) {
        if (typeof s.lat !== 'number' || typeof s.lon !== 'number') continue
        // Filtres : on ne montre pas les avions au sol ni immobiles, ni
        // ceux dont la position remontée par OpenSky est obsolète (l'API
        // garde en cache les dernières positions connues même quand un
        // avion a perdu le contact ADS-B — sinon on voit des « fantômes »
        // qui rejouent en boucle leur dernière approche).
        if (s.on_ground === true) continue
        const fl = typeof s.fl === 'number' ? s.fl : 0
        if (fl === 0) continue
        const gs = typeof s.gs_kt === 'number' ? s.gs_kt : 0
        if (gs < 30) continue
        // Position obsolète : > 90 s depuis le dernier rapport ADS-B.
        const tPos = typeof s.time_position === 'number' ? s.time_position : 0
        if (tPos > 0 && Date.now() / 1000 - tPos > 90) continue

        const dist = distanceNM(ap.lat, ap.lon, s.lat, s.lon)
        if (dist > sceneRangeNm) continue
        // Hauteur scène = altitude (FL × 30.48 m) / metersPerUnit, bornée
        // au cap visuel (RADIUS).
        const altM = fl * 30.48
        const yUnits = Math.max(0.4, Math.min(RADIUS - 0.5, altM / metersPerUnit))
        const [x, , z] = toSceneCoords(ap, s.lat, s.lon, yUnits, nmToUnits)
        const trackDeg = typeof s.true_track_deg === 'number' ? s.true_track_deg : 0
        const trackRad = (-trackDeg * Math.PI) / 180
        const vrate = typeof s.vertical_rate_ms === 'number' ? s.vertical_rate_ms : 0
        // lastUpdateMs = instant du dernier message ADS-B (pas de l'API poll).
        // OpenSky garde la dernière position connue et la renvoie à chaque
        // poll même quand l'avion n'a pas émis de nouveau ADS-B. Si on
        // utilisait Date.now() ici, le useEffect côté AnimatedPlane se
        // déclencherait tous les 30 s (rythme du poll), réinitialisant
        // l'extrapolation à 0 → l'avion paraît "rebooter" à sa dernière
        // position connue toutes les 30 s. En utilisant time_position,
        // l'extrapolation continue tant qu'aucun vrai nouveau point n'arrive.
        const lastUpdateMs =
          typeof s.time_position === 'number' && s.time_position > 0
            ? s.time_position * 1000
            : Date.now()
        out.push({
          callsign: (s.callsign ?? '').trim() || s.icao24 || '????',
          x,
          y: yUnits,
          z,
          trackRad,
          fl,
          vsTrend: vrate > 1 ? 'climb' : vrate < -1 ? 'desc' : 'level',
          distNM: dist,
          gsKt: gs,
          vrateMs: vrate,
          lastUpdateMs,
        })
      }
      out.sort((a, b) => a.distNM - b.distNM)
      setLivePlanes(out.slice(0, 20)) // borne pour ne pas saturer la scène
    }
    fetchPlanes()
    return () => {
      aborted = true
      if (timeoutId) window.clearTimeout(timeoutId)
    }
    // Volontairement *seulement* `[icao]` : sceneRangeNm / nmToUnits /
    // airportInfo / metersPerUnit changent en cascade au mount et provoquent
    // des re-runs qui faisaient partir 5-10 fetches en parallèle. On lit
    // toujours les valeurs courantes via adsbCtxRef.current.
  }, [icao])

  return (
    <div className="relative h-[calc(100vh-72px)]">
      <Canvas
        camera={{ position: [35, 28, 35], fov: 45, near: 0.1, far: 1000 }}
        gl={{ antialias: true, alpha: false }}
        style={{ background: '#020617' }}
      >
        <Suspense fallback={null}>
          <fog attach="fog" args={[0x020617, 60, 220]} />
          <ambientLight color={0x6080a0} intensity={0.45} />
          <directionalLight color={0xfff2d0} intensity={1.2} position={[40, 60, 30]} />
          <directionalLight color={0x88aaff} intensity={0.4} position={[-30, 40, -30]} />
          <Stars radius={250} depth={50} count={600} factor={4} fade={false} />

          <Dome />
          <Ground />
          <CardinalRing />
          <Airport
            icao={icao}
            apLat={airportInfo?.lat ?? AIRPORTS[icao]?.lat ?? 0}
            apLon={airportInfo?.lon ?? AIRPORTS[icao]?.lon ?? 0}
            runways={airportInfo?.runways ?? []}
            nmToUnits={nmToUnits}
          />
          <Tropopause visible={showTropo} y={tropoY} />
          <WindMast visible={showWind} winds={liveWinds} />
          <WindParticles
            visible={showWindParticles}
            winds={liveWinds}
            nmToUnits={nmToUnits}
          />
          <LightningSprites visible={showLightning} flashes={liveFlashes} />
          <NeighborADs aerodromes={neighbors} />
          <PlaneFleet planes={livePlanes} />
          {liveCells.map((c, i) => (
            <CellMesh key={i} cell={c} hidden={c.fl < minFL} />
          ))}

          <OrbitControls
            ref={controlsRef}
            enableDamping
            dampingFactor={0.08}
            minDistance={3}
            maxDistance={150}
            maxPolarAngle={Math.PI * 0.49}
            target={[0, 2, 0]}
          />
        </Suspense>
      </Canvas>

      {/* HUD top-left : sélecteur aéroport */}
      <div className="absolute top-4 left-4 z-10 px-3 py-2 rounded-lg bg-slate-950/80 backdrop-blur-md border border-slate-800 min-w-[240px] shadow-2xl">
        <div className="text-[0.625rem] uppercase tracking-wider text-cyan-300 font-semibold mb-1">
          Aérodrome
        </div>
        <AirportSearch icao={icao} onSelect={setIcao} />
        <div className="mt-1.5 text-[0.5625rem] text-slate-500 font-mono">
          UTC {new Date().toISOString().slice(11, 16)}
        </div>
        {/* Sélecteur de rayon scène : adapte la taille du dôme au cas
            d'usage opérationnel (TWR / APP / briefing étendu). */}
        <div className="mt-1.5 border-t border-slate-800/60 pt-1.5">
          <div className="text-[0.5rem] uppercase tracking-wider text-slate-500 mb-1">
            Rayon
          </div>
          <div className="flex gap-1">
            {RANGE_PRESETS_NM.map((nm) => (
              <button
                key={nm}
                onClick={() => setSceneRangeNm(nm)}
                className={`flex-1 px-1 py-0.5 rounded text-[0.5625rem] font-mono tabular-nums border transition ${
                  sceneRangeNm === nm
                    ? 'bg-cyan-500/20 border-cyan-400/50 text-cyan-100'
                    : 'border-slate-800 text-slate-400 hover:bg-slate-900/60'
                }`}
                title={
                  nm === 5
                    ? 'Tour / finale courte'
                    : nm === 15
                      ? 'TWR + finale étendue'
                      : nm === 30
                        ? 'TMA / approche'
                        : 'Briefing étendu'
                }
              >
                {nm} NM
              </button>
            ))}
          </div>
        </div>
        <div className="mt-1.5 flex items-center gap-2 text-[0.5625rem] border-t border-slate-800/60 pt-1.5">
          <Zap className="size-3 text-amber-300" />
          <span className="text-slate-400">Foudre dôme</span>
          <span className="ml-auto font-mono">
            <span className="text-amber-200">{flashCount.in}</span>
            <span className="text-slate-500"> / {flashCount.fetched} reg.</span>
          </span>
        </div>
        <div className="mt-1 flex items-center gap-2 text-[0.5625rem]">
          <span className="size-3 text-rose-300 inline-block">▮</span>
          <span className="text-slate-400">Cellules RDT</span>
          <span className="ml-auto font-mono">
            <span className="text-rose-200">{cellCount.in}</span>
            <span className="text-slate-500"> / {cellCount.fetched} mond.</span>
          </span>
        </div>
        <div className="mt-1 flex items-center gap-2 text-[0.5625rem]">
          <span className="size-3 text-cyan-300 inline-block">✈</span>
          <span className="text-slate-400">Trafic ADS-B</span>
          <span className="ml-auto font-mono">
            <span className="text-cyan-200">{livePlanes.length}</span>
          </span>
        </div>
        {liveWinds.length > 0 && (
          <div className="mt-1.5 border-t border-slate-800/60 pt-1.5 space-y-0.5">
            <div className="text-[0.5rem] uppercase tracking-wider text-slate-500">Vents</div>
            {liveWinds.map((w) => (
              <div key={w.label} className="flex items-center gap-2 text-[0.5625rem] font-mono">
                <span className="text-slate-500 w-10">{w.label}</span>
                <span className="text-slate-300 w-10 text-right">{Math.round(w.dirDeg)}°</span>
                <span
                  className="w-12 text-right"
                  style={{
                    color: `#${w.color.toString(16).padStart(6, '0')}`,
                  }}
                >
                  {Math.round(w.kt)} kt
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <AlertsPanel
        cells={liveCells}
        flashes={liveFlashes}
        wl={liveWl}
      />

      {/* HUD bottom-right : slider FL + toggles */}
      <div className="absolute bottom-4 right-4 z-10 px-3 py-2 rounded-lg bg-slate-950/80 backdrop-blur-md border border-violet-900/40 min-w-[280px] shadow-2xl">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[0.5625rem] uppercase tracking-wider text-violet-300">
            Filtre FL
          </span>
          <input
            type="range"
            min={0}
            max={500}
            step={50}
            value={minFL}
            onChange={(e) => setMinFL(+e.target.value)}
            className="flex-1 accent-violet-400"
          />
          <span className="text-violet-200 font-mono tabular-nums w-12 text-right text-[0.6875rem]">
            FL{String(minFL).padStart(3, '0')}
          </span>
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[0.625rem] text-slate-300 border-t border-slate-800/60 pt-1.5">
          <ToggleCheckbox checked={showTropo} onChange={setShowTropo} label="tropopause" />
          <ToggleCheckbox checked={showWind} onChange={setShowWind} label="vents" />
          <ToggleCheckbox
            checked={showLightning}
            onChange={setShowLightning}
            label="foudre"
          />
          <ToggleCheckbox
            checked={showWindParticles}
            onChange={setShowWindParticles}
            label="flux 3D"
          />
          <ToggleCheckbox
            checked={showLegend}
            onChange={setShowLegend}
            label="légende"
          />
        </div>
      </div>

      {/* HUD bottom-left : presets caméra */}
      <CameraPresets controlsRef={controlsRef} />

      {showLegend && <LegendPanel onClose={() => setShowLegend(false)} />}

      <MetarPanel
        metar={liveMetar}
        taf={liveTaf}
        wl={liveWl}
        visible={showMetarPanel}
        onToggle={() => setShowMetarPanel((v) => !v)}
      />
    </div>
  )
}

function ToggleCheckbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <label className="flex items-center gap-1.5 cursor-pointer hover:text-slate-100">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-violet-400"
      />
      {checked ? <Eye className="size-3" /> : <EyeOff className="size-3 opacity-50" />}
      <span>{label}</span>
    </label>
  )
}

function CameraPresets({
  controlsRef,
}: {
  controlsRef: React.MutableRefObject<typeof OrbitControls.prototype | null>
}) {
  // Les presets manipulent la position de la caméra via le ref OrbitControls.
  // L'objet a une propriété .object (la caméra) et .target.
  const setView = (pos: [number, number, number], target: [number, number, number] = [0, 5, 0]) => {
    const c = controlsRef.current as unknown as {
      object: THREE.PerspectiveCamera
      target: THREE.Vector3
      update: () => void
    } | null
    if (!c) return
    c.object.position.set(...pos)
    c.target.set(...target)
    c.update()
  }
  return (
    <div className="absolute bottom-4 left-4 z-10 flex items-center gap-1.5 px-2 py-2 rounded-lg bg-slate-950/80 backdrop-blur-md border border-slate-800 shadow-2xl">
      <span className="text-[0.5625rem] uppercase tracking-wider text-slate-500 font-mono px-1">
        Caméra
      </span>
      <button
        onClick={() => setView([35, 28, 35])}
        className="size-8 rounded hover:bg-slate-800 flex items-center justify-center text-slate-300"
        title="Reset"
      >
        <RotateCcw className="size-3.5" />
      </button>
      <button
        onClick={() => setView([0.01, 60, 0.01])}
        className="size-8 rounded hover:bg-slate-800 flex items-center justify-center text-slate-300"
        title="Vue dessus"
      >
        <ArrowDown className="size-3.5" />
      </button>
      <button
        onClick={() => setView([50, 8, 0])}
        className="size-8 rounded hover:bg-slate-800 flex items-center justify-center text-slate-300"
        title="Vue côté"
      >
        <ArrowRight className="size-3.5" />
      </button>
      <button
        onClick={() => setView([5, 4, 5], [0, 0.5, 0])}
        className="px-2 h-8 rounded hover:bg-slate-800 text-[0.5625rem] uppercase tracking-wider text-slate-300 font-mono"
        title="Vue rapprochée pistes"
      >
        Pistes
      </button>
    </div>
  )
}

// AlertsPanel calcule en live les alertes à afficher selon les données live :
//   - cellules actives FL ≥ 350 dans le dôme (Cb dangereux)
//   - foudre proche (compteur dôme)
//   - WL/MAA actif
function AlertsPanel({
  cells,
  flashes,
  wl,
}: {
  cells: Cell[]
  flashes: Lightning[]
  wl: OpmetMessage | null
}) {
  const items = useMemo(() => {
    const out: { color: string; label: string }[] = []
    const dangerCells = cells.filter((c) => c.fl >= 350)
    if (dangerCells.length > 0) {
      const top = dangerCells.reduce((a, b) => (a.fl >= b.fl ? a : b))
      out.push({
        color: 'red',
        label: `${dangerCells.length} cellule(s) Cb · max FL${top.fl}`,
      })
    }
    if (flashes.length > 0) {
      out.push({ color: 'amber', label: `Foudre · ${flashes.length} impacts dôme` })
    }
    if (wl?.tac) {
      out.push({ color: 'violet', label: 'Aerodrome Warning actif' })
    }
    if (out.length === 0) {
      out.push({ color: 'emerald', label: 'Aucune alerte active' })
    }
    return out
  }, [cells, flashes, wl])

  const allClear = items.length === 1 && items[0].color === 'emerald'
  return (
    <div
      className={`absolute top-4 right-4 z-10 px-3 py-2 rounded-lg backdrop-blur-md max-w-[280px] shadow-2xl ${
        allClear
          ? 'bg-emerald-950/40 border border-emerald-500/40'
          : 'bg-red-950/40 border border-red-500/40'
      }`}
    >
      <div className="flex items-center gap-1.5 mb-1.5">
        <AlertTriangle className={`size-3 ${allClear ? 'text-emerald-300' : 'text-red-300'}`} />
        <span
          className={`text-[0.625rem] uppercase tracking-wider font-bold ${
            allClear ? 'text-emerald-200' : 'text-red-200'
          }`}
        >
          {allClear ? 'Statut' : 'Alertes actives'}
        </span>
      </div>
      <ul className="space-y-1 text-[0.6875rem]">
        {items.map((it, i) => (
          <li key={i}>
            <span
              className={`font-semibold ${
                {
                  red: 'text-red-300',
                  amber: 'text-amber-300',
                  violet: 'text-violet-300',
                  emerald: 'text-emerald-300',
                }[it.color]
              }`}
            >
              ●
            </span>{' '}
            <span className="text-slate-200">{it.label}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// MetarPanel affiche le METAR brut + traduction FR pour l'aérodrome
// sélectionné, en bottom-center. Bouton pour étendre TAF/WL.
function MetarPanel({
  metar,
  taf,
  wl,
  visible,
  onToggle,
}: {
  metar: OpmetMessage | null
  taf: OpmetMessage | null
  wl: OpmetMessage | null
  visible: boolean
  onToggle: () => void
}) {
  const [expanded, setExpanded] = useState<'taf' | 'wl' | null>(null)
  if (!visible) {
    return (
      <button
        onClick={onToggle}
        className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 px-4 py-1.5 rounded-full bg-slate-950/80 backdrop-blur border border-slate-800 text-[0.625rem] uppercase tracking-wider text-slate-300 hover:text-cyan-200 hover:border-cyan-700"
      >
        Afficher METAR / TAF
      </button>
    )
  }
  return (
    <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-10 max-w-[640px] min-w-[480px] rounded-lg bg-slate-950/85 backdrop-blur-md border border-slate-800 shadow-2xl overflow-hidden">
      <div className="px-3 py-2 flex items-center gap-2 border-b border-slate-800/60">
        <span className="text-[0.625rem] uppercase tracking-wider text-cyan-300 font-semibold flex-1">
          METAR · TAF · WL — données live
        </span>
        <button
          onClick={onToggle}
          className="text-slate-500 hover:text-slate-200 text-xs"
        >
          ✕
        </button>
      </div>
      <div className="p-3 space-y-2">
        {metar?.tac ? (
          <pre className="text-[0.6875rem] font-mono text-slate-200 bg-slate-900/60 border border-slate-800 rounded p-2 whitespace-pre-wrap break-words">
            {metar.tac}
          </pre>
        ) : (
          <div className="text-[0.625rem] text-slate-500 italic">METAR : (aucun reçu)</div>
        )}
        {metar?.decoded && (
          <div className="text-[0.625rem] text-slate-300 bg-slate-900/30 border border-slate-800/60 rounded p-2 whitespace-pre-wrap leading-relaxed">
            <div className="text-[0.5rem] uppercase tracking-wider text-slate-500 mb-1">
              Traduction
            </div>
            {metar.decoded}
          </div>
        )}

        <div className="flex gap-2 pt-1 border-t border-slate-800/40">
          {taf?.decoded && (
            <button
              onClick={() => setExpanded(expanded === 'taf' ? null : 'taf')}
              className={`px-2 py-1 rounded text-[0.5625rem] uppercase tracking-wider ${
                expanded === 'taf'
                  ? 'bg-violet-500/20 border border-violet-500/40 text-violet-200'
                  : 'border border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              TAF
            </button>
          )}
          {wl?.decoded && (
            <button
              onClick={() => setExpanded(expanded === 'wl' ? null : 'wl')}
              className={`px-2 py-1 rounded text-[0.5625rem] uppercase tracking-wider ${
                expanded === 'wl'
                  ? 'bg-amber-500/20 border border-amber-500/40 text-amber-200'
                  : 'border border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              Aerodrome Warning
            </button>
          )}
        </div>
        {expanded === 'taf' && taf?.decoded && (
          <div className="text-[0.625rem] text-slate-300 bg-slate-900/30 border border-violet-900/40 rounded p-2 whitespace-pre-wrap max-h-72 overflow-y-auto">
            {taf.decoded}
          </div>
        )}
        {expanded === 'wl' && wl?.decoded && (
          <div className="text-[0.625rem] text-slate-300 bg-slate-900/30 border border-amber-900/40 rounded p-2 whitespace-pre-wrap max-h-48 overflow-y-auto">
            {wl.decoded}
          </div>
        )}
      </div>
    </div>
  )
}

// LegendPanel : panneau flottant qui décode les couleurs et symboles de la
// scène 3D pour un opérationnel non familier.
function LegendPanel({ onClose }: { onClose: () => void }) {
  return (
    <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 px-4 py-3 rounded-lg bg-slate-950/90 backdrop-blur-md border border-slate-700/70 shadow-2xl text-[0.625rem] text-slate-300 max-w-[680px] w-[640px]">
      <div className="flex items-center gap-2 mb-2.5 pb-2 border-b border-slate-800/60">
        <span className="text-[0.6875rem] uppercase tracking-wider text-cyan-300 font-semibold flex-1">
          Légende — Tour Tactique 3D
        </span>
        <button
          onClick={onClose}
          className="text-slate-500 hover:text-slate-200 text-xs"
          aria-label="Fermer la légende"
        >
          ✕
        </button>
      </div>

      <div className="grid grid-cols-3 gap-x-5 gap-y-3">
        {/* Cellules orageuses */}
        <div>
          <div className="text-[0.5625rem] uppercase tracking-wider text-rose-300 mb-1.5">
            Cellules orageuses (RDT)
          </div>
          <div className="space-y-0.5">
            <LegendRow color="#7dd3fc" label="< FL100 — cumulus bas" />
            <LegendRow color="#38bdf8" label="FL100-200 — Cu moyens" />
            <LegendRow color="#4ade80" label="FL200-300 — TCU" />
            <LegendRow color="#facc15" label="FL300-350 — Cb pré-mature" />
            <LegendRow color="#f97316" label="FL350-400 — Cb mature" />
            <LegendRow color="#ef4444" label="FL400-450 — Cb sévère" />
            <LegendRow color="#dc2626" label="> FL450 — overshoot top" />
          </div>
        </div>

        {/* Avions */}
        <div>
          <div className="text-[0.5625rem] uppercase tracking-wider text-cyan-300 mb-1.5">
            Trafic ADS-B
          </div>
          <div className="space-y-0.5">
            <LegendRow color="#4ade80" label="Vert ↑ — montée" />
            <LegendRow color="#22d3ee" label="Cyan → — palier" />
            <LegendRow color="#fb923c" label="Orange ↓ — descente" />
          </div>
          <div className="text-[0.5625rem] uppercase tracking-wider text-violet-300 mb-1.5 mt-3">
            Vents (mât / flux 3D)
          </div>
          <div className="space-y-0.5">
            <LegendRow color="#67e8f9" label="< 30 kt — calme" />
            <LegendRow color="#fbbf24" label="30-60 kt — fort" />
            <LegendRow color="#ef4444" label="≥ 60 kt — jet/tempête" />
          </div>
        </div>

        {/* Autres */}
        <div>
          <div className="text-[0.5625rem] uppercase tracking-wider text-amber-300 mb-1.5">
            Phénomènes
          </div>
          <div className="space-y-0.5">
            <LegendRow color="#fde047" label="Foudre — sprite clignotant" />
            <LegendRow color="#38bdf8" label="Tropopause — disque cyan ~FL370" />
            <LegendRow color="#0ea5e9" label="Aéro voisins — points bleus" />
            <LegendRow color="#94a3b8" label="Pistes — gris clair, axe blanc" />
          </div>
          <div className="text-[0.5625rem] uppercase tracking-wider text-slate-500 mb-1.5 mt-3">
            Repères
          </div>
          <div className="space-y-0.5">
            <LegendRow color="#fca5a5" label="Nord (rose des vents)" />
            <LegendRow color="#67e8f9" label="E / S / W cardinaux" />
            <LegendRow color="#64748b" label="Anneaux radiaux 5/10/15/20 NM (rel.)" />
          </div>
        </div>
      </div>

      <div className="mt-3 pt-2 border-t border-slate-800/60 flex flex-wrap gap-x-4 gap-y-1 text-[0.5625rem] text-slate-500">
        <span>
          <span className="text-emerald-400">●</span> METAR/TAF/SIGMET = OPMET officiel
        </span>
        <span>
          <span className="text-amber-300">●</span> Foudre / CTH / Sat IR = EUMETSAT non-OPMET
        </span>
        <span>
          <span className="text-rose-300">●</span> ADS-B = OpenSky non-certifié ATC
        </span>
      </div>
    </div>
  )
}

function LegendRow({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className="size-2.5 rounded-sm shrink-0"
        style={{ backgroundColor: color, boxShadow: `0 0 6px ${color}66` }}
      />
      <span className="text-slate-300">{label}</span>
    </div>
  )
}

// AirportSearch : input avec autocomplete sur les 43k aérodromes OurAirports.
// Cherche par ICAO, IATA, nom ou ville.
function AirportSearch({
  icao,
  onSelect,
}: {
  icao: string
  onSelect: (icao: string) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<
    { ICAO: string; IATA: string; Name: string; Municipality: string; Country: string; Type: string }[]
  >([])
  const [open, setOpen] = useState(false)
  const [hoverIdx, setHoverIdx] = useState(0)

  // Charge le nom complet de l'aéroport courant pour l'afficher quand input
  // n'a pas le focus.
  const [currentName, setCurrentName] = useState('')
  useEffect(() => {
    fetch(`/api/airport/${icao}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.airport) {
          setCurrentName(`${d.airport.ICAO} · ${d.airport.Name}`)
        }
      })
      .catch(() => {})
  }, [icao])

  // Debounce search
  useEffect(() => {
    if (query.length < 2) {
      setResults([])
      return
    }
    let aborted = false
    const t = window.setTimeout(() => {
      fetch(`/api/airports/search?q=${encodeURIComponent(query)}&limit=10`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (aborted || !d) return
          setResults(d.results ?? [])
          setHoverIdx(0)
        })
        .catch(() => {})
    }, 200)
    return () => {
      aborted = true
      window.clearTimeout(t)
    }
  }, [query])

  const select = (code: string) => {
    onSelect(code)
    setQuery('')
    setOpen(false)
  }

  return (
    <div className="relative">
      <input
        type="text"
        value={open ? query : currentName}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
        }}
        onFocus={() => {
          setOpen(true)
          setQuery('')
        }}
        onBlur={() => {
          // Délai pour permettre le clic sur la liste avant blur.
          window.setTimeout(() => setOpen(false), 150)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setHoverIdx((i) => Math.min(results.length - 1, i + 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setHoverIdx((i) => Math.max(0, i - 1))
          } else if (e.key === 'Enter' && results[hoverIdx]) {
            select(results[hoverIdx].ICAO)
          } else if (e.key === 'Escape') {
            setOpen(false)
          }
        }}
        placeholder="ICAO, IATA, ville…"
        className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-cyan-100 font-mono focus:outline-none focus:border-cyan-500/60"
      />
      {open && results.length > 0 && (
        <ul className="absolute left-0 right-0 top-full mt-1 z-20 max-h-72 overflow-y-auto rounded-lg bg-slate-950/95 backdrop-blur border border-slate-700 shadow-2xl">
          {results.map((a, i) => (
            <li
              key={a.ICAO}
              onMouseDown={(e) => {
                e.preventDefault()
                select(a.ICAO)
              }}
              onMouseEnter={() => setHoverIdx(i)}
              className={`px-2 py-1.5 cursor-pointer text-[0.6875rem] flex items-center gap-2 ${
                i === hoverIdx ? 'bg-cyan-500/15' : 'hover:bg-slate-900'
              }`}
            >
              <span className="font-mono text-cyan-200 w-12 shrink-0">{a.ICAO}</span>
              {a.IATA && (
                <span className="font-mono text-slate-500 w-8 shrink-0">{a.IATA}</span>
              )}
              <span className="text-slate-200 truncate flex-1" title={a.Name}>
                {a.Name}
              </span>
              {a.Municipality && (
                <span className="text-[0.5625rem] text-slate-500 truncate max-w-[8rem]">
                  {a.Municipality}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {open && query.length >= 2 && results.length === 0 && (
        <div className="absolute left-0 right-0 top-full mt-1 z-20 px-3 py-2 rounded-lg bg-slate-950/95 backdrop-blur border border-slate-700 text-[0.625rem] text-slate-500">
          Aucun résultat pour « {query} »
        </div>
      )}
    </div>
  )
}
