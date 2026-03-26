extends Node

const SETTINGS_FILE_PATH := "user://settings.cfg"
const DEFAULT_THEME_NAME := "default"
const DEFAULT_WS_PATH := "/ws"
const DEFAULT_SNAPSHOT_PATH := "/api/snapshot"

var _theme_cache: Dictionary = {}

func get_default_connection_settings() -> Dictionary:
	return {
		"host": "127.0.0.1",
		"port": 3000,
		"secure": false,
		"admin_key": "",
		"theme": DEFAULT_THEME_NAME,
		"ws_path": DEFAULT_WS_PATH,
		"snapshot_path": DEFAULT_SNAPSHOT_PATH,
	}

func load_connection_settings() -> Dictionary:
	var settings := get_default_connection_settings()
	var config := ConfigFile.new()
	var error := config.load(SETTINGS_FILE_PATH)
	if error != OK:
		return settings

	for key in ["host", "port", "secure", "admin_key", "ws_path", "snapshot_path"]:
		if config.has_section_key("connection", key):
			settings[key] = config.get_value("connection", key, settings[key])

	if config.has_section_key("ui", "theme"):
		settings["theme"] = config.get_value("ui", "theme", settings["theme"])

	settings["host"] = str(settings.get("host", "127.0.0.1"))
	settings["port"] = int(settings.get("port", 3000))
	settings["secure"] = bool(settings.get("secure", false))
	settings["admin_key"] = str(settings.get("admin_key", ""))
	settings["theme"] = str(settings.get("theme", DEFAULT_THEME_NAME))
	settings["ws_path"] = _normalize_path(str(settings.get("ws_path", DEFAULT_WS_PATH)))
	settings["snapshot_path"] = _normalize_path(str(settings.get("snapshot_path", DEFAULT_SNAPSHOT_PATH)))
	return settings

func save_connection_settings(settings: Dictionary) -> void:
	var sanitized := get_default_connection_settings()
	for key in sanitized.keys():
		if settings.has(key):
			sanitized[key] = settings[key]

	sanitized["host"] = str(sanitized.get("host", "127.0.0.1"))
	sanitized["port"] = int(sanitized.get("port", 3000))
	sanitized["secure"] = bool(sanitized.get("secure", false))
	sanitized["admin_key"] = str(sanitized.get("admin_key", ""))
	sanitized["theme"] = str(sanitized.get("theme", DEFAULT_THEME_NAME))
	sanitized["ws_path"] = _normalize_path(str(sanitized.get("ws_path", DEFAULT_WS_PATH)))
	sanitized["snapshot_path"] = _normalize_path(str(sanitized.get("snapshot_path", DEFAULT_SNAPSHOT_PATH)))

	var config := ConfigFile.new()
	for key in ["host", "port", "secure", "admin_key", "ws_path", "snapshot_path"]:
		config.set_value("connection", key, sanitized[key])
	config.set_value("ui", "theme", sanitized["theme"])
	config.save(SETTINGS_FILE_PATH)

func build_ws_url(settings: Dictionary) -> String:
	var scheme := "wss" if bool(settings.get("secure", false)) else "ws"
	return "%s://%s:%d%s" % [
		scheme,
		str(settings.get("host", "127.0.0.1")),
		int(settings.get("port", 3000)),
		_normalize_path(str(settings.get("ws_path", DEFAULT_WS_PATH))),
	]

func build_http_url(settings: Dictionary, path: String) -> String:
	if path.begins_with("http://") or path.begins_with("https://"):
		return path

	var scheme := "https" if bool(settings.get("secure", false)) else "http"
	return "%s://%s:%d%s" % [
		scheme,
		str(settings.get("host", "127.0.0.1")),
		int(settings.get("port", 3000)),
		_normalize_path(path),
	]

func get_theme_root(theme_name: String) -> String:
	return "res://themes/%s" % [theme_name]

func get_theme_json_path(theme_name: String) -> String:
	return "%s/theme.json" % [get_theme_root(theme_name)]

func resolve_theme_resource(theme_name: String, relative_path: String) -> String:
	return "%s/%s" % [get_theme_root(theme_name), _trim_leading_slash(relative_path)]

func resolve_theme_name(theme_name: String) -> String:
	if theme_name == "" or not FileAccess.file_exists(get_theme_json_path(theme_name)):
		return DEFAULT_THEME_NAME
	return theme_name

func load_theme_definition(theme_name: String) -> Dictionary:
	var resolved_theme := resolve_theme_name(theme_name)
	var path := get_theme_json_path(resolved_theme)

	if _theme_cache.has(resolved_theme):
		return _theme_cache[resolved_theme].duplicate(true)

	var definition := {
		"name": "Default",
		"tile_size": 64,
		"tileset": "tiles/tileset.png",
		"tile_mapping": {
			"normal": {"atlas_x": 0, "atlas_y": 0},
			"wall": {"atlas_x": 1, "atlas_y": 0},
			"door": {"atlas_x": 2, "atlas_y": 0},
			"building_interior": {"atlas_x": 3, "atlas_y": 0},
			"npc": {"atlas_x": 4, "atlas_y": 0},
		},
		"agent_sprite": "sprites/agent.png",
		"speech_bubble": {
			"max_chars": 80,
			"bg_color": "#F5F3E8",
			"text_color": "#1C1C1C",
		},
		"effects": {},
	}

	var file := FileAccess.open(path, FileAccess.READ)
	if file != null:
		var parsed: Variant = JSON.parse_string(file.get_as_text())
		if typeof(parsed) == TYPE_DICTIONARY:
			for key in parsed.keys():
				definition[key] = parsed[key]

	_theme_cache[resolved_theme] = definition.duplicate(true)
	return definition.duplicate(true)

func _normalize_path(value: String) -> String:
	if value == "":
		return "/"
	return value if value.begins_with("/") else "/%s" % [value]

func _trim_leading_slash(value: String) -> String:
	if value.begins_with("/"):
		return value.substr(1)
	return value
