// AC4 — la aritmética del lote, SIN React y SIN una sola petición (HU #11345).
//
// TRES CONSECUENCIAS BUSCADAS, y ninguna es un detalle de implementación:
//
//   1. **No pregunta nada al servidor.** Todo lo que necesita ya está en la fila que se está
//      mirando (`fuente`, `guia.sirveReintentar`, `descarte`, `ocurridoEn`), así que el número que
//      alguien lee justo antes de confirmar NO PUEDE contradecir lo que la lista muestra. Esa es la
//      promesa entera del AC4.
//   2. **Se prueba sin montar nada.** Dentro del diálogo solo podría comprobarse a través de un
//      `<span>`, que es la clase de prueba que sigue en verde cuando el número está mal.
//   3. **Un rechazo que esto no anticipó se ve en el resultado**, no se disimula: el 202 puede traer
//      `descartado_datos` o `no_aplica` para algo que aquí entró, y el diálogo lo agrupa aparte.
//
// LA PALABRA QUE NO SE USA: «descartar». Está ocupada por *dar por perdido*, que es destructiva y
// permanente. «Se van a descartar 4» se lee como «esos cuatro quedan marcados como fallido
// definitivo», que es exactamente lo contrario de lo que pasa (no se los toca). El AC4 se cumple en
// el significado: **«N quedan fuera de este lote»**.

import {
  SIIGO_BANDEJA_TOPE_REENVIO, SIIGO_BANDEJA_TOPE_REINTENTO,
} from '@operaciones/shared-types';
import type { SiigoBandejaFuente } from '@operaciones/shared-types';

/**
 * Lo mínimo de un caso para repartirlo. Se pasa aplanado a propósito: la función no depende del
 * ítem entero del contrato, así que un campo nuevo en la respuesta no la obliga a cambiar.
 */
export interface CasoLote {
  clave: string;
  etiqueta: string;
  fuente: SiigoBandejaFuente;
  facturaId: string;
  /** ISO 8601. Decide quién entra cuando hay tope: **el más antiguo primero**. */
  ocurridoEn: string;
  /**
   * `guia.sirveReintentar`, y **no** `guia.reintentable`.
   *
   * Son preguntas distintas y el contrato lo dice con todas las letras: `reintentable` es «¿vuelve
   * solo?» y `sirveReintentar` es «¿sirve de algo volver a intentarlo a mano?». Una factura que la
   * reconciliación comprobó que Siigo no tiene no vuelve sola —así que `reintentable` es `false`—
   * pero volver a emitirla es exactamente lo correcto. Con el campo equivocado, la bandeja dejaría
   * fuera justo el caso que más claro está.
   */
  sirveReintentar: boolean;
  descartado: boolean;
  /** La frase del servidor, literal, para explicar por qué queda fuera. */
  descripcion: string;
  accion: string;
}

export interface BloqueLote {
  casos: CasoLote[];
  /** Lo que viaja en el cuerpo. Sin repetidos: dos actas de envío pueden ser de la misma factura. */
  facturaIds: string[];
}

export interface ExclusionLote {
  clave: string;
  etiqueta: string;
  /** Por qué queda fuera. De cada caso, nunca un resumen: el AC4 pide el motivo, no el recuento. */
  motivo: string;
}

export interface Previsualizacion {
  seleccionados: number;
  /** El número de la primera frase Y el del botón. Son la misma variable a propósito. */
  aIntentar: number;
  /** `POST /bandeja/reintentar` — **202**: encola, y la factura todavía no existe al contestar. */
  emision: BloqueLote;
  /** `POST /bandeja/reenviar-correo` — **200**: el acta ya existe al contestar. */
  correo: BloqueLote;
  dian: ExclusionLote[];
  descartados: ExclusionLote[];
  noSirveReintentar: ExclusionLote[];
  fueraDeTope: ExclusionLote[];
  totalFuera: number;
  topeEmision: number;
  topeCorreo: number;
}

/** Del más antiguo al más reciente. Es el mismo orden por defecto de la lista, y por eso los que
 *  entran cuando hay tope son los que se ven arriba: la selección se puede comprobar mirando. */
function porAntiguedad(a: CasoLote, b: CasoLote): number {
  return a.ocurridoEn < b.ocurridoEn ? -1 : a.ocurridoEn > b.ocurridoEn ? 1 : 0;
}

function idsUnicos(casos: readonly CasoLote[]): string[] {
  return [...new Set(casos.map((c) => c.facturaId))];
}

/**
 * Reparte la selección en los dos bloques que se van a ejecutar y los cuatro que quedan fuera.
 *
 * **El orden de las exclusiones no es cosmético.** Se comprueba primero la fuente, porque un rechazo
 * de la DIAN no se reintenta *nunca* —emitiría un segundo documento ante la autoridad— y decir de él
 * «está dado por perdido» o «no se arregla reintentando» sería una explicación cierta pero
 * irrelevante. Después el descarte, que es una decisión que alguien tomó y hay que deshacer antes de
 * nada. Y por último la guía, que es el diagnóstico del error.
 */
export function previsualizarLote(seleccion: readonly CasoLote[]): Previsualizacion {
  const emision: CasoLote[] = [];
  const correo: CasoLote[] = [];
  const dian: ExclusionLote[] = [];
  const descartados: ExclusionLote[] = [];
  const noSirveReintentar: ExclusionLote[] = [];

  for (const caso of seleccion) {
    const { clave, etiqueta } = caso;
    if (caso.fuente === 'dian') {
      dian.push({
        clave,
        etiqueta,
        motivo: 'Lo rechazó la DIAN: el documento existe ante la autoridad y reintentarlo emitiría '
          + 'un segundo documento. Se corrige en Siigo Nube y se registra la corrección aquí.',
      });
    } else if (caso.descartado) {
      descartados.push({
        clave,
        etiqueta,
        motivo: 'Está dado por perdido. Para reintentarlo hay que volver a ponerlo en la cola '
          + 'primero, uno por uno.',
      });
    } else if (!caso.sirveReintentar) {
      noSirveReintentar.push({ clave, etiqueta, motivo: `${caso.descripcion} → ${caso.accion}` });
    } else if (caso.fuente === 'emision') {
      emision.push(caso);
    } else {
      correo.push(caso);
    }
  }

  emision.sort(porAntiguedad);
  correo.sort(porAntiguedad);

  const fueraDeTope: ExclusionLote[] = [];
  const recortar = (casos: CasoLote[], tope: number, que: string): CasoLote[] => {
    if (casos.length <= tope) return casos;
    for (const caso of casos.slice(tope)) {
      fueraDeTope.push({
        clave: caso.clave,
        etiqueta: caso.etiqueta,
        motivo: `${que} admite ${tope} por lote y hay ${casos.length}. Entran los ${tope} más `
          + 'antiguos; el resto se puede mandar en un segundo lote.',
      });
    }
    return casos.slice(0, tope);
  };

  const emisionFinal = recortar(emision, SIIGO_BANDEJA_TOPE_REINTENTO, 'El reintento de la emisión');
  const correoFinal = recortar(correo, SIIGO_BANDEJA_TOPE_REENVIO, 'El reenvío del correo');

  return {
    seleccionados: seleccion.length,
    aIntentar: emisionFinal.length + correoFinal.length,
    emision: { casos: emisionFinal, facturaIds: idsUnicos(emisionFinal) },
    correo: { casos: correoFinal, facturaIds: idsUnicos(correoFinal) },
    dian,
    descartados,
    noSirveReintentar,
    fueraDeTope,
    totalFuera: dian.length + descartados.length + noSirveReintentar.length + fueraDeTope.length,
    topeEmision: SIIGO_BANDEJA_TOPE_REINTENTO,
    topeCorreo: SIIGO_BANDEJA_TOPE_REENVIO,
  };
}

/**
 * ¿Este caso puede aportar algo a un lote? Es el predicado de la CASILLA de la fila.
 *
 * La casilla no se pinta donde no hay nada que marcar. Dejar marcar cualquier fila y resolverlo todo
 * en la previsualización sería una sola regla en un solo sitio —tentador— pero produce el gesto
 * «marcar todo → cuarenta quedan fuera → volver a marcar a mano», que es trabajo inventado. Las dos
 * capas dicen lo mismo; **manda la previsualización**, por si el estado cambió entre medias.
 */
export function admiteLote(caso: Pick<CasoLote, 'fuente' | 'descartado' | 'sirveReintentar'>): boolean {
  return caso.fuente !== 'dian' && !caso.descartado && caso.sirveReintentar;
}
