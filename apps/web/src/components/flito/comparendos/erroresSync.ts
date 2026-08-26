// FLITO — Comparendos · Sincronización: qué se le dice al operador cuando el disparo no sale
// (HU #11635, AC3). Sin React: es una tabla y tres predicados.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
// TRES REGLAS QUE ESTE ARCHIVO EXISTE PARA SOSTENER
//
//   1. **Se ramifica por `codigo`, nunca por el texto.** El mensaje del servidor está en español,
//      se escribe para leerlo y va a cambiar —se afina, se le añade contexto, alguien le quita una
//      tilde—. `sin_nits_activos` y `token_no_configurado` son contrato; su redacción no lo es.
//      Es la misma postura de la #11559 y de `NitsComparendos.tsx`.
//   2. **El texto del servidor no se hace eco.** Aquí pesa más que en el resto del módulo por un
//      caso concreto: `nits_filtro_invalido` responde con **la lista de NIT rechazados dentro del
//      mensaje**, y un NIT es un documento de identidad (AGENTS.md §14). Repetirlo tal cual lo
//      metería en el DOM por una vía que nadie revisó y, peor, invitaría a PARSEARLO para sacar los
//      valores — un parseo sobre una frase en prosa que se rompe en silencio en cuanto el backend
//      la reescribe. El copy es genérico y quien tiene que corregir ya sabe qué eligió: lo eligió
//      él, en esta misma pantalla, hace dos segundos.
//   3. **Cada error dice qué hacer, o dice a quién avisar.** Un «no se pudo» sin salida deja a
//      quien opera pulsando el mismo botón. Los tres desenlaces posibles están enumerados en
//      `AccionSync` y no hay un cuarto: o se reintenta, o hay algo que parametrizar en
//      Configuración, o esto no lo arregla quien está mirando la pantalla y hay que decírselo.
//
// Lo que NO vive aquí: el 409 `sync_en_curso` y el corte de tiempo. No son errores de esta tabla
// —son transiciones al seguimiento de la corrida (AC2)— y por eso salen antes, en el hook. Sus dos
// predicados sí están aquí, junto a los demás, para que la clasificación completa se lea de una vez.
// ══════════════════════════════════════════════════════════════════════════════════════════════

import { ApiError } from '../../../lib/api';
import { codigoDeError } from './useComparendoDetalle';

/**
 * Lo único que la consola puede ofrecer, enumerado.
 *
 * `seleccion` no lleva botón: el arreglo es cambiar lo que ya está en pantalla —la lista de NIT
 * elegidos— y un botón «Corregir» que no corrige nada sería un adorno. Lo que hace la consola es
 * llevar el foco y la atención al selector de alcance.
 */
export type AccionSync = 'reintentar' | 'configuracion' | 'token' | 'seleccion' | null;

export interface ErrorSync {
  texto: string;
  accion: AccionSync;
  /**
   * El copy termina en dos puntos y la consola escribe debajo **los NIT que el propio usuario
   * eligió**. Ver la regla 2 de la cabecera: los que el servidor nombra no se leen del mensaje.
   */
  nombraSeleccion?: boolean;
}

/** Texto del botón de cada acción. `seleccion` y `null` no pintan botón (ver `AccionSync`). */
export const ETIQUETA_ACCION: Record<Exclude<AccionSync, 'seleccion' | null>, string> = {
  reintentar: 'Reintentar',
  configuracion: 'Ir a Configuración',
  token: 'Ir al token en Configuración',
};

/**
 * Copy por `codigo` de error del módulo. Las claves son las de `flito-comparendos.errors.ts`.
 *
 * Dos entradas se decidieron en esta HU porque la spec de UX no las traía, y conviene saber por qué
 * cada una acaba donde acaba:
 *
 *   · `scope_demasiado_grande` (400) — **es accionable y por eso NO es un «avisa a soporte»**. El
 *     servidor calcula cuántos NIT caben en el tiempo máximo de una corrida con los municipios
 *     activos que haya; la salida es pedir menos por vez, no llamar a nadie. No se repite el número
 *     máximo que dice el mensaje del servidor: depende del catálogo de municipios y del timeout del
 *     entorno, así que compilarlo aquí sería inventarse un dato que puede ser falso mañana.
 *   · `token_descifrado` (503) — el token guardado quedó DESACTIVADO porque su ciphertext no
 *     verifica. Tiene dos causas con la misma cara: la fila se corrompió (se vuelve a registrar el
 *     token y listo) o la llave maestra del ambiente cambió (registrarlo otra vez volverá a fallar
 *     mañana). El copy dice las dos cosas en ese orden —primero lo que quien mira la pantalla puede
 *     hacer, después a quién avisar si no basta— porque un «avisa al administrador» a secas dejaría
 *     parado un módulo que muchas veces se arregla en treinta segundos desde esta misma pantalla.
 */
const POR_CODIGO: Record<string, ErrorSync> = {
  sin_nits_activos: {
    texto: 'No hay NIT activos para sincronizar. Agrégalos o actívalos en Configuración.',
    accion: 'configuracion',
  },
  nits_filtro_invalido: {
    texto: 'Estos NIT no están activos en el catálogo:',
    accion: 'configuracion',
    nombraSeleccion: true,
  },
  scope_demasiado_grande: {
    texto: 'El alcance que elegiste no cabe en una sola corrida. Sincroniza menos NIT por vez y '
      + 'repite con el resto.',
    accion: 'seleccion',
  },
  token_no_configurado: {
    texto: 'Falta el token SIMIT. Configúralo antes de sincronizar.',
    accion: 'token',
  },
  token_descifrado: {
    texto: 'El token SIMIT guardado no se pudo descifrar y quedó desactivado. Regístralo de nuevo; '
      + 'si vuelve a fallar, avisa a quien administra el ambiente.',
    accion: 'token',
  },
  modo_simulado_en_produccion: {
    texto: 'La sincronización está en modo simulado en un ambiente de producción y se abortó para '
      + 'no escribir datos inventados. Avisa a quien administra el ambiente.',
    accion: null,
  },
  mapa_homologacion_vacio: {
    texto: 'No se puede sincronizar por un problema de configuración del servidor. Avisa a soporte.',
    accion: null,
  },
  llave_maestra: {
    texto: 'No se puede sincronizar por un problema de configuración del servidor. Avisa a soporte.',
    accion: null,
  },
};

/**
 * El error del disparo, traducido.
 *
 * El orden importa: primero el `codigo` —que es el contrato— y solo si no lo hay (o no lo
 * conocemos) se cae al estado HTTP. Un código nuevo que este mapa todavía no tenga sale por el
 * genérico de su estado, que es una degradación aceptable; lo que no puede pasar es que salga
 * `undefined` en pantalla.
 */
export function errorDeSync(e: unknown): ErrorSync {
  const codigo = codigoDeError(e);
  if (codigo && POR_CODIGO[codigo]) return POR_CODIGO[codigo];

  if (e instanceof ApiError) {
    // 403 aquí no es «no eres admin» —esta pantalla ya está tras el guarda de rol— sino que los
    // permisos cambiaron mientras estaba abierta. Reintentar no sirve: hay que volver a entrar.
    if (e.status === 403) {
      return {
        texto: 'Tu sesión ya no tiene permiso para sincronizar comparendos. Vuelve a entrar.',
        accion: null,
      };
    }
    if (e.status === 429) {
      return {
        texto: 'Ya se lanzaron varias sincronizaciones en el último minuto. Espera un minuto.',
        accion: 'reintentar',
      };
    }
  }

  return { texto: 'No se pudo iniciar la sincronización. Vuelve a intentarlo.', accion: 'reintentar' };
}

/**
 * Se acabó el tiempo del cliente, o no hubo respuesta.
 *
 * `status === 0` cubre los tres casos que `api.ts` mete en el mismo saco —timeout propio, fallo de
 * red y abort— y **eso es lo correcto aquí**: en los tres, la petición pudo haber llegado al
 * servidor y la corrida pudo haber arrancado. No se sabe, y por eso ninguno se pinta como fallo
 * definitivo (AC2).
 */
export function esCorteDeTiempo(e: unknown): boolean {
  return e instanceof ApiError && e.status === 0;
}

/**
 * 409 `sync_en_curso`: mi POST no creó nada porque ya había una corrida.
 *
 * Se comprueba el `codigo` y no solo el 409: este módulo responde 409 también a
 * `token_rotacion_concurrente` y a los duplicados de catálogo, y ninguno de esos debe llevar al
 * seguimiento de una corrida que no existe.
 */
export function esSyncEnCurso(e: unknown): boolean {
  return e instanceof ApiError && e.status === 409 && codigoDeError(e) === 'sync_en_curso';
}
