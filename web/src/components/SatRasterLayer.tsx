import { useEffect } from 'react'
import { useMap } from 'react-map-gl/maplibre'

interface SatRasterLayerProps {
  enabled: boolean
  // ID unique côté MapLibre : doit varier par layer pour permettre le toggle
  // de plusieurs raster en parallèle.
  id: string
  // Layer EUMETView (ex: "mtg_fd:ir105_hrfi", "msg_fes:cth").
  wmsLayer: string
  // Style nommé du WMS (palette fixe). Sans style, GeoServer auto-stretche
  // chaque tuile indépendamment → bandes de couleurs incohérentes.
  wmsStyle?: string
  // maxzoom de la source : au-delà, MapLibre upsample la dernière tuile au
  // lieu d'en demander de nouvelles (dont le serveur amont renvoie du vide
  // car la résolution native MSG/MTG-FCI est ~3km/pixel à 0°).
  maxzoom?: number
  opacity?: number
}

// SatRasterLayer ajoute un raster source MapLibre alimenté par notre proxy
// /api/satellite/tile (qui appelle EUMETView WMS). Réutilisable pour FCI IR,
// Cloud Top Height, RGB Convection, etc.
export default function SatRasterLayer({
  enabled,
  id,
  wmsLayer,
  wmsStyle = '',
  maxzoom = 7,
  opacity = 0.7,
}: SatRasterLayerProps) {
  const { current: mapRef } = useMap()
  const map = mapRef?.getMap()

  useEffect(() => {
    if (!map) return
    const sourceId = `eumetview-${id}-src`
    const layerId = `eumetview-${id}-layer`

    const cleanup = () => {
      if (map.getLayer(layerId)) map.removeLayer(layerId)
      if (map.getSource(sourceId)) map.removeSource(sourceId)
    }

    if (!enabled) {
      cleanup()
      return
    }

    if (!map.getSource(sourceId)) {
      const styleQS = wmsStyle ? `&style=${encodeURIComponent(wmsStyle)}` : ''
      map.addSource(sourceId, {
        type: 'raster',
        tiles: [
          `${window.location.origin}/api/satellite/tile?layer=${encodeURIComponent(
            wmsLayer,
          )}${styleQS}&z={z}&x={x}&y={y}`,
        ],
        tileSize: 256,
        minzoom: 0,
        maxzoom,
        attribution: '© EUMETSAT (situationnel, non OPMET)',
      })
    }
    if (!map.getLayer(layerId)) {
      // On insère le raster sous tout label / placeName pour préserver la
      // lisibilité des noms de villes/pays. On cherche un repère « symbol ».
      const layers = map.getStyle().layers ?? []
      const firstSymbol = layers.find((l) => l.type === 'symbol')?.id
      map.addLayer(
        {
          id: layerId,
          type: 'raster',
          source: sourceId,
          paint: { 'raster-opacity': opacity },
        },
        firstSymbol,
      )
    } else {
      map.setPaintProperty(layerId, 'raster-opacity', opacity)
    }

    return cleanup
  }, [map, enabled, id, wmsLayer, wmsStyle, maxzoom, opacity])

  return null
}
