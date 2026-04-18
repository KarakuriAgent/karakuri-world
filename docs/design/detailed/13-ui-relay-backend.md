# 13 - UI 配信バックエンド（polling + R2/CDN primary）

## 1. 構成

UI 配信レイヤーの正本経路は、**固定間隔の snapshot polling → `SpectatorSnapshot` 変換 → R2 カスタムドメイン配信 → ブラウザ polling** とする。`/ws` relay はこの経路を置き換えるものではなく、必要な場合だけ history 補助や publish 加速に使う任意機能として扱う。

| 要素 | 役割 |
|------|------|
| Snapshot publisher | `GET /api/snapshot` を一定間隔で取得し、`SpectatorSnapshot` へ変換して R2 へ publish する。**5 秒 cadence は Durable Object alarm、外部 cron、常駐 scheduler など sub-minute-capable な仕組みで駆動し、Cloudflare Worker の `scheduled()` 単独には依存しない** |
| Workers (Hono) | `GET /api/history` の公開 API、認証境界 |
| D1 | 履歴データと `recent_server_events` cache の保持。relay が無効でも polling で新規観測した `server_event_id` を保存してよい |
| R2 公開バケット | `SpectatorSnapshot` の最新 JSON 配信 |
| Pages SPA | R2 カスタムドメイン上の `snapshot_url` を 5 秒 polling し、`/api/history` を必要時だけ取得する |
| Optional relay / DO | `/ws` ingest、会話ミラー、publish nudge、追加 observability を担う任意コンポーネント。無効でも UI の freshness SLO は守れることを前提とする |

Cloudflare 側の実装物は別リポジトリ `karakuri-world-ui/` に置き、`app/` を Pages、`worker/` を Worker / D1 / 必要に応じた DO に割り当てる。

R2 配信は `*.r2.dev` 直リンクではなく、Cloudflare CDN 設定を適用できるカスタムドメインを前提とする。

## 2. 環境変数とシークレット

| 名前 | 種別 | 用途 |
|------|------|------|
| `KW_BASE_URL` | plain text | 本体サーバーの絶対オリジン URL（例: `http://127.0.0.1:3000`, `https://kw.example.com`）。path / query / fragment は不可 |
| `KW_ADMIN_KEY` | secret | publisher が `/api/snapshot` を取得するための `X-Admin-Key` |
| `SNAPSHOT_OBJECT_KEY` | plain text | 既定値 `snapshot/latest.json` |
| `SNAPSHOT_PUBLISH_INTERVAL_MS` | plain text | publisher の固定 cadence。既定値 `5000` |
| `SNAPSHOT_CACHE_MAX_AGE_SEC` | plain text | R2 object の `Cache-Control` / CDN 想定 TTL。既定値 `5` |
| `AUTH_MODE` | plain text | `public` or `access` |
| `HISTORY_RETENTION_DAYS` | plain text | 既定値 `180` |
| `SNAPSHOT_HEARTBEAT_INTERVAL_MS` | plain text | **任意 / legacy**。relay `/ws` を補助運用する場合の追加 refresh 間隔。primary path の成立条件には含めない |

`SNAPSHOT_PUBLISH_INTERVAL_MS`、`SNAPSHOT_CACHE_MAX_AGE_SEC`、UI 側 polling 間隔は 5 秒で揃える。`SNAPSHOT_HEARTBEAT_INTERVAL_MS` を残す場合も、primary freshness は fixed-cadence publish のみで成立させる。

## 3. Publisher / relay の責務

### 3.1 Publisher state

```typescript
interface PublisherState {
  latest_snapshot?: SpectatorSnapshot;
  recent_server_events: Array<{
    server_event_id: string;
    description: string;
    occurred_at: number;
  }>;
  active_server_event_ids: string[];
  publish_in_flight: boolean;
  publish_queued: boolean;
  last_publish_at?: number;
  last_refresh_at?: number;
  publish_alarm_at?: number;
  publish_failure_streak: number;
}

interface RelayConversationState {
  conversation_id: string;
  status: 'pending' | 'active' | 'closing';
  participant_agent_ids: string[];
  initiator_agent_id?: string;
  current_speaker_agent_id?: string;
  closing_reason?: 'ended_by_agent' | 'max_turns' | 'server_event' | 'turn_timeout' | 'participant_logged_out';
  updated_at: number;
}

interface OptionalRelayState {
  websocket?: WebSocket;
  conversations: Record<string, RelayConversationState>;
  reconnect_attempt: number;
  disconnect_started_at?: number;
  last_event_at?: number;
}
```

primary path で必須なのは `PublisherState` だけである。`OptionalRelayState` は `/ws` ingest を残す配備でのみ使う。

### 3.2 起動フロー

1. D1 の `server_event_instances`（または同等の publisher-side cache）があれば直近 3 件の論理 server event を復元し、なければ `recent_server_events = []` で起動する
2. `active_server_event_ids = []` で初期化する
3. `refreshAndPublish('boot')` を 1 回実行して最初の `snapshot/latest.json` を作る
4. `schedulePublish()` を **sub-minute-capable な trigger** で開始し、以後は `SNAPSHOT_PUBLISH_INTERVAL_MS` ごとに `/api/snapshot` を再取得する
5. relay `/ws` を使う配備では、起動後に `connectWebSocket()` を追加で実行してよい。ただし relay 不在でも 4 が継続することを UI freshness の成立条件とする

### 3.3 任意の relay mirror（history 補助）

`/api/history` を D1 で高効率に返したい配備では、relay が `/ws` event を ingest して会話参加者集合を補う mirror を持ってよい。ただしこの mirror は **snapshot 配信の正本ではない**。

- seed source は `WorldSnapshot.conversations` とする
- relay を使う場合でも、定期 publish は必ず `GET /api/snapshot` の結果から `SpectatorSnapshot` を再生成する
- history link 解決のため、mirror は optional に `closing_reason` を保持してよい。`conversation_closing` では 3 種（`ended_by_agent` / `max_turns` / `server_event`）を反映し、`conversation_closing` を経由しない直接 `conversation_ended` では削除前の一時 state として `turn_timeout` / `participant_logged_out` を含む最終 reason を投影してよい
- relay mirror が壊れても map / freshness 配信は継続し、影響は history 欠落または補助 observability の低下に閉じる

## 4. snapshot 取得フロー

### 4.1 fixed-cadence polling

publisher は `SNAPSHOT_PUBLISH_INTERVAL_MS = 5000` を既定とする fixed cadence で `/api/snapshot` を取得する。quiet period でも cadence は止めない。

1. `publish_in_flight === true` なら `publish_queued = true` を立てて終了
2. `publish_in_flight = true` にして `GET /api/snapshot` を `X-Admin-Key` 付きで取得する
3. `WorldSnapshot` を 12-spectator-snapshot.md の規則で `SpectatorSnapshot` へ変換する
4. `recent_server_events` は primary baseline として `WorldSnapshot.server_events` の **新規観測 edge** から更新する。前回 poll に存在しなかった `server_event_id` を見つけたら `occurred_at = generated_at` で cache に追加し、D1 `server_event_instances` や relay/backfill がある配備ではその後に authoritative な初回発火時刻へ補正してよい
5. `active_server_event_ids` を今回の `WorldSnapshot.server_events[].server_event_id` で置き換える。cold start 直後に永続 cache が無い場合、publisher 起動前に完了済みだった recent history は再現を保証しない
6. `latest_snapshot` を更新し、`last_refresh_at = Date.now()` を記録する
7. `publishSnapshot()` を呼ぶ
8. finally で `publish_in_flight = false` を戻し、`publish_queued === true` なら 1 回だけ追随実行する

### 4.2 trigger の優先順位

publish trigger は以下の順に扱う。

1. **primary**: Durable Object alarm / 外部 cron / 常駐 scheduler などの sub-minute-capable fixed-cadence trigger
2. boot 時の即時 publish
3. 任意の manual trigger（deploy smoke、operator refresh）
4. relay `/ws` event からの best-effort nudge

`/ws` event は「あれば publish を早めてもよい」だけであり、唯一の refresh 契機にしてはならない。

### 4.3 任意の event ingest

relay `/ws` を有効化する配備では、`type: 'event'` を D1 へ保存して `/api/history` を補強してよい。会話 link 解決や unknown event drop の規則は 12-spectator-snapshot.md §5.3〜§5.4、14-ui-history-api.md の定義に従う。

- D1 ingest 失敗は snapshot publish を止めない
- relay 切断中に history gap が発生しうることは明示的に許容する
- relay が無効な配備でも current-state UI は成立しなければならない

## 5. publish とブラウザ配信

### 5.1 publish アルゴリズム

`publishSnapshot()` は最新 `SpectatorSnapshot` を R2 へ上書き publish する。

1. `published_at = Date.now()` で上書きした body を作る
2. `SNAPSHOT_OBJECT_KEY` に PUT する
3. 成功時は `last_publish_at = Date.now()`、`publish_failure_streak = 0`
4. 失敗時は last good object を巻き戻さず、`publish_failure_streak += 1` とし、`min(5000 * 2^(N-1), 60000)` の backoff で次回 publish を再予約する

これにより広域障害時に retry が暴走せず、復旧後は fixed cadence へ戻る。

### 5.2 publish ルール

- object key: `SNAPSHOT_OBJECT_KEY`（既定値: `snapshot/latest.json`）
- `Content-Type: application/json; charset=utf-8`
- `Cache-Control: public, max-age=5`
- metadata に `schema-version=1` を付与する
- `published_at` は毎回の publish 時刻で上書きする

### 5.3 ブラウザ向け cadence と freshness

ブラウザは `snapshot_url`（R2 カスタムドメイン + `SNAPSHOT_OBJECT_KEY`）を 5 秒ごとに直接 fetch する。primary path の正常系予算は次の 3 要素だけで説明できる。

- publisher の `/api/snapshot` 再取得: 5 秒
- CDN Edge TTL / object `max-age`: 5 秒
- UI polling: 5 秒

したがって quiet period を含む正常系 freshness 予算は **15 秒** とする。`generated_at` が stale 判定の正本であり、`published_at` は「publisher が最後に正常 publish できた時刻」を示す診断値に留める。

### 5.4 ブラウザ向け snapshot 配信

browser は R2 公開バケットの CDN URL を直接 polling する。Worker / Pages 経由の snapshot proxy fallback は採用しない。

- UI は配備時に注入した `snapshot_url` を使う
- CDN / Cache Rules は R2 カスタムドメイン側へ設定する
- Worker が担当する動的 API は `/api/history` のみとする
- `AUTH_MODE=access` の場合も snapshot 認可は R2 カスタムドメイン側で完結させる
- snapshot が cross-origin になる配備では、R2 カスタムドメイン側で Pages origin を許可する CORS 設定を行う

#### 5.4.1 Access 保護時の成立条件

`AUTH_MODE=access` で Pages origin と R2 カスタムドメインが別 origin のまま direct fetch を行う場合、初回 fetch の前に **Pages 側と R2 側の両 origin で有効な Access セッションが確立済み** でなければならない。

- 推奨構成は、Pages / Worker API / R2 カスタムドメインを 1 つの Cloudflare Access アプリ（または同等の multi-domain policy）で束ねること
- 上記ができない場合は、SPA 初回表示前に R2 カスタムドメインへの cookie pre-seeding を完了させること
- 満たせない配備は `AUTH_MODE=access` として成立しない。same-origin の snapshot proxy へ逃がさない

### 5.5 CDN / Cache Rules 前提条件

1. R2 バケットを Cloudflare のカスタムドメインで公開する
2. `SNAPSHOT_OBJECT_KEY` を含む公開 URL を Cache Rules の対象に入れる
3. Cache level は `Cache Everything` とする
4. Edge TTL は 5 秒へ固定する
5. origin 側の `Cache-Control: public, max-age=5` と矛盾しない値を維持する

この設定がない場合、R2 読み取りが CDN へ逃げず、本設計の低コスト前提を満たせない。

### 5.6 5 秒制約

以下 3 値は同じ値に固定する。

- publisher cadence
- R2 object の `max-age`
- UI の polling 間隔

relay `/ws` を補助で使う場合も、この 3 値を primary SLO とする。

## 6. 任意の WebSocket relay

### 6.1 役割と backoff

relay `/ws` は optional accelerator であり、必要なら次を担う。

- D1 history ingest の鮮度向上
- `server_event_fired` などを受けた際の publish nudge
- relay 固有の disconnect / event gap observability

接続失敗時の backoff は 1, 2, 4, 8, 16, 30 秒（±20% jitter）を既定とする。

### 6.2 切断時の扱い

- relay 切断は **current-state UI の停止条件ではない**
- fixed-cadence publish が継続し `generated_at` が進む限り、UI は stale にならない
- relay 切断中は history gap が発生しうる
- relay 再接続後に snapshot / mirror を再同期してよいが、それは補助経路の回復であり primary freshness の回復条件ではない

## 7. Worker API

Worker は `GET /api/history` のみを公開する。実装は Hono ルーティングで行い、処理本体は D1 読み取りとする。

```txt
GET /api/history
```

- map / agent status の primary 表示は `snapshot_url` だけで成立する
- `/api/history` は detail overlay の追加情報であり、snapshot 配信より 1 段低い依存に置く
- history が一時的に遅延・欠落しても current-state rendering は継続する

クエリ仕様は 14-ui-history-api.md を参照。

## 8. 認証モード

### 8.1 `AUTH_MODE=public`

- Pages, Worker API, R2 カスタムドメインを無認証で公開する
- snapshot は R2 カスタムドメインの CDN URL をブラウザから直接取得する
- アプリ側追加認証は行わない

### 8.2 `AUTH_MODE=access`

- Pages / Worker API / R2 カスタムドメインを Cloudflare Access の保護対象に置く
- browser は `snapshot_url` へ `credentials: 'include'` 付きで fetch する
- R2 カスタムドメインは Pages origin に対して `Access-Control-Allow-Origin` と `Access-Control-Allow-Credentials: true` を返すよう構成する
- Access cookie の共有または pre-seeding を保証できない配備は不採用とし、snapshot poll を Worker/Pages 経由へ切り替えない
- `/api/history` は引き続き Worker 側の Access 境界で保護し、Workers アプリ側で JWT 検証は行わない

`AUTH_MODE` は配備単位で 1 つ選ぶ。いずれの mode でも UI は CDN の `snapshot_url` を使う。

## 9. 障害時の応答

| 障害 | publisher / relay の挙動 | UI への見え方 |
|------|---------------------------|---------------|
| `/api/snapshot` 一時失敗 | last good snapshot を維持し、fixed-cadence または backoff 後 publish を再試行 | `generated_at` 停滞が 60 秒を超えるまでは stale にならない |
| R2 書き込み失敗 | `publish_failure_streak` を進めて retry。last good object は残す | 直近 object を表示し続け、長期化時のみ stale へ近づく |
| D1 書き込み失敗 | history ingest を失敗扱いにして snapshot publish は継続 | 履歴欠落の可能性。current-state UI は継続 |
| relay `/ws` 切断 | optional relay だけを backoff 再接続 | relay 無効時と同様、publish が継続すれば stale にならない |

### 9.1 observability 要件

primary readiness で最低限見るべきシグナルは以下とする。

| 指標 | 種別 | 増分契機 |
|------|------|----------|
| `ui.snapshot.refresh_failure_total{reason}` | counter | `/api/snapshot` refresh 失敗ごと |
| `ui.r2.publish_failure_total` | counter | R2 PUT 失敗ごと |
| `ui.r2.publish_failure_streak` | gauge | R2 publish の連続失敗回数 |
| `ui.snapshot.generated_age_ms` | gauge | 直近 object の `Date.now() - generated_at` |
| `ui.snapshot.published_age_ms` | gauge | 直近 object の `Date.now() - published_at` |
| `ui.d1.retention_run_total{result}` | counter | retention cron 実行ごと |
| `ui.d1.retention_deleted_rows` | gauge | 直近 retention 成功時の削除行数 |

`ui.d1.ingest_failure_total{event_type}` は **primary readiness 指標には含めない**。これは relay / history ingest の劣化を示す追加シグナルであり、影響範囲は `/api/history` 欠落・遅延に閉じる。したがって current-state UI の launch gate は `generated_age_ms` / `published_age_ms` / publish failure を中心に判定し、history ingest failure 単独では launch-blocker にしない。

relay を残す配備では、補助的に `ui.d1.ingest_failure_total{event_type}`、既存の `relay.ws.disconnect_total{reason,handshake_status}`、`relay.ws.connect_duration_ms`、`relay.ws.event_gap_ms` を使ってよい。ただし production readiness の最優先判定は `generated_age_ms` / `published_age_ms` / publish failure に置き、`/ws` uptime や history ingest の成否自体を primary gate にしてはならない。
