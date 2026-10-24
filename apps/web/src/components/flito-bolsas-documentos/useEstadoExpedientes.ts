// Estado del expediente documental de las compañías del listado de bolsas (HU #13893, Feature #13888).
// Spec `docs/ux/flito-bolsas-expediente-documental.md` (Pantalla 2): UNA carga por listado, no una
// petición por fila. Si hay más de `TOPE_ESTADO_LOTE_BOLSAS` compañías se parte en trozos de ese tope.
// El lote no bloquea la tabla: la tabla se pinta y las celdas esperan.

import { useCallback, useEffect, useState } from 'react';
import { TOPE_ESTADO_LOTE_BOLSAS, type EstadoExpedienteLoteDto } from '@operaciones/shared-types';
import { bolsasDocumentosApi } from '../../lib/api';
import { errorBolsa } from '../../lib/bolsas';

export type EstadoLoteExpedientes =
  | { fase: 'inactivo' }
  | { fase: 'cargando' }
  | { fase: 'error' }
  /** 403 aunque el front creía tener `bolsas.documentos.ver`: la columna se oculta (AC7). */
  | { fase: 'sin-permiso' }
  | { fase: 'listo'; porCompania: ReadonlyMap<number, EstadoExpedienteLoteDto> };

function trozos(ids: number[]): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < ids.length; i += TOPE_ESTADO_LOTE_BOLSAS) out.push(ids.slice(i, i + TOPE_ESTADO_LOTE_BOLSAS));
  return out;
}

/**
 * `companiaIds` cambia de identidad cada vez que el listado se relee (búsqueda, filtro, `nonce`):
 * con eso se vuelve a pedir el lote. Repetidos y nulos se descartan aquí (el API rechaza repetidos).
 */
export function useEstadoExpedientes(companiaIds: readonly (number | null)[] | null, habilitado: boolean) {
  const [estado, setEstado] = useState<EstadoLoteExpedientes>({ fase: 'inactivo' });
  const [reintento, setReintento] = useState(0);

  useEffect(() => {
    const ids = [...new Set((companiaIds ?? []).filter((id): id is number => typeof id === 'number'))];
    if (!habilitado || ids.length === 0) {
      setEstado({ fase: 'inactivo' });
      return;
    }
    let vigente = true;
    setEstado({ fase: 'cargando' });
    Promise.all(trozos(ids).map((companias) => bolsasDocumentosApi.estadoLote({ companiaIds: companias })))
      .then((respuestas) => {
        if (!vigente) return;
        const porCompania = new Map<number, EstadoExpedienteLoteDto>();
        for (const r of respuestas) for (const e of r.estados) porCompania.set(e.companiaId, e);
        setEstado({ fase: 'listo', porCompania });
      })
      .catch((e: unknown) => {
        if (!vigente) return;
        setEstado(errorBolsa(e).status === 403 ? { fase: 'sin-permiso' } : { fase: 'error' });
      });
    return () => { vigente = false; };
  }, [companiaIds, habilitado, reintento]);

  const reintentar = useCallback(() => setReintento((n) => n + 1), []);
  return { estado, reintentar };
}
