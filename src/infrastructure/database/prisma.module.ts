import { Global, Inject, Module, type OnModuleInit } from '@nestjs/common';

import { ExceptionTranslatorRegistry } from '../../core/errors/exception-translator';
import { PrismaExceptionTranslator } from './prisma-exception.translator';
import { type ExtendedPrismaClient, PrismaService } from './prisma.service';

/**
 * DI token for the tenant-scoped Prisma client.
 *
 * Repositories inject this, never `PrismaService` — the raw service is the
 * unscoped client, and injecting it bypasses tenant isolation. Keeping them as
 * distinct tokens makes that bypass visible in a diff.
 */
export const PRISMA = Symbol('PRISMA_SCOPED_CLIENT');

/** `@InjectPrisma() private readonly db: ExtendedPrismaClient` */
export const InjectPrisma = () => Inject(PRISMA);

@Global()
@Module({
  providers: [
    PrismaService,
    PrismaExceptionTranslator,
    {
      provide: PRISMA,
      useFactory: (prisma: PrismaService): ExtendedPrismaClient => prisma.scoped,
      inject: [PrismaService],
    },
  ],
  exports: [PRISMA, PrismaService],
})
export class PrismaModule implements OnModuleInit {
  constructor(
    private readonly registry: ExceptionTranslatorRegistry,
    private readonly translator: PrismaExceptionTranslator,
  ) {}

  /** Teaches the global exception filter how to interpret Prisma errors. */
  onModuleInit(): void {
    this.registry.register(this.translator);
  }
}
