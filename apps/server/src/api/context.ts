import type { AgentRegistration } from '../types/agent.js';

export interface ApiVariables {
  agentId: string;
  agentRegistration: AgentRegistration;
  validatedBody: unknown;
}

export interface ApiEnv {
  Variables: ApiVariables;
}
