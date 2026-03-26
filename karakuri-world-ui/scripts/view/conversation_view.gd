extends Node2D
class_name ConversationView

const SPEECH_BUBBLE_SCENE := preload("res://scenes/components/speech_bubble.tscn")
const RECEIVE_ICON_TEXT := "..."
const BUBBLE_BASE_OFFSET := Vector2(-12.0, -82.0)
const BUBBLE_STACK_SPACING := 72.0
const RECEIVE_ICON_BASE_OFFSET := Vector2(26.0, -72.0)
const RECEIVE_ICON_STACK_SPACING := 28.0

var world_state: WorldState
var agent_controller: AgentController
var _bubble_nodes: Dictionary = {}
var _receive_icon_nodes: Dictionary = {}

func bind(world_state_node: WorldState, agent_controller_node: AgentController) -> void:
    world_state = world_state_node
    agent_controller = agent_controller_node
    world_state.snapshot_replaced.connect(_refresh)
    world_state.event_applied.connect(_refresh)
    world_state.overlays_cleared.connect(_clear_all)
    set_process(true)
    _refresh()

func _process(_delta: float) -> void:
    if world_state == null or agent_controller == null:
        return
    if world_state.conversations.is_empty():
        return
    _reposition_overlays()
    queue_redraw()

func _draw() -> void:
    if world_state == null or agent_controller == null:
        return

    for conversation in world_state.conversations.values():
        if typeof(conversation) != TYPE_DICTIONARY:
            continue
        if str(conversation.get("status", "")) != "active":
            continue

        var initiator := str(conversation.get("initiator_agent_id", ""))
        var target := str(conversation.get("target_agent_id", ""))
        if not agent_controller.has_agent(initiator) or not agent_controller.has_agent(target):
            continue

        draw_line(
            to_local(agent_controller.get_agent_position(initiator)),
            to_local(agent_controller.get_agent_position(target)),
            Color(1.0, 1.0, 1.0, 0.45),
            3.0,
            true
        )

func _refresh(_payload = null) -> void:
    if world_state == null or agent_controller == null:
        return

    var bubble_style := _load_bubble_style()
    var active_bubbles: Dictionary = {}
    var active_icons: Dictionary = {}

    for conversation_id in world_state.conversations.keys():
        var conversation: Variant = world_state.conversations[conversation_id]
        if typeof(conversation) != TYPE_DICTIONARY:
            continue

        var text := _message_for_conversation(conversation)
        if text != "":
            active_bubbles[conversation_id] = true
            var bubble: Node2D = _bubble_nodes.get(conversation_id)
            if bubble == null:
                bubble = SPEECH_BUBBLE_SCENE.instantiate()
                add_child(bubble)
                _bubble_nodes[conversation_id] = bubble
            _apply_bubble_style(bubble, text, bubble_style)

        var receive_icon_agent_id := _receive_icon_agent_id(conversation)
        if receive_icon_agent_id != "":
            active_icons[conversation_id] = true
            var receive_icon: PanelContainer = _receive_icon_nodes.get(conversation_id)
            if receive_icon == null:
                receive_icon = _create_receive_icon()
                add_child(receive_icon)
                _receive_icon_nodes[conversation_id] = receive_icon
            _apply_receive_icon_style(receive_icon, bubble_style)

    for conversation_id in _bubble_nodes.keys().duplicate():
        if active_bubbles.has(conversation_id):
            continue
        _queue_free_if_valid(_bubble_nodes[conversation_id])
        _bubble_nodes.erase(conversation_id)

    for conversation_id in _receive_icon_nodes.keys().duplicate():
        if active_icons.has(conversation_id):
            continue
        _queue_free_if_valid(_receive_icon_nodes[conversation_id])
        _receive_icon_nodes.erase(conversation_id)

    _reposition_overlays()
    queue_redraw()

func _apply_bubble_style(bubble: Node2D, text: String, bubble_style: Dictionary) -> void:
    var message_label: Label = bubble.get_node("Panel/MessageMargin/MessageLabel")
    message_label.text = _truncate_text(text, int(bubble_style.get("max_chars", 80)))
    message_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
    message_label.add_theme_color_override("font_color", bubble_style.get("text_color", Color(0.11, 0.11, 0.11)))

    var panel: PanelContainer = bubble.get_node("Panel")
    panel.self_modulate = bubble_style.get("bg_color", Color(0.96, 0.95, 0.91))

func _apply_receive_icon_style(receive_icon: PanelContainer, bubble_style: Dictionary) -> void:
    receive_icon.self_modulate = bubble_style.get("bg_color", Color(0.96, 0.95, 0.91))
    var label: Label = receive_icon.get_node("MessageMargin/MessageLabel")
    label.add_theme_color_override("font_color", bubble_style.get("text_color", Color(0.11, 0.11, 0.11)))

func _reposition_overlays() -> void:
    if world_state == null or agent_controller == null:
        return

    var bubble_stack_counts: Dictionary = {}
    var icon_stack_counts: Dictionary = {}
    for conversation_id in world_state.conversations.keys():
        var conversation: Variant = world_state.conversations[conversation_id]
        if typeof(conversation) != TYPE_DICTIONARY:
            continue

        if _bubble_nodes.has(conversation_id):
            var speaker_agent_id := _speaker_agent_id(conversation)
            var bubble_stack_index := int(bubble_stack_counts.get(speaker_agent_id, 0))
            _position_bubble(conversation_id, speaker_agent_id, bubble_stack_index)
            bubble_stack_counts[speaker_agent_id] = bubble_stack_index + 1

        if _receive_icon_nodes.has(conversation_id):
            var receive_icon_agent_id := _receive_icon_agent_id(conversation)
            var icon_stack_index := int(icon_stack_counts.get(receive_icon_agent_id, 0))
            _position_receive_icon(conversation_id, receive_icon_agent_id, icon_stack_index)
            icon_stack_counts[receive_icon_agent_id] = icon_stack_index + 1

func _position_bubble(conversation_id: String, speaker_agent_id: String, stack_index: int) -> void:
    if speaker_agent_id == "" or not _bubble_nodes.has(conversation_id) or not agent_controller.has_agent(speaker_agent_id):
        return

    var bubble: Node2D = _bubble_nodes[conversation_id]
    bubble.global_position = agent_controller.get_agent_position(speaker_agent_id) + BUBBLE_BASE_OFFSET + Vector2(0.0, -BUBBLE_STACK_SPACING * stack_index)

func _position_receive_icon(conversation_id: String, agent_id: String, stack_index: int) -> void:
    if agent_id == "" or not _receive_icon_nodes.has(conversation_id) or not agent_controller.has_agent(agent_id):
        return

    var receive_icon: PanelContainer = _receive_icon_nodes[conversation_id]
    receive_icon.global_position = agent_controller.get_agent_position(agent_id) + RECEIVE_ICON_BASE_OFFSET + Vector2(0.0, -RECEIVE_ICON_STACK_SPACING * stack_index)

func _speaker_agent_id(conversation: Dictionary) -> String:
    var messages: Variant = conversation.get("messages", [])
    if typeof(messages) == TYPE_ARRAY and not messages.is_empty():
        var last_message: Variant = messages[messages.size() - 1]
        if typeof(last_message) == TYPE_DICTIONARY:
            return str(last_message.get("speaker_agent_id", conversation.get("initiator_agent_id", "")))
    return str(conversation.get("initiator_agent_id", ""))

func _receive_icon_agent_id(conversation: Dictionary) -> String:
    if str(conversation.get("status", "")) != "pending":
        return ""
    return str(conversation.get("target_agent_id", conversation.get("current_speaker_agent_id", "")))

func _message_for_conversation(conversation: Dictionary) -> String:
    var messages: Variant = conversation.get("messages", [])
    if typeof(messages) != TYPE_ARRAY or messages.is_empty():
        return ""

    var last_message: Variant = messages[messages.size() - 1]
    if typeof(last_message) != TYPE_DICTIONARY:
        return ""
    return str(last_message.get("text", ""))

func _truncate_text(text: String, max_chars: int) -> String:
    if max_chars <= 0 or text.length() <= max_chars:
        return text
    if max_chars == 1:
        return "…"
    return "%s…" % text.substr(0, max_chars - 1)

func _load_bubble_style() -> Dictionary:
    var theme_definition := Globals.load_theme_definition(world_state.active_theme)
    var speech_bubble: Variant = theme_definition.get("speech_bubble", {})
    return {
        "max_chars": max(int(speech_bubble.get("max_chars", 80)), 8),
        "bg_color": _color_from_value(speech_bubble.get("bg_color", "#F5F3E8"), Color(0.96, 0.95, 0.91)),
        "text_color": _color_from_value(speech_bubble.get("text_color", "#1C1C1C"), Color(0.11, 0.11, 0.11)),
    }

func _color_from_value(value, fallback: Color) -> Color:
    return Color.from_string(str(value), fallback)

func _create_receive_icon() -> PanelContainer:
    var receive_icon := PanelContainer.new()
    receive_icon.name = "ReceiveIcon"
    receive_icon.custom_minimum_size = Vector2(36.0, 24.0)

    var margin := MarginContainer.new()
    margin.name = "MessageMargin"
    margin.add_theme_constant_override("margin_left", 8)
    margin.add_theme_constant_override("margin_top", 4)
    margin.add_theme_constant_override("margin_right", 8)
    margin.add_theme_constant_override("margin_bottom", 4)
    receive_icon.add_child(margin)

    var label := Label.new()
    label.name = "MessageLabel"
    label.text = RECEIVE_ICON_TEXT
    label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
    margin.add_child(label)

    return receive_icon

func _queue_free_if_valid(node: Node) -> void:
    if is_instance_valid(node):
        node.queue_free()

func _clear_all() -> void:
    for bubble in _bubble_nodes.values():
        _queue_free_if_valid(bubble)
    _bubble_nodes.clear()

    for receive_icon in _receive_icon_nodes.values():
        _queue_free_if_valid(receive_icon)
    _receive_icon_nodes.clear()

    queue_redraw()
