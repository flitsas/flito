// HU #12083 — Paridad de la reconducción (AC7, CF-16: «nadie gana ni pierde acceso»), y AC8.
//
// Cuatro fuentes, ninguna derivada de otra:
//   · QUÉ rutas se reconducen: `RUTAS_RECONDUCIDAS` (fixture escrita a mano, sin glob).
//   · DÓNDE está montado el código: `montajesDeFunciones()`, que LEE el fuente de los 22 ficheros.
//   · ANTES: la foto congelada `inventario.generado.ts` — qué roles exigía el `requireRole` de cada ruta.
//   · MOTOR: `resolverPermisos` REAL, con `fijarFuenteDePermisos` alimentado desde el SQL de la 0179 y
//     la 0181 parseado (`helpers/permisos-seed-sql.ts`). Ni la foto ni el catálogo entran ahí.
//
// Un caso de Vitest POR RUTA que recorre los 12 roles de `USER_ROLES` y decide como decide la guarda
// (`p.ok && p.funciones.has(codigo)`, exigir-funcion.ts). Al cerrar la HU: 228 rutas × 12 roles.
//
// Mutaciones del AC8 que este fichero atrapa:
//   · quitar `('auditor', 'soat.cola.ver')` de la 0179 → «flito-soat/flito-soat.routes.ts GET / · rol
//     auditor: antes SÍ, motor NO»;
//   · devolver `requireRole('admin')` a una ruta reconducida → «fila sin montaje» aquí y rojo en
//     `permisos.reconduccion-cierre.test.ts`.
// Y la de CONTROL que debe sobrevivir: cambiar el nombre de negocio de una función. Aquí no se mira.
//
// Por qué a nivel de resolutor y no por HTTP: montar los 22 routers reales exige los mocks de base
// de cada módulo (81 specs distintos); que `exigirFuncion` decide con `has(codigo)` lo fija el
// laboratorio de la #12082. Este test prueba lo que aquel no podía: que el conjunto SEMBRADO
// reproduce el `requireRole`. Con `TEST_DATABASE_URL` presente, un segundo `describe` repite la matriz
// leyendo `permisos_rol_funcion` de la base real en vez del SQL; en CI (sin Postgres) solo corre el
// primero.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { USER_ROLES } from '@operaciones/shared-types';
import { RUTAS_RECONDUCIDAS, type RutaReconducida } from '../fixtures/permisos-rutas-reconducidas.js';
import { leerRepartoSembrado } from '../helpers/permisos-seed-sql.js';
import { montajesDeFunciones, llaveDe } from '../../src/modules/permisos/inventario-guardas.js';
import { GUARDAS_MEDIDAS } from '../../src/modules/permisos/inventario.generado.js';
import {
  fijarFuenteDePermisos, invalidarPermisosDe, resolverPermisos, type FilasPermisos,
} from '../../src/shared/permisos-efectivos.js';

const ROLES = [...USER_ROLES] as string[];
/** Un `sub` por rol, fijo: el resolutor cachea por usuario y aquí cada rol es un usuario. */
const subDe = (rol: string) => 1000 + ROLES.indexOf(rol);

const etiqueta = (r: RutaReconducida) => `${r.fichero} ${r.metodo} ${r.ruta}${r.condicion ? ` [${r.condicion}]` : ''}`;

/** La fuente del motor: por rol, EXACTAMENTE los pares del reparto dado y nada más. */
function fuenteDesde(reparto: Map<string, Set<string>>) {
  return async (sub: number): Promise<FilasPermisos | null> => {
    const rol = ROLES[sub - 1000];
    if (!rol) return null;
    return {
      rol,
      tipoPrincipal: rol === 'cliente' ? 'externo' : 'interno',
      funcionesDelRol: [...(reparto.get(rol) ?? [])],
      excepciones: [],
    };
  };
}

/** La decisión de ANTES: la foto por llave. Una fila sin foto es una ruta sin historial → lanza. */
function antesDe(r: RutaReconducida): string[] {
  const g = GUARDAS_MEDIDAS.find((x) => llaveDe(x) === etiqueta(r));
  if (!g) throw new Error(`${etiqueta(r)}: no está en la foto inventario.generado.ts (ruta sin historial)`);
  return g.roles;
}

function matriz(nombre: string, reparto: () => Map<string, Set<string>>) {
  describe(nombre, () => {
    beforeAll(() => {
      fijarFuenteDePermisos(fuenteDesde(reparto()));
      for (const rol of ROLES) invalidarPermisosDe(subDe(rol));
    });
    afterAll(() => { fijarFuenteDePermisos(null); });

    for (const fila of RUTAS_RECONDUCIDAS) {
      it(`${etiqueta(fila)} → ${fila.codigo}: los 12 roles deciden como antes`, async () => {
        const antes = antesDe(fila);
        const desacuerdos: string[] = [];
        for (const rol of ROLES) {
          const p = await resolverPermisos(subDe(rol));
          const motor = p.ok && p.funciones.has(fila.codigo);
          const previo = antes.includes(rol);
          if (motor !== previo) {
            desacuerdos.push(`${etiqueta(fila)} · rol ${rol}: antes ${previo ? 'SÍ' : 'NO'}, motor ${motor ? 'SÍ' : 'NO'}`);
          }
        }
        expect(desacuerdos).toEqual([]);
      });
    }
  });
}

describe('AC7 — las cuatro fuentes se corresponden una a una', () => {
  it('la lista es explícita y sin repetidos', () => {
    const llaves = RUTAS_RECONDUCIDAS.map(etiqueta);
    expect(new Set(llaves).size).toBe(llaves.length);
    expect(RUTAS_RECONDUCIDAS.length).toBeGreaterThan(0);
  });

  it('cada fila tiene su código MONTADO en el fuente (exigirFuncion a nivel de ruta, o tieneFuncion en línea), y ningún montaje queda fuera de la lista', () => {
    const montajes = montajesDeFunciones();
    const enFuente = new Set(montajes.map((m) => (m.metodo === null
      ? `${m.fichero} tieneFuncion → ${m.codigo}`
      : `${m.fichero} ${m.metodo} ${m.ruta} → ${m.codigo}`)));
    const enLista = new Set(RUTAS_RECONDUCIDAS.map((r) => (r.condicion
      ? `${r.fichero} tieneFuncion → ${r.codigo}`
      : `${r.fichero} ${r.metodo} ${r.ruta} → ${r.codigo}`)));
    const sinMontaje = [...enLista].filter((x) => !enFuente.has(x));
    const sinFila = [...enFuente].filter((x) => !enLista.has(x));
    expect(sinMontaje, 'filas de la lista SIN exigirFuncion/tieneFuncion en el código').toEqual([]);
    expect(sinFila, 'montajes del código SIN fila en la lista').toEqual([]);
  });

  it('cada fila está en la foto: nadie reconduce una ruta sin historial', () => {
    for (const fila of RUTAS_RECONDUCIDAS) expect(() => antesDe(fila)).not.toThrow();
  });

  it('el SQL sembrado conoce cada código de la lista (0179 ∪ 0181)', () => {
    const sembrados = new Set([...leerRepartoSembrado().values()].flatMap((s) => [...s]));
    const desconocidos = RUTAS_RECONDUCIDAS.filter((r) => !sembrados.has(r.codigo)).map(etiqueta);
    // Un código que NINGÚN rol tiene sembrado sería una guarda que responde 403 a todo el mundo; hoy
    // no existe ninguna (todas tienen al menos `admin` o `cliente`).
    expect(desconocidos).toEqual([]);
  });
});

matriz('AC7 — el motor alimentado con el SQL de la 0179 + 0181 decide, ruta a ruta y rol a rol, lo mismo que el requireRole de antes', () => leerRepartoSembrado());

// ── Variante contra la base real ─────────────────────────────────────────────────────────────────
const URL_BASE = process.env.TEST_DATABASE_URL;
const repartoDeLaBase = new Map<string, Set<string>>();

describe.skipIf(!URL_BASE)('AC7 — la misma matriz, leyendo permisos_rol_funcion de la base real', () => {
  beforeAll(async () => {
    const sql = postgres(URL_BASE!, { max: 1, onnotice: () => {} });
    try {
      const filas = await sql`SELECT rol_codigo, funcion_codigo FROM permisos_rol_funcion`;
      for (const f of filas) {
        if (!repartoDeLaBase.has(f.rol_codigo)) repartoDeLaBase.set(f.rol_codigo, new Set());
        repartoDeLaBase.get(f.rol_codigo)!.add(f.funcion_codigo);
      }
    } finally { await sql.end(); }
  });
  matriz('base real', () => repartoDeLaBase);
});
