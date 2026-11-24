import { useCallback, useMemo, useState } from 'react';
import { FUNCIONES_DRFLIT, type FuncionDrFlit } from '@operaciones/shared-types';
import { ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';

// Dr. Flit según sus funciones (HU #13942; spec `docs/ux/flito-dr-flit-funciones.md`). El permiso de la
// página (`pagina.flito_dr_flit`) decide si se pinta; sus cuatro funciones (HU #13941) deciden qué se
// ofrece dentro. La web nunca decide por el nombre del rol ni por el enlace.

/** Slug del ítem «Dr. Flit» (General). Llega en `allowedPages` de `/me`, con o sin enlace. */
const PAGINA_DRFLIT = 'flito_dr_flit';

/**
 * ¿Tiene el usuario el ítem «Dr. Flit»? Se lee `allowedPages` directo y NO `effectivePages`/`hasPage`:
 * la frontera por enlace (ADR-0024) no aplica a Dr. Flit (HU #13941), y `hasPage` arrastra el ciclo
 * `permissions → navItems → ayudaFlito` (ver `useDrFlitVisible`).
 */
export function puedeAbrirDrFlit(user: { allowedPages?: readonly string[] | null } | null): boolean {
  return !!user?.allowedPages?.includes(PAGINA_DRFLIT);
}

export interface FuncionesDrFlitPanel {
  /** M: ver los manuales (fichas, «Explícame», búsqueda en los manuales). */
  manuales: boolean;
  /** I: usar la IA (`GET/POST /autorizacion?finalidad=ia`, `POST /chat`). */
  ia: boolean;
  /** G: consulta de gestión (placa, VIN, id FLIT, trámite). */
  gestion: boolean;
  /** S: radicar soporte (`GET /autorizacion?finalidad=soporte`, `POST /casos-soporte`). */
  soporte: boolean;
  /** 403 `drflit-funcion-no-habilitada` inesperado: la función se apaga en esta sesión del panel. */
  retirar: (funcion: FuncionDrFlit) => void;
}

/** Funciones de Dr. Flit del usuario, menos las retiradas por un 403 con el panel abierto (copy 6). */
export function useFuncionesDrFlit(): FuncionesDrFlitPanel {
  const { hasFuncion } = useAuth();
  const [retiradas, setRetiradas] = useState<ReadonlySet<FuncionDrFlit>>(() => new Set());
  const tiene = useCallback((f: FuncionDrFlit) => hasFuncion(f) && !retiradas.has(f), [hasFuncion, retiradas]);
  const retirar = useCallback((f: FuncionDrFlit) => {
    setRetiradas((prev) => (prev.has(f) ? prev : new Set(prev).add(f)));
  }, []);
  return useMemo(() => ({
    manuales: tiene(FUNCIONES_DRFLIT.verManuales),
    ia: tiene(FUNCIONES_DRFLIT.usarIa),
    gestion: tiene(FUNCIONES_DRFLIT.consultarGestion),
    soporte: tiene(FUNCIONES_DRFLIT.radicarSoporte),
    retirar,
  }), [tiene, retirar]);
}

const FUNCIONES_VALIDAS: readonly string[] = Object.values(FUNCIONES_DRFLIT);

/** La función que faltó en un 403 `drflit-funcion-no-habilitada`, o `null` si el error es otro. */
export function funcionNoHabilitada(e: unknown): FuncionDrFlit | null {
  if (!(e instanceof ApiError) || e.status !== 403) return null;
  const raw = e.rawDetails as { codigo?: unknown; funcion?: unknown } | null | undefined;
  if (raw?.codigo !== 'drflit-funcion-no-habilitada') return null;
  return typeof raw.funcion === 'string' && FUNCIONES_VALIDAS.includes(raw.funcion)
    ? (raw.funcion as FuncionDrFlit) : null;
}

/** Copy exacto de la spec (usted, una frase: qué pasó y qué hacer). Nunca el error crudo. */
export const COPY_DRFLIT_FUNCIONES = Object.freeze({
  vacioSinFichas:
    'Todavía no hay manuales de los módulos que usted usa; cuando su administrador le dé acceso a un módulo, aquí podrá consultar cómo funciona.',
  vacioSinFunciones:
    'Dr. Flit aún no tiene funciones habilitadas para usted; pídale a su administrador que le active al menos los manuales.',
  'sin-soporte':
    'Usted no tiene habilitado radicar casos de soporte en Dr. Flit; pídale a su administrador que se lo active.',
  'sin-manuales':
    'No puedo responderle porque usted aún no tiene manuales disponibles; pídale a su administrador que le dé acceso a los manuales de sus módulos.',
  'sin-gestion':
    'Usted no tiene habilitada la consulta de placas y trámites en Dr. Flit; pídale a su administrador que se la active.',
  retirada:
    'Esta función ya no está habilitada para usted; si la necesita, pídale a su administrador que se la active.',
} as const);
