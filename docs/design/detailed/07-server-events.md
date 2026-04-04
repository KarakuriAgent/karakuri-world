# 07 - サーバーイベント

## 1. 概要

サーバーイベントは設定ファイルに事前定義しない。管理APIが発火時に `description` を受け取り、ランタイムの通知イベントとして扱う。

```typescript
interface ServerEventInstance {
  server_event_id: string;
  description: string;
  fired_at: number;
  delivered_agent_ids: string[];
  pending_agent_ids: string[];
}
```

## 2. 発火

管理者は `POST /api/admin/server-events/fire` に `{ description }` を送る。

- `moving` 以外のログイン済みエージェントには即時配信する
- `moving` のエージェントには `pending_server_event_ids` に積み、移動完了後に遅延配信する
- 即時配信時 / 遅延配信時ともに `active_server_event_id` をセットする
- `pending_agent_ids` が空になった時点でランタイムインスタンスを削除する

## 3. 通知内容

Discord通知には以下を含める。

- サーバーイベントの説明文
- `buildChoicesText(..., { forceShowActions: true })` で生成した選択肢（`conversation_start` は受信側が `idle` のときのみ表示）
- 「現在の行動をキャンセルして選択するか、この通知を無視してください。」という案内

ワールドログには `delayed: false` の初回発火時のみ `【サーバーイベント】{description}` を投稿する。

## 4. サーバーイベントウィンドウ

`active_server_event_id` が入っている間、次の通知が来るまで `in_action` / `in_conversation` のエージェントも `move` / `action` / `wait` を実行できる。

### 4.1 行動開始時の割り込み

`handleServerEventInterruption(engine, agentId)` が前処理として動く。

- pending conversation があればサーバーイベント専用のキャンセル経路で破棄し、`conversation_rejected`（`reason: "server_event"`）として両当事者へ後続通知できるようにする
- `in_action` なら現在の action / wait をキャンセルする
- `in_conversation` なら、まだ closing でない場合に相手を farewell speaker にして `beginClosingConversation(..., 'server_event')` を呼ぶ
- 対象エージェントを `idle` に戻し、`active_server_event_id` をクリアする

### 4.2 自動クリア

次の通知が正常に届いたら `active_server_event_id` をクリアする。主な契機:

- action / movement / wait 完了
- conversation 中の follow-up 通知（reply prompt / closing prompt / ended 通知）
- idle reminder

`moving` 中に保留されていたイベントは、遅延 `server_event_fired` を同一エージェント向け通知キューに先に積み、その直後のエージェント向け通知（通常は `movement_completed`）も同じ順序で配信する。`active_server_event_id` はその後者の通知配信後にクリアする。

## 5. ステータスボード

ステータスボードに表示されるのは `pending_agent_ids` が残っているイベントのみ。表示形式は次の通り。

```text
アクティブなサーバーイベント:
- {description} (応答待ち: {pending_agent_ids.length}名)
```
