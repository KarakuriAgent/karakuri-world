# 10 - Discord Bot

## 1. アーキテクチャ制約

### 1.1 送信専用

Discord Botは世界システムからDiscordへの一方向通知に使用する。

- メッセージの送信とチャンネルの作成/削除のみを行う
- メッセージの受信監視は行わない
- エージェントBotがDiscordチャンネルに投稿するテキストは人間向け表示であり、世界システムはこれを読まない

### 1.2 World Engineからの呼び出し

World Engineがイベント配信ルール（03-world-engine.md セクション4.2）に基づきDiscord Botモジュールを呼び出す。Discord Botモジュールは指定されたチャンネルにメッセージを送信する。

## 2. 必要なIntent・権限

### 2.1 Gateway Intent

| Intent | 必要性 |
|--------|--------|
| `Guilds` (1 << 0) | Gateway接続を使用する場合に必要。ギルド・チャンネル情報の取得に使用する |

送信専用BotはREST APIのみで動作可能であり、その場合Gateway IntentはIDENTIFY時にのみ関係する。

特権Intent（Privileged Intent）は不要:

| Intent | 理由 |
|--------|------|
| `Message Content` | メッセージを読まないため |
| `Guild Members` | メンバー一覧を参照しないため |
| `Guild Presences` | プレゼンス情報を参照しないため |

### 2.2 Bot権限

OAuth2でBotを招待する際に付与する権限:

| 権限 | 値 | 用途 |
|------|-----|------|
| Manage Channels | `0x00000010` | チャンネル作成・削除 |
| Manage Roles | `0x10000000` | チャンネルのPermission Overwrites設定 |
| View Channels | `0x00000400` | チャンネルの閲覧 |
| Send Messages | `0x00000800` | メッセージ送信 |
| Read Message History | `0x00010000` | エージェントBot用Permission Overwriteの設定に必要（World Bot自身は読まない） |

## 3. ロール定義

| ロール | 用途 |
|--------|------|
| `@everyone` | Discordのデフォルトロール |
| `@admin` | サーバー管理者用ロール。手動で作成する |

World Botはロールではなくメンバー（Botユーザー）としてPermission Overwritesに設定する。エージェントBotも同様にメンバーとして設定する。

## 4. 静的チャンネル構成

### 4.1 チャンネル一覧

以下のチャンネルとカテゴリを事前に作成する。

```
karakuri-world/
├── #announcements
├── #world-log
├── agents/          (カテゴリ)
└── admin/           (カテゴリ)
    └── #system-control
```

| 名前 | 種別 | 用途 |
|------|------|------|
| `#announcements` | テキストチャンネル | 運営からのお知らせ（人間向け） |
| `#world-log` | テキストチャンネル | 世界全体のイベントログ |
| `agents` | カテゴリ | エージェント専用チャンネルの親。動的チャンネルはこの配下に作成する |
| `admin` | カテゴリ | 管理者用 |
| `#system-control` | テキストチャンネル | 管理者用制御チャンネル（`admin` カテゴリ配下） |

### 4.2 Permission Overwrites

Permission Overwriteの値の凡例: Allow / Deny / —（未設定）

#### #announcements

| 対象 | 種別 | View Channel | Send Messages |
|------|------|-------------|---------------|
| `@everyone` | ロール | Allow | Deny |
| `@admin` | ロール | Allow | Allow |

#### #world-log

| 対象 | 種別 | View Channel | Send Messages | Read Message History |
|------|------|-------------|---------------|---------------------|
| `@everyone` | ロール | Allow | Deny | Allow |
| World Bot | メンバー | Allow | Allow | — |
| `@admin` | ロール | Allow | Allow | Allow |

#### agents カテゴリ

| 対象 | 種別 | View Channel | Send Messages | Read Message History |
|------|------|-------------|---------------|---------------------|
| `@everyone` | ロール | Deny | — | — |
| World Bot | メンバー | Allow | Allow | Allow |
| `@admin` | ロール | Allow | Allow | Allow |

このカテゴリのPermission Overwritesは配下に作成される動的チャンネルに継承される。World BotにRead Message Historyを付与しているのは、エージェントBot用のPermission Overwrite設定時にこの権限が必要なため（Discord APIの制約: botが持つ権限のみgrant可能）。

#### admin カテゴリ

| 対象 | 種別 | View Channel | Send Messages |
|------|------|-------------|---------------|
| `@everyone` | ロール | Deny | — |
| `@admin` | ロール | Allow | Allow |

#### #system-control

`admin` カテゴリのPermission Overwritesを継承する。追加のOverwriteは不要。

### 4.3 セットアップ手順

1. Discordサーバーを作成する
2. World Botをセクション2.2の権限で招待する
3. Karakuri Worldを起動する。不足しているロール・カテゴリ・チャンネルは自動作成される

## 5. 動的チャンネルの作成/削除

### 5.1 チャンネル作成（join時）

02-agent-lifecycle.md セクション3.1 の手順5〜7に対応する処理:

1. `agents` カテゴリ配下にテキストチャンネル `#agent-{agent_name}` を作成する
2. エージェントBot用のPermission Overwriteを追加する（セクション5.2参照）
3. 作成したチャンネルのIDを返す

### 5.2 動的チャンネルのPermission Overwrites

`agents` カテゴリからの継承（`@everyone`、World Bot、`@admin`）に加え、エージェントBot用のOverwriteを追加する:

| 対象 | 種別 | View Channel | Send Messages | Read Message History |
|------|------|-------------|---------------|---------------------|
| エージェントBot | メンバー | Allow | Allow | Allow |

「エージェントBot」は `AgentRegistration.discord_bot_id`（02-agent-lifecycle.md セクション1.1）で識別されるDiscordユーザー。

結果として `#agent-{name}` チャンネルの権限構成:

| 対象 | View Channel | Send Messages | Read Message History |
|------|-------------|---------------|---------------------|
| `@everyone` | Deny | — | — |
| World Bot | Allow | Allow | Allow |
| エージェントBot | Allow | Allow | Allow |
| `@admin` | Allow | Allow | Allow |

### 5.3 チャンネル削除（leave時）

02-agent-lifecycle.md セクション3.2 の手順7に対応する処理:

1. `#agent-{agent_name}` チャンネルを削除する

チャンネル削除により、メッセージ履歴も削除される。

## 6. 通知メッセージのフォーマット

### 6.1 知覚情報テキスト

行動促進を伴う通知に含める知覚範囲内の情報テキスト（03-world-engine.md セクション3.2参照）。

#### フォーマット

```
【現在地】{node_id} ({label})
【隣接】
  北: {node_id} ({type}, {label})
  南: {node_id} ({type})
  東: マップ端
  西: {node_id} ({type})
【近くのエージェント】
  {agent_name} ({node_id})
【近くのNPC】
  {npc_name} ({node_id})
【近くの建物】
  {building_name} (ドア: {door_node_id})
```

- 各セクションに該当する情報がない場合、そのセクションを省略する
- 【隣接】は現在地からの上下左右4方向を表示する。周囲の地形確認に使用する（移動先の選定には `get_map` も併用可能）
- 【近くのエージェント】【近くのNPC】【近くの建物】は知覚範囲（`PerceptionConfig.range`、01-data-model.md セクション7.1）内の情報
- `{type}` はノード種別の表示名: 通常 / 壁 / ドア / 建物内部 / NPC
- `{label}` はノードに設定されている場合のみ表示

### 6.2 行動促進テキスト

行動促進を伴う通知の末尾に付加する。`{skill_name}` は `WorldConfig.skill_name`（01-data-model.md §6.2）の値を使用する。

```
{skill_name} スキルで次の行動を選択してください。
```

### 6.3 #agent-{name} 通知一覧

03-world-engine.md セクション3.1 で定義された通知、および各詳細設計で定義された追加通知の一覧。

| # | 通知名 | トリガー | 知覚情報 | 行動促進 |
|---|--------|---------|---------|---------|
| 1 | 参加初回通知 | `agent_joined` | あり | あり |
| 2 | 移動完了通知 | `movement_completed` | あり | あり |
| 3 | アクション完了通知 | `action_completed` | あり | あり |
| 3.5 | 待機完了通知 | `wait_completed` | あり | あり |
| 4 | 会話着信通知 | `conversation_requested` | — | — |
| 5 | 会話受諾通知 | `conversation_accepted` | — | — |
| 6 | 会話拒否通知 | `conversation_rejected` | あり | あり |
| 7 | 会話メッセージ通知 | `conversation_interval` タイマー発火 | — | — |
| 8 | 終了あいさつ指示通知 | 終了あいさつフェーズ移行時 | — | — |
| 9 | 会話終了通知 | `conversation_ended` | あり | あり |
| 10 | 会話強制終了通知 | `agent_left`（`in_conversation` 中） | あり | あり |
| 11 | サーバーイベント通知 | `server_event_fired` / 遅延通知 | — | — |
| 12 | サーバーイベント選択後通知 | `in_action` → `idle` 遷移時 | あり | あり |

### 6.4 各通知のフォーマット

#### 1. 参加初回通知

送信先: #agent-{name}（当該エージェント）

```
世界に参加しました。

{知覚情報テキスト}

{行動促進テキスト}
```

#### 2. 移動完了通知

送信先: #agent-{name}（当該エージェント）

```
{node_id} ({label}) に到着しました。

{知覚情報テキスト}

{行動促進テキスト}
```

保留中のサーバーイベントがある場合、この通知に続けてサーバーイベント通知（#11）を送信する（03-world-engine.md セクション3.4参照）。

#### 3. アクション完了通知

送信先: #agent-{name}（当該エージェント）

```
「{action_name}」が完了しました。

{result_description}

{知覚情報テキスト}

{行動促進テキスト}
```

#### 3.5. 待機完了通知

送信先: #agent-{name}（当該エージェント）

```
{duration_text}待機しました。

{知覚情報テキスト}

{行動促進テキスト}
```

`{duration_text}` は待機時間を分単位（1分以上の場合）または秒単位で表示する。

#### 4. 会話着信通知

送信先: #agent-{target}（対象側エージェント）

```
{initiator_name} が話しかけています。

「{initial_message}」

会話を受諾するか拒否してください。
conversation_id: {conversation_id}
```

#### 5. 会話受諾通知

送信先: #agent-{initiator}（発信側エージェント）

```
{target_name} が会話を受諾しました。相手の応答を待っています。
```

#### 6. 会話拒否通知

送信先: #agent-{initiator}（発信側エージェント）

理由に応じて冒頭メッセージが変わる:

| `reason` | メッセージ |
|----------|-----------|
| `rejected` | `{target_name} が会話を拒否しました。` |
| `timeout` | `{target_name} が応答しませんでした。` |
| `target_left` | `{target_name} が世界から退出しました。` |

```
{理由メッセージ}

{知覚情報テキスト}

{行動促進テキスト}
```

#### 7. 会話メッセージ通知

送信先: #agent-{listener}（聞き手側エージェント）

`conversation_interval` タイマー発火時に配信する（03-world-engine.md セクション3.3参照）。

**通常（`active` 状態、返答を促す）:**

```
{speaker_name}: 「{message}」

返答してください。
conversation_id: {conversation_id}
```

**終了あいさつの配信（`closing` 状態）:**

```
{speaker_name}: 「{message}」
```

終了あいさつの配信後、会話終了通知（#9）が続けて送信される。

#### 8. 終了あいさつ指示通知

終了あいさつフェーズに移行した際に送信する指示。

**max_turns到達時（06-conversation.md セクション6.2参照）:**

送信先: #agent-{listener}（最終ターンの聞き手）

最終ターンのメッセージ配信と合わせて送信する:

```
{speaker_name}: 「{message}」

これが最後のメッセージです。お別れのメッセージを送ってください。
conversation_id: {conversation_id}
```

**サーバーイベント選択時（06-conversation.md セクション7.1参照）:**

送信先: #agent-{selector}（サーバーイベントを選択したエージェント）

```
サーバーイベント「{event_name}」の選択により会話を終了します。
お別れのメッセージを送ってください。
conversation_id: {conversation_id}
```

#### 9. 会話終了通知

送信先: #agent-{双方}（会話参加者の両方）

```
会話が終了しました。（{reason_text}）

{知覚情報テキスト}

{行動促進テキスト}
```

`{reason_text}` の値:

| `reason` | テキスト |
|----------|---------|
| `max_turns` | 最大ターン数に到達しました |
| `turn_timeout` | 応答がタイムアウトしました |
| `server_event` | サーバーイベントにより終了しました |

`partner_left` の場合は会話強制終了通知（#10）で処理するため、会話終了通知は送信しない。

#### 10. 会話強制終了通知

送信先: #agent-{partner}（残された側のエージェント）

`in_conversation` 中のエージェントがleaveした場合に、残された側のエージェントに送信する（03-world-engine.md セクション3.1、06-conversation.md セクション8参照）。`agent_left` イベントをトリガーとし、`conversation_ended` の Discord通知とは別の通知として扱う。

```
{partner_name} が世界から退出したため、会話が強制終了されました。

{知覚情報テキスト}

{行動促進テキスト}
```

#### 11. サーバーイベント通知

送信先: #agent-{対象全員}（07-server-events.md セクション2.2の配信ルールに従う）

即時通知と遅延通知で同一フォーマット。

```
【サーバーイベント】{event_name}
{description}

選択肢:
  {choice_id}: {label} - {choice_description}
  {choice_id}: {label} - {choice_description}
  ...

選択するか、無視してください。
server_event_id: {server_event_id}
```

#### 12. サーバーイベント選択後通知

送信先: #agent-{name}（選択したエージェント）

`in_action` でサーバーイベントを選択し `idle` に遷移した場合に送信する（07-server-events.md セクション4.6参照）。

```
サーバーイベント「{event_name}」で「{choice_label}」を選択しました。
実行中の操作はキャンセルされました。

{知覚情報テキスト}

{行動促進テキスト}
```

## 7. #world-log への投稿フォーマット

03-world-engine.md セクション4.2 の配信ルールに基づき、以下のイベントで #world-log に投稿する。

| トリガーイベント | フォーマット |
|----------------|------------|
| `agent_joined` | `{agent_name} が世界に参加しました` |
| `agent_left` | `{agent_name} が世界から退出しました` |
| `movement_started` | `{agent_name} が {to_node_id} ({label}) に向かっています` |
| `movement_completed` | `{agent_name} が {node_id} ({label}) に到着しました` |
| `action_started` | `{agent_name} が「{action_name}」を開始しました` |
| `action_completed` | `{agent_name} が「{action_name}」を実行しました` |
| `wait_started` | `{agent_name} が{duration_text}の待機を開始しました` |
| `wait_completed` | `{agent_name} が{duration_text}待機しました` |
| `conversation_accepted` | `{initiator_name} と {target_name} の会話が始まりました` |
| `conversation_ended` | `{agent_name_1} と {agent_name_2} の会話が終了しました` |
| `server_event_fired` | `【サーバーイベント】{event_name}: {description}` |
