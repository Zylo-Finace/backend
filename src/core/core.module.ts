import { Global, Module } from '@nestjs/common';

import { ExceptionTranslatorRegistry } from './errors/exception-translator';

/**
 * Framework-level singletons with no infrastructure dependencies.
 *
 * `core` is the innermost layer: it may be imported by anything and imports
 * nothing from `infrastructure` or `modules`. That direction is what keeps the
 * dependency graph acyclic and lets any feature module be lifted out later.
 */
@Global()
@Module({
  providers: [ExceptionTranslatorRegistry],
  exports: [ExceptionTranslatorRegistry],
})
export class CoreModule {}
