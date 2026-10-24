import { useAuth } from '../../lib/auth';
import { puedeVerAyudaFlito } from '../../lib/ayudaFlito';

/**
 * ¿Se pinta Dr. Flit? (HU #13764 AC1/AC2, fail-closed). `funciones` es `null` hasta que
 * `/permisos/mios` responde; `tipoEnlace` llega en esa misma respuesta (`lib/auth`: `setFunciones` y
 * `setTipoEnlace` en el mismo tick, un solo render), así que con `funciones !== null` ya es fiable.
 * Antes de eso vale `null` y no distingue «sin enlace» de «aún no se sabe»: por eso manda `funciones`.
 * HU #13914: los usuarios con enlace ya ven fichas de Ayuda, pero Dr. Flit sigue oculto para ellos
 * (decisión de producto): se exige además `tipoEnlace` vacío o `ninguno`.
 * Nunca `hasPage`: ciclo `permissions → navItems → ayudaFlito` (ver `lib/ayudaFlito.ts`).
 * Lo comparten el montaje, el dock (reserva lateral) y el `main` (relleno inferior en <lg).
 */
export function useDrFlitVisible(): boolean {
  const { user, funciones, tipoEnlace, permisosError } = useAuth();
  const sinEnlace = tipoEnlace == null || tipoEnlace === 'ninguno';
  return funciones !== null && !permisosError && sinEnlace && puedeVerAyudaFlito(user);
}
