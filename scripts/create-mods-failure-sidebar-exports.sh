#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

ROOT_DIR="${DEFAULT_ROOT}"

usage() {
  cat <<'EOF'
Write an invalid sidebar mod (missing *Button/*Pane named exports).

Usage:
  scripts/create-mods-failure-sidebar-exports.sh [--root <path>]

Options:
  --root <path>  Project root (defaults to repo root)
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
SIDEBAR_PATH="${MODS_DIR}/client/sidebar/tools.js"

if [[ ! -d "${MODS_DIR}" ]]; then
  echo "Missing ${MODS_DIR}. Run scripts/create-mods-manual.sh first." >&2
  exit 1
fi

mkdir -p "$(dirname "${SIDEBAR_PATH}")"

cat > "${SIDEBAR_PATH}" <<'EOF'
export function NotAButton() {
  return 'broken'
}

export function NotAPane() {
  return null
}
EOF

echo "Wrote invalid sidebar module to: ${SIDEBAR_PATH}"
echo "Expected: mods deploy fails with invalid_sidebar_exports."
