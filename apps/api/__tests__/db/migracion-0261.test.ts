// HU #13958 (Feature #13940) — La 0261: «Activar o desactivar proveedores», exclusiva del Administrador (molde de la
// 0255 y la 0258). «Eliminar proveedores» no está aquí: sin ruta DELETE no tendría guarda viva (la siembra esa HU).
//
//   · Estática (siempre corre): sin control de transacción propio; siembra EXACTAMENTE la acción del catálogo
//     (`catalogoCompleto()`: padre, nivel, orden, nombre) con `exclusiva_admin = true`; el código la declara exclusiva;
//     la operación de las guardas no se siembra; repite la limpieza de la 0253 en orden.
//   · Contra PostgreSQL (solo con TEST_DATABASE_URL), en tx con ROLLBACK: dos veces sin error; la acción queda en el
//     cuadro de `admin` y marcada; un rol ≠ admin o una excepción de usuario sobre ella se borran (AC7: la base no
//     admite repartirla; la API ya responde 409 vía `FUNCIONES_EXCLUSIVAS_ADMIN`); re-ejecutable.
import { describe, it, expect, vi } from 'vitest';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { catalogoCompleto } from '../../src/modules/permisos/catalogo.js';
import { FUNCIONES_EXCLUSIVAS_ADMIN } from '../../src/modules/permisos/catalogo-operaciones.js';
import { abrirBase, enTx, leerMigracion, URL_BASE } from '../helpers/base-en-tx.js';

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));

const ARCHIVO = '0261_permisos_proveedores_soat_estado.sql';
const SQL_0261 = leerMigracion(ARCHIVO);
const SIN_COMENTARIOS = SQL_0261.replace(/--[^\n]*/g, '');
const ACCIONES = ['accion.clientes.activar_desactivar_proveedores'];
const OPERACIONES = ['parametrizacion.proveedores.estado'];

describe('0261 — reglas del archivo (análisis estático)', () => {
  it('sin control de transacción propio; INSERT con ON CONFLICT', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0261)).toEqual([]);
    expect(SIN_COMENTARIOS).toMatch(/INSERT INTO permisos_funciones[\s\S]*ON CONFLICT \(codigo\) DO UPDATE/);
    expect(SIN_COMENTARIOS).toMatch(/INSERT INTO permisos_rol_funcion[\s\S]*ON CONFLICT DO NOTHING/);
  });

  it.each(ACCIONES)('%s: el código la declara exclusiva y el catálogo la tiene con reparto [admin], con los valores que siembra el SQL', (accion) => {
    expect(FUNCIONES_EXCLUSIVAS_ADMIN).toContain(accion);
    const f = catalogoCompleto().find((x) => x.codigo === accion);
    expect(f).toMatchObject({ tipo: 'accion', roles: ['admin'], exclusivaAdmin: true, padre: 'pagina.clients', nivel: 3 });
    const fila = `('${accion}', '${f!.modulo}', '${f!.nombreNegocio}',\n   '${f!.descripcion}',\n   'accion', '${f!.padre}', '${f!.nivel}', '${f!.orden}', true)`;
    expect(SIN_COMENTARIOS).toContain(fila);
  });

  it('la operación que exigen las guardas nace absorbida: no se siembra en permisos_funciones', () => {
    for (const op of OPERACIONES) {
      expect(SIN_COMENTARIOS).not.toContain(`'${op}'`);
      expect(catalogoCompleto().some((x) => x.codigo === op)).toBe(false);
    }
  });

  it('repite la limpieza de la 0253 en orden: DELETE roles ≠ admin → DELETE excepciones → INSERT admin', () => {
    const i1 = SIN_COMENTARIOS.indexOf('DELETE FROM permisos_rol_funcion');
    const i2 = SIN_COMENTARIOS.indexOf('DELETE FROM permisos_usuario_funcion');
    const i3 = SIN_COMENTARIOS.lastIndexOf('INSERT INTO permisos_rol_funcion');
    expect(i1).toBeGreaterThan(SIN_COMENTARIOS.indexOf('INSERT INTO permisos_funciones'));
    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThan(i3);
    expect(SIN_COMENTARIOS).toMatch(/rf\.rol_codigo <> 'admin'/);
    expect(SIN_COMENTARIOS.slice(i3)).toMatch(/WHERE f\.exclusiva_admin/);
    // El único literal de rol que siembra es `admin`.
    expect([...SIN_COMENTARIOS.matchAll(/\('([a-z_]+)', 'accion\.clientes\.[a-z_]+_proveedores'\)/g)].map((m) => m[1]))
      .toEqual(['admin']);
  });
});

describe.skipIf(!URL_BASE)('0261 — contra PostgreSQL (tx con ROLLBACK)', () => {
  it('dos veces sin error; la acción queda marcada y en el cuadro de admin; base y código coinciden en las exclusivas', async () => {
    const sql = abrirBase();
    try {
      await enTx(sql, async (tx) => {
        await tx.unsafe(SQL_0261);
        await tx.unsafe(SQL_0261);
        for (const accion of ACCIONES) {
          const [f] = await tx`SELECT exclusiva_admin, padre_codigo, tipo FROM permisos_funciones WHERE codigo = ${accion}`;
          expect(f).toEqual({ exclusiva_admin: true, padre_codigo: 'pagina.clients', tipo: 'accion' });
          const roles = await tx`SELECT rol_codigo FROM permisos_rol_funcion WHERE funcion_codigo = ${accion}`;
          expect(roles.map((r) => r.rol_codigo)).toEqual(['admin']);
        }
        const marcadas = await tx`SELECT codigo FROM permisos_funciones WHERE exclusiva_admin ORDER BY codigo`;
        expect(marcadas.map((m) => m.codigo)).toEqual([...FUNCIONES_EXCLUSIVAS_ADMIN].sort());
      });
    } finally {
      await sql.end();
    }
  });

  it('AC7: un rol ≠ admin o una excepción de usuario sobre la exclusiva se borran; re-ejecutable', async () => {
    const sql = abrirBase();
    try {
      await enTx(sql, async (tx) => {
        await tx.unsafe(SQL_0261);
        const [rol] = await tx`SELECT codigo FROM permisos_roles WHERE codigo <> 'admin' ORDER BY codigo LIMIT 1`;
        const [u] = await tx`SELECT id FROM users ORDER BY id LIMIT 1`;
        if (!rol || !u) return;
        for (const accion of ACCIONES) {
          await tx`DELETE FROM permisos_rol_funcion WHERE rol_codigo = 'admin' AND funcion_codigo = ${accion}`;
          await tx`INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES (${rol.codigo}, ${accion}) ON CONFLICT DO NOTHING`;
          await tx`DELETE FROM permisos_usuario_funcion WHERE user_id = ${u.id} AND funcion_codigo = ${accion}`;
          await tx`INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto) VALUES (${u.id}, ${accion}, 'conceder')`;
        }
        const estado = async () => {
          const [r] = await tx`SELECT
            (SELECT count(*)::int FROM permisos_rol_funcion WHERE funcion_codigo IN ${tx(ACCIONES)} AND rol_codigo <> 'admin') AS otros,
            (SELECT count(*)::int FROM permisos_rol_funcion WHERE funcion_codigo IN ${tx(ACCIONES)} AND rol_codigo = 'admin') AS admin,
            (SELECT count(*)::int FROM permisos_usuario_funcion WHERE funcion_codigo IN ${tx(ACCIONES)}) AS usuarios`;
          return r;
        };
        await tx.unsafe(SQL_0261);
        expect(await estado()).toEqual({ otros: 0, admin: 1, usuarios: 0 });
        await tx.unsafe(SQL_0261);
        expect(await estado()).toEqual({ otros: 0, admin: 1, usuarios: 0 });
      });
    } finally {
      await sql.end();
    }
  });
});
