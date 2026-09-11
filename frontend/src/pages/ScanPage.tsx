import { AlertTriangle, ArrowLeft, ArrowRight, Check, Clock3, FileSearch, PauseCircle, Radio, XCircle } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { isBackendMode, webLensService } from '../api/serviceMode'
import { ErrorState, LoadingState } from '../components/StateView'
import { SeverityBadge, StatusBadge } from '../components/StatusBadge'
import type { Scan, ScanStatus } from '../domain/types'
import { useAsyncData } from '../hooks/useAsyncData'

function useLiveDemo(scan: Scan | null, enabled: boolean) {
  const [override, setOverride] = useState<{ scanId: string; processed: number; status: ScanStatus } | null>(null)
  const activeOverride = override && override.scanId === scan?.id ? override : null
  const processed = activeOverride?.processed ?? scan?.progress.processed ?? 0
  const status = activeOverride?.status ?? scan?.status ?? 'QUEUED'

  useEffect(() => {
    if (!scan || !enabled) return
    if (scan.status !== 'RUNNING') return
    const timer = window.setInterval(() => setOverride((current) => {
      const currentProcessed = current?.scanId === scan.id ? current.processed : scan.progress.processed
      const next = Math.min(currentProcessed + 1, scan.progress.discovered)
      const nextStatus = next === scan.progress.discovered ? 'PARTIAL_SUCCESS' : 'RUNNING'
      if (nextStatus === 'PARTIAL_SUCCESS') window.clearInterval(timer)
      return { scanId: scan.id, processed: next, status: nextStatus }
    }), 1800)
    return () => window.clearInterval(timer)
  }, [enabled, scan])

  return {
    processed,
    status,
    setStatus: (nextStatus: ScanStatus) => scan && setOverride({ scanId: scan.id, processed, status: nextStatus }),
  }
}

export function ScanPage() {
  const { scanId = '' } = useParams()
  const scanState = useAsyncData(() => webLensService.getScan(scanId), `scan:${scanId}`)
  const pagesState = useAsyncData(() => webLensService.listScanPages(scanId), `scan-pages:${scanId}`)
  const live = useLiveDemo(scanState.data, !isBackendMode)
  const [filter, setFilter] = useState<'all' | 'issues'>('all')
  const pages = useMemo(() => filter === 'issues' ? pagesState.data?.filter((page) => page.findings.length > 0) : pagesState.data, [filter, pagesState.data])

  if (scanState.loading) return <div className="app-page"><LoadingState label="Đang tải lần quét…" /></div>
  if (scanState.error || !scanState.data) return <div className="app-page"><ErrorState title="Không tìm thấy lần quét" /></div>
  const scan = scanState.data
  const percent = Math.round((live.processed / Math.max(scan.progress.discovered, 1)) * 100)
  const running = live.status === 'RUNNING'

  async function cancelScan() {
    try {
      const cancelled = await webLensService.cancelScan(scan.id)
      live.setStatus(cancelled.status)
    } catch {
      window.alert('Không thể hủy lần quét. Hãy thử lại.')
    }
  }

  return (
    <div className="app-page">
      <Link className="back-link" to={`/app/websites/${scan.websiteId}`}><ArrowLeft />Evomi Marketing</Link>
      <header className="page-header"><div><span className="page-kicker">SCAN #{scan.id.replace('scan-', '')}</span><h1>{running ? 'Đang thu thập bằng chứng' : 'Báo cáo lần quét'}</h1><p>Bắt đầu {scan.createdAt} · Giới hạn {scan.progress.limit} trang</p></div><div className="header-actions"><StatusBadge status={live.status} />{live.status === 'RUNNING' || live.status === 'QUEUED' ? <button className="button button--danger-ghost" type="button" onClick={cancelScan}><XCircle />Hủy lần quét</button> : null}</div></header>

      <section className="progress-panel" aria-live="polite" aria-busy={running}><div className="progress-summary"><div className="progress-ring" style={{ '--progress': `${percent * 3.6}deg` } as React.CSSProperties}><span>{percent}%</span></div><div><span className="page-kicker">TIẾN ĐỘ</span><h2>{live.processed} / {scan.progress.discovered} trang đã xử lý</h2><p>{running ? 'Crawler đang phân tích /docs và cập nhật progress stream.' : live.status === 'CANCELLED' ? 'Lần quét đã được hủy. Kết quả đã thu thập vẫn có thể đọc.' : 'Lần quét đã đi đến trạng thái cuối.'}</p></div></div><div className="progress-stats"><div><FileSearch /><span><small>PHÁT HIỆN</small><strong>{scan.progress.discovered}</strong></span></div><div><Check /><span><small>THÀNH CÔNG</small><strong>{Math.min(scan.progress.succeeded + Math.max(live.processed - scan.progress.processed, 0), live.processed)}</strong></span></div><div><AlertTriangle /><span><small>THẤT BẠI</small><strong>{scan.progress.failed}</strong></span></div><div><Clock3 /><span><small>THỜI GIAN</small><strong>{scan.duration}</strong></span></div></div><div className="linear-progress"><span style={{ width: `${percent}%` }} /></div></section>

      <div className="report-layout"><section className="content-card"><div className="card-toolbar"><div><h2>Page outcomes</h2><span>Bằng chứng theo từng URL</span></div><div className="segmented" aria-label="Lọc page outcomes"><button className={filter === 'all' ? 'active' : ''} type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>Tất cả</button><button className={filter === 'issues' ? 'active' : ''} type="button" aria-pressed={filter === 'issues'} onClick={() => setFilter('issues')}>Có vấn đề</button></div></div>{pagesState.loading ? <LoadingState /> : pagesState.error ? <ErrorState /> : <div className="page-outcomes">{pages?.map((page) => <Link to={`/app/pages/${page.id}`} key={page.id}><span className={`outcome-icon ${page.outcome}`}>{page.outcome === 'success' ? <Check /> : page.outcome === 'failed' ? <XCircle /> : <AlertTriangle />}</span><span className="outcome-path"><strong>{page.path}</strong><small>{page.url}</small></span><span className="outcome-code">{page.statusCode ?? '—'}</span><span className="outcome-time">{page.responseTimeMs ? `${page.responseTimeMs} ms` : 'Không có dữ liệu'}</span><ArrowRight className="row-arrow" /></Link>)}</div>}</section>
        <aside className="event-panel"><div className="event-title"><Radio className={running ? 'pulse-icon' : ''} /><div><h2>Event stream</h2><span>{running ? 'Kết nối SSE mô phỏng' : 'Luồng đã đóng'}</span></div></div><ol><li><i className="event-ok" /><div><strong>scan.started</strong><span>Worker nhận scan</span><time>20:14:02</time></div></li><li><i className="event-ok" /><div><strong>page.completed</strong><span>/pricing · HTTP 200</span><time>20:14:11</time></div></li><li><i className="event-warn" /><div><strong>page.failed</strong><span>/locations · HTTP 503</span><time>20:14:16</time></div></li><li className={running ? 'event-current' : ''}><i /><div><strong>{running ? 'page.processing' : 'scan.terminal'}</strong><span>{running ? '/docs · đang phân tích' : live.status}</span><time>Bây giờ</time></div></li></ol><div className="event-footer"><PauseCircle />Progress mô phỏng cục bộ</div></aside></div>

      <section className="finding-strip"><div><SeverityBadge severity="warning" /><strong>3 findings cần xem</strong><span>Kết quả được tạo bằng quy tắc deterministic, không dùng AI.</span></div><Link to="/app/pages/page-home">Xem finding nổi bật <ArrowRight /></Link></section>
    </div>
  )
}
