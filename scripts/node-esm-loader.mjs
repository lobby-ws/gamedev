import path from 'node:path'

export async function resolve(specifier, context, defaultResolve) {
  const isRelative = specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/')
  if (!isRelative) {
    return defaultResolve(specifier, context, defaultResolve)
  }

  try {
    return await defaultResolve(specifier, context, defaultResolve)
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' && error?.code !== 'ERR_UNSUPPORTED_DIR_IMPORT') {
      throw error
    }
    if (path.extname(specifier) && error?.code !== 'ERR_UNSUPPORTED_DIR_IMPORT') {
      throw error
    }
  }

  const candidates = [
    `${specifier}.js`,
    `${specifier}.json`,
    `${specifier}.node`,
    `${specifier}/index.js`,
    `${specifier}/index.json`,
    `${specifier}/index.node`,
  ]

  for (const candidate of candidates) {
    try {
      return await defaultResolve(candidate, context, defaultResolve)
    } catch {}
  }

  return defaultResolve(specifier, context, defaultResolve)
}
