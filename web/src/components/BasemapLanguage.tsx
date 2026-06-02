import { useEffect } from 'react'
import { useMap } from 'react-map-gl/maplibre'
import type { MapLanguageCode } from './ConfigPanel'

interface Props {
  language: MapLanguageCode
}

// Applique la langue choisie aux labels du fond de carte Carto. Le style
// dark-matter / voyager référence en dur `{name_en}` ; on substitue par une
// expression `coalesce(name:<lang>, name_<lang>, name)` couvrant les deux
// conventions de schéma (OpenMapTiles standard `name:fr` et la variante
// underscore `name_fr` selon les sources).
export default function BasemapLanguage({ language }: Props) {
  const { current: mapRef } = useMap()

  useEffect(() => {
    const map = mapRef?.getMap()
    if (!map) return

    const apply = () => {
      const style = map.getStyle()
      if (!style) return
      const expr: unknown = [
        'coalesce',
        ['get', `name:${language}`],
        ['get', `name_${language}`],
        ['get', 'name'],
      ]
      for (const layer of style.layers) {
        if (layer.type !== 'symbol') continue
        // Ignore nos propres layers (préfixés countries-, fir-, etc.) — ils ont
        // déjà leur text-field configuré côté composant.
        if (
          layer.id.startsWith('countries-') ||
          layer.id.startsWith('fir-')
        ) continue
        const layout = (layer as { layout?: Record<string, unknown> }).layout
        if (!layout || !('text-field' in layout)) continue
        try {
          map.setLayoutProperty(layer.id, 'text-field', expr)
        } catch { /* layer disparu pendant un reload de style */ }
      }
    }

    if (map.isStyleLoaded()) apply()
    map.on('styledata', apply)
    return () => { map.off('styledata', apply) }
  }, [mapRef, language])

  return null
}
