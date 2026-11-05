// SOAT: `soat_requests` legacy y `flito_soat` con sus satélites, compradores y soportes. Se re-exporta desde `../schema.ts` (HU #13982).
import {
  pgTable, varchar, text, boolean, timestamp, integer, bigint, date, pgEnum, index, uniqueIndex, jsonb,
  numeric, bigserial, uuid, smallint, check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
// FLITO (migración): tipos de extracción OCR persistidos en columnas jsonb.
import type { ExtraccionSoat } from '@operaciones/shared-types';
// SOAT canal Cliente (HU #12093): de dónde salió cada dato del propietario, en columna jsonb.
import type { ProcedenciaCompradorPersistida } from '@operaciones/shared-types';
// Verificación diaria de vigencia del SOAT (HU #12096): motivos de caída de una corrida, en jsonb.
import type { ResumenMotivosCorrida } from '@operaciones/shared-types';
import { users, clients, vehicles, flitoImpuestos, flitoDerechosTramite } from '../schema.js';
import { flitoConciliacionBoletas } from './finanzas.js';
import { flitoSoatIncompletas } from './flito-soat-incompletas.js';
import { siigoFacturas } from './siigo.js';
import { tramitesDigitales, organismosTransitoConfig, flitoTramites } from './tramites.js';

export const statusEnum = pgEnum('soat_status', [
  'pendiente', 'enviado', 'comprado', 'verificado', 'rechazado',
]);

export const soatRequests = pgTable('soat_requests', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  vehicleId: integer('vehicle_id').notNull().references(() => vehicles.id, { onDelete: 'restrict' }),
  tramiteId: integer('tramite_id').references(() => tramitesDigitales.id, { onDelete: 'set null' }),
  status: statusEnum('status').notNull().default('pendiente'),
  requestedBy: integer('requested_by').notNull().references(() => users.id),
  assignedTo: integer('assigned_to').references(() => users.id),
  policyNumber: varchar('policy_number', { length: 50 }),
  insurer: varchar('insurer', { length: 100 }),
  purchaseDate: date('purchase_date'),
  expiryDate: date('expiry_date'),
  runtVerified: boolean('runt_verified').notNull().default(false),
  runtVerifiedAt: timestamp('runt_verified_at', { withTimezone: true }),
  soatHolder: varchar('soat_holder', { length: 200 }),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  vehicleIdIdx: index('idx_soat_requests_vehicle_id').on(t.vehicleId),
  statusIdx: index('idx_soat_requests_status').on(t.status),
}));

export const soatRefreshAttempts = pgTable('soat_refresh_attempts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  soatRequestId: bigint('soat_request_id', { mode: 'number' }).notNull().references(() => soatRequests.id, { onDelete: 'restrict' }),
  triggeredBy: varchar('triggered_by', { length: 20 }).notNull().default('manual'),
  triggeredByUser: integer('triggered_by_user').references(() => users.id),
  result: varchar('result', { length: 30 }).notNull(),
  message: text('message'),
  durationMs: integer('duration_ms'),
  runtMessage: text('runt_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  soatIdIdx: index('idx_soat_refresh_attempts_soat_id').on(t.soatRequestId),
  createdAtIdx: index('idx_soat_refresh_attempts_created_at').on(t.createdAt),
  resultIdx: index('idx_soat_refresh_attempts_result').on(t.result),
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
//
// `pendiente_revision` y `rechazada` estuvieron aquí entre la 0167 y la 0176: eran la cuarentena
// del canal Cliente. La 0176 (Feature #12074, HU #12080) RECREA el tipo sin ellos —igual que hizo
// la 0101 con este mismo enum—, así que a diferencia de los valores viejos de arriba estos no son
// residuo deprecado: ya no existen en la base y escribirlos es un 22P02.
export const flitoSoatEstadoEnum = pgEnum('flito_soat_estado', ['pendiente', 'solicitado', 'con_novedad', 'pagado']);

// Proveedor que adquiere el SOAT (RN-05: determina la estrategia de flujo). HU #13957 (0259): baja lógica (`deleted_at`/
// `deleted_by`) y nombre único solo entre vigentes (exacto, como la constraint que reemplaza): un eliminado lo libera.
export const flitoProveedoresSoat = pgTable('flito_proveedores_soat', {
  id: uuid('id').primaryKey().defaultRandom(),
  nombre: varchar('nombre', { length: 150 }).notNull(),
  estrategia: varchar('estrategia', { length: 40 }).notNull().default('portal'),
  umbralOcr: numeric('umbral_ocr', { precision: 4, scale: 3 }),
  slaHoras: integer('sla_horas'),
  activo: boolean('activo').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), deletedAt: timestamp('deleted_at', { withTimezone: true }), deletedBy: integer('deleted_by').references(() => users.id, { onDelete: 'restrict' }),
}, (t) => ({ nombreVivoUq: uniqueIndex('uq_flito_proveedores_soat_nombre_vivo').on(t.nombre).where(sql`deleted_at IS NULL`) }));

// SOAT anclado al VIN. RN-01 (ADR-0031, migración 0267): a lo sumo UN SOAT ABIERTO (estado <> 'pagado')
// por VIN y por vehículo —índices únicos parciales—; los `pagado` son historial y pueden ser varios.
export const flitoSoat = pgTable('flito_soat', {
  id: uuid('id').primaryKey().defaultRandom(),
  /**
   * true = este SOAT existe por un desbloqueo excepcional, pese a que la compañía autogestiona el
   * suyo (HU #10980). La marca va aquí y no en el trámite porque la cola consulta
   * `flito_soat → clients` sin pasar por `flito_tramites`.
   */
  excepcionAutogestion: boolean('excepcion_autogestion').notNull().default(false),
  /**
   * De qué puerta salió esta fila (Feature #11912): `tramite` (el sync de FLIT, la única que existía
   * hasta hoy) o `cliente` (una compañía la pidió sin trámite digital).
   *
   * Es la ÚNICA columna del canal Cliente que vive en esta tabla, y está aquí porque es lo único que
   * las consultas viejas necesitan poder mirar sin un JOIN: la frontera de autogestión, la cola y el
   * tablero. Todo lo demás del canal —quién la radicó, quién la revisó, la causal del rechazo— vive
   * en `flitoSoatSolicitud`, y el propietario en `flitoCompradores`: `buscarConAcceso()` hace
   * `select` de esta fila ENTERA y la sirve a las rutas del gestor del proveedor, así que meter aquí
   * PII de propietario sería una fuga que ningún test detectaría (ADR-0008 §1.2).
   *
   * `varchar` + CHECK y no un enum de Postgres, al revés que `estado`: `origen` nace hoy y ampliarlo
   * es un DROP/ADD CONSTRAINT barato, mientras que un enum arrastraría a cada migración futura la
   * trampa del 55P04 que este Feature ya paga dos veces.
   */
  origen: varchar('origen', { length: 10 }).notNull().default('tramite'),
  vin: varchar('vin', { length: 17 }).notNull(),
  vehiculoId: integer('vehiculo_id').notNull().references(() => vehicles.id),
  estado: flitoSoatEstadoEnum('estado').notNull().default('pendiente'),
  // Denormalizados y congelados: el SOAT vive más que sus trámites.
  companiaId: integer('compania_id').notNull().references(() => clients.id),
  /**
   * Secretaría de tránsito. Nullable desde la HU #11935 (migración 0171) y **sigue siéndolo desde
   * la HU #11966 (ADR-0010)**, aunque el RUNT haya vuelto a ser compuerta del alta.
   *
   * El organismo NO es compuerta (AC5 de la #11966): el alta escribe el código si el nombre que
   * reporta el RUNT cruza el catálogo, y si no cruza **la fila se crea igual** con `NULL` y el
   * satélite anotando `organismo_no_catalogado`. El `422 organismo_no_catalogado` desapareció de
   * los dos endpoints del canal. Quien lo reintroduzca rompe ese AC.
   *
   * La FK queda — un código escrito tiene que existir en `organismos_transito_config`. El sync y el
   * trámite siguen mandando código. Cola/detalle/export hacen `leftJoin` para no ocultar la fila.
   */
  organismoCodigo: varchar('organismo_codigo', { length: 5 }).references(() => organismosTransitoConfig.codigo),
  proveedorSoatId: uuid('proveedor_soat_id').references(() => flitoProveedoresSoat.id),
  proveedorSobrescrito: boolean('proveedor_sobrescrito').notNull().default(false),
  /**
   * true = la gestión de este SOAT la asume Operaciones en vez de un proveedor (HU #11152,
   * Feature #11150). Es la contingencia: no hay proveedor que atienda el caso, o el que lo tenía
   * no puede.
   *
   * NO confundir con `excepcionAutogestion` ni con `clients.soatAutogestionable`: esos dicen que la
   * COMPAÑÍA se lo gestiona sola y el SOAT ni siquiera debería estar en la cola. Este dice quién
   * dentro de FLITO lo trabaja, y es lo único que decide si el proveedor lo sigue viendo — no el
   * valor de `proveedorSoatId`, que se conserva para poder devolvérselo.
   */
  gestionOperaciones: boolean('gestion_operaciones').notNull().default(false),
  gestionOperacionesMotivo: text('gestion_operaciones_motivo'),
  gestionOperacionesPorId: integer('gestion_operaciones_por_id').references(() => users.id),
  gestionOperacionesEn: timestamp('gestion_operaciones_en', { withTimezone: true }),
  enviadoPorId: integer('enviado_por_id').references(() => users.id),
  enviadoEn: timestamp('enviado_en', { withTimezone: true }),
  pagadoEn: timestamp('pagado_en', { withTimezone: true }),
  valorPagado: numeric('valor_pagado', { precision: 14, scale: 2 }),
  motivoRechazo: text('motivo_rechazo'),
  extraccion: jsonb('extraccion').$type<ExtraccionSoat>(),
  /**
   * Número de póliza NORMALIZADO (solo A-Z0-9, mayúsculas) — Feature #11623, migración 0157.
   *
   * Promovido desde `extraccion->'numeroPoliza'->>'valor'`, que es donde lo dejó el OCR y donde no
   * se puede indexar ni comparar. La copia NO sustituye a `extraccion`: aquella es la prueba de lo
   * que se leyó del documento, con su confianza; esta es la llave operativa con la que una boleta
   * de pago externo cruza contra el SOAT.
   *
   * Nullable: un SOAT `pendiente` todavía no tiene póliza, y el OCR puede no haberla leído. La
   * escriben el backfill de la 0157 (una vez) y `pagarEnTx` (en cada pago), los dos con
   * `polizaParaColumna` de shared-types para que digan exactamente lo mismo.
   *
   * Cuasi-PII: no viaja en path ni en query (AGENTS.md 14).
   */
  numeroPoliza: varchar('numero_poliza', { length: 60 }),
  /**
   * Qué dijo el RUNT la última vez que respondió sobre la vigencia de ESTE SOAT (Feature #12075,
   * HU #12096, migración 0177). Vocabulario: {@link EstadoVigenciaSoat}.
   *
   * **Se llama `estado_vigencia` y no `estado`, y no es preferencia de estilo.** `flito_soat.estado`
   * ya existe y es el enum `flito_soat_estado` con los estados de la SOLICITUD (pendiente,
   * solicitado, con_novedad, pagado). Un `ADD COLUMN IF NOT EXISTS estado` habría sido un no-op
   * silencioso —la columna existe— y el primer `set({ estado: 'vigente' })` habría muerto con
   * `22P02 invalid input value for enum`. Los dos estados son ortogonales: un SOAT `pagado` puede
   * estar `sin_registro`, y de hecho ESA combinación es el hallazgo que este Feature persigue.
   *
   * `varchar` + CHECK y no `pgEnum`, por la misma razón escrita en `origen`: ampliar el vocabulario
   * es un DROP/ADD CONSTRAINT barato, mientras que un enum arrastra el 55P04 que este dominio ya
   * pagó dos veces.
   *
   * El DEFAULT `no_verificado` es la verdad de las ~7 000 filas existentes: de ellas no consta
   * ninguna consulta al RUNT. **Cero backfill** — inventar `vigente` porque están `pagado` sería
   * escribir como hecho lo que este Feature existe para comprobar.
   */
  estadoVigencia: varchar('estado_vigencia', { length: 15 }).notNull().default('no_verificado'),
  /**
   * Cuándo RESPONDIÓ el RUNT, no cuándo se intentó (HU #12096, AC5).
   *
   * La corrida NO la toca cuando el RUNT se cae o el circuito está abierto: si la moviera, un mes de
   * pasarela caída dejaría toda la cola con fecha de anoche y la antigüedad —que es la señal que
   * este Feature mide— diría exactamente lo contrario de lo que pasa. `NULL` = de este SOAT no
   * consta ninguna respuesta del registro.
   */
  verificadaEn: timestamp('verificada_en', { withTimezone: true }),
  /** Hasta cuándo dice el RUNT que la póliza está vigente. `NULL` = respondió por estado, sin fecha. */
  venceEl: date('vence_el'),
  /**
   * Número de póliza QUE REPORTA EL RUNT, normalizado igual que `numero_poliza`.
   *
   * Es OTRA columna a propósito: `numero_poliza` es la que el OCR sacó de la factura de FLITO y con
   * la que se concilia una boleta de pago externo (Feature #11623). Que las dos diverjan es señal
   * útil —una póliza reexpedida—, no ruido; pisar la del OCR con la del registro borraría la llave
   * de conciliación sin que nada se pusiera rojo. **No se proyecta hacia la cola** (HU #12097): es
   * cuasi-PII y colisionaría visualmente con la otra.
   */
  polizaRunt: varchar('poliza_runt', { length: 60 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // Migración 0267 (ADR-0031): los UNIQUE incondicionales de `vin`/`vehiculo_id` se reemplazan por
  // índices de lookup + índices únicos PARCIALES «abierto» (a lo sumo un SOAT no `pagado`).
  // (En una sola línea: `schema.ts` tiene techo de líneas congelado en ESLint.)
  estadoIdx: index('idx_flito_soat_estado').on(t.estado), vinIdx: index('idx_flito_soat_vin').on(t.vin), vehiculoIdx: index('idx_flito_soat_vehiculo').on(t.vehiculoId), vinAbiertoUq: uniqueIndex('uq_flito_soat_vin_abierto').on(t.vin).where(sql`${t.estado} <> 'pagado'`), vehiculoAbiertoUq: uniqueIndex('uq_flito_soat_vehiculo_abierto').on(t.vehiculoId).where(sql`${t.estado} <> 'pagado'`),
  proveedorIdx: index('idx_flito_soat_proveedor').on(t.proveedorSoatId),
  // Migración 0169 (HU #11914), por la auditoría de esquema. Desde la HU #11913 `compania_id` es el
  // PREDICADO OBLIGATORIO del aislamiento del rol `cliente` —lo aplican `condicionesCola()`, que
  // comparten la página, el conteo y las facetas, y `buscarConAcceso()`— y era la única
  // `compania_id` del esquema sin índice, mientras `flito_derechos`, `flito_logistica_actas` y
  // `flito_bolsa_movimientos` ya tenían el suyo. Sin él, cada pantalla del canal Cliente recorre
  // `flito_soat` entera y descarta lo ajeno DESPUÉS de haberlo leído.
  companiaIdx: index('idx_flito_soat_compania').on(t.companiaId),
  // NO único a propósito (ADR-0006 §8): lo crea la migración, y una póliza reexpedida o un `0` que
  // el OCR leyó como `O` haría fallar el `CREATE UNIQUE INDEX` en el despliegue, parando la cadena
  // entera por un dato viejo. El duplicado se resuelve en el cruce, delante de quien puede
  // arreglarlo (`poliza_duplicada`). Parcial: los SOAT pendientes no tienen póliza.
  polizaIdx: index('idx_flito_soat_numero_poliza').on(t.numeroPoliza)
    .where(sql`${t.numeroPoliza} IS NOT NULL`),
  // Declarado AQUÍ y no solo en la migración 0167 a propósito: la lección que dejó escrita la 0157
  // es que un CHECK que solo vive en la base convence a quien lee `schema.ts` de que añadir un valor
  // no necesita migración, y el primer INSERT con el valor nuevo muere con 23514.
  origenChk: check('flito_soat_origen_chk', sql`${t.origen} IN ('tramite', 'cliente')`),
  // `verificada_en` NO lleva índice, y es una decisión MEDIDA (gate de esquema de la HU #12096).
  // El que hubo aquí era INERTE por dos motivos que se refuerzan: un btree se declara
  // `ASC NULLS LAST` y el censo ordena `ASC NULLS FIRST`, que ningún recorrido de ese índice puede
  // suplir; y su predicado —`verificada_en IS NULL OR verificada_en < corte`, un OR de baja
  // selectividad y SIN `LIMIT`— hace que el planificador prefiera seq scan + sort igualmente.
  // Se indexará el día que exista una consulta de antigüedad CON `LIMIT` que lo use, con la cláusula
  // de orden de ESA consulta y comprobando con EXPLAIN que entra. El razonamiento largo, con la
  // medición, está en la migración 0177.
  // Declarado AQUÍ y no solo en la 0177, misma lección de la 0157 que el CHECK de `origen`. Los
  // TRES valores y ni uno más: `vencido` NO se persiste, se deriva de `vence_el` contra el día de
  // Bogotá (ver `ESTADOS_VIGENCIA_SOAT` en shared-types). Un `set({ estadoVigencia: 'vencido' })`
  // tiene que morir con 23514 y no colarse.
  estadoVigenciaChk: check('flito_soat_estado_vigencia_chk',
    sql`${t.estadoVigencia} IN ('vigente', 'sin_registro', 'no_verificado')`),
}));

// `flitoSoatCausalesRechazo` (`flito_soat_causales_rechazo`) vivía aquí: el catálogo del rechazo de
// Operaciones, creado por la 0167 y sembrado por la 0170. La migración 0176 (Feature #12074, HU
// #12080) la BORRA, con su única lectora (`GET /flito/soat/causales-rechazo`) y con la columna que
// la referenciaba. Se retira del esquema en el mismo diff que la migración, y no después: una tabla
// declarada aquí que no existe en la base es un `getTableConfig` verde y un 42P01 en producción.

/**
 * Satélite 1:1 de `flitoSoat` con TODO lo que solo existe cuando el SOAT nació del canal Cliente:
 * quién lo radicó, cuándo, el desenlace de la consulta al RUNT del alta y el rastro de la revisión
 * que hubo entre la 0167 y la 0176 (`revisado_por_*`, `revisado_en`, `reenvios`).
 *
 * **Lo que la HU #12080 retiró de aquí, y por qué el resto se queda.** `causal_rechazo_id` y
 * `observacion_rechazo` se van con la migración 0176: eran el rechazo de Operaciones, un circuito
 * sin usuarios desde que el alta despacha sola. Las columnas del revisor y el contador de reenvíos
 * NO se van: describen lo que de verdad ocurrió sobre las filas de aquel período, están vacías en
 * todo lo nuevo y borrarlas sería reescribir la historia para ahorrar tres columnas nullable.
 *
 * **Por qué una tabla aparte y no doce columnas en `flitoSoat`** (ADR-0008 §1.2, y es la decisión
 * cara de este modelo): `buscarConAcceso()` hace `db.select({ soat: flitoSoat, … })` —la fila
 * ENTERA— y su resultado alimenta el detalle, el rechazo, la reversa, el traspaso y la carga de
 * factura, que son las rutas por las que entra el GESTOR DEL PROVEEDOR. Hoy esa fila es inocua;
 * con la observación del rechazo y los datos de contacto dentro dejaría de serlo, y la regresión
 * sería invisible porque ningún test compara la forma de una fila.
 *
 * `soatId` es la PK: eso da el 1:1 gratis, sin un índice único aparte que alguien pueda olvidar.
 *
 * El PROPIETARIO del vehículo NO está aquí: va a `flitoCompradores`, que es donde la búsqueda de la
 * cola ya lo interroga (§1.3).
 *
 * La escriben las HU #11914 (alta) y #11915 (revisión). La #11913 la crea.
 */
export const flitoSoatSolicitud = pgTable('flito_soat_solicitud', {
  soatId: uuid('soat_id').primaryKey().references(() => flitoSoat.id, { onDelete: 'cascade' }),
  // Quién la radicó. El NOMBRE es el rastro durable —mismo patrón que
  // `flitoSoportes.subidoPorNombre`— y por eso es `NOT NULL`: sobrevive a lo que le pase a la fila
  // de `users`.
  //
  // La FK NO lleva `ON DELETE`, así que PostgreSQL aplica NO ACTION: borrar en duro un usuario que
  // radicó una solicitud FALLA con 23503, no deja este id en NULL. La versión anterior de este
  // comentario —y la prosa gemela de la migración 0167, que no se reescribe porque ya está aplicada
  // y su sha256 registrado en `_kyverum_applied_migrations`— decía lo contrario. Que la columna
  // admita NULL no es consecuencia de ningún borrado; quien la escribe es la HU #11914, y siempre
  // con el usuario que radica.
  solicitadoPorId: integer('solicitado_por_id').references(() => users.id),
  solicitadoPorNombre: varchar('solicitado_por_nombre', { length: 150 }).notNull(),
  solicitadoEn: timestamp('solicitado_en', { withTimezone: true }).notNull().defaultNow(),
  // Quién revisó la solicitud y cuándo, mientras existió la revisión (HU #11915, retirada por la
  // #12080). Ya no las escribe nadie; conservan lo que pasó en las filas de aquel período.
  revisadoPorId: integer('revisado_por_id').references(() => users.id),
  revisadoPorNombre: varchar('revisado_por_nombre', { length: 150 }),
  revisadoEn: timestamp('revisado_en', { withTimezone: true }),
  // Cuántas veces el cliente subsanó y volvió a enviar. Igual que las tres de arriba: sin escritor
  // desde la #12080, se queda en 0 en toda fila nueva.
  reenvios: smallint('reenvios').notNull().default(0),
  /**
   * Desenlace de la verificación RUNT (migración 0171, HU #11935; el significado cambia con la
   * #11966 / ADR-0010). Cuatro columnas derivadas: NUNCA el payload crudo.
   *
   * ── Qué significa cada valor DESDE la HU #11966 ─────────────────────────────────────────────────
   *
   * El RUNT volvió a ser compuerta del alta, así que una fila del canal **nace en `ok`**: si el RUNT
   * no hubiera contestado, o hubiera contestado que no, la fila no existiría (el alta responde
   * 503/422/409 y no inserta). `soat_vigente` nace en `false` por lo mismo — es una lectura
   * concluyente, no un hueco.
   *
   * **`pendiente`, `caido`, `sin_registro` y `no_cuadra` son RESIDUO HISTÓRICO**: solo los llevan las
   * solicitudes radicadas entre la #11935 y la #11966, cuando el alta no esperaba a Kyverum y un job
   * post-commit anotaba el desenlace. Esas filas **no se reescriben ni se reconsultan** (AC6), así
   * que los cuatro valores siguen en el CHECK y en la constante de shared-types. El job que los
   * producía se borró con la #11966: sin función no hay reconsulta posible por descuido.
   *
   * El `default('pendiente')` se conserva por las filas que ya lo tienen y porque el INSERT del alta
   * escribe el valor explícitamente; no describe ya el estado inicial de una fila nueva.
   */
  verificacionEstado: varchar('verificacion_estado', { length: 20 }).notNull().default('pendiente'),
  /** `true`/`false` solo con lectura concluyente (`ok`); `NULL` en los cuatro estados históricos. */
  soatVigente: boolean('soat_vigente'),
  /** Solo si `soat_vigente=true` y el RUNT trajo fecha. Desde la #11966 el alta nace en `false`. */
  soatVigenteHasta: date('soat_vigente_hasta'),
  /**
   * Código máquina del desenlace (mismo vocabulario que `CodigoErrorSolicitudSoat`).
   * Desde la #11966 el único que puede escribir una fila NUEVA es `organismo_no_catalogado`, que no
   * aborta el alta (AC5); `runt_no_disponible`/`runt_sin_registro`/`runt_no_cuadra` son históricos —
   * hoy salen como error HTTP y no hay fila que anotar.
   */
  verificacionCodigo: varchar('verificacion_codigo', { length: 40 }),
  /**
   * Cuándo RESPONDIÓ el RUNT durante el alta (HU #12093, migración 0174).
   *
   * No es `solicitado_en`: aquella dice cuándo se guardó la solicitud y esta cuándo se midió el
   * vehículo. Hoy distan milisegundos —desde ADR-0010 la consulta es compuerta y ocurre dentro de la
   * misma petición— y por eso conviene tenerlas separadas antes de que dejen de coincidir: la ficha
   * enseña «datos del RUNT del …», que es una afirmación sobre el registro nacional y no sobre FLITO.
   *
   * Nullable y SIN backfill: las solicitudes radicadas bajo la #11935 consultaban después del COMMIT
   * (o no consultaban), así que de ellas no consta. `NULL` significa exactamente eso.
   *
   * **La diferencia con `solicitado_en` NO es una duración, y no debe pintarse como tal en ninguna
   * pantalla ni reporte.** Las dos marcas salen de RELOJES DISTINTOS: `solicitado_en` es
   * `defaultNow()`, o sea el reloj del servidor de base de datos, y esta la fija el proceso de la
   * API con `new Date()` justo al volver del RUNT (`flito-soat-cliente.service.ts`,
   * `verificarRuntCompuerta`) — que es lo semánticamente correcto y lo que el AC4 pide. Con API y
   * Postgres en hosts distintos, una deriva de reloj de unos pocos segundos basta para invertir el
   * orden aparente y enseñar «el RUNT respondió después de radicarse», o una duración negativa.
   * No hay CHECK de ordenación entre las dos a propósito: rechazaría altas perfectamente válidas
   * por un problema de relojes ajeno al dato. Cada columna se lee sola, y para «cuánto tardó el
   * RUNT» hace falta medir los dos extremos con el mismo reloj, que hoy nadie hace.
   */
  runtConsultadoEn: timestamp('runt_consultado_en', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  // Mig. 0268 (HU #14017): 'inicial' | 'renovacion' y el SOAT antecesor (solo en renovación).
  tipoSoat: varchar('tipo_soat', { length: 10 }).notNull().default('inicial'), soatAnteriorId: uuid('soat_anterior_id').references(() => flitoSoat.id),
}, (t) => ({
  // `idx_flito_soat_solicitud_causal` se va con su columna en la 0176.
  verificacionEstadoChk: check('flito_soat_solicitud_verificacion_estado_chk', sql`${t.verificacionEstado} IN ('pendiente', 'caido', 'sin_registro', 'no_cuadra', 'ok')`),
  tipoSoatChk: check('flito_soat_solicitud_tipo_soat_chk', sql`${t.tipoSoat} IN ('inicial', 'renovacion')`), anteriorChk: check('flito_soat_solicitud_anterior_chk', sql`${t.tipoSoat} = 'renovacion' OR ${t.soatAnteriorId} IS NULL`),
  anteriorIdx: index('idx_flito_soat_solicitud_anterior').on(t.soatAnteriorId).where(sql`${t.soatAnteriorId} IS NOT NULL`),
}));

/**
 * Una fila por CORRIDA de la verificación diaria de vigencia (Feature #12075, HU #12096, mig. 0177).
 *
 * ── Por qué una tabla y no la clave de `system_kv` que la HU #12095 dejó ────────────────────────
 *
 * El estado de la corrida vivía en `system_kv['flito-soat.vigencia.corrida-dia']`: UNA clave, que el
 * día siguiente SOBRESCRIBE. Si el 4 cerró `parcial` con vehículos sin verificar, el 5 a las 00:10
 * esa constancia desaparecía de la base y solo quedaba en los logs. El AC5 de la #12095 pide cerrar
 * el día «dejando constancia», y con una sola clave la constancia es efímera: sirve para DECIDIR
 * (¿corro hoy?) y no para responder «¿qué días quedaron a medias este mes?». La 0177 retira esa
 * clave; su cabecera deja el NOTICE con lo que se borra.
 *
 * ── La llave es (día, intento), no el día ───────────────────────────────────────────────────────
 *
 * Es lo que hace que un reintento no pise la corrida inicial: `verificados` se SUMA sobre las filas
 * del día y `max(intento)` dice cuántas ejecuciones hubo. Con la llave solo en `dia`, el
 * `onConflictDoUpdate` del intento 2 borraría lo que midió el intento 1 — y con el `target` mal
 * puesto (solo `dia`, sin `intento`) borraría además la corrida del día anterior, que es exactamente
 * la deuda que esta tabla viene a cerrar.
 *
 * ── Lo que NO tiene, a propósito ────────────────────────────────────────────────────────────────
 *
 *   · **Ninguna columna `proximo_intento_en`.** Se DERIVA de `iniciada_en + 1 h` cuando la corrida
 *     sigue `en_curso` y quedan reintentos (CF-06: la cadencia se mide desde el ARRANQUE del
 *     intento, no desde su cierre). Persistirla sería guardar una resta.
 *   · **Ningún identificador de vehículo.** Ni aquí ni en `motivos`: son conteos. Un mapa
 *     vehículo → causa convertiría esta tabla en una lista de VIN con su incidencia.
 *   · **Ningún índice extra sobre `(dia)`**: el único, `(dia, intento)`, lo sirve por prefijo
 *     izquierdo.
 */
export const flitoSoatVerificacionCorridas = pgTable('flito_soat_verificacion_corridas', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Día de la corrida en Bogotá (`yyyy-mm-dd`), NO la fecha del servidor: el contenedor va en UTC. */
  dia: date('dia').notNull(),
  /** 1 es la corrida inicial; 2..4 son los reintentos horarios (`MAX_REINTENTOS` = 3). */
  intento: smallint('intento').notNull(),
  iniciadaEn: timestamp('iniciada_en', { withTimezone: true }).notNull().defaultNow(),
  /** `NULL` = el intento arrancó y no llegó a cerrarse (el proceso murió a mitad). */
  cerradaEn: timestamp('cerrada_en', { withTimezone: true }),
  /**
   * Desenlace del intento, con el MISMO vocabulario que el `EstadoCorrida` del cron —
   * `en_curso | completa | parcial`. No se inventa otro: la lectura del cron reconstruye su
   * `EstadoDelDia` a partir de esta columna, y dos vocabularios obligarían a una traducción que
   * nadie recordaría mantener.
   */
  estado: varchar('estado', { length: 10 }).notNull().default('en_curso'),
  /** Vehículos que el censo devolvió para ESTE intento. */
  total: integer('total').notNull().default(0),
  /** Resueltos con respuesta del RUNT en ESTE intento (un «no» legítimo cuenta como verificado). */
  verificados: integer('verificados').notNull().default(0),
  /** De los verificados, cuántos cambiaron de `estado_vigencia`. Es lo único que se audita por fila. */
  cambiaron: integer('cambiaron').notNull().default(0),
  /**
   * Sin verificar por indisponibilidad de la fuente. **Mayor que cero es lo ÚNICO que reprograma el
   * reintento horario**, así que contar aquí un fallido como verificado apaga el reintento en
   * silencio y para siempre.
   */
  fallidos: integer('fallidos').notNull().default(0),
  /** {@link ResumenMotivosCorrida}: vocabulario cerrado, conteos. Nunca un `err.message` como clave. */
  motivos: jsonb('motivos').$type<ResumenMotivosCorrida>().notNull().default({}),
}, (t) => ({
  diaIntentoUq: uniqueIndex('uq_flito_soat_verif_corrida_dia_intento').on(t.dia, t.intento),
  // Declarado aquí y en la 0177, misma lección de la 0157.
  estadoChk: check('flito_soat_verif_corrida_estado_chk',
    sql`${t.estado} IN ('en_curso', 'completa', 'parcial')`),
}));

/**
 * Comprador(es) del vehículo. Múltiple propietario → varias filas (orden 0 = principal).
 *
 * Desde el Feature #11912 la tabla cuelga de DOS padres, uno y solo uno por fila: el trámite (vía
 * `tramiteId`, como siempre) o el SOAT del canal Cliente (vía `soatId`). El nombre de la tabla ya no
 * cuenta toda la verdad, y es un coste aceptado: la alternativa era tener el concepto «propietario
 * del vehículo» en dos tablas distintas según de dónde viniera el SOAT, con el efecto de que el
 * término de búsqueda de la cola —que interroga ESTA tabla— dejaría de encontrar por propietario
 * justo las solicitudes que el admin tiene que revisar. Un filtro que devuelve menos filas de las
 * que hay, y en verde, es el peor modo de fallo de una pantalla de revisión (ADR-0008 §1.3).
 */
export const flitoCompradores = pgTable('flito_compradores', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Nullable desde la 0167 (antes NOT NULL): una fila del canal Cliente no tiene trámite.
  tramiteId: uuid('tramite_id').references(() => flitoTramites.id, { onDelete: 'cascade' }),
  // El otro padre. `CASCADE` como el de arriba: el propietario no sobrevive a la solicitud.
  soatId: uuid('soat_id').references(() => flitoSoat.id, { onDelete: 'cascade' }),
  /**
   * El tercer padre (HU #12996, migración 0210): la solicitud del canal Cliente APARCADA en
   * `flito_soat_incompletas` porque el RUNT no respondió. Sin `CASCADE`: las incompletas no se
   * borran (las descartadas se conservan, CF-06), así que no hay borrado que propagar.
   */
  soatIncompletaId: uuid('soat_incompleta_id').references(() => flitoSoatIncompletas.id),
  /**
   * El nombre en UNA cadena. Lo escribe el sync fundiendo lo que FLIT manda separado
   * (`flit-http.adapter.ts:74`), y desde la HU #11966 el canal Cliente lo escribe **derivado** de
   * las columnas partidas de abajo (`razon_social ?? "nombres apellidos"`).
   *
   * Sigue siendo NOT NULL y sigue siendo lo que interroga la búsqueda de la cola
   * (`condicionesCola`), pero **ya no es la fuente de verdad del nombre para el canal**: el Excel de
   * una fila `origen='cliente'` lee `nombres`/`apellidos`/`razon_social`. Quien escriba una de las
   * dos vías tiene que escribir la otra en la misma edición, o la cola y el archivo dirán cosas
   * distintas (es lo que obligó a meter `subsanarSolicitud` en el alcance de la #11966).
   */
  nombreCompleto: varchar('nombre_completo', { length: 200 }).notNull(),
  numeroDocumento: varchar('numero_documento', { length: 30 }).notNull(),
  // Catálogo RUNT (CC, CE, TI, PAS, PPT, NIT, RC, PT). Sin CHECK y nullable: las filas que ya
  // existen vinieron del sync sin tipo, y un valor inesperado del RUNT no debe tumbar un alta.
  tipoDocumento: varchar('tipo_documento', { length: 5 }),
  /**
   * El titular PARTIDO (HU #11966, migración 0172): `nombres`/`apellidos` XOR `razon_social`.
   *
   * Las escribe SOLO el canal Cliente. Nullable las tres —y las dos de domicilio— porque las ~7 052
   * filas que ya existen las escribió el sync con el nombre fundido: un NOT NULL obligaría a un
   * backfill que partiera la cadena por el espacio, la heurística que el export rechaza por escrito
   * (falla en cada nombre compuesto y en cada razón social). Las filas de trámite siguen leyendo
   * `flit_raw` y no necesitan estas columnas jamás.
   */
  nombres: varchar('nombres', { length: 200 }),
  apellidos: varchar('apellidos', { length: 200 }),
  razonSocial: varchar('razon_social', { length: 200 }),
  correo: varchar('correo', { length: 150 }),
  celular: varchar('celular', { length: 30 }),
  direccion: varchar('direccion', { length: 300 }),
  /**
   * Municipio y departamento del DOMICILIO del titular (HU #11966). No son la ciudad del trámite ni
   * la jurisdicción del organismo: para una fila `origen='cliente'` la columna `Departamento` del
   * Excel pasa a ser este dato personal, y por eso los dos entran en `CAMPOS_PII_COLA_EXPORT`.
   *
   * Texto libre, sin catálogo DIVIPOLA: el AC solo pide que sean obligatorios en la app. Es lo mismo
   * que ya pasa con `flito_tramites.ciudad`.
   */
  municipio: varchar('municipio', { length: 100 }),
  departamento: varchar('departamento', { length: 100 }),
  /**
   * De dónde salió cada dato del propietario (HU #12093, migración 0174): mapa campo →
   * `'factura' | 'runt' | 'manual'` sobre los nueve campos de `CAMPOS_COMPRADOR_FACTURA`.
   *
   * `NOT NULL DEFAULT '{}'` y sin backfill. El tipo es el PERSISTIDO —un `Partial`— y no el mapa
   * completo, a propósito: las ~7 052 filas del sync de trámites y las radicadas antes de esta HU
   * llevan `{}`, y un `Record` completo aquí le prometería a quien lea la columna una clave que en
   * la mitad de las filas no existe. El alta escribe siempre el mapa COMPLETO (`procedenciaCompleta`,
   * AC3: el defecto es `manual`), que es asignable a esto.
   *
   * La escriben las DOS rutas del canal Cliente que escriben el comprador: el alta con lo que
   * declaró el formulario, y la subsanación con los nueve en `manual` —sus valores acaban de
   * llegar tecleados por una persona—. No es opcional que las dos la escriban: la subsanación
   * reescribe los nueve campos del titular vengan cambiados o no, así que un mapa que se quedara
   * del alta describiría, entero, valores que ya no están en la fila. Ver el docblock del `set` de
   * `subsanarSolicitud`.
   */
  procedencia: jsonb('procedencia').$type<ProcedenciaCompradorPersistida>().notNull().default({}),
  orden: integer('orden').notNull().default(0),
  porcentajeParticipacion: numeric('porcentaje_participacion', { precision: 5, scale: 2 }),
}, (t) => ({
  tramiteIdx: index('idx_flito_compradores_tramite').on(t.tramiteId),
  soatIdx: index('idx_flito_compradores_soat').on(t.soatId),
  // «Uno y solo uno», el patrón literal que `flitoSoportes` ya usa con sus FK. Sin él, una fila
  // podría colgar de los dos padres —y desaparecer con el CASCADE del que no la creó— o de ninguno,
  // que es un propietario huérfano que nadie vuelve a encontrar.
  //
  // Desde la 0210 (HU #12996, ADR-0019) hay un tercer padre: la solicitud INCOMPLETA del canal
  // Cliente. La regla pasa a «trámite XOR (SOAT o incompleta)»: la fila de una incompleta cuelga de
  // ella mientras espera y, al completarse, gana también `soat_id` sin perder el rastro.
  padreChk: check('flito_compradores_padre_chk',
    sql`(${t.tramiteId} IS NOT NULL) <> (${t.soatId} IS NOT NULL OR ${t.soatIncompletaId} IS NOT NULL)`),
  soatIncompletaIdx: index('idx_flito_compradores_soat_incompleta').on(t.soatIncompletaId)
    .where(sql`${t.soatIncompletaId} IS NOT NULL`),
  // «Nunca las dos cosas a la vez» (HU #11966, migración 0172). Las filas legacy lo cumplen: los
  // tres campos NULL. NO se añade el recíproco (`tipo_documento='NIT' ⇒ razon_social IS NOT NULL`):
  // bloquearía a un futuro escritor del sync que rellene `tipo_documento` sin razón social, y la
  // mitad positiva ya la exige Zod en la única ruta que escribe estas columnas.
  //
  // Declarado AQUÍ y no solo en la migración, por la lección de la 0157: un CHECK que solo vive en
  // la base convence a quien lee `schema.ts` de que no hace falta migración, y el primer INSERT
  // nuevo muere con 23514.
  titularChk: check('flito_compradores_titular_chk',
    sql`${t.razonSocial} IS NULL OR (${t.nombres} IS NULL AND ${t.apellidos} IS NULL)`),
}));

// Soporte (archivo) en S3: storage_key sustituye a driveItemId+ruta (decisión D-3).
export const flitoSoportes = pgTable('flito_soportes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tipo: varchar('tipo', { length: 40 }).notNull(),
  nombreArchivo: varchar('nombre_archivo', { length: 300 }).notNull(),
  contentType: varchar('content_type', { length: 100 }).notNull(),
  storageKey: varchar('storage_key', { length: 500 }).notNull(),
  hash: varchar('hash', { length: 64 }).notNull(),
  tamanoBytes: bigint('tamano_bytes', { mode: 'number' }).notNull(),
  soatId: uuid('soat_id').references(() => flitoSoat.id, { onDelete: 'cascade' }),
  impuestoId: uuid('impuesto_id').references(() => flitoImpuestos.id, { onDelete: 'cascade' }),
  // HU #10950: soporte del derecho de tránsito. Nullable como los otros dos: un soporte cuelga de
  // exactamente uno de los tres flujos (o de ninguno, mientras espera en la cola de revisión).
  derechoId: uuid('derecho_id').references(() => flitoDerechosTramite.id, { onDelete: 'cascade' }),
  // HU #11335: el PDF y el XML de la factura electrónica. CUARTA clave foránea nullable del mismo
  // patrón, y no un `tramiteId`: esta tabla nunca ha tenido esa columna, y el trámite se alcanza
  // desde `siigo_factura_tramites`, que además sabe qué facturas siguen vivas. Es una FK HACIA
  // `siigo_facturas`, no una columna sobre ella (AC7).
  siigoFacturaId: uuid('siigo_factura_id').references(() => siigoFacturas.id, { onDelete: 'cascade' }),
  // Feature #11623: QUINTA clave foránea nullable del mismo patrón — el comprobante PSE de la boleta
  // que se conciló (CF-06). La referencia es un thunk, así que da igual que la tabla se declare más
  // abajo en este archivo: mismo caso que `siigoFacturaId`.
  conciliacionBoletaId: uuid('conciliacion_boleta_id')
    .references(() => flitoConciliacionBoletas.id, { onDelete: 'cascade' }),
  subidoPorId: integer('subido_por_id').references(() => users.id),
  subidoPorNombre: varchar('subido_por_nombre', { length: 150 }).notNull(),
  subidoEn: timestamp('subido_en', { withTimezone: true }).notNull().defaultNow(),
  // Descartado en la cola de revisión OCR: libera su hash para permitir recargar el mismo archivo
  // (un documento rechazado no debe contar como duplicado). Se excluye del dedup y de los listados.
  descartado: boolean('descartado').notNull().default(false),
  // HU #13362 (0222): documento adicional del alta de SOAT — etiqueta, y la por validar de la que cuelga (sin CASCADE).
  etiqueta: varchar('etiqueta', { length: 150 }),
  soatIncompletaId: uuid('soat_incompleta_id').references(() => flitoSoatIncompletas.id),
}, (t) => ({
  hashIdx: index('idx_flito_soportes_hash').on(t.hash),
  soatIncompletaIdx: index('idx_flito_soportes_soat_incompleta').on(t.soatIncompletaId).where(sql`${t.soatIncompletaId} IS NOT NULL`),
  documentoAdicionalChk: check('flito_soportes_documento_adicional_chk', sql`${t.tipo} <> 'documento_adicional_soat' OR (${t.etiqueta} IS NOT NULL AND (${t.soatId} IS NOT NULL OR ${t.soatIncompletaId} IS NOT NULL))`),
  // AC3 — un solo documento de cada tipo por factura. La garantía es de la base y no del servicio:
  // entre el «¿ya está?» y el INSERT de un barrido periódico cabe otro ciclo.
  facturaTipoUq: uniqueIndex('idx_flito_soportes_factura_tipo').on(t.siigoFacturaId, t.tipo)
    .where(sql`${t.siigoFacturaId} IS NOT NULL AND ${t.descartado} = false`),
  // Calcado del anterior, por el mismo motivo: un solo comprobante VIVO de cada tipo por boleta.
  boletaTipoUq: uniqueIndex('idx_flito_soportes_boleta_tipo').on(t.conciliacionBoletaId, t.tipo)
    .where(sql`${t.conciliacionBoletaId} IS NOT NULL AND ${t.descartado} = false`),
  // Y el tercero de la familia (Feature #11912): UNA sola factura de venta viva por SOAT. La
  // subsanación del canal Cliente vuelve a subir el archivo, y sin este índice se acumularían dos
  // facturas vivas y la pantalla mostraría la que ordenara primero. `descartado = false` es lo que
  // permite que la nueva entre: sin esa condición, la factura descartada bloquearía la subsanación.
  // Acotado a `factura_venta`: los demás tipos de soporte de un SOAT sí pueden repetirse.
  soatFacturaVentaUq: uniqueIndex('idx_flito_soportes_soat_factura_venta').on(t.soatId)
    .where(sql`${t.soatId} IS NOT NULL AND ${t.tipo} = 'factura_venta' AND ${t.descartado} = false`),
  // Feature #12075 (migración 0177): el índice que el CENSO de la verificación diaria necesita, y
  // NO único — `factura_soat` puede repetirse por SOAT (el único parcial único de esta tabla es el
  // de `factura_venta`, justo encima). Hasta aquí esta tabla no tenía NINGÚN índice por `soat_id`
  // solo: los tres de arriba son parciales sobre otras FK o sobre otro tipo, así que el `EXISTS`
  // del censo recorría `flito_soportes` entera una vez por SOAT candidato.
  soatTipoIdx: index('idx_flito_soportes_soat_tipo').on(t.soatId, t.tipo).where(sql`${t.soatId} IS NOT NULL AND ${t.descartado} = false`),
  // HU #13364 (migración 0223): un adicional vivo por contenido y solicitud; cierra la carrera de dos cargas simultáneas.
  adicionalSoatHashUq: uniqueIndex('uq_flito_soportes_adicional_soat_hash').on(t.soatId, t.hash).where(sql`${t.tipo} = 'documento_adicional_soat' AND ${t.descartado} = false AND ${t.soatId} IS NOT NULL`),
  // HU #12590 (migración 0196): calcado del anterior para `impuesto_id` — la cola de impuestos lee los documentos de cada página con `impuesto_id IN (...) AND tipo IN (...)`.
  impuestoTipoIdx: index('idx_flito_soportes_impuesto_tipo').on(t.impuestoId, t.tipo)
    .where(sql`${t.impuestoId} IS NOT NULL AND ${t.descartado} = false`),
  // «Uno y solo uno» para las DOS FK nuevas del patrón. Lo escribió la 0139 para `siigo_factura_id`
  // y lo ensancha la 0157 con `conciliacion_boleta_id`: sin ensancharlo, un soporte podía colgar de
  // una factura Y de una boleta a la vez, contar como comprobante vivo en los dos índices parciales
  // de arriba y —las dos FK son CASCADE— desaparecer con la factura llevándose el comprobante PSE
  // de una boleta ya conciliada.
  //
  // Las tres FK viejas (soat/impuesto/derecho) siguen SIN excluirse entre sí, igual que las dejó la
  // 0139: es una regla vigente desde mucho antes y cambiarla no es alcance de este Feature.
  excluyenteChk: check('flito_soportes_factura_excluyente_chk',
    sql`(${t.siigoFacturaId} IS NULL
          OR (${t.soatId} IS NULL AND ${t.impuestoId} IS NULL AND ${t.derechoId} IS NULL
              AND ${t.conciliacionBoletaId} IS NULL))
     AND (${t.conciliacionBoletaId} IS NULL
          OR (${t.soatId} IS NULL AND ${t.impuestoId} IS NULL AND ${t.derechoId} IS NULL))`),
}));

// Regla de enrutamiento a proveedor SOAT por ámbito (compañía 10 / organismo 20 / global 30).
export const flitoReglasProveedorSoat = pgTable('flito_reglas_proveedor_soat', {
  id: uuid('id').primaryKey().defaultRandom(),
  ambito: varchar('ambito', { length: 20 }).notNull(),
  companiaId: integer('compania_id').references(() => clients.id, { onDelete: 'cascade' }),
  organismoCodigo: varchar('organismo_codigo', { length: 5 }).references(() => organismosTransitoConfig.codigo, { onDelete: 'cascade' }),
  proveedorSoatId: uuid('proveedor_soat_id').notNull().references(() => flitoProveedoresSoat.id, { onDelete: 'cascade' }),
  prioridad: integer('prioridad').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
