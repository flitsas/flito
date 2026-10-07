// FLITO — estado de la lista de documentos adicionales del detalle SOAT (HU #13363 + #13365).
//
// Vive arriba (en `DocumentosAdicionalesSeccion`) porque la carga y la eliminación de la HU #13365
// cambian la lista sin pasar por el esqueleto: `refrescar` relee en silencio (la lista vieja sigue
// visible hasta que llega la nueva, spec §3.4) y `quitar` saca una fila del estado local tras el 204.
import { useCallback, useEffect, useState } from 'react';
import type { DocumentoAdicionalSoat } from '@operaciones/shared-types';
import { api } from '../../../lib/api';

export type EstadoListaAdicionales =
  | { fase: 'cargando' }
  | { fase: 'error' }
  | { fase: 'lista'; documentos: DocumentoAdicionalSoat[] };

export interface ListaAdicionales {
  estado: EstadoListaAdicionales;
  /** Relee con esqueleto (primera carga, «Reintentar» del error, URL firmada caducada). */
  cargar: () => Promise<DocumentoAdicionalSoat[] | null>;
  /** Relee sin esqueleto. Si falla, la lista queda como estaba y devuelve `false`. */
  refrescar: () => Promise<boolean>;
  /** Saca una fila del estado local (204 / 404 del DELETE). */
  quitar: (id: string) => void;
}

async function leer(soatId: string): Promise<DocumentoAdicionalSoat[]> {
  const r = await api.get<{ documentos: DocumentoAdicionalSoat[] }>(
    `/flito/soat/${encodeURIComponent(soatId)}/documentos-adicionales`,
  );
  // Un cuerpo sin la lista (API por detrás del bundle) se pinta como vacío, no como fallo.
  return Array.isArray(r?.documentos) ? r.documentos : [];
}

export function useDocumentosAdicionales(soatId: string): ListaAdicionales {
  const [estado, setEstado] = useState<EstadoListaAdicionales>({ fase: 'cargando' });

  const cargar = useCallback(async () => {
    setEstado({ fase: 'cargando' });
    try {
      const documentos = await leer(soatId);
      setEstado({ fase: 'lista', documentos });
      return documentos;
    } catch {
      setEstado({ fase: 'error' });
      return null;
    }
  }, [soatId]);

  const refrescar = useCallback(async () => {
    try {
      const documentos = await leer(soatId);
      setEstado({ fase: 'lista', documentos });
      return true;
    } catch {
      return false;
    }
  }, [soatId]);

  const quitar = useCallback((id: string) => {
    setEstado((e) => (e.fase === 'lista' ? { fase: 'lista', documentos: e.documentos.filter((d) => d.id !== id) } : e));
  }, []);

  useEffect(() => { void cargar(); }, [cargar]);

  return { estado, cargar, refrescar, quitar };
}
