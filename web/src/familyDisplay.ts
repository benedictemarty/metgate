const FAMILY_DISPLAY_NAMES: Record<string, string> = {
  wl: 'Aéroport warning',
  WL: 'Aéroport warning',
}

export const displayFamilyName = (familyName: string): string =>
  FAMILY_DISPLAY_NAMES[familyName] ?? familyName

// Métadonnées éditoriales par famille MetGate. Description courte (1 phrase)
// + source. Sert de tooltip / sub-titre dans le catalogue.
export interface FamilyInfo {
  description: string
  source: string
}

const FAMILY_INFO: Record<string, FamilyInfo> = {
  // OPMET officiels OACI / WMO
  METAR: {
    description: 'Observation météo régulière (cadence 30 min) en aérodrome',
    source: 'Météo-France · OPMET OACI Annexe 3',
  },
  SPECI: {
    description: 'Observation spéciale émise hors cadence sur évolution rapide',
    source: 'Météo-France · OPMET OACI Annexe 3',
  },
  TAF: {
    description: "Prévision d'aérodrome (24-30 h)",
    source: 'Météo-France · OPMET OACI Annexe 3',
  },
  SIGMET: {
    description: 'Avis sur phénomènes dangereux (orages, turbulence, givrage, cendres)',
    source: 'MWO via Météo-France · OACI',
  },
  AIRMET: {
    description: 'Avis basse altitude (vent, visi, nuages dangereux <FL100)',
    source: 'MWO via Météo-France · OACI',
  },
  VolcanicAshSIGMET: {
    description: 'SIGMET dédié cendres volcaniques (panaches actifs)',
    source: 'MWO via Météo-France · OACI',
  },
  TropicalCycloneSIGMET: {
    description: 'SIGMET dédié cyclones tropicaux',
    source: 'MWO via Météo-France · OACI',
  },
  VolcanicAshAdvisory: {
    description: 'VAA — analyse / prévision de panache de cendres (Toulouse VAAC)',
    source: 'Toulouse VAAC (Météo-France)',
  },
  TropicalCycloneAdvisory: {
    description: 'TCA — avis cyclone tropical (TCAC)',
    source: 'TCAC La Réunion / Miami / autres',
  },
  SpaceWeatherAdvisory: {
    description: 'Avis météo spatiale (HF, GNSS, radiation)',
    source: 'PECASUS / ACFJ / NOAA SWPC',
  },
  LocalReport: {
    description: 'Bulletin local / OPMET non standard',
    source: 'Centres météo locaux Météo-France',
  },
  WL: {
    description: 'Aerodrome Warning (MAA) — alerte locale aérodrome (vent fort, brouillard, orage)',
    source: 'Météo-France',
  },
  wl: {
    description: 'Aerodrome Warning (MAA) — alerte locale aérodrome (vent fort, brouillard, orage)',
    source: 'Météo-France',
  },
  // Produits convection / radar
  RDT_MSG: {
    description: 'Cellules orageuses détectées par satellite (Rapidly Developing Thunderstorms)',
    source: 'NWC SAF · MSG SEVIRI · Météo-France',
  },
  OPIC_GTD: {
    description: 'Observations / produits OPMET globaux',
    source: 'Météo-France',
  },
  COMPOSITE: {
    description: 'Mosaïque radar nationale',
    source: 'Météo-France · réseau ARAMIS',
  },
  Composite_EUFAB: {
    description: 'Mosaïque radar européenne fabriquée par Météo-France',
    source: 'Météo-France · réseaux européens',
  },
  Composite_EUOPERA: {
    description: 'Mosaïque radar européenne OPERA',
    source: 'EUMETNET OPERA',
  },
  // Convection / aviation
  CAT_EURAT01: {
    description: 'Turbulence en air clair (CAT) — produit déterministe Eurat01',
    source: 'Météo-France',
  },
  GIVRAGE_EURAT01: {
    description: 'Givrage en route — produit déterministe Eurat01',
    source: 'Météo-France',
  },
  // Vents / haute altitude (WCS)
  WIND: {
    description: 'Vent en altitude par niveau de pression (modèle ARPEGE)',
    source: 'Météo-France · ARPEGE',
  },
  JET: {
    description: 'Vent jet stream (haute troposphère)',
    source: 'Météo-France · ARPEGE',
  },
  TROPO: {
    description: 'Altitude de la tropopause',
    source: 'Météo-France · ARPEGE',
  },
  QVACIS: {
    description: 'Concentration de cendres volcaniques (déterministe / probabiliste)',
    source: 'Toulouse VAAC (Météo-France)',
  },
  // Bulletins WMO header (codes 2 lettres)
  fc: { description: 'TAF court (validity ≤ 12 h) — header WMO FC', source: 'Météo-France · WMO' },
  ft: { description: 'TAF long (validity > 12 h) — header WMO FT', source: 'Météo-France · WMO' },
  fv: { description: 'VAA — header WMO FV', source: 'VAAC' },
  fk: { description: 'TCA — header WMO FK', source: 'TCAC' },
  sa: { description: 'METAR — header WMO SA', source: 'Météo-France · WMO' },
  sp: { description: 'SPECI — header WMO SP', source: 'Météo-France · WMO' },
  wa: { description: 'AIRMET — header WMO WA', source: 'MWO · WMO' },
  ws: { description: 'SIGMET — header WMO WS', source: 'MWO · WMO' },
  wv: { description: 'Volcanic Ash SIGMET — header WMO WV', source: 'MWO · WMO' },
  wc: { description: 'Tropical Cyclone SIGMET — header WMO WC', source: 'MWO · WMO' },
}

export function familyInfo(name: string): FamilyInfo | null {
  return FAMILY_INFO[name] ?? null
}

// ───────────────────────────────────────────────────────────────────────
// Produits / sources externes consommés par le portail (hors MetGate)
// EUMETSAT (foudre, satellite, CTH) et OpenSky (trafic ADS-B).
// ───────────────────────────────────────────────────────────────────────

export interface ExternalProduct {
  name: string
  provider: 'EUMETSAT' | 'OpenSky'
  description: string
  source: string
  cadence: string
  endpoint: string
  disclaimer: string
}

export const EXTERNAL_PRODUCTS: ExternalProduct[] = [
  // EUMETSAT
  {
    name: 'MTG-LI Lightning Flashes',
    provider: 'EUMETSAT',
    description: 'Impacts foudre détectés par satellite optique (raie OI 777.4 nm)',
    source: 'EUMETSAT · MTG-I1 Lightning Imager',
    cadence: '10 min · Full Disc',
    endpoint: '/api/lightning',
    disclaimer: 'Situationnel — non OPMET',
  },
  {
    name: 'MTG-FCI Cloud Top Height',
    provider: 'EUMETSAT',
    description:
      "Altitude des sommets nuageux (niveau aviation FL), filtrable par seuil minimum",
    source: 'EUMETSAT · MTG-I1 FCI L2 CTTH',
    cadence: '10 min · Full Disc',
    endpoint: '/api/cloudtop',
    disclaimer: 'Situationnel — non OPMET',
  },
  {
    name: 'FCI IR 10.5 µm',
    provider: 'EUMETSAT',
    description: "Imagerie satellite infrarouge thermique haute résolution",
    source: 'EUMETSAT · MTG-I1 FCI HRFI · via EUMETView WMS',
    cadence: '~10 min · Full Disc',
    endpoint: '/api/satellite/tile?layer=mtg_fd:ir105_hrfi',
    disclaimer: 'Situationnel — non OPMET',
  },
  {
    name: 'MSG Convection RGB',
    provider: 'EUMETSAT',
    description:
      "Composite satellite mettant en évidence les cellules orageuses (Cb), sommets froids en rouge profond",
    source: 'EUMETSAT · MSG SEVIRI · via EUMETView WMS',
    cadence: '15 min · 0° Service',
    endpoint: '/api/satellite/tile?layer=msg_fes:rgb_convection',
    disclaimer: 'Situationnel — non OPMET',
  },
  // OpenSky
  {
    name: 'OpenSky ADS-B',
    provider: 'OpenSky',
    description:
      "États ADS-B des avions (position, altitude, cap, vitesse, vario) pour suivi temps réel",
    source: 'OpenSky Network · ADS-B crowdsourced',
    cadence: '~5-10 s · couverture mondiale (densité variable)',
    endpoint: '/api/aircraft/search & /api/aircraft/{icao24}',
    disclaimer: 'Donnée crowdsourced — non certifiée pour ATC',
  },
]
