// Siigo — configuración global de emisión (HU #11284). Un bloque por criterio de aceptación.
//
// `leerCatalogo` se mockea en vez de sembrar la tabla `siigo_catalogos`: el servicio lee los cuatro
// catálogos en paralelo, y un mock por tabla los serviría todos con las mismas filas o exigiría
// encolar respuestas en un orden que `Promise.all` no garantiza — que es justo el flake que el
// helper keyed existe para evitar. Mockear la frontera deja cada test declarando qué hay en cada
// catálogo, que es lo que el criterio describe.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKeyedDb } from '../helpers/keyed-db.js';
import type { SiigoCatalogoElemento, SiigoTipoCatalogo } from '@operaciones/shared-types';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

/** Contenido de cada catálogo, declarado por test. */
const catalogos: Partial<Record<SiigoTipoCatalogo, SiigoCatalogoElemento[]>> = {};
vi.mock('../../src/modules/siigo/siigo.catalogos.service.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.catalogos.service.js')>();
  return {
    ...real,
    leerCatalogo: vi.fn(async (tipo: SiigoTipoCatalogo) => ({
      tipo,
      etiqueta: tipo,
      ambiente: 'pruebas',
      sincronizadoEn: '2026-08-06T09:00:00Z',
      elementos: catalogos[tipo] ?? [],
    })),
  };
});

const TABLA = 'siigo_config_emision';
const USUARIO = 77;

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRACION = readFileSync(resolve(RAIZ, 'src/db/migrations/0130_siigo_config_emision.sql'), 'utf8');

function elemento(
  codigo: string, nombre: string, activo = true, atributos: Record<string, unknown> | null = null,
): SiigoCatalogoElemento {
  return {
    codigo, nombre, descripcion: null, activo, atributos,
    sincronizadoEn: '2026-08-06T09:00:00Z',
  };
}

/** Catálogos completos y sanos: el punto de partida del caso feliz. */
function catalogosSanos() {
  catalogos.document_type = [
    elemento('1', 'Factura de venta', true, { tipo: 'FV', centroCostoObligatorio: false }),
    elemento('2', 'Factura con centro de costo', true, { tipo: 'FV', centroCostoObligatorio: true }),
    elemento('9', 'Nota crédito', true, { tipo: 'NC', centroCostoObligatorio: false }),
  ];
  catalogos.user = [elemento('35071', 'Ana Ramírez'), elemento('35073', 'Diana Osorio', false)];
  catalogos.payment_type = [elemento('5636', 'Contado', true, { manejaVencimiento: false })];
  catalogos.cost_center = [elemento('25732', 'Principal')];
}

function fila(over: Record<string, unknown> = {}) {
  return {
    id: 'cfg-1',
    ambiente: 'pruebas',
    documentoTipoCodigo: '1',
    vendedorCodigo: '35071',
    formaPagoCodigo: '5636',
    centroCostoCodigo: null,
    plazoVencimientoDias: 0,
    estrategiaNumeracion: 'siigo',
    notas: null,
    vigente: true,
    createdAt: new Date('2026-08-06T10:00:00Z'),
    createdBy: USUARIO,
    updatedAt: new Date('2026-08-06T10:00:00Z'),
    updatedBy: USUARIO,
    ...over,
  };
}

/** INSERT que captura los valores y devuelve la fila creada, como hace `returning()`. */
function capturarInsert(devuelve: Record<string, unknown>) {
  const capturado: { values?: Record<string, unknown> } = {};
  kdb.insert.mockImplementation(() => {
    const chain: Record<string, unknown> = {};
    const run = () => Promise.resolve([{ ...devuelve, ...(capturado.values ?? {}) }]);
    chain.values = (v: Record<string, unknown>) => { capturado.values = v; return chain; };
    chain.returning = () => chain;
    chain.then = (r: (v: unknown) => unknown, j?: (e: unknown) => unknown) => run().then(r, j);
    chain.catch = (j: (e: unknown) => unknown) => run().catch(j);
    chain.finally = (cb: () => void) => run().finally(cb);
    return chain;
  });
  return capturado;
}

beforeEach(() => {
  kdb.reset();
  for (const k of Object.keys(catalogos)) delete catalogos[k as SiigoTipoCatalogo];
  catalogosSanos();
});

// ───────────────────────────────────────────────────────────────────────────────
describe('AC1 — configuración única y validada contra los catálogos', () => {
  it('guarda cuando los cuatro valores están en los catálogos y activos', async () => {
    kdb.when.select(TABLA, []);
    const capturado = capturarInsert(fila());

    const { guardarConfigEmision } = await import('../../src/modules/siigo/config-emision.service.js');
    const c = await guardarConfigEmision(
      { documentoTipoCodigo: '1', vendedorCodigo: '35071', formaPagoCodigo: '5636' },
      USUARIO, 'pruebas',
    );

    expect(capturado.values?.documentoTipoCodigo).toBe('1');
    expect(c.utilizable).toBe(true);
  });

  it('un código que no está en el catálogo se rechaza: estos valores no se escriben a mano', async () => {
    kdb.when.select(TABLA, []);
    const { guardarConfigEmision, SiigoConfigEmisionError } =
      await import('../../src/modules/siigo/config-emision.service.js');

    const e = await guardarConfigEmision({ vendedorCodigo: '99999' }, USUARIO, 'pruebas')
      .catch((x) => x);

    expect(e).toBeInstanceOf(SiigoConfigEmisionError);
    expect(e.campo).toBe('vendedor');
    expect(e.mensaje ?? e.message).toMatch(/no está en el catálogo/i);
  });

  it('un valor INACTIVO en Siigo se rechaza al guardar', async () => {
    kdb.when.select(TABLA, []);
    const { guardarConfigEmision } = await import('../../src/modules/siigo/config-emision.service.js');

    // Diana Osorio existe pero está inactiva: usarla produciría una factura rechazada al emitir.
    const e = await guardarConfigEmision({ vendedorCodigo: '35073' }, USUARIO, 'pruebas')
      .catch((x) => x);

    expect(e.campo).toBe('vendedor');
    expect(e.message).toMatch(/INACTIVO/);
  });

  it('el comprobante tiene que ser de VENTA', async () => {
    kdb.when.select(TABLA, []);
    const { guardarConfigEmision } = await import('../../src/modules/siigo/config-emision.service.js');

    // La nota crédito existe y está activa, pero no sirve para facturar.
    const e = await guardarConfigEmision({ documentoTipoCodigo: '9' }, USUARIO, 'pruebas')
      .catch((x) => x);

    expect(e.campo).toBe('documentoTipo');
    expect(e.message).toMatch(/no es de venta/i);
  });

  it('el centro de costo se exige solo si el comprobante lo exige', async () => {
    kdb.when.select(TABLA, []);
    const { guardarConfigEmision } = await import('../../src/modules/siigo/config-emision.service.js');

    // El comprobante '2' lleva centroCostoObligatorio: true.
    const e = await guardarConfigEmision(
      { documentoTipoCodigo: '2', vendedorCodigo: '35071', formaPagoCodigo: '5636' },
      USUARIO, 'pruebas',
    ).catch((x) => x);

    expect(e.campo).toBe('centroCosto');
    expect(e.message).toMatch(/exige centro de costo/i);
  });

  it('la base garantiza una sola configuración vigente por ambiente, no el código', () => {
    expect(MIGRACION).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_siigo_config_emision_vigente[\s\S]*?WHERE vigente/);
  });

  it('guardar no pisa la anterior: la apaga y crea una nueva', async () => {
    kdb.when.select(TABLA, [fila()]).update(TABLA, []);
    capturarInsert(fila({ id: 'cfg-2' }));

    const capturas: Record<string, unknown>[] = [];
    kdb.update.mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      const run = () => Promise.resolve([]);
      chain.set = (v: Record<string, unknown>) => { capturas.push(v); return chain; };
      for (const m of ['where', 'returning']) chain[m] = () => chain;
      chain.then = (r: (v: unknown) => unknown, j?: (e: unknown) => unknown) => run().then(r, j);
      chain.catch = (j: (e: unknown) => unknown) => run().catch(j);
      chain.finally = (cb: () => void) => run().finally(cb);
      return chain;
    });

    const { guardarConfigEmision } = await import('../../src/modules/siigo/config-emision.service.js');
    await guardarConfigEmision({ plazoVencimientoDias: 30 }, USUARIO, 'pruebas');

    // «¿Con qué vendedor salió la factura de marzo?» solo tiene respuesta si marzo sigue existiendo.
    expect(capturas[0]!.vigente).toBe(false);
    expect(kdb.insert).toHaveBeenCalled();
  });

  it('lo que no viene en el cuerpo se hereda: guardar el plazo no borra el vendedor', async () => {
    kdb.when.select(TABLA, [fila()]).update(TABLA, []);
    const capturado = capturarInsert(fila());

    const { guardarConfigEmision } = await import('../../src/modules/siigo/config-emision.service.js');
    await guardarConfigEmision({ plazoVencimientoDias: 15 }, USUARIO, 'pruebas');

    expect(capturado.values?.vendedorCodigo).toBe('35071');
    expect(capturado.values?.plazoVencimientoDias).toBe(15);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('AC2 — un valor que dejó de existir se señala, y no se corrige solo', () => {
  it('un vendedor que quedó inactivo tras sincronizar marca el campo como inválido', async () => {
    kdb.when.select(TABLA, [fila({ vendedorCodigo: '35073' })]);
    const { obtenerConfigEmision } = await import('../../src/modules/siigo/config-emision.service.js');

    const c = await obtenerConfigEmision('pruebas');

    const vendedor = c!.campos.find((x) => x.campo === 'vendedor')!;
    expect(vendedor.validez).toBe('inactivo');
    expect(vendedor.mensaje).toMatch(/Diana Osorio/);
    expect(c!.utilizable).toBe(false);
    // Y NO se corrige sola: el código guardado sigue siendo el mismo.
    expect(c!.vendedorCodigo).toBe('35073');
  });

  it('un valor que desapareció del catálogo se distingue de uno inactivo', async () => {
    kdb.when.select(TABLA, [fila({ vendedorCodigo: 'BORRADO' })]);
    const { obtenerConfigEmision } = await import('../../src/modules/siigo/config-emision.service.js');

    const vendedor = (await obtenerConfigEmision('pruebas'))!.campos
      .find((x) => x.campo === 'vendedor')!;

    expect(vendedor.validez).toBe('no_existe');
    expect(vendedor.mensaje).toMatch(/ya no existe/i);
  });

  it('el catálogo sin sincronizar NO se confunde con un valor inválido', async () => {
    // Con la copia vacía todo código parecería malo. Mandar a corregir un vendedor que está
    // perfecto llevaría a buscar el problema donde no está.
    catalogos.user = [];
    kdb.when.select(TABLA, [fila()]);
    const { obtenerConfigEmision } = await import('../../src/modules/siigo/config-emision.service.js');

    const vendedor = (await obtenerConfigEmision('pruebas'))!.campos
      .find((x) => x.campo === 'vendedor')!;

    expect(vendedor.validez).toBe('catalogo_sin_sincronizar');
    expect(vendedor.mensaje).toMatch(/sincron/i);
  });

  it('la validez se calcula al LEER, no se guarda', async () => {
    // Misma fila, catálogo distinto: el veredicto cambia sin que nadie haya reescrito nada.
    kdb.when.select(TABLA, [fila()]);
    const { obtenerConfigEmision } = await import('../../src/modules/siigo/config-emision.service.js');

    expect((await obtenerConfigEmision('pruebas'))!.utilizable).toBe(true);

    catalogos.user = [elemento('35071', 'Ana Ramírez', false)];
    expect((await obtenerConfigEmision('pruebas'))!.utilizable).toBe(false);
  });

  it('el centro de costo no exigido aparece como no_aplica, no como incompleto', async () => {
    kdb.when.select(TABLA, [fila({ documentoTipoCodigo: '1', centroCostoCodigo: null })]);
    const { obtenerConfigEmision } = await import('../../src/modules/siigo/config-emision.service.js');

    const centro = (await obtenerConfigEmision('pruebas'))!.campos
      .find((x) => x.campo === 'centroCosto')!;

    expect(centro.validez).toBe('no_aplica');
    // Sin este matiz, una configuración correcta aparecería siempre incompleta.
    expect((await obtenerConfigEmision('pruebas'))!.utilizable).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('AC3, AC4 y AC5 — las decisiones contables abiertas son configuración, no comportamiento', () => {
  it('AC3 — la forma de pago es UNA, no una lista', async () => {
    const { siigoConfigEmision } = await import('../../src/db/schema.js');
    const { getTableColumns } = await import('drizzle-orm');
    const columnas = Object.keys(getTableColumns(siigoConfigEmision));

    expect(columnas).toContain('formaPagoCodigo');
    // Siigo no admite más de una forma de pago por factura; un arreglo aquí sería modelar algo que
    // el API no acepta.
    expect(columnas.filter((c) => /formaPago/i.test(c))).toHaveLength(1);
  });

  it('AC3 — la migración deja escrito por qué es una sola y qué sería otra historia', () => {
    expect(MIGRACION).toMatch(/no admite más de una forma de pago/i);
    expect(MIGRACION).toMatch(/otra historia/i);
  });

  it('AC4 — el plazo es opcional y su valor por defecto es cero', async () => {
    kdb.when.select(TABLA, [fila()]);
    const { obtenerConfigEmision } = await import('../../src/modules/siigo/config-emision.service.js');

    expect((await obtenerConfigEmision('pruebas'))!.plazoVencimientoDias).toBe(0);
    expect(MIGRACION).toMatch(/plazo_vencimiento_dias integer NOT NULL DEFAULT 0/);
  });

  it('AC4 — un plazo negativo o absurdo se rechaza', async () => {
    kdb.when.select(TABLA, []);
    const { guardarConfigEmision } = await import('../../src/modules/siigo/config-emision.service.js');

    for (const dias of [-1, 400, 1.5]) {
      const e = await guardarConfigEmision({ plazoVencimientoDias: dias }, USUARIO, 'pruebas')
        .catch((x) => x);
      expect(e.message).toMatch(/días enteros entre 0 y 365/);
    }
  });

  it('AC4 — el CÁLCULO de la fecha de vencimiento NO está en esta historia', async () => {
    const fuente = readFileSync(
      resolve(RAIZ, 'src/modules/siigo/config-emision.service.ts'), 'utf8',
    );
    // Aquí solo se declara el plazo. Si aparece aritmética de fechas, el alcance se coló.
    expect(fuente).not.toMatch(/setDate|addDays|fechaVencimiento/);
  });

  it('AC5 — la estrategia de numeración es configurable y hoy admite un solo valor', async () => {
    const { ESTRATEGIAS_NUMERACION } = await import('@operaciones/shared-types');

    expect([...ESTRATEGIAS_NUMERACION]).toEqual(['siigo']);
    // El CHECK de un solo elemento obliga a que ampliarlo sea una migración, es decir, una decisión.
    expect(MIGRACION).toMatch(/CHECK \(estrategia_numeracion IN \('siigo'\)\)/);
  });

  it('AC5 — enviar el número desde FLITO se rechaza explícitamente', async () => {
    kdb.when.select(TABLA, []);
    const { guardarConfigEmision } = await import('../../src/modules/siigo/config-emision.service.js');

    const e = await guardarConfigEmision(
      { estrategiaNumeracion: 'flito' as never }, USUARIO, 'pruebas',
    ).catch((x) => x);

    expect(e.message).toMatch(/asigne Siigo/);
    expect(e.message).toMatch(/no está implementado ni confirmado/);
  });

  it('AC5 — la vigencia de la resolución DIAN NO se valida aquí', async () => {
    // Se comprueba la AUSENCIA DE MODELO, no la ausencia de la palabra: mencionar la DIAN en un
    // comentario es correcto, guardar o comprobar su resolución sería salirse del alcance.
    const { siigoConfigEmision } = await import('../../src/db/schema.js');
    const { getTableColumns } = await import('drizzle-orm');
    const columnas = Object.keys(getTableColumns(siigoConfigEmision));

    expect(columnas.filter((c) => /resolucion|vigencia|numeroDesde|numeroHasta/i.test(c))).toEqual([]);
    expect(MIGRACION).not.toMatch(/resolucion_/);

    const fuente = readFileSync(
      resolve(RAIZ, 'src/modules/siigo/config-emision.service.ts'), 'utf8',
    );
    // Ninguna comparación de fechas de vigencia ni lectura de la resolución.
    expect(fuente).not.toMatch(/resolucion[A-Za-z]*\s*[=:.]/);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('AC6 — configuración incompleta es un estado explícito', () => {
  it('sin configuración, el estado lo dice y enumera los campos que siempre aplican', async () => {
    kdb.when.select(TABLA, []);
    const { estadoConfigEmision } = await import('../../src/modules/siigo/config-emision.service.js');

    const e = await estadoConfigEmision('pruebas');

    expect(e.configurada).toBe(false);
    expect(e.completa).toBe(false);
    expect(e.faltantes).toEqual(['documentoTipo', 'vendedor', 'formaPago']);
  });

  it('enumera QUÉ falta, no cuántos', async () => {
    kdb.when.select(TABLA, [fila({ vendedorCodigo: null, formaPagoCodigo: null })]);
    const { estadoConfigEmision } = await import('../../src/modules/siigo/config-emision.service.js');

    const e = await estadoConfigEmision('pruebas');

    expect(e.configurada).toBe(true);
    expect(e.completa).toBe(false);
    expect(e.faltantes).toEqual(['vendedor', 'formaPago']);
  });

  it('un campo inválido cuenta como incompleto y va en su propia lista', async () => {
    kdb.when.select(TABLA, [fila({ vendedorCodigo: '35073' })]);
    const { estadoConfigEmision } = await import('../../src/modules/siigo/config-emision.service.js');

    const e = await estadoConfigEmision('pruebas');

    expect(e.completa).toBe(false);
    expect(e.faltantes).toEqual([]);
    expect(e.invalidos.map((x) => x.campo)).toEqual(['vendedor']);
  });

  it('con todo en orden, la compuerta ve `completa`', async () => {
    kdb.when.select(TABLA, [fila()]);
    const { estadoConfigEmision } = await import('../../src/modules/siigo/config-emision.service.js');

    const e = await estadoConfigEmision('pruebas');
    expect(e.completa).toBe(true);
    expect(e.invalidos).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('Decisión de modelo — el ambiente y el historial', () => {
  it('la configuración es por ambiente: son identificadores de empresas distintas', () => {
    expect(MIGRACION).toMatch(/CHECK \(ambiente IN \('pruebas', 'produccion'\)\)/);
    expect(MIGRACION).toMatch(/idx_siigo_config_emision_vigente[\s\S]*?ON siigo_config_emision \(ambiente\)/);
  });

  it('el historial conserva las configuraciones apagadas', async () => {
    kdb.when.select(TABLA, [fila({ id: 'cfg-2' }), fila({ id: 'cfg-1', vigente: false })]);
    const { historialConfigEmision } = await import('../../src/modules/siigo/config-emision.service.js');

    const h = await historialConfigEmision('pruebas');
    expect(h).toHaveLength(2);
    expect(h.map((c) => c.id)).toEqual(['cfg-2', 'cfg-1']);
  });

  it('el resumen de auditoría lleva códigos y banderas, nunca la fila entera', async () => {
    kdb.when.select(TABLA, [fila()]);
    const { obtenerConfigEmision, resumenConfig } =
      await import('../../src/modules/siigo/config-emision.service.js');

    const texto = resumenConfig((await obtenerConfigEmision('pruebas'))!);

    expect(texto).toContain('vendedor=35071');
    expect(texto).toContain('utilizable=true');
    expect(texto).not.toContain('Ana Ramírez');
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Regresión de la auditoría de seguridad de esta HU.
describe('Regresión — hallazgos de la auditoría de seguridad', () => {
  it('la fila devuelta es la INSERTADA, no una relectura posterior al commit', async () => {
    kdb.when.select(TABLA, [fila({ id: 'vieja' })]).update(TABLA, []);
    capturarInsert(fila({ id: 'recien-creada' }));

    const { guardarConfigEmision } = await import('../../src/modules/siigo/config-emision.service.js');
    const c = await guardarConfigEmision({ plazoVencimientoDias: 7 }, USUARIO, 'pruebas');

    // Con una relectura, un PUT concurrente que confirmara en esa ventana devolvería SU fila y la
    // auditoría atribuiría a este usuario un cambio que no hizo.
    expect(c.id).toBe('recien-creada');
  });

  it('dos guardados simultáneos dan conflicto, no un 500 genérico', async () => {
    kdb.when.select(TABLA, [fila()]).update(TABLA, []);
    // Como lo produce drizzle 0.45: el código de Postgres viaja en `cause`, no en la raíz.
    kdb.insert.mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      const run = () => Promise.reject(Object.assign(
        new Error('Failed query: insert into "siigo_config_emision"\nparams: pruebas'),
        { cause: Object.assign(new Error('duplicate key'), { code: '23505' }) },
      ));
      for (const m of ['values', 'returning']) chain[m] = () => chain;
      chain.then = (r: (v: unknown) => unknown, j?: (e: unknown) => unknown) => run().then(r, j);
      chain.catch = (j: (e: unknown) => unknown) => run().catch(j);
      chain.finally = (cb: () => void) => run().finally(cb);
      return chain;
    });

    const { guardarConfigEmision, SiigoConfigEmisionError } =
      await import('../../src/modules/siigo/config-emision.service.js');
    const e = await guardarConfigEmision({ plazoVencimientoDias: 7 }, USUARIO, 'pruebas')
      .catch((x) => x);

    expect(e).toBeInstanceOf(SiigoConfigEmisionError);
    expect(e.codigo).toBe('conflicto');
    expect(e.message).toMatch(/otro usuario guardó/i);
    // Y el mensaje no arrastra la sentencia ni sus parámetros.
    expect(e.message).not.toContain('Failed query');
    expect(e.message).not.toContain('params:');
  });

  it('el resumen de auditoría delata que las notas cambiaron, sin decir qué dicen', async () => {
    const { obtenerConfigEmision, resumenConfig } =
      await import('../../src/modules/siigo/config-emision.service.js');

    kdb.when.select(TABLA, [fila({ notas: 'Autorizado por Ana, cédula 1000000001' })]);
    const conNotas = resumenConfig((await obtenerConfigEmision('pruebas'))!);

    kdb.reset();
    catalogosSanos();
    kdb.when.select(TABLA, [fila({ notas: 'Otra cosa' })]);
    const conOtras = resumenConfig((await obtenerConfigEmision('pruebas'))!);

    // Comparables entre sí: un cambio solo en notas ya no produce un «Antes» idéntico al «Después».
    expect(conNotas).not.toBe(conOtras);
    // Irreversibles hacia el contenido: `notas` es texto libre y `audit_logs` no es sitio para PII.
    expect(conNotas).not.toContain('Ana');
    expect(conNotas).not.toContain('1000000001');
    expect(conNotas).toMatch(/notas=[0-9a-f]{8}/);
  });

  it('sin notas, el resumen lo dice en vez de un hash del vacío', async () => {
    kdb.when.select(TABLA, [fila({ notas: null })]);
    const { obtenerConfigEmision, resumenConfig } =
      await import('../../src/modules/siigo/config-emision.service.js');

    expect(resumenConfig((await obtenerConfigEmision('pruebas'))!)).toContain('notas=(sin)');
  });

  it('el índice del historial no deriva entre el esquema y la migración', async () => {
    // La migración lo crea DESC; `schema.ts` lo declaraba ASC. Es la clase de deriva que no se nota
    // hasta que alguien regenera algo a partir del esquema.
    const esquema = readFileSync(resolve(RAIZ, 'src/db/schema.ts'), 'utf8');
    expect(MIGRACION).toMatch(/idx_siigo_config_emision_historial\s*\n?\s*ON siigo_config_emision \(ambiente, created_at DESC\)/);
    expect(esquema).toMatch(/idx_siigo_config_emision_historial'\)\.on\(t\.ambiente, desc\(t\.createdAt\)\)/);
  });
});
