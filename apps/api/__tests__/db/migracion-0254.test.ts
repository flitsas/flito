// HU #13945 (Feature #13939) — La 0254: «Activar o desactivar clientes», primera exclusiva del Administrador.
//
//   · Estática (siempre corre): sin control de transacción propio; siembra EXACTAMENTE la acción del catálogo
//     (`catalogoCompleto()`: padre, nivel, orden, nombre) con `exclusiva_admin = true`; el código la declara exclusiva;
//     repite la limpieza de la 0253 en orden (DELETE roles ≠ admin, DELETE excepciones, INSERT admin).
//   · Contra PostgreSQL (solo con TEST_DATABASE_URL), en tx con ROLLBACK: dos veces sin error; la acción queda en el
//     cuadro de `admin` y marcada; un rol ≠ admin o una excepción de usuario sobre ella se borran; la tercera pasada no
//     cambia nada; y la base queda coherente con el código (lo que compara `verificarCatalogoAlArrancar`).
import { describe, it, expect, vi } from 'vitest';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { catalogoCompleto } from '../../src/modules/permisos/catalogo.js';
import { FUNCIONES_EXCLUSIVAS_ADMIN } from '../../src/modules/permisos/catalogo-operaciones.js';
import { abrirBase, enTx, leerMigracion, URL_BASE } from '../helpers/base-en-tx.js';

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));

const ARCHIVO = '0254_permisos_clientes_activar_desactivar.sql';
const SQL_0254 = leerMigracion(ARCHIVO);
const SIN_COMENTARIOS = SQL_0254.replace(/--[^\n]*/g, '');
const ACCION = 'accion.clientes.activar_desactivar';

describe('0254 — reglas del archivo (análisis estático)', () => {
  it('sin control de transacción propio; INSERT con ON CONFLICT', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0254)).toEqual([]);
    expect(SIN_COMENTARIOS).toMatch(/INSERT INTO permisos_funciones[\s\S]*ON CONFLICT \(codigo\) DO UPDATE/);
    expect(SIN_COMENTARIOS).toMatch(/INSERT INTO permisos_rol_funcion[\s\S]*ON CONFLICT DO NOTHING/);
  });

  it('el código la declara exclusiva y el catálogo la tiene con reparto [admin], con los mismos valores que siembra el SQL', () => {
    expect(FUNCIONES_EXCLUSIVAS_ADMIN).toContain(ACCION);
    const f = catalogoCompleto().find((x) => x.codigo === ACCION);
    expect(f).toMatchObject({ tipo: 'accion', roles: ['admin'], exclusivaAdmin: true, padre: 'pagina.clients', nivel: 3 });
    const fila = `('${ACCION}', '${f!.modulo}', '${f!.nombreNegocio}',\n   '${f!.descripcion}',\n   'accion', '${f!.padre}', '${f!.nivel}', '${f!.orden}', true)`;
    expect(SIN_COMENTARIOS).toContain(fila);
  });

  it('la operación que exigen las guardas nace absorbida: no se siembra en permisos_funciones', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/'clients\.clientes\.estado'/);
    expect(catalogoCompleto().some((x) => x.codigo === 'clients.clientes.estado')).toBe(false);
  });

  it('repite la limpieza de la 0253 en orden: DELETE roles ≠ admin → DELETE excepciones → INSERT admin', () => {
    const i1 = SIN_COMENTARIOS.indexOf('DELETE FROM permisos_rol_funcion');
    const i2 = SIN_COMENTARIOS.indexOf('DELETE FROM permisos_usuario_funcion');
    const i3 = SIN_COMENTARIOS.lastIndexOf('INSERT INTO permisos_rol_funcion'); // el de la 0253 (el 1b es el literal de admin)
    expect(i1).toBeGreaterThan(SIN_COMENTARIOS.indexOf('INSERT INTO permisos_funciones'));
    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThan(i3);
    expect(SIN_COMENTARIOS).toMatch(/rf\.rol_codigo <> 'admin'/);
    expect(SIN_COMENTARIOS.slice(i3)).toMatch(/WHERE f\.exclusiva_admin/);
    // El único literal de rol que siembra es `admin`.
    expect([...SIN_COMENTARIOS.matchAll(/VALUES \('([a-z_]+)', 'accion\.clientes\.activar_desactivar'\)/g)].map((m) => m[1])).toEqual(['admin']);
  });
});

describe.skipIf(!URL_BASE)('0254 — contra PostgreSQL (tx con ROLLBACK)', () => {
  it('dos veces sin error; la acción queda marcada y en el cuadro de admin; base y código coinciden en las exclusivas', async () => {
    const sql = abrirBase();
    try {
      await enTx(sql, async (tx) => {
        await tx.unsafe(SQL_0254);
        await tx.unsafe(SQL_0254);
        const [f] = await tx`SELECT exclusiva_admin, padre_codigo, tipo FROM permisos_funciones WHERE codigo = ${ACCION}`;
        expect(f).toEqual({ exclusiva_admin: true, padre_codigo: 'pagina.clients', tipo: 'accion' });
        const roles = await tx`SELECT rol_codigo FROM permisos_rol_funcion WHERE funcion_codigo = ${ACCION}`;
        expect(roles.map((r) => r.rol_codigo)).toEqual(['admin']);
        const marcadas = await tx`SELECT codigo FROM permisos_funciones WHERE exclusiva_admin ORDER BY codigo`;
        expect(marcadas.map((m) => m.codigo)).toEqual([...FUNCIONES_EXCLUSIVAS_ADMIN].sort());
      });
    } finally {
      await sql.end();
    }
  });

  it('un rol ≠ admin o una excepción de usuario sobre la exclusiva se borran; re-ejecutable', async () => {
    const sql = abrirBase();
    try {
      await enTx(sql, async (tx) => {
        await tx.unsafe(SQL_0254);
        const [rol] = await tx`SELECT codigo FROM permisos_roles WHERE codigo <> 'admin' ORDER BY codigo LIMIT 1`;
        const [u] = await tx`SELECT id FROM users ORDER BY id LIMIT 1`;
        if (!rol || !u) return;
        await tx`DELETE FROM permisos_rol_funcion WHERE rol_codigo = 'admin' AND funcion_codigo = ${ACCION}`;
        await tx`INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES (${rol.codigo}, ${ACCION}) ON CONFLICT DO NOTHING`;
        await tx`DELETE FROM permisos_usuario_funcion WHERE user_id = ${u.id} AND funcion_codigo = ${ACCION}`;
        await tx`INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto) VALUES (${u.id}, ${ACCION}, 'conceder')`;
        const estado = async () => {
          const [r] = await tx`SELECT
            (SELECT count(*)::int FROM permisos_rol_funcion WHERE funcion_codigo = ${ACCION} AND rol_codigo <> 'admin') AS otros,
            (SELECT count(*)::int FROM permisos_rol_funcion WHERE funcion_codigo = ${ACCION} AND rol_codigo = 'admin') AS admin,
            (SELECT count(*)::int FROM permisos_usuario_funcion WHERE funcion_codigo = ${ACCION}) AS usuarios`;
          return r;
        };
        await tx.unsafe(SQL_0254);
        expect(await estado()).toEqual({ otros: 0, admin: 1, usuarios: 0 });
        await tx.unsafe(SQL_0254);
        expect(await estado()).toEqual({ otros: 0, admin: 1, usuarios: 0 });
      });
    } finally {
      await sql.end();
    }
  });
});
