import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { ZyRampOrder, ZyRampUser } from '@prisma/client';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../infrastructure/database/prisma.service';

const OPEN = ['awaiting_crypto', 'awaiting_ngn', 'crypto_received', 'ngn_received'] as const;

export interface RampPayoutBank {
  bankName: string | null;
  accountNumber: string | null;
  accountName: string | null;
}

export interface RampOrder {
  id: number;
  ref: string;
  type: string;
  phone: string;
  amountUsdc: number;
  amountNgn: number;
  rate: number;
  status: string;
  depositAddress: string | null;
  wallet: string | null;
  chain: string;
  payoutBank: RampPayoutBank | null;
  txHash: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RampUser {
  phone: string;
  wallet: string | null;
  stellarWallet: string | null;
  zyloWallet: string | null;
  zyloWalletLegacy: string | null;
  celoWallet: string | null;
  bankName: string | null;
  bankAccount: string | null;
  accountName: string | null;
  username: string | null;
  email: string | null;
  pinHash: string | null;
  pinSetupHash: string | null;
  onboardingStep: string | null;
  onboardedAt: Date | null;
  whatsappName: string | null;
  isOnboarded: boolean;
}

export interface RampUserPatch {
  wallet?: string | null;
  stellarWallet?: string | null;
  zyloWallet?: string | null;
  zyloWalletLegacy?: string | null;
  celoWallet?: string | null;
  bankName?: string | null;
  bankAccount?: string | null;
  accountName?: string | null;
  username?: string | null;
  email?: string | null;
  pinHash?: string | null;
  pinSetupHash?: string | null;
  onboardingStep?: string | null;
  onboardedAt?: Date | null;
  whatsappName?: string | null;
}

export interface CreateRampOrderInput {
  ref: string;
  type: string;
  phone: string;
  amountUsdc: number;
  amountNgn: number;
  rate: number;
  status: string;
  depositAddress?: string | null;
  wallet?: string | null;
  chain?: string;
  payoutBank?: {
    bankName?: string | null;
    accountNumber?: string | null;
    accountName?: string | null;
  } | null;
  txHash?: string | null;
  expiresAt?: Date | null;
}

export interface UpdateRampOrderPatch {
  status?: string;
  txHash?: string;
}

function mapOrder(row: ZyRampOrder | null): RampOrder | null {
  if (!row) return null;
  return {
    id: row.id,
    ref: row.ref,
    type: row.type,
    phone: row.phone,
    amountUsdc: Number(row.amountUsdc),
    amountNgn: Number(row.amountNgn),
    rate: Number(row.rate),
    status: row.status,
    depositAddress: row.depositAddress,
    wallet: row.wallet,
    chain: row.chain || 'celo',
    payoutBank: row.payoutBankAccount
      ? {
          bankName: row.payoutBankName,
          accountNumber: row.payoutBankAccount,
          accountName: row.payoutAccountName,
        }
      : null,
    txHash: row.txHash,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapUser(row: ZyRampUser | null): RampUser | null {
  if (!row) return null;
  return {
    phone: row.phone,
    wallet: row.wallet,
    stellarWallet: row.stellarWallet || null,
    zyloWallet: row.zyloWallet || null,
    zyloWalletLegacy:
      (row as ZyRampUser & { zyloWalletLegacy?: string | null }).zyloWalletLegacy || null,
    celoWallet: (row as ZyRampUser & { celoWallet?: string | null }).celoWallet || null,
    bankName: row.bankName,
    bankAccount: row.bankAccount,
    accountName: row.accountName,
    username: row.username || null,
    email: row.email || null,
    pinHash: row.pinHash || null,
    pinSetupHash: row.pinSetupHash || null,
    onboardingStep: row.onboardingStep || null,
    onboardedAt: row.onboardedAt || null,
    whatsappName: row.whatsappName || null,
    isOnboarded: Boolean(row.onboardedAt && row.username && row.pinHash),
  };
}

@Injectable()
export class RampStoreService {
  constructor(private readonly prisma: PrismaService) {}

  shortRef(prefix: string): string {
    return `${prefix}_${randomBytes(3).toString('hex')}`;
  }

  async getUser(phone: string): Promise<RampUser | null> {
    try {
      const row = await this.prisma.zyRampUser.findUnique({ where: { phone } });
      return mapUser(row);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Pre-migration deploy: column zylo_wallet missing — degrade without dying.
      if (message.includes('zylo_wallet') || message.includes('zyloWallet')) {
        const rows = await this.prisma.$queryRaw<
          Array<{
            phone: string;
            wallet: string | null;
            stellar_wallet: string | null;
            bank_name: string | null;
            bank_account: string | null;
            account_name: string | null;
            username: string | null;
            email: string | null;
            pin_hash: string | null;
            pin_setup_hash: string | null;
            onboarding_step: string | null;
            onboarded_at: Date | null;
            whatsapp_name: string | null;
          }>
        >`SELECT phone, wallet, stellar_wallet, bank_name, bank_account, account_name,
                 username, email, pin_hash, pin_setup_hash, onboarding_step, onboarded_at, whatsapp_name
          FROM zylo_ramp_users WHERE phone = ${phone} LIMIT 1`;
        const r = rows[0];
        if (!r) return null;
        return {
          phone: r.phone,
          wallet: r.wallet,
          stellarWallet: r.stellar_wallet,
          zyloWallet: null,
          zyloWalletLegacy: null,
          celoWallet: null,
          bankName: r.bank_name,
          bankAccount: r.bank_account,
          accountName: r.account_name,
          username: r.username,
          email: r.email,
          pinHash: r.pin_hash,
          pinSetupHash: r.pin_setup_hash,
          onboardingStep: r.onboarding_step,
          onboardedAt: r.onboarded_at,
          whatsappName: r.whatsapp_name,
          isOnboarded: Boolean(r.onboarded_at && r.username && r.pin_hash),
        };
      }
      throw e;
    }
  }

  /** Lookup by username (case-insensitive). Stored lowercase. */
  async findUserByUsername(username: string): Promise<RampUser | null> {
    const key = String(username || '')
      .trim()
      .replace(/^@/, '')
      .toLowerCase();
    if (!key) return null;
    try {
      const row = await this.prisma.zyRampUser.findFirst({
        where: { username: { equals: key, mode: 'insensitive' } },
      });
      return mapUser(row);
    } catch {
      const rows = await this.prisma.$queryRaw<Array<{ phone: string }>>`
        SELECT phone FROM zylo_ramp_users WHERE lower(username) = ${key} LIMIT 1`;
      if (!rows[0]?.phone) return null;
      return this.getUser(rows[0].phone);
    }
  }

  /** True if username is taken by someone other than `exceptPhone`. */
  async isUsernameTaken(username: string, exceptPhone?: string): Promise<boolean> {
    const key = String(username || '')
      .trim()
      .replace(/^@/, '')
      .toLowerCase();
    if (!key) return false;
    const other = await this.findUserByUsername(key);
    if (!other) return false;
    if (exceptPhone && other.phone === String(exceptPhone).replace(/\D/g, '')) return false;
    return true;
  }

  async upsertUser(phone: string, patch: RampUserPatch): Promise<RampUser | null> {
    const existing = await this.getUser(phone);

    const data: Record<string, unknown> = {
      phone,
      wallet: patch.wallet !== undefined ? patch.wallet : (existing?.wallet ?? null),
      stellarWallet:
        patch.stellarWallet !== undefined ? patch.stellarWallet : (existing?.stellarWallet ?? null),
      bankName: patch.bankName !== undefined ? patch.bankName : (existing?.bankName ?? null),
      bankAccount:
        patch.bankAccount !== undefined ? patch.bankAccount : (existing?.bankAccount ?? null),
      accountName:
        patch.accountName !== undefined ? patch.accountName : (existing?.accountName ?? null),
      username:
        patch.username !== undefined
          ? patch.username
            ? String(patch.username).trim().replace(/^@/, '').toLowerCase()
            : null
          : (existing?.username ?? null),
      email: patch.email !== undefined ? patch.email : (existing?.email ?? null),
      pinHash: patch.pinHash !== undefined ? patch.pinHash : (existing?.pinHash ?? null),
      pinSetupHash:
        patch.pinSetupHash !== undefined ? patch.pinSetupHash : (existing?.pinSetupHash ?? null),
      onboardingStep:
        patch.onboardingStep !== undefined
          ? patch.onboardingStep
          : (existing?.onboardingStep ?? null),
      onboardedAt:
        patch.onboardedAt !== undefined ? patch.onboardedAt : (existing?.onboardedAt ?? null),
      whatsappName:
        patch.whatsappName !== undefined ? patch.whatsappName : (existing?.whatsappName ?? null),
    };

    if (patch.zyloWallet !== undefined) {
      data.zyloWallet = patch.zyloWallet;
    } else if (existing?.zyloWallet) {
      data.zyloWallet = existing.zyloWallet;
    }

    if (patch.zyloWalletLegacy !== undefined) {
      data.zyloWalletLegacy = patch.zyloWalletLegacy;
    } else if (existing?.zyloWalletLegacy) {
      data.zyloWalletLegacy = existing.zyloWalletLegacy;
    }

    if (patch.celoWallet !== undefined) {
      data.celoWallet = patch.celoWallet;
    } else if (existing?.celoWallet) {
      data.celoWallet = existing.celoWallet;
    }

    try {
      if (existing) {
        await this.prisma.zyRampUser.update({
          where: { phone },
          data: data,
        });
      } else {
        await this.prisma.zyRampUser.create({
          data: data as Parameters<typeof this.prisma.zyRampUser.create>[0]['data'],
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes('zylo_wallet') || message.includes('zyloWallet')) {
        delete data.zyloWallet;
        if (existing) {
          await this.prisma.$executeRaw`
            UPDATE zylo_ramp_users SET
              wallet = ${data.wallet as string | null},
              stellar_wallet = ${data.stellarWallet as string | null},
              bank_name = ${data.bankName as string | null},
              bank_account = ${data.bankAccount as string | null},
              account_name = ${data.accountName as string | null},
              username = ${data.username as string | null},
              email = ${data.email as string | null},
              pin_hash = ${data.pinHash as string | null},
              pin_setup_hash = ${data.pinSetupHash as string | null},
              onboarding_step = ${data.onboardingStep as string | null},
              onboarded_at = ${data.onboardedAt as Date | null},
              whatsapp_name = ${data.whatsappName as string | null},
              updated_at = NOW()
            WHERE phone = ${phone}`;
        } else {
          await this.prisma.$executeRaw`
            INSERT INTO zylo_ramp_users
              (phone, wallet, stellar_wallet, bank_name, bank_account, account_name,
               username, email, pin_hash, pin_setup_hash, onboarding_step, onboarded_at, whatsapp_name)
            VALUES
              (${phone}, ${data.wallet as string | null}, ${data.stellarWallet as string | null},
               ${data.bankName as string | null}, ${data.bankAccount as string | null},
               ${data.accountName as string | null}, ${data.username as string | null},
               ${data.email as string | null}, ${data.pinHash as string | null},
               ${data.pinSetupHash as string | null}, ${data.onboardingStep as string | null},
               ${data.onboardedAt as Date | null}, ${data.whatsappName as string | null})`;
        }
      } else {
        throw e;
      }
    }
    return this.getUser(phone);
  }

  async listOpenOrders(): Promise<RampOrder[]> {
    const rows = await this.prisma.zyRampOrder.findMany({
      where: { status: { in: [...OPEN] } },
      orderBy: { id: 'desc' },
    });
    return rows.map((row) => mapOrder(row)!);
  }

  async findOrder(ref: string): Promise<RampOrder | null> {
    const row = await this.prisma.zyRampOrder.findFirst({
      where: { ref: { equals: String(ref), mode: 'insensitive' } },
    });
    return mapOrder(row);
  }

  async findOpenOrderForPhone(phone: string): Promise<RampOrder | null> {
    const row = await this.prisma.zyRampOrder.findFirst({
      where: { phone, status: { in: [...OPEN] } },
      orderBy: { id: 'desc' },
    });
    return mapOrder(row);
  }

  async createOrder(order: CreateRampOrderInput): Promise<RampOrder | null> {
    await this.prisma.zyRampOrder.create({
      data: {
        ref: order.ref,
        type: order.type,
        phone: order.phone,
        amountUsdc: new Prisma.Decimal(order.amountUsdc),
        amountNgn: order.amountNgn,
        rate: order.rate,
        status: order.status,
        depositAddress: order.depositAddress || null,
        wallet: order.wallet || null,
        chain: order.chain || 'celo',
        payoutBankName: order.payoutBank?.bankName || null,
        payoutBankAccount: order.payoutBank?.accountNumber || null,
        payoutAccountName: order.payoutBank?.accountName || null,
        txHash: order.txHash || null,
        expiresAt: order.expiresAt || null,
      },
    });
    return this.findOrder(order.ref);
  }

  async updateOrder(ref: string, patch: UpdateRampOrderPatch): Promise<RampOrder | null> {
    const existing = await this.findOrder(ref);
    if (!existing) return null;

    const data: Prisma.ZyRampOrderUpdateInput = {};
    if (patch.status != null) data.status = patch.status;
    if (patch.txHash != null) data.txHash = patch.txHash;

    await this.prisma.zyRampOrder.update({
      where: { id: existing.id },
      data,
    });
    return this.findOrder(ref);
  }

  /** Lookup by active zyloWallet or legacy C… address. */
  async findUserByZyloWallet(wallet: string): Promise<RampUser | null> {
    const key = String(wallet || '').trim();
    if (!key) return null;
    try {
      const row = await this.prisma.zyRampUser.findFirst({
        where: {
          OR: [{ zyloWallet: key }, { zyloWalletLegacy: key }],
        },
      });
      return mapUser(row);
    } catch {
      const rows = await this.prisma.$queryRaw<Array<{ phone: string }>>`
        SELECT phone FROM zylo_ramp_users
        WHERE zylo_wallet = ${key} OR zylo_wallet_legacy = ${key}
        LIMIT 1`;
      if (!rows[0]?.phone) return null;
      return this.getUser(rows[0].phone);
    }
  }

  /** Classic G… wallets for Horizon deposit polling (capped). */
  async listClassicZyloWallets(limit = 80): Promise<Array<{ phone: string; zyloWallet: string }>> {
    try {
      const rows = await this.prisma.zyRampUser.findMany({
        where: { zyloWallet: { startsWith: 'G' } },
        select: { phone: true, zyloWallet: true },
        take: limit,
        orderBy: { updatedAt: 'desc' },
      });
      return rows
        .filter((r) => Boolean(r.zyloWallet))
        .map((r) => ({ phone: r.phone, zyloWallet: r.zyloWallet as string }));
    } catch {
      return [];
    }
  }

  /** Custodial Celo EOAs for ERC-20 deposit polling (capped). */
  async listCeloWallets(limit = 80): Promise<Array<{ phone: string; celoWallet: string }>> {
    try {
      const rows = await this.prisma.zyRampUser.findMany({
        where: { celoWallet: { startsWith: '0x' } },
        select: { phone: true, celoWallet: true },
        take: limit,
        orderBy: { updatedAt: 'desc' },
      });
      return rows
        .filter((r) => r.celoWallet && /^0x[a-fA-F0-9]{40}$/.test(r.celoWallet))
        .map((r) => ({ phone: r.phone, celoWallet: r.celoWallet as string }));
    } catch {
      try {
        const rows = await this.prisma.$queryRaw<
          Array<{ phone: string; celo_wallet: string | null }>
        >`
          SELECT phone, celo_wallet FROM zylo_ramp_users
          WHERE celo_wallet IS NOT NULL AND celo_wallet LIKE '0x%'
          ORDER BY updated_at DESC
          LIMIT ${limit}`;
        return rows
          .filter((r) => r.celo_wallet && /^0x[a-fA-F0-9]{40}$/.test(r.celo_wallet))
          .map((r) => ({ phone: r.phone, celoWallet: r.celo_wallet as string }));
      } catch {
        return [];
      }
    }
  }

  async findUserByCeloWallet(wallet: string): Promise<RampUser | null> {
    const key = String(wallet || '')
      .trim()
      .toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(key)) return null;
    try {
      const rows = await this.prisma.$queryRaw<Array<{ phone: string }>>`
        SELECT phone FROM zylo_ramp_users
        WHERE lower(celo_wallet) = ${key}
        LIMIT 1`;
      if (!rows[0]?.phone) return null;
      return this.getUser(rows[0].phone);
    } catch {
      return null;
    }
  }

  async findContactByAlias(
    phone: string,
    alias: string,
  ): Promise<{ alias: string; address: string; label: string | null } | null> {
    const key = String(alias || '')
      .trim()
      .replace(/^@/, '')
      .toLowerCase();
    if (!key) return null;
    try {
      const row = await this.prisma.zyRampContact.findUnique({
        where: { phone_alias: { phone, alias: key } },
      });
      if (!row) return null;
      return { alias: row.alias, address: row.address, label: row.label };
    } catch {
      const rows = await this.prisma.$queryRaw<
        Array<{ alias: string; address: string; label: string | null }>
      >`SELECT alias, address, label FROM zylo_ramp_contacts
         WHERE phone = ${phone} AND lower(alias) = ${key} LIMIT 1`;
      return rows[0] || null;
    }
  }

  /** Prefix / contains match on saved contact aliases for the sender. */
  async searchContacts(
    phone: string,
    query: string,
    limit = 8,
  ): Promise<Array<{ alias: string; address: string; label: string | null }>> {
    const key = String(query || '')
      .trim()
      .replace(/^@/, '')
      .toLowerCase();
    if (!key) return [];
    const take = Math.max(1, Math.min(limit, 10));
    try {
      const rows = await this.prisma.zyRampContact.findMany({
        where: {
          phone,
          OR: [
            { alias: { equals: key, mode: 'insensitive' } },
            { alias: { startsWith: key, mode: 'insensitive' } },
            { alias: { contains: key, mode: 'insensitive' } },
            { label: { contains: key, mode: 'insensitive' } },
          ],
        },
        take,
        orderBy: { alias: 'asc' },
      });
      return rows.map((r) => ({ alias: r.alias, address: r.address, label: r.label }));
    } catch {
      try {
        const rows = await this.prisma.$queryRaw<
          Array<{ alias: string; address: string; label: string | null }>
        >`SELECT alias, address, label FROM zylo_ramp_contacts
           WHERE phone = ${phone}
             AND (
               lower(alias) = ${key}
               OR lower(alias) LIKE ${`${key}%`}
               OR lower(alias) LIKE ${`%${key}%`}
               OR (label IS NOT NULL AND lower(label) LIKE ${`%${key}%`})
             )
           ORDER BY
             CASE WHEN lower(alias) = ${key} THEN 0
                  WHEN lower(alias) LIKE ${`${key}%`} THEN 1
                  ELSE 2 END,
             alias
           LIMIT ${take}`;
        return rows;
      } catch {
        return [];
      }
    }
  }

  /** Username prefix / contains search (excludes `exceptPhone`). */
  async searchUsersByUsername(
    query: string,
    opts?: { exceptPhone?: string; limit?: number },
  ): Promise<RampUser[]> {
    const key = String(query || '')
      .trim()
      .replace(/^@/, '')
      .toLowerCase();
    if (!key || key.length < 2) return [];
    const take = Math.max(1, Math.min(opts?.limit ?? 8, 10));
    try {
      const except = opts?.exceptPhone || '';
      const rows = await this.prisma.$queryRaw<Array<{ phone: string }>>`
        SELECT phone FROM zylo_ramp_users
        WHERE username IS NOT NULL
          AND (
            lower(username) = ${key}
            OR lower(username) LIKE ${`${key}%`}
            OR lower(username) LIKE ${`%${key}%`}
          )
          AND (${except} = '' OR phone <> ${except})
        ORDER BY
          CASE WHEN lower(username) = ${key} THEN 0
               WHEN lower(username) LIKE ${`${key}%`} THEN 1
               ELSE 2 END,
          username
        LIMIT ${take}`;
      const out: RampUser[] = [];
      for (const r of rows) {
        const u = await this.getUser(r.phone);
        if (u) out.push(u);
      }
      return out;
    } catch {
      try {
        const rows = await this.prisma.zyRampUser.findMany({
          where: {
            AND: [
              { username: { not: null } },
              {
                OR: [
                  { username: { equals: key, mode: 'insensitive' } },
                  { username: { startsWith: key, mode: 'insensitive' } },
                  { username: { contains: key, mode: 'insensitive' } },
                ],
              },
              ...(opts?.exceptPhone ? [{ phone: { not: opts.exceptPhone } }] : []),
            ],
          },
          take,
          orderBy: { username: 'asc' },
        });
        return rows.map((r) => mapUser(r)).filter((u): u is RampUser => Boolean(u));
      } catch {
        return [];
      }
    }
  }

  async upsertContact(
    phone: string,
    alias: string,
    address: string,
    label?: string | null,
  ): Promise<{ alias: string; address: string }> {
    const key = String(alias || '')
      .trim()
      .replace(/^@/, '')
      .toLowerCase();
    const addr = String(address || '').trim();
    try {
      const row = await this.prisma.zyRampContact.upsert({
        where: { phone_alias: { phone, alias: key } },
        create: { phone, alias: key, address: addr, label: label || null },
        update: { address: addr, label: label || null },
      });
      return { alias: row.alias, address: row.address };
    } catch {
      await this.prisma.$executeRaw`
        INSERT INTO zylo_ramp_contacts (phone, alias, address, label, created_at, updated_at)
        VALUES (${phone}, ${key}, ${addr}, ${label || null}, NOW(), NOW())
        ON CONFLICT (phone, alias)
        DO UPDATE SET address = EXCLUDED.address, label = EXCLUDED.label, updated_at = NOW()`;
      return { alias: key, address: addr };
    }
  }

  /**
   * When a user migrates C… → G…, rewrite every saved contact that still points
   * at the legacy address so @username / aliases keep working.
   */
  async remapContactAddresses(fromAddress: string, toAddress: string): Promise<number> {
    const from = String(fromAddress || '').trim();
    const to = String(toAddress || '').trim();
    if (!from || !to || from === to) return 0;
    try {
      const result = await this.prisma.zyRampContact.updateMany({
        where: { address: from },
        data: { address: to },
      });
      return result.count;
    } catch {
      try {
        const rows = await this.prisma.$executeRaw`
          UPDATE zylo_ramp_contacts SET address = ${to}, updated_at = NOW()
          WHERE address = ${from}`;
        return typeof rows === 'number' ? rows : 0;
      } catch {
        return 0;
      }
    }
  }

  async expireStaleOrders(ttlMinutes: number): Promise<void> {
    const cutoff = new Date(Date.now() - ttlMinutes * 60_000);
    await this.prisma.zyRampOrder.updateMany({
      where: {
        status: { in: ['awaiting_crypto', 'awaiting_ngn'] },
        createdAt: { lt: cutoff },
      },
      data: { status: 'expired' },
    });
  }

  async createBankSend(input: {
    ref: string;
    phone: string;
    amountNgn: number;
    amountUsdc: number;
    rate: number;
    bankCode: string;
    bankName: string;
    accountNumber: string;
    accountName: string;
    status: string;
    platformUserId?: string | null;
    chain?: string;
    stellarTxHash?: string | null;
    celoTxHash?: string | null;
    providerReference?: string | null;
  }): Promise<void> {
    await this.prisma.zyRampBankSend.create({
      data: {
        ref: input.ref,
        phone: input.phone,
        amountNgn: input.amountNgn,
        amountUsdc: input.amountUsdc,
        rate: input.rate,
        bankCode: input.bankCode,
        bankName: input.bankName,
        accountNumber: input.accountNumber,
        accountName: input.accountName,
        status: input.status,
        platformUserId: input.platformUserId || null,
        chain: input.chain || 'stellar',
        stellarTxHash: input.stellarTxHash || null,
        celoTxHash: input.celoTxHash || null,
        providerReference: input.providerReference || null,
      },
    });
  }

  async createBillPurchase(input: {
    ref: string;
    phone: string;
    vertical: 'airtime' | 'data' | 'electricity' | 'cable' | 'betting';
    amountNgn: number;
    amountUsdc: number;
    rate: number;
    productLabel?: string | null;
    customerId?: string | null;
    customerName?: string | null;
    status: string;
    chain?: string;
    stellarTxHash?: string | null;
    celoTxHash?: string | null;
    providerReference?: string | null;
    failureReason?: string | null;
  }): Promise<void> {
    await this.prisma.zyRampBillPurchase.create({
      data: {
        ref: input.ref,
        phone: input.phone,
        vertical: input.vertical,
        amountNgn: input.amountNgn,
        amountUsdc: input.amountUsdc,
        rate: input.rate,
        productLabel: input.productLabel || null,
        customerId: input.customerId || null,
        customerName: input.customerName || null,
        status: input.status,
        chain: input.chain || 'stellar',
        stellarTxHash: input.stellarTxHash || null,
        celoTxHash: input.celoTxHash || null,
        providerReference: input.providerReference || null,
        failureReason: input.failureReason || null,
      },
    });
  }

  async updateBankSend(
    ref: string,
    patch: {
      status?: string;
      chain?: string;
      stellarTxHash?: string | null;
      celoTxHash?: string | null;
      providerReference?: string | null;
      failureReason?: string | null;
      platformUserId?: string | null;
      completedAt?: Date | null;
    },
  ): Promise<void> {
    await this.prisma.zyRampBankSend.update({
      where: { ref },
      data: {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.chain !== undefined ? { chain: patch.chain } : {}),
        ...(patch.stellarTxHash !== undefined ? { stellarTxHash: patch.stellarTxHash } : {}),
        ...(patch.celoTxHash !== undefined ? { celoTxHash: patch.celoTxHash } : {}),
        ...(patch.providerReference !== undefined
          ? { providerReference: patch.providerReference }
          : {}),
        ...(patch.failureReason !== undefined ? { failureReason: patch.failureReason } : {}),
        ...(patch.platformUserId !== undefined ? { platformUserId: patch.platformUserId } : {}),
        ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
      },
    });
  }

  async listProcessingBankSends(limit = 30): Promise<Array<{ ref: string; createdAt: Date }>> {
    return this.prisma.zyRampBankSend.findMany({
      where: { status: 'processing' },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { ref: true, createdAt: true },
    });
  }

  async findBankSendByRef(ref: string): Promise<{
    ref: string;
    phone: string;
    amountNgn: number;
    amountUsdc: number;
    bankName: string;
    accountName: string;
    accountNumber: string;
    status: string;
    stellarTxHash: string | null;
  } | null> {
    const row = await this.prisma.zyRampBankSend.findUnique({ where: { ref } });
    if (!row) return null;
    return {
      ref: row.ref,
      phone: row.phone,
      amountNgn: row.amountNgn,
      amountUsdc: Number(row.amountUsdc),
      bankName: row.bankName,
      accountName: row.accountName,
      accountNumber: row.accountNumber,
      status: row.status,
      stellarTxHash: row.stellarTxHash,
    };
  }

  /** Newest bank sends / sells for a WhatsApp identity (portal receipt recovery). */
  async listRecentBankSendsForPhone(
    phone: string,
    limit = 15,
  ): Promise<
    Array<{
      ref: string;
      amountNgn: number;
      amountUsdc: number;
      bankName: string;
      accountName: string;
      accountNumber: string;
      status: string;
      createdAt: Date;
    }>
  > {
    const keys = [...new Set([phone, phone.replace(/^\+/, '')].filter(Boolean))];
    const rows = await this.prisma.zyRampBankSend.findMany({
      where: { phone: { in: keys } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 40),
      select: {
        ref: true,
        amountNgn: true,
        amountUsdc: true,
        bankName: true,
        accountName: true,
        accountNumber: true,
        status: true,
        createdAt: true,
      },
    });
    return rows.map((row) => ({
      ref: row.ref,
      amountNgn: row.amountNgn,
      amountUsdc: Number(row.amountUsdc),
      bankName: row.bankName,
      accountName: row.accountName,
      accountNumber: row.accountNumber,
      status: row.status,
      createdAt: row.createdAt,
    }));
  }

  async hasVolumeDedupeKey(dedupeKey: string): Promise<boolean> {
    const key = String(dedupeKey || '')
      .trim()
      .slice(0, 160);
    if (!key) return false;
    try {
      const row = await this.prisma.zyRampVolumeEvent.findUnique({
        where: { dedupeKey: key },
        select: { id: true },
      });
      return Boolean(row);
    } catch {
      try {
        const rows = await this.prisma.$queryRaw<Array<{ id: number }>>`
          SELECT id FROM zylo_ramp_volume_events WHERE dedupe_key = ${key} LIMIT 1`;
        return rows.length > 0;
      } catch {
        return false;
      }
    }
  }

  /**
   * Record USDC/XLM volume + transfer count. Idempotent on `dedupeKey`
   * (usually a Stellar tx hash) so retries and inbound+outbound of the same
   * tx do not double-count.
   */
  async recordVolume(opts: {
    asset: 'usdc' | 'xlm';
    amount: number;
    kind: string;
    dedupeKey: string;
  }): Promise<boolean> {
    const amount = Math.round(Number(opts.amount) * 1e6) / 1e6;
    if (!Number.isFinite(amount) || amount <= 0) return false;
    const dedupeKey = String(opts.dedupeKey || '')
      .trim()
      .slice(0, 160);
    if (!dedupeKey) return false;
    const asset = opts.asset === 'xlm' ? 'xlm' : 'usdc';
    const kind = String(opts.kind || 'transfer').slice(0, 32);

    try {
      await this.prisma.$transaction(async (tx) => {
        try {
          await tx.zyRampVolumeEvent.create({
            data: {
              dedupeKey,
              asset,
              amount: new Prisma.Decimal(amount),
              kind,
            },
          });
        } catch (e) {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
            return;
          }
          throw e;
        }

        await tx.zyRampVolumeStats.upsert({
          where: { id: 1 },
          create: {
            id: 1,
            usdcVolume: asset === 'usdc' ? amount : 0,
            xlmVolume: asset === 'xlm' ? amount : 0,
            usdcTransfers: asset === 'usdc' ? 1 : 0,
            xlmTransfers: asset === 'xlm' ? 1 : 0,
            transferCount: 1,
          },
          update: {
            ...(asset === 'usdc'
              ? {
                  usdcVolume: { increment: amount },
                  usdcTransfers: { increment: 1 },
                }
              : {
                  xlmVolume: { increment: amount },
                  xlmTransfers: { increment: 1 },
                }),
            transferCount: { increment: 1 },
          },
        });
      });
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  //  Payout accounts (Sell USDC NGN destinations)
  // ---------------------------------------------------------------------------

  private mapPayoutAccount(row: {
    id: number;
    phone: string;
    bankName: string;
    bankCode: string;
    accountNumber: string;
    accountName: string;
    isDefault: boolean;
    createdAt: Date;
  }): RampPayoutAccount {
    return {
      id: row.id,
      phone: row.phone,
      bankName: row.bankName,
      bankCode: row.bankCode,
      accountNumber: row.accountNumber,
      accountName: row.accountName,
      isDefault: row.isDefault,
      createdAt: row.createdAt,
    };
  }

  async listPayoutAccounts(phone: string): Promise<RampPayoutAccount[]> {
    return this.listPayoutAccountsForPhones([phone]);
  }

  /** WhatsApp may store the same person under WA id, E.164, or local 08…. */
  async listPayoutAccountsForPhones(phones: string[]): Promise<RampPayoutAccount[]> {
    const keys = [...new Set(phones.map((p) => p.trim()).filter(Boolean))];
    if (keys.length === 0) return [];

    try {
      const rows = await this.prisma.zyRampPayoutAccount.findMany({
        where: { phone: { in: keys } },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
      });
      return rows.map((r) => this.mapPayoutAccount(r));
    } catch {
      const out: RampPayoutAccount[] = [];
      const seen = new Set<number>();
      for (const phone of keys) {
        const rows = await this.prisma.$queryRaw<
          Array<{
            id: number;
            phone: string;
            bank_name: string;
            bank_code: string;
            account_number: string;
            account_name: string;
            is_default: boolean;
            created_at: Date;
          }>
        >`SELECT id, phone, bank_name, bank_code, account_number, account_name, is_default, created_at
           FROM zylo_ramp_payout_accounts WHERE phone = ${phone}
           ORDER BY is_default DESC, created_at DESC`;
        for (const r of rows) {
          if (seen.has(r.id)) continue;
          seen.add(r.id);
          out.push(
            this.mapPayoutAccount({
              id: r.id,
              phone: r.phone,
              bankName: r.bank_name,
              bankCode: r.bank_code,
              accountNumber: r.account_number,
              accountName: r.account_name,
              isDefault: r.is_default,
              createdAt: r.created_at,
            }),
          );
        }
      }
      return out.sort(
        (a, b) =>
          Number(b.isDefault) - Number(a.isDefault) ||
          b.createdAt.getTime() - a.createdAt.getTime(),
      );
    }
  }

  async getDefaultPayoutAccount(phone: string): Promise<RampPayoutAccount | null> {
    const all = await this.listPayoutAccounts(phone);
    return all.find((a) => a.isDefault) || all[0] || null;
  }

  async getPayoutAccountById(phone: string, id: number): Promise<RampPayoutAccount | null> {
    try {
      const row = await this.prisma.zyRampPayoutAccount.findFirst({
        where: { id, phone },
      });
      return row ? this.mapPayoutAccount(row) : null;
    } catch {
      const rows = await this.prisma.$queryRaw<
        Array<{
          id: number;
          phone: string;
          bank_name: string;
          bank_code: string;
          account_number: string;
          account_name: string;
          is_default: boolean;
          created_at: Date;
        }>
      >`SELECT id, phone, bank_name, bank_code, account_number, account_name, is_default, created_at
         FROM zylo_ramp_payout_accounts WHERE phone = ${phone} AND id = ${id} LIMIT 1`;
      const r = rows[0];
      if (!r) return null;
      return this.mapPayoutAccount({
        id: r.id,
        phone: r.phone,
        bankName: r.bank_name,
        bankCode: r.bank_code,
        accountNumber: r.account_number,
        accountName: r.account_name,
        isDefault: r.is_default,
        createdAt: r.created_at,
      });
    }
  }

  /**
   * Upsert by (phone, bankCode, accountNumber). Optionally make default and
   * mirror onto ZyRampUser.bank* for legacy sell handlers.
   */
  async upsertPayoutAccount(input: {
    phone: string;
    bankName: string;
    bankCode: string;
    accountNumber: string;
    accountName: string;
    makeDefault: boolean;
  }): Promise<RampPayoutAccount> {
    const phone = input.phone;
    const bankCode = input.bankCode.trim();
    const accountNumber = input.accountNumber.replace(/\D/g, '');
    const bankName = input.bankName.trim();
    const accountName = input.accountName.trim();

    if (input.makeDefault) {
      try {
        await this.prisma.zyRampPayoutAccount.updateMany({
          where: { phone },
          data: { isDefault: false },
        });
      } catch {
        await this.prisma.$executeRaw`
          UPDATE zylo_ramp_payout_accounts SET is_default = false, updated_at = NOW()
          WHERE phone = ${phone}`;
      }
    }

    let row: RampPayoutAccount;
    try {
      const saved = await this.prisma.zyRampPayoutAccount.upsert({
        where: {
          phone_bankCode_accountNumber: { phone, bankCode, accountNumber },
        },
        create: {
          phone,
          bankName,
          bankCode,
          accountNumber,
          accountName,
          isDefault: input.makeDefault,
        },
        update: {
          bankName,
          accountName,
          ...(input.makeDefault ? { isDefault: true } : {}),
        },
      });
      row = this.mapPayoutAccount(saved);
    } catch {
      await this.prisma.$executeRaw`
        INSERT INTO zylo_ramp_payout_accounts
          (phone, bank_name, bank_code, account_number, account_name, is_default, created_at, updated_at)
        VALUES
          (${phone}, ${bankName}, ${bankCode}, ${accountNumber}, ${accountName}, ${input.makeDefault}, NOW(), NOW())
        ON CONFLICT (phone, bank_code, account_number)
        DO UPDATE SET
          bank_name = EXCLUDED.bank_name,
          account_name = EXCLUDED.account_name,
          is_default = CASE WHEN ${input.makeDefault} THEN true ELSE zylo_ramp_payout_accounts.is_default END,
          updated_at = NOW()`;
      const got = await this.getPayoutAccountById(
        phone,
        (
          await this.prisma.$queryRaw<Array<{ id: number }>>`
            SELECT id FROM zylo_ramp_payout_accounts
            WHERE phone = ${phone} AND bank_code = ${bankCode} AND account_number = ${accountNumber}
            LIMIT 1`
        )[0]?.id || 0,
      );
      if (!got) throw new Error('Failed to save payout account');
      row = got;
    }

    if (input.makeDefault || row.isDefault) {
      await this.upsertUser(phone, {
        bankName: row.bankName,
        bankAccount: row.accountNumber,
        accountName: row.accountName,
      });
    }

    return row;
  }

  async setDefaultPayoutAccount(phone: string, id: number): Promise<RampPayoutAccount | null> {
    const acct = await this.getPayoutAccountById(phone, id);
    if (!acct) return null;
    try {
      await this.prisma.zyRampPayoutAccount.updateMany({
        where: { phone },
        data: { isDefault: false },
      });
      await this.prisma.zyRampPayoutAccount.update({
        where: { id },
        data: { isDefault: true },
      });
    } catch {
      await this.prisma.$executeRaw`
        UPDATE zylo_ramp_payout_accounts SET is_default = false, updated_at = NOW() WHERE phone = ${phone}`;
      await this.prisma.$executeRaw`
        UPDATE zylo_ramp_payout_accounts SET is_default = true, updated_at = NOW()
        WHERE phone = ${phone} AND id = ${id}`;
    }
    await this.upsertUser(phone, {
      bankName: acct.bankName,
      bankAccount: acct.accountNumber,
      accountName: acct.accountName,
    });
    return { ...acct, isDefault: true };
  }

  async deletePayoutAccount(phone: string, id: number): Promise<boolean> {
    const acct = await this.getPayoutAccountById(phone, id);
    if (!acct) return false;
    try {
      await this.prisma.zyRampPayoutAccount.delete({ where: { id } });
    } catch {
      await this.prisma.$executeRaw`
        DELETE FROM zylo_ramp_payout_accounts WHERE phone = ${phone} AND id = ${id}`;
    }
    if (acct.isDefault) {
      const next = await this.getDefaultPayoutAccount(phone);
      if (next) {
        await this.setDefaultPayoutAccount(phone, next.id);
      } else {
        await this.upsertUser(phone, {
          bankName: null,
          bankAccount: null,
          accountName: null,
        });
      }
    }
    return true;
  }
}

export interface RampPayoutAccount {
  id: number;
  phone: string;
  bankName: string;
  bankCode: string;
  accountNumber: string;
  accountName: string;
  isDefault: boolean;
  createdAt: Date;
}
