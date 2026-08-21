import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchJson } from './api'

describe('fetchJson', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves with the parsed body on a 2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ hello: 'world' }), { status: 200 })),
    )

    await expect(fetchJson('/api/whatever')).resolves.toEqual({ hello: 'world' })
  })

  it('throws using the body\'s error message on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: false, error: 'No .db snapshots found' }), {
            status: 503,
          }),
      ),
    )

    await expect(fetchJson('/api/health')).rejects.toThrow('No .db snapshots found')
  })

  it('falls back to a status-based message when the body has no error field', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))

    await expect(fetchJson('/api/health')).rejects.toThrow('Request failed: 500')
  })
})
