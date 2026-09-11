import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { AppRouter } from './AppRouter'

describe('AppRouter', () => {
  it('renders the website dashboard route', async () => {
    render(<MemoryRouter initialEntries={['/app/websites']}><AppRouter /></MemoryRouter>)
    expect(await screen.findByRole('heading', { name: 'Websites' })).toBeInTheDocument()
    expect(await screen.findByText('Evomi Marketing')).toBeInTheDocument()
  })

  it('renders a branded not-found page', () => {
    render(<MemoryRouter initialEntries={['/not-real']}><AppRouter /></MemoryRouter>)
    expect(screen.getByRole('heading', { name: /ngoài frontier/i })).toBeInTheDocument()
  })
})
