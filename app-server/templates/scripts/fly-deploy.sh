#!/usr/bin/env bash
set -euo pipefail

# Deploys the Hyperfy world engine (ghcr.io/lobby-ws/gamedev:main) to Fly.io
# Usage:
#   npm run deploy:fly
# or
#   bash scripts/fly-deploy.sh -a <app-name> -r <region>

APP_NAME=""
REGION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -a|--app)
      APP_NAME="$2"; shift 2 ;;
    -r|--region)
      REGION="$2"; shift 2 ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

if ! command -v flyctl >/dev/null 2>&1; then
  echo "flyctl is required. Install from https://fly.io/docs/hands-on/install-flyctl/" >&2
  exit 1
fi

if [[ -z "$APP_NAME" ]]; then
  read -rp "Fly app name (e.g. my-world): " APP_NAME
fi

if [[ -z "$REGION" ]]; then
  read -rp "Primary region (default iad): " REGION
  REGION=${REGION:-iad}
fi

# Collect required secrets up front
echo "Set required secrets for the world (leave blank to re-prompt)"
while true; do
  read -rp "WORLD_ID: " WORLD_ID || true
  [[ -n "${WORLD_ID:-}" ]] && break || echo "WORLD_ID is required."
done
read -rp "ADMIN_CODE (optional): " ADMIN_CODE || true
while true; do
  read -rp "JWT_SECRET: " JWT_SECRET || true
  [[ -n "${JWT_SECRET:-}" ]] && break || echo "JWT_SECRET is required."
done

# Ensure fly.toml exists and set app name + region
if [[ ! -f fly.toml ]]; then
  echo "fly.toml not found in repo root. Please keep the provided fly.toml template." >&2
  exit 1
fi

echo "Configuring fly.toml for app '$APP_NAME' (region $REGION)..."
sed -i "s/^app = \".*\"/app = \"$APP_NAME\"/" fly.toml
sed -i "s/^primary_region = \".*\"/primary_region = \"$REGION\"/" fly.toml

# Compute domain-based URLs and set envs accordingly
DOMAIN="$APP_NAME.fly.dev"
echo "Setting env URLs to https://$DOMAIN ..."
# Use POSIX character class for whitespace to work with sed
sed -i "s|^[[:space:]]*WORLD_URL = '.*'|  WORLD_URL = 'https://$DOMAIN'|" fly.toml
sed -i "s|^[[:space:]]*PUBLIC_WS_URL = '.*'|  PUBLIC_WS_URL = 'wss://$DOMAIN/ws'|" fly.toml
sed -i "s|^[[:space:]]*PUBLIC_API_URL = '.*'|  PUBLIC_API_URL = 'https://$DOMAIN/api'|" fly.toml
sed -i "s|^[[:space:]]*ASSETS_BASE_URL = '.*'|  ASSETS_BASE_URL = 'https://$DOMAIN/assets'|" fly.toml

# Optional: memory sizing
read -rp "Memory (MB) for the VM (default 1024): " MEM_MB
MEM_MB=${MEM_MB:-1024}
# Sanitize any existing [[vm]] or [vm] blocks to a single [vm] with chosen memory
TMP_FILE=$(mktemp)
awk '
  BEGIN { skip=0 }
  /^\[\[vm\]\]$/ { skip=1; next }
  /^\[vm\]$/ { skip=1; next }
  /^\[.*\]/ {
    if (skip==1) { skip=0; print $0; next }
  }
  { if (skip==0) print $0 }
' fly.toml > "$TMP_FILE" && mv "$TMP_FILE" fly.toml
cat >> fly.toml <<EOT

[vm]
  cpu_kind = "shared"
  cpus = 1
  memory_mb = $MEM_MB
EOT

echo "Initializing app via 'fly launch' (no deploy)..."
set +e
LAUNCH_OUT=$(flyctl launch --name "$APP_NAME" --region "$REGION" --copy-config --no-deploy --yes 2>&1)
LAUNCH_RC=$?
set -e
if [[ $LAUNCH_RC -ne 0 ]]; then
  echo "$LAUNCH_OUT"
  echo "'fly launch' failed; attempting 'fly apps create' fallback..."
  set +e
  CREATE_OUT=$(flyctl apps create "$APP_NAME" 2>&1)
  CREATE_RC=$?
  set -e
  if [[ $CREATE_RC -ne 0 ]]; then
    if echo "$CREATE_OUT" | grep -qi "Name has already been taken"; then
      echo "The name '$APP_NAME' is already taken globally on Fly."
      read -rp "Choose a different app name: " APP_NAME
      sed -i "s/^app = \".*\"/app = \"$APP_NAME\"/" fly.toml
      echo "Retrying 'fly launch' with new name..."
      flyctl launch --name "$APP_NAME" --region "$REGION" --copy-config --no-deploy --yes
    else
      echo "$CREATE_OUT" >&2
      echo "Failed to create app; aborting." >&2
      exit 1
    fi
  fi
fi

SECRETS_TO_SET=()
[[ -n "${WORLD_ID:-}" ]] && SECRETS_TO_SET+=("WORLD_ID=$WORLD_ID")
[[ -n "${JWT_SECRET:-}" ]] && SECRETS_TO_SET+=("JWT_SECRET=$JWT_SECRET")
[[ -n "${ADMIN_CODE:-}" ]] && SECRETS_TO_SET+=("ADMIN_CODE=$ADMIN_CODE")

if (( ${#SECRETS_TO_SET[@]} > 0 )); then
  echo "Setting Fly secrets..."
  flyctl secrets set "${SECRETS_TO_SET[@]}" -a "$APP_NAME"
  echo "Current secrets (will apply on first deploy if no machines yet):"
  flyctl secrets list -a "$APP_NAME"
else
  echo "No secrets set. You can set them later with: flyctl secrets set KEY=VALUE -a $APP_NAME"
fi

# Determine gamedev version from package.json to tag the engine image
GAMEDEV_VERSION=$(node - <<'NODE'
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const ver = (pkg.devDependencies && pkg.devDependencies.gamedev)
  || (pkg.dependencies && pkg.dependencies.gamedev)
  || '';
const clean = String(ver).trim().replace(/^[~^]/, '');
process.stdout.write(`v${clean}`);
NODE
)
if [[ -z "$GAMEDEV_VERSION" ]]; then
  echo "Could not determine gamedev version from package.json (dependencies/devDependencies)." >&2
  exit 1
fi

ENGINE_IMAGE="ghcr.io/lobby-ws/gamedev:$GAMEDEV_VERSION"
echo "Deploying engine image $ENGINE_IMAGE to Fly..."
flyctl deploy --app "$APP_NAME" --image "$ENGINE_IMAGE" --ha=false

# Auto-add/update target in .lobby/targets.json
echo "Updating .lobby/targets.json with target '$APP_NAME'..."
export APP_NAME DOMAIN WORLD_ID ADMIN_CODE
node - <<'NODE'
const fs = require('fs');
const path = require('path');
const appName = process.env.APP_NAME;
const domain = process.env.DOMAIN;
const worldId = process.env.WORLD_ID;
const adminCode = process.env.ADMIN_CODE;
const dir = path.join('.lobby');
const file = path.join(dir, 'targets.json');
let data = {};
try {
  data = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
} catch (_) {}
data[appName] = {
  worldUrl: `https://${domain}`,
  worldId: worldId,
  adminCode: adminCode,
  confirm: true
};
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(file, JSON.stringify(data, null, 2));
console.log(`Wrote ${file} with target '${appName}'.`);
NODE

echo "\nVisit your newly deployed app at https://$APP_NAME.fly.dev/"
echo "You may need to wait a minute or so before the website is live."
echo "\nNext steps:"
echo "- Deploy an app: npm run deploy:app -- <AppName> --target $APP_NAME"
