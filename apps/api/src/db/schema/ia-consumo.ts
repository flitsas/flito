// Contrato `ia-consumo` v1 (docs/contratos/ia-consumo.v1.md, ADR-0047) — migración 0306.
// Mismas tres tablas, columnas y tipos que en FLIT 2.0: no se cambian aquí sin una v2 del contrato.
// Los CHECK de catálogo no van en Drizzle ni en el SQL a propósito: el catálogo puede crecer (un uso
// nuevo) sin migración, y lo garantiza el código (`shared/ia-consumo/catalogo.ts`).
import {
  pgTable, uuid, smallint, timestamp, integer, text, bigint, numeric, jsonb, serial, date, unique, index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const iaConsumoLog = pgTable('ia_consumo_log', {
  id: uuid('id').primaryKey(),
  correlacionId: uuid('correlacion_id').notNull(),
  intento: smallint('intento').notNull().default(1),
  pasada: smallint('pasada').notNull().default(1),
  fechaInicio: timestamp('fecha_inicio', { withTimezone: true }).notNull(),
  fechaFin: timestamp('fecha_fin', { withTimezone: true }).notNull(),
  latenciaMs: integer('latencia_ms').notNull(),
  aplicativo: text('aplicativo').notNull(),
  servicio: text('servicio').notNull(),
  ambiente: text('ambiente').notNull(),
  tenantId: text('tenant_id'),
  usuarioId: text('usuario_id'),
  usuarioLogin: text('usuario_login'),
  origen: text('origen').notNull(),
  modulo: text('modulo').notNull(),
  proceso: text('proceso').notNull(),
  tipoTarea: text('tipo_tarea').notNull(),
  placa: text('placa'),
  entidadTipo: text('entidad_tipo'),
  entidadId: text('entidad_id'),
  archivoMime: text('archivo_mime'),
  archivoBytes: bigint('archivo_bytes', { mode: 'number' }),
  archivoPaginas: integer('archivo_paginas'),
  archivoSha256: text('archivo_sha256'),
  proveedor: text('proveedor').notNull(),
  modeloSolicitado: text('modelo_solicitado'),
  modeloRespondido: text('modelo_respondido'),
  idRespuestaProveedor: text('id_respuesta_proveedor'),
  maxTokens: integer('max_tokens'),
  promptCodigo: text('prompt_codigo'),
  promptVersion: text('prompt_version'),
  promptHash: text('prompt_hash'),
  httpStatus: integer('http_status').notNull().default(0),
  resultado: text('resultado').notNull(),
  stopReason: text('stop_reason'),
  errorCodigo: text('error_codigo'),
  errorMensaje: text('error_mensaje'),
  tokensEntrada: integer('tokens_entrada').notNull().default(0),
  tokensSalida: integer('tokens_salida').notNull().default(0),
  tokensCacheLectura: integer('tokens_cache_lectura').notNull().default(0),
  tokensCacheEscritura: integer('tokens_cache_escritura').notNull().default(0),
  costoUsdEstimado: numeric('costo_usd_estimado', { precision: 12, scale: 6 }),
  metadatos: jsonb('metadatos'),
}, (t) => ({
  fechaIdx: index('ix_ia_consumo_log_fecha').on(t.fechaInicio),
  moduloFechaIdx: index('ix_ia_consumo_log_modulo_fecha').on(t.modulo, t.fechaInicio),
  placaIdx: index('ix_ia_consumo_log_placa').on(t.placa).where(sql`${t.placa} IS NOT NULL`),
  usuarioIdx: index('ix_ia_consumo_log_usuario').on(t.usuarioId, t.fechaInicio).where(sql`${t.usuarioId} IS NOT NULL`),
  correlacionIdx: index('ix_ia_consumo_log_correlacion').on(t.correlacionId),
}));

export const iaConsumoDetalle = pgTable('ia_consumo_detalle', {
  consumoId: uuid('consumo_id').primaryKey().references(() => iaConsumoLog.id, { onDelete: 'cascade' }),
  fechaInicio: timestamp('fecha_inicio', { withTimezone: true }).notNull(),
  promptTexto: text('prompt_texto'),
  respuestaTexto: text('respuesta_texto'),
}, (t) => ({
  fechaIdx: index('ix_ia_consumo_detalle_fecha').on(t.fechaInicio),
}));

export const iaTarifaModelo = pgTable('ia_tarifa_modelo', {
  id: serial('id').primaryKey(),
  proveedor: text('proveedor').notNull(),
  modelo: text('modelo').notNull(),
  vigenteDesde: date('vigente_desde').notNull(),
  precioEntradaMtok: numeric('precio_entrada_mtok', { precision: 12, scale: 6 }).notNull(),
  precioSalidaMtok: numeric('precio_salida_mtok', { precision: 12, scale: 6 }).notNull(),
  precioCacheLecturaMtok: numeric('precio_cache_lectura_mtok', { precision: 12, scale: 6 }).notNull().default('0'),
  precioCacheEscrituraMtok: numeric('precio_cache_escritura_mtok', { precision: 12, scale: 6 }).notNull().default('0'),
  moneda: text('moneda').notNull().default('USD'),
}, (t) => ({
  unicaVigencia: unique('ia_tarifa_modelo_proveedor_modelo_vigente_desde_key').on(t.proveedor, t.modelo, t.vigenteDesde),
}));
