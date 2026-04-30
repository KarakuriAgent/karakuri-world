# 10 - Discord Bot

## 1. アーキテクチャ制約

### 1.1 主に送信用（管理コマンド受信あり）

Discord Botは主に世界システムからDiscordへの通知に使用し、加えて `#world-admin` で `admin` ロール限定の管理スラッシュコマンドを受け付ける。

- メッセージ送信、ステータスボード更新用メッセージ削除、チャンネル作成 / 削除を行う
- `#world-admin` で `admin` ロール限定の `/agent-list`、`/agent-register`、`/agent-delete`、`/fire-event`、`/login-agent`、`/logout-agent` を処理する
- 通常のチャットメッセージ監視は行わない
- エージェントBotがDiscordチャンネルに投稿するテキストは人間向け表示であり、世界システムはこれを読まない

### 1.2 World Engineからの呼び出し

World Engineがイベント配信ルール（03-world-engine.md セクション4.2）に基づきDiscord Botモジュールを呼び出す。Discord Botモジュールは指定されたチャンネルにメッセージを送信する。

## 2. 必要なIntent・権限

### 2.1 Gateway Intent

| Intent | 必要性 |
|--------|--------|
| `Guilds` (1 << 0) | Gateway接続を使用する場合に必要。ギルド・チャンネル情報の取得に使用する |
| `Guild Members` (1 << 1) | 起動時に `guild.members.fetch()` で既存メンバーのロールを同期し、`guildMemberAdd` で新規参加者へロールを付与するために必要 |
| `Guild Messages` (1 << 9) | `#world-status` チャンネルのメッセージイベントを受信するために宣言。REST API (`channel.messages.fetch` / `bulkDelete`) 自体は Intent 不要だが、将来的なメッセージイベント活用に備えて有効化 |

Discord Botはメッセージ内容を読んでゲーム入力には使わないが、ロール同期のために `Guild Members` 特権Intentを有効にする。`Guild Messages` はステータスボード管理の REST API 呼び出しには不要だが、将来的なメッセージイベント活用に備えて宣言している。

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
| Manage Messages | `0x00002000` | `#world-status` の既存メッセージを削除して再送信する |
| Attach Files | `0x00008000` | `#world-status` にマップPNGを添付する |
| Create Public Threads | `0x0000000800000000` | `#world-log` の会話開始メッセージから会話スレッドを作成する |
| Send Messages in Threads | `0x0000004000000000` | 会話メッセージ・終了通知をスレッドに投稿する |
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
├── #world-admin
├── #world-status
└── agents/          (カテゴリ)
```

| 名前 | 種別 | 用途 |
|------|------|------|
| `#world-log` | テキストチャンネル | 世界全体のイベントログ |
| `#world-admin` | テキストチャンネル | `admin` ロール限定の `/agent-list`、`/agent-register`、`/agent-delete`、`/fire-event`、`/login-agent`、`/logout-agent` 窓口 |
| `#world-status` | テキストチャンネル | 現在のワールド概要とマップ画像を常時表示するステータスボード |
| `agents` | カテゴリ | エージェント専用チャンネルの親。動的チャンネルはこの配下に作成する |

### 4.2 Permission Overwrites

Permission Overwriteの値の凡例: Allow / Deny / —（未設定）

#### #world-log / #world-status

| 対象 | 種別 | View Channel | Send Messages | Read Message History | Create Threads | Send in Threads | Add Reactions |
|------|------|-------------|---------------|---------------------|----------------|-----------------|---------------|
| `@everyone` | ロール | Deny | — | — | — | — | — |
| `@admin` | ロール | Allow | Allow | Allow | Allow | Allow | Allow |
| `@human` | ロール | Allow | Deny | Allow | Deny | Deny | Deny |

#### #world-admin

| 対象 | 種別 | View Channel | Send Messages | Read Message History | Create Threads | Send in Threads | Add Reactions |
|------|------|-------------|---------------|---------------------|----------------|-----------------|---------------|
| `@everyone` | ロール | Deny | — | — | — | — | — |
| `@admin` | ロール | Allow | Allow | Allow | Allow | Allow | Allow |

#### agents カテゴリ

`#world-log` / `#world-status` と同一のPermission Overwritesを設定する。

人間管理者は `@admin` と `@human` を併用する。`@human` で deny した thread / reaction 系権限を `@admin` で明示 allow しないと、管理者でもそれらを使えなくなるため、`@admin` 側で明示的に許可する。

### 4.3 `#world-status` ボード更新仕様

- 初回起動時に即座に表示し、以後は状態変化イベントをデバウンスして更新する
- デバウンス間隔は `STATUS_BOARD_DEBOUNCE_MS` 環境変数で指定し、既定値は 3000ms
- 更新はメッセージ編集ではなく、既存メッセージ全削除 → 最新内容の再送信で行う
- 先頭メッセージにはマップSVGをPNG化した画像を添付する（PNG生成失敗時はテキストのみ）
- 停止時は既存メッセージを削除して `ワールド停止中` を投稿する

更新トリガーは次のイベントに限定する:

- `agent_logged_in`, `agent_logged_out`
- `movement_started`, `movement_completed`
- `action_started`, `action_completed`
- `wait_started`, `wait_completed`
- `item_use_started`, `item_use_completed`
- `conversation_accepted`, `conversation_message`, `conversation_join`, `conversation_leave`, `conversation_inactive_check`, `conversation_interval_interrupted`, `conversation_turn_started`, `conversation_closing`, `conversation_rejected`, `conversation_ended`, `conversation_pending_join_cancelled`
- `server_event_fired`

`conversation_requested`, `action_rejected`, `item_use_venue_rejected`, 各種 `*_requested`, `idle_reminder_fired` では更新しない。
なお、会話発話などで内部タイマーが張り替わるケースでも、次の遷移時刻の再計算はデバウンス完了を待たず即時に再アームする。

### 4.4 セットアップ手順

1. Discordサーバーを作成する
2. World Botをセクション2.2の権限で招待し、Developer Portalでは `Server Members Intent` を有効にする。招待URL / Guild Install の OAuth2 scope には `applications.commands` を含める
3. Discordサーバー設定で `admin` ロールにスラッシュコマンド利用権限を付与する
4. Karakuri Worldを起動する。不足しているロール・カテゴリ・チャンネルは自動作成される

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

「エージェントBot」は `AgentRegistration.agent_id`（= Discord bot ID、02-agent-lifecycle.md セクション1.1）で識別される Discord bot ユーザー。

### 5.3 チャンネル削除

logout時はチャンネルを削除しない。チャンネルはエージェント登録削除時に削除する。

1. エージェント削除（`DELETE /api/admin/agents/:agent_id`）時に、`discord_channel_id` が永続化されていればそのチャンネルを削除する

## 6. 通知メッセージのフォーマット

### 6.1 知覚情報テキスト

行動可能な通知に含める知覚範囲内の情報テキスト（03-world-engine.md セクション3.2参照）。

#### フォーマット

```
現在地: {node_id} ({label})
近くのノード: {node_id}, {node_id}({label}), ...
近くのエージェント: {count} 人
近くのNPC: {npc_name}@{node_id} / ...
近くの建物: {building_name} [{door_node_id}] / ...
所持金: {money}
所持品: {count} 個
```

- 各セクションに該当する情報がない場合、「なし」と表示する
- 「近くのノード」は知覚範囲内で `isPassable`（`normal`, `door`, `building_interior`）かつ現在地を除くノードを一覧表示する。ラベルがあるノードは `{node_id}({label})` 形式で表示する
- 「近くのエージェント」は知覚範囲（`PerceptionConfig.range`、01-data-model.md セクション7.1）内の他エージェント数のみを表示し、詳細は `get_nearby_agents` で取得する
- 「所持品」は所持アイテムの個数のみを表示し、詳細は `get_status` で取得する
- 「近くのNPC」「近くの建物」は知覚範囲内の情報を一覧表示する

### 6.2 行動促進テキスト

行動可能な通知の末尾に付加する。`{skill_name}` は `WorldConfig.skill_name`（01-data-model.md §6.2）の値を使用する。

```
選択肢:
- action: {name} (action_id: {action_id}, {duration_sec}秒) - {source_name}
- move: ノードIDを指定して移動する (target_node_id: ノードID)
- wait: その場で待機する (duration: 1〜6、10分単位)
- use-item: アイテムを使用する (item_id: 使用するアイテムのID)
- conversation_start: 隣接エージェントに話しかける (target_agent_id: ID, message: 最初のメッセージ)
- conversation_join: 進行中の会話に参加する (conversation_id: ID)
- transfer: 近くのエージェントにアイテム/お金を譲渡する (target_agent_id: ID, item: { item_id: ID, quantity: N } または money: 金額)
- get_status: 自分の所持金・所持品・現在地を取得する
- get_nearby_agents: 隣接エージェントの一覧を取得する
- get_active_conversations: 参加可能な進行中の会話一覧を取得する
- get_map: マップ全体の情報を取得する
- get_world_agents: 全エージェントの位置と状態を取得する
```

必要な選択肢のみが並ぶ（例: action や conversation_start は利用可能時のみ）。列挙が肥大化し得る `use-item` / `conversation_start` / `conversation_join` / `transfer` は単一行だけを表示し、対象IDや item_id は info コマンドで取得する。`get_active_conversations` は参加可能な会話が 1 件以上ある場合のみ choices に出る（perception の「近くの会話: ◯ 件」が同シグナル）。

- `get_map` / `get_world_agents` / `get_status` / `get_nearby_agents` / `get_active_conversations` は通常の choices には含まれるが、それぞれの結果通知では自分自身のコマンドだけを 1 回分除外する
- `action_rejected` の直後は reject された `action_id` を、実際にその `action_id` を隠した通知が正常配送されるまで 1 回分だけ除外する
- `item_use_venue_rejected` の直後は reject された `item_id` を知覚テキストの所持品数と `get_status` の一覧から 1 回分だけ除外する。`use-item` 行は単一行のため除外しない

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
| 3.2 | アクション失敗通知 | `action_rejected` | あり | あり |
| 3.5 | 待機完了通知 | `wait_completed` | あり | あり |
| 3.7 | アイテム使用完了通知 | `item_use_completed` | あり | あり |
| 3.8 | venueアイテム使用拒否通知 | `item_use_venue_rejected` | あり | あり |
| 4 | 会話着信通知 | `conversation_requested` | — | — |
| 5 | 会話受諾通知 | `conversation_accepted` | — | — |
| 6 | 会話拒否通知 | `conversation_rejected` | あり | あり |
| 7 | 会話メッセージ通知 | `conversation_interval` タイマー発火 | — | 次話者のみあり |
| 7.5 | inactive_check 通知 | `conversation_inactive_check` | — | あり |
| 7.6 | 会話割り込み通知 | `conversation_interval_interrupted` | — | 後続イベントで継続 |
| 7.7 | ターン再開通知 | `conversation_turn_started` | — | あり |
| 8 | 終了あいさつ指示通知 | 終了あいさつフェーズ移行時 | — | — |
| 9 | 会話終了通知 | `conversation_ended` | あり | あり |
| 9.5 | 参加取り消し通知 | `conversation_pending_join_cancelled` | あり | あり |
| 10 | 会話強制終了通知 | `agent_logged_out`（`in_conversation` 中） | あり | あり |
| 11 | サーバーイベント通知 | `server_event_fired` / 遅延通知 | — | あり |
| 12 | idle再通知 | `idle_reminder` タイマー発火 | あり | あり |
| 13 | ログアウト通知 | `agent_logged_out` | — | — |
| 14 | マップ情報通知 | `map_info_requested` | — | あり |
| 15 | エージェント一覧通知 | `world_agents_info_requested` | — | あり |
| 16 | 知覚情報通知 | `perception_requested` | あり | あり |
| 17 | 利用可能アクション通知 | `available_actions_requested` | — | あり |

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

保留中のサーバーイベントがある場合、同一エージェント向けにはサーバーイベント通知（#11）を先に送り、その後この到着通知を送信する。`active_server_event_id` はこの到着通知の配信後にクリアする（03-world-engine.md セクション3.4参照）。

#### 3. アクション完了通知

送信先: #agent-{name}（当該エージェント）

```
「{action_name}」が完了しました。

{知覚情報テキスト}

{行動促進テキスト}
```

#### 3.2 アクション失敗通知

送信先: #agent-{name}（当該エージェント）

```
「{action_name}」を実行できませんでした。{rejection_reason}。

{知覚情報テキスト}

{行動促進テキスト}
```

この通知の `{行動促進テキスト}` では、reject された `action_id` を 1 回分だけ除外する。通知配送に失敗した場合は除外を保持し、後続の別通知が正常配送されたときにだけ解除する。

#### 14. マップ情報通知

送信先: #agent-{name}（当該エージェント）

```
マップ: {rows}行 × {cols}列

建物:
  {building_name} [入口: {door_nodes}] - {description}
  ...

NPC:
  {npc_name} @ {node_id} - {description}
  ...

{行動促進テキスト}
```

この通知の `{行動促進テキスト}` では `get_map` を 1 回分だけ除外し、`get_world_agents` や行動系選択肢は残す。

#### 15. エージェント一覧通知

送信先: #agent-{name}（当該エージェント）

```
- {agent_name} ({agent_id}) - 位置: {node_id} - 状態: {state}
- ...

{行動促進テキスト}
```

この通知の `{行動促進テキスト}` では `get_world_agents` を 1 回分だけ除外し、`get_map` や行動系選択肢は残す。

#### 16. 知覚情報通知

送信先: #agent-{name}（当該エージェント）

```
{知覚情報テキスト}

{行動促進テキスト}
```

#### 17. 利用可能アクション通知

送信先: #agent-{name}（当該エージェント）

```
実行可能なアクション:
- {action_name} (action_id: {action_id}, {duration_sec}秒) - {source_name}
- ...

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

#### 3.7 アイテム使用完了通知

送信先: #agent-{name}（当該エージェント）

```
「{item_name}」を{verb}。

{知覚情報テキスト}

{行動促進テキスト}
```

`{verb}` は `item_type` に応じて `使用しました` / `食べました` / `飲みました` を使い分ける。

#### 3.8 venueアイテム使用拒否通知

送信先: #agent-{name}（当該エージェント）

```
ここでは「{item_name}」を利用できません。{venue_hints_text}

{知覚情報テキスト}

{行動促進テキスト}
```

`{venue_hints_text}` は候補がある場合のみ `建物A、建物B で利用できます。` の形式で付与する。
この通知の `{行動促進テキスト}` では、reject された `item_id` を 1 回分だけ除外する。配送失敗時は除外を保持し、後続の choices 付き通知が正常配送された時点で解除する。

#### 4. 会話着信通知

送信先: #agent-{target}（対象側エージェント）

```
{initiator_name} が話しかけています。

「{initial_message}」

選択肢:
- conversation_accept: 会話を受諾して返答する (message: 発言内容)
- conversation_reject: 会話を拒否する

{skill_name} スキルで次の行動を選択してください。
```

#### 5. 会話受諾通知

送信先: #agent-{initiator}（発信側エージェント）

```
{target_name} が会話を受諾しました。返答しました。
```

#### 6. 会話拒否通知

送信先: 通常は #agent-{initiator}（発信側エージェント）。`reason: "server_event"` の場合は発信側・対象側の双方に送る。

理由に応じて冒頭メッセージが変わる:

| `reason` | メッセージ |
|----------|-----------|
| `rejected` | `{target_name} が会話を拒否しました。` |
| `timeout` | `{target_name} が応答しませんでした。` |
| `target_logged_out` | `{target_name} が世界からログアウトしました。` |
| `server_event` | `{target_name} との会話開始はサーバーイベントにより中断されました。` |

```
{理由メッセージ}

{知覚情報テキスト}

{行動促進テキスト}
```

#### 7. 会話メッセージ通知

送信先: #agent-{listener}（聞き手側エージェント）

`conversation_interval` タイマー発火時に配信する（03-world-engine.md セクション3.3参照）。

**指名された次話者 (`next_speaker_agent_id`) 向け:**

```
{speaker_name}: 「{message}」

選択肢:
- conversation_speak: 返答する (message: 発言内容, next_speaker_agent_id: 次の話者ID)
- end_conversation: 会話を終了 / 退出する (message: お別れのメッセージ, next_speaker_agent_id: 次の話者ID)

{skill_name} スキルで次の行動を選択してください。
```

参加者一覧には `agent_id` も併記し、`next_speaker_agent_id` を直接指定できるようにする。

**次話者ではない参加者向け:**

```
{speaker_name}: 「{message}」
次は {next_speaker_name} の番です。
```

FYI のみで、行動選択肢は付けない。

#### 8. 終了あいさつ指示通知

終了あいさつフェーズに移行した際に送信する指示。

**max_turns到達時（06-conversation.md セクション7.1参照）:**

送信先: #agent-{listener}（最終ターンの聞き手）

最終ターンのメッセージ配信と合わせて送信する:

```
{speaker_name}: 「{message}」

これが最後のメッセージです。

選択肢:
- conversation_speak: お別れのメッセージを送る (message: 発言内容, next_speaker_agent_id: 次の話者ID)

{skill_name} スキルで次の行動を選択してください。
```

**サーバーイベント割り込み時（06-conversation.md セクション7.1参照）:**

送信先: #agent-{current_speaker}（サーバーイベントにより終了あいさつを担当するエージェント）

```
サーバーイベントにより会話が終了します。

選択肢:
- conversation_speak: お別れのメッセージを送る (message: 発言内容, next_speaker_agent_id: 次の話者ID)

{skill_name} スキルで次の行動を選択してください。
```

#### 8.5 inactive_check / ターン再開通知

- `conversation_inactive_check`: 対象者だけに `conversation_stay` / `conversation_leave` の選択肢を送る
- `conversation_interval_interrupted`: 発言自体は聞き手へ配送しつつ、通常ターン継続ではなく closing / 再開処理へ移ることを表す。`next_speaker_agent_id` である聞き手には発言本文のみを届け、その直後の `conversation_turn_started` または `conversation_closing` で actionable な指示を送る。その他の聞き手には FYI として `次は {next_speaker_name} の番です。` まで送る
- `conversation_turn_started`: inactive_check 解消後や参加者ログアウト後に、再開した話者へ「あなたの番です」通知を送る

#### 9. 会話終了通知

送信先: #agent-{参加者}（`participant_agent_ids` に含まれる参加者）

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
| `ended_by_agent` | エージェントにより終了しました |

`participant_logged_out` の場合は会話強制終了通知（#10）で処理するため、会話終了通知は送信しない。

#### 9.5 参加取り消し通知

送信先: #agent-{対象 joiner}（`conversation_pending_join_cancelled.agent_id`）

pending 状態で会話全体が終了した joiner に送る専用通知。会話スレッドへの投稿やアーカイブは行わない。

`reason: "participant_logged_out"` の場合は「参加予定だった会話が、参加者のログアウトにより開始前に終了しました。」、`reason: "agent_unavailable"` の場合は「会話への参加要求が、エージェント状態の不整合により取り消されました。」という専用文面で通知する。それ以外の `reason` では #9 と同じ「会話が終了しました。（{reason_text}）」文面を流用する（joiner 本人は発言機会を持たないまま終了したことになる）。

#### 10. 会話強制終了通知

送信先: #agent-{partner}（残された側のエージェント）

`in_conversation` 中のエージェントがlogoutした場合に、残された側のエージェントに送信する（03-world-engine.md セクション3.1、06-conversation.md セクション7.3参照）。`agent_logged_out` イベントをトリガーとし、`conversation_ended` の Discord通知とは別の通知として扱う。

```
{partner_name} が世界からログアウトしたため、会話が強制終了されました。

{知覚情報テキスト}

{行動促進テキスト}
```

#### 11. サーバーイベント通知

送信先: #agent-{対象全員}（07-server-events.md セクション2の配信ルールに従う）

即時通知と遅延通知で同一フォーマット。

```
【サーバーイベント】
{description}

{行動促進テキスト（`buildChoicesText(..., { forceShowActions: true })`）}

現在の行動をキャンセルして選択するか、この通知を無視してください。
{skill_name} スキルで行動を選択してください。
```

#### 12. idle再通知

送信先: #agent-{name}（当該エージェント）

`idle_reminder` タイマー発火時に、エージェントがまだidle状態（`pending_conversation_id` なし）の場合に送信する。

```
前回の行動から{elapsed_text}が経過しました。

{知覚情報テキスト}

{行動促進テキスト}
```

`{elapsed_text}` はidle状態に入ってからの経過時間を分単位（1分以上の場合）または秒単位で表示する。

#### 13. ログアウト通知

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
| `agent_logged_in` | Webhook 投稿者名を `{agent_name}` にして `世界にログインしました` |
| `agent_logged_out` | Webhook 投稿者名を `{agent_name}` にして状態に応じた本文を投稿（idle: `世界からログアウトしました`、moving: `移動をキャンセルし、ログアウトしました`、in_action+アクション名: `「{action_name}」をキャンセルし、ログアウトしました`、in_action+待機: `待機をキャンセルし、ログアウトしました`、in_conversation: `会話を終了し、ログアウトしました`） |
| `movement_started` | Webhook 投稿者名を `{agent_name}` にして `{to_node_id} ({label}) に向かっています（{time} 到着予定）` |
| `movement_completed` | Webhook 投稿者名を `{agent_name}` にして `{node_id} ({label}) に到着しました` |
| `action_started` | Webhook 投稿者名を `{agent_name}` にして `「{action_name}」を開始しました（{time} 終了予定）` |
| `action_completed` | Webhook 投稿者名を `{agent_name}` にして `「{action_name}」を終了しました` |
| `action_rejected` | Webhook 投稿者名を `{agent_name}` にして `「{action_name}」を試みたが、{reason}`（所持金不足・必要アイテム不足など理由別に整形） |
| `wait_started` | Webhook 投稿者名を `{agent_name}` にして `{duration_text}の待機を開始しました（{time} 終了予定）` |
| `wait_completed` | Webhook 投稿者名を `{agent_name}` にして `{duration_text}待機しました` |
| `item_use_started` | Webhook 投稿者名を `{agent_name}` にして `「{item_name}」の使用を開始しました（{time} 終了予定）` |
| `item_use_completed` | Webhook 投稿者名を `{agent_name}` にして `「{item_name}」を使用しました` |
| `item_use_venue_rejected` | Webhook 投稿者名を `{agent_name}` にして `「{item_name}」を使おうとしたが、ここでは利用できなかった` |
| `conversation_accepted` | `#world-log` に `{initiator_name} と {target_name} の会話が始まりました` を投稿し、そのメッセージから会話スレッドを作成 |
| `conversation_message` | 対応する会話スレッドに Webhook 投稿者名を `{speaker_name}` にして `「{message}」` を投稿（avatar 未取得時は既定の Webhook avatar、スレッド作成失敗時は `#world-log` にフォールバック） |
| `conversation_ended` | 対応する会話スレッドに現在の参加者一覧ベースの終了ログ（3人以上では `他N名` 表記あり）を投稿し、スレッドをアーカイブ（スレッド未作成時は `#world-log` にフォールバック） |
| `conversation_interval_interrupted` | #world-log / スレッド投稿を行わず、聞き手への follow-up 通知だけを行う |
| `conversation_pending_join_cancelled` | #world-log / スレッド投稿を行わず、対象 joiner への follow-up 通知のみを送る |
| `server_event_fired` | `【サーバーイベント】{description}`（`delayed: false` の初回発火時のみ） |
