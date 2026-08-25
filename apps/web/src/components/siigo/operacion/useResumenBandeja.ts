// `GET /siigo/bandeja/resumen` y `GET /siigo/freno`: dos consultas de apoyo con estado PROPIO.
//
// Tienen su propio estado, y eso es el AC2 bien entendido: si el resumen falla, la lista se pinta
// igual y son los KPIs los que muestran su error con su reintento. Colgar la pantalla entera de una
// consulta accesoria convertiría un contador que no cargó en un muro.

import { useCallback, useEffect, useState } from 'react';
import type { EstadoFrenoSiigo, SiigoBandejaResumen } from '@operaciones/shared-types';
import { api, errorMessage } from '../../../lib/api';

export interface ResumenBandeja {
  resumen: SiigoBandejaResumen | null;
  cargando: boolean;
  error: string | null;
  recargar: () => void;
}

export function useResumenBandeja(recargaExterna: number): ResumenBandeja {
  const [resumen, setResumen] = useState<SiigoBandejaResumen | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    let vivo = true;
    setCargando(true);
    setError(null);
    api.get<SiigoBandejaResumen>('/siigo/bandeja/resumen').then((r) => {
      if (!vivo) return;
      setResumen(r);
      setCargando(false);
    }).catch((e) => {
      if (!vivo) return;
      setError(errorMessage(e));
      setResumen(null);
      setCargando(false);
    });
    return () => { vivo = false; };
  }, [recarga, recargaExterna]);

  return { resumen, cargando, error, recargar: useCallback(() => setRecarga((n) => n + 1), []) };
}

/**
 * El freno por proporción de errores.
 *
 * **Si esta consulta falla, no se pinta el banner y no se inhabilita nada.** Un fallo al preguntar
 * por el freno no puede paralizar la operación: si de verdad está frenada, el `POST` devolverá 503
 * con su motivo y ahí se dice con la respuesta en la mano. Por eso este hook no expone `error`:
 * nadie tiene que decidir nada con él.
 */
export function useFrenoSiigo(recargaExterna: number): EstadoFrenoSiigo | null {
  const [freno, setFreno] = useState<EstadoFrenoSiigo | null>(null);

  useEffect(() => {
    let vivo = true;
    api.get<EstadoFrenoSiigo>('/siigo/freno')
      .then((f) => { if (vivo) setFreno(f); })
      .catch(() => { if (vivo) setFreno(null); });
    return () => { vivo = false; };
  }, [recargaExterna]);

  return freno;
}
