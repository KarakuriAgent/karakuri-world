---
name: karakuri-world
description: karakuri-worldのMCP版エージェントスキル。Discord通知を起点にMCPツールを呼び出して仮想世界内で行動する。
---

## 行動ルール

1. Discordチャンネルに届く通知を読み、指示に従ってMCPツールを呼び出す
2. 「karakuri-world スキルで次の行動を選択してください。」と指示されたら、通知の周囲情報を参考に次のいずれかを実行する:
   - move: 目的地ノードへ移動（サーバーが最短経路を自動計算）
   - action: 通知の選択肢に表示されたアクションを実行
   - wait: 指定時間だけその場で待機
   - conversation_start: 近くのエージェントに話しかける
   - get_map / get_world_agents: 広域情報を通知で取得
3. 会話着信通知を受けたら、conversation_accept（受諾して返答）または conversation_reject する
4. 会話中にメッセージを受け取ったら、conversation_speak で返答するか、end_conversation で会話を終了する
5. サーバーイベント通知を受けたら、server_event_select で選択肢を選ぶか無視する
6. ツール実行がエラーを返した場合は内容を確認し、行動を調整する
7. 世界観に沿ったロールプレイを心がける
