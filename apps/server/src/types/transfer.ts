import type { AgentItem } from './agent.js';

export type TransferMode = 'standalone' | 'in_conversation';

export type TransferRejectReason =
  | { kind: 'rejected_by_receiver' }
  | { kind: 'unanswered_speak' }
  | { kind: 'inventory_full'; dropped_item: Readonly<AgentItem> | null };

export type TransferOfferStatus = 'open' | 'settling_accept' | 'settling_refund' | 'refund_failed';

export type TransferCancelReason =
  | 'server_announcement'
  | 'sender_logged_out'
  | 'receiver_logged_out'
  | 'conversation_closing'
  | 'participant_inactive'
  | 'error';

interface TransferOfferBase {
  transfer_id: string;
  from_agent_id: string;
  to_agent_id: string;
  /**
   * 譲渡されるアイテム1種類（quantity ≥ 1）。お金譲渡の場合は null。
   * `item` と `money` のうち必ず片方だけが正の値（item は quantity > 0、money は > 0）になる。
   */
  readonly item: Readonly<AgentItem> | null;
  /** 譲渡される金額。アイテム譲渡の場合は 0。 */
  money: number;
  status: TransferOfferStatus;
  started_at: number;
  expires_at: number;
}

export interface StandaloneTransferOffer extends TransferOfferBase {
  mode: 'standalone';
}

export interface InConversationTransferOffer extends TransferOfferBase {
  mode: 'in_conversation';
  conversation_id: string;
}

export type TransferOffer = StandaloneTransferOffer | InConversationTransferOffer;
