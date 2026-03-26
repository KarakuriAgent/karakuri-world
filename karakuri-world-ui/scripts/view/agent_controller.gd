extends Node2D
class_name AgentController

const AGENT_SCENE := preload("res://scenes/components/agent_sprite.tscn")

var world_state: WorldState
var map_renderer: MapRenderer
var _agent_nodes: Dictionary = {}
var _movement_tweens: Dictionary = {}
var _avatar_requests: Dictionary = {}
var _default_texture: Texture2D

func bind(world_state_node: WorldState, map_renderer_node: MapRenderer) -> void:
    world_state = world_state_node
    map_renderer = map_renderer_node
    world_state.snapshot_replaced.connect(_on_snapshot_replaced)
    world_state.event_applied.connect(_on_event_applied)
    world_state.agent_avatar_updated.connect(_on_agent_avatar_updated)
    world_state.overlays_cleared.connect(_on_overlays_cleared)

func load_theme(_theme_name: String) -> void:
    if map_renderer != null:
        _default_texture = map_renderer.get_default_agent_texture()
    _sync_agents(false)

func has_agent(agent_id: String) -> bool:
    return _agent_nodes.has(agent_id)

func get_agent_position(agent_id: String) -> Vector2:
    if not _agent_nodes.has(agent_id):
        return Vector2.ZERO
    return _agent_nodes[agent_id].global_position

func get_agent_canvas_position(agent_id: String) -> Vector2:
    if not _agent_nodes.has(agent_id):
        return Vector2.ZERO
    var agent_node: Node2D = _agent_nodes[agent_id]
    return agent_node.get_global_transform_with_canvas().origin

func _on_snapshot_replaced(_snapshot: Dictionary) -> void:
    _sync_agents(true)

func _on_event_applied(_event: Dictionary) -> void:
    _sync_agents(false)

func _on_agent_avatar_updated(agent_id: String, texture: Texture2D) -> void:
    if not _agent_nodes.has(agent_id):
        return
    var agent_node: Node2D = _agent_nodes[agent_id]
    var sprite: Sprite2D = agent_node.get_node("Sprite2D")
    sprite.texture = texture

func _on_overlays_cleared() -> void:
    for agent_id in _movement_tweens.keys():
        var tween: Variant = _movement_tweens[agent_id]
        if tween != null:
            tween.kill()
    _movement_tweens.clear()

func _sync_agents(animate_spawn: bool) -> void:
    if world_state == null or map_renderer == null:
        return

    var active_ids: Dictionary = {}
    var offsets := _build_offsets(world_state.get_agents_sorted())
    for agent_data in world_state.get_agents_sorted():
        if typeof(agent_data) != TYPE_DICTIONARY:
            continue
        var agent_id := str(agent_data.get("agent_id", ""))
        active_ids[agent_id] = true

        var agent_node: Node2D = _agent_nodes.get(agent_id)
        if agent_node == null:
            agent_node = AGENT_SCENE.instantiate()
            agent_node.name = "Agent_%s" % agent_id
            add_child(agent_node)
            _agent_nodes[agent_id] = agent_node
            if animate_spawn:
                _play_spawn(agent_node)

        _apply_agent(agent_id, agent_node, agent_data, offsets.get(agent_id, Vector2.ZERO))

    for agent_id in _agent_nodes.keys().duplicate():
        if active_ids.has(agent_id):
            continue
        _remove_agent(agent_id)

func _apply_agent(agent_id: String, agent_node: Node2D, agent_data: Dictionary, offset: Vector2) -> void:
    agent_node.set_meta("node_offset", offset)
    var sprite: Sprite2D = agent_node.get_node("Sprite2D")
    var name_label: Label = agent_node.get_node("NameLabel")
    var state_label: Label = agent_node.get_node("StateLabel")
    name_label.text = str(agent_data.get("agent_name", agent_id))
    state_label.text = _build_state_text(agent_data)
    _apply_state_style(sprite, str(agent_data.get("state", "idle")))
    _apply_texture(agent_id, sprite, agent_data)

    if str(agent_data.get("state", "idle")) == "moving" and typeof(agent_data.get("movement", {})) == TYPE_DICTIONARY:
        _restore_movement(agent_id, agent_node, agent_data, offset)
    else:
        _stop_movement(agent_id)
        agent_node.position = map_renderer.node_id_to_world_position(str(agent_data.get("node_id", ""))) + offset

func _apply_texture(agent_id: String, sprite: Sprite2D, agent_data: Dictionary) -> void:
    var avatar_texture: Variant = agent_data.get("avatar_texture", null)
    if avatar_texture != null:
        sprite.texture = avatar_texture
        return

    sprite.texture = _default_texture
    var avatar_url: Variant = agent_data.get("avatar_url", null)
    if avatar_url != null and str(avatar_url) != "":
        _request_avatar(agent_id, str(avatar_url))

func _request_avatar(agent_id: String, avatar_url: String) -> void:
    if world_state == null or _avatar_requests.has(agent_id):
        return
    if world_state.connection_settings.is_empty():
        return

    var request := HTTPRequest.new()
    add_child(request)
    _avatar_requests[agent_id] = request
    request.request_completed.connect(_on_avatar_request_completed.bind(agent_id, request))
    var error := request.request(Globals.build_http_url(world_state.connection_settings, avatar_url))
    if error != OK:
        _avatar_requests.erase(agent_id)
        request.queue_free()

func _on_avatar_request_completed(result: int, response_code: int, headers: PackedStringArray, body: PackedByteArray, agent_id: String, request: HTTPRequest) -> void:
    _avatar_requests.erase(agent_id)
    if is_instance_valid(request):
        request.queue_free()

    if result != HTTPRequest.RESULT_SUCCESS or response_code < 200 or response_code >= 300:
        return

    var image := Image.new()
    var content_type := _read_header(headers, "content-type")
    var error := ERR_FILE_UNRECOGNIZED
    if content_type.contains("jpeg") or content_type.contains("jpg"):
        error = image.load_jpg_from_buffer(body)
    elif content_type.contains("png"):
        error = image.load_png_from_buffer(body)
    else:
        error = image.load_png_from_buffer(body)
        if error != OK:
            error = image.load_jpg_from_buffer(body)

    if error != OK:
        return

    var texture := ImageTexture.create_from_image(image)
    world_state.apply_avatar_texture(agent_id, texture)

func _restore_movement(agent_id: String, agent_node: Node2D, agent_data: Dictionary, offset: Vector2) -> void:
    _stop_movement(agent_id)
    var movement: Variant = agent_data.get("movement", {})
    if typeof(movement) != TYPE_DICTIONARY:
        agent_node.position = map_renderer.node_id_to_world_position(str(agent_data.get("node_id", ""))) + offset
        return

    var current_node_id := str(agent_data.get("node_id", movement.get("from_node_id", "")))
    var path: Variant = movement.get("path", [])
    var remaining_nodes := []
    var current_found := current_node_id == str(movement.get("from_node_id", ""))
    if typeof(path) == TYPE_ARRAY:
        for node_id in path:
            var next_node_id := str(node_id)
            if next_node_id == current_node_id:
                current_found = true
                continue
            if current_found:
                remaining_nodes.append(next_node_id)
    if remaining_nodes.is_empty() and str(movement.get("to_node_id", "")) != current_node_id:
        remaining_nodes.append(str(movement.get("to_node_id", current_node_id)))

    agent_node.position = map_renderer.node_id_to_world_position(current_node_id) + offset
    if remaining_nodes.is_empty():
        return

    var now_ms := int(Time.get_unix_time_from_system() * 1000.0)
    var remaining_ms: int = max(int(movement.get("arrives_at", now_ms)) - now_ms, 0)
    if remaining_ms <= 0:
        agent_node.position = map_renderer.node_id_to_world_position(str(remaining_nodes[-1])) + offset
        return

    var tween: Variant = create_tween()
    var step_duration: float = float(remaining_ms) / 1000.0 / float(max(remaining_nodes.size(), 1))
    for node_id in remaining_nodes:
        tween.tween_property(agent_node, "position", map_renderer.node_id_to_world_position(str(node_id)) + offset, step_duration)
    _movement_tweens[agent_id] = tween

func _stop_movement(agent_id: String) -> void:
    if not _movement_tweens.has(agent_id):
        return
    var tween: Variant = _movement_tweens[agent_id]
    if tween != null:
        tween.kill()
    _movement_tweens.erase(agent_id)

func _remove_agent(agent_id: String) -> void:
    _stop_movement(agent_id)
    if _avatar_requests.has(agent_id):
        var request: Variant = _avatar_requests[agent_id]
        if is_instance_valid(request):
            request.queue_free()
        _avatar_requests.erase(agent_id)
    var agent_node: Variant = _agent_nodes[agent_id]
    _agent_nodes.erase(agent_id)
    if is_instance_valid(agent_node):
        var fade_tween: Variant = create_tween()
        fade_tween.tween_property(agent_node, "modulate:a", 0.0, 0.18)
        fade_tween.tween_callback(agent_node.queue_free)

func _build_offsets(sorted_agents: Array) -> Dictionary:
    var grouped: Dictionary = {}
    for agent_data in sorted_agents:
        if typeof(agent_data) != TYPE_DICTIONARY:
            continue
        var node_id := str(agent_data.get("node_id", ""))
        if not grouped.has(node_id):
            grouped[node_id] = []
        grouped[node_id].append(str(agent_data.get("agent_id", "")))

    var offsets: Dictionary = {}
    for node_id in grouped.keys():
        var agent_ids: Variant = grouped[node_id]
        for index in range(agent_ids.size()):
            offsets[agent_ids[index]] = _offset_for_index(index, agent_ids.size())
    return offsets

func _offset_for_index(index: int, total: int) -> Vector2:
    if total <= 1:
        return Vector2.ZERO
    var radius: float = max(map_renderer.get_tile_size() * 0.14, 10.0)
    var angle := (TAU / total) * index
    return Vector2(cos(angle), sin(angle)) * radius

func _build_state_text(agent_data: Dictionary) -> String:
    var state := str(agent_data.get("state", "idle"))
    var current_action: Variant = agent_data.get("current_action", {})
    if typeof(current_action) == TYPE_DICTIONARY and current_action.has("action_name") and str(current_action.get("action_name", "")) != "":
        return "%s · %s" % [state, current_action.get("action_name", "")]
    var selection: Variant = agent_data.get("last_selection", {})
    if typeof(selection) == TYPE_DICTIONARY and selection.has("choice_label"):
        return "%s · %s" % [state, selection.get("choice_label", "")]
    return state

func _apply_state_style(sprite: Sprite2D, state: String) -> void:
    match state:
        "moving":
            sprite.modulate = Color(1.0, 0.95, 0.74, 1.0)
        "in_action":
            sprite.modulate = Color(0.78, 0.88, 1.0, 1.0)
        "in_conversation":
            sprite.modulate = Color(0.82, 1.0, 0.84, 1.0)
        _:
            sprite.modulate = Color(1.0, 1.0, 1.0, 1.0)

func _read_header(headers: PackedStringArray, header_name: String) -> String:
    for header in headers:
        var lower := header.to_lower()
        if lower.begins_with(header_name + ":"):
            return lower.split(":", false, 1)[1].strip_edges()
    return ""

func _play_spawn(agent_node: Node2D) -> void:
    agent_node.modulate = Color(1.0, 1.0, 1.0, 0.0)
    var tween: Variant = create_tween()
    tween.tween_property(agent_node, "modulate:a", 1.0, 0.18)
