# @karakuri-world/front

> 日本語版は [README.ja.md](./README.ja.md) を参照。

Spectator UI. Two-layer architecture: Vite/React SPA (Cloudflare Pages) + Cloudflare Worker (Durable Object that publishes snapshot and history objects), shipped as the `apps/front/` workspace of the Karakuri World monorepo.

Run the commands below from inside `apps/front/`, or invoke them from the repo root with `npm run dev:front` / `npm run build:front` / `npm test -w @karakuri-world/front`.

## Local development

Create `.env.local`, then start the dev server:

```bash
VITE_SNAPSHOT_URL=https://snapshot.example.com/snapshot/latest.json
VITE_AUTH_MODE=public
```

```bash
cd apps/front
npm install
npm run dev
```

`npm run dev` / `npm run build` stop immediately if any required variable is missing (fail-fast).

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_SNAPSHOT_URL` | ✓ | Snapshot alias URL on the R2 custom domain (default key: `snapshot/latest.json`). Fetched directly by the browser. `http` / `https` only; no credentials, query, or fragment |
| `VITE_AUTH_MODE` | ✓ | `public` or `access` |
| `VITE_PHASE3_EFFECTS_ENABLED` | - | Master switch for Phase 3 visual effects (default `false`) |
| `VITE_PHASE3_EFFECT_RAIN_ENABLED` / `_SNOW_` / `_FOG_` / `_DAY_NIGHT_` | - | Per-effect rollout flags for weather / day-night (default `false`; effective only when `VITE_PHASE3_EFFECTS_ENABLED=true`) |
| `VITE_PHASE3_EFFECT_MOTION_ENABLED` / `_ACTION_PARTICLES_` | - | Rollout flags for movement interpolation and `current_activity.emoji` particles (default `false`; same condition) |

History objects (`history/agents/{agent_id}.json` / `history/conversations/{conversation_id}.json`) are derived from the same origin as `VITE_SNAPSHOT_URL`. The Worker exposes no read-side endpoints, so `VITE_API_BASE_URL` is not needed.

## Deployment

### 1. Create Cloudflare resources

```bash
# R2 buckets holding both snapshot and history objects
npx wrangler r2 bucket create <real-snapshot-bucket>
npx wrangler r2 bucket create <real-snapshot-bucket-preview>
```

### 2. Prepare wrangler.toml

`wrangler.toml` is git-ignored and must be generated locally from the tracked template:

```bash
cd apps/front
cp wrangler.toml.example wrangler.toml
```

Replace the placeholder R2 bucket names (`replace-with-real-snapshot-bucket` / `...-preview`) in `wrangler.toml` with the real buckets you just created.

### 3. Set secrets (first time only)

```bash
npx wrangler secret put SNAPSHOT_PUBLISH_AUTH_KEY
```

`SNAPSHOT_PUBLISH_AUTH_KEY` is the shared Bearer token the backend (`@karakuri-world/server`) uses when calling `/api/publish-snapshot` and `/api/publish-agent-history`. It must match the same-named variable in the backend `.env` exactly. Empty or whitespace-only values fail the Worker env parse at boot; leaving it unset keeps those publish endpoints in the default-deny `503` state.

The interactive debug flow (`npm run debug:start`) prompts for the same secret.

### 4. Configure R2 bucket CORS

When the Pages domain and the R2 custom domain are cross-origin, allow the Pages origin for both the `snapshot/*` and `history/*` prefixes:

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
npx wrangler r2 bucket cors set <real-snapshot-bucket> --file /tmp/cors.json
```

Replace `origins` with your actual Pages domain. For `AUTH_MODE=access`, also allow `Access-Control-Allow-Credentials: true`. Verify with `npx wrangler r2 bucket cors list <real-snapshot-bucket>`.

### 5. Deploy the Worker

```bash
npm run deploy:prod
```

`deploy:prod` wraps the following steps:

1. Fail closed if `wrangler.toml` still contains placeholder R2 bucket names
2. Run `npx wrangler deploy`
3. `curl` the Worker URL once so `UIBridgeDurableObject.boot()` runs immediately and starts the quiet-period alarm path

> **Note**: If step 3 does not succeed, the quiet-period fallback resync will not start.

### 6. Deploy the frontend (Cloudflare Pages)

Set the `VITE_*` variables in `.env.local`, then build and deploy:

```bash
npm run build
npx wrangler pages deploy dist --project-name karakuri-world-ui-frontend \
  --commit-dirty=true --commit-message="deploy"
```

## Auth modes

Pick exactly one mode per deployment: `AUTH_MODE=public` or `AUTH_MODE=access`. A deployment is valid only when Pages and the R2 custom domain (serving both `snapshot/latest.json` and `history/*`) are configured for the same mode.

### `AUTH_MODE=public` (recommended — simple)

Pages and the R2 custom domain are all publicly accessible.

### `AUTH_MODE=access`

Pages and the R2 custom domain must sit behind one Access app (or an equivalent multi-domain policy) so a single login pre-seeds cookies for both. The browser fetches snapshot and history objects with `credentials: 'include'`.

If Access cookie sharing / pre-seeding cannot be guaranteed, do **not** add a Worker/Pages snapshot proxy fallback. Switch to `AUTH_MODE=public` instead.

## Post-deploy verification

1. Open `VITE_SNAPSHOT_URL` directly in a browser and confirm JSON is returned (for `AUTH_MODE=access`, expect HTTP 200 only after the Access session is established).
2. Repeat the snapshot request and confirm edge caching (`CF-Cache-Status: HIT` or equivalent) with the `Cache Everything` + `Edge TTL = 5 seconds` rule in effect.
3. Request `history/agents/<known-agent>.json` from the same R2 origin and confirm it loads.
4. When Pages and R2 are cross-origin, confirm both `snapshot/*` and `history/*` preflight / GET responses carry the expected CORS headers. For `AUTH_MODE=access`, also confirm `Access-Control-Allow-Credentials: true` and a successful credentialed fetch.
5. Open the UI and confirm snapshots refresh periodically — the stale banner must not appear while publish-health metadata is healthy, and it must clear after a later successful publish or the 3-minute fallback resync.

If any of the above fails in `AUTH_MODE=access`, fix Access cookie sharing / pre-seeding or choose `AUTH_MODE=public`. Do not ship a proxy fallback.

## R2 cache configuration

Add Cache Rules in the Cloudflare dashboard for both `snapshot/latest.json` and `history/*`:

- **Rule**: `Cache Everything`
- **Edge TTL**: `5 seconds`

Set `Cache-Control: public, max-age=5` on the R2 objects so origin and edge TTLs line up.

## Testing

```bash
npm test                       # full suite
npm run test:phase1-acceptance # Phase 1 acceptance gate only
npm run relay:readiness        # relay alert configuration validation
```

`npm run test:phase1-acceptance` is the focused go/no-go gate for the spectator UI. It covers:

- desktop + mobile initial shell layout on one shared map host
- 100-agent snapshot reflection within the Phase 1 15-second budget
- selected agent detail remains coherent when history objects are empty or degraded
- populated `history/agents/{agent_id}.json` fetches make conversation log expansion additive
- stale signaling driven by publish-health metadata (`last_publish_error_at`), cleared by later successful publishes or the 3-minute fallback resync
- event-driven snapshot/history publication as the primary freshness path, with only the 3-minute fallback resync remaining during quiet periods (no sub-minute heartbeat)

## Relay readiness gate

Unit 32 removed relay `/ws` as a primary path, and the backend has now removed the legacy `/ws` endpoint entirely. The Worker fail-closes `/ws` with `404`. Readiness is polling + R2/CDN freshness, direct alias-object fetches for both snapshot and history, event-driven publication, and auth-mode correctness, with only the 3-minute quiet-period fallback resync remaining. The relay alert artifacts cover `ui.*` and `relay.r2.*` signals only — no relay WebSocket signals remain.

Relay gate expectations:

- readiness alerts use the primary metric set: `ui.snapshot.refresh_failure_total{reason}`, `ui.snapshot.generated_age_ms`, `ui.snapshot.published_age_ms`, `ui.r2.publish_failure_total`, `ui.r2.publish_failure_streak`
- `ui.snapshot.refresh_failure_total{reason}` uses the reasons emitted by the Worker: `boot`, `fallback-refresh`, `world-event`, `manual`, `external-request`
- R2 retry-brake saturation (`ui.r2.publish_failure_streak >= 5`, matching the 60-second cap) is an explicit gate item
- the immediate auth/config pager route and the sustained outage pager route must resolve to different production destinations
- the production manifest must include real notification destinations, provider rule references, staging drill receipts for every required alert path, and pre-production sign-off
- production validation also fails if `wrangler.toml` omits the required `SNAPSHOT_BUCKET` binding or still has placeholder R2 bucket names

`npm run relay:readiness` by itself validates only the checked-in catalog/drill artifacts. Production relay validation remains fail-closed until the production manifest is filled in.

## Operations files

| File | Purpose |
|------|---------|
| `worker/ops/relay-alerting-spec.json` | Alert rule definitions, routes, and clear conditions |
| `worker/ops/relay-synthetic-drills.json` | Staging drill catalog plus synthetic metric timelines |
| `worker/ops/relay-production-readiness.template.json` | Production sign-off template (fail-closed) |
| `worker/ops/relay-production-readiness.example.json` | Passing example manifest for review/tests |
