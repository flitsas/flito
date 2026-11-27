// Épica #14548 (ADR-0051) — Errores de dominio del visor de consumo de IA. El servicio no conoce HTTP: lanza
// `IaConsumoError` y la ruta traduce `status` y `codigo` (diseño §8.5). El `codigo` es el contrato; el mensaje es para la
// persona usuaria y nunca lleva el valor de un filtro ni un dato personal.
import { IA_RANGO_MAX_DIAS } from '@operaciones/shared-types';

export type CodigoErrorIa =
  | 'datos_invalidos'
  | 'rango_invalido'
  | 'rango_demasiado_amplio'
  | 'fuera_de_ventana'
  | 'cursor_invalido'
  | 'no_encontrado'
  | 'consulta_demasiado_lenta'
  | 'auditoria_no_disponible';

const ESTADO: Record<CodigoErrorIa, number> = {
  datos_invalidos: 400,
  rango_invalido: 400,
  rango_demasiado_amplio: 400,
  fuera_de_ventana: 400,
  cursor_invalido: 400,
  no_encontrado: 404,
  consulta_demasiado_lenta: 503,
  auditoria_no_disponible: 503,
};

/** Textos para la persona usuaria, uno por código fijo (`fuera_de_ventana` lleva su fecha: ver `mensajeFueraDeVentana`). */
export const MENSAJES_IA = {
  datos_invalidos: 'Revisa los filtros: hay un valor que no es válido.',
  rango_invalido: 'El rango de fechas no es válido. La fecha de inicio debe ser anterior o igual a la de fin, y no puede ser futura.',
  rango_demasiado_amplio: `Una consulta admite hasta ${IA_RANGO_MAX_DIAS} días. Acota el rango.`,
  cursor_invalido: 'La página ya no es válida. Vuelve a buscar desde el principio.',
  no_encontrado: 'No encontramos ese registro.',
  consulta_demasiado_lenta: 'La consulta tardó demasiado. Reduce el rango de fechas y vuelve a intentarlo.',
  auditoria_no_disponible: 'No pudimos registrar el acceso a datos personales, así que no mostramos la información. Intenta de nuevo en un momento.',
} as const satisfies Record<Exclude<CodigoErrorIa, 'fuera_de_ventana'>, string>;

/** Mensaje de `fuera_de_ventana`: la fecha mínima y cuántos meses cubre la ventana. */
export function mensajeFueraDeVentana(desde: string, meses: number): string {
  const periodo = meses === 1 ? 'el último mes' : `los últimos ${meses} meses`;
  return `Solo se puede consultar desde el ${desde}, ${periodo}.`;
}

export class IaConsumoError extends Error {
  readonly status: number;
  readonly codigo: CodigoErrorIa;

  constructor(codigo: CodigoErrorIa, mensaje: string) {
    super(mensaje);
    this.name = 'IaConsumoError';
    this.codigo = codigo;
    this.status = ESTADO[codigo];
  }
}
