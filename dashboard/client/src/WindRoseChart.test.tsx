import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { binWind } from './windRose'
import { WindRoseChart } from './WindRoseChart'

// See LineChart.test.tsx: without test.globals, cleanup must be registered.
afterEach(cleanup)

const rose = binWind([
  { bearing: 270, speed: 5 },
  { bearing: 270, speed: 25 },
  { bearing: 90, speed: 12 },
  { bearing: 0, speed: 0 },
])

describe('WindRoseChart', () => {
  it('draws one arc per non-empty sector/speed band, and a hover target per sector', () => {
    render(<WindRoseChart data={rose} width={300} height={300} />)
    // W has two bands, E has one.
    expect(screen.getAllByTestId('wind-arc')).toHaveLength(3)
    expect(screen.getAllByTestId('wind-sector-target')).toHaveLength(16)
  })

  it('shows the calm share in the center', () => {
    render(<WindRoseChart data={rose} width={300} height={300} />)
    expect(screen.getByTestId('wind-calm').textContent).toBe('25%')
  })

  it("reports a sector's share and its speed bands on hover", () => {
    render(<WindRoseChart data={rose} width={300} height={300} />)
    // Sectors render in compass order: index 12 is W.
    fireEvent.mouseMove(screen.getAllByTestId('wind-sector-target')[12])
    expect(screen.getByTestId('wind-tooltip-heading').textContent).toBe('From W · 50%')
    expect(screen.getByText('1–10 km/h')).toBeTruthy()
    expect(screen.getByText('20–30 km/h')).toBeTruthy()
    expect(screen.getByText('2 of 4 observations')).toBeTruthy()
  })

  it('says so when the window has no paired observations', () => {
    render(<WindRoseChart data={binWind([])} width={300} height={300} />)
    expect(screen.getByText('No readings in this range.')).toBeTruthy()
  })
})
