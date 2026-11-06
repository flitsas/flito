// Barril del esquema Drizzle: solo re-exporta. Toda tabla nueva va en `./schema/<dominio>.ts` (HU #13984).
// Lo que un archivo de `schema/` evalúa al cargar y usan dos o más (enums, `bytea`) va en `./schema/_comunes.ts`.
export { flitoModalidadEnum, vehicleTypeEnum, fuelTypeEnum, docEstadoEnum } from './schema/_comunes.js'; // `bytea` es interno.
export * from './schema/nucleo.js';
export * from './schema/flota.js';
export * from './schema/mantenimiento.js';
export * from './schema/pesv.js';
export * from './schema/rndc.js';
export * from './schema/laft.js';
export * from './schema/tramites.js';
export * from './schema/soat.js';
export * from './schema/comparendos.js';
export * from './schema/siigo.js';
export * from './schema/finanzas.js';
export * from './schema/flito-impuestos.js';
export * from './schema/flito-derechos.js';
export * from './schema/flito-seguimiento.js';
export * from './schema/flito-logistica.js';
export { permisosRoles, permisosFunciones, permisosRolFuncion, permisosUsuarioFuncion, permisosIntentosDenegados, permisosAuditoria } from './schema/permisos.js';
export * from './schema/flito-bolsas-documentos.js';
export * from './schema/flito-soat-masivo.js';
export * from './schema/uso-legacy.js';
export { flitoComprobantes } from './schema/flito-comprobantes.js';
export * from './schema/flito-bolsas-unicas.js';
export { flitoSoatIncompletas } from './schema/flito-soat-incompletas.js';
export { flitoStorageBorradosPendientes } from './schema/flito-storage-borrados-pendientes.js';
export { flitoImpuestoEnviosFlit2 } from './schema/flito-impuesto-envios-flit2.js';
export { flitoImpuestoCertificacionDirecta } from './schema/flito-impuesto-certificacion-directa.js';
export { flitoTramiteViajesLogistica } from './schema/flito-logistica-viajes.js';
export * from './schema/flito-logistica-traslados.js';
export * from './schema/pii-key-registry.js'; // Feature #13978: registro de llaves PII
export * from './schema/flito-proveedores.js'; // Feature #14323 (ADR-0039): identidad única de proveedor
export { flitoSyncFlit2Acceso, flitoSyncFlit2Lectura, flitoSyncInterruptor, flitoSyncFlit1Lectura } from './schema/flito-sync.js';
// `./schema/flito-drflit.ts` (HU #13803, Dr. Flit, Ley 1581) NO se re-exporta: se importa de ahí directo.
