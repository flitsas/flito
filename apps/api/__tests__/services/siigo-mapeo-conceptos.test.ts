// Siigo — mapeo de conceptos a productos (HU #11282). Un bloque por criterio de aceptación.
//
// Tres de los ocho AC no se prueban con drizzle mockeado sino leyendo artefactos reales, porque la
// promesa que hacen vive fuera del servicio:
//   · AC1 se cumple en la SEMILLA de la migración 0128 → se lee el SQL.
//   · AC3 se cumple por AUSENCIA de condiciones por concepto → se lee el fuente del servicio.
//   · AC7 se cumple por AUSENCIA de columnas de retención → se lee el esquema y la migración.
// Probarlos contra un mock los dejaría verdes aunque el artefacto real no dijera nada.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns } from 'drizzle-orm';
import { createKeyedDb } from '../helpers/keyed-db.js';
import {
  CONCEPTOS_FACTURABLES, CONCEPTO_FACTURABLE_COLUMNA_LIQUIDACION,
} from '@operaciones/shared-types';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

// La HU #11283 añadió validación contra Siigo en TODA escritura. Aquí se neutraliza a propósito:
// este spec prueba las reglas del mapeo —precedencia, confirmación frágil, guardas—, y dejar que
// cada caso saliera a validar convertiría fallos de validación en fallos de esas reglas, que es
// justo la clase de test que no dice dónde está el problema. La validación tiene spec propio en
// siigo-mapeo-validacion.test.ts.
vi.mock('../../src/modules/siigo/siigo.productos.service.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.productos.service.js')>();
  return {
    ...real,
    validarMapeoContraSiigo: vi.fn(async () => ({
      valido: true,
      motivo: null,
      mensaje: 'Verificado contra Siigo: producto simulado.',
      nombreProductoSiigo: 'producto simulado',
      verificadoEn: new Date('2026-08-06T12:00:00Z').toISOString(),
    })),
    consultarProductoPorCodigo: vi.fn(async () => ({
      existe: true, activo: true, nombre: 'producto simulado',
    })),
  };
});

const TABLA = 'siigo_mapeo_conceptos';
const ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const USUARIO = 77;

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRACION = readFileSync(resolve(RAIZ, 'src/db/migrations/0128_siigo_mapeo_conceptos.sql'), 'utf8');
const SERVICIO_SRC = readFileSync(resolve(RAIZ, 'src/modules/siigo/mapeo-conceptos.service.ts'), 'utf8');

/** Fila del mapeo tal como la devuelve drizzle. Los tests solo sobreescriben lo que les importa. */
function fila(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    ambiente: 'pruebas',
    concepto: CONCEPTOS_FACTURABLES[0],
    tipoTramite: null,
    codigoProducto: null,
    nombreProducto: null,
    clasificacionTributaria: null,
    impuestos: [],
    unidadMedida: null,
    ingresoParaTerceros: false,
    facturaLineaPropia: true,
    lineaPropiaPendiente: false,
    confirmadoContabilidad: false,
    confirmadoPorId: null,
    confirmadoEn: null,
    confirmacionRevertidaEn: null,
    confirmacionRevertidaPor: null,
    activo: true,
    notas: null,
    createdAt: new Date('2026-08-05T10:00:00Z'),
    createdBy: null,
    updatedAt: new Date('2026-08-05T10:00:00Z'),
    updatedBy: null,
    ...over,
  };
}

/** Captura el objeto que llega a `.set()` del UPDATE, que es donde vive la regla del AC4. */
function capturarSet(filaDevuelta: Record<string, unknown>) {
  const capturado: { set?: Record<string, unknown> } = {};
  kdb.update.mockImplementation(() => {
    const chain: Record<string, unknown> = {};
    const run = () => Promise.resolve([{ ...filaDevuelta, ...(capturado.set ?? {}) }]);
    chain.set = (v: Record<string, unknown>) => { capturado.set = v; return chain; };
    chain.where = () => chain;
    chain.returning = () => chain;
    chain.then = (r: (v: unknown) => unknown, j?: (e: unknown) => unknown) => run().then(r, j);
    chain.catch = (j: (e: unknown) => unknown) => run().catch(j);
    chain.finally = (cb: () => void) => run().finally(cb);
    return chain;
  });
  return capturado;
}

/**
 * Réplica de lo que lanza drizzle-orm 0.45.2 ante una violación de unicidad: `PgSession` envuelve
 * TODO error del driver en un `DrizzleQueryError` cuyo `message` es `Failed query: <sql>\nparams:
 * <valores>`, y deja el código de Postgres en `cause`. Los dos rasgos importan: el código anidado
 * (si se mira `e.code` a secas, la traducción es código muerto) y el SQL con parámetros en el
 * mensaje (si el error escapa del módulo, acaba en el log del errorHandler).
 */
function errorDeUnicoDeDrizzle(): Error {
  const causa = Object.assign(
    new Error('duplicate key value violates unique constraint "idx_siigo_mapeo_unico_activo"'),
    { code: '23505' },
  );
  return Object.assign(
    new Error('Failed query: insert into "siigo_mapeo_conceptos" ("ambiente", "concepto") '
      + 'values ($1, $2)\nparams: pruebas,soat'),
    { cause: causa },
  );
}

/** Captura el objeto que llega a `.values()` del INSERT. */
function capturarValues(filaDevuelta: Record<string, unknown>) {
  const capturado: { values?: Record<string, unknown> } = {};
  kdb.insert.mockImplementation(() => {
    const chain: Record<string, unknown> = {};
    const run = () => Promise.resolve([{ ...filaDevuelta, ...(capturado.values ?? {}) }]);
    chain.values = (v: Record<string, unknown>) => { capturado.values = v; return chain; };
    chain.returning = () => chain;
    chain.then = (r: (v: unknown) => unknown, j?: (e: unknown) => unknown) => run().then(r, j);
    chain.catch = (j: (e: unknown) => unknown) => run().catch(j);
    chain.finally = (cb: () => void) => run().finally(cb);
    return chain;
  });
  return capturado;
}

beforeEach(() => { kdb.reset(); });

// ───────────────────────────────────────────────────────────────────────────────
describe('AC1 — los seis conceptos existen desde el primer día', () => {
  it('la semilla de la migración 0128 siembra exactamente los seis conceptos facturables', () => {
    const sembrados = [...MIGRACION.matchAll(/^\s*\('([a-z_]+)',\s+(?:true|false),/gm)].map((m) => m[1]);
    expect(new Set(sembrados)).toEqual(new Set(CONCEPTOS_FACTURABLES));
    expect(sembrados).toHaveLength(CONCEPTOS_FACTURABLES.length);
  });

  it('los conceptos corresponden uno a uno con las columnas de valor de la liquidación sellada', async () => {
    const { flitoLiquidaciones } = await import('../../src/db/schema.js');
    const columnas = Object.keys(getTableColumns(flitoLiquidaciones));

    for (const concepto of CONCEPTOS_FACTURABLES) {
      const columna = CONCEPTO_FACTURABLE_COLUMNA_LIQUIDACION[concepto];
      expect(columnas, `${concepto} apunta a una columna que no existe`).toContain(columna);
    }
    // Uno a uno de verdad: dos conceptos no pueden compartir columna.
    const usadas = CONCEPTOS_FACTURABLES.map((c) => CONCEPTO_FACTURABLE_COLUMNA_LIQUIDACION[c]);
    expect(new Set(usadas).size).toBe(usadas.length);
  });

  it('la semilla no escribe código de producto ni confirmación de contabilidad', () => {
    const insert = MIGRACION.slice(MIGRACION.indexOf('INSERT INTO siigo_mapeo_conceptos'));
    expect(insert).not.toMatch(/codigo_producto/);
    expect(insert).not.toMatch(/confirmado_contabilidad/);
    expect(insert).not.toMatch(/clasificacion_tributaria/);
    // Y las columnas nacen en el estado correcto por DEFAULT, no por omisión afortunada.
    expect(MIGRACION).toMatch(/confirmado_contabilidad\s+boolean NOT NULL DEFAULT false/);
    expect(MIGRACION).toMatch(/codigo_producto\s+varchar\(30\),/);
  });

  it('siembra los dos ambientes: un ambiente recién migrado no depende de que alguien copie filas', () => {
    const insert = MIGRACION.slice(MIGRACION.indexOf('INSERT INTO siigo_mapeo_conceptos'));
    expect(insert).toContain("('pruebas'), ('produccion')");
  });

  it('la genérica de un concepto no se puede eliminar: el AC1 promete que siempre está', async () => {
    kdb.when.select(TABLA, [fila({ tipoTramite: null })]);
    const { desactivarMapeoEspecifico, SiigoMapeoError } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');

    await expect(desactivarMapeoEspecifico(ID, USUARIO)).rejects.toBeInstanceOf(SiigoMapeoError);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('AC2 — cada concepto declara su tratamiento tributario', () => {
  it('guarda producto, clasificación, impuestos, unidad e ingreso para terceros como datos', async () => {
    const actual = fila();
    kdb.when.select(TABLA, [actual]);
    const cap = capturarSet(actual);

    const { actualizarMapeo } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');
    const r = await actualizarMapeo(ID, {
      codigoProducto: 'SOAT-001',
      nombreProducto: 'Póliza SOAT',
      clasificacionTributaria: 'excluido',
      impuestos: [{ id: 13156, nombre: 'IVA 19%', porcentaje: 19 }],
      unidadMedida: '94',
      ingresoParaTerceros: true,
    }, USUARIO);

    expect(cap.set).toMatchObject({
      codigoProducto: 'SOAT-001',
      clasificacionTributaria: 'excluido',
      unidadMedida: '94',
      ingresoParaTerceros: true,
      updatedBy: USUARIO,
    });
    expect(cap.set?.impuestos).toEqual([{ id: 13156, nombre: 'IVA 19%', porcentaje: 19 }]);
    expect(r.mapeo.codigoProducto).toBe('SOAT-001');
  });

  it('la clasificación tributaria nace SIN DECLARAR, que no es lo mismo que «excluido»', async () => {
    kdb.when.select(TABLA, [fila()]);
    const { obtenerMapeo } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');
    const m = await obtenerMapeo(ID);

    expect(m.clasificacionTributaria).toBeNull();
    expect(m.listoParaFacturar).toBe(false);
  });

  it('rechaza un código de producto con espacios: Siigo no lo admite y no vale gastar la llamada', async () => {
    kdb.when.select(TABLA, [fila()]);
    const { actualizarMapeo, SiigoMapeoError } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');

    await expect(actualizarMapeo(ID, { codigoProducto: 'SOAT 001' }, USUARIO))
      .rejects.toBeInstanceOf(SiigoMapeoError);
  });

  it('rechaza un impuesto sin id numérico de Siigo', async () => {
    kdb.when.select(TABLA, [fila()]);
    const { actualizarMapeo, SiigoMapeoError } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');

    await expect(actualizarMapeo(ID, { impuestos: [{ id: 0 }] }, USUARIO))
      .rejects.toBeInstanceOf(SiigoMapeoError);
  });

  it('un jsonb de impuestos corrupto no revienta la lectura: se descartan las entradas sin id', async () => {
    kdb.when.select(TABLA, [fila({ impuestos: [{ id: 5 }, { nombre: 'sin id' }, 'basura', null] })]);
    const { obtenerMapeo } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');

    expect((await obtenerMapeo(ID)).impuestos).toEqual([{ id: 5, nombre: null, porcentaje: null }]);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('AC3 — el tratamiento tributario no vive en el código', () => {
  it('el servicio no contiene ninguna condición escrita sobre un concepto concreto', () => {
    // Se busca el nombre de cada concepto en TODO el fuente, comentarios incluidos. Es
    // deliberadamente estricto: en cuanto uno aparezca, aunque sea en un comentario, alguien está a
    // un paso de escribir el `if`.
    for (const concepto of CONCEPTOS_FACTURABLES) {
      expect(SERVICIO_SRC, `el servicio nombra «${concepto}»`).not.toContain(concepto);
    }
  });

  it('cambiar la clasificación tributaria se refleja en la siguiente lectura, sin desplegar nada', async () => {
    const { resolverMapeo } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');

    kdb.when.selectOnce(TABLA, [fila({ clasificacionTributaria: 'gravado' })]);
    expect((await resolverMapeo('pruebas', CONCEPTOS_FACTURABLES[0], null))?.mapeo.clasificacionTributaria)
      .toBe('gravado');

    // Mismo código, otra fila en la base: el valor nuevo sale sin tocar el programa.
    kdb.when.selectOnce(TABLA, [fila({ clasificacionTributaria: 'exento' })]);
    expect((await resolverMapeo('pruebas', CONCEPTOS_FACTURABLES[0], null))?.mapeo.clasificacionTributaria)
      .toBe('exento');
  });

  it('un concepto sin configurar devuelve null, no un objeto con valores por defecto', async () => {
    kdb.when.select(TABLA, []);
    const { resolverMapeo } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');
    expect(await resolverMapeo('pruebas', CONCEPTOS_FACTURABLES[0], null)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('AC4 — la confirmación queda trazada y es frágil a propósito', () => {
  const CONFIRMADA = () => fila({
    codigoProducto: 'P-1',
    clasificacionTributaria: 'gravado',
    confirmadoContabilidad: true,
    confirmadoPorId: 5,
    confirmadoEn: new Date('2026-08-01T09:00:00Z'),
    impuestos: [{ id: 13156 }],
  });

  it.each([
    ['clasificación tributaria', { clasificacionTributaria: 'exento' as const }, 'clasificación tributaria'],
    ['impuestos', { impuestos: [{ id: 99 }] }, 'impuestos aplicables'],
    ['ingreso para terceros', { ingresoParaTerceros: true }, 'ingreso recibido para terceros'],
    ['código de producto', { codigoProducto: 'P-2' }, 'código de producto en Siigo'],
  ])('cambiar %s tumba la confirmación', async (_n, cambio, etiqueta) => {
    const actual = CONFIRMADA();
    kdb.when.select(TABLA, [actual]);
    const cap = capturarSet(actual);

    const { actualizarMapeo } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');
    const r = await actualizarMapeo(ID, cambio, USUARIO);

    expect(cap.set?.confirmadoContabilidad).toBe(false);
    expect(cap.set?.confirmacionRevertidaEn).toBeInstanceOf(Date);
    expect(cap.set?.confirmacionRevertidaPor).toContain(etiqueta);
    expect(r.confirmacionRevertidaPor.length).toBe(1);
  });

  it('al revertir NO se borra quién confirmó ni cuándo: es justo lo que se preguntará después', async () => {
    const actual = CONFIRMADA();
    kdb.when.select(TABLA, [actual]);
    const cap = capturarSet(actual);

    const { actualizarMapeo } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');
    const r = await actualizarMapeo(ID, { codigoProducto: 'P-9' }, USUARIO);

    expect(cap.set).not.toHaveProperty('confirmadoPorId');
    expect(cap.set).not.toHaveProperty('confirmadoEn');
    expect(r.mapeo.confirmadoPorId).toBe(5);
    expect(r.mapeo.confirmadoEn).toBe('2026-08-01T09:00:00.000Z');
  });

  it('el motivo guarda NOMBRES de campo, nunca los valores viejos ni los nuevos', async () => {
    const actual = CONFIRMADA();
    kdb.when.select(TABLA, [actual]);
    const cap = capturarSet(actual);

    const { actualizarMapeo } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');
    await actualizarMapeo(ID, { codigoProducto: 'SECRETO-42' }, USUARIO);

    expect(String(cap.set?.confirmacionRevertidaPor)).not.toContain('SECRETO-42');
    expect(String(cap.set?.confirmacionRevertidaPor)).not.toContain('P-1');
  });

  it('reenviar los MISMOS valores no tumba la confirmación', async () => {
    const actual = CONFIRMADA();
    kdb.when.select(TABLA, [actual]);
    const cap = capturarSet(actual);

    const { actualizarMapeo } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');
    const r = await actualizarMapeo(ID, {
      codigoProducto: 'P-1',
      clasificacionTributaria: 'gravado',
      ingresoParaTerceros: false,
      // Mismo conjunto de impuestos, distinto orden y con el nombre relleno: sigue siendo lo mismo.
      impuestos: [{ id: 13156, nombre: 'IVA 19%' }],
    }, USUARIO);

    expect(cap.set?.confirmadoContabilidad).toBeUndefined();
    expect(r.confirmacionRevertidaPor).toEqual([]);
  });

  it('cambiar solo las notas o el nombre del producto no toca la confirmación', async () => {
    const actual = CONFIRMADA();
    kdb.when.select(TABLA, [actual]);
    const cap = capturarSet(actual);

    const { actualizarMapeo } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');
    await actualizarMapeo(ID, { notas: 'revisado con contabilidad', nombreProducto: 'Otro nombre' }, USUARIO);

    expect(cap.set?.confirmadoContabilidad).toBeUndefined();
  });

  it('quitar un impuesto también cuenta como cambio', async () => {
    const actual = CONFIRMADA();
    kdb.when.select(TABLA, [actual]);
    const cap = capturarSet(actual);

    const { actualizarMapeo } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');
    await actualizarMapeo(ID, { impuestos: [] }, USUARIO);

    expect(cap.set?.confirmadoContabilidad).toBe(false);
  });

  it('sobre una fila NO confirmada no hay nada que revertir', async () => {
    const actual = fila({ codigoProducto: 'P-1' });
    kdb.when.select(TABLA, [actual]);
    const cap = capturarSet(actual);

    const { actualizarMapeo } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');
    const r = await actualizarMapeo(ID, { codigoProducto: 'P-2' }, USUARIO);

    expect(cap.set).not.toHaveProperty('confirmacionRevertidaEn');
    expect(r.confirmacionRevertidaPor).toEqual([]);
  });

  it('confirmar deja quién y cuándo, y limpia la reversión anterior', async () => {
    const actual = fila({
      codigoProducto: 'P-1', clasificacionTributaria: 'gravado',
      confirmacionRevertidaEn: new Date('2026-07-01T00:00:00Z'),
      confirmacionRevertidaPor: 'Cambio en código de producto en Siigo',
    });
    kdb.when.select(TABLA, [actual]);
    const cap = capturarSet(actual);

    const { confirmarMapeo } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');
    const r = await confirmarMapeo(ID, USUARIO);

    expect(cap.set).toMatchObject({ confirmadoContabilidad: true, confirmadoPorId: USUARIO });
    expect(cap.set?.confirmadoEn).toBeInstanceOf(Date);
    expect(cap.set?.confirmacionRevertidaEn).toBeNull();
    expect(r.mapeo.confirmadoContabilidad).toBe(true);
  });

  it('no se confirma un concepto sin código de producto: sería firmar un formulario en blanco', async () => {
    kdb.when.select(TABLA, [fila({ clasificacionTributaria: 'gravado' })]);
    const { confirmarMapeo, SiigoMapeoError } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');
    await expect(confirmarMapeo(ID, USUARIO)).rejects.toBeInstanceOf(SiigoMapeoError);
  });

  it('no se confirma un concepto sin clasificación tributaria declarada', async () => {
    kdb.when.select(TABLA, [fila({ codigoProducto: 'P-1' })]);
    const { confirmarMapeo, SiigoMapeoError } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');
    await expect(confirmarMapeo(ID, USUARIO)).rejects.toBeInstanceOf(SiigoMapeoError);
  });

  it('la base impide confirmar sin dejar rastro (CHECK en la migración)', () => {
    expect(MIGRACION).toMatch(/CONSTRAINT siigo_mapeo_confirmacion_trazada[\s\S]*confirmado_por_id IS NOT NULL AND confirmado_en IS NOT NULL/);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('AC5 — la granularidad admite el tipo de trámite', () => {
  const CONCEPTO = CONCEPTOS_FACTURABLES[3];

  it('sin tipo de trámite, resuelve la genérica', async () => {
    kdb.when.select(TABLA, [fila({ concepto: CONCEPTO, tipoTramite: null, codigoProducto: 'GEN' })]);
    const { resolverMapeo } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');

    const r = await resolverMapeo('pruebas', CONCEPTO, null);
    expect(r?.origen).toBe('generica');
    expect(r?.mapeo.codigoProducto).toBe('GEN');
  });

  it('la fila con tipo de trámite tiene precedencia sobre la genérica', async () => {
    kdb.when.select(TABLA, [
      fila({ concepto: CONCEPTO, tipoTramite: null, codigoProducto: 'GEN' }),
      fila({ id: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb', concepto: CONCEPTO, tipoTramite: 'TRASPASO', codigoProducto: 'ESP' }),
    ]);
    const { resolverMapeo } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');

    const r = await resolverMapeo('pruebas', CONCEPTO, 'traspaso');
    expect(r?.origen).toBe('especifica');
    expect(r?.mapeo.codigoProducto).toBe('ESP');
  });

  it('normaliza el tipo de trámite: «  traspaso » y «TRASPASO» son el mismo', async () => {
    kdb.when.select(TABLA, [fila({ concepto: CONCEPTO, tipoTramite: 'TRASPASO', codigoProducto: 'ESP' })]);
    const { resolverMapeo } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');

    expect((await resolverMapeo('pruebas', CONCEPTO, '  traspaso '))?.origen).toBe('especifica');
  });

  it('si la específica está inactiva, el concepto vuelve a su genérica y no a un valor viejo', async () => {
    // Las inactivas no llegan aquí: el servicio filtra por `activo` en la propia consulta.
    kdb.when.select(TABLA, [fila({ concepto: CONCEPTO, tipoTramite: null, codigoProducto: 'GEN' })]);
    const { resolverMapeo } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');

    const r = await resolverMapeo('pruebas', CONCEPTO, 'traspaso');
    expect(r?.origen).toBe('generica');
  });

  it('la base impide dos filas vivas para la misma pareja concepto + tipo de trámite', () => {
    expect(MIGRACION).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_siigo_mapeo_unico_activo[\s\S]*?COALESCE\(tipo_tramite, ''\)[\s\S]*?WHERE activo/);
  });

  it('el duplicado de la base se traduce a un mensaje que dice qué hacer, no al error de Postgres', async () => {
    kdb.insert.mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      // Como lo produce drizzle-orm 0.45.2 de verdad: el error del driver NO llega crudo, viene
      // envuelto en un DrizzleQueryError con el código de Postgres en `cause`. Simularlo con un
      // error plano y `code` en la raíz dejaba el test verde mientras la ruta real devolvía 500.
      const run = () => Promise.reject(errorDeUnicoDeDrizzle());
      for (const m of ['values', 'returning']) chain[m] = () => chain;
      chain.then = (r: (v: unknown) => unknown, j?: (e: unknown) => unknown) => run().then(r, j);
      chain.catch = (j: (e: unknown) => unknown) => run().catch(j);
      chain.finally = (cb: () => void) => run().finally(cb);
      return chain;
    });
    const { crearMapeoEspecifico, SiigoMapeoError } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');

    await expect(crearMapeoEspecifico(
      { ambiente: 'pruebas', concepto: CONCEPTO, tipoTramite: 'TRASPASO' }, USUARIO,
    )).rejects.toMatchObject({ name: 'SiigoMapeoError', codigo: 'duplicado' });

    await expect(crearMapeoEspecifico(
      { ambiente: 'pruebas', concepto: CONCEPTO, tipoTramite: 'TRASPASO' }, USUARIO,
    )).rejects.toBeInstanceOf(SiigoMapeoError);
  });

  it('crear una específica sin tipo de trámite se rechaza: la genérica ya existe y se edita', async () => {
    const { crearMapeoEspecifico, SiigoMapeoError } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');
    await expect(crearMapeoEspecifico(
      { ambiente: 'pruebas', concepto: CONCEPTO, tipoTramite: '   ' }, USUARIO,
    )).rejects.toBeInstanceOf(SiigoMapeoError);
  });

  it('una específica nace SIN confirmar aunque copie los datos de una confirmada', async () => {
    let valores: Record<string, unknown> | null = null;
    kdb.insert.mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      const run = () => Promise.resolve([fila({ tipoTramite: 'TRASPASO', ...(valores ?? {}) })]);
      chain.values = (v: Record<string, unknown>) => { valores = v; return chain; };
      chain.returning = () => chain;
      chain.then = (r: (v: unknown) => unknown, j?: (e: unknown) => unknown) => run().then(r, j);
      chain.catch = (j: (e: unknown) => unknown) => run().catch(j);
      chain.finally = (cb: () => void) => run().finally(cb);
      return chain;
    });
    const { crearMapeoEspecifico } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');
    const creado = await crearMapeoEspecifico({
      ambiente: 'pruebas', concepto: CONCEPTO, tipoTramite: 'traspaso',
      codigoProducto: 'P-1', clasificacionTributaria: 'gravado',
    }, USUARIO);

    expect(valores).not.toHaveProperty('confirmadoContabilidad');
    expect(creado.confirmadoContabilidad).toBe(false);
    expect((valores as unknown as Record<string, unknown>).tipoTramite).toBe('TRASPASO');
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('AC6 — GMF como línea propia: sujeto a confirmación de contabilidad', () => {
  it('la semilla deja el indicador apagado y la decisión marcada como pendiente', () => {
    // Una sola fila de la semilla lleva el indicador apagado y el pendiente encendido.
    const conPendiente = [...MIGRACION.matchAll(/^\s*\('([a-z_]+)',\s+(true|false),\s+(true|false),/gm)]
      .map((m) => ({ concepto: m[1], lineaPropia: m[2] === 'true', pendiente: m[3] === 'true' }));

    const abiertos = conPendiente.filter((c) => c.pendiente);
    expect(abiertos).toHaveLength(1);
    expect(abiertos[0].lineaPropia).toBe(false);
    // El resto queda decidido y sin pendiente.
    expect(conPendiente.filter((c) => !c.pendiente).every((c) => c.lineaPropia)).toBe(true);
  });

  it('cambiar la decisión es editar configuración, no desplegar: hay endpoint y campo para ello', async () => {
    const actual = fila({ facturaLineaPropia: false, lineaPropiaPendiente: true });
    kdb.when.select(TABLA, [actual]);
    const cap = capturarSet(actual);

    const { actualizarMapeo } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');
    const r = await actualizarMapeo(ID, { facturaLineaPropia: true, lineaPropiaPendiente: false }, USUARIO);

    expect(cap.set).toMatchObject({ facturaLineaPropia: true, lineaPropiaPendiente: false });
    expect(r.mapeo.facturaLineaPropia).toBe(true);
  });

  it('con la decisión abierta la fila NO se da por lista, aunque tenga producto y confirmación', async () => {
    kdb.when.select(TABLA, [fila({
      codigoProducto: 'GMF-1', clasificacionTributaria: 'excluido',
      confirmadoContabilidad: true, confirmadoPorId: 5, confirmadoEn: new Date(),
      facturaLineaPropia: false, lineaPropiaPendiente: true,
    })]);
    const { obtenerMapeo } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');

    // «Apagado y pendiente» significa SIN DECIDIR, no «se absorbe»: dar la fila por lista sería
    // elegir una de las dos respuestas en silencio.
    expect((await obtenerMapeo(ID)).listoParaFacturar).toBe(false);
  });

  it('el estado del ambiente reporta la decisión abierta en vez de esconderla', async () => {
    const conceptoAbierto = CONCEPTOS_FACTURABLES[5];
    kdb.when.select(TABLA, CONCEPTOS_FACTURABLES.map((c, i) => fila({
      id: `aaaaaaaa-1111-4111-8111-00000000000${i}`,
      concepto: c,
      codigoProducto: 'P', clasificacionTributaria: 'gravado',
      confirmadoContabilidad: true, confirmadoPorId: 5, confirmadoEn: new Date(),
      lineaPropiaPendiente: c === conceptoAbierto,
      facturaLineaPropia: c !== conceptoAbierto,
    })));
    const { estadoMapeo } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');
    const e = await estadoMapeo('pruebas');

    expect(e.conceptosConDecisionPendiente).toEqual([conceptoAbierto]);
    expect(e.conceptosPendientes).toEqual([conceptoAbierto]);
    expect(e.completo).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('AC7 — retenciones: sujeto a confirmación de contabilidad', () => {
  it('esta historia NO modela retenciones: ni columnas ni campos', async () => {
    const { siigoMapeoConceptos } = await import('../../src/db/schema.js');
    const columnas = Object.keys(getTableColumns(siigoMapeoConceptos)).join(' ').toLowerCase();

    expect(columnas).not.toContain('retencion');
    expect(columnas).not.toContain('reteica');
    expect(columnas).not.toContain('reteiva');
    expect(columnas).not.toContain('autorretencion');
    expect(MIGRACION.toLowerCase()).not.toMatch(/^\s*retenciones\s/m);
  });

  it('queda documentado que incorporarlas es añadir columnas, no rehacer el modelo', () => {
    expect(MIGRACION).toMatch(/RETENCIONES \(AC7\)/);
    expect(MIGRACION).toMatch(/AÑADIR COLUMNAS/);
    expect(SERVICIO_SRC).toMatch(/NO modela retenciones \(AC7\)/);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('Decisión de modelo — `ambiente` forma parte de la identidad de la fila', () => {
  it('la unicidad incluye el ambiente: configurar pruebas no puede pisar producción', () => {
    expect(MIGRACION).toMatch(/idx_siigo_mapeo_unico_activo\s*\n\s*ON siigo_mapeo_conceptos \(ambiente, concepto, COALESCE\(tipo_tramite, ''\)\)/);
  });

  it('la decisión está justificada en la cabecera de la migración', () => {
    expect(MIGRACION).toMatch(/Por qué la llave lleva `ambiente`/);
    expect(MIGRACION).toMatch(/#11285/);
  });

  it('resolver el mapeo sin ambiente no es posible: la firma lo exige', async () => {
    const { resolverMapeo } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');
    expect(resolverMapeo.length).toBe(3);
  });

  it('el ambiente es del entorno de la petición, no un valor por defecto del esquema', () => {
    expect(MIGRACION).not.toMatch(/ambiente\s+varchar\(12\) NOT NULL DEFAULT/);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Regresión de los hallazgos de la revisión de QA y seguridad de esta misma HU.
// Cada uno pasaba desapercibido con la batería anterior: van con el porqué, no solo con el assert.
describe('Regresión — hallazgos de la revisión', () => {
  const GENERICA = () => fila({ tipoTramite: null });
  const ESPECIFICA = () => fila({ id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', tipoTramite: 'TRASPASO' });

  it('la genérica no se desactiva con PATCH: el DELETE lo impide y el PATCH no puede ser la puerta de atrás', async () => {
    kdb.when.select(TABLA, [GENERICA()]);
    const cap = capturarSet(GENERICA());

    const { actualizarMapeo, SiigoMapeoError } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');
    await expect(actualizarMapeo(ID, { activo: false }, USUARIO))
      .rejects.toThrow(SiigoMapeoError);
    // Y no llegó a la base: la guarda va antes del UPDATE, no después.
    expect(cap.set).toBeUndefined();
  });

  it('desactivar la genérica rompería la idempotencia de la semilla — por eso el índice único es PARCIAL', () => {
    // El `ON CONFLICT DO NOTHING` de la semilla se apoya en `WHERE activo`. Si una genérica pudiera
    // quedar inactiva, una segunda pasada de la migración insertaría una fila más.
    expect(MIGRACION).toMatch(/idx_siigo_mapeo_unico_activo[\s\S]*?WHERE activo/);
    expect(MIGRACION).toMatch(/ON CONFLICT DO NOTHING/);
  });

  it('desactivar una ESPECÍFICA sí se permite: la guarda es solo para la genérica', async () => {
    kdb.when.select(TABLA, [ESPECIFICA()]);
    const cap = capturarSet(ESPECIFICA());

    const { actualizarMapeo } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');
    await actualizarMapeo(ESPECIFICA().id, { activo: false }, USUARIO);
    expect(cap.set?.activo).toBe(false);
  });

  it('el estado no dice `completo` si la fila que de verdad se usaría está incompleta', async () => {
    const lista = (over: Record<string, unknown>) => fila({
      codigoProducto: 'P-1', clasificacionTributaria: 'gravado', confirmadoContabilidad: true, ...over,
    });
    const genericasListas = CONCEPTOS_FACTURABLES.map((c) => lista({ id: `g-${c}`, concepto: c }));

    const { estadoMapeo } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');

    kdb.when.select(TABLA, genericasListas);
    expect((await estadoMapeo('pruebas')).completo).toBe(true);

    // Un alta específica nace sin producto por diseño; y por AC5 tiene PRECEDENCIA sobre la
    // genérica. Mirar solo las genéricas daría un GO en falso a la compuerta de la HU #11285.
    const concepto = CONCEPTOS_FACTURABLES[0];
    kdb.when.select(TABLA, [...genericasListas, fila({ id: 'e-1', concepto, tipoTramite: 'TRASPASO' })]);

    const estado = await estadoMapeo('pruebas');
    expect(estado.completo).toBe(false);
    expect(estado.conceptosPendientes).toContain(concepto);
  });

  it('el alta específica hereda la decisión de línea propia en vez de inventarla (AC6)', async () => {
    const concepto = CONCEPTOS_FACTURABLES[0];
    // La genérica del GMF vive con la decisión ABIERTA: no facturada como línea propia y pendiente.
    kdb.when.select(TABLA, [fila({ concepto, tipoTramite: null, facturaLineaPropia: false, lineaPropiaPendiente: true })]);
    const cap = capturarValues(fila({ concepto, tipoTramite: 'TRASPASO' }));

    const { crearMapeoEspecifico } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');
    await crearMapeoEspecifico({ ambiente: 'pruebas', concepto, tipoTramite: 'TRASPASO' }, USUARIO);

    expect(cap.values?.facturaLineaPropia).toBe(false);
    expect(cap.values?.lineaPropiaPendiente).toBe(true);
  });

  it('sin genérica de la que heredar, el alta usa el mismo valor que la columna (false), nunca true', async () => {
    const concepto = CONCEPTOS_FACTURABLES[0];
    kdb.when.select(TABLA, []);
    const cap = capturarValues(fila({ concepto, tipoTramite: 'TRASPASO' }));

    const { crearMapeoEspecifico } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');
    await crearMapeoEspecifico({ ambiente: 'pruebas', concepto, tipoTramite: 'TRASPASO' }, USUARIO);

    expect(cap.values?.facturaLineaPropia).toBe(false);
    expect(MIGRACION).toMatch(/factura_linea_propia\s+boolean NOT NULL DEFAULT false/);
  });

  it('el choque con el índice único también se traduce a 409 al EDITAR, no solo al crear', async () => {
    kdb.when.select(TABLA, [ESPECIFICA()]);
    kdb.update.mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      const run = () => Promise.reject(errorDeUnicoDeDrizzle());
      for (const m of ['set', 'where', 'returning']) chain[m] = () => chain;
      chain.then = (r: (v: unknown) => unknown, j?: (e: unknown) => unknown) => run().then(r, j);
      chain.catch = (j: (e: unknown) => unknown) => run().catch(j);
      chain.finally = (cb: () => void) => run().finally(cb);
      return chain;
    });

    const { actualizarMapeo, SiigoMapeoError } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');
    await expect(actualizarMapeo(ESPECIFICA().id, { activo: true }, USUARIO))
      .rejects.toMatchObject({ codigo: 'duplicado' });

    // Y el mensaje que sale del módulo no arrastra el SQL ni los parámetros de la consulta.
    const e = await actualizarMapeo(ESPECIFICA().id, { activo: true }, USUARIO).catch((x) => x);
    expect(e).toBeInstanceOf(SiigoMapeoError);
    expect(e.message).not.toContain('Failed query');
    expect(e.message).not.toContain('params:');
    expect(e.message).not.toContain('insert into');
  });

  it('cambiar el PORCENTAJE de un impuesto tumba la confirmación aunque el id sea el mismo', async () => {
    const actual = fila({
      codigoProducto: 'P-1', clasificacionTributaria: 'gravado', confirmadoContabilidad: true,
      impuestos: [{ id: 13156, nombre: 'IVA 19%', porcentaje: 19 }],
    });
    kdb.when.select(TABLA, [actual]);
    const cap = capturarSet(actual);

    const { actualizarMapeo } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');
    const r = await actualizarMapeo(ID, {
      impuestos: [{ id: 13156, nombre: 'IVA 5%', porcentaje: 5 }],
    }, USUARIO);

    // El porcentaje SE PERSISTE en este mismo update: si no tumbara la confirmación, la pantalla
    // mostraría un «IVA 5% confirmado por contabilidad» que nadie firmó.
    expect(cap.set?.confirmadoContabilidad).toBe(false);
    expect(r.confirmacionRevertidaPor).toEqual(['impuestos']);
  });

  it('rellenar un dato que estaba vacío NO es contradecirlo: completar información no tumba nada', async () => {
    const actual = fila({
      codigoProducto: 'P-1', clasificacionTributaria: 'gravado', confirmadoContabilidad: true,
      impuestos: [{ id: 13156 }],
    });
    kdb.when.select(TABLA, [actual]);
    const cap = capturarSet(actual);

    const { actualizarMapeo } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');
    await actualizarMapeo(ID, { impuestos: [{ id: 13156, nombre: 'IVA 19%', porcentaje: 19 }] }, USUARIO);

    expect(cap.set?.confirmadoContabilidad).toBeUndefined();
  });
});
