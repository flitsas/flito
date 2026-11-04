// La ruta que guarda la telemetría RUM (HU #14281, ADR-0036). Una sola regla para el navegador
// (`apps/web/src/lib/rum.ts`) y para el API, que también debe limpiar lo que mande una versión
// anterior de la página.

const PAGINAS_CON_TOKEN: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\/+tramite\/+portal\/+[^/]/i, '/tramite/portal/:token'],
  [/^\/+m\/+[^/]/i, '/m/:token'],
];

/**
 * `/tramite/portal/<token>` y `/m/<token>` pasan a la plantilla de su página, con lo que traigan
 * detrás; así dos tokens de la misma página se agrupan en una ruta. Lo demás sale igual, salvo query
 * o fragmento (`location.pathname` no los trae). Lo que no es texto se devuelve tal cual.
 */
export function normalizarRutaRum<T>(ruta: T): T | string {
  if (typeof ruta !== 'string') return ruta;
  const sinQuery = ruta.split(/[?#]/, 1)[0]!;
  const pagina = PAGINAS_CON_TOKEN.find(([patron]) => patron.test(sinQuery));
  return pagina ? pagina[1] : sinQuery;
}
