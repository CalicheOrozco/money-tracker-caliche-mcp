export function normalizeTag (value) {
  return String(value ?? '')
    .trim()
    .replace(/^#/, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]/gu, '')
}

export function parseTags (value) {
  return [...new Set(String(value ?? '').split(',').map(normalizeTag).filter(Boolean))]
}
