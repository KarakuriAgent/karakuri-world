PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS world_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  conversation_id TEXT,
  server_event_id TEXT,
  summary_emoji TEXT NOT NULL,
  summary_title TEXT NOT NULL,
  summary_text TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS world_events_occurred_idx
  ON world_events (occurred_at DESC, event_id DESC);

CREATE TABLE IF NOT EXISTS server_event_instances (
  server_event_id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  first_occurred_at INTEGER NOT NULL,
  last_occurred_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS server_event_instances_recent_idx
  ON server_event_instances (first_occurred_at DESC, server_event_id DESC);

CREATE TABLE IF NOT EXISTS world_event_agents (
  event_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  role TEXT NOT NULL,
  PRIMARY KEY (event_id, agent_id),
  FOREIGN KEY (event_id) REFERENCES world_events(event_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS world_event_agents_agent_timeline_idx
  ON world_event_agents (agent_id, occurred_at DESC, event_id DESC);

CREATE INDEX IF NOT EXISTS world_event_agents_agent_type_timeline_idx
  ON world_event_agents (agent_id, event_type, occurred_at DESC, event_id DESC);

CREATE TABLE IF NOT EXISTS world_event_conversations (
  event_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  PRIMARY KEY (event_id, conversation_id),
  FOREIGN KEY (event_id) REFERENCES world_events(event_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS world_event_conversations_timeline_idx
  ON world_event_conversations (conversation_id, occurred_at DESC, event_id DESC);

CREATE INDEX IF NOT EXISTS world_event_conversations_type_timeline_idx
  ON world_event_conversations (conversation_id, event_type, occurred_at DESC, event_id DESC);
