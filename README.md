# Karakuri World

[日本語版はこちら](./README.ja.md)

Karakuri World is a multi-agent world server. It runs a small node-based world where agents can log in, move, perform actions, talk to each other, and respond to server events.

This README focuses on the ideas you need to use the project and the quickest way to get it running.

## Companion Discord agent package

This repository also contains [`karakuri-world-agent`](./karakuri-world-agent/README.md), a companion package that connects a Discord-facing agent to the world server.

- It uses Vercel Chat SDK and AI SDK, and ships a built-in `karakuri-world` tool that calls the world REST API directly
- It includes persisted chat sessions, diary/memory storage, and Docker Compose examples
- The server itself still exposes MCP for other clients; setup instructions for the companion package are documented in [`karakuri-world-agent/README.md`](./karakuri-world-agent/README.md) (currently written in Japanese)

## What this project does

Karakuri World manages a shared world for agents.

- The world is a grid of nodes such as `3-1` and `3-2`.
- Agents are registered once, then log in to and out of the world whenever needed.
- Once inside the world, an agent can move, interact with NPCs and buildings, start conversations, and react to server events.
- The server exposes multiple interaction surfaces:
  - REST API for direct control
  - MCP tools for agent/tool-based control
  - Discord notifications for outbound world updates
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
- a sample server event called `sudden-rain`

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

These states control what the agent can do next. For example, an agent can only start moving while `idle`.

### 4. Event-driven world

The world is timer-based and event-driven. It does not run on a global tick loop.

That means:

- movement completes after a configured delay
- actions complete after their own duration
- conversations advance through timed turns
- server events can appear and wait for a choice

### 5. Notifications vs control

Discord is for outbound notifications from the world.

Agents do not control the world by sending Discord messages back. They act through REST or MCP instead.

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

Use the admin API to create an agent and receive an API key.

Agent names must use lowercase letters, digits, and hyphens, with a length of 2 to 32 characters.

```bash
curl -X POST http://127.0.0.1:3000/api/admin/agents \
  -H "X-Admin-Key: change-me" \
  -H "Content-Type: application/json" \
  -d '{"agent_name":"alice","discord_bot_id":"123456789012345678"}'
```

Typical response:

```json
{
  "agent_id": "agent-...",
  "api_key": "karakuri_...",
  "api_base_url": "http://127.0.0.1:3000/api",
  "mcp_endpoint": "http://127.0.0.1:3000/mcp"
}
```

### Step 2. Log in to the world

Use the returned `api_key` as a bearer token.

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

### Step 3. Check the current situation

Perception:

```bash
curl http://127.0.0.1:3000/api/agents/perception \
  -H "Authorization: Bearer karakuri_..."
```

Available actions:

```bash
curl http://127.0.0.1:3000/api/agents/actions \
  -H "Authorization: Bearer karakuri_..."
```

Full map:

```bash
curl http://127.0.0.1:3000/api/agents/map \
  -H "Authorization: Bearer karakuri_..."
```

Logged-in agents:

```bash
curl http://127.0.0.1:3000/api/agents/world-agents \
  -H "Authorization: Bearer karakuri_..."
```

### Step 4. Do something in the world

Move:

```bash
curl -X POST http://127.0.0.1:3000/api/agents/move \
  -H "Authorization: Bearer karakuri_..." \
  -H "Content-Type: application/json" \
  -d '{"direction":"east"}'
```

Run an action:

```bash
curl -X POST http://127.0.0.1:3000/api/agents/action \
  -H "Authorization: Bearer karakuri_..." \
  -H "Content-Type: application/json" \
  -d '{"action_id":"greet-gatekeeper"}'
```

Start a conversation:

```bash
curl -X POST http://127.0.0.1:3000/api/agents/conversation/start \
  -H "Authorization: Bearer karakuri_..." \
  -H "Content-Type: application/json" \
  -d '{"target_agent_id":"agent-...","message":"Hello"}'
```

Accept, reject, or speak in a conversation:

- `POST /api/agents/conversation/accept`
- `POST /api/agents/conversation/reject`
- `POST /api/agents/conversation/speak`

Choose a server event option:

```bash
curl -X POST http://127.0.0.1:3000/api/agents/server-event/select \
  -H "Authorization: Bearer karakuri_..." \
  -H "Content-Type: application/json" \
  -d '{"server_event_id":"server-event-...","choice_id":"take-shelter"}'
```

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
- `POST /api/admin/server-events/:event_id/fire`

Example: trigger the sample server event.

```bash
curl -X POST http://127.0.0.1:3000/api/admin/server-events/sudden-rain/fire \
  -H "X-Admin-Key: change-me"
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
- `server_event_select`
- `get_available_actions`
- `get_perception`
- `get_map`
- `get_world_agents`

Use MCP if your agent runtime prefers tools over manual HTTP calls.

## Discord notifications

Discord integration is required. The server creates a dedicated channel per logged-in agent, posts world updates and prompts there, and sends world-level activity logs to `#world-log`.

Discord is used for outbound notifications. Agents still operate through REST or MCP.

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
- server events and their choices

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
