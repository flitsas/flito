// HU #12610 (Feature #12605, Épica #12245) — `extraerComprobanteUniversal`: UNA lectura para
// cualquier documento del catálogo. Calco de flito-ocr.recibo-caja.test.ts: `anthropicMessages`
// mockeado, sin red ni API key. Cubre AC1 (forma, normalización, catálogo cerrado, escalación),
// AC2 (sin datos de persona) y AC6 (regresión de `SISTEMA_OCR` y de `ConceptoBolsa`).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CampoComprobante, CAMPOS_COMPROBANTE, ConceptoBolsa, ConceptoCosto, CONCEPTO_BOLSA_LABEL, CONCEPTO_COSTO_LABEL,
  TIPO_DOCUMENTO_COMPROBANTE_LABEL, TipoDocumentoComprobante,
} from '@operaciones/shared-types';

process.env.OCR_STUB = '0';
process.env.OCR_LOCAL = '0';

const anthropicMock = vi.fn();
vi.mock('../../src/modules/tramites/anthropic.js', () => ({ anthropicMessages: anthropicMock }));

const { extraerComprobanteUniversal, OcrNoDisponibleError } = await import('../../src/modules/flito-ocr/flito-ocr.service.js');
const { PROMPT_COMPROBANTE_UNIVERSAL, PROMPT_PARTICION_CONSOLIDADO, SISTEMA_OCR } = await import('../../src/modules/flito-ocr/flito-ocr.prompts.js');
const { env } = await import('../../src/config/env.js');

type Crudo = { valor: string | null; confianza: 'alta' | 'media' | 'baja' | null };
function respuesta(obj: Record<string, Crudo | unknown>) {
  return { ok: true as const, data: { content: [{ text: JSON.stringify(obj) }] } };
}
const c = (valor: string | null, confianza: Crudo['confianza'] = 'alta'): Crudo => ({ valor, confianza });
const doc = (umbral = 0.85) => ({ nombreArchivo: 'comprobante.pdf', contentType: 'application/pdf', contenido: Buffer.from('%PDF-x'), umbral });

type Payload = { model: string; max_tokens: number; system: string; messages: { content: { type: string; text?: string }[] }[] };
const payloadDe = (n: number) => anthropicMock.mock.calls[n]![0] as Payload;
const promptDeLlamada = (n: number) => payloadDe(n).messages[0]!.content.find((x) => x.type === 'text')!.text!;

/** Los diez campos nítidos: no escala. */
const TODO_ALTA = {
  tipoDocumento: c('factura_soat'), esComprobantePago: c('true'), concepto: c('soat'),
  placa: c('abc-123'), vin: c(' 1HG CM82633A123456'), idFlit: c('flit-arhzz1'),
  valorTotal: c('$ 1.234.567'), fechaPago: c('10/09/2026'), numeroDocumento: c('po-123'), emisor: c('  Seguros del Estado '),
};

beforeEach(() => anthropicMock.mockReset());

// ─────────────────────────── AC1 — forma y normalización ─────────────────────

describe('AC1 — una sola lectura con PROMPT_COMPROBANTE_UNIVERSAL', () => {
  it('devuelve exactamente los diez campos de CampoComprobante como CampoExtraido, con una sola llamada si todo salió alta', async () => {
    anthropicMock.mockResolvedValueOnce(respuesta(TODO_ALTA));

    const r = await extraerComprobanteUniversal(doc());

    expect(anthropicMock).toHaveBeenCalledTimes(1);
    expect(payloadDe(0).model).toBe(env.ANTHROPIC_MODEL_HAIKU);
    expect(promptDeLlamada(0)).toBe(PROMPT_COMPROBANTE_UNIVERSAL);
    expect(Object.keys(r).sort()).toEqual([...CAMPOS_COMPROBANTE].sort());
    for (const campo of CAMPOS_COMPROBANTE) {
      expect(Object.keys(r[campo]!).sort()).toEqual(['confiable', 'confianza', 'valor']);
    }
  });

  it('normaliza cada campo con su normalizador: placa, vin, idFlit con separadores, pesos, fecha ISO, número exacto, emisor recortado', async () => {
    anthropicMock.mockResolvedValueOnce(respuesta(TODO_ALTA));

    const r = await extraerComprobanteUniversal(doc());

    expect(r[CampoComprobante.PLACA]).toEqual({ valor: 'ABC123', confianza: 0.95, confiable: true });
    expect(r[CampoComprobante.VIN]).toEqual({ valor: '1HGCM82633A123456', confianza: 0.95, confiable: true });
    // El ID FLIT conserva el guion: «FLIT-ARHZZ1» ≠ «FLITARHZZ1» (regla 4 de SISTEMA_OCR).
    expect(r[CampoComprobante.ID_FLIT]).toEqual({ valor: 'FLIT-ARHZZ1', confianza: 0.95, confiable: true });
    expect(r[CampoComprobante.VALOR_TOTAL]).toEqual({ valor: '1234567', confianza: 0.95, confiable: true });
    expect(r[CampoComprobante.FECHA_PAGO]).toEqual({ valor: '2026-09-10', confianza: 0.95, confiable: true });
    expect(r[CampoComprobante.NUMERO_DOCUMENTO]).toEqual({ valor: 'PO-123', confianza: 0.95, confiable: true });
    expect(r[CampoComprobante.EMISOR]).toEqual({ valor: 'Seguros del Estado', confianza: 0.95, confiable: true });
    expect(r[CampoComprobante.TIPO_DOCUMENTO]).toEqual({ valor: 'factura_soat', confianza: 0.95, confiable: true });
    expect(r[CampoComprobante.ES_COMPROBANTE_PAGO]).toEqual({ valor: 'true', confianza: 0.95, confiable: true });
    expect(r[CampoComprobante.CONCEPTO]).toEqual({ valor: 'soat', confianza: 0.95, confiable: true });
  });

  it('emisor: 150 caracteres caben; 151 se descartan (null, confianza 0), no se truncan', async () => {
    anthropicMock
      .mockResolvedValueOnce(respuesta({ ...TODO_ALTA, emisor: c('E'.repeat(150)) }))
      .mockResolvedValueOnce(respuesta({ ...TODO_ALTA, emisor: c('E'.repeat(151)) }));

    const cabe = await extraerComprobanteUniversal(doc());
    const noCabe = await extraerComprobanteUniversal(doc());

    expect(cabe[CampoComprobante.EMISOR]!.valor).toHaveLength(150);
    expect(noCabe[CampoComprobante.EMISOR]).toEqual({ valor: null, confianza: 0, confiable: false });
  });

  // Mutante: el normalizador de catálogo acepta un literal fuera del catálogo (o hace `includes`
  // parcial) → estos tres campos saldrían con valor y confianza 0.95 en vez de null / 0.
  it('catálogo cerrado: tipoDocumento, concepto y esComprobantePago fuera del catálogo → null con confianza 0 aunque el modelo dijera alta', async () => {
    anthropicMock.mockResolvedValueOnce(respuesta({
      ...TODO_ALTA, tipoDocumento: c('factura'), concepto: c('seguro'), esComprobantePago: c('sí'),
    }));

    const r = await extraerComprobanteUniversal(doc());

    expect(r[CampoComprobante.TIPO_DOCUMENTO]).toEqual({ valor: null, confianza: 0, confiable: false });
    expect(r[CampoComprobante.CONCEPTO]).toEqual({ valor: null, confianza: 0, confiable: false });
    expect(r[CampoComprobante.ES_COMPROBANTE_PAGO]).toEqual({ valor: null, confianza: 0, confiable: false });
    // La escalación mira la confianza CRUDA del modelo ('alta'), no la normalizada: un literal fuera
    // del catálogo dicho con seguridad no gasta la segunda pasada, simplemente no entra.
    expect(anthropicMock).toHaveBeenCalledTimes(1);
  });

  it('catálogo cerrado: acepta los literales del catálogo sin importar mayúsculas ni espacios de borde', async () => {
    anthropicMock.mockResolvedValueOnce(respuesta({
      ...TODO_ALTA, tipoDocumento: c(' Recibo_Derecho '), concepto: c('TRAMITE_DIGITAL'), esComprobantePago: c('FALSE'),
    }));

    const r = await extraerComprobanteUniversal(doc());

    expect(r[CampoComprobante.TIPO_DOCUMENTO]!.valor).toBe(TipoDocumentoComprobante.RECIBO_DERECHO);
    expect(r[CampoComprobante.CONCEPTO]!.valor).toBe(ConceptoCosto.TRAMITE_DIGITAL);
    expect(r[CampoComprobante.ES_COMPROBANTE_PAGO]!.valor).toBe('false');
    expect(anthropicMock).toHaveBeenCalledTimes(1);
  });

  it('todos los tipos y conceptos del catálogo pasan el normalizador (y cada tipo tiene label)', async () => {
    for (const tipo of Object.values(TipoDocumentoComprobante)) {
      anthropicMock.mockReset();
      anthropicMock.mockResolvedValueOnce(respuesta({ ...TODO_ALTA, tipoDocumento: c(tipo) }));
      const r = await extraerComprobanteUniversal(doc());
      expect(r[CampoComprobante.TIPO_DOCUMENTO]!.valor).toBe(tipo);
      expect(TIPO_DOCUMENTO_COMPROBANTE_LABEL[tipo]).toBeTruthy();
    }
    for (const concepto of Object.values(ConceptoCosto)) {
      anthropicMock.mockReset();
      anthropicMock.mockResolvedValueOnce(respuesta({ ...TODO_ALTA, concepto: c(concepto) }));
      const r = await extraerComprobanteUniversal(doc());
      expect(r[CampoComprobante.CONCEPTO]!.valor).toBe(concepto);
    }
  });

  // Mutante: sustituir el null por '' o la confianza 0 por un valor por defecto → la igualdad
  // estricta de abajo cae en los diez campos.
  it('ningún campo se rellena cuando el modelo no lo devolvió: {valor: null, confianza: 0, confiable: false}', async () => {
    anthropicMock.mockResolvedValue(respuesta({}));

    const r = await extraerComprobanteUniversal(doc());

    for (const campo of CAMPOS_COMPROBANTE) {
      expect(r[campo]).toStrictEqual({ valor: null, confianza: 0, confiable: false });
    }
  });

  it('escala a Sonnet cuando tipo, es-pago, concepto, valor, placa, vin o idFlit no salen alta; gana la mayor confianza', async () => {
    anthropicMock
      .mockResolvedValueOnce(respuesta({ ...TODO_ALTA, valorTotal: c('1234567', 'media') }))
      .mockResolvedValueOnce(respuesta({ ...TODO_ALTA, valorTotal: c('1234500', 'alta') }));

    const r = await extraerComprobanteUniversal(doc());

    expect(anthropicMock).toHaveBeenCalledTimes(2);
    expect(payloadDe(1).model).toBe(env.ANTHROPIC_MODEL_SONNET);
    expect(promptDeLlamada(1)).toBe(PROMPT_COMPROBANTE_UNIVERSAL);
    expect(r[CampoComprobante.VALOR_TOTAL]).toEqual({ valor: '1234500', confianza: 0.95, confiable: true });
  });

  it('fechaPago, numeroDocumento y emisor dudosos NO escalan: una sola llamada y quedan no confiables', async () => {
    anthropicMock.mockResolvedValueOnce(respuesta({
      ...TODO_ALTA, fechaPago: c('10/09/2026', 'baja'), numeroDocumento: c('po-123', 'media'), emisor: c('X', null),
    }));

    const r = await extraerComprobanteUniversal(doc());

    expect(anthropicMock).toHaveBeenCalledTimes(1);
    expect(r[CampoComprobante.FECHA_PAGO]).toEqual({ valor: '2026-09-10', confianza: 0.3, confiable: false });
    expect(r[CampoComprobante.NUMERO_DOCUMENTO]).toEqual({ valor: 'PO-123', confianza: 0.6, confiable: false });
    expect(r[CampoComprobante.EMISOR]).toEqual({ valor: 'X', confianza: 0, confiable: false });
  });

  it('con umbral 0.85 solo alta es confiable: media (0.6) no lo es', async () => {
    anthropicMock.mockResolvedValue(respuesta({ ...TODO_ALTA, tipoDocumento: c('factura_soat', 'media') }));

    const r = await extraerComprobanteUniversal(doc(0.85));

    expect(r[CampoComprobante.TIPO_DOCUMENTO]).toEqual({ valor: 'factura_soat', confianza: 0.6, confiable: false });
  });

  it('OCR caído (no-200) → OcrNoDisponibleError, no TypeError', async () => {
    anthropicMock.mockResolvedValueOnce({ ok: false, status: 503, message: 'Servicio de IA no configurado' });

    await expect(extraerComprobanteUniversal(doc())).rejects.toBeInstanceOf(OcrNoDisponibleError);
  });
});

// ─────────────────────────── AC2 — sin datos de persona ──────────────────────

describe('AC2 — Habeas Data: nada de personas entra ni se pide', () => {
  // Mutante: propagar el JSON crudo del modelo (p. ej. `return { ...crudo, ...salida }`) → las tres
  // claves aparecen en el resultado y la igualdad de claves cae.
  it('claves fuera del catálogo (titular, cedula, direccion) se descartan y no llegan a ExtraccionComprobante', async () => {
    anthropicMock.mockResolvedValueOnce(respuesta({
      ...TODO_ALTA, titular: c('JUANA PEREZ'), cedula: c('1234567890'), direccion: c('CALLE 1 # 2-3'),
    }));

    const r = await extraerComprobanteUniversal(doc());

    expect(Object.keys(r).sort()).toEqual([...CAMPOS_COMPROBANTE].sort());
    expect(r).not.toHaveProperty('titular');
    expect(r).not.toHaveProperty('cedula');
    expect(r).not.toHaveProperty('direccion');
    expect(JSON.stringify(r)).not.toMatch(/JUANA|1234567890|CALLE 1/);
  });

  it('el prompt universal prohíbe leer datos de personas y no pide ningún campo de persona', () => {
    expect(PROMPT_COMPROBANTE_UNIVERSAL).toContain('NO leas ni devuelvas datos de personas (nombres, cédulas, direcciones, teléfonos)');
    expect(PROMPT_COMPROBANTE_UNIVERSAL).not.toMatch(/"nombres"|"apellidos"|"cedula"|"celular"|"direccion"/);
    expect(PROMPT_PARTICION_CONSOLIDADO).toContain('No leas ni devuelvas datos de personas');
  });

  it('el JSON de salida del prompt pide exactamente los diez campos del catálogo, en su orden', () => {
    const esperado = `{${CAMPOS_COMPROBANTE.map((k) => `"${k}":{"valor":null,"confianza":null}`).join(',')}}`;
    expect(PROMPT_COMPROBANTE_UNIVERSAL.trimEnd().endsWith(esperado)).toBe(true);
  });
});

// ─────────────────────────── AC6 — regresión ─────────────────────────────────

describe('AC6 — SISTEMA_OCR ampliado sin tocar las reglas; ConceptoBolsa intacto', () => {
  it('la primera línea nombra recibos de derechos, facturas de servicios y comprobantes de pago; el resto sigue igual', () => {
    const [primera, ...resto] = SISTEMA_OCR.split('\n');
    expect(primera).toContain('recibos de derechos de tránsito');
    expect(primera).toContain('facturas de servicios');
    expect(primera).toContain('comprobantes de pago');
    expect(primera).toContain('pólizas de SOAT');
    expect(resto.join('\n')).toContain('REGLAS ABSOLUTAS:\n1. Extrae SOLO lo que veas LITERALMENTE en el documento.');
    expect(resto.join('\n')).toContain('4. TRANSCRIBE EXACTAMENTE.');
    expect(resto.join('\n')).toContain('Respondes SIEMPRE un único objeto JSON, sin markdown ni texto alrededor.');
  });

  it('ConceptoBolsa = ConceptoCosto + gmf, con las mismas claves, literales y labels de siempre', () => {
    expect(Object.keys(ConceptoBolsa)).toEqual(['DERECHO', 'SOAT', 'IMPUESTO', 'TRAMITE_DIGITAL', 'LOGISTICA', 'SERVICIOS_ADICIONALES', 'GMF']);
    expect(Object.values(ConceptoBolsa)).toEqual(['derecho', 'soat', 'impuesto', 'tramite_digital', 'logistica', 'servicios_adicionales', 'gmf']);
    expect(Object.keys(CONCEPTO_BOLSA_LABEL)).toEqual(['derecho', 'soat', 'impuesto', 'tramite_digital', 'logistica', 'servicios_adicionales', 'gmf']);
    expect(CONCEPTO_BOLSA_LABEL).toEqual({
      derecho: 'Derecho de tránsito', soat: 'SOAT', impuesto: 'Impuesto', tramite_digital: 'Trámite digital',
      logistica: 'Logística', servicios_adicionales: 'Servicios adicionales', gmf: 'GMF (4x1000)',
    });
    expect(Object.values(ConceptoCosto)).toEqual(Object.values(ConceptoBolsa).filter((v) => v !== 'gmf'));
    for (const concepto of Object.values(ConceptoCosto)) {
      expect(CONCEPTO_COSTO_LABEL[concepto]).toBe(CONCEPTO_BOLSA_LABEL[concepto]);
    }
  });
});
