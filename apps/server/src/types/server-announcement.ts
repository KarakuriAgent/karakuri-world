export interface ServerAnnouncementInstance {
  server_announcement_id: string;
  description: string;
  fired_at: number;
  delivered_agent_ids: string[];
  pending_agent_ids: string[];
}
