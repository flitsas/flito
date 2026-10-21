// Dr. Flit — almacén de la conversación en la pestaña (HU #13767, Feature #13694; slim §4–§5).
//
// SIN IMPORTS, a propósito: `lib/auth.tsx` llama a `limpiarConversacionDrFlit()` en sus 4 salidas de
// sesión y `auth.tsx` viaja en el chunk de ENTRADA (el de /login). Mismo motivo y patrón que
// `conciliacionAviso.ts`: lo que el entry se lleva son estas funciones y nada más.
//
// Solo `sessionStorage` (nunca `localStorage`, AC4): la conversación dura lo que la pestaña y la
// sesión. Ninguna función lanza ni escribe en consola: con el almacenamiento bloqueado la
// conversación vive en memoria (AC6) y el cierre de sesión sigue su curso.

/** Prefijo de TODA clave de Dr. Flit: es lo que barre `limpiarConversacionDrFlit`. */
export const PREFIJO_DRFLIT = 'flito:drflit:';

/**
 * `flito:drflit:conversacion:<userId>`. El usuario en la clave es defensa en profundidad: si un
 * barrido fallara, quien entre después en la misma pestaña no lee la conversación ajena.
 */
/**
 * ¿La pestaña está descargando este documento (recarga o navegación dura)? Al descargar, el navegador
 * aborta las peticiones en vuelo: un `/auth/me` abortado cae en el `.catch` de `auth.tsx` como si el
 * token no sirviera, y el barrido borraba la conversación que el documento SIGUIENTE iba a restaurar
 * (HU #13767 AC1, F5 justo después de cargar). Mientras se descarga no se barre: si la sesión de
 * verdad terminó, el documento siguiente arranca sin token y barre él (camino «arranque sin token»).
 */
let descargando = false;
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => { descargando = true; });
  // Vuelta desde la bfcache: el documento sigue vivo y vuelve a barrer normalmente.
  window.addEventListener('pageshow', () => { descargando = false; });
}

export function claveConversacion(userId: string | number): string {
  return `${PREFIJO_DRFLIT}conversacion:${userId}`;
}

export function leerCrudo(userId: string | number): string | null {
  try {
    return sessionStorage.getItem(claveConversacion(userId));
  } catch {
    return null;
  }
}

export function escribirCrudo(userId: string | number, valor: string): void {
  try {
    sessionStorage.setItem(claveConversacion(userId), valor);
  } catch { /* bloqueado o lleno: la conversación vive en memoria */ }
}

export function borrarCrudo(userId: string | number): void {
  try {
    sessionStorage.removeItem(claveConversacion(userId));
  } catch { /* bloqueado: no hay nada que borrar */ }
}

/**
 * Barre toda clave `flito:drflit:` de la pestaña. Las claves se recogen ANTES de borrar
 * (`key(i)` se reindexa en cada `removeItem`) y cada borrado va en su propio `try`. No lanza nunca.
 */
export function limpiarConversacionDrFlit(): void {
  if (descargando) return;
  const claves: string[] = [];
  try {
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const clave = sessionStorage.key(i);
      if (clave !== null && clave.startsWith(PREFIJO_DRFLIT)) claves.push(clave);
    }
  } catch {
    return;
  }
  for (const clave of claves) {
    try { sessionStorage.removeItem(clave); } catch { /* sigue con la siguiente */ }
  }
}
