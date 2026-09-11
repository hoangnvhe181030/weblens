import { Aperture, Check, Code2, FileSearch, Image, Link2, LoaderCircle, TriangleAlert } from 'lucide-react'

export function ScanVisual() {
  return (
    <div className="scan-visual" aria-label="Minh họa WebLens đang quét website">
      <div className="scan-visual__top"><span className="window-dots" aria-hidden="true"><i /><i /><i /></span><span className="address">https://your-site.dev</span><span className="live-dot">LIVE</span></div>
      <div className="scan-visual__body">
        <div className="visual-rail">
          <span className="rail-logo"><Aperture size={17} /></span>
          <span /><span /><span /><span />
        </div>
        <div className="visual-content">
          <div className="visual-heading"><div><small>SCAN #WL-104</small><strong>Đang đọc bằng chứng</strong></div><span className="visual-status"><LoaderCircle className="spin" size={15} />68%</span></div>
          <div className="visual-progress"><span /></div>
          <div className="visual-stats">
            <div><small>Đã phát hiện</small><strong>18</strong></div><div><small>Thành công</small><strong>11</strong></div><div><small>Cảnh báo</small><strong>03</strong></div>
          </div>
          <div className="visual-feed">
            <div><span className="feed-icon ok"><Check /></span><span><strong>/</strong><small>200 · 684 ms</small></span><span className="resource-icons"><Code2 /><Image /><Link2 /></span></div>
            <div><span className="feed-icon ok"><Check /></span><span><strong>/pricing</strong><small>200 · 312 ms</small></span><span className="feed-tag">Sạch</span></div>
            <div><span className="feed-icon warn"><TriangleAlert /></span><span><strong>/locations</strong><small>503 · không khả dụng</small></span><span className="feed-tag feed-tag--warn">Lỗi</span></div>
            <div className="is-loading"><span className="feed-icon"><FileSearch /></span><span><strong>/docs</strong><small>Đang phân tích HTML…</small></span></div>
          </div>
        </div>
      </div>
    </div>
  )
}
