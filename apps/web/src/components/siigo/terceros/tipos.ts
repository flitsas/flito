// Contratos y catálogos de la pestaña «Terceros» de la parametrización (HU #11299, Feature #11241).
//
// Vive aparte de los cuatro bloques porque los cuatro comparten los mismos motivos y las mismas
// formas de respuesta: duplicar la etiqueta de un motivo en dos archivos es cómo se llega a que la
// misma carencia se llame de dos maneras en la misma pantalla.
//
// Lo que NO está aquí, y es deliberado: nada de `puntaje`. El servicio de equivalencias lo calcula
// como `1 − distancia/(longitud+1)` y pintarlo como porcentaje de confianza inventaría una
// precisión que la distancia de edición no tiene (spec UX §Superficie 2).

import {
  MOTIVOS_NO_FACTURABLE,
  MOTIVOS_PENDIENTE_CLASIFICACION,
  type FaltanteCliente,
  type MotivoNoFacturable,
} from '@operaciones/shared-types';
import { ApiError } from '../../../lib/api';
import type { ChipTone } from '../../flit/StatusChip';

/**
 * Etiqueta corta de cada motivo: la que cabe en una pastilla de filtro.
 *
 * La frase completa NO se reescribe aquí — sale de `MOTIVOS_NO_FACTURABLE`, que ya está redactada
 * en prosa de negocio. Esto es solo el rótulo de dos palabras del filtro, y por eso es lo único de
 * copy nuevo que la pestaña añade sobre el catálogo.
 */
export const ETIQUETA_CORTA_MOTIVO: Record<MotivoNoFacturable, string> = {
  tipo_persona_sin_clasificar: 'Tipo de persona',
  id_tipo_faltante: 'Tipo de identificación',
  identificacion_faltante: 'Identificación',
  identificacion_duplicada: 'Identificación duplicada',
  nombre_no_utilizable: 'Nombre',
  nombre_particion_sin_confirmar: 'Partición del nombre',
  responsabilidad_fiscal_faltante: 'Resp. fiscal',
  direccion_faltante: 'Dirección',
  ubicacion_faltante: 'Ciudad',
  telefono_faltante: 'Teléfono',
  contacto_faltante: 'Contacto',
};

/** ¿Este motivo se resuelve decidiendo (alguien mira) o capturando (alguien teclea)? */
export function esDeDecision(motivo: MotivoNoFacturable): boolean {
  return MOTIVOS_PENDIENTE_CLASIFICACION.includes(motivo);
}

/**
 * Los dos grupos del detalle (AC4). El orden DENTRO de cada grupo es el que trae el servidor
 * —identidad → nombre → fiscales → ubicación → teléfono → contacto, el orden de un formulario—: no
 * se reordena por «gravedad», que sería una jerarquía inventada donde todos bloquean por igual.
 */
export function agruparFaltantes(faltantes: readonly FaltanteCliente[]): {
  decidir: FaltanteCliente[];
  capturar: FaltanteCliente[];
} {
  return {
    decidir: faltantes.filter((f) => esDeDecision(f.motivo)),
    capturar: faltantes.filter((f) => !esDeDecision(f.motivo)),
  };
}

// ---------------------------------------------------------------------------
// Equivalencias de ciudad (`/api/siigo/clientes-ciudades`)
// ---------------------------------------------------------------------------

export type CertezaEquivalencia = 'exacta' | 'aproximada' | 'ambigua' | 'sin_equivalencia';

export interface CandidataCiudad {
  countryCode: string;
  stateCode: string;
  stateName: string;
  cityCode: string;
  cityName: string;
}

export interface PropuestaCiudad {
  textoOrigen: string;
  certeza: CertezaEquivalencia;
  candidatas: CandidataCiudad[];
}

export interface PropuestaCliente {
  clienteId: number;
  nombre: string;
  ciudadTexto: string | null;
  propuesta: PropuestaCiudad;
}

export interface EstadoMapeoCiudades {
  total: number;
  conCodigo: number;
  pendientes: number;
  proponibles: number;
  ambiguos: number;
  sinEquivalencia: number;
}

export interface EquivalenciaObsoleta {
  clienteId: number;
  nombre: string;
  ciudadActual: string | null;
  textoConfirmado: string | null;
}

/** Orden de trabajo de la cola: lo barato primero (spec UX §Superficie 2). */
export const ORDEN_CERTEZA: CertezaEquivalencia[] = ['exacta', 'aproximada', 'ambigua', 'sin_equivalencia'];

// ---------------------------------------------------------------------------
// Sincronización del tercero (`POST /api/siigo/terceros/cliente/:clienteId`)
// ---------------------------------------------------------------------------

export type DesenlaceTercero = 'vinculado_existente' | 'creado' | 'actualizado' | 'sin_cambios';

export interface ResultadoTercero {
  clienteId: number;
  siigoCustomerId: string;
  identificacion: string;
  sucursal: number;
  desenlace: DesenlaceTercero;
}

/**
 * Los CINCO desenlaces, no cuatro (AC6).
 *
 * El AC nombra cuatro; el servicio devuelve además `sin_cambios`, que significa «la huella coincide,
 * no se llamó a Siigo». Plegarlo dentro de «actualizado» daría los cuatro del AC a cambio de
 * afirmar una escritura que no ocurrió, así que tiene su propia fila.
 *
 * `creado` y `vinculado_existente` se separan por CUATRO ejes a la vez —chip, símbolo, frase y
 * tener o no verificación— porque es la distinción con consecuencia contable: creado significa que
 * ahora hay un tercero nuevo en Siigo; vinculado, que ya había uno con su historia contable y que
 * las facturas de FLIT van a salir contra él.
 */
export const DESENLACE: Record<DesenlaceTercero, {
  tono: ChipTone; titulo: string; simbolo: string; frase: string; verificable: boolean;
}> = {
  creado: {
    tono: 'success',
    titulo: 'Creado en Siigo',
    simbolo: '✚',
    frase: 'Antes no existía. Ahora hay un tercero nuevo con este NIT y esta sucursal.',
    verificable: false,
  },
  vinculado_existente: {
    tono: 'active',
    titulo: 'Vinculado a uno que ya existía',
    simbolo: '🔗',
    frase: 'No se creó nada: ya había un tercero con este NIT y esta sucursal, y se apuntó a él. '
      + 'Las facturas saldrán contra su contabilidad.',
    verificable: true,
  },
  actualizado: {
    tono: 'active',
    titulo: 'Actualizado en Siigo',
    simbolo: '↺',
    frase: 'Ya estaba vinculado y algo había cambiado: se reenvió la ficha completa.',
    verificable: false,
  },
  sin_cambios: {
    tono: 'neutral',
    titulo: 'Ya estaba al día',
    simbolo: '●',
    frase: 'Nada cambió desde la última vez. No se llamó a Siigo.',
    verificable: false,
  },
};

/** Los fallos primero: lo que exige que alguien actúe va arriba. El éxito se lee en el encabezado. */
export const ORDEN_DESENLACE: DesenlaceTercero[] = [
  'creado', 'vinculado_existente', 'actualizado', 'sin_cambios',
];

/**
 * Un rechazo que se arregla EN LA FICHA DEL CLIENTE, no escalando a soporte.
 *
 * Cubre las dos formas que tiene ese mismo problema de fondo:
 *   · **422 `cliente_no_facturable`** — el validador dice qué campos faltan y los manda en
 *     `faltantes` (el mismo `FaltanteCliente[]` de `GET /siigo/clientes/:id/validacion`).
 *   · **409 `sin_identificacion`** — el cliente no tiene `document`, así que la identidad no se
 *     puede armar y el fallo ocurre ANTES de validar: llega sin `faltantes`. Es el mismo «le falta
 *     un dato a la ficha» con otra forma, y tratarlo como avería mandaría a buscar a soporte por
 *     algo que se corrige tecleando.
 *
 * Devuelve `null` para cualquier otro fallo: un 429, un 500 o una red caída no se disfrazan de
 * ficha incompleta.
 */
export interface RechazoDeFicha {
  mensaje: string;
  faltantes: FaltanteCliente[];
}

function esFaltante(v: unknown): v is FaltanteCliente {
  if (typeof v !== 'object' || v === null) return false;
  const f = v as { motivo?: unknown; detalle?: unknown };
  return typeof f.motivo === 'string'
    && Object.prototype.hasOwnProperty.call(MOTIVOS_NO_FACTURABLE, f.motivo)
    && typeof f.detalle === 'string';
}

export function rechazoDeFicha(e: unknown): RechazoDeFicha | null {
  if (!(e instanceof ApiError)) return null;
  const cuerpo = e.rawDetails as { codigo?: unknown; faltantes?: unknown } | null | undefined;
  const codigo = typeof cuerpo?.codigo === 'string' ? cuerpo.codigo : null;
  if (codigo !== 'cliente_no_facturable' && codigo !== 'sin_identificacion') return null;
  // `faltantes` es opcional en el contrato y puede llegar vacío en el caso defensivo del servidor:
  // ahí manda el texto de `error`, que es lo que se pinta cuando la lista no trae nada.
  const crudos = Array.isArray(cuerpo?.faltantes) ? cuerpo.faltantes : [];
  return { mensaje: e.toUserMessage(), faltantes: crudos.filter(esFaltante) };
}

/** ¿La petición se fue sin respuesta? (`ApiError.status === 0` = red caída o tope de tiempo). */
export function esSinRespuesta(e: unknown): boolean {
  return e instanceof ApiError && e.status === 0;
}

/** ¿El limitador cortó la tanda? */
export function esDemasiadasSeguidas(e: unknown): boolean {
  return e instanceof ApiError && e.status === 429;
}
