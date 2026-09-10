// HU #12084 AC4 — La CONCURRENCIA del invariante anti-bloqueo, contra PostgreSQL de verdad: dos
// transacciones que se retiran la administración la una a la otra, lanzadas en paralelo; exactamente
// una recibe `BloqueoAdministracionError` (409) y en la base queda exactamente un administrador.
//
// Es el PRIMER test de concurrencia real del repo (`flito-bolsas-transito-carrera.test.ts` dice con
// esas palabras que solo la probaría «un Postgres de verdad con dos sesiones»). Sin `TEST_DATABASE_URL`
// se SALTA en vez de fallar (el CI no levanta Postgres):
//     TEST_DATABASE_URL='postgres://operaciones_app:…@127.0.0.1:5434/operaciones_db' \
//     npm run test -w apps/api -- __tests__/db/permisos-anti-bloqueo.concurrencia.test.ts
// y hay que LEER que no dice `skipped`.
//
// ── Aislamiento del censo real ──────────────────────────────────────────────────────────────────
// El invariante se invoca con `funciones = ['zz.prueba12084.administrar']`, una función TEMPORAL que
// este test siembra, para que los administradores reales de la base no sostengan la cuenta. Es la
// única razón por la que el parámetro `funciones` existe en la firma.
//
// ── Datos confirmados, no rollback ──────────────────────────────────────────────────────────────
// Dos sesiones tienen que verse, así que `beforeAll` CONFIRMA un rol `zz_prueba12084` (interno), la
// función temporal, el par en `permisos_rol_funcion` y dos usuarios `zz_prueba12084_x` / `_y`; `afterAll`
// los borra en orden inverso y `beforeAll` empieza borrando restos de una corrida anterior. Todo con
// el prefijo `zz_prueba12084` para que un residuo sea reconocible.
//
// Si la corrida muere entre `beforeAll` y `afterAll`, `verificarCatalogoAlArrancar` TUMBA el API local
// («La base declara y el código no usa: zz.prueba12084.administrar»). Es ruidoso a propósito. Limpieza
// manual, en este orden:
//     DELETE FROM users WHERE username LIKE 'zz_prueba12084%';
//     DELETE FROM permisos_rol_funcion WHERE funcion_codigo = 'zz.prueba12084.administrar';
//     DELETE FROM permisos_funciones WHERE codigo = 'zz.prueba12084.administrar';
//     DELETE FROM permisos_roles WHERE codigo = 'zz_prueba12084';
//
// ── La carrera, y por qué la barrera es de DOS señales ─────────────────────────────────────────
// Cada lado: lock → desactiva al OTRO → señal «escribí» → espera la señal del otro (tope 300 ms) →
// cuenta → señal «conté» → espera la del otro (tope 300 ms) → confirma o lanza.
//   · CON `FOR UPDATE`: A bloquea {X, Y}; B se queda esperando en el lock. A agota los dos topes, cuenta
//     1 (Y sigue activo) y confirma. B despierta, reevalúa (X ya no cuenta), bloquea {Y}, desactiva a
//     Y, cuenta 0 y lanza. Exactamente uno de dos.
//   · SIN `FOR UPDATE` (mutación M3) o con la cuenta FUERA de la transacción (M2): B no espera; los dos
//     escriben, los dos se ven mutuamente «activo» (sin confirmar), los dos cuentan 1 ANTES de que
//     ninguno confirme (la segunda señal lo garantiza) y los dos confirman: cero administradores → rojo.
// La segunda señal es lo que hace determinista la mutación: sin ella, A podría contar después de que
// B confirmara y fallar «por casualidad», y el test seguiría en verde con el código roto.
//
// No limpia `permisos_auditoria`: se invoca el invariante y `tx.update` directos, no los servicios.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { permisosFunciones, permisosRoles, permisosRolFuncion, users } from '../../src/db/schema.js';
import { BloqueoAdministracionError, conSeguroAntiBloqueo } from '../../src/shared/permisos-anti-bloqueo.js';

const URL = process.env.TEST_DATABASE_URL;
const ROL = 'zz_prueba12084';
const FUNCION = 'zz.prueba12084.administrar';
const X = 'zz_prueba12084_x';
const Y = 'zz_prueba12084_y';

/** Una señal que se puede esperar con tope: `await s.esperar(ms)` resuelve al disparo o al tope. */
function senal() {
  let disparar!: () => void;
  const p = new Promise<void>((r) => { disparar = r; });
  return {
    disparar,
    esperar: (ms: number) => Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]),
  };
}

describe.skipIf(!URL)('AC4 — dos administradores que se retiran el permiso a la vez: exactamente uno recibe 409', () => {
  const sql = postgres(URL ?? '', { max: 3, onnotice: () => {} });
  const db = drizzle(sql);
  let idX = 0;
  let idY = 0;

  async function limpiar(): Promise<void> {
    await sql`DELETE FROM users WHERE username LIKE ${`${ROL}%`}`;
    await sql`DELETE FROM permisos_rol_funcion WHERE funcion_codigo = ${FUNCION}`;
    await sql`DELETE FROM permisos_funciones WHERE codigo = ${FUNCION}`;
    await sql`DELETE FROM permisos_roles WHERE codigo = ${ROL}`;
  }

  beforeAll(async () => {
    await limpiar();
    await db.insert(permisosRoles).values({ codigo: ROL, nombre: 'Prueba 12084', tipoEnlace: 'ninguno', tipoPrincipal: 'interno' });
    await db.insert(permisosFunciones).values({ codigo: FUNCION, modulo: 'zz', nombreNegocio: 'Prueba', descripcion: 'Temporal del test de la HU #12084.', tipo: 'operacion' });
    await db.insert(permisosRolFuncion).values({ rolCodigo: ROL, funcionCodigo: FUNCION });
    const filas = await db.insert(users).values([
      { username: X, name: 'Prueba X', passwordHash: 'x', role: ROL, active: true },
      { username: Y, name: 'Prueba Y', passwordHash: 'x', role: ROL, active: true },
    ]).returning({ id: users.id, username: users.username });
    idX = filas.find((f) => f.username === X)!.id;
    idY = filas.find((f) => f.username === Y)!.id;
  });

  afterAll(async () => {
    await limpiar();
    await sql.end();
  });

  const activos = async () => Number((await sql`SELECT count(*)::int AS n FROM users WHERE role = ${ROL} AND active`)[0]!.n);

  /**
   * Un lado de la carrera: desactiva al otro administrador dentro del invariante, con las dos
   * señales de la barrera. Devuelve `'ok'` si confirmó o el error si lanzó.
   */
  function lado(objetivo: number, mias: { escribi: ReturnType<typeof senal>; conte: ReturnType<typeof senal> }, otras: typeof mias) {
    return db.transaction(async (tx) => {
      await conSeguroAntiBloqueo(tx, async () => {
        await tx.update(users).set({ active: false }).where(eq(users.id, objetivo));
        mias.escribi.disparar();
        await otras.escribi.esperar(300);
      }, [FUNCION]);
      mias.conte.disparar();
      await otras.conte.esperar(300);
      return 'ok' as const;
    }).catch((e: unknown) => e);
  }

  it('con barrera: A escribe y espera; B se queda en el lock; al final uno confirma y el otro recibe BloqueoAdministracionError', async () => {
    expect(await activos()).toBe(2);
    const a = { escribi: senal(), conte: senal() };
    const b = { escribi: senal(), conte: senal() };

    const pa = lado(idX, a, b);
    // B arranca cuando A ya escribió (y ya tiene el lock): es el escenario de §4.4 del diseño.
    await a.escribi.esperar(300);
    const pb = lado(idY, b, a);
    const [ra, rb] = await Promise.all([pa, pb]);

    const errores = [ra, rb].filter((r) => r instanceof BloqueoAdministracionError);
    const oks = [ra, rb].filter((r) => r === 'ok');
    expect(errores, `resultados: ${String(ra)} / ${String(rb)}`).toHaveLength(1);
    expect(oks).toHaveLength(1);
    expect((errores[0] as BloqueoAdministracionError).funcion).toBe(FUNCION);
    // Ninguno de los dos murió por otra cosa (un deadlock 40P01 sería un Error que no es el nuestro).
    expect([ra, rb].every((r) => r === 'ok' || r instanceof BloqueoAdministracionError)).toBe(true);
    // Y en la base queda EXACTAMENTE uno: el que la transacción rechazada intentó desactivar, revertido.
    expect(await activos()).toBe(1);
  });

  it('sin barrera, cinco veces seguidas: siempre exactamente uno de dos', async () => {
    for (let i = 0; i < 5; i++) {
      await sql`UPDATE users SET active = true WHERE role = ${ROL}`;
      const a = { escribi: senal(), conte: senal() };
      const b = { escribi: senal(), conte: senal() };
      const [ra, rb] = await Promise.all([lado(idX, a, b), lado(idY, b, a)]);
      const errores = [ra, rb].filter((r) => r instanceof BloqueoAdministracionError);
      expect(errores, `vuelta ${i}: ${String(ra)} / ${String(rb)}`).toHaveLength(1);
      expect([ra, rb].filter((r) => r === 'ok')).toHaveLength(1);
      expect(await activos()).toBe(1);
    }
  });

  it('un usuario con la función REVOCADA a título personal no sostiene la cuenta (rama V del resolutor)', async () => {
    await sql`UPDATE users SET active = true WHERE role = ${ROL}`;
    // Y la tiene revocada: solo X cuenta. Desactivar a X debe lanzar aunque Y siga activo.
    await sql`INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto) VALUES (${idY}, ${FUNCION}, 'revocar')`;
    try {
      const r = await db.transaction(async (tx) => conSeguroAntiBloqueo(tx, async () => {
        await tx.update(users).set({ active: false }).where(eq(users.id, idX));
      }, [FUNCION])).catch((e: unknown) => e);
      expect(r).toBeInstanceOf(BloqueoAdministracionError);
      expect(await activos()).toBe(2);
    } finally {
      await sql`DELETE FROM permisos_usuario_funcion WHERE user_id = ${idY} AND funcion_codigo = ${FUNCION}`;
    }
  });
});
