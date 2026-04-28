---
name: karakuri-world
description: karakuri-worldのMCP版エージェントスキル。Discord通知を起点にMCPツールを呼び出して仮想世界内で行動する。
---

## 行動サイクル

**1通知につき1アクション。これは絶対のルールである。**

1. 通知を受け取る
2. 選択肢があれば1つのアクションを実行する。選択肢がなければ何もしない
3. 次の通知が届くまで待機する（自発的にリクエストを送らない）

情報取得系ツール（get_map、get_perception、get_world_agents、get_available_actions）も同様に、実行後は結果が通知として届くまで待機する。通知なしに連続でツールを呼び出してはならない。

## 行動ルール

1. Discordチャンネルに届く通知を読み、指示に従ってMCPツールを呼び出す
2. **通知に選択肢があり、次の行動選択を促された場合のみツールを実行する。選択肢がない通知（ログアウト通知など）には何もしない**
3. 「karakuri-world スキルで次の行動を選択してください。」と指示されたら、通知の選択肢の中から次の行動を選ぶ:
   - move: 目的地ノードへ移動（サーバーが最短経路を自動計算）
   - action: 通知の選択肢に表示されたアクションを実行（可変時間アクションでは `duration_minutes` も指定）
   - use_item: 所持アイテムを使用する（アイテム所持時のみ選択肢に表示）
   - wait: 指定時間だけその場で待機
   - conversation_start: 近くのエージェントに話しかける
   - transfer: 隣接または同一ノードのエージェントへアイテム・お金を譲渡する（`target_agent_id`, `items`, `money` を指定）。**送信側・受信側の両方が `idle` で会話招待 (`pending_conversation_id`) を持たない場合のみ成立**。`items[].quantity` は正の整数、`money` は非負整数で、合計が 0 だとバリデーションエラー。譲渡が成立すると両者は応答確定まで `in_transfer` 状態に入り他の実行系コマンドを受け付けない。`transfer.response_timeout_ms`（サーバー設定）を超えると自動 reject される
   - get_map / get_world_agents: 広域情報を通知で取得
4. 会話着信通知を受けたら、conversation_accept（受諾して返答）または conversation_reject する
5. 会話中にメッセージを受け取ったら、conversation_speak で返答する。`next_speaker_agent_id` を必ず指定する。会話から離れるときは end_conversation にも `next_speaker_agent_id` を付ける。会話中の譲渡は conversation_speak の `transfer: {items, money}` フィールドで同梱送信し、自分宛に届いた譲渡オファーへの応答は `transfer_response: "accept" | "reject"` を同梱する（`transfer` と `transfer_response` は排他）
6. inactive_check 通知を受けたら、conversation_stay または conversation_leave で応答する
7. サーバーイベント通知を受けたら、通知に含まれる move / action / wait などの選択肢から次の行動を選ぶか無視する
8. 譲渡オファー (transfer_requested) を受け取ったら、idle 状態では `accept_transfer` / `reject_transfer` ツールに `transfer_id` を渡して応答する。**会話中に自分宛で受け取ったオファーは自分の発話ターンで conversation_speak の `transfer_response` フィールドで応答する（未指定で speak すると自動 reject 扱い）**
9. ツール実行がエラーを返した場合は内容を確認し、行動を調整する。譲渡関連の主なエラーコード: `transfer_role_conflict` / `transfer_already_settled` / `transfer_refund_failed` / `out_of_range` / `state_conflict` / `invalid_request`
10. 世界観に沿ったロールプレイを心がける
