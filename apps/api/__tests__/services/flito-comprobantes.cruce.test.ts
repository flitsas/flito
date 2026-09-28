process.env.TZ = 'UTC';
// HU #12629 (Feature #12606, Épica #12245) — El CRUCE por llave: `candidatosPorLlave` (prioridad
// id_flit > vin > placa, igualdad normalizada, D8), `admite` por concepto, `cruzar()` (único /
// desempate / ambiguo / sin candidatos), el cruce dentro de la carga (AC4), `GET /:id` con
// `candidatos[]` y `POST /tramites/buscar` (AC5), y el filtro `asociacion` del listado (AC8).
//
// `db` es el mock keyed por tabla: IGNORA el where, así que lo que se afirma del predicado se afirma
// sobre SQL RENDERIZADO (`renderizar` + `espia.condicionesLeidas()`), y la prioridad de llave se
// prueba encolando respuestas por consulta (`selectOnce`) y leyendo qué llave ató cada una.
//
// Mutantes nombrados:
//   · AC2-M invertir la prioridad (placa antes que id_flit) → «dos llaves válidas a trámites distintos» cae.
//   · AC2-M2 cambiar `=` por `LIKE` en `condicionLlave` → «igualdad normalizada, nunca LIKE» cae.
//   · AC2-M3 añadir `logistica_autogestionable` al SQL → «D8: el SQL no mira autogestión ni gestor» cae.
//   · AC3-M desempatar cuando dos admiten («el primero que admite») → «ambos con impuesto solicitado → cruce_ambiguo» cae.
//   · AC3-M2 un candidato que no admite → fijar sin motivo → «único que no admite → destino_no_admite» cae.
//   · AC4-M escribir tramite_id del primer candidato en cruce_ambiguo → «la fila nace con tramite_id NULL» cae.
//   · AC5-M devolver 21 → «≤ 20» cae; AC5-M2 exponer el nombre del propietario → «forma del DTO» cae.
//   · AC8-M intercambiar manual/automático → «aplicado_manual liga false» cae.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { getTableName, sql } from 'drizzle-orm';
import { CampoComprobante, ConceptoCosto, MotivoPendienteComprobante, type CandidatoTramiteDto } from '@operaciones/shared-types';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { renderizar, ligadoA } from '../helpers/sql-ligado.js';
import { testToken, fuenteDePrueba, operacionesDePartida } from '../helpers/auth.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }) }));
const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/historial/permisos-intentos-denegados.js', () => ({
  registrarIntentoDenegado: vi.fn().mockResolvedValue(undefined), ventanaActual: () => new Date(), VENTANA_DEDUP_MS: 3_600_000,
}));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));
const uploadMock = vi.fn();
vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: uploadMock, presignedGetEntityDocument: vi.fn(), getEntityDocumentStream: vi.fn(),
}));
const particionarMock = vi.fn();
const leerMock = vi.fn();
vi.mock('../../src/modules/flito-comprobantes/flito-comprobantes.ocr.js', () => ({ particionar: particionarMock, leerSubDocumento: leerMock }));
const logLineas: unknown[] = [];
const logMock = { info: (...a: unknown[]) => logLineas.push(a), warn: (...a: unknown[]) => logLineas.push(a), error: (...a: unknown[]) => logLineas.push(a), debug: vi.fn(), child: () => logMock };
vi.mock('../../src/shared/logger.js', () => ({ loggerFor: () => logMock, logger: logMock }));

const { fijarFuenteDePermisos } = await import('../../src/shared/permisos-efectivos.js');
const { flitoComprobantes, flitoSoportes, flitoTramites } = await import('../../src/db/schema.js');
const {
  candidatosPorLlave, candidatosPorTexto, cruzar, cruzarLectura, condicionLlave, condicionBusqueda, admiteDe, aCandidato, llavesDe,
  PROYECCION_CANDIDATO, MAX_CANDIDATOS_BUSQUEDA,
} = await import('../../src/modules/flito-comprobantes/flito-comprobantes.cruce.js');
const { motivoPendienteDe, columnasDeLectura, condicionesListado, condicionAsociacion } = await import('../../src/modules/flito-comprobantes/flito-comprobantes.service.js');
const { cargarLote } = await import('../../src/modules/flito-comprobantes/flito-comprobantes.carga.js');

const T_COMP = getTableName(flitoComprobantes);
const T_SOP = getTableName(flitoSoportes);
const T_TRAM = getTableName(flitoTramites);
const BASE = '/api/flito/comprobantes';
const ID = '71030cce-1a4c-4fb6-855d-fcc80aadc4e9';
const LOTE = '9c1d4d5e-3b7a-4c2e-9f0a-1b2c3d4e5f60';
const T1 = '5a3c4c2e-0f9b-4e6e-9a1d-2c3b4a5d6e7f';
const T2 = '6b4d5d3f-1a0c-4f7f-8b2e-3d4c5b6e7f80';
const CTX = { userId: 7, username: 'fin@flitsas.io' };
const PDF = Buffer.from('%PDF-1.4\n%comprobante\n');

const campo = (valor: string | null, confianza: number) => ({ valor, confianza, confiable: confianza >= 0.85 });

/** Una fila cruda de `consultaCandidatos` (con columnas de persona DE MÁS, para el mutante AC5-M2). */
const fila = (over: Record<string, unknown> = {}) => ({
  tramiteId: T1, idFlit: 'FLIT-ABC001', placa: 'ABC123', vin: '1HGCM82633A004352', tipoTramite: 'MATRICULA', empresa: 'Acme S.A.S.', flitEstado: 'Aprobado',
  soatId: 'soat-1', soatEstado: 'solicitado', impuestoEstado: 'solicitado', derechoId: null, liquidacionId: null,
  docTramiteDigital: false, docLogistica: false, docServiciosAdicionales: false, createdAt: new Date('2026-09-01T00:00:00Z'),
  propietarioNombre: 'Juan Pérez', propietarioCedula: '12345678', ...over,
});

const lectura = (over: Record<string, ReturnType<typeof campo>> = {}) => ({
  extraccion: {
    [CampoComprobante.TIPO_DOCUMENTO]: campo('recibo_impuesto', 0.95), [CampoComprobante.ES_COMPROBANTE_PAGO]: campo('true', 0.95),
    [CampoComprobante.CONCEPTO]: campo('impuesto', 0.95), [CampoComprobante.PLACA]: campo('XYZ789', 0.9), [CampoComprobante.VIN]: campo(null, 0),
    [CampoComprobante.ID_FLIT]: campo('FLIT-ARHZZ1', 0.7), [CampoComprobante.VALOR_TOTAL]: campo('120000', 0.95),
    [CampoComprobante.FECHA_PAGO]: campo('2026-09-12', 0.95), [CampoComprobante.NUMERO_DOCUMENTO]: campo('R-9', 0.95), [CampoComprobante.EMISOR]: campo('Gobernación', 0.9),
    ...over,
  },
  tipoDestino: 'recibo_impuesto' as const,
  extraccionDestino: null,
});

const espia = crearEspia(kdb);

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-comprobantes/flito-comprobantes.routes.js');
  app.use(BASE, router);
  app.use((err: { message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: 'fallback', detalle: err.message });
  });
  return app;
}
const auth = async (role: 'admin' | 'financiera' | 'auditor' = 'financiera') => `Bearer ${await testToken({ sub: 7, username: 'u@flitsas.io', role })}`;

/** Las condiciones `where` que fueron a `flito_tramites`, renderizadas. */
const condicionesTramites = () => espia.condicionesLeidas().map((c) => renderizar(c as never)).filter((q) => q.sql.includes('"flito_tramites"') || q.sql.includes('"vehicles"'));

let nComp = 0;
beforeEach(() => {
  kdb.reset(); espia.reiniciar(); nComp = 0; logLineas.length = 0;
  auditMock.mockClear(); uploadMock.mockReset(); particionarMock.mockReset(); leerMock.mockReset();
  uploadMock.mockResolvedValue('flito/comprobantes/lote/x.pdf');
  particionarMock.mockImplementation(async (a: { buffer: Buffer; nombre: string; contentType: string }) =>
    ({ documentos: [{ buffer: a.buffer, contentType: a.contentType, paginas: null, nombre: a.nombre }], paginasNoLeidas: [], metodo: 'unico' }));
  leerMock.mockResolvedValue(lectura());
  kdb.when.select(T_SOP, []).select(T_COMP, []).select(T_TRAM, []).insert(T_SOP, [{ id: 'sop-1' }]).insert(T_COMP, () => [{ id: `c-${++nComp}` }]);
});
afterEach(() => { fijarFuenteDePermisos(fuenteDePrueba); });

// ═════════════════ AC2 · prioridad id_flit > vin > placa; igualdad normalizada; D8 ══════════════

describe('AC2 — candidatosPorLlave: prioridad, normalización y D8', () => {
  it('idFlit «FLIT-ARHZZ1» que no existe y placa «XYZ789» que sí → el cruce se fija por PLACA (la llave que da 0 no bloquea a la siguiente)', async () => {
    kdb.when.selectOnce(T_TRAM, []).selectOnce(T_TRAM, [fila({ idFlit: 'FLIT-XYZ', placa: 'XYZ789' })]);
    const h = await candidatosPorLlave({ idFlit: 'FLIT-ARHZZ1', vin: null, placa: 'xyz-789' });
    expect(h.cruce).toBe('placa');
    expect(h.hayLlave).toBe(true);
    expect(h.candidatos.map((c) => c.tramiteId)).toEqual([T1]);
    // Dos consultas: primero id_flit (0 filas), luego placa; el vin vacío se salta.
    const qs = condicionesTramites();
    expect(qs).toHaveLength(2);
    expect(qs[0]!.sql).toBe('UPPER("flito_tramites"."id_flit") = $1');
    expect(qs[0]!.params).toEqual(['FLIT-ARHZZ1']);
    expect(qs[1]!.sql).toBe('UPPER(REPLACE("vehicles"."plate", \'-\', \'\')) = $1');
    expect(qs[1]!.params).toEqual(['XYZ789']); // sin guion y en mayúsculas
  });

  it('AC2-M: dos llaves válidas que apuntan a trámites DISTINTOS → gana id_flit (una sola consulta; la placa ni se pregunta)', async () => {
    kdb.when.selectOnce(T_TRAM, [fila({ tramiteId: T1, idFlit: 'FLIT-ABC001' })]).selectOnce(T_TRAM, [fila({ tramiteId: T2, idFlit: 'FLIT-OTRO' })]);
    const h = await candidatosPorLlave({ idFlit: 'flit-abc001', vin: null, placa: 'ZZZ999' });
    expect(h.cruce).toBe('id_flit');
    expect(h.candidatos.map((c) => c.tramiteId)).toEqual([T1]);
    expect(condicionesTramites()).toHaveLength(1);
    expect(condicionesTramites()[0]!.params).toEqual(['FLIT-ABC001']);
  });

  it('vin antes que placa: con id_flit vacío y vin que cruza, la placa no se consulta', async () => {
    kdb.when.selectOnce(T_TRAM, [fila()]);
    const h = await candidatosPorLlave({ idFlit: null, vin: '1hgcm82633a004352', placa: 'ABC123' });
    expect(h.cruce).toBe('vin');
    const qs = condicionesTramites();
    expect(qs).toHaveLength(1);
    expect(qs[0]!.sql).toBe('UPPER("vehicles"."vin") = $1');
    expect(qs[0]!.params).toEqual(['1HGCM82633A004352']);
  });

  it('ninguna llave → hayLlave false, cero consultas; llaves que no cruzan → hayLlave true, candidatos []', async () => {
    const sin = await candidatosPorLlave({ idFlit: null, vin: '', placa: '  ' });
    expect(sin).toEqual({ candidatos: [], cruce: null, hayLlave: false });
    expect(condicionesTramites()).toHaveLength(0);
    const nada = await candidatosPorLlave({ idFlit: 'FLIT-NO', vin: 'VINNO', placa: 'NOP000' });
    expect(nada).toEqual({ candidatos: [], cruce: null, hayLlave: true });
    expect(condicionesTramites()).toHaveLength(3);
  });

  it('AC2-M2: igualdad normalizada UPPER(...) = $ — nunca LIKE ni ILIKE — en las tres llaves', () => {
    for (const [tipo, valor] of [['id_flit', 'flit-1'], ['vin', 'abc'], ['placa', 'ab-c123']] as const) {
      const q = renderizar(condicionLlave(tipo, valor));
      expect(q.sql).not.toMatch(/LIKE/i);
      expect(q.sql).toMatch(/^UPPER\(.*\) = \$1$/);
      expect(q.params).toHaveLength(1);
    }
    expect(renderizar(condicionLlave('placa', 'ab-c123')).params).toEqual(['ABC123']);
    expect(renderizar(condicionLlave('id_flit', ' flit-1 ')).params).toEqual(['FLIT-1']);
  });

  it('AC2-M3 (D8): ni el predicado, ni la proyección, ni el fuente miran logistica_autogestionable, gestor ni asignado', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const fuente = readFileSync(join(import.meta.dirname, '../../src/modules/flito-comprobantes/flito-comprobantes.cruce.ts'), 'utf8');
    const sinComentarios = fuente.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const prohibido of ['logistica_autogestionable', 'logisticaAutogestionable', 'gestor', 'asignado']) expect(sinComentarios).not.toMatch(new RegExp(prohibido, 'i'));
    const sqlProyeccion = Object.values(PROYECCION_CANDIDATO).map((c) => renderizar(sql`${c}`).sql).join('\n');
    for (const prohibido of ['autogestion', 'gestor', 'asignado', 'document', 'cedula', 'telefono', 'email']) expect(sqlProyeccion).not.toMatch(new RegExp(prohibido, 'i'));
    // Y las tablas del diseño: trámites ⋈ vehicles ⟕ clients ⟕ flito_soat ⟕ flito_impuestos ⟕ flito_derechos_tramite ⟕ flito_liquidaciones + EXISTS sobre comprobantes aplicados.
    expect(sinComentarios).toMatch(/\.innerJoin\(vehicles,/);
    for (const t of ['clients', 'flitoSoat', 'flitoImpuestos', 'flitoDerechosTramite', 'flitoLiquidaciones']) expect(sinComentarios).toMatch(new RegExp(`\\.leftJoin\\(${t},`));
    expect(sqlProyeccion).toMatch(/EXISTS \(\s*SELECT 1 FROM "flito_comprobantes"/);
    const exists = renderizar(sql`${PROYECCION_CANDIDATO.docLogistica}`);
    expect(exists.params).toEqual(['logistica']);
    expect(exists.sql).toContain('"flito_comprobantes"."estado" = \'aplicado\'');
    expect(exists.sql).toContain('"flito_comprobantes"."es_pago" = true');
  });
});

// ═════════════════ AC3 · admite por concepto y cruzar() ════════════════════════════════════════

describe('AC3 — admite por concepto', () => {
  it('soat/impuesto: solicitado → admite; pagado → ya_pagado; sin registro → no_gestionado; otro → estado_no_permitido', () => {
    expect(admiteDe(fila({ soatEstado: 'solicitado', impuestoEstado: 'solicitado' }))).toMatchObject({ soat: 'admite', impuesto: 'admite' });
    expect(admiteDe(fila({ soatEstado: 'pagado', impuestoEstado: 'pagado' }))).toMatchObject({ soat: 'ya_pagado', impuesto: 'ya_pagado' });
    expect(admiteDe(fila({ soatId: null, soatEstado: null, impuestoEstado: null }))).toMatchObject({ soat: 'no_gestionado', impuesto: 'no_gestionado' });
    expect(admiteDe(fila({ soatEstado: 'pendiente', impuestoEstado: 'en_gestion' }))).toMatchObject({ soat: 'estado_no_permitido', impuesto: 'estado_no_permitido' });
  });

  it('derecho: aprobado sin derecho → admite; con derecho → ya_pagado; no aprobado → estado_no_permitido (LOWER del flit_estado)', () => {
    expect(admiteDe(fila({ flitEstado: 'APROBADO', derechoId: null })).derecho).toBe('admite');
    expect(admiteDe(fila({ flitEstado: 'Aprobado', derechoId: 'der-1' })).derecho).toBe('ya_pagado');
    expect(admiteDe(fila({ flitEstado: 'En revisión', derechoId: null })).derecho).toBe('estado_no_permitido');
    expect(admiteDe(fila({ flitEstado: null, derechoId: null })).derecho).toBe('estado_no_permitido');
  });

  it('honorarios: liquidación → liquidado; comprobante aplicado del concepto → ya_documentado; si no → admite (la autogestión no bloquea, cierre (e))', () => {
    const libre = admiteDe(fila());
    expect(libre).toMatchObject({ tramite_digital: 'admite', logistica: 'admite', servicios_adicionales: 'admite' });
    const sellado = admiteDe(fila({ liquidacionId: 'liq-1', docLogistica: true }));
    expect(sellado).toMatchObject({ tramite_digital: 'liquidado', logistica: 'liquidado', servicios_adicionales: 'liquidado' });
    const doc = admiteDe(fila({ docTramiteDigital: true }));
    expect(doc).toMatchObject({ tramite_digital: 'ya_documentado', logistica: 'admite', servicios_adicionales: 'admite' });
    expect(Object.keys(libre).sort()).toEqual(['derecho', 'impuesto', 'logistica', 'servicios_adicionales', 'soat', 'tramite_digital']);
  });

  it('Bug #12913 — servicios adicionales admite un SEGUNDO servicio aunque ya haya un pago SA aplicado (uno por tipo: el duplicado lo decide el índice `…_sa` al aplicar); la proyección ya no mira el documentado SA', () => {
    // Aunque la fila trajera una marca de documentado SA (fixture viejo), no se consulta.
    expect(admiteDe(fila({ docServiciosAdicionales: true } as never)).servicios_adicionales).toBe('admite');
    expect(admiteDe(fila({ liquidacionId: 'liq-1' })).servicios_adicionales).toBe('liquidado');
    expect('docServiciosAdicionales' in PROYECCION_CANDIDATO).toBe(false);
  });

  it('AC5-M2: aCandidato deja fuera cualquier dato de persona: solo llaves del vehículo, tipo, empresa, estados y admite', () => {
    const c = aCandidato(fila({ liquidacionId: 'liq-1' }));
    expect(Object.keys(c).sort()).toEqual(['admite', 'empresa', 'flitEstado', 'idFlit', 'liquidado', 'placa', 'tipoTramite', 'tramiteId', 'vin']);
    expect(c).toMatchObject({ tramiteId: T1, idFlit: 'FLIT-ABC001', placa: 'ABC123', vin: '1HGCM82633A004352', tipoTramite: 'MATRICULA', empresa: 'Acme S.A.S.', flitEstado: 'Aprobado', liquidado: true });
    expect(JSON.stringify(c)).not.toContain('Juan');
    expect(JSON.stringify(c)).not.toContain('12345678');
  });
});

describe('AC3 — cruzar(): ninguno, uno, varios y desempate', () => {
  const cand = (tramiteId: string, over: Record<string, unknown> = {}): CandidatoTramiteDto => aCandidato(fila({ tramiteId, ...over }));

  it('0 candidatos → llave_no_cruza; sin llave → sin_llave_de_cruce; tramite_id NULL en ambos', () => {
    expect(cruzar({ candidatos: [], cruce: null, hayLlave: true }, ConceptoCosto.IMPUESTO)).toEqual({ tramiteId: null, cruce: null, candidatos: [], motivo: 'llave_no_cruza' });
    expect(cruzar({ candidatos: [], cruce: null, hayLlave: false }, ConceptoCosto.IMPUESTO)).toEqual({ tramiteId: null, cruce: null, candidatos: [], motivo: 'sin_llave_de_cruce' });
  });

  it('1 candidato que admite → cruce fijado sin motivo; AC3-M2: 1 que NO admite → fijado igual con destino_no_admite (D6: el candidato queda visible)', () => {
    const admite = cruzar({ candidatos: [cand(T1)], cruce: 'placa', hayLlave: true }, ConceptoCosto.IMPUESTO);
    expect(admite).toMatchObject({ tramiteId: T1, cruce: 'placa', motivo: null });
    const pagado = cruzar({ candidatos: [cand(T1, { impuestoEstado: 'pagado' })], cruce: 'id_flit', hayLlave: true }, ConceptoCosto.IMPUESTO);
    expect(pagado).toMatchObject({ tramiteId: T1, cruce: 'id_flit', motivo: 'destino_no_admite' });
    expect(pagado.candidatos).toHaveLength(1);
    // Concepto desconocido con un solo candidato: se fija, y como nada «admite» un concepto null, destino_no_admite.
    expect(cruzar({ candidatos: [cand(T1)], cruce: 'vin', hayLlave: true }, null)).toMatchObject({ tramiteId: T1, cruce: 'vin', motivo: 'destino_no_admite' });
  });

  it('> 1 con EXACTAMENTE uno que admite el concepto → desempate; AC3-M: dos trámites de la misma placa, ambos con impuesto solicitado → cruce_ambiguo y tramite_id NULL', () => {
    const desempate = cruzar({ candidatos: [cand(T1, { impuestoEstado: 'pagado' }), cand(T2)], cruce: 'placa', hayLlave: true }, ConceptoCosto.IMPUESTO);
    expect(desempate).toMatchObject({ tramiteId: T2, cruce: 'placa', motivo: null });
    expect(desempate.candidatos).toHaveLength(2);

    const ambiguo = cruzar({ candidatos: [cand(T1), cand(T2)], cruce: 'placa', hayLlave: true }, ConceptoCosto.IMPUESTO);
    expect(ambiguo).toEqual(expect.objectContaining({ tramiteId: null, cruce: null, motivo: 'cruce_ambiguo' }));
    expect(ambiguo.candidatos.map((c) => c.tramiteId)).toEqual([T1, T2]);
    // Ninguno admite → también ambiguo (no se elige «el menos malo»); y sin concepto no hay desempate.
    expect(cruzar({ candidatos: [cand(T1, { impuestoEstado: 'pagado' }), cand(T2, { impuestoEstado: null })], cruce: 'placa', hayLlave: true }, ConceptoCosto.IMPUESTO).motivo).toBe('cruce_ambiguo');
    expect(cruzar({ candidatos: [cand(T1, { impuestoEstado: 'pagado' }), cand(T2)], cruce: 'placa', hayLlave: true }, null).motivo).toBe('cruce_ambiguo');
  });
});

// ═════════════════ AC4 · el cruce corre en la carga ═════════════════════════════════════════════

describe('AC4 — la carga deja la sugerencia escrita en el pendiente', () => {
  it('cruce único por placa → la fila nace pendiente/leido con tramite_id y cruce=placa SUGERIDOS; aplicados sigue vacío', async () => {
    kdb.when.selectOnce(T_TRAM, []).selectOnce(T_TRAM, [fila({ idFlit: 'FLIT-XYZ', placa: 'XYZ789' })]);
    const res = await cargarLote([{ originalname: 'r.pdf', mimetype: 'application/pdf', buffer: PDF, size: PDF.length }], LOTE, CTX);
    expect(res.aplicados).toEqual([]);
    expect(res.pendientes[0]).toMatchObject({ comprobanteId: 'c-1', motivo: 'leido', detalle: 'Leído, pendiente de asociar', idFlit: 'FLIT-ARHZZ1', placa: 'XYZ789' });
    expect(espia.ultimoInsertEn(T_COMP)).toMatchObject({ estado: 'pendiente', motivoPendiente: 'leido', tramiteId: T1, cruce: 'placa' });
    // Ningún log con la llave leída.
    expect(JSON.stringify(logLineas)).not.toContain('XYZ789');
    expect(JSON.stringify(logLineas)).not.toContain('FLIT-ARHZZ1');
  });

  it('AC4-M: cruce_ambiguo (dos trámites de la placa, ambos admiten) → tramite_id y cruce NULL (no se adivina el primero)', async () => {
    kdb.when.selectOnce(T_TRAM, []).selectOnce(T_TRAM, [fila({ tramiteId: T1, placa: 'XYZ789' }), fila({ tramiteId: T2, placa: 'XYZ789', idFlit: 'FLIT-2' })]);
    const res = await cargarLote([{ originalname: 'r.pdf', mimetype: 'application/pdf', buffer: PDF, size: PDF.length }], LOTE, CTX);
    expect(res.pendientes[0]).toMatchObject({ motivo: 'cruce_ambiguo' });
    const f = espia.ultimoInsertEn(T_COMP);
    expect(f.tramiteId).toBeNull();
    expect(f.cruce).toBeNull();
    expect(f.motivoPendiente).toBe('cruce_ambiguo');
  });

  it('llave que no cruza → llave_no_cruza; único que no admite → destino_no_admite con la sugerencia escrita', async () => {
    const r1 = await cargarLote([{ originalname: 'a.pdf', mimetype: 'application/pdf', buffer: PDF, size: PDF.length }], LOTE, CTX);
    expect(r1.pendientes[0]!.motivo).toBe('llave_no_cruza');
    expect(espia.ultimoInsertEn(T_COMP)).toMatchObject({ motivoPendiente: 'llave_no_cruza', tramiteId: null, cruce: null });

    kdb.when.selectOnce(T_TRAM, [fila({ idFlit: 'FLIT-ARHZZ1', impuestoEstado: 'pagado' })]);
    const r2 = await cargarLote([{ originalname: 'b.pdf', mimetype: 'application/pdf', buffer: Buffer.from('%PDF-1.5\n%b\n'), size: 12 }], LOTE, CTX);
    expect(r2.pendientes[0]!.motivo).toBe('destino_no_admite');
    expect(espia.ultimoInsertEn(T_COMP)).toMatchObject({ motivoPendiente: 'destino_no_admite', tramiteId: T1, cruce: 'id_flit' });
  });

  it('precedencia completa: ocr → tipo → concepto → sin_llave → llave_no_cruza → cruce_ambiguo → destino_no_admite → confianza_insuficiente → leido', () => {
    const base = lectura().extraccion;
    const cruce = (motivo: 'llave_no_cruza' | 'cruce_ambiguo' | 'destino_no_admite' | null) => ({ tramiteId: motivo ? null : T1, cruce: motivo ? null : 'placa' as const, candidatos: [], motivo });
    expect(motivoPendienteDe(null, cruce('llave_no_cruza'))).toBe(MotivoPendienteComprobante.OCR_NO_DISPONIBLE);
    expect(motivoPendienteDe({ ...base, tipoDocumento: campo(null, 0) }, cruce('llave_no_cruza'))).toBe(MotivoPendienteComprobante.TIPO_NO_IDENTIFICADO);
    expect(motivoPendienteDe({ ...base, concepto: campo('impuesto', 0.5) }, cruce('llave_no_cruza'))).toBe(MotivoPendienteComprobante.CONCEPTO_DESCONOCIDO);
    expect(motivoPendienteDe({ ...base, placa: campo(null, 0), idFlit: campo(null, 0) }, cruce('llave_no_cruza'))).toBe(MotivoPendienteComprobante.SIN_LLAVE_DE_CRUCE);
    expect(motivoPendienteDe(base, cruce('llave_no_cruza'))).toBe(MotivoPendienteComprobante.LLAVE_NO_CRUZA);
    expect(motivoPendienteDe(base, cruce('cruce_ambiguo'))).toBe(MotivoPendienteComprobante.CRUCE_AMBIGUO);
    expect(motivoPendienteDe({ ...base, valorTotal: campo('1', 0.2) }, cruce('destino_no_admite'))).toBe(MotivoPendienteComprobante.DESTINO_NO_ADMITE);
    expect(motivoPendienteDe({ ...base, valorTotal: campo('1', 0.2) }, cruce(null))).toBe(MotivoPendienteComprobante.CONFIANZA_INSUFICIENTE);
    expect(motivoPendienteDe(base, cruce(null))).toBe(MotivoPendienteComprobante.LEIDO);
    // Sin cruce (F1) la función sigue igual que antes.
    expect(motivoPendienteDe(base)).toBe(MotivoPendienteComprobante.LEIDO);
    // columnasDeLectura solo escribe la sugerencia cuando hay tramiteId.
    expect(columnasDeLectura(lectura(), cruce('cruce_ambiguo'))).toMatchObject({ tramiteId: null, cruce: null });
    expect(columnasDeLectura(lectura(), cruce(null))).toMatchObject({ tramiteId: T1, cruce: 'placa' });
    expect(columnasDeLectura(null, null)).toMatchObject({ tramiteId: null, cruce: null, motivoPendiente: 'ocr_no_disponible' });
  });

  it('cruzarLectura: sin lectura → null; sin llaves → sin_llave_de_cruce sin consultar; con llaves → cruza con el concepto confiable', async () => {
    expect(await cruzarLectura(null)).toBeNull();
    const sinLlave = await cruzarLectura({ ...lectura().extraccion, placa: campo(null, 0), idFlit: campo(null, 0) });
    expect(sinLlave).toMatchObject({ motivo: 'sin_llave_de_cruce', tramiteId: null });
    expect(condicionesTramites()).toHaveLength(0);
    expect(llavesDe(lectura().extraccion)).toEqual({ idFlit: 'FLIT-ARHZZ1', vin: null, placa: 'XYZ789' });
    kdb.when.selectOnce(T_TRAM, [fila({ idFlit: 'FLIT-ARHZZ1', impuestoEstado: 'pagado' }), fila({ tramiteId: T2, idFlit: 'FLIT-ARHZZ1' })]);
    const r = await cruzarLectura(lectura().extraccion);
    expect(r).toMatchObject({ tramiteId: T2, cruce: 'id_flit', motivo: null });
  });
});

// ═════════════════ AC5 · GET /:id con candidatos; POST /tramites/buscar ═════════════════════════

describe('AC5 — GET /:id devuelve candidatos; POST /tramites/buscar por body', () => {
  const filaLista = (over: Record<string, unknown> = {}) => ({
    id: ID, loteId: LOTE, estado: 'pendiente', motivoPendiente: 'cruce_ambiguo', detallePendiente: null, tipoDocumento: 'recibo_impuesto', esPago: true,
    concepto: 'impuesto', tramiteId: null, tramiteIdFlit: null, tramitePlaca: null, cruce: null, placaLeida: 'XYZ789', vinLeido: null, idFlitLeido: null,
    valor: '120000.00', fechaDocumento: '2026-09-12', numeroDocumento: 'R-9', emisor: 'Gobernación', marcadoPorDiferencia: false, diferenciaTarifa: null,
    diferenciaAceptadaEn: null, paginas: null, archivoNombre: 'r.pdf', archivoContentType: 'application/pdf',
    createdAt: new Date('2026-09-15T12:00:00Z'), aplicadoEn: null, aplicadoAutomaticamente: false, descartadoEn: null,
    subidoPorNombre: 'fin@flitsas.io', aplicadoPorNombre: null, descartadoPorNombre: null, ...over,
  });

  it('pendiente con llaves → candidatos[] de CandidatoTramiteDto (sin persona), Cache-Control: no-store; se consultó por la placa leída', async () => {
    const app = await buildApp();
    kdb.when.selectOnce(T_COMP, [filaLista()]).selectOnce(T_COMP, [{ extraccion: lectura().extraccion, extraccionDestino: null }])
      .selectOnce(T_TRAM, [fila({ tramiteId: T1, placa: 'XYZ789' }), fila({ tramiteId: T2, placa: 'XYZ789', idFlit: 'FLIT-2', impuestoEstado: 'pagado' })]);
    const res = await request(app).get(`${BASE}/${ID}`).set('Authorization', await auth());
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.candidatos).toHaveLength(2);
    expect(res.body.candidatos[0]).toEqual({
      tramiteId: T1, idFlit: 'FLIT-ABC001', placa: 'XYZ789', vin: '1HGCM82633A004352', tipoTramite: 'MATRICULA', empresa: 'Acme S.A.S.', flitEstado: 'Aprobado', liquidado: false,
      admite: { soat: 'admite', impuesto: 'admite', derecho: 'admite', tramite_digital: 'admite', logistica: 'admite', servicios_adicionales: 'admite' },
    });
    expect(res.body.candidatos[1].admite.impuesto).toBe('ya_pagado');
    expect(JSON.stringify(res.body)).not.toContain('Juan');
    expect(res.body).not.toHaveProperty('extraccion');
    expect(condicionesTramites().at(-1)!.params).toEqual(['XYZ789']);
  });

  it('en aplicados y descartados candidatos = [] y no se consulta flito_tramites', async () => {
    const app = await buildApp();
    for (const estado of ['aplicado', 'descartado']) {
      espia.reiniciar();
      kdb.when.selectOnce(T_COMP, [filaLista({ estado, motivoPendiente: null })]).selectOnce(T_COMP, [{ extraccion: {}, extraccionDestino: null }]).select(T_TRAM, [fila()]);
      const res = await request(app).get(`${BASE}/${ID}`).set('Authorization', await auth());
      expect(res.status).toBe(200);
      expect(res.body.candidatos).toEqual([]);
      expect(condicionesTramites()).toHaveLength(0);
    }
  });

  it('POST /tramites/buscar { buscar }: exige comprobantes.tramites.buscar (auditor → 403); 3..60 caracteres; no-store; misma forma y el mismo admite', async () => {
    const app = await buildApp();
    expect(operacionesDePartida('financiera')).toContain('comprobantes.tramites.buscar');
    expect(operacionesDePartida('auditor')).not.toContain('comprobantes.tramites.buscar');
    expect((await request(app).post(`${BASE}/tramites/buscar`).send({ buscar: 'ABC123' })).status).toBe(401);
    expect((await request(app).post(`${BASE}/tramites/buscar`).set('Authorization', await auth('auditor')).send({ buscar: 'ABC123' })).status).toBe(403);
    expect((await request(app).post(`${BASE}/tramites/buscar`).set('Authorization', await auth()).send({ buscar: 'AB' })).status).toBe(400);
    expect((await request(app).post(`${BASE}/tramites/buscar`).set('Authorization', await auth()).send({ buscar: 'x'.repeat(61) })).status).toBe(400);
    expect((await request(app).post(`${BASE}/tramites/buscar`).set('Authorization', await auth()).send({})).body.codigo).toBe('datos_invalidos');
    // Sin variante GET.
    expect((await request(app).get(`${BASE}/tramites/buscar?buscar=ABC123`).set('Authorization', await auth())).status).toBe(404);

    kdb.when.selectOnce(T_TRAM, [fila(), fila({ tramiteId: T2, idFlit: 'FLIT-ABC002', soatEstado: 'pagado' })]);
    const res = await request(app).post(`${BASE}/tramites/buscar`).set('Authorization', await auth()).send({ buscar: ' abc-12 ' });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.candidatos).toHaveLength(2);
    expect(Object.keys(res.body.candidatos[0]).sort()).toEqual(['admite', 'empresa', 'flitEstado', 'idFlit', 'liquidado', 'placa', 'tipoTramite', 'tramiteId', 'vin']);
    expect(res.body.candidatos[1].admite.soat).toBe('ya_pagado');
    expect(JSON.stringify(res.body)).not.toContain('Juan');
    // El predicado: contención normalizada en id_flit / placa (sin guion) / vin; la llave no viaja en la URL.
    const q = condicionesTramites().at(-1)!;
    expect(q.sql).toBe('(UPPER("flito_tramites"."id_flit") LIKE $1 or UPPER(REPLACE("vehicles"."plate", \'-\', \'\')) LIKE $2 or UPPER("vehicles"."vin") LIKE $3)');
    expect(q.params).toEqual(['%ABC-12%', '%ABC12%', '%ABC-12%']);
    expect(renderizar(condicionBusqueda('flit')).params).toEqual(['%FLIT%', '%FLIT%', '%FLIT%']);
  });

  it('AC5-M: la consulta devuelve 21 → el servicio entrega 20 (LIMIT en el SQL y corte en memoria)', async () => {
    const veintiuno = Array.from({ length: 21 }, (_, i) => fila({ tramiteId: `${T1.slice(0, -2)}${String(i).padStart(2, '0')}`, idFlit: `FLIT-${i}` }));
    kdb.when.selectOnce(T_TRAM, veintiuno);
    const c = await candidatosPorTexto('FLIT');
    expect(MAX_CANDIDATOS_BUSQUEDA).toBe(20);
    expect(c).toHaveLength(20);
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const fuente = readFileSync(join(import.meta.dirname, '../../src/modules/flito-comprobantes/flito-comprobantes.cruce.ts'), 'utf8');
    expect(fuente).toMatch(/\.limit\(MAX_CANDIDATOS_BUSQUEDA\)/);
  });
});

// ═════════════════ AC8 · filtro asociacion en GET / ═════════════════════════════════════════════

describe('AC8 — filtro asociacion (SQL renderizado; cada literal UNA vez, Bug #12058)', () => {
  it('las seis traducciones', () => {
    const q = (a: Parameters<typeof condicionAsociacion>[0]) => renderizar(condicionAsociacion(a));
    expect(q('pendiente').sql).toBe('"flito_comprobantes"."estado" = $1');
    expect(q('pendiente').params).toEqual(['pendiente']);
    expect(q('aplicado_automatico').sql).toBe('("flito_comprobantes"."estado" = $1 and "flito_comprobantes"."es_pago" = $2 and "flito_comprobantes"."aplicado_automaticamente" = $3)');
    expect(q('aplicado_automatico').params).toEqual(['aplicado', true, true]);
    expect(q('aplicado_manual').params).toEqual(['aplicado', true, false]); // AC8-M
    expect(q('adjuntado').sql).toBe('("flito_comprobantes"."estado" = $1 and "flito_comprobantes"."es_pago" = $2)');
    expect(q('adjuntado').params).toEqual(['aplicado', false]);
    expect(q('rechazado_pago').sql).toBe('("flito_comprobantes"."estado" = $1 and "flito_comprobantes"."motivo_pendiente" = $2)');
    expect(q('rechazado_pago').params).toEqual(['pendiente', 'destino_no_admite']);
    expect(q('descartado').params).toEqual(['descartado']);
  });

  it('entra en condicionesListado junto a los demás filtros, sin repetir literales; y la ruta lo valida como enum', async () => {
    const r = renderizar(condicionesListado({ estado: 'aplicado', asociacion: 'aplicado_manual', page: 1, pageSize: 50 })!);
    // `estado = 'aplicado'` aparece dos veces (filtro explícito + traducción) y son DOS parámetros: Drizzle no deduplica (Bug #12058).
    expect(r.params).toEqual(['aplicado', 'aplicado', true, false]);
    expect(ligadoA(renderizar(condicionesListado({ asociacion: 'rechazado_pago', page: 1, pageSize: 50 })!), '"flito_comprobantes"."motivo_pendiente"')).toBe('destino_no_admite');

    const app = await buildApp();
    kdb.when.selectOnce(T_COMP, [{ total: 0 }]).selectOnce(T_COMP, []);
    const ok = await request(app).get(`${BASE}?asociacion=adjuntado`).set('Authorization', await auth());
    expect(ok.status).toBe(200);
    const leidas = espia.condicionesLeidas().map((c) => renderizar(c as never));
    expect(leidas).toHaveLength(2);
    for (const q of leidas) expect(q.params).toEqual(['aplicado', false]);
    expect((await request(app).get(`${BASE}?asociacion=otra`).set('Authorization', await auth())).status).toBe(400);
  });
});
