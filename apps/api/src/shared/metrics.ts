// PESV-07 (B2) — métricas Prometheus para observabilidad de uploads de evidencia
// y cierres de diagnóstico PESV.
//
// Registro dedicado (no el global default) para control explícito. Se expone en
// GET /metrics (fuera de /api → nginx no lo proxya públicamente; lo scrapea
// Prometheus desde el host en localhost:3005/metrics).

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
