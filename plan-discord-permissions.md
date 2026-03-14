# Discordチャンネル権限の再構成

## Context

現在の権限モデルでは `#announcements`/`#world-log` が完全公開（誰でも書き込み可）で、`agents`/`admin` カテゴリは everyone に非表示。人間ユーザー・エージェントBot・管理Botの区別がロールレベルで管理されていない。

これを「全チャンネル人間は閲覧可能だが書き込みは制限」「エージェントBotは自分のチャンネルのみ」という新しい権限モデルに変更し、3つのロール（admin/human/agent）+ メンバーレベル権限で制御する。

また、現在使われていない `#announcements`、`#system-control`、`admin` カテゴリを廃止する。

既存サーバーは存在しないため、後方互換性は考慮不要。

## 新しいチャンネル構成

```
karakuri-world/
├── #world-log
└── agents/          (カテゴリ)
    ├── agent-alice
    ├── agent-bob
    └── ...
```

廃止: `#announcements`、`admin` カテゴリ、`#system-control`

## 新しい権限モデル

### ロール

| ロール | 対象 | 用途 |
|---|---|---|
| `admin` | 人間管理者（手動付与）+ World Bot（自動付与） | 全チャンネル読み書き可 |
| `human` | 一般人間（自動付与） | 全チャンネル閲覧のみ |
| `agent` | エージェントBot（自動付与） | 分類用。ロールレベル権限なし |

### チャンネル別権限

#### #world-log

| 対象 | 種別 | ViewChannel | SendMessages | ReadMessageHistory | その他Allow | その他Deny |
|---|---|---|---|---|---|---|
| `@everyone` | ロール | Deny | — | — | — | — |
| `@admin` | ロール | Allow | Allow | Allow | CreatePublicThreads, CreatePrivateThreads, SendMessagesInThreads, AddReactions | — |
| `@human` | ロール | Allow | — | Allow | — | SendMessages, CreatePublicThreads, CreatePrivateThreads, SendMessagesInThreads, AddReactions |

> **`@admin` に thread/reaction 系を明示 Allow する理由**: 人間管理者は `admin` + `human` を併用する。Discord の権限計算では同一レベル（ロール overwrite）の Deny は、別ロールの Allow がない限り Deny が優先される。`human` で Deny した権限を `admin` で Allow しないと管理者でもこれらが使えなくなる。

#### agents カテゴリ

`#world-log` と同じ overwrite 構成。

#### agent-{name} チャンネル

全 overwrite を個別に設定（カテゴリとは非同期。`permissionOverwrites` を明示した時点で Discord のカテゴリ同期は解除される）:

| 対象 | 種別 | ViewChannel | SendMessages | ReadMessageHistory | その他Allow | その他Deny |
|---|---|---|---|---|---|---|
| `@everyone` | ロール | Deny | — | — | — | — |
| `@admin` | ロール | Allow | Allow | Allow | CreatePublicThreads, CreatePrivateThreads, SendMessagesInThreads, AddReactions | — |
| `@human` | ロール | Allow | — | Allow | — | SendMessages, CreatePublicThreads, CreatePrivateThreads, SendMessagesInThreads, AddReactions |
| エージェントBot | メンバー | Allow | Allow | Allow | — | — |

## 変更対象ファイル

| ファイル | 変更内容 |
|---|---|
| `src/discord/channel-manager.ts` | チャンネル廃止、ロール追加、権限モデル変更、`StaticChannels` export |
| `src/discord/bot.ts` | GuildMembers intent追加、起動時ロール同期、guildMemberAddリスナー |
| `test/unit/discord/channel-manager.test.ts` | モック・アサーション更新 |
| `test/unit/discord/bot-roles.test.ts` | ロール同期テスト（新規ファイル） |
| `docs/design/detailed/10-discord-bot.md` | チャンネル構成・ロール定義・権限テーブル・Intent更新 |
| `docs/design/communication-layer.md` | チャンネル構成・権限モデル更新 |
| `docs/discord-setup.md` | 新ロール・Privileged Intent・権限モデル・構成更新 |
| `docs/discord-setup.ja.md` | 同上（日本語版） |

---

## Step 1: `src/discord/channel-manager.ts`

### 1a. `StaticChannels` を export し、フィールド変更

```typescript
export interface StaticChannels {
  world_log_id: string;
  agents_category_id: string;
  admin_role_id: string;
  human_role_id: string;
  agent_role_id: string;
}
```

削除: `announcements_id`, `admin_category_id`, `system_control_id`

### 1b. `ensureStaticChannels()` の変更

- `human`/`agent` ロール作成を追加（adminロールと同じパターン）
- `restrictedOverwrites` から World Bot のメンバーレベル overwrite を削除（admin ロールで代替）
- `restrictedOverwrites` の `admin` ロール overwrite に thread/reaction 系の Allow を追加:
  - `CreatePublicThreads+CreatePrivateThreads+SendMessagesInThreads+AddReactions=Allow`
- `restrictedOverwrites` に `human` ロールを追加:
  - `ViewChannel+ReadMessageHistory=Allow`
  - `SendMessages+CreatePublicThreads+CreatePrivateThreads+SendMessagesInThreads+AddReactions=Deny`
- `#announcements` 作成を削除
- `admin` カテゴリ作成を削除
- `#system-control` 作成を削除
- `#world-log` に `permissionOverwrites: restrictedOverwrites` を適用
- `worldBotId` の取得を削除（未使用になるため）

### 1c. `createAgentChannel()` の変更

- World Bot のメンバーレベル overwrite を削除（admin ロールで代替）
- `admin` ロールの overwrite に thread/reaction 系の Allow を追加
- `human` ロールの overwrite を追加（閲覧のみ、書き込み系 Deny）
- カテゴリ同期に依存せず、全 overwrite を明示的に組み立てる（現行コードと同じ方針）

---

## Step 2: `src/discord/bot.ts`

### 2a. Intent に `GatewayIntentBits.GuildMembers` を追加

### 2b. `create()` に起動時メンバーロール同期 + guildMemberAdd リスナー

**重要**: リスナーを `members.fetch()` より先に登録して取りこぼしを防ぐ。

```
1. ensureStaticChannels() → StaticChannels を取得
2. client.on('guildMemberAdd', ...) を登録  ← 先にリスナー
3. guild.members.fetch() で既存メンバーにロール同期  ← 後に同期
```

ロール同期ロジック（`syncMemberRole` ヘルパー関数として抽出）:
- 管理Bot自身 → `admin` を `add`。`human`/`agent` を `remove`
- その他 Bot (`member.user.bot`) → `agent` を `add`。`human`/`admin` を `remove`
- 人間 → `human` を `add`。`agent` を `remove`

> 不整合ロール除去の理由: `@everyone` を全面 `ViewChannel=Deny` にするため、Bot が誤って `human` を持つと全チャンネルが可視になり、人間が `human` を失うと何も見えなくなる。起動時同期で整合性を回復する。

**API呼び出し**:
- `member.roles.add(roleId)` / `member.roles.remove(roleId)` を使用
- `roles.set()` は使わない（手動付与の `admin` ロール等を消さないため）
- 既に付与/除去済みの場合は API 呼び出しをスキップ（`member.roles.cache.has()` でチェック）
- **World Bot 自身への `admin` 付与失敗は throw（fail-fast）**。World Bot の member overwrite を外したため、`admin` ロールがないと全チャンネルへのアクセスが不可能になり以後の Discord 送信が壊れる
- その他メンバーの `roles.add`/`remove` 失敗時は warn ログを出して継続（起動を止めない）

**guildMemberAdd リスナー**:
- `member.guild.id === guild.id` をチェック
- 同じ `syncMemberRole` ロジックを適用

**制限事項**: Bot 停止中に参加した人間は、次回起動時の `members.fetch()` 同期まで可視チャンネルが 0 になる。これは許容する。

### 2c. import 更新

`GuildMember` を追加、`StaticChannels` を channel-manager から import。

---

## Step 3: テスト更新

### 3a. `test/unit/discord/channel-manager.test.ts`

**`createMockGuild` の更新:**
- options に `omitHumanRole`, `omitAgentRole` を追加
- `rolesMap` に `human-role`/`agent-role` エントリを追加
- `roles.create` モックに `roleCreateCounter` を導入して一意IDを生成
- `#announcements`、`admin` カテゴリ、`#system-control` をチャンネルマップから削除

**既存テスト更新:**
- **"creates agent channels with expected permission overwrites"**: World Bot メンバー overwrite を削除、human ロール overwrite のアサーション追加、admin ロールに thread/reaction Allow を追加
- **"does not create anything when all resources exist"**: `result` を新 `StaticChannels` に合わせる
- **"auto-creates all missing resources"**: ロール作成数を1→3に、チャンネル作成数を5→2に（world-log + agents カテゴリ）
- **"creates #system-control under newly created admin category"**: テスト削除

**新規テスト追加:**
- `#world-log` 作成時に `permissionOverwrites` が設定されることの検証
- human ロールの deny に thread 系・reaction 権限が含まれることの検証
- admin ロールの allow に thread 系・reaction 権限が含まれることの検証

### 3b. `bot.ts` のユニットテスト追加（新規ファイル `test/unit/discord/bot-roles.test.ts`）

ロール自動付与ロジックをテスト:
- 起動時: 人間メンバーに `human` ロール付与
- 起動時: bot メンバーに `agent` ロール付与
- 起動時: 管理Bot自身に `admin` ロール付与
- 起動時: 既にロール付与済みのメンバーはスキップ
- 起動時: Bot が `human` を持っていたら除去する（不整合回収）
- 起動時: 人間が `agent` を持っていたら除去する（不整合回収）
- guildMemberAdd: 人間 → `human` ロール付与
- guildMemberAdd: bot → `agent` ロール付与
- guildMemberAdd: wrong guild のイベントは無視する
- World Bot 自身の admin 付与失敗時: throw して起動を中断する
- その他メンバーの roles.add 失敗時: warn ログを出して起動を継続する

---

## Step 4: 設計書の更新

### 4a. `docs/design/detailed/10-discord-bot.md`

- **§2.1 Gateway Intent**: `Guild Members` を特権Intentとして追加（`Guild Members` は不要→必要に変更）
- **§3 ロール定義**: `@human`（自動付与）と `@agent`（自動付与）を追加。自動付与の仕組み（起動時同期 + guildMemberAdd）を記述。不整合回収の説明を追加
- **§4 静的チャンネル構成**: `#announcements`、`admin` カテゴリ、`#system-control` を削除。チャンネル一覧とPermission Overwritesテーブルを更新。admin ロールに thread/reaction Allow、human ロールに thread/reaction Deny を明記
- **§5.2 動的チャンネルのPermission Overwrites**: 結果テーブルに `@human` を追加。「カテゴリからの継承」→「全 overwrite を明示的に設定」に表現を修正。World Bot メンバー overwrite を削除

### 4b. `docs/design/communication-layer.md`

- §4.1 チャンネル構成図から `#announcements`、`admin/`、`system-control` を削除
- §4.2 チャンネル権限モデルを新モデルに更新（`@human` 行を追加）

### 4c. `docs/discord-setup.md` (英語版)

- Bot の動作説明に `Guild Members` Privileged Intent が必要と追記
- Developer Portal で「Server Members Intent」を有効にする手順を追加
- 自動作成リソーステーブル: `#announcements`/`admin`カテゴリ/`#system-control` を削除、`human`/`agent` ロールを追加
- チャンネル可視性モデルを新権限モデルに更新
- ロール階層の注記を追加: World Bot のロールが `human`/`agent` より上位にある必要がある
- 制限事項を追記: Bot 停止中に参加した人間は次回起動まで可視チャンネルが 0

### 4d. `docs/discord-setup.ja.md` (日本語版)

- 4c と同内容を日本語で反映

---

## 検証方法

1. `npm test` で全テスト通過を確認
2. 実サーバーでの確認:
   - 起動時に3ロール（admin/human/agent）が自動作成されること
   - `#announcements`、`admin` カテゴリ、`#system-control` が作成されないこと
   - 既存メンバーに human/agent ロールが自動付与されること
   - 不整合ロール（Bot の human、人間の agent）が除去されること
   - 新規メンバー参加時にロールが自動付与されること
   - 人間ユーザーが全チャンネルを閲覧できるが書き込み・スレッド作成・リアクションできないこと
   - 管理者（admin + human）がスレッド作成・リアクションを含め全操作可能なこと
   - エージェントBotが自分のチャンネルのみアクセスできること
   - 管理Botが全チャンネルで読み書きできること

## 前提条件（手動作業）

- Discord Developer Portal で「Server Members Intent」を有効化する
- 管理Botに Discord の「Manage Roles」と「Manage Channels」権限があること（既に設定済み）
- World Bot の統合ロール（Discord が Bot 招待時に自動作成）が `admin`/`human`/`agent` ロールより上位にあること（ロール階層。自動作成されたロールは通常上位なので問題ないが、手動で並び替えた場合に注意）
- `admin` ロールは人間管理者にも手動で付与する
