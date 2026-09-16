// HU #12531 y #12536 — el reporte de costos y su consolidado, en `.xlsx` (Feature #12530, épica #12243).
//
// Lo que se afirma es el LIBRO REAL que sale por la ruta, abierto con ExcelJS —como hacen las suites
// de SOAT e Impuestos—, no la constante que lo generó: nombre de hoja, las 32/13 cabeceras escritas a
// mano (las 32 del detalle son las LITERALES del Excel de Financiero, HU #12536, más «Servicios
// adicionales» de la HU #12546), el TIPO de cada celda (número con formato contable, `Date` de día, vacía para `null`), el
// autofiltro y la fila fija. El CI no levanta Postgres y `keyed-db` devuelve la fila entera e ignora
// `limit`, así que el tope se prueba con TOPE+1 filas de fixture (el servicio lanza antes de
// resolverlas) y con un espía sobre `limit`. Cada aserto lleva el mutante que lo pone rojo.
//
// Se corre con `TZ=UTC` y bajo `-05` da lo mismo: el día de la celda sale del ISO, no del reloj.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import ExcelJS from 'exceljs';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken, type TestRole } from '../helpers/auth.js';

const kdb = createKeyedDb();

vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

/** Orden observado: primero el rastro PII, después el primer byte del archivo (AC9). */
const orden: string[] = [];
const logPiiMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/pii-audit.js', () => ({
  logPiiAccess: (...args: unknown[]) => { orden.push('pii'); return logPiiMock(...args); },
}));
/** `sendExcel` se ENVUELVE, no se sustituye: el archivo que se afirma es el de verdad. */
vi.mock('../../src/shared/utils/excel.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/utils/excel.js')>();
  return {
    ...actual,
    sendExcel: (...args: Parameters<typeof actual.sendExcel>) => { orden.push('excel'); return actual.sendExcel(...args); },
  };
});

// Espías que ENVUELVEN al original: las rutas se prueban contra el servicio real y a la vez se lee
// qué filtro y qué periodo les llegó (AC8, AC2).
vi.mock('../../src/modules/finanzas/finanzas.service.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/modules/finanzas/finanzas.service.js')>();
  return { ...orig, filasParaExportar: vi.fn(orig.filasParaExportar) };
});
vi.mock('../../src/modules/finanzas/finanzas.consolidado.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/modules/finanzas/finanzas.consolidado.js')>();
  return { ...orig, consolidadoReporte: vi.fn(orig.consolidadoReporte) };
});

const { filasParaExportar, TOPE_EXPORTACION } = await import('../../src/modules/finanzas/finanzas.service.js');
const { consolidadoReporte } = await import('../../src/modules/finanzas/finanzas.consolidado.js');
const filasParaExportarMock = vi.mocked(filasParaExportar);
const consolidadoMock = vi.mocked(consolidadoReporte);
const {
  COLUMNAS_EXPORT_CONSOLIDADO, COLUMNAS_EXPORT_DETALLE, fechaExcel, filasExcelDetalle, FORMATO_DINERO,
  nombreCompletoTitular,
} = await import('../../src/modules/finanzas/finanzas.export-excel.js');
const { ExportColaDemasiadoGrandeError } = await import('../../src/shared/export/cola-flito-excel.js');
const { bufferParaExcelJS } = await import('../../src/shared/utils/excel.js');

const BASE = '/api/finanzas';
const RUTA_DETALLE = `${BASE}/reporte-costos/export`;
const RUTA_CONSOLIDADO = `${BASE}/reporte-costos/consolidado/export`;

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Una fila CRUDA como la devuelve el `select` de `SELECT_FILA`, antes de `aFila`. */
function cruda(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tramiteId: 't1', idFlit: 'FLIT-1', placa: 'ABC123', estado: 'Aprobado', empresa: 'ACME',
    vin: 'VIN1', marca: 'CHEVROLET', linea: 'ONIX', tipoTramite: 'Traspaso',
    fechaAprobacion: new Date('2026-09-03T04:30:00.000Z'), fechaCreacion: new Date('2026-09-01T10:00:00.000Z'),
    sellada: true, estadoLiquidacion: 'liquidado',
    soat: '450000', impuesto: '120000', derechoTramite: '80000', tramiteDigital: '200000',
    logistica: '15000', gmf: '3460', totalFila: '868460',
    // HU #12546 — la proyección trae la clave siempre; `null` = sin servicios (`Number(undefined)`
    // sería NaN y este archivo no lo vería: `build:api` no typechequea `__tests__`).
    serviciosAdicionales: null, serviciosAdicionalesCantidad: 0,
    // HU #12627 — siempre viaja: 1 = solo el viaje incluido en la tarifa.
    logisticaViajesCantidad: 1,
    soatPendiente: false, impuestoPendiente: false,
    gestionaSoat: true, gestionaImpuesto: true, gestionaLogistica: true,
    soatAutogestionable: false, impuestosAutogestionable: false, logisticaAutogestionable: false,
    estadoFacturacion: 'no_enviado', facturaDatos: null,
    boletaReferencia: null, soatConciliadoEn: null,
    titularTipoFlit: 'cc', titularNombresFlit: 'JUAN CARLOS', titularApellidosFlit: 'MEJIA MEJIA',
    titularDocumento: '1020304050',
    // HU #12531 — el contacto del primer comprador.
    titularCorreo: 'juan@correo.co', titularTelefono: '3001234567', titularDireccion: 'CRA 7 # 45-12',
    organismoCodigo: '05266', organismoAlias: 'Envigado',
    ...over,
  };
}

const grupo = (over: Record<string, unknown> = {}) => ({
  companiaId: 7, companiaNit: '811011779', periodo: '2026-09', tramites: 2,
  soat: '900000', impuesto: '240000', derechoTramite: '160000', gmf: '6920', logistica: '30000',
  tramiteDigital: '400000', serviciosAdicionales: '0', totalReintegro: '1336920', totalServicio: '400000', total: '1736920',
  filasIncompletas: 1,
  ...over,
});
const MAESTRO = [{ id: 7, nombre: 'ACME', documento: '811011779' }, { id: 9, nombre: 'BETA', documento: '900555111' }];

// ── App, sesiones y espías ──────────────────────────────────────────────────

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/finanzas/finanzas.routes.js');
  app.use(BASE, router);
  return app;
}

/** `sub` nuevo por caso: el limitador cuenta 5/min y usuario, y su ventana no se reinicia. */
let siguienteSub = 7300;
const sesion = async (role: TestRole = 'financiera'): Promise<string> =>
  `Bearer ${await testToken({ sub: siguienteSub++, username: 'fin@flit.io', role })}`;

const exportar = async (ruta: string, cabecera: string, cuerpo: unknown = {}) =>
  request(await buildApp()).post(ruta).set('Authorization', cabecera).responseType('blob').send(cuerpo as object);

/** Los `limit(n)` que llegaron a la base, en orden. */
const limites: number[] = [];
function instalarEspias(): void {
  const selectBase = kdb.select.getMockImplementation() as (...a: unknown[]) => Record<string, unknown>;
  kdb.select.mockImplementation((...args: unknown[]) => {
    const chain = selectBase(...args);
    const limit = chain.limit as (n: number) => unknown;
    chain.limit = (n: number) => { limites.push(n); return limit(n); };
    return chain;
  });
}

async function libro(cuerpo: Buffer): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bufferParaExcelJS(cuerpo));
  const hoja = wb.worksheets[0];
  expect(hoja).toBeDefined();
  return hoja!;
}

/** La celda de la fila `n` bajo la cabecera `cabecera`, leída del libro (índice por la fila 1 real). */
function celda(hoja: ExcelJS.Worksheet, cabecera: string, n = 2): ExcelJS.Cell {
  const cabeceras = (hoja.getRow(1).values as unknown[]).slice(1) as string[];
  const i = cabeceras.indexOf(cabecera);
  expect(i, `cabecera «${cabecera}»`).toBeGreaterThanOrEqual(0);
  return hoja.getRow(n).getCell(i + 1);
}

/**
 * Las 32 cabeceras ESCRITAS A MANO, literales del Excel de Financiero (HU #12536) más «Servicios
 * adicionales» (HU #12546, justo después de «Modelo»): si vivieran en la constante de producción, un
 * cambio de orden o de mayúscula pasaría en verde. Mutante «cabecera 'Cliente' con mayúscula», «Vin
 * como VIN», «Tramite con tilde», «Teléfono sin /Celular», «Servicios adicionales al final»: cae aquí.
 */
const CABECERAS_DETALLE = [
  'cliente', 'Mes/Trimestre', 'FLIT', 'Placa', 'Tipo', 'CC-NIT', 'Nombres', 'Apellidos', 'Nombre completo',
  'Modelo', 'Servicios adicionales', 'Estado', 'Correo', 'OT', 'Tipo Trámite', 'Teléfono/Celular', 'Dirección',
  'SOAT', 'Trámite', 'Impuesto', 'Columna1', 'Columna2', 'GMF', 'Total Reintegro', 'Servicio',
  'Factura', 'Factura Terceros', 'Vin', 'Placa2', 'Tramite', 'fecha_aprobacion', 'Filtromes',
];
const CABECERAS_CONSOLIDADO = [
  'Cliente', 'Periodo', 'Trámites', 'SOAT', 'Impuesto', 'Trámite', 'GMF', 'Logística',
  'Total reintegro', 'Trámite digital', 'Servicio', 'Total', 'Incompletos',
];
/** Las nueve de dinero del CONSOLIDADO (AC2, sin cambios en la HU #12536). */
const DINERO = ['SOAT', 'Impuesto', 'Trámite', 'GMF', 'Logística', 'Total reintegro', 'Trámite digital', 'Servicio', 'Total'];
/** Las ocho de dinero del DETALLE con valor; «Columna2» va aparte: lleva el formato pero siempre vacía. */
const DINERO_DETALLE = ['SOAT', 'Trámite', 'Impuesto', 'Columna1', 'GMF', 'Total Reintegro', 'Servicio', 'Servicios adicionales'];
const NUMFMT_DINERO = '_-"$" * #,##0.00_-;-"$" * #,##0.00_-;_-"$" * "-"??_-;_-@_-';

beforeEach(() => {
  kdb.reset();
  instalarEspias();
  orden.length = 0;
  limites.length = 0;
  logPiiMock.mockClear();
  filasParaExportarMock.mockClear();
  consolidadoMock.mockClear();
});

// ───────────────────────────── AC1 — el detalle ─────────────────────────────

describe('AC1 — POST /reporte-costos/export entrega el detalle entero en .xlsx', () => {
  it('200, xlsx, nombre con sello de Colombia, no-store, hoja «Reporte de costos» y las 32 cabeceras literales en orden', async () => {
    kdb.when.select('flito_tramites', [cruda(), cruda({ tramiteId: 't2', idFlit: 'FLIT-2' }), cruda({ tramiteId: 't3', idFlit: 'FLIT-3' })]);
    const r = await exportar(RUTA_DETALLE, await sesion());
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    // Mutante «prefijo viejo» / «sin sello»: `reporte-costos.csv` o sin `_AAAAMMDD-HHmm`.
    expect(r.headers['content-disposition']).toMatch(/^attachment; filename="reporte-costos_\d{8}-\d{4}\.xlsx"$/);
    expect(r.headers['cache-control']).toBe('no-store');

    const hoja = await libro(r.body as Buffer);
    // Mutante «hoja 'Datos'» (el defecto de sendExcel).
    expect(hoja.name).toBe('Reporte de costos');
    // Mutante «una columna de más» (p. ej. Marca o Liquidación): el `toEqual` es del array entero.
    expect((hoja.getRow(1).values as unknown[]).slice(1)).toEqual(CABECERAS_DETALLE);
    expect(CABECERAS_DETALLE).toHaveLength(32);
    expect(hoja.getRow(1).cellCount).toBe(32);
    // La 32.ª va PEGADA a «Modelo» (CF-10 de la HU #12546), no al final del archivo.
    expect(CABECERAS_DETALLE[CABECERAS_DETALLE.indexOf('Modelo') + 1]).toBe('Servicios adicionales');
    expect(COLUMNAS_EXPORT_DETALLE.map((c) => c.header)).toEqual(CABECERAS_DETALLE);
    // Todas las filas del filtro, no una página: 1 cabecera + 3 filas.
    expect(hoja.rowCount).toBe(4);
    expect(celda(hoja, 'FLIT', 4).value).toBe('FLIT-3');
  });
});

// ───────────────────────────── AC5 — el titular ─────────────────────────────

describe('AC5 — Nombre completo y contacto del primer comprador', () => {
  it('natural: «JUAN CARLOS» + «MEJIA MEJIA» → «JUAN CARLOS MEJIA MEJIA»; correo, teléfono y dirección del comprador', async () => {
    kdb.when.select('flito_tramites', [cruda()]);
    const hoja = await libro((await exportar(RUTA_DETALLE, await sesion())).body as Buffer);
    // Mutante «nombre_completo fundido del sync» o «solo nombres».
    expect(celda(hoja, 'Nombre completo').value).toBe('JUAN CARLOS MEJIA MEJIA');
    expect(celda(hoja, 'Nombres').value).toBe('JUAN CARLOS');
    expect(celda(hoja, 'Apellidos').value).toBe('MEJIA MEJIA');
    expect(celda(hoja, 'Correo').value).toBe('juan@correo.co');
    expect(celda(hoja, 'Teléfono/Celular').value).toBe('3001234567');
    expect(celda(hoja, 'Dirección').value).toBe('CRA 7 # 45-12');
    // Mutante «Number(titularDocumento)»: el tipo sería Number y perdería ceros a la izquierda.
    expect(celda(hoja, 'CC-NIT').value).toBe('1020304050');
    expect(celda(hoja, 'CC-NIT').type).toBe(ExcelJS.ValueType.String);
    expect(celda(hoja, 'Tipo').value).toBe('CC');
    // HU #12536: la razón social y la liquidación ya no son columnas del archivo.
    const cabeceras = (hoja.getRow(1).values as unknown[]).slice(1);
    expect(cabeceras).not.toContain('Razón social');
    expect(cabeceras).not.toContain('Liquidación');
  });

  it('identificación literal: cliente, FLIT, Placa = Placa2, Vin; Modelo es la LÍNEA; Tipo Trámite = Tramite', async () => {
    kdb.when.select('flito_tramites', [cruda()]);
    const hoja = await libro((await exportar(RUTA_DETALLE, await sesion())).body as Buffer);
    expect(celda(hoja, 'cliente').value).toBe('ACME');
    expect(celda(hoja, 'FLIT').value).toBe('FLIT-1');
    expect(celda(hoja, 'Placa').value).toBe('ABC123');
    // Mutante «Placa2 ← vin»: saldría VIN1.
    expect(celda(hoja, 'Placa2').value).toBe('ABC123');
    expect(celda(hoja, 'Vin').value).toBe('VIN1');
    // Mutante «Modelo ← marca»: saldría CHEVROLET. Mutante «Modelo ← año»: no sería la línea.
    expect(celda(hoja, 'Modelo').value).toBe('ONIX');
    expect(celda(hoja, 'Tipo Trámite').value).toBe('Traspaso');
    // Mutante «Tramite ← tipo de documento»: saldría CC. Mutante «Tramite ← derechoTramite»: sería Number.
    expect(celda(hoja, 'Tramite').value).toBe('Traspaso');
    expect(celda(hoja, 'Tramite').type).toBe(ExcelJS.ValueType.String);
    expect(celda(hoja, 'Estado').value).toBe('Aprobado');
    expect(celda(hoja, 'OT').value).toBe('Envigado');
  });

  it('jurídica: Tipo «NIT», la razón social ES el nombre completo, Nombres/Apellidos vacíos; sin correo, OT ni placa las celdas van vacías', async () => {
    kdb.when.select('flito_tramites', [cruda({
      titularTipoFlit: 'n', titularNombresFlit: 'TRANSPORTES ABC SAS', titularApellidosFlit: null, titularCorreo: null,
      organismoCodigo: null, organismoAlias: null, placa: null,
    })]);
    const hoja = await libro((await exportar(RUTA_DETALLE, await sesion())).body as Buffer);
    expect(celda(hoja, 'Tipo').value).toBe('NIT');
    // Mutante «nombres + apellidos aunque haya razón social»: saldría vacío o «TRANSPORTES ABC SAS ».
    expect(celda(hoja, 'Nombre completo').value).toBe('TRANSPORTES ABC SAS');
    // Mutante «Nombres ← razón social»: la jurídica no reparte su nombre en dos columnas.
    expect(celda(hoja, 'Nombres').type).toBe(ExcelJS.ValueType.Null);
    expect(celda(hoja, 'Apellidos').type).toBe(ExcelJS.ValueType.Null);
    // Mutante «?? ''» en cualquiera: el tipo sería String.
    expect(celda(hoja, 'Correo').value).toBeNull();
    expect(celda(hoja, 'Correo').type).toBe(ExcelJS.ValueType.Null);
    expect(celda(hoja, 'OT').type).toBe(ExcelJS.ValueType.Null);
    expect(celda(hoja, 'Placa').type).toBe(ExcelJS.ValueType.Null);
    expect(celda(hoja, 'Placa2').type).toBe(ExcelJS.ValueType.Null);
  });

  it('nombreCompletoTitular (pura): razón social manda; apellidos null (S-05) no dejan espacio colgando; nada → null', () => {
    expect(nombreCompletoTitular({ titularNombres: 'ANA', titularApellidos: null, titularRazonSocial: null })).toBe('ANA');
    expect(nombreCompletoTitular({ titularNombres: null, titularApellidos: 'PÉREZ', titularRazonSocial: null })).toBe('PÉREZ');
    // Mutante «`${n} ${a}` sin filtrar»: daría «ANA » o « PÉREZ».
    expect(nombreCompletoTitular({ titularNombres: 'ANA', titularApellidos: 'PÉREZ', titularRazonSocial: 'X SAS' })).toBe('X SAS');
    // Mutante «'' en vez de null»: la celda dejaría de estar vacía.
    expect(nombreCompletoTitular({ titularNombres: null, titularApellidos: null, titularRazonSocial: null })).toBeNull();
  });

  it('un trámite con dos compradores sigue siendo UNA fila: no hay join a flito_compradores', async () => {
    // La subconsulta se afirma en `finanzas.reporte-columnas.test.ts`; aquí, que la fila del libro es una
    // por trámite aunque la base tenga dos compradores (el mock no multiplica porque no hay join).
    kdb.when.select('flito_tramites', [cruda()]).select('flito_compradores', [{ id: 'c1' }, { id: 'c2' }]);
    const hoja = await libro((await exportar(RUTA_DETALLE, await sesion())).body as Buffer);
    expect(hoja.rowCount).toBe(2);
    expect(kdb.select.mock.calls.length).toBe(1);
  });
});

// ───────────────────────────── AC3 y AC4 — tipos de celda ─────────────────────────────

describe('AC3 — el dinero es número con el formato contable, nunca texto ni fórmula', () => {
  it('las ocho columnas de dinero son number con el numFmt exacto; Columna1 es la logística; GMF y totales llevan el valor', async () => {
    // Con servicios adicionales: la 32.ª columna solo puede ser `Number` si la fila lleva importe.
    kdb.when.select('flito_tramites', [cruda({ serviciosAdicionales: '85000', serviciosAdicionalesCantidad: 2 })]);
    const hoja = await libro((await exportar(RUTA_DETALLE, await sesion())).body as Buffer);
    for (const cab of DINERO_DETALLE) {
      const c = celda(hoja, cab);
      // Mutante «String(v)» en el serializador: el tipo sería String. Mutante «numFmt '"$"#,##0'»: otro formato.
      expect(c.type, cab).toBe(ExcelJS.ValueType.Number);
      expect(c.numFmt, cab).toBe(NUMFMT_DINERO);
    }
    expect(FORMATO_DINERO).toBe(NUMFMT_DINERO);
    expect(celda(hoja, 'SOAT').value).toBe(450000);
    expect(celda(hoja, 'Trámite').value).toBe(80000);
    expect(celda(hoja, 'Impuesto').value).toBe(120000);
    // Mutante «Columna1 ← tramiteDigital»: saldría 200000. Mutante «Columna1 ← null»: celda vacía.
    expect(celda(hoja, 'Columna1').value).toBe(15000);
    // Mutante «fórmula =SUM(...)»: el tipo sería Formula.
    expect(celda(hoja, 'GMF').value).toBe(3460);
    expect(celda(hoja, 'Total Reintegro').value).toBe(668460);
    // «Servicio» = trámite digital + servicios adicionales (RN-02 con la HU #12546): 200.000 + 85.000.
    // Mutante «subtotalesDe se queda con el trámite digital»: 200000, y el pie dejaría de cuadrar.
    expect(celda(hoja, 'Servicio').value).toBe(285000);
    // HU #12546 — el IMPORTE, no la cantidad (2): un mutante «cantidad» pondría 2 aquí.
    expect(celda(hoja, 'Servicios adicionales').value).toBe(85000);
  });

  it('sin servicios adicionales la celda va VACÍA, no en cero (HU #12546)', async () => {
    // Mutante «?? 0»: el tipo sería Number y el 0 cuadraría un promedio que no existe.
    kdb.when.select('flito_tramites', [cruda({ serviciosAdicionales: null })]);
    const hoja = await libro((await exportar(RUTA_DETALLE, await sesion())).body as Buffer);
    expect(celda(hoja, 'Servicios adicionales').type).toBe(ExcelJS.ValueType.Null);
    expect(celda(hoja, 'Servicios adicionales').value).toBeNull();
    // Y la COLUMNA conserva el formato contable aunque la celda esté vacía.
    const i = CABECERAS_DETALLE.indexOf('Servicios adicionales') + 1;
    expect(hoja.getColumn(i).numFmt).toBe(NUMFMT_DINERO);
  });

  it('HU #12627 — la cantidad de viajes de logística viaja en la fila del JSON pero NO en el archivo: siguen 32 cabeceras (AC8)', async () => {
    kdb.when.select('flito_tramites', [cruda({ logistica: '90000', logisticaViajesCantidad: 3 })]);
    const filas = await filasParaExportar({});
    // `aFila` la proyecta (mutante «olvidar el campo»: undefined); y `null`/`0` se conservan tal cual
    // (mutante «?? 0» sobre un sello anterior al Feature diría «se selló sin viajes»).
    expect(filas[0]!.logisticaViajesCantidad).toBe(3);
    kdb.when.select('flito_tramites', [cruda({ logisticaViajesCantidad: null })]);
    expect((await filasParaExportar({}))[0]!.logisticaViajesCantidad).toBeNull();
    kdb.when.select('flito_tramites', [cruda({ logisticaViajesCantidad: 0 })]);
    expect((await filasParaExportar({}))[0]!.logisticaViajesCantidad).toBe(0);
    // El Excel es literal del adjunto del PO: ni una 33.ª cabecera ni la cantidad colada en otra clave.
    const hoja = filasExcelDetalle(filas)[0]!;
    expect(hoja).not.toHaveProperty('logisticaViajesCantidad');
    expect(Object.values(hoja)).not.toContain(3);
    expect(COLUMNAS_EXPORT_DETALLE.map((c) => c.key)).not.toContain('logisticaViajesCantidad');
    expect(COLUMNAS_EXPORT_DETALLE).toHaveLength(32);
    // Columna1 sigue siendo la logística YA sumada (tarifa + viajes), no la tarifa sola.
    expect(hoja.columna1).toBe(90000);
  });

  it('Columna2 va vacía pero con la columna en formato de dinero; Factura es texto y Factura Terceros vacía', async () => {
    kdb.when.select('flito_tramites', [cruda({ facturaDatos: { numero: 'FV-1-123', requiereRevision: false }, estadoFacturacion: 'emitido' })]);
    const hoja = await libro((await exportar(RUTA_DETALLE, await sesion())).body as Buffer);
    // Mutante «columna2 ← logistica» o «?? 0»: el tipo sería Number.
    expect(celda(hoja, 'Columna2').type).toBe(ExcelJS.ValueType.Null);
    expect(celda(hoja, 'Columna2').value).toBeNull();
    // Mutante «Columna2 sin dinero()»: la columna no llevaría el numFmt contable.
    const iColumna2 = CABECERAS_DETALLE.indexOf('Columna2') + 1;
    expect(hoja.getColumn(iColumna2).numFmt).toBe(NUMFMT_DINERO);
    // Mutante «Number(facturaNumero)»: 'FV-1-123' no es número, pero un consecutivo pelado sí caería.
    expect(celda(hoja, 'Factura').value).toBe('FV-1-123');
    expect(celda(hoja, 'Factura').type).toBe(ExcelJS.ValueType.String);
    // Mutante «facturaTerceros ← facturaNumero»: saldría FV-1-123.
    expect(celda(hoja, 'Factura Terceros').type).toBe(ExcelJS.ValueType.Null);
  });

  it('una fila sin sellar exporta sus valores estimados: no hay columna «Estimado» ni «Liquidación»', async () => {
    kdb.when.select('flito_tramites', [cruda({ sellada: false, estadoLiquidacion: null, soat: '460000' })]);
    const hoja = await libro((await exportar(RUTA_DETALLE, await sesion())).body as Buffer);
    // Mutante «sin sellar → dinero vacío»: el estimado es lo que Financiero cuadra.
    expect(celda(hoja, 'SOAT').value).toBe(460000);
    expect(celda(hoja, 'Total Reintegro').type).toBe(ExcelJS.ValueType.Number);
    const cabeceras = (hoja.getRow(1).values as unknown[]).slice(1);
    expect(cabeceras).not.toContain('Estimado');
    expect(cabeceras).not.toContain('Liquidación');
  });
});

describe('AC4 — fechas como Date de día en UTC, periodos como texto, null como celda vacía', () => {
  it('aprobación 2026-09-03T04:30Z → fecha_aprobacion = 2026-09-03 (Date, yyyy-mm-dd); Filtromes 2026-09; Mes/Trimestre 2026-T3', async () => {
    kdb.when.select('flito_tramites', [cruda()]);
    const hoja = await libro((await exportar(RUTA_DETALLE, await sesion())).body as Buffer);
    const aprobado = celda(hoja, 'fecha_aprobacion');
    // Mutante «fecha_aprobacion como texto ISO»: el tipo sería String. Mutante «new Date(iso)» en -05: sería el 2 a las 23:30.
    expect(aprobado.type).toBe(ExcelJS.ValueType.Date);
    expect((aprobado.value as Date).toISOString()).toBe('2026-09-03T00:00:00.000Z');
    expect(aprobado.numFmt).toBe('yyyy-mm-dd');
    // Mutante «Filtromes con el trimestre»: saldría 2026-T3. Mutante «Mes/Trimestre ← mes»: saldría 2026-09.
    expect(celda(hoja, 'Filtromes').value).toBe('2026-09');
    expect(celda(hoja, 'Mes/Trimestre').value).toBe('2026-T3');
    expect(celda(hoja, 'Filtromes').type).toBe(ExcelJS.ValueType.String);
    // HU #12536: «Creado» ya no viaja en el archivo.
    expect((hoja.getRow(1).values as unknown[]).slice(1)).not.toContain('Creado');
  });

  it('fechaExcel (pura): día del ISO en UTC; null y basura → null', () => {
    expect(fechaExcel('2026-10-01T04:30:00.000Z')?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    // Mutante «getDate() local»: bajo -05 daría el 30 de septiembre.
    expect(fechaExcel('2026-10-01T04:30:00.000Z')?.getUTCDate()).toBe(1);
    expect(fechaExcel(null)).toBeNull();
    expect(fechaExcel('no es fecha')).toBeNull();
  });

  it('SOAT null → celda vacía (no 0, no «»); sin aprobar → fecha_aprobacion, Filtromes y Mes/Trimestre vacíos', async () => {
    kdb.when.select('flito_tramites', [cruda({ soat: null, soatAutogestionable: true, fechaAprobacion: null })]);
    const hoja = await libro((await exportar(RUTA_DETALLE, await sesion())).body as Buffer);
    // Mutante «?? 0»: sería Number 0. Mutante «?? ''»: sería String.
    expect(celda(hoja, 'SOAT').type).toBe(ExcelJS.ValueType.Null);
    expect(celda(hoja, 'SOAT').value).toBeNull();
    expect(celda(hoja, 'fecha_aprobacion').type).toBe(ExcelJS.ValueType.Null);
    expect(celda(hoja, 'Filtromes').type).toBe(ExcelJS.ValueType.Null);
    expect(celda(hoja, 'Mes/Trimestre').type).toBe(ExcelJS.ValueType.Null);
  });

  it('filasExcelDetalle (pura) no convierte null en cadena en ninguna clave', () => {
    const f = filasExcelDetalle([{
      tramiteId: 't', idFlit: 'F', placa: null, estado: null, empresa: null, vin: null, marca: null, linea: null,
      tipoTramite: null, fechaAprobacion: null, fechaCreacion: null, soat: null, impuesto: null, derechoTramite: null,
      logistica: null, tramiteDigital: null, gmf: null, total: null, sellada: false, estadoLiquidacion: null,
      noConfigurados: [], sinRecibo: [], pendientesPago: [], autogestionados: [], noAplican: [],
      estadoFacturacion: 'no_enviado', facturaNumero: null, facturaRequiereRevision: false,
      soatConciliado: false, boletaReferencia: null, soatConciliadoEn: null,
      titularNombres: null, titularApellidos: null, titularRazonSocial: null, titularTipoDocumento: null,
      titularDocumento: null, titularCorreo: null, titularTelefono: null, titularDireccion: null,
      organismoCodigo: null, organismoNombre: null, mes: null, trimestre: null, totalReintegro: null, totalServicio: null,
      serviciosAdicionales: null, serviciosAdicionalesCantidad: null, logisticaViajesCantidad: null,
    }])[0]!;
    const noNulos = Object.entries(f).filter(([, v]) => v !== null).map(([k]) => k).sort();
    // Solo lo que de verdad tiene valor: el id. Mutante «columna2: ''» o «facturaTerceros: ''»: aparecerían aquí.
    expect(noNulos).toEqual(['flit']);
    expect(f.columna2).toBeNull();
    expect(f.facturaTerceros).toBeNull();
    expect(Object.keys(f)).toHaveLength(32);
  });
});

// ───────────────────────────── AC6 — la hoja ─────────────────────────────

describe('AC6 — cabecera negrita con relleno, autofiltro y primera fila fija', () => {
  it('fila 1 bold con relleno, autoFilter sobre la fila 1 y views[0].ySplit === 1', async () => {
    kdb.when.select('flito_tramites', [cruda()]);
    const hoja = await libro((await exportar(RUTA_DETALLE, await sesion())).body as Buffer);
    expect(hoja.getRow(1).getCell(1).font?.bold).toBe(true);
    expect((hoja.getRow(1).getCell(1).fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FF1F2937');
    // Mutante «sin opciones»: `autoFilter` undefined y `views` sin frozen.
    const af = hoja.autoFilter as unknown;
    const ref = typeof af === 'string' ? af : JSON.stringify(af);
    // 32 columnas: A..Z son 26 y la 32.ª es AF. Mutante «una columna menos»: AE1.
    expect(ref).toMatch(/A1:AF1|"row":1,"column":32/);
    expect(hoja.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
  });
});

// ───────────────────────────── AC7 — el tope ─────────────────────────────

describe('AC7 — más de TOPE_EXPORTACION filas → 422 sin archivo; TOPE exactas → archivo completo', () => {
  const muchas = (n: number) => Array.from({ length: n }, (_, i) => cruda({ tramiteId: `t${i}` }));

  it('TOPE+1 → 422 con codigo estable y mensaje que pide acotar; se pidió limit(TOPE+1) y no hay xlsx', async () => {
    kdb.when.select('flito_tramites', muchas(TOPE_EXPORTACION + 1));
    const r = await exportar(RUTA_DETALLE, await sesion(), { estados: ['Aprobado'] });
    expect(r.status).toBe(422);
    expect(r.headers['content-type']).toContain('application/json');
    const body = JSON.parse((r.body as Buffer).toString('utf8'));
    expect(body.codigo).toBe('export_demasiado_grande');
    expect(body.error).toContain('Acota');
    expect(body.error).toContain('20.000');
    // Mutante «limit(TOPE)» con recorte en silencio: el espía vería 20000.
    expect(limites).toEqual([TOPE_EXPORTACION + 1]);
    expect(orden).not.toContain('excel');
    // Un 422 tampoco escribe «export» en el registro PII: no se entregó nada.
    expect(logPiiMock.mock.calls.filter(([, o]) => (o as { accion: string }).accion === 'export')).toHaveLength(0);
  });

  it('el servicio con exactamente TOPE filas devuelve las TOPE (no lanza); con TOPE+1 lanza antes de resolverlas', async () => {
    kdb.when.select('flito_tramites', muchas(TOPE_EXPORTACION));
    const filas = await filasParaExportar({});
    expect(filas).toHaveLength(TOPE_EXPORTACION);
    expect(TOPE_EXPORTACION).toBe(20_000);

    kdb.when.select('flito_tramites', muchas(TOPE_EXPORTACION + 1));
    // Mutante «>=»: lanzaría con TOPE exactas (arriba). Mutante «sin throw»: devolvería 20001.
    await expect(filasParaExportar({})).rejects.toBeInstanceOf(ExportColaDemasiadoGrandeError);
  });
});

// ───────────────────────────── AC8 — sesión, roles, limitador, validación ─────────────────────────────

describe('AC8 — sesión, roles, limitador y cuerpo estricto', () => {
  it('sin Authorization → 401; cliente → 403; auditor → 200', async () => {
    kdb.when.select('flito_tramites', [cruda()]);
    expect((await request(await buildApp()).post(RUTA_DETALLE).send({})).status).toBe(401);
    expect((await exportar(RUTA_DETALLE, await sesion('cliente'))).status).toBe(403);
    expect((await exportar(RUTA_DETALLE, await sesion('proveedor'))).status).toBe(403);
    expect((await exportar(RUTA_DETALLE, await sesion('auditor'))).status).toBe(200);
    expect((await exportar(RUTA_CONSOLIDADO, await sesion('cliente'))).status).toBe(403);
  });

  it('la 6.ª petición del mismo usuario en un minuto → 429 (bolsa compartida con SOAT/Impuestos)', async () => {
    kdb.when.select('flito_tramites', [cruda()]);
    const cab = await sesion();
    for (let i = 0; i < 5; i++) expect((await exportar(RUTA_DETALLE, cab)).status, `intento ${i + 1}`).toBe(200);
    // Mutante «sin exportColaLimiter»: la sexta sería 200.
    const sexta = await exportar(RUTA_CONSOLIDADO, cab);
    expect(sexta.status).toBe(429);
  });

  it('campo desconocido en el cuerpo → 400 y no se consulta; una etapa fuera del catálogo también', async () => {
    kdb.when.select('flito_tramites', [cruda()]);
    // Mutante «sin .strict()»: `organismo` en singular se ignoraría y saldría el reporte entero.
    const r = await exportar(RUTA_DETALLE, await sesion(), { organismo: '05001' });
    expect(r.status).toBe(400);
    expect(kdb.select).not.toHaveBeenCalled();
    expect((await exportar(RUTA_DETALLE, await sesion(), { etapa: 'inventada' })).status).toBe(400);
    expect((await exportar(RUTA_DETALLE, await sesion(), { desde: '01/09/2026' })).status).toBe(400);
    expect((await exportar(RUTA_CONSOLIDADO, await sesion(), { periodo: 'semana' })).status).toBe(400);
  });

  it('los GET antiguos ya no existen (404)', async () => {
    const app = await buildApp();
    const cab = await sesion();
    expect((await request(app).get(RUTA_DETALLE).set('Authorization', cab)).status).toBe(404);
    expect((await request(app).get(`${RUTA_CONSOLIDADO}?periodo=mes`).set('Authorization', cab)).status).toBe(404);
  });

  it('el filtro del cuerpo llega al servicio: listas, fechas y etapa (no se pierde ninguno)', async () => {
    kdb.when.select('flito_tramites', [cruda()]);
    const cuerpo = {
      buscar: 'abc', estados: ['Aprobado'], empresas: ['811011779'], tipos: ['Traspaso'], organismos: ['05266', '05001'],
      etapa: 'incompleto', documentacionCompleta: true, desde: '2026-01-01', hasta: '2026-12-31',
      aprobadoDesde: '2026-09-01', aprobadoHasta: '2026-09-30', estadoFacturacion: 'rechazado',
    };
    expect((await exportar(RUTA_DETALLE, await sesion(), cuerpo)).status).toBe(200);
    // Mutante «filtrosDeCuerpo olvida un campo»: faltaría en lo que recibió el servicio.
    expect(filasParaExportarMock.mock.calls.at(-1)![0]).toMatchObject(cuerpo);
    // Sin paginación: el archivo es todo el filtro.
    expect(filasParaExportarMock.mock.calls.at(-1)![0]).not.toHaveProperty('page');
    // Una lista vacía no filtra (como `lista()` en la query).
    expect((await exportar(RUTA_DETALLE, await sesion(), { estados: [] })).status).toBe(200);
    expect(filasParaExportarMock.mock.calls.at(-1)![0]!.estados).toBeUndefined();
  });
});

// ───────────────────────────── AC9 — PII ─────────────────────────────

describe('AC9 — el rastro PII se escribe antes del primer byte, con los diez campos y el número de filas', () => {
  it('accion export, recurso finanzas_reporte_costos, campos del titular + contacto, motivo con filas=N, ANTES del archivo', async () => {
    kdb.when.select('flito_tramites', [cruda(), cruda({ tramiteId: 't2' })]);
    expect((await exportar(RUTA_DETALLE, await sesion())).status).toBe(200);
    expect(logPiiMock).toHaveBeenCalledTimes(1);
    const [, opts] = logPiiMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(opts).toMatchObject({ resourceTipo: 'finanzas_reporte_costos', accion: 'export', resourceId: null });
    // Mutante «lista sin correo/celular/direccion»: el registro mentiría por omisión.
    expect([...(opts.camposAccedidos as string[])].sort()).toEqual([
      'apellidos', 'celular', 'correo', 'direccion', 'nombres', 'numero_documento', 'placa', 'razon_social',
      'tipo_documento', 'vin',
    ]);
    expect(opts.motivo).toBe('Reporte de costos — filas=2');
    // Ningún nombre, documento ni correo en el registro.
    expect(JSON.stringify(opts)).not.toMatch(/JUAN|1020304050|juan@correo/);
    // Mutante «registrar después de sendExcel»: el orden sería ['excel', 'pii'].
    expect(orden).toEqual(['pii', 'excel']);
  });

  it('el consolidado no registra PII: no lleva titular ni placa', async () => {
    kdb.when.select('flito_tramites', [grupo()]).select('clients', MAESTRO);
    expect((await exportar(RUTA_CONSOLIDADO, await sesion())).status).toBe(200);
    expect(logPiiMock).not.toHaveBeenCalled();
  });
});

// ───────────────────────────── AC2 — el consolidado ─────────────────────────────

describe('AC2 — POST /reporte-costos/consolidado/export', () => {
  it('periodo mes → consolidado-costos_….xlsx, hoja «Consolidado», 13 cabeceras, una fila por cliente × mes, «Sin aprobar»', async () => {
    kdb.when.select('flito_tramites', [
      grupo(), grupo({ periodo: '2026-10', tramites: 1 }),
      grupo({ companiaId: 9, companiaNit: '900555111', periodo: null, tramites: 3 }),
    ]).select('clients', MAESTRO);
    const r = await exportar(RUTA_CONSOLIDADO, await sesion(), { periodo: 'mes' });
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toMatch(/^attachment; filename="consolidado-costos_\d{8}-\d{4}\.xlsx"$/);
    expect(r.headers['cache-control']).toBe('no-store');
    const hoja = await libro(r.body as Buffer);
    expect(hoja.name).toBe('Consolidado');
    expect((hoja.getRow(1).values as unknown[]).slice(1)).toEqual(CABECERAS_CONSOLIDADO);
    expect(COLUMNAS_EXPORT_CONSOLIDADO.map((c) => c.header)).toEqual(CABECERAS_CONSOLIDADO);
    expect(hoja.rowCount).toBe(4);
    expect([2, 3, 4].map((n) => [celda(hoja, 'Cliente', n).value, celda(hoja, 'Periodo', n).value])).toEqual([
      ['ACME', '2026-09'], ['ACME', '2026-10'], ['BETA', 'Sin aprobar'],
    ]);
    // Trámites e Incompletos enteros con numFmt '0'; el dinero con el contable.
    expect(celda(hoja, 'Trámites').type).toBe(ExcelJS.ValueType.Number);
    expect(celda(hoja, 'Trámites').value).toBe(2);
    expect(celda(hoja, 'Trámites').numFmt).toBe('0');
    expect(celda(hoja, 'Incompletos').value).toBe(1);
    expect(celda(hoja, 'Incompletos').numFmt).toBe('0');
    for (const cab of DINERO) {
      expect(celda(hoja, cab).type, cab).toBe(ExcelJS.ValueType.Number);
      expect(celda(hoja, cab).numFmt, cab).toBe(NUMFMT_DINERO);
    }
    expect(celda(hoja, 'Trámite').value).toBe(160000);
    expect(celda(hoja, 'Total').value).toBe(1736920);
    expect(hoja.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
  });

  it('periodo trimestre llega al servicio y el Periodo sale como AAAA-Tn', async () => {
    kdb.when.select('flito_tramites', [grupo({ periodo: '2026-T3' })]).select('clients', MAESTRO);
    const r = await exportar(RUTA_CONSOLIDADO, await sesion(), { periodo: 'trimestre', empresas: ['811011779'] });
    expect(r.status).toBe(200);
    // Mutante «periodo perdido»: el servicio recibiría 'mes'.
    expect(consolidadoMock.mock.calls.at(-1)![1]).toBe('trimestre');
    expect(consolidadoMock.mock.calls.at(-1)![0]).toMatchObject({ empresas: ['811011779'] });
    const hoja = await libro(r.body as Buffer);
    expect(celda(hoja, 'Periodo').value).toBe('2026-T3');
  });
});
