// FLITO SOAT — verificación de vigencia: el RECORRIDO (Feature #12075).
//
// Este archivo es el PUNTO DE EXTENSIÓN de la HU #12096 y hoy no tiene lógica de negocio dentro. La
// HU #12095 entrega solo la programación de la corrida (`flito-soat-vigencia.cron.ts`): cuándo
// arranca, quién la ejecuta, cómo se apaga y cuándo se reintenta. Lo que se separa aquí —a
// propósito— es QUÉ hace la corrida: elegir los vehículos con comprobante cargado, consultar la
// vigencia y escribir el resultado.
//
// El contrato existe ANTES que la implementación porque el andamiaje depende de él en dos puntos que
// no son cosméticos:
//
//   · `pendientes > 0` es lo ÚNICO que dispara el reintento horario (AC6 de la #12095). Mientras
//     este archivo devuelva cero, la corrida se cierra como completa y no se reintenta nunca: es el
//     comportamiento correcto de un recorrido que no existe todavía, no un fallo silencioso.
//   · `dia` e `intento` viajan hacia adentro para que el recorrido pueda excluir lo que ya verificó
//     con éxito ese día (AC6, segunda parte). El filtro es de la #12096 —el cron no sabe de
//     vehículos—, pero sin estos dos datos en la firma la #12096 no tendría con qué filtrar.
//
// ── Lo que la HU #12096 NO puede perder al crear la tabla de corridas ────────────────────────────
//
// La tabla debe guardar UNA FILA POR CORRIDA, no una por día vivo.
//
// Hoy el estado de la corrida vive en una sola clave de `system_kv`
// (`flito-soat.vigencia.corrida-dia`), y eso significa que el día siguiente la SOBRESCRIBE: si el 4
// cierra `parcial` con vehículos sin verificar, el 5 a las 00:10 esa constancia desaparece de la base
// y solo queda en los logs. El AC6 de la #12095 pide cerrar el día como parcial «dejando
// constancia», y con una sola clave esa constancia es efímera — sirve para decidir (que es para lo
// que la #12095 la usa: ¿corro hoy o no?), no para responder «¿qué días quedaron a medias este mes?».
//
// Esta HU tiene prohibido tocar el esquema, así que la deuda se traslada explícita: cuando la #12096
// mueva `leerEstadoDelDia`/`guardarEstadoDelDia` del KV a la tabla, la clave primaria tiene que ser
// el DÍA (o el par día+intento), y la lectura del cron un «último estado del día de hoy» — no un
// `UPDATE` sobre la única fila. Con una fila por día vivo se repite el mismo agujero con más pasos.

import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('flito-soat-vigencia');

export interface RecorridoVigenciaParams {
  /** Día de la corrida en Bogotá, `YYYY-MM-DD`. Es la llave por la que la #12096 sabrá qué vehículos ya verificó hoy. */
  dia: string;
  /** Número de ejecución del día: 1 es la corrida inicial, 2..4 son los reintentos horarios. */
  intento: number;
}

export interface ResultadoRecorridoVigencia {
  /** Vehículos que el recorrido tomó en este intento. */
  considerados: number;
  /** Verificados con éxito en este intento. Un reintento no vuelve a tomarlos. */
  verificados: number;
  /**
   * Vehículos que quedaron SIN verificar por indisponibilidad de la fuente.
   *
   * Mayor que cero es lo que reprograma la corrida a la hora siguiente. No incluye los que se
   * resolvieron con un «no» legítimo: eso es un vehículo verificado, no uno pendiente.
   */
  pendientes: number;
}

/**
 * Recorre los vehículos que toca verificar hoy. **Sin implementar: HU #12096.**
 *
 * No lanza ni consulta a nadie. Devuelve un recorrido vacío para que el andamiaje de la #12095 se
 * pueda desplegar y observar (arranque, candado, interruptor, idempotencia del día) sin tocar
 * todavía ni un vehículo ni el RUNT.
 */
export async function recorrerVigenciaSoat(
  params: RecorridoVigenciaParams,
): Promise<ResultadoRecorridoVigencia> {
  log.warn(
    { dia: params.dia, intento: params.intento },
    'recorrido de vigencia SIN IMPLEMENTAR (HU #12096): la corrida se cierra sin verificar ningún vehículo',
  );
  return { considerados: 0, verificados: 0, pendientes: 0 };
}
