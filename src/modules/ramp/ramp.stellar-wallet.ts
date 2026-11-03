import { Injectable } from '@nestjs/common';
import {
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  type xdr,
} from '@stellar/stellar-sdk';
import { PinoLogger } from 'nestjs-pino';

import { getRampConfig } from './ramp.config';
import {
  formatSacAmount,
  isClassicStellarAddress,
  isContractStellarAddress,
  stellarClassicSeed,
  stellarUserIdBytes,
  usdcToStroops,
} from './ramp.stellar-classic';
import { RampStoreService } from './ramp.store';

export {
  formatSacAmount,
  formatUsdcAmount,
  isClassicStellarAddress,
  isContractStellarAddress,
  stellarClassicSeed,
  stellarUserIdBytes,
  usdcToStroops,
} from './ramp.stellar-classic';

/** Mainnet RPC can lag; short polls caused false “not confirmed” + dangerous retries. */
const POLL_ATTEMPTS = 90;
const POLL_INTERVAL_MS = 2000;
/** Keep this much XLM on classic accounts for reserves + fees. */
const CLASSIC_XLM_RESERVE = 1.6;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function stellarClassicKeypair(phone: string, hdMnemonic: string): Keypair {
  return Keypair.fromRawEd25519Seed(stellarClassicSeed(phone, hdMnemonic));
}

function addressFromNative(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw instanceof Address) return raw.toString();
  return Address.fromScVal(raw as xdr.ScVal).toString();
}

function toI128(raw: unknown): bigint {
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return BigInt(Math.trunc(raw));
  if (typeof raw === 'string' && /^-?\d+$/.test(raw)) return BigInt(raw);
  if (raw && typeof raw === 'object' && 'toString' in raw) {
    const s = String((raw as { toString: () => string }).toString());
    if (/^-?\d+$/.test(s)) return BigInt(s);
  }
  return 0n;
}

function amountToHorizonString(amount: number): string {
  return (Math.round(amount * 1e7) / 1e7).toFixed(7);
}

/**
 * Custodial Stellar wallets: classic G… (HD) for new users; Soroban C… helpers for migration.
 */
@Injectable()
export class RampStellarWalletService {
  constructor(
    private readonly store: RampStoreService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RampStellarWalletService.name);
  }

  /** Classic G path ready (mnemonic + operator + Horizon). */
  isClassicConfigured(): boolean {
    const { stellar } = getRampConfig();
    return Boolean(stellar.hdMnemonic && stellar.operatorSecret && stellar.horizonUrl);
  }

  /** Factory still needed to drain legacy C… wallets. */
  isFactoryConfigured(): boolean {
    const { stellar } = getRampConfig();
    return Boolean(stellar.factoryContractId && stellar.operatorSecret && stellar.rpcUrl);
  }

  isConfigured(): boolean {
    return this.isClassicConfigured() || this.isFactoryConfigured();
  }

  keypairForPhone(phone: string): Keypair {
    const { hdMnemonic } = getRampConfig().stellar;
    if (!hdMnemonic) {
      throw new Error('WA_RAMP_STELLAR_HD_MNEMONIC is not set');
    }
    return stellarClassicKeypair(phone, hdMnemonic);
  }

  private horizon(): Horizon.Server {
    return new Horizon.Server(getRampConfig().stellar.horizonUrl, { allowHttp: true });
  }

  private usdcAsset(): Asset {
    const issuer = getRampConfig().stellar.usdcIssuer;
    if (!issuer || !/^G[A-Z0-9]{55}$/i.test(issuer)) {
      throw new Error('WA_RAMP_STELLAR_USDC_ISSUER is not set (classic USDC trustline)');
    }
    return new Asset('USDC', issuer);
  }

  /**
   * Provision classic G… (preferred) or legacy factory C… if HD mnemonic missing.
   * Persists `zyloWallet` when classic.
   */
  async provisionWallet(phone: string): Promise<string | null> {
    if (this.isClassicConfigured()) {
      return this.provisionClassicWallet(phone);
    }
    if (this.isFactoryConfigured()) {
      return this.provisionContractWallet(phone);
    }
    this.logger.warn('[zylo-ramp] Stellar not configured — skip wallet provision');
    return null;
  }

  async provisionClassicWallet(phone: string): Promise<string | null> {
    const normalized = String(phone || '').replace(/\D/g, '');
    const existing = await this.store.getUser(normalized);
    if (existing?.zyloWallet && isClassicStellarAddress(existing.zyloWallet)) {
      await this.ensureClassicActivated(normalized, existing.zyloWallet);
      return existing.zyloWallet;
    }

    const kp = this.keypairForPhone(normalized);
    const address = kp.publicKey();
    await this.ensureClassicActivated(normalized, address);
    await this.store.upsertUser(normalized, { zyloWallet: address });
    this.logger.info({ phone: normalized, address }, '[zylo-ramp] classic G wallet provisioned');
    return address;
  }

  /** createAccount (if needed) + USDC changeTrust. */
  private async ensureClassicActivated(phone: string, address: string): Promise<void> {
    const { stellar } = getRampConfig();
    const horizon = this.horizon();
    const operator = Keypair.fromSecret(stellar.operatorSecret);
    const userKp = this.keypairForPhone(phone);

    let exists = true;
    try {
      await horizon.loadAccount(address);
    } catch (e) {
      const status = (e as { response?: { status?: number } })?.response?.status;
      if (status === 404) exists = false;
      else throw e;
    }

    if (!exists) {
      const starting = String(stellar.activationXlm || 2);
      const opAccount = await horizon.loadAccount(operator.publicKey());
      const createTx = new TransactionBuilder(opAccount, {
        fee: BASE_FEE,
        networkPassphrase: stellar.networkPassphrase,
      })
        .addOperation(
          Operation.createAccount({
            destination: address,
            startingBalance: starting,
          }),
        )
        .setTimeout(180)
        .build();
      createTx.sign(operator);
      const createRes = await horizon.submitTransaction(createTx);
      this.logger.info(
        { phone, address, hash: createRes.hash, starting },
        '[zylo-ramp] classic account created',
      );
    }

    const account = await horizon.loadAccount(address);
    const asset = this.usdcAsset();
    const hasTrust = account.balances.some(
      (b) =>
        b.asset_type !== 'native' &&
        'asset_code' in b &&
        b.asset_code === 'USDC' &&
        'asset_issuer' in b &&
        b.asset_issuer === asset.getIssuer(),
    );
    if (hasTrust) return;

    const trustTx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: stellar.networkPassphrase,
    })
      .addOperation(Operation.changeTrust({ asset }))
      .setTimeout(180)
      .build();
    trustTx.sign(userKp);
    const trustRes = await horizon.submitTransaction(trustTx);
    this.logger.info(
      { phone, address, hash: trustRes.hash },
      '[zylo-ramp] classic USDC trustline added',
    );
  }

  /** Legacy Soroban factory register (migration source only). */
  async provisionContractWallet(phone: string): Promise<string | null> {
    if (!this.isFactoryConfigured()) return null;
    const userId = stellarUserIdBytes(phone);
    const existing = await this.tryGetWallet(userId);
    if (existing) return existing;
    const wallet = await this.invokeRegister(userId);
    this.logger.info({ phone, wallet }, '[zylo-ramp] provisioned legacy C wallet');
    return wallet;
  }

  /**
   * If user still has C… as zyloWallet: create G…, drain funds, flip DB.
   * Returns active G… address (or existing G…).
   */
  async migrateToClassicIfNeeded(phone: string): Promise<{
    wallet: string | null;
    migrated: boolean;
    notifiedNeeded: boolean;
  }> {
    const normalized = String(phone || '').replace(/\D/g, '');
    const user = await this.store.getUser(normalized);
    if (!user) return { wallet: null, migrated: false, notifiedNeeded: false };

    if (user.zyloWallet && isClassicStellarAddress(user.zyloWallet)) {
      const gWallet = user.zyloWallet;
      // Repair: contacts may still hold the old C… from before migration.
      if (user.zyloWalletLegacy && isContractStellarAddress(user.zyloWalletLegacy)) {
        void this.store.remapContactAddresses(user.zyloWalletLegacy, gWallet).catch(() => 0);
      }
      return { wallet: gWallet, migrated: false, notifiedNeeded: false };
    }

    if (!this.isClassicConfigured()) {
      return { wallet: user.zyloWallet, migrated: false, notifiedNeeded: false };
    }

    const legacyC =
      (isContractStellarAddress(user.zyloWallet) ? user.zyloWallet : null) ||
      (isContractStellarAddress(user.zyloWalletLegacy) ? user.zyloWalletLegacy : null);

    const gWallet = await this.provisionClassicWallet(normalized);
    if (!gWallet) return { wallet: null, migrated: false, notifiedNeeded: false };

    let drained = false;
    if (legacyC && this.isFactoryConfigured()) {
      try {
        drained = await this.drainContractWallet(legacyC, gWallet);
      } catch (e) {
        this.logger.error(
          { err: e instanceof Error ? e.message : String(e), phone: normalized, legacyC, gWallet },
          '[zylo-ramp] C→G drain failed',
        );
      }
    }

    const wasContract = isContractStellarAddress(user.zyloWallet);
    await this.store.upsertUser(normalized, {
      zyloWallet: gWallet,
      zyloWalletLegacy: legacyC || user.zyloWalletLegacy || null,
    });

    if (legacyC && legacyC !== gWallet) {
      const remapped = await this.store.remapContactAddresses(legacyC, gWallet).catch(() => 0);
      if (remapped > 0) {
        this.logger.info(
          { phone: normalized, legacyC, gWallet, remapped },
          '[zylo-ramp] remapped contacts C→G',
        );
      }
    }

    return {
      wallet: gWallet,
      migrated: wasContract || drained,
      notifiedNeeded: wasContract,
    };
  }

  /** Move USDC + spendable XLM from Soroban C… to classic G… via operator. */
  async drainContractWallet(fromContract: string, toClassic: string): Promise<boolean> {
    const bal = await this.getContractBalances(fromContract);
    const usdcAmt = Number(formatSacAmount(bal.usdc));
    const xlmAmt = Number(formatSacAmount(bal.xlm));
    let moved = false;

    if (usdcAmt >= 0.0000001) {
      await this.transferTokenContract(
        fromContract,
        getRampConfig().stellar.usdcContractId,
        toClassic,
        usdcAmt,
        'USDC',
      );
      moved = true;
    }
    // Leave a tiny SAC dust if any; transfer almost all XLM.
    if (xlmAmt >= 0.0001) {
      const sendXlm = Math.max(0, Math.floor((xlmAmt - 0.00001) * 1e7) / 1e7);
      if (sendXlm > 0) {
        await this.transferTokenContract(
          fromContract,
          getRampConfig().stellar.xlmContractId,
          toClassic,
          sendXlm,
          'XLM',
        );
        moved = true;
      }
    }
    return moved;
  }

  async getBalances(walletId: string): Promise<{ usdc: bigint; xlm: bigint }> {
    if (isClassicStellarAddress(walletId)) {
      return this.getClassicBalances(walletId);
    }
    return this.getContractBalances(walletId);
  }

  async getClassicBalances(address: string): Promise<{ usdc: bigint; xlm: bigint }> {
    const horizon = this.horizon();
    const account = await horizon.loadAccount(address);
    let xlm = 0n;
    let usdc = 0n;
    const issuer = getRampConfig().stellar.usdcIssuer;
    for (const b of account.balances) {
      if (b.asset_type === 'native') {
        xlm = usdcToStroops(Number(b.balance));
      } else if (
        'asset_code' in b &&
        b.asset_code === 'USDC' &&
        'asset_issuer' in b &&
        b.asset_issuer === issuer
      ) {
        usdc = usdcToStroops(Number(b.balance));
      }
    }
    return { usdc, xlm };
  }

  async getContractBalances(walletContractId: string): Promise<{ usdc: bigint; xlm: bigint }> {
    const [usdc, xlm] = await Promise.all([
      this.getUsdcBalance(walletContractId),
      this.getXlmBalance(walletContractId),
    ]);
    return { usdc, xlm };
  }

  async getTokenBalance(walletContractId: string, tokenContractId: string): Promise<bigint> {
    const { stellar } = getRampConfig();
    if (!stellar.operatorSecret) throw new Error('Stellar operator not configured');
    const operator = Keypair.fromSecret(stellar.operatorSecret);
    const sim = await this.simulate(walletContractId, operator.publicKey(), 'token_balance', [
      Address.fromString(tokenContractId).toScVal(),
    ]);
    const retval: xdr.ScVal | undefined = sim.result?.retval;
    if (!retval) return 0n;
    return toI128(scValToNative(retval));
  }

  async getUsdcBalance(walletContractId: string): Promise<bigint> {
    const { stellar } = getRampConfig();
    if (!stellar.usdcContractId) throw new Error('USDC contract id not configured');
    if (isClassicStellarAddress(walletContractId)) {
      return (await this.getClassicBalances(walletContractId)).usdc;
    }
    return this.getTokenBalance(walletContractId, stellar.usdcContractId);
  }

  async getXlmBalance(walletContractId: string): Promise<bigint> {
    const { stellar } = getRampConfig();
    if (!stellar.xlmContractId) throw new Error('XLM contract id not configured');
    if (isClassicStellarAddress(walletContractId)) {
      return (await this.getClassicBalances(walletContractId)).xlm;
    }
    return this.getTokenBalance(walletContractId, stellar.xlmContractId);
  }

  async transferUsdc(
    fromWallet: string,
    to: string,
    amountUsdc: number,
    phone?: string,
  ): Promise<string> {
    if (isClassicStellarAddress(fromWallet)) {
      return this.transferClassicUsdc(fromWallet, to, amountUsdc, phone);
    }
    const { stellar } = getRampConfig();
    if (!stellar.usdcContractId) throw new Error('USDC contract id not configured');
    const need = usdcToStroops(amountUsdc);
    const bal = await this.getUsdcBalance(fromWallet);
    if (bal < need) {
      throw new Error(
        `Insufficient USDC. You have ${formatSacAmount(bal)}, need ${amountUsdc}. Fund your wallet first.`,
      );
    }
    return this.transferTokenContract(fromWallet, stellar.usdcContractId, to, amountUsdc, 'USDC');
  }

  async transferXlm(
    fromWallet: string,
    to: string,
    amountXlm: number,
    phone?: string,
  ): Promise<string> {
    if (isClassicStellarAddress(fromWallet)) {
      return this.transferClassicXlm(fromWallet, to, amountXlm, phone);
    }
    const { stellar } = getRampConfig();
    if (!stellar.xlmContractId) throw new Error('XLM contract id not configured');
    const need = usdcToStroops(amountXlm);
    const bal = await this.getXlmBalance(fromWallet);
    if (bal < need) {
      throw new Error(
        `Insufficient XLM. You have ${formatSacAmount(bal)}, need ${amountXlm}. Fund your wallet first.`,
      );
    }
    return this.transferTokenContract(fromWallet, stellar.xlmContractId, to, amountXlm, 'XLM');
  }

  private async transferClassicUsdc(
    fromG: string,
    to: string,
    amountUsdc: number,
    phoneHint?: string,
  ): Promise<string> {
    if (!(amountUsdc > 0)) throw new Error('Amount must be positive');
    const bal = await this.getClassicBalances(fromG);
    const need = usdcToStroops(amountUsdc);
    if (bal.usdc < need) {
      throw new Error(
        `Insufficient USDC. You have ${formatSacAmount(bal.usdc)}, need ${amountUsdc}. Fund your wallet first.`,
      );
    }
    const phone =
      phoneHint || (await this.store.findUserByZyloWallet(fromG).then((u) => u?.phone || null));
    if (!phone) throw new Error('Unknown Stellar wallet — cannot sign');
    const userKp = this.keypairForPhone(phone);
    if (userKp.publicKey() !== fromG) {
      throw new Error('Wallet key mismatch — message support');
    }
    const { stellar } = getRampConfig();
    const horizon = this.horizon();
    const account = await horizon.loadAccount(fromG);
    const asset = this.usdcAsset();
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: stellar.networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination: to,
          asset,
          amount: amountToHorizonString(amountUsdc),
        }),
      )
      .setTimeout(180)
      .build();
    tx.sign(userKp);
    const res = await horizon.submitTransaction(tx);
    void this.store
      .recordVolume({ asset: 'usdc', amount: amountUsdc, kind: 'transfer', dedupeKey: res.hash })
      .catch(() => undefined);
    this.logger.info(
      { from: fromG, to, amount: amountUsdc, hash: res.hash },
      '[zylo-ramp] classic USDC payment ok',
    );
    return res.hash;
  }

  /**
   * Refund USDC from the operator vault (WA_RAMP_STELLAR_DEPOSIT_ADDRESS) back
   * to a user's classic G… wallet. Used when airtime/data fails after debit.
   */
  async refundUsdcFromVault(toUserG: string, amountUsdc: number): Promise<string> {
    if (!(amountUsdc > 0)) throw new Error('Refund amount must be positive');
    if (!isClassicStellarAddress(toUserG)) {
      throw new Error('Refund destination must be a classic G… address');
    }
    const { stellar } = getRampConfig();
    if (!stellar.operatorSecret || !stellar.depositAddress) {
      throw new Error('Stellar operator/vault not configured for refunds');
    }
    const operator = Keypair.fromSecret(stellar.operatorSecret);
    const vault = stellar.depositAddress;
    if (operator.publicKey() !== vault) {
      throw new Error(
        `Operator key (${operator.publicKey().slice(0, 6)}…) does not match vault ${vault.slice(0, 6)}…`,
      );
    }

    const horizon = this.horizon();
    const account = await horizon.loadAccount(vault);
    const asset = this.usdcAsset();
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: stellar.networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination: toUserG,
          asset,
          amount: amountToHorizonString(amountUsdc),
        }),
      )
      .setTimeout(180)
      .build();
    tx.sign(operator);
    const res = await horizon.submitTransaction(tx);
    this.logger.info(
      { from: vault, to: toUserG, amount: amountUsdc, hash: res.hash },
      '[zylo-ramp] classic USDC vault refund ok',
    );
    return res.hash;
  }

  private async transferClassicXlm(
    fromG: string,
    to: string,
    amountXlm: number,
    phoneHint?: string,
  ): Promise<string> {
    if (!(amountXlm > 0)) throw new Error('Amount must be positive');
    const bal = await this.getClassicBalances(fromG);
    const available = Number(formatSacAmount(bal.xlm)) - CLASSIC_XLM_RESERVE;
    if (available + 1e-9 < amountXlm) {
      throw new Error(
        `Insufficient XLM. Spendable ~${Math.max(0, available).toFixed(4)} (keeping reserve), need ${amountXlm}.`,
      );
    }
    const phone =
      phoneHint || (await this.store.findUserByZyloWallet(fromG).then((u) => u?.phone || null));
    if (!phone) throw new Error('Unknown Stellar wallet — cannot sign');
    const userKp = this.keypairForPhone(phone);
    if (userKp.publicKey() !== fromG) {
      throw new Error('Wallet key mismatch — message support');
    }
    const { stellar } = getRampConfig();
    const horizon = this.horizon();
    const account = await horizon.loadAccount(fromG);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: stellar.networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination: to,
          asset: Asset.native(),
          amount: amountToHorizonString(amountXlm),
        }),
      )
      .setTimeout(180)
      .build();
    tx.sign(userKp);
    const res = await horizon.submitTransaction(tx);
    void this.store
      .recordVolume({ asset: 'xlm', amount: amountXlm, kind: 'transfer', dedupeKey: res.hash })
      .catch(() => undefined);
    this.logger.info(
      { from: fromG, to, amount: amountXlm, hash: res.hash },
      '[zylo-ramp] classic XLM payment ok',
    );
    return res.hash;
  }

  /** Operator-signed Soroban wallet.transfer (legacy C…). */
  async transferTokenContract(
    walletContractId: string,
    tokenContractId: string,
    to: string,
    amount: number,
    assetLabel = 'token',
  ): Promise<string> {
    const { stellar } = getRampConfig();
    if (!stellar.operatorSecret) throw new Error('Stellar operator not configured');
    const stroops = usdcToStroops(amount);
    if (stroops <= 0n) throw new Error('Amount must be positive');

    const operator = Keypair.fromSecret(stellar.operatorSecret);
    const args = [
      Address.fromString(operator.publicKey()).toScVal(),
      Address.fromString(tokenContractId).toScVal(),
      Address.fromString(to).toScVal(),
      nativeToScVal(stroops, { type: 'i128' }),
    ];

    const prepared = await this.prepare(walletContractId, operator.publicKey(), 'transfer', args);
    prepared.sign(operator);

    const server = this.rpcServer();
    const send = await server.sendTransaction(prepared);
    if (send.status === 'ERROR') {
      throw new Error(
        send.errorResult
          ? `transfer submit failed: ${send.errorResult.toXDR('base64')}`
          : 'transfer submit failed',
      );
    }

    const result = await this.poll(send.hash);
    if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new Error(`transfer tx status=${result.status}`);
    }
    this.logger.info(
      { wallet: walletContractId, to, amount, asset: assetLabel, hash: send.hash },
      '[zylo-ramp] contract token transfer ok',
    );
    const asset = assetLabel === 'XLM' ? 'xlm' : 'usdc';
    void this.store
      .recordVolume({ asset, amount, kind: 'transfer', dedupeKey: send.hash })
      .catch(() => undefined);
    return send.hash;
  }

  private rpcServer(): rpc.Server {
    return new rpc.Server(getRampConfig().stellar.rpcUrl, { allowHttp: true });
  }

  private async tryGetWallet(userId: Buffer): Promise<string | null> {
    try {
      const { stellar } = getRampConfig();
      const operator = Keypair.fromSecret(stellar.operatorSecret);
      const sim = await this.simulate(
        stellar.factoryContractId,
        operator.publicKey(),
        'get_wallet',
        [nativeToScVal(userId, { type: 'bytes' })],
      );
      const retval: xdr.ScVal | undefined = sim.result?.retval;
      if (!retval) return null;
      const native: unknown = scValToNative(retval);
      if (native == null) return null;
      return addressFromNative(native);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn({ err: message }, '[zylo-ramp] get_wallet failed');
      return null;
    }
  }

  private async invokeRegister(userId: Buffer): Promise<string> {
    const { stellar } = getRampConfig();
    const operator = Keypair.fromSecret(stellar.operatorSecret);
    const args = [nativeToScVal(userId, { type: 'bytes' })];
    const prepared = await this.prepare(
      stellar.factoryContractId,
      operator.publicKey(),
      'register',
      args,
    );
    prepared.sign(operator);
    const server = this.rpcServer();
    const send = await server.sendTransaction(prepared);
    if (send.status === 'ERROR') {
      throw new Error(
        send.errorResult
          ? `register submit failed: ${send.errorResult.toXDR('base64')}`
          : 'register submit failed',
      );
    }
    const result = await this.poll(send.hash);
    if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      const existing = await this.tryGetWallet(userId);
      if (existing) return existing;
      throw new Error(`register tx status=${result.status}`);
    }
    const meta = result.returnValue;
    if (!meta) {
      const existing = await this.tryGetWallet(userId);
      if (existing) return existing;
      throw new Error('register succeeded but no return value');
    }
    return addressFromNative(scValToNative(meta));
  }

  private async prepare(
    contractId: string,
    sourcePublicKey: string,
    functionName: string,
    args: xdr.ScVal[],
  ): Promise<ReturnType<TransactionBuilder['build']>> {
    const { stellar } = getRampConfig();
    const server = this.rpcServer();
    const operator = Keypair.fromSecret(stellar.operatorSecret);

    const buildTx = async () => {
      const account = await server.getAccount(sourcePublicKey);
      const contract = new Contract(contractId);
      return new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: stellar.networkPassphrase,
      })
        .addOperation(contract.call(functionName, ...args))
        .setTimeout(180)
        .build();
    };

    let tx = await buildTx();
    let simulated = await server.simulateTransaction(tx);

    if (rpc.Api.isSimulationRestore(simulated)) {
      this.logger.warn(
        { contractId, functionName },
        '[zylo-ramp] ledger restore required — restoring footprint',
      );
      const account = await server.getAccount(operator.publicKey());
      const minResourceFee = Number(simulated.restorePreamble.minResourceFee || 0);
      const fee = (Number(BASE_FEE) + minResourceFee).toString();
      const restoreTx = new TransactionBuilder(account, {
        fee,
        networkPassphrase: stellar.networkPassphrase,
      })
        .setSorobanData(simulated.restorePreamble.transactionData.build())
        .addOperation(Operation.restoreFootprint({}))
        .setTimeout(180)
        .build();
      restoreTx.sign(operator);
      const restoreSend = await server.sendTransaction(restoreTx);
      if (restoreSend.status === 'ERROR') {
        throw new Error('Wallet storage restore failed — try again in a minute');
      }
      const restoreResult = await this.poll(restoreSend.hash);
      if (restoreResult.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error('Wallet storage restore did not confirm — try again shortly');
      }
      tx = await buildTx();
      simulated = await server.simulateTransaction(tx);
    }

    if (rpc.Api.isSimulationError(simulated)) {
      throw new Error(this.mapSimError(simulated.error));
    }
    if (rpc.Api.isSimulationRestore(simulated)) {
      throw new Error('Wallet still needs ledger restore after retry — message support');
    }

    return rpc.assembleTransaction(tx, simulated).build();
  }

  private mapSimError(raw: string): string {
    const text = String(raw || '');
    if (/Error\(Contract,\s*#1\)/.test(text)) {
      return 'Simulation failed: insufficient balance or wallet storage not ready (Contract #1)';
    }
    if (/Error\(Contract,\s*#2\)/.test(text)) {
      return 'Simulation failed: operator not authorized for this wallet (Contract #2)';
    }
    if (/Error\(Contract,\s*#3\)/.test(text)) {
      return 'Simulation failed: invalid amount (Contract #3)';
    }
    if (/Error\(Contract,\s*#6\)/.test(text)) {
      return 'Simulation failed: daily spend limit reached (Contract #6)';
    }
    return `Simulation failed: ${text}`;
  }

  private async simulate(
    contractId: string,
    sourcePublicKey: string,
    functionName: string,
    args: xdr.ScVal[],
  ): Promise<rpc.Api.SimulateTransactionSuccessResponse> {
    const { stellar } = getRampConfig();
    const server = this.rpcServer();
    const account = await server.getAccount(sourcePublicKey);
    const contract = new Contract(contractId);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: stellar.networkPassphrase,
    })
      .addOperation(contract.call(functionName, ...args))
      .setTimeout(30)
      .build();
    const simulated = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(simulated)) {
      throw new Error(`Simulation failed: ${simulated.error}`);
    }
    if (rpc.Api.isSimulationRestore(simulated)) {
      throw new Error('Simulation requires ledger restore');
    }
    return simulated;
  }

  private async poll(hash: string): Promise<rpc.Api.GetTransactionResponse> {
    const server = this.rpcServer();
    for (let i = 0; i < POLL_ATTEMPTS; i++) {
      const tx = await server.getTransaction(hash);
      if (tx.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
        return tx;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`Transaction ${hash} not confirmed after ${POLL_ATTEMPTS} attempts`);
  }
}
