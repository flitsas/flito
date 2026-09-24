// FLITO — Servicios adicionales DE UN TRÁMITE: lo que el panel, la celda de la tabla y el buscador
// comparten sin ser UI (HU #12548, Feature #12544, épica #12246).
// Diseño: `docs/ux/finanzas-reporte-costos-servicios-adicionales.md` §7-R2.
//
// Es el catálogo ASIGNADO, no el catálogo de tipos: aquel vive en `lib/serviciosAdicionales.ts` y
// tiene su propio formato de dinero (`pesosCatalogo`). Aquí el importe se dice con `pesos()` DEL
// REPORTE, que es la pantalla en la que estamos: el total del panel y la celda «Serv. adic.» de la
// fila son la misma cifra y no pueden escribirse distinto.

import {
  CODIGO_SERVICIO_ADICIONAL_TRAMITE,
  type ServicioAdicionalTipo, type TramiteServicioAdicional,
} from '@operaciones/shared-types';
import { pesos, type Fila } from '../components/finanzas/tiposReporteCostos';
import { ApiError, errorMessage } from './api';
import { normalizaTexto } from './tarifas';

/** Los tres verbos cuelgan de la misma ruta; el DELETE le añade `/:asignacionId`. */
export const rutaServiciosDeTramite = (tramiteId: string): string =>
  `/finanzas/tramites/${tramiteId}/servicios-adicionales`;

/** «Sin servicios» · «1 servicio» · «2 servicios». El plural se decide aquí, no en el JSX. */
export function etiquetaCantidad(n: number): string {
  if (n <= 0) return 'Sin servicios';
  return n === 1 ? '1 servicio' : `${n} servicios`;
}

/**
 * Lo que el buscador puede ofrecer: tipos ACTIVOS, sin los que este trámite ya tiene, filtrados por
 * el texto sin tildes ni mayúsculas. Función pura: se prueba sin DOM.
 *
 * El filtro por `activo` es redundante con el endpoint (se pide sin `incluirBajas`) y se deja a
 * propósito: si alguien cambiara la llamada, un tipo dado de baja no se colaría en una lista desde
 * la que se cobra.
 */
export function asignablesDe(
  tipos: ServicioAdicionalTipo[], asignados: readonly string[], consulta = '',
): ServicioAdicionalTipo[] {
  const yaEstan = new Set(asignados);
  const texto = normalizaTexto(consulta.trim());
  return tipos.filter((t) => t.activo && !yaEstan.has(t.id)
    && (texto === '' || normalizaTexto(t.nombre).includes(texto)));
}

/** Los `tipoId` que el trámite ya lleva: lo que `asignablesDe` excluye. */
export const tipoIdsDe = (items: TramiteServicioAdicional[]): string[] => items.map((i) => i.tipoId);

/**
 * Qué dice la celda «Serv. adic.» de una fila. La gobierna la CANTIDAD, no el importe, porque los
 * dos ceros posibles no significan lo mismo (UX §5.3, AC6):
 *
 *   · `cantidad = null` → **«Sin dato»**: la liquidación se selló antes de que FLITO cobrara
 *     servicios adicionales (HU #12546) y el sello no lleva la clave. No es «no tiene ninguno».
 *   · `cantidad = 0`    → **«—»**, el vacío del reporte: no lleva ninguno, no hay nada que hacer.
 *   · `cantidad ≥ 1`    → el importe y cuántos son, en dos renglones. **Con `valor = 0` se pinta
 *     «$ 0»**: dos servicios de valor cero son un cobro legítimo, y aquí el cero es el dato, no la
 *     ausencia de dato.
 *
 * Por eso ni `pesos(valor ?? 0)` —que pondría «$ 0» donde no hay nada, que es lo que esta pantalla
 * evita en todos sus conceptos— ni `if (!valor) vacío` —que borraría el cobro legítimo de cero—.
 */
export type CeldaServicios =
  | { clase: 'sin_dato' }
  | { clase: 'vacio' }
  | { clase: 'valor'; valor: number | null; etiqueta: string; accesible: string };

export function textoCeldaServicios(f: Fila): CeldaServicios {
  const cantidad = f.serviciosAdicionalesCantidad;
  if (cantidad === null) return { clase: 'sin_dato' };
  if (cantidad <= 0) return { clase: 'vacio' };
  const etiqueta = etiquetaCantidad(cantidad);
  const valor = f.serviciosAdicionales;
  return {
    clase: 'valor', valor, etiqueta,
    // Empieza por lo visible (WCAG 2.5.3) y dice el concepto, que la cabecera abrevia. El espacio
    // duro (U+00A0) que `Intl` mete tras el signo se normaliza a uno normal: en un ATRIBUTO nadie
    // normaliza por él —ni el aserto de QA ni quien lo lea—, y con el duro deja de ser «$ 125.000».
    accesible: `${valor === null ? 'Sin importe' : pesos(valor).replace(/\s/g, ' ')} en ${etiqueta} adicionales`,
  };
}

/** El texto del `title` de «Sin dato»: por qué esa liquidación no sabe cuántos llevaba. */
export const TITULO_SIN_DATO = 'Se liquidó antes de que FLITO cobrara servicios adicionales.';

// ── Qué hacer con un error de escritura (UX §6.2 y §6.3) ────────────────────────────────────────

/**
 * La lectura de un fallo del `POST` o del `DELETE`, en una sola función pura: qué se le dice al
 * usuario EN LÍNEA —nunca por el aviso global de la página— y qué tiene que rehacer el panel.
 *
 * Vive aquí y no en cada componente porque los dos verbos comparten cuatro de los cinco
 * desenlaces: un 409 `TRAMITE_LIQUIDADO` deja el panel de solo lectura venga de donde venga, y un
 * 404 del TRÁMITE (que el servidor distingue del 404 de la asignación solo por el texto: no manda
 * `codigo` en ese caso) ofrece actualizar el reporte en los dos.
 */
export interface FalloEscritura {
  mensaje: string;
  /** Repedir la lista del trámite: lo que se ve ya no es lo que hay. */
  recargarLista: boolean;
  /** Repedir el catálogo de tipos: alguien dio uno de baja. */
  recargarCatalogo: boolean;
  /** El trámite quedó sellado: el panel pasa a solo lectura en el acto, sin sondear. */
  soloLectura: boolean;
  /** El trámite ya no existe: se ofrece «Actualizar el reporte». */
  tramiteIdo: boolean;
}

const SIN_NADA = { recargarLista: false, recargarCatalogo: false, soloLectura: false, tramiteIdo: false };

export const MSG_ASIGNACION_DE_COMPROBANTE = 'Este servicio viene de un comprobante de pago aplicado; no se puede quitar desde el panel.';

export function falloDeEscritura(err: unknown, accion: 'asignar' | 'quitar'): FalloEscritura {
  const status = err instanceof ApiError ? err.status : 0;
  const codigo = err instanceof ApiError
    ? (err.rawDetails as { codigo?: string } | null | undefined)?.codigo
    : undefined;
  const delServidor = errorMessage(err);

  if (codigo === CODIGO_SERVICIO_ADICIONAL_TRAMITE.TRAMITE_LIQUIDADO) {
    // El literal es el del servidor a propósito: es el mismo verbo que la línea de estado de solo
    // lectura, y es el que verá quien lo intente otra vez.
    return { ...SIN_NADA, mensaje: delServidor, recargarLista: true, soloLectura: true };
  }
  if (codigo === CODIGO_SERVICIO_ADICIONAL_TRAMITE.SERVICIO_YA_ASIGNADO) {
    return {
      ...SIN_NADA, recargarLista: true,
      mensaje: 'Ese servicio ya está asignado a este trámite. Alguien lo añadió antes; la lista se actualizó.',
    };
  }
  if (codigo === CODIGO_SERVICIO_ADICIONAL_TRAMITE.ASIGNACION_DE_COMPROBANTE) {
    // Bug #12913: quitarla dejaría un comprobante aplicado sin su costo. No se recarga nada: la
    // fila sigue ahí y sigue siendo verdad.
    return { ...SIN_NADA, mensaje: MSG_ASIGNACION_DE_COMPROBANTE };
  }
  if (codigo === CODIGO_SERVICIO_ADICIONAL_TRAMITE.TIPO_NO_DISPONIBLE) {
    return {
      ...SIN_NADA, recargarCatalogo: true,
      mensaje: 'Ese tipo ya no está disponible: alguien lo dio de baja. El catálogo se actualizó.',
    };
  }
  if (status === 404) {
    // El 404 del trámite no trae `codigo`; el de la asignación tampoco. Los separa el literal, que
    // es contrato leído de `finanzas-servicios-adicionales.routes.ts`, no una suposición.
    if (/^El trámite no existe/i.test(delServidor)) {
      return { ...SIN_NADA, mensaje: 'Este trámite ya no existe.', tramiteIdo: true };
    }
    return { ...SIN_NADA, mensaje: 'Ese servicio ya no estaba en el trámite. La lista se actualizó.', recargarLista: true };
  }
  if (status === 403) {
    return {
      ...SIN_NADA, soloLectura: true,
      mensaje: accion === 'asignar'
        ? 'Tu usuario ya no puede asignar servicios adicionales. Vuelve a entrar para actualizar tus permisos.'
        : 'Tu usuario ya no puede quitar servicios adicionales. Vuelve a entrar para actualizar tus permisos.',
    };
  }
  return {
    ...SIN_NADA,
    mensaje: accion === 'asignar'
      ? `No se pudo añadir el servicio. Vuelve a intentarlo. ${delServidor}`
      : `No se pudo quitar el servicio. Vuelve a intentarlo. ${delServidor}`,
  };
}
