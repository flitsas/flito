// Certificación de impuesto sin trámite. Vive aparte de `schema.ts` por el techo de max-lines.
// `flito_impuestos.tramite_id` es NOT NULL: este registro no cabe en esa tabla.
// Retención (Ley 1581): datos personales del propietario (documento, nombre), placa, VIN y la factura de venta en el
// bucket se conservan 10 años desde la creación del registro, igual que la cédula histórica de logística. Hoy NO hay
// purga automática: la purga y el cifrado en reposo de estos campos quedan como deuda declarada hasta que se defina el
// mecanismo. El acceso a la lectura se registra en pii-audit.
import { sql } from 'drizzle-orm';
import {
  check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar,
} from 'drizzle-orm/pg-core';
import type { ComparacionCampoFacturaRunt } from '@operaciones/shared-types';
import { organismosTransitoConfig, users } from '../schema.js';

/** Lista blanca del RUNT que imprime el PDF. Misma forma que `RegistroRuntCertificado`. */
export interface RegistroRuntGuardado {
  clasificacion: string | null;
  color: string | null;
  cilindraje: string | null;
  tipoServicio: string | null;
  organismoTransito: string | null;
  estadoAutomotor: string | null;
  fechaMatricula: string | null;
  numMotor: string | null;
  numChasis: string | null;
  numSerie: string | null;
}

export const ESTADOS_CERTIFICACION_DIRECTA = [
  'radicado', 'sin_respuesta', 'sin_vehiculo', 'sin_coincidencia', 'certificado',
] as const;
export type EstadoCertificacionDirecta = (typeof ESTADOS_CERTIFICACION_DIRECTA)[number];

/** Lo que se congela al certificar, para rearmar el PDF sin volver al RUNT. */
export interface SnapshotCertificacionDirecta {
  campos: ComparacionCampoFacturaRunt[];
  registroRunt: RegistroRuntGuardado;
}

export const flitoImpuestoCertificacionDirecta = pgTable('flito_impuesto_certificacion_directa', {
  id: uuid('id').primaryKey().defaultRandom(),
  organismoCodigo: varchar('organismo_codigo', { length: 5 }).notNull().references(() => organismosTransitoConfig.codigo),
  placa: varchar('placa', { length: 10 }).notNull(),
  placaNorm: varchar('placa_norm', { length: 10 }).notNull(),
  documentoPropietario: varchar('documento_propietario', { length: 30 }).notNull(),
  nombrePropietario: varchar('nombre_propietario', { length: 200 }).notNull(),
  vin: varchar('vin', { length: 17 }).notNull(),
  vinNorm: varchar('vin_norm', { length: 17 }).notNull(),
  marca: varchar('marca', { length: 60 }).notNull(),
  linea: varchar('linea', { length: 80 }).notNull(),
  anio: varchar('anio', { length: 4 }).notNull(),
  color: varchar('color', { length: 60 }).notNull(),
  cilindrada: varchar('cilindrada', { length: 20 }).notNull(),
  facturaStorageKey: text('factura_storage_key').notNull(),
  facturaNombre: varchar('factura_nombre', { length: 200 }).notNull(),
  facturaMime: varchar('factura_mime', { length: 80 }).notNull(),
  facturaBytes: integer('factura_bytes').notNull(),
  estado: varchar('estado', { length: 20 }).$type<EstadoCertificacionDirecta>().notNull().default('radicado'),
  comparacion: jsonb('comparacion').$type<ComparacionCampoFacturaRunt[] | null>(),
  snapshot: jsonb('snapshot').$type<SnapshotCertificacionDirecta | null>(),
  certificadoEn: timestamp('certificado_en', { withTimezone: true }),
  certificadoPorId: integer('certificado_por_id').references(() => users.id),
  certificadoPorNombre: varchar('certificado_por_nombre', { length: 200 }),
  creadoPorId: integer('creado_por_id').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  vinCertUq: uniqueIndex('uq_flito_imp_cert_dir_vin').on(t.vinNorm).where(sql`${t.estado} = 'certificado'`),
  placaCertUq: uniqueIndex('uq_flito_imp_cert_dir_placa').on(t.placaNorm).where(sql`${t.estado} = 'certificado'`),
  listaIdx: index('idx_flito_imp_cert_dir_creado').on(t.createdAt),
  estadoCk: check('ck_flito_imp_cert_dir_estado', sql`${t.estado} IN ('radicado','sin_respuesta','sin_vehiculo','sin_coincidencia','certificado')`),
  mimeCk: check('ck_flito_imp_cert_dir_mime', sql`${t.facturaMime} = 'application/pdf'`),
  bytesCk: check('ck_flito_imp_cert_dir_bytes', sql`${t.facturaBytes} > 0 AND ${t.facturaBytes} <= 15728640`),
  certCk: check('ck_flito_imp_cert_dir_cert',
    sql`(${t.estado} = 'certificado') = (${t.certificadoEn} IS NOT NULL AND ${t.snapshot} IS NOT NULL)`),
}));
