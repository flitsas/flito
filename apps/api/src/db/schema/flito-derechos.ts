// FLITO Derechos de tránsito: `flito_derechos_tramite` y los pendientes por reintento. Se re-exporta desde `../schema.ts` (HU #13984).
import {
  pgTable, varchar, boolean, timestamp, integer, date, index, jsonb, numeric, uuid,
} from 'drizzle-orm/pg-core';
import type { ExtraccionDerechoTramite } from '@operaciones/shared-types';
import { users, clients, procesamientoCuentas } from './nucleo.js';
import { flitoSoportes } from './soat.js';
import { organismosTransitoConfig, flitoTramites } from './tramites.js';

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
