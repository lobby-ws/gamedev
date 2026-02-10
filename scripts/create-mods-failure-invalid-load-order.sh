#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

ROOT_DIR="${DEFAULT_ROOT}"
MODE="unknown-id"

usage() {
  cat <<'EOF'
Write an invalid mods/load-order.json to trigger order validation failures.

Usage:
  scripts/create-mods-failure-invalid-load-order.sh [--root <path>] [--mode <mode>]

Modes:
  unknown-id   References an id that does not exist in modules (default)
  cycle        Creates a cyclic dependency in order relations
  duplicate    Repeats a module id in array order

Options:
  --root <path>  Project root (defaults to repo root)
  --mode <mode>  One of: unknown-id | cycle | duplicate
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
    --mode)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --mode" >&2
        exit 1
      fi
      MODE="$2"
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
LOAD_ORDER_PATH="${MODS_DIR}/load-order.json"

if [[ ! -d "${MODS_DIR}" ]]; then
  echo "Missing ${MODS_DIR}. Run scripts/create-mods-manual.sh first." >&2
  exit 1
fi

case "${MODE}" in
  unknown-id)
    cat > "${LOAD_ORDER_PATH}" <<'EOF'
[
  "core.shared.shared_echo",
  "core.server.server_echo",
  "core.client.client_b",
  "missing.module.id",
  "client.components.status",
  "client.sidebar.tools"
]
EOF
    ;;
  cycle)
    cat > "${LOAD_ORDER_PATH}" <<'EOF'
{
  "after": {
    "core.client.client_a": ["core.client.client_b"],
    "core.client.client_b": ["core.client.client_a"]
  }
}
EOF
    ;;
  duplicate)
    cat > "${LOAD_ORDER_PATH}" <<'EOF'
[
  "core.client.client_a",
  "core.client.client_a",
  "core.client.client_b"
]
EOF
    ;;
  *)
    echo "Unknown mode: ${MODE}" >&2
    usage >&2
    exit 1
    ;;
esac

echo "Wrote invalid load order (${MODE}) to: ${LOAD_ORDER_PATH}"
echo "Expected: mods deploy fails with invalid_mod_load_order detail."
