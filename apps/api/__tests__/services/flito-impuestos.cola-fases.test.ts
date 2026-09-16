// HU #12590 (AC8) — la cola de impuestos expone `liquidadoEn` y `documentos` (liquidación del
// impuesto / pago con marca / ambos / ninguno) y filtra por «liquidado pendiente de pago».
//
// Tres cosas distintas, cada una con su técnica:
//   (i)   `documentosDe` es pura y se prueba sin base: los cuatro casos.
//   (ii)  `documentos` y `liquidadoEn` viajan en el DTO: se ejercita por `detalleImpuesto`, que pasa
//         por el MISMO `ensamblar` que la cola (calco de flito-impuestos.cola-certificacion.test.ts; la
//         cola lanza conteo y página en un `Promise.all` sobre la misma tabla y encolar dos respuestas
//         para un par sin orden garantizado es el flake que el mock keyed evita).
//   (iii) El mock keyed ignora el `where`, así que «no cuenta descartados» y «solo los dos tipos» se
//         afirman sobre el SQL RENDERIZADO de la consulta a `flito_soportes`, con `ligadosA`.
//   (iv)  El filtro `liquidadoPendientePago` también se lee del SQL (`espia.condicionesLeidas()`):
//         el mock devolvería las mismas filas con o sin la condición. Mutante M6 (sin `IS NOT NULL`)
//         → cae el aserto del predicado.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { ligadoA, ligadosA, renderizar, type SqlRenderizado } from '../helpers/sql-ligado.js';
import { EstadoImpuesto, TipoSoporte } from '@operaciones/shared-types';

const kdb = createKeyedDb();

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const { detalleImpuesto, colaImpuestos, documentosDe } = await import('../../src/modules/flito-impuestos/flito-impuestos.service.js');
const { flitoImpuestos, flitoImpuestoCertificaciones, flitoCompradores, flitoSoportes } = await import('../../src/db/schema.js');

const T_IMPUESTOS = getTableName(flitoImpuestos);
const T_CERT = getTableName(flitoImpuestoCertificaciones);
const T_COMPRADORES = getTableName(flitoCompradores);
const T_SOPORTES = getTableName(flitoSoportes);

const ADMIN = { userId: 1, username: 'ops@flitsas.io', role: 'admin', organismos: [] as string[] };
const GESTOR = { userId: 2, username: 'gestor@flitsas.io', role: 'gestor_impuestos', organismos: ['05001'] };
const ID = '71030cce-1a4c-4fb6-855d-fcc80aadc4e9';
const LIQUIDADO_EN = new Date('2026-09-15T14:30:00Z');

const filaAcceso = () => ({
  imp: { id: ID, tramiteId: 't1', estado: 'solicitado', organismoCodigo: '05001', gestionOperaciones: false, extraccion: null, extraccionFacturaVenta: null, pagadoEn: null },
  dentroDeFrontera: true,
});

const filaCola = (over: Record<string, unknown> = {}) => ({
  id: ID, tramiteId: 't1', idFlit: 'FLIT-1001', tipoTramite: 'traspaso',
  fechaAprobacion: null, fechaCreacion: null, marca: 'KIA', linea: 'K3 CROSS',
  estado: 'solicitado', organismoCodigo: '05001', valorLiquidado: '350000', valorPagado: null,
  marcadoPorDiferencia: false, facturaVentaFlitId: null, enviadoEn: null, pagadoEn: null, liquidadoEn: null,
  motivoRechazo: null, createdAt: new Date('2026-08-01T12:00:00Z'),
  placa: 'QIU744', vin: '3KPFF51ABTE156687', companiaNombre: 'Concesionario Norte',
  organismoNombre: 'STT Manizales', organismoSla: 24, enviadoPorNombre: null, tipoTitularFlit: 'cc',
  ...over,
});

const soporte = (tipo: string, id = `sop-${tipo}`) => ({
  id, impuestoId: ID, tipo, nombreArchivo: `${tipo}.pdf`, subidoEn: new Date('2026-09-15T14:30:00Z'), descartado: false,
});

function escenario(soportes: unknown[], over: Record<string, unknown> = {}) {
  kdb.when
    .selectOnce(T_IMPUESTOS, [filaAcceso()])
    .selectOnce(T_IMPUESTOS, [filaCola(over)])
    .select(T_COMPRADORES, [])
    .select(T_CERT, [])
    .select(T_SOPORTES, soportes);
}

beforeEach(() => { kdb.reset(); });

// ═════════════════ (i) documentosDe ═════════════════════════════════════════════════════════════

describe('documentosDe — de los tipos presentes al valor del DTO', () => {
  it('liquidación + pago → ambos; solo una → esa; nada → null', () => {
    expect(documentosDe(new Set([TipoSoporte.RECIBO_IMPUESTO_SIN_MARCA_AGUA, TipoSoporte.RECIBO_IMPUESTO]))).toBe('ambos');
    expect(documentosDe(new Set([TipoSoporte.RECIBO_IMPUESTO_SIN_MARCA_AGUA]))).toBe('liquidacion');
    expect(documentosDe(new Set([TipoSoporte.RECIBO_IMPUESTO]))).toBe('pago');
    expect(documentosDe(new Set())).toBeNull();
  });

  it('un tipo ajeno (factura de venta, comprobante) no cuenta como documento de la hacienda', () => {
    expect(documentosDe(new Set(['factura_venta', 'comprobante_pse']))).toBeNull();
    // Y el literal VIEJO tampoco: la 0196 lo renombró y el servicio ya no lo escribe.
    expect(documentosDe(new Set(['recibo_impuesto_sin_marca']))).toBeNull();
  });
});

// ═════════════════ (ii) el DTO ══════════════════════════════════════════════════════════════════

describe('la cola expone liquidadoEn y documentos (por `ensamblar`, común a cola y detalle)', () => {
  it('solo la liquidación cargada → documentos = liquidacion, liquidadoEn en ISO', async () => {
    escenario([soporte(TipoSoporte.RECIBO_IMPUESTO_SIN_MARCA_AGUA)], { liquidadoEn: LIQUIDADO_EN });
    const r = await detalleImpuesto(ID, ADMIN);
    expect(r?.documentos).toBe('liquidacion');
    expect(r?.liquidadoEn).toBe('2026-09-15T14:30:00.000Z');
    expect(r?.estado).toBe('solicitado');
  });

  it('las dos fases → ambos', async () => {
    escenario([soporte(TipoSoporte.RECIBO_IMPUESTO_SIN_MARCA_AGUA), soporte(TipoSoporte.RECIBO_IMPUESTO)], { liquidadoEn: LIQUIDADO_EN, estado: 'pagado' });
    const r = await detalleImpuesto(ID, ADMIN);
    expect(r?.documentos).toBe('ambos');
  });

  it('solo el pago con marca → pago', async () => {
    escenario([soporte(TipoSoporte.RECIBO_IMPUESTO)], { estado: 'pagado' });
    const r = await detalleImpuesto(ID, ADMIN);
    expect(r?.documentos).toBe('pago');
  });

  it('sin documentos → null explícito en los dos campos, no ausentes', async () => {
    escenario([]);
    const r = await detalleImpuesto(ID, ADMIN);
    expect(r).toHaveProperty('documentos', null);
    expect(r).toHaveProperty('liquidadoEn', null);
  });
});

// ═════════════════ (iii) la consulta a flito_soportes ═══════════════════════════════════════════

describe('la consulta de documentos: solo los dos tipos y sin descartados (leído del SQL)', () => {
  it('el WHERE liga los dos tipos del catálogo y `descartado = false`', async () => {
    const espia = crearEspia(kdb);
    escenario([soporte(TipoSoporte.RECIBO_IMPUESTO)]);

    await detalleImpuesto(ID, ADMIN);

    const consultas = espia.condicionesLeidas().map((c) => renderizar(c as never));
    // `detalleImpuesto` consulta `flito_soportes` dos veces (documentos y listado); la de documentos
    // es la que compara `tipo` con una lista.
    const deDocumentos = consultas.find((q) => /"flito_soportes"\."tipo"\s+in\s*\(/i.test(q.sql));
    expect(deDocumentos, 'no se encontró la consulta de documentos por tipo').toBeDefined();
    expect(ligadosA(deDocumentos!, '"flito_soportes"."tipo"').sort()).toEqual(
      [TipoSoporte.RECIBO_IMPUESTO_SIN_MARCA_AGUA, TipoSoporte.RECIBO_IMPUESTO].sort(),
    );
    expect(ligadoA(deDocumentos!, '"flito_soportes"."descartado"')).toBe(false);
    expect(ligadosA(deDocumentos!, '"flito_soportes"."impuesto_id"')).toEqual([ID]);
  });
});

// ═════════════════ (iv)/(v) el filtro liquidadoPendientePago ════════════════════════════════════

/** La condición de la cola sobre `flito_impuestos` que nombra `liquidado_en`, o `undefined`. */
function condicionConLiquidadoEn(consultas: SqlRenderizado[]): SqlRenderizado | undefined {
  return consultas.find((q) => /liquidado_en/i.test(q.sql));
}

describe('liquidadoPendientePago — el predicado va en el SQL (M6)', () => {
  it('con el flag: `estado = solicitado AND liquidado_en IS NOT NULL`, dentro del mismo WHERE que el resto', async () => {
    const espia = crearEspia(kdb);
    kdb.when.select(T_IMPUESTOS, []).select(T_COMPRADORES, []).select(T_CERT, []).select(T_SOPORTES, []);

    await colaImpuestos(ADMIN, { liquidadoPendientePago: true, organismos: ['05001'], buscar: 'QIU' });

    const consultas = espia.condicionesLeidas().map((c) => renderizar(c as never));
    const q = condicionConLiquidadoEn(consultas);
    expect(q, 'ninguna condición de la cola nombra liquidado_en').toBeDefined();
    expect(q!.sql).toMatch(/"flito_impuestos"\."liquidado_en"\s+is\s+not\s+null/i);
    expect(ligadoA(q!, '"flito_impuestos"."estado"')).toBe(EstadoImpuesto.SOLICITADO);
    // AND con lo demás: el organismo y el texto siguen en la misma condición.
    expect(ligadosA(q!, '"flito_impuestos"."organismo_codigo"')).toEqual(['05001']);
    expect(q!.params.some((p) => typeof p === 'string' && p.includes('QIU'))).toBe(true);
  });

  it('sin el flag el SQL no nombra liquidado_en', async () => {
    const espia = crearEspia(kdb);
    kdb.when.select(T_IMPUESTOS, []).select(T_COMPRADORES, []).select(T_CERT, []).select(T_SOPORTES, []);

    await colaImpuestos(ADMIN, { organismos: ['05001'] });

    const consultas = espia.condicionesLeidas().map((c) => renderizar(c as never));
    expect(consultas.length).toBeGreaterThan(0);
    expect(condicionConLiquidadoEn(consultas)).toBeUndefined();
  });

  it('`false` explícito tampoco filtra', async () => {
    const espia = crearEspia(kdb);
    kdb.when.select(T_IMPUESTOS, []).select(T_COMPRADORES, []).select(T_CERT, []).select(T_SOPORTES, []);
    await colaImpuestos(ADMIN, { liquidadoPendientePago: false });
    const consultas = espia.condicionesLeidas().map((c) => renderizar(c as never));
    expect(condicionConLiquidadoEn(consultas)).toBeUndefined();
  });

  it('gestor + flag: la frontera (estados visibles + organismos) sigue en el SQL; el flag va AND', async () => {
    const espia = crearEspia(kdb);
    kdb.when.select(T_IMPUESTOS, []).select(T_COMPRADORES, []).select(T_CERT, []).select(T_SOPORTES, []);

    // Con los dos estados pedidos: el gestor sin `estados` solo ve `solicitado`, y aquí lo que se
    // mide es que la frontera (`ESTADOS_VISIBLES_GESTOR`) no la altera el flag.
    await colaImpuestos(GESTOR, { liquidadoPendientePago: true, estados: [EstadoImpuesto.SOLICITADO, EstadoImpuesto.PAGADO] });

    const consultas = espia.condicionesLeidas().map((c) => renderizar(c as never));
    const q = condicionConLiquidadoEn(consultas);
    expect(q).toBeDefined();
    expect(q!.sql).toMatch(/"flito_impuestos"\."liquidado_en"\s+is\s+not\s+null/i);
    // ESTADOS_VISIBLES_GESTOR intacto: el `in (…)` sigue ligando solicitado y pagado.
    const enLista = /"flito_impuestos"\."estado"\s+in\s*\(([^)]*)\)/i.exec(q!.sql);
    expect(enLista, 'la frontera de estados del gestor desapareció del SQL').not.toBeNull();
    const ligadosEnLista = [...enLista![1]!.matchAll(/\$(\d+)/g)].map((m) => q!.params[Number(m[1]) - 1]);
    expect(ligadosEnLista.sort()).toEqual([EstadoImpuesto.PAGADO, EstadoImpuesto.SOLICITADO].sort());
    expect(ligadosA(q!, '"flito_impuestos"."organismo_codigo"')).toEqual(['05001']);
    // Y la igualdad del flag, aparte de la lista.
    expect(q!.sql).toMatch(/"flito_impuestos"\."estado"\s*=\s*\$\d+/);
  });
});
