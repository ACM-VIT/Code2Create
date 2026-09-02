import { useEffect, useState } from 'react'
import bonsaiSource from '../../assets/plant-01.webp'

const revealDelay = 300
const bonsaiDecoded = decodeBonsai()

function decodeBonsai() {
  const image = new Image()
  image.src = bonsaiSource
  return image.decode().catch(() => undefined)
}

export function DelayedBonsai({ compact = false }: { compact?: boolean }) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    let active = true
    let resolveDelay = () => {}
    const delayElapsed = new Promise<void>((resolve) => {
      resolveDelay = resolve
    })
    const timer = window.setTimeout(resolveDelay, revealDelay)
    void Promise.all([delayElapsed, bonsaiDecoded]).then(() => {
      if (active) setVisible(true)
    })
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [])

  if (!visible) return null

  return (
    <div className={`delayed-bonsai${compact ? ' delayed-bonsai-compact' : ''}`} role="status">
      <div className="delayed-bonsai-art" aria-hidden="true">
        <img src={bonsaiSource} alt="" />
        {Array.from({ length: 9 }, (_, index) => <i key={index} />)}
      </div>
      <span className="delayed-bonsai-label">just a moment</span>
    </div>
  )
}
