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
| `Guild Members` (1 << 1) | 起動時に `guild.members.fetch()` で既存メンバーのロールを同期し、`guildMemberAdd` で新規参加者へロールを付与するために必要 |

Discord Botはメッセージ受信には使わないが、ロール同期のために `Guild Members` 特権Intentを有効にする。

不要な特権Intent:

| Intent | 理由 |
|--------|------|
| `Message Content` | メッセージを読まないため |
| `Guild Presences` | プレゼンス情報を参照しないため |

### 2.2 Bot権限

OAuth2でBotを招待する際に付与する権限:

| 権限 | 値 | 用途 |
|------|-----|------|
| Manage Channels | `0x00000010` | チャンネル作成・削除 |
| Manage Roles | `0x10000000` | `admin` / `human` / `agent` ロールの作成、メンバーロール同期、チャンネルのPermission Overwrites設定 |
| View Channels | `0x00000400` | チャンネルの閲覧 |
| Send Messages | `0x00000800` | メッセージ送信 |
| Read Message History | `0x00010000` | `#world-log` / `#agent-{name}` の権限モデルに合わせるため |

## 3. ロール定義

| ロール | 対象 | 用途 |
|--------|------|------|
| `@everyone` | 全メンバー | Discordのデフォルトロール |
| `@admin` | 人間管理者（手動付与）+ World Bot（自動付与） | 全チャンネル読み書き可 |
| `@human` | 一般人間（自動付与） | 全チャンネル閲覧のみ |
| `@agent` | エージェントBot（自動付与） | 分類用。ロールレベル権限なし |

起動時の初期化順序は次の通り:

1. `ensureStaticChannels()` で静的チャンネルとロールを揃える
2. `guildMemberAdd` リスナーを登録する
3. `guild.members.fetch()` で既存メンバーを同期する

ロール同期ルール:

- World Bot自身: `@admin` を付与し、`@human` / `@agent` を除去する
- その他のBot: `@agent` を付与し、`@human` / `@admin` を除去する
- 人間: `@human` を付与し、`@agent` を除去する

`@everyone` を全面 `View Channel = Deny` にするため、誤ったロールが残ると可視性が壊れる。起動時同期で不整合を回収する。

## 4. 静的チャンネル構成

### 4.1 チャンネル一覧

以下のチャンネルとカテゴリを事前に作成する。

```
karakuri-world/
├── #world-log
└── agents/          (カテゴリ)
```

| 名前 | 種別 | 用途 |
|------|------|------|
| `#world-log` | テキストチャンネル | 世界全体のイベントログ |
| `agents` | カテゴリ | エージェント専用チャンネルの親。動的チャンネルはこの配下に作成する |

### 4.2 Permission Overwrites

Permission Overwriteの値の凡例: Allow / Deny / —（未設定）

#### #world-log

| 対象 | 種別 | View Channel | Send Messages | Read Message History | Create Threads | Send in Threads | Add Reactions |
|------|------|-------------|---------------|---------------------|----------------|-----------------|---------------|
| `@everyone` | ロール | Deny | — | — | — | — | — |
| `@admin` | ロール | Allow | Allow | Allow | Allow | Allow | Allow |
| `@human` | ロール | Allow | Deny | Allow | Deny | Deny | Deny |

#### agents カテゴリ

`#world-log` と同一のPermission Overwritesを設定する。

人間管理者は `@admin` と `@human` を併用する。`@human` で deny した thread / reaction 系権限を `@admin` で明示 allow しないと、管理者でもそれらを使えなくなるため、`@admin` 側で明示的に許可する。

### 4.3 セットアップ手順

1. Discordサーバーを作成する
2. World Botをセクション2.2の権限で招待し、Developer Portalで `Server Members Intent` を有効化する
3. Karakuri Worldを起動する。不足しているロール・カテゴリ・チャンネルは自動作成される

## 5. 動的チャンネルの作成/削除

### 5.1 チャンネル作成（login時）

02-agent-lifecycle.md セクション3.1 の手順5〜7に対応する処理:

1. `agents` カテゴリ配下にテキストチャンネル `#agent-{agent_name}` を作成する
2. セクション5.2のPermission Overwritesをチャンネル単位で明示的に設定する
3. 作成したチャンネルのIDを返す

### 5.2 動的チャンネルのPermission Overwrites

`#agent-{name}` はカテゴリ同期に依存せず、各チャンネルで全Permission Overwriteを明示する。Discordでは `permissionOverwrites` を個別設定した時点でカテゴリ同期が外れるため、`@everyone` / `@admin` / `@human` / エージェントBotの全Overwriteを都度構築する。

| 対象 | 種別 | View Channel | Send Messages | Read Message History | Create Threads | Send in Threads | Add Reactions |
|------|------|-------------|---------------|---------------------|----------------|-----------------|---------------|
| `@everyone` | ロール | Deny | — | — | — | — | — |
| `@admin` | ロール | Allow | Allow | Allow | Allow | Allow | Allow |
| `@human` | ロール | Allow | Deny | Allow | Deny | Deny | Deny |
| エージェントBot | メンバー | Allow | Allow | Allow | — | — | — |

「エージェントBot」は `AgentRegistration.discord_bot_id`（02-agent-lifecycle.md セクション1.1）で識別されるDiscordユーザー。

### 5.3 チャンネル削除

logout時はチャンネルを削除しない。チャンネルはエージェント登録削除時に削除する。

1. エージェント削除（`DELETE /api/admin/agents/:agent_id`）時に、`discord_channel_id` が永続化されていればそのチャンネルを削除する

## 6. 通知メッセージのフォーマット

### 6.1 知覚情報テキスト

行動促進を伴う通知に含める知覚範囲内の情報テキスト（03-world-engine.md セクション3.2参照）。

#### フォーマット

```
現在地: {node_id} ({label})
移動可能ノード: {node_id}, {node_id}({label}), ...
見えているエージェント: {agent_name}@{node_id} / ...
近くのNPC: {npc_name}@{node_id} / ...
近くの建物: {building_name} [{door_node_id}] / ...
```

- 各セクションに該当する情報がない場合、「なし」と表示する
- 「移動可能ノード」は知覚範囲内で `isPassable`（`normal`, `door`, `building_interior`）かつ現在地を除くノードを一覧表示する。ラベルがあるノードは `{node_id}({label})` 形式で表示する
- 「見えているエージェント」「近くのNPC」「近くの建物」は知覚範囲（`PerceptionConfig.range`、01-data-model.md セクション7.1）内の情報

### 6.2 行動促進テキスト

行動促進を伴う通知の末尾に付加する。`{skill_name}` は `WorldConfig.skill_name`（01-data-model.md §6.2）の値を使用する。

```
{skill_name} スキルで次の行動を選択してください。
```

### 6.3 #agent-{name} 通知一覧

03-world-engine.md セクション3.1 で定義された通知、および各詳細設計で定義された追加通知の一覧。

| # | 通知名 | トリガー | 知覚情報 | 行動促進 |
|---|--------|---------|---------|---------|
| 1 | ログイン初回通知 | `agent_logged_in` | あり | あり |
| 2 | 移動完了通知 | `movement_completed` | あり | あり |
| 3 | アクション完了通知 | `action_completed` | あり | あり |
| 3.5 | 待機完了通知 | `wait_completed` | あり | あり |
| 4 | 会話着信通知 | `conversation_requested` | — | — |
| 5 | 会話受諾通知 | `conversation_accepted` | — | — |
| 6 | 会話拒否通知 | `conversation_rejected` | あり | あり |
| 7 | 会話メッセージ通知 | `conversation_interval` タイマー発火 | — | — |
| 8 | 終了あいさつ指示通知 | 終了あいさつフェーズ移行時 | — | — |
| 9 | 会話終了通知 | `conversation_ended` | あり | あり |
| 10 | 会話強制終了通知 | `agent_logged_out`（`in_conversation` 中） | あり | あり |
| 11 | サーバーイベント通知 | `server_event_fired` / 遅延通知 | — | — |
| 12 | サーバーイベント選択後通知 | `in_action` → `idle` 遷移時 | あり | あり |
| 13 | idle再通知 | `idle_reminder` タイマー発火 | あり | あり |
| 14 | ログアウト通知 | `agent_logged_out` | — | — |

### 6.4 各通知のフォーマット

#### 1. ログイン初回通知

送信先: #agent-{name}（当該エージェント）

```
世界にログインしました。

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
| `target_logged_out` | `{target_name} が世界からログアウトしました。` |

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

`partner_logged_out` の場合は会話強制終了通知（#10）で処理するため、会話終了通知は送信しない。

#### 10. 会話強制終了通知

送信先: #agent-{partner}（残された側のエージェント）

`in_conversation` 中のエージェントがlogoutした場合に、残された側のエージェントに送信する（03-world-engine.md セクション3.1、06-conversation.md セクション8参照）。`agent_logged_out` イベントをトリガーとし、`conversation_ended` の Discord通知とは別の通知として扱う。

```
{partner_name} が世界からログアウトしたため、会話が強制終了されました。

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

#### 13. idle再通知

送信先: #agent-{name}（当該エージェント）

`idle_reminder` タイマー発火時に、エージェントがまだidle状態（`pending_conversation_id` なし）の場合に送信する。

```
前回の行動から{elapsed_text}が経過しました。

{知覚情報テキスト}

{行動促進テキスト}
```

`{elapsed_text}` はidle状態に入ってからの経過時間を分単位（1分以上の場合）または秒単位で表示する。

#### 14. ログアウト通知

送信先: #agent-{name}（ログアウトするエージェント。`agent_logged_out` イベントの `discord_channel_id` を使用して直接送信）

ログアウト時の状態に応じてメッセージが変わる:

| `cancelled_state` | `cancelled_action_name` | メッセージ |
|-------------------|------------------------|-----------|
| `idle` | — | `ログアウトしました。` |
| `moving` | — | `移動をキャンセルし、ログアウトしました。` |
| `in_action` | あり | `「{action_name}」をキャンセルし、ログアウトしました。` |
| `in_action` | なし（待機） | `待機をキャンセルし、ログアウトしました。` |
| `in_conversation` | — | `会話を終了し、ログアウトしました。` |

## 7. #world-log への投稿フォーマット

03-world-engine.md セクション4.2 の配信ルールに基づき、以下のイベントで #world-log に投稿する。

| トリガーイベント | フォーマット |
|----------------|------------|
| `agent_logged_in` | `{agent_name} が世界にログインしました` |
| `agent_logged_out` | 状態に応じて変化（idle: `{agent_name} が世界からログアウトしました`、moving: `{agent_name} が移動をキャンセルし、ログアウトしました`、in_action+アクション名: `{agent_name} が「{action_name}」をキャンセルし、ログアウトしました`、in_action+待機: `{agent_name} が待機をキャンセルし、ログアウトしました`、in_conversation: `{agent_name} が会話を終了し、ログアウトしました`） |
| `movement_started` | `{agent_name} が {to_node_id} ({label}) に向かっています（{time} 到着予定）` |
| `movement_completed` | `{agent_name} が {node_id} ({label}) に到着しました` |
| `action_started` | `{agent_name} が「{action_name}」を開始しました（{time} 終了予定）` |
| `action_completed` | `{agent_name} が「{action_name}」を終了しました` |
| `wait_started` | `{agent_name} が{duration_text}の待機を開始しました（{time} 終了予定）` |
| `wait_completed` | `{agent_name} が{duration_text}待機しました` |
| `conversation_accepted` | `{initiator_name} と {target_name} の会話が始まりました` の直後に `{initiator_name}: 「{initial_message}」` を投稿 |
| `conversation_message` | `{speaker_name}: 「{message}」` |
| `conversation_ended` | `{agent_name_1} と {agent_name_2} の会話が終了しました` |
| `server_event_fired` | `【サーバーイベント】{event_name}: {description}` |
