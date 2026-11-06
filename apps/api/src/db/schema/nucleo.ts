// Núcleo: usuarios, compañías, bitácoras (auditoría, PII, RUM), locks/KV, outbox de correo, cuentas de cobro y atadura gestor-organismo. Se re-exporta desde `../schema.ts` (HU #13984).
import {
  pgTable, serial, varchar, text, boolean, timestamp, integer, pgEnum, index, uniqueIndex, jsonb, numeric,
  bigserial, uuid, smallint, doublePrecision, primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { flitoProveedoresLogistica } from './flito-logistica.js';
import { permisosRoles } from './permisos.js';
import { flitoProveedoresSoat } from './soat.js';
import { organismosTransitoConfig } from './tramites.js';

// OBSOLETO desde la migración 0178 (HU #12169): la fuente de verdad de qué roles existen es la tabla
// `permisosRoles`, no este tipo. Ninguna columna lo usa ya — `users.role` pasó a varchar(40) con FK
// al catálogo. Se CONSERVA declarado (y el tipo se conserva en la base) porque es la única vía de
// vuelta si hubiera que revertir la 0178; borrar la constante no borraría el tipo y dejaría este
// archivo diciendo menos de lo que la base contiene. NO añadirle valores: un rol nuevo es una FILA.
// (`operaciones` sigue vivo en el enum de Postgres, deprecado y sin usuarios; nunca entró al literal
// y tampoco entra al catálogo, porque se fusionó en `admin`.)
export const roleEnum = pgEnum('user_role', ['admin', 'proveedor', 'transito', 'compliance', 'lider_pesv', 'supervisor_flota', 'conductor', 'auditor', 'gestor_impuestos', 'mensajero', 'financiera', 'cliente']);

export const auditActionEnum = pgEnum('audit_action', [
  'login', 'login_failed', 'logout',
  'create', 'update', 'delete',
  'upload', 'export', 'purchase',
  'wo_open', 'wo_close', 'stock_adjust',
  'view',  // mig 0069 — para audit de visualización de evidencias PESV (Ley 1581 + ONAC)
]);

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  username: varchar('username', { length: 50 }).notNull().unique(),
  name: varchar('name', { length: 100 }).notNull(),
  email: varchar('email', { length: 150 }),
  passwordHash: text('password_hash').notNull(),
  // HU #12169: era `roleEnum('role')`. Ahora es el CÓDIGO de una fila de `permisos_roles`.
  // `ON DELETE RESTRICT` = CF-05/RN-A8 (un rol con usuarios no se borra, y lo impide la base);
  // `ON UPDATE RESTRICT` = el código es inmutable (ver la cabecera de `permisosRoles`).
  role: varchar('role', { length: 40 }).notNull()
    .references(() => permisosRoles.codigo, { onDelete: 'restrict', onUpdate: 'restrict' }),
  active: boolean('active').notNull().default(true),
  /**
   * OBSOLETA desde la HU #12087: congelada en la foto de la 0188. NO se escribe más, NO se lee para
   * decidir; la fuente de las páginas por usuario es `permisos_usuario_funcion` (filas `conceder`/
   * `revocar pagina.<slug>`), que lee `shared/permisos-efectivos.ts`. No se borra (AC6): la fila del
   * listado la sigue devolviendo tal cual y la SPA ya no la lee.
   */
  allowedPages: text('allowed_pages').array().notNull().default(sql`'{}'::text[]`),
  /**
   * OBSOLETA desde HU #12088. Fuente única de organismos_transito = `flito_gestor_organismos`.
   * Se conserva NULL tras backfill 0189; no DROP. JWT/bandeja leen el 1.er código de la puente.
   * No se escribe más desde la API (writes fuerzan null).
   */
  transitoCodigo: varchar('transito_codigo', { length: 5 }),
  esMecanico: boolean('es_mecanico').notNull().default(false),
  especialidades: text('especialidades').array().notNull().default(sql`'{}'::text[]`),
  esConductor: boolean('es_conductor').notNull().default(false),
  // FLITO (migración): atadura de visibilidad del gestor SOAT (rol `proveedor`) a su
  // proveedor SOAT — hace cumplir CA-09 en la consulta.
  //
  // El gestor de impuestos NO vive aquí: desde la HU #12053 su atadura (CA-10) es la tabla
  // `flito_gestor_organismos`, porque son VARIOS organismos y `transito_codigo` solo guardaba uno
  // —y además es del rol `transito`—. Para un `gestor_impuestos`, `transito_codigo` queda NULL
  // desde la migración 0173: fuente única, sin segundo inquilino.
  flitoProveedorSoatId: uuid('flito_proveedor_soat_id').references((): any => flitoProveedoresSoat.id),
  /**
   * FLITO — Cliente (Feature #11912): la compañía de la que es este usuario. Es la atadura de
   * visibilidad del rol `cliente`, igual que `flitoProveedorSoatId` lo es del gestor: `contextoSoat()`
   * la lee de AQUÍ y no del JWT, para que un cambio de compañía surta efecto sin re-emitir el token.
   *
   * NULLABLE en la base a propósito, como `transitoCodigo`: la mayoría de los roles no tienen
   * compañía y un `NOT NULL` obligaría a inventarle una a cada admin. La obligatoriedad es
   * CONDICIONAL AL ROL y desde la migración 0178 (HU #12169) ya no la sostiene un CHECK: el
   * `users_cliente_compania_chk` de la 0168 —que nombraba el literal 'cliente'— se ELIMINÓ y en su
   * lugar está el `CONSTRAINT TRIGGER users_ambito_trg`, que lee `permisos_roles.tipo_enlace` del rol
   * de la fila. Drizzle tampoco lo declara aquí, ahora por otro motivo: no tiene primitiva para
   * `CREATE CONSTRAINT TRIGGER`. Vive solo en el SQL de la 0178.
   *
   * El cambio no es de estilo: un CHECK no puede consultar otra tabla, así que jamás habría cubierto
   * un rol NUEVO creado por el administrador con `tipo_enlace = 'compania'`.
   *
   * `ON DELETE RESTRICT` explícito (ADR-0008 §3): `CASCADE` borraría usuarios al borrar una
   * compañía, y `SET NULL` crearía por la puerta de atrás justo el estado que el AC2 declara
   * imposible — un `cliente` sin compañía.
   */
  // El `(): any` es el mismo truco que `flitoProveedorSoatId` de arriba, y por el mismo motivo:
  // `clients` se declara DESPUÉS de `users`, así que sin la anotación TypeScript no puede inferir el
  // tipo de ninguna de las dos tablas (TS7022) y `db.select().from(users)` degrada a `any` en todo
  // el proyecto.
  companiaId: integer('compania_id').references((): any => clients.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  sessionInvalidatedAt: timestamp('session_invalidated_at', { withTimezone: true }),
  /**
   * HU #12089 — baja lógica. NULL = en alta. Independiente de `active` (suspensión temporal).
   * La fila sigue existiendo: username/email NO se liberan. Nunca hard-delete de `users`.
   */
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  /** Actor de la baja; `ON DELETE RESTRICT` = nadie borra la fila del actor mientras haya bajas suyas. */
  deletedBy: integer('deleted_by').references((): any => users.id, { onDelete: 'restrict' }),
}, (t) => ({
  // Sirve al listado de usuarios por compañía y, sobre todo, al `ON DELETE RESTRICT`: sin él, borrar
  // una compañía escanea `users` entera para comprobar que nadie la referencia.
  companiaIdx: index('idx_users_compania').on(t.companiaId),
  // HU #12169: mismo argumento que el de arriba, para el `ON DELETE RESTRICT` de `users_role_fkey`.
  // Sin él, borrar un rol escanea `users` entera. También sirve al conteo por rol (CF-22).
  roleIdx: index('idx_users_role').on(t.role),
  // HU #13971 (0264): impacto/desactivación/eliminación de un proveedor SOAT. Completo, no parcial (ver cabecera 0264).
  proveedorSoatIdx: index('idx_users_flito_proveedor_soat').on(t.flitoProveedorSoatId),
}));

export const clients = pgTable('clients', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 200 }).notNull(),
  document: varchar('document', { length: 20 }),
  documentType: varchar('document_type', { length: 5 }).default('NIT'),
  phone: varchar('phone', { length: 20 }),
  email: varchar('email', { length: 150 }),
  address: varchar('address', { length: 300 }),
  city: varchar('city', { length: 100 }),
  notes: text('notes'),
  active: boolean('active').notNull().default(true),
  // FLITO (migración): parametrización por compañía. Si un módulo es autogestionable,
  // los trámites de esta compañía no entran a ese módulo FLITO (RN-02 SOAT / RN-03 Imp).
  // HU #13937 (migración 0252): las tres banderas nacen en TRUE — una compañía nueva no tiene
  // servicios gestionados por FLITO hasta que alguien los active. Las existentes no se tocaron.
  soatAutogestionable: boolean('soat_autogestionable').notNull().default(true),
  // HU #13967: `clients.soat_sin_tramite` (Feature #11912) SALIÓ del esquema. La columna física se
  // queda en la BD con su DEFAULT y sin uso (se retira en #13968): el canal lo abre el PROVEEDOR
  // elegido (`flitoProveedorSoatSinTramiteId IS NOT NULL`) junto con la función `soat.solicitud.crear`.
  /**
   * FLITO — Cliente (Feature #12074, HU #12078): el gestor por defecto AL QUE VAN las solicitudes
   * que esta compañía radica por el canal SIN TRÁMITE. Desde esa HU el alta no espera a que
   * Operaciones elija destino: nace en `solicitado` con el destino ya escrito, y sale de aquí.
   *
   * HU #13967: desde esta HU es ADEMÁS el interruptor del canal. `NULL` = «Sin proveedor» = canal
   * CERRADO; no nulo = canal abierto hacia ese proveedor (si está inactivo, la solicitud cae en la
   * contingencia de Operaciones). Puede radicar quien tenga `soat.solicitud.crear` y una compañía
   * con proveedor. El CHECK `clients_sin_tramite_gestor_chk` (0175) se retira en la 0262.
   *
   * **SOLO del canal sin trámite, y el nombre lo dice a propósito.** El SOAT POR TRÁMITE no la lee
   * nunca: allí Operaciones elige gestor en cada `POST /flito/soat/enviar`, que es cuando alguien
   * mira la carga de cada uno (HU #10979). El único lector que DECIDE con ella es
   * `resolverDestinoCanalCliente()`, en `flito-soat-cliente.service.ts`; desde la HU #12079
   * `GET /clients` también la lee, pero solo para MOSTRARLA —unida a `flito_proveedores_soat`, para
   * que la ficha de la compañía diga el nombre del gestor y si está activo—, nunca para enrutar.
   *
   * NULLABLE, como `users.companiaId`: casi ninguna compañía tiene el canal abierto, y el nulo es
   * justamente «canal cerrado» (HU #13967).
   *
   * `ON DELETE RESTRICT` explícito (ADR-0005 regla 1, ADR-0008 §3): `SET NULL` cerraría el canal de
   * la compañía por la puerta de atrás y en silencio. Sin índice: `clients` tiene cientos de filas y no existe `DELETE /proveedores-soat`
   * (un proveedor se retira con `activo = false`, que NO dispara la FK).
   */
  flitoProveedorSoatSinTramiteId: uuid('flito_proveedor_soat_sin_tramite_id')
    .references((): any => flitoProveedoresSoat.id, { onDelete: 'restrict' }),
  impuestosAutogestionable: boolean('impuestos_autogestionable').notNull().default(true),
  // HU #14104 (0279, Feature #14089): quién maneja la logística de la compañía. NULLABLE; con la logística ENCENDIDA
  // (`logistica_autogestionable = false`) el PATCH de compañías exige proveedor (422). Sin default: las encendidas hoy
  // quedan en NULL. `ON DELETE RESTRICT` (como la FK SOAT). En la misma línea: el techo congelado de schema.ts no admite crecer.
  logisticaAutogestionable: boolean('logistica_autogestionable').notNull().default(true), flitoProveedorLogisticaId: uuid('flito_proveedor_logistica_id').references((): any => flitoProveedoresLogistica.id, { onDelete: 'restrict' }),
  // FLITO Logística: si acepta entregas parciales (CA-08/09). Si es false, el acta se retiene
  // hasta tener todos los documentos de la empresa (Solo completo).
  logisticaPermiteParcial: boolean('logistica_permite_parcial').notNull().default(false),
  // Carpeta lógica en S3 donde se replican facturas/soportes (reinterpreta la
  // "carpeta OneDrive por compañía" del diseño original; decisión D-3).
  flitoCarpetaStorage: varchar('flito_carpeta_storage', { length: 300 }),
  // Tolerancia (en pesos) entre valor liquidado y pagado antes de marcar para revisión.
  flitoToleranciaValorImpuesto: numeric('flito_tolerancia_valor_impuesto', { precision: 14, scale: 2 }).notNull().default('0'),
  // Siigo (Feature #11241, HU #11292): lo que exige para crear el tercero. Nada de esto es
  // obligatorio para crear un cliente en FLITO; su ausencia solo impide facturarlo.
  // `documentType` sigue siendo texto libre a propósito: cerrarlo rompería filas existentes.
  personType: varchar('person_type', { length: 10 }),
  idType: varchar('id_type', { length: 10 }),
  checkDigit: smallint('check_digit'),
  fiscalResponsibilities: text('fiscal_responsibilities').array().notNull().default(sql`'{}'::text[]`),
  countryCode: varchar('country_code', { length: 2 }),
  stateCode: varchar('state_code', { length: 5 }),
  cityCode: varchar('city_code', { length: 10 }),
  commercialName: varchar('commercial_name', { length: 200 }),
  // La clave real del tercero en Siigo es (identificación, sucursal), no la identificación sola.
  branchOffice: integer('branch_office').notNull().default(0),
  contactFirstName: varchar('contact_first_name', { length: 100 }),
  contactLastName: varchar('contact_last_name', { length: 100 }),
  contactEmail: varchar('contact_email', { length: 150 }),
  phoneIndicative: varchar('phone_indicative', { length: 10 }),
  phoneNumber: varchar('phone_number', { length: 10 }),
  // Para poder auditar la derivación masiva de la 0132 y no pisar lo que clasificó una persona.
  personTypeOrigen: varchar('person_type_origen', { length: 20 }).notNull().default('sin_derivar'),
  // Rastro de quién convirtió `city` —texto libre— en códigos de Siigo (HU #11294). El texto
  // original NO se toca: es la prueba de qué decía la ficha cuando alguien decidió la equivalencia.
  cityTextoOrigen: varchar('city_texto_origen', { length: 100 }),
  cityConfirmadaPor: integer('city_confirmada_por').references(() => users.id),
  cityConfirmadaEn: timestamp('city_confirmada_en', { withTimezone: true }),
  // Lo que la migración encontró y bloquea facturar. Vacío NO significa facturable: el veredicto
  // completo lo calcula el informe de la HU #11296, que mira además dirección, contacto y ciudad.
  facturacionBloqueos: text('facturacion_bloqueos').array().notNull().default(sql`'{}'::text[]`),
  // HU #13952 (0257) — baja lógica (la escribe la HU #13954). NULL = vigente: un cliente dado de baja no ocupa su NIT +
  // sucursal (ni la validación de altas/ediciones ni el índice único lo cuentan). Misma línea: techo de max-lines.
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), deletedAt: timestamp('deleted_at', { withTimezone: true }), deletedBy: integer('deleted_by').references(() => users.id, { onDelete: 'restrict' }),
}, (t) => ({
  documentIdx: index('idx_clients_document').on(t.document),
  // HU #13952 (0257) — red de seguridad de «un NIT por sucursal entre vigentes»: misma normalización que la validación
  // previa (`upper(btrim())`); sin NIT (NULL o vacío) no participa. Se conserva el no único (búsqueda exacta, con bajas).
  // Misma línea: techo de max-lines del archivo.
  documentBranchIdx: index('idx_clients_document_branch').on(t.document, t.branchOffice), documentBranchVivoUq: uniqueIndex('uq_clients_document_branch_vivo').on(sql`upper(btrim(${t.document}))`, t.branchOffice).where(sql`deleted_at IS NULL AND document IS NOT NULL AND btrim(document) <> ''`),
  proveedorSoatSinTramiteIdx: index('idx_clients_flito_proveedor_soat_sin_tramite').on(t.flitoProveedorSoatSinTramiteId), proveedorLogisticaIdx: index('idx_clients_flito_proveedor_logistica').on(t.flitoProveedorLogisticaId), // HU #13971 (0264) / #14104 (0275)
}));

export const systemLocks = pgTable('system_locks', {
  lockName: varchar('lock_name', { length: 50 }).primaryKey(),
  acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
  acquiredBy: varchar('acquired_by', { length: 100 }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

// FLOTA-01 (mig 0083) — KV genérico de estado operativo (no secretos).
export const systemKv = pgTable('system_kv', {
  k: varchar('k', { length: 120 }).primaryKey(),
  v: jsonb('v').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const auditLogs = pgTable('audit_logs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  userEmail: varchar('user_email', { length: 150 }),
  action: auditActionEnum('action').notNull(),
  resource: varchar('resource', { length: 50 }).notNull(),
  resourceId: varchar('resource_id', { length: 50 }),
  detail: text('detail'),
  ipAddress: varchar('ip_address', { length: 45 }),
  userAgent: varchar('user_agent', { length: 500 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  createdAtIdx: index('idx_audit_logs_created_at').on(t.createdAt),
  userIdIdx: index('idx_audit_logs_user_id').on(t.userId),
}));

export const procesamientoCuentas = pgTable('procesamiento_cuentas', {
  id: serial('id').primaryKey(),
  usuarioId: integer('usuario_id').references(() => users.id, { onDelete: 'set null' }),
  driveFileId: varchar('drive_file_id', { length: 100 }),
  nombreArchivo: varchar('nombre_archivo', { length: 255 }),
  totalPaginas: integer('total_paginas'),
  cuentasDetectadas: integer('cuentas_detectadas'),
  placasUnicas: integer('placas_unicas'),
  valorTotal: numeric('valor_total', { precision: 20, scale: 2 }),
  directorioSalida: varchar('directorio_salida', { length: 255 }),
  estado: varchar('estado', { length: 20 }).notNull().default('procesando'),
  error: text('error'),
  // HU #10952: idempotencia de la sincronización con Drive. El scope de Drive es de solo lectura,
  // así que no se puede marcar el archivo en el origen: se lleva aquí. La fecha de modificación
  // acompaña al id porque un mismo archivo puede reemplazarse en Drive conservando su id.
  organismoCodigo: varchar('organismo_codigo', { length: 5 }),
  driveModifiedTime: timestamp('drive_modified_time', { withTimezone: true }),
  /**
   * Quién tocó el archivo en el Drive por última vez (HU del cron). Se persiste, no se consulta en
   * vivo: el registro tiene que sobrevivir al archivo, y si mañana lo borran de la carpeta esta es la
   * única forma de saber quién lo había subido.
   */
  modificadoPor: varchar('modificado_por', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Estados de un procesamiento. Texto libre en la columna, no enum, así que añadir uno no exige
 * ALTER TYPE.
 *
 * `omitido` lo escribe el arranque del cron sobre los consolidados que ya estaban en la carpeta el
 * día que se encendió: se dan por vistos sin gastar OCR en histórico que nadie pidió. Es distinto de
 * no tener registro, que significa «no se ha mirado nunca».
 */
export const ESTADO_PROCESAMIENTO = {
  PROCESANDO: 'procesando',
  COMPLETADO: 'completado',
  ERROR: 'error',
  OMITIDO: 'omitido',
} as const;
export type EstadoProcesamiento = (typeof ESTADO_PROCESAMIENTO)[keyof typeof ESTADO_PROCESAMIENTO];

export const outboxEstadoEnum = pgEnum('outbox_estado', [
  'pendiente', 'enviado', 'error', 'fallido_definitivo',
]);

// Outbox transaccional para emails (anti pérdida silenciosa de notificaciones).
export const notificationOutbox = pgTable('notification_outbox', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  canal: varchar('canal', { length: 20 }).notNull().default('email'),
  destinatarios: text('destinatarios').notNull(), // JSON array de emails
  asunto: text('asunto').notNull(),
  cuerpoHtml: text('cuerpo_html').notNull(),
  cuerpoTexto: text('cuerpo_texto'),
  estado: outboxEstadoEnum('estado').notNull().default('pendiente'),
  intentos: smallint('intentos').notNull().default(0),
  ultimoIntentoAt: timestamp('ultimo_intento_at', { withTimezone: true }),
  proximoIntentoAt: timestamp('proximo_intento_at', { withTimezone: true }),
  ultimoError: text('ultimo_error'),
  messageId: text('message_id'),
  enviadoAt: timestamp('enviado_at', { withTimezone: true }),
  contextoTipo: varchar('contexto_tipo', { length: 40 }),
  contextoId: integer('contexto_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer('created_by').references(() => users.id),
});

export const piiAccessLog = pgTable('pii_access_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: integer('user_id').references(() => users.id),
  userRole: varchar('user_role', { length: 40 }),
  resourceTipo: varchar('resource_tipo', { length: 50 }).notNull(),
  resourceId: integer('resource_id'),
  accion: varchar('accion', { length: 20 }).notNull(),
  camposAccedidos: text('campos_accedidos').array().notNull().default(sql`ARRAY[]::text[]`),
  motivo: varchar('motivo', { length: 200 }),
  ipOrigen: varchar('ip_origen', { length: 45 }),
  userAgent: text('user_agent'),
  requestId: uuid('request_id'),
  accessedAt: timestamp('accessed_at', { withTimezone: true }).notNull().defaultNow(),
});

// RUM — Web Vitals de campo (FIONA PR2). Append-only; endpoint público /api/rum.
export const rumWebVitals = pgTable('rum_web_vitals', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  metric: varchar('metric', { length: 8 }).notNull(),
  value: doublePrecision('value').notNull(),
  rating: varchar('rating', { length: 20 }),
  route: varchar('route', { length: 200 }),
  navType: varchar('nav_type', { length: 24 }),
  device: varchar('device', { length: 12 }),
  conn: varchar('conn', { length: 12 }),
  sessionId: varchar('session_id', { length: 40 }),
  ipOrigen: varchar('ip_origen', { length: 45 }),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * CA-10 (HU #12053, Feature #12052) — los organismos de tránsito que ve un `gestor_impuestos`.
 *
 * Sustituye el préstamo de `users.transito_codigo`, que es del rol `transito`, solo guardaba UNO y
 * que el `superRefine` de `users.routes.ts` ya rechazaba para cualquier otro rol —es decir: la API
 * declaraba ilegal el estado que el seed producía—. Desde la migración 0173, para un gestor esa
 * columna queda NULL: **la fuente es esta tabla y solo esta tabla**.
 *
 * PK compuesta y sin `id` propio: la fila ES el par. Un uuid obligaría además a un índice único
 * sobre el par —dos objetos de base de datos para un solo hecho— y nadie referencia estas filas por
 * id.
 *
 * `ON DELETE` clasificado según ADR-0005: `userId` es *pertenencia* (la fila no existe sin su
 * usuario) → CASCADE; `organismoCodigo` es RESTRICT porque borrar un organismo no puede desatar
 * gestores en silencio, y SET NULL es imposible en una columna de la PK.
 */
export const flitoGestorOrganismos = pgTable('flito_gestor_organismos', {
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  organismoCodigo: varchar('organismo_codigo', { length: 5 }).notNull()
    .references(() => organismosTransitoConfig.codigo, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.organismoCodigo] }),
  // Por el RESTRICT, no por un reporte: sin él, borrar una fila de organismos_transito_config
  // escanea esta tabla entera. Mismo motivo, escrito, que `idx_users_compania`.
  organismoIdx: index('idx_flito_gestor_organismos_organismo').on(t.organismoCodigo),
}));
