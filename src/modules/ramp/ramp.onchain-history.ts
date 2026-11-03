import { Injectable } from '@nestjs/common';
import { Horizon } from '@stellar/stellar-sdk';
import { Contract, JsonRpcProvider, formatUnits, id as ethId } from 'ethers';
import { PinoLogger } from 'nestjs-pino';

import { getRampConfig } from './ramp.config';
import { celoTxUrl, stellarTxUrl } from './ramp.format';

export type OnchainNetwork = 'stellar' | 'celo';
export type OnchainDirection = 'in' | 'out';

export type OnchainTransfer = {
  id: string;
  network: OnchainNetwork;
  direction: OnchainDirection;
  amountUsdc: number;
  asset: string;
  counterparty: string;
  txHash: string;
  txUrl: string;
  createdAt: string;
  status: 'success' | 'pending' | 'failed';
};

const TRANSFER_TOPIC = ethId('Transfer(address,address,uint256)');
const ERC20_DECIMALS_ABI = ['function decimals() view returns (uint8)'] as const;

/**
 * On-demand USDC (and Celo stable) transfer history for custodial wallets.
 * Used by the web portal Activity feed and admin ledger — not a persistent indexer.
 */
@Injectable()
export class RampOnchainHistoryService {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(RampOnchainHistoryService.name);
  }

  async listForWallets(opts: {
    stellarAddress?: string | null;
    celoAddress?: string | null;
    limit?: number;
  }): Promise<OnchainTransfer[]> {
    const limit = Math.min(Math.max(opts.limit ?? 40, 1), 100);
    const [stellar, celo] = await Promise.all([
      opts.stellarAddress && /^[GC][A-Z0-9]{55}$/i.test(opts.stellarAddress)
        ? this.stellarPayments(opts.stellarAddress, limit)
        : Promise.resolve([] as OnchainTransfer[]),
      opts.celoAddress && /^0x[a-fA-F0-9]{40}$/.test(opts.celoAddress)
        ? this.celoTransfers(opts.celoAddress, limit)
        : Promise.resolve([] as OnchainTransfer[]),
    ]);

    return [...stellar, ...celo]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);
  }

  private async stellarPayments(address: string, limit: number): Promise<OnchainTransfer[]> {
    const { stellar } = getRampConfig();
    if (!stellar.horizonUrl) return [];

    try {
      const horizon = new Horizon.Server(stellar.horizonUrl, { allowHttp: true });
      const page = await horizon.payments().forAccount(address).order('desc').limit(limit).call();
      const out: OnchainTransfer[] = [];

      for (const p of page.records || []) {
        if (String(p.type) !== 'payment') continue;
        const payment = p as {
          id: string;
          to: string;
          from?: string;
          amount: string;
          asset_type: string;
          asset_code?: string;
          asset_issuer?: string;
          transaction_hash: string;
          created_at?: string;
        };

        const isUsdc =
          payment.asset_type !== 'native' &&
          payment.asset_code === 'USDC' &&
          (!stellar.usdcIssuer || payment.asset_issuer === stellar.usdcIssuer);
        if (!isUsdc) continue;

        const amount = Number(payment.amount);
        if (!Number.isFinite(amount) || amount <= 0) continue;

        const direction: OnchainDirection = payment.to === address ? 'in' : 'out';
        const counterparty =
          direction === 'in' ? payment.from || 'unknown' : payment.to || 'unknown';
        const txHash = payment.transaction_hash;

        out.push({
          id: `stellar:${txHash}:${payment.id}`,
          network: 'stellar',
          direction,
          amountUsdc: amount,
          asset: 'USDC',
          counterparty,
          txHash,
          txUrl: stellarTxUrl(txHash),
          createdAt: payment.created_at || new Date().toISOString(),
          status: 'success',
        });
      }
      return out;
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err), address },
        '[ramp-onchain] Stellar payment history failed',
      );
      return [];
    }
  }

  private async celoTransfers(address: string, limit: number): Promise<OnchainTransfer[]> {
    const { celo } = getRampConfig();
    const tokens = [
      { symbol: 'USDC', address: celo.usdcAddress, decimals: 6 },
      { symbol: 'USDT', address: celo.usdtAddress, decimals: 6 },
      { symbol: 'cUSD', address: celo.cusdAddress, decimals: 18 },
    ].filter((t) => t.address && /^0x[a-fA-F0-9]{40}$/.test(t.address));

    if (!tokens.length || !celo.rpcUrl) return [];

    try {
      const provider = new JsonRpcProvider(celo.rpcUrl);
      const latest = await provider.getBlockNumber();
      // ~2 days of Celo blocks (5s) — enough for recent Activity without huge RPC load.
      const lookback = Math.min(latest, 35_000);
      const fromBlock = Math.max(0, latest - lookback);
      const padded = '0x' + address.slice(2).toLowerCase().padStart(64, '0');
      const out: OnchainTransfer[] = [];

      for (const token of tokens) {
        let decimals = token.decimals;
        try {
          const c = new Contract(token.address, ERC20_DECIMALS_ABI, provider) as unknown as {
            decimals: () => Promise<number | bigint>;
          };
          const d = await c.decimals();
          if (d != null) decimals = Number(d);
        } catch {
          /* keep default */
        }

        const chunk = 2_000;
        for (let start = fromBlock; start <= latest && out.length < limit * 2; start += chunk + 1) {
          const end = Math.min(latest, start + chunk);
          const [incoming, outgoing] = await Promise.all([
            provider
              .getLogs({
                address: token.address,
                fromBlock: start,
                toBlock: end,
                topics: [TRANSFER_TOPIC, null, padded],
              })
              .catch(() => [] as Awaited<ReturnType<JsonRpcProvider['getLogs']>>),
            provider
              .getLogs({
                address: token.address,
                fromBlock: start,
                toBlock: end,
                topics: [TRANSFER_TOPIC, padded, null],
              })
              .catch(() => [] as Awaited<ReturnType<JsonRpcProvider['getLogs']>>),
          ]);

          for (const log of [...incoming, ...outgoing]) {
            const direction: OnchainDirection =
              log.topics[2]?.toLowerCase() === padded ? 'in' : 'out';
            let counterparty = 'unknown';
            try {
              const topic = direction === 'in' ? log.topics[1] : log.topics[2];
              if (topic && topic.length >= 66) {
                counterparty = '0x' + topic.slice(26);
              }
            } catch {
              /* keep */
            }
            const amount = Number(formatUnits(log.data, decimals));
            if (!Number.isFinite(amount) || amount <= 0) continue;
            const txHash = log.transactionHash;
            // Approximate time from block number (Celo ~5s) — avoids N getBlock RPCs.
            const ageBlocks = Math.max(0, latest - log.blockNumber);
            const createdAt = new Date(Date.now() - ageBlocks * 5_000).toISOString();

            out.push({
              id: `celo:${txHash}:${log.index}:${token.symbol}`,
              network: 'celo',
              direction,
              amountUsdc: amount,
              asset: token.symbol,
              counterparty,
              txHash,
              txUrl: celoTxUrl(txHash),
              createdAt,
              status: 'success',
            });
          }
        }
      }

      return out
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, limit);
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err), address },
        '[ramp-onchain] Celo transfer history failed',
      );
      return [];
    }
  }
}
