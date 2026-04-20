# 13 - UI 配信バックエンド（event-driven publish + R2 primary）

## 1. 要約

Issue #60 の正本経路は **Node.js backend → Worker publish API → `UIBridgeDurableObject` → R2 → React SPA polling** である。relay `/ws` は廃止済みで、snapshot / history とも R2 を正本に寄せる。

- backend は world event / weather update を起点に publish を要求する
- Worker は `POST /api/publish-snapshot` / `POST /api/publish-agent-history` を default-deny 認証で受ける
- Durable Object が authoritative writer として snapshot / history の R2 更新を直列化する
- SPA は R2 の `snapshot/manifest.json` を fetch し、manifest が指す versioned snapshot object を読む。必要時だけ Worker `/api/history` を読む
- quiet period の再取得は **3 分 fallback resync** のみで、5 秒固定 refresh は前提にしない

## 2. 構成要素

| 要素 | 役割 |
| --- | --- |
| `SnapshotPublisher` (backend) | event-driven に Worker `/api/publish-snapshot` を叩く。デバウンス、指数バックオフ、retry exhaustion を持つ |
| `AgentHistoryManager` (backend) | agent 単位の直近履歴を Worker `/api/publish-agent-history` へ append する。失敗時はメモリ buffer で再送する |
| Worker `fetch()` | publish endpoint の認証境界、および `/api/history` 公開 API |
| `UIBridgeDurableObject` | snapshot refresh、R2 publish retry、per-agent history serialize、fallback resync を管理する |
| R2 `SNAPSHOT_BUCKET` | `snapshot/manifest.json` / `snapshot/v/{generated_at}.json` / `snapshot/latest.json` と history documents の保存先 |
| React SPA | R2 manifest を polling し、versioned snapshot + `last_publish_error_at` を含む freshness signal から stale を判定する |

## 3. Worker / Durable Object

### 3.1 publish endpoint

- `POST /api/publish-snapshot`
  - `Authorization: Bearer ${SNAPSHOT_PUBLISH_AUTH_KEY}` 必須
  - 未設定なら 503、不一致なら 401
  - DO 内で `/api/snapshot` を取り直して R2 publish する
  - refresh 失敗 / DO failure は 5xx で backend に返し、backend 側 retry を有効にする
- `POST /api/publish-agent-history`
  - 同じ shared secret で保護する
  - body は `{ agent_id, events }`
  - DO が agent / conversation history object を read-modify-write で更新する

### 3.2 `BridgeState`

Durable Object は少なくとも次を保持する。

```ts
interface BridgeState {
  latest_snapshot?: SpectatorSnapshot;
  recent_server_events: SpectatorRecentServerEvent[];
  active_server_event_ids: string[];
  last_publish_at?: number;
  last_refresh_at?: number;
  fallback_refresh_alarm_at?: number;
  publish_alarm_at?: number;
  publish_attempt?: number;
  last_publish_error_at?: number;
  last_publish_error_code?: string;
  publish_failure_streak: number;
}
```

- `fallback_refresh_alarm_at`: 3 分 fallback resync 用
- `publish_alarm_at`: R2 publish retry backoff 用
- `last_publish_error_at`: SPA stale banner へ伝播する publish/refresh failure marker

### 3.3 alarm の責務

`alarm()` は 2 種類だけを扱う。

1. `fallback_refresh_alarm_at` 到達時: `/api/snapshot` を再取得して再 publish、次回 3 分後を再予約
2. `publish_alarm_at` 到達時: 失敗していた R2 publish を再試行

通常の freshness は backend からの event-driven publish request が担い、alarm は保険としてのみ残す。

## 4. snapshot publish

### 4.1 refresh → transform → publish

1. backend が可視 state 変化イベントを観測して Worker `/api/publish-snapshot` を叩く
2. DO が backend `/api/snapshot` を `X-Admin-Key` 付きで取得する
3. `WorldSnapshot` を `SpectatorSnapshot` へ変換する
4. `snapshot/v/{generated_at}.json` と `snapshot/manifest.json`（互換用に `snapshot/latest.json` も）へ publish する
5. publish 失敗時は `publish_failure_streak` を進め、5s → 10s → 20s ... の backoff で retry する

shutdown drain 中は backend が mutating HTTP request を 503 で拒否しつつ、Worker が最終 publish 用に読む `GET /api/snapshot` と `GET /health` だけは継続提供する。`WorldEngine.dispose()` はタイマー消去前の `WorldSnapshot` を固定化してから flush を完了するため、moving / in_action の agent でも shutdown publish から `movement` / `current_activity` が欠落しない。

### 4.2 freshness / stale

SPA は以下を使って stale を判断する。

- `generated_at`
- `published_at`
- `last_publish_error_at`

`last_publish_error_at > published_at` の snapshot は「last good publish より後に publish/refresh error が発生した」ことを示すため、年齢条件を待たずに stale 扱いにする。

## 5. history publish / read

- backend は UI 表示対象イベントだけを `AgentHistoryManager` に記録する
- Worker / DO は `history/agents/{agent_id}.json` と `history/conversations/{conversation_id}.json` を R2 に保持する
- `GET /api/history` は R2 document を読み、`scope` / `types` / `cursor` / `limit` を Worker で適用する
- R2 miss は `{ items: [], hydration: 'never-recorded' }`、R2 例外は 5xx `internal_error` として区別する

## 6. observability

最低限監視するシグナル:

- `ui.snapshot.refresh_failure_total{reason}`
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
