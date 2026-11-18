// Validación Zod de la API de vistas de columnas (ADR-0045). Límites de `reglas.ts` y de shared-types.
import { z } from 'zod';
import { MAX_COLUMNAS_POR_VISTA } from './flito-vistas-columnas.reglas.js';

const claveColumna = z.string().trim().min(1).max(60);

const columnasUnicas = z
  .array(claveColumna)
  .min(1)
  .max(MAX_COLUMNAS_POR_VISTA)
  .refine((cs) => new Set(cs).size === cs.length, { message: 'Columnas repetidas' });

export const crearVistaSchema = z.object({
  nombre: z.string().trim().min(1).max(60),
  alcance: z.enum(['personal', 'compartida']),
  columnas: columnasUnicas,
});

export const actualizarVistaSchema = z
  .object({
    nombre: z.string().trim().min(1).max(60).optional(),
    columnas: columnasUnicas.optional(),
    version: z.number().int().positive(),
  })
  .refine((v) => v.nombre !== undefined || v.columnas !== undefined, { message: 'Nada que actualizar' });

/** `null` = restablecer (sistema explícito). */
export const predeterminadaSchema = z.object({
  vistaId: z.number().int().positive().nullable(),
});

export const vistaIdParamSchema = z.coerce.number().int().positive();

export type CrearVistaEntrada = z.infer<typeof crearVistaSchema>;
export type ActualizarVistaEntrada = z.infer<typeof actualizarVistaSchema>;
