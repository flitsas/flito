// HU #12827 (ampliación de la sesión de evidencias en DEV): el semáforo nuevo aparece solo.
//
// Tras «Reintentar validación» o tras enviar al gestor, las filas quedan en `analisisEstado =
// 'en_curso'` y el resultado lo escribe un job del API. Antes había que recargar la página para
// verlo. Este hook vuelve a pedir en segundo plano LA MISMA página de la cola (mismos filtros y
// página, vía `pedirPagina`, que construye la página) y, de las filas que estaban en curso y en la
// respuesta ya no lo están, copia solo el resultado del análisis. No sustituye el listado: ni
// reordena, ni repagina, ni toca `total` ni las demás filas, ni muestra spinner.
//
// Una sola petición por tick, sea cual sea el número de filas en curso: `apiLimiter` es 500 req /
// 15 min por IP para todo /api (oficinas comparten IP), y un GET por fila lo agotaba en < 1 min.
//
// - Un tick cada `INTERVALO_SONDEO_MS`; con la pestaña oculta (`document.hidden`) no se pide nada.
// - Sin solapes: si la petición anterior sigue en vuelo, el tick se salta.
// - Tope: se sondea como mucho `TOPE_SONDEO_MS` desde que entró en curso la última fila. Agotado,
//   la fila se queda «Analizando», sin error: recargar sigue funcionando.
// - Cualquier fallo (red, 429, 5xx) se ignora: se reintenta en el siguiente tick.

import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { ImpuestoItem } from './ImpuestoCola';

export const INTERVALO_SONDEO_MS = 8_000;
export const TOPE_SONDEO_MS = 180_000;

/** Lo que el sondeo copia a la fila: lo que el análisis post-envío puede cambiar. */
type Resultado = Pick<ImpuestoItem, 'analisisEstado' | 'semaforo' | 'motivoSemaforo' | 'certificacion'>;

export default function useSondeoAnalisis<C extends { items: ImpuestoItem[] }>(
  data: C | null, setData: Dispatch<SetStateAction<C | null>>, pedirPagina: () => Promise<C>,
) {
  const clave = (data?.items ?? []).filter((i) => i.analisisEstado === 'en_curso').map((i) => i.id).join(',');
  // La función cambia en cada render (cierra sobre los filtros): se lee por ref para no reiniciar el intervalo.
  const pedir = useRef(pedirPagina);
  pedir.current = pedirPagina;
  /** Instante en que empezó el sondeo vigente y filas que había entonces en curso. */
  const desde = useRef<number | null>(null);
  const vistos = useRef(new Set<string>());

  useEffect(() => {
    const ids = new Set(clave ? clave.split(',') : []);
    // Una fila que entra en curso (otro reintento, otro envío) estrena el tope de todo el sondeo.
    if ([...ids].some((id) => !vistos.current.has(id))) desde.current = Date.now();
    vistos.current = ids;
    if (ids.size === 0) return;

    let vivo = true;
    let enVuelo = false;
    const tick = async () => {
      if (enVuelo || (typeof document !== 'undefined' && document.hidden)) return;
      if (Date.now() - (desde.current ?? 0) >= TOPE_SONDEO_MS) return;
      enVuelo = true;
      const r = await pedir.current().catch(() => null);
      enVuelo = false;
      if (!vivo || !r) return;
      const terminados = new Map<string, Resultado>();
      for (const x of r.items ?? []) {
        if (!ids.has(x.id) || x.analisisEstado === 'en_curso') continue;
        terminados.set(x.id, {
          analisisEstado: x.analisisEstado ?? null, semaforo: x.semaforo ?? null,
          motivoSemaforo: x.motivoSemaforo ?? null, certificacion: x.certificacion ?? null,
        });
      }
      if (terminados.size === 0) return;
      setData((d) => d && ({
        ...d, items: d.items.map((i) => terminados.has(i.id) ? { ...i, ...terminados.get(i.id) } : i),
      }));
    };
    const t = setInterval(() => { void tick(); }, INTERVALO_SONDEO_MS);
    return () => { vivo = false; clearInterval(t); };
  }, [clave, setData]);
}
