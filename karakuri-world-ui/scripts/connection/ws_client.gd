extends Node
class_name WSClient

signal connection_state_changed(state: String, message: String)
signal snapshot_received(snapshot: Dictionary)
signal event_received(event: Dictionary)
signal snapshot_fallback_received(snapshot: Dictionary)
signal connection_failed(message: String)
signal disconnected(message: String)

const STATE_DISCONNECTED := "disconnected"
const STATE_CONNECTING := "connecting"
const STATE_CONNECTED := "connected"
const STATE_SYNCED := "synced"

var _socket := WebSocketPeer.new()
var _http_request: HTTPRequest
var _settings: Dictionary = {}
var _manual_disconnect := false
var _last_ready_state := WebSocketPeer.STATE_CLOSED

func _ready() -> void:
    _http_request = HTTPRequest.new()
    _http_request.request_completed.connect(_on_snapshot_request_completed)
    add_child(_http_request)
    set_process(true)

func configure(settings: Dictionary) -> void:
    _settings = settings.duplicate(true)

func connect_to_server(settings: Dictionary = {}) -> bool:
    if not settings.is_empty():
        configure(settings)
    if _settings.is_empty():
        connection_failed.emit("Missing connection settings.")
        return false

    _manual_disconnect = false
    _socket = WebSocketPeer.new()
    _socket.handshake_headers = PackedStringArray([
        "X-Admin-Key: %s" % str(_settings.get("admin_key", "")),
    ])

    var error := _socket.connect_to_url(Globals.build_ws_url(_settings))
    if error != OK:
        connection_failed.emit("WebSocket connection failed (%s)." % [error_string(error)])
        request_snapshot_fallback()
        return false

    _last_ready_state = _socket.get_ready_state()
    connection_state_changed.emit(STATE_CONNECTING, "Connecting to %s" % Globals.build_ws_url(_settings))
    return true

func disconnect_from_server(manual := true) -> void:
    _manual_disconnect = manual
    if _socket != null and _socket.get_ready_state() != WebSocketPeer.STATE_CLOSED:
        _socket.close()
    _last_ready_state = WebSocketPeer.STATE_CLOSED
    if manual:
        if _http_request != null:
            _http_request.cancel_request()
        connection_state_changed.emit(STATE_DISCONNECTED, "Disconnected.")

func request_snapshot_fallback() -> void:
    if _http_request == null or _settings.is_empty():
        return
    if _http_request.get_http_client_status() == HTTPClient.STATUS_REQUESTING:
        return

    var headers := PackedStringArray([
        "X-Admin-Key: %s" % str(_settings.get("admin_key", "")),
    ])
    var error := _http_request.request(
        Globals.build_http_url(_settings, str(_settings.get("snapshot_path", Globals.DEFAULT_SNAPSHOT_PATH))),
        headers,
        HTTPClient.METHOD_GET
    )
    if error != OK:
        connection_failed.emit("HTTP snapshot request failed (%s)." % [error_string(error)])

func _process(_delta: float) -> void:
    if _socket == null or _socket.get_ready_state() == WebSocketPeer.STATE_CLOSED:
        return

    var poll_error := _socket.poll()
    if poll_error != OK and poll_error != ERR_BUSY:
        _handle_socket_closed("WebSocket poll failed (%s)." % [error_string(poll_error)])
        return

    var ready_state := _socket.get_ready_state()
    if ready_state != _last_ready_state:
        _last_ready_state = ready_state
        match ready_state:
            WebSocketPeer.STATE_CONNECTING:
                connection_state_changed.emit(STATE_CONNECTING, "Connecting...")
            WebSocketPeer.STATE_OPEN:
                connection_state_changed.emit(STATE_CONNECTED, "WebSocket connected. Waiting for snapshot...")
            WebSocketPeer.STATE_CLOSING:
                connection_state_changed.emit(STATE_DISCONNECTED, "Closing connection...")
            WebSocketPeer.STATE_CLOSED:
                _handle_socket_closed(_socket.get_close_reason())
                return

    if ready_state == WebSocketPeer.STATE_OPEN:
        _drain_packets()

func _drain_packets() -> void:
    while _socket.get_available_packet_count() > 0:
        var packet := _socket.get_packet()
        var text := packet.get_string_from_utf8()
        var parsed = JSON.parse_string(text)
        if typeof(parsed) != TYPE_DICTIONARY:
            continue

        var message: Dictionary = parsed
        match str(message.get("type", "")):
            "snapshot":
                connection_state_changed.emit(STATE_SYNCED, "Snapshot synchronized.")
                snapshot_received.emit(message.get("data", {}))
            "event":
                event_received.emit(message.get("data", {}))

func _handle_socket_closed(reason: String) -> void:
    if _manual_disconnect:
        disconnected.emit("Disconnected.")
        return

    request_snapshot_fallback()
    var message := reason if reason != "" else "Connection lost."
    disconnected.emit(message)
    connection_state_changed.emit(STATE_DISCONNECTED, message)

func _on_snapshot_request_completed(result: int, response_code: int, _headers: PackedStringArray, body: PackedByteArray) -> void:
    if _manual_disconnect:
        return
    if result != HTTPRequest.RESULT_SUCCESS or response_code < 200 or response_code >= 300:
        connection_failed.emit("HTTP snapshot fallback failed (%d)." % [response_code])
        return

    var parsed = JSON.parse_string(body.get_string_from_utf8())
    if typeof(parsed) != TYPE_DICTIONARY:
        connection_failed.emit("HTTP snapshot fallback returned invalid JSON.")
        return

    snapshot_fallback_received.emit(parsed)
