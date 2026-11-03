import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  Address,
  Horizon,
  nativeToScVal,
  rpc,
  scValToNative,
  type xdr,
} from '@stellar/stellar-sdk';
import { PinoLogger } from 'nestjs-pino';

import { getRampConfig, isRampEnabled } from './ramp.config';
import {
  buildIncomingCreditCaption,
  formatUsdcWithNgn,
  isUsdcLikeAsset,
  shortStellarAddr,
  stellarTxUrl,
} from './ramp.format';
import { RampOnboardingService } from './ramp.onboarding';
import { renderTransferReceiptPng } from './ramp.receipt';
import { formatSacAmount, RampStellarWalletService } from './ramp.stellar-wallet';
import { RampStoreService } from './ramp.store';
import { RampTxNotifyDedupe } from './ramp.tx-notify-dedupe';
import { RampWhatsAppService } from './ramp.whatsapp';

const POLL_MS = 20_000;
const MAX_SEEN = 2_000;

function topicTransfer(): string {
  return nativeToScVal('transfer', { type: 'symbol' }).toXDR('base64');
}

function amountFromEventValue(value: xdr.ScVal): bigint {
  const native: unknown = scValToNative(value);
  if (typeof native === 'bigint') return native;
  if (typeof native === 'number' && Number.isFinite(native)) return BigInt(Math.trunc(native));
  if (native && typeof native === 'object' && 'amount' in native) {
    const amt = native.amount;
    if (typeof amt === 'bigint') return amt;
    if (typeof amt === 'number') return BigInt(Math.trunc(amt));
    if (typeof amt === 'string' && /^-?\d+$/.test(amt)) return BigInt(amt);
  }
  return 0n;
}

function addressFromTopic(topic: xdr.ScVal): string | null {
  try {
    const native: unknown = scValToNative(topic);
    if (typeof native === 'string') return native;
    return Address.fromScVal(topic).toString();
  } catch {
    return null;
  }
}

/**
 * Poll Soroban getEvents for USDC / XLM SAC transfers into BANJEE smart wallets.
 * Notifies the user on WhatsApp when funds arrive.
 */
@Injectable()
export class RampStellarWatcher implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | null = null;
  private cursor: string | null = null;
  private startLedger: number | null = null;
  private readonly seenTx = new Set<string>();
  /** Classic G… wallets whose recent Horizon history was marked seen without notify (post-boot). */
  private readonly classicSeeded = new Set<string>();
  private scanning = false;

  constructor(
    private readonly store: RampStoreService,
    private readonly whatsapp: RampWhatsAppService,
    private readonly stellarWallets: RampStellarWalletService,
    private readonly onboarding: RampOnboardingService,
    private readonly txNotifyDedupe: RampTxNotifyDedupe,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RampStellarWatcher.name);
  }

  onModuleInit(): void {
    this.start();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  private start(): void {
    if (!isRampEnabled()) {
      this.logger.info('[zylo-ramp] disabled — stellar watcher not started');
      return;
    }
    const { stellar } = getRampConfig();
    if (!stellar.rpcUrl || (!stellar.usdcContractId && !stellar.xlmContractId)) {
      this.logger.warn('[zylo-ramp] Stellar SAC ids / RPC missing — watcher idle');
      return;
    }
    this.logger.info(
      { usdc: stellar.usdcContractId, xlm: stellar.xlmContractId },
      '[zylo-ramp] watching Stellar wallet deposits',
    );
    void this.scanOnce();
    this.timer = setInterval(() => void this.scanOnce(), POLL_MS);
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private server(): rpc.Server {
    return new rpc.Server(getRampConfig().stellar.rpcUrl, { allowHttp: true });
  }

  private remember(txKey: string): boolean {
    if (this.seenTx.has(txKey)) return false;
    this.seenTx.add(txKey);
    if (this.seenTx.size > MAX_SEEN) {
      const drop = [...this.seenTx].slice(0, this.seenTx.size - MAX_SEEN);
      for (const k of drop) this.seenTx.delete(k);
    }
    return true;
  }

  private async scanOnce(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      await this.pollEvents();
      await this.pollClassicPayments();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn({ err: message }, '[zylo-ramp] stellar watcher scan failed');
    } finally {
      this.scanning = false;
    }
  }

  private async pollEvents(): Promise<void> {
    const { stellar } = getRampConfig();
    const server = this.server();
    const transfer = topicTransfer();

    const contractIds = [stellar.usdcContractId, stellar.xlmContractId].filter(Boolean);
    if (!contractIds.length) return;

    if (this.startLedger == null && !this.cursor) {
      const latest = await server.getLatestLedger();
      // Only watch new deposits after boot (avoid spamming historical credits).
      this.startLedger = Math.max(1, latest.sequence - 2);
    }

    const filters = contractIds.map((id) => ({
      type: 'contract' as const,
      contractIds: [id],
      topics: [[transfer, '*', '*', '*']],
    }));

    // getEvents allows max 5 filters — we use ≤2.
    let pages = 0;
    let cursor = this.cursor;

    while (pages < 10) {
      pages += 1;
      const res = cursor
        ? await server.getEvents({
            cursor,
            filters,
            limit: 100,
          })
        : await server.getEvents({
            startLedger: this.startLedger!,
            filters,
            limit: 100,
          });

      for (const ev of res.events || []) {
        await this.handleEvent(ev, stellar.usdcContractId, stellar.xlmContractId);
      }

      if (res.cursor) {
        this.cursor = res.cursor;
        cursor = res.cursor;
      }

      if (!res.events?.length || res.events.length < 100) break;
    }
  }

  private async handleEvent(
    ev: rpc.Api.EventResponse,
    usdcId: string,
    xlmId: string,
  ): Promise<void> {
    if (!ev.inSuccessfulContractCall) return;
    if (!ev.topic || ev.topic.length < 3) return;

    const to = addressFromTopic(ev.topic[2]!);
    if (!to || (!to.startsWith('C') && !to.startsWith('G'))) return;

    const txHash = ev.txHash;
    const txKey = `${txHash}:${ev.id || ev.operationIndex}`;
    if (!this.remember(txKey)) return;

    const user = await this.store.findUserByZyloWallet(to).catch(() => null);
    if (!user?.phone) return;

    const amountRaw = amountFromEventValue(ev.value);
    if (amountRaw <= 0n) return;

    const contractId = ev.contractId || '';
    let asset = 'TOKEN';
    if (contractId === usdcId) asset = 'USDC';
    else if (contractId === xlmId) asset = 'XLM';
    else {
      // Decode topic[3] if present (e.g. "USDC:G…" or "native")
      try {
        const tip: unknown = scValToNative(ev.topic[3]!);
        if (typeof tip === 'string') {
          if (tip === 'native') asset = 'XLM';
          else if (tip.startsWith('USDC')) asset = 'USDC';
          else asset = tip.split(':')[0] || tip;
        }
      } catch {
        /* keep TOKEN */
      }
    }

    const pretty = formatSacAmount(amountRaw);
    const from = addressFromTopic(ev.topic[1]!) || 'unknown';

    this.logger.info(
      { phone: user.phone, to, amount: pretty, asset, txHash },
      '[zylo-ramp] stellar deposit detected',
    );

    if (asset === 'USDC' || asset === 'XLM') {
      const amountNum = Number(pretty);
      if (Number.isFinite(amountNum) && amountNum > 0) {
        void this.store
          .recordVolume({
            asset: asset === 'XLM' ? 'xlm' : 'usdc',
            amount: amountNum,
            kind: 'deposit',
            dedupeKey: txHash,
          })
          .catch(() => undefined);
      }
    }

    // Already notified at send-time (BANJEE → BANJEE transfer)
    if (!this.txNotifyDedupe.tryClaim(txHash, to)) {
      this.logger.info({ txHash, to }, '[zylo-ramp] deposit notify skipped (already sent)');
      return;
    }

    // Resolve sender: @username if another BANJEE wallet, else short address
    let fromLabel = shortStellarAddr(from);
    try {
      if (/^C[A-Z0-9]{55}$/i.test(from)) {
        const peer = await this.store.findUserByZyloWallet(from);
        if (peer?.username) fromLabel = `@${peer.username}`;
      }
    } catch {
      /* keep short addr */
    }

    const amountNum = Number(pretty);
    const amount = Number.isFinite(amountNum) ? amountNum : 0;
    const rate = getRampConfig().rates.sellNgn;

    let balancePretty: string | null = null;
    try {
      const bal = await this.stellarWallets.getBalances(to);
      balancePretty = asset === 'XLM' ? formatSacAmount(bal.xlm) : formatSacAmount(bal.usdc);
    } catch {
      /* ignore */
    }

    const caption = buildIncomingCreditCaption({
      amount,
      asset,
      balancePretty,
      sellRateNgn: rate,
      includeTxUrl: false,
    });
    const amountHero = isUsdcLikeAsset(asset) ? formatUsdcWithNgn(amount, rate) : null;

    try {
      const receiptPng = await renderTransferReceiptPng({
        brandName: this.onboarding.brandName(),
        amount,
        asset,
        amountHero,
        toLabel: user.username ? `@${user.username}` : shortStellarAddr(to),
        toAddress: to,
        fromAddress: from !== 'unknown' ? from : null,
        fromLabel,
        txHash,
        direction: 'received',
      });
      await this.whatsapp.dispatchReplies(user.phone, {
        type: 'image',
        buffer: receiptPng,
        mimeType: 'image/png',
        filename: 'zylo-received.png',
        caption,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn({ err: message }, '[zylo-ramp] deposit receipt image failed');
      const body = buildIncomingCreditCaption({
        amount,
        asset,
        balancePretty,
        sellRateNgn: rate,
        includeTxUrl: true,
        txUrl: stellarTxUrl(txHash),
      });
      try {
        await this.whatsapp.dispatchReplies(user.phone, this.onboarding.balanceActionButtons(body));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn({ err: msg, phone: user.phone }, '[zylo-ramp] deposit notify failed');
        this.seenTx.delete(txKey);
      }
      return;
    }
  }

  /** Horizon payments into classic G… wallets. */
  private async pollClassicPayments(): Promise<void> {
    const { stellar } = getRampConfig();
    if (!stellar.horizonUrl || !stellar.usdcIssuer) return;

    const wallets = await this.store.listClassicZyloWallets(60);
    if (!wallets.length) return;

    const horizon = new Horizon.Server(stellar.horizonUrl, { allowHttp: true });
    for (const { phone, zyloWallet } of wallets) {
      try {
        const page = await horizon.payments().forAccount(zyloWallet).order('desc').limit(8).call();
        // After every deploy, mark the recent window as already-seen so we
        // don't re-WhatsApp historical credits (refunds, prior deposits).
        const seedOnly = !this.classicSeeded.has(zyloWallet);

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
          };
          if (payment.to !== zyloWallet) continue;
          const txHash = payment.transaction_hash;
          const txKey = `classic:${txHash}:${payment.id}`;

          if (seedOnly) {
            this.remember(txKey);
            this.txNotifyDedupe.tryClaim(txHash, zyloWallet);
            continue;
          }

          if (!this.remember(txKey)) continue;

          let asset = 'TOKEN';
          const pretty = payment.amount;
          if (payment.asset_type === 'native') {
            asset = 'XLM';
          } else if (payment.asset_code === 'USDC' && payment.asset_issuer === stellar.usdcIssuer) {
            asset = 'USDC';
          } else {
            continue;
          }

          // Durable skip if we already counted this deposit (survives restarts).
          if (await this.store.hasVolumeDedupeKey(txHash)) {
            this.txNotifyDedupe.tryClaim(txHash, zyloWallet);
            continue;
          }

          const user = await this.store.getUser(phone).catch(() => null);
          if (!user) continue;

          if (!this.txNotifyDedupe.tryClaim(txHash, zyloWallet)) continue;

          const amountNum = Number(pretty);
          if (Number.isFinite(amountNum) && amountNum > 0) {
            void this.store
              .recordVolume({
                asset: asset === 'XLM' ? 'xlm' : 'usdc',
                amount: amountNum,
                kind: 'deposit',
                dedupeKey: txHash,
              })
              .catch(() => undefined);
          }

          const from = payment.from || 'unknown';
          let fromLabel = shortStellarAddr(from);
          try {
            const peer = await this.store.findUserByZyloWallet(from);
            if (peer?.username) fromLabel = `@${peer.username}`;
          } catch {
            /* keep */
          }

          let balancePretty: string | null = null;
          try {
            const bal = await this.stellarWallets.getBalances(zyloWallet);
            balancePretty = asset === 'XLM' ? formatSacAmount(bal.xlm) : formatSacAmount(bal.usdc);
          } catch {
            /* ignore */
          }

          const amount = Number.isFinite(amountNum) ? amountNum : 0;
          const rate = getRampConfig().rates.sellNgn;
          const caption = buildIncomingCreditCaption({
            amount,
            asset,
            balancePretty,
            sellRateNgn: rate,
            includeTxUrl: false,
          });
          const amountHero = isUsdcLikeAsset(asset) ? formatUsdcWithNgn(amount, rate) : null;

          try {
            const receiptPng = await renderTransferReceiptPng({
              brandName: this.onboarding.brandName(),
              amount,
              asset,
              amountHero,
              toLabel: user.username ? `@${user.username}` : shortStellarAddr(zyloWallet),
              toAddress: zyloWallet,
              fromAddress: from !== 'unknown' ? from : null,
              fromLabel,
              txHash,
              direction: 'received',
            });
            await this.whatsapp.dispatchReplies(phone, {
              type: 'image',
              buffer: receiptPng,
              mimeType: 'image/png',
              filename: 'zylo-received.png',
              caption,
            });
          } catch (err) {
            const body = buildIncomingCreditCaption({
              amount,
              asset,
              balancePretty,
              sellRateNgn: rate,
              includeTxUrl: true,
              txUrl: stellarTxUrl(txHash),
            });
            await this.whatsapp
              .dispatchReplies(phone, this.onboarding.balanceActionButtons(body))
              .catch((e) => {
                this.logger.warn(
                  { err: e instanceof Error ? e.message : String(e), phone },
                  '[zylo-ramp] classic deposit notify failed',
                );
                this.seenTx.delete(txKey);
              });
            this.logger.warn(
              { err: err instanceof Error ? err.message : String(err), phone },
              '[zylo-ramp] classic deposit receipt image failed',
            );
          }
          this.logger.info(
            { phone, to: zyloWallet, amount: pretty, asset, txHash },
            '[zylo-ramp] classic stellar deposit detected',
          );
        }

        if (seedOnly) {
          this.classicSeeded.add(zyloWallet);
          this.logger.info(
            { phone, zyloWallet, n: (page.records || []).length },
            '[zylo-ramp] classic payment history seeded (no notify)',
          );
        }
      } catch (e) {
        const status = (e as { response?: { status?: number } })?.response?.status;
        if (status === 404) continue;
        this.logger.warn(
          { err: e instanceof Error ? e.message : String(e), phone, zyloWallet },
          '[zylo-ramp] classic payment poll failed',
        );
      }
    }
  }
}
