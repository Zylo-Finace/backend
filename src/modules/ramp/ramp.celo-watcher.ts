import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ethers } from 'ethers';
import { PinoLogger } from 'nestjs-pino';

import { formatCeloStable, RampCeloWalletService } from './ramp.celo-wallet';
import { getRampConfig, isRampEnabled } from './ramp.config';
import { buildIncomingCreditCaption, celoTxUrl, shortEvmAddr } from './ramp.format';
import { RampCommandsService } from './ramp.commands';
import { RampOnboardingService } from './ramp.onboarding';
import { RampStoreService, type RampOrder } from './ramp.store';
import { RampTxNotifyDedupe } from './ramp.tx-notify-dedupe';
import { RampWhatsAppService } from './ramp.whatsapp';

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

@Injectable()
export class RampCeloWatcher implements OnModuleInit, OnModuleDestroy {
  private lastBlock: number | null = null;
  private userLastBlock: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: RampStoreService,
    private readonly whatsapp: RampWhatsAppService,
    private readonly commands: RampCommandsService,
    private readonly celoWallets: RampCeloWalletService,
    private readonly onboarding: RampOnboardingService,
    private readonly txNotifyDedupe: RampTxNotifyDedupe,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RampCeloWatcher.name);
  }

  onModuleInit(): void {
    this.start();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  private provider(): ethers.JsonRpcProvider {
    const { celo } = getRampConfig();
    return new ethers.JsonRpcProvider(celo.rpcUrl, 42220, { staticNetwork: true });
  }

  async markSellCryptoReceived(order: RampOrder, txHash: string): Promise<boolean> {
    if (order.status !== 'awaiting_crypto') return false;
    await this.store.updateOrder(order.ref, { status: 'crypto_received', txHash });
    void this.store
      .recordVolume({
        asset: 'usdc',
        amount: Number(order.amountUsdc),
        kind: 'sell',
        dedupeKey: txHash || `sell:${order.ref}`,
      })
      .catch(() => undefined);

    const bank = order.payoutBank;
    await this.whatsapp.sendText(
      order.phone,
      [
        `✅ Received ${order.amountUsdc} USDC`,
        `Tx: ${txHash}`,
        `Ref: ${order.ref}`,
        '',
        `Paying ₦${order.amountNgn.toLocaleString('en-NG')} to your bank next.`,
      ].join('\n'),
    );

    await this.commands.notifyAdmin(
      [
        `SELL ready to pay NGN`,
        `${order.ref}: ₦${order.amountNgn} → ${bank?.bankName} ${bank?.accountNumber} (${bank?.accountName})`,
        `After you pay NGN, reply: confirm ${order.ref}`,
      ].join('\n'),
    );

    return true;
  }

  /** Operator float: match sell orders awaiting USDC. */
  private async scanVaultDeposits(): Promise<void> {
    const config = getRampConfig();
    if (!config.celo.depositAddress || !config.celo.usdcAddress) return;

    const p = this.provider();
    const latest = await p.getBlockNumber();
    if (this.lastBlock == null) {
      this.lastBlock = Math.max(0, latest - 20);
    }
    if (latest <= this.lastBlock) return;

    const fromBlock = this.lastBlock + 1;
    const toBlock = latest;
    this.lastBlock = latest;

    const deposit = ethers.getAddress(config.celo.depositAddress);
    const usdc = ethers.getAddress(config.celo.usdcAddress);
    const toTopic = ethers.zeroPadValue(deposit, 32);

    const logs = await p.getLogs({
      address: usdc,
      fromBlock,
      toBlock,
      topics: [TRANSFER_TOPIC, null, toTopic],
    });

    if (!logs.length) return;

    const openSells = (await this.store.listOpenOrders()).filter(
      (o) => o.type === 'sell' && o.status === 'awaiting_crypto',
    );
    if (!openSells.length) return;

    for (const log of logs) {
      const amount = Number(ethers.formatUnits(log.data, 6));
      const txHash = log.transactionHash;
      const order = openSells.find((o) => Math.abs(Number(o.amountUsdc) - amount) < 1e-6);
      if (!order) {
        this.logger.info({ amount, txHash }, '[zylo-ramp] unmatched USDC deposit');
        await this.commands.notifyAdmin(`Unmatched deposit ${amount} USDC\n${txHash}`);
        continue;
      }
      const ok = await this.markSellCryptoReceived(order, txHash);
      if (ok) {
        const idx = openSells.findIndex((o) => o.ref === order.ref);
        if (idx >= 0) openSells.splice(idx, 1);
      }
    }
  }

  /**
   * User custodial EOAs: USDC / USDT / cUSD Transfer → WhatsApp (one message).
   * Scans token logs in the block range and matches `to` against known wallets.
   */
  private async scanUserDeposits(): Promise<void> {
    const config = getRampConfig();
    const tokens: Array<{ symbol: string; address: string; decimals: number }> = [];
    for (const t of [
      { symbol: 'USDC', address: config.celo.usdcAddress, decimals: 6 },
      { symbol: 'USDT', address: config.celo.usdtAddress, decimals: 6 },
      { symbol: 'cUSD', address: config.celo.cusdAddress, decimals: 18 },
    ]) {
      if (!/^0x[a-fA-F0-9]{40}$/.test(t.address)) continue;
      try {
        tokens.push({ ...t, address: ethers.getAddress(t.address.toLowerCase()) });
      } catch (e) {
        this.logger.warn(
          { err: e instanceof Error ? e.message : String(e), token: t.symbol, address: t.address },
          '[zylo-ramp] celo token address invalid; skipping',
        );
      }
    }

    if (!tokens.length) return;

    const wallets = await this.store.listCeloWallets(80);
    if (!wallets.length) return;

    const byAddr = new Map<string, string>();
    for (const w of wallets) {
      try {
        byAddr.set(ethers.getAddress(w.celoWallet).toLowerCase(), w.phone);
      } catch {
        /* skip bad */
      }
    }
    if (!byAddr.size) return;

    const p = this.provider();
    const latest = await p.getBlockNumber();
    if (this.userLastBlock == null) {
      // Only notify new deposits after boot (avoid historical spam).
      this.userLastBlock = latest;
      return;
    }
    if (latest <= this.userLastBlock) return;

    const fromBlock = this.userLastBlock + 1;
    const toBlock = latest;
    this.userLastBlock = latest;

    // Cap range so a long outage does not pull huge log sets.
    const safeFrom = Math.max(fromBlock, toBlock - 200);

    for (const token of tokens) {
      let logs: ethers.Log[];
      try {
        logs = await p.getLogs({
          address: ethers.getAddress(token.address),
          fromBlock: safeFrom,
          toBlock,
          topics: [TRANSFER_TOPIC],
        });
      } catch (e) {
        this.logger.warn(
          { err: e instanceof Error ? e.message : String(e), token: token.symbol },
          '[zylo-ramp] celo user deposit getLogs failed',
        );
        continue;
      }

      for (const log of logs) {
        if (!log.topics[2] || log.topics[2].length < 66) continue;
        const to = ethers.getAddress('0x' + log.topics[2].slice(26)).toLowerCase();
        const phone = byAddr.get(to);
        if (!phone) continue;

        const txHash = log.transactionHash;
        if (!this.txNotifyDedupe.tryClaim(txHash, to)) continue;

        let fromLabel = 'unknown';
        try {
          if (log.topics[1] && log.topics[1].length >= 66) {
            const from = ethers.getAddress('0x' + log.topics[1].slice(26));
            fromLabel = shortEvmAddr(from);
            const peer = await this.store.findUserByCeloWallet(from);
            if (peer?.username) fromLabel = `@${peer.username}`;
          }
        } catch {
          /* keep */
        }

        const amount = Number(ethers.formatUnits(log.data, token.decimals));
        if (!Number.isFinite(amount) || amount <= 0) continue;

        void this.store
          .recordVolume({
            asset: 'usdc',
            amount,
            kind: 'deposit',
            dedupeKey: `celo:${txHash}:${token.symbol}`,
          })
          .catch(() => undefined);

        const user = await this.store.getUser(phone).catch(() => null);
        if (!user) continue;

        let balancePretty: string | null = null;
        try {
          const bal = await this.celoWallets.getStableBalances(to);
          balancePretty = formatCeloStable(bal.total);
        } catch {
          /* keep */
        }

        const pretty = formatCeloStable(amount);
        const rate = getRampConfig().rates.sellNgn;
        const body = buildIncomingCreditCaption({
          amount,
          asset: token.symbol,
          balancePretty,
          sellRateNgn: rate,
          includeTxUrl: true,
          txUrl: celoTxUrl(txHash),
        });

        await this.whatsapp
          .dispatchReplies(phone, this.onboarding.balanceActionButtons(body))
          .catch((err) => {
            this.logger.warn(
              { err: err instanceof Error ? err.message : String(err), phone },
              '[zylo-ramp] celo user deposit notify failed',
            );
          });

        this.logger.info(
          { phone, to, amount: pretty, asset: token.symbol, txHash, fromLabel },
          '[zylo-ramp] celo user deposit detected',
        );
      }
    }
  }

  private async scanOnce(): Promise<void> {
    await this.scanVaultDeposits();
    await this.scanUserDeposits();
  }

  start(): void {
    if (!isRampEnabled()) {
      this.logger.info('[zylo-ramp] disabled — celo watcher not started');
      return;
    }
    const { celo } = getRampConfig();
    if (!celo.depositAddress && !celo.hdMnemonic) {
      this.logger.warn('[zylo-ramp] Celo deposit/HD missing — watcher idle');
      return;
    }
    this.logger.info(
      { deposit: celo.depositAddress || null, userDeposits: Boolean(celo.hdMnemonic) },
      '[zylo-ramp] watching Celo USDC vault + user wallet deposits',
    );
    const tick = async () => {
      try {
        await this.scanOnce();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.logger.error({ err: message }, '[zylo-ramp] celo scan error');
      }
    };
    void tick();
    this.timer = setInterval(() => {
      void tick();
    }, 12_000);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
