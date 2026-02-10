#!/usr/bin/env bash
set -euo pipefail

WORLD_URL="${WORLD_URL:-}"
ADMIN_CODE="${ADMIN_CODE:-}"

usage() {
  cat <<'EOF'
Trigger an invalid_mod_manifest failure by sending a malformed admin manifest payload.

Requirements:
  WORLD_URL and ADMIN_CODE must be set in the environment.

Usage:
  WORLD_URL=http://localhost:3000 ADMIN_CODE=secret \
    scripts/create-mods-failure-invalid-manifest-api.sh
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ -z "${WORLD_URL}" ]]; then
  echo "Missing WORLD_URL" >&2
  exit 1
fi
if [[ -z "${ADMIN_CODE}" ]]; then
  echo "Missing ADMIN_CODE" >&2
  exit 1
fi

BASE_URL="${WORLD_URL%/}"
LOCK_TOKEN=""

release_lock() {
  if [[ -z "${LOCK_TOKEN}" ]]; then
    return
  fi
  curl -sS \
    -X DELETE \
    -H "content-type: application/json" \
    -H "x-admin-code: ${ADMIN_CODE}" \
    -d "{\"token\":\"${LOCK_TOKEN}\",\"scope\":\"mods\"}" \
    "${BASE_URL}/admin/deploy-lock" >/dev/null || true
}
trap release_lock EXIT

lock_response="$(
  curl -sS \
    -X POST \
    -H "content-type: application/json" \
    -H "x-admin-code: ${ADMIN_CODE}" \
    -d '{"owner":"mods-failure-script","scope":"mods"}' \
    "${BASE_URL}/admin/deploy-lock"
)"

LOCK_TOKEN="$(printf '%s' "${lock_response}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);if(j && j.token) process.stdout.write(j.token)}catch{}})")"

if [[ -z "${LOCK_TOKEN}" ]]; then
  echo "Failed to acquire deploy lock. Response:" >&2
  echo "${lock_response}" >&2
  exit 1
fi

bad_response="$(
  curl -sS \
    -X PUT \
    -H "content-type: application/json" \
    -H "x-admin-code: ${ADMIN_CODE}" \
    -d "{\"lockToken\":\"${LOCK_TOKEN}\",\"manifest\":{\"version\":1,\"modules\":[{\"id\":\"broken\",\"kind\":\"system\",\"scope\":\"server\"}]}}" \
    "${BASE_URL}/admin/mods/manifest"
)"

echo "Server response:"
echo "${bad_response}"
echo "Expected: error=invalid_mod_manifest"
