// Folder paths come from the server as it spells them: `/books/Sci-Fi` on Linux and macOS,
// `G:\BT\eBook` or `\\nas\books` on Windows. `/` is the top of the folder picker either way; on
// Windows it is not a real folder but the list of drives.

const DRIVE_ROOT = /^[A-Za-z]:\\$/

export function isWindowsFolderPath(path: string): boolean {
  return /^[A-Za-z]:(?:[\\/]|$)/.test(path) || /^[\\/]{2}[^\\/]/.test(path)
}

/** A full path the server can open: `/…`, a drive path or a network share. */
export function isAbsoluteFolderPath(path: string): boolean {
  return path.startsWith('/') || isWindowsFolderPath(path)
}

export function folderSeparator(path: string): '/' | '\\' {
  return isWindowsFolderPath(path) ? '\\' : '/'
}

export function normalizeFolderPath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed || trimmed === '/' || trimmed === '\\') return '/'
  if (isWindowsFolderPath(trimmed)) {
    const body = trimmed.replace(/[\\/]+/g, '\\').replace(/\\+$/, '')
    if (/^[\\/]{2}/.test(trimmed)) return `\\${body}`
    const drive = `${body.charAt(0).toUpperCase()}${body.slice(1)}`
    return /^[A-Za-z]:$/.test(drive) ? `${drive}\\` : drive
  }
  return trimmed.replace(/\/+$/, '')
}

/** Path parts from the top down. A drive (`G:`) or a share (`\\nas\books`) is one part. */
export function folderSegments(path: string): string[] {
  const normalized = normalizeFolderPath(path)
  if (normalized === '/') return []
  if (!isWindowsFolderPath(normalized)) return normalized.split('/').filter(Boolean)
  if (normalized.startsWith('\\\\')) {
    const [server = '', share = '', ...rest] = normalized.slice(2).split('\\')
    return [share ? `\\\\${server}\\${share}` : `\\\\${server}`, ...rest]
  }
  return normalized.split('\\').filter(Boolean)
}

export function parentFolderPath(path: string): string {
  const parts = folderSegments(path)
  parts.pop()
  if (parts.length === 0) return '/'
  if (!isWindowsFolderPath(normalizeFolderPath(path))) return `/${parts.join('/')}`
  const joined = parts.join('\\')
  return /^[A-Za-z]:$/.test(joined) ? `${joined}\\` : joined
}

export function folderLeafName(path: string): string {
  const normalized = normalizeFolderPath(path)
  if (normalized === '/') return '/'
  if (DRIVE_ROOT.test(normalized)) return normalized.slice(0, 2)
  const parts = folderSegments(normalized)
  return parts[parts.length - 1] ?? normalized
}

export function isPathInside(path: string, parent: string): boolean {
  const child = normalizeFolderPath(path)
  const above = normalizeFolderPath(parent)
  if (child === above) return false
  if (above === '/') return isAbsoluteFolderPath(child)
  const separator = folderSeparator(above)
  return above.endsWith(separator) ? child.startsWith(above) : child.startsWith(`${above}${separator}`)
}

export function coveringFolderPath(path: string, candidates: string[]): string | null {
  const normalized = normalizeFolderPath(path)
  return (
    candidates
      .map(normalizeFolderPath)
      .filter((candidate) => candidate !== normalized && isPathInside(normalized, candidate))
      .sort((a, b) => b.length - a.length)[0] ?? null
  )
}

export function consolidateFolderPaths(paths: string[]): string[] {
  const unique = [...new Set(paths.map(normalizeFolderPath))]
  return unique.filter((path) => !unique.some((candidate) => candidate !== path && isPathInside(path, candidate)))
}
