#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

ROOT_DIR="${DEFAULT_ROOT}"
FORCE=0

usage() {
  cat <<'EOF'
Create a baseline mods test set for manual verification.

Usage:
  scripts/create-mods-manual.sh [--root <path>] [--force]

Options:
  --root <path>  Project root (defaults to repo root)
  --force        Replace existing ./mods content
  -h, --help     Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --root" >&2
        exit 1
      fi
      ROOT_DIR="$2"
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

MODS_DIR="${ROOT_DIR}/mods"

if [[ -d "${MODS_DIR}" ]] && [[ -n "$(find "${MODS_DIR}" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
  if [[ "${FORCE}" -ne 1 ]]; then
    echo "Refusing to overwrite existing ${MODS_DIR}. Re-run with --force." >&2
    exit 1
  fi
  rm -rf "${MODS_DIR}"
fi

mkdir -p \
  "${MODS_DIR}/core/server" \
  "${MODS_DIR}/core/client" \
  "${MODS_DIR}/core/shared" \
  "${MODS_DIR}/client/components" \
  "${MODS_DIR}/client/sidebar"

cat > "${MODS_DIR}/core/server/server_echo.js" <<'EOF'
export default class ServerEchoMod {
  constructor(world) {
    this.world = world
  }
  async init() {}
  start() {
    console.log('[mods-manual] server mod active')
  }
  preTick() {}
  preFixedUpdate() {}
  fixedUpdate() {}
  postFixedUpdate() {}
  preUpdate() {}
  update() {}
  postUpdate() {}
  lateUpdate() {}
  postLateUpdate() {}
  commit() {}
  postTick() {}
  destroy() {}
}
EOF

cat > "${MODS_DIR}/core/shared/shared_echo.js" <<'EOF'
export default class SharedEchoMod {
  constructor(world) {
    this.world = world
  }
  async init() {}
  start() {
    console.log('[mods-manual] shared mod active')
  }
  preTick() {}
  preFixedUpdate() {}
  fixedUpdate() {}
  postFixedUpdate() {}
  preUpdate() {}
  update() {}
  postUpdate() {}
  lateUpdate() {}
  postLateUpdate() {}
  commit() {}
  postTick() {}
  destroy() {}
}
EOF

cat > "${MODS_DIR}/core/client/client_a.js" <<'EOF'
export default class ClientAMod {
  constructor(world) {
    this.world = world
  }
  async init() {}
  start() {
    console.log('[mods-manual] client A active')
  }
  preTick() {}
  preFixedUpdate() {}
  fixedUpdate() {}
  postFixedUpdate() {}
  preUpdate() {}
  update() {}
  postUpdate() {}
  lateUpdate() {}
  postLateUpdate() {}
  commit() {}
  postTick() {}
  destroy() {}
}
EOF

cat > "${MODS_DIR}/core/client/client_b.js" <<'EOF'
export default class ClientBMod {
  constructor(world) {
    this.world = world
  }
  async init() {}
  start() {
    console.log('[mods-manual] client B active')
  }
  preTick() {}
  preFixedUpdate() {}
  fixedUpdate() {}
  postFixedUpdate() {}
  preUpdate() {}
  update() {}
  postUpdate() {}
  lateUpdate() {}
  postLateUpdate() {}
  commit() {}
  postTick() {}
  destroy() {}
}
EOF

cat > "${MODS_DIR}/client/components/status.js" <<'EOF'
import { createElement } from 'react'

export default function StatusMod() {
  return createElement(
    'div',
    {
      style: {
        position: 'absolute',
        top: '12px',
        left: '12px',
        padding: '6px 10px',
        background: 'rgba(0, 0, 0, 0.65)',
        color: '#8ff7a7',
        border: '1px solid #8ff7a7',
        borderRadius: '8px',
        fontSize: '12px',
        pointerEvents: 'none',
      },
    },
    'mods component ok'
  )
}
EOF

cat > "${MODS_DIR}/client/sidebar/tools.js" <<'EOF'
export function ToolsButton() {
  return 'Mod Tools'
}

export function ToolsPane({ hidden }) {
  if (hidden) return null
  return (
    <div style={{ padding: '12px', border: '1px solid #555', borderRadius: '8px' }}>
      mods sidebar pane ok
    </div>
  )
}
EOF

cat > "${MODS_DIR}/load-order.json" <<'EOF'
[
  "core.shared.shared_echo",
  "core.server.server_echo",
  "core.client.client_b",
  "core.client.client_a",
  "client.components.status",
  "client.sidebar.tools"
]
EOF

echo "Created baseline mods set at: ${MODS_DIR}"
echo "Next:"
echo "  node bin/gamedev.mjs mods deploy --dry-run --target dev"
echo "  node bin/gamedev.mjs mods deploy --target dev --note \"manual mods test\""
