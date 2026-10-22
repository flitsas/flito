// HU #13268 (Feature #13267, ADR-0020) — tabla de clasificación de la respuesta de FLIT 2 al envío de
// un adjunto (diseño §5), fila a fila, como función pura y sin red. Decide por `code`, nunca por
// `detail`; un 404 SIN problem+json es «ruta aún no desplegada» (pausa), no `procedure_not_found`.

import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import {
  clasificarRespuestaAdjunto, problemaDesdeTexto, urlDeEnvioAdjunto, mimeAdjuntoPorBytes,
  ESTADOS_FLIT2_ADMITEN_ADJUNTO, MAX_BYTES_ADJUNTO, TIPO_LIQUIDACION_IMPUESTO,
} from '../../src/modules/flito-sync/flit2-adjuntos.js';

const SHA = createHash('sha256').update('comprobante').digest('hex');
const recibido = (over: Record<string, unknown> = {}) => ({
  adjuntoId: '0192b7c4-9a1b-7c2d-8e3f-4a5b6c7d8e9f', tipo: TIPO_LIQUIDACION_IMPUESTO, sha256: SHA,
  reemplazoDe: null, enMatriz: true, pagadoMarcado: false, ...over,
});
const p = (cuerpo: unknown) => problemaDesdeTexto(JSON.stringify(cuerpo));

describe('constantes del contrato (D-8)', () => {
  it('tipo liquidacion_impuesto, 20 MB exactos y los cuatro estados que admiten el adjunto', () => {
    expect(TIPO_LIQUIDACION_IMPUESTO).toBe('liquidacion_impuesto');
    expect(MAX_BYTES_ADJUNTO).toBe(20_971_520);
    expect([...ESTADOS_FLIT2_ADMITEN_ADJUNTO]).toEqual(['preasignacion', 'asignado', 'entregado', 'rechazado']);
  });
});

describe('problemaDesdeTexto', () => {
  it('cuerpo vacío, no JSON o JSON sin code → null (lo que distingue el 404 de ruta inexistente)', () => {
    expect(problemaDesdeTexto('')).toBeNull();
    expect(problemaDesdeTexto(null)).toBeNull();
    expect(problemaDesdeTexto('<html>Not Found</html>')).toBeNull();
    expect(problemaDesdeTexto('{"detail":"algo"}')).toBeNull();
  });
  it('terminal y estado SOLO se leen en not_allowed_in_state', () => {
    expect(p({ code: 'not_allowed_in_state', terminal: false, estado: 'borrador', detail: 'x' }))
      .toEqual({ code: 'not_allowed_in_state', terminal: false, estado: 'borrador' });
    expect(p({ code: 'attachment_exists', terminal: true, estado: 'aprobado' })).toEqual({ code: 'attachment_exists' });
  });
  it('terminal no booleano queda ausente', () => {
    expect(p({ code: 'not_allowed_in_state', terminal: 'true' })).toEqual({ code: 'not_allowed_in_state' });
  });
});

describe('clasificarRespuestaAdjunto — tabla §5', () => {
  it('201 con AdjuntoRecibido válido y sha256 igual → enviado nuevo (AC1); guarda pagadoMarcado sin decidir', () => {
    const r = clasificarRespuestaAdjunto(201, null, null, { cuerpo: recibido(), sha256Local: SHA });
    expect(r).toEqual({ tipo: 'enviado', nuevo: true, recibido: expect.objectContaining({ adjuntoId: recibido().adjuntoId, pagadoMarcado: false, enMatriz: true }) });
  });
  it('200 con el mismo sha256 → enviado NO nuevo (AC8, idempotente)', () => {
    expect(clasificarRespuestaAdjunto(200, null, null, { cuerpo: recibido(), sha256Local: SHA })).toMatchObject({ tipo: 'enviado', nuevo: false });
  });
  it('2xx fuera de contrato → reintentable respuesta_invalida; sha256 distinto → reintentable sha256_distinto', () => {
    expect(clasificarRespuestaAdjunto(201, null, null, { cuerpo: { adjuntoId: 'x' }, sha256Local: SHA }))
      .toEqual({ tipo: 'reintentable', codigo: 'respuesta_invalida', status: 201 });
    expect(clasificarRespuestaAdjunto(201, null, null, { cuerpo: null, sha256Local: SHA }))
      .toEqual({ tipo: 'reintentable', codigo: 'respuesta_invalida', status: 201 });
    expect(clasificarRespuestaAdjunto(200, null, null, { cuerpo: recibido({ sha256: 'a'.repeat(64) }), sha256Local: SHA }))
      .toEqual({ tipo: 'reintentable', codigo: 'sha256_distinto', status: 200 });
  });
  it('401 (tras la renovación única) → reintentable invalid_token (AC5)', () => {
    expect(clasificarRespuestaAdjunto(401, p({ code: 'invalid_token' }), null)).toEqual({ tipo: 'reintentable', codigo: 'invalid_token', status: 401 });
  });
  it('403 insufficient_scope → pausa', () => {
    expect(clasificarRespuestaAdjunto(403, p({ code: 'insufficient_scope' }), null)).toEqual({ tipo: 'pausa', codigo: 'insufficient_scope', status: 403 });
  });
  it('404 SIN cuerpo → pausa no_disponible; 404 procedure_not_found → definitivo (AC7, D-7)', () => {
    expect(clasificarRespuestaAdjunto(404, null, null)).toEqual({ tipo: 'pausa', codigo: 'no_disponible', status: 404 });
    expect(clasificarRespuestaAdjunto(404, p({ code: 'procedure_not_found' }), null)).toEqual({ tipo: 'definitivo', motivo: 'procedure_not_found', status: 404 });
  });
  it('400 missing_file / invalid_mime / file_too_large → definitivo; invalid_tipo → pausa', () => {
    for (const code of ['missing_file', 'invalid_mime', 'file_too_large'] as const) {
      expect(clasificarRespuestaAdjunto(400, p({ code }), null)).toEqual({ tipo: 'definitivo', motivo: code, status: 400 });
    }
    expect(clasificarRespuestaAdjunto(400, p({ code: 'invalid_tipo' }), null)).toEqual({ tipo: 'pausa', codigo: 'invalid_tipo', status: 400 });
  });
  it('409 attachment_exists (sin extensiones) → definitivo (AC6 → ya_cargado_gestor)', () => {
    expect(clasificarRespuestaAdjunto(409, p({ code: 'attachment_exists' }), null)).toEqual({ tipo: 'definitivo', motivo: 'attachment_exists', status: 409 });
  });
  it('409 not_allowed_in_state terminal:true → definitivo con el estado de FLIT 2 (AC6)', () => {
    expect(clasificarRespuestaAdjunto(409, p({ code: 'not_allowed_in_state', terminal: true, estado: 'aprobado' }), null))
      .toEqual({ tipo: 'definitivo', motivo: 'not_allowed_in_state', status: 409, estadoFlit2: 'aprobado' });
  });
  it('409 not_allowed_in_state terminal:false → estacionar SIN intento (AC5 excepción)', () => {
    expect(clasificarRespuestaAdjunto(409, p({ code: 'not_allowed_in_state', terminal: false, estado: 'preparado' }), null))
      .toEqual({ tipo: 'estacionar', estadoFlit2: 'preparado' });
  });
  it('409 not_allowed_in_state sin terminal booleano → reintentable respuesta_invalida', () => {
    expect(clasificarRespuestaAdjunto(409, p({ code: 'not_allowed_in_state' }), null)).toEqual({ tipo: 'reintentable', codigo: 'respuesta_invalida', status: 409 });
  });
  it('429 → espera con el Retry-After (AC7); 60 solo si faltara', () => {
    expect(clasificarRespuestaAdjunto(429, p({ code: 'rate_limited' }), 17)).toEqual({ tipo: 'espera', segundos: 17 });
    expect(clasificarRespuestaAdjunto(429, null, null)).toEqual({ tipo: 'espera', segundos: 60 });
  });
  it('5xx → reintentable con su code (o http_<status>); 4xx no listado → inesperado_<status> (AC5)', () => {
    expect(clasificarRespuestaAdjunto(503, p({ code: 'storage_unavailable' }), null)).toEqual({ tipo: 'reintentable', codigo: 'storage_unavailable', status: 503 });
    expect(clasificarRespuestaAdjunto(502, null, null)).toEqual({ tipo: 'reintentable', codigo: 'http_502', status: 502 });
    expect(clasificarRespuestaAdjunto(422, p({ code: 'otro' }), null)).toEqual({ tipo: 'reintentable', codigo: 'inesperado_422', status: 422 });
    expect(clasificarRespuestaAdjunto(403, p({ code: 'forbidden' }), null)).toEqual({ tipo: 'reintentable', codigo: 'inesperado_403', status: 403 });
  });
  it('decide por code, no por detail', () => {
    expect(clasificarRespuestaAdjunto(409, p({ code: 'attachment_exists', detail: 'not_allowed_in_state terminal false' }), null))
      .toMatchObject({ tipo: 'definitivo', motivo: 'attachment_exists' });
  });
});

describe('urlDeEnvioAdjunto y mimeAdjuntoPorBytes', () => {
  it('ruta del contrato; id vacío, `.` o `..` → null (no se recorren rutas del host)', () => {
    expect(urlDeEnvioAdjunto('https://flit2.ejemplo.test', '0192b7c4-5e6a-7d10-9f21-000000000001')?.pathname)
      .toBe('/api/v1/external/tramites/0192b7c4-5e6a-7d10-9f21-000000000001/adjuntos');
    for (const malo of ['', ' ', '.', '..']) expect(urlDeEnvioAdjunto('https://flit2.ejemplo.test', malo)).toBeNull();
  });
  it('pdf / jpeg / png / webp por bytes; cualquier otra cosa → null (sin caída a PDF)', () => {
    expect(mimeAdjuntoPorBytes(Buffer.from('%PDF-1.7'))).toBe('application/pdf');
    expect(mimeAdjuntoPorBytes(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(mimeAdjuntoPorBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(mimeAdjuntoPorBytes(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]))).toBe('image/webp');
    expect(mimeAdjuntoPorBytes(Buffer.from('GIF89a'))).toBeNull();
    expect(mimeAdjuntoPorBytes(Buffer.alloc(0))).toBeNull();
  });
});
