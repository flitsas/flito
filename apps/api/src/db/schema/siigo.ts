// Siigo API: facturación electrónica de trámites. Se re-exporta desde `../schema.ts` (HU #13983).
import {
  pgTable, varchar, text, boolean, timestamp, integer, date, index, uniqueIndex, jsonb, numeric, bigserial,
  smallserial, uuid, smallint,
} from 'drizzle-orm/pg-core';
import { sql, desc } from 'drizzle-orm';
// Entrega de la factura por correo (HU #11334): destinatarios con su procedencia, en columna jsonb.
import type { SiigoDestinatario } from '@operaciones/shared-types';
import { users, clients } from '../schema.js';
import { bytea } from './_comunes.js';
import { flitoLiquidaciones } from './finanzas.js';
import { flitoTramites } from './tramites.js';

// ============================================================================
// Siigo API — facturación electrónica de trámites (Feature #11239)
// ============================================================================

/**
 * Credenciales de Siigo API cifradas con AES-256-GCM (HU #11247).
 *
 * Mismo esquema probado en `rndcCredenciales`: el cipher viaja con su IV, su authTag y un
 * `aadNonce` propio que entra en los datos asociados. Eso ata el ciphertext a ESTA fila: copiar
 * el cipher a otra fila, o alterar el nonce, hace fallar la verificación de integridad en vez de
 * devolver un texto plano equivocado.
 *
 * El `username` va en claro a propósito: no es el secreto y hace falta para poder listar y
 * distinguir credenciales sin descifrar nada. El secreto es `access_key`.
 *
 * Solo puede haber UNA credencial activa por ambiente. Se garantiza con un índice único parcial
 * —no solo por convención de código— porque dos activas harían que la credencial usada dependiera
 * del orden de las filas.
 */
export const siigoCredenciales = pgTable('siigo_credenciales', {
  id: smallserial('id').primaryKey(),
  ambiente: varchar('ambiente', { length: 12 }).notNull(),
  username: varchar('username', { length: 150 }).notNull(),
  accessKeyCipher: bytea('access_key_cipher').notNull(),
  accessKeyIv: bytea('access_key_iv').notNull(),
  accessKeyAuthTag: bytea('access_key_auth_tag').notNull(),
  aadNonce: uuid('aad_nonce').notNull(),
  keyVersion: smallint('key_version').notNull().default(1),
  activo: boolean('activo').notNull().default(true),
  notas: text('notas'),
  // Rastro durable del descifrado fallido. Un log se rota y se pierde; esta columna sobrevive y
  // explica en la propia pantalla por qué la credencial dejó de estar activa.
  descifradoFallidoEn: timestamp('descifrado_fallido_en', { withTimezone: true }),
  descifradoFallidoMotivo: varchar('descifrado_fallido_motivo', { length: 200 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer('created_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: integer('updated_by').references(() => users.id),
}, (t) => ({
  // Una sola credencial activa por ambiente. Parcial: las desactivadas son historial y pueden
  // repetirse cuantas veces se reconfigure.
  ambienteActivoIdx: uniqueIndex('idx_siigo_credenciales_ambiente_activo')
    .on(t.ambiente)
    .where(sql`${t.activo}`),
}));

/**
 * Bitácora WORM de las llamadas a Siigo API (HU #11251).
 *
 * Append-only de verdad: disparadores en la base prohíben UPDATE y DELETE, y el rol de la
 * aplicación solo tiene SELECT e INSERT. Una factura electrónica respalda una venta ante la DIAN;
 * si el registro de lo que se envió se pudiera editar, no probaría nada.
 *
 * `operacion` es texto y no un enum porque el catálogo crecerá con las Features 11 a 15, y un enum
 * obligaría a una migración por cada operación nueva.
 */
export const siigoOperaciones = pgTable('siigo_operaciones', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  operacion: varchar('operacion', { length: 40 }).notNull(),
  metodo: varchar('metodo', { length: 10 }),
  ruta: varchar('ruta', { length: 300 }),
  entidadTipo: varchar('entidad_tipo', { length: 20 }),
  entidadId: varchar('entidad_id', { length: 60 }),
  intento: smallint('intento').notNull().default(1),
  ambiente: varchar('ambiente', { length: 12 }).notNull(),
  /** 'real' o 'mock': distingue una prueba de una operación productiva. */
  modo: varchar('modo', { length: 10 }).notNull().default('real'),
  /** Ya saneado: nunca contiene el access_key ni la cabecera de autorización. */
  requestBody: jsonb('request_body'),
  responseBody: jsonb('response_body'),
  statusHttp: smallint('status_http'),
  resultado: varchar('resultado', { length: 20 }).notNull(),
  codigo: varchar('codigo', { length: 60 }),
  mensaje: text('mensaje'),
  duracionMs: integer('duracion_ms'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer('created_by').references(() => users.id),
}, (t) => ({
  entidadIdx: index('idx_siigo_op_entidad').on(t.entidadTipo, t.entidadId, t.createdAt),
  createdAtIdx: index('idx_siigo_op_created_at').on(t.createdAt),
  resultadoIdx: index('idx_siigo_op_resultado').on(t.resultado, t.createdAt),
}));

/**
 * Mapeo de cada concepto facturable al producto que lo representa en Siigo (HU #11282).
 *
 * Es la tabla que hace que el AC3 sea cierto: el armado de la factura lee de aquí la clasificación
 * tributaria, los impuestos y la unidad de medida, así que cambiarlos es editar configuración y no
 * desplegar. En el servicio de armado no puede aparecer ninguna condición sobre un concepto
 * concreto — si la ves, es un bug de diseño, no un atajo.
 *
 * `ambiente` forma parte de la identidad de la fila. El `codigoProducto` y los ids de `impuestos`
 * pertenecen a UNA empresa de Siigo, y pruebas y producción son empresas distintas con ids
 * distintos (docs/integraciones/siigo-api.md §Notas, punto 6). Sin ambiente en la llave, configurar
 * contra pruebas dejaría escrito un código que en producción es otro producto — y eso ya es una
 * factura mal emitida ante la DIAN. Además la HU #11285 exige que al cambiar de ambiente NO se
 * hereden confirmaciones del otro, cosa imposible con una sola fila por concepto.
 *
 * `tipoTramite` NULL = configuración genérica; con tipo de trámite, precedencia sobre la genérica.
 * Misma convención que usaba `flito_tarifas_compania` (0110) y que hereda `flitoTarifasVigencias`.
 *
 * NO modela retenciones (AC7): no está confirmado si ReteICA, ReteIVA o autorretención aplican a
 * las facturas de FLIT. Incorporarlas sería añadir columnas aquí, no rehacer el modelo.
 */
export const siigoMapeoConceptos = pgTable('siigo_mapeo_conceptos', {
  id: uuid('id').primaryKey().defaultRandom(),
  ambiente: varchar('ambiente', { length: 12 }).notNull(),
  concepto: varchar('concepto', { length: 30 }).notNull(),
  /** NULL = configuración genérica del concepto. Normalizado en mayúsculas. */
  tipoTramite: varchar('tipo_tramite', { length: 60 }),
  /** `code` de POST /v1/products: alfanumérico, sin espacios, ≤30. NULL = sin mapear todavía. */
  codigoProducto: varchar('codigo_producto', { length: 30 }),
  nombreProducto: varchar('nombre_producto', { length: 200 }),
  /** gravado | exento | excluido. NULL = SIN DECLARAR, que no es lo mismo que excluido. */
  clasificacionTributaria: varchar('clasificacion_tributaria', { length: 12 }),
  /** `[{ id, nombre?, porcentaje? }]` con ids de GET /v1/taxes de ESTA empresa de Siigo. */
  impuestos: jsonb('impuestos').notNull().default(sql`'[]'::jsonb`),
  unidadMedida: varchar('unidad_medida', { length: 20 }),
  /** Dinero que FLIT recauda y traslada (SOAT, impuesto, derecho), no ingreso propio. */
  ingresoParaTerceros: boolean('ingreso_para_terceros').notNull().default(false),
  /**
   * AC6 — GMF. `false` con `lineaPropiaPendiente = true` significa «sin decidir», NO «se absorbe».
   * Quien arme la factura debe mirar el pendiente antes de actuar.
   */
  facturaLineaPropia: boolean('factura_linea_propia').notNull().default(false),
  lineaPropiaPendiente: boolean('linea_propia_pendiente').notNull().default(false),
  confirmadoContabilidad: boolean('confirmado_contabilidad').notNull().default(false),
  /** Quién y cuándo confirmó. NO se limpian al revertir: el AC4 pide que el rastro sobreviva. */
  confirmadoPorId: integer('confirmado_por_id').references(() => users.id),
  confirmadoEn: timestamp('confirmado_en', { withTimezone: true }),
  confirmacionRevertidaEn: timestamp('confirmacion_revertida_en', { withTimezone: true }),
  /** Nombres de los campos que tumbaron la confirmación. Nunca valores. */
  confirmacionRevertidaPor: varchar('confirmacion_revertida_por', { length: 300 }),
  activo: boolean('activo').notNull().default(true),
  notas: text('notas'),
  /**
   * Última comprobación del código de producto contra Siigo (HU #11283).
   *
   * Es un dato CON FECHA, no una propiedad permanente: alguien puede inactivar el producto en Siigo
   * Nube sin tocar FLITO, y entonces una fila «válida» deja de serlo sin que nadie se entere hasta
   * la primera factura rechazada. `no_verificable` NO es lo mismo que `no_existe`: significa que
   * Siigo no respondió y el dato puede estar perfecto.
   *
   * Deliberadamente separado de `confirmadoContabilidad`: son dos afirmaciones de dos responsables
   * distintos. Contabilidad firma el tratamiento tributario; la validación comprueba que el
   * producto existe. Colapsarlas haría que revalidar tumbara firmas contables.
   */
  validacionEstado: varchar('validacion_estado', { length: 20 }).notNull().default('sin_validar'),
  /** Texto accionable. Nunca el mensaje crudo de Siigo, ni SQL, ni la clave del cortacircuitos. */
  validacionMensaje: varchar('validacion_mensaje', { length: 300 }),
  /** Fecha del último INTENTO. Con `no_verificable` hubo intento y no hubo respuesta. */
  validadoEn: timestamp('validado_en', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer('created_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: integer('updated_by').references(() => users.id),
}, (t) => ({
  // Una sola fila viva por ambiente + concepto + tipo. El COALESCE evita varias genéricas del mismo
  // concepto (NULL no colisiona con NULL). Parcial: las desactivadas son historial.
  unicoActivoIdx: uniqueIndex('idx_siigo_mapeo_unico_activo')
    .on(t.ambiente, t.concepto, sql`COALESCE(${t.tipoTramite}, '')`)
    .where(sql`${t.activo}`),
  ambienteConceptoIdx: index('idx_siigo_mapeo_ambiente_concepto').on(t.ambiente, t.concepto),
  // Lo que busca la pantalla tras una revalidación son las EXCEPCIONES, no el total.
  validacionNovedadIdx: index('idx_siigo_mapeo_validacion_novedad')
    .on(t.ambiente, t.validacionEstado)
    .where(sql`${t.validacionEstado} IN ('no_existe', 'inactivo', 'no_verificable')`),
}));

/**
 * Copia local de los catálogos de Siigo (HU #11281).
 *
 * Siigo permite 100 peticiones por minuto por empresa. Resolver el nombre de un vendedor o de una
 * forma de pago cada vez que se pinta una pantalla de parametrización agotaría esa cuota con
 * consultas que devuelven siempre lo mismo. Por eso se cachean aquí y se leen de local.
 *
 * Única por (`ambiente`, `tipo`, `codigo`). Dos razones distintas: el identificador de Siigo solo es
 * único DENTRO de su catálogo —el id 1253 puede ser un grupo de inventario y también una forma de
 * pago— y `pruebas` y `produccion` son EMPRESAS DISTINTAS en Siigo, cada una con sus propios
 * identificadores. Sin `ambiente` en la llave, sincronizar producción pisaría los códigos que
 * coincidieran con los de pruebas e inactivaría el resto del catálogo del otro ambiente por no
 * haber venido en la respuesta.
 *
 * NO hay borrado. Un elemento que deja de venir de Siigo se marca `activo = false` y conserva su
 * fila: una factura emitida el año pasado referencia un centro de costo que quizá ya no existe, y
 * sin la fila no habría forma de explicar esa parametrización.
 *
 * Datos personales: del catálogo de vendedores (`/v1/users`) se guarda SOLO el nombre. Siigo
 * devuelve además `identification` y `email`, que son datos personales bajo la Ley 1581 y no hacen
 * falta para elegir un vendedor, así que no se persisten (ver `siigo.catalogos.service.ts`).
 */
export const siigoCatalogos = pgTable('siigo_catalogos', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  /** 'pruebas' | 'produccion'. Empresas distintas en Siigo: sus catálogos no se mezclan. */
  ambiente: varchar('ambiente', { length: 12 }).notNull(),
  /** 'document_type' | 'user' | 'payment_type' | 'tax' | 'account_group' | 'cost_center'. */
  tipo: varchar('tipo', { length: 30 }).notNull(),
  /** Identificador de Siigo como texto: hay catálogos con código alfanumérico. */
  codigo: varchar('codigo', { length: 60 }).notNull(),
  nombre: varchar('nombre', { length: 200 }).notNull(),
  descripcion: varchar('descripcion', { length: 300 }),
  activo: boolean('activo').notNull().default(true),
  /** Atributos propios del catálogo (porcentaje del impuesto, si maneja vencimiento…). Sin PII. */
  atributos: jsonb('atributos'),
  sincronizadoEn: timestamp('sincronizado_en', { withTimezone: true }).notNull().defaultNow(),
  /** Momento en que dejó de venir de Siigo. Null mientras siga activo. */
  inactivadoEn: timestamp('inactivado_en', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // Es también el índice contra el que resuelve el ON CONFLICT del upsert: si estas columnas y el
  // `target` del upsert dejan de coincidir, la sincronización falla entera en Postgres.
  ambienteTipoCodigoUq: uniqueIndex('idx_siigo_catalogos_ambiente_tipo_codigo')
    .on(t.ambiente, t.tipo, t.codigo),
  // La lectura real de la parametrización: «los elementos activos de este catálogo en este
  // ambiente, por nombre».
  ambienteTipoActivoIdx: index('idx_siigo_catalogos_ambiente_tipo_activo')
    .on(t.ambiente, t.tipo, t.activo, t.nombre),
}));

/**
 * Catálogo oficial de países, departamentos y ciudades de Siigo (HU #11293).
 *
 * Vive aparte de `siigoCatalogos` por una diferencia de fondo: los seis catálogos de aquella tabla
 * se sincronizan llamando a la API, y este **no existe como servicio** — Siigo lo publica como un
 * .xlsx. Meterlo allí obligaría a decir «sincronizado» cuando nadie llamó a Siigo, y a compartir
 * columnas que aquí no significan nada: el listado no depende de la cuenta, así que no tiene
 * ambiente. Se carga desde `src/db/data/siigo-ciudades.json`.
 */
export const siigoCiudades = pgTable('siigo_ciudades', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  /** Ojo: el listado oficial trae `Co`, no `CO`. Se guarda tal cual lo publica Siigo. */
  countryCode: varchar('country_code', { length: 2 }).notNull(),
  countryName: varchar('country_name', { length: 80 }).notNull(),
  stateCode: varchar('state_code', { length: 5 }).notNull(),
  stateName: varchar('state_name', { length: 80 }).notNull(),
  cityCode: varchar('city_code', { length: 10 }).notNull(),
  cityName: varchar('city_name', { length: 80 }).notNull(),
  /** `cityName` sin tildes y en minúsculas: un LIKE sobre una función no usa índice. */
  cityBusqueda: varchar('city_busqueda', { length: 80 }).notNull(),
  /** false = dejó de venir en el listado. No se borra: un cliente antiguo puede referenciarla. */
  activo: boolean('activo').notNull().default(true),
  version: varchar('version', { length: 20 }),
  cargadoEn: timestamp('cargado_en', { withTimezone: true }).notNull().defaultNow(),
  actualizadoEn: timestamp('actualizado_en', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // La clave es la TERNA, no el código de ciudad: el listado trae `05001` dos veces —Medellín en
  // Colombia y Chachapollas en Perú—. Un único sobre `cityCode` habría perdido una de las dos.
  // Es también el target del ON CONFLICT del upsert: si dejan de coincidir, la carga falla entera.
  ternaUq: uniqueIndex('idx_siigo_ciudades_terna').on(t.countryCode, t.stateCode, t.cityCode),
  cascadaIdx: index('idx_siigo_ciudades_cascada').on(t.countryCode, t.stateCode),
  busquedaIdx: index('idx_siigo_ciudades_busqueda').on(t.cityBusqueda),
}));

/**
 * Parámetros operativos del ambiente (migración 0148; antes «configuración global de emisión»).
 *
 * **Ya no dice con qué nacen las facturas.** Hasta el 2026-08-13 guardaba el tipo de comprobante, el
 * vendedor, la forma de pago y el centro de costo con los que se emitía TODO un ambiente. Se retiró:
 * los cuatro se eligen en cada envío, por empresa, y quedan como snapshot inmutable en
 * `siigoLotesFacturacion`. Una configuración global significaba que cambiar el vendedor de una
 * empresa lo cambiaba para todas.
 *
 * Con ella se fueron las cuatro columnas que sostenían preguntas de negocio abiertas —retenciones,
 * moneda, numeración y plazo de vencimiento—, porque esas preguntas se respondieron y una respuesta
 * no necesita una palanca. Están en la 0148 con su respuesta.
 *
 * Quedan dos valores, y siguen en tabla y no en una variable `SIIGO_*` a propósito: son por
 * ambiente, quedan historiados y admiten `CHECK`. No hay pantalla ni endpoint que los escriba —se
 * cambian con una migración—, así que el historial se conserva pero ya nadie inserta filas nuevas.
 */
export const siigoConfigEmision = pgTable('siigo_config_emision', {
  id: uuid('id').primaryKey().defaultRandom(),
  ambiente: varchar('ambiente', { length: 12 }).notNull(),
  /** Desde cuándo se factura. No hay histórico: lo anterior no se emite (pregunta 13, respondida). */
  historicoDesde: date('historico_desde').notNull().defaultNow(),
  /** Minutos tras los cuales una factura `en_proceso` se considera huérfana y se reconcilia. */
  arrendamientoEnProcesoMin: integer('arrendamiento_en_proceso_min').notNull().default(15),
  /** false = fila histórica. */
  vigente: boolean('vigente').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer('created_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: integer('updated_by').references(() => users.id),
}, (t) => ({
  // AC1 — una sola vigente por ambiente. Parcial: las apagadas son historial y se repiten.
  vigenteUq: uniqueIndex('idx_siigo_config_emision_vigente')
    .on(t.ambiente)
    .where(sql`${t.vigente}`),
  // DESC igual que en la migración 0130: la consulta real es «lo más reciente primero», y una
  // deriva de dirección entre `schema.ts` y la base es de las que no se notan hasta que alguien
  // regenera algo a partir del esquema.
  historialIdx: index('idx_siigo_config_emision_historial').on(t.ambiente, desc(t.createdAt)),
}));

/**
 * Lote de facturación: el conjunto de trámites que se factura junto (HU #11323, Feature #11242).
 *
 * **Su identidad es determinista y sale de lo que contiene.** Con un id aleatorio, dos encolados
 * del mismo trámite producirían dos lotes, dos claves de idempotencia distintas y **dos facturas
 * DIAN reales** — la misma carrera que el `UNIQUE` sobre `idempotencyKey` evita un nivel más abajo,
 * pero fuera de su alcance. Reencolar el mismo conjunto devuelve el lote que ya existía.
 */
export const siigoLotesFacturacion = pgTable('siigo_lotes_facturacion', {
  id: uuid('id').primaryKey().defaultRandom(),
  ambiente: varchar('ambiente', { length: 12 }).notNull(),
  /** Solo 'por_tramite' (D-1 diferida). Consolidar exige migración, es decir, una decisión. */
  estrategia: varchar('estrategia', { length: 30 }).notNull().default('por_tramite'),
  /**
   * sha256 hex de los ids de trámite Y los conceptos, ambos ORDENADOS: ni el orden de selección en
   * la pantalla ni el de los conceptos cambian la identidad del lote (A1, migración 0146).
   */
  huella: varchar('huella', { length: 64 }).notNull(),
  /** Conceptos elegidos al enviar, ordenados. Vacío = lote anterior a A1 (todos los aplicables). */
  conceptos: text('conceptos').array().notNull().default(sql`'{}'::text[]`),
  /**
   * Snapshot INMUTABLE de la emisión elegida al enviar (A2). Entra en la huella: cambiar el vendedor
   * cambia la factura, así que cambia la identidad del lote.
   *
   * **`null` = lote encolado antes del 2026-08-13, al que le falta con qué emitir.** Hasta la 0148
   * significaba «usar la configuración global vigente»; esa configuración se retiró y ya no hay nada
   * detrás, así que `prepararEmision` rechaza el lote y pide reenviar los trámites. No se puso
   * `NOT NULL` para no tener que inventarle un vendedor a esos lotes en una migración — se prefiere
   * una fila que falla ruidosamente al emitir sobre una que emite con datos que nadie eligió.
   *
   * `centroCostoCodigo` es la excepción: ahí `null` sigue siendo legítimo, porque solo es obligatorio
   * cuando el comprobante lo exige (`cost_center_mandatory` de `/v1/document-types`).
   */
  documentoTipoCodigo: varchar('documento_tipo_codigo', { length: 60 }),
  vendedorCodigo: varchar('vendedor_codigo', { length: 60 }),
  formaPagoCodigo: varchar('forma_pago_codigo', { length: 60 }),
  centroCostoCodigo: varchar('centro_costo_codigo', { length: 60 }),
  /**
   * Si al enviar se pidió que la factura saliera por correo (HU #11708, migración 0161).
   *
   * **No entra en la huella**, y esa es la diferencia con los cuatro campos de arriba. El vendedor
   * cambia el DOCUMENTO que ve la DIAN; el correo solo dice qué hacer con él después. Meterlo en la
   * identidad del lote le daría dos claves de idempotencia al mismo documento fiscal —y con ellas la
   * posibilidad de dos facturas ante la DIAN— para expresar una diferencia que la DIAN no ve. Un
   * segundo envío con la casilla cambiada recibe `ya_estaba`, y el correo se pide con el reenvío.
   */
  correoSolicitado: boolean('correo_solicitado').notNull().default(false),
  /**
   * Direcciones elegidas al enviar. **Vacío = las de la ficha del cliente, no «a nadie»**: quien no
   * quiere que salga no marca `correoSolicitado`.
   *
   * DATO PERSONAL en una tabla que no tenía ninguno. Se guarda porque la emisión ocurre después y en
   * otro proceso, y para entonces la ficha pudo cambiar. La contrapartida no es opcional: el flujo
   * de supresión de `privacy.routes.ts` la vacía con `purgarDestinatariosDeLotes`, igual que redacta
   * las actas. Toda dirección que este programa guarda tiene que estar al alcance de la purga.
   */
  correoDestinatarios: jsonb('correo_destinatarios').$type<SiigoDestinatario[]>().notNull().default([]),
  creadoPor: integer('creado_por').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // Es también la garantía del AC1: entre un SELECT y un INSERT cabe otra petición, así que la
  // idempotencia del encolado no puede vivir en el servicio.
  naturalUq: uniqueIndex('idx_siigo_lotes_natural').on(t.ambiente, t.estrategia, t.huella),
}));

/**
 * La factura electrónica (HU #11323).
 *
 * Una factura aceptada por la DIAN **no se puede deshacer**, así que toda la unicidad de este
 * módulo la impone la base de datos y nunca el código.
 *
 * El `UNIQUE` de la clave de idempotencia es **por ambiente**, no global. Global parece más seguro
 * y es lo contrario: `pruebas` y `produccion` son empresas distintas de Siigo, así que un lote
 * ensayado en pruebas dejaría su clave ocupada y la emisión real del mismo lote fallaría para
 * siempre.
 */
export const siigoFacturas = pgTable('siigo_facturas', {
  id: uuid('id').primaryKey().defaultRandom(),
  loteId: uuid('lote_id').notNull().references(() => siigoLotesFacturacion.id),
  ambiente: varchar('ambiente', { length: 12 }).notNull(),
  /** Pregunta 9 abierta (¿una sola empresa emisora?). Registrarlo ahora es gratis; después, imposible. */
  empresaEmisoraNit: varchar('empresa_emisora_nit', { length: 20 }),
  /** Derivada del lote, estable, NUNCA aleatoria. El contrato exige alfanumérico ≤30. */
  idempotencyKey: varchar('idempotency_key', { length: 30 }).notNull(),

  siigoInvoiceId: varchar('siigo_invoice_id', { length: 60 }),
  numero: varchar('numero', { length: 60 }),
  comprobanteNombre: varchar('comprobante_nombre', { length: 120 }),
  cufe: varchar('cufe', { length: 200 }),
  publicUrl: text('public_url'),
  /** `numeric` llega como CADENA por drizzle. No compararlo con un número sin convertir. */
  totalSiigo: numeric('total_siigo', { precision: 14, scale: 2 }),

  estado: varchar('estado', { length: 20 }).notNull().default('en_proceso'),
  /** Reloj del arrendamiento: sin esto, un worker caído bloquea la clave para siempre. */
  enProcesoDesde: timestamp('en_proceso_desde', { withTimezone: true }),
  intentos: integer('intentos').notNull().default(0),
  errorCode: varchar('error_code', { length: 80 }),
  errorDetalle: text('error_detalle'),
  enviadaEn: timestamp('enviada_en', { withTimezone: true }),

  /**
   * Marca APARTE del estado. Una factura emitida cuyo total no cuadra con la liquidación sigue
   * estando emitida —el documento existe ante la DIAN— y además necesita que alguien la mire.
   * Como estado se habría perdido la primera mitad.
   */
  requiereRevision: boolean('requiere_revision').notNull().default(false),
  revisionMotivo: text('revision_motivo'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idemUq: uniqueIndex('idx_siigo_facturas_idem').on(t.ambiente, t.idempotencyKey),
  enProcesoIdx: index('idx_siigo_facturas_en_proceso').on(t.enProcesoDesde),
  estadoIdx: index('idx_siigo_facturas_estado').on(t.ambiente, t.estado, desc(t.createdAt)),
  // Migración 0149. **No es para el JOIN de la reconciliación**, que entra por `id` —la primaria— y
  // desde esa única fila alcanza el lote por la primaria del lote: ese camino no lo toca. Está
  // porque `lote_id` era una clave foránea SIN índice, y sin él cualquier comprobación de integridad
  // sobre `siigo_lotes_facturacion` recorre esta tabla entera, que solo crece.
  loteIdx: index('idx_siigo_facturas_lote').on(t.loteId),
}));

/**
 * Qué trámites cubre cada factura (HU #11323).
 *
 * **N:1 desde el primer día** aunque hoy siempre tenga una sola fila: es lo que permitirá habilitar
 * la facturación consolidada sin migrar `siigoFacturas`.
 *
 * `activo` es un espejo de «su factura no está fallida», mantenido por un disparador. Existe porque
 * el predicado de un índice parcial no admite subconsultas, y comprobarlo en el servicio no sirve:
 * entre el SELECT y el INSERT caben dos peticiones, y el resultado de esa carrera son dos facturas
 * DIAN sobre el mismo trámite.
 */
export const siigoFacturaTramites = pgTable('siigo_factura_tramites', {
  id: uuid('id').primaryKey().defaultRandom(),
  facturaId: uuid('factura_id').notNull().references(() => siigoFacturas.id, { onDelete: 'cascade' }),
  tramiteId: uuid('tramite_id').notNull().references(() => flitoTramites.id),
  /** Se guarda para poder explicar una factura vieja aunque la liquidación cambie después. */
  liquidacionId: uuid('liquidacion_id').references(() => flitoLiquidaciones.id, { onDelete: 'set null' }),
  /** Qué concepto cubre. `null` = factura anterior a A1, que cubría todos los aplicables. */
  concepto: varchar('concepto', { length: 30 }),
  activo: boolean('activo').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  facturaIdx: index('idx_siigo_factura_tramites_factura').on(t.facturaId),
  // Parcial a propósito: una factura `fallida` NO ocupa el trámite, porque el reintento legítimo
  // tiene que poder volver a facturarlo.
  //
  // Por (trámite, concepto) desde A1 (D-5): lo que impide es emitir DOS VECES el mismo concepto del
  // mismo trámite —dos documentos ante la DIAN, irreversibles—, no facturar mañana otro concepto.
  // El COALESCE cubre las filas históricas con `concepto` NULL, que en un índice único serían todas
  // distintas entre sí y dejarían sin protección justo a los datos que ya existen.
  vivoUq: uniqueIndex('idx_siigo_factura_tramites_vivo')
    .on(t.tramiteId, sql`COALESCE(${t.concepto}, '*')`).where(sql`${t.activo}`),
}));

/**
 * Qué trámites contiene un lote (HU #11327, migración 0144).
 *
 * La huella del lote lo IDENTIFICA —sha256 del conjunto ordenado— pero no se puede invertir: sirve
 * para reconocer «esto ya se encoló», no para saber qué hay dentro. Mientras el único que emitía era
 * quien acababa de elegir los trámites daba igual; el trabajador de la cola toma una fila con un
 * `loteId` y nada más, así que sin esta tabla no puede saber qué facturar.
 *
 * La pertenencia se guarda en el LOTE y no en la cola a propósito: la cola dice cuándo toca
 * trabajar, el lote dice sobre qué. Duplicarla en la cola daría dos definiciones del mismo conjunto.
 */
export const siigoLoteTramites = pgTable('siigo_lote_tramites', {
  id: uuid('id').primaryKey().defaultRandom(),
  loteId: uuid('lote_id').notNull()
    .references(() => siigoLotesFacturacion.id, { onDelete: 'cascade' }),
  // RESTRICT explícito: un trámite que se encoló para facturar no se borra dejando el lote
  // apuntando al vacío. El SQL ya lo dice; declararlo aquí evita que `schema.ts` y la migración
  // discrepen, que es una deriva que este repo ya pagó una vez.
  tramiteId: uuid('tramite_id').notNull()
    .references(() => flitoTramites.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // Idempotencia del alta: `asegurarLote` se repite en cada emisión y en cada encolado del mismo
  // conjunto, y tiene que poder repetirse sin duplicar la pertenencia.
  parUq: uniqueIndex('idx_siigo_lote_tramites_par').on(t.loteId, t.tramiteId),
  tramiteIdx: index('idx_siigo_lote_tramites_tramite').on(t.tramiteId),
}));

/**
 * La cola de emisión: qué queda por facturar y cuándo le toca (HU #11327, migración 0144).
 *
 * **Eje APARTE de `siigoFacturas`**, que responde «¿qué le pasó al documento?» y por eso no tiene ni
 * puede tener un estado `pendiente`: su fila nace cuando se reserva la clave de idempotencia, y
 * reservar la clave ya es estar en proceso. Lo que está pendiente es el trámite.
 *
 * **Lo que esta tabla NO garantiza.** No impide la doble factura —eso son la reserva de la clave, el
 * índice de trámites vivos y el `Idempotency-Key`—: impide el TRABAJO duplicado, que dos instancias
 * gasten cuota intentando lo mismo. Y lo impide con el arrendamiento, que no es un quinto estado
 * sino una propiedad de la fila: al vencer vuelve a ser elegible sola, sin que nadie limpie nada
 * detrás de un proceso caído.
 */
export const siigoColaFacturacion = pgTable('siigo_cola_facturacion', {
  id: uuid('id').primaryKey().defaultRandom(),
  // RESTRICT: la fila de cola es el rastro de que alguien pidió facturar esto.
  loteId: uuid('lote_id').notNull()
    .references(() => siigoLotesFacturacion.id, { onDelete: 'restrict' }),
  /** Denormalizado del lote: la sentencia que selecciona Y BLOQUEA no debe alcanzar a otra tabla. */
  ambiente: varchar('ambiente', { length: 12 }).notNull(),
  estado: varchar('estado', { length: 24 }).notNull().default('pendiente'),
  /** Desenlaces de red: Siigo contestó y rechazó. Son los que gastan el techo. */
  intentos: integer('intentos').notNull().default(0),
  maxIntentos: integer('max_intentos').notNull().default(5),
  /** Ciclos SIN desenlace. Techo propio: un Siigo lento no puede dar una factura por perdida. */
  esperas: integer('esperas').notNull().default(0),
  maxEsperas: integer('max_esperas').notNull().default(20),
  /** NOT NULL: una fila sin cita deja de facturarse en silencio, sin que nadie reciba un error. */
  proximoIntentoAt: timestamp('proximo_intento_at', { withTimezone: true }).notNull().defaultNow(),
  ultimoIntentoAt: timestamp('ultimo_intento_at', { withTimezone: true }),
  /** Arrendamiento, no estado. Las dos columnas van juntas o no van (lo afirma un CHECK). */
  tomadoPor: varchar('tomado_por', { length: 120 }),
  tomadoEn: timestamp('tomado_en', { withTimezone: true }),
  /** La factura que produjo el trabajo. La cola la LEE del resultado; nunca escribe en facturas. */
  facturaId: uuid('factura_id').references(() => siigoFacturas.id, { onDelete: 'restrict' }),
  desenlace: varchar('desenlace', { length: 20 }),
  errorCode: varchar('error_code', { length: 80 }),
  errorDetalle: text('error_detalle'),
  encoladoPor: integer('encolado_por').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // Reencolar el mismo conjunto NO crea una segunda fila, y lo garantiza el índice: entre un SELECT
  // y un INSERT cabe otra petición.
  loteUq: uniqueIndex('idx_siigo_cola_lote').on(t.loteId),
  // La consulta del trabajador, exactamente. Parcial: lo terminado es la mayor parte de la tabla con
  // el tiempo y no se vuelve a mirar nunca.
  listaIdx: index('idx_siigo_cola_lista').on(t.ambiente, t.proximoIntentoAt, t.createdAt)
    .where(sql`${t.estado} IN ('pendiente', 'error')`),
  estadoIdx: index('idx_siigo_cola_estado').on(t.ambiente, t.estado, desc(t.createdAt)),
  facturaIdx: index('idx_siigo_cola_factura').on(t.facturaId)
    .where(sql`${t.facturaId} IS NOT NULL`),
}));

/**
 * Historial del estado ante la DIAN (HU #11330, Feature #11243).
 *
 * **Eje distinto del `estado` de `siigoFacturas`.** Aquel responde «¿consiguió FLITO emitirla?»;
 * este, «¿qué dice la autoridad tributaria del documento que ya existe?». Metidos en el mismo
 * campo, una factura `anulada` dejaría de constar como `emitida`, cuando el documento existe ante
 * la DIAN y existirá siempre. Por eso esta HU **no añade una sola columna a `siigoFacturas`**.
 *
 * **Append-only.** El estado vigente es la última fila, no un campo que se sobrescribe: «¿cuándo
 * pasó a rechazada y por qué?» es la pregunta que se hace cuando algo va mal, y un campo
 * sobrescrito no la puede responder. Los disparadores de la migración `0137` prohíben el `DELETE` y
 * limitan el `UPDATE` a que `verificadoEn` avance.
 *
 * Se escribe por una sola puerta —`aplicarEstadoDian()`— y nunca directamente.
 */
export const siigoFacturaEstadosDian = pgTable('siigo_factura_estados_dian', {
  id: uuid('id').primaryKey().defaultRandom(),
  facturaId: uuid('factura_id').notNull()
    .references(() => siigoFacturas.id, { onDelete: 'cascade' }),
  /**
   * Orden total. No sobra teniendo `createdAt`: el `now()` de PostgreSQL es la hora de INICIO DE LA
   * TRANSACCIÓN, así que dos filas de la misma transacción comparten instante y el desempate por
   * un uuid aleatorio sería aleatorio también. «La última fila» se decide por aquí, nunca por fecha.
   */
  secuencia: bigserial('secuencia', { mode: 'number' }).notNull(),
  estado: varchar('estado', { length: 20 }).notNull(),
  /** El CUFE observado. Se repite en cada fila: prueba que se habla del mismo documento. */
  cufe: varchar('cufe', { length: 200 }),
  /** Da sentido a `rechazada`. Sin él, el historial dice que algo falló y no dice qué. */
  motivo: text('motivo'),
  /** `emision | sondeo | webhook | manual`. Ver `siigo-estado-dian.ts`. */
  fuente: varchar('fuente', { length: 12 }).notNull(),
  /** Respuesta cruda YA SANEADA. Nunca contiene la clave con la que se factura. */
  payload: jsonb('payload'),
  registradoPor: integer('registrado_por').references(() => users.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /**
   * Cuándo se confirmó por última vez que el estado seguía siendo este. **Única columna mutable**,
   * y solo hacia adelante: confirmar que una factura sigue aceptada no es un hecho nuevo del
   * documento, es una observación nuestra. Si cada sondeo escribiera una fila, un mes de consultas
   * cada quince minutos dejaría ~2900 filas idénticas y el historial dejaría de ser legible.
   */
  verificadoEn: timestamp('verificado_en', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // UNIQUE y no un índice normal: un `bigserial` se puede sobrescribir o reiniciar, y dos filas de
  // la misma factura con el mismo número volverían ambigua «la última».
  secuenciaUq: uniqueIndex('idx_siigo_estado_dian_secuencia').on(t.facturaId, desc(t.secuencia)),
  facturaFechaIdx: index('idx_siigo_estado_dian_factura_fecha').on(t.facturaId, desc(t.createdAt)),
  // Parcial: las aceptadas y anuladas son la mayoría de la tabla y no hay nada que volver a preguntar.
  pendientesIdx: index('idx_siigo_estado_dian_pendientes').on(t.verificadoEn)
    .where(sql`${t.estado} = 'en_validacion'`),
}));

/**
 * La corrección de una factura ya emitida, hecha por fuera y registrada aquí (HU #11343).
 *
 * **Tabla nueva con clave foránea, sin una sola columna sobre `siigoFacturas`.** No es estética: la
 * Feature #11242 tiene que poder seguir evolucionando su fila sin arrastrar a nadie, y una factura
 * corregida **sigue existiendo ante la DIAN** — el documento no desaparece de la historia porque
 * alguien lo haya anulado después.
 *
 * **Append-only por disparador**, como `siigoOperaciones`. Lo que afirma que una factura se corrigió
 * no puede reescribirse; si se pudiera, no probaría nada. Este módulo no expone actualización ni
 * borrado, y no por olvido: la base los prohíbe.
 *
 * `tipo` **no incluye `nota_credito`**, y esa ausencia es la decisión: no se sabe si corregir una
 * factura emitida es una nota crédito (pregunta 8, abierta). Ver la migración `0140`.
 */
export const siigoFacturaCorrecciones = pgTable('siigo_factura_correcciones', {
  id: uuid('id').primaryKey().defaultRandom(),
  facturaId: uuid('factura_id').notNull().references(() => siigoFacturas.id),
  tipo: varchar('tipo', { length: 20 }).notNull(),
  /** Solo 'manual'. El ejecutor que actúa contra Siigo es la HU #11344, bloqueada. */
  ejecutor: varchar('ejecutor', { length: 20 }).notNull().default('manual'),
  /** Sin identificador no se puede verificar en Siigo, y una corrección no verificable es un rumor. */
  documentoSiigo: varchar('documento_siigo', { length: 100 }).notNull(),
  motivo: text('motivo').notNull(),
  /** Cuándo se hizo EN SIIGO. `createdAt` es cuándo se anotó en FLITO. */
  fechaCorreccion: date('fecha_correccion').notNull(),
  registradoPor: integer('registrado_por').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  facturaIdx: index('idx_siigo_correcciones_factura').on(t.facturaId, desc(t.createdAt)),
}));

/**
 * Acta de entrega por correo de cada factura (HU #11334, migración 0141).
 *
 * El correo lo envía **Siigo**, no FLITO: esto no es una cola de salida y no toca
 * `notification_outbox`. Lo que se guarda es qué le pedimos a Siigo y qué contestó.
 *
 * Append-only con una única puerta: se pueden vaciar los `destinatarios` por un derecho de
 * supresión (Ley 1581) conservando el hecho del envío. Cualquier otro UPDATE y todo DELETE mueren
 * en el disparador — ver el encabezado de la migración.
 */
export const siigoFacturaEnvios = pgTable('siigo_factura_envios', {
  id: uuid('id').primaryKey().defaultRandom(),
  facturaId: uuid('factura_id').notNull().references(() => siigoFacturas.id, { onDelete: 'cascade' }),
  /** 'emision' = el correo que Siigo mandó solo al crear; 'reenvio' = lo pidió una persona. */
  origen: varchar('origen', { length: 12 }).notNull(),
  resultado: varchar('resultado', { length: 16 }).notNull(),
  /** [{ correo, origen }]. La procedencia es lo que hace auditable la resolución de destinatarios. */
  destinatarios: jsonb('destinatarios').$type<SiigoDestinatario[]>().notNull().default([]),
  destinatariosPurgadosEn: timestamp('destinatarios_purgados_en', { withTimezone: true }),
  codigo: varchar('codigo', { length: 60 }),
  motivo: text('motivo'),
  /** NULL cuando lo originó la emisión: ahí no hay una persona que lo pidiera. */
  solicitadoPor: integer('solicitado_por').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  facturaIdx: index('idx_siigo_envios_factura').on(t.facturaId, desc(t.createdAt)),
}));

/**
 * Vínculo entre un cliente de FLITO y su tercero en Siigo (HU #11297, migración 0143).
 *
 * La clave del tercero EN SIIGO es la pareja (identificación, sucursal): una identificación puede
 * repetirse allá si la sucursal es distinta. El índice único va sobre las dos.
 */
/**
 * Lo último que se usó al facturarle a un cliente (A2, migración 0147).
 *
 * **Recuerda, no parametriza.** Se escribe sola al enviar y solo sirve para precargar el diálogo
 * del envío siguiente. Con qué configuración salió cada factura vive en el lote, que es inmutable.
 */
export const siigoEmisionCliente = pgTable('siigo_emision_cliente', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: integer('client_id').notNull().references(() => clients.id, { onDelete: 'cascade' }),
  ambiente: varchar('ambiente', { length: 12 }).notNull(),
  documentoTipoCodigo: varchar('documento_tipo_codigo', { length: 60 }),
  vendedorCodigo: varchar('vendedor_codigo', { length: 60 }),
  formaPagoCodigo: varchar('forma_pago_codigo', { length: 60 }),
  centroCostoCodigo: varchar('centro_costo_codigo', { length: 60 }),
  actualizadoPor: integer('actualizado_por').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // `pruebas` y `produccion` son empresas distintas de Siigo: un vendedor de una no significa nada
  // en la otra, y precargar el diálogo de producción con un código de pruebas sería un rechazo que
  // nadie entendería.
  clienteAmbienteUq: uniqueIndex('idx_siigo_emision_cliente').on(t.clientId, t.ambiente),
}));

export const siigoTerceros = pgTable('siigo_terceros', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: integer('client_id').notNull().references(() => clients.id, { onDelete: 'cascade' }),
  /** Lo único que no podemos reconstruir por nuestra cuenta si se pierde. */
  siigoCustomerId: varchar('siigo_customer_id', { length: 60 }).notNull(),
  /** Copia de la pareja en el momento del vínculo: permite detectar una discrepancia posterior. */
  identificacion: varchar('identificacion', { length: 50 }).notNull(),
  sucursal: integer('sucursal').notNull().default(0),
  /** Hash del objeto EXACTO enviado. Responde «¿cambió?» sin guardar una copia de los datos. */
  huella: varchar('huella', { length: 64 }).notNull(),
  sincronizadoEn: timestamp('sincronizado_en', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  parejaUq: uniqueIndex('idx_siigo_terceros_identificacion_sucursal').on(t.identificacion, t.sucursal),
  clienteUq: uniqueIndex('idx_siigo_terceros_cliente').on(t.clientId),
  /** Y un tercero tiene UN cliente: sin esto, dos clientes pueden acabar facturando contra el mismo. */
  customerUq: uniqueIndex('idx_siigo_terceros_customer').on(t.siigoCustomerId),
}));
