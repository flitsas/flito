// FLITO Derechos de tránsito — carga manual de recibos (HU #10950).
//
// Cubre las funciones puras del cruce (evaluarDerecho, desempatarPorTipo, advertenciasDe) y el flujo
// completo de POST /cargar con drizzle, OCR y storage mockeados. La separación de PDF y la expansión
// de ZIP se prueban contra archivos reales generados en el propio test: son la parte del pipeline
// donde un mock no probaría nada.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';
import { CampoDerechoTramite, MotivoRevision } from '@operaciones/shared-types';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock, delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const extraerMock = vi.fn();
vi.mock('../../src/modules/flito-ocr/flito-ocr.service.js', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, extraerDerechoTramite: extraerMock };
});

const uploadMock = vi.fn().mockResolvedValue('cliente/derechos-tramite/k.pdf');
vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: uploadMock,
  firmarDescargaEntidad: vi.fn().mockReturnValue('/api/files?key=k'),
  presignedGetEntityDocument: vi.fn().mockResolvedValue('https://s3/k'),
}));

const {
  evaluarDerecho, desempatarPorTipo, advertenciasDe, normalizarTexto,
} = await import('../../src/modules/flito-derechos/flito-derechos.service.js');

beforeEach(() => {
  selectMock.mockReset(); insertMock.mockReset(); updateMock.mockReset();
  transactionMock.mockReset(); extraerMock.mockReset(); uploadMock.mockClear();
});

const campo = (valor: string | null, confianza: number) => ({ valor, confianza, confiable: confianza >= 0.85 });

// ─────────────────────────── evaluarDerecho (puro) ───────────────────────────

describe('evaluarDerecho — solo placa (llave) y valorTotal bloquean', () => {
  it('placa y valorTotal confiables → aprobada', () => {
    const e = { [CampoDerechoTramite.PLACA]: campo('QTP701', 0.95), [CampoDerechoTramite.VALOR_TOTAL]: campo('236700', 0.95) };
    expect(evaluarDerecho(e, 0.85)).toEqual({ aprobada: true });
  });

  it('placa bajo umbral → CONFIANZA_INSUFICIENTE', () => {
    const e = { [CampoDerechoTramite.PLACA]: campo('QTP701', 0.3), [CampoDerechoTramite.VALOR_TOTAL]: campo('236700', 0.95) };
    expect(evaluarDerecho(e, 0.85).motivo).toBe(MotivoRevision.CONFIANZA_INSUFICIENTE);
  });

  it('valorTotal bajo umbral → CONFIANZA_INSUFICIENTE y lo nombra', () => {
    const e = { [CampoDerechoTramite.PLACA]: campo('QTP701', 0.95), [CampoDerechoTramite.VALOR_TOTAL]: campo('236700', 0.3) };
    const v = evaluarDerecho(e, 0.85);
    expect(v.aprobada).toBe(false);
    expect(v.detalle).toContain(CampoDerechoTramite.VALOR_TOTAL);
  });

  it('radicado, organismo y tipo ilegibles NO bloquean', () => {
    const e = {
      [CampoDerechoTramite.PLACA]: campo('QTP701', 0.95),
      [CampoDerechoTramite.VALOR_TOTAL]: campo('236700', 0.95),
      [CampoDerechoTramite.NUMERO_RADICADO]: campo(null, 0),
      [CampoDerechoTramite.ORGANISMO]: campo(null, 0),
      [CampoDerechoTramite.TIPO_TRAMITE]: campo(null, 0),
    };
    expect(evaluarDerecho(e, 0.85).aprobada).toBe(true);
  });
});

// ─────────────────────────── desempate por concepto ──────────────────────────

const cand = (id: string, tipo: string | null, extra: Record<string, unknown> = {}) => ({
  tramiteId: id, idFlit: `FLIT-${id}`, tipoTramite: tipo, organismoCodigo: '05001',
  companiaId: 1, document: '900', carpeta: null, yaTieneDerecho: false, ...extra,
});

describe('desempatarPorTipo — el concepto del recibo decide entre varios trámites', () => {
  it('un solo candidato → lo devuelve sin mirar el concepto', () => {
    const c = [cand('a', 'TRASPASO')];
    expect(desempatarPorTipo(c, 'MATRICULA INICIAL')).toEqual(c);
  });

  it('concepto que casa con exactamente uno → lo aísla', () => {
    const c = [cand('a', 'MATRICULA INICIAL'), cand('b', 'TRASPASO')];
    expect(desempatarPorTipo(c, 'TRASPASO').map((x) => x.tramiteId)).toEqual(['b']);
  });

  it('casa por contención parcial (INSCRIPCION DE PRENDA ⊃ PRENDA)', () => {
    const c = [cand('a', 'PRENDA'), cand('b', 'TRASPASO')];
    expect(desempatarPorTipo(c, 'INSCRIPCION DE PRENDA').map((x) => x.tramiteId)).toEqual(['a']);
  });

  it('ignora tildes y separadores', () => {
    const c = [cand('a', 'MATRÍCULA-INICIAL'), cand('b', 'TRASPASO')];
    expect(desempatarPorTipo(c, 'matricula inicial').map((x) => x.tramiteId)).toEqual(['a']);
  });

  it('sin concepto legible → devuelve todos (decide una persona)', () => {
    const c = [cand('a', 'MATRICULA INICIAL'), cand('b', 'TRASPASO')];
    expect(desempatarPorTipo(c, null)).toHaveLength(2);
  });

  it('concepto que casa con varios → devuelve todos, no elige al azar', () => {
    const c = [cand('a', 'TRASPASO'), cand('b', 'TRASPASO')];
    expect(desempatarPorTipo(c, 'TRASPASO')).toHaveLength(2);
  });

  it('concepto que no casa con ninguno → devuelve todos', () => {
    const c = [cand('a', 'MATRICULA INICIAL'), cand('b', 'TRASPASO')];
    expect(desempatarPorTipo(c, 'RADICADO DE CUENTA')).toHaveLength(2);
  });
});

// ─────────────────────────── advertencias ────────────────────────────────────

describe('advertenciasDe — discrepancias que se registran pero no bloquean', () => {
  it('tipo del recibo distinto al del trámite → advertencia', () => {
    const e = { [CampoDerechoTramite.TIPO_TRAMITE]: campo('TRASPASO', 0.95) };
    const out = advertenciasDe(cand('a', 'MATRICULA INICIAL'), e);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('TRASPASO');
  });

  it('tipos equivalentes → sin advertencia', () => {
    const e = { [CampoDerechoTramite.TIPO_TRAMITE]: campo('INSCRIPCION DE PRENDA', 0.95) };
    expect(advertenciasDe(cand('a', 'PRENDA'), e)).toHaveLength(0);
  });

  it('trámite sin organismo emparejado → advertencia sobre el emisor', () => {
    const e = { [CampoDerechoTramite.ORGANISMO]: campo('MEDELLIN', 0.95) };
    const out = advertenciasDe(cand('a', null, { organismoCodigo: null }), e);
    expect(out.join(' ')).toContain('MEDELLIN');
  });

  it('sin datos que contrastar → sin advertencias', () => {
    expect(advertenciasDe(cand('a', 'TRASPASO'), {})).toHaveLength(0);
  });
});

describe('normalizarTexto', () => {
  it('quita tildes, separadores y pasa a mayúsculas', () => {
    expect(normalizarTexto('matrícula-inicial 2026')).toBe('MATRICULAINICIAL2026');
  });
  it('null y undefined → cadena vacía', () => {
    expect(normalizarTexto(null)).toBe('');
    expect(normalizarTexto(undefined)).toBe('');
  });
});

// ─────────────────────────── Separación de PDF (archivo real) ────────────────

async function pdfDePaginas(n: number): Promise<Buffer> {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i += 1) doc.addPage([200, 200]);
  return Buffer.from(await doc.save());
}

describe('separarPaginas — parte el PDF consolidado', () => {
  it('PDF de 5 páginas → 5 documentos numerados desde 1', async () => {
    const { separarPaginas } = await import('../../src/shared/pdf/separar-paginas.js');
    const paginas = await separarPaginas(await pdfDePaginas(5));
    expect(paginas.map((p) => p.numero)).toEqual([1, 2, 3, 4, 5]);
    for (const p of paginas) expect(p.buffer.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('PDF de una sola página → se devuelve intacto (el hash del dedup no debe cambiar)', async () => {
    const { separarPaginas } = await import('../../src/shared/pdf/separar-paginas.js');
    const original = await pdfDePaginas(1);
    const paginas = await separarPaginas(original);
    expect(paginas).toHaveLength(1);
    expect(paginas[0].buffer.equals(original)).toBe(true);
  });

  it('por encima del tope de páginas → error explícito, no proceso a medias', async () => {
    const { separarPaginas, MAX_PAGINAS, PdfDemasiadoGrandeError } = await import('../../src/shared/pdf/separar-paginas.js');
    await expect(separarPaginas(await pdfDePaginas(MAX_PAGINAS + 1))).rejects.toBeInstanceOf(PdfDemasiadoGrandeError);
  });
});

// ─────────────────────────── Expansión de ZIP (archivo real) ─────────────────

describe('expandirZips — un ZIP es una caja que se abre', () => {
  it('expande el contenido e ignora __MACOSX y ocultos', async () => {
    const JSZip = (await import('jszip')).default;
    const { expandirZips } = await import('../../src/shared/archivos/expandir-zip.js');
    const zip = new JSZip();
    zip.file('QTP701.pdf', '%PDF-uno');
    zip.file('sub/QTP702.pdf', '%PDF-dos');
    zip.file('__MACOSX/._QTP701.pdf', 'basura');
    zip.file('.DS_Store', 'basura');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    const out = await expandirZips([{ originalname: 'lote.zip', mimetype: 'application/zip', buffer, size: buffer.length }]);
    expect(out.map((a) => a.originalname).sort()).toEqual(['QTP701.pdf', 'QTP702.pdf']);
    expect(out.every((a) => a.mimetype === 'application/pdf')).toBe(true);
  });

  it('archivos sueltos pasan tal cual', async () => {
    const { expandirZips } = await import('../../src/shared/archivos/expandir-zip.js');
    const suelto = { originalname: 'x.pdf', mimetype: 'application/pdf', buffer: Buffer.from('%PDF'), size: 4 };
    expect(await expandirZips([suelto])).toEqual([suelto]);
  });
});

// ─────────────────────────── Ruta POST /cargar ───────────────────────────────

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-derechos/flito-derechos.routes.js');
  app.use('/api/flito/derechos', router);
  return app;
}
const auth = async (role: string) => `Bearer ${await testToken({ sub: 5, username: 'ops@x.io', role: role as never })}`;
const DERECHO_ID = '00000000-0000-0000-0000-0000000000d1';

const reciboOk = {
  [CampoDerechoTramite.PLACA]: campo('QTP701', 0.95),
  [CampoDerechoTramite.VALOR_TOTAL]: campo('236700', 0.95),
  [CampoDerechoTramite.FECHA_PAGO]: campo('2026-05-23', 0.95),
  [CampoDerechoTramite.NUMERO_RADICADO]: campo('1005504347', 0.95),
  [CampoDerechoTramite.ORGANISMO]: campo('MEDELLIN', 0.95),
  [CampoDerechoTramite.TIPO_TRAMITE]: campo('MATRICULA INICIAL', 0.95),
};

// PDF real de una página: `documentosDe` abre todo PDF con pdf-lib antes de mandarlo al OCR, así que
// un buffer de mentira ("%PDF") caería en `fallidos` y ninguna rama del cruce llegaría a ejecutarse.
const PDF_UNA_PAGINA = await pdfDePaginas(1);

const cargar = async (role = 'admin', nombre = 'QTP701.pdf', buffer: Buffer = PDF_UNA_PAGINA) =>
  request(await buildApp())
    .post('/api/flito/derechos/cargar')
    .set('Authorization', await auth(role))
    .attach('archivos', buffer, nombre);

/** Transacción mockeada: devuelve el id del derecho en el primer insert. */
function mockTransaccion() {
  const txInsert = vi.fn()
    .mockReturnValueOnce(chain([{ id: DERECHO_ID }]))
    .mockReturnValue(chain([]));
  const txUpdate = vi.fn().mockReturnValue(chain([]));
  transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({ insert: txInsert, update: txUpdate }));
  return { txInsert, txUpdate };
}

describe('derechos — RBAC', () => {
  it('auditor no puede cargar → 403', async () => {
    expect((await cargar('auditor')).status).toBe(403);
  });

  it('sin archivos → 400', async () => {
    const r = await request(await buildApp())
      .post('/api/flito/derechos/cargar').set('Authorization', await auth('admin'));
    expect(r.status).toBe(400);
  });
});

describe('derechos — carga y cruce', () => {
  it('AC6 — archivo idéntico ya cargado → duplicado, sin gastar OCR', async () => {
    selectMock.mockReturnValueOnce(chain([{ derechoId: DERECHO_ID }]));
    const r = await cargar();
    expect(r.status).toBe(200);
    expect(r.body.duplicados).toHaveLength(1);
    expect(extraerMock).not.toHaveBeenCalled();
  });

  it('AC2 — página de resumen (todo null) → omitida, no se archiva ni se registra', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    extraerMock.mockResolvedValueOnce({
      [CampoDerechoTramite.PLACA]: campo(null, 0),
      [CampoDerechoTramite.VALOR_TOTAL]: campo(null, 0),
    });
    const r = await cargar('admin', 'consolidado.pdf');
    expect(r.status).toBe(200);
    expect(r.body.omitidas).toHaveLength(1);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('AC5 — placa sin ningún trámite → bandeja de pendientes, con su archivo guardado', async () => {
    selectMock.mockReturnValueOnce(chain([]));   // dedup
    extraerMock.mockResolvedValueOnce(reciboOk);
    selectMock.mockReturnValueOnce(chain([]));   // candidatos
    insertMock.mockReturnValueOnce(chain([{ id: 'sop1' }])).mockReturnValueOnce(chain([]));

    const r = await cargar();
    expect(r.status).toBe(200);
    expect(r.body.pendientes).toHaveLength(1);
    expect(r.body.pendientes[0].placa).toBe('QTP701');
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });

  it('AC1 — un único trámite vivo → registrado y atado al trámite', async () => {
    selectMock.mockReturnValueOnce(chain([]));                     // dedup
    extraerMock.mockResolvedValueOnce(reciboOk);
    selectMock.mockReturnValueOnce(chain([cand('t1', 'MATRICULA INICIAL')]));
    insertMock.mockReturnValueOnce(chain([{ id: 'sop1' }]));       // soporte
    const { txUpdate } = mockTransaccion();

    const r = await cargar();
    expect(r.status).toBe(200);
    expect(r.body.registrados).toHaveLength(1);
    expect(r.body.registrados[0]).toMatchObject({ placa: 'QTP701', valor: '236700', idFlit: 'FLIT-t1' });
    expect(txUpdate).toHaveBeenCalledTimes(1); // soporte atado al derecho
  });

  it('AC4 — tipo discrepante con un único candidato → registra igual y deja la advertencia', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    extraerMock.mockResolvedValueOnce(reciboOk); // dice MATRICULA INICIAL
    selectMock.mockReturnValueOnce(chain([cand('t1', 'TRASPASO')]));
    insertMock.mockReturnValueOnce(chain([{ id: 'sop1' }]));
    mockTransaccion();

    const r = await cargar();
    expect(r.body.registrados).toHaveLength(1);
    expect(r.body.registrados[0].detalle).toContain('advertencias');
  });

  it('AC3 — varios trámites y concepto que no desempata → revisión CRUCE_AMBIGUO', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    extraerMock.mockResolvedValueOnce({ ...reciboOk, [CampoDerechoTramite.TIPO_TRAMITE]: campo(null, 0) });
    selectMock.mockReturnValueOnce(chain([cand('t1', 'MATRICULA INICIAL'), cand('t2', 'TRASPASO')]));
    insertMock.mockReturnValueOnce(chain([{ id: 'sop1' }]));
    const txInsert = vi.fn().mockReturnValue(chain([]));
    transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({ insert: txInsert, update: vi.fn().mockReturnValue(chain([])) }));

    const r = await cargar();
    expect(r.body.enRevision).toHaveLength(1);
    expect(r.body.registrados).toHaveLength(0);
    expect(r.body.enRevision[0].detalle).toContain('Varios trámites');
  });

  it('AC3 — varios trámites pero el concepto desempata → registra sin intervención', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    extraerMock.mockResolvedValueOnce(reciboOk); // MATRICULA INICIAL
    selectMock.mockReturnValueOnce(chain([cand('t1', 'MATRICULA INICIAL'), cand('t2', 'TRASPASO')]));
    insertMock.mockReturnValueOnce(chain([{ id: 'sop1' }]));
    mockTransaccion();

    const r = await cargar();
    expect(r.body.registrados).toHaveLength(1);
    expect(r.body.registrados[0].idFlit).toBe('FLIT-t1');
  });

  it('AC7 — valor bajo el umbral → revisión, nunca se persiste como válido', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    extraerMock.mockResolvedValueOnce({ ...reciboOk, [CampoDerechoTramite.VALOR_TOTAL]: campo('236700', 0.3) });
    selectMock.mockReturnValueOnce(chain([cand('t1', 'MATRICULA INICIAL')]));
    insertMock.mockReturnValueOnce(chain([{ id: 'sop1' }]));
    const txInsert = vi.fn().mockReturnValue(chain([]));
    transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({ insert: txInsert, update: vi.fn().mockReturnValue(chain([])) }));

    const r = await cargar();
    expect(r.body.enRevision).toHaveLength(1);
    expect(r.body.registrados).toHaveLength(0);
  });

  it('sin placa legible → revisión SIN_LLAVE_DE_CRUCE (el nombre del archivo tampoco la trae)', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    extraerMock.mockResolvedValueOnce({
      [CampoDerechoTramite.PLACA]: campo(null, 0),
      [CampoDerechoTramite.VALOR_TOTAL]: campo('236700', 0.95),
    });
    insertMock.mockReturnValueOnce(chain([{ id: 'sop1' }]));
    const txInsert = vi.fn().mockReturnValue(chain([]));
    transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({ insert: txInsert, update: vi.fn().mockReturnValue(chain([])) }));

    const r = await cargar('admin', 'recibo-sin-placa.pdf');
    expect(r.body.enRevision).toHaveLength(1);
    expect(r.body.enRevision[0].detalle).toContain('Sin placa');
  });

  it('el trámite ya tiene su derecho → duplicado, no viola el unique por trámite', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    extraerMock.mockResolvedValueOnce(reciboOk);
    selectMock.mockReturnValueOnce(chain([cand('t1', 'MATRICULA INICIAL', { yaTieneDerecho: true })]));

    const r = await cargar();
    expect(r.body.duplicados).toHaveLength(1);
    expect(r.body.duplicados[0].detalle).toContain('ya tiene registrado');
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('AC8 — un archivo que revienta en OCR no tumba el lote', async () => {
    selectMock
      .mockReturnValueOnce(chain([]))                                  // dedup del roto
      .mockReturnValueOnce(chain([]))                                  // dedup del bueno
      .mockReturnValueOnce(chain([cand('t1', 'MATRICULA INICIAL')]));  // candidatos del bueno
    extraerMock
      .mockRejectedValueOnce(new Error('PDF ilegible'))
      .mockResolvedValueOnce(reciboOk);
    insertMock.mockReturnValue(chain([{ id: 'sop1' }]));
    mockTransaccion();

    const r = await request(await buildApp())
      .post('/api/flito/derechos/cargar')
      .set('Authorization', await auth('admin'))
      .attach('archivos', PDF_UNA_PAGINA, 'roto.pdf')
      .attach('archivos', PDF_UNA_PAGINA, 'QTP701.pdf');

    expect(r.status).toBe(200);
    expect(r.body.fallidos).toHaveLength(1);
    expect(r.body.fallidos[0].detalle).toContain('PDF ilegible');
    expect(r.body.registrados).toHaveLength(1);
  });

  it('AC8 — un archivo que no es un PDF válido se reporta y no interrumpe el lote', async () => {
    // El corrupto revienta al abrirlo, antes de cualquier consulta: los mocks son los del bueno.
    selectMock
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([cand('t1', 'MATRICULA INICIAL')]));
    extraerMock.mockResolvedValueOnce(reciboOk);
    insertMock.mockReturnValue(chain([{ id: 'sop1' }]));
    mockTransaccion();

    const r = await request(await buildApp())
      .post('/api/flito/derechos/cargar')
      .set('Authorization', await auth('admin'))
      .attach('archivos', Buffer.from('esto no es un pdf'), 'corrupto.pdf')
      .attach('archivos', PDF_UNA_PAGINA, 'QTP701.pdf');

    expect(r.status).toBe(200);
    expect(r.body.fallidos).toHaveLength(1);
    expect(r.body.fallidos[0].archivo).toBe('corrupto.pdf');
    expect(r.body.registrados).toHaveLength(1);
  });

  it('AC2 — PDF consolidado: cada página se procesa por separado', async () => {
    selectMock.mockReturnValue(chain([]));  // dedup y candidatos: sin resultados → pendientes
    extraerMock.mockResolvedValue(reciboOk);
    insertMock.mockReturnValue(chain([{ id: 'sop1' }]));

    const r = await cargar('admin', 'consolidado.pdf', await pdfDePaginas(3));
    expect(r.status).toBe(200);
    expect(extraerMock).toHaveBeenCalledTimes(3);
    expect(r.body.pendientes).toHaveLength(3);
    expect(r.body.pendientes.map((p: { archivo: string }) => p.archivo)).toEqual([
      'consolidado - pág 1.pdf', 'consolidado - pág 2.pdf', 'consolidado - pág 3.pdf',
    ]);
  });
});
