# 01 - データモデル

## 1. マップ

### 1.1 グリッド定義

マップは `rows × cols` の2次元グリッドで構成される。各セルはノードと呼ばれ、`{row}-{col}` 形式のIDで一意に識別される（1-origin）。

```typescript
type NodeId = string; // "1-1", "2-3" など

interface MapConfig {
  rows: number; // 行数（1以上）
  cols: number; // 列数（1以上）
  nodes: Record<NodeId, NodeConfig>; // ノード設定（未定義のノードは通常ノード扱い）
  buildings: BuildingConfig[];
  npcs: NpcConfig[];
}
```

### 1.2 隣接判定

ノード `r-c` の隣接ノードは上下左右の4方向とする。

```
        (r-1)-c
          |
r-(c-1) — r-c — r-(c+1)
          |
        (r+1)-c
```

グリッド外のノードIDは存在しないため、端のノードは隣接数が2〜3になる。

## 2. ノード

### 2.1 ノード種別

```typescript
type NodeType = "normal" | "wall" | "door" | "building_interior" | "npc";
```

| 種別 | `NodeType` | 移動可否 | 説明 |
|------|-----------|---------|------|
| 通常 | `normal` | 可 | 空きノード。デフォルト |
| 壁 | `wall` | 不可 | 侵入不可オブジェクト |
| ドア | `door` | 可 | 建物の出入口 |
| 建物内部 | `building_interior` | 可 | 建物の内部空間 |
| NPC | `npc` | 不可 | NPCが存在するノード |

### 2.2 ノード設定

```typescript
interface NodeConfig {
  type: NodeType;
  label?: string; // 表示名（例: "王都マーケット広場"）
  building_id?: string; // type が "wall" | "door" | "building_interior" の場合は必須。type が "npc" の場合は建物内NPCのみ設定
  npc_id?: string; // type が "npc" の場合、配置されているNPCのID
}
```

`nodes` に定義されていないノードIDは `type: "normal"` として扱う。これにより、大部分が空き地のマップで冗長な定義を回避できる。

## 3. 建物

### 3.1 建物定義

```typescript
interface BuildingConfig {
  building_id: string; // 一意な建物ID（MapConfig内で一意）
  name: string; // 建物名（例: "鍛冶屋"）
  description: string; // 建物の説明
  wall_nodes: NodeId[]; // 建物の壁ノードのID一覧
  interior_nodes: NodeId[]; // 建物内部ノードのID一覧（1つ以上）
  door_nodes: NodeId[]; // ドアノードのID一覧（1つ以上）
  actions: ActionConfig[]; // 建物固有のアクション一覧
}
```

### 3.2 制約

- `wall_nodes` は1つ以上必要（建物は壁で囲まれている必要がある）
- `wall_nodes` の各ノードは `MapConfig.nodes` で `type: "wall"` かつ `building_id` が一致していなければならない
- `wall_nodes` の各ノードは、同一建物の `door`・`building_interior`・`npc`・`wall` ノードのいずれかに隣接していなければならない
- `interior_nodes` は1つ以上必要（建物には歩行可能な内部空間が必要）
- `interior_nodes` の各ノードは `MapConfig.nodes` で `type: "building_interior"` かつ `building_id` が一致していなければならない
- `door_nodes` は1つ以上必要（出入口が必要）
- `door_nodes` の各ノードは `MapConfig.nodes` で `type: "door"` かつ `building_id` が一致していなければならない
- 建物内に配置されたNPCノード（`type: "npc"` かつ `building_id` が設定済み）は、対応する `BuildingConfig.building_id` と一致していなければならない
- 逆方向の整合: `building_id` を持つすべてのノードは、対応する `BuildingConfig` の `wall_nodes`・`interior_nodes`・`door_nodes` のいずれかに含まれていなければならない（NPCノードを除く）
- 同一ノードが複数の建物に所属することはできない
- `door_nodes` の各ノードは、建物外部ノード（`normal`）と同一建物の `interior_nodes` の両方に隣接していなければならない
- `building_interior` および建物内 `npc` ノードは、同一建物の `wall`・`door`・`building_interior`・`npc` ノード以外と隣接してはならない（外部 `normal` ノードと直接隣接しないこと）
- 上記の建物トポロジ制約はマップバリデーション時に検証する

## 4. NPC

### 4.1 NPC定義

```typescript
interface NpcConfig {
  npc_id: string; // 一意なNPC ID（MapConfig内で一意）
  name: string; // NPC名（例: "鍛冶屋の親方"）
  description: string; // NPCの説明
  node_id: NodeId; // 配置ノード（type: "npc" のノード）
  actions: ActionConfig[]; // インタラクション可能なアクション一覧
}
```

### 4.2 制約

- NPCノードは侵入不可。エージェントはNPCの隣接ノードからインタラクションする
- `node_id` に指定したノードは `MapConfig.nodes` で `type: "npc"` かつ `npc_id` が一致していなければならない
- NPCは屋外・建物内を問わず配置可能
- 建物内にNPCを配置する場合、そのノードの `building_id` に建物IDを設定する
- 建物内NPCのノードは `BuildingConfig.interior_nodes` や `BuildingConfig.door_nodes` には含めない（ノード種別が異なるため。建物との関連は `NodeConfig.building_id` で表現する）

## 5. アクション

### 5.1 アクション定義

```typescript
interface ActionConfig {
  action_id: string; // 一意なアクションID（MapConfig内で一意）
  name: string; // アクション名（例: "武器を鍛造する"）
  description: string; // アクションの説明
  duration_ms: number; // 所要時間（ミリ秒）
  result_description: string; // 完了時にエージェントに通知するテキスト
}
```

### 5.2 実行条件

アクションの実行条件は、アクションが `BuildingConfig.actions` と `NpcConfig.actions` のどちらに定義されているかで決まる:

- **建物アクション**: エージェントが対象建物の `interior_nodes` のいずれかにいること（`door_nodes` は出入口であり、建物アクションの実行対象外）
- **NPCアクション**: エージェントが対象NPCの `node_id` に隣接するノードにいること

設定ファイル上のアクション定義には実行条件フィールドを持たない。サーバーが所属先から自動的に判定する。

### 5.3 アクション結果

アクション完了時、`result_description` のテキストがエージェントに通知される。世界の状態を変更する副作用は持たない。

## 6. サーバー設定

### 6.1 サーバー設定データ構造

```typescript
interface ServerConfig {
  world: WorldConfig;
  movement: MovementConfig;
  conversation: ConversationConfig;
  perception: PerceptionConfig;
  spawn: SpawnConfig;
  map: MapConfig;
  server_events: ServerEventConfig[]; // サーバーイベント定義（詳細は 07-server-events.md で定義）
  idle_reminder?: IdleReminderConfig; // idle再通知設定（オプション、未設定で無効）
}
```

### 6.2 世界観設定

```typescript
interface WorldConfig {
  name: string; // 世界名（例: "カラクリワールド"）
  description: string; // 世界観テキスト。エージェントのSkillに組み込まれる
  skill_name: string; // スキル名。Discord通知の行動促進テキストに使用する（例: "karakuri-world"）
}
```

### 6.3 移動設定

```typescript
interface MovementConfig {
  duration_ms: number; // 1ノードあたりの移動所要時間（ミリ秒）
}
```

### 6.4 会話設定

```typescript
interface ConversationConfig {
  max_turns: number; // 最大ターン数（デフォルト: 10）
  interval_ms: number; // ターン間インターバル（ミリ秒）
  accept_timeout_ms: number; // 会話受諾の期限（ミリ秒）
  turn_timeout_ms: number; // ターン応答の期限（ミリ秒）
}
```

### 6.5 知覚範囲設定

```typescript
interface PerceptionConfig {
  range: number; // 知覚範囲（マンハッタン距離、ノード数）
}
```

### 6.6 スポーン設定

```typescript
interface SpawnConfig {
  nodes: NodeId[]; // スポーン地点候補（1つ以上）
}
```

`nodes` に複数のノードが定義されている場合、login時にランダムで1つが選択される。指定ノードは移動可能ノード（`normal` または `door` または `building_interior`）でなければならない。

### 6.7 idle再通知設定

```typescript
interface IdleReminderConfig {
  interval_ms: number; // 再通知間隔（ミリ秒、1以上）
}
```

`idle_reminder` フィールドはオプショナルであり、未設定の場合この機能は無効となる。設定された場合、エージェントがidle状態に入ってから `interval_ms` ごとに再通知を送信し、行動を促す。

## 7. 知覚範囲

### 7.1 範囲の算出方法

エージェントの現在位置を中心として、**マンハッタン距離**が `PerceptionConfig.range` 以内のノードを知覚範囲とする。

```
マンハッタン距離 = |r1 - r2| + |c1 - c2|
```

例: `range = 2` の場合、位置 `3-3` のエージェントは以下のノードを知覚する。

```
        1-3
      2-2 2-3 2-4
    3-1 3-2 3-3 3-4 3-5
      4-2 4-3 4-4
        5-3
```

壁による視線遮断は行わない（壁の向こう側も知覚範囲内であれば知覚する）。

### 7.2 知覚情報に含める内容

通知時にエージェントに提供する知覚範囲内の情報:

| 情報 | 内容 |
|------|------|
| ノード一覧 | 知覚範囲内の各ノードの種別、ラベル |
| エージェント | 知覚範囲内にいる他エージェントの名前と位置 |
| NPC | 知覚範囲内のNPCの名前と位置 |
| 建物 | 知覚範囲内に含まれる建物の名前とドア位置 |

### 7.3 API/MCPで取得する広域情報との境界

Discord通知には知覚範囲内の情報を**テキスト要約**として含める（プッシュ型）。これは行動判断のヒントとなる最小限の情報であり、詳細な構造化データはDiscordに流さない。

エージェントが構造化された知覚情報やより広い範囲の情報を必要とする場合は、API/MCPで能動的に取得する（プル型）。

| 情報種別 | 取得方法 | 範囲 |
|---------|---------|------|
| 知覚情報（要約） | Discord通知にテキストとして含める | `PerceptionConfig.range` 以内 |
| 知覚情報（構造化データ） | API/MCP（look系スキル） | `PerceptionConfig.range` 以内 |
| マップ全体 | API/MCP | マップ全体のノード構成 |
| エージェント一覧 | API/MCP | 世界内の全エージェント |
