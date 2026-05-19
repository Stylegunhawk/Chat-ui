#!/usr/bin/env bash
# ============================================================
# DevForge Login Script
# Gets a Google ID token → exchanges for DevForge JWT (RAG)
# Then creates/retrieves an API key → tests gateway endpoint
#
# Usage:
#   ./scripts/devforge_login.sh [--tenant <tenant_id>] [--backend <url>]
#
# Prerequisites:
#   - jq        (brew install jq)
#   - gcloud    (optional — used for auto token; brew install google-cloud-sdk)
#   - curl
# ============================================================

set -euo pipefail

# ── Config ──────────────────────────────────────────────────
BACKEND_URL="${DEVFORGE_BACKEND_URL:-http://localhost:8001}"
TENANT_ID="${DEVFORGE_TENANT_ID:-demonslayer52866}"        # used as mongodb_id
GOOGLE_ACCOUNT="demonslayer52866@gmail.com"
TOKEN_FILE="${HOME}/.devforge_token"

# Colour helpers
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# ── Arg parsing ──────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tenant) TENANT_ID="$2"; shift 2 ;;
    --backend) BACKEND_URL="$2"; shift 2 ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

echo ""
echo "══════════════════════════════════════════════"
echo "  DevForge Auth — ${GOOGLE_ACCOUNT}"
echo "  Backend : ${BACKEND_URL}"
echo "  Tenant  : ${TENANT_ID}"
echo "══════════════════════════════════════════════"
echo ""

# ─────────────────────────────────────────────────────────────
# STEP 1: Get Google ID Token
# ─────────────────────────────────────────────────────────────
echo ">>> STEP 1: Getting Google ID Token"

GOOGLE_ID_TOKEN=""

# Method A: gcloud CLI (non-interactive, fastest)
if command -v gcloud &>/dev/null; then
  warn "Trying gcloud auth print-identity-token for ${GOOGLE_ACCOUNT}..."
  GOOGLE_ID_TOKEN=$(gcloud auth print-identity-token \
    --account="${GOOGLE_ACCOUNT}" 2>/dev/null || echo "")
  if [[ -n "$GOOGLE_ID_TOKEN" ]]; then
    info "Got Google ID token via gcloud (${#GOOGLE_ID_TOKEN} chars)"
  else
    warn "gcloud failed (account not logged in?). Run: gcloud auth login ${GOOGLE_ACCOUNT}"
  fi
fi

# Method B: Manual paste fallback
if [[ -z "$GOOGLE_ID_TOKEN" ]]; then
  echo ""
  warn "gcloud not available or not logged in. Get your Google ID token manually:"
  echo ""
  echo "  Option 1 — gcloud CLI:"
  echo "    gcloud auth login ${GOOGLE_ACCOUNT}"
  echo "    gcloud auth print-identity-token --account=${GOOGLE_ACCOUNT}"
  echo ""
  echo "  Option 2 — OAuth Playground:"
  echo "    https://developers.google.com/oauthplayground"
  echo "    Select: Google OAuth2 API v2 → userinfo.email"
  echo "    Exchange code → copy the id_token field"
  echo ""
  read -r -p "Paste your Google ID token: " GOOGLE_ID_TOKEN
  [[ -z "$GOOGLE_ID_TOKEN" ]] && error "No token provided."
fi

# ─────────────────────────────────────────────────────────────
# STEP 2: Exchange Google token → DevForge JWT
# ─────────────────────────────────────────────────────────────
echo ""
echo ">>> STEP 2: Exchanging for DevForge JWT"

AUTH_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "${BACKEND_URL}/api/auth/google" \
  -H "Content-Type: application/json" \
  -d "{\"google_token\": \"${GOOGLE_ID_TOKEN}\", \"mongodb_id\": \"${TENANT_ID}\"}")

HTTP_CODE=$(echo "$AUTH_RESPONSE" | tail -1)
AUTH_BODY=$(echo "$AUTH_RESPONSE" | head -n -1)

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "Auth response (HTTP ${HTTP_CODE}):"
  echo "$AUTH_BODY" | jq . 2>/dev/null || echo "$AUTH_BODY"
  error "Auth failed (HTTP ${HTTP_CODE}). Check Google token validity."
fi

JWT=$(echo "$AUTH_BODY" | jq -r '.access_token')
EXPIRES_IN=$(echo "$AUTH_BODY" | jq -r '.expires_in // 3600')

[[ -z "$JWT" || "$JWT" == "null" ]] && error "No access_token in response: $AUTH_BODY"

info "Got DevForge JWT (expires in ${EXPIRES_IN}s)"

# Decode and show JWT payload
JWT_PAYLOAD=$(echo "$JWT" | cut -d'.' -f2 | base64 --decode 2>/dev/null || \
              echo "$JWT" | cut -d'.' -f2 | python3 -c "import sys,base64; d=sys.stdin.read().strip(); print(base64.b64decode(d+'==').decode())" 2>/dev/null || echo "{}")
echo "  Tenant ID : $(echo "$JWT_PAYLOAD" | jq -r '.tenant_id // "?"')"
echo "  Expires   : $(echo "$JWT_PAYLOAD" | jq -r '.exp // "?"' | xargs -I{} date -d @{} 2>/dev/null || echo "?")"

# Save token for reuse
cat > "$TOKEN_FILE" <<EOF
export DEVFORGE_JWT="${JWT}"
export DEVFORGE_TENANT="${TENANT_ID}"
export DEVFORGE_BACKEND="${BACKEND_URL}"
EOF
info "JWT saved to ${TOKEN_FILE} (source it in your shell)"

# ─────────────────────────────────────────────────────────────
# STEP 3: Verify JWT — list RAG files
# ─────────────────────────────────────────────────────────────
echo ""
echo ">>> STEP 3: Verifying JWT → GET /api/v1/rag/files"

FILES_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X GET "${BACKEND_URL}/api/v1/rag/files" \
  -H "Authorization: Bearer ${JWT}")

HTTP_CODE=$(echo "$FILES_RESPONSE" | tail -1)
FILES_BODY=$(echo "$FILES_RESPONSE" | head -n -1)

if [[ "$HTTP_CODE" == "200" ]]; then
  FILE_COUNT=$(echo "$FILES_BODY" | jq 'length' 2>/dev/null || echo "?")
  info "RAG files endpoint OK — ${FILE_COUNT} file(s) for tenant '${TENANT_ID}'"
else
  warn "RAG files returned HTTP ${HTTP_CODE}"
  echo "$FILES_BODY" | jq . 2>/dev/null || echo "$FILES_BODY"
fi

# ─────────────────────────────────────────────────────────────
# STEP 4: Gateway endpoint — get API key
# ─────────────────────────────────────────────────────────────
echo ""
echo ">>> STEP 4: Gateway endpoint (requires API key, not JWT)"
echo ""
warn "The gateway uses x-api-key auth (different from JWT)."
echo "  To create an API key (requires admin credentials):"
echo ""
echo "  ADMIN_JWT=\$(curl -s -X POST ${BACKEND_URL}/api/auth/login \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"email\":\"admin@devforge.ai\",\"password\":\"adminpass123\"}' | jq -r '.access_token')"
echo ""
echo "  curl -X POST ${BACKEND_URL}/api/admin/keys \\"
echo "    -H \"Authorization: Bearer \$ADMIN_JWT\" \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"name\":\"${GOOGLE_ACCOUNT}\",\"integration_name\":\"test\",\"tier\":\"free\",\"tenant_id\":\"${TENANT_ID}\"}'"
echo ""

# If DEVFORGE_API_KEY is already set, test gateway immediately
if [[ -n "${DEVFORGE_API_KEY:-}" ]]; then
  echo ">>> Testing gateway with existing DEVFORGE_API_KEY"
  GW_RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST "${BACKEND_URL}/api/gateway" \
    -H "x-api-key: ${DEVFORGE_API_KEY}" \
    -H "Content-Type: application/json" \
    -d '{"name":"generate_data","arguments":{"rows":1,"format":"json"}}')

  HTTP_CODE=$(echo "$GW_RESPONSE" | tail -1)
  GW_BODY=$(echo "$GW_RESPONSE" | head -n -1)

  if [[ "$HTTP_CODE" == "200" ]]; then
    info "Gateway OK (HTTP 200)"
    echo "$GW_BODY" | jq . 2>/dev/null || echo "$GW_BODY"
  else
    warn "Gateway returned HTTP ${HTTP_CODE}"
    echo "$GW_BODY" | jq . 2>/dev/null || echo "$GW_BODY"
  fi
else
  warn "Set DEVFORGE_API_KEY env var to test the gateway endpoint, e.g.:"
  echo "  DEVFORGE_API_KEY=df_xxx ./scripts/devforge_login.sh"
fi

# ─────────────────────────────────────────────────────────────
# SUMMARY
# ─────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════"
echo "  Quick reference"
echo "══════════════════════════════════════════════"
echo ""
echo "  # Load JWT into current shell:"
echo "  source ${TOKEN_FILE}"
echo ""
echo "  # Test RAG search:"
echo "  curl -X POST ${BACKEND_URL}/api/v1/rag/chunk/semanticSearchForChat \\"
echo "    -H \"Authorization: Bearer \$DEVFORGE_JWT\" \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"userQuery\":\"test\",\"top_k\":5,\"messageId\":\"msg-1\"}'"
echo ""
echo "  # Test gateway (API key required):"
echo "  curl -X POST ${BACKEND_URL}/api/gateway \\"
echo "    -H \"x-api-key: \$DEVFORGE_API_KEY\" \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"name\":\"generate_data\",\"arguments\":{\"rows\":3}}'"
echo ""
