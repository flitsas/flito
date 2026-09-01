// FLITO — export a Excel de las colas de SOAT e Impuestos (Feature #11908, HU #11909).
//
// Lo que se comparte entre el servidor y la pantalla de este export es UN número: cuántas filas
// admite. La pantalla lo necesita para explicar el 422 antes de que el usuario lo provoque; el
// servidor lo usa como valor por defecto de su perilla de entorno. Con dos copias, el aviso de la
// interfaz diría un número y el backend aplicaría otro.
//
// Las columnas del archivo NO viven aquí: las escribe el servidor y nadie más las consume
// (`apps/api/src/shared/export/cola-flito-excel.ts`). Publicarlas en el paquete compartido invitaría
// a que la pantalla renderizara una vista previa a partir de ellas, y ahí el `.xlsx` dejaría de
// tener una sola fuente.

/**
 * Tope de filas de un export de la cola de SOAT o de Impuestos. Un filtro que devuelva más responde
 * 422 y no genera archivo.
 *
 * **Es el MISMO 2 000 de `COMPARENDOS_EXPORT_MAX_FILAS`, y no una coincidencia estética.** El número
 * de allí no salió de un criterio de producto sino de una MEDICIÓN de memoria: `sendExcel` arma el
 * workbook entero en el heap, el API corre en una sola instancia fork con `max_memory_restart:
 * '512M'`, y el limitador del export es por usuario —así que nada impide que se construyan cinco a
 * la vez—. Esa medición está documentada en el docstring de `COMPARENDOS_EXPORT_MAX_FILAS` y en
 * `apps/api/__tests__/services/flito-comparendos-export-concurrencia.test.ts`, y cubre exactamente
 * el mismo mecanismo: mismo proceso, mismo `sendExcel`, mismo techo de PM2.
 *
 * Estas dos colas tienen ADEMÁS un archivo más estrecho —once columnas frente a veintiuna—, así que
 * el mismo tope compra más margen del que se midió, no menos.
 *
 * **Una sola constante para las dos colas y no una por módulo** (decisión pegada en la HU): el
 * presupuesto que se está repartiendo es el del PROCESO, y el proceso es uno. Dos perillas
 * independientes darían la ilusión de dos presupuestos y se sumarían en el mismo heap.
 *
 * Subirlo no es configuración: multiplica por 5/min el techo de extracción de datos personales de
 * los dos módulos, y lo que sale de aquí lleva cédula, correo y dirección del titular. El techo duro
 * de la variable de entorno (20 000) es el punto donde ADR-0004 dice que el debate deja de ser el
 * tope y pasa a ser la arquitectura (export asíncrono); pasar de ahí exige un ADR, no un `.env`.
 */
export const FLITO_COLA_EXPORT_MAX_FILAS = 2000;
