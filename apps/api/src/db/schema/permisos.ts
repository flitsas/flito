// Tablas del Feature #12072 (permisos: roles, funciones, reparto, excepciones por usuario y bitácora
// de 403). Viven aquí y no en `schema.ts` porque ese archivo está contra el techo de max-lines (3400)
// y este bloque es el que crece HU a HU (#12087/#12171 añaden `permisos_auditoria`). `schema.ts` las
// re-exporta, así que todo importador sigue leyendo `db/schema.js`; nada más cambia.
//
// Import circular a propósito: `users.role` referencia `permisosRoles.codigo` y `permisos_usuario_funcion`
// / `permisos_intentos_denegados` referencian `users.id`. Las FK de Drizzle son callbacks perezosos,
// así que el ciclo ESM resuelve sin problema (`migracion-0178.test.ts` lo comprueba con `getTableConfig`).
import { pgTable, varchar, text, boolean, timestamp, integer, index, uniqueIndex, bigserial, primaryKey, check, jsonb, uuid } from 'drizzle-orm/pg-core';
import { sql, desc } from 'drizzle-orm';
import { CAMPOS_AUDITABLES } from '@operaciones/shared-types';
import { users } from '../schema.js';

// HU #12169 — El catálogo de roles. Sustituye al enum `user_role` como fuente de verdad de qué roles
// existen: aquí una FILA es un rol, y el administrador puede crear y borrar filas (CF-03, CF-05),
// cosa que sobre un enum de Postgres no es difícil, es imposible.
//
// `codigo` es la PK y es INMUTABLE: 276 `requireRole('…')` de `apps/api/src/modules` lo comparan como
// literal, así que renombrarlo no es editar un rol, es cambiar el sistema. Lo editable es `nombre`; la
// FK de `users.role` lo declara con `ON UPDATE RESTRICT` para que lo diga la base y no un comentario.
export const permisosRoles = pgTable('permisos_roles', {
  codigo: varchar('codigo', { length: 40 }).primaryKey(),
  nombre: varchar('nombre', { length: 80 }).notNull(),
  descripcion: text('descripcion'),
  // 'ninguno' | 'compania' | 'proveedor_soat' | 'organismos_transito'. El ROL dice si se enlaza y a
  // QUÉ tipo (RN-A3); el usuario dice a cuál. Lo hacen cumplir los dos triggers de la 0178
  // (`users_ambito_trg` y `users_ambito_organismos_trg`), que Drizzle no sabe declarar.
  tipoEnlace: varchar('tipo_enlace', { length: 24 }).notNull().default('ninguno'),
  // 'interno' | 'externo'. Lo consume el motor (HU #12082): `resolverPermisos` lo devuelve cacheado y
  // `guardiaCanalCliente` dispara la frontera del canal externo por este valor, no por el literal del rol.
  tipoPrincipal: varchar('tipo_principal', { length: 10 }).notNull().default('interno'),
  // Candado de BORRADO (ADR-0015 §Decisión 5), no marca de origen: true ⇒ el rol no se borra. Solo
  // `admin`: el candado temporal de `cliente` lo retiró la 0180 (HU #12082 AC8). Editar sigue permitido (CF-04).
  esSistema: boolean('es_sistema').notNull().default(false),
  // Gobierna la ASIGNACIÓN, no la autenticación: un usuario con rol inactivo sigue entrando.
  activo: boolean('activo').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tipoEnlaceChk: check('permisos_roles_tipo_enlace_chk',
    sql`${t.tipoEnlace} IN ('ninguno','compania','proveedor_soat','organismos_transito')`),
  tipoPrincipalChk: check('permisos_roles_tipo_principal_chk',
    sql`${t.tipoPrincipal} IN ('interno','externo')`),
}));

// HU #12081 — El catálogo de FUNCIONES y el reparto rol × función. Migración 0179.
//
// `permisos_funciones` la declara el PRODUCTO y la siembra la migración (CF-23): el administrador
// reparte funciones, no las inventa. De ahí el `ON DELETE RESTRICT` de las dos puentes hacia aquí y
// el `CASCADE` hacia `permisos_roles`/`users`: borrar un rol o un usuario se lleva SU reparto, pero
// borrar una función que alguien tiene concedida lo impide la base.
// Se genera desde el código: `npm run permisos:seed -w apps/api` (modules/permisos/catalogo.ts).
export const permisosFunciones = pgTable('permisos_funciones', {
  // `pagina.<slug>` o `<modulo>.<objeto>.<accion>`. PK textual e inmutable, como en permisosRoles.
  codigo: varchar('codigo', { length: 80 }).primaryKey(),
  // Agrupa para la pantalla: el grupo de PAGE_GROUPS en las páginas, el módulo en las operaciones.
  modulo: varchar('modulo', { length: 40 }).notNull(),
  nombreNegocio: varchar('nombre_negocio', { length: 120 }).notNull(),
  descripcion: text('descripcion').notNull(),
  tipo: varchar('tipo', { length: 10 }).notNull(),
  activo: boolean('activo').notNull().default(true),
}, (t) => ({
  tipoChk: check('permisos_funciones_tipo_chk', sql`${t.tipo} IN ('pagina','operacion')`),
  moduloIdx: index('idx_permisos_funciones_modulo').on(t.modulo),
}));

/** Lo que un ROL concede: el reparto de partida del AC4, y lo que edita la #12082. */
export const permisosRolFuncion = pgTable('permisos_rol_funcion', {
  rolCodigo: varchar('rol_codigo', { length: 40 }).notNull()
    .references(() => permisosRoles.codigo, { onDelete: 'cascade', onUpdate: 'restrict' }),
  funcionCodigo: varchar('funcion_codigo', { length: 80 }).notNull()
    .references(() => permisosFunciones.codigo, { onDelete: 'restrict', onUpdate: 'restrict' }),
}, (t) => ({
  pk: primaryKey({ columns: [t.rolCodigo, t.funcionCodigo] }),
  funcionIdx: index('idx_permisos_rol_funcion_funcion').on(t.funcionCodigo),
}));

/**
 * La excepción por USUARIO sobre lo que le da su rol. `efecto` es 'conceder' | 'revocar'.
 *
 * Esta HU solo siembra 'conceder' (el backfill de `users.allowed_pages`); 'revocar' no lo escribe
 * nadie todavía y llega con la HU de permisos por usuario. La columna nace igual: partir el modelo
 * en dos migraciones obligaría a reescribir la PK.
 */
export const permisosUsuarioFuncion = pgTable('permisos_usuario_funcion', {
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  funcionCodigo: varchar('funcion_codigo', { length: 80 }).notNull()
    .references(() => permisosFunciones.codigo, { onDelete: 'restrict', onUpdate: 'restrict' }),
  efecto: varchar('efecto', { length: 8 }).notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.funcionCodigo] }),
  efectoChk: check('permisos_usuario_funcion_efecto_chk', sql`${t.efecto} IN ('conceder','revocar')`),
}));

/** HU #12082 / ADR-0016 — contador de 403 por (usuario, funcion, hora). Sin PII; sin FK en rol y funcion a propósito. */
export const permisosIntentosDenegados = pgTable('permisos_intentos_denegados', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
  rolCodigo: varchar('rol_codigo', { length: 40 }).notNull(),
  funcionCodigo: varchar('funcion_codigo', { length: 80 }).notNull(),
  motivo: varchar('motivo', { length: 16 }).notNull(),
  metodo: varchar('metodo', { length: 10 }).notNull(),
  ruta: varchar('ruta', { length: 300 }).notNull(),
  ventanaInicio: timestamp('ventana_inicio', { withTimezone: true }).notNull(),
  primeraVez: timestamp('primera_vez', { withTimezone: true }).notNull().defaultNow(),
  ultimaVez: timestamp('ultima_vez', { withTimezone: true }).notNull().defaultNow(),
  veces: integer('veces').notNull().default(1),
}, (t) => ({
  ventanaUq: uniqueIndex('permisos_intentos_denegados_ventana_uq').on(t.userId, t.funcionCodigo, t.ventanaInicio),
  funcionIdx: index('idx_permisos_intentos_funcion').on(t.funcionCodigo, desc(t.ultimaVez)),
  motivoChk: check('permisos_intentos_denegados_motivo_chk', sql`${t.motivo} IN ('sin_funcion','sin_modulo','no_reconocida','no_resuelto')`),
  vecesChk: check('permisos_intentos_denegados_veces_chk', sql`${t.veces} >= 1`),
}));

/**
 * La lista blanca de `CAMPOS_AUDITABLES` (shared-types) como literales SQL para el CHECK de abajo.
 * Es la MISMA lista que el tipo `CampoAuditable` y que el CHECK de la 0184 (el test de paridad lo
 * compara). Solo se renderizan literales del código —ninguna entrada externa—: regla 3 de AGENTS.md.
 */
const LISTA_CAMPOS_SQL = [...new Set(Object.values(CAMPOS_AUDITABLES).flat())]
  .map((c) => `'${c}'`).join(',');

/**
 * HU #12171 / ADR-0014 — CF-19: historial consultable de cambios de usuarios, roles y permisos.
 *
 * RN-01 (RN-A10 del Feature #12072): del ACTOR se guarda el correo —es el autor del acto y así
 * funciona una bitácora—; del TITULAR solo su id interno y su rol. Su nombre se resuelve por JOIN
 * al leer y NUNCA se copia aquí.
 * RN-02: un par por CAMPO, nunca el documento entero. La lista blanca vive en shared-types y está
 * duplicada como CHECK en la 0184 y aquí abajo: el tipo impide pasar la fila entera, el CHECK impide
 * el INSERT crudo.
 * RN-03: inmutable por REVOKE (0184), no por disparador: la retención de 6 años (`archivar_offline`,
 * mecanismo HU #12215) tiene que poder ejecutarse.
 *
 * Ver ADR-0014 para por qué no son dos columnas nuevas en `audit_logs`.
 */
export const permisosAuditoria = pgTable('permisos_auditoria', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  /** Agrupa las N filas de un mismo acto: un PATCH de 3 campos son 3 filas y 1 lote. */
  loteId: uuid('lote_id').notNull(),
  /** 'usuario' | 'rol' | 'rol_funcion' | 'usuario_funcion'. */
  entidad: varchar('entidad', { length: 20 }).notNull(),
  accion: varchar('accion', { length: 12 }).notNull(),
  /** Null solo en 'borrar'. */
  campo: varchar('campo', { length: 40 }),
  valorAntes: jsonb('valor_antes'),
  valorDespues: jsonb('valor_despues'),
  /** Auditoría (ADR-0005): RESTRICT. Con SET NULL la fila afirma un cambio sin sujeto. */
  usuarioAfectadoId: integer('usuario_afectado_id').references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
  usuarioAfectadoRol: varchar('usuario_afectado_rol', { length: 40 }),
  /** Sin `.references()` A PROPÓSITO: una FK aquí rompe CF-05. Ver el COMMENT de la migración. */
  rolAfectadoCodigo: varchar('rol_afectado_codigo', { length: 40 }),
  /** Auditoría (ADR-0005): RESTRICT. Null = sistema, no «se desconoce» — lo fija `origen`. */
  actorUserId: integer('actor_user_id').references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
  actorEmail: varchar('actor_email', { length: 150 }),
  actorRol: varchar('actor_rol', { length: 40 }),
  ipAddress: varchar('ip_address', { length: 45 }),
  userAgent: varchar('user_agent', { length: 500 }),
  origen: varchar('origen', { length: 20 }).notNull().default('usuario'),
  motivo: text('motivo'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  titularIdx: index('idx_permisos_auditoria_titular').on(t.usuarioAfectadoId, desc(t.createdAt))
    .where(sql`${t.usuarioAfectadoId} IS NOT NULL`),
  rolIdx: index('idx_permisos_auditoria_rol').on(t.rolAfectadoCodigo, desc(t.createdAt))
    .where(sql`${t.rolAfectadoCodigo} IS NOT NULL`),
  entidadIdx: index('idx_permisos_auditoria_entidad').on(t.entidad, desc(t.createdAt)),
  createdIdx: index('idx_permisos_auditoria_created').on(desc(t.createdAt)),
  // Los mismos CHECK que la 0184, con el MISMO nombre: el test de paridad los busca por nombre.
  entidadChk: check('permisos_auditoria_entidad_chk', sql`${t.entidad} IN ('usuario','rol','rol_funcion','usuario_funcion')`),
  accionChk: check('permisos_auditoria_accion_chk', sql`${t.accion} IN ('crear','editar','borrar','baja','reactivar','activar','desactivar')`),
  origenChk: check('permisos_auditoria_origen_chk', sql`${t.origen} IN ('usuario','sistema','auditoria')`),
  sujetoChk: check('permisos_auditoria_sujeto_chk', sql`(${t.usuarioAfectadoId} IS NOT NULL) <> (${t.rolAfectadoCodigo} IS NOT NULL)`),
  titularRolChk: check('permisos_auditoria_titular_rol_chk', sql`(${t.usuarioAfectadoId} IS NULL) = (${t.usuarioAfectadoRol} IS NULL)`),
  actorChk: check('permisos_auditoria_actor_chk', sql`(${t.origen} = 'usuario') = (${t.actorUserId} IS NOT NULL)`),
  campoChk: check('permisos_auditoria_campo_chk', sql`${t.campo} IS NOT NULL OR ${t.accion} = 'borrar'`),
  campoListaChk: check('permisos_auditoria_campo_lista_chk', sql`${t.campo} IS NULL OR ${t.campo} IN (${sql.raw(LISTA_CAMPOS_SQL)})`),
  passwordSinValorChk: check('permisos_auditoria_password_sin_valor_chk', sql`${t.campo} <> 'password' OR (${t.valorAntes} IS NULL AND ${t.valorDespues} IS NULL)`),
}));
