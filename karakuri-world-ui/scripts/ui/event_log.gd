extends VBoxContainer
class_name EventLogPanel

var world_state: WorldState

@onready var title_label: Label = $TitleLabel
@onready var log_body: RichTextLabel = $LogBody

func bind_world_state(world_state_node: WorldState) -> void:
    world_state = world_state_node
    world_state.snapshot_replaced.connect(_refresh)
    world_state.log_changed.connect(_refresh)
    world_state.connection_state_changed.connect(_refresh)
    _refresh()

func _refresh(_arg = null, _arg2 = null) -> void:
    if world_state == null:
        return
    title_label.text = "Event Log (%d)" % [world_state.event_log.size()]
    var lines := []
    for entry in world_state.event_log:
        lines.append("%s  %s" % [_format_time(int(entry.get("occurred_at", 0))), str(entry.get("summary", ""))])
    log_body.text = "\n".join(lines)
    log_body.scroll_to_line(0)

func _format_time(timestamp_ms: int) -> String:
    if timestamp_ms <= 0:
        return "--:--:--"
    var datetime := Time.get_datetime_dict_from_unix_time(int(timestamp_ms / 1000))
    return "%02d:%02d:%02d" % [
        int(datetime.get("hour", 0)),
        int(datetime.get("minute", 0)),
        int(datetime.get("second", 0)),
    ]
