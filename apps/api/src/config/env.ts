import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production']).default('development'),
  PORT: z.coerce.number().default(3005),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  CORS_ORIGIN: z.string().default('https://operaciones.flitsas.com'),
  ANTHROPIC_API_KEY: z.string().optional(),
  // FLOTA-03 (post INC-OCR-2026-05-12): modelos OCR configurables por entorno para
  // poder migrar sin redeploy cuando Anthropic deprecate un modelo (causa raíz del
  // incidente: sonnet 20250929 deprecado → not_found_error oculto).
  ANTHROPIC_MODEL_HAIKU: z.string().default('claude-haiku-4-5-20251001'),
  ANTHROPIC_MODEL_SONNET: z.string().default('claude-sonnet-4-6'),
  RUNT_INTERNAL_KEY: z.string().min(20),
  // ADR-OPS-001: direct = integraciones locales; cea-proxy = legacy cea.kyverum.com; auto = direct si FASECOLDA_* presentes
  INTEGRACIONES_MODE: z.enum(['direct', 'cea-proxy', 'auto']).default('auto'),
  FASECOLDA_USER: z.string().optional(),
  FASECOLDA_PASS: z.string().optional(),
  // Sin default: en producción debe venir del .env. Si falta, el boot falla con error claro.
  PII_ENC_KEY: z.string().min(32, 'PII_ENC_KEY es requerido (mín 32 chars)'),
  // Clave HMAC dedicada para búsqueda determinística de cédula (32 bytes hex = 64 chars).
  // Separada de PII_ENC_KEY por principio de mínimo privilegio (ISO A.9.4):
  // si HMAC_KEY se compromete, no compromete la confidencialidad del cifrado.
  PII_HMAC_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'PII_HMAC_KEY debe ser 64 hex chars (32 bytes)'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM_NAME: z.string().default('FLIT Operaciones'),
  // Si el envío de email de validación falla (o SMTP sin configurar), NO bloquear
  // el trámite: devolver el enlace al admin para envío manual. Default true.
  // (z.coerce.boolean trataría "false" como true → usamos transform explícito.)
  TRAMITES_EMAIL_FALLBACK: z.string().optional().transform((v) => v !== 'false' && v !== '0'),
  // TRAM-INNOV A5: bloquear "Enviar a tránsito" si faltan ítems obligatorios del
  // checklist de la tipología elegida. Default true (prod). Solo aplica cuando el
  // trámite tiene `tipologia_codigo` — trámites sin tipología no se ven afectados.
  TRAMITE_STRICT_CHECKLIST: z.string().optional().transform((v) => v !== 'false' && v !== '0'),
  // ADR-OPS-001 F2: motor PDF local vs proxy CEA. `auto` = local si CEA_DOCS_PROXY desactivado.
  PDF_MODE: z.enum(['local', 'cea-proxy', 'auto']).default('auto'),
  // TRAM-TRASPASO-F2 legacy: false/'0' fuerza PDF_MODE=local.
  CEA_DOCS_PROXY_ENABLED: z.string().optional().transform((v) => v !== 'false' && v !== '0'),
  // TRAM-INNOV A4: notificaciones de estado por WhatsApp (Meta Cloud API).
  // Opcionales: si faltan, el canal WhatsApp se desactiva (degradación elegante,
  // se usa email/enlace manual). No romper el boot si no están.
  WHATSAPP_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_ID: z.string().optional(),
  PUBLIC_URL: z.string().default('https://operaciones.flitsas.com'),
  S3_ENDPOINT: z.string().default('s3.kyverum.com'),
  S3_PORT: z.string().default('443'),
  // Credenciales MinIO sin default — deben venir del .env (no usar valores hardcoded en repo).
  S3_ACCESS_KEY: z.string().min(3, 'S3_ACCESS_KEY es requerido'),
  S3_SECRET_KEY: z.string().min(8, 'S3_SECRET_KEY es requerido'),
  GOOGLE_DRIVE_KEY_PATH: z.string().optional(),
  GOOGLE_DRIVE_FOLDER_ID: z.string().default('1cWFfPFpesQbHS6lLikumbDKYHO88G8DC'),
  // RNDC (Sprint 4 Fase 4.2): clave maestra AES-256-GCM (32 bytes hex = 64 chars).
  // En desarrollo se genera al boot si falta; en producción es obligatoria.
  RNDC_ENC_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'RNDC_ENC_KEY debe ser 64 hex chars (32 bytes)').optional(),
  RNDC_MODE: z.enum(['mock', 'real']).default('mock'),
  RNDC_MOCK_ERROR_RATE: z.coerce.number().min(0).max(1).default(0),
  RNDC_MOCK_TIMEOUT_RATE: z.coerce.number().min(0).max(1).default(0.02),
  // OPS-08 (drift-check 2026-06-01): vars antes leídas con process.env directo.
  // NIT de la empresa emisora en RNDC. FUTURO multi-tenant: tabla `empresa`.
  EMPRESA_NIT: z.string().regex(/^\d{6,12}$/, 'EMPRESA_NIT debe ser 6-12 dígitos').default('900000001'),
  // Ambiente RNDC del envío SOAP (independiente de RNDC_MODE mock/real).
  RNDC_AMBIENTE: z.enum(['sandbox', 'produccion']).default('sandbox'),
  // Cron de retención PII: deshabilitado salvo valor '1' explícito (transform → boolean).
  PRIVACY_RETENTION_CRON_ENABLED: z.string().optional().transform((v) => v === '1'),
  // TRAM-INNOV-B3: firma electrónica. `mock` por defecto (CI/dev/demo); `zapsign`
  // requiere ZAPSIGN_API_TOKEN. El webhook se valida con HMAC (FIRMA_WEBHOOK_SECRET).
  FIRMA_PROVIDER: z.enum(['mock', 'zapsign']).default('mock'),
  FIRMA_WEBHOOK_SECRET: z.string().optional(),
  ZAPSIGN_API_TOKEN: z.string().optional(),
  ZAPSIGN_SANDBOX: z.string().optional().transform((v) => v !== 'false' && v !== '0'),
  // Clave dedicada para HMAC de tokens de descarga (independiente de JWT_SECRET).
  // Si no se define, se deriva de JWT_SECRET en runtime para compatibilidad con tokens
  // ya distribuidos. Para rotación: definir esta var, regenerar tokens, distribuir nuevas URLs.
  DOWNLOAD_TOKEN_SECRET: z.string().min(32).optional(),
  // Destinatarios alertas PESV (alcoholimetría positiva, etc.). Coma-separados.
  // Si vacío, fallback a admins activos del tenant. NUNCA debe quedar en kyverum.com.
  PESV_ALERT_RECIPIENTS: z.string().optional(),
  // Destinatarios alertas SLA LAFT/ROS (warn_12h, warn_4h, breach). Coma-separados.
  // Opt-in deliberado: si está vacío, el cron registra la alarma sin destinatarios y
  // emite log warn — NO falla el flujo. Política PO: no setear emails por defecto.
  LAFT_COMPLIANCE_RECIPIENTS: z.string().optional(),
}).superRefine((data, ctx) => {
  // Bloquea CORS_ORIGIN='*' en producción (XSS cross-origin).
  if (data.NODE_ENV === 'production') {
    const origins = data.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);
    if (origins.includes('*')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGIN'],
        message: 'CORS_ORIGIN no puede ser "*" en producción',
      });
    }
    for (const o of origins) {
      if (o !== '*' && !/^https?:\/\//.test(o)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CORS_ORIGIN'],
          message: `CORS_ORIGIN inválido en producción: "${o}" (debe ser URL https://...)`,
        });
      }
    }
  }
});

export const env = envSchema.parse(process.env);

// Lista parseada de orígenes permitidos (consumida por app.ts CORS).
export const corsOrigins: string[] = env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);

// Destinatarios PESV parseados. Vacío → consumidor cae a admins de BD.
export const pesvAlertRecipients: string[] = (env.PESV_ALERT_RECIPIENTS ?? '')
  .split(',').map((e) => e.trim()).filter((e) => e && e.includes('@'));

// Destinatarios LAFT/Compliance parseados. Compartido entre F3 (RTE breach) y F4
// (ROS SLA cron). Mismo contrato que PESV: si está vacío, los consumidores loguean
// y siguen — no es un email transaccional crítico. La obligación legal queda cubierta
// por el reporte WORM. Política PO: NO setear emails por defecto.
export const laftComplianceRecipients: string[] = (env.LAFT_COMPLIANCE_RECIPIENTS ?? '')
  .split(',').map((e) => e.trim()).filter((e) => e && e.includes('@'));
