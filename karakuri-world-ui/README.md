# karakuri-world-ui

> 日本語版は [README.ja.md](./README.ja.md) を参照。

## Spectator UI dev/build environment

The Vite app is fail-fast by design: both `npm run dev` and `npm run build` stop immediately unless all required browser-side variables are present.

Create `karakuri-world-ui/.env.local` (or another Vite env file) with:

```bash
VITE_SNAPSHOT_URL=https://snapshots.example.com/snapshot/manifest.json
VITE_AUTH_MODE=public
VITE_API_BASE_URL=https://history.example.com/api/history
VITE_PHASE3_EFFECTS_ENABLED=false
VITE_PHASE3_EFFECT_RAIN_ENABLED=false
VITE_PHASE3_EFFECT_SNOW_ENABLED=false
VITE_PHASE3_EFFECT_FOG_ENABLED=false
VITE_PHASE3_EFFECT_DAY_NIGHT_ENABLED=false
VITE_PHASE3_EFFECT_MOTION_ENABLED=false
VITE_PHASE3_EFFECT_ACTION_PARTICLES_ENABLED=false
```

Required values:

- `VITE_SNAPSHOT_URL`: absolute browser-fetchable snapshot manifest URL. The browser polls the public R2/CDN `snapshot/manifest.json`, resolves the versioned snapshot key from that manifest, and then fetches the immutable `snapshot/v/{generated_at}.json` object. Because this value ships in the browser bundle, it must stay public-facing: use only `http` / `https`, and do not embed credentials, query params, or fragments. Do not point this at `/api/snapshot`.
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

`npm run test:phase1-acceptance` is the focused acceptance gate for the spectator UI Phase 1 behavior. The updated delivery-track pivot after Unit 28 is documented in Units 29+; this command remains the practical UI go/no-go check.

The automated gate covers:

- desktop + mobile initial shell layout on one shared map host
- 100-agent snapshot reflection within the Phase 1 15-second budget
- selected agent detail remains coherent even when `/api/history` is empty or degraded
- populated `/api/history?agent_id=...&limit=20` checks and conversation log expansion are additive comparisons when ingest/backfill is available
- stale signaling driven by publish-health metadata (`last_publish_error_at`) rather than quiet periods alone, while later successful publishes or the 3-minute fallback resync clear the banner
- **Units 29/32 alignment**: event-driven snapshot/history publication is the primary freshness path, and the quiet-period path is only the **3-minute fallback resync**, not a sub-minute heartbeat

Run the full suite with `npm test`; use `npm run test:phase1-acceptance` when you want the Phase 1 go/no-go gate only.

## Phase 2 auth-mode deployment guide

Choose exactly one auth mode per deployment: `AUTH_MODE=public` or `AUTH_MODE=access`. A deployment is valid only when Pages, Worker `/api/history`, and the R2 `snapshot_url` are all configured for that same mode.

- `AUTH_MODE=public`: Pages, Worker `/api/history`, and the R2 custom domain are all publicly reachable.
- `AUTH_MODE=access`: Pages, Worker `/api/history`, and the R2 custom domain are all protected by Cloudflare Access, and the browser fetches both `snapshot_url` and `/api/history` with `credentials: 'include'`.
- If Pages and Worker `/api/history` are cross-origin, set Worker `HISTORY_CORS_ALLOWED_ORIGINS` to a comma-separated list of exact Pages origins (for example `https://ui.example.com,https://preview-ui.example.com`). The Worker echoes only configured origins; in `AUTH_MODE=access` it also returns `Access-Control-Allow-Credentials: true`, so `*` is not a valid substitute.

Do not mix modes within one deployment, and do not add a Worker/Pages snapshot proxy fallback when `AUTH_MODE=access` preconditions are not met. If Access cookie sharing or pre-seeding cannot be guaranteed, switch the deployment to `AUTH_MODE=public` instead of proxying snapshot traffic through `/api`.

### Required R2 custom-domain setup

`snapshot_url` is the public manifest URL on the R2 custom domain (default: `https://snapshot.example.com/snapshot/manifest.json`). The browser fetches that manifest in both auth modes, then follows its `latest_snapshot_key` to the immutable versioned snapshot object. `snapshot/latest.json` remains a compatibility alias only.

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

3. **Event-driven primary path + quiet-period fallback**
    - Trigger representative world events and confirm the worker ingests them into history and publishes an updated snapshot promptly; event-driven publication is the primary readiness path.
    - Then, with the deployed worker and UI left idle, confirm healthy quiet periods do **not** trigger the stale banner on age alone; instead, verify the banner appears only when publish-health metadata reports a failure and clears after a later successful publish or fallback resync.

## Cloudflare Worker deployment

`wrangler.toml` is git-ignored and must be generated locally from the tracked template `wrangler.toml.example`:

```bash
cd karakuri-world-ui
cp wrangler.toml.example wrangler.toml
```

`wrangler.toml.example` carries placeholder R2 bucket names for the shared snapshot/history bucket:

- `bucket_name = "replace-with-real-snapshot-bucket"`
- `preview_bucket_name = "replace-with-real-snapshot-bucket-preview"`

Before any real deploy, create or identify the bucket that will hold both snapshot objects and history objects, then replace those values in your local `wrangler.toml`.

Example:

```bash
cd karakuri-world-ui
npx wrangler r2 bucket create <real-snapshot-bucket>
npx wrangler r2 bucket create <real-snapshot-bucket-preview>
```

Then set required secrets (once) and deploy:

```bash
npx wrangler secret put KW_ADMIN_KEY
npx wrangler secret put SNAPSHOT_PUBLISH_AUTH_KEY
npm run deploy:prod
```

For the interactive debug flow (`npm run debug:start`), the script now prompts for both Worker secrets as well. Enter the same `SNAPSHOT_PUBLISH_AUTH_KEY` value that your backend uses. It must be non-empty: leaving it unset keeps the Worker's `/api/publish-snapshot` and `/api/publish-agent-history` endpoints in the default-deny `503` state, and configuring it as an empty/blank secret now fails Worker env parsing during boot.

`deploy:prod` wraps the following steps:

1. Fail closed if `wrangler.toml` still contains placeholder R2 bucket names.
2. Run `npx wrangler deploy`.
3. `curl` the Worker URL once so `UIBridgeDurableObject.boot()` runs immediately and starts the quiet-period alarm path.

At minimum, deployment also requires `KW_BASE_URL`, the secret `KW_ADMIN_KEY`, and the shared publish secret `SNAPSHOT_PUBLISH_AUTH_KEY` used by the backend when calling `/api/publish-snapshot` and `/api/publish-agent-history`. When Pages and Worker `/api/history` are cross-origin, also set `HISTORY_CORS_ALLOWED_ORIGINS` to the exact Pages origin list.

The shared R2 bucket now stores both the published snapshot objects and the history objects read by `GET /api/history` (for example `history/agents/{agent_id}.json` and `history/conversations/{conversation_id}.json`).

## Relay alert wiring and readiness gate

Unit 32 removed relay `/ws` as a primary path, and the backend has now removed the legacy `/ws` endpoint entirely. The Worker now fail-closes `/ws` with `404` instead of falling through any Durable Object fallback. The readiness story is polling + R2/CDN freshness, manifest-driven versioned snapshot fetches, event-driven snapshot/history publication, and auth-mode correctness, with only the 3-minute quiet-period fallback resync remaining. The relay alert artifacts (`relay-alerting-spec.json` etc.) cover `ui.*` and `relay.r2.*` signals only — no relay WebSocket signals remain.

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

`npm run relay:readiness` by itself validates the checked-in catalog/drill artifacts. Primary event-driven + quiet-period fallback/R2 readiness still requires the separate operator checks documented above and in Units 29+; production relay validation remains fail-closed until the production manifest is filled in.

Relay gate expectations:

- readiness alerts use the primary metric set from Units 10/29+: `ui.snapshot.refresh_failure_total{reason}`, `ui.snapshot.generated_age_ms`, `ui.snapshot.published_age_ms`, `ui.r2.publish_failure_total`, and `ui.r2.publish_failure_streak`.
- `ui.snapshot.refresh_failure_total{reason}` now uses the Phase 8 refresh reasons emitted by the Worker: `boot`, `fallback-refresh`, `world-event`, `manual`, and `external-request`.
- the sustained outage pager route must resolve to a real production destination.
- R2 retry-brake saturation (`ui.r2.publish_failure_streak >= 5`, matching the 60-second cap) is an explicit gate item.
- the immediate auth/config pager route and the sustained outage pager route must resolve to different production destinations.
- the production manifest must include real notification destinations, provider rule references, staging drill receipts with both observed alert IDs and observed route IDs for every required alert path, and pre-production sign-off.
- production validation also fails if `wrangler.toml` omits the required `SNAPSHOT_BUCKET` binding or still has placeholder R2 bucket names.
