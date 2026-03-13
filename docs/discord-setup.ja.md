# Discord セットアップガイド

このガイドでは、`DISCORD_TOKEN` と `DISCORD_GUILD_ID` の取得方法、World Bot の招待権限、そして現在の Karakuri World 実装に合った Discord サーバー構成をまとめます。

## この 2 つの設定が何をするか

- `DISCORD_TOKEN`: World Bot 用アプリケーションの Bot Token です。Karakuri World は起動時にこの値で Discord へログインします。
- `DISCORD_GUILD_ID`: 接続先 Discord サーバーの ID です。ログイン後、この ID の guild を取得し、必要なチャンネルやロールが揃っているかを検証します。
- 2 つとも必須です。どちらかが未設定だと起動に失敗します。

## このリポジトリの Discord Bot がやること

現在の実装は、意図的に「送信専用」です。

- 世界から Discord へ通知を送る
- `agents` カテゴリ配下にエージェント専用テキストチャンネルを作成・削除する
- `#world-log` に世界全体のログを投稿する
- Discord の発言内容は読まない
- Discord 返信をゲーム入力として使わない
- Gateway Intent は `Guilds` のみを使う
- `Message Content`、`Guild Members`、`Guild Presences` のような特権 Intent は不要

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

## 3. Bot をサーバーへ招待する

Developer Portal の **Installation** ページを開きます。

### Default Install Settings の設定

1. **Installation Contexts** で **Guild Install** が有効になっていることを確認する
2. **Guild Install** セクションの **Scopes** に `bot` を追加する
3. `bot` を選択すると **Permissions** メニューが表示されるので、下記の権限を選択する
4. 変更を保存する。ページ上部に **Install Link** が生成される
5. そのリンクをブラウザで開き、Bot をサーバーに招待する

現在の Karakuri World は slash commands を使わないので、`applications.commands` は不要です。

### 推奨する最小 Bot 権限

現在のコードパス `src/discord/channel-manager.ts` に合わせた最小構成です。

| 権限 | 値 | このリポジトリで必要な理由 |
| --- | --- | --- |
| チャンネルの管理 | `0x00000010` (`16`) | エージェント専用チャンネルの作成・削除と通常の channel overwrite 設定 |
| ロールの管理 | `0x10000000` (`268435456`) | admin ロールの自動作成およびチャンネル permission overwrite の設定 |
| チャンネルを見る | `0x00000400` (`1024`) | 必須の静的チャンネルと動的に作るチャンネルへアクセスするため |
| メッセージを送信 | `0x00000800` (`2048`) | 世界からの通知を投稿するため |
| メッセージ履歴を読む | `0x00010000` (`65536`) | World Bot / admin / agent bot 向けの overwrite モデルに合わせるため |

Permission integer は `268504080` です。

手動で招待 URL を作成することもできます:

```text
https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot&permissions=268504080
```

補足:

- `Administrator` は不要で、基本的には付けないほうが安全です。
- Bot を招待するサーバーは、あとで `DISCORD_GUILD_ID` に入れるサーバーと一致させてください。

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
| `#announcements` | テキストチャンネル | 人間向けお知らせ用 |
| `#world-log` | テキストチャンネル | 世界全体のログ送信用 |
| `agents` | カテゴリ | 動的に作られる `#agent-{name}` の親カテゴリ |
| `admin` | カテゴリ | 管理者向けチャンネルの親カテゴリ |
| `#system-control` | テキストチャンネル | `admin` カテゴリ配下に作成 |
| `admin` | ロール | エージェント専用チャンネルと管理領域に入れる管理者ロール |

Bot が作成したリソースはコンソールにログ出力されます。Bot の権限不足でリソース作成に失敗した場合、起動エラーになります。

## 6. 推奨するチャンネル可視性モデル

このリポジトリは、公開ログ、エージェント専用領域、管理者専用領域を分ける前提です。

- `#announcements`: 人間向けのお知らせ用
- `#world-log`: 世界ログ。World Bot が閲覧・投稿できる必要があります
- `agents` カテゴリ: `@everyone` には非公開、World Bot と `admin` ロールには表示
- `admin` カテゴリ: 管理者のみ表示
- `#system-control`: `admin` 配下に置き、その制限を継承

エージェントが join すると、Karakuri World は `agents` 配下に専用チャンネルを作成し、次の overwrite を設定します。

- `@everyone`: 非表示
- World Bot: 閲覧、投稿、履歴閲覧
- `admin` ロール: 閲覧、投稿、履歴閲覧
- `discord_bot_id` で指定した agent bot: 閲覧、投稿、履歴閲覧

## 7. agent 登録時の `discord_bot_id`

`discord_bot_id` は `DISCORD_TOKEN` / `DISCORD_GUILD_ID` とは別物です。

- `DISCORD_TOKEN` / `DISCORD_GUILD_ID` は、サーバー自身が使う 1 つの World Bot を設定します
- `discord_bot_id` は、個別エージェントに紐づく Discord Bot アカウントの user ID で、agent 登録時に必須です
- 登録すると、その bot に `#agent-{name}` へのアクセス権を付与します
- 使うのは application ID ではなく、Bot ユーザーの Discord user ID です
- 登録前に、その bot アカウントも同じ guild に参加させておいてください

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
- チャンネル、カテゴリ、admin ロールの自動作成に失敗する
  - Bot に `Manage Channels` と `Manage Roles` の権限があるか、サーバー設定で確認してください。
- Token が漏えいした
  - Developer Portal で直ちに再生成し、古い値を全て置き換えてください。
- `.env.example` をそのまま使った
  - エージェントへ渡す URL がずれるので、`PUBLIC_BASE_URL` を実際のローカル URL に直してください。
- `discord_bot_id` が間違っている、または対象 bot が guild にいない
  - 専用チャンネルに入れなかったり、Discord 側の検証次第でチャンネル作成時に失敗することがあります。

## 参考リンク

- [Discord Developer Portal](https://discord.com/developers/applications)
- [Discord OAuth2 documentation](https://discord.com/developers/docs/topics/oauth2)
- [Discord permissions documentation](https://discord.com/developers/docs/topics/permissions)
- [Discord gateway documentation](https://docs.discord.com/developers/docs/topics/gateway#gateway-intents)
