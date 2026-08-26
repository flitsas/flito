// Piezas comunes de las cuatro vistas de bolsas (HU #11127–#11130).
//
// Nada de umbrales ni de clasificación de riesgo vive aquí: eso es `nivelRiesgoDe` en shared-types,
// que es la misma función que usa la API para calcular el nivel que devuelve. Lo que sí es de la
// web es cómo se PINTA ese nivel, y eso es lo que hay en este archivo.

import toast from 'react-hot-toast';
import {
  NivelRiesgoBolsa, getOrganismoByCodigo, CLAVE_AGRUPACION_SIN_ASIGNAR, type SoporteFirmado,
} from '@operaciones/shared-types';
import { api, errorMessage } from './api';
import type { ChipTone } from '../components/flit/StatusChip';

/**
 * Roles que pueden ver una bolsa. Espeja el `requireRole('admin', 'financiera')` del router: sin
 * esto la página cargaría para un rol que va a recibir 403 en las seis peticiones, y el usuario
 * vería una pantalla de errores en vez de un «no tienes acceso».
 *
 * Auditoría queda fuera a propósito, a diferencia del resto de FLITO: el Feature es explícito en que
 * ningún otro rol accede a los movimientos crudos.
 */
export const ROLES_BOLSAS = ['admin', 'financiera'];

export function puedeVerBolsas(role: string | undefined): boolean {
  return role !== undefined && ROLES_BOLSAS.includes(role);
}

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
