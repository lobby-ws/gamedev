#!/usr/bin/env bash
set -euo pipefail

# Redeploy the engine to Fly using the latest image tag
# Usage:
#   npm run update:engine
#   bash scripts/update-engine.sh [-a <app-name>] [--ha=false]

APP_NAME=""
HA_FLAG="--ha=false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -a|--app)
      APP_NAME="$2"; shift 2 ;;
    --ha=*)
      HA_FLAG="$1"; shift 1 ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

if ! command -v flyctl >/dev/null 2>&1; then
  echo "flyctl is required. Install from https://fly.io/docs/hands-on/install-flyctl/" >&2
  exit 1
fi

if [[ -z "$APP_NAME" ]]; then
  if [[ -f fly.toml ]]; then
    # Extract app name from fly.toml (handles single or double quotes)
    APP_NAME=$(awk -F= '/^app\s*=/{gsub(/[ \047\"]/ ,"",$2); print $2}' fly.toml || true)
  fi
fi

if [[ -z "$APP_NAME" ]]; then
  read -rp "Fly app name: " APP_NAME
fi

IMAGE="ghcr.io/lobby-ws/gamedev:main"
echo "Redeploying $IMAGE to app '$APP_NAME' ($HA_FLAG)..."
flyctl deploy --app "$APP_NAME" --image "$IMAGE" $HA_FLAG
echo "Done. Visit https://$APP_NAME.fly.dev/"
echo "You may need to wait a minute or so before the website is live."
