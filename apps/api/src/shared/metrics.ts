// PESV-07 (B2) — métricas Prometheus para observabilidad de uploads de evidencia
// y cierres de diagnóstico PESV.
//
// Registro dedicado (no el global default) para control explícito. Se expone en
// GET /metrics, fuera de /api. Estar fuera de /api NO lo protege: el vhost del
// subdominio de API enruta la raíz al servicio y la ruta quedó pública en los tres
// ambientes (Bug #11599). Hoy la cierra `shared/middleware/metricsAuth.ts`, que exige
// `Authorization: Bearer ${METRICS_TOKEN}` y responde 404 si esa variable no está.

import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();

// Métricas de runtime del proceso (cpu, memoria, event loop) con prefijo propio.
collectDefaultMetrics({ register: registry, prefix: 'operaciones_' });

export const pesvEvidenciaUploadTotal = new Counter({
  name: 'pesv_evidencia_upload_total',
  help: 'Intentos de upload de evidencia PESV por resultado y mime declarado.',
  labelNames: ['result', 'mime'] as const,
  registers: [registry],
});

export const pesvEvidenciaUploadSizeBytes = new Histogram({
  name: 'pesv_evidencia_upload_size_bytes',
  help: 'Tamaño (bytes) de evidencias PESV subidas con éxito.',
  buckets: [10_000, 100_000, 500_000, 1_000_000, 5_000_000, 10_000_000, 20_000_000],
  registers: [registry],
});

export const pesvDiagnosticoCerradoTotal = new Counter({
  name: 'pesv_diagnostico_cerrado_total',
  help: 'Diagnósticos PESV cerrados (transición WORM).',
  registers: [registry],
});

export const pesvEvidenciaUploadInflight = new Gauge({
  name: 'pesv_evidencia_upload_inflight',
  help: 'Uploads de evidencia PESV en curso (concurrencia instantánea).',
  registers: [registry],
});

// TRAM-10/11 — resiliencia integraciones de trámites.
export const tramFurRequestTotal = new Counter({
  name: 'tram_fur_request_total',
  help: 'Generaciones de FUR (CEA) por resultado.',
  labelNames: ['result'] as const,   // success | upstream_error | timeout | network
  registers: [registry],
});

// TRAM-TRASPASO-F2: generación de documentos legales (contrato/improntas) vía proxy CEA.
export const tramDocGenTotal = new Counter({
  name: 'tram_doc_gen_total',
  help: 'Generaciones de documentos legales de traspaso (CEA) por tipo y resultado.',
  labelNames: ['tipo', 'result'] as const, // tipo: contrato|improntas · result: success|upstream_error|timeout|network
  registers: [registry],
});

export const tramAnthropicRequestTotal = new Counter({
  name: 'tram_anthropic_request_total',
  help: 'Llamadas a Anthropic en trámites (OCR/biométrico) por operación y resultado.',
  labelNames: ['op', 'result'] as const,  // op: ocr|biometric · result: success|error|timeout|no_key
  registers: [registry],
});

// TRAM-INNOV A1 — pre-vuelo (semáforo SOAT/SIMIT/RUNT) computado por resultado.
export const tramPreflightComputedTotal = new Counter({
  name: 'tram_preflight_computed_total',
  help: 'Pre-vuelos de trámite computados por resultado global.',
  labelNames: ['result'] as const,   // green | yellow | red
  registers: [registry],
});

// TRAM-INNOV-PRE-02 — clicks en CTAs accionables del pre-vuelo (telemetría).
export const tramPreflightCtaClickedTotal = new Counter({
  name: 'tram_preflight_cta_clicked_total',
  help: 'Clicks en CTAs accionables del pre-vuelo, por ctaId.',
  labelNames: ['cta_id'] as const,
  registers: [registry],
});

// TRAM-INNOV A4 — notificaciones de estado enviadas por tipo y canal.
export const tramNotifSentTotal = new Counter({
  name: 'tram_notif_sent_total',
  help: 'Notificaciones de estado de trámite enviadas por tipo y canal.',
  labelNames: ['tipo', 'canal'] as const,
  registers: [registry],
});

// HU #11299 — freno de un limitador que dispara (429).
//
// Existe por un punto ciego que abrió la propia corrección de seguridad de esta HU: al poner los
// limitadores del módulo `siigo/` DELANTE de las guardas de permiso, los intentos que exceden la
// ventana se resuelven en 429 y ya no dejan la fila `permiso_denegado` en `siigo_operaciones`. El
// intercambio es el correcto —una bitácora que no se puede inundar vale más que un registro
// exhaustivo que sí—, pero dejaba al actor persistente invisible justo a partir del intento en que
// empieza a ser interesante: la API no exponía ningún contador de 429 ni escribía nada al frenar.
//
// La etiqueta es el NOMBRE del limitador y nada más. Ni la ruta ni la llave: la ruta lleva
// identificadores en los parámetros y la llave lleva el `sub` del usuario, y las dos harían crecer
// la cardinalidad de la serie sin techo. Quién insiste va al log (`shared/middleware/rateLimiter`),
// que es donde una llave se puede leer y caducar; aquí va cuánto, que es lo que se grafica y lo que
// dispara una alerta.
export const rateLimitBloqueadoTotal = new Counter({
  name: 'rate_limit_bloqueado_total',
  help: 'Peticiones rechazadas con 429 por un limitador, por limitador.',
  labelNames: ['limitador'] as const,
  registers: [registry],
});
