// HU #12084 (Feature #12072, CF-12, RN-A1) — El invariante anti-bloqueo: el sistema nunca se queda
// sin nadie que pueda administrar permisos ni sin nadie que pueda administrar usuarios.
// HU #13424 (ADR-0022 §D3) — y ese «alguien» es UNA persona: las cuatro funciones en el mismo usuario.
//
// ── Qué afirma ──────────────────────────────────────────────────────────────────────────────────
//
// «Tras esta escritura sigue habiendo al menos UN usuario activo, vivo, de un rol INTERNO, cuyo
// conjunto efectivo contiene A LA VEZ todas las `FUNCIONES_DE_ADMINISTRACION`.» Hasta la HU #13424
// bastaba un titular por función (podían ser dos personas distintas); ahora es la conjunción, y no
// mira el NOMBRE del rol: `admin` es un rol editable más (ADR-0022 §D1). El conjunto efectivo
// es la regla del resolutor (`permisos-efectivos.ts`, `(R ∪ C) \ V`) escrita en SQL para `operacion.*`:
// la tiene si su rol se la da O se la concedieron a título personal, Y no se la revocaron. Sin las
// dos ramas de `permisos_usuario_funcion` el invariante ignoraría a quien la tiene concedida y, peor,
// contaría a quien la tiene REVOCADA. No se llama a `resolverPermisos()` porque ese lee de la caché y
// de `db`, no de la transacción abierta, y no vería la escritura propia.
//
// Y exige rol `interno`: un `admin` pasado a `externo` no puede llegar a `/api/permisos/roles` porque
// `guardiaCanalCliente` lo cierra antes de que `exigirFuncion` mire el conjunto.
//
// ── Por qué un ENVOLTORIO y no una simulación ───────────────────────────────────────────────────
//
// Cinco caminos pueden dejar el sistema cerrado: dar de baja a un usuario (#12089), desactivarlo,
// cambiarle el rol, editar el cuadro de un rol y borrar un rol. Simular «qué pasaría si» obligaría a
// cinco ramas del predicado, una por forma de cambio: la comprobación copiada cinco veces con otro
// disfraz. Aquí se ESCRIBE y se cuenta el estado resultante en la misma transacción: el SELECT ve la
// escritura propia sin confirmar, y si la cuenta es cero se lanza y la transacción revierte. Deshacer
// una escritura ya hecha es gratis en Postgres.
//
// ── El orden es lo que aguanta la concurrencia (AC4) ────────────────────────────────────────────
//
//   1. BLOQUEAR PRIMERO la población que hoy sostiene la administración: `SELECT … FOR UPDATE OF
//      users ORDER BY id`. Solo las filas de `users` que cuentan (dos en DEV), no toda la tabla.
//   2. Ejecutar la escritura.
//   3. Contar a quien reúne TODAS. Cero → `BloqueoAdministracionError` → la ruta responde 409.
//
// El lock (paso 1) sigue con `OR` y no con `AND`, a propósito: la población bloqueada tiene que ser un
// SUPERCONJUNTO de la contada. Bloquear solo a quien ya tiene las cuatro dejaría sin lock a quien está
// a una escritura concurrente de completarlas.
//
// Dos administradores que se retiran el permiso el uno al otro: A bloquea {X, Y}, escribe, cuenta
// (X ya no cuenta, Y sí) y confirma. B se quedó esperando en X; al despertar, `FOR UPDATE` reevalúa
// la fila con el estado confirmado de A (READ COMMITTED), X sale del conjunto, B bloquea {Y}, escribe
// y cuenta cero → 409. Sin `FOR UPDATE` los dos contarían al otro como administrador y los dos
// confirmarían: cero administradores. El lock va ANTES de la escritura y en orden fijo por `id` para
// que dos operaciones que bloqueen primero su propio objetivo y después la población no se crucen
// (`40P01`).
//
// Orden que cumplen los CINCO caminos: POBLACIÓN PRIMERO, el objetivo propio después. Siempre que
// una transacción vaya a tomar P, `conSeguroAntiBloqueo` es lo PRIMERO que corre dentro de ella, y
// cualquier `FOR UPDATE` sobre su propio objetivo va DENTRO del envoltorio:
//   · `actualizarUsuario` y `cambiarActivo` (users.service.ts): P → `for('update')` del titular
//     (re-bloquear una fila propia es un no-op) → `UPDATE users` (su `KEY SHARE` sobre
//     `permisos_roles` también queda después de P).
//   · `guardarCuadro`, `borrarRol` y `editarRol` con `tipoPrincipal` (permisos-roles.service.ts):
//     P → `for('update')` de la fila de `permisos_roles` → escritura.
//   · `editarRol` SIN `tipoPrincipal` no toma P: su `FOR UPDATE` del rol va solo y no puede cruzarse.
// Un `FOR UPDATE` del rol ANTES de P (como tenían `borrarRol` y `editarRol` hasta el db-review de la
// HU #12084) contra `guardarCuadro` del mismo rol era un `40P01` servido como 500.
//
// Descartado: `pg_advisory_xact_lock` (sirve, pero el AC nombra `SELECT … FOR UPDATE` sobre las filas
// afectadas y la mutación «quitarle el FOR UPDATE» tiene que ser observable) y `SERIALIZABLE`
// (reintentos `40001` en cinco rutas).
//
// ── Si ya hay cero administradores ──────────────────────────────────────────────────────────────
//
// El invariante rechaza TODA operación de las cinco, incluida la que intente arreglarlo. No hay ruta
// que lo cause; si un día ocurre, la vía es `psql`, marcándole las cuatro al rol (interno) que deba
// tenerlas —`<rol>` es su código; sin preferencia de nombre—:
//     INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
//       VALUES ('<rol>', 'pagina.users'), ('<rol>', 'usuarios.usuario.editar'),
//              ('<rol>', 'pagina.roles_permisos'), ('<rol>', 'permisos.cuadro.guardar')
//       ON CONFLICT DO NOTHING;
//
// Vive en `shared/` y no en `modules/permisos/`: lo invocan `users.service.ts` y
// `permisos-roles.service.ts`, y colgarlo de un módulo crearía la dependencia entre hermanos que
// `shared/historial/permisos-auditoria.ts` evitó con el mismo argumento.
import { and, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { db } from '../db/client.js';
import { permisosRoles, permisosRolFuncion, permisosUsuarioFuncion, users } from '../db/schema.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Lo que el invariante necesita del ejecutor: solo `select`. Una transacción abierta lo cumple. */
export type EjecutorSeguro = Pick<Tx, 'select'>;

/**
 * Lo que el panel llama «Usuarios» y «Roles y permisos» (HU #13424, decisión P-2 del PO): la página
 * y la función de API de cada uno. Sin la `pagina.*`, quien conserva la función de API queda fuera
 * de la SPA y su única salida es `curl`/`psql`: eso también es un bloqueo.
 */
export const FUNCIONES_DE_ADMINISTRACION = [
  'pagina.users', 'usuarios.usuario.editar', 'pagina.roles_permisos', 'permisos.cuadro.guardar',
] as const;

/**
 * HU #12089 — un usuario «vivo» es el que no está dado de baja. Se usa en el lock y en la cuenta del
 * invariante anti-bloqueo: quien tiene `deleted_at` no sostiene la administración.
 */
export const CONDICION_USUARIO_VIVO: SQL = isNull(users.deletedAt);

export const MENSAJE_BLOQUEO_ADMINISTRACION =
  'No se puede guardar: FLITO se quedaría sin ningún usuario activo que pueda administrar Usuarios y Roles y permisos.';

/**
 * `funcion`: la primera de las funciones que se quedó sin ningún titular, o —si cada una conserva
 * alguno pero nadie las reúne todas— la primera de la lista. Contrato 409 `{ error, funcion }`.
 */
export class BloqueoAdministracionError extends Error {
  constructor(public readonly funcion: string) {
    super(MENSAJE_BLOQUEO_ADMINISTRACION);
    this.name = 'BloqueoAdministracionError';
  }
}

/**
 * `tiene(F)` para la fila de `users` del FROM exterior: la regla del resolutor para `operacion.*`.
 * Se escribe con el `sql` parametrizado de drizzle (tablas y columnas interpoladas, `F` como
 * parámetro; ningún `sql.raw`) y NO con `tx.select(...)` en los EXISTS, a propósito: cada subconsulta
 * construida con el builder es una llamada más a `select` sobre el ejecutor, y los specs que
 * encolan respuestas por posición (`selectMock.mockReturnValueOnce`) se desordenan con seis llamadas
 * invisibles. Así el invariante cuesta exactamente DOS `select`: el lock y la cuenta.
 */
function tiene(funcion: string): SQL {
  const porRol = sql`exists (select 1 from ${permisosRolFuncion} where ${permisosRolFuncion.rolCodigo} = ${users.role} and ${permisosRolFuncion.funcionCodigo} = ${funcion})`;
  const concedida = sql`exists (select 1 from ${permisosUsuarioFuncion} where ${permisosUsuarioFuncion.userId} = ${users.id} and ${permisosUsuarioFuncion.funcionCodigo} = ${funcion} and ${permisosUsuarioFuncion.efecto} = ${'conceder'})`;
  const revocada = sql`exists (select 1 from ${permisosUsuarioFuncion} where ${permisosUsuarioFuncion.userId} = ${users.id} and ${permisosUsuarioFuncion.funcionCodigo} = ${funcion} and ${permisosUsuarioFuncion.efecto} = ${'revocar'})`;
  return sql`((${porRol} or ${concedida}) and not ${revocada})`;
}

/** Activo, vivo y de rol interno: la población que puede administrar. */
function poblacionAdministradora(): SQL {
  return and(eq(users.active, true), eq(permisosRoles.tipoPrincipal, 'interno'), CONDICION_USUARIO_VIVO)!;
}

/**
 * 1) bloquea la población administradora, 2) ejecuta la escritura, 3) comprueba; si nadie reúne todas
 * las funciones, lanza `BloqueoAdministracionError` y la transacción que envuelve revierte.
 *
 * `funciones` existe SOLO para el test de concurrencia, que cuenta sobre una función temporal para
 * no depender de los administradores reales de la base. Producción no lo pasa.
 */
export async function conSeguroAntiBloqueo<T>(
  tx: EjecutorSeguro,
  escritura: () => Promise<T>,
  funciones: readonly string[] = FUNCIONES_DE_ADMINISTRACION,
): Promise<T> {
  // 1. El lock, PRIMERO y en orden fijo. `OF users`: solo las filas de la tabla principal.
  await tx.select({ id: users.id }).from(users)
    .innerJoin(permisosRoles, eq(permisosRoles.codigo, users.role))
    .where(and(poblacionAdministradora(), or(...funciones.map((f) => tiene(f)))))
    .orderBy(users.id)
    .for('update', { of: users });

  // 2. La escritura.
  const resultado = await escritura();

  // 3. La cuenta, en la misma transacción: ve la escritura propia sin confirmar. `todas` es la que
  // decide (la conjunción en el MISMO usuario); las `f<i>` solo eligen qué función nombrar en el 409.
  const contadores: Record<string, SQL<number>> = {
    todas: sql<number>`count(*) filter (where ${sql.join(funciones.map((f) => tiene(f)), sql` and `)})::int`,
  };
  for (const [i, f] of funciones.entries()) {
    contadores[`f${i}`] = sql<number>`count(*) filter (where ${tiene(f)})::int`;
  }
  const [fila] = await tx.select(contadores).from(users)
    .innerJoin(permisosRoles, eq(permisosRoles.codigo, users.role))
    .where(poblacionAdministradora());
  const leer = (k: string) => Number((fila as Record<string, unknown> | undefined)?.[k] ?? 0);
  if (leer('todas') === 0) {
    const huerfana = funciones.find((_, i) => leer(`f${i}`) === 0) ?? funciones[0];
    throw new BloqueoAdministracionError(huerfana);
  }
  return resultado;
}
