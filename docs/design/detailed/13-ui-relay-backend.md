# 13 - UI 中継バックエンド（Workers / DO / R2）

## 1. 構成

UI 中継レイヤーは Cloudflare 上の以下 4 要素で構成する。

| 要素 | 役割 |
|------|------|
| Workers (Hono) | `GET /api/history` の公開 API、認証境界 |
| Durable Object | `/ws` 常時接続、D1 永続化、`/api/snapshot` 再取得、R2 更新 |
| D1 | 履歴データ保持 |
| R2 公開バケット | `SpectatorSnapshot` の最新 JSON 配信 |

Cloudflare 側の実装物は overview どおり別リポジトリ `karakuri-world-ui/` に置き、`worker/` 配下を Hono エントリ + Durable Object 本体、`app/` 配下を Pages 配備する React/Vite SPA とする。

DO は 1 ワールドにつき 1 インスタンスだけを使用する。`env.UI_BRIDGE.idFromName('primary')` のような固定名で singleton 化する。

R2 配信は `*.r2.dev` 直リンクではなく、Cloudflare CDN 設定を適用できるカスタムドメインを前提とする。

## 2. 環境変数とシークレット

| 名前 | 種別 | 用途 |
|------|------|------|
| `KW_BASE_URL` | plain text | 本体サーバーの絶対オリジン URL（例: `http://127.0.0.1:3000`, `https://kw.example.com`）。path / query / fragment は不可 |
| `KW_ADMIN_KEY` | secret | `/ws`, `/api/snapshot` 用 `X-Admin-Key` |
| `SNAPSHOT_OBJECT_KEY` | plain text | 既定値 `snapshot/latest.json` |
| `SNAPSHOT_PUBLISH_INTERVAL_MS` | plain text | 既定値 `5000` |
| `SNAPSHOT_HEARTBEAT_INTERVAL_MS` | plain text | イベント無発生時の freshness heartbeat 間隔。既定値 `30000` |
| `SNAPSHOT_CACHE_MAX_AGE_SEC` | plain text | 既定値 `5` |
| `AUTH_MODE` | plain text | `public` or `access` |
| `HISTORY_RETENTION_DAYS` | plain text | 既定値 `180` |

## 3. Durable Object の責務

### 3.1 インメモリ状態

```typescript
interface BridgeConversationState {
  conversation_id: string;
  status: 'pending' | 'active' | 'closing';
  participant_agent_ids: string[];
  initiator_agent_id?: string;
  current_speaker_agent_id?: string;
  closing_reason?: 'max_turns' | 'turn_timeout' | 'server_event' | 'ended_by_agent' | 'participant_logged_out';
  updated_at: number;
}

interface BridgeState {
  websocket?: WebSocket;
  latest_snapshot?: SpectatorSnapshot;
  conversations: Record<string, BridgeConversationState>;
  recent_server_events: Array<{
    server_event_id: string;
    description: string;
    occurred_at: number;
  }>; // server_event_id 単位で重複排除済みの論理イベント
  last_event_at?: number;
  last_publish_at?: number;
  last_refresh_at?: number;
  reconnect_attempt: number;
  refresh_in_flight: boolean;
  refresh_queued: boolean;
  publish_alarm_at?: number;   // 次回 publish 試行時刻。throttle 待ち・R2 書き込み再試行の両方に使う
  heartbeat_alarm_at?: number; // 次回 heartbeat refresh 試行時刻。直前の refresh 成否に関わらず常に維持する
}
```

### 3.2 起動フロー

1. D1 の `server_event_instances` から `ORDER BY first_occurred_at DESC, server_event_id DESC LIMIT 3` で論理 server event を復元し、`recent_server_events` を初期化する。cold start で `world_events` 全体を `GROUP BY server_event_id` する設計は採らず、遅延再配信の重複排除は ingest 時に `server_event_instances` へ畳み込んでおく
2. `connectWebSocket()` を実行する
3. `KW_BASE_URL` から `new URL('/ws', KW_BASE_URL)` を生成し、`https:` は `wss:`, `http:` は `ws:` へ変換した URL に `X-Admin-Key` 付きで接続する。`/api/snapshot` も同じ `KW_BASE_URL` から `new URL('/api/snapshot', KW_BASE_URL)` で導出する
4. 接続直後に受信する `type: 'snapshot'` を `SpectatorSnapshot` に変換し、メモリへ保持する
5. 初回 snapshot 受信時点で `last_refresh_at = Date.now()` を記録し、**publish 成否とは独立に** `scheduleHeartbeat()` を呼んで quiet period 用 alarm を開始する
6. その後 `schedulePublish()` を呼ぶ。初回 publish は `last_publish_at` が未設定のため即時実行してよいが、2 回目以降は常に `SNAPSHOT_PUBLISH_INTERVAL_MS` の throttle に従う。初回 publish が失敗した場合も `publish_alarm_at` を再設定し、次の DO alarm で再試行する

### 3.3 DO 内の会話状態ミラー

`latest_snapshot` は観戦 UI 向けの投影結果であり、world event 受信直後の link 解決には使わない。`conversation_turn_started` / `conversation_inactive_check` のように payload だけでは参加者集合が閉じないイベントに備え、DO は `BridgeState.conversations` に authoritative な会話状態ミラーを別途保持する。

- seed source は本体の `WorldSnapshot.conversations` とする。起動直後の `/ws` 初回 `snapshot`、以後の `/ws` `snapshot`、`refreshSnapshot()` 成功時のすべてで、受け取った `WorldSnapshot.conversations` から `BridgeState.conversations` を丸ごと再構築する
- この再構築は `SpectatorSnapshot` への変換より先に行う。したがって `latest_snapshot` がまだ旧値でも、同じ入力 `WorldSnapshot` から復元した会話状態ミラーを ingest に使える
- event ingest 中は `BridgeState.conversations` を直接その場で書き換えず、まず「event 適用後の next state」をローカルに作る。link 行はこの next state を使って解決し、D1 書き込み成功後にだけ `BridgeState.conversations` へ commit する。D1 書き込み失敗時は mirror 更新も破棄し、次回 snapshot 再同期を待つ
- teardown は `conversation_rejected` / `conversation_ended` の保存成功直後に行う。これらは D1 保存後に対象 `conversation_id` を mirror から削除する
- `conversation_pending_join_cancelled` は pending joiner だけの取消通知であり active participant 集合を変えないため、mirror は更新しない

## 4. WebSocket 受信処理

### 4.1 受信ペイロード

本体の `/ws` は次の 2 種類のみを送る。

- `type: 'snapshot'`
- `type: 'event'`

### 4.2 `snapshot` 受信時

1. `WorldSnapshot.conversations` から `BridgeState.conversations` を全面再構築する
2. `WorldSnapshot` を 12-spectator-snapshot.md の規則で `SpectatorSnapshot` へ変換
3. メモリ上 `latest_snapshot` を置換
4. D1 には保存しない
5. `schedulePublish()` を呼ぶ。`last_publish_at` が未設定の cold start 時だけ即時 publish を許可し、それ以外は 5.2 の throttle に従う。失敗時も heartbeat alarm はそのまま維持し、`publish_alarm_at` を再設定して再試行する

### 4.3 `event` 受信時

1. イベントをサニタイズして D1 へ保存する。`server_event_fired` の場合は同一 ingest 処理で `server_event_instances` にも UPSERT し、`first_occurred_at = min(existing, incoming)` / `last_occurred_at = max(existing, incoming)` を維持する。`/api/history` 用の `world_event_agents` / `world_event_conversations` link 行にも同じ `occurred_at` を冗長保存し、agent / conversation cursor が `ORDER BY occurred_at DESC, event_id DESC` を index 走査で満たせるようにする。会話イベントは 14-ui-history-api.md §4.2.1 の staged update 規則で link し、payload に参加者一覧がない `conversation_turn_started` / `conversation_inactive_check` では `latest_snapshot` ではなく `BridgeState.conversations` の next state から対象参加者集合を補完する
2. `last_event_at` を更新する
3. `event.type === 'server_event_fired'` の場合は `recent_server_events` を `server_event_id` 単位で merge する。未登録の `server_event_id` のみ `{ server_event_id, description, occurred_at }` を追加し、既存 `server_event_id`（遅延再配信を含む）は重複追加せず既存の `occurred_at` / 並び順を維持する。その後 `occurred_at DESC` で最大 3 件に切り詰める
4. `refreshSnapshot('world-event')` を要求する

DO はイベント差分で snapshot を更新しない。毎回 `/api/snapshot` を再取得し、サーバー本体を正本とする。

## 5. snapshot 再取得と R2 publish

### 5.1 再取得アルゴリズム

`refreshSnapshot()` は多重実行を禁止する。成功時だけでなく失敗時も、quiet period 中に再試行が途切れないよう alarm を維持する。

1. `refresh_in_flight === true` なら `refresh_queued = true` を立てて終了
2. `new URL('/api/snapshot', KW_BASE_URL)` を `X-Admin-Key` 付きで取得
3. `WorldSnapshot.conversations` から `BridgeState.conversations` を全面再構築する
4. `WorldSnapshot` を `SpectatorSnapshot` に変換する。このとき `recent_server_events` はメモリ上の履歴を使って埋め、`is_active` は `WorldSnapshot.server_events` との `server_event_id` 突合で判定する
5. `latest_snapshot` を更新し、`last_refresh_at = Date.now()` を記録する
6. `scheduleHeartbeat()` を呼ぶ
7. `schedulePublish()` を呼ぶ
8. `/api/snapshot` 取得または変換に失敗した場合は `latest_snapshot` と `BridgeState.conversations` を維持したまま終了し、**既存の `heartbeat_alarm_at` を消さない**。`reason === 'heartbeat'` で失敗した場合は `heartbeat_alarm_at = Date.now() + SNAPSHOT_HEARTBEAT_INTERVAL_MS` として次回試行を再予約する
9. 完了時に `refresh_in_flight = false`
10. `refresh_queued === true` なら 1 回だけ再実行

### 5.2 publish ルール

- object key: `SNAPSHOT_OBJECT_KEY` を使用する（既定値: `snapshot/latest.json`）
- `Content-Type: application/json; charset=utf-8`
- `Cache-Control: public, max-age=5`
- メタデータに `schema-version=1` を付与する
- `published_at` は毎回の publish 時刻で上書きする

publish 間隔は `SNAPSHOT_PUBLISH_INTERVAL_MS = 5000` を既定とし、`last_publish_at` がある状態では 5 秒未満で再書き込みしない。cold start の初回 publish のみ即時実行してよく、その後の publish はすべて DO alarm 経由を含めて同じ throttle に従う。`SNAPSHOT_OBJECT_KEY` を変更した場合も、publish 先・UI の `snapshot_url`・Cache Rules 対象は同じキーへ揃える。

R2 書き込み失敗時は `latest_snapshot` / `last_refresh_at` を巻き戻さず、`publish_alarm_at = max(Date.now(), (last_publish_at ?? 0) + SNAPSHOT_PUBLISH_INTERVAL_MS)` を再設定して次回 alarm で再試行する。これにより、初回 publish が失敗した場合でも次の world event を待たずに retry が継続する。

### 5.3 heartbeat refresh

overview に合わせ、UI の stale 判定は `generated_at` を正本とする。DO は `SNAPSHOT_HEARTBEAT_INTERVAL_MS = 30000` を既定とし、イベントが来ていない間も `/api/snapshot` を再取得して本体に新しい `generated_at` を発行させる。`published_at` は stale 判定の解除条件ではなく、relay freshness の補助情報としてのみ扱う。

1. `scheduleHeartbeat()` は **初回 WebSocket snapshot 受信直後** と、以後のすべての成功した snapshot 取得後に呼ぶ
2. `scheduleHeartbeat()` は `heartbeat_alarm_at` を「次回 heartbeat **試行**時刻」として扱う。直前の publish 成否や refresh 成否を条件に消さない
3. `heartbeat_alarm_at = last_refresh_at + SNAPSHOT_HEARTBEAT_INTERVAL_MS` を記録し、DO alarm は `publish_alarm_at` と `heartbeat_alarm_at` のうち早いほうへ再設定する
4. alarm 起動時に `heartbeat_alarm_at` が期限到達していれば、まず `heartbeat_alarm_at = Date.now() + SNAPSHOT_HEARTBEAT_INTERVAL_MS` を再設定してから `refreshSnapshot('heartbeat')` を呼ぶ。これにより refresh が失敗しても quiet period 中の retry が止まらない
5. heartbeat refresh でも `/api/snapshot` を再取得する
6. WebSocket の接続状態は heartbeat refresh の実行条件にしない。`/ws` の再接続中でも DO alarm は維持し、`/api/snapshot` に到達できる限り heartbeat refresh を継続する
7. 世界状態に変化がなくても `/api/snapshot` の再取得が成功すれば新しい `generated_at` を含む `WorldSnapshot` が返るため、quiet period や `/ws` 再接続中でも `generated_at` は進みうる
8. UI は `generated_at` の経過時間だけで stale 判定を行い、`published_at` は「relay が最後に正常 publish できた時刻」を示す診断値としてのみ使う

### 5.4 ブラウザ向け snapshot 配信

 overview に合わせ、ブラウザは R2 公開バケットの CDN URL を直接ポーリングする。取得先は R2 カスタムドメイン配下の絶対 URL であり、`SNAPSHOT_OBJECT_KEY` を連結して決める（例: 既定値のままなら `https://snapshot.example.com/snapshot/latest.json`）。5 秒ごとの snapshot poll を Worker 経由へ切り替えるフォールバックは採用しない。

- UI は配備時に注入した `snapshot_url`（R2 カスタムドメイン + `SNAPSHOT_OBJECT_KEY` の絶対 URL）を 5 秒間隔で直接 fetch する
- CDN / Cache Rules はブラウザ公開 URL そのものである R2 カスタムドメイン側へ設定する
- Workers が担当する動的 API は `/api/history` のみとし、snapshot relay ルートは追加しない
- `AUTH_MODE=access` の場合も snapshot 認可は R2 カスタムドメイン側で完結させる
- snapshot が cross-origin になる配備では、R2 カスタムドメイン側で Pages origin を許可する CORS 設定を行う

#### 5.4.1 Access 保護時の成立条件

`AUTH_MODE=access` で Pages origin と R2 カスタムドメインが別 origin のまま direct fetch を行う場合、`credentials: 'include'` と CORS だけでは不十分である。初回の snapshot fetch が成功するためには、SPA 起動前に **Pages 側と R2 側の両 origin で有効な Access セッションが確立済み** でなければならない。

- 推奨構成は、Pages / Worker API / R2 カスタムドメインを 1 つの Cloudflare Access アプリ（または同等の multi-domain Access policy）で束ね、1 回の認証で両 origin に対する cookie を事前発行できる構成とする
- 上記ができない場合は、SPA 初回表示前に R2 カスタムドメインへの遷移・silent preflight・同等の cookie pre-seeding フローを必須とし、direct fetch 開始前に R2 側 Access cookie の存在を保証する
- **上記のいずれも満たせない配備では `AUTH_MODE=access` 配備自体を成立条件未達とみなし、この構成は採用してはならない**。snapshot poll を same-origin の Worker/Pages ルートへ逃がす代替案は overview の負荷要件に反するため不採用とする

したがって、cross-origin 配備の成立条件は「CORS 設定済み」ではなく「CORS 設定済み かつ Access セッション共有または cookie pre-seeding 済み」である。満たせない場合は `AUTH_MODE=public` を選ぶか、Access 配備条件を見直す。

### 5.5 CDN / Cache Rules 前提条件

overview のコスト・スケーラビリティ要件を満たすため、R2 の公開経路には以下を必須設定とする。

1. R2 バケットを Cloudflare のカスタムドメイン（例: `snapshot.example.com`）で公開する
2. `SNAPSHOT_OBJECT_KEY` を含む公開 URL を必ず Cache Rules の対象に入れる（既定値のままなら `snapshot/*` を対象にすればよい）
3. Cache level は `Cache Everything` とする（JSON を明示的にキャッシュ対象へ昇格）
4. Edge TTL は 5 秒へ固定する
5. origin 側の `Cache-Control: public, max-age=5` と矛盾しない値を維持する

この設定がない場合、JSON は CDN エッジで安定してヒットせず、閲覧数増加時に R2 Class B 読み取りがそのまま増えるため、本設計の「CDN 規模で低コスト配信」という前提を満たせない。

ブラウザ公開 URL そのものがこの R2 カスタムドメインとなる。認証の有無に関わらず Cache Rules 自体は同一内容とする。

### 5.6 5 秒制約

以下 3 値は同じ値に固定する。

- DO publish throttle
- R2 object の `max-age`
- UI の polling 間隔

この値の変更は 3 箇所を同時に変更することを前提とする。
heartbeat 間隔は別管理とし、polling 間隔より十分長く（既定 30 秒）保つ。

## 6. 再接続

### 6.1 バックオフ

接続失敗時は指数バックオフ + ジッターを用いる。

| 失敗回数 | 待機秒 |
|---------|--------|
| 1 | 1 |
| 2 | 2 |
| 3 | 4 |
| 4 | 8 |
| 5 | 16 |
| 6 以降 | 30 |

待機値に対して ±20% のランダムジッターを入れる。

### 6.2 切断時の扱い

- 既存の R2 snapshot は削除しない
- 既存の heartbeat alarm は維持し、`/ws` 再接続中でも `/api/snapshot` が成功する限り `generated_at` / `published_at` は進み続ける
- UI の stale 表示は `/ws` 切断そのものではなく、`generated_at` が 60 秒超停滞したときにだけ出る。したがって `/ws` 切断と同時に `/api/snapshot` も失敗し続けた場合や、本体が新しい snapshot を生成できない場合に stale へ遷移する
- 再接続後は `/ws` 初回 `snapshot` で状態を全面再構築する

## 7. Worker API

Workers は `GET /api/history` のみを公開する。実装は `karakuri-world-ui/worker/index.ts` の Hono ルーティングで行い、処理本体は D1 読み取りとする。本体サーバーへの転送は行わない。snapshot poll 用の relay / proxy API は追加しない。

```txt
GET /api/history
```

クエリ仕様は 14-ui-history-api.md を参照。

## 8. 認証モード

### 8.1 `AUTH_MODE=public`

- Pages, Worker API, R2 カスタムドメインを無認証で公開する
- snapshot は R2 カスタムドメインの CDN URL をブラウザから直接取得する。URL は `SNAPSHOT_OBJECT_KEY` を反映した `snapshot_url` を使う
- アプリ側追加認証は行わない

### 8.2 `AUTH_MODE=access`

- Pages / Worker API と R2 カスタムドメインを Cloudflare Access の保護対象に置く
- direct snapshot fetch を使う配備では、Pages と R2 が同一 Access アプリまたは同等の multi-domain Access policy 配下にあり、初回 fetch 前から両 origin に対する Access cookie が成立していることを必須条件とする
- snapshot 認可を R2 カスタムドメイン側で成立させる場合、UI はその絶対 URL へ `credentials: 'include'` 付きで fetch する
- R2 カスタムドメインは Pages origin に対して `Access-Control-Allow-Origin` と `Access-Control-Allow-Credentials: true` を返すよう構成する
- Access cookie の共有または pre-seeding を保証できない配備は不採用とし、snapshot poll を Worker/Pages 経由へ切り替えない
- `/api/history` は引き続き Worker 側の Access 境界で保護し、Workers アプリ側で JWT 検証は行わない

`AUTH_MODE` は配備単位で 1 つ選ぶ。UI は `public` と、条件を満たした `access` 配備のいずれでも CDN の `snapshot_url` を使う。条件を満たせない `access` 配備は構成不備として扱い、proxy fallback は設けない。

## 9. 障害時の応答

| 障害 | DO の挙動 | UI への見え方 |
|------|-----------|---------------|
| `/ws` 切断 | バックオフ再接続 + heartbeat refresh 継続。`/api/snapshot` に到達できる間は publish も継続 | `generated_at` が進み続ける限り stale にならない。heartbeat も止まった場合のみ stale バッジ表示 |
| `/api/snapshot` 一時失敗 | 既存 snapshot を維持し、既に予約済みの heartbeat alarm を残したまま次回 heartbeat で再試行 | heartbeat 欠落後に stale バッジ表示 |
| D1 書き込み失敗 | エラーログ出力、snapshot 更新は継続 | 履歴 API の一部欠落 |
| R2 書き込み失敗 | `publish_alarm_at` を再設定し、world event が来なくても DO alarm で publish を再試行 | heartbeat 欠落後に stale バッジ表示 |

履歴保存の失敗は観戦継続を止めない。一方で最新 snapshot の維持を最優先とする。
