import { pgTable, serial, varchar, text, boolean, timestamp, time, integer, bigint, date, pgEnum, index, uniqueIndex, jsonb, numeric, bigserial, smallserial, uuid, customType, smallint, doublePrecision, primaryKey, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
// FLITO (migración): tipos de extracción OCR persistidos en columnas jsonb.
import type { ExtraccionImpuesto, ExtraccionFacturaVentaImpuesto, ExtraccionDerechoTramite, ComparacionFacturaRunt } from '@operaciones/shared-types';
// Certificación de impuestos contra el RUNT (Feature #11159): detalle por campo en columna jsonb.
import type { ComparacionCampo } from '@operaciones/shared-types';

// OBSOLETO desde la migración 0178 (HU #12169): la fuente de verdad de qué roles existen es la tabla
// `permisosRoles`, no este tipo. Ninguna columna lo usa ya — `users.role` pasó a varchar(40) con FK
// al catálogo. Se CONSERVA declarado (y el tipo se conserva en la base) porque es la única vía de
// vuelta si hubiera que revertir la 0178; borrar la constante no borraría el tipo y dejaría este
// archivo diciendo menos de lo que la base contiene. NO añadirle valores: un rol nuevo es una FILA.
// (`operaciones` sigue vivo en el enum de Postgres, deprecado y sin usuarios; nunca entró al literal
// y tampoco entra al catálogo, porque se fusionó en `admin`.)
export const roleEnum = pgEnum('user_role', ['admin', 'proveedor', 'transito', 'compliance', 'lider_pesv', 'supervisor_flota', 'conductor', 'auditor', 'gestor_impuestos', 'mensajero', 'financiera', 'cliente']);

// Las tablas `permisos_*` (roles, funciones, reparto, excepciones por usuario, bitácora de 403) viven en
// `./schema/permisos.ts` y se re-exportan desde aquí: este archivo está contra el techo de max-lines (3400)
// y ese bloque es el que crece con el Feature #12072. Para el resto del código nada cambia: se sigue
// importando de `db/schema.js`.
// Import (y no solo `export … from`) porque `users.role` referencia `permisosRoles.codigo` aquí abajo.
import { permisosRoles, permisosFunciones, permisosRolFuncion, permisosUsuarioFuncion, permisosIntentosDenegados, permisosAuditoria } from './schema/permisos.js';
export { permisosRoles, permisosFunciones, permisosRolFuncion, permisosUsuarioFuncion, permisosIntentosDenegados, permisosAuditoria };
export * from './schema/flito-bolsas-documentos.js'; export * from './schema/flito-soat-masivo.js'; export * from './schema/uso-legacy.js'; // HU #13989 (ADR-0033) / HU #14131 (cola masiva SOAT) / HU #13889 (ADR-0028): expediente documental de la compañía
// Épica #12245: `flito_comprobantes` vive en `./schema/flito-comprobantes.ts` por el mismo techo (HU #12611).
import { flitoComprobantes } from './schema/flito-comprobantes.js';
export { flitoComprobantes };
// HU #13899 (ADR-0029): modelo único de bolsa en `./schema/flito-bolsas-unicas.ts` por el mismo techo.
export * from './schema/flito-bolsas-unicas.js';
// HU #12996: `flito_soat_incompletas` vive en `./schema/flito-soat-incompletas.ts` por el mismo techo.
import { flitoSoatIncompletas } from './schema/flito-soat-incompletas.js';
export { flitoSoatIncompletas };
// HU #13410: `flito_storage_borrados_pendientes` vive en `./schema/flito-storage-borrados-pendientes.ts`.
export { flitoStorageBorradosPendientes } from './schema/flito-storage-borrados-pendientes.js';
// HU #13268: `flito_impuesto_envios_flit2` (outbox del envío a FLIT 2) vive en `./schema/` por el mismo techo.
export { flitoImpuestoEnviosFlit2 } from './schema/flito-impuesto-envios-flit2.js'; export { flitoImpuestoCertificacionDirecta } from './schema/flito-impuesto-certificacion-directa.js';
// HU #12619: `flito_tramite_viajes_logistica` vive en `./schema/flito-logistica-viajes.ts` por el mismo techo.
import { flitoTramiteViajesLogistica } from './schema/flito-logistica-viajes.js';
export { flitoTramiteViajesLogistica };
// HU #14109: traslados, líneas, motivos, líneas y firmas de acta viven en `./schema/flito-logistica-traslados.ts`.
export * from './schema/flito-logistica-traslados.js'; export * from './schema/pii-key-registry.js'; // Feature #13978: registro de llaves PII
// HU #13061: `flito_sync_flit2_acceso` vive en `./schema/flito-sync.ts` por el mismo techo.
export { flitoSyncFlit2Acceso, flitoSyncFlit2Lectura, flitoSyncInterruptor, flitoSyncFlit1Lectura } from './schema/flito-sync.js';
// HU #13803: `flito_drflit_autorizaciones` (Dr. Flit, Ley 1581) vive en `./schema/flito-drflit.ts` y NO se
// re-exporta: este archivo está EN el techo (3400) y una línea más rompe el lint. Se importa de ahí directo.
// HU #13982 / #13983 (Feature #13975): trámites, SOAT, comparendos, Siigo y finanzas viven en `./schema/<dominio>.ts`.
// Los enums y `bytea` compartidos van en `./schema/_comunes.ts`, sin dependencias: se evalúan al definir cada tabla.
import { bytea, flitoModalidadEnum } from './schema/_comunes.js';
export { flitoModalidadEnum };
import { tramitesDigitales, organismosTransitoConfig, flitoTramites } from './schema/tramites.js';
export * from './schema/tramites.js';
import { flitoProveedoresSoat, flitoSoportes } from './schema/soat.js';
export * from './schema/soat.js';
export * from './schema/comparendos.js';
export * from './schema/siigo.js';
export * from './schema/finanzas.js';

export const laftKindEnum = pgEnum('laft_kind', ['PN', 'PJ']);
export const laftRiskLevelEnum = pgEnum('laft_risk_level', ['bajo', 'medio', 'alto']);
export const laftStatusEnum = pgEnum('laft_status', ['pendiente', 'vinculada', 'bloqueada', 'archivada']);
export const laftUnusualDecisionEnum = pgEnum('laft_unusual_decision', ['pendiente', 'en_analisis', 'descartada', 'escalada', 'reportada']);

export const auditActionEnum = pgEnum('audit_action', [
  'login', 'login_failed', 'logout',
  'create', 'update', 'delete',
  'upload', 'export', 'purchase',
  'wo_open', 'wo_close', 'stock_adjust',
  'view',  // mig 0069 — para audit de visualización de evidencias PESV (Ley 1581 + ONAC)
]);

export const stageEnum = pgEnum('vehicle_stage', [
  'ingreso', 'impuesto', 'soat_pendiente', 'soat_comprado', 'soat_verificado', 'listo',
]);

export const multasEstadoEnum = pgEnum('multas_estado', ['no_consultado', 'sin_multas', 'con_multas', 'acuerdo_pago']);

export const vehicleTypeEnum = pgEnum('vehicle_type', ['tractomula', 'camion', 'buseta', 'camioneta', 'automovil', 'motocicleta', 'otro']);
export const measurementTypeEnum = pgEnum('measurement_type', ['km', 'horas', 'ambos']);
export const workLoadEnum = pgEnum('work_load', ['bajo', 'normal', 'severo']);
export const fuelTypeEnum = pgEnum('fuel_type', ['acpm', 'gasolina', 'gas', 'electrico', 'hibrido']);
export const measurementSourceEnum = pgEnum('measurement_source', ['manual', 'app', 'gps', 'combustible', 'ot']);
export const docEstadoEnum = pgEnum('doc_estado', ['vigente', 'por_vencer', 'vencido', 'archivado']);

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

export const vehicles = pgTable('vehicles', {
  id: serial('id').primaryKey(),
  vin: varchar('vin', { length: 17 }).unique(),
  plate: varchar('plate', { length: 10 }),
  ownerName: varchar('owner_name', { length: 200 }),
  ownerDocument: varchar('owner_document', { length: 20 }),
  brand: varchar('brand', { length: 50 }),
  model: varchar('model', { length: 50 }),
  year: integer('year'),
  vehicleClass: varchar('vehicle_class', { length: 50 }),
  clientId: integer('client_id').references(() => clients.id),
  stage: stageEnum('stage').notNull().default('ingreso'),
  taxPaid: boolean('tax_paid').notNull().default(false),
  taxAmount: integer('tax_amount'),
  taxDate: date('tax_date'),
  avaluoComercial: integer('avaluo_comercial'),
  impuestoTotalPagar: integer('impuesto_total_pagar'),
  formularioNo: varchar('formulario_no', { length: 30 }),
  taxSource: varchar('tax_source', { length: 20 }),
  multasEstado: multasEstadoEnum('multas_estado').notNull().default('no_consultado'),
  multasTotal: numeric('multas_total', { precision: 15, scale: 2 }),
  multasCount: integer('multas_count'),
  multasConsultadoAt: timestamp('multas_consultado_at', { withTimezone: true }),
  multasNotas: text('multas_notas'),
  notes: text('notes'),
  // Flota propia (Sprint 1 — núcleo CloudFleet-style). Cuando es_flota_propia=false el vehículo
  // pertenece al pipeline de tránsito y los campos de flota se ignoran.
  esFlotaPropia: boolean('es_flota_propia').notNull().default(false),
  alias: varchar('alias', { length: 80 }),
  tipoVehiculo: vehicleTypeEnum('tipo_vehiculo'),
  tipoMedicion: measurementTypeEnum('tipo_medicion'),
  medicionPrincipal: varchar('medicion_principal', { length: 10 }),
  tipoTrabajo: workLoadEnum('tipo_trabajo').default('normal'),
  combustiblePrincipal: fuelTypeEnum('combustible_principal'),
  combustibleSecundario: fuelTypeEnum('combustible_secundario'),
  numMotor: varchar('num_motor', { length: 50 }),
  numSerie: varchar('num_serie', { length: 50 }),
  fechaCompra: date('fecha_compra'),
  precioCompra: numeric('precio_compra', { precision: 15, scale: 2 }),
  distMax24h: integer('dist_max_24h'),
  distPromedioDia: integer('dist_promedio_dia'),
  horasOpMes: integer('horas_op_mes'),
  rendimientoIdeal: numeric('rendimiento_ideal', { precision: 8, scale: 2 }),
  color: varchar('color', { length: 30 }),
  // Datos técnicos que FLIT trae en el reporte de trámites y que el sync persiste en CADA corrida
  // (HU #11906, migración 0166). Viven en `vehicles` y NO en `flito_soat` porque `resolverSoat()`
  // hace `return` sin actualizar campos cuando el SOAT ya existe: ahí, un SOAT sincronizado antes
  // de esta HU no se completaría jamás. `upsertVehiculo()` corre para todos los trámites siempre.
  // Los tres son TEXTO —no integer, no enum— a propósito; el porqué está en la 0166.
  cilindraje: varchar('cilindraje', { length: 10 }),
  carroceria: varchar('carroceria', { length: 60 }),
  tipoServicio: varchar('tipo_servicio', { length: 30 }),
  /**
   * Los DOS que solo trae el RUNT (HU #11966, migración 0172). Texto por lo mismo que los tres de
   * arriba: el origen es texto de un tercero y `"0"`, `"05"` y `""` son distinguibles.
   *
   * `puertas` **la escribe solo el canal Cliente**, y eso es una regla de SERVICIO y no de esquema:
   * `vehicles` no conoce el origen del SOAT, así que no hay CHECK que lo ate. Lo que la hace cierta
   * es el export, que la lee solo para filas `origen = 'cliente'`; la fila de trámite conserva la
   * constante `'4'` de la plantilla del cliente.
   *
   * Nullable las dos: un NOT NULL exigiría un DEFAULT para las filas que ya existen, y el único
   * candidato de `puertas` sería `'4'` — escribir en la base la constante de la plantilla como si
   * fuera un dato medido, que es la mentira que el AC6 de la #11966 viene a quitar del archivo.
   */
  pasajerosSentados: varchar('pasajeros_sentados', { length: 10 }),
  puertas: varchar('puertas', { length: 5 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  plateIdx: index('idx_vehicles_plate').on(t.plate),
}));

// Vinculación cabezote ↔ trailer (E2). Solo un trailer puede estar es_actual=true por cada vinculado.
export const vehicleEquipmentLinks = pgTable('vehicle_equipment_links', {
  id: serial('id').primaryKey(),
  vehiculoPrincipalId: integer('vehiculo_principal_id').notNull().references(() => vehicles.id, { onDelete: 'restrict' }),
  vehiculoVinculadoId: integer('vehiculo_vinculado_id').notNull().references(() => vehicles.id, { onDelete: 'restrict' }),
  desde: timestamp('desde', { withTimezone: true }).notNull().defaultNow(),
  hasta: timestamp('hasta', { withTimezone: true }),
  esActual: boolean('es_actual').notNull().default(true),
  creadoPor: integer('creado_por').references(() => users.id),
  notas: text('notas'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Mediciones de odómetro/horómetro (E3).
export const vehicleMeasurements = pgTable('vehicle_measurements', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  vehicleId: integer('vehicle_id').notNull().references(() => vehicles.id, { onDelete: 'cascade' }),
  fecha: date('fecha').notNull().defaultNow(),
  odometro: integer('odometro'),
  horometro: integer('horometro'),
  fuente: measurementSourceEnum('fuente').notNull().default('manual'),
  usuarioId: integer('usuario_id').references(() => users.id),
  nota: text('nota'),
  excedioPromedio: boolean('excedio_promedio').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Catálogo de tipos de documento (E4).
export const documentTypes = pgTable('document_types', {
  id: serial('id').primaryKey(),
  codigo: varchar('codigo', { length: 40 }).notNull().unique(),
  nombre: varchar('nombre', { length: 120 }).notNull(),
  requiereVigencia: boolean('requiere_vigencia').notNull().default(true),
  diasAlerta: integer('dias_alerta').array().notNull().default(sql`'{30,15,7,0}'::int[]`),
  destinatariosDefault: text('destinatarios_default').array().notNull().default(sql`'{}'::text[]`),
  activo: boolean('activo').notNull().default(true),
  orden: integer('orden').notNull().default(100),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Documentos concretos por vehículo (E4).
export const vehicleDocuments = pgTable('vehicle_documents', {
  id: serial('id').primaryKey(),
  vehicleId: integer('vehicle_id').notNull().references(() => vehicles.id, { onDelete: 'cascade' }),
  tipoId: integer('tipo_id').notNull().references(() => documentTypes.id, { onDelete: 'restrict' }),
  numero: varchar('numero', { length: 80 }),
  vigenciaDesde: date('vigencia_desde'),
  vigenciaHasta: date('vigencia_hasta'),
  archivoStorageKey: varchar('archivo_storage_key', { length: 500 }),
  archivoFilename: varchar('archivo_filename', { length: 300 }),
  archivoSize: integer('archivo_size'),
  archivoMime: varchar('archivo_mime', { length: 100 }),
  estado: docEstadoEnum('estado').notNull().default('vigente'),
  destinatariosExtra: text('destinatarios_extra').array().notNull().default(sql`'{}'::text[]`),
  notas: text('notas'),
  subidoPor: integer('subido_por').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Idempotencia de alertas (E4): UNIQUE(documento_id, dias_anticipacion) garantiza que el cron
// no vuelva a enviar la misma alerta así corra dos veces el mismo día por reinicio de PM2.
export const alertsSent = pgTable('alerts_sent', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  documentoId: integer('documento_id').notNull().references(() => vehicleDocuments.id, { onDelete: 'cascade' }),
  diasAnticipacion: integer('dias_anticipacion').notNull(),
  enviadoAt: timestamp('enviado_at', { withTimezone: true }).notNull().defaultNow(),
  destinatarios: text('destinatarios').array().notNull(),
  emailMessageId: varchar('email_message_id', { length: 200 }),
  resultado: varchar('resultado', { length: 20 }).notNull(),
  errorMsg: text('error_msg'),
});

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

// TRAM-INNOV B1 — pasaporte vehicular: historial cronológico encadenado por VIN.
export const vehiculoHistorial = pgTable('vehiculo_historial', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  vin: varchar('vin', { length: 17 }).notNull(),
  eventoTipo: varchar('evento_tipo', { length: 40 }).notNull(),
  referenciaTramiteId: integer('referencia_tramite_id').references(() => tramitesDigitales.id, { onDelete: 'set null' }),
  payload: jsonb('payload'),
  hashPrev: varchar('hash_prev', { length: 64 }).notNull(),
  hashSelf: varchar('hash_self', { length: 64 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  vinIdx: index('idx_vehiculo_historial_vin').on(t.vin, t.createdAt, t.id),
  vinIdIdx: index('idx_vehiculo_historial_vin_id').on(t.vin, t.id),
}));

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

// === LAFT — Política de Prevención LA/FT/FPADM (FLIT SAS) =====================

export const laftCounterparties = pgTable('laft_counterparties', {
  id: serial('id').primaryKey(),
  kind: laftKindEnum('kind').notNull(),
  docType: varchar('doc_type', { length: 10 }).notNull(),
  docNumber: varchar('doc_number', { length: 20 }).notNull(),
  fullName: varchar('full_name', { length: 200 }).notNull(),
  email: varchar('email', { length: 150 }),
  phone: varchar('phone', { length: 20 }),
  address: varchar('address', { length: 300 }),
  city: varchar('city', { length: 100 }),
  country: varchar('country', { length: 80 }).notNull().default('Colombia'),
  economicActivity: varchar('economic_activity', { length: 200 }),
  ciiu: varchar('ciiu', { length: 10 }),
  fundOrigin: text('fund_origin').notNull(),
  isPep: boolean('is_pep').notNull().default(false),
  pepRole: varchar('pep_role', { length: 200 }),
  pepPeriodStart: date('pep_period_start'),
  pepPeriodEnd: date('pep_period_end'),
  pepKinship: varchar('pep_kinship', { length: 50 }),
  factorCounterparty: integer('factor_counterparty'),
  factorProduct: integer('factor_product'),
  factorChannel: integer('factor_channel'),
  factorJurisdiction: integer('factor_jurisdiction'),
  riskLevel: laftRiskLevelEnum('risk_level'),
  status: laftStatusEnum('status').notNull().default('pendiente'),
  blockReason: text('block_reason'),
  nextReviewAt: date('next_review_at'),
  version: integer('version').notNull().default(1),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  // F2 LAFT — cifrado PII (mig 0063). Las columnas plain (docNumber/email/phone)
  // siguen existiendo hasta que el backfill termine y se apruebe la 0064 de drop.
  docNumberEnc: jsonb('doc_number_enc'),
  docNumberHash: varchar('doc_number_hash', { length: 64 }),
  emailEnc: jsonb('email_enc'),
  phoneEnc: jsonb('phone_enc'),
}, (t) => ({
  docIdx: index('idx_laft_cp_doc').on(t.docNumber),
  statusIdx: index('idx_laft_cp_status').on(t.status),
  reviewIdx: index('idx_laft_cp_review').on(t.nextReviewAt),
  riskIdx: index('idx_laft_cp_risk').on(t.riskLevel),
  docHashIdx: index('idx_laft_cp_doc_hash').on(t.docNumberHash),
}));

export const laftBeneficialOwners = pgTable('laft_beneficial_owners', {
  id: serial('id').primaryKey(),
  counterpartyId: integer('counterparty_id').notNull().references(() => laftCounterparties.id, { onDelete: 'cascade' }),
  docType: varchar('doc_type', { length: 10 }).notNull(),
  docNumber: varchar('doc_number', { length: 20 }).notNull(),
  fullName: varchar('full_name', { length: 200 }).notNull(),
  ownershipPct: numeric('ownership_pct', { precision: 5, scale: 2 }).notNull(),
  isPep: boolean('is_pep').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  cpIdx: index('idx_laft_bo_cp').on(t.counterpartyId),
  docIdx: index('idx_laft_bo_doc').on(t.docNumber),
}));

export const laftDocuments = pgTable('laft_documents', {
  id: serial('id').primaryKey(),
  counterpartyId: integer('counterparty_id').notNull().references(() => laftCounterparties.id, { onDelete: 'cascade' }),
  kind: varchar('kind', { length: 50 }).notNull(),
  filename: varchar('filename', { length: 255 }).notNull(),
  storageKey: varchar('storage_key', { length: 500 }).notNull(),
  sizeBytes: integer('size_bytes'),
  mimeType: varchar('mime_type', { length: 100 }),
  uploadedBy: integer('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  cpIdx: index('idx_laft_docs_cp').on(t.counterpartyId),
}));

export const laftRestrictiveLists = pgTable('laft_restrictive_lists', {
  id: serial('id').primaryKey(),
  code: varchar('code', { length: 20 }).notNull().unique(),
  name: varchar('name', { length: 120 }).notNull(),
  binding: boolean('binding').notNull().default(false),
  sourceUrl: varchar('source_url', { length: 500 }),
  description: text('description'),
  active: boolean('active').notNull().default(true),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  totalEntries: integer('total_entries').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const laftListEntries = pgTable('laft_list_entries', {
  id: serial('id').primaryKey(),
  listId: integer('list_id').notNull().references(() => laftRestrictiveLists.id, { onDelete: 'cascade' }),
  fullName: varchar('full_name', { length: 500 }).notNull(),
  fullNameNorm: varchar('full_name_norm', { length: 500 }).notNull(),
  aliases: jsonb('aliases'),
  docType: varchar('doc_type', { length: 20 }),
  docNumber: varchar('doc_number', { length: 50 }),
  country: varchar('country', { length: 80 }),
  birthDate: varchar('birth_date', { length: 20 }),
  remarks: text('remarks'),
  sourceId: varchar('source_id', { length: 100 }),
  sourceHash: varchar('source_hash', { length: 64 }),
  validFrom: date('valid_from'),
  importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  listIdx: index('idx_laft_le_list').on(t.listId),
  docIdx: index('idx_laft_le_doc').on(t.docNumber),
  sourceIdx: index('idx_laft_le_source').on(t.listId, t.sourceId),
}));

export const laftListChecks = pgTable('laft_list_checks', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  counterpartyId: integer('counterparty_id').notNull().references(() => laftCounterparties.id, { onDelete: 'cascade' }),
  listId: integer('list_id').notNull().references(() => laftRestrictiveLists.id, { onDelete: 'restrict' }),
  queryDoc: varchar('query_doc', { length: 50 }),
  queryNameNorm: varchar('query_name_norm', { length: 500 }),
  matchEntryId: integer('match_entry_id').references(() => laftListEntries.id, { onDelete: 'set null' }),
  matchScore: integer('match_score').notNull().default(0),
  matchKind: varchar('match_kind', { length: 20 }),
  evidence: jsonb('evidence'),
  checkedBy: integer('checked_by').references(() => users.id, { onDelete: 'set null' }),
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  cpIdx: index('idx_laft_checks_cp').on(t.counterpartyId, t.checkedAt),
}));

export const laftAuditLog = pgTable('laft_audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  userUsername: varchar('user_username', { length: 50 }),
  action: varchar('action', { length: 50 }).notNull(),
  resource: varchar('resource', { length: 50 }).notNull(),
  resourceId: varchar('resource_id', { length: 50 }),
  beforeState: jsonb('before_state'),
  afterState: jsonb('after_state'),
  ipAddress: varchar('ip_address', { length: 45 }),
  userAgent: varchar('user_agent', { length: 500 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  createdIdx: index('idx_laft_audit_created').on(t.createdAt),
  resourceIdx: index('idx_laft_audit_resource').on(t.resource, t.resourceId),
  userIdx: index('idx_laft_audit_user').on(t.userId),
}));

export const laftUnusualOperations = pgTable('laft_unusual_operations', {
  id: serial('id').primaryKey(),
  counterpartyId: integer('counterparty_id').references(() => laftCounterparties.id, { onDelete: 'set null' }),
  detectedBy: integer('detected_by').references(() => users.id, { onDelete: 'set null' }),
  detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
  source: varchar('source', { length: 50 }).notNull(),
  signals: jsonb('signals').notNull(),
  amount: numeric('amount', { precision: 20, scale: 2 }),
  currency: varchar('currency', { length: 10 }).default('COP'),
  description: text('description').notNull(),
  analysisText: text('analysis_text'),
  decision: laftUnusualDecisionEnum('decision').notNull().default('pendiente'),
  decidedBy: integer('decided_by').references(() => users.id, { onDelete: 'set null' }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionReason: text('decision_reason'),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  decisionIdx: index('idx_laft_uo_decision').on(t.decision),
  cpIdx: index('idx_laft_uo_cp').on(t.counterpartyId),
  detectedIdx: index('idx_laft_uo_detected').on(t.detectedAt),
}));

export const laftRosDrafts = pgTable('laft_ros_drafts', {
  id: serial('id').primaryKey(),
  operationId: integer('operation_id').notNull().references(() => laftUnusualOperations.id, { onDelete: 'restrict' }),
  sirelPayload: jsonb('sirel_payload').notNull(),
  pdfStorageKey: varchar('pdf_storage_key', { length: 500 }),
  generatedBy: integer('generated_by').references(() => users.id, { onDelete: 'set null' }),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
  sentToUiafAt: timestamp('sent_to_uiaf_at', { withTimezone: true }),
  sirelRadicado: varchar('sirel_radicado', { length: 60 }),
  evidenceFiles: jsonb('evidence_files'),
  notes: text('notes'),
  // F4 SARLAFT v2 (migration 0065): timer SLA 24h + export para SIREL data-entry humano.
  clasificadoAt: timestamp('clasificado_at', { withTimezone: true }),
  slaDueAt: timestamp('sla_due_at', { withTimezone: true }),
  slaBreached: boolean('sla_breached').notNull().default(false),
  exportPdfStorageKey: text('export_pdf_storage_key'),
  exportCsvStorageKey: text('export_csv_storage_key'),
  exportSha256: varchar('export_sha256', { length: 64 }),
  sirelAcuseAt: timestamp('sirel_acuse_at', { withTimezone: true }),
}, (t) => ({
  opIdx: index('idx_laft_ros_op').on(t.operationId),
  sentIdx: index('idx_laft_ros_sent').on(t.sentToUiafAt),
}));

export const laftRosSlaAlarmas = pgTable('laft_ros_sla_alarmas', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  rosDraftId: integer('ros_draft_id').notNull().references(() => laftRosDrafts.id, { onDelete: 'cascade' }),
  tipo: varchar('tipo', { length: 20 }).notNull(), // warn_12h | warn_4h | breach
  alarmadaAt: timestamp('alarmada_at', { withTimezone: true }).notNull().defaultNow(),
  destinatarios: text('destinatarios'),
  acuseAt: timestamp('acuse_at', { withTimezone: true }),
  acusePor: integer('acuse_por').references(() => users.id),
});

export const laftTrainings = pgTable('laft_trainings', {
  id: serial('id').primaryKey(),
  title: varchar('title', { length: 200 }).notNull(),
  description: text('description'),
  trainerName: varchar('trainer_name', { length: 120 }),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
  durationHours: numeric('duration_hours', { precision: 4, scale: 1 }),
  contentUrl: varchar('content_url', { length: 500 }),
  evaluationUrl: varchar('evaluation_url', { length: 500 }),
  passingScore: integer('passing_score').default(70),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  scheduledIdx: index('idx_laft_tr_scheduled').on(t.scheduledAt),
}));

export const laftTrainingAttendees = pgTable('laft_training_attendees', {
  id: serial('id').primaryKey(),
  trainingId: integer('training_id').notNull().references(() => laftTrainings.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  attended: boolean('attended').notNull().default(false),
  score: integer('score'),
  attendedAt: timestamp('attended_at', { withTimezone: true }),
  certificateStorageKey: varchar('certificate_storage_key', { length: 500 }),
}, (t) => ({
  trainingIdx: index('idx_laft_ta_training').on(t.trainingId),
  userIdx: index('idx_laft_ta_user').on(t.userId),
}));

// LAFT/SARLAFT v2 — F1: jobs de sincronización de listas restrictivas (auditoría WORM).
// El cron diario inserta una fila por lista (running) → la cierra (success/failed).
// Trigger BD bloquea cualquier UPDATE/DELETE posterior sobre filas no-running (ver mig 0062).
export const laftListsSyncJobs = pgTable('laft_lists_sync_jobs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  listCode: varchar('list_code', { length: 20 }).notNull(),
  trigger: varchar('trigger', { length: 20 }).notNull().default('cron'),
  triggeredBy: integer('triggered_by').references(() => users.id, { onDelete: 'set null' }),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  status: varchar('status', { length: 20 }).notNull().default('running'),
  sourceUrl: text('source_url'),
  sourceHash: varchar('source_hash', { length: 64 }),
  entriesTotal: integer('entries_total'),
  entriesAdded: integer('entries_added'),
  entriesRemoved: integer('entries_removed'),
  entriesModified: integer('entries_modified'),
  retroMatchesNew: integer('retro_matches_new'),
  errorText: text('error_text'),
  durationMs: integer('duration_ms'),
}, (t) => ({
  listStartedIdx: index('idx_laft_sync_jobs_list_code_started').on(t.listCode, t.startedAt),
  statusIdx: index('idx_laft_sync_jobs_status').on(t.status, t.startedAt),
}));

// ============================================================================
// LAFT v2 F3 (mig 0064) — RTE / AROS / parámetros / cash txns / idempotencia
// ============================================================================

// Parámetros LAFT configurables (umbrales RTE, dia corte AROS, SLA ROS).
// El Empleado de Cumplimiento ajusta estos valores vía UI sin redeploy.
export const laftParametros = pgTable('laft_parametros', {
  clave: varchar('clave', { length: 60 }).primaryKey(),
  valor: text('valor').notNull(),
  descripcion: text('descripcion'),
  actualizadoPor: integer('actualizado_por').references(() => users.id, { onDelete: 'set null' }),
  actualizadoAt: timestamp('actualizado_at', { withTimezone: true }).notNull().defaultNow(),
});

// Transacciones en efectivo. WORM-light: REVOKE DELETE en BD; UPDATE solo desde
// app para asociar unusual_operation_id / ros_draft_id post-creación.
export const laftCashTxns = pgTable('laft_cash_txns', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  counterpartyId: integer('counterparty_id').notNull().references(() => laftCounterparties.id, { onDelete: 'restrict' }),
  amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull().default('COP'),
  kind: varchar('kind', { length: 20 }).notNull(),
  fecha: date('fecha').notNull(),
  descripcion: text('descripcion'),
  numeroRecibo: varchar('numero_recibo', { length: 60 }),
  thresholdIndividualBreached: boolean('threshold_individual_breached').notNull().default(false),
  thresholdAcumuladoBreached: boolean('threshold_acumulado_breached').notNull().default(false),
  unusualOperationId: integer('unusual_operation_id').references(() => laftUnusualOperations.id, { onDelete: 'set null' }),
  rosDraftId: integer('ros_draft_id').references(() => laftRosDrafts.id, { onDelete: 'set null' }),
  registradoPor: integer('registrado_por').notNull().references(() => users.id, { onDelete: 'restrict' }),
  registradoAt: timestamp('registrado_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  cpFechaIdx: index('idx_laft_cash_cp_fecha').on(t.counterpartyId, t.fecha),
  kindIdx: index('idx_laft_cash_kind').on(t.kind),
}));

// Reportes generados a la UIAF (RTE/AROS/ROS). WORM-strict: trigger BD bloquea
// cambios distintos a enviado_a_uiaf_at + acuse_uiaf.
export const laftReportesUiaf = pgTable('laft_reportes_uiaf', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tipo: varchar('tipo', { length: 10 }).notNull(),
  periodoAnio: integer('periodo_anio'),
  periodoMes: integer('periodo_mes'),
  periodoTrimestre: integer('periodo_trimestre'),
  generadoPor: integer('generado_por').notNull().references(() => users.id, { onDelete: 'restrict' }),
  generadoAt: timestamp('generado_at', { withTimezone: true }).notNull().defaultNow(),
  totalOperaciones: integer('total_operaciones').notNull().default(0),
  totalMontoCop: numeric('total_monto_cop', { precision: 18, scale: 2 }),
  formato: varchar('formato', { length: 10 }).notNull(),
  storageKey: text('storage_key'),
  sha256: varchar('sha256', { length: 64 }).notNull(),
  enviadoAUiafAt: timestamp('enviado_a_uiaf_at', { withTimezone: true }),
  acuseUiaf: text('acuse_uiaf'),
}, (t) => ({
  periodoIdx: index('idx_laft_reportes_periodo').on(t.periodoAnio, t.tipo),
}));

// Idempotencia persistente para POSTs LAFT (cash txn / generar reportes).
// Misma forma que jornadas_idempotency_keys / rndc_idempotency_keys.
export const laftCashIdempotencyKeys = pgTable('laft_cash_idempotency_keys', {
  key: varchar('key', { length: 80 }).notNull(),
  scope: varchar('scope', { length: 20 }).notNull(),
  cashTxnId: bigint('cash_txn_id', { mode: 'number' }).references(() => laftCashTxns.id, { onDelete: 'set null' }),
  reporteId: bigint('reporte_id', { mode: 'number' }).references(() => laftReportesUiaf.id, { onDelete: 'set null' }),
  userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================================
// Sprint 2A — Mantenimiento (E1, E2, E3)
// ============================================================================

export const criterioPeriodicidadEnum = pgEnum('criterio_periodicidad', ['vehicle', 'tipo_vehiculo', 'combustible']);
export const scheduleTipoEnum = pgEnum('schedule_tipo', ['manual', 'automatica']);
export const scheduleEstadoEnum = pgEnum('schedule_estado', ['pendiente', 'ejecutada', 'vencida', 'cancelada']);
export const movementTypeEnum = pgEnum('movement_type', ['entrada', 'salida', 'traslado', 'ajuste', 'reverso_ot']);

export const maintenanceSystems = pgTable('maintenance_systems', {
  id: serial('id').primaryKey(),
  codigo: varchar('codigo', { length: 20 }).notNull().unique(),
  nombre: varchar('nombre', { length: 80 }).notNull(),
  orden: integer('orden').notNull().default(100),
  activo: boolean('activo').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const maintenanceSubsystems = pgTable('maintenance_subsystems', {
  id: serial('id').primaryKey(),
  systemId: integer('system_id').notNull().references(() => maintenanceSystems.id, { onDelete: 'restrict' }),
  codigo: varchar('codigo', { length: 20 }).notNull(),
  nombre: varchar('nombre', { length: 80 }).notNull(),
  activo: boolean('activo').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const maintenanceJobs = pgTable('maintenance_jobs', {
  id: serial('id').primaryKey(),
  codigo: varchar('codigo', { length: 30 }).notNull().unique(),
  nombre: varchar('nombre', { length: 150 }).notNull(),
  systemId: integer('system_id').references(() => maintenanceSystems.id, { onDelete: 'restrict' }),
  subsystemId: integer('subsystem_id').references(() => maintenanceSubsystems.id, { onDelete: 'restrict' }),
  tiempoEstimadoHoras: numeric('tiempo_estimado_horas', { precision: 6, scale: 2 }),
  descripcion: text('descripcion'),
  activo: boolean('activo').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const partsLocations = pgTable('parts_locations', {
  id: serial('id').primaryKey(),
  codigo: varchar('codigo', { length: 20 }).notNull().unique(),
  nombre: varchar('nombre', { length: 80 }).notNull(),
  bodega: varchar('bodega', { length: 80 }),
  activo: boolean('activo').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const parts = pgTable('parts', {
  id: serial('id').primaryKey(),
  codigo: varchar('codigo', { length: 30 }).notNull().unique(),
  nombre: varchar('nombre', { length: 150 }).notNull(),
  unidadMedida: varchar('unidad_medida', { length: 10 }).notNull().default('und'),
  inventariable: boolean('inventariable').notNull().default(true),
  existenciaMin: numeric('existencia_min', { precision: 12, scale: 2 }).notNull().default('0'),
  existenciaMax: numeric('existencia_max', { precision: 12, scale: 2 }),
  systemId: integer('system_id').references(() => maintenanceSystems.id, { onDelete: 'set null' }),
  valorPromedio: numeric('valor_promedio', { precision: 15, scale: 4 }).notNull().default('0'),
  activo: boolean('activo').notNull().default(true),
  observaciones: text('observaciones'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const partsStock = pgTable('parts_stock', {
  id: serial('id').primaryKey(),
  partId: integer('part_id').notNull().references(() => parts.id, { onDelete: 'cascade' }),
  locationId: integer('location_id').notNull().references(() => partsLocations.id, { onDelete: 'restrict' }),
  cantidad: numeric('cantidad', { precision: 14, scale: 3 }).notNull().default('0'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const partsMovements = pgTable('parts_movements', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  fecha: date('fecha').notNull().defaultNow(),
  tipo: movementTypeEnum('tipo').notNull(),
  partId: integer('part_id').notNull().references(() => parts.id, { onDelete: 'restrict' }),
  cantidad: numeric('cantidad', { precision: 14, scale: 3 }).notNull(),
  valorUnit: numeric('valor_unit', { precision: 15, scale: 4 }),
  ubicacionOrigenId: integer('ubicacion_origen_id').references(() => partsLocations.id, { onDelete: 'restrict' }),
  ubicacionDestinoId: integer('ubicacion_destino_id').references(() => partsLocations.id, { onDelete: 'restrict' }),
  factura: varchar('factura', { length: 50 }),
  remision: varchar('remision', { length: 50 }),
  woId: bigint('wo_id', { mode: 'number' }).references((): any => workOrders.id, { onDelete: 'restrict' }),
  observaciones: text('observaciones'),
  usuarioId: integer('usuario_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const maintenanceRoutines = pgTable('maintenance_routines', {
  id: serial('id').primaryKey(),
  codigo: varchar('codigo', { length: 30 }).notNull().unique(),
  nombre: varchar('nombre', { length: 150 }).notNull(),
  descripcion: text('descripcion'),
  activo: boolean('activo').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const routineJobs = pgTable('routine_jobs', {
  routineId: integer('routine_id').notNull().references(() => maintenanceRoutines.id, { onDelete: 'cascade' }),
  jobId: integer('job_id').notNull().references(() => maintenanceJobs.id, { onDelete: 'restrict' }),
  orden: integer('orden').notNull().default(1),
});

export const routineParts = pgTable('routine_parts', {
  routineId: integer('routine_id').notNull().references(() => maintenanceRoutines.id, { onDelete: 'cascade' }),
  partId: integer('part_id').notNull().references(() => parts.id, { onDelete: 'restrict' }),
  cantidad: numeric('cantidad', { precision: 12, scale: 3 }).notNull().default('1'),
});

export const routinePeriodicity = pgTable('routine_periodicity', {
  id: serial('id').primaryKey(),
  routineId: integer('routine_id').notNull().references(() => maintenanceRoutines.id, { onDelete: 'cascade' }),
  criterio: criterioPeriodicidadEnum('criterio').notNull(),
  refId: integer('ref_id'),
  tipoVehiculo: vehicleTypeEnum('tipo_vehiculo'),
  combustible: fuelTypeEnum('combustible'),
  kmPeriodo: integer('km_periodo'),
  horasPeriodo: integer('horas_periodo'),
  diasPeriodo: integer('dias_periodo'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const maintenanceSchedule = pgTable('maintenance_schedule', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  vehicleId: integer('vehicle_id').notNull().references(() => vehicles.id, { onDelete: 'cascade' }),
  routineId: integer('routine_id').references(() => maintenanceRoutines.id, { onDelete: 'cascade' }),
  jobId: integer('job_id').references(() => maintenanceJobs.id, { onDelete: 'cascade' }),
  fechaProgramada: date('fecha_programada').notNull(),
  medicionProgramada: integer('medicion_programada'),
  tipo: scheduleTipoEnum('tipo').notNull().default('automatica'),
  secuencial: boolean('secuencial').notNull().default(false),
  estado: scheduleEstadoEnum('estado').notNull().default('pendiente'),
  woId: bigint('wo_id', { mode: 'number' }).references((): any => workOrders.id, { onDelete: 'set null' }),
  creadoPor: integer('creado_por').references(() => users.id),
  notas: text('notas'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================================
// Sprint 2B — Preorden + Orden de Trabajo (E4)
// ============================================================================

export const preOrderEstadoEnum = pgEnum('pre_order_estado', ['borrador', 'aprobada', 'generada_ot', 'rechazada']);
export const woTipoEnum = pgEnum('wo_tipo', ['preventivo', 'correctivo', 'predictivo']);
export const woEstadoEnum = pgEnum('wo_estado', ['abierta', 'cerrada_tecnica', 'cerrada_final', 'anulada']);

export const preOrders = pgTable('pre_orders', {
  id: serial('id').primaryKey(),
  numero: varchar('numero', { length: 20 }).notNull().unique(),
  vehicleId: integer('vehicle_id').notNull().references(() => vehicles.id, { onDelete: 'restrict' }),
  fecha: date('fecha').notNull().defaultNow(),
  estado: preOrderEstadoEnum('estado').notNull().default('borrador'),
  observaciones: text('observaciones'),
  creadoPor: integer('creado_por').references(() => users.id),
  aprobadoPor: integer('aprobado_por').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const preOrderJobs = pgTable('pre_order_jobs', {
  preOrderId: integer('pre_order_id').notNull().references(() => preOrders.id, { onDelete: 'cascade' }),
  jobId: integer('job_id').notNull().references(() => maintenanceJobs.id, { onDelete: 'restrict' }),
  costoEstimado: numeric('costo_estimado', { precision: 15, scale: 2 }).notNull().default('0'),
});

export const preOrderParts = pgTable('pre_order_parts', {
  preOrderId: integer('pre_order_id').notNull().references(() => preOrders.id, { onDelete: 'cascade' }),
  partId: integer('part_id').notNull().references(() => parts.id, { onDelete: 'restrict' }),
  cantidad: numeric('cantidad', { precision: 12, scale: 3 }).notNull().default('1'),
  costoEstimado: numeric('costo_estimado', { precision: 15, scale: 2 }).notNull().default('0'),
});

export const workOrders = pgTable('work_orders', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  numero: varchar('numero', { length: 20 }).notNull().unique(),
  vehicleId: integer('vehicle_id').notNull().references(() => vehicles.id, { onDelete: 'restrict' }),
  preOrderId: integer('pre_order_id').references(() => preOrders.id, { onDelete: 'set null' }),
  routineId: integer('routine_id').references(() => maintenanceRoutines.id, { onDelete: 'set null' }),
  fechaIngresoTaller: timestamp('fecha_ingreso_taller', { withTimezone: true }).notNull().defaultNow(),
  fechaOrden: date('fecha_orden').notNull().defaultNow(),
  posibleCierre: date('posible_cierre'),
  medicionIngreso: integer('medicion_ingreso'),
  proveedorId: integer('proveedor_id').references(() => users.id),
  tipoTrabajo: woTipoEnum('tipo_trabajo').notNull().default('preventivo'),
  falla: text('falla'),
  conductorId: integer('conductor_id').references(() => users.id),
  observaciones: text('observaciones'),
  estado: woEstadoEnum('estado').notNull().default('abierta'),
  fechaCierreTecnica: timestamp('fecha_cierre_tecnica', { withTimezone: true }),
  fechaCierreFinal: timestamp('fecha_cierre_final', { withTimezone: true }),
  garantia: boolean('garantia').notNull().default(false),
  metodoPago: varchar('metodo_pago', { length: 20 }),
  costoTotalCalculado: numeric('costo_total_calculado', { precision: 15, scale: 2 }),
  creadoPor: integer('creado_por').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const woJobs = pgTable('wo_jobs', {
  id: serial('id').primaryKey(),
  woId: bigint('wo_id', { mode: 'number' }).notNull().references(() => workOrders.id, { onDelete: 'cascade' }),
  jobId: integer('job_id').notNull().references(() => maintenanceJobs.id, { onDelete: 'restrict' }),
  mechanicId: integer('mechanic_id').references(() => users.id),
  tiempoRealHoras: numeric('tiempo_real_horas', { precision: 6, scale: 2 }),
  costoManoObra: numeric('costo_mano_obra', { precision: 15, scale: 2 }).notNull().default('0'),
  notas: text('notas'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const woParts = pgTable('wo_parts', {
  id: serial('id').primaryKey(),
  woId: bigint('wo_id', { mode: 'number' }).notNull().references(() => workOrders.id, { onDelete: 'cascade' }),
  partId: integer('part_id').notNull().references(() => parts.id, { onDelete: 'restrict' }),
  cantidad: numeric('cantidad', { precision: 12, scale: 3 }).notNull(),
  valorUnit: numeric('valor_unit', { precision: 15, scale: 4 }),
  descuento: numeric('descuento', { precision: 15, scale: 2 }).notNull().default('0'),
  ubicacionId: integer('ubicacion_id').references(() => partsLocations.id, { onDelete: 'restrict' }),
  aplicadoStock: boolean('aplicado_stock').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const woSeguimientos = pgTable('wo_seguimientos', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  woId: bigint('wo_id', { mode: 'number' }).notNull().references(() => workOrders.id, { onDelete: 'cascade' }),
  texto: text('texto'),
  archivos: jsonb('archivos').notNull().default(sql`'[]'::jsonb`),
  autorId: integer('autor_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const woOtrosGastos = pgTable('wo_otros_gastos', {
  id: serial('id').primaryKey(),
  woId: bigint('wo_id', { mode: 'number' }).notNull().references(() => workOrders.id, { onDelete: 'cascade' }),
  concepto: varchar('concepto', { length: 150 }).notNull(),
  monto: numeric('monto', { precision: 15, scale: 2 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================================
// Sprint 3A — PESV Conductores (Resolución 40595/2022)
// ============================================================================

export const contratoTipoEnum = pgEnum('contrato_tipo', ['directo', 'contratista', 'temporal']);
export const trainingModalidadEnum = pgEnum('training_modalidad', ['presencial', 'virtual', 'mixta']);
export const incidentTipoEnum = pgEnum('incident_tipo', ['accidente', 'casi_accidente', 'comparendo']);
export const incidentGravedadEnum = pgEnum('incident_gravedad', ['sin', 'leve', 'grave', 'fatal']);
export const incidentEstadoEnum = pgEnum('incident_estado', ['abierto', 'investigacion', 'cerrado']);
// Declarado aquí (NO en bloque PESV-S6 abajo) porque roadIncidents lo usa.
export const pesvCausaRaizMetodoEnum = pgEnum('pesv_causa_raiz_metodo', ['5_porques', 'ishikawa', 'arbol_causas', 'otro']);
export const actionEstadoEnum = pgEnum('action_estado', ['pendiente', 'en_proceso', 'cumplida', 'vencida']);

export const driverProfile = pgTable('driver_profile', {
  userId: integer('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  // PII cifrado AES-256-GCM (Ola C-1 2026-05-05). Columnas *_legacy_plain dropeadas en 0052 (Lote 11 2026-05-06).
  cedulaCipher: bytea('cedula_cipher'),
  cedulaIv: bytea('cedula_iv'),
  cedulaAuthTag: bytea('cedula_auth_tag'),
  cedulaAadNonce: uuid('cedula_aad_nonce'),
  cedulaKeyVersion: smallint('cedula_key_version'),
  cedulaHash: bytea('cedula_hash'),
  fechaNacimiento: date('fecha_nacimiento'),
  licenciaNumeroCipher: bytea('licencia_numero_cipher'),
  licenciaNumeroIv: bytea('licencia_numero_iv'),
  licenciaNumeroAuthTag: bytea('licencia_numero_auth_tag'),
  licenciaNumeroAadNonce: uuid('licencia_numero_aad_nonce'),
  licenciaNumeroKeyVersion: smallint('licencia_numero_key_version'),
  categorias: text('categorias').array().notNull().default(sql`'{}'::text[]`),
  licenciaVigencia: date('licencia_vigencia'),
  examenPsicoFecha: date('examen_psico_fecha'),
  examenPsicoVigencia: date('examen_psico_vigencia'),
  restriccionesMedicas: text('restricciones_medicas').array().notNull().default(sql`'{}'::text[]`),
  arl: varchar('arl', { length: 80 }),
  eps: varchar('eps', { length: 80 }),
  fondoPensiones: varchar('fondo_pensiones', { length: 80 }),
  contratoTipo: contratoTipoEnum('contrato_tipo'),
  experienciaAnios: numeric('experiencia_anios', { precision: 4, scale: 1 }).notNull().default('0'),
  sancionesCount: integer('sanciones_count').notNull().default(0),
  fotoStorageKey: varchar('foto_storage_key', { length: 500 }),
  runtConsultadoAt: timestamp('runt_consultado_at', { withTimezone: true }),
  runtPayloadCipher: bytea('runt_payload_cipher'),
  runtPayloadIv: bytea('runt_payload_iv'),
  runtPayloadAuthTag: bytea('runt_payload_auth_tag'),
  runtPayloadAadNonce: uuid('runt_payload_aad_nonce'),
  runtPayloadKeyVersion: smallint('runt_payload_key_version'),
  // Sprint 3B — extensiones operación PESV.
  suspendidoPorAlcohol: boolean('suspendido_por_alcohol').notNull().default(false),
  fechaSuspension: timestamp('fecha_suspension', { withTimezone: true }),
  motivoSuspension: text('motivo_suspension'),
  suspensionLevantadaPor: integer('suspension_levantada_por').references(() => users.id),
  suspensionLevantadaAt: timestamp('suspension_levantada_at', { withTimezone: true }),
  checklistPinHash: varchar('checklist_pin_hash', { length: 120 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const driverDocumentTypes = pgTable('driver_document_types', {
  id: serial('id').primaryKey(),
  codigo: varchar('codigo', { length: 40 }).notNull().unique(),
  nombre: varchar('nombre', { length: 120 }).notNull(),
  requiereVigencia: boolean('requiere_vigencia').notNull().default(true),
  diasAlerta: integer('dias_alerta').array().notNull().default(sql`'{30,15,7,0}'::int[]`),
  destinatariosDefault: text('destinatarios_default').array().notNull().default(sql`'{}'::text[]`),
  activo: boolean('activo').notNull().default(true),
  orden: integer('orden').notNull().default(100),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const driverDocuments = pgTable('driver_documents', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tipoId: integer('tipo_id').notNull().references(() => driverDocumentTypes.id, { onDelete: 'restrict' }),
  numero: varchar('numero', { length: 80 }),
  vigenciaDesde: date('vigencia_desde'),
  vigenciaHasta: date('vigencia_hasta'),
  archivoStorageKey: varchar('archivo_storage_key', { length: 500 }),
  archivoFilename: varchar('archivo_filename', { length: 300 }),
  archivoSize: integer('archivo_size'),
  archivoMime: varchar('archivo_mime', { length: 100 }),
  estado: docEstadoEnum('estado').notNull().default('vigente'),
  destinatariosExtra: text('destinatarios_extra').array().notNull().default(sql`'{}'::text[]`),
  notas: text('notas'),
  subidoPor: integer('subido_por').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const driverAlertsSent = pgTable('driver_alerts_sent', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  documentoId: integer('documento_id').notNull().references(() => driverDocuments.id, { onDelete: 'cascade' }),
  diasAnticipacion: integer('dias_anticipacion').notNull(),
  enviadoAt: timestamp('enviado_at', { withTimezone: true }).notNull().defaultNow(),
  destinatarios: text('destinatarios').array().notNull(),
  emailMessageId: varchar('email_message_id', { length: 200 }),
  resultado: varchar('resultado', { length: 20 }).notNull(),
  errorMsg: text('error_msg'),
});

export const safetyTrainings = pgTable('safety_trainings', {
  id: serial('id').primaryKey(),
  titulo: varchar('titulo', { length: 150 }).notNull(),
  descripcion: text('descripcion'),
  horas: numeric('horas', { precision: 4, scale: 1 }).notNull(),
  fecha: date('fecha').notNull(),
  instructor: varchar('instructor', { length: 120 }),
  modalidad: trainingModalidadEnum('modalidad').notNull().default('presencial'),
  linkMaterial: text('link_material'),
  vigenciaMeses: integer('vigencia_meses'),
  creadaPor: integer('creada_por').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const trainingAttendees = pgTable('training_attendees', {
  trainingId: integer('training_id').notNull().references(() => safetyTrainings.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  asistio: boolean('asistio').notNull().default(false),
  calificacion: numeric('calificacion', { precision: 4, scale: 2 }),
  certificadoStorageKey: varchar('certificado_storage_key', { length: 500 }),
  registradoAt: timestamp('registrado_at', { withTimezone: true }).notNull().defaultNow(),
});

export const roadIncidents = pgTable('road_incidents', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tipo: incidentTipoEnum('tipo').notNull(),
  vehicleId: integer('vehicle_id').references(() => vehicles.id, { onDelete: 'set null' }),
  conductorId: integer('conductor_id').references(() => users.id, { onDelete: 'set null' }),
  fecha: date('fecha').notNull(),
  hora: time('hora'),
  lugarTexto: varchar('lugar_texto', { length: 300 }),
  lat: numeric('lat', { precision: 9, scale: 6 }),
  lng: numeric('lng', { precision: 9, scale: 6 }),
  gravedad: incidentGravedadEnum('gravedad').notNull().default('sin'),
  descripcion: text('descripcion'),
  costos: numeric('costos', { precision: 12, scale: 2 }).notNull().default('0'),
  victimasCount: integer('victimas_count').notNull().default(0),
  diasPerdidos: integer('dias_perdidos').notNull().default(0),
  comparendoNumero: varchar('comparendo_numero', { length: 40 }),
  valorMulta: numeric('valor_multa', { precision: 12, scale: 2 }),
  fotosKeys: text('fotos_keys').array().notNull().default(sql`'{}'::text[]`),
  reportadoPor: integer('reportado_por').references(() => users.id),
  estado: incidentEstadoEnum('estado').notNull().default('abierto'),
  // PESV-S6 Paso 13 — investigación causa raíz estructurada
  causaRaizMetodo: pesvCausaRaizMetodoEnum('causa_raiz_metodo'),
  causaRaizJsonb: jsonb('causa_raiz_jsonb'),
  investigacionResponsableId: integer('investigacion_responsable_id').references(() => users.id),
  investigacionCerradaAt: timestamp('investigacion_cerrada_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
});

export const incidentActions = pgTable('incident_actions', {
  id: serial('id').primaryKey(),
  incidentId: bigint('incident_id', { mode: 'number' }).notNull().references(() => roadIncidents.id, { onDelete: 'cascade' }),
  descripcion: text('descripcion').notNull(),
  responsableId: integer('responsable_id').references(() => users.id),
  fechaLimite: date('fecha_limite'),
  fechaCumplimiento: date('fecha_cumplimiento'),
  evidenciaStorageKey: varchar('evidencia_storage_key', { length: 500 }),
  estado: actionEstadoEnum('estado').notNull().default('pendiente'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================================
// Sprint 3B — Operación PESV (checklists, alcoholimetría, emergencias)
// ============================================================================

export const checklistFreqEnum = pgEnum('checklist_freq', ['diaria', 'semanal', 'mensual']);
export const checklistDecisionEnum = pgEnum('checklist_decision', ['apto', 'no_apto', 'condicional']);
export const itemCriterioEnum = pgEnum('item_criterio', ['booleano', 'tres_estados', 'numerico']);
export const itemEstadoEnum = pgEnum('item_estado', ['bueno', 'regular', 'malo']);
export const alcoholTestTipoEnum = pgEnum('alcohol_test_tipo', ['preoperacional', 'aleatoria', 'post_incidente', 'periodica']);
export const alcoholResultadoEnum = pgEnum('alcohol_resultado', ['negativo', 'positivo', 'inconcluso']);
export const emergencyContactTipoEnum = pgEnum('emergency_contact_tipo', ['arl', 'ambulancia', 'bombero', 'policia', 'taller_grua', 'aseguradora', 'interno']);
export const emergencyCategoriaEnum = pgEnum('emergency_categoria', ['accidente', 'averia', 'medico', 'seguridad']);

export const checklistTemplates = pgTable('checklist_templates', {
  id: serial('id').primaryKey(),
  titulo: varchar('titulo', { length: 150 }).notNull(),
  vehiculoTipo: vehicleTypeEnum('vehiculo_tipo'),
  frecuencia: checklistFreqEnum('frecuencia').notNull().default('diaria'),
  vigente: boolean('vigente').notNull().default(true),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer('created_by').references(() => users.id),
});

export const checklistTemplateItems = pgTable('checklist_template_items', {
  id: serial('id').primaryKey(),
  templateId: integer('template_id').notNull().references(() => checklistTemplates.id, { onDelete: 'cascade' }),
  orden: integer('orden').notNull(),
  categoria: varchar('categoria', { length: 40 }),
  label: varchar('label', { length: 200 }).notNull(),
  criterio: itemCriterioEnum('criterio').notNull().default('tres_estados'),
  obligatorio: boolean('obligatorio').notNull().default(true),
  critico: boolean('critico').notNull().default(false),
  unidad: varchar('unidad', { length: 20 }),
  minValor: numeric('min_valor'),
  maxValor: numeric('max_valor'),
});

export const checklists = pgTable('checklists', {
  id: serial('id').primaryKey(),
  vehicleId: integer('vehicle_id').notNull().references(() => vehicles.id, { onDelete: 'restrict' }),
  conductorId: integer('conductor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  templateId: integer('template_id').notNull().references(() => checklistTemplates.id, { onDelete: 'restrict' }),
  templateVersion: integer('template_version').notNull(),
  fechaHora: timestamp('fecha_hora', { withTimezone: true }).notNull().defaultNow(),
  medicionActual: integer('medicion_actual'),
  lat: numeric('lat', { precision: 9, scale: 6 }),
  lng: numeric('lng', { precision: 9, scale: 6 }),
  decision: checklistDecisionEnum('decision').notNull(),
  firmaPinVerificado: boolean('firma_pin_verificado').notNull().default(false),
  qrToken: varchar('qr_token', { length: 64 }).notNull().unique(),
  observacionesGenerales: text('observaciones_generales'),
  anuladoAt: timestamp('anulado_at', { withTimezone: true }),
  anuladoPor: integer('anulado_por').references(() => users.id),
  anuladoMotivo: text('anulado_motivo'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const checklistResponses = pgTable('checklist_responses', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  checklistId: integer('checklist_id').notNull().references(() => checklists.id, { onDelete: 'cascade' }),
  itemId: integer('item_id').notNull().references(() => checklistTemplateItems.id, { onDelete: 'restrict' }),
  valorBool: boolean('valor_bool'),
  valorEstado: itemEstadoEnum('valor_estado'),
  valorNum: numeric('valor_num', { precision: 12, scale: 2 }),
  observacion: text('observacion'),
  fotoStorageKeys: text('foto_storage_keys').array().notNull().default(sql`'{}'::text[]`),
});

export const alcoholTests = pgTable('alcohol_tests', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  conductorId: integer('conductor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  fechaHora: timestamp('fecha_hora', { withTimezone: true }).notNull().defaultNow(),
  tipo: alcoholTestTipoEnum('tipo').notNull(),
  valorMg: numeric('valor_mg', { precision: 4, scale: 2 }).notNull(),
  gradoAlcohol: smallint('grado_alcohol').notNull().default(0),
  resultado: alcoholResultadoEnum('resultado').notNull(),
  equipoSerial: varchar('equipo_serial', { length: 60 }),
  equipoCalibracionFecha: date('equipo_calibracion_fecha'),
  operadorId: integer('operador_id').notNull().references(() => users.id),
  incidentId: bigint('incident_id', { mode: 'number' }).references(() => roadIncidents.id, { onDelete: 'set null' }),
  fotoEvidenciaKeys: text('foto_evidencia_keys').array().notNull().default(sql`'{}'::text[]`),
  accionTomada: text('accion_tomada'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const emergencyContacts = pgTable('emergency_contacts', {
  id: serial('id').primaryKey(),
  tipo: emergencyContactTipoEnum('tipo').notNull(),
  zona: varchar('zona', { length: 100 }).notNull(),
  nombre: varchar('nombre', { length: 150 }).notNull(),
  telefono: varchar('telefono', { length: 40 }).notNull(),
  telefonoAlternativo: varchar('telefono_alternativo', { length: 40 }),
  email: varchar('email', { length: 150 }),
  direccion: varchar('direccion', { length: 300 }),
  observaciones: text('observaciones'),
  prioridad: smallint('prioridad').notNull().default(100),
  activo: boolean('activo').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const emergencyProtocols = pgTable('emergency_protocols', {
  id: serial('id').primaryKey(),
  titulo: varchar('titulo', { length: 200 }).notNull(),
  categoria: emergencyCategoriaEnum('categoria').notNull(),
  descripcionMd: text('descripcion_md').notNull(),
  zonas: text('zonas').array().notNull().default(sql`'{}'::text[]`),
  version: integer('version').notNull().default(1),
  vigente: boolean('vigente').notNull().default(true),
  archivoPdfStorageKey: varchar('archivo_pdf_storage_key', { length: 500 }),
  createdBy: integer('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const emergencyDrills = pgTable('emergency_drills', {
  id: serial('id').primaryKey(),
  fecha: date('fecha').notNull(),
  escenario: varchar('escenario', { length: 200 }).notNull(),
  protocoloId: integer('protocolo_id').references(() => emergencyProtocols.id, { onDelete: 'set null' }),
  participantes: integer('participantes').array().notNull().default(sql`'{}'::int[]`),
  evidenciaStorageKeys: text('evidencia_storage_keys').array().notNull().default(sql`'{}'::text[]`),
  observaciones: text('observaciones'),
  planMejora: text('plan_mejora'),
  responsableId: integer('responsable_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================
// Sprint 4 Fase 4.1 — RNDC (Registro Nacional de Despachos de Carga, Mintransporte)
// ============================================================
export const naturalezaCargaEnum = pgEnum('naturaleza_carga', [
  'carga_normal', 'carga_peligrosa', 'carga_refrigerada',
  'carga_extradimensionada', 'carga_extrapesada',
]);
export const monedaRndcEnum = pgEnum('moneda_rndc', ['COP', 'USD']);
export const tenedorTipoEnum = pgEnum('tenedor_tipo', ['propietario', 'poseedor', 'tenedor']);
export const tipoDocRndcEnum = pgEnum('tipo_doc_rndc', ['CC', 'CE', 'NIT', 'PAS', 'TI', 'RC']);
export const remesaEstadoEnum = pgEnum('remesa_estado', ['borrador', 'activa', 'cumplida', 'anulada']);

// Declarado aquí y no junto a los demás enums RNDC (más abajo) porque `remesas` y
// `manifiestos` lo referencian y pgTable se evalúa al cargar el módulo: dejarlo después
// daría ReferenceError por TDZ.
export const rndcEstadoEnvioEnum = pgEnum('rndc_estado_envio', [
  'no_aplica', 'pendiente_envio', 'enviando', 'aceptado',
  'error_envio', 'fallido_temporal', 'fallido_definitivo', 'cancelado_pre_envio',
]);
export const manifiestoEstadoEnum = pgEnum('manifiesto_estado', [
  'borrador', 'listo', 'radicado_rndc', 'aceptado', 'rechazado', 'cumplido', 'anulado',
]);
export const titularPagoTipoEnum = pgEnum('titular_pago_tipo', ['propietario', 'conductor', 'empresa', 'tercero']);

export const rndcMunicipios = pgTable('rndc_municipios', {
  codigoDane: varchar('codigo_dane', { length: 5 }).primaryKey(),
  nombre: varchar('nombre', { length: 120 }).notNull(),
  departamentoCodigo: varchar('departamento_codigo', { length: 2 }).notNull(),
  departamentoNombre: varchar('departamento_nombre', { length: 80 }).notNull(),
  vigente: boolean('vigente').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const rndcProductosTransportar = pgTable('rndc_productos_transportar', {
  codigo: varchar('codigo', { length: 10 }).primaryKey(),
  nombre: varchar('nombre', { length: 200 }).notNull(),
  naturaleza: naturalezaCargaEnum('naturaleza').notNull().default('carga_normal'),
  unidadMedidaDefault: varchar('unidad_medida_default', { length: 10 }),
  vigente: boolean('vigente').notNull().default(true),
});

export const rndcEmpaques = pgTable('rndc_empaques', {
  codigo: varchar('codigo', { length: 10 }).primaryKey(),
  nombre: varchar('nombre', { length: 80 }).notNull(),
  vigente: boolean('vigente').notNull().default(true),
});

export const rndcUnidadesMedida = pgTable('rndc_unidades_medida', {
  codigo: varchar('codigo', { length: 10 }).primaryKey(),
  nombre: varchar('nombre', { length: 80 }).notNull(),
  factorConversionKg: numeric('factor_conversion_kg', { precision: 14, scale: 6 }),
  vigente: boolean('vigente').notNull().default(true),
});

export const rndcModosPago = pgTable('rndc_modos_pago', {
  codigo: varchar('codigo', { length: 10 }).primaryKey(),
  nombre: varchar('nombre', { length: 80 }).notNull(),
  vigente: boolean('vigente').notNull().default(true),
});

export const tenedores = pgTable('tenedores', {
  id: serial('id').primaryKey(),
  tipo: tenedorTipoEnum('tipo').notNull().default('tenedor'),
  tipoDoc: tipoDocRndcEnum('tipo_doc').notNull(),
  documento: varchar('documento', { length: 20 }).notNull(),
  nombre: varchar('nombre', { length: 200 }).notNull(),
  direccion: varchar('direccion', { length: 300 }),
  ciudadDane: varchar('ciudad_dane', { length: 5 }).references(() => rndcMunicipios.codigoDane),
  telefono: varchar('telefono', { length: 40 }),
  email: varchar('email', { length: 150 }),
  vinculadoUserId: integer('vinculado_user_id').references(() => users.id),
  activo: boolean('activo').notNull().default(true),
  notas: text('notas'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer('created_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const propietariosCarga = pgTable('propietarios_carga', {
  id: serial('id').primaryKey(),
  tipoDoc: tipoDocRndcEnum('tipo_doc').notNull(),
  documento: varchar('documento', { length: 20 }).notNull(),
  nombre: varchar('nombre', { length: 200 }).notNull(),
  direccion: varchar('direccion', { length: 300 }),
  ciudadDane: varchar('ciudad_dane', { length: 5 }).references(() => rndcMunicipios.codigoDane),
  telefono: varchar('telefono', { length: 40 }),
  email: varchar('email', { length: 150 }),
  clientId: integer('client_id').references(() => clients.id),
  activo: boolean('activo').notNull().default(true),
  notas: text('notas'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer('created_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const destinatariosCarga = pgTable('destinatarios_carga', {
  id: serial('id').primaryKey(),
  tipoDoc: tipoDocRndcEnum('tipo_doc').notNull(),
  documento: varchar('documento', { length: 20 }).notNull(),
  nombre: varchar('nombre', { length: 200 }).notNull(),
  direccion: varchar('direccion', { length: 300 }),
  ciudadDane: varchar('ciudad_dane', { length: 5 }).references(() => rndcMunicipios.codigoDane),
  telefono: varchar('telefono', { length: 40 }),
  email: varchar('email', { length: 150 }),
  activo: boolean('activo').notNull().default(true),
  notas: text('notas'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer('created_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const remesas = pgTable('remesas', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  numero: varchar('numero', { length: 30 }).notNull().unique(),
  consecutivoRndc: varchar('consecutivo_rndc', { length: 30 }),
  clientId: integer('cliente_id').references(() => clients.id),
  propietarioCargaId: integer('propietario_carga_id').references(() => propietariosCarga.id),
  destinatarioCargaId: integer('destinatario_carga_id').references(() => destinatariosCarga.id),
  municipioOrigenDane: varchar('municipio_origen_dane', { length: 5 }).notNull().references(() => rndcMunicipios.codigoDane),
  municipioDestinoDane: varchar('municipio_destino_dane', { length: 5 }).notNull().references(() => rndcMunicipios.codigoDane),
  direccionCargue: varchar('direccion_cargue', { length: 300 }),
  direccionDescargue: varchar('direccion_descargue', { length: 300 }),
  productoCodigo: varchar('producto_codigo', { length: 10 }).references(() => rndcProductosTransportar.codigo),
  naturaleza: naturalezaCargaEnum('naturaleza').notNull().default('carga_normal'),
  empaqueCodigo: varchar('empaque_codigo', { length: 10 }).references(() => rndcEmpaques.codigo),
  unidadMedidaCodigo: varchar('unidad_medida_codigo', { length: 10 }).references(() => rndcUnidadesMedida.codigo),
  cantidadCargada: numeric('cantidad_cargada', { precision: 14, scale: 3 }).notNull(),
  cantidadEntregada: numeric('cantidad_entregada', { precision: 14, scale: 3 }),
  pesoKg: numeric('peso_kg', { precision: 14, scale: 3 }),
  fechaCargue: date('fecha_cargue').notNull(),
  horaCargue: time('hora_cargue'),
  fechaDescargePactada: date('fecha_descargue_pactada'),
  valorFlete: numeric('valor_flete', { precision: 15, scale: 2 }).notNull().default('0'),
  valorAnticipo: numeric('valor_anticipo', { precision: 15, scale: 2 }).notNull().default('0'),
  moneda: monedaRndcEnum('moneda').notNull().default('COP'),
  modoPagoCodigo: varchar('modo_pago_codigo', { length: 10 }).references(() => rndcModosPago.codigo),
  estado: remesaEstadoEnum('estado').notNull().default('borrador'),
  manifiestoId: bigint('manifiesto_id', { mode: 'number' }),
  cumplidoAt: timestamp('cumplido_at', { withTimezone: true }),
  cumplidoObservaciones: text('cumplido_observaciones'),
  cumplidoEvidenciaKeys: text('cumplido_evidencia_keys').array().notNull().default(sql`'{}'::text[]`),
  observaciones: text('observaciones'),
  // Estado envío RNDC (Fase 4.2)
  estadoEnvio: rndcEstadoEnvioEnum('estado_envio').notNull().default('no_aplica'),
  intentosEnvio: smallint('intentos_envio').notNull().default(0),
  ultimoIntentoAt: timestamp('ultimo_intento_at', { withTimezone: true }),
  proximoIntentoAt: timestamp('proximo_intento_at', { withTimezone: true }),
  ultimoError: text('ultimo_error'),
  rowVersion: integer('row_version').notNull().default(1),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: integer('deleted_by').references(() => users.id),
  createdBy: integer('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const manifiestos = pgTable('manifiestos', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  numero: varchar('numero', { length: 30 }).notNull().unique(),
  consecutivoRndc: varchar('consecutivo_rndc', { length: 30 }),
  vehiculoPrincipalId: integer('vehiculo_principal_id').notNull().references(() => vehicles.id),
  vehiculoRemolqueId: integer('vehiculo_remolque_id').references(() => vehicles.id),
  conductorId: integer('conductor_id').notNull().references(() => users.id),
  tenedorId: integer('tenedor_id').references(() => tenedores.id),
  municipioOrigenDane: varchar('municipio_origen_dane', { length: 5 }).notNull().references(() => rndcMunicipios.codigoDane),
  municipioDestinoDane: varchar('municipio_destino_dane', { length: 5 }).notNull().references(() => rndcMunicipios.codigoDane),
  fechaExpedicion: date('fecha_expedicion').notNull(),
  fechaPactadaPago: date('fecha_pactada_pago'),
  valorFleteTotal: numeric('valor_flete_total', { precision: 15, scale: 2 }).notNull().default('0'),
  valorAnticipo: numeric('valor_anticipo', { precision: 15, scale: 2 }).notNull().default('0'),
  retencionFuente: numeric('retencion_fuente', { precision: 15, scale: 2 }).notNull().default('0'),
  retencionIca: numeric('retencion_ica', { precision: 15, scale: 2 }).notNull().default('0'),
  titularPagoTipo: titularPagoTipoEnum('titular_pago_tipo').notNull().default('conductor'),
  titularPagoDoc: varchar('titular_pago_doc', { length: 20 }),
  titularPagoNombre: varchar('titular_pago_nombre', { length: 200 }),
  // PII cifrado AES-256-GCM (Ola C-1 2026-05-05). Columna *_legacy_plain dropeada en 0052 (Lote 11 2026-05-06).
  titularPagoCuentaCipher: bytea('titular_pago_cuenta_cipher'),
  titularPagoCuentaIv: bytea('titular_pago_cuenta_iv'),
  titularPagoCuentaAuthTag: bytea('titular_pago_cuenta_auth_tag'),
  titularPagoCuentaAadNonce: uuid('titular_pago_cuenta_aad_nonce'),
  titularPagoCuentaKeyVersion: smallint('titular_pago_cuenta_key_version'),
  observaciones: text('observaciones'),
  qrToken: varchar('qr_token', { length: 64 }).unique(),
  estado: manifiestoEstadoEnum('estado').notNull().default('borrador'),
  rechazoMotivo: text('rechazo_motivo'),
  anuladoMotivo: text('anulado_motivo'),
  anuladoPor: integer('anulado_por').references(() => users.id),
  anuladoAt: timestamp('anulado_at', { withTimezone: true }),
  radicadoAt: timestamp('radicado_at', { withTimezone: true }),
  aceptadoAt: timestamp('aceptado_at', { withTimezone: true }),
  cumplidoAt: timestamp('cumplido_at', { withTimezone: true }),
  // Estado envío RNDC (Fase 4.2)
  estadoEnvio: rndcEstadoEnvioEnum('estado_envio').notNull().default('no_aplica'),
  intentosEnvio: smallint('intentos_envio').notNull().default(0),
  ultimoIntentoAt: timestamp('ultimo_intento_at', { withTimezone: true }),
  proximoIntentoAt: timestamp('proximo_intento_at', { withTimezone: true }),
  ultimoError: text('ultimo_error'),
  rowVersion: integer('row_version').notNull().default(1),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: integer('deleted_by').references(() => users.id),
  createdBy: integer('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const manifiestoRemesas = pgTable('manifiesto_remesas', {
  manifiestoId: bigint('manifiesto_id', { mode: 'number' }).notNull().references(() => manifiestos.id, { onDelete: 'cascade' }),
  remesaId: bigint('remesa_id', { mode: 'number' }).notNull().references(() => remesas.id),
  orden: integer('orden').notNull().default(1),
});

// ============================================================================
// Sprint 4 Fase 4.2 — RNDC envío, WORM operaciones, credenciales cifradas
// ============================================================================

export const rndcOpTipoEnum = pgEnum('rndc_op_tipo', [
  'ingresarRemesa', 'ingresarManifiesto', 'anularManifiesto',
  'anularRemesa', 'consultarEstadoIngreso', 'cumplirManifiesto',
]);
export const rndcOpResultadoEnum = pgEnum('rndc_op_resultado', [
  'ok', 'error_negocio', 'error_tecnico', 'timeout',
]);
// rndcEstadoEnvioEnum se declara arriba, junto a remesaEstadoEnum (lo usan remesas y manifiestos).
export const outboxEstadoEnum = pgEnum('outbox_estado', [
  'pendiente', 'enviado', 'error', 'fallido_definitivo',
]);

// WORM: append-only. Triggers en BD prohíben UPDATE/DELETE.
// El repo solo expone insert() y query() — capa de aplicación refuerza.
export const rndcOperaciones = pgTable('rndc_operaciones', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tipoOp: rndcOpTipoEnum('tipo_op').notNull(),
  entidadTipo: varchar('entidad_tipo', { length: 20 }).notNull(),
  entidadId: integer('entidad_id').notNull(),
  intento: smallint('intento').notNull().default(1),
  modo: varchar('modo', { length: 10 }).notNull(),
  requestXml: text('request_xml'),
  responseXml: text('response_xml'),
  resultado: rndcOpResultadoEnum('resultado').notNull(),
  codigoResultado: varchar('codigo_resultado', { length: 10 }),
  consecutivoRndc: varchar('consecutivo_rndc', { length: 30 }),
  mensaje: text('mensaje'),
  duracionMs: integer('duracion_ms'),
  ipOrigen: varchar('ip_origen', { length: 45 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer('created_by').references(() => users.id),
}, (t) => ({
  byEntidad: index('idx_rndc_op_entidad').on(t.entidadTipo, t.entidadId, t.createdAt),
  byTipoResultado: index('idx_rndc_op_tipo_resultado').on(t.tipoOp, t.resultado),
}));

// Credenciales cifradas AES-256-GCM. AAD vincula cipher a esta fila vía aad_nonce UUID.
export const rndcCredenciales = pgTable('rndc_credenciales', {
  id: smallserial('id').primaryKey(),
  empresaNit: varchar('empresa_nit', { length: 20 }).notNull(),
  habilitadorNit: varchar('habilitador_nit', { length: 20 }).notNull(),
  numNit: varchar('num_nit', { length: 20 }).notNull(),
  claveQrCipher: bytea('clave_qr_cipher').notNull(),
  claveQrIv: bytea('clave_qr_iv').notNull(),
  claveQrAuthTag: bytea('clave_qr_auth_tag').notNull(),
  aadNonce: uuid('aad_nonce').notNull(),
  keyVersion: smallint('key_version').notNull().default(1),
  ambiente: varchar('ambiente', { length: 10 }).notNull().default('sandbox'),
  activo: boolean('activo').notNull().default(true),
  notas: text('notas'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer('created_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: integer('updated_by').references(() => users.id),
});

// Idempotencia persistida. Reemplaza al Map en memoria del mock (que no sobrevive restart).
export const rndcIdempotencyKeys = pgTable('rndc_idempotency_keys', {
  consecutivoLocal: varchar('consecutivo_local', { length: 40 }).primaryKey(),
  entidadTipo: varchar('entidad_tipo', { length: 20 }).notNull(),
  entidadId: integer('entidad_id').notNull(),
  requestHash: varchar('request_hash', { length: 64 }).notNull(),
  consecutivoRndc: varchar('consecutivo_rndc', { length: 30 }),
  resultado: varchar('resultado', { length: 20 }),
  modo: varchar('modo', { length: 10 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

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

// ============================================================================
// PESV Sprint Compliance · Fase 1 Paso 1 (Res. 40595/2022 + Res. 45295)
// ============================================================================
export const pesvPolicyEstadoEnum = pgEnum('pesv_policy_estado', ['borrador', 'vigente', 'reemplazada']);
export const pesvComitePeriodicidadEnum = pgEnum('pesv_comite_periodicidad', ['mensual', 'bimestral', 'trimestral', 'semestral']);
export const pesvComiteRolEnum = pgEnum('pesv_comite_rol', ['presidente', 'secretario', 'lider_pesv', 'vocal', 'representante_conductores', 'hse', 'mantenimiento']);
export const pesvActaEstadoEnum = pgEnum('pesv_acta_estado', ['borrador', 'cerrada']);
export const pesvPlanEstadoEnum = pgEnum('pesv_plan_estado', ['borrador', 'aprobado', 'cerrado']);
export const pesvAccionEstadoEnum = pgEnum('pesv_accion_estado', ['pendiente', 'en_proceso', 'cumplida', 'vencida']);
export const pesvDiagEstadoEnum = pgEnum('pesv_diag_estado', ['borrador', 'cerrado']);
export const pesvFasePhvaEnum = pgEnum('pesv_fase_phva', ['planear', 'hacer', 'verificar', 'actuar']);
// Niveles formales del diagnóstico PHVA (mig 0068, Res. 40595/2022 anexo técnico).
export const pesvNivelEmpresaEnum = pgEnum('pesv_nivel_empresa', ['basico', 'estandar', 'avanzado']);
export const pesvNivelRubricaEnum = pgEnum('pesv_nivel_rubrica', ['no_implementado', 'en_desarrollo', 'implementado', 'sostenido']);

export const pesvPolicy = pgTable('pesv_policy', {
  id: serial('id').primaryKey(),
  version: integer('version').notNull(),
  titulo: varchar('titulo', { length: 200 }).notNull(),
  contenidoMd: text('contenido_md').notNull(),
  pdfStorageKey: varchar('pdf_storage_key', { length: 500 }),
  pdfFirmadoStorageKey: varchar('pdf_firmado_storage_key', { length: 500 }),
  pkcs7Signature: customType<{ data: Buffer; driverData: Buffer }>({ dataType() { return 'bytea'; } })('pkcs7_signature'),
  signerCertPem: text('signer_cert_pem'),
  signatureAlgo: varchar('signature_algo', { length: 40 }),
  vigenciaDesde: date('vigencia_desde').notNull(),
  vigenciaHasta: date('vigencia_hasta'),
  firmadaPor: integer('firmada_por').references(() => users.id),
  firmadaAt: timestamp('firmada_at', { withTimezone: true }),
  hashSha256: customType<{ data: Buffer; driverData: Buffer }>({ dataType() { return 'bytea'; } })('hash_sha256'),
  estado: pesvPolicyEstadoEnum('estado').notNull().default('borrador'),
  optimisticV: integer('optimistic_v').notNull().default(1),
  createdBy: integer('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pesvComite = pgTable('pesv_comite', {
  id: serial('id').primaryKey(),
  nombre: varchar('nombre', { length: 150 }).notNull(),
  periodicidad: pesvComitePeriodicidadEnum('periodicidad').notNull().default('trimestral'),
  activo: boolean('activo').notNull().default(true),
  createdBy: integer('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pesvComiteMiembros = pgTable('pesv_comite_miembros', {
  comiteId: integer('comite_id').notNull().references(() => pesvComite.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id),
  rol: pesvComiteRolEnum('rol').notNull(),
  desde: date('desde').notNull(),
  hasta: date('hasta'),
});

export const pesvComiteActas = pgTable('pesv_comite_actas', {
  id: serial('id').primaryKey(),
  comiteId: integer('comite_id').notNull().references(() => pesvComite.id),
  numero: integer('numero').notNull(),
  fecha: date('fecha').notNull(),
  lugar: varchar('lugar', { length: 200 }),
  agendaMd: text('agenda_md'),
  decisionesMd: text('decisiones_md'),
  asistentesIds: integer('asistentes_ids').array().notNull().default(sql`ARRAY[]::integer[]`),
  ausentesIds: integer('ausentes_ids').array().notNull().default(sql`ARRAY[]::integer[]`),
  pdfStorageKey: varchar('pdf_storage_key', { length: 500 }),
  pdfFirmadoStorageKey: varchar('pdf_firmado_storage_key', { length: 500 }),
  pkcs7Signature: customType<{ data: Buffer; driverData: Buffer }>({ dataType() { return 'bytea'; } })('pkcs7_signature'),
  signerCertPem: text('signer_cert_pem'),
  signatureAlgo: varchar('signature_algo', { length: 40 }),
  hashSha256: customType<{ data: Buffer; driverData: Buffer }>({ dataType() { return 'bytea'; } })('hash_sha256'),
  estado: pesvActaEstadoEnum('estado').notNull().default('borrador'),
  createdBy: integer('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pesvPlanAnual = pgTable('pesv_plan_anual', {
  id: serial('id').primaryKey(),
  anio: smallint('anio').notNull().unique(),
  objetivoGeneral: text('objetivo_general').notNull(),
  presupuestoCop: numeric('presupuesto_cop', { precision: 14, scale: 2 }).notNull().default('0'),
  aprobadoPor: integer('aprobado_por').references(() => users.id),
  aprobadoAt: timestamp('aprobado_at', { withTimezone: true }),
  estado: pesvPlanEstadoEnum('estado').notNull().default('borrador'),
  optimisticV: integer('optimistic_v').notNull().default(1),
  createdBy: integer('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pesvPlanObjetivos = pgTable('pesv_plan_objetivos', {
  id: serial('id').primaryKey(),
  planId: integer('plan_id').notNull().references(() => pesvPlanAnual.id, { onDelete: 'cascade' }),
  codigo: varchar('codigo', { length: 20 }).notNull(),
  descripcion: text('descripcion').notNull(),
  metaPct: numeric('meta_pct', { precision: 5, scale: 2 }).notNull(),
  unidad: varchar('unidad', { length: 50 }),
  responsableId: integer('responsable_id').references(() => users.id),
  fechaLimite: date('fecha_limite'),
});

export const pesvPlanAcciones = pgTable('pesv_plan_acciones', {
  id: serial('id').primaryKey(),
  objetivoId: integer('objetivo_id').notNull().references(() => pesvPlanObjetivos.id, { onDelete: 'cascade' }),
  descripcion: text('descripcion').notNull(),
  responsableId: integer('responsable_id').references(() => users.id),
  fechaInicio: date('fecha_inicio'),
  fechaFin: date('fecha_fin'),
  presupuestoCop: numeric('presupuesto_cop', { precision: 14, scale: 2 }).notNull().default('0'),
  avancePct: numeric('avance_pct', { precision: 5, scale: 2 }).notNull().default('0'),
  estado: pesvAccionEstadoEnum('estado').notNull().default('pendiente'),
  evidenciaKeys: text('evidencia_keys').array().notNull().default(sql`ARRAY[]::text[]`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pesvEstandaresCatalogo = pgTable('pesv_estandares_catalogo', {
  id: serial('id').primaryKey(),
  codigo: varchar('codigo', { length: 20 }).notNull().unique(),
  paso: smallint('paso').notNull(),  // 1..24 (Res. 40595/2022)
  fase: pesvFasePhvaEnum('fase').notNull(),  // planear/hacer/verificar/actuar
  nombre: varchar('nombre', { length: 200 }).notNull(),
  descripcion: text('descripcion'),
  peso: numeric('peso', { precision: 5, scale: 2 }).notNull().default('1.0'),
  vigente: boolean('vigente').notNull().default(true),
  orden: smallint('orden').notNull(),
  // Nivel mínimo de empresa al que aplica el estándar (mig 0068). Default 'avanzado'
  // porque los 24 estándares actuales son nivel avanzado. El seed 0069 ajustará
  // básico/estándar tras concepto MOLANO (gate de fuente literal anexo Res. 40595/2022).
  nivelMinimo: pesvNivelEmpresaEnum('nivel_minimo').notNull().default('avanzado'),
});

export const pesvDiagnosticos = pgTable('pesv_diagnosticos', {
  id: serial('id').primaryKey(),
  anio: smallint('anio').notNull().unique(),
  fecha: date('fecha').notNull(),
  responsableId: integer('responsable_id').notNull().references(() => users.id),
  scoreGlobal: numeric('score_global', { precision: 5, scale: 2 }).notNull().default('0'),
  estado: pesvDiagEstadoEnum('estado').notNull().default('borrador'),
  optimisticV: integer('optimistic_v').notNull().default(1),
  observaciones: text('observaciones'),
  cerradoAt: timestamp('cerrado_at', { withTimezone: true }),
  // Autoclasificación de nivel + justificación opcional Ley 1581 (mig 0068).
  nivelEmpresa: pesvNivelEmpresaEnum('nivel_empresa').notNull().default('avanzado'),
  nivelCriterioJustificacion: text('nivel_criterio_justificacion'),
  createdBy: integer('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pesvDiagnosticoItems = pgTable('pesv_diagnostico_items', {
  diagnosticoId: integer('diagnostico_id').notNull().references(() => pesvDiagnosticos.id, { onDelete: 'cascade' }),
  estandarId: integer('estandar_id').notNull().references(() => pesvEstandaresCatalogo.id),
  scorePct: numeric('score_pct', { precision: 5, scale: 2 }).notNull().default('0'),
  // Rúbrica de 4 niveles (mig 0068). Mapeo canónico:
  // no_implementado=0% · en_desarrollo=50% · implementado=75% · sostenido=100%.
  // El trigger SQL trg_pesv_diag_items_worm valida que scorePct ∈ {0,50,75,100}.
  nivelRubrica: pesvNivelRubricaEnum('nivel_rubrica').notNull().default('no_implementado'),
  evidenciaKeys: text('evidencia_keys').array().notNull().default(sql`ARRAY[]::text[]`),
  comentarios: text('comentarios'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================================
// PESV-S6 · Estándares huérfanos + Log Ley 1581
// ============================================================================
export const pesvAuditoriaTipoEnum = pgEnum('pesv_auditoria_tipo', ['interna', 'externa', 'supert', 'onac']);
export const pesvAuditoriaEstadoEnum = pgEnum('pesv_auditoria_estado', ['planificada', 'en_curso', 'cerrada']);
export const pesvHallazgoSeveridadEnum = pgEnum('pesv_hallazgo_severidad', ['observacion', 'no_conformidad_menor', 'no_conformidad_mayor', 'critico']);
export const pesvHallazgoEstadoEnum = pgEnum('pesv_hallazgo_estado', ['abierto', 'en_remediacion', 'cerrado', 'aceptado']);
export const pesvComunicacionTipoEnum = pgEnum('pesv_comunicacion_tipo', ['politica', 'lecciones_aprendidas', 'capacitacion', 'recordatorio', 'otro']);
export const pesvContratistaEstadoEnum = pgEnum('pesv_contratista_estado', ['vinculado', 'suspendido', 'desvinculado']);
export const pesvContratistaEvalEnum = pgEnum('pesv_contratista_evaluacion', ['apto', 'apto_condicional', 'no_apto']);
// pesvCausaRaizMetodoEnum se declara más arriba junto a incidentEstadoEnum porque roadIncidents lo usa.

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

export const pesvAuditorias = pgTable('pesv_auditorias', {
  id: serial('id').primaryKey(),
  anio: smallint('anio').notNull(),
  tipo: pesvAuditoriaTipoEnum('tipo').notNull(),
  alcance: text('alcance').notNull(),
  fechaPlanificada: date('fecha_planificada').notNull(),
  fechaInicio: date('fecha_inicio'),
  fechaCierre: date('fecha_cierre'),
  auditorExterno: varchar('auditor_externo', { length: 200 }),
  auditorLiderId: integer('auditor_lider_id').references(() => users.id),
  estado: pesvAuditoriaEstadoEnum('estado').notNull().default('planificada'),
  resumen: text('resumen'),
  evidenciaKeys: text('evidencia_keys').array().notNull().default(sql`ARRAY[]::text[]`),
  optimisticV: integer('optimistic_v').notNull().default(1),
  createdBy: integer('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pesvAuditoriaHallazgos = pgTable('pesv_auditoria_hallazgos', {
  id: serial('id').primaryKey(),
  auditoriaId: integer('auditoria_id').notNull().references(() => pesvAuditorias.id, { onDelete: 'cascade' }),
  pasoPesv: smallint('paso_pesv'),
  severidad: pesvHallazgoSeveridadEnum('severidad').notNull(),
  descripcion: text('descripcion').notNull(),
  evidenciaKeys: text('evidencia_keys').array().notNull().default(sql`ARRAY[]::text[]`),
  responsableId: integer('responsable_id').references(() => users.id),
  fechaLimite: date('fecha_limite'),
  estado: pesvHallazgoEstadoEnum('estado').notNull().default('abierto'),
  accionesMd: text('acciones_md'),
  cierreObservaciones: text('cierre_observaciones'),
  cerradoAt: timestamp('cerrado_at', { withTimezone: true }),
  cerradoPor: integer('cerrado_por').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pesvComunicaciones = pgTable('pesv_comunicaciones', {
  id: serial('id').primaryKey(),
  tipo: pesvComunicacionTipoEnum('tipo').notNull(),
  asunto: varchar('asunto', { length: 200 }).notNull(),
  cuerpoMd: text('cuerpo_md').notNull(),
  pdfStorageKey: varchar('pdf_storage_key', { length: 500 }),
  destinatariosRoles: text('destinatarios_roles').array().notNull().default(sql`ARRAY[]::text[]`),
  publicadoAt: timestamp('publicado_at', { withTimezone: true }),
  publicadoPor: integer('publicado_por').references(() => users.id),
  vencimientoAcuse: date('vencimiento_acuse'),
  acusesCount: integer('acuses_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pesvComunicacionAcuses = pgTable('pesv_comunicacion_acuses', {
  comunicacionId: integer('comunicacion_id').notNull().references(() => pesvComunicaciones.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  acuseAt: timestamp('acuse_at', { withTimezone: true }).notNull().defaultNow(),
  ipOrigen: varchar('ip_origen', { length: 45 }),
});

export const pesvContratistas = pgTable('pesv_contratistas', {
  id: serial('id').primaryKey(),
  razonSocial: varchar('razon_social', { length: 200 }).notNull(),
  nit: varchar('nit', { length: 20 }).notNull().unique(),
  contactoNombre: varchar('contacto_nombre', { length: 150 }),
  contactoEmail: varchar('contacto_email', { length: 150 }),
  contactoTelefono: varchar('contacto_telefono', { length: 40 }),
  pesvNivel: varchar('pesv_nivel', { length: 20 }),
  pesvCertificadoStorageKey: varchar('pesv_certificado_storage_key', { length: 500 }),
  pesvVencimiento: date('pesv_vencimiento'),
  evaluacion: pesvContratistaEvalEnum('evaluacion').notNull().default('apto_condicional'),
  proximaEvaluacion: date('proxima_evaluacion'),
  estado: pesvContratistaEstadoEnum('estado').notNull().default('vinculado'),
  observaciones: text('observaciones'),
  createdBy: integer('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================================
// PESV Sprint Compliance · Fase 3 Control de Jornada (Decreto 1079/2015)
// ============================================================================
export const jornadaPausaMotivoEnum = pgEnum('jornada_pausa_motivo', ['descanso', 'comida', 'combustible', 'cargue_descargue', 'otro']);
export const jornadaAlarmaTipoEnum = pgEnum('jornada_alarma_tipo', ['mas_4h_continuas', 'mas_10h_jornada', 'menos_8h_descanso', 'mas_60h_semanal', 'sin_pausa_obligatoria']);
export const jornadaIdemScopeEnum = pgEnum('jornada_idem_scope', ['open', 'close', 'pausa_open', 'pausa_close']);

export const jornadasConductor = pgTable('jornadas_conductor', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  conductorId: integer('conductor_id').notNull().references(() => users.id),
  vehicleId: integer('vehicle_id').references(() => vehicles.id),
  checklistId: integer('checklist_id'),
  inicioAt: timestamp('inicio_at', { withTimezone: true }).notNull(),
  finAt: timestamp('fin_at', { withTimezone: true }),
  horasConduccion: numeric('horas_conduccion', { precision: 6, scale: 2 }),
  horasDescansoPre: numeric('horas_descanso_pre', { precision: 6, scale: 2 }),
  cerrada: boolean('cerrada').notNull().default(false),
  cerradaAutomatica: boolean('cerrada_automatica').notNull().default(false),
  cerradaPor: integer('cerrada_por').references(() => users.id),
  observaciones: text('observaciones'),
  optimisticV: integer('optimistic_v').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const jornadasPausas = pgTable('jornadas_pausas', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  jornadaId: bigint('jornada_id', { mode: 'number' }).notNull().references(() => jornadasConductor.id, { onDelete: 'cascade' }),
  inicioAt: timestamp('inicio_at', { withTimezone: true }).notNull(),
  finAt: timestamp('fin_at', { withTimezone: true }),
  motivo: jornadaPausaMotivoEnum('motivo').notNull().default('descanso'),
  duracionMin: integer('duracion_min'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const jornadasAlarmas = pgTable('jornadas_alarmas', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  jornadaId: bigint('jornada_id', { mode: 'number' }).notNull().references(() => jornadasConductor.id, { onDelete: 'cascade' }),
  tipo: jornadaAlarmaTipoEnum('tipo').notNull(),
  generadaAt: timestamp('generada_at', { withTimezone: true }).notNull().defaultNow(),
  valorObservado: numeric('valor_observado', { precision: 8, scale: 2 }).notNull(),
  valorLimite: numeric('valor_limite', { precision: 8, scale: 2 }).notNull(),
  unidad: varchar('unidad', { length: 20 }).notNull().default('horas'),
  ackBy: integer('ack_by').references(() => users.id),
  ackAt: timestamp('ack_at', { withTimezone: true }),
  ackObservaciones: text('ack_observaciones'),
});

export const jornadasReportesMensuales = pgTable('jornadas_reportes_mensuales', {
  id: serial('id').primaryKey(),
  conductorId: integer('conductor_id').notNull().references(() => users.id),
  anio: smallint('anio').notNull(),
  mes: smallint('mes').notNull(),
  jornadasCount: integer('jornadas_count').notNull().default(0),
  horasTotales: numeric('horas_totales', { precision: 7, scale: 2 }).notNull().default('0'),
  alarmasCount: integer('alarmas_count').notNull().default(0),
  cumpleNorma: boolean('cumple_norma').notNull().default(true),
  detalleJsonb: jsonb('detalle_jsonb'),
  generadoAt: timestamp('generado_at', { withTimezone: true }).notNull().defaultNow(),
  generadoPor: integer('generado_por').references(() => users.id),
});

export const jornadasIdempotencyKeys = pgTable('jornadas_idempotency_keys', {
  key: varchar('key', { length: 80 }).notNull(),
  scope: jornadaIdemScopeEnum('scope').notNull(),
  jornadaId: bigint('jornada_id', { mode: 'number' }).references(() => jornadasConductor.id, { onDelete: 'cascade' }),
  pausaId: bigint('pausa_id', { mode: 'number' }).references(() => jornadasPausas.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id),
  usedAt: timestamp('used_at', { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================================
// PESV Sprint Compliance · Fase 2 Paso 4 — Infraestructura segura
// ============================================================================
export const routeCriticidadEnum = pgEnum('route_criticidad', ['baja', 'media', 'alta', 'critica']);
export const routeWaypointTipoEnum = pgEnum('route_waypoint_tipo', ['origen', 'destino', 'parada_segura', 'area_descanso', 'punto_riesgo', 'zona_peligrosa', 'peaje', 'pernocta', 'cargue', 'descargue']);
export const routeRiskEstadoEnum = pgEnum('route_risk_estado', ['borrador', 'aprobado']);

export const routes = pgTable('routes', {
  id: serial('id').primaryKey(),
  codigo: varchar('codigo', { length: 30 }).notNull().unique(),
  nombre: varchar('nombre', { length: 200 }).notNull(),
  origen: varchar('origen', { length: 200 }).notNull(),
  destino: varchar('destino', { length: 200 }).notNull(),
  distanciaKm: numeric('distancia_km', { precision: 8, scale: 2 }),
  duracionEstimadaMin: integer('duracion_estimada_min'),
  criticidad: routeCriticidadEnum('criticidad').notNull().default('media'),
  modoOperacion: varchar('modo_operacion', { length: 50 }),
  vehiculoTipo: varchar('vehiculo_tipo', { length: 50 }),
  notas: text('notas'),
  activo: boolean('activo').notNull().default(true),
  optimisticV: integer('optimistic_v').notNull().default(1),
  createdBy: integer('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const routeWaypoints = pgTable('route_waypoints', {
  id: serial('id').primaryKey(),
  routeId: integer('route_id').notNull().references(() => routes.id, { onDelete: 'cascade' }),
  orden: smallint('orden').notNull(),
  tipo: routeWaypointTipoEnum('tipo').notNull(),
  nombre: varchar('nombre', { length: 200 }).notNull(),
  descripcion: text('descripcion'),
  lat: numeric('lat', { precision: 9, scale: 6 }),
  lng: numeric('lng', { precision: 9, scale: 6 }),
  telefonoContacto: varchar('telefono_contacto', { length: 40 }),
  observaciones: text('observaciones'),
});

export const routeRiskAnalyses = pgTable('route_risk_analyses', {
  id: serial('id').primaryKey(),
  routeId: integer('route_id').notNull().references(() => routes.id, { onDelete: 'cascade' }),
  trimestre: varchar('trimestre', { length: 7 }).notNull(),
  fecha: date('fecha').notNull(),
  evaluadorId: integer('evaluador_id').notNull().references(() => users.id),
  resumen: text('resumen'),
  estado: routeRiskEstadoEnum('estado').notNull().default('borrador'),
  optimisticV: integer('optimistic_v').notNull().default(1),
  aprobadoAt: timestamp('aprobado_at', { withTimezone: true }),
  aprobadoPor: integer('aprobado_por').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const routeRiskItems = pgTable('route_risk_items', {
  id: serial('id').primaryKey(),
  analisisId: integer('analisis_id').notNull().references(() => routeRiskAnalyses.id, { onDelete: 'cascade' }),
  peligro: varchar('peligro', { length: 300 }).notNull(),
  probabilidad: smallint('probabilidad').notNull(),
  impacto: smallint('impacto').notNull(),
  score: smallint('score'),
  controlesActuales: text('controles_actuales'),
  residualProb: smallint('residual_prob'),
  residualImp: smallint('residual_imp'),
  residualScore: smallint('residual_score'),
  planAccion: text('plan_accion'),
  responsableId: integer('responsable_id').references(() => users.id),
  fechaLimite: date('fecha_limite'),
});

export const routePernoctaZones = pgTable('route_pernocta_zones', {
  id: serial('id').primaryKey(),
  nombre: varchar('nombre', { length: 200 }).notNull(),
  routeId: integer('route_id').references(() => routes.id, { onDelete: 'set null' }),
  lat: numeric('lat', { precision: 9, scale: 6 }),
  lng: numeric('lng', { precision: 9, scale: 6 }),
  capacidad: integer('capacidad'),
  contacto: varchar('contacto', { length: 150 }),
  telefono: varchar('telefono', { length: 40 }),
  protocoloMd: text('protocolo_md'),
  servicios: text('servicios').array().notNull().default(sql`ARRAY[]::text[]`),
  vigente: boolean('vigente').notNull().default(true),
  createdBy: integer('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const routeAssignments = pgTable('route_assignments', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  routeId: integer('route_id').notNull().references(() => routes.id, { onDelete: 'cascade' }),
  remesaId: bigint('remesa_id', { mode: 'number' }).references(() => remesas.id, { onDelete: 'cascade' }),
  manifiestoId: bigint('manifiesto_id', { mode: 'number' }).references(() => manifiestos.id, { onDelete: 'cascade' }),
  asignadoPor: integer('asignado_por').notNull().references(() => users.id),
  asignadoAt: timestamp('asignado_at', { withTimezone: true }).notNull().defaultNow(),
  notas: text('notas'),
});

// ============================================================================
// PESV Sprint Compliance · Fase 9 (S9) — Pasos menores 1.5 / 1.7 / 19
// ============================================================================
export const pesvRaciTipoEnum = pgEnum('pesv_raci_tipo', ['R', 'A', 'C', 'I']);
export const pesvNormativaTipoEnum = pgEnum('pesv_normativa_tipo', ['ley', 'decreto', 'resolucion', 'concepto', 'circular', 'norma_tecnica']);
export const pesvRetencionAccionEnum = pgEnum('pesv_retencion_accion', ['purgar', 'archivar_offline', 'anonimizar']);

export const pesvRaci = pgTable('pesv_raci', {
  id: serial('id').primaryKey(),
  procesoCodigo: varchar('proceso_codigo', { length: 20 }).notNull(),
  procesoNombre: varchar('proceso_nombre', { length: 200 }).notNull(),
  rol: varchar('rol', { length: 40 }).notNull(),
  tipo: pesvRaciTipoEnum('tipo').notNull(),
  descripcion: text('descripcion'),
  optimisticV: integer('optimistic_v').notNull().default(1),
  createdBy: integer('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pesvNormativa = pgTable('pesv_normativa', {
  id: serial('id').primaryKey(),
  codigo: varchar('codigo', { length: 80 }).notNull().unique(),
  tipo: pesvNormativaTipoEnum('tipo').notNull(),
  titulo: text('titulo').notNull(),
  emisor: varchar('emisor', { length: 120 }).notNull(),
  fechaPublicacion: date('fecha_publicacion').notNull(),
  vigente: boolean('vigente').notNull().default(true),
  aplicaA: text('aplica_a').array().notNull().default(sql`ARRAY[]::text[]`),
  urlOficial: varchar('url_oficial', { length: 500 }),
  resumenMd: text('resumen_md'),
  ultimaRevisionAt: timestamp('ultima_revision_at', { withTimezone: true }),
  ultimaRevisionPor: integer('ultima_revision_por').references(() => users.id),
  proximaRevisionAt: timestamp('proxima_revision_at', { withTimezone: true }).notNull(),
  notasMd: text('notas_md'),
  optimisticV: integer('optimistic_v').notNull().default(1),
  createdBy: integer('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pesvNormativaRevisiones = pgTable('pesv_normativa_revisiones', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  normativaId: integer('normativa_id').notNull().references(() => pesvNormativa.id, { onDelete: 'cascade' }),
  revisadaAt: timestamp('revisada_at', { withTimezone: true }).notNull().defaultNow(),
  revisadaPor: integer('revisada_por').notNull().references(() => users.id),
  cambiosObservados: text('cambios_observados'),
  proximaRevisionAt: timestamp('proxima_revision_at', { withTimezone: true }).notNull(),
});

export const pesvRetencionPoliticas = pgTable('pesv_retencion_politicas', {
  id: serial('id').primaryKey(),
  tipoDocumento: varchar('tipo_documento', { length: 60 }).notNull().unique(),
  retencionAnios: smallint('retencion_anios').notNull(),
  baseLegal: varchar('base_legal', { length: 200 }).notNull(),
  accion: pesvRetencionAccionEnum('accion').notNull().default('archivar_offline'),
  habilitado: boolean('habilitado').notNull().default(true),
  notasMd: text('notas_md'),
  optimisticV: integer('optimistic_v').notNull().default(1),
  createdBy: integer('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pesvRetencionLog = pgTable('pesv_retencion_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  politicaId: integer('politica_id').references(() => pesvRetencionPoliticas.id, { onDelete: 'set null' }),
  tipoDocumento: varchar('tipo_documento', { length: 60 }).notNull(),
  cantidadAfectada: integer('cantidad_afectada').notNull().default(0),
  cutoffDate: date('cutoff_date').notNull(),
  accion: pesvRetencionAccionEnum('accion').notNull(),
  ejecutadoAt: timestamp('ejecutado_at', { withTimezone: true }).notNull().defaultNow(),
  ejecutadoPorCron: boolean('ejecutado_por_cron').notNull().default(true),
  ejecutadoPorUser: integer('ejecutado_por_user').references(() => users.id),
  detalleMd: text('detalle_md'),
});

// ============================================================================
// LAFT F2 — KYC empleados (Resolución UIAF 122/2021 + Circular SuperT 4607/2026)
// ============================================================================
export const laftEmployeesKyc = pgTable('laft_employees_kyc', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }).unique(),
  factorPersona: jsonb('factor_persona'),
  factorCanal: jsonb('factor_canal'),
  factorZona: jsonb('factor_zona'),
  antecedentesCheckAt: timestamp('antecedentes_check_at', { withTimezone: true }),
  antecedentesResultado: jsonb('antecedentes_resultado'),
  antecedentesDocumentoPath: text('antecedentes_documento_path'),
  pep: boolean('pep').notNull().default(false),
  pepDetalle: text('pep_detalle'),
  riskLevel: varchar('risk_level', { length: 10 }).notNull().default('bajo'),
  matchBlocked: boolean('match_blocked').notNull().default(false),
  matchBlockedReason: text('match_blocked_reason'),
  nextReviewAt: date('next_review_at').notNull(),
  observaciones: text('observaciones'),
  version: integer('version').notNull().default(1),
  createdBy: integer('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: integer('updated_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  nextReviewIdx: index('idx_laft_emp_kyc_next_review').on(t.nextReviewAt),
  blockedIdx: index('idx_laft_emp_kyc_blocked').on(t.userId),
  riskIdx: index('idx_laft_emp_kyc_risk').on(t.riskLevel),
}));

// ============================================================================
// LAFT/SARLAFT v2 — F5: Manual versionado, oficial cumplimiento, auditorías
// (mig 0066 + 0067). Resolución 4607/2026 SuperTransporte.
// ============================================================================
export const laftManualVersions = pgTable('laft_manual_versions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  version: integer('version').notNull().unique(),
  titulo: varchar('titulo', { length: 200 }).notNull().default('Manual SARLAFT'),
  contenidoMd: text('contenido_md').notNull(),
  sha256: varchar('sha256', { length: 64 }).notNull(),
  pdfStorageKey: text('pdf_storage_key'),
  firmadoPorRepresentante: integer('firmado_por_representante').references(() => users.id),
  firmadoPorOficial: integer('firmado_por_oficial').references(() => users.id),
  firmadoAt: timestamp('firmado_at', { withTimezone: true }),
  publicado: boolean('publicado').notNull().default(false),
  publicadoAt: timestamp('publicado_at', { withTimezone: true }),
  motivoCambio: text('motivo_cambio'),
  createdBy: integer('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  publicadoIdx: index('idx_laft_manual_publicado').on(t.version),
}));

export const laftComplianceOfficers = pgTable('laft_compliance_officers', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id),
  rol: varchar('rol', { length: 20 }).notNull(),
  certificacionIso17024: boolean('certificacion_iso17024').notNull().default(false),
  certificacionDocStorageKey: text('certificacion_doc_storage_key'),
  designadoPor: integer('designado_por').notNull().references(() => users.id),
  actaJuntaStorageKey: text('acta_junta_storage_key'),
  validFrom: date('valid_from').notNull(),
  validTo: date('valid_to'),
  revocadoAt: timestamp('revocado_at', { withTimezone: true }),
  revocadoMotivo: text('revocado_motivo'),
  revocadoPor: integer('revocado_por').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  vigentesIdx: index('idx_laft_officer_vigentes').on(t.rol),
  userIdx: index('idx_laft_officer_user').on(t.userId),
}));

export const laftAuditPlans = pgTable('laft_audit_plans', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  anio: integer('anio').notNull(),
  tipo: varchar('tipo', { length: 20 }).notNull(),
  alcance: text('alcance'),
  responsableUserId: integer('responsable_user_id').references(() => users.id),
  responsableExternoNombre: varchar('responsable_externo_nombre', { length: 150 }),
  responsableExternoNit: varchar('responsable_externo_nit', { length: 20 }),
  fechaPlanificada: date('fecha_planificada').notNull(),
  fechaEjecutada: date('fecha_ejecutada'),
  hallazgosMd: text('hallazgos_md'),
  conclusionesMd: text('conclusiones_md'),
  evidenciaStorageKey: text('evidencia_storage_key'),
  estado: varchar('estado', { length: 20 }).notNull().default('planeada'),
  createdBy: integer('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  anioIdx: index('idx_laft_audit_plan_anio').on(t.anio, t.tipo),
  estadoIdx: index('idx_laft_audit_plan_estado').on(t.estado),
}));

// ════════════════════════════════════════════════════════════════════════════
// FLITO — SOAT e Impuestos (migración packages/ → Operaciones)
// Ver docs/MIGRACION_FLITO_A_OPERACIONES.md §5. Dominio anclado al VIN (SOAT) y al
// trámite (Impuestos). Los estados y campos OCR viven en @operaciones/shared-types.
// FK a entidades del grande son `integer` (clients/vehicles/users) o `varchar(5)`
// (organismos_transito_config.codigo); las entidades internas FLITO usan `uuid`.
// ════════════════════════════════════════════════════════════════════════════

// Estados unificados de SOAT e impuestos: pendiente | solicitado | con_novedad | pagado (ver
// flito-estados.ts). Los valores viejos (en_adquisicion, en_gestion, sin_factura, retenido,
// rechazado, no_aplica) quedan deprecados en el enum de Postgres, pero se omiten del literal.
export const flitoImpuestoEstadoEnum = pgEnum('flito_impuesto_estado', ['pendiente', 'solicitado', 'con_novedad', 'pagado']);
/** HU #12825: ciclo del análisis post-envío. NULL en la columna = nunca encolado (histórico). */
export const flitoImpuestoAnalisisEstadoEnum = pgEnum('flito_impuesto_analisis_estado', ['en_curso', 'completado', 'error_analisis']);
/** HU #12827: semáforo factura vs RUNT. NULL en la columna = sin calcular. */
export const flitoImpuestoSemaforoEnum = pgEnum('flito_impuesto_semaforo', ['verde', 'naranja', 'rojo']);

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

// Impuesto, uno por trámite (tramite_id UNIQUE).
export const flitoImpuestos = pgTable('flito_impuestos', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** true = creado por un desbloqueo excepcional pese a que la compañía autogestiona (HU #10980). */
  excepcionAutogestion: boolean('excepcion_autogestion').notNull().default(false),
  tramiteId: uuid('tramite_id').notNull().unique().references(() => flitoTramites.id),
  estado: flitoImpuestoEstadoEnum('estado').notNull().default('pendiente'),
  organismoCodigo: varchar('organismo_codigo', { length: 5 }).notNull().references(() => organismosTransitoConfig.codigo),
  companiaId: integer('compania_id').notNull().references(() => clients.id),
  // Snapshot de la modalidad al crear el registro (CA-04).
  modalidadAplicada: flitoModalidadEnum('modalidad_aplicada').notNull(),
  valorLiquidado: numeric('valor_liquidado', { precision: 14, scale: 2 }),
  valorPagado: numeric('valor_pagado', { precision: 14, scale: 2 }),
  marcadoPorDiferencia: boolean('marcado_por_diferencia').notNull().default(false),
  // Factura de venta = precondición del envío. Referencia por id (sin FK dura: evita
  // ciclo con flito_soportes, igual que en el modelo original).
  facturaVentaSoporteId: uuid('factura_venta_soporte_id'),
  extraccionFacturaVenta: jsonb('extraccion_factura_venta').$type<ExtraccionFacturaVentaImpuesto>(),
  /**
   * Gemelo del de `flito_soat` (HU #11152 trae la columna; #11155 la usa). Aquí pesa más: el
   * destinatario del impuesto no es un proveedor sino el gestor de `organismo_codigo`, así que esta
   * bandera es lo ÚNICO que puede sacarlo de su cola y evitar que se pague dos veces.
   */
  gestionOperaciones: boolean('gestion_operaciones').notNull().default(false),
  gestionOperacionesMotivo: text('gestion_operaciones_motivo'),
  gestionOperacionesPorId: integer('gestion_operaciones_por_id').references(() => users.id),
  gestionOperacionesEn: timestamp('gestion_operaciones_en', { withTimezone: true }),
  enviadoPorId: integer('enviado_por_id').references(() => users.id),
  enviadoEn: timestamp('enviado_en', { withTimezone: true }),
  pagadoEn: timestamp('pagado_en', { withTimezone: true }),
  /**
   * HU #12590: fecha-hora en que se cargó la liquidación del impuesto (el documento de la hacienda
   * sin marca). Marca «liquidado» sobre `solicitado`; el estado NO cambia. No es
   * `flito_liquidaciones.liquidado_en` (esa es la Liquidación de FLITO, el total a cobrar).
   */
  liquidadoEn: timestamp('liquidado_en', { withTimezone: true }),
  motivoRechazo: text('motivo_rechazo'),
  extraccion: jsonb('extraccion').$type<ExtraccionImpuesto>(),
  /**
   * HU #12825 (migración 0206): análisis post-envío en segundo plano. `analizadoEn` solo se escribe
   * si corrió al menos un paso; con él poblado y posterior al encolado, el job no re-ejecuta (AC2).
   * `analisisReencolados` lo sube solo la recuperación de huérfanos (AC4: una vez).
   */
  analisisEstado: flitoImpuestoAnalisisEstadoEnum('analisis_estado'),
  analisisEncoladoEn: timestamp('analisis_encolado_en', { withTimezone: true }),
  analisisReencolados: smallint('analisis_reencolados').notNull().default(0),
  analizadoEn: timestamp('analizado_en', { withTimezone: true }),
  /** HU #12827 (migración 0207): semáforo factura de venta vs RUNT y su detalle (motivo en el jsonb). */
  semaforo: flitoImpuestoSemaforoEnum('semaforo'),
  comparacionFacturaRunt: jsonb('comparacion_factura_runt').$type<ComparacionFacturaRunt>(),
  /**
   * HU #12833 (migración 0208): dirección del comprador CONFIRMADA (de la factura o corregida a mano).
   * Vive aquí y no en `flito_compradores` porque el sync con FLIT borra y reinserta esa tabla.
   * `direccionFuente` es el discriminante: NULL = se lee la de FLIT; 'factura' | 'manual'.
   * La propuesta sin confirmar sigue en `extraccionFacturaVenta` (no se duplica).
   */
  direccionFactura: text('direccion_factura'),
  municipioFactura: text('municipio_factura'),
  departamentoFactura: text('departamento_factura'),
  direccionFuente: text('direccion_fuente').$type<'factura' | 'manual'>(),
  direccionPendienteRevision: boolean('direccion_pendiente_revision').notNull().default(false),
  direccionConfirmadaPorId: integer('direccion_confirmada_por_id').references(() => users.id, { onDelete: 'set null' }),
  direccionConfirmadaPorNombre: text('direccion_confirmada_por_nombre'),
  direccionConfirmadaEn: timestamp('direccion_confirmada_en', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  estadoIdx: index('idx_flito_impuestos_estado').on(t.estado),
  organismoIdx: index('idx_flito_impuestos_organismo').on(t.organismoCodigo),
  analisisEnCursoIdx: index('idx_flito_impuestos_analisis_en_curso').on(t.analisisEncoladoEn)
    .where(sql`${t.analisisEstado} = 'en_curso'`),
}));

/**
 * Certificación de un impuesto contra el RUNT (Feature #11159, HU #11164).
 *
 * Una fila por INTENTO exitoso de certificación, no una por impuesto: recertificar (RN-10) apaga la
 * anterior con `vigente = false` y escribe otra. El historial completo importa porque el certificado
 * es evidencia frente a una auditoría, y «cuándo se verificó y contra qué respondió el RUNT» es
 * justo lo que se le pregunta a una evidencia.
 *
 * `snapshot_runt` guarda la respuesta cruda para poder regenerar el certificado sin volver a
 * consultar (RN-11: el PDF se genera en caliente, pero desde este snapshot, no desde el RUNT). Es la
 * razón por la que la certificación se persiste aunque el PDF no.
 *
 * Los intentos FALLIDOS no se persisten: una discrepancia o un error de servicio no dejan fila
 * (RN-06, RN-07). El registro conserva su certificación anterior, si la tenía.
 */
export const flitoImpuestoCertificaciones = pgTable('flito_impuesto_certificaciones', {
  id: uuid('id').primaryKey().defaultRandom(),
  impuestoId: uuid('impuesto_id').notNull().references(() => flitoImpuestos.id, { onDelete: 'cascade' }),
  /** Solo una certificación vigente por impuesto — lo garantiza un índice único parcial en la migración. */
  vigente: boolean('vigente').notNull().default(true),
  /**
   * Con qué se identificó el vehículo ante el RUNT. El documento NO es un dato decorativo: es la
   * prueba de propiedad (RN-02) —que el RUNT respondiera OK a la pareja placa+documento es lo que
   * certifica que ese documento es el del propietario registrado—, y por eso viaja al certificado.
   *
   * Cuando FLITO no conoce el documento del titular, la consulta va por VIN y `documentoConsultado`
   * queda nulo (migración 0123). Un CHECK exige que al menos uno de los dos esté presente: sin eso
   * el certificado no diría con qué se le preguntó al RUNT y dejaría de ser auditable.
   */
  placaConsultada: varchar('placa_consultada', { length: 10 }).notNull(),
  documentoConsultado: varchar('documento_consultado', { length: 30 }),
  vinConsultado: varchar('vin_consultado', { length: 17 }),
  /** Código RUNT del tipo de documento que resolvió la consulta ('C', 'E', …). Lo devuelve el RUNT. */
  tipoDocPropietario: varchar('tipo_doc_propietario', { length: 5 }),
  /**
   * Nombre del propietario SEGÚN FLITO, congelado al certificar (HU #11167).
   *
   * No se compara con nada —el RUNT no devuelve al propietario—, pero sí se imprime en el
   * certificado, y lo que el certificado imprime no puede cambiar después de emitido. Nullable: las
   * certificaciones anteriores a la migración 0122 no lo tienen.
   */
  propietarioNombre: varchar('propietario_nombre', { length: 200 }),
  /** Resultado por campo (`ComparacionCampo[]`): qué se comparó, con qué valores y si bloqueaba. */
  campos: jsonb('campos').$type<ComparacionCampo[]>().notNull(),
  /** Respuesta cruda del RUNT. Contiene PII → sujeto a la política de retención de privacidad. */
  snapshotRunt: jsonb('snapshot_runt'),
  certificadoPorId: integer('certificado_por_id').references(() => users.id, { onDelete: 'set null' }),
  // Se copia el nombre además del id: si el usuario se borra, el certificado debe seguir diciendo
  // quién lo emitió. Mismo criterio que `flito_soportes.subido_por_nombre`.
  certificadoPorNombre: varchar('certificado_por_nombre', { length: 150 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  impuestoIdx: index('idx_flito_imp_cert_impuesto').on(t.impuestoId, t.createdAt),
}));

// Cola de revisión OCR (CA-06/CA-07). Los gestores no la resuelven (RN-04/RN-05).
export const flitoRevisiones = pgTable('flito_revisiones', {
  id: uuid('id').primaryKey().defaultRandom(),
  modulo: varchar('modulo', { length: 20 }).notNull(),
  motivo: varchar('motivo', { length: 40 }).notNull(),
  detalle: text('detalle').notNull(),
  registroId: uuid('registro_id'),
  soporteId: uuid('soporte_id').notNull().references(() => flitoSoportes.id, { onDelete: 'cascade' }),
  placaSugerida: varchar('placa_sugerida', { length: 10 }),
  extraccion: jsonb('extraccion').notNull(),
  resuelto: boolean('resuelto').notNull().default(false),
  resueltoPorId: integer('resuelto_por_id').references(() => users.id),
  resueltoEn: timestamp('resuelto_en', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  resueltoIdx: index('idx_flito_revisiones_resuelto').on(t.resuelto),
}));

// ── FLITO Derechos de tránsito (HU #10950) ───────────────────────────────────
// Lo que el organismo cobra por radicar el trámite. A diferencia del SOAT (anclado al VIN, RN-01),
// el derecho se paga POR TRÁMITE: cada radicación tiene el suyo, así que `tramite_id` es UNIQUE.
// No hay máquina de estados: el recibo llega ya pagado, el registro es la prueba de cuánto se pagó.
export const flitoDerechosTramite = pgTable('flito_derechos_tramite', {
  id: uuid('id').primaryKey().defaultRandom(),
  tramiteId: uuid('tramite_id').notNull().unique().references(() => flitoTramites.id, { onDelete: 'cascade' }),
  organismoCodigo: varchar('organismo_codigo', { length: 5 }).references(() => organismosTransitoConfig.codigo),
  companiaId: integer('compania_id').references(() => clients.id),
  valor: numeric('valor', { precision: 14, scale: 2 }),
  fechaPago: date('fecha_pago'),
  numeroRadicado: varchar('numero_radicado', { length: 40 }),
  // Concepto leído del recibo ("MATRICULA INICIAL", "PRENDA"…). Se guarda como texto crudo: cada
  // organismo lo rotula distinto y normalizarlo perdería la evidencia de qué decía el documento.
  tipoTramiteRecibo: varchar('tipo_tramite_recibo', { length: 60 }),
  origen: varchar('origen', { length: 20 }).notNull(),
  // `origen` dice el CANAL ('manual' | 'drive'); estas tres dicen el DOCUMENTO. Con los consolidados
  // del Drive —un PDF de trece páginas por día— saber que vino «del Drive» no permite volver al
  // papel: hacen falta el archivo y la página.
  archivoOrigen: varchar('archivo_origen', { length: 255 }),
  // El barrido que lo produjo, que ya guarda nombre, fileId, quién lo subió y cuándo, y que
  // sobrevive al borrado del archivo en el Drive. Null en carga manual, que no tiene barrido.
  procesamientoId: integer('procesamiento_id').references(() => procesamientoCuentas.id, { onDelete: 'set null' }),
  paginas: jsonb('paginas').$type<number[]>(),
  // Sin FK dura hacia flito_soportes: evita el ciclo (soportes ya referencia esta tabla), igual que
  // flito_impuestos.factura_venta_soporte_id.
  soporteId: uuid('soporte_id'),
  extraccion: jsonb('extraccion').$type<ExtraccionDerechoTramite>(),
  // Discrepancias que no bloquean pero deben quedar trazadas (p.ej. el tipo del recibo no coincide
  // con el del trámite). Lista de strings.
  advertencias: jsonb('advertencias').$type<string[]>(),
  registradoPorId: integer('registrado_por_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  organismoIdx: index('idx_flito_derechos_organismo').on(t.organismoCodigo),
  companiaIdx: index('idx_flito_derechos_compania').on(t.companiaId),
  procesamientoIdx: index('idx_flito_derechos_procesamiento').on(t.procesamientoId),
}));

/**
 * Cambios de estado de SOAT e impuestos — el equivalente de `flito_tramite_historial` para los dos
 * conceptos, que hasta ahora no tenían ninguno y cuyo rastro vivía disperso en `audit_logs`, en
 * texto libre y sin campos de estado.
 *
 * Una sola tabla para ambos, discriminados por `concepto`: comparten los mismos cuatro estados y las
 * mismas transiciones, así que dos tablas gemelas serían dos veces el mismo código.
 *
 * Sin FK hacia `flito_soat`/`flito_impuestos`: una FK apunta a UNA tabla y este historial sirve a
 * dos. La integridad la da `concepto` más el filtro de los lectores.
 */
export const flitoEstadoHistorial = pgTable('flito_estado_historial', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  /** 'soat' | 'impuesto'. */
  concepto: varchar('concepto', { length: 20 }).notNull(),
  registroId: uuid('registro_id').notNull(),
  /** Null en el alta: antes de existir no había estado del que venir. */
  estadoAnterior: varchar('estado_anterior', { length: 30 }),
  estadoNuevo: varchar('estado_nuevo', { length: 30 }).notNull(),
  motivo: text('motivo'),
  usuarioId: integer('usuario_id').references(() => users.id, { onDelete: 'set null' }),
  // Se copia el correo además del id: si el usuario se borra, el historial debe seguir diciendo
  // quién lo hizo. Mismo criterio que `flito_soportes.subido_por_nombre`.
  usuarioEmail: varchar('usuario_email', { length: 150 }),
  /** 'usuario' | 'sistema' | 'auditoria'. El último marca lo reconstruido desde `audit_logs`. */
  origen: varchar('origen', { length: 20 }).notNull().default('usuario'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  registroIdx: index('idx_flito_estado_historial_registro').on(t.concepto, t.registroId, t.createdAt),
}));

// SIN LECTOR. Fue el buffer de recibos cuya placa aún no correspondía a ningún trámite, que un
// reintento cruzaba solo cuando el trámite llegaba desde FLIT. Se retiró por decisión de negocio: la
// bandeja acumulaba comprobantes que en la práctica no llegaban a cruzar, y mantener archivos
// huérfanos en el almacenamiento costaba más que lo que aportaba. Ahora lo que no cruza se descarta
// con un aviso que dice qué recibo y con qué placa.
//
// La definición se queda deliberadamente, igual que se hizo con `flito_reglas_proveedor_soat`: borrar
// datos de una tabla viva en el mismo cambio que quita su único lector es innecesariamente
// irreversible. El DROP va en una migración posterior, cuando esté mergeado y verificado.
export const flitoDerechosPendientes = pgTable('flito_derechos_pendientes', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** 'derecho' | 'soat' | 'impuesto'. La bandeja sirve a los tres conceptos (HU #10982). */
  concepto: varchar('concepto', { length: 20 }).notNull().default('derecho'),
  /** Null cuando el recibo no permitió leerla: el archivo se guarda igual, lo resuelve una persona. */
  placa: varchar('placa', { length: 10 }),
  soporteId: uuid('soporte_id').notNull().references(() => flitoSoportes.id, { onDelete: 'cascade' }),
  organismoCodigo: varchar('organismo_codigo', { length: 5 }),
  valor: numeric('valor', { precision: 14, scale: 2 }),
  fechaPago: date('fecha_pago'),
  numeroRadicado: varchar('numero_radicado', { length: 40 }),
  tipoTramiteRecibo: varchar('tipo_tramite_recibo', { length: 60 }),
  extraccion: jsonb('extraccion').$type<ExtraccionDerechoTramite>(),
  origen: varchar('origen', { length: 20 }).notNull(),
  intentos: integer('intentos').notNull().default(1),
  ultimoIntentoEn: timestamp('ultimo_intento_en', { withTimezone: true }).notNull().defaultNow(),
  resuelto: boolean('resuelto').notNull().default(false),
  resueltoTramiteId: uuid('resuelto_tramite_id').references(() => flitoTramites.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // El reintento barre solo los no resueltos; el índice por placa es el que usa ese barrido.
  pendientePlacaIdx: index('idx_flito_derechos_pendientes_placa').on(t.placa, t.resuelto),
  pendienteConceptoIdx: index('idx_flito_pendientes_concepto').on(t.concepto, t.resuelto),
}));

// ── FLITO Logística (Fase 1) ────────────────────────────────────────────────
// Trazabilidad del documento físico (LT/placa) del organismo al cliente. La unidad es el
// DOCUMENTO individual (RN-01); actas y rutas son agrupaciones sobre él. Los literales de estos
// enums coinciden con packages/shared-types/src/flito-logistica.ts (fuente única del dominio).
export const flitoLogisticaDocEstadoEnum = pgEnum('flito_logistica_doc_estado', ['generado', 'recogido', 'clasificado', 'en_acta', 'despachado', 'entregado', 'novedad', 'devuelto', 'en_flit']); // 'en_flit': 0275 (HU #14109)
export const flitoLogisticaActaEstadoEnum = pgEnum('flito_logistica_acta_estado', ['generada', 'despachada', 'entregada', 'devuelta']);
export const flitoLogisticaTipoDocEnum = pgEnum('flito_logistica_tipo_doc', ['licencia_transito', 'placa', 'otro']);

// Proveedor logístico: mensajería propia (PWA FLITO) o integración con tercero (FEATURE §6).
export const flitoProveedoresLogistica = pgTable('flito_proveedores_logistica', {
  id: uuid('id').primaryKey().defaultRandom(),
  nombre: varchar('nombre', { length: 150 }).notNull().unique(),
  estrategia: varchar('estrategia', { length: 40 }).notNull().default('pwa_propia'),
  activo: boolean('activo').notNull().default(true),
  // HU #14103 (0278): nit (único parcial `uq_flito_proveedores_logistica_nit` en la migración; NULL en filas previas), contacto y teléfono, en la misma línea: el techo congelado de schema.ts no admite crecer.
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), nit: varchar('nit', { length: 20 }), contacto: varchar('contacto', { length: 150 }), telefono: varchar('telefono', { length: 30 }),
});

// Acta: agrupación por empresa para despacho/entrega (CA-04, una por empresa por lote). El acta
// firmada + evidencia (columnas de entrega) se pueblan en la Fase 2 (PWA); aquí quedan definidas.
// HU #14109 (ADR-0030 §17): UNA acta por compañía en los tres puntos (`compania_id` NOT NULL); `punto` y `firmante_id` (FK a
// `flito_logistica_recogida_firmantes`, solo SQL por el import circular; CHECK/único en la 0276). Las columnas viejas (`receptor_*`, `firma_*`) NO se borran hasta la HU de cifrado del histórico.
export const flitoLogisticaActas = pgTable('flito_logistica_actas', {
  id: uuid('id').primaryKey().defaultRandom(),
  companiaId: integer('compania_id').notNull().references(() => clients.id),
  firmanteId: uuid('firmante_id'), punto: varchar('punto', { length: 10 }).notNull().default('cliente'), organismoCodigo: varchar('organismo_codigo', { length: 5 }).references(() => organismosTransitoConfig.codigo), trasladoId: uuid('traslado_id'),
  estado: flitoLogisticaActaEstadoEnum('estado').notNull().default('generada'),
  mensajeroId: integer('mensajero_id').references(() => users.id),
  proveedorLogisticaId: uuid('proveedor_logistica_id').references(() => flitoProveedoresLogistica.id),
  // Snapshot de configuración de la compañía al cerrar el lote.
  permiteParcial: boolean('permite_parcial').notNull().default(false),
  direccionEntrega: varchar('direccion_entrega', { length: 300 }),
  contactoNombre: varchar('contacto_nombre', { length: 150 }), contactoDocumento: varchar('contacto_documento', { length: 30 }),
  // Artefacto y evidencia de la entrega (Fase 2: firma digital + evidencia estructurada, RN-03/9.5).
  pdfStorageKey: varchar('pdf_storage_key', { length: 400 }),
  // Firma de quien ENTREGA (Operaciones), capturada en la consola al despachar el acta.
  firmaEntregaStorageKey: varchar('firma_entrega_storage_key', { length: 400 }),
  entregaNombre: varchar('entrega_nombre', { length: 150 }),
  // Firma de quien RECIBE (receptor en la empresa), capturada en campo por el mensajero.
  firmaStorageKey: varchar('firma_storage_key', { length: 400 }),
  fotoStorageKey: varchar('foto_storage_key', { length: 400 }),
  receptorNombre: varchar('receptor_nombre', { length: 150 }), receptorDocumento: varchar('receptor_documento', { length: 30 }),
  entregadoLat: numeric('entregado_lat', { precision: 10, scale: 7 }), entregadoLng: numeric('entregado_lng', { precision: 10, scale: 7 }),
  entregadoEn: timestamp('entregado_en', { withTimezone: true }),
  motivoDevolucion: text('motivo_devolucion'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  companiaIdx: index('idx_flito_log_actas_compania').on(t.companiaId),
  estadoIdx: index('idx_flito_log_actas_estado').on(t.estado),
  mensajeroIdx: index('idx_flito_log_actas_mensajero').on(t.mensajeroId), trasladoIdx: index('idx_flito_log_actas_traslado').on(t.trasladoId), firmanteCompaniaUq: uniqueIndex('uq_flito_log_actas_firmante_compania').on(t.firmanteId, t.companiaId).where(sql`${t.punto} = 'organismo'`), firmanteCk: check('ck_flito_log_actas_firmante_punto', sql`${t.punto} <> 'organismo' OR ${t.firmanteId} IS NOT NULL`),
}));

// Documento físico individual (RN-01). Congela organismo (dónde se generó) y compañía (destino),
// para que sobreviva a cambios del trámite. Un mismo documento físico no se duplica: (tramite, tipo) único.
export const flitoLogisticaDocumentos = pgTable('flito_logistica_documentos', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** NULL = LT pendiente de trámite (ADR-0030 §17.2): CHECK `tramite_id IS NOT NULL OR compania_id IS NULL`; único parcial (vehiculo_id, tipo) en la 0276. */
  tramiteId: uuid('tramite_id').references(() => flitoTramites.id, { onDelete: 'cascade' }),
  tipo: flitoLogisticaTipoDocEnum('tipo').notNull(),
  estado: flitoLogisticaDocEstadoEnum('estado').notNull().default('generado'),
  // Congelados desde el trámite al generar el documento.
  organismoCodigo: varchar('organismo_codigo', { length: 5 }).notNull().references(() => organismosTransitoConfig.codigo),
  companiaId: integer('compania_id').references(() => clients.id),
  companiaNit: varchar('compania_nit', { length: 30 }),
  vehiculoId: integer('vehiculo_id').notNull().references(() => vehicles.id),
  // Código escaneable / serial del documento (barras/QR). Null hasta la Fase 2 (escaneo).
  identificador: varchar('identificador', { length: 120 }),
  // Datos leídos del PDF417 de la LT al escanear (fuente: código de barras del reverso).
  numeroLicencia: varchar('numero_licencia', { length: 40 }),
  // N.º de la LT: NO viaja en el código (impreso debajo); se captura manual ahora, OCR después.
  numeroLt: varchar('numero_lt', { length: 40 }),
  propietarioNombre: varchar('propietario_nombre', { length: 200 }),
  propietarioDocumento: varchar('propietario_documento', { length: 30 }),
  combustible: varchar('combustible', { length: 30 }),
  // Foto del propietario embebida en el código (JPEG), subida a storage.
  fotoStorageKey: varchar('foto_storage_key', { length: 400 }),
  actaId: uuid('acta_id').references(() => flitoLogisticaActas.id), recogidaFirmanteId: uuid('recogida_firmante_id'),
  /** INDICADOR (no bloqueo): true = falta el acta de organismo de la LT. Backfill 0276: false solo en las ya entregadas. */
  actaOrganismoPendiente: boolean('acta_organismo_pendiente').notNull().default(true),
  // Motivo de la última novedad/devolución (obligatorio en esos estados, RN-04).
  motivo: text('motivo'),
  flitRaw: jsonb('flit_raw'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // Un documento físico por (trámite, tipo): la sincronización repetida no duplica registros (RN-06).
  tramiteTipoUnico: uniqueIndex('uq_flito_log_doc_tramite_tipo').on(t.tramiteId, t.tipo),
  estadoIdx: index('idx_flito_log_doc_estado').on(t.estado),
  companiaIdx: index('idx_flito_log_doc_compania').on(t.companiaId),
  actaIdx: index('idx_flito_log_doc_acta').on(t.actaId), tramiteCompaniaCk: check('ck_flito_log_doc_tramite_compania', sql`${t.tramiteId} IS NOT NULL OR ${t.companiaId} IS NULL`), pendienteUq: uniqueIndex('uq_flito_log_doc_vehiculo_pendiente').on(t.vehiculoId, t.tipo).where(sql`${t.tramiteId} IS NULL`),
}));

// Idempotencia de las escrituras de campo (RN-06/CA-06): la PWA del mensajero encola escrituras
// offline con una clave propia; un reenvío con la misma clave devuelve la respuesta ya guardada en
// vez de re-ejecutar, así una sincronización repetida no duplica recogidas/entregas.
export const flitoLogisticaIdempotencia = pgTable('flito_logistica_idempotencia', {
  idempotencyKey: text('idempotency_key').primaryKey(),
  status: integer('status').notNull(),
  response: jsonb('response').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Bitácora de transición por documento: sostiene CA-07 (actor, hora, ubicación de cada transición),
// RN-04 (motivo) y RN-07 (lat/lng solo en recogida/entrega). Más natural que un diff campo-a-campo.
export const flitoLogisticaEventos = pgTable('flito_logistica_documento_eventos', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentoId: uuid('documento_id').notNull().references(() => flitoLogisticaDocumentos.id, { onDelete: 'cascade' }),
  estadoAnterior: varchar('estado_anterior', { length: 20 }),
  estadoNuevo: varchar('estado_nuevo', { length: 20 }).notNull(),
  actorId: integer('actor_id').references(() => users.id),
  lat: numeric('lat', { precision: 10, scale: 7 }), lng: numeric('lng', { precision: 10, scale: 7 }),
  motivo: text('motivo'),
  origen: varchar('origen', { length: 10 }).notNull(),
  // HU #14109: eventos de traslado/acta (payload solo ids/códigos, NUNCA PII). Nullable: los viejos no los tienen.
  tipo: varchar('tipo', { length: 30 }), trasladoId: uuid('traslado_id'), actaId: uuid('acta_id'), destino: varchar('destino', { length: 10 }), payload: jsonb('payload'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  documentoIdx: index('idx_flito_log_eventos_documento').on(t.documentoId, t.createdAt),
}));
