// Piezas comunes de las cuatro vistas de bolsas (HU #11127–#11130).
//
// Nada de umbrales ni de clasificación de riesgo vive aquí: eso es `nivelRiesgoDe` en shared-types,
// que es la misma función que usa la API para calcular el nivel que devuelve. Lo que sí es de la
// web es cómo se PINTA ese nivel, y eso es lo que hay en este archivo.

import toast from 'react-hot-toast';
import {
  NivelRiesgoBolsa, getOrganismoByCodigo, CLAVE_AGRUPACION_SIN_ASIGNAR, CONCEPTO_BOLSA_LABEL,
  CONCEPTO_BOLSA_TRANSITO_LABEL,
  type ConceptoBolsa, type ConceptoBolsaTransito, type NivelBolsaTransito, type ParCoberturaOcupada,
  type SoporteFirmado,
} from '@operaciones/shared-types';
import { ApiError, api, errorMessage } from './api';
import type { ChipTone } from '../components/flit/StatusChip';


/**
 * El color del riesgo. `sin_recargas` es NEUTRO y no de alarma: un cliente que aún no ha recibido su
 * primera recarga no tiene un problema de saldo, y pintarlo en rojo mandaría a Financiera a atender
 * clientes que no han empezado a operar.
 */
export const TONO_NIVEL: Record<NivelRiesgoBolsa, ChipTone> = {
  normal: 'success',
  bajo: 'warning',
  critico: 'danger',
  agotada: 'danger',
  sin_recargas: 'neutral',
};

export const pesos = (n: number): string =>
  n.toLocaleString('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });

/** Un valor con su signo explícito. En un libro contable, «+» y «−» se leen antes que el color. */
export const pesosConSigno = (n: number, entrada: boolean): string =>
  `${entrada ? '+' : '−'} ${pesos(Math.abs(n))}`;

/**
 * Fecha 'YYYY-MM-DD' sin pasar por `new Date`.
 *
 * `new Date('2026-07-23')` es medianoche UTC y, renderizada en Colombia (UTC−5), retrocede un día:
 * el mismo fallo que ya costó una corrección en la tabla de derechos.
 */
export const fechaDia = (v: string | null): string => {
  if (!v) return '—';
  const [y, m, d] = v.slice(0, 10).split('-');
  return `${Number(d)}/${Number(m)}/${y}`;
};

/** Instante completo (columna timestamp). Aquí sí hay hora que convertir. */
export const fechaHora = (v: string | null): string =>
  (v ? new Date(v).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' }) : '—');

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** '2026-07' → 'julio de 2026'. */
export function etiquetaPeriodo(periodo: string): string {
  const [y, m] = periodo.split('-').map(Number);
  const nombre = MESES[m - 1];
  return nombre ? `${nombre} de ${y}` : periodo;
}

/** Periodo contable en curso, en hora de Colombia. */
export function periodoActual(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit' })
    .format(new Date())
    .slice(0, 7);
}

/** Los últimos `n` periodos, del más reciente al más antiguo. Alimenta el selector de periodo. */
export function ultimosPeriodos(n: number): string[] {
  const [y0, m0] = periodoActual().split('-').map(Number);
  return Array.from({ length: n }, (_, i) => {
    const total = y0 * 12 + (m0 - 1) - i;
    return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
  });
}

/** Hoy en Colombia como 'YYYY-MM-DD', para el valor por defecto de los formularios. */
export function hoyColombia(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
}

/**
 * Nombre del organismo. Los desgloses vienen por código DANE, que no dice nada a quien concilia.
 * `sin_asignar` no es un código roto: son las recargas y los honorarios de FLIT, que no tienen OT.
 */
export function etiquetaOrganismo(codigo: string): string {
  if (codigo === CLAVE_AGRUPACION_SIN_ASIGNAR) return 'Sin organismo';
  return getOrganismoByCodigo(codigo)?.ciudad ?? codigo;
}

/**
 * Abre el comprobante en una pestaña nueva. La URL viene firmada y caduca.
 *
 * Ruta propia del módulo y no la de derechos: aquella está abierta a `admin` y `auditor`, y aquí
 * quien abre el soporte es `financiera`. Compartirla habría obligado a ensanchar sus roles y le
 * habría dado a auditoría los comprobantes de las bolsas, que el Feature reserva a Administración
 * y Financiera.
 */
export async function abrirSoporteBolsa(soporteId: string): Promise<void> {
  try {
    const { url } = await api.get<SoporteFirmado>(`/flito/bolsas/soportes/${soporteId}`);
    window.open(url, '_blank', 'noopener');
  } catch (e) {
    toast.error(errorMessage(e));
  }
}

/**
 * Descarga un CSV generado en el navegador.
 *
 * Se arma aquí y no en el servidor porque los filtros de la tabla —rango de fechas, OT, concepto—
 * se aplican sobre los movimientos ya cargados: pedirle al backend que los repita significaría
 * inventarse un endpoint de exportación que no existe, y arriesgarse a que el archivo no contenga
 * exactamente lo que se está viendo.
 *
 * BOM + `;` + CRLF, las mismas convenciones del export del reporte de costos: sin ellas Excel en
 * español mete todas las columnas en una y se come las tildes.
 */
export function descargarCsv(nombre: string, cabeceras: string[], filas: string[][]): void {
  const celda = (v: string): string => (/[";\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const texto = `﻿${[cabeceras, ...filas].map((f) => f.map(celda).join(';')).join('\r\n')}\r\n`;
  const url = URL.createObjectURL(new Blob([texto], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Catálogo de bolsas (HU #13901) ──────────────────────────────────────────────

/** Una compañía de `/clients`, lo único que el formulario necesita de ella. */
export interface ClienteOpcion {
  id: number;
  name: string;
}

/**
 * Código de negocio y datos extra de un error del API de bolsas (`{ error, codigo, ...datos }`).
 *
 * La pantalla decide el copy por el `codigo`, nunca enseña `error` tal cual: el texto del servidor
 * está escrito para el log, no para quien opera.
 */
export function errorBolsa(e: unknown): { status: number | null; codigo: string | null; datos: Record<string, unknown> } {
  if (e instanceof ApiError) {
    const datos = (e.rawDetails && typeof e.rawDetails === 'object' ? e.rawDetails : {}) as Record<string, unknown>;
    return { status: e.status, codigo: typeof datos.codigo === 'string' ? datos.codigo : null, datos };
  }
  return { status: null, codigo: null, datos: {} };
}

/** Cómo se nombra cada concepto autogestionable dentro del aviso («gestiona su SOAT…»). */
const SU_CONCEPTO: Partial<Record<ConceptoBolsa, string>> = {
  soat: 'su SOAT',
  impuesto: 'sus impuestos',
  logistica: 'su logística',
};

const unirConY = (partes: string[]): string =>
  (partes.length <= 1 ? partes.join('') : `${partes.slice(0, -1).join(', ')} y ${partes[partes.length - 1]}`);

/**
 * Aviso de autogestión (AC10, D15). `null` si no hay nada que avisar.
 * Uno: «…su SOAT por su cuenta: no llegarán movimientos a la bolsa salvo excepciones.»
 * Varios: «…su SOAT y su logística por su cuenta: no llegarán movimientos a la bolsa por esos conceptos salvo excepciones.»
 */
export function avisoAutogestion(conceptos: readonly ConceptoBolsa[]): string | null {
  if (conceptos.length === 0) return null;
  const nombres = conceptos.map((c) => SU_CONCEPTO[c] ?? `su ${CONCEPTO_BOLSA_LABEL[c]}`);
  return conceptos.length === 1
    ? `Esta compañía gestiona ${nombres[0]} por su cuenta: no llegarán movimientos a la bolsa salvo excepciones.`
    : `Esta compañía gestiona ${unirConY(nombres)} por su cuenta: no llegarán movimientos a la bolsa por esos conceptos salvo excepciones.`;
}

/** Longitud mínima del motivo de inactivar / reactivar (AC5, mismo umbral que el API). */
export const MOTIVO_MINIMO = 5;

// ── Bolsa de tránsito en el catálogo único (HU #13908) ──────────────────────────

/**
 * Tono del nivel de una bolsa de TRÁNSITO (su escala, con «En préstamo»). `sin_cargas` es borrador:
 * no es una alarma, es una bolsa que todavía no ha empezado a operar.
 */
export const TONO_NIVEL_TRANSITO: Record<NivelBolsaTransito, ChipTone> = {
  normal: 'success',
  bajo: 'warning',
  critico: 'danger',
  agotada: 'danger',
  en_prestamo: 'danger',
  sin_cargas: 'draft',
};

/** Saldo con «−» escrito: en préstamo el signo se lee antes que el color. */
export const saldoConSigno = (n: number): string => (n < 0 ? `− ${pesos(Math.abs(n))}` : pesos(n));

/** Nombre visible de una secretaría por su código DIVIPOLA (nunca el código solo si hay catálogo). */
export function nombreSecretaria(codigo: string): string {
  const o = getOrganismoByCodigo(codigo);
  return o ? `${o.ciudad} — ${o.nombre}` : codigo;
}

/** Pares del 409 `cobertura_ocupada` (alta, edición o reactivación). `[]` si el cuerpo no los trae. */
export function paresOcupados(datos: Record<string, unknown>): ParCoberturaOcupada[] {
  const pares = Array.isArray(datos.pares) ? datos.pares : [];
  return pares.filter((p): p is ParCoberturaOcupada =>
    !!p && typeof p === 'object'
    && typeof (p as ParCoberturaOcupada).organismoCodigo === 'string'
    && typeof (p as ParCoberturaOcupada).concepto === 'string'
    && typeof (p as ParCoberturaOcupada).bolsaNombre === 'string');
}

/** Rótulo de un cobro de tránsito; el valor crudo solo si llega uno que la web no conoce. */
export function cobroTransito(concepto: string): string {
  return CONCEPTO_BOLSA_TRANSITO_LABEL[concepto as ConceptoBolsaTransito] ?? concepto;
}

/**
 * Aviso de autogestión de impuestos en tránsito (AC9 de la HU #13908). `null` si no hay nada que avisar.
 * Conserva literal el texto del AC desde «este organismo es autogestionado…».
 */
export function avisoAutogestionTransito(secretarias: string[]): string | null {
  const unicas = [...new Set(secretarias)];
  if (unicas.length === 0) return null;
  if (unicas.length === 1) {
    return `${unicas[0]}: este organismo es autogestionado para impuestos: no llegarán movimientos de impuesto a la bolsa salvo excepciones.`;
  }
  return `Estos organismos son autogestionados para impuestos: ${unicas.join(', ')}. No llegarán movimientos de impuesto a la bolsa salvo excepciones.`;
}
