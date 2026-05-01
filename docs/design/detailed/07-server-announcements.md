# 07 - サーバーアナウンス

## 1. 概要

サーバーアナウンスは設定ファイルに事前定義しない。管理APIが発火時に `description` を受け取り、ランタイムの通知イベントとして扱う。

```typescript
interface ServerAnnouncementInstance {
  server_announcement_id: string;
  description: string;
  fired_at: number;
  delivered_agent_ids: string[];
  pending_agent_ids: string[];
}
```

## 2. 発火

管理者は `POST /api/admin/server-announcements/fire` に `{ description }` を送る。

- `moving` 以外のログイン済みエージェントには即時配信する
- `moving` のエージェントには `pending_server_announcement_ids` に積み、移動完了後に遅延配信する
- 即時配信時 / 遅延配信時ともに `active_server_announcement_id` をセットする
- `pending_agent_ids` が空になった時点でランタイムインスタンスを削除する

## 3. 通知内容

Discord通知には以下を含める。

- サーバーアナウンスの説明文
- `buildChoicesText(..., { forceShowActions: true })` で生成した選択肢（`conversation_start` は受信側が `idle` のときのみ表示）
- 「現在の行動をキャンセルして選択するか、この通知を無視してください。」という案内

ワールドログには `delayed: false` の初回発火時のみ `【サーバーアナウンス】{description}` を投稿する。

## 4. サーバーアナウンスウィンドウ

`active_server_announcement_id` が入っている間、次の通知が来るまで `in_action` / `in_conversation` のエージェントも `move` / `action` / `use_item` / `wait` を実行できる。`use_item` は通常アイテムなら他の行動系コマンドと同じ割り込み規則に従い、`venue` 型アイテムでは状態遷移なしの `item_use_venue_rejected` 通知だけを返す。

### 4.1 行動開始時の割り込み

`handleServerAnnouncementInterruption(engine, agentId)` が前処理として動く。

- pending conversation があればサーバーアナウンス専用のキャンセル経路で破棄し、`conversation_rejected`（`reason: "server_announcement"`）として両当事者へ後続通知できるようにする
- `in_action` なら現在の action / wait / item_use をキャンセルする。`item_use` 中断時は `item_use_completed` を発行せず、開始前提のままアイテム消費も行わない
- `in_conversation` でも pending joiner（`pending_participant_agent_ids` にだけ含まれ、まだターン境界で参加未反映の joiner）の場合は、その会話から自分だけ切り離して `idle` に戻す。active な会話本体は closing に進めない
- それ以外の `in_conversation` なら、まだ closing でない場合に相手を farewell speaker にして `beginClosingConversation(..., 'server_announcement')` を呼ぶ
- 対象エージェントを `idle` に戻し、`active_server_announcement_id` をクリアする。以後は新しい `move` / `action` / `use_item` / `wait` を通常どおり開始する

### 4.2 自動クリア

次の通知が正常に届いたら `active_server_announcement_id` をクリアする。主な契機:

- action / movement / wait 完了
- `item_use_completed`
- `item_use_venue_rejected`
- conversation 中の follow-up 通知（reply prompt / closing prompt / ended 通知）
- idle reminder

`moving` 中に保留されていたイベントは、遅延 `server_announcement_fired` を同一エージェント向け通知キューに先に積み、その直後のエージェント向け通知（通常は `movement_completed`）も同じ順序で配信する。`active_server_announcement_id` はその後者の通知配信後にクリアする。

idle 状態のエージェントがサーバーアナウンス通知を見て `move` / `action` / `use_item` / `wait` を選んだ場合は、割り込み前処理の時点で `active_server_announcement_id` を消費済みとしてクリアし、そのコマンドの成否は通常の通知系列へ委ねる。したがって通常アイテム使用では `item_use_started` 中にウィンドウを保持し続けず、`venue` 型拒否では `item_use_venue_rejected` が「次の通知」として window を閉じる。
