# Karakuri World UI

[日本語版はこちら](./README.ja.md)

A Godot 4 desktop client that visualizes the Karakuri World server state in real time.

## Requirements

- **Godot 4.3 or later** (TileMapLayer support required)
- A running Karakuri World server (`npm start`)
- The server's Admin Key

## Getting started

### From the Godot editor

1. Open Godot 4 and import `karakuri-world-ui/project.godot` as a project
2. Press **F5** (or the play button) to run the scene
3. Enter your server details in the connection dialog and click **Save & Connect**

### Exported binary

Use the Godot editor menu **Project → Export** to export a standalone desktop build.

## Connection settings

The connection dialog opens on first launch or when you click the **Settings** button.

| Field | Description | Default |
|-------|-------------|---------|
| Host | Server hostname or IP | `127.0.0.1` |
| Port | Server port | `3000` |
| TLS | Check to use `wss` / `https` | OFF |
| Admin key | The server's `ADMIN_KEY` (required) | — |
| Theme | Theme folder name | `default` |

Settings are saved automatically to `user://settings.cfg` (the OS app-data directory).

## Controls

| Action | Input |
|--------|-------|
| Pan (camera move) | Middle-mouse drag / Arrow keys |
| Zoom | Mouse wheel |
| Camera reset | Home key / Double-click |
| Select agent | Click an entry in the side panel |
| Connect / Disconnect | Buttons in the top bar |

## Screen layout

```
┌─ Connection Bar ─────────────────────────────┐
│ ws://127.0.0.1:3000 • theme: default • synced│
│ [Connect] [Disconnect] [Settings]            │
├──────────────────────────────┬────────────────┤
│                              │  Agents (3)    │
│         Map View             │  - Alice [idle]│
│    (TileMap + Agents)        │  - Bob [moving]│
│                              │                │
│   [Alice] ──── [Bob]         ├────────────────┤
│      │                       │  Event Log (5) │
│   ┌──┴──┐                    │  12:30 Alice...│
│   │Hello│                    │  12:29 Bob ... │
│   └─────┘                    │                │
├──────────────────────────────┴────────────────┤
│ Connection: synced │ World: example │ Agents: 3│
└───────────────────────────────────────────────┘
```

- **Connection Bar**: Shows the connection target, theme, and state. Contains connect/disconnect/settings buttons.
- **Map View**: Renders the tile-based grid map with agent sprites, speech bubbles, and server event banners.
- **Side Panel**: Lists logged-in agents (click to pan the camera) and an event log.
- **Status Bar**: Connection state, world name, and agent count.

## Theme system

Themes are placed as folders under `themes/`.

```
themes/
└── default/
    ├── theme.json          # Theme definition
    ├── tiles/tileset.png   # Tile sheet (5 tile types)
    ├── sprites/agent.png   # Default agent sprite
    └── effects/            # Server event effects (optional)
```

### theme.json structure

```json
{
  "name": "Default",
  "tile_size": 64,
  "tileset": "tiles/tileset.png",
  "tile_mapping": {
    "normal":             { "atlas_x": 0, "atlas_y": 0 },
    "wall":               { "atlas_x": 1, "atlas_y": 0 },
    "door":               { "atlas_x": 2, "atlas_y": 0 },
    "building_interior":  { "atlas_x": 3, "atlas_y": 0 },
    "npc":                { "atlas_x": 4, "atlas_y": 0 }
  },
  "agent_sprite": "sprites/agent.png",
  "speech_bubble": {
    "max_chars": 50,
    "bg_color": "#F5F3E8",
    "text_color": "#1C1C1C"
  },
  "effects": {
    "sudden-rain": "effects/rain_overlay.tscn"
  }
}
```

### Creating a custom theme

1. Create a new folder under `themes/` (e.g. `themes/steampunk/`)
2. Add a `theme.json` and the corresponding assets
3. Enter the folder name in the Theme field of the connection dialog

Each entry in `tile_mapping` specifies the atlas coordinates within the tile sheet image. The tile size can be changed via `tile_size`.

The `effects` field maps a server event definition ID to an effect scene (`.tscn`). Events without a matching effect show only a banner.

### Agent avatars

When an agent has a custom avatar image, the client automatically downloads and displays it from the server. Agents without an avatar use the theme's `agent_sprite` image.

## Directory structure

```
karakuri-world-ui/
├── project.godot                    # Godot project config
├── scenes/
│   ├── main.tscn                    # Main scene
│   ├── connection_dialog.tscn       # Connection settings dialog
│   └── components/
│       ├── agent_sprite.tscn        # Agent sprite
│       ├── speech_bubble.tscn       # Speech bubble
│       └── event_banner.tscn        # Server event banner
├── scripts/
│   ├── main.gd                      # Main scene script
│   ├── autoload/globals.gd          # Settings & theme loading (Autoload)
│   ├── connection/
│   │   ├── ws_client.gd             # WebSocket communication
│   │   └── reconnect.gd             # Exponential backoff reconnection
│   ├── state/
│   │   ├── world_state.gd           # World state management
│   │   └── event_processor.gd       # Event → state mapping
│   ├── view/
│   │   ├── map_renderer.gd          # Map rendering (TileMapLayer)
│   │   ├── agent_controller.gd      # Agent display & movement animation
│   │   ├── conversation_view.gd     # Speech bubbles & connection lines
│   │   └── server_event_fx.gd       # Server event effects
│   └── ui/
│       ├── agent_list.gd            # Agent list panel
│       ├── event_log.gd             # Event log panel
│       └── status_bar.gd            # Status bar
├── themes/default/                  # Default theme
└── resources/default_theme.tres     # Godot GUI theme resource
```

## Communication

- **WebSocket** (`ws://{host}:{port}/ws`): Authenticated with the `X-Admin-Key` header. Receives `snapshot` and `event` messages.
- **HTTP fallback** (`GET /api/snapshot`): Fetches a snapshot when the WebSocket connection fails.
- **Reconnection**: Automatic reconnection with exponential backoff (1 s → max 30 s, ×2) on disconnect.

## Design document

See [`docs/design/detailed/13-ui-client.md`](../docs/design/detailed/13-ui-client.md) for the detailed design specification.
