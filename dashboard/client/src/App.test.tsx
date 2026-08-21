import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'

// jsdom doesn't implement ResizeObserver, which @visx/responsive's
// ParentSize (used to size the chart) relies on.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe('App', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // Regression test: fetch() doesn't reject on HTTP error status, so a 503
  // error body used to be treated as success data and crash the whole
  // component (setSeries(undefined) -> series.map throws in render).
  it('shows the server error message instead of crashing when no snapshot exists', async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error: 'No .db snapshots found in /backups. Run backup.sh first.',
            }),
            { status: 503 },
          ),
      ),
    )

    render(<App />)

    expect(
      await screen.findByText('Error: No .db snapshots found in /backups. Run backup.sh first.'),
    ).toBeTruthy()
  })
})
