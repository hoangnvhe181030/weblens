import { ArrowLeft, ArrowRight, ExternalLink, Play, Settings2 } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { webLensService } from '../api/serviceMode'
import { ErrorState, LoadingState } from '../components/StateView'
import { StatusBadge } from '../components/StatusBadge'
import { useAsyncData } from '../hooks/useAsyncData'

export function WebsiteDetailPage() {
  const { websiteId = '' } = useParams()
  const navigate = useNavigate()
  const websiteState = useAsyncData(() => webLensService.getWebsite(websiteId), `website:${websiteId}`)
  const scansState = useAsyncData(() => webLensService.listScans(websiteId), `website-scans:${websiteId}`)

  async function startScan() {
    try {
      const scan = await webLensService.startScan(websiteId, crypto.randomUUID())
      navigate(`/app/scans/${scan.id}`)
    } catch {
      window.alert('Không thể bắt đầu lần quét. Hãy thử lại.')
    }
  }

  if (websiteState.loading) return <div className="app-page"><LoadingState label="Đang tải website…" /></div>
  if (websiteState.error || !websiteState.data) return <div className="app-page"><ErrorState title="Không tìm thấy website" /></div>
  const website = websiteState.data

  return (
    <div className="app-page">
      <Link className="back-link" to="/app/websites"><ArrowLeft />Tất cả websites</Link>
      <header className="detail-header"><div className="detail-identity"><span className="site-favicon site-favicon--large">{website.hostname.slice(0, 1).toUpperCase()}</span><div><span className="page-kicker">WEBSITE DETAIL</span><h1>{website.name}</h1><a href={website.url} target="_blank" rel="noreferrer">{website.url}<ExternalLink size={14} /></a></div></div><div className="header-actions"><button className="button button--secondary" type="button"><Settings2 />Cấu hình</button><button className="button button--primary" type="button" onClick={startScan}><Play />Bắt đầu quét</button></div></header>
      <section className="site-summary"><div><small>TRẠNG THÁI GẦN NHẤT</small><StatusBadge status={website.latestStatus ?? 'QUEUED'} /></div><div><small>TRANG PHÁT HIỆN</small><strong>{website.pageCount}</strong></div><div><small>FINDINGS</small><strong>{website.findingCount}</strong></div><div><small>CẬP NHẬT</small><strong>{website.updatedAt}</strong></div></section>
      <section className="content-card"><div className="card-toolbar"><div><h2>Lịch sử quét</h2><span>Mới nhất trước</span></div><span className="future-chip">So sánh scan · V2</span></div>{scansState.loading ? <LoadingState /> : scansState.error ? <ErrorState /> : <div className="data-table-wrap"><table className="data-table"><thead><tr><th scope="col">Lần quét</th><th scope="col">Trạng thái</th><th scope="col">Pages</th><th scope="col">Findings</th><th scope="col">Thời lượng</th><th scope="col"><span className="sr-only">Mở</span></th></tr></thead><tbody>{scansState.data?.map((scan) => <tr key={scan.id}><td><Link to={`/app/scans/${scan.id}`}><strong>#{scan.id.replace('scan-', '')}</strong><small>{scan.createdAt}</small></Link></td><td><StatusBadge status={scan.status} /></td><td>{scan.progress.processed} / {scan.progress.discovered}</td><td>{scan.findingCount}</td><td>{scan.duration}</td><td><Link className="icon-link" to={`/app/scans/${scan.id}`} aria-label={`Mở lần quét ${scan.id}`}><ArrowRight /></Link></td></tr>)}</tbody></table></div>}</section>
    </div>
  )
}
