extends CanvasLayer
class_name ServerEventFX

const EVENT_BANNER_SCENE := preload("res://scenes/components/event_banner.tscn")
const BANNER_DISPLAY_SECONDS := 3.0
const SELECTION_DISPLAY_SECONDS := 2.5
const SELECTION_BASE_OFFSET := Vector2(0.0, -96.0)
const SELECTION_STACK_SPACING := 28.0
const FALLBACK_SELECTION_START := Vector2(24.0, 208.0)

var world_state: WorldState
var agent_controller: AgentController
var _effect_layer: Node

@onready var banner_stack: VBoxContainer = $BannerContainer/BannerStack
@onready var selection_layer: Control = $SelectionLayer

func _ready() -> void:
    _effect_layer = get_node_or_null("EffectLayer")
    if _effect_layer == null:
        _effect_layer = Node.new()
        _effect_layer.name = "EffectLayer"
        add_child(_effect_layer)
        move_child(_effect_layer, 0)
    set_process(true)

func bind(world_state_node: WorldState, agent_controller_node: AgentController) -> void:
    world_state = world_state_node
    agent_controller = agent_controller_node
    world_state.event_applied.connect(_on_event_applied)
    world_state.overlays_cleared.connect(_clear_overlays)

func _process(_delta: float) -> void:
    if agent_controller == null:
        return

    var selection_counts: Dictionary = {}
    var fallback_index := 0
    for child in selection_layer.get_children():
        if not (child is Control):
            continue

        var chip: Control = child
        var agent_id := str(chip.get_meta("agent_id", ""))
        if agent_id != "" and agent_controller.has_agent(agent_id):
            var stack_index := int(selection_counts.get(agent_id, 0))
            chip.position = _selection_position(agent_id, chip, stack_index)
            selection_counts[agent_id] = stack_index + 1
        else:
            chip.position = FALLBACK_SELECTION_START + Vector2(0.0, fallback_index * SELECTION_STACK_SPACING)
            fallback_index += 1

func _on_event_applied(event: Dictionary) -> void:
    match str(event.get("type", "")):
        "server_event_fired":
            _show_banner(event)
            _play_theme_effect(str(event.get("event_id_ref", "")))
        "server_event_selected":
            _show_selection(event)

func _show_banner(event: Dictionary) -> void:
    var banner: PanelContainer = EVENT_BANNER_SCENE.instantiate()
    var title_label: Label = banner.get_node("Content/VBoxContainer/TitleLabel")
    var description_label: Label = banner.get_node("Content/VBoxContainer/DescriptionLabel")

    title_label.text = str(event.get("name", event.get("event_id_ref", "Server Event")))
    description_label.text = str(event.get("description", ""))
    description_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART

    banner_stack.add_child(banner)
    banner.modulate = Color(1.0, 1.0, 1.0, 0.0)

    var tween = create_tween()
    tween.tween_property(banner, "modulate:a", 1.0, 0.12)
    tween.tween_interval(BANNER_DISPLAY_SECONDS)
    tween.tween_property(banner, "modulate:a", 0.0, 0.4)
    tween.tween_callback(_queue_free_if_valid.bind(banner))

func _show_selection(event: Dictionary) -> void:
    var chip := _create_selection_chip(str(event.get("choice_label", "Selected")))
    chip.set_meta("agent_id", str(event.get("agent_id", "")))
    selection_layer.add_child(chip)
    chip.position = _selection_position(str(event.get("agent_id", "")), chip, 0)

    chip.modulate = Color(1.0, 1.0, 1.0, 0.0)
    var tween = create_tween()
    tween.tween_property(chip, "modulate:a", 1.0, 0.12)
    tween.tween_interval(SELECTION_DISPLAY_SECONDS)
    tween.tween_property(chip, "modulate:a", 0.0, 0.35)
    tween.tween_callback(_queue_free_if_valid.bind(chip))

func _selection_position(agent_id: String, chip: Control, stack_index: int) -> Vector2:
    if agent_controller == null or agent_id == "" or not agent_controller.has_agent(agent_id):
        return FALLBACK_SELECTION_START + Vector2(0.0, stack_index * SELECTION_STACK_SPACING)

    var screen_position := agent_controller.get_agent_canvas_position(agent_id) + SELECTION_BASE_OFFSET + Vector2(0.0, -SELECTION_STACK_SPACING * stack_index)
    return screen_position - Vector2(chip.get_combined_minimum_size().x * 0.5, 0.0)

func _create_selection_chip(text: String) -> PanelContainer:
    var chip := PanelContainer.new()
    chip.custom_minimum_size = Vector2(96.0, 28.0)
    chip.self_modulate = Color(0.19, 0.20, 0.28, 0.9)

    var margin := MarginContainer.new()
    margin.add_theme_constant_override("margin_left", 10)
    margin.add_theme_constant_override("margin_top", 4)
    margin.add_theme_constant_override("margin_right", 10)
    margin.add_theme_constant_override("margin_bottom", 4)
    chip.add_child(margin)

    var label := Label.new()
    label.text = text
    label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
    label.add_theme_color_override("font_color", Color(1.0, 0.95, 0.7, 1.0))
    margin.add_child(label)

    return chip

func _play_theme_effect(event_id_ref: String) -> void:
    if world_state == null or _effect_layer == null or event_id_ref == "":
        return

    var theme_definition := Globals.load_theme_definition(world_state.active_theme)
    var effects = theme_definition.get("effects", {})
    if typeof(effects) != TYPE_DICTIONARY or not effects.has(event_id_ref):
        return

    var effect_path := Globals.resolve_theme_resource(world_state.active_theme, str(effects[event_id_ref]))
    var effect_scene := load(effect_path) as PackedScene
    if effect_scene == null:
        return

    var effect_instance := effect_scene.instantiate()
    _effect_layer.add_child(effect_instance)

    if effect_instance is Control:
        var effect_control: Control = effect_instance
        effect_control.anchor_right = 1.0
        effect_control.anchor_bottom = 1.0

    var cleanup_tween = create_tween()
    cleanup_tween.tween_interval(BANNER_DISPLAY_SECONDS + 0.5)
    cleanup_tween.tween_callback(_queue_free_if_valid.bind(effect_instance))

func _queue_free_if_valid(node: Node) -> void:
    if is_instance_valid(node):
        node.queue_free()

func _clear_overlays() -> void:
    for child in banner_stack.get_children():
        _queue_free_if_valid(child)
    for child in selection_layer.get_children():
        _queue_free_if_valid(child)
    if _effect_layer != null:
        for child in _effect_layer.get_children():
            _queue_free_if_valid(child)
