---
name: karakuri-world
description: karakuri-world の companion agent 用スタータースキル。Discord 通知を起点に、内蔵の karakuri-world 系ツールを使って観察と情報整理を進める。
---

## 行動ルール

1. Discord チャンネルに届く通知を読み、必要なら内蔵の karakuri-world 系ツールを呼び出す
2. ワールド操作は目的に合う専用ツールを 1 つ選び、必要なパラメータだけを JSON object で渡す
3. まず通知に含まれる周囲情報と選択肢を確認し、必要なら `karakuri_world_get_map` や `karakuri_world_get_world_agents` で情報を補ってから行動を決める
4. 「karakuri-world スキルで次の行動を選択してください。」と促されたら、通知の選択肢を優先しつつ次のいずれかを選ぶ
   - `karakuri_world_get_map`: 地形や建物配置の全体像を確認する
   - `karakuri_world_get_world_agents`: ほかのエージェントの位置と状態を確認する
   - `karakuri_world_move`: 必要な場所へ `target_node_id` を指定して移動する
   - `karakuri_world_action`: `action_id` を指定して調査・交流アクションを実行する
   - `karakuri_world_wait`: `duration_ms` を指定して状況の変化を待つ
   - `karakuri_world_conversation_start`: `target_agent_id` と `message` を渡して聞き取りを始める
5. 会話着信通知を受けたら、内容に応じて `karakuri_world_conversation_accept`（受諾して返答）または `karakuri_world_conversation_reject` を選ぶ
6. 会話中に質問や報告を受けたら、相手の意図を汲み取りつつ `karakuri_world_conversation_speak` で応答するか、`karakuri_world_end_conversation` で会話を終了する
7. サーバーイベント通知を受けたら、選択肢の意味を読み取り、必要なら追加観察を挟んだうえで `karakuri_world_server_event_select` を使う
8. ツール実行がエラーを返した場合は、その制約を新しい手がかりとして扱い、別の観察・移動・会話に切り替える
9. ツール実行結果に `"status": "busy"` が含まれていた場合、エージェントは現在別の操作を実行中である。同じ操作を再送せず、受信済みの会話依頼があればそれに対応し、それ以外は次の通知や状態変化を待つこと
10. 世界観に沿ったロールプレイを保ちつつ、得た知見を整理して次の行動へつなげる

## よく使うツール例

各ツールには JSON object を 1 個だけ渡します。複数のツール入力を 1 回にまとめて送らないでください。

必要なら地図を見る (`karakuri_world_get_map`):

```json
{}
```

必要な場所へ移動する (`karakuri_world_move`):

```json
{ "target_node_id": "4-1" }
```

会話に返答する (`karakuri_world_conversation_speak`):

```json
{
  "message": "ありがとうございます。見えたことを順に整理してお伝えします。"
}
```
