// Datos compartidos de proveedores y su asignación a compañías (HU #14105).
//
// El API aún no entrega un listado unificado ni el conteo de compañías asignadas, así que la web une
// lo que SÍ expone: `proveedores-soat`, `proveedores-logistica` y `GET /flito/parametrizacion/companias`
// (que trae `proveedorLogisticaId` y `proveedorSoatSinTramiteId`). Si alguno de esos GET no se puede
// leer (función ausente), la asignación queda como «desconocida» y la pantalla no inventa avisos.

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';

export type TipoProveedor = 'SOAT' | 'LOGISTICA';

export interface Proveedor {
  id: string; tipo: TipoProveedor; nombre: string; activo: boolean;
  /** Solo SOAT. */
  estrategia: string | null; umbralOcr: number | null; slaHoras: number | null;
  /** Solo Logística. */
  nit: string | null; contacto: string | null; telefono: string | null;
}

export interface CompaniaAsignacion {
  id: number; nombre: string; activo: boolean; logisticaAutogestionable: boolean;
  proveedorLogisticaId: string | null; proveedorSoatSinTramiteId: string | null;
}

export const aProveedorSoat = (p: any): Proveedor => ({
  id: String(p.id), tipo: 'SOAT', nombre: p.nombre, activo: !!p.activo,
  estrategia: p.estrategia ?? null, umbralOcr: p.umbralOcr ?? null, slaHoras: p.slaHoras ?? null,
  nit: null, contacto: null, telefono: null,
});
export const aProveedorLogistica = (p: any): Proveedor => ({
  id: String(p.id), tipo: 'LOGISTICA', nombre: p.nombre, activo: !!p.activo,
  estrategia: null, umbralOcr: null, slaHoras: null,
  nit: p.nit ?? null, contacto: p.contacto ?? null, telefono: p.telefono ?? null,
});

export const RUTA_SOAT = '/flito/parametrizacion/proveedores-soat';
export const RUTA_LOGISTICA = '/flito/parametrizacion/proveedores-logistica';
export const rutaProveedor = (p: Pick<Proveedor, 'tipo'>) => (p.tipo === 'LOGISTICA' ? RUTA_LOGISTICA : RUTA_SOAT);

export async function cargarProveedores(): Promise<Proveedor[]> {
  const [soat, logistica] = await Promise.all([
    api.get<any[]>(RUTA_SOAT), api.get<any[]>(RUTA_LOGISTICA),
  ]);
  return [...soat.map(aProveedorSoat), ...logistica.map(aProveedorLogistica)]
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

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

/**
 * Compañías con su proveedor asignado. `null` = no se pudo leer (sin la función, o falló): la
 * asignación es desconocida y no se marca nada. Se recarga con `recargar`.
 */
export function useCompaniasAsignacion() {
  const [data, setData] = useState<CompaniaAsignacion[] | null>(null);
  const [recarga, setRecarga] = useState(0);
  useEffect(() => {
    let vivo = true;
    api.get<any[]>('/flito/parametrizacion/companias')
      .then((f) => {
        if (!vivo) return;
        setData(f.map((c) => ({
          id: Number(c.id), nombre: String(c.nombre), activo: c.activo !== false,
          logisticaAutogestionable: !!c.logisticaAutogestionable,
          proveedorLogisticaId: c.proveedorLogisticaId ?? null,
          proveedorSoatSinTramiteId: c.proveedorSoatSinTramiteId ?? null,
        })));
      })
      .catch(() => { if (vivo) setData(null); });
    return () => { vivo = false; };
  }, [recarga]);
  return { data, recargar: useCallback(() => setRecarga((n) => n + 1), []) };
}

/** Compañías asignadas a un proveedor (incluye las de logística apagada que lo conservan). */
export function companiasDe(p: Proveedor, companias: CompaniaAsignacion[] | null): CompaniaAsignacion[] | null {
  if (!companias) return null;
  return companias.filter((c) => (p.tipo === 'LOGISTICA' ? c.proveedorLogisticaId : c.proveedorSoatSinTramiteId) === p.id);
}

const plural = (n: number) => `${n} ${n === 1 ? 'compañía' : 'compañías'}`;

/** «Compañía A, B y C y 2 más» (hasta 3 nombres). */
export function nombresResumidos(nombres: string[]): string {
  const ver = nombres.slice(0, 3).join(', ');
  return nombres.length > 3 ? `${ver} y ${nombres.length - 3} más` : ver;
}

/** Copy del bloqueo de baja (AC6). */
export function textoBajaBloqueada(nombre: string, nombres: string[]): string {
  return `No se puede inactivar a ${nombre}: está asignado a ${plural(nombres.length)} (${nombresResumidos(nombres)}). Asigne otro proveedor a esas compañías y vuelva a intentarlo.`;
}
