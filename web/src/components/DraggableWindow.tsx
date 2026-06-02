import { useEffect, useRef, useState } from 'react'
import { GripHorizontal } from 'lucide-react'

interface Props {
  children: React.ReactNode
  className?: string
  centered?: boolean       // si true, le translate compose avec -50% pour rester centré
  handleClassName?: string // styles supplémentaires pour la poignée (positionnement)
  storageKey?: string      // si fourni, persiste la position dans localStorage
}

// Wrap n'importe quel widget flottant (slider, panneau) dans un conteneur dont
// la position peut être déplacée à la souris via une poignée discrète.
// - `className` : classes Tailwind du wrapper (typiquement `absolute bottom-… left-…`)
// - `centered` : pour les widgets centrés horizontalement (compose `-50%` + dx)
// - double-clic sur la poignée → recentrage (offset remis à zéro)
export default function DraggableWindow({
  children,
  className,
  centered = false,
  handleClassName = '-top-2 left-1/2 -translate-x-1/2',
  storageKey,
}: Props) {
  const [offset, setOffset] = useState<{ x: number; y: number }>(() => {
    if (!storageKey || typeof window === 'undefined') return { x: 0, y: 0 }
    try {
      const v = window.localStorage.getItem(storageKey)
      if (v) {
        const p = JSON.parse(v)
        if (typeof p.x === 'number' && typeof p.y === 'number') return p
      }
    } catch { /* ignore */ }
    return { x: 0, y: 0 }
  })
  const dragging = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null)

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragging.current
      if (!d) return
      setOffset({ x: d.baseX + (e.clientX - d.startX), y: d.baseY + (e.clientY - d.startY) })
    }
    const onUp = () => { dragging.current = null }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  useEffect(() => {
    if (!storageKey) return
    try { window.localStorage.setItem(storageKey, JSON.stringify(offset)) } catch { /* ignore */ }
  }, [storageKey, offset])

  const tx = centered ? `calc(-50% + ${offset.x}px)` : `${offset.x}px`
  const transform = `translate(${tx}, ${offset.y}px)`

  return (
    <div className={className} style={{ transform }}>
      <button
        onMouseDown={(e) => {
          e.stopPropagation()
          e.preventDefault()
          dragging.current = {
            startX: e.clientX,
            startY: e.clientY,
            baseX: offset.x,
            baseY: offset.y,
          }
        }}
        onDoubleClick={() => setOffset({ x: 0, y: 0 })}
        title="Glisser pour déplacer · double-clic pour repositionner"
        className={`absolute ${handleClassName} z-10 size-5 rounded-md bg-slate-900/90 border border-slate-700 text-slate-500 hover:text-slate-200 hover:bg-slate-800 cursor-grab active:cursor-grabbing flex items-center justify-center shadow-md`}
      >
        <GripHorizontal className="size-3" />
      </button>
      {children}
    </div>
  )
}
