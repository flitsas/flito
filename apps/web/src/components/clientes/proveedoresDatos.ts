// Datos compartidos de proveedores y su asignación a compañías.
//
// HU #14336 y #14337 (ADR-0039 §7.1): la gestión habla con `/flito/parametrizacion/proveedores`, que entrega una identidad
// por proveedor con sus servicios. El servidor cuenta las compañías y los bloqueos; la web no cruza catálogos.
// HU #14342 y #14344 (ADR-0039 §7.1 y §14): los selectores de asignación piden `/proveedores/selector?servicio=`, que
// entrega solo los activos con ese servicio. Por eso aquí no hay filtro de inactivos ni cruce de catálogos.

import { useCallback, useEffect, useState } from 'react';
import {
  SERVICIOS_PROVEEDOR, SERVICIO_PROVEEDOR_LABEL,
  type ImpactoProveedorDto, type ProveedorDetalleDto, type ProveedorListaItemDto, type ProveedorSelectorItemDto, type ServicioProveedor,
} from '@operaciones/shared-types';
import { api } from '../../lib/api';

export const RUTA_UNIFICADA = '/flito/parametrizacion/proveedores';

/**
 * Fila de un selector de asignación. El API solo devuelve activos y sin `activo`; se marca aquí para que
 * `opcionesConEstado` los trate igual que a un asignado inactivo que la pantalla agrega aparte.
 */
export interface ProveedorOfrecido extends ProveedorSelectorItemDto { activo: boolean }

/** Listado de gestión: sin teléfono, correo, dirección ni contacto. */
export const cargarProveedores = () => api.get<ProveedorListaItemDto[]>(RUTA_UNIFICADA);

/** Detalle con datos personales: solo se pide al abrir editar o ver detalle. */
export const cargarDetalleProveedor = (id: string) => api.get<ProveedorDetalleDto>(`${RUTA_UNIFICADA}/${id}`);

/** Lo que bloquea o afecta la baja. Exige `parametrizacion.proveedores.estado`. */
export const cargarImpactoProveedor = (id: string) => api.get<ImpactoProveedorDto>(`${RUTA_UNIFICADA}/${id}/impacto`);

/** Los servicios que presta, siempre en el mismo orden: SOAT y luego Logística. */
export const serviciosEnOrden = (s: readonly ServicioProveedor[]) => SERVICIOS_PROVEEDOR.filter((x) => s.includes(x));

const plural = (n: number) => `${n} ${n === 1 ? 'compañía' : 'compañías'}`;

/** Umbral con coma decimal, «0,85»; «—» si el proveedor no lo tiene. */
export const textoUmbral = (v: number | null | undefined) =>
  (v == null ? '—' : v.toLocaleString('es-CO', { minimumFractionDigits: 2 }));

/** Celda de la lista: con un servicio, el número; con dos, «2 SOAT · 3 Logística». No se suman: una compañía puede contar doble. */
export function textoCompanias(p: Pick<ProveedorListaItemDto, 'servicios' | 'companiasPorServicio'>): string {
  const servicios = serviciosEnOrden(p.servicios);
  if (servicios.length === 1) return String(p.companiasPorServicio[servicios[0]!] ?? 0);
  return servicios.map((s) => `${p.companiasPorServicio[s] ?? 0} ${SERVICIO_PROVEEDOR_LABEL[s]}`).join(' · ');
}

/** Línea de edición y detalle: explica de antemano por qué podría bloquearse quitar un servicio. */
export function textoCompaniasAsignadas(p: Pick<ProveedorListaItemDto, 'servicios' | 'companiasPorServicio'>): string {
  const servicios = serviciosEnOrden(p.servicios);
  const total = servicios.reduce((n, s) => n + (p.companiasPorServicio[s] ?? 0), 0);
  if (total === 0) return 'Sin compañías asignadas.';
  if (servicios.length > 1) return `Asignado a ${textoCompanias(p)}.`;
  return `Asignado a ${plural(total)}.`;
}

/**
 * Frase de impacto del diálogo de baja, con lo que trae el servidor. Con bloqueos en un servicio: «2 compañías asignadas,
 * 3 SOAT en curso.». En los dos, rotulada, porque las cantidades no se suman.
 */
export function fraseImpacto(i: Pick<ImpactoProveedorDto, 'bloqueosPorServicio'>): string {
  const conBloqueos = SERVICIOS_PROVEEDOR.filter((s) => (i.bloqueosPorServicio[s]?.length ?? 0) > 0);
  const lista = (s: ServicioProveedor) => (i.bloqueosPorServicio[s] ?? []).map((b) => b.texto).join(', ');
  if (conBloqueos.length === 0) return 'No tiene procesos en curso.';
  if (conBloqueos.length === 1) return `${lista(conBloqueos[0]!)}.`;
  return conBloqueos.map((s) => `${SERVICIO_PROVEEDOR_LABEL[s]}: ${lista(s)}.`).join(' ');
}

/**
 * Proveedores activos que prestan un servicio: cuatro estados + reintento. `refresco` vuelve a pedir el
 * catálogo cuando la página recarga sus datos. Con `habilitado: false` se queda en cargando: quien lo apaga no pinta el selector.
 */
export function useProveedoresSelector(servicio: ServicioProveedor, habilitado = true, refresco = 0) {
  const [data, setData] = useState<ProveedorOfrecido[] | null>(null);
  const [error, setError] = useState(false);
  const [recarga, setRecarga] = useState(0);
  useEffect(() => {
    if (!habilitado) return;
    let vivo = true;
    setData(null); setError(false);
    api.get<ProveedorSelectorItemDto[]>(`${RUTA_UNIFICADA}/selector?servicio=${servicio}`)
      .then((f) => { if (vivo) setData(f.map((p) => ({ ...p, activo: true }))); })
      .catch(() => { if (vivo) setError(true); });
    return () => { vivo = false; };
  }, [servicio, habilitado, refresco, recarga]);
  return { data, error, recargar: useCallback(() => setRecarga((n) => n + 1), []) };
}

export type CatalogoSelector = ReturnType<typeof useProveedoresSelector>;

const SOAT_CARGANDO = 'Cargando proveedores…';
const SOAT_ERROR = 'No se pudieron cargar los proveedores.';
const SOAT_VACIO = 'No hay proveedores de SOAT activos.';
export const SOAT_REINTENTO = 'Volver a cargar proveedores';

/** Lo que dice el selector de envío de SOAT cuando no hay nada que elegir; `null` si hay opciones. */
export function mensajeSelectorSoat({ data, error }: Pick<CatalogoSelector, 'data' | 'error'>): string | null {
  if (error) return SOAT_ERROR;
  if (data === null) return SOAT_CARGANDO;
  return data.length === 0 ? SOAT_VACIO : null;
}
