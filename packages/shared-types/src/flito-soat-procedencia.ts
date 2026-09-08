// FLITO — SOAT, canal Cliente: DE DÓNDE salió cada dato del propietario (Feature #12073, HU #12093).
//
// ── Qué problema resuelve, y por qué necesita vocabulario COMPARTIDO ────────────────────────────
//
// Desde la HU #12092 el formulario del canal ya no se teclea entero: el OCR lee el comprador de la
// factura de venta y el RUNT confirma el vehículo, así que el mismo campo puede llegar de tres sitios
// distintos —lo leyó la factura, lo trajo el RUNT, o lo escribió la persona—. Operaciones revisa esas
// solicitudes y tiene que poder explicar qué está leyendo: «este nombre lo puso el concesionario en
// la factura» y «esta dirección la tecleó el cliente» no se revisan igual.
//
// Vive en `shared-types` y no en el módulo de la API porque los DOS extremos escriben contra este
// vocabulario: el formulario (HU #12094) construye el mapa campo a campo mientras el usuario corrige,
// y el alta lo valida y lo persiste. Con las tres cadenas escritas a mano en cada lado, el día que
// alguien renombrara un valor el front seguiría mandando el viejo y el back respondería 400 sin que
// nada en el build se pusiera rojo.
//
// ── Lo que este archivo NO decide ───────────────────────────────────────────────────────────────
//
// No decide qué campos son «del comprador»: esa lista es `CAMPOS_COMPRADOR_FACTURA`, y vive junto al
// enum de campos de la factura porque es de donde se leen. Aquí se importa. Duplicarla sería tener
// dos listas que el día que crezca la factura dirían cosas distintas: el OCR extraería un décimo
// campo que la procedencia no sabría nombrar.

import type { CampoCompradorFactura } from './flito-ocr.js';

/**
 * Las TRES procedencias posibles de un dato del propietario, y no hay una cuarta.
 *
 *   · `factura` — lo leyó el OCR de la factura de venta y la persona NO lo tocó (HU #12092).
 *   · `runt`    — lo trajo la consulta al registro nacional dentro del alta (ADR-0010).
 *   · `manual`  — lo escribió o lo corrigió la persona. Es también el DEFECTO: ver
 *     {@link PROCEDENCIA_POR_DEFECTO}.
 *
 * No hay un valor «desconocido»: el hueco se llena con `manual`, que es el único de los tres que no
 * afirma nada que no haya pasado. Un dato que llegó sin declarar procedencia lo puso alguien —no hay
 * otra vía de entrada al alta—, así que `manual` es lo cierto y no una suposición cómoda.
 */
export const ProcedenciaDato = {
  FACTURA: 'factura',
  RUNT: 'runt',
  MANUAL: 'manual',
} as const;

export type ProcedenciaDato = (typeof ProcedenciaDato)[keyof typeof ProcedenciaDato];

/** Los tres valores en forma de lista, para el `z.enum` de la ruta y para el formulario. */
export const PROCEDENCIAS_DATO = [
  ProcedenciaDato.FACTURA,
  ProcedenciaDato.RUNT,
  ProcedenciaDato.MANUAL,
] as const satisfies readonly ProcedenciaDato[];

/**
 * El defecto, en una constante y no en tres literales repartidos.
 *
 * Lo aplican el servicio del alta (AC3: «esos campos quedan como `manual`, nunca nulos ni ausentes»)
 * y el formulario cuando la persona teclea sobre un campo leído. Que sea la misma constante es lo que
 * hace que las dos mitades no puedan discrepar.
 */
export const PROCEDENCIA_POR_DEFECTO: ProcedenciaDato = ProcedenciaDato.MANUAL;

/**
 * El mapa COMPLETO: los nueve campos del comprador, cada uno con su procedencia.
 *
 * Es un `Record` y no un `Partial`, y esa es la mitad del AC3: lo que se persiste no tiene huecos. Un
 * mapa a medias obligaría a todo lector a decidir por su cuenta qué significa una clave ausente, y la
 * primera pantalla que decidiera «ausente = leído de la factura» estaría afirmando de un dato tecleado
 * que lo puso el concesionario.
 *
 * Lo que la BASE guarda es {@link ProcedenciaCompradorPersistida}, que sí admite el mapa vacío: es lo
 * que tienen las ~7 052 filas anteriores a la migración 0174.
 */
export type ProcedenciaComprador = Record<CampoCompradorFactura, ProcedenciaDato>;

/**
 * Lo que de verdad puede haber en `flito_compradores.procedencia`, que NO es lo mismo.
 *
 * La columna nace `NOT NULL DEFAULT '{}'` y la migración 0174 no lleva backfill (no hay nada que
 * rellenar: de las filas viejas no se sabe de dónde salió cada dato, e inventarlo sería escribir en
 * la base una procedencia que nadie observó). Así que toda fila anterior a esta HU —y toda fila del
 * sync de trámites, que ni siquiera pasa por el canal— lleva `{}`.
 *
 * El tipo lo dice en vez de esconderlo: quien lea esta columna tiene que contar con el mapa vacío. El
 * alta, en cambio, escribe siempre un {@link ProcedenciaComprador} completo, que es asignable a esto.
 */
export type ProcedenciaCompradorPersistida = Partial<ProcedenciaComprador>;
