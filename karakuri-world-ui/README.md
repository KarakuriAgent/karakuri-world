# karakuri-world-ui

> 日本語版は [README.ja.md](./README.ja.md) を参照。

Spectator UI. Two-layer architecture: Vite/React SPA (Cloudflare Pages) + Cloudflare Worker (history API + snapshot publishing).

## Local development

Create `.env.local`, then start the dev server:

```bash
VITE_SNAPSHOT_URL=https://snapshot.example.com/snapshot/latest.json
VITE_AUTH_MODE=public
VITE_API_BASE_URL=https://your-worker.workers.dev/api/history
```

```bash
cd karakuri-world-ui
npm install
npm run dev
```

`npm run dev` / `npm run build` stop immediately if any required variable is missing (fail-fast).

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_SNAPSHOT_URL` | ✓ | Snapshot URL on the R2 custom domain (do not point at `/api/snapshot`) |
| `VITE_AUTH_MODE` | ✓ | `public` or `access` |
| `VITE_API_BASE_URL` | ✓ | Full URL to the Worker's `/api/history` endpoint |
| `VITE_PHASE3_EFFECTS_ENABLED` | - | Master switch for visual effects (default `false`) |
| `VITE_PHASE3_EFFECT_RAIN_ENABLED` etc. | - | Per-effect rollout flags (default `false`) |

## Deployment

### 1. Create Cloudflare resources

```bash
# D1 database (history storage)
npx wrangler d1 create karakuri-world-ui-history

# R2 buckets (snapshot storage)
npx wrangler r2 bucket create karakuri-world-ui-snapshot
npx wrangler r2 bucket create karakuri-world-ui-snapshot-preview
```

### 2. Prepare wrangler.toml

```bash
cp wrangler.toml.example wrangler.toml
```

Replace the placeholders in `wrangler.toml` with real values:

- `database_id` / `preview_database_id` → IDs returned when the D1 database was created
- `bucket_name` / `preview_bucket_name` → names of the R2 buckets you created

### 3. Set secrets (first time only)

```bash
npx wrangler secret put KW_ADMIN_KEY         # Karakuri World admin key
npx wrangler secret put KW_BASE_URL          # Karakuri World server URL
```

If Pages and Worker are cross-origin, also configure CORS:

```bash
npx wrangler secret put HISTORY_CORS_ALLOWED_ORIGINS
# e.g. https://your-pages.pages.dev,https://ui.example.com
```

### 4. Configure R2 bucket CORS

When the Pages domain and the R2 custom domain are cross-origin (which is normally the case), add a CORS rule to the R2 bucket:

```bash
cat > /tmp/cors.json << 'EOF'
{
  "rules": [
    {
      "allowed": {
        "origins": ["https://your-pages-domain.example.com"],
        "methods": ["GET", "HEAD"],
        "headers": ["*"]
      },
      "maxAgeSeconds": 86400
    }
  ]
}
EOF
npx wrangler r2 bucket cors set karakuri-world-ui-snapshot --file /tmp/cors.json
```

Replace `origins` with your actual Pages domain (e.g. `https://karakuri-world.0235.app`). Verify with `npx wrangler r2 bucket cors list karakuri-world-ui-snapshot`.

### 5. Deploy the Worker

```bash
npm run deploy:prod
```

This command runs in order:

1. Checks `wrangler.toml` for remaining placeholders (stops if found)
2. Applies D1 migrations
3. Runs `wrangler deploy`
4. Sends a warm-up request to the Worker (starts snapshot publishing)

> **Note**: Snapshot publishing to R2 will not begin unless the warm-up request succeeds.

### 6. Deploy the frontend (Cloudflare Pages)

Set the `VITE_*` variables in `.env.local`, then build and deploy:

```bash
npm run build
npx wrangler pages deploy dist --project-name karakuri-world-ui-frontend \
  --commit-dirty=true --commit-message="deploy"
```

## Auth modes

### `AUTH_MODE=public` (recommended — simple)

Pages, Worker `/api/history`, and the R2 custom domain are all publicly accessible.

### `AUTH_MODE=access`

Protects browser sessions with Cloudflare Access. Pages, Worker, and R2 must all sit behind the same Access policy so a single login establishes cookies for all three.

## Post-deploy verification

1. Open `VITE_SNAPSHOT_URL` directly in a browser and confirm JSON is returned.
2. Call `/api/history?agent_id=<id>&limit=1` on the Worker and confirm a response.
3. Open the UI and confirm the snapshot refreshes periodically (within 60 seconds).

## R2 cache configuration

Add a Cache Rule for the snapshot object path in the Cloudflare dashboard:

- **Rule**: `Cache Everything`
- **Edge TTL**: `5 seconds`

Set `Cache-Control: public, max-age=5` on the R2 object.

## Testing

```bash
npm test                       # full suite
npm run test:phase1-acceptance # Phase 1 acceptance gate only
npm run relay:readiness        # alert configuration validation
```

## Operations files

| File | Purpose |
|------|---------|
| `worker/ops/relay-alerting-spec.json` | Alert rule definitions |
| `worker/ops/relay-production-readiness.template.json` | Production sign-off template |
| `schema/history.sql` | D1 schema |
| `migrations/0001_plan05_history_schema.sql` | Wrangler migration |
