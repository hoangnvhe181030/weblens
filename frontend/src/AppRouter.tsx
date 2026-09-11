import { Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import { AuthPage } from './pages/AuthPage'
import { LandingPage } from './pages/LandingPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { PageDetailPage } from './pages/PageDetailPage'
import { ScanPage } from './pages/ScanPage'
import { SnapshotPage } from './pages/SnapshotPage'
import { WebsiteDetailPage } from './pages/WebsiteDetailPage'
import { WebsitesPage } from './pages/WebsitesPage'

export function AppRouter() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<AuthPage mode="login" />} />
      <Route path="/register" element={<AuthPage mode="register" />} />
      <Route path="/app" element={<AppShell />}>
        <Route index element={<Navigate to="websites" replace />} />
        <Route path="websites" element={<WebsitesPage />} />
        <Route path="websites/:websiteId" element={<WebsiteDetailPage />} />
        <Route path="scans/:scanId" element={<ScanPage />} />
        <Route path="pages/:scanPageId" element={<PageDetailPage />} />
        <Route path="snapshots/:snapshotId" element={<SnapshotPage />} />
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  )
}
