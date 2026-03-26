extends Node
class_name EventProcessor

func apply_event(world_state: WorldState, event: Dictionary) -> void:
	if world_state == null:
		return

	var event_type := str(event.get("type", ""))
	match event_type:
		"agent_logged_in":
			_apply_agent_logged_in(world_state, event)
		"agent_logged_out":
			_apply_agent_logged_out(world_state, event)
		"movement_started":
			_apply_movement_started(world_state, event)
		"movement_completed":
			_apply_movement_completed(world_state, event)
		"action_started":
			_apply_action_started(world_state, event)
		"action_completed":
			_apply_action_completed(world_state, event)
		"wait_started":
			_apply_wait_started(world_state, event)
		"wait_completed":
			_apply_wait_completed(world_state, event)
		"conversation_requested":
			_apply_conversation_requested(world_state, event)
		"conversation_accepted":
			_apply_conversation_accepted(world_state, event)
		"conversation_rejected":
			_apply_conversation_rejected(world_state, event)
		"conversation_message":
			_apply_conversation_message(world_state, event)
		"conversation_ended":
			_apply_conversation_ended(world_state, event)
		"server_event_fired":
			_apply_server_event_fired(world_state, event)
		"server_event_selected":
			_apply_server_event_selected(world_state, event)
		"idle_reminder_fired":
			pass
		_:
			return

	world_state.last_event_at = int(event.get("occurred_at", world_state.last_event_at))
	world_state.append_event_log(event)
	world_state.event_applied.emit(event)
	world_state.state_changed.emit()

func _apply_agent_logged_in(world_state: WorldState, event: Dictionary) -> void:
	var agent_id := str(event.get("agent_id", ""))
	world_state.agents[agent_id] = {
		"agent_id": agent_id,
		"agent_name": str(event.get("agent_name", agent_id)),
		"node_id": str(event.get("node_id", "")),
		"state": "idle",
		"discord_channel_id": str(event.get("discord_channel_id", "")),
		"avatar_url": event.get("avatar_url", null),
		"avatar_texture": null,
		"movement": {},
		"current_action": {},
		"last_selection": {},
	}

func _apply_agent_logged_out(world_state: WorldState, event: Dictionary) -> void:
	var agent_id := str(event.get("agent_id", ""))
	world_state.agents.erase(agent_id)
	_remove_conversations_for_agent(world_state, agent_id)

func _apply_movement_started(world_state: WorldState, event: Dictionary) -> void:
	var agent := _ensure_agent(world_state, str(event.get("agent_id", "")))
	agent["state"] = "moving"
	agent["node_id"] = str(event.get("from_node_id", agent.get("node_id", "")))
	agent["movement"] = {
		"from_node_id": str(event.get("from_node_id", agent.get("node_id", ""))),
		"to_node_id": str(event.get("to_node_id", agent.get("node_id", ""))),
		"path": event.get("path", []),
		"arrives_at": int(event.get("arrives_at", 0)),
	}
	world_state.agents[str(agent.get("agent_id", ""))] = agent

func _apply_movement_completed(world_state: WorldState, event: Dictionary) -> void:
	var agent := _ensure_agent(world_state, str(event.get("agent_id", "")))
	agent["state"] = "idle"
	agent["node_id"] = str(event.get("node_id", agent.get("node_id", "")))
	agent["movement"] = {}
	world_state.agents[str(agent.get("agent_id", ""))] = agent

func _apply_action_started(world_state: WorldState, event: Dictionary) -> void:
	var agent := _ensure_agent(world_state, str(event.get("agent_id", "")))
	agent["state"] = "in_action"
	agent["current_action"] = {
		"action_id": str(event.get("action_id", "")),
		"action_name": str(event.get("action_name", "")),
		"completes_at": int(event.get("completes_at", 0)),
	}
	world_state.agents[str(agent.get("agent_id", ""))] = agent

func _apply_action_completed(world_state: WorldState, event: Dictionary) -> void:
	var agent := _ensure_agent(world_state, str(event.get("agent_id", "")))
	agent["state"] = "idle"
	agent["current_action"] = {}
	world_state.agents[str(agent.get("agent_id", ""))] = agent

func _apply_wait_started(world_state: WorldState, event: Dictionary) -> void:
	var agent := _ensure_agent(world_state, str(event.get("agent_id", "")))
	agent["state"] = "in_action"
	agent["current_action"] = {
		"action_id": "wait",
		"action_name": "Waiting",
		"completes_at": int(event.get("completes_at", 0)),
	}
	world_state.agents[str(agent.get("agent_id", ""))] = agent

func _apply_wait_completed(world_state: WorldState, event: Dictionary) -> void:
	var agent := _ensure_agent(world_state, str(event.get("agent_id", "")))
	agent["state"] = "idle"
	agent["current_action"] = {}
	world_state.agents[str(agent.get("agent_id", ""))] = agent

func _apply_conversation_requested(world_state: WorldState, event: Dictionary) -> void:
	var conversation_id := str(event.get("conversation_id", ""))
	world_state.conversations[conversation_id] = {
		"conversation_id": conversation_id,
		"status": "pending",
		"initiator_agent_id": str(event.get("initiator_agent_id", "")),
		"target_agent_id": str(event.get("target_agent_id", "")),
		"current_turn": 1,
		"current_speaker_agent_id": str(event.get("target_agent_id", "")),
		"messages": [
			{
				"speaker_agent_id": str(event.get("initiator_agent_id", "")),
				"text": str(event.get("message", "")),
			}
		],
	}

func _apply_conversation_accepted(world_state: WorldState, event: Dictionary) -> void:
	var conversation_id := str(event.get("conversation_id", ""))
	var conversation: Variant = world_state.conversations.get(conversation_id, {
		"conversation_id": conversation_id,
		"messages": [],
	})
	conversation["status"] = "active"
	conversation["initiator_agent_id"] = str(event.get("initiator_agent_id", conversation.get("initiator_agent_id", "")))
	conversation["target_agent_id"] = str(event.get("target_agent_id", conversation.get("target_agent_id", "")))
	world_state.conversations[conversation_id] = conversation

	var initiator := _ensure_agent(world_state, str(event.get("initiator_agent_id", "")))
	initiator["state"] = "in_conversation"
	world_state.agents[str(initiator.get("agent_id", ""))] = initiator

	var target := _ensure_agent(world_state, str(event.get("target_agent_id", "")))
	target["state"] = "in_conversation"
	target["current_action"] = {}
	world_state.agents[str(target.get("agent_id", ""))] = target

func _apply_conversation_rejected(world_state: WorldState, event: Dictionary) -> void:
	var conversation_id := str(event.get("conversation_id", ""))
	world_state.conversations.erase(conversation_id)

	var initiator := _ensure_agent(world_state, str(event.get("initiator_agent_id", "")))
	initiator["state"] = "idle"
	world_state.agents[str(initiator.get("agent_id", ""))] = initiator

func _apply_conversation_message(world_state: WorldState, event: Dictionary) -> void:
	var conversation_id := str(event.get("conversation_id", ""))
	var conversation: Variant = world_state.conversations.get(conversation_id, {
		"conversation_id": conversation_id,
		"messages": [],
	})
	var messages: Variant = conversation.get("messages", [])
	messages.append({
		"speaker_agent_id": str(event.get("speaker_agent_id", "")),
		"text": str(event.get("message", "")),
	})
	conversation["messages"] = messages
	conversation["current_turn"] = int(event.get("turn", conversation.get("current_turn", 1)))
	conversation["current_speaker_agent_id"] = str(event.get("listener_agent_id", ""))
	world_state.conversations[conversation_id] = conversation

func _apply_conversation_ended(world_state: WorldState, event: Dictionary) -> void:
	world_state.conversations.erase(str(event.get("conversation_id", "")))
	for agent_id in [str(event.get("initiator_agent_id", "")), str(event.get("target_agent_id", ""))]:
		if agent_id == "":
			continue
		var agent := _ensure_agent(world_state, agent_id)
		agent["state"] = "idle"
		world_state.agents[agent_id] = agent

func _apply_server_event_fired(world_state: WorldState, event: Dictionary) -> void:
	var server_event_id := str(event.get("server_event_id", ""))
	world_state.server_events[server_event_id] = {
		"server_event_id": server_event_id,
		"event_id": str(event.get("event_id_ref", "")),
		"name": str(event.get("name", "")),
		"description": str(event.get("description", "")),
		"choices": event.get("choices", []),
		"delivered_agent_ids": event.get("delivered_agent_ids", []),
		"pending_agent_ids": event.get("pending_agent_ids", []),
		"last_selection": {},
	}

func _apply_server_event_selected(world_state: WorldState, event: Dictionary) -> void:
	var server_event_id := str(event.get("server_event_id", ""))
	var server_event: Variant = world_state.server_events.get(server_event_id, {
		"server_event_id": server_event_id,
		"event_id": str(event.get("event_id_ref", "")),
		"choices": [],
		"delivered_agent_ids": [],
		"pending_agent_ids": [],
	})
	server_event["last_selection"] = {
		"agent_id": str(event.get("agent_id", "")),
		"choice_id": str(event.get("choice_id", "")),
		"choice_label": str(event.get("choice_label", "")),
	}
	world_state.server_events[server_event_id] = server_event

	var agent := _ensure_agent(world_state, str(event.get("agent_id", "")))
	agent["last_selection"] = server_event["last_selection"]
	if str(event.get("source_state", "")) == "in_action":
		agent["state"] = "idle"
		agent["current_action"] = {}
	world_state.agents[str(agent.get("agent_id", ""))] = agent

func _ensure_agent(world_state: WorldState, agent_id: String) -> Dictionary:
	if world_state.agents.has(agent_id):
		return world_state.agents[agent_id]

	var agent := {
		"agent_id": agent_id,
		"agent_name": agent_id,
		"node_id": "",
		"state": "idle",
		"discord_channel_id": "",
		"avatar_url": null,
		"avatar_texture": null,
		"movement": {},
		"current_action": {},
		"last_selection": {},
	}
	world_state.agents[agent_id] = agent
	return agent

func _remove_conversations_for_agent(world_state: WorldState, agent_id: String) -> void:
	var removable := []
	for conversation_id in world_state.conversations.keys():
		var conversation: Dictionary = world_state.conversations[conversation_id]
		if str(conversation.get("initiator_agent_id", "")) == agent_id or str(conversation.get("target_agent_id", "")) == agent_id:
			removable.append(conversation_id)
	for conversation_id in removable:
		world_state.conversations.erase(conversation_id)
