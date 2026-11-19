// Dr. Flit — consultas de gestión sin IA (Feature #13834, HU #13836).
// Body compartido por los `POST /api/flito/<modulo>/buscar` (trámites en G1; SOAT, impuestos y derechos
// en G2/G3). El valor (placa, VIN o id FLIT) es cuasi-PII: viaja en el body (AGENTS.md §14) y NUNCA se
// escribe en logs, en `audit` ni en el `motivo` del rastro PII.
import { z } from 'zod';
import { MAX_VALOR_GESTION, TARJETAS_POR_MODULO } from '@operaciones/shared-types';

export const busquedaGestionSchema = z.object({
  valor: z.string().trim().min(1).max(MAX_VALOR_GESTION),
}).strict();

/** Página fija de la consulta: la primera, con a lo sumo `TARJETAS_POR_MODULO` filas. */
export const PAGINA_GESTION = Object.freeze({ page: 1, pageSize: TARJETAS_POR_MODULO });

/** Motivo del rastro PII: solo el número de filas, jamás el valor buscado. */
export const motivoGestion = (filas: number): string => `Dr. Flit gestión — filas=${filas}`;
