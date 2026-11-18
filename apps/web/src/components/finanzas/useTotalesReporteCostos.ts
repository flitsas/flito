// Los totales del reporte de costos, aparte del listado (Épica #14560). El agregado del costo de
// proveedor tarda decenas de segundos sobre el universo filtrado y no cambia al paginar, así que el
// API lo sirve en `GET /finanzas/reporte-costos/totales` y la tabla se pide con `sinTotales=1`: la
// tabla se pinta en cuanto llega su página y el pie tiene su propio estado (cargando, error con
// reintento, lleno). El vacío no existe aquí: sin trámites no hay tabla ni pie.
//
// Se vuelve a pedir SOLO cuando cambia la consulta (filtros, etapa, estado de facturación) o la
// página pide recargar tras una acción que mueve cifras (liquidar, reversar, aceptar diferencia);
// nunca al paginar, porque `consulta` no lleva `page`. Una respuesta que llega con la consulta ya
// cambiada se descarta por número de petición: `api.ts` no recibe un `AbortSignal` externo.

import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import type { TotalesReporte } from './tiposReporteCostos';

export type EstadoTotales =
  | { fase: 'cargando' }
  | { fase: 'error' }
  | { fase: 'lleno'; datos: TotalesReporte };

const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const esTotales = (v: unknown): v is TotalesReporte =>
  esObjeto(v) && esObjeto(v.totales) && esObjeto(v.totalesCostosProveedor);

export function useTotalesReporteCostos(consulta: string, recarga: number) {
  const [estado, setEstado] = useState<EstadoTotales>({ fase: 'cargando' });
  const [intento, setIntento] = useState(0);
  const ultima = useRef(0);
  /** La última consulta lanzada: el doble efecto de StrictMode no repite una agregación de ~20 s. */
  const lanzada = useRef('');

  useEffect(() => {
    const clave = `${consulta}|${recarga}|${intento}`;
    if (clave === lanzada.current) return;
    lanzada.current = clave;
    const id = ++ultima.current;
    setEstado({ fase: 'cargando' });
    api.get<TotalesReporte>(`/finanzas/reporte-costos/totales?${consulta}`)
      // Una respuesta sin las dos claves (un proxy, un HTML, un `[]`) es un fallo, no un pie vacío:
      // pintarla tumbaría la tabla entera al leer `totales.filasIncompletas`.
      .then((datos) => {
        if (id !== ultima.current) return;
        setEstado(esTotales(datos) ? { fase: 'lleno', datos } : { fase: 'error' });
      })
      // Nunca el error crudo del API: el pie dice qué pasó y ofrece reintentar.
      .catch(() => { if (id === ultima.current) setEstado({ fase: 'error' }); });
  }, [consulta, recarga, intento]);

  return { estado, reintentar: () => setIntento((n) => n + 1) };
}
