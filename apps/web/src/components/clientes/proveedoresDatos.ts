// Datos compartidos de proveedores y su asignación a compañías (HU #14105).
//
// HU #14162: el servidor entrega el listado unificado con el conteo de compañías asignadas
// (`GET /flito/parametrizacion/proveedores`) y el impacto de la baja de un proveedor de logística
// (`.../proveedores-logistica/:id/impacto`). La web ya no cruza catálogos ni cuenta en el cliente.

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';

export type TipoProveedor = 'SOAT' | 'LOGISTICA';

export interface Proveedor {
  id: string; tipo: TipoProveedor; nombre: string; activo: boolean;
  /** Solo SOAT. */
  estrategia: string | null; umbralOcr: number | null; slaHoras: number | null;
  /** Solo Logística. */
  nit: string | null; contacto: string | null; telefono: string | null;
  /** Compañías vigentes asignadas (lo cuenta el servidor). */
  companiasAsignadas: number;
}

export const aProveedorSoat = (p: any): Proveedor => ({
  id: String(p.id), tipo: 'SOAT', nombre: p.nombre, activo: !!p.activo,
  estrategia: p.estrategia ?? null, umbralOcr: p.umbralOcr ?? null, slaHoras: p.slaHoras ?? null,
  nit: null, contacto: null, telefono: null, companiasAsignadas: Number(p.companiasAsignadas ?? 0),
});
export const aProveedorLogistica = (p: any): Proveedor => ({
  id: String(p.id), tipo: 'LOGISTICA', nombre: p.nombre, activo: !!p.activo,
  estrategia: null, umbralOcr: null, slaHoras: null,
  nit: p.nit ?? null, contacto: p.contacto ?? null, telefono: p.telefono ?? null,
  companiasAsignadas: Number(p.companiasAsignadas ?? 0),
});

export const RUTA_SOAT = '/flito/parametrizacion/proveedores-soat';
export const RUTA_LOGISTICA = '/flito/parametrizacion/proveedores-logistica';
export const rutaProveedor = (p: Pick<Proveedor, 'tipo'>) => (p.tipo === 'LOGISTICA' ? RUTA_LOGISTICA : RUTA_SOAT);

export const RUTA_UNIFICADA = '/flito/parametrizacion/proveedores';

/** Listado unificado SOAT + Logística, ya ordenado por nombre y con `companiasAsignadas`. */
export async function cargarProveedores(): Promise<Proveedor[]> {
  const f = await api.get<any[]>(RUTA_UNIFICADA);
  return f.map((p) => (p.tipo === 'logistica' ? aProveedorLogistica(p) : aProveedorSoat(p)));
}

/** SOAT: estrategia, umbral OCR y ANS no vienen en el listado unificado; se piden al abrir editar/detalle. */
export async function completarSoat(p: Proveedor): Promise<Proveedor> {
  if (p.tipo !== 'SOAT') return p;
  const f = await api.get<any[]>(RUTA_SOAT);
  const d = f.find((x) => String(x.id) === p.id);
  return d ? { ...aProveedorSoat(d), companiasAsignadas: p.companiasAsignadas } : p;
}

/** Impacto de la baja de un proveedor de logística: total de compañías vigentes y hasta 3 nombres. */
export interface ImpactoLogistica { companias: number; nombres: string[] }
export const cargarImpactoLogistica = (id: string) => api.get<ImpactoLogistica>(`${RUTA_LOGISTICA}/${id}/impacto`);

/** Solo proveedores de logística (selector de la compañía): cuatro estados + reintento. */
export function useProveedoresLogistica(habilitado = true) {
  const [data, setData] = useState<Proveedor[] | null>(null);
  const [error, setError] = useState(false);
  const [recarga, setRecarga] = useState(0);
  useEffect(() => {
    if (!habilitado) return;
    let vivo = true;
    setData(null); setError(false);
    api.get<any[]>(RUTA_LOGISTICA)
      .then((f) => { if (vivo) setData(f.map(aProveedorLogistica)); })
      .catch(() => { if (vivo) setError(true); });
    return () => { vivo = false; };
  }, [habilitado, recarga]);
  return { data, error, recargar: useCallback(() => setRecarga((n) => n + 1), []) };
}

const plural = (n: number) => `${n} ${n === 1 ? 'compañía' : 'compañías'}`;

/** «A, B, C y 2 más»: hasta 3 nombres; `total` es el de compañías (puede superar los nombres entregados). */
export function nombresResumidos(nombres: string[], total = nombres.length): string {
  const ver = nombres.slice(0, 3).join(', ');
  return total > 3 ? `${ver} y ${total - 3} más` : ver;
}

/** Copy del bloqueo de baja (AC6). */
export function textoBajaBloqueada(nombre: string, total: number, nombres: string[]): string {
  return `No se puede inactivar a ${nombre}: está asignado a ${plural(total)} (${nombresResumidos(nombres, total)}). Asigne otro proveedor a esas compañías y vuelva a intentarlo.`;
}
