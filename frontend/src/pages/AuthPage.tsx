import { ArrowLeft, ArrowRight, Check, Eye, EyeOff, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { authApi } from '../api/authApi'
import { isBackendMode } from '../api/serviceMode'
import { Brand } from '../components/Brand'

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const isRegister = mode === 'register'
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()
  const location = useLocation()
  const targetUrl = (location.state as { targetUrl?: string } | null)?.targetUrl

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const email = String(form.get('email') ?? '')
    const password = String(form.get('password') ?? '')
    const minimumPasswordLength = isBackendMode && isRegister ? 12 : 8
    if (!email.includes('@') || password.length < minimumPasswordLength) {
      setError(`Kiểm tra lại email và mật khẩu tối thiểu ${minimumPasswordLength} ký tự.`)
      return
    }
    setError(null)
    setSubmitting(true)
    if (!isBackendMode) {
      window.setTimeout(() => navigate('/app/websites'), 650)
      return
    }
    try {
      if (isRegister) {
        await authApi.register(email, password, String(form.get('name') ?? ''))
      } else {
        await authApi.login(email, password)
      }
      navigate('/app/websites')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Không thể xác thực với backend.')
      setSubmitting(false)
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-brand"><Brand /><Link to="/"><ArrowLeft size={16} />Về trang chủ</Link></div>
      <section className="auth-panel" aria-labelledby="auth-title">
        <div className="auth-copy"><span className="eyebrow-pill"><span />WEBLENS DEMO</span><h1 id="auth-title">{isRegister ? 'Bắt đầu quan sát website.' : 'Chào mừng bạn trở lại.'}</h1><p>{isRegister ? 'Tạo không gian demo để trải nghiệm luồng scan, report và browser capture.' : 'Đăng nhập vào không gian demo WebLens của bạn.'}</p>{targetUrl ? <div className="target-preview"><small>WEBSITE VỪA NHẬP</small><strong>{targetUrl}</strong></div> : null}</div>
        <form className="auth-form" onSubmit={submit} noValidate aria-busy={submitting}>
          {isRegister ? <div className="field"><label htmlFor="name">Tên hiển thị</label><input id="name" name="name" autoComplete="name" placeholder="Nguyễn Hoàng" required /></div> : null}
          <div className="field"><label htmlFor="email">Email công việc</label><input id="email" name="email" type="email" autoComplete="email" placeholder="developer@example.com" aria-invalid={Boolean(error)} aria-describedby={error ? 'auth-error' : undefined} required /></div>
          <div className="field"><label htmlFor="password">Mật khẩu</label><div className="password-wrap"><input id="password" name="password" type={showPassword ? 'text' : 'password'} autoComplete={isRegister ? 'new-password' : 'current-password'} placeholder="Tối thiểu 8 ký tự" aria-invalid={Boolean(error)} aria-describedby={error ? 'auth-error' : 'password-help'} required minLength={8} /><button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}>{showPassword ? <EyeOff /> : <Eye />}</button></div><small id="password-help">Bản demo không lưu hoặc gửi mật khẩu.</small></div>
          {error ? <p className="form-alert" id="auth-error" role="alert">{error}</p> : null}
          <button className="button button--primary button--full" type="submit" disabled={submitting}>{submitting ? 'Đang chuẩn bị…' : isRegister ? 'Tạo tài khoản demo' : 'Đăng nhập demo'}<ArrowRight size={17} /></button>
          <p className="auth-switch">{isRegister ? 'Đã có tài khoản?' : 'Chưa có tài khoản?'} <Link to={isRegister ? '/login' : '/register'}>{isRegister ? 'Đăng nhập' : 'Tạo tài khoản'}</Link></p>
        </form>
      </section>
      <aside className="auth-aside"><div className="auth-aside-grid" /><div><ShieldCheck /><h2>Bằng chứng trước.<br />Kết luận sau.</h2><p>“Mỗi finding phải chỉ ra điều đã quan sát, quy tắc đã dùng và giới hạn của dữ liệu.”</p><ul><li><Check />Không render HTML không tin cậy</li><li><Check />Không giả lập bảo mật backend</li><li><Check />Không gửi request ra Internet</li></ul></div></aside>
    </main>
  )
}
