import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { webLensService } from '../api/serviceMode'
import { snapshot } from '../data/mockData'
import { SnapshotPage } from './SnapshotPage'

describe('SnapshotPage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('tải screenshot qua API có xác thực và chỉ render dưới dạng ảnh tĩnh', async () => {
    vi.spyOn(webLensService, 'getSnapshot').mockResolvedValue({
      ...snapshot,
      artifacts: { renderedHtmlBytes: 1200, screenshotBytes: 4 },
    })
    vi.spyOn(webLensService, 'getCaptureScreenshot').mockResolvedValue(new Blob(
      [new Uint8Array([0xff, 0xd8, 0xff, 0xd9])],
      { type: 'image/jpeg' },
    ))
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:weblens-screenshot')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)

    render(
      <MemoryRouter initialEntries={['/app/snapshots/snapshot-1']}>
        <Routes>
          <Route path="/app/snapshots/:snapshotId" element={<SnapshotPage />} />
        </Routes>
      </MemoryRouter>,
    )

    const image = await screen.findByRole('img', { name: /Screenshot của https:\/\/evomi.com\//i })
    expect(image).toHaveAttribute('src', 'blob:weblens-screenshot')
    expect(createObjectUrl).toHaveBeenCalledOnce()
    expect(webLensService.getCaptureScreenshot).toHaveBeenCalledWith('snapshot-1')
    expect(screen.getByText(/không thực thi website/i)).toBeInTheDocument()
    expect(document.querySelector('iframe')).not.toBeInTheDocument()
  })
})
