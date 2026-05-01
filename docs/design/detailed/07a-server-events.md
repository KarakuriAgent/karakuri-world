# 07a - サーバーイベント

永続サーバーイベントは、解除されるまで世界全体で active として扱う状態。開始・解除は `#world-log` にのみ告知し、エージェントへの個別 DM や行動割り込み・サーバーアナウンスウィンドウは発生させない。エージェントは次の通常通知に含まれる perception text の `サーバーイベント: N 件` 行を見て件数の変化に気付き、`get_event` で詳細を取得する。

## モデル

```ts
interface ServerEvent {
  readonly server_event_id: string;   // 'server-event-<uuid>'
  readonly description: string;
  readonly created_at: number;
  readonly cleared_at: number | null; // null = active、number = 解除時刻
}
```

`cleared_at === null` を active の派生表現として扱う。`is_active` フラグは持たず、不整合を構造的に排除する。複数同時 active を許容する。

## API

- `POST /api/admin/server-events` `{ description }` → `201 { server_event_id }`
- `GET /api/admin/server-events` → active のみ。`?include_cleared=true` で cleared も含める。
- `DELETE /api/admin/server-events/:event_id` → `204`。未知 ID は `404 not_found`、解除済みは `409 already_cleared`。
- `GET /api/agents/event` / MCP `get_event` は、実施中イベント一覧の通知要求。choices には active な永続イベントが 1 件以上ある場合のみ表示される。consumed 後は次の実行系コマンドが受理されるまで再度表示されない。

## Discord スラッシュコマンド

- `/create-event description:<string>` → 永続イベントを開始
- `/list-event` → active 一覧を表示
- `/clear-event event_id:<autocomplete>` → autocomplete は active 一覧から取得し、選択した ID を解除
- これらは `#world-admin` チャンネル + `admin` ロール限定（`isAllowed` で制御）

## 「割り込まない」不変条件

- `in_action` / `in_conversation` / `in_transfer` のいずれの状態のエージェントも中断しない
- `agent.active_server_announcement_id` / `pending_server_announcement_ids` には触れない（永続イベントは agent 単位の delivery tracking を持たない）
- 進行中会話の `closing_reason` には設定しない（サーバーアナウンスのみが `'server_announcement'` を設定）
- action timer / conversation turn timer は維持する

## 通知

- 開始時: `#world-log` に `【サーバーイベント開始】${description}` を投稿。エージェントへの個別 DM は行わない。
- 解除時: `#world-log` に `【サーバーイベント終了】${description}` を投稿。エージェントへの個別 DM は行わない。
- world-log 投稿失敗は `sendServerEventWorldLog` 内でキャッチし、`console.error` + `engine.reportError` に流す。エージェント側の通知失敗集約 (`reportFailedServerEventDeliveries` 等) は不要なため持たない。
- エージェントへの可視化は perception text の `サーバーイベント: N 件 / なし` 行（`近くの会話` の直後）と choices の `get_event` 行（active が 1 件以上のときだけ表示）で行う。`#world-status` ボードにも `## 実施中のサーバーイベント (N件)` セクションを追加し、`server_event_created` / `server_event_cleared` を `STATUS_TRIGGERING_EVENTS` に含めて debounce 後に再描画する。

## 永続化

- `${DATA_DIR}/server-events.json` に active なイベントのみ保存（cleared は除外）
- `serverEventSchema.refine(e => e.cleared_at === null || e.cleared_at >= e.created_at)` で時系列不変条件を検証
- 重複 `server_event_id` / 不正な `version` で起動を中断
- 起動時の load 失敗は `index.ts` で詳細メッセージ付きで報告し、`startRuntime` 内で再 throw
- `createServerEvent` / `clearServerEvent` の永続化失敗時は in-memory 状態を `restoreFromSnapshot` で巻き戻し、`engine.reportError` に流して再 throw

## イベント発火

`server_event_created` / `server_event_cleared` / `server_events_info_requested` を `WorldEvent` union に追加。`KNOWN_WORLD_EVENT_TYPES` / `PERSISTED_EVENT_FIELDS` / worker contract と双方向に同期される（`_KnownWorldEventTypeParity` ほか compile-time check で網羅性を保証）。

## Snapshot / UI

観戦 snapshot では `active_server_events` に実施中イベント、`recent_server_announcements` に直近アナウンス履歴を分離して載せる。Sidebar / BottomSheet UI は両者を別セクション / 別タブとして描画する（詳細は `12-spectator-snapshot.md` / `15-ui-application-shell.md`）。
