import { Injectable } from '@nestjs/common';

/**
 * Avoid double WhatsApp alerts when we notify the recipient at send-time
 * and the Stellar deposit watcher sees the same transfer shortly after.
 */
@Injectable()
export class RampTxNotifyDedupe {
  private readonly keys = new Set<string>();
  private static readonly MAX = 2_000;

  /** Returns true if this is the first claim (caller should notify). */
  tryClaim(txHash: string, toWallet: string): boolean {
    const key = `${String(txHash || '').trim()}:${String(toWallet || '').trim()}`;
    if (!txHash || !toWallet) return true;
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    if (this.keys.size > RampTxNotifyDedupe.MAX) {
      const drop = [...this.keys].slice(0, this.keys.size - RampTxNotifyDedupe.MAX);
      for (const k of drop) this.keys.delete(k);
    }
    return true;
  }
}
