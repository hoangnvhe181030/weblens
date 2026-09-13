import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { webLensService } from '../api/serviceMode'
import { scanPages } from '../data/mockData'
import type { Capture } from '../domain/types'
import { PageDetailPage } from './PageDetailPage'

describe('PageDetailPage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('liên kết tới capture hoàn tất mới nhất thay vì snapshot demo cố định', async () => {
    const page = scanPages[0]
    const latestCapture: Capture = {
      id: '6132a7d3-591e-481a-8131-628d5401068a',
      scanId: page.scanId,
      pageId: page.id,
      status: 'COMPLETED',
      targetUrl: page.url,
      measurementProfile: 'desktop-lab-v1',
      analyticsExpectedCount: 1,
      analyticsPublishedCount: 1,
      objectCount: 2,
      totalObjectBytes: 17_739,
      createdAt: 'Vừa xong',
    }
    vi.spyOn(webLensService, 'getScanPage').mockResolvedValue(page)
    vi.spyOn(webLensService, 'getLatestCapture').mockResolvedValue(latestCapture)

    render(
      <MemoryRouter initialEntries={[`/app/pages/${page.id}`]}>
        <Routes>
          <Route path="/app/pages/:scanPageId" element={<PageDetailPage />} />
        </Routes>
      </MemoryRouter>,
    )

    const link = await screen.findByRole('link', { name: /Xem snapshot gần nhất/i })
    expect(link).toHaveAttribute('href', `/app/snapshots/${latestCapture.id}`)
    expect(link).not.toHaveAttribute('href', '/app/snapshots/snapshot-1')
  })
})
