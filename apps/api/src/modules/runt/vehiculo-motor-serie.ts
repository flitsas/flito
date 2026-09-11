/**
 * Número de motor y de serie del RUNT → `vehicles.num_motor` / `vehicles.num_serie` (HU #12401).
 *
 * Vive aquí, en `runt/`, y no dentro de `certificacion-runt.ts` ni de `flito-soat`, a propósito:
 *   · `certificacion-runt.ts` es el motor de COMPARACIÓN de la certificación de impuestos. Es puro y
 *     no loguea; esta función avisa cuando recorta, así que meterla allí le colgaría un logger a un
 *     archivo cuyo contrato es «solo decide».
 *   · La escriben dos recorridos hoy (alta del canal Cliente y verificación diaria de vigencia del
 *     SOAT) y la HU #12402 la va a reutilizar desde Impuestos. Ninguno de los tres es dueño natural
 *     de la regla; `runt/` sí, que es de donde sale el dato.
 *
 * PURA salvo por el `log` que se le inyecta: sin red y sin base, para cubrirla con Vitest a pelo.
 */

import type { loggerFor } from '../../shared/logger.js';

/** Lo mínimo que se necesita del logger. Inyectado, para que el archivo siga siendo puro. */
export type LogDeRecorte = Pick<ReturnType<typeof loggerFor>, 'warn'>;

/**
 * Ancho de `vehicles.num_motor` y `vehicles.num_serie` (varchar(50), migración 0018).
 *
 * Exportado para que el test de paridad lo contraste con `getTableConfig(vehicles)`, igual que
 * `MAX_DATOS_VEHICULO` en `flit-sync/flit-http.adapter.ts`: un tope que se separa de su columna no
 * protege de nada.
 */
export const MAX_MOTOR_SERIE = 50;

/** Los dos campos tal como los devuelve `extraerVehiculoRunt`: `null` = «el RUNT no lo trajo». */
export interface MotorYSerieRunt {
  numMotor: string | null;
  numSerie: string | null;
}

/** Lo que se le pasa a `.set()` / `.values()`. La clave AUSENTE es la mitad del contrato. */
export interface MotorYSeriePersistible {
  numMotor?: string;
  numSerie?: string;
}

/**
 * Recorta a la columna y avisa, sin el valor.
 *
 * Aquí se TRUNCA y no se descarta, al contrario que `acotado()` del sync, y la diferencia está
 * decidida en el AC6 de la HU («se guardan los primeros 50»): el número de motor no es un dato que
 * se compare ni se opere, es un texto que va al Excel del SOAT y a la ficha, y 50 caracteres de un
 * motor de 60 siguen identificando el mismo motor. El aviso lleva el campo y la longitud recibida
 * —NO el valor, ni placa, ni VIN, ni titular—: un campo mal alineado por la pasarela (una
 * dirección donde debía ir el motor) no puede acabar en el log.
 */
function recortado(valor: string, campo: keyof MotorYSerieRunt, log: LogDeRecorte): string {
  if (valor.length <= MAX_MOTOR_SERIE) return valor;
  log.warn(
    { campo, longitud: valor.length, max: MAX_MOTOR_SERIE },
    'dato del RUNT más largo que su columna en vehicles: se guardan los primeros caracteres',
  );
  return valor.slice(0, MAX_MOTOR_SERIE);
}

/**
 * Lo que va a `vehicles` de motor y serie, con la política del sync (ADR-0008 §1.4): **un campo
 * vacío no borra lo que ya se sabía**.
 *
 * Ausente o vacío → la clave NO viaja (ni `null` ni `''`). En un UPDATE eso deja la columna como
 * estaba; en un INSERT, Drizzle la deja en su defecto, que es `null`, y en una fila nueva `null` sí
 * es la forma correcta de decir «el RUNT no lo trajo». Un solo predicado para las dos ramas, y por
 * eso el resultado se aplica con spread (`...motorYSerieParaVehiculo(...)`) y no campo a campo.
 */
export function motorYSerieParaVehiculo(datos: MotorYSerieRunt, log: LogDeRecorte): MotorYSeriePersistible {
  const salida: MotorYSeriePersistible = {};
  const motor = datos.numMotor?.trim();
  if (motor) salida.numMotor = recortado(motor, 'numMotor', log);
  const serie = datos.numSerie?.trim();
  if (serie) salida.numSerie = recortado(serie, 'numSerie', log);
  return salida;
}
