// FLITO logística — predicado «trámite aprobado» y normalización de placa, compartidos por el escaneo
// (flito-logistica.service.ts) y el registro masivo de viajes (HU #14127), para que ambos definan
// «aprobado» igual. Fichero propio: flito-logistica.service.ts está contra su techo de líneas.
import { sql } from 'drizzle-orm';
import { flitoTramites } from '../../db/schema.js';

export const normPlaca = (s: string): string => s.toUpperCase().replace(/[\s-]/g, '');
// HU #13946: un trámite retenido (cliente inactivo) puede llegar o pasar a «Aprobado» en FLIT (el sync escribe
// `flit_estado` en cada update), pero no entra a la consola, ni al escaneo/validación de la LT, ni a las facetas.
export const aprobadoSql = sql`lower(${flitoTramites.flitEstado}) = 'aprobado' AND NOT ${flitoTramites.retenido}`;
