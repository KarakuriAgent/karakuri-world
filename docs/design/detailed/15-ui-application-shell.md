# 15 - UI アプリケーションシェル

## 1. 画面責務

### 1.1 UI 実装スタック

overview で確定した UI 側の実装基盤は以下のとおりとする。

| 領域 | 採用 | 用途 |
|------|------|------|
| SPA | React + Vite | Pages に配備する観戦クライアント |
| DOM スタイリング | Tailwind CSS | サイドバー、上部バッジ、オーバーレイ、ボトムシート |
| マップ描画 | Pixi.js / `@pixi/react` | グリッド、エージェント、ズーム操作 |
| 公開 API | Hono | Worker 側の `/api/history` ルーティング |

Pixi 領域以外の UI パーツは React + Tailwind で実装し、ブラウザ向け画面で別スタックを追加しない。

### 1.2 UI リポジトリ構成

UI システムは overview どおり別リポジトリ `karakuri-world-ui/` で管理し、少なくとも以下の構成を前提とする。

```txt
karakuri-world-ui/
├── app/            # React SPA (Vite)
├── worker/         # Hono API + Durable Object
├── wrangler.toml
└── vite.config.ts
```

`app/` は Pages 配備対象、`worker/` は Workers 配備対象とし、本体リポジトリへ UI 実装物を混在させない。詳細なレイヤー分割は 13-ui-relay-backend.md と 16-ui-map-view.md に従う。

### 1.3 画面責務

SPA は単一ルート `/` を持つ観戦専用ビューとする。表示責務は以下の 3 つに分ける。

| 領域 | 責務 |
|------|------|
| サイドバー / トップバッジ / ボトムシート | 日付・天気・サーバーイベント・エージェント一覧 |
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
  snapshot_status: 'idle' | 'loading' | 'ready' | 'error';
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

### 3.2 snapshot 適用の単調性

snapshot poll は **single-flight** を必須とする。5 秒 interval はそのまま維持するが、ある fetch が未完了の間は次の poll を同時発行しない。interval tick が重なった場合は `pollQueued = true` のようなフラグだけを立て、進行中 fetch の完了後に 1 回だけ追随 fetch を行う。

また、成功レスポンスを store へ反映する前に、現在保持中 snapshot と以下の順で比較し、**version の採用は新しいものだけ** に制限する。

1. `generated_at` が大きい
2. `generated_at` が同一なら `published_at` が大きい
3. それも同一なら同一版として idempotent に再適用可

同一版の成功レスポンスは、payload を再適用してもしなくても version 意味論は変えないが、**poll 自体は成功として扱う**。したがって直前が fetch error でも、same-version fetch が成功した時点で `snapshot_status = 'ready'`, `last_success_at = Date.now()` へ回復してよい。一方で `snapshot.generated_at` / `published_at`、そこから導かれる stale 判定、version の単調性は巻き戻さず、stale deadline も常に `snapshot.generated_at + 60000` 基準のままとする。

上記に当てはまらない遅延レスポンスは破棄し、`snapshot`, `snapshot_status`, `last_success_at`, `is_stale`, stale timer を巻き戻してはならない。これにより、R2 / CDN / ブラウザで古いレスポンスが遅れて返ってきても UI 状態は単調増加の snapshot だけを採用する。

### 3.3 stale 判定

overview に合わせ、UI の stale 判定は `generated_at` を正本とする。13-ui-relay-backend.md セクション 5.3 の heartbeat は quiet period でも `/api/snapshot` を再取得して `generated_at` 自体を進めるため、UI は `published_at` を stale 解除条件に使わない。クライアント自身の fetch 成否は別軸で扱う。

13-ui-relay-backend.md の既定値では、quiet period 中に `generated_at` が更新された snapshot が UI へ届くまでの正常系予算は以下になる。

- heartbeat refresh: 30 秒
- publish throttle: 5 秒
- CDN Edge TTL: 5 秒
- クライアント polling: 5 秒

合計 45 秒が正常系の上限となるため、これと同値の閾値ではタイマーの揺らぎやネットワークジッターで false stale が出うる。そこで UI の stale 閾値は 60 秒とし、正常系に対して 15 秒の運用バッファを残す。

以下を満たした場合に stale とみなす。

- `Date.now() - snapshot.generated_at > 60000`

`is_stale` は `snapshot.generated_at` と現在時刻から導く派生状態である。store に bool を保持してよいが、**snapshot fetch 成功時だけでなくローカル時刻の経過でも再評価され続けなければならない**。そのため UI は最新 snapshot を受け取るたびに `stale_deadline = snapshot.generated_at + 60000` を再計算し、期限到達時に `is_stale = true` へ遷移させる one-shot timer（または同等の定期 reevaluation）を必ず張り直す。fetch 失敗中もこの timer は止めない。

`last_success_at` は「最後に poll 自体が成功した時刻」の診断用であり、stale 判定を打ち消す条件には使わない。`published_at` も stale 判定には使わず、relay が最後に正常 publish できた時刻を示す補助診断値として扱う。したがって relay heartbeat により R2 配信だけが継続していても、`generated_at` が進まない snapshot は stale と判定される。

fetch 失敗は stale と別状態であり、`snapshot_status = 'error'` と `last_error_at` で管理する。stale 中も最後に取得した snapshot は表示し続ける。

## 4. snapshot ポーリング

### 4.1 取得先

- URL: 配備時に注入する `snapshot_url`（R2 カスタムドメイン + `SNAPSHOT_OBJECT_KEY` の CDN 絶対 URL。例: 既定値のままなら `https://snapshot.example.com/snapshot/latest.json`）
- 間隔: 5000ms 固定

### 4.2 取得フロー

1. 初回マウント時に即時 fetch
2. 以後 5 秒ごとに再取得するが、3.2 のとおり poll 自体は single-flight とし、重複 tick は 1 回分だけ queue する
3. fetch レスポンスは「**ステータス確認 → JSON parse → schema_version 検証**」の順で必ず妥当性を検証する。HTTP 非 2xx、parse 失敗、`schema_version !== 1` のいずれかに該当した場合は 8 と同じ失敗扱いとし、`snapshot_status = 'error'`, `last_error_at = Date.now()` を記録して既存 snapshot はそのまま残す。検証を 3.2 の version 比較より前に行い、壊れた body を `ready` で素通りさせない
4. 検証通過した成功時は 3.2 の比較規則で処理する。現在より新しい snapshot は採用し、same-version success は version を進めずに成功扱いとする。どちらも `snapshot_status = 'ready'`, `last_success_at = Date.now()` を記録する
5. 4 の成功時は、現在 store に残っている最新 snapshot に対して 3.3 の stale 条件を再評価する。新しい snapshot を採用した場合はその snapshot 用に stale timer を張り直し、same-version success の場合も stale 判定だけは回復後の現在時刻で再評価してよい。ただし stale deadline は常に当該 snapshot の `generated_at + 60000` を使い、fetch 成功時刻基準へ延長しない
6. stale timer の callback は、張り直し時点の `{ generated_at, published_at }` もしくは同等の version token を capture し、発火時に「まだ同じ snapshot が store に載っている場合だけ」`is_stale = true` を適用する。これにより古い timer が新しい snapshot 到着後に遅れて発火しても stale 表示へ巻き戻さない
7. 3.2 の比較で破棄された遅延成功レスポンスは no-op とし、`snapshot_status`, `last_success_at`, stale timer を更新しない。recover 対象になるのはあくまで「現在 store 上の snapshot と同一版」または「それより新しい版」の成功だけである
8. 失敗時は既存 snapshot を保持したまま `snapshot_status = 'error'`, `last_error_at = Date.now()` を記録する
9. 失敗時も既存 snapshot に対する stale timer / 定期 reevaluation は継続し、最後の成功 snapshot が 60 秒を超えた時点で `is_stale = true` へ遷移させる

Phase 1 の polling は常に通常の GET で行い、毎回 200 + body を受け取る前提で実装する。`If-None-Match` / 304 は本書のスコープ外であり、このフェーズでは送出・処理しない。

## 5. デスクトップレイアウト

### 5.1 ブレークポイント

- `lg` 以上（1024px 以上）をデスクトップ扱いとする

### 5.2 幅

| 領域 | 幅 |
|------|----|
| サイドバー | 320px 固定 |
| オーバーレイ | 360px 固定 |
| マップ | 残余幅 |

オーバーレイ非表示時はマップが全残余幅を使う。

### 5.3 サイドバー構成

1. ヘッダー: `calendar.display_label`, 天気, 気温
2. サーバーイベント: `snapshot.recent_server_events` の先頭 3 件（`snapshot.server_events` は active 判定用にのみ参照する）
3. エージェント一覧: `snapshot.agents` を `state !== 'idle'` を先頭、同順位は `agent_name` 昇順で表示

`snapshot.server_events` は「現在 outstanding のイベント数」や active バッジ判定に使い、固定表示する「直近のサーバーイベント」は `recent_server_events` を正本とする。これにより完了済みイベントも overview どおり一定期間表示できる。

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
| `list` | 45vh | 直近サーバーイベント + エージェント一覧 |
| `detail` | 82vh | 選択エージェント詳細 + 履歴 |

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
3. `history_cache['agent:{agent_id}']` が未取得、`status === 'error'`、または `last_fetched_at` から 30 秒以上経過していれば `/api/history?agent_id=...&limit=20` を取得
4. デスクトップはオーバーレイ開閉、モバイルは `detail` 表示へ切り替え

同じエージェントを選び直した場合でも、キャッシュが 30 秒未満なら再利用し、30 秒以上ならバックグラウンド再取得で更新する。

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
- 展開時に `history_cache['conversation:{conversation_id}']` が未取得、`status === 'error'`、または `last_fetched_at` から 30 秒以上経過していれば `/api/history?conversation_id=...&limit=50` を取得する
- 取得済みで 30 秒未満ならキャッシュ済み会話履歴をそのまま表示する
- エージェント履歴本体 (`agent:{agent_id}`) と会話詳細 (`conversation:{conversation_id}`) は別キャッシュとして保持し、相互に上書きしない

### 8.3 履歴取得アクション

履歴取得ロジックは以下の共通アクションへ寄せる。

```typescript
fetchHistory(
  scope: { agent_id: string } | { conversation_id: string },
  options?: {
    limit?: number;
    cursor?: string;
    merge?: 'replace' | 'append';
  }
): Promise<void>
```

- scope から `HistoryScopeKey` を生成する
- fetch 開始時に対応 cache entry の `status = 'loading'`（既存 `response` / `last_fetched_at` がある場合はそのまま保持）
- `options.cursor` 未指定時、または `merge === 'replace'` の場合はレスポンス全体で cache を置換する
- `options.cursor` 指定かつ `merge === 'append'` の場合は、既存 cache の `response.items` の末尾へ新規取得 `items` を連結し、`event_id` 単位で重複排除したうえで `occurred_at DESC, event_id DESC` を維持する
- append 後の `next_cursor` は最新レスポンスの `next_cursor` で上書きする
- 成功時に `response`, `last_fetched_at`, `status = 'ready'` を更新する
- 失敗時は既存 `response` / `next_cursor` / `last_fetched_at` を**変更せず**に `status = 'error'`, `error_at = Date.now()` を記録する。append fetch の途中失敗で部分結果を取り込まない（重複排除や `next_cursor` 進行が破綻しないようにする）。次回再試行は同じ `cursor` から再取得する

これにより 30 秒キャッシュ判定、再試行ボタン、会話展開の lazy fetch を単一路線で実装する。

`agent:{agent_id}` の「さらに読み込む」は `fetchHistory({ agent_id }, { limit: 20, cursor: cache.response?.next_cursor, merge: 'append' })`、`conversation:{conversation_id}` では `limit: 50` を使う。`next_cursor` がない場合は追加取得を行わない。

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
| サーバーイベントなし | `snapshot.recent_server_events` が空なら `サーバーイベントはまだありません` |
| 履歴なし | `履歴はまだありません` |
| 履歴取得失敗 | `履歴の取得に失敗しました` + 再試行ボタン |

## 11. 認証との関係

- `AUTH_MODE=public` では `snapshot_url` と `/api/history` へ通常の fetch を使用する
- `AUTH_MODE=access` では、13-ui-relay-backend.md §5.4.1 の前提を満たす direct 配備に限り snapshot を `fetch(snapshot_url, { credentials: 'include' })` で取得する
- Access cookie の共有または pre-seeding を保証できない配備は成立条件未達であり、snapshot 取得先を same-origin proxy へ切り替えない
- direct snapshot fetch を使う cross-origin 配備では backend 側の CORS 設定に加えて、R2 origin 側 Access セッションが初回 fetch 前に成立していることを前提とする
- アプリ内ログイン UI は持たない
