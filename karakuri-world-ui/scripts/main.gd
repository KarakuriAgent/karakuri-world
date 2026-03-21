extends Node2D

@onready var ws_client: WSClient = $WSClient
@onready var reconnect: ReconnectHelper = $Reconnect
@onready var world_state: WorldState = $WorldState
@onready var event_processor: EventProcessor = $EventProcessor
@onready var map_renderer: MapRenderer = $MapRenderer
@onready var agent_controller: AgentController = $AgentController
@onready var conversation_view: ConversationView = $ConversationView
@onready var server_event_fx: ServerEventFX = $ServerEventFX
@onready var camera: Camera2D = $Camera2D
@onready var connection_label: Label = $UI/Root/ConnectionBar/ConnectionBarMargin/ConnectionBarRow/ConnectionLabel
@onready var connect_button: Button = $UI/Root/ConnectionBar/ConnectionBarMargin/ConnectionBarRow/ConnectButton
@onready var disconnect_button: Button = $UI/Root/ConnectionBar/ConnectionBarMargin/ConnectionBarRow/DisconnectButton
@onready var settings_button: Button = $UI/Root/ConnectionBar/ConnectionBarMargin/ConnectionBarRow/SettingsButton
@onready var agent_list: AgentListPanel = $UI/Root/SidePanel/SidePanelMargin/SidePanelVBox/AgentList
@onready var event_log: EventLogPanel = $UI/Root/SidePanel/SidePanelMargin/SidePanelVBox/EventLog
@onready var status_bar: StatusBarPanel = $UI/Root/StatusBarPanel/StatusBar
@onready var connection_dialog: Window = $ConnectionDialog
@onready var host_field: LineEdit = $ConnectionDialog/MarginContainer/VBoxContainer/FormGrid/HostField
@onready var port_field: LineEdit = $ConnectionDialog/MarginContainer/VBoxContainer/FormGrid/PortField
@onready var secure_checkbox: CheckBox = $ConnectionDialog/MarginContainer/VBoxContainer/FormGrid/SecureCheckBox
@onready var admin_key_field: LineEdit = $ConnectionDialog/MarginContainer/VBoxContainer/FormGrid/AdminKeyField
@onready var theme_field: LineEdit = $ConnectionDialog/MarginContainer/VBoxContainer/FormGrid/ThemeField
@onready var dialog_connect_button: Button = $ConnectionDialog/MarginContainer/VBoxContainer/ButtonRow/ConnectButton
@onready var dialog_cancel_button: Button = $ConnectionDialog/MarginContainer/VBoxContainer/ButtonRow/CancelButton

var _connection_settings: Dictionary = {}
var _manual_disconnect := false
var _dragging_camera := false
const CAMERA_PAN_SPEED := 400.0
const CAMERA_ZOOM_MIN := Vector2(0.4, 0.4)
const CAMERA_ZOOM_MAX := Vector2(2.2, 2.2)
const CAMERA_INITIAL_POSITION := Vector2(640.0, 360.0)

func _ready() -> void:
    _connection_settings = Globals.load_connection_settings()
    world_state.set_connection_settings(_connection_settings)
    world_state.set_theme(Globals.resolve_theme_name(str(_connection_settings.get("theme", Globals.DEFAULT_THEME_NAME))))
    world_state.set_connection_state("disconnected", "Ready.")

    map_renderer.bind_world_state(world_state)
    map_renderer.load_theme(str(_connection_settings.get("theme", Globals.DEFAULT_THEME_NAME)))
    agent_controller.bind(world_state, map_renderer)
    agent_controller.load_theme(str(_connection_settings.get("theme", Globals.DEFAULT_THEME_NAME)))
    conversation_view.bind(world_state, agent_controller)
    server_event_fx.bind(world_state, agent_controller)
    agent_list.bind_world_state(world_state)
    event_log.bind_world_state(world_state)
    status_bar.bind_world_state(world_state)
    agent_list.set_default_icon(map_renderer.get_default_agent_texture())

    connect_button.pressed.connect(_on_connect_button_pressed)
    disconnect_button.pressed.connect(_on_disconnect_button_pressed)
    settings_button.pressed.connect(_show_connection_dialog)
    dialog_connect_button.pressed.connect(_on_dialog_connect_pressed)
    dialog_cancel_button.pressed.connect(_hide_connection_dialog)
    connection_dialog.close_requested.connect(_hide_connection_dialog)
    agent_list.agent_selected.connect(_focus_agent)

    ws_client.connection_state_changed.connect(_on_ws_state_changed)
    ws_client.snapshot_received.connect(_on_snapshot_received)
    ws_client.event_received.connect(_on_event_received)
    ws_client.snapshot_fallback_received.connect(_on_snapshot_fallback_received)
    ws_client.connection_failed.connect(_on_ws_connection_failed)
    ws_client.disconnected.connect(_on_ws_disconnected)
    reconnect.retry_requested.connect(_on_retry_requested)
    reconnect.retry_scheduled.connect(_on_retry_scheduled)

    _populate_connection_dialog(_connection_settings)
    _refresh_connection_bar()

    if str(_connection_settings.get("admin_key", "")) == "":
        _show_connection_dialog()
    else:
        _connect_with_settings(_connection_settings)

func _unhandled_input(event: InputEvent) -> void:
    if event is InputEventMouseButton:
        var mouse_event: InputEventMouseButton = event
        if mouse_event.button_index == MOUSE_BUTTON_WHEEL_UP and mouse_event.pressed:
            camera.zoom = (camera.zoom * 0.9).clamp(CAMERA_ZOOM_MIN, CAMERA_ZOOM_MAX)
        elif mouse_event.button_index == MOUSE_BUTTON_WHEEL_DOWN and mouse_event.pressed:
            camera.zoom = (camera.zoom * 1.1).clamp(CAMERA_ZOOM_MIN, CAMERA_ZOOM_MAX)
        elif mouse_event.button_index == MOUSE_BUTTON_MIDDLE:
            _dragging_camera = mouse_event.pressed
        elif mouse_event.button_index == MOUSE_BUTTON_LEFT and mouse_event.pressed and mouse_event.double_click:
            camera.position = CAMERA_INITIAL_POSITION
            camera.zoom = Vector2.ONE
    elif event is InputEventMouseMotion and _dragging_camera:
        var motion_event: InputEventMouseMotion = event
        camera.position -= motion_event.relative / camera.zoom
    elif event is InputEventKey and event.pressed and not event.echo and event.keycode == KEY_HOME:
        camera.position = CAMERA_INITIAL_POSITION
        camera.zoom = Vector2.ONE

func _process(delta: float) -> void:
    if connection_dialog.visible:
        return
    var pan_direction := Vector2.ZERO
    if Input.is_key_pressed(KEY_LEFT):
        pan_direction.x -= 1.0
    if Input.is_key_pressed(KEY_RIGHT):
        pan_direction.x += 1.0
    if Input.is_key_pressed(KEY_UP):
        pan_direction.y -= 1.0
    if Input.is_key_pressed(KEY_DOWN):
        pan_direction.y += 1.0
    if pan_direction != Vector2.ZERO:
        camera.position += pan_direction.normalized() * CAMERA_PAN_SPEED * delta / camera.zoom.x

func _on_connect_button_pressed() -> void:
    if str(_connection_settings.get("admin_key", "")) == "":
        _show_connection_dialog()
        return
    _connect_with_settings(_connection_settings)

func _on_disconnect_button_pressed() -> void:
    _manual_disconnect = true
    reconnect.cancel()
    ws_client.disconnect_from_server(true)
    world_state.set_connection_state("disconnected", "Disconnected by user.")
    _refresh_connection_bar()

func _show_connection_dialog() -> void:
    _populate_connection_dialog(_connection_settings)
    connection_dialog.show()
    host_field.grab_focus()

func _hide_connection_dialog() -> void:
    connection_dialog.hide()

func _on_dialog_connect_pressed() -> void:
    var settings := _collect_dialog_settings()
    _connect_with_settings(settings)
    _hide_connection_dialog()

func _connect_with_settings(settings: Dictionary) -> void:
    _manual_disconnect = false
    reconnect.cancel()
    _connection_settings = settings.duplicate(true)
    Globals.save_connection_settings(_connection_settings)
    world_state.set_connection_settings(_connection_settings)
    world_state.set_theme(Globals.resolve_theme_name(str(_connection_settings.get("theme", Globals.DEFAULT_THEME_NAME))))
    map_renderer.load_theme(str(_connection_settings.get("theme", Globals.DEFAULT_THEME_NAME)))
    agent_controller.load_theme(str(_connection_settings.get("theme", Globals.DEFAULT_THEME_NAME)))
    agent_list.set_default_icon(map_renderer.get_default_agent_texture())
    ws_client.configure(_connection_settings)
    ws_client.connect_to_server(_connection_settings)
    _refresh_connection_bar()

func _on_ws_state_changed(state: String, message: String) -> void:
    world_state.set_connection_state(state, message)
    if state == WSClient.STATE_SYNCED:
        reconnect.reset()
    _refresh_connection_bar()

func _on_snapshot_received(snapshot: Dictionary) -> void:
    world_state.replace_from_snapshot(snapshot)
    _refresh_connection_bar()

func _on_event_received(event: Dictionary) -> void:
    event_processor.apply_event(world_state, event)

func _on_snapshot_fallback_received(snapshot: Dictionary) -> void:
    if world_state.connection_state == WSClient.STATE_SYNCED:
        return
    world_state.replace_from_snapshot(snapshot)
    if world_state.connection_state != WSClient.STATE_SYNCED:
        world_state.set_connection_state(WSClient.STATE_CONNECTING, "Recovered snapshot via HTTP fallback. Retrying WebSocket...")
    _refresh_connection_bar()

func _on_ws_connection_failed(message: String) -> void:
    if _manual_disconnect:
        return
    world_state.set_connection_state(WSClient.STATE_CONNECTING, message)
    reconnect.schedule_retry()
    _refresh_connection_bar()

func _on_ws_disconnected(message: String) -> void:
    if _manual_disconnect:
        world_state.set_connection_state(WSClient.STATE_DISCONNECTED, "Disconnected by user.")
        _refresh_connection_bar()
        return
    world_state.set_connection_state(WSClient.STATE_CONNECTING, message)
    reconnect.schedule_retry()
    _refresh_connection_bar()

func _on_retry_requested() -> void:
    if _connection_settings.is_empty() or _manual_disconnect:
        return
    ws_client.connect_to_server(_connection_settings)

func _on_retry_scheduled(delay_seconds: float, attempt: int) -> void:
    world_state.set_connection_state(WSClient.STATE_CONNECTING, "Reconnect attempt %d in %.1fs" % [attempt, delay_seconds])
    _refresh_connection_bar()

func _focus_agent(agent_id: String) -> void:
    if not agent_controller.has_agent(agent_id):
        return
    camera.position = agent_controller.get_agent_position(agent_id)

func _populate_connection_dialog(settings: Dictionary) -> void:
    host_field.text = str(settings.get("host", "127.0.0.1"))
    port_field.text = str(settings.get("port", 3000))
    secure_checkbox.button_pressed = bool(settings.get("secure", false))
    admin_key_field.text = str(settings.get("admin_key", ""))
    theme_field.text = str(settings.get("theme", Globals.DEFAULT_THEME_NAME))

func _collect_dialog_settings() -> Dictionary:
    var settings := Globals.get_default_connection_settings()
    settings["host"] = host_field.text.strip_edges() if host_field.text.strip_edges() != "" else settings["host"]
    settings["port"] = int(port_field.text.to_int()) if port_field.text.strip_edges() != "" else settings["port"]
    settings["secure"] = secure_checkbox.button_pressed
    settings["admin_key"] = admin_key_field.text.strip_edges()
    settings["theme"] = theme_field.text.strip_edges() if theme_field.text.strip_edges() != "" else Globals.DEFAULT_THEME_NAME
    settings["ws_path"] = _connection_settings.get("ws_path", settings["ws_path"])
    settings["snapshot_path"] = _connection_settings.get("snapshot_path", settings["snapshot_path"])
    return settings

func _refresh_connection_bar() -> void:
    connection_label.text = "%s://%s:%d  •  theme: %s  •  %s" % [
        "wss" if bool(_connection_settings.get("secure", false)) else "ws",
        str(_connection_settings.get("host", "127.0.0.1")),
        int(_connection_settings.get("port", 3000)),
        str(_connection_settings.get("theme", Globals.DEFAULT_THEME_NAME)),
        world_state.connection_state,
    ]
    connect_button.disabled = world_state.connection_state == WSClient.STATE_CONNECTING
    disconnect_button.disabled = world_state.connection_state == WSClient.STATE_DISCONNECTED
