// Bug #14491 — las expresiones de `flit_raw` del Excel de las colas, EJECUTADAS contra Postgres REAL.
//
// `cola-flito-derivados.test.ts` afirma qué clave queda ligada a qué campo leyendo el SQL renderizado;
// aquí se comprueba lo que ese SQL DEVUELVE, que es lo que el Bug rompía: un trámite de FLIT 2 trae
// marca/línea/año/clase/capacidad ANIDADOS en `vehiculo` y las cinco celdas salían vacías. Sin
// tablas: el crudo va como parámetro a un `select … from (select $1::jsonb as flit_raw) flito_tramites`.
// Solo corre con TEST_DATABASE_URL.

import { describe, it, expect, afterAll } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { flitoTramites } from '../../src/db/schema.js';
import { expresionesFlitRaw, expresionTiposDocumentoFlit2 } from '../../src/shared/export/cola-flito-derivados.js';

const URL_BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_BASE)('expresionesFlitRaw contra Postgres (Bug #14491)', () => {
  const cliente = postgres(URL_BASE ?? 'postgres://nadie@127.0.0.1:1/x', { max: 1, onnotice: () => {} });
  const db = drizzle(cliente);
  afterAll(async () => { await cliente.end(); });

  const exprs = expresionesFlitRaw(flitoTramites.flitRaw);

  async function extraer(crudo: unknown): Promise<Record<string, string | null>> {
    const json = crudo === null ? null : JSON.stringify(crudo);
    const filas = await db.execute(sql`select ${exprs.marca} as marca, ${exprs.linea} as linea, ${exprs.modelo} as modelo,
      ${exprs.clase} as clase, ${exprs.capacidad} as capacidad, ${exprs.nombres} as nombres, ${exprs.tipo} as tipo,
      ${exprs.departamento} as departamento
      from (select ${json}::jsonb as flit_raw) as "flito_tramites"`);
    return (filas as unknown as Record<string, string | null>[])[0]!;
  }

  it('FLIT 2: las cinco salen de `vehiculo.*` (marca, linea, modeloAno, clase, capacidad)', async () => {
    const r = await extraer({
      id: 'x', radicado: 'R-1',
      vehiculo: { vin: 'V', marca: 'MAZDA', linea: 'CX-30 TOURING', modeloAno: 2024, clase: 'CAMIONETA', capacidad: 5 },
    });
    expect(r).toMatchObject({ marca: 'MAZDA', linea: 'CX-30 TOURING', modelo: '2024', clase: 'CAMIONETA', capacidad: '5' });
  });

  it('FLIT 1 (regresión): las claves planas, con el cruce línea ← `modelo` y año ← `modeloAno`, salen igual', async () => {
    const r = await extraer({ marca: 'KIA', modelo: 'STONIC', modeloAno: '2021', capacidad: '5', nombres: 'ANA', tipo: 'cc' });
    expect(r).toEqual({ marca: 'KIA', linea: 'STONIC', modelo: '2021', clase: null, capacidad: '5', nombres: 'ANA', tipo: 'cc', departamento: null });
    expect((await extraer({ departamentoTransito: 'CUNDINAMARCA' })).departamento).toBe('CUNDINAMARCA');
  });

  it('la plana gana a la anidada: un crudo con las dos no cambia lo que FLIT 1 publicaba', async () => {
    const r = await extraer({ marca: 'KIA', modelo: 'STONIC', vehiculo: { marca: 'OTRA', linea: 'OTRA' } });
    expect(r.marca).toBe('KIA');
    expect(r.linea).toBe('STONIC');
  });

  it('un objeto o array anidado bajo `vehiculo.<clave>` se descarta (no se serializa a la celda)', async () => {
    const r = await extraer({ vehiculo: { marca: { a: 1 }, linea: ['X'], clase: 'BUS' } });
    expect(r).toMatchObject({ marca: null, linea: null, clase: 'BUS' });
  });

  it('sin `vehiculo`, sin claves o con `flit_raw` NULL: todo NULL', async () => {
    expect(await extraer({})).toMatchObject({ marca: null, linea: null, modelo: null, clase: null, capacidad: null });
    expect(await extraer(null)).toMatchObject({ marca: null, linea: null, modelo: null, clase: null, capacidad: null });
    expect(await extraer({ vehiculo: 'texto' })).toMatchObject({ marca: null, clase: null });
  });

  it('departamento: FLIT 2 cae a `organismo.departamento`; la plana de FLIT 1 gana; objeto anidado → null', async () => {
    expect((await extraer({ organismo: { ciudad: 'BOGOTA', departamento: 'BOGOTA D.C.' } })).departamento).toBe('BOGOTA D.C.');
    expect((await extraer({ departamentoTransito: 'CUNDINAMARCA', organismo: { departamento: 'OTRO' } })).departamento).toBe('CUNDINAMARCA');
    expect((await extraer({ organismo: { departamento: { a: 1 } } })).departamento).toBeNull();
  });

  async function tipos(crudo: unknown, fuente: string): Promise<unknown> {
    const e = expresionTiposDocumentoFlit2(flitoTramites.flitRaw, flitoTramites.fuente);
    const filas = await db.execute(sql`select ${e} as t from (select ${JSON.stringify(crudo)}::jsonb as flit_raw, ${fuente}::text as fuente) as "flito_tramites"`);
    return (filas as unknown as { t: unknown }[])[0]!.t;
  }

  it('tipos de documento de FLIT 2: ordenados por `ordinal` (sin él, la posición), solo cadenas, solo `fuente = flit2`', async () => {
    const compradores = [
      { ordinal: 2, tipoDocumento: 'CC' }, { ordinal: 1, tipoDocumento: 'NIT' }, { ordinal: 3, tipoDocumento: { x: 1 } },
    ];
    expect(await tipos({ compradores }, 'flit2')).toEqual(['NIT', 'CC', null]);
    expect(await tipos({ compradores: [{ tipoDocumento: 'CE' }, { tipoDocumento: 'CC' }] }, 'flit2')).toEqual(['CE', 'CC']);
    expect(await tipos({ compradores }, 'flit')).toBeNull();
    expect(await tipos({ compradores: 'x' }, 'flit2')).toBeNull();
    expect(await tipos({ compradores: [] }, 'flit2')).toEqual([]);
  });
});
