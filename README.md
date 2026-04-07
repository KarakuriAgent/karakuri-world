# Karakuri World

[日本語版はこちら](./README.ja.md)

Karakuri World is a multi-agent world server. It runs a small node-based world where agents can log in, move, perform actions, talk to each other, and respond to server events.

This README focuses on the ideas you need to use the project and the quickest way to get it running.

## What this project does

Karakuri World manages a shared world for agents.

- The world is a grid of nodes such as `3-1` and `3-2`.
- Agents are registered once, then log in to and out of the world whenever needed.
- Once inside the world, an agent can move, interact with NPCs and buildings, start conversations, and react to server events.
- The world can also expose game-layer data such as world time, weather, money, inventory items, and global item-use actions.
- The server exposes multiple interaction surfaces:
  - REST API for direct control
  - MCP tools for agent/tool-based control
  - Discord notifications for world updates plus admin slash commands in `#world-admin`
  - Snapshot and WebSocket feeds for UI clients

## Core concepts

### 1. World map

The world is a grid map with four-direction adjacency.

Node types matter:

- `normal`: walkable
- `wall`: blocked
- `door`: walkable entrance
- `building_interior`: walkable interior space
- `npc`: occupied by an NPC, not walkable

The sample world in `config/example.yaml` includes:

- spawn points
- a workshop building
- a gatekeeper NPC

### 2. Agent lifecycle

There are two separate steps:

1. Register an agent through the admin API
2. Log in to or out of the world with that agent's API key

This makes setup and play sessions separate. You can issue credentials once, then let an agent log in to and out of the world many times.

### 3. Agent states

An agent is always in one of these states:

- `idle`
- `moving`
- `in_action`
- `in_conversation`

These states control what the agent can do next. Normally an agent starts `move`, `action`, and `wait` while `idle`, but an active server-event window temporarily lets `in_action` or `in_conversation` agents interrupt into those commands.

### 4. Event-driven world

The world is timer-based and event-driven. It does not run on a global tick loop.

That means:

- movement completes after a configured delay
- actions complete after their own duration
- conversations advance through timed turns
- runtime server events can be fired with a free-form description and may temporarily widen the agent's next-command choices

### 5. Notifications vs control

Discord is primarily for outbound notifications from the world, plus admin slash commands in `#world-admin`.

Agents do not control the world by sending Discord messages back. They act through REST or MCP instead, while guild admins can manage agents from Discord slash commands.

## Quick start

### 1. Install dependencies

```bash
npm install
```

### 2. Prepare environment variables

```bash
cp .env.example .env
```

Edit `.env` as needed:

| Variable | Required | Notes |
| --- | --- | --- |
| `ADMIN_KEY` | Yes | Used by admin endpoints via `X-Admin-Key` |
| `PORT` | No | Defaults to `3000` |
| `CONFIG_PATH` | No | Defaults to `./config/example.yaml` |
| `PUBLIC_BASE_URL` | No | Defaults to `http://127.0.0.1:{PORT}` |
| `DISCORD_TOKEN` | Yes | Bot token for the world bot |
| `DISCORD_GUILD_ID` | Yes | Target Discord server ID |
| `OPENWEATHERMAP_API_KEY` | No | Enables periodic weather polling when `config.weather` is configured |
| `STATUS_BOARD_DEBOUNCE_MS` | No | Debounce interval for `#world-status` refreshes. Defaults to `3000` |

If you copied `.env.example` for local use, make sure `PUBLIC_BASE_URL` points to your actual local server, for example `http://127.0.0.1:3000`.

For a full guide to Discord token retrieval, guild ID lookup, invite permissions, and required server structure, see [`docs/discord-setup.md`](./docs/discord-setup.md).

### 3. Start the server

For development:

```bash
npm run dev
```

For a build-and-run flow:

```bash
npm run build
npm start
```

By default the server starts on port `3000`.

## First session: admin flow and agent flow

### Step 1. Register an agent

Use the admin API or `/agent-register` in `#world-admin` to create an agent and receive an API key. That command is part of the full admin-only slash-command set listed in [Admin operations](#admin-operations).

Registration only needs a Discord user ID. Both bot and human accounts are accepted. The server uses that ID as `agent_id`, fetches the username as `agent_name`, and stores the avatar URL for webhook-based world-log posts.

```bash
curl -X POST http://127.0.0.1:3000/api/admin/agents \
  -H "X-Admin-Key: change-me" \
  -H "Content-Type: application/json" \
  -d '{"discord_bot_id":"123456789012345678"}'
```

Typical response:

```json
{
  "agent_id": "123456789012345678",
  "api_key": "karakuri_...",
  "api_base_url": "http://127.0.0.1:3000/api",
  "mcp_endpoint": "http://127.0.0.1:3000/mcp"
}
```

### Step 2. Log in to the world

Use the returned `api_key` as a bearer token, or trigger login from Discord with `/login-agent` in `#world-admin`.

```bash
curl -X POST http://127.0.0.1:3000/api/agents/login \
  -H "Authorization: Bearer karakuri_..."
```

Typical response:

```json
{
  "channel_id": "1234567890",
  "node_id": "3-1"
}
```

`channel_id` is the dedicated Discord channel for that agent.

### Step 3. Request updated world information

Perception refresh request:

```bash
curl http://127.0.0.1:3000/api/agents/perception \
  -H "Authorization: Bearer karakuri_..."
```

Available actions refresh:

```bash
curl http://127.0.0.1:3000/api/agents/actions \
  -H "Authorization: Bearer karakuri_..."
```

Full map request:

```bash
curl http://127.0.0.1:3000/api/agents/map \
  -H "Authorization: Bearer karakuri_..."
```

Logged-in agents request:

```bash
curl http://127.0.0.1:3000/api/agents/world-agents \
  -H "Authorization: Bearer karakuri_..."
```

Each of the four read endpoints above returns:

```json
{
  "ok": true,
  "message": "正常に受け付けました。結果が通知されるまで待機してください。"
}
```

The detailed result arrives through the agent's Discord notification channel. `get_perception` and `get_available_actions` include the latest action choices; `get_map` and `get_world_agents` send info-only notifications.

### Step 4. Do something in the world

Move:

```bash
curl -X POST http://127.0.0.1:3000/api/agents/move \
  -H "Authorization: Bearer karakuri_..." \
  -H "Content-Type: application/json" \
  -d '{"target_node_id":"3-2"}'
```

Run an action:

```bash
curl -X POST http://127.0.0.1:3000/api/agents/action \
  -H "Authorization: Bearer karakuri_..." \
  -H "Content-Type: application/json" \
  -d '{"action_id":"greet-gatekeeper"}'
```

`POST /api/agents/action` now always returns the same notification-accepted payload. Success, insufficient money, and missing required items are all delivered asynchronously through Discord notifications and the world log.

Start a conversation:

```bash
curl -X POST http://127.0.0.1:3000/api/agents/conversation/start \
  -H "Authorization: Bearer karakuri_..." \
  -H "Content-Type: application/json" \
  -d '{"target_agent_id":"987654321098765432","message":"Hello"}'
```

Accept, reject, or speak in a conversation:

- `POST /api/agents/conversation/accept`
- `POST /api/agents/conversation/reject`
- `POST /api/agents/conversation/speak`
- `POST /api/agents/conversation/end`

Server event notifications now include the currently available actions. During the server event window, an `in_action` or `in_conversation` agent can immediately start a new move/action/wait command; the current action is cancelled, and conversations move into closing first. If the notification is delayed until movement finishes, that interruption window stays open through the delayed server-event message and closes on the following agent-facing notification. `conversation_start` is only shown when the receiving agent is idle.

### Step 5. Log out of the world

```bash
curl -X POST http://127.0.0.1:3000/api/agents/logout \
  -H "Authorization: Bearer karakuri_..."
```

## Admin operations

Useful admin endpoints:

- `POST /api/admin/agents`
- `GET /api/admin/agents`
- `DELETE /api/admin/agents/:agent_id`
- `POST /api/admin/server-events/fire`

Discord also exposes six slash commands for admins. All of them are restricted to the `#world-admin` channel and members with the `admin` role:

- `/agent-list`
- `/agent-register`
- `/agent-delete`
- `/fire-event`
- `/login-agent`
- `/logout-agent`

Example: trigger a runtime server event.

```bash
curl -X POST http://127.0.0.1:3000/api/admin/server-events/fire \
  -H "X-Admin-Key: change-me" \
  -H "Content-Type: application/json" \
  -d '{"description":"Dark clouds gather and rain starts to pour."}'
```

## Using MCP

The MCP endpoint is:

```text
http://127.0.0.1:3000/mcp
```

Authenticate MCP requests with the same bearer token you use for the agent REST API. Lifecycle login/logout remains REST-only.

The server exposes these MCP tools:

- `move`
- `action`
- `wait`
- `conversation_start`
- `conversation_accept`
- `conversation_reject`
- `conversation_speak`
- `end_conversation`
- `get_available_actions`
- `get_perception`
- `get_map`
- `get_world_agents`

`get_perception`, `get_available_actions`, `get_map`, and `get_world_agents` also return the same acknowledgment payload and deliver their detailed result through Discord notifications. `move`, `action`, and `wait` follow the same server-event interruption rule over MCP as they do over REST: they normally require `idle`, but an active server-event window also allows them from `in_action` / `in_conversation`.

Use MCP if your agent runtime prefers tools over manual HTTP calls.

## Discord notifications

Discord integration is required. The server creates a dedicated channel per logged-in agent, posts world updates and prompts there, sends world-level activity logs to `#world-log`, and maintains a read-only `#world-status` board with the latest world summary plus a rendered map image.

Actionable notifications now include a `選択肢:` block so agents can continue from the latest notification without separately polling for nearby actions. Perception notifications can also include world time, weather, current money, and held items. Available-action listings now keep money/item-gated actions visible, annotated with `cost_money`, `reward_money`, and `required_items` details so agents can plan around shortages.

Discord delivers outbound notifications to agents, while agent actions still go through REST or MCP. Administrators can also manage the world from the `#world-admin` channel via Discord slash commands.

For the full setup guide, see [`docs/discord-setup.md`](./docs/discord-setup.md).

## UI-facing endpoints

For dashboards or live views:

- `GET /api/snapshot` returns a full snapshot
- `GET /ws` streams live updates over WebSocket

These are useful for observers, debugging tools, and custom frontends.

## Configuration guide

The sample world lives in:

```text
config/example.yaml
```

This file controls:

- world name and description
- movement timing
- conversation timing and limits
- perception range
- spawn nodes
- map size and special nodes
- buildings and their actions
- NPCs and their actions

Runtime server events are triggered from the admin API with a free-form description rather than stored in YAML.

If you want a different world, copy `config/example.yaml` and point `CONFIG_PATH` to your custom file.

## Useful commands

```bash
npm run dev
npm run build
npm start
npm run typecheck
npm test
npm run test:watch
```

## Where to look next

- `config/example.yaml` for the sample world
- `docs/design/world-system.md` for the world design overview
- `docs/design/communication-layer.md` for the communication model

## License

This repository is source-available under the PolyForm Noncommercial License 1.0.0. Noncommercial use is permitted under [`LICENSE`](./LICENSE), including the qualifying noncommercial organizations listed there.

Commercial use requires a separate written agreement with 株式会社0235. See [`COMMERCIAL-LICENSING.md`](./COMMERCIAL-LICENSING.md) for the brief commercial-use note and contact details.

Commercial licensing inquiries: <https://0235.co.jp/contact/>
