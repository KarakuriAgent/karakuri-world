import type { TransferOffer } from '../../types/transfer.js';

export class TransferStateStore {
  private readonly transfers = new Map<string, TransferOffer>();

  set(offer: TransferOffer): TransferOffer {
    this.transfers.set(offer.transfer_id, offer);
    return offer;
  }

  get(transferId: string): TransferOffer | null {
    return this.transfers.get(transferId) ?? null;
  }

  has(transferId: string): boolean {
    return this.transfers.has(transferId);
  }

  delete(transferId: string): TransferOffer | null {
    const offer = this.transfers.get(transferId) ?? null;
    if (offer) {
      this.transfers.delete(transferId);
    }
    return offer;
  }

  list(): TransferOffer[] {
    return [...this.transfers.values()].sort((left, right) => left.started_at - right.started_at);
  }

  listByAgent(agentId: string): TransferOffer[] {
    return this.list().filter((offer) => offer.from_agent_id === agentId || offer.to_agent_id === agentId);
  }
}
