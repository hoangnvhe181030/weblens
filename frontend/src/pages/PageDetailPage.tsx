import { ArrowLeft, ArrowRight, Braces, Camera, Check, Clock3, Code2, ExternalLink, FileCode2, Image, Link2, LoaderCircle, Type } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { webLensService } from '../api/serviceMode'
import { ErrorState, LoadingState } from '../components/StateView'
import { SeverityBadge } from '../components/StatusBadge'
import { useAsyncData } from '../hooks/useAsyncData'
import { formatBytes } from '../utils/validation'

export function PageDetailPage() {
  const { scanPageId = '' } = useParams()
  const { data: page, error, loading } = useAsyncData(() => webLensService.getScanPage(scanPageId), `scan-page:${scanPageId}`)
  const [captureState, setCaptureState] = useState<'idle' | 'queued' | 'running'>('idle')
  const navigate = useNavigate()

  useEffect(() => {
    if (captureState === 'queued') {
      const timer = window.setTimeout(() => setCaptureState('running'), 550)
      return () => window.clearTimeout(timer)
    }
    if (captureState === 'running') {
      const timer = window.setTimeout(() => navigate('/app/snapshots/snapshot-1'), 900)
      return () => window.clearTimeout(timer)
    }
  }, [captureState, navigate])

  if (loading) return <div className="app-page"><LoadingState label="Đang tải bằng chứng trang…" /></div>
  if (error || !page) return <div className="app-page"><ErrorState title="Không tìm thấy trang đã quét" /></div>

  return (
    <div className="app-page">
      <Link className="back-link" to="/app/scans/scan-103"><ArrowLeft />Scan #103</Link>
      <header className="detail-header"><div><span className="page-kicker">SCAN PAGE EVIDENCE</span><h1>{page.path}</h1><a href={page.url} target="_blank" rel="noreferrer">{page.url}<ExternalLink size={14} /></a></div><button className="button button--primary" type="button" disabled={captureState !== 'idle'} onClick={() => setCaptureState('queued')}>{captureState === 'idle' ? <Camera /> : <LoaderCircle className="spin" />}{captureState === 'idle' ? 'Tạo browser capture' : captureState === 'queued' ? 'Đang xếp hàng…' : 'Chromium đang render…'}</button></header>
      {captureState !== 'idle' ? <div className="capture-progress" role="status" aria-live="polite"><span className="pulse" /><div><strong>{captureState === 'queued' ? 'Capture job đã được tạo' : 'Browser Worker đang ghi nhận tài nguyên'}</strong><small>{captureState === 'queued' ? 'QUEUED → chờ worker khả dụng' : 'RUNNING → timeout demo 900 ms'}</small></div></div> : null}

      <section className="evidence-metrics"><article><span><Code2 /></span><small>HTTP STATUS</small><strong>{page.statusCode ?? '—'}</strong><p>{page.outcome === 'failed' ? 'Không thành công' : 'Phản hồi nhận được'}</p></article><article><span><Clock3 /></span><small>RESPONSE TIME</small><strong>{page.responseTimeMs ? `${page.responseTimeMs} ms` : '—'}</strong><p>Mục tiêu quan sát: 500 ms</p></article><article><span><FileCode2 /></span><small>HTML SIZE</small><strong>{page.responseBytes ? formatBytes(page.responseBytes) : '—'}</strong><p>Ngưỡng cảnh báo: 293 KB</p></article></section>

      <div className="page-detail-grid"><section className="content-card evidence-details"><div className="card-toolbar"><div><h2>Nội dung đã trích xuất</h2><span>Text được escape, không render HTML</span></div></div><dl><div><dt><Type />Title</dt><dd>{page.title ?? <span className="missing">Không thu thập được</span>}</dd></div><div><dt><Type />H1</dt><dd>{page.h1 ?? <span className="missing">Không thu thập được</span>}</dd></div></dl><div className="resource-counts"><div><Link2 /><span><strong>{page.links}</strong><small>Liên kết</small></span></div><div><Image /><span><strong>{page.images}</strong><small>Hình ảnh</small></span></div><div><Braces /><span><strong>{page.scripts}</strong><small>Scripts</small></span></div><div><FileCode2 /><span><strong>{page.stylesheets}</strong><small>Stylesheets</small></span></div></div></section>
        <section className="content-card findings-card"><div className="card-toolbar"><div><h2>Deterministic findings</h2><span>{page.findings.length} kết quả</span></div></div>{page.findings.length === 0 ? <div className="clean-state"><Check /><strong>Không có finding</strong><p>Trang nằm trong các ngưỡng đã cấu hình.</p></div> : <div className="finding-list">{page.findings.map((finding) => <article key={finding.id}><div><SeverityBadge severity={finding.severity} /><small>RULE · {finding.id.toUpperCase()}</small></div><h3>{finding.title}</h3><p>{finding.description}</p><code>{finding.evidence}</code></article>)}</div>}</section></div>
      <div className="security-note"><strong>Ranh giới bảo mật</strong><p>Frontend chỉ kiểm tra cú pháp URL và hiển thị text đã escape. DNS, redirect, private IP, response-size limit và DNS rebinding phải được kiểm soát ở backend trước mọi kết nối.</p><Link to="/app/snapshots/snapshot-1">Xem snapshot mẫu <ArrowRight /></Link></div>
    </div>
  )
}
