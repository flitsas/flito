// FLITO Impuestos — carga de recibos → Pagado (Fase 4 P3). Verifica evaluarReciboImpuesto (puro),
// dedup CA-08 por hash, cruce contra EN_GESTION, conciliación → PAGADO y revisión. drizzle + OCR +
// storage mockeados; invariantes de BD además con smoke.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';
import { CampoImpuesto, MotivoRevision, type ExtraccionImpuesto } from '@operaciones/shared-types';

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
  return { ...real, extraerReciboImpuesto: extraerMock };
});
const uploadMock = vi.fn().mockResolvedValue('flito/impuestos/recibos/k.pdf');
vi.mock('../../src/services/storage.js', () => ({ uploadEntityDocument: uploadMock }));

const { evaluarReciboImpuesto, evaluarDiferencia, cargarRecibos } = await import('../../src/modules/flito-impuestos/flito-recibos.service.js');
const { umbralPara } = await import('../../src/modules/flito-parametrizacion/flito-parametrizacion.service.js');

beforeEach(() => { selectMock.mockReset(); insertMock.mockReset(); updateMock.mockReset(); transactionMock.mockReset(); extraerMock.mockReset(); uploadMock.mockClear(); });

const campo = (valor: string | null, confianza: number) => ({ valor, confianza, confiable: confianza >= 0.85 });

// ─────────────────────────── evaluarReciboImpuesto (puro) ────────────────────

describe('evaluarReciboImpuesto — solo placa (llave) + valorTotal bloquean', () => {
  it('placa y valorTotal confiables → aprobada', () => {
    const e = { [CampoImpuesto.PLACA]: campo('QTQ100', 0.95), [CampoImpuesto.VALOR_TOTAL]: campo('634900', 0.95) };
    expect(evaluarReciboImpuesto(e, 0.85)).toEqual({ aprobada: true });
  });
  it('placa bajo umbral → CONFIANZA_INSUFICIENTE', () => {
    const e = { [CampoImpuesto.PLACA]: campo('QTQ100', 0.3), [CampoImpuesto.VALOR_TOTAL]: campo('634900', 0.95) };
    expect(evaluarReciboImpuesto(e, 0.85).motivo).toBe(MotivoRevision.CONFIANZA_INSUFICIENTE);
  });
  it('valorTotal bajo umbral → CONFIANZA_INSUFICIENTE', () => {
    const e = { [CampoImpuesto.PLACA]: campo('QTQ100', 0.95), [CampoImpuesto.VALOR_TOTAL]: campo('634900', 0.3) };
    const v = evaluarReciboImpuesto(e, 0.85);
    expect(v.aprobada).toBe(false);
    expect(v.detalle).toContain(CampoImpuesto.VALOR_TOTAL);
  });
  it('placa ausente → CONFIANZA_INSUFICIENTE', () => {
    const e = { [CampoImpuesto.VALOR_TOTAL]: campo('634900', 0.95) };
    expect(evaluarReciboImpuesto(e, 0.85).aprobada).toBe(false);
  });
});

// ─────────────────────── evaluarDiferencia (D-5, Fase 7) ─────────────────────

describe('evaluarDiferencia — marca de diferencia de valor por organismo (D-5)', () => {
  it('organismo con flag apagado → nunca marca, aunque haya diferencia', () => {
    expect(evaluarDiferencia({ diferenciaActiva: false, valorLiquidado: '100000', tolerancia: '0' }, '999999')).toBe(false);
  });
  it('flag encendido + diferencia sobre tolerancia → marca', () => {
    expect(evaluarDiferencia({ diferenciaActiva: true, valorLiquidado: '100000', tolerancia: '1000' }, '105000')).toBe(true);
  });
  it('flag encendido pero diferencia dentro de la tolerancia → no marca', () => {
    expect(evaluarDiferencia({ diferenciaActiva: true, valorLiquidado: '100000', tolerancia: '5000' }, '104000')).toBe(false);
  });
  it('flag encendido pero sin valorLiquidado fiable → no marca', () => {
    expect(evaluarDiferencia({ diferenciaActiva: true, valorLiquidado: null, tolerancia: '0' }, '104000')).toBe(false);
  });
  it('flag encendido pero sin valorPagado → no marca', () => {
    expect(evaluarDiferencia({ diferenciaActiva: true, valorLiquidado: '100000', tolerancia: '0' }, null)).toBe(false);
  });
});

// ─────────────────────────── Ruta POST /recibos ──────────────────────────────

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-impuestos/flito-impuestos.routes.js');
  app.use('/api/flito/impuestos', router);
  return app;
}
const auth = async (role: string) => `Bearer ${await testToken({ sub: 5, username: 'g@x.io', role: role as never })}`;
const UUID = '00000000-0000-0000-0000-0000000000dd';

const candidato = {
  impuestoId: UUID, estado: 'solicitado', organismoCodigo: '08001', tramiteIdFlit: 'FLIT-1', placa: 'QTQ100',
  companiaId: 1, document: '900', carpeta: null, valorLiquidado: '500000',
};
const reciboOk = { [CampoImpuesto.PLACA]: campo('QTQ100', 0.95), [CampoImpuesto.VALOR_TOTAL]: campo('634900', 0.95), [CampoImpuesto.NUMERO_RECIBO]: campo('R-1', 0.95) };

describe('recibos — RBAC', () => {
  it('auditor → POST /recibos 403', async () => {
    const r = await request(await buildApp()).post('/api/flito/impuestos/recibos').set('Authorization', await auth('auditor')).attach('archivos', Buffer.from('%PDF'), 'r.pdf');
    expect(r.status).toBe(403);
  });
});

describe('recibos — flujo', () => {
  it('archivo idéntico ya cargado → duplicado (CA-08 por hash), sin OCR', async () => {
    selectMock.mockReturnValueOnce(chain([{ impuestoId: UUID }])); // dedup por hash
    const r = await request(await buildApp()).post('/api/flito/impuestos/recibos').set('Authorization', await auth('admin')).attach('archivos', Buffer.from('%PDF'), 'QTQ100.pdf');
    expect(r.status).toBe(200);
    expect(r.body.duplicados).toHaveLength(1);
    expect(extraerMock).not.toHaveBeenCalled();
  });

  it('placa que no cruza con ningún en gestión (ni pagado) → se DESCARTA', async () => {
    // La HU #10982 lo archivaba en una bandeja para que un reintento lo cruzara al llegar el impuesto
    // desde FLIT. Se retiró: la bandeja acumulaba recibos que no llegaban a cruzar. El aviso queda, y
    // el fichero original sigue en manos de quien lo cargó, así que se puede reintentar.
    selectMock.mockReturnValueOnce(chain([]));  // dedup hash
    extraerMock.mockResolvedValueOnce(reciboOk);
    selectMock.mockReturnValueOnce(chain([]));  // candidato EN_GESTION
    selectMock.mockReturnValueOnce(chain([]));  // adjuntarComplemento: PAGADO
    const r = await request(await buildApp()).post('/api/flito/impuestos/recibos').set('Authorization', await auth('admin')).attach('archivos', Buffer.from('%PDF'), 'QTQ100.pdf');
    expect(r.status).toBe(200);
    expect(r.body.noAsociados).toHaveLength(1);
    expect(r.body.noAsociados[0].detalle).toMatch(/se descarta/i);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('cruza y confiable → concilia a PAGADO (RN-03 impuestos)', async () => {
    selectMock.mockReturnValueOnce(chain([]));           // dedup hash
    extraerMock.mockResolvedValueOnce(reciboOk);
    selectMock.mockReturnValueOnce(chain([candidato]));  // candidato EN_GESTION
    selectMock.mockReturnValueOnce(chain([]));           // dedup por número de recibo
    // El primero devuelve el soporte; los demás (bitácora, historial de estado) no se leen. Con
    // `mockReturnValue` de respaldo, añadir una escritura más a la transacción no vuelve a romper
    // este test por una razón que no tiene que ver con lo que comprueba.
    const txInsert = vi.fn().mockReturnValueOnce(chain([{ id: 'sop1' }])).mockReturnValue(chain([]));
    const txUpdate = vi.fn().mockReturnValue(chain([]));
    transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({ insert: txInsert, update: txUpdate }));

    const r = await request(await buildApp()).post('/api/flito/impuestos/recibos').set('Authorization', await auth('admin')).attach('archivos', Buffer.from('%PDF'), 'QTQ100.pdf');
    expect(r.status).toBe(200);
    expect(r.body.conciliados).toHaveLength(1);
    expect(txUpdate).toHaveBeenCalledTimes(1); // → PAGADO
  });

  it('cruza pero baja confianza en valorTotal → revisión (CA-06), no paga', async () => {
    selectMock.mockReturnValueOnce(chain([]));           // dedup hash
    extraerMock.mockResolvedValueOnce({ ...reciboOk, [CampoImpuesto.VALOR_TOTAL]: campo('634900', 0.3) });
    selectMock.mockReturnValueOnce(chain([candidato]));  // candidato EN_GESTION
    selectMock.mockReturnValueOnce(chain([]));           // dedup por número de recibo
    const txInsert = vi.fn().mockReturnValueOnce(chain([{ id: 'sop1' }])).mockReturnValueOnce(chain([])).mockReturnValueOnce(chain([])); // soporte + revisión + audit
    const txUpdate = vi.fn().mockReturnValue(chain([]));
    transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({ insert: txInsert, update: txUpdate }));

    const r = await request(await buildApp()).post('/api/flito/impuestos/recibos').set('Authorization', await auth('admin')).attach('archivos', Buffer.from('%PDF'), 'QTQ100.pdf');
    expect(r.status).toBe(200);
    expect(r.body.enRevision).toHaveLength(1);
    expect(txUpdate).not.toHaveBeenCalled(); // NO pasó a pagado
  });
});

// ───────── Umbral de OCR por organismo del CANDIDATO (HU #12053, diseño §6(b)) ────────────────────
//
// Lo que se vigila aquí es la lógica que introdujo la HU #12053 y que ningún test tocaba: el umbral
// con el que se marca `confiable` y se decide si un recibo se concilia solo sale del organismo del
// IMPUESTO CANDIDATO —quien EMITE el documento— y no de quién sube el archivo. Para un gestor de un
// solo organismo es indistinguible del viejo `umbralDelGestor`, así que la frontera solo aparece con
// DOS organismos de umbral distinto: el MISMO recibo, con la MISMA confianza, sale «confiable» bajo
// uno y «no confiable» bajo el otro. Sin estos casos, `umbralDelCandidato` se puede sustituir entera
// por `lote.porDefecto` sin que nada se ponga rojo (mutante superviviente del gate de QA).
//
// Se llama a `cargarRecibos` directo y no por HTTP a propósito: por la ruta, `contextoImpuesto`
// consume un `selectMock` más y la atadura del gestor pasaría a ser parte de lo probado. Aquí la
// lista de organismos se le ENTREGA al servicio y lo que se mide es qué hace con ella.
//
// Los mocks de este repo mienten: el `chain` de los helpers devuelve la fila entera aunque el
// `select` pidiera menos y se traga los argumentos de `.values()` / `.set()`. Por eso los asertos no
// se hacen sobre lo que el mock devuelve, sino sobre lo que el servicio ESCRIBE (capturado abajo) y
// sobre el detalle que produce `evaluarReciboImpuesto`.

const ORG_LAXO = '05001';      // flito_umbral_ocr = 0.600
const ORG_ESTRICTO = '11001';  // flito_umbral_ocr = 0.950
const UMBRAL_LAXO = 0.6;
const UMBRAL_ESTRICTO = 0.95;
const POR_DEFECTO = umbralPara(null); // OCR_UMBRAL_DEFECTO: con el que se EXTRAE siempre

const GESTOR = { userId: 5, username: 'gestor@flito.co', role: 'gestor_impuestos', organismos: [ORG_LAXO, ORG_ESTRICTO] };

/** Filas de `organismos_transito_config` como las devuelve `abrirLote` (numeric → string). */
const umbralesDelLote = () => chain([{ codigo: ORG_LAXO, u: '0.600' }, { codigo: ORG_ESTRICTO, u: '0.950' }]);

const candidatoDe = (organismoCodigo: string, impuestoId = UUID) => ({
  impuestoId, estado: 'solicitado', organismoCodigo, tramiteIdFlit: 'FLIT-1', tramiteId: 'TR-1',
  placa: 'QTQ100', companiaId: 1, carpeta: null, valorLiquidado: '500000',
  diferenciaActiva: false, tolerancia: '0',
});

const pdf = (nombre: string, contenido: string) => ({ originalname: nombre, mimetype: 'application/pdf', buffer: Buffer.from(contenido), size: contenido.length });

/**
 * El recibo que el OCR devuelve, extraído SIEMPRE con el umbral por defecto (0.85): placa y
 * valorTotal —los dos que bloquean— quedan en 0.90 (`confiable: true` con el defecto), y el año
 * gravable, que NO bloquea, en 0.70 (`confiable: false` con el defecto). Ese tercer campo es lo que
 * hace observable el umbral incluso cuando la decisión de conciliar no cambia.
 */
const reciboMedio = () => ({
  [CampoImpuesto.PLACA]: campo('QTQ100', 0.9),
  [CampoImpuesto.VALOR_TOTAL]: campo('634900', 0.9),
  [CampoImpuesto.NUMERO_RECIBO]: campo('R-9', 0.9),
  [CampoImpuesto.ANIO_GRAVABLE]: campo('2026', 0.7),
});

/**
 * Transacción que CAPTURA lo que se escribe. Hace falta porque el `chain` de los helpers descarta
 * los argumentos de `.values()` y `.set()`: sin esto, el aserto sobre la extracción persistida no
 * tendría de dónde leerla y quedaría verde por vacío.
 */
function txQueCaptura() {
  const escrituras: Record<string, unknown>[] = [];
  const c = chain([{ id: 'sop-1' }]) as unknown as Record<string, unknown>;
  const captura = (v: Record<string, unknown>) => { escrituras.push(v); return c; };
  c.values = captura; c.set = captura;
  const insert = vi.fn().mockReturnValue(c);
  const update = vi.fn().mockReturnValue(c);
  transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({ insert, update }));
  /** La extracción tal cual se persistió: en `flito_impuestos.extraccion` o en `flito_revisiones`. */
  const persistida = (): ExtraccionImpuesto => {
    const fila = escrituras.find((e) => 'extraccion' in e);
    expect(fila, 'ninguna escritura llevó `extraccion`: el aserto no tendría qué mirar').toBeDefined();
    return fila!.extraccion as ExtraccionImpuesto;
  };
  return { escrituras, insert, update, persistida };
}

describe('recibos — el umbral de OCR es el del organismo del candidato (HU #12053, §6(b))', () => {
  it('la premisa del archivo: el umbral por defecto cae ENTRE los dos organismos', () => {
    // Si esto deja de ser cierto (cambia OCR_UMBRAL_DEFECTO), los tres casos de abajo dejarían de
    // distinguir el umbral del organismo del umbral por defecto y se volverían verdes vacíos.
    expect(POR_DEFECTO).toBeGreaterThan(UMBRAL_LAXO);
    expect(POR_DEFECTO).toBeLessThan(UMBRAL_ESTRICTO);
  });

  it('TC-12053-26: bajo el organismo ESTRICTO el recibo NO es confiable y va a revisión con SU umbral', async () => {
    selectMock.mockReturnValueOnce(umbralesDelLote());                    // abrirLote
    selectMock.mockReturnValueOnce(chain([]));                            // dedup por hash
    selectMock.mockReturnValueOnce(chain([candidatoDe(ORG_ESTRICTO)]));   // candidato EN GESTION
    selectMock.mockReturnValueOnce(chain([]));                            // dedup por número de recibo
    extraerMock.mockResolvedValueOnce(reciboMedio());
    const { update, persistida } = txQueCaptura();

    const res = await cargarRecibos([pdf('QTQ100.pdf', '%PDF-estricto')], true, GESTOR);

    // Con el umbral por defecto (0.85) este recibo se habría pagado solo. El organismo que emite el
    // documento pide 0.95, así que va a revisión: es dinero que no se mueve sin que alguien mire.
    expect(res.conciliados).toHaveLength(0);
    expect(res.enRevision).toHaveLength(1);
    expect(update).not.toHaveBeenCalled(); // NO pasó a PAGADO
    // El umbral que recibió `evaluarReciboImpuesto` es observable en su propio detalle.
    expect(res.enRevision[0].detalle).toContain(`umbral de ${UMBRAL_ESTRICTO}`);
    expect(res.enRevision[0].detalle).not.toContain(`umbral de ${POR_DEFECTO}`);
    // Y lo que se PERSISTE —el chip «confiable / no confiable» que pinta `FlitoRevisiones.tsx`— se
    // re-marcó con ese mismo umbral: el OCR lo había marcado confiable con el defecto.
    const e = persistida();
    expect(e[CampoImpuesto.PLACA]!.confiable).toBe(false);
    expect(e[CampoImpuesto.VALOR_TOTAL]!.confiable).toBe(false);
    // Re-marcar es recalcular un booleano: ni el valor ni la confianza se tocan.
    expect(e[CampoImpuesto.PLACA]!.confianza).toBe(0.9);
    expect(e[CampoImpuesto.PLACA]!.valor).toBe('QTQ100');
  });

  it('TC-12053-26 (bis): el MISMO recibo, con la MISMA confianza, bajo el organismo LAXO sí es confiable', async () => {
    selectMock.mockReturnValueOnce(umbralesDelLote());                 // abrirLote
    selectMock.mockReturnValueOnce(chain([]));                         // dedup por hash
    selectMock.mockReturnValueOnce(chain([candidatoDe(ORG_LAXO)]));    // candidato EN GESTION
    selectMock.mockReturnValueOnce(chain([]));                         // dedup por número de recibo
    extraerMock.mockResolvedValueOnce(reciboMedio());
    const { update, persistida } = txQueCaptura();

    const res = await cargarRecibos([pdf('QTQ100.pdf', '%PDF-laxo')], true, GESTOR);

    expect(res.enRevision).toHaveLength(0);
    expect(res.conciliados).toHaveLength(1);
    expect(update).toHaveBeenCalledTimes(1); // → PAGADO
    const e = persistida();
    expect(e[CampoImpuesto.PLACA]!.confiable).toBe(true);
    // El aserto que separa 0.60 de 0.85: el año gravable no bloquea el pago, así que la decisión de
    // conciliar sale igual con los dos umbrales; su `confiable`, NO. Con el umbral por defecto este
    // campo se persistiría como no confiable y la pantalla lo pintaría en rojo sin razón.
    expect(e[CampoImpuesto.ANIO_GRAVABLE]!.confianza).toBe(0.7);
    expect(e[CampoImpuesto.ANIO_GRAVABLE]!.confiable).toBe(true);
  });

  it('TC-12053-27: un recibo BAJO el umbral por defecto se concilia igual si su organismo lo admite', async () => {
    selectMock.mockReturnValueOnce(umbralesDelLote());                 // abrirLote
    selectMock.mockReturnValueOnce(chain([]));                         // dedup por hash
    selectMock.mockReturnValueOnce(chain([candidatoDe(ORG_LAXO)]));    // candidato EN GESTION
    selectMock.mockReturnValueOnce(chain([]));                         // dedup por número de recibo
    // 0.70 en los DOS campos que bloquean: bajo el defecto (0.85) esto es revisión; bajo el 0.60 del
    // organismo que emitió el recibo, es un pago que se concilia solo.
    extraerMock.mockResolvedValueOnce({
      [CampoImpuesto.PLACA]: campo('QTQ100', 0.7),
      [CampoImpuesto.VALOR_TOTAL]: campo('634900', 0.7),
      [CampoImpuesto.NUMERO_RECIBO]: campo('R-7', 0.7),
    });
    const { update, persistida } = txQueCaptura();

    const res = await cargarRecibos([pdf('QTQ100.pdf', '%PDF-bajo-defecto')], true, GESTOR);

    expect(res.enRevision).toHaveLength(0);
    expect(res.conciliados).toHaveLength(1);
    expect(update).toHaveBeenCalledTimes(1); // → PAGADO
    const e = persistida();
    expect(e[CampoImpuesto.VALOR_TOTAL]!.confiable).toBe(true); // el OCR lo trajo en `false`
  });

  it('TC-12053-28: el mapa de umbrales se carga UNA vez por lote, no una por archivo', async () => {
    selectMock.mockReturnValueOnce(umbralesDelLote());                  // abrirLote (la única)
    // El dedup por hash es un pre-paso de TODO el lote (HU #12051): los dos archivos pasan por él
    // ANTES de que arranque el OCR en tandas, así que sus dos consultas van seguidas y el candidato
    // de cada archivo se busca después, ya en el bucle que persiste.
    selectMock.mockReturnValueOnce(chain([]));                          // archivo 1: dedup hash
    selectMock.mockReturnValueOnce(chain([]));                          // archivo 2: dedup hash
    selectMock.mockReturnValueOnce(chain([candidatoDe(ORG_LAXO)]));     // archivo 1: candidato
    selectMock.mockReturnValueOnce(chain([]));                          // archivo 1: dedup nº recibo
    selectMock.mockReturnValueOnce(chain([candidatoDe(ORG_ESTRICTO, '00000000-0000-0000-0000-0000000000de')]));
    selectMock.mockReturnValueOnce(chain([]));                          // archivo 2: dedup nº recibo
    extraerMock.mockResolvedValue(reciboMedio());
    txQueCaptura();

    const res = await cargarRecibos([pdf('a.pdf', '%PDF-a'), pdf('b.pdf', '%PDF-b')], true, GESTOR);

    // Los dos archivos se procesaron —y con umbral distinto cada uno, que es lo que hace que el
    // conteo signifique algo: el mapa sirvió para los dos sin volver a la BD.
    expect(res.conciliados).toHaveLength(1);
    expect(res.enRevision).toHaveLength(1);
    // Decisión explícita del diseño §6(b): UNA consulta a `organismos_transito_config` por lote. Se
    // cuenta por las columnas pedidas y no por la posición, que el `chain` no distingue.
    const consultasDeUmbral = selectMock.mock.calls.filter(([cols]) => cols !== null && typeof cols === 'object' && 'u' in cols);
    expect(consultasDeUmbral).toHaveLength(1);
    expect(selectMock).toHaveBeenCalledTimes(7); // 1 del lote + 3 por archivo
  });
});
