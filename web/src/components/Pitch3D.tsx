import { useEffect } from 'react'
import { useMap } from 'react-map-gl/maplibre'

interface Props {
  enabled: boolean
  pitch?: number
}

// Ajuste imperativement le pitch (inclinaison) du fond de carte MapLibre.
// `enabled=true` → pitch cible (45° par défaut), sinon retour à plat.
// L'animation est gérée par MapLibre via `easeTo` pour une transition douce.
export default function Pitch3D({ enabled, pitch = 45 }: Props) {
  const { current: mapRef } = useMap()

  useEffect(() => {
    const map = mapRef?.getMap()
    if (!map) return
    try {
      map.easeTo({ pitch: enabled ? pitch : 0, duration: 600 })
    } catch { /* style peut être en cours de chargement */ }
  }, [enabled, pitch, mapRef])

  return null
}
