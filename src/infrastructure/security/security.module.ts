import { Global, Module } from '@nestjs/common';

import { CryptoService } from './crypto.service';
import { HashingService } from './hashing.service';

/**
 * Cryptographic primitives.
 *
 * Global because credential hashing and field encryption are needed wherever
 * sensitive data is handled, and because both services are stateless singletons —
 * there is nothing to isolate per consumer.
 */
@Global()
@Module({
  providers: [HashingService, CryptoService],
  exports: [HashingService, CryptoService],
})
export class SecurityModule {}
