export interface ServerEventChoiceConfig {
  choice_id: string;
  label: string;
  description: string;
}

export interface ServerEventConfig {
  event_id: string;
  name: string;
  description: string;
  choices: ServerEventChoiceConfig[];
  timeout_ms: number;
}

export interface ServerEventInstance extends ServerEventConfig {
  server_event_id: string;
  fired_at: number;
  delivered_agent_ids: string[];
  pending_agent_ids: string[];
}
