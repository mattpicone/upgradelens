#!/usr/bin/env bash
# One-shot first deployment. Prerequisite: `npx wrangler login` completed
# (free Cloudflare account, no credit card). Everything else is automatic.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Verifying Cloudflare auth"
npx wrangler whoami

echo "==> Creating D1 database (idempotent)"
if ! npx wrangler d1 list --json | grep -q '"upgradelens"'; then
  npx wrangler d1 create upgradelens
fi
DB_ID=$(npx wrangler d1 list --json | node -e "
  let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
    const db=JSON.parse(s).find(d=>d.name==='upgradelens');
    if(!db){process.exit(1)};console.log(db.uuid);
  })")
echo "    database_id: $DB_ID"

echo "==> Writing database_id into wrangler.toml"
perl -pi -e "s/^database_id = .*/database_id = \"$DB_ID\"/" wrangler.toml

echo "==> Applying schema"
npx wrangler d1 execute upgradelens --remote --file=./migrations/0001_init.sql -y
npx wrangler d1 execute upgradelens --remote --file=./migrations/0003_mcp_funnel.sql -y

echo "==> Setting worker secrets"
OWNER_TOKEN="ulo_$(openssl rand -hex 24)"
ADMIN_KEY_FILE=".admin_key_local"
if [ -f "$ADMIN_KEY_FILE" ]; then ADMIN_KEY=$(cat "$ADMIN_KEY_FILE"); else ADMIN_KEY="ulk_admin_$(openssl rand -hex 24)"; echo "$ADMIN_KEY" > "$ADMIN_KEY_FILE"; fi
echo "$OWNER_TOKEN" | npx wrangler secret put OWNER_TOKEN
echo "$ADMIN_KEY" | npx wrangler secret put ADMIN_KEY
echo "$OWNER_TOKEN" > .owner_token_local && chmod 600 .owner_token_local
echo "    OWNER_TOKEN saved to .owner_token_local (git-ignored)"

echo "==> Resolving workers.dev subdomain"
SUBDOMAIN=$(npx wrangler whoami 2>/dev/null | grep -oE '[a-z0-9-]+@' | head -1 || true)

echo "==> Deploying"
npx wrangler deploy
npx wrangler d1 execute upgradelens --remote --file=./migrations/0003_mcp_funnel.sql -y

echo "==> Determining public URL"
URL=$(npx wrangler deployments list 2>/dev/null | grep -oE 'https://[a-z0-9.-]+workers\.dev' | head -1 || true)
if [ -z "$URL" ]; then
  read -r -p "Enter the deployed URL printed above (https://upgradelens....workers.dev): " URL
fi
echo "    $URL"

echo "==> Updating PUBLIC_BASE_URL and committing"
perl -pi -e "s|^PUBLIC_BASE_URL = .*|PUBLIC_BASE_URL = \"$URL\"|" wrangler.toml
grep -rl "upgradelens.mattpicone.workers.dev" README.md server.json src/routes/meta.ts docs/ 2>/dev/null \
  | xargs -I{} perl -pi -e "s|https://upgradelens\.mattpicone\.workers\.dev|$URL|g" {} || true
npx wrangler deploy

echo "==> Verifying health"
curl -fsS -A "upgradelens-ci" "$URL/healthz"
npx wrangler d1 execute upgradelens --remote --file=./migrations/0004_activate_validation.sql -y

echo "==> Syncing GitHub automation config"
gh variable set SERVICE_URL --body "$URL" || true
gh secret set ADMIN_KEY --body "$ADMIN_KEY" || true

echo "==> Creating CI deploy token note"
echo "NOTE: for CI deploys, create a Cloudflare API token (Workers Scripts:Edit + D1:Edit)"
echo "at https://dash.cloudflare.com/profile/api-tokens and run:"
echo "  gh secret set CLOUDFLARE_API_TOKEN --body <token>"

echo "==> Publishing to the official MCP Registry"
if ! command -v mcp-publisher >/dev/null 2>&1; then
  brew install mcp-publisher 2>/dev/null || {
    curl -fsSL "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" \
      | tar xz mcp-publisher && chmod +x mcp-publisher && mkdir -p "$HOME/.local/bin" && mv mcp-publisher "$HOME/.local/bin/" && export PATH="$HOME/.local/bin:$PATH"
  }
fi
mcp-publisher login github
mcp-publisher publish server.json

echo ""
echo "ALL DONE."
echo "  Public API + MCP: $URL  ($URL/mcp)"
echo "  Dashboard:        curl --oauth2-bearer \"<OWNER_TOKEN>\" '$URL/dashboard?format=json'"
git add -A && git commit -m "Configure production deployment (D1 id, public URL)" && git push
