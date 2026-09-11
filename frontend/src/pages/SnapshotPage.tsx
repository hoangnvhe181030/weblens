import { ArrowLeft, Braces, Camera, Check, ChevronDown, FileCode2, Filter, Image, Network, Search, ShieldCheck } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { webLensService } from '../api/serviceMode'
import { ErrorState, LoadingState } from '../components/StateView'
import { useAsyncData } from '../hooks/useAsyncData'
import { formatBytes } from '../utils/validation'

export function SnapshotPage() {
  const { snapshotId = '' } = useParams()
  const { data: snapshot, error, loading } = useAsyncData(() => webLensService.getSnapshot(snapshotId), `snapshot:${snapshotId}`)
  const [query, setQuery] = useState('')
  const [type, setType] = useState('all')
  const filtered = useMemo(() => snapshot?.resources.filter((resource) => (type === 'all' || resource.type === type) && resource.url.toLowerCase().includes(query.toLowerCase())) ?? [], [query, snapshot, type])

  if (loading) return <div className="app-page"><LoadingState label="Đang tải snapshot…" /></div>
  if (error || !snapshot) return <div className="app-page"><ErrorState title="Không tìm thấy snapshot" /></div>

  return (
    <div className="app-page">
      <Link className="back-link" to="/app/pages/page-home"><ArrowLeft />Page evidence /</Link>
      <header className="page-header"><div><span className="page-kicker">PAGE SNAPSHOT · V1.5</span><h1>Rendered capture</h1><p>{snapshot.finalUrl} · {snapshot.createdAt}</p></div><span className="capture-complete"><Check />Capture hoàn tất</span></header>
      <section className="snapshot-stats"><div><Camera /><span><small>VIEWPORT</small><strong>{snapshot.viewport}</strong></span></div><div><Network /><span><small>TÀI NGUYÊN</small><strong>{snapshot.resourceCount}</strong></span></div><div><FileCode2 /><span><small>TỔNG DUNG LƯỢNG</small><strong>{formatBytes(snapshot.totalBytes)}</strong></span></div><div><ShieldCheck /><span><small>WORKER</small><strong>Isolated Chromium</strong></span></div></section>

      <div className="snapshot-layout"><section className="snapshot-preview"><div className="preview-toolbar"><span className="window-dots"><i /><i /><i /></span><span>{snapshot.finalUrl}</span><span>1440 × 900</span></div><div className="captured-site"><div className="captured-nav"><span className="captured-logo" /><div><i /><i /><i /></div><b /></div><div className="captured-hero"><small>ETHICAL WEB DATA</small><h2>Reliable infrastructure<br />for every request.</h2><p /><p /><button type="button" tabIndex={-1}>Start building</button></div><div className="captured-tiles"><span /><span /><span /></div><div className="snapshot-watermark"><Camera />Ảnh minh họa WebLens · không phải website trực tiếp</div></div></section>
        <aside className="snapshot-inspector"><div className="inspector-tabs"><button className="active" type="button">Tóm tắt</button><button type="button">DOM</button></div><div className="inspector-body"><span className="page-kicker">CAPTURE METADATA</span><dl><div><dt>Trạng thái</dt><dd><span className="ok-dot" />Hoàn tất</dd></div><div><dt>Final URL</dt><dd>{snapshot.finalUrl}</dd></div><div><dt>HTML sau render</dt><dd>348.2 KB</dd></div><div><dt>Screenshot</dt><dd>1.4 MB · WEBP</dd></div><div><dt>Content hash</dt><dd><code>sha256:8f31…c29a</code></dd></div></dl><div className="inspector-note"><Braces /><p><strong>Không thực thi nội dung capture</strong>DOM và JavaScript chỉ được xem như dữ liệu không tin cậy.</p></div></div></aside></div>

      <section className="content-card resources-card"><div className="card-toolbar"><div><h2>Network resources</h2><span>{filtered.length} / {snapshot.resources.length} tài nguyên mẫu</span></div><div className="resource-filters"><label className="search-field"><span className="sr-only">Tìm tài nguyên</span><Search /><input placeholder="Tìm URL…" value={query} onChange={(event) => setQuery(event.target.value)} /></label><label className="select-field"><Filter /><span className="sr-only">Loại tài nguyên</span><select value={type} onChange={(event) => setType(event.target.value)}><option value="all">Mọi loại</option><option value="document">Document</option><option value="stylesheet">CSS</option><option value="script">Script</option><option value="image">Image</option><option value="font">Font</option><option value="fetch">Fetch</option></select><ChevronDown /></label></div></div><div className="data-table-wrap"><table className="data-table resource-table"><thead><tr><th scope="col">Resource</th><th scope="col">Type</th><th scope="col">Status</th><th scope="col">Size</th><th scope="col">Duration</th></tr></thead><tbody>{filtered.map((resource) => <tr key={resource.id}><td><div className={`resource-type-icon ${resource.type}`}>{resource.type === 'image' ? <Image /> : resource.type === 'script' ? <Braces /> : <FileCode2 />}</div><span><strong>{new URL(resource.url).pathname || '/'}</strong><small>{new URL(resource.url).hostname}</small></span></td><td>{resource.type}</td><td><span className="http-ok">{resource.status}</span></td><td>{formatBytes(resource.sizeBytes)}</td><td>{resource.durationMs} ms</td></tr>)}</tbody></table></div></section>
    </div>
  )
}
