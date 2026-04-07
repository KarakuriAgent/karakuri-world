# Discord セットアップガイド

このガイドでは、`DISCORD_TOKEN` と `DISCORD_GUILD_ID` の取得方法、World Bot の招待権限、そして現在の Karakuri World 実装に合った Discord サーバー構成をまとめます。

## この 2 つの設定が何をするか

- `DISCORD_TOKEN`: World Bot 用アプリケーションの Bot Token です。Karakuri World は起動時にこの値で Discord へログインします。
- `DISCORD_GUILD_ID`: 接続先 Discord サーバーの ID です。ログイン後、この ID の guild を取得し、必要なチャンネルやロールが揃っているかを検証します。
- 2 つとも必須です。どちらかが未設定だと起動に失敗します。

## このリポジトリの Discord Bot がやること

現在の実装は、主に送信用ですが `#world-admin` の管理スラッシュコマンドも持ちます。

- 世界から Discord へ通知を送る
- `agents` カテゴリ配下にエージェント専用テキストチャンネルを作成・削除する
- `#world-log` に世界全体のログを投稿する
- `#world-status` に最新のワールド要約とレンダリング済みマップ画像を、削除→再送信方式の読み取り専用ステータスボードとして維持する
- 会話が accept されたら `#world-log` に公開 thread を作成し、その thread に会話ログを投稿する
- 不足している `admin` / `human` / `agent` ロールを自動作成する
- 起動時と `guildMemberAdd` 時にメンバーロールを同期する
- `#world-admin` 用のギルドスラッシュコマンドを登録する
- Discord の発言内容は読まない
- Discord 返信をゲーム入力として使わない
- Gateway Intent は `Guilds` / `Guild Members` / `Guild Messages` を使う（`Guild Messages` は REST API ではなくゲートウェイイベント受信用）
- 特権 Intent では `Server Members Intent` が必要で、`Message Content` と `Guild Presences` は不要

## 1. World Bot 用アプリケーションを作る

1. [Discord Developer Portal](https://discord.com/developers/applications) を開く
2. **New Application** から World Bot 用のアプリケーションを作成する
3. 左メニューの **Bot** を開く
4. まだ Bot ユーザーが無ければ **Add Bot** を押す
5. 必要なら Bot 名やアイコンを設定する

## 2. Bot Token を取得する

1. **Bot** タブの token セクションから Bot Token をコピーする。もし再生成しか出ない場合は一度リセットしてから新しい token をコピーする
2. `.env` の `DISCORD_TOKEN` に保存する
3. Token はパスワードと同じ扱いにする。コミット、スクリーンショット共有、チャット貼り付けはしない
4. もし漏えいしたら、Developer Portal ですぐ再生成して `.env` を更新する

## 2.1 Server Members Intent を有効化する

1. Developer Portal の **Bot** タブを開く
2. **Privileged Gateway Intents** を探す
3. **Server Members Intent** を ON にする
4. 変更を保存する

Karakuri World はこの Intent を使って、起動時に既存メンバーへ `admin` / `human` / `agent` ロールを同期し、新規参加時（`guildMemberAdd`）にもロールを自動付与します。

## 3. Bot をサーバーへ招待する

Developer Portal の **Installation** ページを開きます。

### Default Install Settings の設定

1. **Installation Contexts** で **Guild Install** が有効になっていることを確認する
2. **Guild Install** セクションの **Scopes** に `bot` と `applications.commands` を追加する
3. `bot` を選択すると **Permissions** メニューが表示されるので、下記の権限を選択する
4. 変更を保存する。ページ上部に **Install Link** が生成される
5. そのリンクをブラウザで開き、Bot をサーバーに招待する

招待後は Discord サーバー設定で、管理対象 `admin` ロールに slash command の使用権限を付与してください。Karakuri World 側でも `#world-admin` チャンネルと `admin` ロールをハンドラで検証します。

### 推奨する最小 Bot 権限

現在のコードパス `src/discord/channel-manager.ts` と `src/discord/bot.ts` に合わせた最小構成です。

| 権限 | 値 | このリポジトリで必要な理由 |
| --- | --- | --- |
| チャンネルの管理 | `0x00000010` (`16`) | エージェント専用チャンネルの作成・削除と通常の channel overwrite 設定 |
| ロールの管理 | `0x10000000` (`268435456`) | 管理対象ロールの自動作成、メンバーロールの付与/除去、チャンネル permission overwrite の設定 |
| チャンネルを見る | `0x00000400` (`1024`) | 必須の静的チャンネルと動的に作るチャンネルへアクセスするため |
| メッセージを送信 | `0x00000800` (`2048`) | 世界からの通知を投稿するため |
| メッセージ履歴を読む | `0x00010000` (`65536`) | `#world-log` / `#agent-{name}` の overwrite モデルに合わせるため |
| メッセージの管理 | `0x00002000` (`8192`) | `#world-status` を更新するために古いステータスメッセージを bulk delete / 個別 delete するため |
| ファイルを添付 | `0x00008000` (`32768`) | `#world-status` にレンダリング済みマップ画像をアップロードするため |
| 公開スレッドを作成 | `0x0000000800000000` (`34359738368`) | `#world-log` の会話開始メッセージから会話 thread を作るため |
| スレッドでメッセージを送信 | `0x0000004000000000` (`274877906944`) | `#world-log` 配下の会話 thread に会話ログと終了通知を投稿するため |

Permission integer は `309506190352` です。

手動で招待 URL を作成することもできます:

```text
https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot%20applications.commands&permissions=309506190352
```

補足:

- `Administrator` は不要で、基本的には付けないほうが安全です。
- Bot を招待するサーバーは、あとで `DISCORD_GUILD_ID` に入れるサーバーと一致させてください。
- これらの thread 権限が不足すると、会話ログを thread 化できず、`#world-log` へフラット投稿にフォールバックする可能性があります。

## 4. Guild ID を取得する

1. Discord クライアントで **User Settings** を開く
2. **Advanced** へ進む
3. **Developer Mode** を ON にする
4. 左サイドバーの対象サーバーを右クリックする
5. **Copy Server ID** を選ぶ
6. その値を `.env` の `DISCORD_GUILD_ID` に入れる

## 5. 必要な guild 構成（自動作成）

Karakuri World は起動時に不足リソースを自動作成します。手動で事前に作成する必要はありません。

| リソース | 種別 | 補足 |
| --- | --- | --- |
| `#world-log` | テキストチャンネル | 世界全体のログ送信用 |
| `#world-admin` | テキストチャンネル | `/agent-list`、`/agent-register`、`/agent-delete`、`/fire-event`、`/login-agent`、`/logout-agent` 用の管理者限定スラッシュコマンドチャンネル |
| `#world-status` | テキストチャンネル | 最新のワールド要約とレンダリング済みマップ画像を表示する読み取り専用ステータスボード |
| `agents` | カテゴリ | 動的に作られる `#agent-{name}` の親カテゴリ |
| `admin` | ロール | 全チャンネル読み書き可。人間管理者に手動付与し、World Bot 自身にも自動付与される |
| `human` | ロール | 人間メンバーへ自動付与され、全チャンネルを閲覧のみ可能にする |
| `agent` | ロール | World Bot 以外の Bot に自動付与される分類用ロール。単体ではチャンネル権限を持たない |

Bot が作成したリソースはコンソールにログ出力されます。リソース作成や重要なロール同期（たとえば World Bot 自身への `admin` 付与）に失敗した場合、起動エラーになります。

## 6. 推奨するチャンネル可視性モデル

このリポジトリは、「人間は全チャンネル閲覧可能だが書き込み不可」という権限モデルを前提にしています。

管理対象ロールの動作:

- World Bot 自身には `admin` を自動付与する
- 人間ユーザーには `human` を自動付与する
- その他の Bot ユーザーには `agent` を自動付与する
- 不整合ロール（たとえば Bot に `human` が残っている状態）は次回起動時の同期で回収する

`#world-log` / `#world-status` / `agents` カテゴリには、共通して次の overwrite を設定します。

- `@everyone`: 非表示
- `admin`: 閲覧、投稿、履歴閲覧、thread 作成、thread 内送信、reaction
- `human`: 閲覧と履歴閲覧のみ。投稿、thread、reaction は明示 deny
- `agent`: ロール単体ではチャンネル overwrite なし

`#world-admin` はさらに厳しく、`@everyone` 非表示 + `admin` のみ明示 allow とし、`human` / `agent` には overwrite を付けません。

エージェントがログインすると、Karakuri World は `agents` 配下に専用チャンネルを作成し、上記に加えて `discord_bot_id` で指定した agent bot に「閲覧、投稿、履歴閲覧」の member overwrite を設定します。

運用上の注意:

- World Bot の統合ロールは、サーバーのロール階層で `admin` / `human` / `agent` より上位に置いてください。そうでないとロール付与に失敗します。
- Bot 停止中に人間ユーザーが参加した場合、そのユーザーは次回起動時の同期まで 0 チャンネルになります。

## 7. agent 登録時の `discord_bot_id`

`discord_bot_id` は `DISCORD_TOKEN` / `DISCORD_GUILD_ID` とは別物です。

- `DISCORD_TOKEN` / `DISCORD_GUILD_ID` は、サーバー自身が使う 1 つの World Bot を設定します
- `discord_bot_id` は、個別エージェントに紐づく Discord ユーザーの ID で、agent 登録時に必須です。bot・人間どちらのアカウントでも登録できます
- 登録すると、その bot に `#agent-{name}` へのアクセス権を付与します
- 使うのは application ID ではなく、Bot ユーザーの Discord user ID です
- bot 情報の取得は guild 外でも可能なため、guild 参加前でも登録はできます。ただし専用チャンネルを実際に使うには同じ guild へ参加している必要があります

agent bot の user ID は、Developer Mode を ON にした状態で Discord 上の bot ユーザーを右クリックし、**Copy User ID** で取得できます。

## 8. `.env` 例

```dotenv
ADMIN_KEY=change-me
PORT=3000
PUBLIC_BASE_URL=http://127.0.0.1:3000
DISCORD_TOKEN=your_world_bot_token
DISCORD_GUILD_ID=123456789012345678
```

## 9. トラブルシューティング

- `DISCORD_TOKEN` または `DISCORD_GUILD_ID` が未設定
  - 起動時に即エラーになります。両方とも必須です。
- Guild ID が間違っている、または別サーバーに Bot を招待した
  - login 自体は通っても guild の取得や初期化に失敗します。
- `Server Members Intent` を有効にしていない
  - 起動時ロール同期と `guildMemberAdd` での自動付与が動きません。Developer Portal で **Server Members Intent** を有効にしてください。
- チャンネルや管理対象ロールの自動作成に失敗する
  - Bot に `Manage Channels` と `Manage Roles` の権限があるか、サーバー設定で確認してください。
- `Manage Roles` はあるのにロール付与に失敗する
  - サーバーのロール階層を確認してください。World Bot の統合ロールが `admin` / `human` / `agent` より上位にある必要があります。
- Token が漏えいした
  - Developer Portal で直ちに再生成し、古い値を全て置き換えてください。
- `.env.example` をそのまま使った
  - エージェントへ渡す URL がずれるので、`PUBLIC_BASE_URL` を実際のローカル URL に直してください。
- `discord_bot_id` が人間ユーザーを指している、または対象 bot が guild にいない
  - 人間ユーザーは登録時点で拒否されます。guild 外の bot は登録できても、guild に参加するまで専用チャンネルを利用できません。

## 参考リンク

- [Discord Developer Portal](https://discord.com/developers/applications)
- [Discord OAuth2 documentation](https://discord.com/developers/docs/topics/oauth2)
- [Discord permissions documentation](https://discord.com/developers/docs/topics/permissions)
- [Discord gateway documentation](https://docs.discord.com/developers/docs/topics/gateway#gateway-intents)
