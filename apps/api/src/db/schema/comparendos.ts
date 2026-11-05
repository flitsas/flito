// FLITO Comparendos: monitoreo por NIT y sincronización SIMIT/municipal. Se re-exporta desde `../schema.ts` (HU #13983).
import {
  pgTable, varchar, text, boolean, timestamp, integer, date, pgEnum, index, uniqueIndex, jsonb, numeric,
  smallserial, uuid, smallint, check,
} from 'drizzle-orm/pg-core';
import { sql, desc } from 'drizzle-orm';
import { users } from '../schema.js';
import { bytea } from './_comunes.js';

// ═══════════════════════════════════════════════════════════════════════════
// FLITO — Monitoreo de comparendos (Feature #11492, 17a). Migración 0150.
//
// Módulo `flito-comparendos`: inventario multi-NIT de comparendos traídos de SIMIT (Verifik) y de
// los municipales (UTS), que se compara entre corridas de sync para detectar altas y bajas.
//
// NO es el gate SIMIT del traspaso, ni el pre-vuelo, ni el incidente PESV `comparendo`: aquellos
// responden «¿este vehículo puede traspasarse hoy?» con una consulta que caduca; este lleva un
// histórico. Ver docs/dominio.md y ADR-0001..0003.
// ═══════════════════════════════════════════════════════════════════════════

export const flitoComparendosEstadoEnum = pgEnum('flito_comparendos_estado', ['activo', 'inactivo']);
export const flitoComparendosSyncEstadoEnum = pgEnum('flito_comparendos_sync_estado', [
  'running', 'completed', 'partial', 'failed',
]);
// El cuarto valor, `gestion`, lo añade la migración 0154 (HU #11556) y va AL FINAL: el orden de
// `pg_enum` es el orden de comparación del tipo, y un `ADD VALUE ... BEFORE/AFTER` reordenaría algo
// que nadie pidió reordenar. Los tres primeros los escribe el sync; `gestion` lo escribe una
// persona desde el endpoint de gestión (HU #11557), y es el único que no viene de una corrida.
export const flitoComparendosEventoTipoEnum = pgEnum('flito_comparendos_evento_tipo', [
  'primera_llegada', 'inactivacion', 'reaparicion', 'gestion',
]);
export const flitoComparendosOrigenMergeEnum = pgEnum('flito_comparendos_origen_merge', [
  'simit', 'municipal', 'ambos',
]);
// Comparendo o multa (HU #11712, migración 0160). Los dos endpoints devuelven las dos cosas en la
// misma lista y lo que las distingue es la resolución: sin resolución sigue siendo comparendo, con
// resolución ya es multa. Es un enum y no un booleano porque un booleano no sabe decir «no se
// sabe», que es exactamente lo que hay que decir del histórico anterior a la 0160 —y no es un
// `varchar` con CHECK porque cuesta lo mismo y pierde la unión tipada en TypeScript.
export const flitoComparendosTipoRegistroEnum = pgEnum('flito_comparendos_tipo_registro', [
  'comparendo', 'multa',
]);

/**
 * NITs a monitorear (CF-01). Catálogo propio y no una vista de `clients`: se monitorean empresas
 * que pueden no ser clientes nuestros, y un cliente puede no monitorearse.
 */
export const flitoComparendosNits = pgTable('flito_comparendos_nits', {
  id: uuid('id').primaryKey().defaultRandom(),
  nit: varchar('nit', { length: 20 }).notNull(),
  alias: varchar('alias', { length: 120 }),
  activo: boolean('activo').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer('created_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: integer('updated_by').references(() => users.id),
}, (t) => ({
  nitUq: uniqueIndex('uq_flito_comparendos_nits_nit').on(t.nit),
}));

/**
 * Municipios fuente (CF-02). `codigoFuente` es el valor literal que viaja en `?fuente=` a UTS;
 * `nombre` es para la pantalla de 17b. Separados porque el proveedor espera 'ITAGUI' y a un humano
 * se le muestra 'Itagüí': con una sola columna, corregir la ortografía rompería la integración.
 */
export const flitoComparendosMunicipios = pgTable('flito_comparendos_municipios', {
  id: uuid('id').primaryKey().defaultRandom(),
  codigoFuente: varchar('codigo_fuente', { length: 40 }).notNull(),
  nombre: varchar('nombre', { length: 80 }).notNull(),
  activo: boolean('activo').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  fuenteUq: uniqueIndex('uq_flito_comparendos_municipios_fuente').on(t.codigoFuente),
}));

/** Causales de gestión (CF-04). Catálogo de 17a; quien las asigna a un comparendo es 17b. */
export const flitoComparendosCausales = pgTable('flito_comparendos_causales', {
  id: uuid('id').primaryKey().defaultRandom(),
  nombre: varchar('nombre', { length: 120 }).notNull(),
  activo: boolean('activo').notNull().default(true),
  orden: smallint('orden').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  nombreUq: uniqueIndex('uq_flito_comparendos_causales_nombre').on(t.nombre),
}));

/**
 * Token Verifik SIMIT cifrado en reposo (CF-03, ADR-0002). Mismo esquema que `siigoCredenciales`.
 *
 * Singleton lógico: una sola fila activa, garantizada por índice único PARCIAL y no por convención
 * —con dos activas, el token usado dependería del orden de las filas—. Las inactivas son el
 * historial de rotación, de donde sale el «quién/cuándo» que pide el CF-03.
 */
export const flitoComparendosTokenSimit = pgTable('flito_comparendos_token_simit', {
  id: smallserial('id').primaryKey(),
  tokenCipher: bytea('token_cipher').notNull(),
  tokenIv: bytea('token_iv').notNull(),
  tokenAuthTag: bytea('token_auth_tag').notNull(),
  aadNonce: uuid('aad_nonce').notNull(),
  keyVersion: smallint('key_version').notNull().default(1),
  activo: boolean('activo').notNull().default(true),
  // Rastro durable del descifrado fallido (patrón de `siigoCredenciales`): un log se rota y se
  // pierde; estas columnas sobreviven y explican por qué el token dejó de servir.
  descifradoFallidoEn: timestamp('descifrado_fallido_en', { withTimezone: true }),
  descifradoFallidoMotivo: varchar('descifrado_fallido_motivo', { length: 200 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer('created_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: integer('updated_by').references(() => users.id),
}, (t) => ({
  unActivo: uniqueIndex('uq_flito_comparendos_token_activo').on(t.activo).where(sql`${t.activo}`),
}));

/**
 * Mapa versionable fuente → canónico (ADR-0003). Es tabla y no if/else en el servicio para que
 * renombrar un campo del proveedor sea una fila con su fecha y su nota, no un despliegue.
 *
 * El merge lee la versión MÁXIMA. La v1 que siembra la 0150 nace `provisional=true` porque se
 * dedujo sin payloads reales; la HU #11501 la verifica y siembra la v2.
 *
 * `prioridad` (menor gana) ordena los candidatos de un mismo `targetField` dentro de un origen: el
 * diseño los lista en orden de preferencia y sin esta columna ese orden se perdía al insertar.
 */
export const flitoComparendosFieldMap = pgTable('flito_comparendos_field_map', {
  id: uuid('id').primaryKey().defaultRandom(),
  version: integer('version').notNull(),
  origen: varchar('origen', { length: 20 }).notNull(), // 'simit' | 'municipal'
  sourcePath: varchar('source_path', { length: 120 }).notNull(),
  targetField: varchar('target_field', { length: 60 }).notNull(),
  prioridad: smallint('prioridad').notNull().default(0),
  provisional: boolean('provisional').notNull().default(true),
  notas: text('notas'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  verOrigPath: uniqueIndex('uq_flito_comparendos_field_map').on(t.version, t.origen, t.sourcePath),
}));

/**
 * Registro consolidado: canónico tipado (lo que 17b filtra y exporta) + payload crudo de cada
 * fuente (la red para re-mergear si la homologación v1 resultó equivocada, sin volver a llamar al
 * proveedor).
 *
 * Unicidad por `numeroComparendo` y no por (nit, numero): el número lo asigna el Estado y es único
 * en el país (CF-07). La placa no es llave — un vehículo acumula comparendos.
 */
export const flitoComparendosRegistros = pgTable('flito_comparendos_registros', {
  id: uuid('id').primaryKey().defaultRandom(),
  numeroComparendo: varchar('numero_comparendo', { length: 60 }).notNull(),
  nitMonitoreado: varchar('nit_monitoreado', { length: 20 }).notNull(),
  // Campos de FUENTE: los escribe el sync y nadie más. No hay endpoint que los edite (CF-09).
  placa: varchar('placa', { length: 10 }),
  codigoInfraccion: varchar('codigo_infraccion', { length: 20 }),
  descripcionInfraccion: text('descripcion_infraccion'),
  fechaComparendo: date('fecha_comparendo'),
  // Cuándo se NOTIFICÓ el comparendo (HU #11794, migración 0164). Columna propia y no un dato
  // derivable: las dos fuentes la publican —en tres grafías distintas— y de ella cuelga el conteo de
  // términos del proceso. Un dato que no es columna no se puede filtrar ni ordenar, y el payload
  // crudo viene podado a la lista blanca del `field_map` (RN-25).
  //
  // `null` significa «no notificado o no se sabe», y las dos cosas caben en el mismo nulo a
  // propósito: ninguna de las dos fuentes distingue «todavía no se notificó» de «no publico la
  // fecha». Lo que NO cabe es `1900-01-01`: ese valor es el CENTINELA con el que el proveedor dice
  // «no notificado» (premisa documentada en la 0158), y persistirlo guardaría una fecha del siglo
  // XIX como si fuera un hecho. Lo descarta `fechaCanonica`, para esta columna Y para
  // `fecha_comparendo` — el mismo centinela con el mismo criterio.
  //
  // Dato de FUENTE (CF-09): lo escribe el sync y ningún endpoint de gestión lo edita.
  fechaNotificacion: date('fecha_notificacion'),
  organismo: varchar('organismo', { length: 120 }),
  // A qué municipio se le PREGUNTÓ. No cambia de significado con la HU #11878: sigue siendo la
  // trazabilidad de la corrida —qué fuente devolvió esta fila— y es `null` en todo comparendo que
  // solo vio el SIMIT, porque a nadie se le preguntó por él.
  municipioFuente: varchar('municipio_fuente', { length: 40 }),
  // De qué municipio ES el comparendo (HU #11878, migración 0165). Es OTRA pregunta que la de
  // arriba, y confundirlas es el defecto que esta columna cierra: filtrar por Medellín contra
  // `municipio_fuente` escondía los comparendos de Medellín que solo había reportado el SIMIT, cuyo
  // `organismo` («STRIA DE TTOyTTE MEDELLIN») sí decía de dónde eran.
  //
  // Lo DERIVA `municipioDelComparendo` (`flito-comparendos-merge.ts`) en dos escalones: el municipio
  // consultado si lo hay, y si no el `codigo_fuente` del catálogo que aparezca —con límite de
  // palabra y siendo el ÚNICO que aparece— dentro del organismo ya resuelto. `null` significa «no se
  // sabe de dónde es», nunca cadena vacía, y ahí caen tanto lo irreconocible como lo AMBIGUO: dos
  // municipios dentro del mismo texto no se desempatan, se declaran desconocidos.
  //
  // SIN FK contra `flito_comparendos_municipios`, igual que `municipio_fuente` y por el mismo
  // motivo: renombrar un `codigo_fuente` en la parametrización se convertiría en un error de
  // escritura sobre el histórico. Se re-deriva entera en cada sync (como `tipo_registro`), así que
  // el catálogo que crece corrige solo lo que antes no supo reconocer.
  municipioComparendo: varchar('municipio_comparendo', { length: 40 }),
  monto: numeric('monto', { precision: 14, scale: 2 }),
  estadoFuente: varchar('estado_fuente', { length: 80 }),
  // Comparendo o multa, y la resolución que lo convirtió (HU #11712, migración 0160). Las tres son
  // nullable y SIN default, y eso es la afirmación principal de la HU: `null` significa «no se
  // sabe», que es todo lo que sabemos del histórico anterior a la 0160 —sus payloads ya fueron
  // podados y ninguna versión del mapa nombraba la resolución, así que el dato no está en ninguna
  // parte—. Un `default 'comparendo'` no sería optimismo transitorio: las filas `inactivo` ya no
  // las visita ningún sync (CF-10), así que nadie volvería a corregirlo nunca.
  //
  // `tipoRegistro` lo DERIVA `resolverCampos` de las otras dos, y NO es un campo del `field_map`:
  // si lo fuera, una fila de una tabla de texto elegiría el valor de una columna `enum` y el INSERT
  // reventaría con un `22P02` a mitad de corrida, matando el NIT entero.
  //
  // `idResolucion` es columna propia y no un candidato más de `numeroResolucion` porque es un
  // identificador de SISTEMA del proveedor (`115697134`) y no un número legible: como respaldo del
  // número acabaría pintado en la columna «N.º resolución». Se guarda porque viene nulo mientras es
  // comparendo y con valor cuando ya es multa, así que es la otra mitad de la señal del tipo. No se
  // publica en el API.
  tipoRegistro: flitoComparendosTipoRegistroEnum('tipo_registro'),
  numeroResolucion: varchar('numero_resolucion', { length: 60 }),
  idResolucion: varchar('id_resolucion', { length: 60 }),
  origenMerge: flitoComparendosOrigenMergeEnum('origen_merge').notNull(),
  vistoEnSimit: boolean('visto_en_simit').notNull().default(false),
  vistoEnMunicipal: boolean('visto_en_municipal').notNull().default(false),
  payloadSimit: jsonb('payload_simit'),
  payloadMunicipal: jsonb('payload_municipal'),
  // Estado de monitoreo: lo mantiene el sync comparando corridas.
  estado: flitoComparendosEstadoEnum('estado').notNull().default('activo'),
  primeraVistoEn: timestamp('primera_visto_en', { withTimezone: true }).notNull().defaultNow(),
  ultimoVistoEn: timestamp('ultimo_visto_en', { withTimezone: true }).notNull().defaultNow(),
  inactivadoEn: timestamp('inactivado_en', { withTimezone: true }),
  ultimoSyncRunId: uuid('ultimo_sync_run_id'),
  // Gestión operativa: columnas de 17a, escritura de 17b.
  causalId: uuid('causal_id').references(() => flitoComparendosCausales.id),
  observacion: text('observacion'),
  // Auditoría de la gestión (HU #11556, migración 0154). `updated_at` NO sirve para esto: lo
  // reescribe el sync en cada corrida, así que no distingue una fila gestionada ayer por una
  // persona de una que el sync tocó hace diez minutos. Las dos son nullable y sin default: `null`
  // significa «nadie la ha gestionado», que es lo que vale para todo el histórico anterior.
  //
  // `integer` y no `uuid` porque `users.id` es `serial`: una FK hereda el tipo de a quien apunta.
  // Y `onDelete: 'restrict'` porque esto es auditoría — un `set null` dejaría la fila diciendo que
  // se gestionó en una fecha y por nadie. Un usuario que gestionó comparendos no se borra, se
  // desactiva. La cláusula está afirmada contra la 0154 en un test de paridad, porque degradarla
  // deja un esquema válido y una auditoría falseada.
  gestionActualizadaEn: timestamp('gestion_actualizada_en', { withTimezone: true }),
  gestionActualizadaPor: integer('gestion_actualizada_por')
    .references(() => users.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  numeroUq: uniqueIndex('uq_flito_comparendos_numero').on(t.numeroComparendo),
  nitIdx: index('idx_flito_comparendos_nit').on(t.nitMonitoreado),
  placaIdx: index('idx_flito_comparendos_placa').on(t.placa),
  estadoIdx: index('idx_flito_comparendos_estado').on(t.estado),
  // Purga por retención (HU #11511, migración 0152). Ninguno de los de arriba cubre el filtro de la
  // purga —`WHERE ultimo_visto_en < corte ORDER BY ultimo_visto_en LIMIT n`, hasta 20 veces por
  // pasada, más el `count(*)` del dryRun y del freno—, que sin índice es un recorrido secuencial de
  // la tabla que más crece del módulo.
  ultimoVistoIdx: index('idx_flito_comparendos_ultimo_visto').on(t.ultimoVistoEn),
  // Filtros del listado (HU #11555, migración 0153). Los dos primeros llevan detrás las MISMAS
  // columnas del cursor y en el MISMO orden (`created_at DESC, id DESC`, RN-32): con la IGUALDAD
  // delante, el índice entrega la página ya ordenada y el plan pierde el nodo de `Sort`. Sin esa
  // cola, filtrar por municipio sería recorrer la tabla entera y ordenarla para quedarse con 50
  // filas. `origen_merge` no tiene índice a propósito: son tres valores sobre toda la tabla y el
  // planner no lo usaría.
  // Desde la HU #11878 el índice del filtro va sobre `municipio_comparendo` y SUSTITUYE al de
  // `municipio_fuente` (que la 0165 borra), no convive con él: el filtro del listado se mudó de
  // columna y la vieja ya no aparece en ningún `WHERE` guiado por igualdad —solo en
  // `condicionAusente`, donde quien guía es `ultimo_sync_run_id IS DISTINCT FROM` y el municipio
  // entra como `IS NULL OR IN (...)`—. Dos índices con la misma cola sobre la tabla que más crece
  // del módulo serían escrituras pagadas para un plan que nadie pide.
  municipioComparendoCreadoIdx: index('idx_flito_comparendos_municipio_comparendo_creado')
    .on(t.municipioComparendo, desc(t.createdAt), desc(t.id)),
  causalCreadoIdx: index('idx_flito_comparendos_causal_creado')
    .on(t.causalId, desc(t.createdAt), desc(t.id)),
  // `sinCausal=true` necesita un índice PARCIAL propio, y no es una duplicación del anterior: para
  // que un índice entregue el orden ya hecho, su primera columna tiene que estar fijada por una
  // IGUALDAD, y `causal_id IS NULL` no lo es. Medido sobre 200.000 filas (AC5 de la #11555), el
  // índice de arriba no evita el `Sort` ni forzando el plan a mano —`Index Only Scan` + `Sort`,
  // 25,7 ms—, y sin forzar nada el planner elige `Seq Scan` + `top-N heapsort`: 43 ms y 6.343
  // buffers. Con este parcial la misma consulta baja a 0,14 ms y 7 buffers.
  //
  // Sacar `causal_id` del cuerpo al `WHERE` es lo que lo hace posible: dentro del índice ya no hay
  // más que filas sin causal, así que `(created_at DESC, id DESC)` manda desde la primera columna.
  // Y sale más barato de mantener que el índice completo de la causal (6,8 MB contra 12 MB) porque
  // solo indexa la parte de la tabla que le toca.
  sinCausalCreadoIdx: index('idx_flito_comparendos_sin_causal_creado')
    .on(desc(t.createdAt), desc(t.id))
    .where(sql`${t.causalId} is null`),
  // El sello de la gestión es una sola cosa (HU #11557, migración 0156): o están la fecha y el
  // autor, o no está ninguno de los dos. Una fecha sin autor diría que la fila se gestionó y no fue
  // nadie —el mismo daño que el `ON DELETE RESTRICT` de arriba impide por el otro lado (ADR-0005)—
  // y un autor sin fecha sería la mitad de una auditoría. La escritura las pone siempre juntas,
  // también al vaciar la causal y la observación; esto es lo que lo sostiene desde la base.
  gestionAuditoriaChk: check(
    'flito_comparendos_gestion_auditoria_chk',
    sql`(${t.gestionActualizadaEn} is null) = (${t.gestionActualizadaPor} is null)`,
  ),
  // El tipo y la resolución no pueden contradecirse (HU #11712, migración 0160): o la fila no dice
  // nada de las tres (el histórico), o dice el tipo y ese tipo es `multa` exactamente cuando hay
  // alguna de las dos resoluciones. El merge lo cumple por construcción —deriva el tipo del valor
  // que acaba de resolver—, y esto es lo que lo sostiene desde la base para el día que haya un
  // segundo camino de escritura.
  //
  // Las dos piezas que parecen adorno hacen trabajos DISTINTOS, y confundirlas es fácil (verificado
  // contra PostgreSQL 16): la PRIMERA rama está para **admitir el histórico**, no para cerrar un
  // hueco —sin ella, `tipo_registro IS NOT NULL` da FALSE y el CHECK rechaza toda fila sin tipo, que
  // al aplicar la 0160 son TODAS: el `ADD CONSTRAINT` moriría al validar—. Lo que cierra el hueco de
  // la evaluación a NULL es la guarda `is not null` de la SEGUNDA rama: la comparación desnuda
  // `(NULL = 'multa') = (…)` evalúa a NULL y un CHECK que evalúa a NULL PASA, así que sin ella se
  // colaría la fila peor —sin tipo y con número de resolución—; con ella, `FALSE AND NULL` es FALSE.
  tipoResolucionChk: check(
    'flito_comparendos_tipo_resolucion_chk',
    sql`(${t.tipoRegistro} is null and ${t.numeroResolucion} is null and ${t.idResolucion} is null) or (${t.tipoRegistro} is not null and (${t.tipoRegistro} = 'multa') = (${t.numeroResolucion} is not null or ${t.idResolucion} is not null))`,
  ),
}));

/**
 * Timeline (CF-11): llegada, desaparición, reaparición. Responde «¿desde cuándo arrastramos esto?»,
 * que el estado actual no puede contar.
 *
 * El único (registro, tipo, run) es el anti-spam como candado de base: la regla «sin eventos
 * redundantes» aplicada solo en el servicio se rompe con el primer reintento de una corrida.
 */
export const flitoComparendosEventos = pgTable('flito_comparendos_eventos', {
  id: uuid('id').primaryKey().defaultRandom(),
  registroId: uuid('registro_id').notNull()
    .references(() => flitoComparendosRegistros.id, { onDelete: 'cascade' }),
  tipo: flitoComparendosEventoTipoEnum('tipo').notNull(),
  syncRunId: uuid('sync_run_id'),
  detalle: jsonb('detalle'), // sin token; NIT/placa redactados según pii-audit
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  regIdx: index('idx_flito_comparendos_eventos_reg').on(t.registroId, t.createdAt),
  regTipoRunUq: uniqueIndex('uq_flito_comparendos_evento_reg_tipo_run')
    .on(t.registroId, t.tipo, t.syncRunId),
}));

/** Una corrida por disparo de sync (CF-05). */
export const flitoComparendosSyncRuns = pgTable('flito_comparendos_sync_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  estado: flitoComparendosSyncEstadoEnum('estado').notNull().default('running'),
  scopeNits: jsonb('scope_nits').notNull().$type<string[]>(),
  resumen: jsonb('resumen'),
  iniciadoPor: integer('iniciado_por').references(() => users.id),
  iniciadoEn: timestamp('iniciado_en', { withTimezone: true }).notNull().defaultNow(),
  finalizadoEn: timestamp('finalizado_en', { withTimezone: true }),
}, (t) => ({
  // Purga por retención (HU #11511, migración 0152): candidatos por antigüedad, heartbeat de la
  // última corrida ok y listado de corridas recientes. La tabla no tenía más índice que su PK.
  iniciadoIdx: index('idx_flito_comparendos_sync_runs_iniciado').on(t.iniciadoEn),
}));

/**
 * Un paso por par (NIT, fuente). No es telemetría: es la condición del CF-10. Solo se inactiva por
 * ausencia a los NIT con SIMIT ok y TODOS sus municipios activos ok en la corrida — sin el detalle
 * por paso, un timeout se leería como «el comparendo ya no existe».
 */
export const flitoComparendosSyncSteps = pgTable('flito_comparendos_sync_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull()
    .references(() => flitoComparendosSyncRuns.id, { onDelete: 'cascade' }),
  nit: varchar('nit', { length: 20 }).notNull(),
  fuente: varchar('fuente', { length: 40 }).notNull(), // 'simit' | codigoFuente del municipio
  ok: boolean('ok').notNull(),
  httpStatus: smallint('http_status'),
  errorCode: varchar('error_code', { length: 60 }),
  mensaje: text('mensaje'), // sin PII ni token
  itemsLeidos: integer('items_leidos'),
  duracionMs: integer('duracion_ms'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  runIdx: index('idx_flito_comparendos_sync_steps_run').on(t.runId),
}));
