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

import { describe, it, expect, beforeAll } from 'vitest';
import postgres from 'postgres';
import { USER_ROLES } from '@operaciones/shared-types';
import { RUTAS_RECONDUCIDAS, type RutaReconducida } from '../fixtures/permisos-rutas-reconducidas.js';
// HU #12873: el seed de la reconducción es el del mundo PLANO (≤ 0231); el árbol (0232/0233) y sus
// pérdidas por la regla «todos» los vigilan `migracion-0233.test.ts` y el reporte en seco de la HU.
import { leerRepartoSembrado, MIGRACIONES_ANTES_DEL_ARBOL } from '../helpers/permisos-seed-sql.js';
import { montajesDeFunciones, llaveDe } from '../../src/modules/permisos/inventario-guardas.js';
import { GUARDAS_MEDIDAS } from '../../src/modules/permisos/inventario.generado.js';
import {
  ACCIONES_ARBOL, ACCIONES_UNIVERSALES, expandirSinCadena, operacionesDe, PARTIDAS_DE_OPERACIONES_NUEVAS as PARTIDA_DE_OPERACION_NUEVA,
} from '../../src/modules/permisos/arbol/expansion.js';
import { FUNCIONES_EXCLUSIVAS_ADMIN } from '../../src/modules/permisos/catalogo-operaciones.js';

/**
 * HU #13427: en el mundo PLANO (seed ≤ 0231) una operación nueva que parte una guarda vieja se decide con su código de
 * PARTIDA (`finanzas.reporte_costos.exportar` → `finanzas.reporte_costos.ver`; gastos diarios → su página).
 */
const enPlano = (codigo: string) => PARTIDA_DE_OPERACION_NUEVA[codigo] ?? codigo;

/**
 * HU #13428 (P-22): las guardas de Perfil no tienen equivalente en el mundo plano — antes NO había guarda y las
 * pasaba cualquiera; su partida (`pagina.perfil`) solo la tenía admin. Su paridad no es la de la foto sino la
 * del reparto universal: plegado hasta la 0237, cada rol tiene la acción que las concede (caso propio, abajo).
 */
const DE_TODOS = new Set(ACCIONES_UNIVERSALES.flatMap((u) => operacionesDe(u.accion)));

/**
 * HU #13945: las operaciones absorbidas por una acción EXCLUSIVA del Administrador (`FUNCIONES_EXCLUSIVAS_ADMIN`)
 * nacen en el árbol, sin partida en el mundo plano: la siembra de su acción es posterior (0255) y el plano no puede
 * decidirlas (solo el grupo `operaciones`: el `apoyo` de lectura sí es del plano). Se excluyen SOLO de la matriz plana; la de la base real sí las mide (admin SÍ, el resto NO).
 */
const DE_EXCLUSIVAS = new Set(FUNCIONES_EXCLUSIVAS_ADMIN.flatMap((a) => ACCIONES_ARBOL[a]?.operaciones ?? []));
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

/**
 * HU #13429: el mundo PLANO (≤ 0231) no tiene elementos, ítems en cadena ni acciones; con el resolutor en cadena sus
 * operaciones sueltas ya no entrarían (fallo cerrado). Esta matriz mide una propiedad HISTÓRICA —el SQL de la
 * reconducción reproduce el `requireRole`— y la decide con la regla que regía ese mundo: `(R ∪ C) \ V` sin cadena
 * (`expandirSinCadena`). Que el mundo de HOY (0001..0239) no pierde nada con la cadena lo vigilan, rol a rol,
 * `permisos-arbol-legado.test.ts` (paridad del pliegue) y el reporte en seco de la #13429.
 */
function matriz(
  nombre: string, reparto: () => Map<string, Set<string>>, codigoDe: (c: string) => string = (c) => c,
  fuera: ReadonlySet<string> = new Set(),
) {
  describe(nombre, () => {
    for (const fila of RUTAS_RECONDUCIDAS.filter((f) => !DE_TODOS.has(f.codigo) && !fuera.has(f.codigo))) {
      it(`${etiqueta(fila)} → ${fila.codigo}: los 12 roles deciden como antes`, async () => {
        const antes = antesDe(fila);
        const desacuerdos: string[] = [];
        for (const rol of ROLES) {
          const motor = expandirSinCadena(reparto().get(rol) ?? []).has(codigoDe(fila.codigo));
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
    const sembrados = new Set([...leerRepartoSembrado(MIGRACIONES_ANTES_DEL_ARBOL).values()].flatMap((s) => [...s]));
    const desconocidos = RUTAS_RECONDUCIDAS.filter((r) => !sembrados.has(enPlano(r.codigo))).map(etiqueta);
    // Un código que NINGÚN rol tiene sembrado es una guarda que responde 403 a todo el mundo. Solo hay
    // una, a propósito: el reemplazo del comprobante de pago nace sin rol (AC7 de la HU #13269) y el
    // administrador lo concede desde el panel. HU #13889 (ADR-0028): las cuatro del expediente documental
    // tampoco tienen reparto de partida: nacen en el árbol y las concede su acción (la 0248 solo marca a `admin`).
    // Cualquier otra es un olvido.
    expect(desconocidos).toEqual([
      // HU #13941: las tres funciones de Dr. Flit nacen en el árbol (la 0254 las da con su acción a `admin`).
      'flito-dr-flit/dr-flit.funciones.ts POST * [usar_ia]',
      'flito-dr-flit/dr-flit.funciones.ts POST * [radicar_soporte]',
      'flito-dr-flit/dr-flit.funciones.ts POST * [consultar_gestion]',
      'flito-bolsas-documentos/flito-bolsas-documentos.routes.ts GET /companias/:companiaId',
      'flito-bolsas-documentos/flito-bolsas-documentos.routes.ts GET /companias/:companiaId/tipos/:tipo/historial',
      'flito-bolsas-documentos/flito-bolsas-documentos.routes.ts POST /companias/:companiaId/tipos/:tipo',
      'flito-bolsas-documentos/flito-bolsas-documentos.routes.ts GET /documentos/:documentoId/archivo',
      // HU #13890 (ADR-0028 §5 E4): la fecha manual reutiliza `bolsas.documentos.cargar`, sin reparto de partida.
      'flito-bolsas-documentos/flito-bolsas-documentos.routes.ts PUT /documentos/:documentoId/fecha-expedicion',
      // HU #13964 (ADR-0028 adenda E7): retirar la vigente reutiliza `bolsas.documentos.cargar`, sin reparto de partida.
      'flito-bolsas-documentos/flito-bolsas-documentos.routes.ts POST /documentos/:documentoId/retirar',
      // HU #13893 (ADR-0028 §5 E6): el estado del lote reutiliza `bolsas.documentos.ver`, sin reparto de partida.
      'flito-bolsas-documentos/flito-bolsas-documentos.routes.ts POST /estado-lote',
      'flito-impuestos/flito-impuestos.recibo-reemplazo.routes.ts POST /:id/recibos/reemplazar-pago',
      // HU #13945: `clients.clientes.estado` nace absorbida por la acción exclusiva del Administrador
      // `accion.clientes.activar_desactivar`; la siembra la 0255 (solo `admin`), no el seed plano.
      'clients/clients.routes.ts GET /:id/impacto',
      'clients/clients.routes.ts PATCH /:id/estado',
    ]);
  });
});

describe('HU #13428 (P-22) — las guardas de Perfil: antes las pasaba cualquiera; después, cada rol por su acción', () => {
  it('las dos filas de Perfil están en la lista y en la foto con los 12 roles', () => {
    const filas = RUTAS_RECONDUCIDAS.filter((f) => DE_TODOS.has(f.codigo));
    expect(filas.map((f) => f.codigo).sort()).toEqual(['perfil.contrasena.cambiar', 'perfil.datos.ver']);
    for (const f of filas) expect([...antesDe(f)].sort()).toEqual([...ROLES].sort());
  });

  it('plegadas las migraciones hasta la 0237, el motor se las concede a los 12 roles', async () => {
    fijarFuenteDePermisos(fuenteDesde(leerRepartoSembrado()));
    try {
      for (const rol of ROLES) invalidarPermisosDe(subDe(rol));
      for (const rol of ROLES) {
        const p = await resolverPermisos(subDe(rol));
        for (const op of DE_TODOS) expect(p.ok && p.funciones.has(op), `${rol} ${op}`).toBe(true);
      }
    } finally {
      fijarFuenteDePermisos(null);
      for (const rol of ROLES) invalidarPermisosDe(subDe(rol));
    }
  });
});

matriz('AC7 — el motor alimentado con el SQL de la 0179 + 0181 decide, ruta a ruta y rol a rol, lo mismo que el requireRole de antes', () => leerRepartoSembrado(MIGRACIONES_ANTES_DEL_ARBOL), enPlano, DE_EXCLUSIVAS);

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
