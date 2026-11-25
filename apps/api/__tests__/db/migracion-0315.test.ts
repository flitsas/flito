// Épica #14678 (ADR-0048) — La 0315 (menú por áreas) EJECUTADA sobre una base poblada, dentro de una transacción que
// siempre se deshace (`enTx`). Antes de sembrar, la base vuelve al árbol de antes con el inverso de lo visible
// (`docs/arquitectura/epica-14678-0315-rollback.sql`): sirve en una base con la 0315 ya aplicada (CI, local) y prueba
// de paso el inverso. Fixtures sintéticos (roles `t14678_*`):
//   (a) rol con página efectiva bajo un elemento viejo            → recibe el elemento nuevo (paso 4a);
//   (b) rol con una marca dormida que el elemento nuevo despertaría → se borra (paso 6);
//   (c) usuario con `conceder` del elemento viejo                   → recibe página/elemento nuevo (pasos 7a/7b);
//   (d) usuario con `revocar` de una página                         → sigue sin verla;
//   (e) caso 3.6: `revocar` de `menu.administracion` con Organismos STT por rol → PÉRDIDA DECLARADA (no se evita);
//   (f) N1 (db-review): quien recibe `menu.administracion` por Organismos STT y tenía dormidas Siigo credenciales o
//       Torre · Umbrales no las gana NI con el árbol nuevo NI con el viejo (inverso aplicado): pasos 6 y 8b.
// Criterio: páginas efectivas por rol y por usuario idénticas antes / después (árbol nuevo) / tras el inverso (árbol
// viejo), salvo (e); y la 2.ª corrida no cambia ninguna fila.
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { abrirBase, enTx, leerMigracion, URL_BASE } from '../helpers/base-en-tx.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQL_0315 = leerMigracion('0315_flito_menu_por_areas.sql');
/** El inverso sin su transacción ni el borrado del ledger (aquí manda `enTx`). */
const INVERSO = readFileSync(path.resolve(__dirname, '../../../../docs/arquitectura/epica-14678-0315-rollback.sql'), 'utf8')
  .split('\n').filter((l) => !/^(BEGIN|COMMIT);/.test(l) && !l.includes('_kyverum_applied_migrations')).join('\n');

const R = (s: string) => `t14678_${s}`;
/** Marcas de rol de los fixtures. */
const ROLES: Record<string, string[]> = {
  a: ['menu.gestion', 'pagina.flito_soat', 'accion.soat.ver_listado'],
  b: ['menu.pesv', 'pagina.pesv_plan', 'pagina.laft'], // pagina.laft dormida (sin menu.laft) → Kyverum la despertaría
  c: ['pagina.rndc'], // dormida en el rol; el usuario la ve por su `conceder menu.rndc`
  e: ['menu.transito', 'pagina.transito_organismos'],
  f: ['menu.transito', 'pagina.transito_organismos', 'pagina.siigo_credenciales', 'pagina.torre_umbrales'], // N1, rol
  f2: ['pagina.transito_organismos', 'pagina.siigo_credenciales'], // N1, usuario: ve Organismos por su `conceder`
};
/** Usuarios de los fixtures: [rol, excepciones]. */
const USUARIOS: Record<string, [string, [string, 'conceder' | 'revocar'][]]> = {
  ua: ['a', []],
  ub: ['b', []],
  ub2: ['b', [['menu.laft', 'conceder']]], // veía LAFT por su conceder: el paso 6 se la quita al rol, 7a se la da a él
  uc: ['c', [['menu.rndc', 'conceder']]],
  ud: ['a', [['pagina.flito_soat', 'revocar']]],
  ue: ['e', [['menu.administracion', 'revocar']]],
  uf: ['f', []],
  uf2: ['f2', [['menu.transito', 'conceder']]],
};

type Foto = { roles: string[]; usuarios: string[] };

/** Páginas efectivas (marcada y con su elemento marcado; en el usuario sobre (R ∪ C) \ V) con el padre que hay en la base. */
async function foto(tx: postgres.TransactionSql): Promise<Foto> {
  const roles = await tx`
    SELECT r.rol_codigo || ' ' || f.codigo AS k FROM permisos_rol_funcion r
      JOIN permisos_funciones f ON f.codigo = r.funcion_codigo AND f.tipo = 'pagina'
     WHERE r.rol_codigo LIKE 't14678\\_%'
       AND EXISTS (SELECT 1 FROM permisos_rol_funcion e WHERE e.rol_codigo = r.rol_codigo AND e.funcion_codigo = f.padre_codigo)
     ORDER BY 1`;
  const usuarios = await tx`
    WITH m AS (
      (SELECT u.username, r.funcion_codigo AS codigo FROM users u JOIN permisos_rol_funcion r ON r.rol_codigo = u.role
        WHERE u.username LIKE 't14678\\_%'
       UNION SELECT u.username, k.funcion_codigo FROM permisos_usuario_funcion k JOIN users u ON u.id = k.user_id
        WHERE k.efecto = 'conceder' AND u.username LIKE 't14678\\_%')
      EXCEPT SELECT u.username, k.funcion_codigo FROM permisos_usuario_funcion k JOIN users u ON u.id = k.user_id
        WHERE k.efecto = 'revocar' AND u.username LIKE 't14678\\_%')
    SELECT m.username || ' ' || f.codigo AS k FROM m JOIN permisos_funciones f ON f.codigo = m.codigo AND f.tipo = 'pagina'
     WHERE EXISTS (SELECT 1 FROM m e WHERE e.username = m.username AND e.codigo = f.padre_codigo)
     ORDER BY 1`;
  return { roles: roles.map((x) => x.k as string), usuarios: usuarios.map((x) => x.k as string) };
}

async function filas(tx: postgres.TransactionSql): Promise<string[]> {
  const rs = await tx`
    SELECT 'r ' || rol_codigo || ' ' || funcion_codigo AS k FROM permisos_rol_funcion
    UNION ALL SELECT 'u ' || user_id || ' ' || funcion_codigo || ' ' || efecto FROM permisos_usuario_funcion
    UNION ALL SELECT 'f ' || codigo || ' ' || coalesce(padre_codigo, '-') || ' ' || orden FROM permisos_funciones
    ORDER BY 1`;
  return rs.map((x) => x.k as string);
}

async function sembrar(tx: postgres.TransactionSql): Promise<void> {
  for (const [clave, marcas] of Object.entries(ROLES)) {
    await tx`INSERT INTO permisos_roles (codigo, nombre) VALUES (${R(clave)}, ${'Prueba 0315 ' + clave})`;
    for (const m of marcas) await tx`INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES (${R(clave)}, ${m})`;
  }
  for (const [nombre, [rol, excepciones]] of Object.entries(USUARIOS)) {
    const [u] = await tx`INSERT INTO users (username, name, password_hash, role) VALUES (${R(nombre)}, ${nombre}, 'h', ${R(rol)}) RETURNING id`;
    for (const [codigo, efecto] of excepciones) {
      await tx`INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto) VALUES (${u!.id}, ${codigo}, ${efecto})`;
    }
  }
}

const sin = (xs: string[], fuera: string[]) => xs.filter((x) => !fuera.includes(x));
/** La pérdida declarada del caso 3.6 (e): la migración no puede evitarla. */
const PERDIDA_3_6 = `${R('ue')} pagina.transito_organismos`;

describe.skipIf(!URL_BASE)('0315 — ejecutada sobre una base poblada (en transacción, siempre con ROLLBACK)', () => {
  const sql = URL_BASE ? abrirBase() : (null as unknown as postgres.Sql);
  afterAll(async () => { await sql?.end(); });

  it('pérdidas = 0 y ganancias = 0 con el árbol nuevo y con el viejo (inverso), salvo el 3.6; 2.ª corrida sin cambios', async () => {
    const r = await enTx(sql, async (tx) => {
      await tx.unsafe(INVERSO); // la base vuelve al árbol de antes de la 0315
      await sembrar(tx);
      const antes = await foto(tx);
      await tx.unsafe(SQL_0315);
      const despues = await foto(tx);
      const filasTras1 = await filas(tx);
      await tx.unsafe(SQL_0315);
      const filasTras2 = await filas(tx);
      const padreSoat = await tx`SELECT padre_codigo FROM permisos_funciones WHERE codigo = 'pagina.flito_soat'`;
      const marcasRol = await tx`SELECT rol_codigo || ' ' || funcion_codigo AS k FROM permisos_rol_funcion WHERE rol_codigo LIKE 't14678\\_%' ORDER BY 1`;
      await tx.unsafe(INVERSO); // el árbol viejo otra vez (lo que vería el código anterior)
      const conArbolViejo = await foto(tx);
      return {
        antes, despues, conArbolViejo, filasTras1, filasTras2,
        padreSoat: padreSoat[0]!.padre_codigo as string, marcasRol: marcasRol.map((x) => x.k as string),
      };
    });

    expect(r.padreSoat).toBe('menu.operaciones'); // la migración corrió de verdad
    // Los fixtures ven lo que deben antes (si no, el test no prueba nada).
    expect(r.antes.roles).toEqual(expect.arrayContaining([`${R('a')} pagina.flito_soat`, `${R('b')} pagina.pesv_plan`, `${R('f')} pagina.transito_organismos`]));
    expect(r.antes.usuarios).toEqual(expect.arrayContaining([`${R('ub2')} pagina.laft`, `${R('uc')} pagina.rndc`, PERDIDA_3_6, `${R('uf2')} pagina.transito_organismos`]));
    expect(r.antes.usuarios).not.toContain(`${R('ud')} pagina.flito_soat`);

    // Roles: idénticos con el árbol nuevo y con el viejo.
    expect(r.despues.roles).toEqual(r.antes.roles);
    expect(r.conArbolViejo.roles).toEqual(r.antes.roles);
    // Usuarios: idénticos salvo la pérdida declarada del caso 3.6, con los dos árboles.
    expect(r.despues.usuarios).toEqual(sin(r.antes.usuarios, [PERDIDA_3_6]));
    expect(r.despues.usuarios).not.toContain(PERDIDA_3_6);
    expect(r.conArbolViejo.usuarios.filter((x) => !r.antes.usuarios.includes(x)), 'ganancias con el árbol viejo').toEqual([]);
    expect(r.conArbolViejo.usuarios).toEqual(r.antes.usuarios); // con el árbol viejo el 3.6 vuelve a verla: nada se pierde

    // Pasos concretos: 4a da el elemento nuevo; 6 borra las dormidas (también las de N1).
    expect(r.marcasRol).toEqual(expect.arrayContaining([`${R('a')} menu.operaciones`, `${R('b')} menu.kyverum`, `${R('e')} menu.administracion`, `${R('f')} menu.administracion`]));
    for (const k of [`${R('b')} pagina.laft`, `${R('f')} pagina.siigo_credenciales`, `${R('f')} pagina.torre_umbrales`]) expect(r.marcasRol, k).not.toContain(k);

    // Idempotencia: la 2.ª corrida no cambia ninguna fila.
    expect(r.filasTras2).toEqual(r.filasTras1);
  });
});
