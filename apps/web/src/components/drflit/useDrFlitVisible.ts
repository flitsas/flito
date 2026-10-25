import { useAuth } from '../../lib/auth';
import { puedeAbrirDrFlit } from './drFlitFunciones';

/**
 * ¿Se pinta Dr. Flit? (HU #13764 AC1/AC2, fail-closed). `funciones` es `null` hasta que
 * `/permisos/mios` responde: mientras carga o si falló, no se pinta (HU #13942 AC7).
 * HU #13942 AC1: lo decide el ítem `pagina.flito_dr_flit` (HU #13941), con o sin enlace. Ya no se
 * excluye por `tipoEnlace` (HU #13914) ni basta con tener fichas de Ayuda visibles.
 * Nunca `hasPage`: ciclo `permissions → navItems → ayudaFlito` (ver `lib/ayudaFlito.ts`).
 * Lo comparten el montaje, el dock (reserva lateral) y el `main` (relleno inferior en <lg).
 */
export function useDrFlitVisible(): boolean {
  const { user, funciones, permisosError } = useAuth();
  return funciones !== null && !permisosError && puedeAbrirDrFlit(user);
}
