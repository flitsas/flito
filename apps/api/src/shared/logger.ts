import pino from 'pino';
import { env } from '../config/env.js';

// Logger estructurado centralizado (ISO 27001 A.8.15 — registro de eventos).
// JSON en producción para ingestión por agregadores (fluent-bit, vector, datadog).
// pino-pretty solo en desarrollo para legibilidad en terminal.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (env.NODE_ENV === 'production' ? 'info' : 'debug'),
  base: { service: 'operaciones-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    // Campos que jamás deben aparecer en logs (ISO 27001 A.8.11 — protección PII).
    paths: ['*.password', '*.passwordHash', '*.claveQR', '*.token', '*.jwt', '*.secret', '*.apiKey'],
    censor: '[REDACTED]',
  },
  ...(env.NODE_ENV !== 'production'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' },
        },
      }
    : {}),
});

// Namespaced child loggers para componentes — facilita filtrado por módulo en agregadores.
export function loggerFor(component: string) {
  return logger.child({ component });
}
