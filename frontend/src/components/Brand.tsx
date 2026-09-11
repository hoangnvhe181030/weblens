import { Aperture } from 'lucide-react'
import { Link } from 'react-router-dom'

export function Brand({ inverse = false }: { inverse?: boolean }) {
  return (
    <Link className={`brand${inverse ? ' brand--inverse' : ''}`} to="/" aria-label="WebLens — về trang chủ">
      <span className="brand__mark" aria-hidden="true"><Aperture size={19} strokeWidth={2.5} /></span>
      <span>WebLens</span>
    </Link>
  )
}
