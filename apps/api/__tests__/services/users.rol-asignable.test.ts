// HU #12169 (AC6) — `rolAsignable()`: la validación del rol pregunta al CATÁLOGO.
//
// Aquí se vigila la CONSULTA, no el handler: qué tabla lee, con qué condición y qué devuelve cuando
// no hay fila. El 400 del handler se prueba en `users.routes.test.ts`, donde esta función va mockeada.
//
// Por qué se afirma sobre la condición RENDERIZADA y no sobre el resultado: el mock de este repo
// devuelve lo que se le diga sin mirar el `where`, así que «rol inactivo → null» pasaría en verde con
// la condición `activo` PODADA. Lo que ata el predicado es leer el SQL que de verdad se construyó
// (memoria del repo: «el predicado exportado no ata la consulta»).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const selectMock = vi.fn();
let condicion: unknown;
let tablaLeida: unknown;
let filas: unknown[] = [];

/** Chain que CAPTURA `from` y `where` en vez de ignorarlos. */
function chainEspia() {
  const t: Record<string, unknown> = {
    from: (tabla: unknown) => { tablaLeida = tabla; return t; },
    where: (c: unknown) => { condicion = c; return t; },
    limit: () => t,
    then: (res: (v: unknown) => unknown) => Promise.resolve(filas).then(res),
  };
  return t;
}

vi.mock('../../src/db/client.js', () => ({
  db: { select: (...a: unknown[]) => selectMock(...a) },
  getPoolStats: vi.fn(),
}));

const render = (c: unknown) => new PgDialect().sqlToQuery(c as never);

beforeEach(() => {
  condicion = undefined; tablaLeida = undefined; filas = [];
  selectMock.mockReset().mockImplementation(chainEspia);
});

describe('rolAsignable — AC6', () => {
  it('lee `permisos_roles` filtrando por el código Y por `activo = true`', async () => {
    const { rolAsignable } = await import('../../src/modules/users/users.service.js');
    filas = [{ tipoEnlace: 'compania' }];
    const r = await rolAsignable('cliente');

    expect(r).toEqual({ tipoEnlace: 'compania' });
    const q = render(condicion);
    // La tabla es el catálogo, no una constante compilada: eso es TODO el AC6.
    expect(q.sql).toMatch(/"permisos_roles"\."codigo" = \$1/);
    // Y el `activo`: sin esta rama, un rol desactivado se seguiría pudiendo asignar. Es la mitad del
    // predicado que un `select` mockeado jamás notaría ausente.
    expect(q.sql).toMatch(/"permisos_roles"\."activo" = \$2/);
    expect(q.params).toEqual(['cliente', true]);
  });

  it('sin fila devuelve null — que es lo que el handler traduce a 400', async () => {
    const { rolAsignable } = await import('../../src/modules/users/users.service.js');
    filas = [];
    expect(await rolAsignable('rol_inventado')).toBeNull();
  });

  it('pide solo `tipoEnlace`: el catálogo entero no le hace falta a una validación', async () => {
    const { rolAsignable } = await import('../../src/modules/users/users.service.js');
    filas = [{ tipoEnlace: 'ninguno' }];
    await rolAsignable('admin');
    expect(Object.keys(selectMock.mock.calls[0][0] as object)).toEqual(['tipoEnlace']);
    expect(tablaLeida).toBeDefined();
  });
});
