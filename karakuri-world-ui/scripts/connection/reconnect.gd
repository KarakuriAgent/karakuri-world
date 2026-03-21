extends Node
class_name ReconnectHelper

signal retry_requested
signal retry_scheduled(delay_seconds: float, attempt: int)

@export var initial_delay_seconds := 1.0
@export var max_delay_seconds := 30.0
@export var multiplier := 2.0

var _attempt := 0
var _timer: Timer

func _ready() -> void:
    _timer = Timer.new()
    _timer.one_shot = true
    _timer.timeout.connect(_on_timeout)
    add_child(_timer)

func reset() -> void:
    _attempt = 0
    if _timer != null:
        _timer.stop()

func cancel() -> void:
    if _timer != null:
        _timer.stop()

func schedule_retry() -> void:
    if _timer == null:
        return
    if _timer.time_left > 0.0:
        return

    _attempt += 1
    var delay := min(max_delay_seconds, initial_delay_seconds * pow(multiplier, max(_attempt - 1, 0)))
    _timer.start(delay)
    retry_scheduled.emit(delay, _attempt)

func is_waiting() -> bool:
    return _timer != null and _timer.time_left > 0.0

func _on_timeout() -> void:
    retry_requested.emit()
