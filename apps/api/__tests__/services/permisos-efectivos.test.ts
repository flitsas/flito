// HU #12081 AC4 — `paginasEfectivasDeUsuario`: la pieza que repone las páginas de `admin`.
//
// Es el único código que corre en CADA login y en CADA `/me` desde esta HU, y lo que sostiene que
// retirar los dos atajos sea neutro. Si esto devuelve de menos, el administrador se queda sin
// pantallas; si devuelve de más, concede lo que nadie le dio.
//
// Aquí se prueba la TRADUCCIÓN (códigos de función → slugs, unión con la columna, filtrados). Que
// los datos que lee sean los correctos se prueba contra PostgreSQL en
// `__tests__/db/migracion-0179.test.ts`: el mock de este repo devuelve la fila entera aunque el
// `select` pida menos, así que no vale para afirmar nada sobre el contenido de la base.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const selectMock = vi.fn();
let condicion: unknown;
let filas: { codigo: string }[] = [];

/**
 * Chain que CAPTURA el `where` en vez de ignorarlo.
 *
 * El `chain` del repo es passthrough —memoria: «el mock ignora `orderBy`», «el predicado exportado no
 * ata la consulta»—, así que con él un `eq(rolCodigo, 'admin')` CABLEADO devolvería las mismas filas
 * y todos los casos de abajo seguirían verdes. Se guarda la condición para poder renderizarla.
 */
function chainEspia() {
  const t: Record<string, unknown> = {
    from: () => t,
    where: (c: unknown) => { condicion = c; return t; },
    then: (res: (v: unknown) => unknown) => Promise.resolve(filas).then(res),
  };
  return t;
}

vi.mock('../../src/db/client.js', () => ({
  db: { select: (...a: unknown[]) => selectMock(...a), insert: vi.fn(), update: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));

const { paginasEfectivasDeUsuario } = await import('../../src/shared/permisos-efectivos.js');

const render = (c: unknown) => new PgDialect().sqlToQuery(c as never);

beforeEach(() => {
  condicion = undefined; filas = [];
  selectMock.mockReset().mockImplementation(chainEspia);
});

/** Lo que devolvería `permisos_rol_funcion` para un rol. */
const reparto = (...codigos: string[]) => { filas = codigos.map((codigo) => ({ codigo })); };

describe('paginasEfectivasDeUsuario — del reparto sembrado a la lista de slugs', () => {
  it('traduce `pagina.<slug>` a `<slug>`', async () => {
    reparto('pagina.dashboard', 'pagina.users');
    expect((await paginasEfectivasDeUsuario({ id: 1, role: 'admin' })).sort())
      .toEqual(['dashboard', 'users']);
  });

  it('IGNORA las funciones de tipo `operacion`: están sembradas pero no son pantallas', async () => {
    reparto('pagina.dashboard', 'soat.cola.ver', 'tramite.lote.crear');
    expect(await paginasEfectivasDeUsuario({ id: 1, role: 'admin' })).toEqual(['dashboard']);
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
    reparto('bolsas.transito');
    expect(await paginasEfectivasDeUsuario({ id: 1, role: 'financiera' })).toEqual([]);
  });

  it('descarta un código de página que ya no existe en el catálogo', async () => {
    reparto('pagina.dashboard', 'pagina.pantalla_retirada');
    expect(await paginasEfectivasDeUsuario({ id: 1, role: 'admin' })).toEqual(['dashboard']);
  });

  it('suma las páginas propias del usuario, sin repetir', async () => {
    reparto('pagina.dashboard');
    const pages = await paginasEfectivasDeUsuario({
      id: 9, role: 'conductor', allowedPages: ['dashboard', 'pesv'],
    });
    expect(pages.sort()).toEqual(['dashboard', 'pesv']);
  });

  it('filtra las páginas propias inválidas, igual que hacía `getEffectivePages`', async () => {
    reparto();
    expect(await paginasEfectivasDeUsuario({ id: 9, role: 'x', allowedPages: ['no_existe', 'laft'] }))
      .toEqual(['laft']);
  });

  it('un rol sin reparto y sin páginas propias no ve NADA: el fallo por defecto es cerrado', async () => {
    reparto();
    expect(await paginasEfectivasDeUsuario({ id: 9, role: 'rol_recien_creado' })).toEqual([]);
  });

  it('consulta el reparto del ROL del usuario y nada más', async () => {
    reparto('pagina.dashboard');
    await paginasEfectivasDeUsuario({ id: 1, role: 'auditor', allowedPages: [] });
    // Una sola consulta por petición: el login y `/me` la pagan en cada llamada, y una segunda
    // (`permisos_usuario_funcion`) sería una consulta por un dato que hoy no escribe nadie.
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  // ── La atadura al rol, sobre el SQL renderizado ────────────────────────────────────────────────
  //
  // Ninguno de los casos de arriba ata la consulta al rol que se pasó: el chain devuelve las filas
  // que se le digan mire lo que mire el `where`, así que un `eq(rolCodigo, 'admin')` CABLEADO los
  // deja a todos en verde. Y esta es LA función que decide las páginas del administrador: si el rol
  // fuera un literal, cada usuario del sistema recibiría el reparto de `admin`.
  //
  // Se afirma sobre el predicado que de verdad se construyó, como en `users.rol-asignable.test.ts`.
  // Mutante que mata: sustituir `user.role` por `'admin'` en `permisos-efectivos.ts`.
  it('el `where` filtra por el rol DEL USUARIO, no por un literal', async () => {
    reparto('pagina.dashboard');
    await paginasEfectivasDeUsuario({ id: 7, role: 'gestor_impuestos' });

    const q = render(condicion);
    expect(q.sql).toMatch(/"permisos_rol_funcion"\."rol_codigo" = \$1/);
    // El parámetro es el rol que entró. Un literal cableado dejaría aquí otro valor.
    expect(q.params).toEqual(['gestor_impuestos']);
  });

  it('dos usuarios de roles distintos producen DOS predicados distintos', async () => {
    // El caso anterior por sí solo no descarta que el rol se lea de un sitio fijo que casualmente
    // coincida; esto lo cierra: cambia la entrada, cambia el parámetro.
    reparto('pagina.dashboard');
    await paginasEfectivasDeUsuario({ id: 1, role: 'mensajero' });
    expect(render(condicion).params).toEqual(['mensajero']);

    reparto('pagina.dashboard');
    await paginasEfectivasDeUsuario({ id: 2, role: 'compliance' });
    expect(render(condicion).params).toEqual(['compliance']);
  });

  it('pide solo el código de la función: el catálogo entero no le hace falta', async () => {
    reparto();
    await paginasEfectivasDeUsuario({ id: 1, role: 'admin' });
    expect(Object.keys(selectMock.mock.calls[0][0] as object)).toEqual(['codigo']);
  });
});
