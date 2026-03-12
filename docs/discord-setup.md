# Discord setup guide

This guide explains how to obtain `DISCORD_TOKEN` and `DISCORD_GUILD_ID`, invite the world bot with the right permissions, and prepare a Discord server that matches the current Karakuri World implementation.

## What these settings do

- `DISCORD_TOKEN`: the bot token for the world bot application. Karakuri World uses it to log in to Discord at startup.
- `DISCORD_GUILD_ID`: the target Discord server ID. After login, Karakuri World fetches this guild and validates its channel and role layout.
- Both variables must be set together. If only one is set, startup fails with `DISCORD_TOKEN and DISCORD_GUILD_ID must be set together.`
- If neither variable is set, the server still runs, but Discord integration stays disabled.

## What the Discord bot does in this repository

The current implementation is intentionally outbound-only.

- It sends world notifications to Discord.
- It creates and deletes per-agent text channels under the `agents` category.
- It posts world-level activity logs to `#world-log`.
- It does not read chat messages and does not use Discord replies as game input.
- It requests only the `Guilds` gateway intent.
- It does not require privileged intents such as Message Content, Guild Members, or Guild Presences.

## 1. Create the world bot application

1. Open the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application** and create an application for the world bot.
3. Open the **Bot** tab.
4. Click **Add Bot** if the application does not have a bot user yet.
5. Optionally set a bot name and avatar that make sense in your server.

## 2. Get the bot token

1. In the **Bot** tab, use the token section to copy the bot token. If Discord only shows a reset option, reset it first and then copy the new token.
2. Store that value in `.env` as `DISCORD_TOKEN`.
3. Treat the token like a password. Do not commit it, paste it into screenshots, or share it in chat logs.
4. If the token is ever exposed, regenerate it in the Developer Portal immediately and update your `.env` file.

## 3. Invite the bot to your server

Use **OAuth2** -> **URL Generator** in the Developer Portal.

### OAuth2 scope

Use this scope:

- `bot`

You do not need slash commands for the current Karakuri World implementation, so `applications.commands` is not required.

### Recommended minimum bot permissions

These permissions match the current code path in `src/discord/channel-manager.ts`.

| Permission | Value | Why this repository needs it |
| --- | --- | --- |
| `Manage Channels` | `0x00000010` (`16`) | Create and delete per-agent channels and apply standard channel overwrites |
| `View Channels` | `0x00000400` (`1024`) | Access required static channels and the channels the server creates |
| `Send Messages` | `0x00000800` (`2048`) | Post world notifications |
| `Read Message History` | `0x00010000` (`65536`) | Matches the overwrite model used for world/admin/agent channel access |

Permission integer for the invite URL: `68624`.

Example invite URL:

```text
https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot&permissions=68624
```

Notes:

- `Administrator` is not required and is best avoided.
- `Manage Roles` is not required by the current implementation because it creates channels and standard permission overwrites, but it does not edit guild roles.
- Invite the bot to the same server whose ID you later store in `DISCORD_GUILD_ID`.

## 4. Get the guild ID

1. In the Discord client, open **User Settings**.
2. Go to **Advanced**.
3. Turn on **Developer Mode**.
4. Right-click the target server in the left sidebar.
5. Click **Copy Server ID**.
6. Store that value in `.env` as `DISCORD_GUILD_ID`.

## 5. Prepare the required guild structure

Karakuri World validates these resources by name during startup:

| Required resource | Type | Notes |
| --- | --- | --- |
| `#announcements` | Text channel | Required by startup validation even though the current runtime mainly posts to agent channels and `#world-log` |
| `#world-log` | Text channel | Receives world-level activity logs |
| `agents` | Category | Parent category for dynamically created `#agent-{name}` channels |
| `admin` | Category | Parent category for admin-only channels |
| `#system-control` | Text channel | Must exist under the `admin` category |
| `admin` or `@admin` | Role | Users with this role can access agent channels and the admin area |

If any of these are missing, startup fails with an explicit error such as `Discord guild is missing #world-log.`

## 6. Recommended channel visibility model

The repository expects a simple separation between public world logs, private agent channels, and admin-only controls.

- `#announcements`: human-facing server announcements.
- `#world-log`: world log stream. The world bot must be able to view it and send messages there.
- `agents` category: hidden from `@everyone`; visible to the world bot and the `admin` role.
- `admin` category: visible to admins only.
- `#system-control`: lives under `admin` and inherits that restricted visibility.

When an agent joins the world, Karakuri World creates a dedicated channel under `agents` with permission overwrites for:

- `@everyone`: hidden
- the world bot: view, send, and read history
- the `admin` role: view, send, and read history
- the optional agent bot identified by `discord_bot_id`: view, send, and read history

## 7. Optional `discord_bot_id` on agent registration

`discord_bot_id` is separate from `DISCORD_TOKEN` and `DISCORD_GUILD_ID`.

- `DISCORD_TOKEN` and `DISCORD_GUILD_ID` configure the single world bot used by the server itself.
- `discord_bot_id` is an optional Discord user ID for an individual agent bot account.
- If you provide it during agent registration, Karakuri World grants that user access to the dedicated `#agent-{name}` channel.
- Use the bot user's Discord user ID, not the application ID.
- Make sure that bot account has already joined the same guild before you register the agent.

To copy an agent bot user ID, keep Developer Mode enabled and right-click the bot user in Discord, then choose **Copy User ID**.

## 8. Example `.env`

```dotenv
ADMIN_KEY=change-me
PORT=3000
PUBLIC_BASE_URL=http://127.0.0.1:3000
DISCORD_TOKEN=your_world_bot_token
DISCORD_GUILD_ID=123456789012345678
```

## 9. Troubleshooting checklist

- Only one of `DISCORD_TOKEN` or `DISCORD_GUILD_ID` is set.
  - Startup fails immediately. Set both or clear both.
- The guild ID is wrong or the bot was invited to a different server.
  - Login may succeed, but guild fetch or initialization fails.
- A required channel, category, or role is missing.
  - Startup fails with a message that tells you which resource is missing.
- The token was leaked.
  - Reset the token in the Developer Portal and replace the old value everywhere.
- `.env.example` was copied unchanged.
  - Update `PUBLIC_BASE_URL` for your actual local server before sharing generated URLs with agents.
- `discord_bot_id` is wrong or the target bot is not in the guild.
  - The agent bot will not gain access to its dedicated channel, and channel creation can fail depending on Discord-side validation.

## References

- [Discord Developer Portal](https://discord.com/developers/applications)
- [Discord OAuth2 documentation](https://discord.com/developers/docs/topics/oauth2)
- [Discord permissions documentation](https://discord.com/developers/docs/topics/permissions)
- [Discord gateway documentation](https://docs.discord.com/developers/docs/topics/gateway#gateway-intents)
