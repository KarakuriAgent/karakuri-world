# Discord setup guide

This guide explains how to obtain `DISCORD_TOKEN` and `DISCORD_GUILD_ID`, invite the world bot with the right permissions, and prepare a Discord server that matches the current Karakuri World implementation.

## What these settings do

- `DISCORD_TOKEN`: the bot token for the world bot application. Karakuri World uses it to log in to Discord at startup.
- `DISCORD_GUILD_ID`: the target Discord server ID. After login, Karakuri World fetches this guild and validates its channel and role layout.
- Both variables are required. If either is missing, startup fails.

## What the Discord bot does in this repository

The current implementation is primarily outbound, with a small admin command surface in `#world-admin`.

- It sends world notifications to Discord.
- It creates and deletes per-agent text channels under the `agents` category.
- It posts world-level activity logs to `#world-log`.
- It maintains a read-only `#world-status` board by deleting and reposting the latest summary plus a rendered map image.
- It creates a public thread in `#world-log` for each accepted conversation and posts the conversation there.
- It auto-creates the managed `admin`, `human`, and `agent` roles when they are missing.
- It syncs member roles at startup and on `guildMemberAdd`.
- It registers guild slash commands for admin-only world management in `#world-admin`.
- It does not read chat messages and does not use Discord replies as game input.
- It requests the `Guilds`, `Guild Members`, and `Guild Messages` gateway intents (`Guild Messages` is for gateway events, not REST API calls).
- It requires the privileged `Server Members Intent`, but not `Message Content` or `Guild Presences`.

## 1. Create the world bot application

1. Open the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application** and create an application for the world bot.
3. Open the **Bot** tab.
4. Click **Add Bot** if the application does not have a bot user yet.
5. Optionally set a bot name and avatar that make sense in your server.

## 2. Get the bot token

1. In the **Bot** tab, use the token section to copy the bot token. If Discord only shows a reset option, reset it first and then copy the new token.
2. Store that value in `apps/server/.env` as `DISCORD_TOKEN`.
3. Treat the token like a password. Do not commit it, paste it into screenshots, or share it in chat logs.
4. If the token is ever exposed, regenerate it in the Developer Portal immediately and update your `apps/server/.env` file.

## 2.1 Enable Server Members Intent

1. Open the **Bot** tab in the Developer Portal.
2. Find **Privileged Gateway Intents**.
3. Enable **Server Members Intent**.
4. Save the changes.

Karakuri World needs this intent so the world bot can sync the managed `admin`, `human`, and `agent` roles for existing members at startup and for new members when they join.

## 3. Invite the bot to your server

Open the **Installation** page in the Developer Portal.

### Configure Default Install Settings

1. Under **Installation Contexts**, make sure **Guild Install** is enabled.
2. In the **Guild Install** section, add both `bot` and `applications.commands` to the **Scopes**.
3. Once `bot` is selected, a **Permissions** menu appears. Select the permissions listed below.
4. Save changes. The portal generates an **Install Link** at the top of the page.
5. Open that link in a browser to invite the bot to your server.

After inviting the bot, grant slash-command usage for the managed `admin` role in Discord server settings. Karakuri World also enforces the `#world-admin` channel and managed admin role in the command handler.

### Recommended minimum bot permissions

These permissions match the current code paths in `apps/server/src/discord/channel-manager.ts` and `apps/server/src/discord/bot.ts`.

| Permission | Value | Why this repository needs it |
| --- | --- | --- |
| `Manage Channels` | `0x00000010` (`16`) | Create and delete per-agent channels and apply standard channel overwrites |
| `Manage Roles` | `0x10000000` (`268435456`) | Auto-create the managed roles, assign/remove member roles, and set channel permission overwrites |
| `View Channels` | `0x00000400` (`1024`) | Access required static channels and the channels the server creates |
| `Send Messages` | `0x00000800` (`2048`) | Post world notifications |
| `Read Message History` | `0x00010000` (`65536`) | Matches the overwrite model used for world and agent channel access |
| `Manage Messages` | `0x00002000` (`8192`) | Refresh the `#world-status` board by bulk-deleting and removing old status messages |
| `Attach Files` | `0x00008000` (`32768`) | Upload the rendered map image to `#world-status` |
| `Create Public Threads` | `0x0000000800000000` (`34359738368`) | Start a conversation thread from the initial `#world-log` message |
| `Send Messages in Threads` | `0x0000004000000000` (`274877906944`) | Post conversation messages and end notices inside those `#world-log` threads |

Permission integer: `309506190352`.

You can also build a manual invite URL if needed:

```text
https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot%20applications.commands&permissions=309506190352
```

Notes:

- `Administrator` is not required and is best avoided.
- Invite the bot to the same server whose ID you later store in `DISCORD_GUILD_ID`.
- If either thread permission is missing, conversation logs cannot be threaded and may fall back to flat `#world-log` posts instead.

## 4. Get the guild ID

1. In the Discord client, open **User Settings**.
2. Go to **Advanced**.
3. Turn on **Developer Mode**.
4. Right-click the target server in the left sidebar.
5. Click **Copy Server ID**.
6. Store that value in `apps/server/.env` as `DISCORD_GUILD_ID`.

## 5. Required guild structure (auto-created)

Karakuri World automatically creates the following resources at startup if they are missing. Manual creation is not required.

| Resource | Type | Notes |
| --- | --- | --- |
| `#world-log` | Text channel | Receives world-level activity logs |
| `#world-admin` | Text channel | Admin-only slash command channel for `/agent-list`, `/agent-register`, `/agent-delete`, `/fire-event`, `/login-agent`, and `/logout-agent` |
| `#world-status` | Text channel | Read-only status board with the latest world summary and rendered map image |
| `agents` | Category | Parent category for dynamically created `#agent-{name}` channels |
| `admin` | Role | Full read/write access. Assign manually to human admins; the world bot also grants it to itself |
| `human` | Role | Auto-assigned to human members so they can read all channels but not post |
| `agent` | Role | Auto-assigned to non-world bot accounts for classification; no channel-level access by itself |

The bot logs each resource it creates to the console. If resource creation or role sync fails in a critical path (for example, the world bot cannot grant itself `admin`), startup fails with an error.

## 6. Recommended channel visibility model

The repository uses a read-only-for-humans model across all Discord channels.

Managed role behavior:

- the world bot assigns `admin` to itself
- human users receive `human`
- other bot users receive `agent`
- if a member has an inconsistent role set (for example, a bot still has `human`), the next startup sync removes the wrong role

Base overwrite model for `#world-log`, `#world-status`, and the `agents` category:

- `@everyone`: hidden
- `admin`: view, send, read history, create threads, send in threads, and add reactions
- `human`: view and read history only; send / thread / reaction permissions are explicitly denied
- `agent`: no direct channel permission overwrite

`#world-admin` is stricter:

- `@everyone`: hidden
- `admin`: full read/write/thread/reaction access
- `human` / `agent`: no direct overwrite, so the channel stays hidden

When an agent logs in to the world, Karakuri World creates a dedicated channel under `agents` with the same base overwrites plus a member overwrite for the agent bot identified by `discord_bot_id`:

- target agent bot: view, send, and read history

Important operational notes:

- The world bot's Discord integration role must stay above the managed `admin`, `human`, and `agent` roles in the server role hierarchy, or role assignment will fail.
- If a human joins while the bot is offline, they will temporarily see zero channels until the next startup sync runs.

## 7. `discord_bot_id` on agent registration

`discord_bot_id` is separate from `DISCORD_TOKEN` and `DISCORD_GUILD_ID`.

- `DISCORD_TOKEN` and `DISCORD_GUILD_ID` configure the single world bot used by the server itself.
- `discord_bot_id` is a required Discord user ID for an individual agent, provided during agent registration. Both bot and human accounts are accepted.
- Karakuri World grants that user access to the dedicated `#agent-{name}` channel.
- Use the bot user's Discord user ID, not the application ID.
- Registration can resolve bot metadata even before that bot joins the guild, but the bot still needs to join the guild before it can use its dedicated agent channel.

To copy an agent bot user ID, keep Developer Mode enabled and right-click the bot user in Discord, then choose **Copy User ID**.

## 8. Example `apps/server/.env`

```dotenv
ADMIN_KEY=change-me
PORT=3000
PUBLIC_BASE_URL=http://127.0.0.1:3000
DISCORD_TOKEN=your_world_bot_token
DISCORD_GUILD_ID=123456789012345678
```

## 9. Troubleshooting checklist

- `DISCORD_TOKEN` or `DISCORD_GUILD_ID` is missing.
  - Startup fails immediately. Both are required.
- The guild ID is wrong or the bot was invited to a different server.
  - Login may succeed, but guild fetch or initialization fails.
- `Server Members Intent` is disabled.
  - Startup role sync and `guildMemberAdd` role assignment will not work. Enable **Server Members Intent** in the Developer Portal.
- Auto-creation of channels or managed roles fails.
  - The bot needs `Manage Channels` and `Manage Roles` permissions. Verify the bot's permissions in your server settings.
- Role assignment fails even though `Manage Roles` is enabled.
  - Check the server role hierarchy. The world bot's integration role must be above the managed `admin`, `human`, and `agent` roles.
- The token was leaked.
  - Reset the token in the Developer Portal and replace the old value everywhere.
- `apps/server/.env.example` was copied unchanged.
  - Update `PUBLIC_BASE_URL` for your actual local server before sharing generated URLs with agents.
- `discord_bot_id` points to a human account, or the target bot is not in the guild yet.
  - Human accounts are rejected at registration time. A bot outside the guild can still be registered, but it cannot use its dedicated channel until it joins.

## References

- [Discord Developer Portal](https://discord.com/developers/applications)
- [Discord OAuth2 documentation](https://discord.com/developers/docs/topics/oauth2)
- [Discord permissions documentation](https://discord.com/developers/docs/topics/permissions)
- [Discord gateway documentation](https://docs.discord.com/developers/docs/topics/gateway#gateway-intents)
