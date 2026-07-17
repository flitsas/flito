import { useState, useEffect, useCallback, useRef } from 'react';
import { api, errorMessage } from '../../lib/api';
import toast from 'react-hot-toast';
import type { RangoFechas } from '../../lib/dateColombia';

export interface TramitesListParams {
  search?: string;
  /** Etapa del embudo (borrador, en_preparacion, …) — mismo criterio que columnas kanban. */
  etapa?: string;
  /** TRAM-TRASPASO-F4: filtrar por modalidad de entrada. */
  modalidadEntrada?: '' | 'matricula_inicial' | 'traspaso';
  /** Rango de ingreso (created_at, zona Colombia). null = sin filtro. */
  rango?: RangoFechas | null;
  page?: number;
  pageSize?: number;
  enabled?: boolean;
}

const DEFAULT_PAGE_SIZE = 25;

export function useTramites<T>(params: TramitesListParams = {}) {
  const {
    search = '',
    etapa = '',
    modalidadEntrada = '',
    rango = null,
    page = 1,
    pageSize = DEFAULT_PAGE_SIZE,
    enabled = true,
  } = params;

  const [tramites, setTramites] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef(0);

  const load = useCallback(async () => {
    if (!enabled) return;
    const reqId = ++reqRef.current;
    setLoading(true);
    setError(null);
    try {
      const limit = Math.min(Math.max(1, pageSize), 200);
      const offset = Math.max(0, (page - 1) * limit);
      const q = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (search.trim()) q.set('search', search.trim().slice(0, 100));
      if (etapa) q.set('etapa', etapa);
      if (modalidadEntrada) q.set('modalidadEntrada', modalidadEntrada);
      if (rango) {
        q.set('desde', rango.desde);
        q.set('hasta', rango.hasta);
      }
      const res = await api.get<{ items: T[]; total: number; limit: number; offset: number }>(`/tramites?${q}`);
      if (reqId !== reqRef.current) return;
      setTramites(res.items);
      setTotal(res.total);
      setHasMore(res.offset + res.items.length < res.total);
    } catch (e) {
      if (reqId !== reqRef.current) return;
      const msg = errorMessage(e);
      setError(msg);
      setTramites([]);
      setTotal(0);
      setHasMore(false);
      toast.error(msg);
    } finally {
      if (reqId === reqRef.current) setLoading(false);
    }
  }, [enabled, search, etapa, modalidadEntrada, rango, page, pageSize]);

  useEffect(() => { load(); }, [load]);

  return { tramites, total, loading, hasMore, error, page, pageSize, load };
}
