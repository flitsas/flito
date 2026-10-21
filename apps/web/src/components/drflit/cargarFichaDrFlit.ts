// Dr. Flit — carga de UNA ficha para «Explícame un módulo» (HU #13765 AC4). El llamador solo pasa
// claves visibles para el usuario: una ficha sin permiso no se pide nunca.
//
// Chromium cachea el fallo de un `import()` dinámico (mismo motivo que `DrFlitMontaje`): repetir
// la misma URL devuelve el mismo error sin volver a pedirla. El reintento pide el módulo de la ficha
// con una query única; la URL sale del mensaje del error y solo se usa si es del propio origen.

import { leerFichaParseada } from '../../content/ayuda/cargarFichas';
import { parsearFicha, type FichaParseada } from '../../lib/ayudaFicha';

const URL_EN_ERROR = /(https?:\/\/[^\s]+)/;
const urlsFallidas = new Map<string, string>();

function esDeEsteOrigen(url: string): boolean {
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

function conReintento(url: string, intento: number): string {
  return `${url}${url.includes('?') ? '&' : '?'}reintento=${intento}`;
}

/** `null` = ficha pendiente (sin archivo). Un throw = error de carga (se ofrece «Reintentar»). */
export async function cargarFichaDrFlit(clave: string, intento: number): Promise<FichaParseada | null> {
  try {
    const fallida = urlsFallidas.get(clave);
    if (intento > 0 && fallida) {
      const mod = (await import(/* @vite-ignore */ conReintento(fallida, intento))) as { default?: unknown };
      if (typeof mod.default !== 'string') throw new Error('Ficha ilegible.');
      urlsFallidas.delete(clave);
      return parsearFicha(mod.default);
    }
    return await leerFichaParseada(clave);
  } catch (e) {
    const url = e instanceof Error ? URL_EN_ERROR.exec(e.message)?.[1] : undefined;
    if (url && esDeEsteOrigen(url)) urlsFallidas.set(clave, url.split(/[?&]reintento=/)[0]);
    throw e;
  }
}
