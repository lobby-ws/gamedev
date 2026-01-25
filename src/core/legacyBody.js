import { parse as acornParse } from 'acorn'

function indentScriptBody(body, indent = '  ') {
  return body
    .split('\n')
    .map(line => (line ? `${indent}${line}` : line))
    .join('\n')
}

export function buildLegacyBodyModuleSource(code, moduleSpecifier = '<legacy>') {
  let ast
  try {
    ast = acornParse(code, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowHashBang: true,
      allowReturnOutsideFunction: true,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown_error'
    throw new Error(`legacy_body_parse_error:${moduleSpecifier}:${message}`)
  }

  const importNodes = []
  const bodyNodes = []
  let seenNonImport = false

  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration') {
      if (seenNonImport) {
        throw new Error(`legacy_body_imports_must_be_at_top:${moduleSpecifier}`)
      }
      importNodes.push(node)
      continue
    }

    if (
      node.type === 'ExportDefaultDeclaration' ||
      node.type === 'ExportNamedDeclaration' ||
      node.type === 'ExportAllDeclaration'
    ) {
      throw new Error(`legacy_body_exports_not_allowed:${moduleSpecifier}`)
    }

    seenNonImport = true
    bodyNodes.push(node)
  }

  const importSource = importNodes.map(node => code.slice(node.start, node.end)).join('\n')
  const bodySource = bodyNodes.map(node => code.slice(node.start, node.end)).join('\n')
  const indentedBody = bodySource ? indentScriptBody(bodySource) : ''

  return [
    importSource,
    'const shared = {}',
    'export default (world, app, fetch, props, setTimeout) => {',
    '  const config = props // deprecated',
    indentedBody,
    '}',
  ]
    .filter(Boolean)
    .join('\n')
}
