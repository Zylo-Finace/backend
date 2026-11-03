import { Global, Inject, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';

import { type AppConfig, buildAppConfig } from './app.config';
import { validateEnv } from './env.validation';

/** DI token for the typed, frozen {@link AppConfig} tree. */
export const APP_CONFIG = Symbol('APP_CONFIG');

/** `@InjectConfig() private readonly config: AppConfig` */
export const InjectConfig = () => Inject(APP_CONFIG);

/**
 * Global configuration module.
 *
 * `@nestjs/config` is still mounted because third-party Nest packages expect
 * `ConfigService` to exist, but first-party code should inject {@link APP_CONFIG}.
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // `.env` is a developer convenience. In staging/production the process is
      // configured by real environment variables (Twelve-Factor III).
      envFilePath: ['.env.local', '.env'],
      expandVariables: true,
      validate: validateEnv,
    }),
  ],
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: (): AppConfig => buildAppConfig(validateEnv(process.env)),
    },
  ],
  exports: [APP_CONFIG],
})
export class AppConfigModule {}
