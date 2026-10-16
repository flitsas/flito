// HU #13428 AC7 (diseño §5-ter.1 punto 1) — El invariante anti-bloqueo cuenta sobre el conjunto EXPANDIDO,
// contra PostgreSQL de verdad. La 0237 absorbe `usuarios.usuario.editar` y `permisos.cuadro.guardar`
// (borra sus filas: las concede su acción del árbol); leyendo filas crudas, la cuenta daría 0 y todo
// guardado de usuarios y roles respondería 409.
//
// Sin `TEST_DATABASE_URL` se SALTA (el CI no levanta Postgres):
//     TEST_DATABASE_URL='postgres://operaciones_app:…@127.0.0.1:5434/operaciones_db' \
//     npm run test -w apps/api -- __tests__/db/permisos-anti-bloqueo.expandido.test.ts
// y hay que LEER que no dice `skipped`.
//
// Todo ocurre en UNA transacción que se revierte al final: si la base aún no tiene el árbol (0232..0237)
// se aplican dentro; los usuarios reales se desactivan dentro (para que no sostengan la cuenta); se crea
// un rol interno con un usuario. Nada se confirma.
//
// Los tres casos del diseño:
//   1. rol con SOLO `accion.usuarios.editar` + `accion.roles_permisos.asignar` + las dos páginas → sostiene;
//   2. quitarle la acción al rol → BloqueoAdministracionError (409);
//   3. revocar al usuario la ACCIÓN que su rol le da → 409 («revocar gana»). Revocar la OPERACIÓN absorbida
//      ya no se puede: la 0237 la borra de `permisos_funciones` y la FK de `permisos_usuario_funcion` lo
//      rechaza; lo que el panel puede revocar es la acción (o la página, caso 4).
//   4. revocar al usuario la PÁGINA (no absorbida) aunque su rol la tenga → 409.
// Mutante nombrado: `tiene(F)` sobre filas crudas de F (lo de antes) → el caso 1 lanza.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { BloqueoAdministracionError, conSeguroAntiBloqueo } from '../../src/shared/permisos-anti-bloqueo.js';

const URL = process.env.TEST_DATABASE_URL;
const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/db/migrations');
const ARBOL = [
  '0232_permisos_arbol_gestion_siembra.sql', '0233_permisos_arbol_gestion_reparto.sql',
  '0234_permisos_arbol_finanzas_siembra.sql', '0235_permisos_arbol_finanzas_reparto.sql',
  '0236_permisos_arbol_administracion_siembra.sql', '0237_permisos_arbol_administracion_reparto.sql',
  // HU #13429: con la cadena, el rol de prueba necesita también `menu.administracion` (la 0238 lo siembra).
  '0238_permisos_arbol_legado_siembra.sql', '0239_permisos_arbol_legado_reparto.sql',
];
const ROL = 'zz_prueba13428';
const USUARIO = 'zz_prueba13428_u';

class Revertir extends Error {}

type Tx = Parameters<Parameters<ReturnType<typeof drizzle>['transaction']>[0]>[0];

type Resultado = 'sostiene' | string;

/** Corre `caso` dentro de una transacción con el árbol aplicado y un único administrador candidato; revierte. */
async function enTransaccion(caso: (tx: Tx, userId: number) => Promise<void>): Promise<Resultado> {
  const cliente = postgres(URL ?? '', { max: 1, onnotice: () => {} });
  const db = drizzle(cliente);
  let resultado: Resultado = '';
  try {
    await db.transaction(async (tx) => {
      const [{ hay }] = (await tx.execute(sql`SELECT EXISTS (SELECT 1 FROM permisos_funciones WHERE codigo = 'menu.administracion') AS hay`)) as unknown as { hay: boolean }[];
      if (!hay) for (const f of ARBOL) await tx.execute(sql.raw(readFileSync(path.join(DIR, f), 'utf8')));
      await tx.execute(sql`UPDATE users SET active = false`);
      await tx.execute(sql`INSERT INTO permisos_roles (codigo, nombre, tipo_enlace) VALUES (${ROL}, 'Prueba 13428', 'ninguno')`);
      await tx.execute(sql`INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
        SELECT ${ROL}, c FROM unnest(ARRAY['menu.administracion', 'pagina.users', 'pagina.roles_permisos', 'accion.usuarios.editar', 'accion.roles_permisos.asignar']) AS c`);
      const [{ id }] = (await tx.execute(sql`INSERT INTO users (username, name, password_hash, role, active)
        VALUES (${USUARIO}, 'Prueba 13428', 'x', ${ROL}, true) RETURNING id`)) as unknown as { id: number }[];
      await caso(tx, id);
      try {
        await conSeguroAntiBloqueo(tx, async () => undefined);
        resultado = 'sostiene';
      } catch (e) {
        if (!(e instanceof BloqueoAdministracionError)) throw e;
        resultado = e.funcion;
      }
      throw new Revertir();
    });
  } catch (e) {
    if (!(e instanceof Revertir)) throw e;
  } finally {
    await cliente.end();
  }
  return resultado;
}

describe.skipIf(!URL)('HU #13428 AC7 — anti-bloqueo sobre el conjunto expandido (Postgres real, todo revertido)', () => {
  it('1. un rol con SOLO las acciones (sin filas de las operaciones absorbidas) sostiene el invariante', async () => {
    expect(await enTransaccion(async () => undefined)).toBe('sostiene');
  });

  it('2. sin la acción «Editar usuario» → 409 nombrando la operación que quedó sin titular', async () => {
    const r = await enTransaccion(async (tx) => {
      await tx.execute(sql`DELETE FROM permisos_rol_funcion WHERE rol_codigo = ${ROL} AND funcion_codigo = 'accion.usuarios.editar'`);
    });
    expect(r).toBe('usuarios.usuario.editar');
  });

  it('3. revocar al usuario la ACCIÓN que su rol le da → 409 (revocar gana)', async () => {
    const r = await enTransaccion(async (tx, userId) => {
      await tx.execute(sql`INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto) VALUES (${userId}, 'accion.roles_permisos.asignar', 'revocar')`);
    });
    expect(r).toBe('permisos.cuadro.guardar');
  });

  it('4. revocar al usuario la PÁGINA (no absorbida) aunque su rol la tenga → 409', async () => {
    const r = await enTransaccion(async (tx, userId) => {
      await tx.execute(sql`INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto) VALUES (${userId}, 'pagina.users', 'revocar')`);
    });
    expect(r).toBe('pagina.users');
  });
});
