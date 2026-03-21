extends Node2D
class_name MapRenderer

var world_state: WorldState
var theme_definition: Dictionary = {}
var theme_name := Globals.DEFAULT_THEME_NAME
var tile_size := 64
var _default_agent_texture: Texture2D

@onready var tile_map = $TileMapLayer
@onready var labels_layer: Node2D = $Labels

func bind_world_state(world_state_node: WorldState) -> void:
    world_state = world_state_node
    world_state.snapshot_replaced.connect(_on_snapshot_replaced)

func load_theme(next_theme_name: String) -> void:
    theme_name = Globals.resolve_theme_name(next_theme_name if next_theme_name != "" else Globals.DEFAULT_THEME_NAME)
    theme_definition = Globals.load_theme_definition(theme_name)
    tile_size = int(theme_definition.get("tile_size", 64))
    _default_agent_texture = load(Globals.resolve_theme_resource(theme_name, str(theme_definition.get("agent_sprite", "sprites/agent.png")))) as Texture2D
    _rebuild_tileset()
    if world_state != null and not world_state.map.is_empty():
        render_map(world_state.map)

func get_default_agent_texture() -> Texture2D:
    return _default_agent_texture

func get_tile_size() -> int:
    return tile_size

func node_id_to_world_position(node_id: String) -> Vector2:
    var coords := node_id_to_grid(node_id)
    return Vector2((coords.x + 0.5) * tile_size, (coords.y + 0.5) * tile_size)

func node_id_to_grid(node_id: String) -> Vector2i:
    var parts := node_id.split("-")
    if parts.size() != 2:
        return Vector2i.ZERO
    return Vector2i(max(int(parts[1]) - 1, 0), max(int(parts[0]) - 1, 0))

func render_map(map_data: Dictionary) -> void:
    if tile_map == null:
        return
    tile_map.clear()
    _clear_labels()

    var rows := int(map_data.get("rows", 0))
    var cols := int(map_data.get("cols", 0))
    for row in range(rows):
        for col in range(cols):
            tile_map.set_cell(Vector2i(col, row), 0, _atlas_for_type("normal"))

    var nodes = map_data.get("nodes", {})
    if typeof(nodes) == TYPE_DICTIONARY:
        for node_id in nodes.keys():
            var node_config = nodes[node_id]
            if typeof(node_config) != TYPE_DICTIONARY:
                continue
            var node_type := str(node_config.get("type", "normal"))
            tile_map.set_cell(node_id_to_grid(str(node_id)), 0, _atlas_for_type(node_type))
            if node_config.has("label"):
                _add_label(str(node_config.get("label", "")), str(node_id), Color(0.96, 0.96, 0.96, 0.92))

    var buildings = map_data.get("buildings", [])
    if typeof(buildings) == TYPE_ARRAY:
        for value in buildings:
            if typeof(value) != TYPE_DICTIONARY:
                continue
            var door_nodes = value.get("door_nodes", [])
            if typeof(door_nodes) == TYPE_ARRAY and not door_nodes.is_empty():
                _add_label(str(value.get("name", "Building")), str(door_nodes[0]), Color(0.82, 0.88, 0.98, 0.95))

    var npcs = map_data.get("npcs", [])
    if typeof(npcs) == TYPE_ARRAY:
        for value in npcs:
            if typeof(value) != TYPE_DICTIONARY:
                continue
            _add_label(str(value.get("name", "NPC")), str(value.get("node_id", "")), Color(0.96, 0.82, 0.60, 0.95))

func _rebuild_tileset() -> void:
    if tile_map == null:
        return

    var tileset_path := Globals.resolve_theme_resource(theme_name, str(theme_definition.get("tileset", "tiles/tileset.png")))
    var texture := load(tileset_path) as Texture2D
    if texture == null:
        return

    var tile_set := TileSet.new()
    var atlas_source := TileSetAtlasSource.new()
    atlas_source.texture = texture
    atlas_source.texture_region_size = Vector2i(tile_size, tile_size)
    var mapping = theme_definition.get("tile_mapping", {})
    if typeof(mapping) == TYPE_DICTIONARY:
        for node_type in mapping.keys():
            var tile_info = mapping[node_type]
            if typeof(tile_info) != TYPE_DICTIONARY:
                continue
            atlas_source.create_tile(Vector2i(int(tile_info.get("atlas_x", 0)), int(tile_info.get("atlas_y", 0))))
    tile_set.add_source(atlas_source, 0)
    tile_map.tile_set = tile_set

func _atlas_for_type(node_type: String) -> Vector2i:
    var mapping = theme_definition.get("tile_mapping", {})
    if typeof(mapping) == TYPE_DICTIONARY and mapping.has(node_type):
        var tile_info = mapping[node_type]
        if typeof(tile_info) == TYPE_DICTIONARY:
            return Vector2i(int(tile_info.get("atlas_x", 0)), int(tile_info.get("atlas_y", 0)))
    return Vector2i.ZERO

func _add_label(text: String, node_id: String, color: Color) -> void:
    if text == "":
        return
    var label := Label.new()
    label.text = text
    label.position = node_id_to_world_position(node_id) + Vector2(-0.45 * tile_size, -0.62 * tile_size)
    label.add_theme_color_override("font_color", color)
    labels_layer.add_child(label)

func _clear_labels() -> void:
    for child in labels_layer.get_children():
        child.queue_free()

func _on_snapshot_replaced(_snapshot: Dictionary) -> void:
    if world_state == null:
        return
    render_map(world_state.map)
