import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { LandingPage } from './LandingPage'

describe('LandingPage', () => {
  it('explains V1.5 and labels the future roadmap', () => {
    render(<MemoryRouter><LandingPage /></MemoryRouter>)
    expect(screen.getByRole('heading', { name: /Chụp lại trang đã sống/i })).toBeInTheDocument()
    expect(screen.getByText(/Các tính năng dưới đây chưa hoạt động/i)).toBeInTheDocument()
  })

  it('shows an accessible validation error for an unsafe protocol', async () => {
    const user = userEvent.setup()
    render(<MemoryRouter><LandingPage /></MemoryRouter>)
    const input = screen.getByLabelText(/Website bạn muốn quan sát/i)
    await user.clear(input)
    await user.type(input, 'file:///etc/passwd')
    await user.click(screen.getByRole('button', { name: /Quét thử/i }))
    expect(screen.getByRole('alert')).toHaveTextContent(/HTTP hoặc HTTPS/i)
    expect(input).toHaveAttribute('aria-invalid', 'true')
  })
})
