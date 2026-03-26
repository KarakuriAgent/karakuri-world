extends VBoxContainer
class_name AgentListPanel

signal agent_selected(agent_id: String)

var world_state: WorldState
var default_icon: Texture2D

@onready var title_label: Label = $TitleLabel
@onready var agent_items: ItemList = $AgentItems

func _ready() -> void:
    agent_items.item_selected.connect(_on_item_selected)

func bind_world_state(world_state_node: WorldState) -> void:
    world_state = world_state_node
    world_state.snapshot_replaced.connect(_refresh)
    world_state.event_applied.connect(_refresh)
    world_state.connection_state_changed.connect(_refresh)
    world_state.agent_avatar_updated.connect(_on_avatar_updated)
    _refresh()

func set_default_icon(texture: Texture2D) -> void:
    default_icon = texture
    _refresh()

func _on_avatar_updated(_agent_id: String, _texture: Texture2D) -> void:
    _refresh()

func _refresh(_arg = null, _arg2 = null) -> void:
    if world_state == null or agent_items == null:
        return
    title_label.text = "Agents (%d)" % [world_state.get_agent_count()]
    agent_items.clear()
    for agent_data in world_state.get_agents_sorted():
        if typeof(agent_data) != TYPE_DICTIONARY:
            continue
        var text := "%s  [%s]  %s" % [
            str(agent_data.get("agent_name", "agent")),
            str(agent_data.get("state", "idle")),
            str(agent_data.get("node_id", "?")),
        ]
        var icon: Variant = agent_data.get("avatar_texture", null)
        if icon == null:
            icon = default_icon
        if icon == null:
            agent_items.add_item(text)
        else:
            agent_items.add_item(text, icon)
        var index := agent_items.get_item_count() - 1
        agent_items.set_item_metadata(index, str(agent_data.get("agent_id", "")))

func _on_item_selected(index: int) -> void:
    var metadata: Variant = agent_items.get_item_metadata(index)
    if metadata == null:
        return
    agent_selected.emit(str(metadata))
