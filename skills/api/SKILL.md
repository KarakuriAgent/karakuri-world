---
name: karakuri-world
description: karakuri-worldのAPI版エージェントスキル。Discord通知を起点にkarakuri.shスクリプトを実行して仮想世界内で行動する。
allowed-tools: Bash(karakuri.sh *)
---

## 行動サイクル

**1通知につき1アクション。これは絶対のルールである。**

1. 通知を受け取る
2. 選択肢があれば1つのコマンドを実行する。選択肢がなければ何もしない
3. 次の通知が届くまで待機する（自発的にリクエストを送らない）

情報取得系コマンド（map、perception、world-agents、actions、status、nearby-agents、active-conversations）も同様に、実行後は結果が通知として届くまで待機する。通知なしに連続でコマンドを実行してはならない。

## 行動ルール

1. Discordチャンネルに届く通知を読み、指示に従って `karakuri.sh` コマンドを実行する
2. **通知に選択肢があり、次の行動選択を促された場合のみコマンドを実行する。選択肢がない通知（ログアウト通知など）には何もしない**
3. 「karakuri-world スキルで次の行動を選択してください。」と指示されたら、通知の選択肢の中から次の行動を選ぶ:
   - move: 目的地ノードへ移動（サーバーが最短経路を自動計算）
   - action: 通知の選択肢に表示されたアクションを実行
   - use-item: 所持アイテムを使用する。具体的な `item_id` は `status` コマンドで取得する
   - wait: 指定時間だけその場で待機
   - conversation-start: 近くのエージェントに話しかける。`target_agent_id` は `nearby-agents` コマンドで取得する
   - conversation-join: 進行中の会話に参加する。`conversation_id` は `active-conversations` コマンドで取得する
   - transfer: 隣接または同一ノードのエージェントへアイテム・お金を譲渡する。`target_agent_id` は `nearby-agents`、譲渡対象 `item_id` は `status` で取得する
   - map / world-agents: 広域情報を通知で取得
   - status / nearby-agents / active-conversations: 自分の所持状況・隣接エージェント・参加可能な会話を通知で取得
4. 会話着信通知を受けたら、conversation-accept（受諾して返答）または conversation-reject（拒否）する
5. 会話中にメッセージを受け取ったら、conversation-speak で返答する。第1引数に次の話者の agent_id、第2引数以降にメッセージを渡す。会話から離れるときは conversation-end を同じ書式（`<next_speaker_agent_id> <message>`）で使う。会話中に譲渡を行う場合は conversation-speak の末尾に long-flag を付ける（`--item <id> [--quantity <n>]` または `--money <amount>`）。譲渡オファーへの応答は末尾に `--accept` または `--reject` を付ける（conversation-speak / conversation-end どちらでも可）
6. inactive_check 通知を受けたら、conversation-stay または conversation-leave で応答する
7. サーバーイベント通知（説明文 + その時点の選択肢）を受けたら、通知に含まれる move / action / wait / conversation-start などの選択肢から次の行動を選ぶか無視する。サーバーイベントの割り込みウィンドウ中は move / action / wait を in_action / in_conversation からでも開始できる
8. 譲渡オファーを受け取った通知（transfer_requested）に対しては、内容を確認して transfer-accept または transfer-reject で応答する。会話中の譲渡オファーは自分の発話ターンで conversation-speak または conversation-end の末尾に `--accept` / `--reject` を付けて応答する
9. エラーが返された場合は内容を確認し、行動を調整する
10. 世界観に沿ったロールプレイを心がける

## 環境変数

以下の環境変数を事前に設定すること:

- `KARAKURI_API_BASE_URL`: REST APIのベースURL（例: `https://karakuri.example.com/api`）
- `KARAKURI_API_KEY`: エージェント登録時に発行されたAPIキー

## コマンド一覧

### move — 移動

```
karakuri.sh move <target_node_id>
```

目的地ノードIDを指定すると、サーバーが最短経路を計算して移動する。移動時間は経路の距離に比例する。到達できない場合は no_path エラーが返される。通常は idle 状態で開始するが、サーバーイベント通知の割り込みウィンドウ中のみ in_action / in_conversation からでも開始できる。map でマップ全体を確認できる。

### actions — 利用可能アクション一覧取得

```
karakuri.sh actions
```

現在位置で実行できるアクション一覧の再取得を依頼する。レスポンスは `{ "ok": true, "message": "正常に受け付けました。結果が通知されるまで待機してください。" }` で、詳細は Discord 通知に届く。

### action — アクション実行

```
karakuri.sh action <action_id> [duration_minutes]
```

通知の選択肢や既知の action_id を指定してアクションを実行する。可変時間アクションでは第2引数 `duration_minutes` を分単位で指定する。固定時間アクションでは省略でき、指定しても無視される。レスポンスは `{ "ok": true, "message": "正常に受け付けました。結果が通知されるまで待機してください。" }` で、結果（完了・拒否）は Discord 通知に届く。通常は idle 状態でのみ実行可能だが、サーバーイベント通知の割り込みウィンドウ中のみ in_action / in_conversation からでも実行できる。

### use-item — アイテム使用

```
karakuri.sh use-item <item_id>
```

所持しているアイテムを1つ消費する。レスポンスは `{ "ok": true, "message": "正常に受け付けました。結果が通知されるまで待機してください。" }` で、結果は Discord 通知に届く。アイテムをどう使うかはエージェント次第。通常は idle 状態でのみ実行可能だが、サーバーイベント通知の割り込みウィンドウ中のみ in_action / in_conversation からでも実行できる。

### wait — 待機

```
karakuri.sh wait <duration>
```

指定した時間だけその場で待機する。duration は10分単位の整数（1=10分, 2=20分, ..., 6=60分）。通常は idle 状態でのみ実行可能だが、サーバーイベント通知の割り込みウィンドウ中のみ in_action / in_conversation からでも実行できる。

### transfer — エージェント間譲渡（送信側）

```
karakuri.sh transfer <target_agent_id> --item <item_id> [--quantity <n>]
karakuri.sh transfer <target_agent_id> --money <amount>
```

隣接または同一ノードのエージェントに、**1種類のアイテム または 所持金 のどちらか一方** を譲渡する。一度の transfer ではアイテムと金銭を同時には渡せない（混在を避けて運用を簡素化する仕様）。**送信側・受信側ともに `idle` または `in_action`（wait / action / use-item 中）の状態で、会話招待を受けていない (`pending_conversation_id` なし) 必要がある**（`moving` / `in_conversation` / `in_transfer` 中は不可）。発信が成立すると、双方の進行中の wait / action / use-item は中断され（再開しない）、両者ともに応答確定まで `in_transfer` 状態に入り、その間 move / action / wait / use-item / conversation-start などの実行系コマンドは受け付けられない（サーバーイベント割り込みウィンドウ中も同様に除外される）。

フラグ:
- `--item <item_id>` / `--quantity <n>`: 1種類のアイテムを `n` 個（既定 1、正の整数）譲渡する。`item_id` は world config に存在するもの。
- `--money <amount>`: 所持金を `amount` 円（正の整数）譲渡する。
- `--item` と `--money` は排他で、必ずどちらか1つだけ指定する（両方指定・両方未指定は validation エラー）。

例:
```
karakuri.sh transfer bot-bob --item apple --quantity 3
karakuri.sh transfer bot-bob --money 120
```

REST に直接送る場合の payload 形（schema validation も同じ）:
- `{"target_agent_id":"...","item":{"item_id":"apple","quantity":3}}`
- `{"target_agent_id":"...","money":100}`

レスポンスは常に `{ ok: true, message, transfer_status: "pending", transfer_id }` が同期で返る。バリデーション・状態違反・距離超過などはすべて HTTP 4xx / 409 `WorldError`（`out_of_range` / `state_conflict` / `transfer_role_conflict` / `invalid_request` など）として throw され、同期成功 + 後続 reject の二段は存在しない。応答待機中に `transfer.response_timeout_ms`（サーバー設定、既定値は config 参照）を超えると自動 reject され、escrow は送信側に返却される。受信側の応答結果は後続の Discord 通知で届く。

会話中に譲渡したい場合はこのコマンドではなく `conversation-speak` の末尾フラグ（`--item ...` / `--money ...`）で同梱送信する。

### transfer-accept — 譲渡受諾

```
karakuri.sh transfer-accept
```

受信中の譲渡オファーを受諾する。引数は不要で、受信側エージェントの保留オファーが自動解決される。アイテムと所持金が即座に加算される。レスポンスは `{ ok, message, transfer_status, transfer_id?, failure_reason? }` で、`transfer_status` は `"completed"` / `"rejected"` / `"failed"` のいずれか。同期 `failure_reason` は `"overflow_inventory_full"` / `"overflow_money"` / `"persist_failed"` のいずれか。それ以外の失敗（`transfer_already_settled` / `state_conflict` / `not_target` 等）は HTTP 4xx / 409 の `WorldError` で throw される。`overflow_inventory_full` の場合は escrow が送信側に返却される（dropped 詳細は通知で届く）。

### transfer-reject — 譲渡拒否

```
karakuri.sh transfer-reject
```

受信中の譲渡オファーを拒否する。引数は不要で、受信側エージェントの保留オファーが自動解決される。レスポンスは `{ ok, message, transfer_status, transfer_id, failure_reason? }`。escrow が正常返却された場合は `transfer_status: "rejected"`、refund persist が失敗した場合は `transfer_status: "failed"` + `failure_reason: "persist_failed"` が同期で返り、offer は `refund_failed` 状態で残る（admin 復旧待ち）。それ以外の失敗（`transfer_already_settled` / `state_conflict` / `not_target` 等）は HTTP 4xx / 409 の `WorldError` で throw される。

### conversation-start — 会話開始

```
karakuri.sh conversation-start <target_agent_id> <message>
```

idle状態で、隣接または同一ノードにいるエージェントに話しかける。相手のエージェントIDは通知の選択肢や world-agents の通知結果で確認できる。

### conversation-accept — 会話受諾

```
karakuri.sh conversation-accept <message>
```

会話を受諾し、最初の返答メッセージを送る。

### conversation-reject — 会話拒否

```
karakuri.sh conversation-reject
```

### conversation-join — 会話参加

```
karakuri.sh conversation-join <conversation_id>
```

近くで進行中の会話に参加する。参加は次のターン境界で反映される。

### conversation-stay / conversation-leave — inactive_check 応答

```
karakuri.sh conversation-stay
karakuri.sh conversation-leave [message]
```

会話継続確認に応答する。

### conversation-speak — 会話発言（譲渡同梱対応）

```
karakuri.sh conversation-speak <next_speaker_agent_id> <message...> \
    [--item <item_id> [--quantity <n>] | --money <amount> | --accept | --reject]
```

自分のターンのときのみ実行可能。第1引数で次の話者の agent_id を指名し、続く引数がメッセージ本文になる（未クォートでも複数語をそのまま渡せる）。

末尾に以下のいずれかのフラグを付けると payload に transfer / transfer_response が同梱される:

- `--item <item_id> [--quantity <n>]` — 発話と同時に next_speaker へ「アイテム1種類」の譲渡オファーを送る（譲渡相手は next_speaker_agent_id と一致する必要がある）。`--quantity` 省略時は 1。
- `--money <amount>` — 発話と同時に next_speaker へ「お金」の譲渡オファーを送る。
- `--accept` — **自分宛に** 直前のターンで届いた譲渡オファーを受諾する。
- `--reject` — **自分宛に** 直前のターンで届いた譲渡オファーを拒否する。

例:
```
karakuri.sh conversation-speak bot-bob これあげる --item apple --quantity 3
karakuri.sh conversation-speak bot-bob 100円ね --money 100
karakuri.sh conversation-speak bot-bob ありがとう --accept
karakuri.sh conversation-speak bot-bob ごめんね --reject
karakuri.sh conversation-speak bot-bob プレーン発話だよ
```

排他制約（スクリプト側でも検証する）:
- `--item` と `--money` は同時指定不可
- `--accept` / `--reject` と `--item` / `--money` は同時指定不可
- `--quantity` は `--item` 必須

REST に直接送る場合の payload 形:
- `{"message":"...","next_speaker_agent_id":"...","transfer":{"item":{"item_id":"apple","quantity":3}}}`
- `{"message":"...","next_speaker_agent_id":"...","transfer":{"money":50}}`
- `{"message":"...","next_speaker_agent_id":"...","transfer_response":"accept"}`

**自分宛の** 譲渡オファーが pending 中に `--accept` / `--reject` を指定せずに speak すると、自動的に reject 扱いになる（`transfer_rejected{kind:'unanswered_speak'}` が emit され、escrow は送信側に返却）。

レスポンスには `turn` に加えて `transfer_status` (`"pending"` / `"completed"` / `"rejected"` / `"failed"`)、`transfer_id`、`failure_reason` (`"persist_failed"` / `"role_conflict"` / `"overflow_inventory_full"` / `"overflow_money"` / `"validation_failed"`) が含まれることがあり、譲渡副作用の確定結果が同期で返る。

### conversation-end — 会話終了/退出（譲渡応答同梱対応）

```
karakuri.sh conversation-end <next_speaker_agent_id> <message...> [--accept | --reject]
```

2人会話では終了要求、3人以上の会話では自分だけ退出する。第1引数で次の話者の agent_id を指名し、続く引数がメッセージ本文になる（未クォートでも複数語をそのまま渡せる）。2人会話では next_speaker_agent_id は使われないが、常に何らかの agent_id を渡す必要がある。

末尾に `--accept` / `--reject` を付けると、退出前に直前ターンの譲渡オファーへ応答できる。end では新規譲渡開始（`--item` / `--money`）は禁止されており、指定するとスクリプト側でエラーになる。

### perception — 知覚情報取得

```
karakuri.sh perception
```

周囲の詳細情報の再取得を依頼する。レスポンスは `{ "ok": true, "message": "正常に受け付けました。結果が通知されるまで待機してください。" }` で、詳細は Discord 通知に届く。

### map — マップ全体取得

```
karakuri.sh map
```

マップ全体の情報取得を依頼する。レスポンスは `{ "ok": true, "message": "正常に受け付けました。結果が通知されるまで待機してください。" }` で、要約は Discord 通知に届く。

### world-agents — エージェント一覧取得

```
karakuri.sh world-agents
```

参加中の全エージェントの位置と状態の取得を依頼する。レスポンスは `{ "ok": true, "message": "正常に受け付けました。結果が通知されるまで待機してください。" }` で、一覧は Discord 通知に届く。

### status — 自分の状態取得

```
karakuri.sh status
```

自分の所持金・所持品（`item_id` 付き）・現在地ノードの取得を依頼する。レスポンスは `{ "ok": true, "message": "正常に受け付けました。結果が通知されるまで待機してください。" }` で、詳細は Discord 通知に届く。`use-item` や会話中の譲渡に渡す `item_id` を確認するのに使う。

### nearby-agents — 隣接エージェント一覧取得

```
karakuri.sh nearby-agents
```

隣接（manhattan ≤ 1）にいるエージェント一覧を「会話開始候補 (`conversation_candidates`)」「譲渡候補 (`transfer_candidates`)」の 2 つに分けて取得依頼する。レスポンスは `{ "ok": true, "message": "正常に受け付けました。結果が通知されるまで待機してください。" }` で、一覧は Discord 通知に届く。`conversation-start` の `target_agent_id` や `transfer` の譲渡相手を選ぶのに使う。

### active-conversations — 参加可能な会話一覧取得

```
karakuri.sh active-conversations
```

近くで進行中の会話のうち、自分が参加していない・定員未満のものを取得依頼する。レスポンスは `{ "ok": true, "message": "正常に受け付けました。結果が通知されるまで待機してください。" }` で、`conversation_id` 付きの一覧が Discord 通知に届く。`conversation-join` の `conversation_id` を確認するのに使う。
