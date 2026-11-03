import { Injectable } from '@nestjs/common';

import type { AppException } from './app.exception';

/**
 * Translates an infrastructure-specific error into a domain {@link AppException}.
 *
 * This is what keeps `core` free of infrastructure imports: the database module
 * contributes a Prisma translator, the storage module an S3 one, and the global
 * exception filter stays ignorant of both. Adding a new infrastructure adapter
 * never means editing the filter (Open/Closed).
 */
export interface ExceptionTranslator {
  /** Returns an AppException when this translator recognises the error, else `undefined`. */
  translate(error: unknown): AppException | undefined;
}

/**
 * Registry of error translators.
 *
 * NestJS has no multi-provider mechanism (unlike Angular), so contributions are
 * registered imperatively at module init rather than by binding many providers to
 * one token. That is also more robust here: registration order cannot silently
 * change which translator "wins" a token, and a module can register conditionally.
 */
@Injectable()
export class ExceptionTranslatorRegistry {
  private readonly translators: ExceptionTranslator[] = [];

  register(translator: ExceptionTranslator): void {
    if (!this.translators.includes(translator)) {
      this.translators.push(translator);
    }
  }

  /** First match wins; `undefined` means no translator recognised the error. */
  translate(error: unknown): AppException | undefined {
    for (const translator of this.translators) {
      const translated = translator.translate(error);
      if (translated) return translated;
    }
    return undefined;
  }

  get size(): number {
    return this.translators.length;
  }
}
