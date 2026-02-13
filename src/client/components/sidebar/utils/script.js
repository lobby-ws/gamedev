export function formatScriptError(error) {
  if (!error) {
    return { title: 'No script error detected.', detail: '' }
  }
  const name = error.name || 'Error'
  const message = error.message || ''
  const title = message ? `${name}: ${message}` : name
  const locationParts = []
  if (error.fileName) {
    locationParts.push(error.fileName)
  }
  if (error.lineNumber) {
    locationParts.push(error.lineNumber)
  }
  if (error.columnNumber) {
    locationParts.push(error.columnNumber)
  }
  const location = locationParts.length ? `at ${locationParts.join(':')}` : ''
  let detail = ''
  if (location) {
    detail = location
  }
  if (error.stack) {
    const lines = String(error.stack).split('\n').slice(0, 6).join('\n')
    detail = detail ? `${detail}\n${lines}` : lines
  }
  return { title, detail }
}

export function getMentionState(value, caret) {
  if (typeof value !== 'string' || !Number.isFinite(caret)) return null
  const upto = value.slice(0, caret)
  const at = upto.lastIndexOf('@')
  if (at === -1) return null
  if (at > 0 && !/\s/.test(upto[at - 1])) return null
  const query = upto.slice(at + 1)
  if (/\s/.test(query)) return null
  return { start: at, query }
}

function fuzzyScore(query, text) {
  if (!text) return 0
  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  if (!lowerQuery) return 1
  let score = 0
  let index = 0
  for (let i = 0; i < lowerQuery.length; i += 1) {
    const ch = lowerQuery[i]
    const found = lowerText.indexOf(ch, index)
    if (found === -1) return 0
    score += found === index ? 3 : 1
    index = found + 1
  }
  if (lowerText.startsWith(lowerQuery)) score += 4
  return score + lowerQuery.length / Math.max(lowerText.length, 1)
}

export function fuzzyMatchList(query, entries) {
  const scored = []
  for (const entry of entries) {
    const score = fuzzyScore(query, entry.path)
    if (!score) continue
    scored.push({ entry, score })
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.entry.path.localeCompare(b.entry.path)
  })
  return scored.map(item => item.entry)
}
