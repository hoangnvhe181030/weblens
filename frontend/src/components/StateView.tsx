import { AlertTriangle, Inbox, LoaderCircle } from 'lucide-react'
import type { ReactNode } from 'react'

export function LoadingState({ label = 'Đang tải dữ liệu…' }: { label?: string }) {
  return <div className="state-view" role="status" aria-live="polite"><LoaderCircle className="spin" aria-hidden="true" /><strong>{label}</strong><span>WebLens đang chuẩn bị bằng chứng.</span></div>
}

export function ErrorState({ title = 'Không thể tải dữ liệu', message = 'Hãy thử tải lại trang.' }: { title?: string; message?: string }) {
  return <div className="state-view state-view--error" role="alert"><AlertTriangle aria-hidden="true" /><strong>{title}</strong><span>{message}</span><button className="button button--secondary" type="button" onClick={() => window.location.reload()}>Thử lại</button></div>
}

export function EmptyState({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="state-view"><Inbox aria-hidden="true" /><strong>{title}</strong><span>{children}</span>{action}</div>
}
