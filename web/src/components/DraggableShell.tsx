import { useEffect, useRef } from 'react'
import { GripHorizontal } from 'lucide-react'

// Enveloppe « draggable » : barre de prise en haut, conteneur de popup décalable
// à la souris. On remonte au noeud `.maplibregl-popup-content` (qui porte le
// fond de la bulle) et on lui applique un translate — le tip MapLibre reste fixe
// sur le point d'ancrage géographique, ce qui donne un effet « leader line ».
//
// À utiliser en wrapper direct du contenu d'un `<Popup>` react-map-gl. Le
// `closest('.maplibregl-popup-content')` ne marche que si le composant est rendu
// à l'intérieur de la popup MapLibre.
export default function DraggableShell({ children }: { children: React.ReactNode }) {
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const offsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const dragging = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null)

  const apply = (x: number, y: number) => {
    offsetRef.current = { x, y }
    const node = wrapperRef.current
    if (!node) return
    const content = node.closest('.maplibregl-popup-content') as HTMLElement | null
    if (content) content.style.transform = `translate(${x}px, ${y}px)`
  }

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragging.current
      if (!d) return
      apply(d.baseX + (e.clientX - d.startX), d.baseY + (e.clientY - d.startY))
    }
    const onUp = () => { dragging.current = null }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  return (
    <div ref={wrapperRef}>
      <div
        onMouseDown={(e) => {
          e.stopPropagation()
          e.preventDefault()
          dragging.current = {
            startX: e.clientX,
            startY: e.clientY,
            baseX: offsetRef.current.x,
            baseY: offsetRef.current.y,
          }
        }}
        onDoubleClick={() => apply(0, 0)}
        title="Glisser pour déplacer · double-clic pour recentrer"
        className="flex items-center justify-center gap-1 -mx-3 -mt-2 mb-1 px-3 py-1 cursor-grab active:cursor-grabbing text-slate-500 hover:text-slate-300 hover:bg-slate-800/40 rounded-t-md select-none"
      >
        <GripHorizontal className="size-3.5" />
      </div>
      {children}
    </div>
  )
}
