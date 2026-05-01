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
interface ItemRequirement {
  item_id: string; // ServerConfig.items 内の item_id を参照
  quantity: number; // 1以上
}

interface ActionConfigBase {
  action_id: string; // 一意なアクションID（MapConfig内で一意）
  name: string; // アクション名（例: "武器を鍛造する"）
  description: string; // アクションの説明
  emoji?: string; // 任意。UI/通知で使う代表絵文字
  cost_money?: number; // 開始時に消費する所持金（通貨の最小単位・非負整数。小数は不可）
  reward_money?: number; // 完了時に付与する所持金（通貨の最小単位・非負整数。小数は不可）
  required_items?: ItemRequirement[]; // 開始時に消費する必要アイテム
  reward_items?: ItemRequirement[]; // 完了時に付与する報酬アイテム
}

interface FixedDurationActionConfig extends ActionConfigBase {
  duration_ms: number; // 固定所要時間（ミリ秒）
  min_duration_minutes?: never;
  max_duration_minutes?: never;
}

interface RangeDurationActionConfig extends ActionConfigBase {
  duration_ms?: never;
  min_duration_minutes: number; // 実行時に選べる最小所要時間（分）
  max_duration_minutes: number; // 実行時に選べる最大所要時間（分）
}

type ActionConfig = FixedDurationActionConfig | RangeDurationActionConfig;
```

- **固定時間アクション**: `duration_ms` を持つ。実行時に追加の時間指定は不要
- **可変時間アクション**: `min_duration_minutes` / `max_duration_minutes` を持つ。エージェントは実行時にこの範囲内の `duration_minutes` を指定する
- **絵文字指定**: `emoji` は任意。指定された場合、通知・観戦UI・履歴要約で当該アクションの代表絵文字として利用できる
- **所持金コスト**: `cost_money` は任意。指定時はアクション開始時に消費し、不足時は実行できない
- **所持金報酬**: `reward_money` は任意。指定時はアクション完了時に付与する
- **必要アイテム**: `required_items` は任意。各要素は `item_id` と必要数量を表し、開始時に消費する。`venue` 型アイテムでは 05-actions.md セクション6.3.1 の `venue_hints` 構築にも使う
- **報酬アイテム**: `reward_items` は任意。各要素は完了時に付与するアイテムと数量を表す
- 上記の2形式は排他的であり、`duration_ms` と `min/max_duration_minutes` を同時に持つことはできない
- `required_items` / `reward_items` の `item_id` は `ServerConfig.items` に定義済みのアイテムを参照しなければならない
- 同一アクション内で `required_items` / `reward_items` に同じ `item_id` を複数回書かない

### 5.2 実行条件

アクションの実行条件は、アクションが `BuildingConfig.actions` と `NpcConfig.actions` のどちらに定義されているかで決まる:

- **建物アクション**: エージェントが対象建物の `interior_nodes` のいずれかにいること（`door_nodes` は出入口であり、建物アクションの実行対象外）
- **NPCアクション**: エージェントが対象NPCの `node_id` に隣接するノードにいること

設定ファイル上のアクション定義には実行条件フィールドを持たない。サーバーが所属先から自動的に判定する。

### 5.3 実行時の所要時間決定

- 固定時間アクションでは設定済みの `duration_ms` がそのまま使われる
- 可変時間アクションでは、エージェントが `ActionRequest.duration_minutes` に分単位の値を指定し、サーバーが `duration_ms` に解決して実行する
- 固定時間アクションに `duration_minutes` が渡された場合は無視される
- 可変時間アクションで `duration_minutes` が未指定、または範囲外の場合は `invalid_request` になる
- 解決済みの `duration_ms` はイベント・タイマー・スナップショットに保持される

### 5.4 アクション結果

アクション完了時、アクション名を含む完了通知がエージェントに送られる。結果の解釈はエージェントに委ねられるが、`cost_money` / `required_items` / `reward_money` / `reward_items` を指定した場合は経済状態に副作用を持つ。適用タイミングは以下のとおり。

- `cost_money` / `required_items`: 開始時に消費
- `reward_money` / `reward_items`: 完了時に付与
- 開始後に会話着信受諾・サーバーアナウンス割り込み・logout で中断された場合、開始時消費分は返却しない
- `reward_items` の付与は `EconomyConfig.max_inventory_slots` と各 `ItemConfig.max_stack` の制約を受け、入りきらない分は `items_dropped` として扱う

## 6. サーバー設定

### 6.1 サーバー設定データ構造

```typescript
interface ServerConfig {
  timezone: string; // IANA timezone 名（例: "Asia/Tokyo"）
  world: WorldConfig;
  movement: MovementConfig;
  conversation: ConversationConfig;
  perception: PerceptionConfig;
  spawn: SpawnConfig;
  map: MapConfig;
  idle_reminder?: IdleReminderConfig; // idle再通知設定（オプション、未設定で無効）
  economy?: EconomyConfig; // 所持金・所持品・item_use の設定
  items?: ItemConfig[]; // アイテムカタログ
}
```

`timezone` はワールドのローカル時刻を決める正本であり、天気取得・通知時刻・観戦 UI 向け `calendar` 生成の基準として使う。値は IANA timezone database の識別子（例: `Asia/Tokyo`）を前提とする。

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

### 6.8 経済設定

```typescript
interface EconomyConfig {
  initial_money?: number; // login時の初期所持金（通貨の最小単位・非負整数）。未設定時は 0
  max_inventory_slots?: number; // 所持品スロット上限。未設定時は無制限
  item_use_duration_ms?: number; // 汎用 item_use の所要時間。未設定時は 600_000
}
```

- `initial_money` は新規登録直後および再ログイン時の未保存エージェントに適用する
- `max_inventory_slots` は `reward_items` や `use-item` 後の所持品数制御に使う
- `item_use_duration_ms` は 03-world-engine.md / 05-actions.md の `item_use` タイマーの正本である

### 6.9 アイテムカタログ

```typescript
type ItemType = "general" | "food" | "drink" | "venue";

interface ItemConfig {
  item_id: string; // 一意なアイテムID
  name: string;
  description: string;
  type: ItemType;
  stackable: boolean;
  max_stack?: number; // stackable = true のときのみ利用
}

interface AgentItem {
  item_id: string;
  quantity: number;
}
```

`ItemType` の意味:

| 値 | 用途 |
|----|------|
| `general` | 汎用使用できる一般アイテム |
| `food` | 汎用使用でき、完了通知で「食べました」を使う |
| `drink` | 汎用使用でき、完了通知で「飲みました」を使う |
| `venue` | 汎用 `use-item` できず、`required_items` を参照するアクション場所案内に使う |

- `ServerConfig.items` は `item_id` ごとの正本カタログであり、`required_items` / `reward_items` / `AgentItem.item_id` はここを参照する
- `stackable = false` のアイテムは 1 件ごとに別スロットとして数える
- `stackable = true` でも `max_stack` を超える数量は別スロットへ分割され、`max_inventory_slots` を超える分は保持できない

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
| 近くのノード | 知覚範囲内の passable ノード（現在地を除く）のIDとラベル |
| エージェント | 知覚範囲内にいる他エージェントの名前と位置 |
| NPC | 知覚範囲内のNPCの名前と位置 |
| 建物 | 知覚範囲内に含まれる建物の名前とドア位置 |

### 7.3 API/MCPで取得する広域情報との境界

Discord通知には知覚範囲内の情報を**テキスト要約**として含める（プッシュ型）。加えて、通知には `選択肢` リストを含め、次に選べる action / move / wait / conversation_start / 各種情報取得をまとめて提示する。

エージェントが知覚・行動候補・広域情報の最新状態を必要とする場合は、API/MCPで能動的に取得を依頼する。API/MCP は即時に `{ ok: true, message: "..." }` を返し、詳細結果は Discord 通知として返送する。

| 情報種別 | 取得方法 | 範囲 |
|---------|---------|------|
| 知覚情報（要約） | Discord通知にテキストとして含める | `PerceptionConfig.range` 以内 |
| 行動候補 | Discord通知の `選択肢` に含める | 現在位置および近傍 |
| 知覚情報の再取得 | API/MCP で依頼し、結果は Discord 通知で受け取る | `PerceptionConfig.range` 以内 |
| マップ全体 | API/MCP で依頼し、結果は Discord 通知で受け取る | マップ全体の要約 |
| エージェント一覧 | API/MCP で依頼し、結果は Discord 通知で受け取る | 世界内の全エージェント |
