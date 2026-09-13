import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  CircleDashed,
  Clock3,
  Database,
  FileSearch,
  Gauge,
  LoaderCircle,
  RefreshCw,
  ServerCog,
  ShieldCheck,
  XCircle,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ApiError } from '../api/apiClient'
import { isBackendMode, webLensService } from '../api/serviceMode'
import { ErrorState, LoadingState } from '../components/StateView'
import { SeverityBadge, StatusBadge } from '../components/StatusBadge'
import type { Scan, ScanPageRecord, ScanStatus } from '../domain/types'
import { useAsyncData } from '../hooks/useAsyncData'

type ScanTab = 'overview' | 'pages' | 'issues'
type PipelineState = 'done' | 'active' | 'pending'

const terminalStatuses = new Set<ScanStatus>(['COMPLETED', 'PARTIAL_SUCCESS', 'FAILED', 'CANCELLED'])
const emptyScanPages: ScanPageRecord[] = []

function isTerminal(status: ScanStatus) {
  return terminalStatuses.has(status)
}

function useLiveDemo(scan: Scan | null, enabled: boolean) {
  const [override, setOverride] = useState<{ scanId: string; processed: number; status: ScanStatus } | null>(null)
  const activeOverride = override?.scanId === scan?.id ? override : null
  const processed = activeOverride?.processed ?? scan?.progress.processed ?? 0
  const status = activeOverride?.status ?? scan?.status ?? 'QUEUED'

  useEffect(() => {
    if (!scan || !enabled || scan.status !== 'RUNNING') return
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
    setStatus: (nextStatus: ScanStatus) => {
      if (scan && enabled) setOverride({ scanId: scan.id, processed, status: nextStatus })
    },
  }
}

function statusCopy(status: ScanStatus) {
  switch (status) {
    case 'QUEUED':
      return { title: 'Đang chờ crawler nhận việc', detail: 'Yêu cầu đã được lưu bền vững và đang chờ dispatch.' }
    case 'RUNNING':
      return { title: 'Crawler đang thu thập bằng chứng', detail: 'Tiến độ được đồng bộ từ Control Plane mỗi 2 giây.' }
    case 'CANCEL_REQUESTED':
      return { title: 'Đang dừng an toàn', detail: 'Worker hoàn tất phần việc đang giữ lease trước khi kết thúc.' }
    case 'COMPLETED':
      return { title: 'Lần quét đã hoàn tất', detail: 'Toàn bộ công việc hợp lệ đã được xử lý.' }
    case 'PARTIAL_SUCCESS':
      return { title: 'Hoàn tất với dữ liệu một phần', detail: 'Một số trang không thể thu thập; hãy xem chi tiết bên dưới.' }
    case 'FAILED':
      return { title: 'Lần quét thất bại', detail: 'Không thể hoàn tất lần quét trong các giới hạn đã cấu hình.' }
    case 'CANCELLED':
      return { title: 'Lần quét đã được hủy', detail: 'Bằng chứng đã công bố trước khi hủy vẫn được giữ lại.' }
  }
}

function formatBytes(bytes?: number) {
  if (bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function outcomeLabel(outcome: ScanPageRecord['outcome']) {
  if (outcome === 'success') return 'Thành công'
  if (outcome === 'warning') return 'Cảnh báo'
  return 'Thất bại'
}

function ScanPagesTable({ pages }: { pages: ScanPageRecord[] }) {
  if (pages.length === 0) {
    return (
      <div className="scan-empty">
        <CircleDashed aria-hidden="true" />
        <strong>Chưa có trang phù hợp</strong>
        <span>Crawler chưa công bố dữ liệu hoặc bộ lọc hiện tại không có kết quả.</span>
      </div>
    )
  }

  return (
    <div className="scan-table-wrap">
      <table className="scan-table">
        <thead>
          <tr>
            <th scope="col">URL</th>
            <th scope="col">HTTP</th>
            <th scope="col">Kết quả</th>
            <th scope="col">Phản hồi</th>
            <th scope="col">Findings</th>
            <th scope="col"><span className="sr-only">Mở trang</span></th>
          </tr>
        </thead>
        <tbody>
          {pages.map((page) => (
            <tr key={page.id}>
              <td>
                <Link className="scan-url" to={`/app/pages/${page.id}`}>
                  <strong>{page.path}</strong>
                  <span>{page.url}</span>
                </Link>
              </td>
              <td><code className={`http-code http-code--${page.statusCode ? Math.floor(page.statusCode / 100) : 'none'}`}>{page.statusCode ?? '—'}</code></td>
              <td><span className={`outcome-label outcome-label--${page.outcome}`}><i aria-hidden="true" />{outcomeLabel(page.outcome)}</span></td>
              <td>{page.responseTimeMs === undefined ? 'Không có' : `${page.responseTimeMs} ms`}</td>
              <td>{page.findings.length}</td>
              <td><Link className="icon-link" to={`/app/pages/${page.id}`} aria-label={`Mở bằng chứng của ${page.path}`}><ArrowRight /></Link></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function ScanPage() {
  const { scanId = '' } = useParams()
  const [tab, setTab] = useState<ScanTab>('overview')
  const [cancelling, setCancelling] = useState(false)
  const [cancelAccepted, setCancelAccepted] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const scanState = useAsyncData(() => webLensService.getScan(scanId), `scan:${scanId}`, {
    pollIntervalMs: isBackendMode ? 2000 : undefined,
    shouldPoll: (scan) => !isTerminal(scan.status),
    shouldPollOnError: () => false,
  })
  const live = useLiveDemo(scanState.data, !isBackendMode)
  const displayedStatus: ScanStatus = cancelAccepted && !isTerminal(live.status) ? 'CANCEL_REQUESTED' : live.status
  const active = !isTerminal(displayedStatus)
  const pagesState = useAsyncData(() => webLensService.listScanPages(scanId), `scan-pages:${scanId}`, {
    pollIntervalMs: isBackendMode ? 2500 : undefined,
    shouldPoll: () => active,
    shouldPollOnError: () => active,
  })

  const report = pagesState.data
  const allPages = report?.items ?? emptyScanPages
  const issuePages = useMemo(() => allPages.filter((page) => page.findings.length > 0 || page.outcome !== 'success'), [allPages])
  const totalFindings = useMemo(() => allPages.reduce((total, page) => total + page.findings.length, 0), [allPages])
  const firstIssuePage = issuePages[0]
  const httpBuckets = useMemo(() => {
    const buckets = [
      { label: '2xx', count: 0, tone: 'success' },
      { label: '3xx', count: 0, tone: 'redirect' },
      { label: '4xx', count: 0, tone: 'warning' },
      { label: '5xx', count: 0, tone: 'danger' },
      { label: 'Không phản hồi', count: 0, tone: 'muted' },
    ]
    for (const page of allPages) {
      if (page.statusCode === undefined) buckets[4].count += 1
      else if (page.statusCode >= 500) buckets[3].count += 1
      else if (page.statusCode >= 400) buckets[2].count += 1
      else if (page.statusCode >= 300) buckets[1].count += 1
      else if (page.statusCode >= 200) buckets[0].count += 1
      else buckets[4].count += 1
    }
    return buckets
  }, [allPages])

  if (scanState.loading) return <div className="app-page"><LoadingState label="Đang tải lần quét…" /></div>
  if (!scanState.data) {
    return <div className="app-page"><ErrorState title="Không tìm thấy lần quét" message={scanState.error?.message} /></div>
  }

  const scan = scanState.data
  const copy = statusCopy(displayedStatus)
  const percent = Math.min(100, Math.round((live.processed / Math.max(scan.progress.discovered, 1)) * 100))
  const displayedSucceeded = Math.min(
    scan.progress.succeeded + Math.max(live.processed - scan.progress.processed, 0),
    live.processed,
  )
  const analyticsExpected = report?.analyticsExpectedCount ?? 0
  const analyticsPublished = report?.analyticsPublishedCount ?? 0
  const analyticsReady = Boolean(report?.fresh && (analyticsExpected > 0 || isTerminal(displayedStatus)))
  const analyticsPercent = analyticsExpected === 0
    ? (analyticsReady ? 100 : 0)
    : Math.min(100, Math.round((analyticsPublished / analyticsExpected) * 100))
  const pipeline: Array<{ label: string; detail: string; state: PipelineState }> = [
    { label: 'Yêu cầu được lưu', detail: scan.createdAt, state: 'done' },
    {
      label: 'Crawler thực thi',
      detail: displayedStatus === 'QUEUED' ? 'Đang chờ worker' : `${live.processed}/${scan.progress.discovered} trang đã xử lý`,
      state: displayedStatus === 'QUEUED' ? 'pending' : active ? 'active' : 'done',
    },
    {
      label: 'ClickHouse lập chỉ mục',
      detail: report ? `${analyticsPublished}/${analyticsExpected} payload đã công bố` : 'Chưa có watermark',
      state: analyticsReady ? 'done' : analyticsExpected > 0 ? 'active' : 'pending',
    },
    {
      label: 'Báo cáo sẵn sàng',
      detail: analyticsReady && isTerminal(displayedStatus) ? 'Dữ liệu đã đồng bộ' : 'Chờ lifecycle và analytics hội tụ',
      state: analyticsReady && isTerminal(displayedStatus) ? 'done' : isTerminal(displayedStatus) ? 'active' : 'pending',
    },
  ]

  async function cancelScan() {
    if (cancelling) return
    setCancelling(true)
    setCancelError(null)
    try {
      const cancelled = await webLensService.cancelScan(scan.id)
      setCancelAccepted(cancelled.status === 'CANCEL_REQUESTED')
      live.setStatus(cancelled.status)
    } catch (error: unknown) {
      const requestId = error instanceof ApiError ? ` · Mã theo dõi ${error.requestId}` : ''
      setCancelError(`${error instanceof Error ? error.message : 'Không thể hủy lần quét.'}${requestId}`)
    } finally {
      setCancelling(false)
    }
  }

  return (
    <div className="app-page scan-page">
      <Link className="back-link" to={`/app/websites/${scan.websiteId}`}><ArrowLeft />Quay lại website</Link>

      <header className="scan-page-header">
        <div>
          <span className="page-kicker">SCAN · {scan.id.slice(0, 8).toUpperCase()}</span>
          <h1>{copy.title}</h1>
          <p>{copy.detail}</p>
        </div>
        <div className="scan-header-actions">
          <StatusBadge status={displayedStatus} />
          {active ? (
            <button className="button button--danger-ghost" type="button" onClick={cancelScan} disabled={cancelling || displayedStatus === 'CANCEL_REQUESTED'}>
              {cancelling ? <LoaderCircle className="spin" /> : <XCircle />}
              {cancelling ? 'Đang gửi yêu cầu…' : displayedStatus === 'CANCEL_REQUESTED' ? 'Đang hủy…' : 'Hủy lần quét'}
            </button>
          ) : null}
        </div>
      </header>

      {cancelError ? <div className="scan-alert scan-alert--error" role="alert"><AlertTriangle />{cancelError}</div> : null}
      {scanState.error && scanState.data ? (
        <div className="scan-alert" role="status"><RefreshCw />Mất kết nối khi làm mới tiến độ. WebLens đang giữ dữ liệu gần nhất.</div>
      ) : null}

      <section className="scan-control-panel" aria-live="polite" aria-busy={scanState.refreshing || pagesState.refreshing}>
        <div className="scan-control-meta">
          <span><Activity />TRẠNG THÁI VẬN HÀNH</span>
          <span className={scanState.refreshing || pagesState.refreshing ? 'is-syncing' : ''}>
            <i aria-hidden="true" />{isBackendMode ? 'Đồng bộ tự động' : 'Dữ liệu mô phỏng'}
          </span>
        </div>
        <div className="scan-control-main">
          <div className="scan-progress-ring" style={{ '--progress': `${percent * 3.6}deg` } as React.CSSProperties}>
            <span><strong>{percent}%</strong><small>Đã xử lý</small></span>
          </div>
          <div className="scan-progress-copy">
            <span className="scan-eyebrow">PROGRESS VERSION · LIVE PROJECTION</span>
            <h2>{live.processed} trên {scan.progress.discovered} trang</h2>
            <p>Giới hạn cứng {scan.progress.limit} trang · Thời lượng {scan.duration} · Collector {scan.collectorVersion ?? 'crawler-v1'}</p>
          </div>
          <div className="analytics-signal">
            <Database />
            <span><small>CLICKHOUSE</small><strong>{analyticsReady ? 'Đã đồng bộ' : analyticsExpected > 0 ? 'Đang lập chỉ mục' : 'Chờ dữ liệu'}</strong></span>
            <b>{analyticsPercent}%</b>
          </div>
        </div>
        <div className="scan-meter"><span style={{ width: `${percent}%` }} /></div>
        <div className="scan-kpis">
          <div><FileSearch /><span><small>PHÁT HIỆN</small><strong>{scan.progress.discovered}</strong></span></div>
          <div><CircleDashed /><span><small>TRONG HÀNG ĐỢI</small><strong>{scan.progress.queued}</strong></span></div>
          <div><Gauge /><span><small>Đã xử lý</small><strong>{live.processed}</strong></span></div>
          <div><Check /><span><small>THÀNH CÔNG</small><strong>{displayedSucceeded}</strong></span></div>
          <div><AlertTriangle /><span><small>THẤT BẠI</small><strong>{scan.progress.failed}</strong></span></div>
        </div>
      </section>

      <section className="scan-workspace">
        <div className="scan-tabs" role="tablist" aria-label="Nội dung báo cáo quét">
          <button id="scan-tab-overview" role="tab" aria-selected={tab === 'overview'} aria-controls="scan-panel" className={tab === 'overview' ? 'active' : ''} type="button" onClick={() => setTab('overview')}>Tổng quan</button>
          <button id="scan-tab-pages" role="tab" aria-selected={tab === 'pages'} aria-controls="scan-panel" className={tab === 'pages' ? 'active' : ''} type="button" onClick={() => setTab('pages')}>Trang <span>{allPages.length}</span></button>
          <button id="scan-tab-issues" role="tab" aria-selected={tab === 'issues'} aria-controls="scan-panel" className={tab === 'issues' ? 'active' : ''} type="button" onClick={() => setTab('issues')}>Vấn đề <span>{issuePages.length}</span></button>
          <div className="scan-data-freshness">
            <i className={analyticsReady ? 'fresh' : ''} aria-hidden="true" />
            {analyticsReady ? `Watermark ${report?.analyticsWatermark ?? 'sẵn sàng'}` : `${analyticsPublished}/${analyticsExpected} đã lập chỉ mục`}
          </div>
        </div>

        <div id="scan-panel" className="scan-tab-panel" role="tabpanel" aria-labelledby={`scan-tab-${tab}`}>
          {pagesState.error ? (
            <div className={`scan-report-notice ${report ? 'scan-report-notice--stale' : ''}`} role="status">
              <RefreshCw />
              <div>
                <strong>{report ? 'Dữ liệu trang có thể đã cũ' : 'Crawler đang chuẩn bị báo cáo'}</strong>
                <span>{report ? 'Lần làm mới gần nhất thất bại; dữ liệu đã tải vẫn được giữ nguyên.' : 'Endpoint báo cáo chưa sẵn sàng. WebLens sẽ tự thử lại trong khi scan còn hoạt động.'}</span>
              </div>
            </div>
          ) : null}

          {pagesState.loading ? <LoadingState label="Đang đọc analytical projection…" /> : null}

          {!pagesState.loading && tab === 'overview' ? (
            <div className="scan-overview-grid">
              <article className="scan-insight-card">
                <header><div><span className="scan-eyebrow">RESPONSE PROFILE</span><h2>Phân bố trạng thái HTTP</h2></div><strong>{allPages.length} URL</strong></header>
                <div className="http-distribution">
                  {httpBuckets.map((bucket) => (
                    <div key={bucket.label}>
                      <span>{bucket.label}</span>
                      <div><i className={`http-bar--${bucket.tone}`} style={{ width: `${Math.round((bucket.count / Math.max(allPages.length, 1)) * 100)}%` }} /></div>
                      <strong>{bucket.count}</strong>
                    </div>
                  ))}
                </div>
              </article>

              <article className="scan-insight-card">
                <header><div><span className="scan-eyebrow">DURABLE PIPELINE</span><h2>Luồng xử lý</h2></div><ServerCog /></header>
                <ol className="scan-pipeline">
                  {pipeline.map((step) => (
                    <li className={`pipeline--${step.state}`} key={step.label}>
                      <i aria-hidden="true">{step.state === 'done' ? <Check /> : null}</i>
                      <div><strong>{step.label}</strong><span>{step.detail}</span></div>
                    </li>
                  ))}
                </ol>
                <p className="pipeline-note"><ShieldCheck />Luồng này được suy ra từ projection thật, không phải event stream giả.</p>
              </article>

              <article className="scan-insight-card scan-config-card">
                <header><div><span className="scan-eyebrow">EFFECTIVE POLICY</span><h2>Giới hạn đã áp dụng</h2></div><Clock3 /></header>
                <dl>
                  <div><dt>Số trang tối đa</dt><dd>{scan.effectiveConfig?.maxPages ?? scan.progress.limit}</dd></div>
                  <div><dt>Độ sâu tối đa</dt><dd>{scan.effectiveConfig?.maxDepth ?? '—'}</dd></div>
                  <div><dt>Concurrency</dt><dd>{scan.effectiveConfig?.concurrency ?? '—'}</dd></div>
                  <div><dt>Response tối đa</dt><dd>{formatBytes(scan.effectiveConfig?.maxResponseBytes)}</dd></div>
                  <div><dt>Thời gian tối đa</dt><dd>{scan.effectiveConfig ? `${scan.effectiveConfig.maxDurationSeconds}s` : '—'}</dd></div>
                  <div><dt>Redirect tối đa</dt><dd>{scan.effectiveConfig?.maxRedirects ?? '—'}</dd></div>
                </dl>
              </article>

              <article className="scan-insight-card scan-index-card">
                <header><div><span className="scan-eyebrow">ANALYTICS COVERAGE</span><h2>Độ mới dữ liệu</h2></div><Database /></header>
                <div className="index-score"><strong>{analyticsPercent}%</strong><span>{analyticsPublished} / {analyticsExpected} payload</span></div>
                <div className="index-meter"><span style={{ width: `${analyticsPercent}%` }} /></div>
                <p>{analyticsReady ? 'Page metrics và findings đã đạt watermark hiện tại.' : 'Lifecycle vẫn đọc được trong khi ClickHouse tiếp tục hội tụ.'}</p>
              </article>

              {scan.terminalReason ? (
                <article className="scan-terminal-card">
                  <AlertTriangle />
                  <div><span>{scan.terminalReason.code}</span><strong>{scan.terminalReason.message}</strong></div>
                </article>
              ) : null}
            </div>
          ) : null}

          {!pagesState.loading && tab === 'pages' ? <ScanPagesTable pages={allPages} /> : null}
          {!pagesState.loading && tab === 'issues' ? <ScanPagesTable pages={issuePages} /> : null}
        </div>
      </section>

      <section className={`finding-strip ${totalFindings === 0 ? 'finding-strip--clean' : ''}`}>
        <div>
          {totalFindings > 0 ? <SeverityBadge severity="warning" /> : <Check />}
          <strong>{totalFindings > 0 ? `${totalFindings} finding${totalFindings > 1 ? 's' : ''} cần xem` : 'Chưa có finding trong dữ liệu đã công bố'}</strong>
          <span>Kết quả deterministic, không dùng AI để quyết định.</span>
        </div>
        {firstIssuePage ? <Link to={`/app/pages/${firstIssuePage.id}`}>Mở bằng chứng nổi bật <ArrowRight /></Link> : null}
      </section>
    </div>
  )
}
