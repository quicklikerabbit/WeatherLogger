// fetch() only rejects on network failure, not HTTP error status — without
// this, a 503/400 body like { ok: false, error: "..." } gets treated as
// success data and crashes downstream code expecting the real shape.
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const data = await res.json()
  if (!res.ok) {
    throw new Error(data.error ?? `Request failed: ${res.status}`)
  }
  return data as T
}
