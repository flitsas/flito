// HU #12081 AC4 — `paginasEfectivasDeUsuario`: la pieza que repone las páginas de `admin`.
// HU #12082 — desde esta HU es una VISTA del resolutor único (`resolverPermisos`): recibe el `id` y
// devuelve solo las `pagina.*` del conjunto efectivo como slugs. Los casos de TRADUCCIÓN se conservan;
// la lectura (las tres consultas y sus `where`) se prueba en `permisos-resolutor.test.ts`.
//
// Es el código que corre en CADA login y en CADA `/me`, y lo que sostiene que retirar los dos atajos
// sea neutro. Si esto devuelve de menos, el administrador se queda sin pantallas; si devuelve de más,
// concede lo que nadie le dio. Que los datos que lee sean los correctos se prueba contra PostgreSQL en
// `__tests__/db/migracion-0179.test.ts`: el mock de este repo devuelve la fila entera aunque el
// `select` pida menos, así que no vale para afirmar nada sobre el contenido de la base.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const selectMock = vi.fn();
let condiciones: unknown[] = [];
let respuestas: unknown[][] = [];

/**
 * Chain que CAPTURA el `where` en vez de ignorarlo.
 *
 * El `chain` del repo es passthrough —memoria: «el mock ignora `orderBy`», «el predicado exportado no
 * ata la consulta»—, así que con él un `eq(rolCodigo, 'admin')` CABLEADO devolvería las mismas filas
 * y todos los casos de abajo seguirían verdes. Se guarda la condición para poder renderizarla.
 */
function chainEspia() {
  const filas = respuestas.shift() ?? [];
  const t: Record<string, unknown> = {
    from: () => t,
    innerJoin: () => t,
    where: (c: unknown) => { condiciones.push(c); return t; },
    limit: () => t,
    then: (res: (v: unknown) => unknown) => Promise.resolve(filas).then(res),
  };
  return t;
}

vi.mock('../../src/db/client.js', () => ({
  db: { select: (...a: unknown[]) => selectMock(...a), insert: vi.fn(), update: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));

const { paginasEfectivasDeUsuario, fijarFuenteDePermisos } = await import('../../src/shared/permisos-efectivos.js');

const render = (c: unknown) => new PgDialect().sqlToQuery(c as never);

beforeEach(() => {
  condiciones = []; respuestas = [];
  selectMock.mockReset().mockImplementation(chainEspia);
  fijarFuenteDePermisos(null); // fuente real y caché vacía en cada caso
});

type Excepcion = { codigo: string; efecto: 'conceder' | 'revocar' };

/**
 * La tanda: fila de users⋈permisos_roles, reparto del rol, filas propias de `permisos_usuario_funcion`.
 * HU #12087: las páginas propias ya NO vienen de `users.allowed_pages` (congelada, 0188) sino de la
 * tabla como `conceder pagina.<slug>`; `propias` admite slugs (→ `conceder`) o excepciones completas.
 */
function usuario(role: string, propias: (string | Excepcion)[] | null, ...reparto: string[]) {
  respuestas = [
    [{ rol: role, tipoPrincipal: 'interno' }],
    reparto.map((codigo) => ({ codigo })),
    (propias ?? []).map((p) => (typeof p === 'string' ? { codigo: `pagina.${p}`, efecto: 'conceder' } : p)),
  ];
}

describe('paginasEfectivasDeUsuario — del reparto sembrado a la lista de slugs', () => {
  it('traduce `pagina.<slug>` a `<slug>`', async () => {
    usuario('admin', null, 'pagina.dashboard', 'pagina.users');
    expect((await paginasEfectivasDeUsuario(1)).sort()).toEqual(['dashboard', 'users']);
  });

  it('IGNORA las funciones de tipo `operacion`: están en el conjunto pero no son pantallas', async () => {
    usuario('admin', null, 'pagina.dashboard', 'soat.cola.ver', 'tramite.lote.crear');
    expect(await paginasEfectivasDeUsuario(1)).toEqual(['dashboard']);
  });

  it('una operación cuyo código CORTADO parece un slug tampoco se cuela', async () => {
    // El caso de arriba NO prueba el `startsWith`, y está medido: quitando esa línea seguía en verde,
    // porque a `soat.cola.ver` le sobra un punto tras cortarle siete caracteres y `isValidPage` la
    // rechaza igual. Lo que hace falta para que el guard cuente es una colisión de verdad:
    // `bolsas.transito` —módulo de seis letras y código de dos segmentos— cortado por 'pagina.'
    // (siete caracteres) da exactamente `transito`, que SÍ es una página del catálogo.
    //
    // Sin el `startsWith`, este caso concede la pantalla de Tránsito a cualquiera que tenga esa
    // operación. Con él, no concede nada. Ese es el mutante que este caso mata.
    usuario('financiera', null, 'bolsas.transito');
    expect(await paginasEfectivasDeUsuario(1)).toEqual([]);
  });

  it('descarta un código de página que ya no existe en el catálogo', async () => {
    usuario('admin', null, 'pagina.dashboard', 'pagina.pantalla_retirada');
    expect(await paginasEfectivasDeUsuario(1)).toEqual(['dashboard']);
  });

  it('suma las páginas propias del usuario (`conceder pagina.*` de permisos_usuario_funcion), sin repetir', async () => {
    usuario('conductor', ['dashboard', 'pesv'], 'pagina.dashboard');
    expect((await paginasEfectivasDeUsuario(9)).sort()).toEqual(['dashboard', 'pesv']);
  });

  it('filtra las páginas propias que ya no están en el catálogo, igual que las del rol', async () => {
    usuario('x', ['no_existe', 'laft']);
    expect(await paginasEfectivasDeUsuario(9)).toEqual(['laft']);
  });

  // AC2 de la HU #12087, para páginas. Mutante nombrado (AC8): quitar el bucle de `revocar` de
  // `conjuntoEfectivo` deja `fleet` en la lista y este caso cae.
  it('`revocar pagina.fleet` contra `pagina.fleet` del rol → la página NO está: revocar manda sobre el rol', async () => {
    usuario('gestor', [{ codigo: 'pagina.fleet', efecto: 'revocar' }], 'pagina.dashboard', 'pagina.fleet');
    expect(await paginasEfectivasDeUsuario(9)).toEqual(['dashboard']);
  });

  it('`revocar` de una página que el rol NO da tampoco la añade (no es un conceder disfrazado)', async () => {
    usuario('gestor', [{ codigo: 'pagina.fleet', efecto: 'revocar' }], 'pagina.dashboard');
    expect(await paginasEfectivasDeUsuario(9)).toEqual(['dashboard']);
  });

  it('de `users` pide `role` y el tipo del rol, y NO `allowed_pages`: la columna está congelada (0188)', async () => {
    usuario('auditor', ['pesv'], 'pagina.dashboard');
    await paginasEfectivasDeUsuario(1);
    expect(Object.keys(selectMock.mock.calls[0]![0] as object).sort()).toEqual(['rol', 'tipoPrincipal']);
  });

  it('un rol sin reparto y sin páginas propias no ve NADA: el fallo por defecto es cerrado', async () => {
    usuario('rol_recien_creado', null);
    expect(await paginasEfectivasDeUsuario(9)).toEqual([]);
  });

  it('un usuario que no existe (o una base caída) → [] sin lanzar: el login pinta un menú, no decide', async () => {
    respuestas = [[]];
    expect(await paginasEfectivasDeUsuario(404)).toEqual([]);
  });

  it('consulta la fila del usuario, el reparto de SU rol y sus excepciones: tres consultas, una vez por minuto', async () => {
    usuario('auditor', [], 'pagina.dashboard');
    await paginasEfectivasDeUsuario(1);
    expect(selectMock).toHaveBeenCalledTimes(3);
    // La segunda llamada dentro del TTL es un acierto de caché: el login y `/me` no pagan otra tanda.
    await paginasEfectivasDeUsuario(1);
    expect(selectMock).toHaveBeenCalledTimes(3);
  });

  // ── La atadura al rol, sobre el SQL renderizado ────────────────────────────────────────────────
  //
  // El chain devuelve las filas que se le digan mire lo que mire el `where`, así que un
  // `eq(rolCodigo, 'admin')` CABLEADO dejaría todos los casos en verde. Y esta es LA función que
  // decide las páginas del administrador. Desde la HU #12082 el rol NO entra como argumento: se LEE
  // de la fila de `users` y con ese valor se consulta el reparto. Mutante que mata: sustituir
  // `fila.rol` por `'admin'` en `permisos-efectivos.ts`.
  it('el `where` del reparto filtra por el rol LEÍDO de la fila del usuario, no por un literal', async () => {
    usuario('gestor_impuestos', null, 'pagina.dashboard');
    await paginasEfectivasDeUsuario(7);

    const [qUsuario, qRol] = condiciones.map(render);
    expect(qUsuario!.sql).toMatch(/"users"\."id" = \$1/);
    expect(qUsuario!.params).toEqual([7]);
    expect(qRol!.sql).toMatch(/"permisos_rol_funcion"\."rol_codigo" = \$1/);
    expect(qRol!.params).toEqual(['gestor_impuestos']);
  });

  it('dos usuarios de roles distintos producen DOS predicados distintos', async () => {
    usuario('mensajero', null, 'pagina.dashboard');
    await paginasEfectivasDeUsuario(1);
    expect(render(condiciones[1]).params).toEqual(['mensajero']);

    usuario('compliance', null, 'pagina.dashboard');
    await paginasEfectivasDeUsuario(2);
    expect(render(condiciones[4]).params).toEqual(['compliance']);
  });

  it('del reparto pide solo el código de la función: el catálogo entero no le hace falta', async () => {
    usuario('admin', null);
    await paginasEfectivasDeUsuario(1);
    expect(Object.keys(selectMock.mock.calls[1]![0] as object)).toEqual(['codigo']);
  });
});
