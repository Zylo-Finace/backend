import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import type { AppConfig } from '../config/app.config';
import { ApiErrorResponse } from '../core/dto/api-response.dto';

/**
 * OpenAPI document generation.
 *
 * Mounted only outside production by default: the spec enumerates every endpoint
 * and field, which is free reconnaissance for an attacker. Teams that publish
 * docs publicly should serve the generated JSON from a separate, authenticated
 * host rather than exposing the live UI from the API process.
 */
export function setupSwagger(app: INestApplication, config: AppConfig): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('BANJEE API')
      .setDescription(
        [
          'BANJEE — WhatsApp finance platform (subsidiary of BANJEE TECHNOLOGIES LLP).',
          'Built on the Meta Cloud API.',
          '',
          '### Conventions',
          '- Every response uses a common envelope: `{ success, data, meta?, requestId, timestamp }`.',
          '- Errors carry a stable `error.code`. **Branch on the code, never on the HTTP status or message.**',
          '- `error.retryable` tells a client whether replaying the request may succeed.',
          '- List endpoints use cursor pagination; pass the opaque `meta.nextCursor` back as `cursor`.',
          '- Mutating endpoints accept an `Idempotency-Key` header and are safe to retry.',
          '- Quote the `requestId` from any response when contacting support — it maps to the server trace.',
        ].join('\n'),
      )
      .setVersion('1.0')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Short-lived access token from `POST /api/v1/auth/login`.',
        },
        'access-token',
      )
      .addApiKey(
        {
          type: 'apiKey',
          name: 'X-API-Key',
          in: 'header',
          description: 'Server-to-server credential. Scoped to one tenant.',
        },
        'api-key',
      )
      .addServer(config.app.url, 'Current environment')
      .build(),
    {
      // Registers shared response schemas that individual controllers reference
      // rather than redeclaring.
      extraModels: [ApiErrorResponse],
      operationIdFactory: (controllerKey: string, methodKey: string) =>
        `${controllerKey.replace(/Controller$/, '')}_${methodKey}`,
    },
  );

  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: 'docs/json',
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true,
      docExpansion: 'none',
      filter: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
    },
    customSiteTitle: 'BANJEE API',
  });
}
