# 13 - UI 配信バックエンド（event-driven publish + R2 primary）

## 1. 要約

Issue #60 / #64 以降の正本経路は **Node.js backend → Worker publish API → `UIBridgeDurableObject` → R2 → React SPA polling** である。relay `/ws` と Worker read endpoint（旧 `/api/history`）は廃止済みで、snapshot / history とも R2 の静的 JSON を正本に寄せる。

- backend は world event / weather update / 起動時初回 publish を起点に publish を要求する
- Worker は `POST /api/publish-snapshot` / `POST /api/publish-agent-history` を default-deny 認証で受ける
- snapshot は **POST body として push** される。DO は受け取った body をそのまま `applySnapshot` に流す
- Durable Object が authoritative writer として snapshot / history の R2 更新を直列化する
- SPA は R2 の `snapshot/latest.json`（alias）と `history/agents/*` / `history/conversations/*` を 5 秒周期で直接 polling する。Worker を経由する read 経路は無い
- コールドスタート時は永続化済みの直前 snapshot を restore し、startup 直後の 1 回 publish で UI に最新状態を届ける（pull / fallback resync は持たない）

## 2. 構成要素

| 要素 | 役割 |
| --- | --- |
| `SnapshotPublisher` (backend) | event-driven に `WorldSnapshot` を組み立て、Worker `/api/publish-snapshot` に body として push する。デバウンス、指数バックオフ、retry exhaustion を持つ。起動時に 1 回 `requestPublish()` が呼ばれ初回 snapshot を必ず流す |
| `AgentHistoryManager` (backend) | agent 単位の直近履歴を Worker `/api/publish-agent-history` へ append する。失敗時はメモリ buffer に残したまま指数バックオフで自動リトライ（`retryMaxAttempts` 到達で `gaveUp`、次の `recordEvent` で復帰） |
| Worker `fetch()` | publish endpoint（`/api/publish-snapshot` / `/api/publish-agent-history`）の認証境界。read 系 endpoint は持たない |
| `UIBridgeDurableObject` | push された snapshot body を直接 `applySnapshot` に流し、R2 publish retry、per-agent history serialize を管理する |
| R2 `SNAPSHOT_BUCKET` | `snapshot/latest.json`（alias）と `history/agents/*` / `history/conversations/*` の保存先。いずれも `Cache-Control: public, max-age=5` |
| React SPA | R2 alias を 5 秒周期で polling し、`last_publish_error_at` を含む freshness signal から stale を判定する。snapshot poll 成功時に選択中 agent と展開中 conversation の history も自動再取得 |

## 3. Worker / Durable Object

### 3.1 publish endpoint

- `POST /api/publish-snapshot`
  - `Authorization: Bearer ${SNAPSHOT_PUBLISH_AUTH_KEY}` 必須
  - 未設定なら 503、不一致なら 401
  - body は `WorldSnapshot` JSON（`recent_server_announcements` を含む）
  - body parse 失敗 / schema 不一致は 400
  - DO 内部失敗は 5xx で backend に返し、backend 側 retry を有効にする
- `POST /api/publish-agent-history`
  - 同じ shared secret で保護する
  - body は `{ agent_id, events }`
  - DO が agent / conversation history object を read-modify-write で更新する

### 3.2 `BridgeState`

Durable Object は少なくとも次を保持する。

```ts
interface BridgeState {
  latest_snapshot?: SpectatorSnapshot;
  last_publish_at?: number;
  publish_alarm_at?: number;
  publish_attempt?: number;
  last_publish_error_at?: number;
  last_publish_error_code?: string;
  publish_failure_streak: number;
}
```

- `publish_alarm_at`: R2 publish retry backoff 用
- `last_publish_error_at`: SPA stale banner へ伝播する publish failure marker

pull / refresh 用のフィールドは持たない。`recent_server_announcements` は常に push された body 側から `SpectatorSnapshot.recent_server_announcements` に反映されるため DO 側でキャッシュする必要がない。

### 3.3 alarm の責務

`alarm()` は R2 publish retry (`publish_alarm_at`) のみを扱う。通常の freshness は backend からの event-driven publish request が担う。fallback resync は存在しない。

## 4. snapshot publish

### 4.1 body push → transform → publish

1. backend が可視 state 変化イベントを観測し、`WorldSnapshot`（`recent_server_announcements` を含む）を組み立てて Worker `/api/publish-snapshot` に body として送る。起動時にも 1 回 `requestPublish()` が発火し、静穏期の再起動でも UI が空のままにならない
2. DO は body の `WorldSnapshot` を zod で検証し、そのまま `applySnapshot` に渡す。`generated_at` が既存 snapshot より古ければ破棄する
3. `WorldSnapshot` を `SpectatorSnapshot` へ変換する
4. alias object `snapshot/latest.json` 1 本に `Cache-Control: public, max-age=5` で publish する
5. publish 失敗時は `publish_failure_streak` を進め、5s → 10s → 20s ... の backoff で retry する

backend の shutdown drain 中は mutating / publish HTTP request を 503 で拒否する。最終 publish は `WorldEngine.dispose()` がタイマー消去前の `WorldSnapshot` を固定化してから送出するため、moving / in_action の agent でも shutdown publish から `movement` / `current_activity` が欠落しない。DO も backend も pull 経路を持たず、`GET /api/snapshot` / `GET /api/history` といった read endpoint はどのレイヤーにも存在しない（push が唯一の配信経路で、UI は R2 CDN を直接 fetch する）。

### 4.2 freshness / stale

SPA は以下を使って stale を判断する。

- `generated_at`
- `published_at`
- `last_publish_error_at`

`last_publish_error_at > published_at` の snapshot は「last good publish より後に publish error が発生した」ことを示すため、年齢条件を待たずに stale 扱いにする。

### 4.3 `recent_server_announcements`

サーバーアナウンスは `maybeCleanupServerAnnouncement`（エージェント単位の整理では `cleanupServerAnnouncementsForAgent`）によって active 状態が解除されても UI サイドバーに一定期間残す必要があるため、backend は `WorldEngine.state.recentServerAnnouncements`（`RecentServerAnnouncementsStore`）に 10 件の FIFO リングバッファを保持し、すべての `WorldSnapshot` に `recent_server_announcements: RecentServerAnnouncementSnapshot[]` を含める。各要素は `{ server_announcement_id, description, occurred_at, is_active }` で、cleanup 時は `is_active=false` に切り替わる。永続 active server events については引き続き `active_server_events` 側で `server_event_id` を保持する。

## 5. history publish / read

- backend は UI 表示対象イベントだけを `AgentHistoryManager` に記録する
- Worker / DO は `history/agents/{agent_id}.json` と `history/conversations/{conversation_id}.json` を R2 に `Cache-Control: public, max-age=5` で保持する
- 観戦 UI は Worker を経由せず、R2 public URL から直接 fetch する（`${snapshotOrigin}/history/agents/{agent_id}.json` など）
- R2 側に object が無い場合は HTTP 404 がそのまま返り、UI は scope ごとに 1 回 `console.warn` を出してから空ドキュメントとして継続する
- backend の history publish 失敗は指数バックオフで自動リトライする（`retryMaxAttempts` 上限到達で `gaveUp`、次の `recordEvent` で復帰。詳細は `docs/design/detailed/14-ui-history-api.md` §4）

## 6. observability

最低限監視するシグナル:

- `ui.r2.publish_failure_total`
- `ui.r2.publish_failure_streak`
- `ui.snapshot.generated_age_ms`
- `ui.snapshot.published_age_ms`

history は current-state UI の primary path ではないため、history append failure は別シグナルで観測しつつ snapshot freshness の launch gate からは分離する。

## 7. 廃止済み事項

本ドキュメントでは以下を前提にしない。

- relay `/ws`
- D1 history store
- 5 秒固定 `/api/snapshot` refresh loop
- DO 側からの pull（`fetchWorldSnapshot` / `refreshSnapshot`）
- 3 分 fallback resync（`fallback_refresh_alarm_at`）
- `KW_BASE_URL` / `KW_ADMIN_KEY`（backend への pull 認証は不要になった）
- `snapshot/manifest.json` と `snapshot/v/{generated_at}.json`（Issue #64 で alias 一本化）
- Worker `GET /api/history`（Issue #64 で R2 直接 fetch に置き換え）
- `HISTORY_CORS_ALLOWED_ORIGINS` Worker 変数（read endpoint 廃止に伴い不要）
