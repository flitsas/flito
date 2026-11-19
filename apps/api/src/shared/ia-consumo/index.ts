// Contrato `ia-consumo` v1 (ADR-0047) — punto de entrada para los llamadores: abrir el ámbito y anotar.
export { conContextoIa, leerContextoIa, normalizarPlacaIa, type ContextoIa } from './contexto.js';
export { procesoIa, type ProcesoIaFlito } from './catalogo.js';
export { anotarConsumoIa } from './escritor.js';
