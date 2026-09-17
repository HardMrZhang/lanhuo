import type { Category, Drama, DramaSummary } from './types'

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

export const api = {
  categories: () => get<Category[]>('/api/categories'),
  dramas: (params: { category?: string; q?: string; sort?: string } = {}) => {
    const qs = new URLSearchParams()
    if (params.category && params.category !== 'all') qs.set('category', params.category)
    if (params.q) qs.set('q', params.q)
    if (params.sort) qs.set('sort', params.sort)
    const suffix = qs.toString() ? `?${qs}` : ''
    return get<DramaSummary[]>(`/api/dramas${suffix}`)
  },
  drama: (id: string) => get<Drama>(`/api/dramas/${encodeURIComponent(id)}`),
}
