extends Node
class_name WorldState

signal snapshot_replaced(snapshot: Dictionary)
signal event_applied(event: Dictionary)
signal overlays_cleared
signal agent_avatar_updated(agent_id: String, texture: Texture2D)
signal connection_state_changed(state: String, message: String)
signal log_changed
signal state_changed

const MAX_LOG_ENTRIES := 100

var world: Dictionary = {}
var map: Dictionary = {}
var agents: Dictionary = {}
var conversations: Dictionary = {}
var server_events: Dictionary = {}
var event_log: Array[Dictionary] = []
var connection_settings: Dictionary = {}
var connection_state := "disconnected"
var connection_message := ""
var active_theme := Globals.DEFAULT_THEME_NAME
var generated_at := 0
var last_event_at := 0

func set_theme(theme_name: String) -> void:
    active_theme = theme_name if theme_name != "" else Globals.DEFAULT_THEME_NAME
    state_changed.emit()

func set_connection_settings(settings: Dictionary) -> void:
    connection_settings = settings.duplicate(true)
    state_changed.emit()

func set_connection_state(state: String, message: String = "") -> void:
    connection_state = state
    connection_message = message
    connection_state_changed.emit(state, message)
    state_changed.emit()

func replace_from_snapshot(snapshot: Dictionary) -> void:
    world = _clone_dictionary(snapshot.get("world", {}))
    map = _clone_dictionary(snapshot.get("map", {}))
    agents.clear()
    conversations.clear()
    server_events.clear()
    event_log.clear()
    generated_at = int(snapshot.get("generated_at", 0))
    last_event_at = generated_at

    var agent_items: Variant = snapshot.get("agents", [])
    if typeof(agent_items) == TYPE_ARRAY:
        for value in agent_items:
            if typeof(value) != TYPE_DICTIONARY:
                continue
            var agent_data: Dictionary = value.duplicate(true)
            agent_data["avatar_texture"] = null
            agent_data["current_action"] = {}
            agent_data["last_selection"] = {}
            if not agent_data.has("movement"):
                agent_data["movement"] = {}
            agents[str(agent_data.get("agent_id", ""))] = agent_data

    var conversation_items: Variant = snapshot.get("conversations", [])
    if typeof(conversation_items) == TYPE_ARRAY:
        for value in conversation_items:
            if typeof(value) != TYPE_DICTIONARY:
                continue
            var conversation: Dictionary = value.duplicate(true)
            conversation["messages"] = []
            conversations[str(conversation.get("conversation_id", ""))] = conversation

    var server_event_items: Variant = snapshot.get("server_events", [])
    if typeof(server_event_items) == TYPE_ARRAY:
        for value in server_event_items:
            if typeof(value) != TYPE_DICTIONARY:
                continue
            var server_event: Dictionary = value.duplicate(true)
            server_event["last_selection"] = {}
            server_events[str(server_event.get("server_event_id", ""))] = server_event

    overlays_cleared.emit()
    snapshot_replaced.emit(snapshot)
    log_changed.emit()
    state_changed.emit()

func apply_avatar_texture(agent_id: String, texture: Texture2D) -> void:
    if not agents.has(agent_id):
        return
    var agent: Dictionary = agents[agent_id]
    agent["avatar_texture"] = texture
    agents[agent_id] = agent
    agent_avatar_updated.emit(agent_id, texture)
    state_changed.emit()

func clear_avatar_texture(agent_id: String) -> void:
    if not agents.has(agent_id):
        return
    var agent: Dictionary = agents[agent_id]
    agent["avatar_texture"] = null
    agents[agent_id] = agent
    state_changed.emit()

func append_event_log(event: Dictionary) -> void:
    var entry: Dictionary = {
        "occurred_at": int(event.get("occurred_at", Time.get_unix_time_from_system() * 1000.0)),
        "type": str(event.get("type", "unknown")),
        "summary": _build_event_summary(event),
    }
    event_log.push_front(entry)
    if event_log.size() > MAX_LOG_ENTRIES:
        event_log.resize(MAX_LOG_ENTRIES)
    log_changed.emit()

func get_agents_sorted() -> Array:
    var values := agents.values()
    values.sort_custom(_sort_agents)
    return values

func get_agent_count() -> int:
    return agents.size()

func get_world_name() -> String:
    return str(world.get("name", ""))

func _sort_agents(left: Dictionary, right: Dictionary) -> bool:
    return str(left.get("agent_name", "")) < str(right.get("agent_name", ""))

func _clone_dictionary(value) -> Dictionary:
    if typeof(value) == TYPE_DICTIONARY:
        return value.duplicate(true)
    return {}

func _build_event_summary(event: Dictionary) -> String:
    var event_type := str(event.get("type", "unknown"))
    match event_type:
        "agent_logged_in":
            return "%s logged in at %s." % [event.get("agent_name", "Agent"), event.get("node_id", "?")]
        "agent_logged_out":
            return "%s logged out." % [event.get("agent_name", "Agent")]
        "movement_started":
            return "%s started moving to %s." % [event.get("agent_name", "Agent"), event.get("to_node_id", "?")]
        "movement_completed":
            return "%s reached %s." % [event.get("agent_name", "Agent"), event.get("node_id", "?")]
        "action_started":
            return "%s started %s." % [event.get("agent_name", "Agent"), event.get("action_name", "an action")]
        "action_completed":
            return "%s finished %s." % [event.get("agent_name", "Agent"), event.get("action_name", "an action")]
        "wait_started":
            return "%s is waiting." % [event.get("agent_name", "Agent")]
        "wait_completed":
            return "%s finished waiting." % [event.get("agent_name", "Agent")]
        "conversation_requested":
            return "Conversation requested: %s → %s." % [event.get("initiator_agent_id", "?"), event.get("target_agent_id", "?")]
        "conversation_accepted":
            return "Conversation accepted for %s." % [event.get("conversation_id", "?")]
        "conversation_rejected":
            return "Conversation rejected for %s." % [event.get("conversation_id", "?")]
        "conversation_message":
            return "%s said: %s" % [event.get("speaker_agent_id", "?"), event.get("message", "")]
        "conversation_ended":
            return "Conversation ended for %s." % [event.get("conversation_id", "?")]
        "server_event_fired":
            return "Server event: %s." % [event.get("name", event.get("event_id_ref", "event"))]
        "server_event_selected":
            return "%s selected %s." % [event.get("agent_id", "Agent"), event.get("choice_label", "a choice")]
        "idle_reminder_fired":
            return "Idle reminder fired for %s." % [event.get("agent_name", "Agent")]
        _:
            return "%s event received." % [event_type]
