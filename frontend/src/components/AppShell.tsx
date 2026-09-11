import { Aperture, Globe2, LogOut, Menu, PanelLeftClose, ScanLine, Settings, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { authApi } from '../api/authApi'
import type { ApiUser } from '../api/contracts'
import { isBackendMode } from '../api/serviceMode'
import { Brand } from './Brand'

const demoNavItems = [
  { to: '/app/websites', label: 'Websites', icon: Globe2 },
  { to: '/app/scans/scan-104', label: 'Lần quét đang chạy', icon: ScanLine },
  { to: '/app/snapshots/snapshot-1', label: 'Bản chụp gần nhất', icon: Aperture },
]

export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false)
  const [user, setUser] = useState<ApiUser | null>(null)
  const navigate = useNavigate()
  const closeMobileNav = () => setMobileOpen(false)
  const navItems = isBackendMode ? demoNavItems.slice(0, 1) : demoNavItems

  useEffect(() => {
    if (!isBackendMode) return
    let active = true
    authApi.me()
      .then((currentUser) => { if (active) setUser(currentUser) })
      .catch(() => { if (active) navigate('/login', { replace: true }) })
    return () => { active = false }
  }, [navigate])

  async function logout() {
    if (isBackendMode) {
      try {
        await authApi.logout()
      } catch {
        // Local credentials are cleared by the API client even if the session has already expired.
      }
    }
    closeMobileNav()
    navigate('/login')
  }

  return (
    <div className="app-frame">
      <a className="skip-link" href="#main-content">Đi đến nội dung chính</a>
      <button className="mobile-menu" type="button" aria-label={mobileOpen ? 'Đóng điều hướng' : 'Mở điều hướng'} aria-expanded={mobileOpen} aria-controls="app-sidebar" onClick={() => setMobileOpen((value) => !value)}>
        {mobileOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
      </button>
      {mobileOpen ? <button className="sidebar-backdrop" type="button" aria-label="Đóng điều hướng" onClick={() => setMobileOpen(false)} /> : null}
      <aside className={`app-sidebar${mobileOpen ? ' is-open' : ''}`} id="app-sidebar">
        <div className="sidebar-top"><Brand inverse /><button type="button" className="icon-button sidebar-collapse" aria-label="Thu gọn thanh điều hướng"><PanelLeftClose aria-hidden="true" /></button></div>
        <div className="workspace-chip"><span className="workspace-avatar">W</span><span><strong>WebLens Lab</strong><small>Không gian demo</small></span></div>
        <nav className="side-nav" aria-label="Điều hướng ứng dụng">
          <p className="side-label">Quan sát</p>
          {navItems.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} onClick={closeMobileNav} className={({ isActive }) => isActive ? 'active' : undefined}><Icon size={18} aria-hidden="true" />{label}</NavLink>)}
        </nav>
        <div className="sidebar-bottom">
          <button type="button"><Settings size={18} aria-hidden="true" />Cài đặt demo</button>
          <button type="button" onClick={logout}><LogOut size={18} aria-hidden="true" />Đăng xuất</button>
          <div className="user-chip"><span className="user-avatar">{user ? user.displayName.slice(0, 2).toUpperCase() : 'NH'}</span><span><strong>{user?.displayName ?? 'Nguyễn Hoàng'}</strong><small>{user?.email ?? 'developer@weblens.dev'}</small></span></div>
        </div>
      </aside>
      <main className="app-main" id="main-content"><Outlet /></main>
    </div>
  )
}
