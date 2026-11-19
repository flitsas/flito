import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../../lib/api';
import type { PendienteLt } from './tipos';

/** Carga la bandeja. Sin `habilitado` no hace NINGUNA petición. Refrescar con datos no vacía la lista. */
export function useLtPendientes(habilitado: boolean) {
  const [items, setItems] = useState<PendienteLt[] | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState(false);
  const seq = useRef(0);
  const recargar = useCallback(() => {
    if (!habilitado) return Promise.resolve();
    const mi = ++seq.current;
    setCargando(true); setError(false);
    return api.get<{ pendientes: PendienteLt[] }>('/flito/logistica/pendientes-tramite')
      .then((r) => { if (mi === seq.current) setItems(r.pendientes); })
      .catch(() => { if (mi === seq.current) setError(true); })
      .finally(() => { if (mi === seq.current) setCargando(false); });
  }, [habilitado]);
  useEffect(() => { void recargar(); }, [recargar]);
  return { items, cargando, error, recargar };
}
