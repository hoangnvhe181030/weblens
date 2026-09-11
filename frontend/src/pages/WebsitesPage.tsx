import { Activity, ArrowRight, CheckCircle2, CircleAlert, Globe2, Plus, Search, Sparkles } from 'lucide-react'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { webLensService } from '../api/serviceMode'
import { EmptyState, ErrorState, LoadingState } from '../components/StateView'
import { StatusBadge } from '../components/StatusBadge'
import { useAsyncData } from '../hooks/useAsyncData'
import { validatePublicUrl } from '../utils/validation'

export function WebsitesPage() {
  const [reloadKey, setReloadKey] = useState(0)
  const { data, error, loading } = useAsyncData(() => webLensService.listWebsites(), `websites:${reloadKey}`)
  const [adding, setAdding] = useState(false)
  const [search, setSearch] = useState('')
  const [urlError, setUrlError] = useState<string | null>(null)
  const filtered = data?.filter((website) => `${website.name} ${website.hostname}`.toLowerCase().includes(search.toLowerCase())) ?? []

  async function addWebsite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = String(new FormData(event.currentTarget).get('url') ?? '')
    const validationError = validatePublicUrl(value)
    setUrlError(validationError)
    if (validationError) return
    try {
      const hostname = new URL(value).hostname
      await webLensService.createWebsite(hostname, value)
      setAdding(false)
      setReloadKey((current) => current + 1)
    } catch (requestError) {
      setUrlError(requestError instanceof Error ? requestError.message : 'Không thể thêm website.')
    }
  }

  return (
    <div className="app-page">
      <header className="page-header"><div><span className="page-kicker">TỔNG QUAN</span><h1>Websites</h1><p>Quan sát tất cả target và lần quét gần nhất trong một nơi.</p></div><button className="button button--primary" type="button" aria-expanded={adding} aria-controls="add-website-panel" onClick={() => setAdding((value) => !value)}><Plus size={17} />Thêm website</button></header>

      <section className="metric-grid" aria-label="Tóm tắt workspace"><article><span className="metric-icon mint"><Globe2 /></span><div><small>WEBSITE</small><strong>03</strong><p>3 target đang hoạt động</p></div></article><article><span className="metric-icon blue"><Activity /></span><div><small>LẦN QUÉT THÁNG NÀY</small><strong>28</strong><p><b>+12%</b> so với tháng trước</p></div></article><article><span className="metric-icon green"><CheckCircle2 /></span><div><small>TRANG THÀNH CÔNG</small><strong>96.8%</strong><p>61 / 63 page outcomes</p></div></article><article><span className="metric-icon orange"><CircleAlert /></span><div><small>FINDINGS ĐANG MỞ</small><strong>08</strong><p>1 nghiêm trọng · 7 cảnh báo</p></div></article></section>

      {adding ? <section className="inline-panel" id="add-website-panel" aria-labelledby="add-website-title"><div><Sparkles /><h2 id="add-website-title">Thêm target demo</h2><p>Frontend chỉ kiểm tra cú pháp. Backend thật vẫn phải chống SSRF trước mọi kết nối.</p></div><form onSubmit={addWebsite} noValidate><label htmlFor="new-site-url">URL website</label><div className="compact-form"><input id="new-site-url" name="url" placeholder="https://example.com" aria-invalid={Boolean(urlError)} aria-describedby={urlError ? 'new-site-error' : 'new-site-help'} /><button className="button button--dark" type="submit">Thêm target</button></div>{urlError ? <p className="field-error" id="new-site-error" role="alert">{urlError}</p> : <small id="new-site-help">Chỉ chấp nhận HTTP hoặc HTTPS.</small>}</form></section> : null}

      <section className="content-card">
        <div className="card-toolbar"><div><h2>Website đã đăng ký</h2><span>{data?.length ?? 0} target</span></div><label className="search-field"><span className="sr-only">Tìm website</span><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Tìm theo tên hoặc domain" /></label></div>
        {loading ? <LoadingState label="Đang tải danh sách website…" /> : error ? <ErrorState /> : filtered.length === 0 ? <EmptyState title="Không có website phù hợp">Thử từ khóa khác hoặc thêm target mới.</EmptyState> : <div className="website-list">{filtered.map((website) => <Link className="website-row" to={`/app/websites/${website.id}`} key={website.id}><span className="site-favicon">{website.hostname.slice(0, 1).toUpperCase()}</span><span className="site-identity"><strong>{website.name}</strong><small>{website.url}</small></span><span className="site-stat"><small>TRANG</small><strong>{website.pageCount}</strong></span><span className="site-stat"><small>FINDINGS</small><strong>{website.findingCount}</strong></span><span className="site-status"><StatusBadge status={website.latestStatus ?? 'QUEUED'} /><small>{website.updatedAt}</small></span><ArrowRight className="row-arrow" aria-hidden="true" /></Link>)}</div>}
      </section>
      <p className="demo-note"><span>DEMO</span>Dữ liệu trên màn hình này được mô phỏng cục bộ và không thực hiện request đến các website.</p>
    </div>
  )
}
