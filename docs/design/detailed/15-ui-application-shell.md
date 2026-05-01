# 15 - UI アプリケーションシェル

> **Issue #60 / #64 以降**: 正本は event-driven publish → R2 alias (`snapshot/latest.json`) + `history/*` を UI が 5 秒周期で直接 polling する構成。manifest / versioned snapshot / Worker read endpoint は全廃し、UI の stale 判定は age-based timer ではなく publish-health metadata を使う。history は snapshot poll 成功時に自動再取得され、ページング / cursor は持たない。

## 1. 画面責務

### 1.1 UI 実装スタック

overview で確定した UI 側の実装基盤は以下のとおりとする。

| 領域 | 採用 | 用途 |
|------|------|------|
| SPA | React + Vite | Pages に配備する観戦クライアント |
| DOM スタイリング | Tailwind CSS | サイドバー、上部バッジ、オーバーレイ、ボトムシート |
| マップ描画 | Pixi.js / `@pixi/react` | グリッド、エージェント、ズーム操作 |
| publish endpoint | Hono | Worker 側の publish ルーティング（`/api/publish-snapshot` / `/api/publish-agent-history`）。read 系 endpoint は持たない |

Pixi 領域以外の UI パーツは React + Tailwind で実装し、ブラウザ向け画面で別スタックを追加しない。

### 1.2 UI パッケージ構成

UI システムは monorepo 内の `apps/front/` workspace（`@karakuri-world/front`）で管理し、少なくとも以下の構成を前提とする。サーバー本体（`apps/server/`、`@karakuri-world/server`）とは同一リポジトリでも別パッケージとして切り離し、デプロイ単位とビルドパイプラインを独立させる。

```txt
apps/front/
├── app/            # React SPA (Vite)
├── worker/         # Hono API + Durable Object
├── wrangler.toml
└── vite.config.ts
```

`app/` は Pages 配備対象、`worker/` は Workers 配備対象とし、サーバー本体の `apps/server/` へ UI 実装物を混在させない。詳細なレイヤー分割は 13-ui-relay-backend.md と 16-ui-map-view.md に従う。

### 1.3 画面責務

SPA は単一ルート `/` を持つ観戦専用ビューとする。表示責務は以下の 3 つに分ける。

| 領域 | 責務 |
|------|------|
| サイドバー / トップバッジ / ボトムシート | 日付・天気・サーバーイベント・サーバーアナウンス・エージェント一覧 |
| マップ | ワールド全体の可視化、選択操作 |
| オーバーレイ | 選択エージェントの詳細と履歴 |

## 2. 実装優先順位

最初に実装する画面は以下の順とする。

1. マップ表示
2. エージェント一覧選択
3. エージェント詳細オーバーレイ
4. 会話ログ展開

観戦 UI の中核は「現在の世界を見渡せること」であるため、マップを最優先にする。

## 3. 状態管理

### 3.1 Zustand store

```typescript
type HistoryScopeKey = `agent:${string}` | `conversation:${string}`;

// status と response の整合を型で守る discriminated union。
// `ready` 状態では response が必須、`idle` / `loading` / `error` では response は optional。
type HistoryCacheEntry =
  | { status: 'idle' }
  | { status: 'loading'; response?: HistoryResponse; last_fetched_at?: number }
  | { status: 'ready'; response: HistoryResponse; last_fetched_at: number }
  | { status: 'error'; response?: HistoryResponse; last_fetched_at?: number; error_at: number };

interface SnapshotStore {
  snapshot?: SpectatorSnapshot;
  // `incompatible` は schema_version 不一致の永続エラー状態。`error` と明確に区別する。
  snapshot_status: 'idle' | 'loading' | 'ready' | 'error' | 'incompatible';
  last_success_at?: number;
  last_error_at?: number;
  is_stale: boolean;
  selected_agent_id?: string;
  history_cache: Record<HistoryScopeKey, HistoryCacheEntry | undefined>;
  expanded_conversation_ids: Record<string, boolean | undefined>;
  mobile_sheet_mode: 'peek' | 'list' | 'detail';
}
```

履歴キャッシュ key は `agent:{agent_id}` と `conversation:{conversation_id}` を使い、エージェント履歴と会話履歴を同じ store で扱う。

### 3.2 snapshot 適用

snapshot poll は **single-flight** を必須とする。実装既定値として 5 秒 interval polling を行ってよいが、ある fetch が未完了の間は次の poll を同時発行しない。interval tick が重なった場合は `pollQueued = true` のようなフラグだけを立て、進行中 fetch の完了後に 1 回だけ追随 fetch を行う。

`snapshot_url` は R2 alias `snapshot/latest.json` を直接指す。UI は alias body をそのまま `SpectatorSnapshot` として zod パースし、manifest / versioned snapshot の 2 段 fetch は行わない（Issue #64 で撤廃済み）。

store へ反映する前に、現在保持中 snapshot と以下の順で比較し、**新しい version だけを採用する**。

1. `generated_at` が大きい
2. `generated_at` が同一なら `published_at` が大きい
3. それも同一なら `last_publish_error_at` が大きい
4. すべて同一なら同一版として idempotent に扱う

同一 `generated_at` の alias 更新も、edge cache 越しに同じ body を受け取るケースを含む。その場合でも `snapshot_status = 'ready'`, `last_success_at = Date.now()` へ回復してよい。一方で上記順序に当てはまらない遅延レスポンスは破棄し、`snapshot`, `snapshot_status`, `last_success_at`, `is_stale` を巻き戻してはならない。

### 3.3 stale 判定

overview と `13-ui-relay-backend.md` に合わせ、UI の stale 判定は **publish-health metadata** だけで扱う。quiet period 中の age-based stale timer は置かず、healthy な snapshot は `generated_at` が古くなっても stale にしない。クライアント自身の fetch 成否は別軸で扱う。

以下を満たした場合に stale とみなす。

- `snapshot.last_publish_error_at !== undefined && snapshot.last_publish_error_at > snapshot.published_at`

この条件は「last good publish より後に publish/refresh error が発生した」ことを示す。alias body の同一版 poll でも `last_publish_error_at` だけが前進したケースで stale へ遷移できる。

`is_stale` は受理済み snapshot の metadata から導く派生状態であり、**ローカル時刻経過だけで true に遷移させない**。poll 再開後に healthy snapshot を受け取った場合は `is_stale = false` を維持し、quiet period だけを理由に stale バナーを出さない。

`last_success_at` は「最後に poll 自体が成功した時刻」の診断用であり、stale 判定を打ち消す条件にも、発火条件にも使わない。fetch 失敗は stale と別状態であり、`snapshot_status = 'error'` と `last_error_at` で管理する。stale 中も最後に取得した snapshot は表示し続ける。

## 4. snapshot ポーリング

### 4.1 取得先

- URL: 配備時に注入する `VITE_SNAPSHOT_URL`（R2 カスタムドメイン上の alias URL。例: `https://snapshot.example.com/snapshot/latest.json`）
- 間隔: 既定 5000ms。R2 alias の `Cache-Control: public, max-age=5` と揃えている（Issue #64 本文で許容された約 10 秒の worst-case lag）

### 4.2 取得フロー

1. 初回マウント時に即時 fetch
2. 以後は alias を定期再取得するが、3.2 のとおり poll 自体は single-flight とし、重複 tick は 1 回分だけ queue する
3. fetch レスポンスは「**ステータス確認 → JSON parse → `SpectatorSnapshot` schema 検証**」の順で必ず妥当性を検証する。HTTP 非 2xx または JSON parse 失敗は transient な fetch error として `snapshot_status = 'error'`, `last_error_at = Date.now()` を記録する。`schema_version !== 1` は transient error ではなく永続エラー扱いとし、`snapshot_status = 'incompatible'` を記録する。どちらの場合も既存 snapshot はそのまま残す
4. 成功時は 3.2 の比較規則で新しい版だけを採用する。同一版の alias redelivery でも `snapshot_status = 'ready'`, `last_success_at = Date.now()` を記録し、3.3 の publish-health 条件で `is_stale` を即時計算する。age-based stale timer は張らない
5. 3.2 の比較で破棄された遅延成功レスポンスは no-op とし、`snapshot_status`, `last_success_at`, `is_stale` を巻き戻さない。recover 対象になるのはあくまで「現在 store 上の snapshot と同一版」または「それより新しい版」の成功だけである
6. 失敗時は既存 snapshot を保持したまま `snapshot_status = 'error'`, `last_error_at = Date.now()` を記録する。fetch error だけで `is_stale` を true にしない
7. **poll 成功時は `refreshActiveHistoryScopes` を起動**し、`selected_agent_id` と `expanded_conversation_ids` の各 scope について history を再取得する（次節参照）

現行フェーズの polling は常に通常の GET で行い、毎回 200 + body を受け取る前提で実装する。`If-None-Match` / 304 は本書のスコープ外であり、このフェーズでは送出・処理しない。

## 5. デスクトップレイアウト

### 5.1 ブレークポイント

- `lg` 以上（1024px 以上）をデスクトップ扱いとする

### 5.2 幅

| 領域 | 幅 |
|------|----|
| サイドバー | 320px 固定 |
| オーバーレイ | 既定 580px（280–640px の範囲で resize 可能。viewport 幅の 40% を動的上限として clamp し、値は `localStorage` に永続化する） |
| マップ | 残余幅 |

オーバーレイ非表示時はマップが全残余幅を使う。

### 5.3 サイドバー構成

1. ヘッダー: `calendar.display_label`, 天気, 気温
2. 実施中のサーバーイベント: `snapshot.active_server_events` の全件を固定表示し、件数バッジ `[N]` を見出しに添える。`active_server_events.length === 0` の場合はセクションごと非表示にする（empty state も出さない）
3. サーバーアナウンス: `snapshot.recent_server_announcements` の先頭 3 件を固定表示する（backend 側のリングバッファがそのまま publish される）。空の場合は empty state を表示する
4. エージェント一覧: `snapshot.agents` を `state !== 'idle'` を先頭、同順位は `agent_name` 昇順で表示

`recent_server_announcements` は `is_active` フラグ付きで完了済みアナウンスも含む。active バッジ判定は各エントリの `is_active` を使い、polling-only + cold start で cache が空の場合は empty state を表示する。`active_server_events` は backend `ServerEventStore.listActive()` の写しで、`server_event_id` / `description` / `created_at` を保持する（`cleared_at` は派生表現として publisher 側で除外）。

### 5.4 デスクトップオーバーレイ挙動

- エージェント選択時のみ右端からスライドイン表示する
- 開閉アニメーションは `transform: translateX()` ベースで 200ms、ease-out を既定とする
- 背景のマップは閉じずに残し、オーバーレイ開閉でマップの再マウントは行わない
- オーバーレイを閉じても `selected_agent_id` は維持せず解除し、選択ハイライトも同時に外す

## 6. モバイルレイアウト

### 6.1 ブレークポイント

- 1023px 以下をモバイル扱いとする

### 6.2 上部バッジ

- マップは常にフルスクリーン表示し、`calendar.display_label` と天気 / 気温は safe area を考慮した上部バッジとして常時表示する
- 上部バッジはボトムシートの状態に依存せず、`peek` / `list` / `detail` の全モードで残す
- モバイルでは日付・天気をボトムシートへ移さず、overview の「上部バッジ + 下部詳細」の構成を維持する

### 6.3 ボトムシート状態

| モード | 高さ | 内容 |
|--------|------|------|
| `peek` | 88px | エージェント数・進行中イベント数のサマリ |
| `list` | 45vh | 「実施中のイベント」「アナウンス」タブ + エージェント一覧 |
| `detail` | 82vh | 選択エージェント詳細 + 履歴 |

`list` モード上部にタブを 2 つ配置する: 「実施中のイベント (N)」（`snapshot.active_server_events` を表示）と「アナウンス (N)」（`snapshot.recent_server_announcements` を表示）。`active_server_events.length >= 1` の場合は初期表示でイベントタブを自動選択する（active 件数が 0 のときはアナウンスタブを既定）。タブは排他で、同時に両方のパネルを表示しない。

`selected_agent_id` が設定されたら自動で `detail` へ遷移する。モバイルで `detail` を明示的に閉じる場合は `selected_agent_id` も同時に `undefined` へ戻したうえで `list` へ戻す。これにより「選択中なので自動で detail に戻る」ループを防ぐ。`detail` 中もマップと上部バッジは背面に残す。`list` モードのエージェント一覧もデスクトップのサイドバーと同じ並び順（セクション9.1）を使う。

### 6.4 ボトムシート遷移

- ユーザー操作は drag/swipe による 3 段階 snap とし、自由高さにはしない
- snap 先は `peek -> list -> detail` の順で、上方向 swipe で展開、下方向 swipe で縮小する
- `selected_agent_id` がない状態で `detail` へは遷移させない
- `detail` から `list` へ戻す操作は「detail を閉じる」扱いとし、その時点で `selected_agent_id` も解除する
- 背面タップでの dismiss は行わず、明示的なハンドル操作または下方向 swipe で `list` へ戻す

## 7. エージェント選択

### 7.1 選択導線

- マップ上のエージェント / グループをタップ
- サイドバー / ボトムシート一覧をタップ

### 7.2 選択時の処理

1. `selected_agent_id` を更新
2. マップを対象ノードへフォーカス
3. `fetchHistory({ agent_id })` を無条件に呼ぶ。取得先は `${snapshotOrigin}/history/agents/{encodeURIComponent(agent_id)}.json`
4. デスクトップはオーバーレイ開閉、モバイルは `detail` 表示へ切り替え

選択後は snapshot polling の完了ごとに `refreshActiveHistoryScopes` が同じ scope を自動再取得するため、30 秒 TTL のようなクライアント側ゲートは持たない。キャッシュが壊れた場合は `status: 'error'` から retry ボタンで復帰する。

## 8. オーバーレイ仕様

### 8.1 表示項目

- アバター
- エージェント名
- `status_emoji`
- 現在地 `node_id`
- 現在の行動（移動中 / 待機中 / アクション中 / 会話中）
- 履歴一覧（新しい順）

### 8.2 会話ログ展開

- `conversation_id` を持つ履歴項目は折りたたみ可能にする
- 展開状態は `expanded_conversation_ids[conversation_id]` で保持する
- 展開時に `fetchHistory({ conversation_id })` を呼ぶ（取得先: `${snapshotOrigin}/history/conversations/{encodeURIComponent(conversation_id)}.json`）
- 以降は snapshot polling 成功のたびに `refreshActiveHistoryScopes` が同じ scope を自動再取得する
- エージェント履歴本体 (`agent:{agent_id}`) と会話詳細 (`conversation:{conversation_id}`) は別キャッシュとして保持し、相互に上書きしない

### 8.3 履歴取得アクション

履歴取得ロジックは以下の共通アクションへ寄せる。

```typescript
fetchHistory(scope: { agent_id: string } | { conversation_id: string }): Promise<void>
```

- scope から `HistoryScopeKey` を生成する
- fetch 開始時に対応 cache entry の `status = 'loading'`（既存 `response` / `last_fetched_at` がある場合はそのまま保持）
- 取得先は `VITE_SNAPSHOT_URL` の origin から派生させた R2 URL（`history/agents/{id}.json` / `history/conversations/{id}.json`）
- HTTP 404 は object 未生成として `{ items: [] }` を `ready` 状態で採用する（scope ごとに 1 回だけ `console.warn` を出し key-scheme drift に気付けるようにする）
- その他 `!ok` / zod パース失敗は `status = 'error'`, `error_at = Date.now()` を記録し、直前の `response` / `last_fetched_at` は保持する。zod パース失敗は transient failure と区別できるよう `console.error` にスコープと URL を出す
- 取得した document は `items` / `recent_actions` / `recent_conversations` を `event_id` で dedupe したうえで `occurred_at DESC, event_id DESC` に整列して `response.items` とする
- 100 件 cap 済みの静的ドキュメントを丸取りする前提で、cursor / ページングは存在しない
- `stopPolling` 呼び出し時は in-flight history fetch も `HISTORY_STOP_ABORT_REASON` で abort し、state 更新は行わない

これにより「選択時の 1 回 fetch + poll 同期の自動更新 + retry ボタン」を単一路線で実装する。

## 9. 一覧の並び順

### 9.1 エージェント一覧

サイドバーとモバイルのボトムシート一覧は共通で、以下の優先順位でソートする。

1. `state !== 'idle'`
2. `agent_name` 昇順

状態変化中のエージェントを先頭に寄せ、観戦時の視線移動を減らす。

### 9.2 履歴

- `occurred_at` 降順
- 同一会話の連続発言は UI 上でグループ化しない

会話ログのグルーピングは将来拡張とし、初期実装は API 順をそのまま表示する。

## 10. 空状態・エラー状態

| 状態 | 表示 |
|------|------|
| snapshot 未取得 | 全画面ローディング |
| snapshot stale | 上部に `接続遅延中` バッジ |
| snapshot fetch error | stale バッジとは別に `更新の取得に失敗しました` を表示し、最後に成功した snapshot を継続表示 |
| snapshot incompatible (`schema_version !== 1`) | transient error とは分離し、`観戦 UI の更新が必要です。再読み込みしてください` のような永続エラー表示を行う。最後に成功した snapshot は継続表示してよいが、リトライで解消しないためユーザーへ再読み込みを促す導線を出す |
| サーバーアナウンスなし | `snapshot.recent_server_announcements` が空なら `サーバーアナウンスはまだありません` |
| 実施中サーバーイベントなし | `snapshot.active_server_events` が空ならサイドバーは該当セクションごと非表示、モバイルのイベントタブは empty state `実施中のサーバーイベントはありません` |
| 履歴なし | `履歴はまだありません` |
| 履歴取得失敗 (初回 fetch) | `履歴の取得に失敗しました` + 再試行ボタンを一覧領域全体で表示し、既存 items は存在しないため空 |
| history refresh 失敗 (既存 response あり) | 既存 items を表示し続けつつ、header に `更新に失敗しました` + `再試行` を inline 表示する。再試行は同じ scope で単純に `fetchHistory(scope)` を再実行する |

## 11. 認証との関係

- `AUTH_MODE=public` では `snapshot_url` と `history/*` へ通常の fetch を使用する
- `AUTH_MODE=access` では、13-ui-relay-backend.md §5.4.1 の前提を満たす direct 配備に限り、snapshot / history とも `fetch(url, { credentials: 'include' })` で取得する
- Access cookie の共有または pre-seeding を保証できない配備は成立条件未達であり、snapshot 取得先を same-origin proxy へ切り替えない
- cross-origin 配備では R2 origin 側 Access セッションが初回 fetch 前に成立していることが前提となる。CORS は `snapshot/*` と `history/*` の両 prefix を対象に構成する
- アプリ内ログイン UI は持たない
