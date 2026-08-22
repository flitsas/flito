// FLITO — Conciliación · el aviso guardado en la pestaña (Feature #11623, HU #11680).
//
// Solo el ALMACENAMIENTO del aviso del AC5: su forma, su clave y su barrido. Ni copy, ni DTOs, ni
// formato de moneda — y por eso es un archivo aparte y no un rincón de `conciliacion.ts`.
//
// El motivo es de peso, literalmente. `lib/auth.tsx` llama a `limpiarAvisos()` al cerrar sesión, y
// `auth.tsx` viaja en el chunk de ENTRADA: el que descarga quien todavía no ha entrado, en /login.
// Con la función dentro de `conciliacion.ts`, el bundler arrastraba al entry las ~500 líneas de copy
// de la conciliación y sus dependencias — medido: 26,8 → 33,9 KB gzip, con el budget en 32. Este
// módulo no importa nada, así que lo que el entry se lleva son estas tres funciones y ya.
//
// `conciliacion.ts` lo re-exporta: las pantallas siguen importando de un único sitio.

/**
 * Lo que el aviso de éxito necesita decir, SIN un solo dato personal.
 *
 * Se guarda en `sessionStorage` porque el AC5 exige que el aviso **sobreviva a una recarga** con sus
 * cifras, y esas cifras no se pueden reconstruir del detalle: los saldos resultantes de las bolsas
 * solo viajan en la respuesta de `conciliar`, y `yaDescontadoEnLiquidacion` deja de ser cierto en
 * cuanto la conciliación ADOPTA el movimiento (pasa de `origen='automatico'` a `'conciliacion'`, que
 * es justo lo que el detalle mira). Sin esto, recargar convertiría el aviso en una versión pobre de
 * sí mismo — o, peor, en una que dice «0 ya descontados» cuando hubo dos.
 *
 * **No se guarda ni una placa ni una póliza**: solo conteos, importes y nombres de bolsa. Es una
 * copia de cifras, no del cuadre.
 */
export interface AvisoConciliacion {
  soatConciliados: number;
  totalConciliado: number;
  cliente: { nombre: string | null; descontado: number; saldoResultante: number };
  transito: { nombre: string | null; descontado: number; saldoResultante: number }[];
  /** Cuántos SOAT ya se habían descontado al liquidar. `0` = no hay frase de adoptados. */
  adoptados: number;
}

/**
 * El prefijo de TODAS las claves del aviso. Es lo que `limpiarAvisos` barre, así que vive suelto: la
 * clave completa se arma abajo y este literal no se repite en ninguna otra parte del archivo.
 */
const PREFIJO_AVISO = 'flito:conciliacion:aviso:';

/**
 * `flito:conciliacion:aviso:<userId>:<boletaId>` — la clave lleva al USUARIO, no solo a la boleta.
 *
 * Dos personas de Financiera comparten a veces la misma pestaña, y el aviso guardado GANA sobre el
 * reconstruido del detalle (ver `FlitoConciliacionBoleta`). Sin el usuario en la clave, la segunda
 * abre la boleta y ve el snapshot de saldos de la primera pintado como si fuera el de ahora. No es
 * una fuga —las dos ven las bolsas— pero es un dato viejo presentado como bueno, y son cifras de
 * dinero.
 */
function claveAviso(userId: string | number, boletaId: string): string {
  return `${PREFIJO_AVISO}${userId}:${boletaId}`;
}

export function guardarAviso(userId: string | number, boletaId: string, aviso: AvisoConciliacion): void {
  try {
    sessionStorage.setItem(claveAviso(userId, boletaId), JSON.stringify(aviso));
  } catch { /* sessionStorage lleno o deshabilitado: el aviso vive lo que viva la pestaña */ }
}

export function leerAviso(userId: string | number, boletaId: string): AvisoConciliacion | null {
  try {
    const crudo = sessionStorage.getItem(claveAviso(userId, boletaId));
    if (!crudo) return null;
    const dato = JSON.parse(crudo) as AvisoConciliacion;
    return typeof dato?.soatConciliados === 'number' ? dato : null;
  } catch {
    return null;
  }
}

/**
 * Barre TODOS los avisos guardados en la pestaña. Lo llama `lib/auth.tsx`, tanto al cerrar sesión a
 * mano como cuando la sesión se cae sola (`SESSION_ENDED_EVENT`).
 *
 * Por qué hace falta: el cierre de sesión de FLIT es SPA —cambia la ruta, **no destruye la
 * pestaña**—, y `sessionStorage` sobrevive a eso. Sin este barrido, quien entrara después en la
 * misma pestaña seguiría teniendo a mano los saldos de bolsa de quien salió, aunque fuera un
 * conductor. Y la expiración cuenta igual que el logout: deja el mismo rastro.
 *
 * Tres detalles que no son de estilo:
 *
 *   · **Las claves se recogen antes de borrar.** `sessionStorage.key(i)` se reindexa en cada
 *     `removeItem`, así que borrar mientras se itera se salta la mitad de las claves.
 *   · **No lanza nunca.** El almacenamiento puede estar deshabilitado, y un usuario que no puede
 *     cerrar sesión porque el barrido explotó es peor que el rastro que esto viene a limpiar.
 *   · **Cada borrado va en su propio `try`, y lo que no se pudo borrar se dice.** Con un solo `try`
 *     alrededor de los dos bucles, un `removeItem` que lanzara a mitad dejaba las claves restantes
 *     sin borrar —saldos de bolsa vivos en la pestaña— y sin ningún rastro. «No fallar» y «no
 *     enterarse» no son lo mismo. El aviso va por consola, como el resto de lo que falla en el front
 *     sin tumbar la vista (`[pwa]`, `[ErrorBoundary]`), y **no nombra las claves**: llevan dentro el
 *     usuario y la boleta (AGENTS.md §14), así que solo se dice cuántas quedaron.
 */
export function limpiarAvisos(): void {
  const claves: string[] = [];
  try {
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const clave = sessionStorage.key(i);
      if (clave !== null && clave.startsWith(PREFIJO_AVISO)) claves.push(clave);
    }
  } catch {
    // sessionStorage deshabilitado: no hay nada que barrer y el cierre de sesión sigue.
    return;
  }
  let sinBorrar = 0;
  for (const clave of claves) {
    try { sessionStorage.removeItem(clave); } catch { sinBorrar += 1; }
  }
  if (sinBorrar > 0) {
    console.warn(`[conciliacion] ${sinBorrar} de ${claves.length} aviso(s) no se pudieron borrar de la pestaña al cerrar sesión`);
  }
}

/** `descontado === -1` marca «esto no se sabe», que no es lo mismo que «fue cero». */
export const IMPORTE_DESCONOCIDO = -1;
