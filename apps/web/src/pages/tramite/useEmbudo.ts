// TRAM-OPS-01 — hook embudo (Claude puede importar en TramitesEmbudo.tsx).

import { useCallback, useState } from 'react';
import { api } from '../../lib/api';
import type { RangoFechas } from '../../lib/dateColombia';
import type { TramiteEmbudoCardData } from './TramiteEmbudoCard';

export interface EmbudoColumna {
  id: string;
  label: string;
  count: number;
  tramites: TramiteEmbudoCardData[];
}

export interface EmbudoResponse {
  columnas: EmbudoColumna[];
}

export function useEmbudo(limit = 50, rango: RangoFechas | null = null, modalidadEntrada: '' | 'matricula_inicial' | 'traspaso' = '') {
  const [columnas, setColumnas] = useState<EmbudoColumna[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams({ limit: String(limit) });
      if (rango) {
        q.set('desde', rango.desde);
        q.set('hasta', rango.hasta);
      }
      if (modalidadEntrada) q.set('modalidadEntrada', modalidadEntrada);
      const res = await api.get<EmbudoResponse>(`/tramites/embudo?${q}`);
      setColumnas(res.columnas ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cargar el embudo');
      setColumnas([]);
    } finally { setLoading(false); }
  }, [limit, rango, modalidadEntrada]);

  return { columnas, loading, error, load };
}
