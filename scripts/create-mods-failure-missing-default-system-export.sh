#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

ROOT_DIR="${DEFAULT_ROOT}"
TARGET="server"

usage() {
  cat <<'EOF'
Write a system mod without a default export to trigger runtime loader failure.

Usage:
  scripts/create-mods-failure-missing-default-system-export.sh [--root <path>] [--target <server|client>]

Options:
  --root <path>      Project root (defaults to repo root)
  --target <value>   Which system mod to break: server (default) or client
  -h, --help         Show this help
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
    --target)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --target" >&2
        exit 1
      fi
      TARGET="$2"
      shift 2
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

if [[ ! -d "${MODS_DIR}" ]]; then
  echo "Missing ${MODS_DIR}. Run scripts/create-mods-manual.sh first." >&2
  exit 1
fi

case "${TARGET}" in
  server)
    FILE_PATH="${MODS_DIR}/core/server/server_echo.js"
    EXPECTED_ID="core.server.server_echo"
    ;;
  client)
    FILE_PATH="${MODS_DIR}/core/client/client_a.js"
    EXPECTED_ID="core.client.client_a"
    ;;
  *)
    echo "Unknown target: ${TARGET}" >&2
    usage >&2
    exit 1
    ;;
esac

mkdir -p "$(dirname "${FILE_PATH}")"

cat > "${FILE_PATH}" <<'EOF'
export class BrokenSystemMod {
  constructor(world) {
    this.world = world
  }
}
EOF

echo "Wrote non-default-export system module: ${FILE_PATH}"
echo "Expected runtime failure id: ${EXPECTED_ID}"
if [[ "${TARGET}" == "server" ]]; then
  echo "Expected after deploy + restart: server startup fails with mod_system_default_export_missing:${EXPECTED_ID}"
else
  echo "Expected after deploy + client refresh: client load fails with mod_client_system_default_export_missing:${EXPECTED_ID}"
fi
