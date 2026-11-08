import { useLayoutEffect, useRef, useState } from 'preact/hooks'
import type { Cadre } from './ocr.ts'
import { T } from './textes.ts'

interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}
interface Boite {
  x: number
  y: number
  l: number
  h: number
}

const RAYON_COIN = 34 // px : zone de prise d'un coin au doigt

export function Recadrage(props: { image: HTMLImageElement; onValider: (c: Cadre) => void; onAnnuler: () => void }) {
  const { image } = props
  const zone = useRef<HTMLDivElement>(null)
  const [boite, setBoite] = useState<Boite | null>(null)
  const [rect, setRect] = useState<Rect>({ x0: 0.06, y0: 0.08, x1: 0.94, y1: 0.92 })
  const geste = useRef<{ mode: 'nouveau' | 'coin'; coin: number; depart: { x: number; y: number }; avant: Rect } | null>(null)

  useLayoutEffect(() => {
    const calculer = () => {
      const z = zone.current?.getBoundingClientRect()
      if (!z) return
      const ratio = image.naturalWidth / image.naturalHeight
      let l = z.width
      let h = l / ratio
      if (h > z.height) {
        h = z.height
        l = h * ratio
      }
      setBoite({ x: (z.width - l) / 2, y: (z.height - h) / 2, l, h })
    }
    calculer()
    window.addEventListener('resize', calculer)
    return () => window.removeEventListener('resize', calculer)
  }, [image])

  function position(e: PointerEvent) {
    const z = zone.current!.getBoundingClientRect()
    const b = boite!
    return {
      x: Math.min(1, Math.max(0, (e.clientX - z.left - b.x) / b.l)),
      y: Math.min(1, Math.max(0, (e.clientY - z.top - b.y) / b.h)),
    }
  }

  function coins(r: Rect) {
    return [
      { x: r.x0, y: r.y0 },
      { x: r.x1, y: r.y0 },
      { x: r.x1, y: r.y1 },
      { x: r.x0, y: r.y1 },
    ]
  }

  function bas(e: PointerEvent) {
    if (!boite) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const p = position(e)
    const b = boite
    const proche = coins(rect).findIndex((c) => Math.hypot((c.x - p.x) * b.l, (c.y - p.y) * b.h) < RAYON_COIN)
    geste.current = { mode: proche >= 0 ? 'coin' : 'nouveau', coin: proche, depart: p, avant: rect }
  }

  function bouge(e: PointerEvent) {
    const g = geste.current
    if (!g || !boite) return
    const p = position(e)
    if (g.mode === 'coin') {
      const r = { ...g.avant }
      if (g.coin === 0 || g.coin === 3) r.x0 = p.x
      else r.x1 = p.x
      if (g.coin === 0 || g.coin === 1) r.y0 = p.y
      else r.y1 = p.y
      setRect(r)
    } else {
      setRect({
        x0: Math.min(g.depart.x, p.x),
        y0: Math.min(g.depart.y, p.y),
        x1: Math.max(g.depart.x, p.x),
        y1: Math.max(g.depart.y, p.y),
      })
    }
  }

  function haut() {
    const g = geste.current
    geste.current = null
    if (!g) return
    setRect((r) => {
      const n = { x0: Math.min(r.x0, r.x1), y0: Math.min(r.y0, r.y1), x1: Math.max(r.x0, r.x1), y1: Math.max(r.y0, r.y1) }
      // Un simple tap ne doit pas effacer le cadre
      return n.x1 - n.x0 < 0.05 || n.y1 - n.y0 < 0.03 ? g.avant : n
    })
  }

  function valider() {
    const L = image.naturalWidth
    const H = image.naturalHeight
    props.onValider({
      x: Math.round(rect.x0 * L),
      y: Math.round(rect.y0 * H),
      l: Math.max(1, Math.round((rect.x1 - rect.x0) * L)),
      h: Math.max(1, Math.round((rect.y1 - rect.y0) * H)),
    })
  }

  return (
    <div class="ecran recadrage">
      <header class="entete">
        <h1>{T.recadrage.titre}</h1>
        <p class="aide">{T.recadrage.aide}</p>
      </header>
      <div class="recadrage-zone" ref={zone} onPointerDown={bas} onPointerMove={bouge} onPointerUp={haut} onPointerCancel={haut}>
        {boite && (
          <>
            <img
              src={image.src}
              alt=""
              draggable={false}
              style={{ left: `${boite.x}px`, top: `${boite.y}px`, width: `${boite.l}px`, height: `${boite.h}px` }}
            />
            <div
              class="selection"
              style={{
                left: `${boite.x + Math.min(rect.x0, rect.x1) * boite.l}px`,
                top: `${boite.y + Math.min(rect.y0, rect.y1) * boite.h}px`,
                width: `${Math.abs(rect.x1 - rect.x0) * boite.l}px`,
                height: `${Math.abs(rect.y1 - rect.y0) * boite.h}px`,
              }}
            >
              <span class="poignee hg" />
              <span class="poignee hd" />
              <span class="poignee bd" />
              <span class="poignee bg" />
            </div>
          </>
        )}
      </div>
      <footer class="actions">
        <button class="bouton principal" onClick={valider}>
          {T.boutons.lire}
        </button>
        <label for="entree-photo" class="bouton secondaire">
          {T.boutons.reprendre}
        </label>
        <button class="bouton discret" onClick={props.onAnnuler}>
          {T.boutons.retour}
        </button>
      </footer>
    </div>
  )
}
