// HU #13429 AC8 (diseño §5-quater.5) — El invariante anti-bloqueo con NIVELES, contra PostgreSQL de verdad: una
// función de administración cuenta solo si alguna alternativa que la concede está marcada con TODA su cadena
// (elemento → ítem → acción), cada eslabón `(rol ∨ conceder) ∧ ¬revocar`. TCs TC-17, TC-18 y TC-19.
//
// Sin `TEST_DATABASE_URL` se SALTA (el CI no levanta Postgres) y un `skipped` NO cuenta como pass:
//     TEST_DATABASE_URL='postgres://operaciones_app:…@127.0.0.1:5434/operaciones_db' \
//     npm run test -w apps/api -- __tests__/db/permisos-anti-bloqueo.niveles.test.ts
//
// Todo ocurre en UNA transacción que se revierte: si la base no tiene el árbol (0232..0239) se aplica dentro; los
// usuarios reales se desactivan dentro; se crean uno o dos roles internos con un usuario cada uno. Nada se confirma.
// Mutante nombrado: `tiene(F)` sin la cadena (solo el código que concede, lo de la #13428) → caen 2, 3, 4 y 5.
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
  '0238_permisos_arbol_legado_siembra.sql', '0239_permisos_arbol_legado_reparto.sql',
];
const CADENA = ['menu.administracion', 'pagina.users', 'pagina.roles_permisos', 'accion.usuarios.editar', 'accion.roles_permisos.asignar'];

class Revertir extends Error {}
type Tx = Parameters<Parameters<ReturnType<typeof drizzle>['transaction']>[0]>[0];

async function crearAdministrador(tx: Tx, rol: string, codigos: readonly string[]): Promise<number> {
  await tx.execute(sql`INSERT INTO permisos_roles (codigo, nombre, tipo_enlace) VALUES (${rol}, ${`Prueba ${rol}`}, 'ninguno')`);
  await tx.execute(sql`INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) SELECT ${rol}, c FROM unnest(ARRAY[${sql.join(codigos.map((c) => sql`${c}`), sql`, `)}]::text[]) AS c`);
  const [{ id }] = (await tx.execute(sql`INSERT INTO users (username, name, password_hash, role, active)
    VALUES (${`${rol}_u`}, 'Prueba 13429', 'x', ${rol}, true) RETURNING id`)) as unknown as { id: number }[];
  return id;
}

/** Corre `caso` en una transacción con el árbol aplicado y UN rol administrador (`zz_a13429`); revierte. */
async function enTransaccion(caso: (tx: Tx, userId: number) => Promise<void>): Promise<string> {
  const cliente = postgres(URL ?? '', { max: 1, onnotice: () => {} });
  const db = drizzle(cliente);
  let resultado = '';
  try {
    await db.transaction(async (tx) => {
      const [{ hay }] = (await tx.execute(sql`SELECT EXISTS (SELECT 1 FROM permisos_funciones WHERE codigo = 'menu.administracion') AS hay`)) as unknown as { hay: boolean }[];
      if (!hay) for (const f of ARBOL) await tx.execute(sql.raw(readFileSync(path.join(DIR, f), 'utf8')));
      await tx.execute(sql`UPDATE users SET active = false`);
      const id = await crearAdministrador(tx, 'zz_a13429', CADENA);
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

const quitar = (codigo: string) => async (tx: Tx) => {
  await tx.execute(sql`DELETE FROM permisos_rol_funcion WHERE rol_codigo = 'zz_a13429' AND funcion_codigo = ${codigo}`);
};

describe.skipIf(!URL)('HU #13429 AC8 — anti-bloqueo con niveles (Postgres real, todo revertido)', () => {
  it('1. el rol con la cadena entera (elemento, ítems y acciones) sostiene el invariante', async () => {
    expect(await enTransaccion(async () => undefined)).toBe('sostiene');
  });

  it('2. TC-17: desmarcar `menu.administracion` (nivel 1) en el último rol → 409, aunque ítems y acciones sigan marcados', async () => {
    expect(await enTransaccion(quitar('menu.administracion'))).toBe('pagina.users');
  });

  it('3. TC-18: desmarcar `pagina.users` (nivel 2) → 409 nombrando la página; la acción de debajo tampoco cuenta', async () => {
    expect(await enTransaccion(quitar('pagina.users'))).toBe('pagina.users');
  });

  it('4. TC-18: desmarcar `pagina.roles_permisos` → 409 nombrando la página', async () => {
    expect(await enTransaccion(quitar('pagina.roles_permisos'))).toBe('pagina.roles_permisos');
  });

  it('5. TC-18: revocar al último usuario el nivel 1 por excepción → 409', async () => {
    const r = await enTransaccion(async (tx, userId) => {
      await tx.execute(sql`INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto) VALUES (${userId}, 'menu.administracion', 'revocar')`);
    });
    expect(r).toBe('pagina.users');
  });

  it('6. TC-19: con DOS roles que sostienen Administración, desmarcarla en uno → sigue sosteniendo', async () => {
    const r = await enTransaccion(async (tx) => {
      await crearAdministrador(tx, 'zz_b13429', CADENA);
      await quitar('menu.administracion')(tx);
    });
    expect(r).toBe('sostiene');
  });

  it('7. P-25 opción A: `conceder` del elemento al usuario cuyo rol no lo tiene completa la cadena y sostiene', async () => {
    const r = await enTransaccion(async (tx, userId) => {
      await quitar('menu.administracion')(tx);
      await tx.execute(sql`INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto) VALUES (${userId}, 'menu.administracion', 'conceder')`);
    });
    expect(r).toBe('sostiene');
  });
});
