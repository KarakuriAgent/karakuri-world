# karakuri-world-ui

## Spectator UI dev/build environment

The Vite app is fail-fast by design: both `npm run dev` and `npm run build` stop immediately unless all required browser-side variables are present.

Create `karakuri-world-ui/.env.local` (or another Vite env file) with:

```bash
VITE_SNAPSHOT_URL=https://snapshots.example.com/snapshot/latest.json
VITE_AUTH_MODE=public
VITE_API_BASE_URL=https://relay.example.com/api/history
VITE_PHASE3_EFFECTS_ENABLED=false
VITE_PHASE3_EFFECT_RAIN_ENABLED=false
VITE_PHASE3_EFFECT_SNOW_ENABLED=false
VITE_PHASE3_EFFECT_FOG_ENABLED=false
VITE_PHASE3_EFFECT_DAY_NIGHT_ENABLED=false
VITE_PHASE3_EFFECT_MOTION_ENABLED=false
VITE_PHASE3_EFFECT_ACTION_PARTICLES_ENABLED=false
```

Required values:

- `VITE_SNAPSHOT_URL`: absolute browser-fetchable snapshot object URL. In plan12 this is the direct snapshot URL, typically the R2 custom domain plus the published object key. Because this value ships in the browser bundle, it must stay public-facing: use only `http` / `https`, and do not embed credentials, query params, or fragments. Do not point this at `/api/snapshot`; the browser always polls the R2 custom-domain object URL directly.
- `VITE_AUTH_MODE`: `public` or `access`.
- `VITE_API_BASE_URL`: absolute Worker history API endpoint. This must be the full `/api/history` URL, not just the Worker origin and not a parent path such as `/api`. Because this value is also browser-exposed, do not embed credentials, query params, or fragments.
- `VITE_PHASE3_EFFECTS_ENABLED` (optional): `true` or `false`. Defaults to `false`; keep it off until Phase 3 effects are intentionally being exercised.
- `VITE_PHASE3_EFFECT_RAIN_ENABLED`, `VITE_PHASE3_EFFECT_SNOW_ENABLED`, `VITE_PHASE3_EFFECT_FOG_ENABLED`, `VITE_PHASE3_EFFECT_DAY_NIGHT_ENABLED` (optional): per-effect rollout flags. Each defaults to `false`, and each only takes effect when `VITE_PHASE3_EFFECTS_ENABLED=true`, so rain / snow / fog / day-night can be rolled back independently without removing the Phase 3 foundation.
- `VITE_PHASE3_EFFECT_MOTION_ENABLED`, `VITE_PHASE3_EFFECT_ACTION_PARTICLES_ENABLED` (optional): rollout flags for movement interpolation and lightweight `current_activity.emoji` particles. Both default to `false`, and both only take effect when `VITE_PHASE3_EFFECTS_ENABLED=true`, so Phase 1 static node rendering remains the fallback during staged rollout or rollback.

For local verification:

```bash
cd karakuri-world-ui
npm run dev
npm run build
npm run test:phase1-acceptance
```

## Phase 1 acceptance gate

`npm run test:phase1-acceptance` is the focused acceptance gate for plan21 / rollout Phase 1. It makes the required checks explicit without changing the authoritative docs.

The automated gate covers:

- desktop + mobile initial shell layout on one shared map host
- 100-agent snapshot reflection within the Phase 1 15-second budget
- selected agent detail + `/api/history?agent_id=...&limit=20`
- conversation log expansion from the same detail flow
- quiet-period freshness (`generated_at` refresh prevents stale before the 60-second threshold)
- **Unit 27 dependency**: relay `/ws` disconnect/reconnect lifecycle, freshness continuity during downtime, and first-snapshot state rebuild after reconnect

Run the full suite with `npm test`; use `npm run test:phase1-acceptance` when you want the Phase 1 go/no-go gate only.

## Phase 2 auth-mode deployment guide

Choose exactly one auth mode per deployment: `AUTH_MODE=public` or `AUTH_MODE=access`. A deployment is valid only when Pages, Worker `/api/history`, and the R2 `snapshot_url` are all configured for that same mode.

- `AUTH_MODE=public`: Pages, Worker `/api/history`, and the R2 custom domain are all publicly reachable.
- `AUTH_MODE=access`: Pages, Worker `/api/history`, and the R2 custom domain are all protected by Cloudflare Access, and the browser fetches both `snapshot_url` and `/api/history` with `credentials: 'include'`.
- If Pages and Worker `/api/history` are cross-origin, set Worker `HISTORY_CORS_ALLOWED_ORIGINS` to a comma-separated list of exact Pages origins (for example `https://ui.example.com,https://preview-ui.example.com`). The Worker echoes only configured origins; in `AUTH_MODE=access` it also returns `Access-Control-Allow-Credentials: true`, so `*` is not a valid substitute.

Do not mix modes within one deployment, and do not add a Worker/Pages snapshot proxy fallback when `AUTH_MODE=access` preconditions are not met. If Access cookie sharing or pre-seeding cannot be guaranteed, switch the deployment to `AUTH_MODE=public` instead of proxying snapshot traffic through `/api`.

### Required R2 custom-domain setup

`snapshot_url` is always the R2 custom-domain URL plus `SNAPSHOT_OBJECT_KEY` (for the default key: `https://snapshot.example.com/snapshot/latest.json`). The browser fetches that URL directly in both auth modes.

Required operator setup on the R2 custom domain:

1. Publish the bucket through a Cloudflare custom domain.
2. Add Cache Rules for the snapshot object path with `Cache Everything`.
3. Fix the Edge TTL to `5 seconds`.
4. Keep that rule aligned with the origin `Cache-Control: public, max-age=5`.
5. If Pages and the R2 custom domain are cross-origin, configure R2 CORS so the Pages origin is allowed in both auth modes. For `AUTH_MODE=access`, also allow credentialed fetches (`Access-Control-Allow-Credentials: true`).

### `AUTH_MODE=access` hard preconditions

`AUTH_MODE=access` is valid only when the browser already has a usable Access session for both the Pages origin and the R2 custom domain before the SPA starts polling `snapshot_url`.

- Preferred: place Pages, Worker `/api/history`, and the R2 custom domain behind one Access app or an equivalent multi-domain policy so one login pre-seeds both cookies.
- Acceptable alternative: explicitly pre-seed the R2 custom-domain cookie before the SPA starts (for example via a dedicated R2 visit / silent pre-seeding flow).
- Not acceptable: relying on CORS alone, or falling back to a same-origin Worker/Pages snapshot proxy when R2 Access cookies are missing.

### Public/access smoke-test checklist

Run the following after each deployment or auth-mode change:

1. Open the deployed UI and confirm the chosen mode is the only mode in use for that deployment.
2. Request `VITE_SNAPSHOT_URL` directly in the browser:
   - `AUTH_MODE=public`: expect HTTP 200 without Access login.
   - `AUTH_MODE=access`: expect HTTP 200 only after Pages and R2 Access sessions are both established; if R2 still challenges while Pages is already logged in, the deployment is not ready.
3. Verify the snapshot response comes from the R2 custom domain object path, not `/api/snapshot`.
4. Repeat the snapshot request and confirm edge caching (`CF-Cache-Status: HIT` or equivalent) with the `Cache Everything` + `Edge TTL = 5 seconds` rule in effect.
5. Request `/api/history?agent_id=<known-agent>&limit=1` from the deployed Worker:
   - `AUTH_MODE=public`: expect success without Access login.
   - `AUTH_MODE=access`: expect an Access auth challenge/failure before login, then success after the Access session is established.
6. If Pages and Worker `/api/history` are cross-origin, confirm the Worker preflight/GET responses include `Access-Control-Allow-Origin: <Pages origin>`, and for `AUTH_MODE=access` also confirm `Access-Control-Allow-Credentials: true` and a successful credentialed browser fetch.
7. If Pages and R2 are cross-origin, confirm the R2 response includes the expected CORS behavior for the Pages origin in both auth modes, and for `AUTH_MODE=access` also confirm `Access-Control-Allow-Credentials: true` and a successful credentialed fetch.
8. If any of the above fails in `AUTH_MODE=access`, fix Access cookie sharing / pre-seeding or choose `AUTH_MODE=public`; do not ship a proxy fallback.

### Manual acceptance items that still require an operator

The following checks still need staging/preview infrastructure and cannot be fully proven in local Vitest alone:

1. **R2 custom-domain edge cache (`AUTH_MODE=public` or `AUTH_MODE=access`)**
    - Apply `Cache Everything` + `Edge TTL = 5 seconds` on the snapshot object path served from the R2 custom domain.
    - Request the same snapshot object twice and confirm the second response becomes an edge cache hit (`CF-Cache-Status: HIT` or equivalent) while the cached age stays within the 5-second TTL window.
    - After the TTL rolls over, confirm the object serves a newer body with updated `generated_at` / `published_at` without breaking the freshness budget.

2. **`AUTH_MODE=access` cookie sharing / pre-seeding**
   - Confirm Pages login also establishes an R2 custom-domain Access session, or run the documented pre-seeding flow before the SPA begins polling.
   - Verify the first direct browser fetch to `snapshot_url` succeeds with `credentials: 'include'`.
   - If the first fetch still redirects/challenges on the R2 domain, treat the deployment as invalid rather than adding a snapshot proxy.

3. **Live `/ws` disconnect recovery scenario**
   - With the deployed worker and UI open, force the relay websocket to disconnect (for example by restarting or temporarily blocking the upstream `/ws` origin).
   - Confirm the UI keeps the previous render and does not enter stale before the 60-second threshold as long as `/api/snapshot` heartbeat refresh keeps `generated_at` moving.
   - Restore `/ws`, then confirm the first post-reconnect snapshot rebuilds live state/conversation state and that reconnect observability is emitted (`relay.ws.disconnect_total`, `relay.ws.connect_duration_ms`, `relay.ws.event_gap_ms`).

## Cloudflare Worker deployment

`wrangler.toml` is checked in with non-deployable placeholder D1 IDs:

- `database_id = "00000000-0000-0000-0000-000000000000"`
- `preview_database_id = "00000000-0000-0000-0000-000000000000"`

It also includes placeholder R2 bucket names for snapshot publishing:

- `bucket_name = "replace-with-real-snapshot-bucket"`
- `preview_bucket_name = "replace-with-real-snapshot-bucket-preview"`

Before any real deploy, create or identify the relay history D1 database and replace both values with the IDs Wrangler returns.

The checked-in `wrangler.toml` also schedules the worker `scheduled()` handler once per day at `03:00 UTC` so D1 history retention keeps running. Keep that cron (or an equivalent daily schedule) enabled in production.

Example:

```bash
cd karakuri-world-ui
npx wrangler d1 create karakuri-world-ui-history
npx wrangler r2 bucket create <real-snapshot-bucket>
npx wrangler r2 bucket create <real-snapshot-bucket-preview>
```

Then update `wrangler.toml` with the emitted `database_id` / `preview_database_id` and the real R2 bucket names, and configure the required runtime values:

```bash
npx wrangler d1 migrations apply HISTORY_DB --remote
npx wrangler secret put KW_ADMIN_KEY
npx wrangler deploy
```

At minimum, deployment also requires `KW_BASE_URL` plus any non-default relay settings used by the worker. When Pages and Worker `/api/history` are cross-origin, also set `HISTORY_CORS_ALLOWED_ORIGINS` to the exact Pages origin list. `HISTORY_RETENTION_DAYS` remains optional and defaults to `180`, but if you override it the deployed worker and cron schedule should use the same retention policy.

The checked-in D1 schema lives at `schema/history.sql`, and the deployable Wrangler migration lives at `migrations/0001_plan05_history_schema.sql`.

## Relay alert wiring and readiness gate

Unit 28 keeps relay alerting as checked-in artifacts plus a validation gate so production deploys cannot be marked ready while alert wiring is incomplete.

Authoritative repo-owned artifacts:

- `worker/ops/relay-alerting-spec.json`: alert rules, routes, clear conditions, and the required auth-vs-network routing split.
- `worker/ops/relay-synthetic-drills.json`: staging drill catalog plus synthetic metric timelines that must evaluate into the expected alert paths.
- `worker/ops/relay-production-readiness.template.json`: production sign-off template that intentionally fails the gate until real routes, receipts, drill evidence, and sign-off timestamps are filled in.
- `worker/ops/relay-production-readiness.example.json`: passing example manifest shape for review/tests.

Validation commands:

```bash
cd karakuri-world-ui
npm run relay:readiness
npm run relay:readiness -- --target=production --manifest worker/ops/relay-production-readiness.example.json --wrangler worker/test/fixtures/wrangler.production.example.toml
```

`npm run relay:readiness` by itself validates only the checked-in catalog/drill artifacts. Production readiness validation is fail-closed: use `--target=production` together with `--manifest`, and keep the wrangler path explicit when reviewing a deployable config.

Production gate expectations:

- `relay.ws.disconnect_total{handshake_status=auth_rejected}` stays on the immediate pager route.
- `network` / `timeout` websocket failures only escalate on the sustained paging route once freshness/heartbeat evidence shows the outage persisted.
- the immediate auth/config pager route and the sustained outage pager route must resolve to different production destinations.
- retention cron silence (`relay.d1.retention_run_total{result=success}` absent for 2 days), large retention backlog cleanup (`relay.d1.retention_deleted_rows` crossing the review threshold), and R2 retry-brake saturation (`relay.r2.publish_failure_streak >= 5`, matching the 60-second cap) are explicit gate items.
- the production manifest must include real notification destinations, provider rule references, staging drill receipts with both observed alert IDs and observed route IDs for every required alert path, and pre-production sign-off.
- production validation also fails if `wrangler.toml` omits the required `HISTORY_DB` / `SNAPSHOT_BUCKET` bindings, still has placeholder D1/R2 bindings, or if the daily `03:00 UTC` retention cron is missing.
