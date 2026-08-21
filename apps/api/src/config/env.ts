import { z } from 'zod';
import dotenv from 'dotenv';
import { COMPARENDOS_EXPORT_MAX_FILAS, CONCILIACION_MAX_FILAS } from '@operaciones/shared-types';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

/**
 * Trata `VAR=` (en blanco) como ausente.
 *
 * `.optional()` de Zod tolera `undefined`, no `''`: dotenv convierte una línea en blanco en cadena
 * vacía, que sí está definida, así que la validación corre igual y falla. Sin esto, copiar
 * `.env.example` a `.env` deja la API sin arrancar por un error que no menciona que la causa fue
 * dejar la variable en blanco — y empuja a rellenar una llave a las apuradas para desatascar el
 * boot, que es justo lo contrario del defecto seguro.
 */
const vacioComoAusente = (v: unknown) => (v === '' ? undefined : v);

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
  // TLS del cliente S3/MinIO. Default true (S3 HTTPS externo). Poner "false" para un MinIO local
  // por HTTP (contenedor en el VPS o dev). Transform explícito: z.coerce.boolean vería "false" como true.
  S3_USE_SSL: z.string().optional().transform((v) => v !== 'false' && v !== '0'),
  // Credenciales MinIO sin default — deben venir del .env (no usar valores hardcoded en repo).
  S3_ACCESS_KEY: z.string().min(3, 'S3_ACCESS_KEY es requerido'),
  S3_SECRET_KEY: z.string().min(8, 'S3_SECRET_KEY es requerido'),
  GOOGLE_DRIVE_KEY_PATH: z.string().optional(),
  // Barrido diario del Drive de derechos: DESHABILITADO salvo '1' explícito. Puerta positiva a
  // propósito — gasta OCR de pago, y no debe encenderse por deducir el entorno. Igual que
  // PRIVACY_RETENTION_CRON_ENABLED.
  DRIVE_DERECHOS_CRON_ENABLED: z.string().optional().transform((v) => v === '1'),
  // Hora local de Colombia a la que barre. Configurable para poder probarlo sin esperar al día
  // siguiente; en producción no hay razón para moverlo de las 9.
  DRIVE_DERECHOS_CRON_HORA: z.coerce.number().int().min(0).max(23).default(9),
  GOOGLE_DRIVE_FOLDER_ID: z.string().default('1cWFfPFpesQbHS6lLikumbDKYHO88G8DC'),
  // RNDC (Sprint 4 Fase 4.2): clave maestra AES-256-GCM (32 bytes hex = 64 chars).
  // En desarrollo se genera al boot si falta; en producción es obligatoria.
  RNDC_ENC_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'RNDC_ENC_KEY debe ser 64 hex chars (32 bytes)').optional(),
  RNDC_MODE: z.enum(['mock', 'real']).default('mock'),
  // Siigo API (Feature #11239): clave maestra AES-256-GCM propia (32 bytes hex = 64 chars).
  // Opcional en el esquema para no romper entornos que aún no usan la integración, pero SIN
  // derivación de respaldo: el servicio de credenciales falla explícitamente si falta (HU #11247).
  SIIGO_ENC_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'SIIGO_ENC_KEY debe ser 64 hex chars (32 bytes)').optional(),
  SIIGO_BASE_URL: z.string().url().default('https://api.siigo.com'),
  // Nombre de la aplicación integradora. Siigo lo exige en TODA petición y bloquea a quien envíe
  // información falsa. Opcional aquí y validado al resolver la configuración: así el arranque no
  // depende de una integración que puede no estar en uso todavía (HU #11248).
  SIIGO_PARTNER_ID: z.string().optional(),
  SIIGO_AMBIENTE: z.enum(['pruebas', 'produccion']).default('pruebas'),
  // `mock` por defecto (HU #11252): mientras no haya credenciales del ambiente real, el valor
  // seguro es NO salir a la red. Pasar a `real` es una decisión explícita de despliegue.
  SIIGO_MODE: z.enum(['mock', 'real']).default('mock'),
  // Interruptor ÚNICO de los tres crons de Siigo —archivo de soportes, sondeo DIAN y vaciado de la
  // cola de emisión— (Bug #11649). Sustituye a `SIIGO_DIAN_CRON_ENABLED`,
  // `SIIGO_ARCHIVO_CRON_ENABLED` y `SIIGO_COLA_CRON_ENABLED`, que se leían crudas de `process.env`
  // con la guarda `=== '0'`: cualquier valor que no fuera exactamente esa cadena —incluida la
  // variable ausente o con el nombre mal escrito— dejaba el cron ENCENDIDO.
  //
  // **El defecto es `off` y esa es la corrección del Bug.** Estos tres ciclos emiten documentos
  // ante la DIAN, y una emisión es irreversible hacia un tercero: arrancarla exige un acto
  // deliberado del despliegue, no la ausencia de una variable. La asimetría es la que decide:
  // NO arrancar se nota —la cola crece y se ve en la bandeja—, arrancar de más no se nota hasta
  // que el documento ya está ante la DIAN. Es además el mismo criterio que ya usan los crons de
  // portal y de purga de comparendos en `server.ts` (apagados salvo `=1`); estaba invertido justo
  // en los tres que más caro cuestan.
  SIIGO_CRONS: z.enum(['on', 'off']).default('off'),
  RNDC_MOCK_ERROR_RATE: z.coerce.number().min(0).max(1).default(0),
  RNDC_MOCK_TIMEOUT_RATE: z.coerce.number().min(0).max(1).default(0.02),
  // ── Monitoreo de comparendos (Feature #11492, 17a) ─────────────────────────
  //
  // Hosts SIEMPRE por env, nunca en el código: es decisión cerrada del Feature. Los proveedores
  // cambian de dominio y cada ambiente apunta a uno distinto. Sin default para no fingir que hay
  // un valor bueno; los adapters fallan explícito si falta y `MODE=real`.
  VERIFIK_SIMIT_BASE_URL: z.preprocess(vacioComoAusente, z.string().url().optional()),
  UTS_MUNICIPAL_BASE_URL: z.preprocess(vacioComoAusente, z.string().url().optional()),
  // Llave maestra del token SIMIT (ADR-0002). Dedicada y no derivada de SIIGO_ENC_KEY / RNDC_ENC_KEY
  // por mínimo privilegio: si se compromete una, las otras integraciones siguen protegidas. Opcional
  // aquí para que el boot no exija provisionarla antes de que el módulo se use; el servicio del
  // token falla explícito cuando falta (no cifra ni descifra a medias).
  COMPARENDOS_ENC_KEY: z.preprocess(
    vacioComoAusente,
    z.string().regex(/^[0-9a-fA-F]{64}$/, 'COMPARENDOS_ENC_KEY debe ser 64 hex chars (32 bytes)').optional(),
  ),
  // Bootstrap SOLO de desarrollo del token SIMIT (HU #11498). La fuente de verdad operativa es la
  // fila cifrada de `flito_comparendos_token_simit`: esto existe para que un entorno recién clonado
  // pueda probar el sync sin pasar antes por el PUT, y el servicio lo usa únicamente cuando NO hay
  // fila activa. Nunca se loguea ni se devuelve por el API. En PDN no sustituye al cifrado en
  // reposo — un token en env no tiene trazabilidad de quién lo puso ni cuándo (CF-03).
  VERIFIK_SIMIT_TOKEN: z.preprocess(vacioComoAusente, z.string().min(1).optional()),
  // `mock` por defecto: sin credenciales reales, un test o un dev no deben salir a la red.
  COMPARENDOS_SIMIT_MODE: z.enum(['mock', 'real']).default('mock'),
  // Retención del histórico de registros/timeline (CF Habeas Data, Ley 1581). 24 meses por defecto,
  // parametrizable — decisión humana del 2026-08-13. Desde la HU #11511 la CONSUME de verdad
  // `flito-comparendos-purga.cron.ts`: los comparendos que nadie ha vuelto a ver desde el corte y las
  // corridas de sync anteriores a él se borran (con su timeline y sus pasos, por CASCADE).
  COMPARENDOS_RETENTION_MONTHS: z.coerce.number().int().min(1).max(120).default(24),
  // Puerta positiva del cron de purga (RN-28), mismo criterio que PRIVACY_RETENTION_CRON_ENABLED: un
  // job que BORRA no se enciende por desplegarse, sino cuando alguien decide que puede empezar. Con
  // la puerta cerrada, `runComparendosPurgaOnce()` sigue siendo invocable a mano (y en seco).
  COMPARENDOS_PURGA_CRON_ENABLED: z.string().optional().transform((v) => v === '1'),
  // Freno de la purga (RN-30), el análogo irreversible del freno de inactivación. `LOTE × MAX_LOTES`
  // limita el RITMO del borrado (10 000 filas/día), no el daño: una purga equivocada vacía la tabla
  // igual, solo que despacio. Una pasada se aborta entera si los candidatos superan MAX_RATIO de la
  // tabla, o si no hay ninguna corrida de sync terminada en SYNC_MAX_DIAS — el reloj de la retención
  // es `ultimo_visto_en` y solo lo mueve el sync: con el sync parado, la tabla envejece ENTERA y la
  // purga acabaría borrando datos vigentes en silencio. Subir MAX_RATIO es la salida deliberada para
  // la primera pasada de una base con años de histórico, después de mirar el `dryRun`.
  COMPARENDOS_PURGA_MAX_RATIO: z.coerce.number().min(0.01).max(1).default(0.25),
  COMPARENDOS_PURGA_SYNC_MAX_DIAS: z.coerce.number().int().min(1).max(365).default(7),
  // Timeout por llamada al proveedor y cuántas municipales van en paralelo por NIT (ADR-0001 §7).
  // No son ajustes de gusto: el sync es síncrono y el nginx del web corta a los ~120 s, así que la
  // matriz NIT × municipios en serie con los 15 s por defecto de `httpsGetJson` se pasa de largo.
  COMPARENDOS_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(8000),
  COMPARENDOS_SYNC_CONCURRENCIA: z.coerce.number().int().min(1).max(12).default(5),
  // Freno de inactivación masiva del sync (RN-24). Una corrida cuyo barrido apagaría más de estos
  // topes no apaga nada y se cierra como `partial`. El escenario que cubre no necesita atacante: un
  // token vencido cuyo proveedor conteste 200 con lista vacía pasa todos los filtros sin ruido, y el
  // histórico apagado es reversible en los registros pero NO en el timeline. Los defaults son la
  // escala de un catálogo normal; súbelos si la operación real los roza.
  COMPARENDOS_INACTIVACION_MAX_FILAS: z.coerce.number().int().min(1).max(1_000_000).default(200),
  COMPARENDOS_INACTIVACION_MAX_RATIO: z.coerce.number().min(0.01).max(1).default(0.5),
  // Tope de filas de un export a Excel del consolidado (HU #11558, ADR-0004 §2). Un filtro que
  // devuelva más responde 422 y no genera archivo. El default es la constante de
  // `packages/shared-types` —una sola fuente para el número que la pantalla usa al explicar el 422—
  // y esta variable existe para poder BAJARLO con datos reales del `pii_access_log` sin desplegar.
  //
  // El techo de 20 000 no es holgura: es el punto en el que el propio ADR dice que el debate deja de
  // ser el tope y pasa a ser la arquitectura (export asíncrono), así que subirlo más allá exige un
  // ADR sucesor y no una variable de entorno. Súbelo aquí y el boot falla, que es la conversación
  // que se quiere tener. Ojo: esta perilla es una decisión de PRIVACIDAD disfrazada de configuración
  // —multiplica por 5/min el techo de extracción del módulo— y ADR-0004 es dónde está escrito.
  COMPARENDOS_EXPORT_MAX_FILAS: z.coerce.number().int().min(1).max(20_000)
    .default(COMPARENDOS_EXPORT_MAX_FILAS),
  // Feature #11623 — tope de líneas de una boleta de conciliación. Perilla y no constante porque el
  // coste real no es leer el Excel: es que la HU siguiente asienta UNA salida de bolsa por línea, en
  // serie y dentro de una sola transacción, porque el saldo se encadena. El techo de 2 000 es el
  // punto en el que esa transacción deja de ser reintentable a mano: pasarlo pide otro diseño (lote
  // asíncrono), no otra variable. El valor por defecto es CONCILIACION_MAX_FILAS de shared-types,
  // que es el número que la pantalla anuncia antes de subir el archivo.
  CONCILIACION_MAX_FILAS: z.coerce.number().int().min(1).max(2_000)
    .default(CONCILIACION_MAX_FILAS),
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
  // ── FLITO (migración packages/ → Operaciones) ──────────────────────────────
  // Umbral de confianza OCR por defecto (0..1). Sobrescribible por proveedor/organismo.
  // Un campo bajo este umbral cae en la cola de revisión (RN-04/CA-06).
  OCR_UMBRAL_DEFECTO: z.coerce.number().min(0).max(1).default(0.85),
  // Cron de sincronización desde FLIT (formato de 6 campos, con segundos). Default: cada 5 min.
  SYNC_CRON: z.string().default('0 */5 * * * *'),
  // Habilita el job de sincronización FLITO. Default true; 'false'/'0' lo apaga.
  SYNC_HABILITADO: z.string().optional().transform((v) => v !== 'false' && v !== '0'),
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
