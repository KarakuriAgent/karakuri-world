# 12 - 観戦用スナップショットと本体拡張

## 1. 目的

本書は UI システム向けに公開する `SpectatorSnapshot` と、それを生成するために Karakuri World 本体へ追加する型・変換ルールを定義する。方針は「ブラウザに出してよい情報だけを、UI がそのまま描画できる形で渡す」である。`GET /api/snapshot` は引き続き内部 / 管理向け `WorldSnapshot` を返す正本 API であり、primary path では snapshot publisher がこれを fixed cadence で取得して `SpectatorSnapshot` へ変換する。relay が `/ws` 初回 `snapshot` を使う場合も、それは補助経路として扱う。

## 2. 本体側の追加データ

### 2.1 `WorldSnapshot` の追加項目

snapshot publisher が `/api/snapshot` を正本の世界状態として再利用できるよう、`WorldSnapshot` に以下を追加する。relay が `/ws` 初回 `snapshot` を使う場合も同じ構造を読む。固定表示する直近サーバーイベント履歴は 5.1 のとおり D1 ないし同等の永続化データから補う。

```typescript
interface WorldCalendarSnapshot {
  timezone: string;
  local_date: string; // YYYY-MM-DD
  local_time: string; // HH:mm:ss
  season: 'spring' | 'summer' | 'autumn' | 'winter';
  season_label: '春' | '夏' | '秋' | '冬';
  day_in_season: number; // 1始まり
  display_label: string; // 例: "春・3日目"
}

interface MapRenderTheme {
  cell_size: number;
  label_font_size: number;
  node_id_font_size: number;
  background_fill: string;
  grid_stroke: string;
  default_node_fill: string;
  normal_node_fill: string;
  wall_node_fill: string;
  door_node_fill: string;
  npc_node_fill: string;
  building_palette: string[];
  wall_text_color: string;
  default_text_color: string;
}

interface WorldSnapshot {
  // 既存項目
  world: WorldConfig;
  map: MapConfig;
  weather?: SnapshotWeather;
  agents: AgentSnapshot[];
  conversations: ConversationSnapshot[];
  server_events: ServerEventSnapshot[];
  generated_at: number;

  // 追加項目
  calendar: WorldCalendarSnapshot;
  map_render_theme: MapRenderTheme;
}
```

`map_render_theme` は `src/discord/map-renderer.ts` の定数を正本として生成する。UI 側で独自定数を持たず、Discord 表示とブラウザ表示の差分をなくす。特に `background_fill` と `node_id_font_size` を contract に含め、ブラウザ側へ固定値を残さない。

### 2.2 `AgentSnapshot` の追加項目

```typescript
type AgentActivitySnapshot =
  | {
      type: 'action';
      action_id: string;
      action_name: string;
      duration_ms: number;
      completes_at: number;
    }
  | {
      type: 'wait';
      duration_ms: number;
      completes_at: number;
    }
  | {
      type: 'item_use';
      item_id: string;
      item_name: string;
      completes_at: number;
    };

interface AgentSnapshot {
  // 既存項目（内部契約のまま維持）
  agent_id: string;
  agent_name: string;
  node_id: NodeId;
  state: AgentState;
  discord_channel_id: string;
  money: number;
  items: AgentItem[];
  movement?: { ... };
  current_activity?: AgentActivitySnapshot;

  // 既存だが観戦用に必要
  discord_bot_avatar_url?: string;

  // UI 向け追加
  status_emoji: string; // 例: "💬", "🚶", "💤", "🎣"
  current_conversation_id?: string;
}
```

`discord_bot_avatar_url` は Phase 1 時点の既定アイコンソースとして、登録時に取得済みの値を永続化層から snapshot 生成時に反映する。未取得時は `undefined` とし、UI は既定アイコンへフォールバックする。overview 6.5 の将来要件どおり、UI 独自アイコン（画像 URL / 絵文字）を導入する場合はこのフィールドを唯一の契約に固定せず、`SpectatorAgentSnapshot` に専用の追加フィールドを後方互換的に拡張する。

`status_emoji` は UI が状態絵文字マッピングを再実装しないための派生値である。優先順位は 4.2 を参照。

`AgentActivitySnapshot` は本体 snapshot の内部契約をそのまま再掲したものであり、`action` / `wait` は `duration_ms` を持つ一方、`item_use` は現行実装どおり `completes_at` のみを持つ。アクション絵文字はここには持たせず、`action_id` を用いて後段で導出する。

### 2.3 `ActionConfig` の追加項目

アクション種別ごとの見た目を UI と通知で揃えるため、`ActionConfigBase` に任意の `emoji` を追加する。

```typescript
interface ActionConfigBase {
  action_id: string;
  name: string;
  description: string;
  emoji?: string;
  // 既存項目は省略
}
```

## 3. 観戦用公開型

### 3.1 `SpectatorSnapshot`

snapshot publisher は `WorldSnapshot` から以下の公開専用型へ変換して R2 に書き出す。

```typescript
interface SpectatorWorldSnapshot {
  name: string;
  description: string;
}

interface SpectatorNodeConfig {
  type: NodeType;
  label?: string;
  building_id?: string;
  npc_id?: string;
}

interface SpectatorBuildingConfig {
  building_id: string;
  name: string;
  description: string;
  wall_nodes: NodeId[];
  interior_nodes: NodeId[];
  door_nodes: NodeId[];
}

interface SpectatorNpcConfig {
  npc_id: string;
  name: string;
  description: string;
  node_id: NodeId;
}

interface SpectatorMapSnapshot {
  rows: number;
  cols: number;
  nodes: Record<NodeId, SpectatorNodeConfig>;
  buildings: SpectatorBuildingConfig[];
  npcs: SpectatorNpcConfig[];
}

type SpectatorAgentActivity =
  | {
      type: 'action';
      label: string;
      emoji: string;
      duration_ms: number;
      completes_at: number;
    }
  | {
      type: 'wait';
      label: string;
      emoji: string;
      duration_ms: number;
      completes_at: number;
    }
  | {
      type: 'item_use';
      label: string;
      emoji: string;
      completes_at: number;
      duration_ms?: number;
    };

interface SpectatorAgentSnapshot {
  agent_id: string;
  agent_name: string;
  node_id: NodeId;
  state: AgentState;
  status_emoji: string;
  discord_bot_avatar_url?: string; // Phase 1 の既定アイコンソース
  current_conversation_id?: string;
  movement?: {
    from_node_id: NodeId;
    to_node_id: NodeId;
    path: NodeId[];
    arrives_at: number;
  };
  current_activity?: SpectatorAgentActivity;
}

interface SpectatorConversationSnapshot {
  conversation_id: string;
  status: ConversationStatus;
  participant_agent_ids: string[];
  current_speaker_agent_id: string;
  current_turn: number;
}

interface SpectatorServerEventSnapshot {
  server_event_id: string;
  description: string;
  delivered_agent_ids: string[];
  pending_agent_ids: string[];
}

interface SpectatorRecentServerEvent {
  server_event_id: string;
  description: string;
  occurred_at: number;
  is_active: boolean;
}

interface SpectatorSnapshot {
  schema_version: 1;
  world: SpectatorWorldSnapshot;
  timezone: string;
  calendar: WorldCalendarSnapshot;
  map: SpectatorMapSnapshot;
  map_render_theme: MapRenderTheme;
  weather?: SnapshotWeather;
  agents: SpectatorAgentSnapshot[];
  conversations: SpectatorConversationSnapshot[];
  server_events: SpectatorServerEventSnapshot[];
  recent_server_events: SpectatorRecentServerEvent[];
  generated_at: number; // 本体 snapshot 生成時刻
  published_at: number; // snapshot publisher が R2 へ反映した時刻
}
```

現行 UI は `discord_bot_avatar_url ?? 既定アイコン` で描画してよいが、将来 overview 6.5 の UI 独自アイコン設定を導入する際は `ui_agent_icon -> discord_bot_avatar_url -> 既定アイコン` の優先順位へ拡張できる余地を残す。`discord_bot_avatar_url` 前提の実装詳細を snapshot publish / 永続化契約そのものに焼き込まない。

`generated_at` は本体がその `WorldSnapshot` を生成した時刻であり、overview どおり UI の stale 判定の正本とする。primary path では publisher が `/api/snapshot` を fixed cadence で再取得するため、quiet period でも成功した再取得ごとに `generated_at` は進む。`published_at` は snapshot publisher が公開 JSON を最後に正常反映した時刻で、配信健全性診断の補助情報として使う。`server_events` は「現在未解決のイベント」、`recent_server_events` は publisher-side cache から合成する「直近に観測・発火したイベント履歴」であり、完了済みイベントも含んでよい。ただし polling-only + cold start では publisher 起動前に完了した履歴の完全再現までは保証しない。

### 3.2 除外する情報

以下は `WorldSnapshot` / `WorldEvent` に存在しても `SpectatorSnapshot` と D1 永続化対象から除外する。`/api/history.detail` も D1 の `payload_json` をそのまま返すため、同じ除外規則を共有する。

| 項目 | 理由 |
|------|------|
| `discord_channel_id` | 内部 Discord 導線でありブラウザ公開不要 |
| `money` | 観戦に不要、内部ゲーム情報 |
| `items` | 観戦に不要、内部ゲーム情報 |
| `BuildingConfig.actions`, `NpcConfig.actions` | UI マップ描画に不要であり、内部アクション設定を漏らさないため |
| `ActionConfigBase.cost_money`, `reward_money`, `required_items`, `reward_items` | 経済・インベントリ条件の公開を防ぐため |
| `ActionStartedEvent.cost_money`, `items_consumed` | エージェントの所持金・所持品変動が露出するため |
| `ActionCompletedEvent.cost_money`, `reward_money`, `money_balance`, `items_granted`, `items_dropped` | 経済・インベントリ結果の露出を防ぐため |
| エージェント API キー類 | 機密情報 |
| 管理 API 用 URL / ヘッダー | 機密情報 |

除外規則は denylist ではなく allowlist として扱う。公開契約に明記されていないフィールドは、将来 `WorldSnapshot` / `WorldEvent` に追加されても自動公開しない。

## 4. 派生値の算出ルール

### 4.1 季節と日付

ゲーム内日付は `ServerConfig.timezone` を正本とする実時間連動モデルで定義する。永続化された専用カレンダー状態は持たない。

- `local_date`: `generated_at` を `timezone` でローカル日付へ変換
- `season`: 気象学的季節を採用する
  - 3〜5 月: `spring`
  - 6〜8 月: `summer`
  - 9〜11 月: `autumn`
  - 12〜2 月: `winter`
- `day_in_season`: 季節開始日からの 1 始まり日数
- `display_label`: `{season_label}・{day_in_season}日目`

この方式により本体サーバーが既に持つ `timezone` と現在時刻だけで UI 表示を決定できる。

### 4.2 `status_emoji`

`status_emoji` は以下の優先順位で決定する。

1. `state === 'moving'` の場合は `🚶`
2. `state === 'in_conversation'` の場合は `💬`
3. `current_activity.type === 'wait'` の場合は `💤`
4. `current_activity.type === 'item_use'` の場合は `🧰`
5. `current_activity.type === 'action'` かつ対応 `ActionConfig.emoji` があればその値
6. `current_activity.type === 'action'` で `emoji` 未指定なら `✨`
7. `state === 'idle'` の場合は空文字

`current_activity.emoji` も同じルールで埋め、UI はその値をそのまま描画する。

### 4.3 `current_activity.label`

`SpectatorAgentActivity.label` は UI が活動名を追加推論しないための派生値であり、`AgentActivitySnapshot` から以下の規則で決定する。

1. `type === 'action'` の場合は `action_name` をそのまま使う
2. `type === 'wait'` の場合は固定値 `待機` を使う
3. `type === 'item_use'` の場合は `item_name` をそのまま使う

`label` は短い表示名のみを入れ、絵文字・残り時間・説明文は含めない。

## 5. 変換ルール

### 5.1 `WorldSnapshot -> SpectatorSnapshot`

snapshot publisher（または同等の変換層）は以下の順で変換する。

1. `world` から `name`, `description` のみを残す
2. `timezone` は `calendar.timezone` を複製してトップレベルにも配置する
3. `map` は `MapConfig` を `SpectatorMapSnapshot` へ縮約し、`rows`, `cols`, `nodes`, `buildings`, `npcs` の描画に必要な構造だけを残す。`buildings[].actions` と `npcs[].actions` は丸ごと除外し、ブラウザへ内部アクション設定を渡さない
4. `agents` は内部 `WorldSnapshot.AgentSnapshot` を入力とし、`discord_channel_id`, `money`, `items` などの内部項目をここで除外したうえで、公開用 `SpectatorAgentSnapshot` へ `status_emoji` と `current_conversation_id` を含めて変換する
5. `conversations` は UI 描画に必要な要約項目だけへ圧縮する
6. `server_events` は `WorldSnapshot.server_events` をそのまま写し、現在 outstanding なイベントだけを保持する
7. `recent_server_events` は publisher-side cache から `server_event_id` 単位で重複排除した論理イベントを `occurred_at DESC` で最大 3 件埋める。primary baseline では fixed-cadence polling 中の `WorldSnapshot.server_events` を監視し、前回 poll に無かった `server_event_id` を **新規観測**した時点の `generated_at` を `occurred_at` として記録する。D1 `server_event_instances` や relay/backfill がある配備では、その後に authoritative な初回発火時刻へ補正してよい。永続 cache を持たない cold start では起動前に完了した recent history の再現は保証しない。`is_active` は各 `server_event_id` が手順 6 の `server_events` にまだ存在するかで判定する
8. `published_at` は publisher の書き込み時刻で上書きする

将来 `ui_agent_icon` 等の UI 専用アイコン契約を追加する場合も、この変換境界で `SpectatorAgentSnapshot` に載せ替える。publisher / relay 境界の永続化・公開 JSON は「現在の Discord avatar URL」ではなく「観戦 UI が使うアイコン情報」を返す責務へ拡張可能であることを前提にしておく。

### 5.2 `current_activity` の変換

- `action` は `AgentActivitySnapshot.duration_ms` をそのまま `SpectatorAgentActivity.duration_ms` に写す
- `action.label` は `AgentActivitySnapshot.action_name` をそのまま使う
- `wait` も同様に `duration_ms` を必須で写す
- `wait.label` は固定値 `待機` とする
- `item_use` は現行本体の `AgentActivitySnapshot` / `ItemUseTimer` / `item_use_started` イベントが `duration_ms` を持たないため、`completes_at` を必須、`duration_ms` は省略可とする
- `item_use.label` は `AgentActivitySnapshot.item_name` をそのまま使う
- UI は `item_use.duration_ms` がない前提で実装し、残り時間表示が必要な場合は `completes_at - Date.now()` のみを使う。開始時刻に依存する進捗率バーは初期実装の責務に含めない
- 将来、本体が `item_use` にも `duration_ms` を追加した場合は、同一フィールドへ後方互換的に反映できる

この方針により、現行本体の型定義（`src/types/snapshot.ts` の `item_use` 分岐、`src/types/timer.ts` の `ItemUseTimer`）と矛盾せずに実装できる。

### 5.3 `WorldEvent -> PersistedSpectatorEvent`

イベント永続化時も同じサニタイズ規則を適用する。`payload_json` / `/api/history.detail` は「イベント種別ごとの公開 allowlist だけを残した JSON」とし、以下を authoritative rule とする。

| イベント種別 | 保存する公開フィールド | 明示的に除外する代表フィールド |
|-------------|------------------------|------------------------------|
| `agent_logged_in` | `agent_id`, `agent_name`, `node_id` | `discord_channel_id` |
| `agent_logged_out` | `agent_id`, `agent_name`, `node_id`, `cancelled_state`, `cancelled_action_name` | `discord_channel_id` |
| `movement_started` | `agent_id`, `agent_name`, `from_node_id`, `to_node_id`, `path`, `arrives_at` | なし |
| `movement_completed` | `agent_id`, `agent_name`, `node_id`, `delivered_server_event_ids` | なし |
| `action_started` | `agent_id`, `agent_name`, `action_id`, `action_name`, `duration_ms`, `completes_at` | `cost_money`, `items_consumed` |
| `action_completed` | `agent_id`, `agent_name`, `action_id`, `action_name` | `cost_money`, `reward_money`, `money_balance`, `items_granted`, `items_dropped` |
| `action_rejected` | `agent_id`, `agent_name`, `action_id`, `action_name`, `rejection_reason` | 経済・所持品の内訳を表す追加フィールド全般 |
| `wait_started` | `agent_id`, `agent_name`, `duration_ms`, `completes_at` | なし |
| `wait_completed` | `agent_id`, `agent_name`, `duration_ms` | なし |
| `item_use_started` | `agent_id`, `agent_name`, `item_id`, `item_name`, `completes_at` | 所持品残高・在庫差分の追加フィールド全般 |
| `item_use_completed` | `agent_id`, `agent_name`, `item_id`, `item_name`, `item_type` | 所持品残高・在庫差分の追加フィールド全般 |
| `item_use_venue_rejected` | `agent_id`, `agent_name`, `item_id`, `item_name`, `venue_hints` | 所持品残高・在庫差分の追加フィールド全般 |
| 会話系イベント | 03-world-engine.md / 06-conversation.md で定義される会話公開フィールド（`conversation_id`, 参加者, 話者, `message`, `reason`, `final_message` など UI 表示に使うもの） | 内部通知導線・秘密情報・将来追加される非公開フィールド |
| `server_event_fired` | `server_event_id`, `description`, `delivered_agent_ids`, `pending_agent_ids`, `delayed` | なし |

特に `cost_money`, `reward_money`, `required_items`, `reward_items`, `money_balance`, `items_consumed`, `items_granted`, `items_dropped` といった経済・インベントリ関連フィールドは、設定由来でもイベント結果由来でも公開契約へ入れない。

`delayed` を `server_event_fired` の公開フィールドに含めるのは、observability 上の必須情報だからである。同じ `server_event_id` の遅延再配信を `server_event_instances.first_occurred_at` / `last_occurred_at` 差分で検出する設計（14-ui-history-api.md §4.3）と組み合わせ、運用者が遅延再配信の発生を後追い可能にする。なお `delayed` は UI 描画には使わず、`SpectatorRecentServerEvent` には載せない。

### 5.4 未知イベント・未知フィールド受信時の規則

optional relay / history ingest 経路で本表に列挙されていない `event.type` を受信した場合、または既知イベントに想定外フィールドが含まれていた場合の挙動は次のとおりとする。

- **未知 `event.type`**: `world_events` / link 表への保存を行わずに drop する。drop 件数は `event.type` 単位で metric として記録し、warn ログを出す。`SpectatorSnapshot` の生成・配信にも反映しない
- **既知イベントの未知フィールド**: 本表 / §5.3 に列挙された allowlist フィールドのみを `payload_json` へ保存し、それ以外は黙って捨てる。新規フィールド検出時に warn ログ + metric を出す
- これにより本体側で新イベントや新フィールドが追加された際にも、UI 中継・履歴 API 側の公開境界が自動的に拡張されない

詳細な D1 形式は 14-ui-history-api.md を参照。

## 6. 互換性とバージョニング

- `SpectatorSnapshot.schema_version` は破壊的変更時にのみ更新する
- UI は未知のフィールドを無視し、`schema_version !== 1` の場合は一時的な fetch error とは区別される `incompatible` 状態として扱い、「観戦 UI の更新が必要です。再読み込みしてください」のような永続エラーメッセージを表示する。リトライで解消しない永続エラーであるため、通常の transient error と同じ「更新の取得に失敗しました」表示には吸収しない
- 後方互換で済む追加フィールドは `schema_version` を上げない。非互換な型・意味変更のときに限り `schema_version` を上げる
- 本体 `WorldSnapshot` は内部用型であるため後方互換保証対象にせず、snapshot publisher / relay の変換層を境界とする
