import type { FindingSeverity, ScanStatus } from '../domain/types'

const scanLabels: Record<ScanStatus, string> = {
  QUEUED: 'Đang chờ',
  RUNNING: 'Đang quét',
  CANCEL_REQUESTED: 'Đang hủy',
  COMPLETED: 'Hoàn tất',
  PARTIAL_SUCCESS: 'Hoàn tất một phần',
  FAILED: 'Thất bại',
  CANCELLED: 'Đã hủy',
}

export function StatusBadge({ status }: { status: ScanStatus }) {
  const tone = status === 'COMPLETED' ? 'success' : status === 'RUNNING' || status === 'QUEUED' ? 'active' : status === 'PARTIAL_SUCCESS' ? 'warning' : 'danger'
  return <span className={`status status--${tone}`}><span aria-hidden="true" />{scanLabels[status]}</span>
}

const severityLabels: Record<FindingSeverity, string> = { critical: 'Nghiêm trọng', warning: 'Cảnh báo', info: 'Thông tin' }

export function SeverityBadge({ severity }: { severity: FindingSeverity }) {
  return <span className={`status status--${severity === 'critical' ? 'danger' : severity}`}>{severityLabels[severity]}</span>
}
