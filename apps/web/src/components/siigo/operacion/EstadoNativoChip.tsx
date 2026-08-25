// El chip de estado: **el ÚNICO sitio de la pantalla que traduce un catálogo** (AC3).
//
// La bandeja junta tres cosas que ya tienen dueño y catálogo propios y conserva el estado NATIVO de
// cada una. Inventar aquí un «estado de la bandeja» común sería la cuarta definición de algo que ya
// tiene tres dueños, y mentiría: «Fallido» no significa lo mismo en una cola con cinco intentos, en
// un rechazo de la DIAN y en un correo que nunca salió porque no había dirección.
//
// Está en un archivo y no en tres `switch` repartidos por la fila, el detalle y el diálogo: repartido,
// el día que llegue un estado nuevo a la cola habría tres sitios donde pintarlo y dos donde olvidarlo.
//
// **Falta un `Record` en el contrato.** `siigo-envio.ts` no exporta el suyo —las otras dos patas sí
// tienen `SIIGO_COLA_ESTADO_ETIQUETA` y `SIIGO_ESTADO_DIAN_ETIQUETA`—, así que el correo se rotula
// con `SIIGO_BANDEJA_RESULTADO_CORREO_ETIQUETA`, que cubre exactamente los mismos valores. Se usa ese
// y no unas etiquetas escritas aquí a mano, que serían una segunda verdad sobre lo mismo. Queda
// anotado para backend: el rótulo natural sería `SIIGO_ENVIO_RESULTADO_ETIQUETA`.

import {
  SIIGO_BANDEJA_RESULTADO_CORREO_ETIQUETA, SIIGO_COLA_ESTADO_ETIQUETA,
  SIIGO_ESTADO_DIAN_ETIQUETA,
} from '@operaciones/shared-types';
import type {
  SiigoBandejaEstadoNativo, SiigoBandejaFuente, SiigoColaEstado, SiigoEnvioResultado,
  SiigoEstadoDian,
} from '@operaciones/shared-types';
import StatusChip, { type ChipTone } from '../../flit/StatusChip';

const TONO_COLA: Record<SiigoColaEstado, ChipTone> = {
  pendiente: 'active',
  enviado: 'success',
  error: 'warning',
  fallido_definitivo: 'danger',
};

const TONO_DIAN: Record<SiigoEstadoDian, ChipTone> = {
  en_validacion: 'active',
  aceptada: 'success',
  rechazada: 'danger',
  anulada: 'draft',
};

/**
 * `no_realizado` **no** es sinónimo de `fallido`, y la bandeja es justo donde esa distinción se paga:
 * un cliente sin correo en la ficha nunca llegó a Siigo, así que reintentar volvería a no salir. Dos
 * estados distintos y dos tonos distintos; la guía es la que dice si sirve reintentarlo.
 */
const TONO_CORREO: Record<SiigoEnvioResultado, ChipTone> = {
  enviado: 'success',
  fallido: 'danger',
  no_realizado: 'warning',
};

/** La etiqueta y el tono de la pata del caso. `null` cuando la fuente no trajo su estado. */
function leer(
  fuente: SiigoBandejaFuente, estado: SiigoBandejaEstadoNativo,
): { texto: string; tono: ChipTone } | null {
  if (fuente === 'emision' && estado.cola) {
    return { texto: SIIGO_COLA_ESTADO_ETIQUETA[estado.cola], tono: TONO_COLA[estado.cola] };
  }
  if (fuente === 'dian' && estado.dian) {
    return { texto: SIIGO_ESTADO_DIAN_ETIQUETA[estado.dian], tono: TONO_DIAN[estado.dian] };
  }
  if (fuente === 'correo' && estado.correo) {
    return {
      texto: SIIGO_BANDEJA_RESULTADO_CORREO_ETIQUETA[estado.correo],
      tono: TONO_CORREO[estado.correo],
    };
  }
  return null;
}

export default function EstadoNativoChip(
  { fuente, estado }: { fuente: SiigoBandejaFuente; estado: SiigoBandejaEstadoNativo },
) {
  const leido = leer(fuente, estado);
  // Sin estado no se pinta un chip vacío ni un «—» con forma de estado: un indicador sobre un dato
  // que no existe miente más de lo que informa.
  if (!leido) return null;
  return <StatusChip tone={leido.tono}>{leido.texto}</StatusChip>;
}
