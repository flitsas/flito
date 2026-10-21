import { useAuth } from '../../lib/auth';
import { puedeVerAyudaFlito } from '../../lib/ayudaFlito';

/**
 * ¿Se pinta Dr. Flit? (HU #13764 AC1/AC2, fail-closed). `funciones` es `null` hasta que
 * `/permisos/mios` responde; `tipoEnlace` no sirve como señal (vale `null` antes y después).
 * Nunca `hasPage`: ciclo `permissions → navItems → ayudaFlito` (ver `lib/ayudaFlito.ts`).
 * Lo comparten el montaje, el dock (reserva lateral) y el `main` (relleno inferior en <lg).
 */
export function useDrFlitVisible(): boolean {
  const { user, funciones, permisosError } = useAuth();
  return funciones !== null && !permisosError && puedeVerAyudaFlito(user);
}
