// HU #13310 (Feature #13309, ADR-0021 §3) — adaptador HTTP del envío del comprobante de pago a FLIT 1.
// `fetch` nativo de Node 22 + `FormData`/`Blob`: sin dependencia nueva. Endpoints SIN autenticación
// (contrato de FLIT 1, R-3).
//
// RN-F1-H1 Tres pasos con `redirect: 'error'` (un 3xx no se sigue → `red`, reintentable) y timeouts
//   10/60/15 s. Con `archivoIdSubido` solo se hace el paso 3 (AC5).
// RN-F1-H2 Paso 2: todos los `fields` en el orden recibido y `file` como ÚLTIMA parte. La URL sale
//   siempre de la respuesta del paso 1 y se valida antes (A-1); si no pasa → `pausa`.
// RN-F1-H3 Paso 3: `{ idAttachmentPdfDraft: "", idAttachmentPdfPrepared: "", idAttachedPaymentReceipt }`.
//   El cuerpo de la respuesta se descarta sin leerlo.
// RN-F1-H4 Log (AC9): solo `{ paso, status, codigo, duracionMs }`. NUNCA url, fields, filename, cuerpos
//   ni el `message` de un error de `fetch` (puede llevar la URL firmada): solo su `name`.
import { env } from '../../config/env.js';
import { loggerFor } from '../../shared/logger.js';
import type { ArchivoComprobanteFlit1, Flit1AdjuntosPort, PasoEnvioFlit1, ResultadoEnvioFlit1 } from './flit1-adjuntos.port.js';
import {
  CATEGORIA_FLIT1, MAX_CUERPO_ERROR_BYTES, MAX_CUERPO_PASO1_BYTES, TIMEOUTS_FLIT1_MS, baseFlit1Valida,
  clasificarStatusFlit1, parsearRespuestaArchivo, urlSubidaFlit1Permitida,
} from './flit1-adjuntos.js';

const log = loggerFor('flito-sync.flit1-adjuntos');

export interface ConfigFlit1Adjuntos { archivosBase: string; tramitesBase: string }

/** D-8: las dos bases válidas, o null (= envío FLIT 1 apagado). Nunca loguea el valor. */
export function configFlit1Adjuntos(): ConfigFlit1Adjuntos | null {
  const archivosBase = baseFlit1Valida(env.FLIT1_ARCHIVOS_BASE_URL);
  const tramitesBase = baseFlit1Valida(env.FLIT1_TRAMITES_BASE_URL);
  if (!archivosBase || !tramitesBase) {
    const invalida = (crudo: string | undefined, valida: string | null) => Boolean(crudo && crudo.trim()) && valida === null;
    if (invalida(env.FLIT1_ARCHIVOS_BASE_URL, archivosBase) || invalida(env.FLIT1_TRAMITES_BASE_URL, tramitesBase)) {
      log.warn('FLIT1_ARCHIVOS_BASE_URL o FLIT1_TRAMITES_BASE_URL inválida (https, sin credenciales ni query): envío FLIT 1 apagado');
    }
    return null;
  }
  return { archivosBase, tramitesBase };
}

/** Lee el cuerpo hasta `max` bytes; null si lo supera o falla la lectura (nunca lanza). */
async function leerTextoAcotado(res: Response, max: number): Promise<string | null> {
  if (!res.body) return '';
  const lector = res.body.getReader();
  const trozos: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await lector.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) { await lector.cancel().catch(() => {}); return null; }
      trozos.push(value);
    }
  } catch {
    return null;
  }
  return Buffer.concat(trozos).toString('utf8');
}

function descartar(res: Response): void {
  res.body?.cancel().catch(() => {});
}

type Fallo = Exclude<ResultadoEnvioFlit1, { tipo: 'enviado' }>;

/** Status ≠ 2xx → desenlace (A-2: solo 403/404 leen un cuerpo acotado, que no sale de aquí). */
async function falloPorStatus(paso: PasoEnvioFlit1, res: Response, archivoId: string | null): Promise<Fallo> {
  const status = res.status;
  let cuerpo: string | null = null;
  // El cuerpo de S3 (paso 2) no se lee: XML con Key/RequestId, y A-2 no aplica a S3.
  if ((status === 403 || status === 404) && paso !== 2) cuerpo = await leerTextoAcotado(res, MAX_CUERPO_ERROR_BYTES);
  else descartar(res);
  const clase = clasificarStatusFlit1(paso, status, cuerpo);
  if (clase === 'pausa') return { tipo: 'pausa', paso, codigo: 'no_disponible', status };
  return { tipo: clase, paso, codigo: `http_${status}`, status, archivoId } as Fallo;
}

export function crearFlit1AdjuntosHttp(cfg: ConfigFlit1Adjuntos): Flit1AdjuntosPort {
  const registrar = (paso: PasoEnvioFlit1, inicio: number, r: { codigo?: string; status?: number | null; tipo: string }) => {
    log.info({ paso, status: r.status ?? null, codigo: r.codigo ?? r.tipo, duracionMs: Date.now() - inicio }, 'envío a FLIT 1: paso');
  };

  async function llamar(paso: PasoEnvioFlit1, url: string, init: RequestInit): Promise<Response | { error: string }> {
    try {
      return await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUTS_FLIT1_MS[paso]) });
    } catch (e) {
      // Solo el nombre: el mensaje de `fetch failed` puede incluir la URL (firmada en el paso 2).
      return { error: e instanceof Error ? e.name : 'Error' };
    }
  }

  async function paso3(idReal: string, archivoId: string): Promise<ResultadoEnvioFlit1> {
    const inicio = Date.now();
    const res = await llamar(3, `${cfg.tramitesBase}/api/v1/vehicleTaxesQuery/${encodeURIComponent(idReal)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idAttachmentPdfDraft: '', idAttachmentPdfPrepared: '', idAttachedPaymentReceipt: archivoId }),
    });
    let r: ResultadoEnvioFlit1;
    if ('error' in res) r = { tipo: 'reintentable', paso: 3, codigo: 'red', status: null, archivoId };
    else if (res.ok) { descartar(res); r = { tipo: 'enviado', archivoId, status: res.status }; }
    else r = await falloPorStatus(3, res, archivoId);
    registrar(3, inicio, r);
    return r;
  }

  return {
    async enviarComprobante(idReal: string, archivo: ArchivoComprobanteFlit1, archivoIdSubido: string | null): Promise<ResultadoEnvioFlit1> {
      if (archivoIdSubido) return paso3(idReal, archivoIdSubido);

      // Paso 1: registrar el archivo.
      let inicio = Date.now();
      const r1 = await llamar(1, `${cfg.archivosBase}/api/v1/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: archivo.filename, category: CATEGORIA_FLIT1 }),
      });
      if ('error' in r1) {
        const r: ResultadoEnvioFlit1 = { tipo: 'reintentable', paso: 1, codigo: 'red', status: null, archivoId: null };
        registrar(1, inicio, r);
        return r;
      }
      if (!r1.ok) {
        const r = await falloPorStatus(1, r1, null);
        registrar(1, inicio, r);
        return r;
      }
      const texto = await leerTextoAcotado(r1, MAX_CUERPO_PASO1_BYTES);
      let json: unknown;
      try { json = texto === null ? null : JSON.parse(texto); } catch { json = null; }
      const archivoFlit1 = parsearRespuestaArchivo(json);
      if (!archivoFlit1) {
        const r: ResultadoEnvioFlit1 = { tipo: 'reintentable', paso: 1, codigo: 'respuesta_invalida', status: r1.status, archivoId: null };
        registrar(1, inicio, r);
        return r;
      }
      registrar(1, inicio, { tipo: 'ok', status: r1.status });

      // A-1: la URL de subida se valida antes de tocarla.
      if (!urlSubidaFlit1Permitida(archivoFlit1.url)) {
        const r: ResultadoEnvioFlit1 = { tipo: 'pausa', paso: 2, codigo: 'url_subida_no_permitida', status: null };
        registrar(2, Date.now(), r);
        return r;
      }

      // Paso 2: subida multipart; `file` es la última parte.
      inicio = Date.now();
      const form = new FormData();
      for (const [k, v] of archivoFlit1.fields) form.append(k, v);
      form.append('file', new Blob([new Uint8Array(archivo.bytes)], { type: archivo.contentType }), archivo.filename);
      // La URL tal cual llegó (ya validada): normalizarla podría alterar la firma.
      const r2 = await llamar(2, archivoFlit1.url, { method: 'POST', body: form });
      if ('error' in r2 || !r2.ok) {
        const r: ResultadoEnvioFlit1 = 'error' in r2
          ? { tipo: 'reintentable', paso: 2, codigo: 'red', status: null, archivoId: null }
          : await falloPorStatus(2, r2, null);
        registrar(2, inicio, r);
        return r;
      }
      descartar(r2);
      registrar(2, inicio, { tipo: 'ok', status: r2.status });

      // Paso 3: enlazar el archivo al trámite.
      return paso3(idReal, archivoFlit1.id);
    },
  };
}
