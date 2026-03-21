extends HBoxContainer
class_name StatusBarPanel

var world_state: WorldState

@onready var connection_value: Label = $ConnectionValue
@onready var world_value: Label = $WorldValue
@onready var agents_value: Label = $AgentsValue
@onready var message_value: Label = $MessageValue

func bind_world_state(world_state_node: WorldState) -> void:
    world_state = world_state_node
    world_state.connection_state_changed.connect(_refresh)
    world_state.snapshot_replaced.connect(_refresh)
    world_state.event_applied.connect(_refresh)
    _refresh()

func _refresh(_arg = null, _arg2 = null) -> void:
    if world_state == null:
        return
    connection_value.text = world_state.connection_state
    world_value.text = world_state.get_world_name() if world_state.get_world_name() != "" else "—"
    agents_value.text = str(world_state.get_agent_count())
    message_value.text = world_state.connection_message if world_state.connection_message != "" else "Ready"
