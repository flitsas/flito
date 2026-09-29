// FLITO — Gestión Trámites · botón «Sincronizar FLIT 2» (HU #13096, Feature #13059).
// Spec UX: `docs/ux/hu-13096-boton-sincronizar-flit2.md`. Contrato: `Flit2LecturaResultado`
// (shared-types) de `POST /api/flito/sync/flit2/sincronizar`, sin cuerpo.
//
// Reglas:
//   · se pinta solo con `sync.sync.lanzar` (la función que exige el endpoint), fuera de la guarda
//     de FLIT 1: sin ella el botón no está en el DOM;
//   · secundario del kit: la única primaria de la cabecera sigue siendo «Sincronizar FLIT»;
//   · el resultado va en UN toast por pulsación (`id` fijo), con copy propio: nunca el `error`,
//     el `codigo` ni el `status` del API;
//   · mientras lee, un segundo clic no sale: guarda por `ref` además del `disabled`, porque dos
//     clics en el mismo tick llegan antes de que React repinte.

import { useCallback, useRef, useState } from 'react';
import type { Flit2LecturaResultado } from '@operaciones/shared-types';
import { ApiError, api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { toastError, toastOk } from '../../flit/ToastFlito';
import { flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';

const RUTA_SINCRONIZAR = '/flito/sync/flit2/sincronizar';
const ID_TOAST = 'flit2-sync';
const QUEDAN_MAS = 'Quedan más: la lectura automática sigue donde quedó.';

function numero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function plural(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`;
}

/** «N quedaron sin empresa o sin secretaría…», o vacío si no hay faltantes. */
function fraseFaltantes(r: Flit2LecturaResultado): string {
  const n = numero(r.companiasFaltantes) + numero(r.organismosSinEmparejar);
  if (n <= 0) return '';
  return n === 1
    ? ' 1 quedó sin empresa o sin secretaría: revísalo en la cola.'
    : ` ${n} quedaron sin empresa o sin secretaría: revísalos en la cola.`;
}

/** Copy del 200 (lleno, parcial o vacío). La telemetría de la lectura no se pinta. */
export function textoDeResultado(r: Flit2LecturaResultado): string {
  const leidos = numero(r.leidos);
  if (leidos === 0 && !r.hasMore) return 'FLIT 2 no tiene trámites nuevos ni con cambios desde la última lectura.';
  const base = `FLIT 2: ${plural(leidos, 'trámite leído', 'trámites leídos')}, `
    + `${plural(numero(r.nuevos), 'nuevo', 'nuevos')} y ${plural(numero(r.actualizados), 'actualizado', 'actualizados')}.`;
  return `${base}${fraseFaltantes(r)}${r.hasMore ? ` ${QUEDAN_MAS}` : ''}`;
}

interface CuerpoError { codigo?: unknown; parcial?: unknown }

function cuerpoDe(e: unknown): CuerpoError {
  if (!(e instanceof ApiError)) return {};
  const c = e.rawDetails as CuerpoError | null | undefined;
  return c && typeof c === 'object' ? c : {};
}

function parcialDe(c: CuerpoError): Flit2LecturaResultado | null {
  const p = c.parcial as Flit2LecturaResultado | null | undefined;
  return p && typeof p === 'object' && typeof p.leidos === 'number' ? p : null;
}

const GENERICO = 'No se pudo sincronizar FLIT 2. Vuelve a intentarlo.';

/** Copy por respuesta de error y si ofrece [Reintentar]. Un código fuera de la lista cae en el genérico. */
function avisoDeError(e: unknown): { texto: string; reintentar: boolean } {
  const status = e instanceof ApiError ? e.status : 0;
  const codigo = cuerpoDe(e).codigo;
  if (status === 429) return { texto: 'Ya sincronizaste FLIT 2 varias veces en el último minuto. Espera un minuto.', reintentar: false };
  switch (codigo) {
    case 'lectura_concurrente':
      return { texto: 'Ya hay una lectura de FLIT 2 en marcha. Espera a que termine y actualiza la cola.', reintentar: false };
    case 'no_configurado':
      return { texto: 'FLIT 2 no está configurado en este ambiente. Avísale a quien administra el servidor.', reintentar: false };
    case 'sin_acceso':
      return { texto: 'FLITO no tiene acceso a FLIT 2. Configúralo en Acceso a FLIT 2.', reintentar: false };
    case 'rechazado':
      return { texto: 'FLIT 2 rechazó el acceso guardado. Revísalo en Acceso a FLIT 2.', reintentar: false };
    case 'bloqueado':
      return { texto: 'FLIT 2 bloqueó el acceso por intentos fallidos. Prueba de nuevo en unos minutos.', reintentar: false };
    case 'espera':
      return { texto: 'FLIT 2 pidió esperar antes de seguir. La lectura automática continúa donde quedó.', reintentar: false };
    case 'no_responde':
      return { texto: 'FLIT 2 no responde. Puede ser una caída momentánea: vuelve a intentarlo en unos minutos.', reintentar: true };
    case 'llave_maestra':
    case 'acceso_descifrado':
      return {
        texto: 'El servidor no puede leer el acceso a FLIT 2. Revísalo en Acceso a FLIT 2 o avísale a quien administra el ambiente.',
        reintentar: false,
      };
    case 'flit2_respuesta':
      return { texto: 'FLIT 2 respondió de forma inesperada. Vuelve a intentarlo; si se repite, avísale a soporte.', reintentar: true };
    default:
      return { texto: GENERICO, reintentar: true };
  }
}

/** `onIntento` se llama al terminar cada pulsación, salga bien o mal (HU #13098: refresca el estado de FLIT 2). */
export default function SincronizarFlit2({ onTerminado, onIntento }: { onTerminado: () => void; onIntento?: () => void }) {
  const { hasFuncion } = useAuth();
  const [leyendo, setLeyendo] = useState(false);
  const enVuelo = useRef(false);

  const sincronizar = useCallback(async () => {
    if (enVuelo.current) return;
    enVuelo.current = true;
    setLeyendo(true);
    try {
      const r = await api.post<Flit2LecturaResultado>(RUTA_SINCRONIZAR);
      if (r && typeof r.leidos === 'number') {
        toastOk(textoDeResultado(r), { id: ID_TOAST });
        onTerminado();
      } else {
        toastError(GENERICO, () => { void sincronizar(); }, { id: ID_TOAST });
      }
    } catch (e) {
      const cuerpo = cuerpoDe(e);
      const parcial = parcialDe(cuerpo);
      if (parcial) onTerminado();
      const leidos = parcial ? `Se alcanzaron a leer ${plural(parcial.leidos, 'trámite', 'trámites')} (${plural(numero(parcial.nuevos), 'nuevo', 'nuevos')}).` : '';
      if (parcial && cuerpo.codigo === 'espera') {
        toastOk(`${leidos} FLIT 2 pidió esperar: la lectura automática sigue donde quedó.`, { id: ID_TOAST });
      } else {
        const { texto, reintentar } = avisoDeError(e);
        toastError(leidos ? `${leidos} ${texto}` : texto, reintentar ? () => { void sincronizar(); } : undefined, { id: ID_TOAST });
      }
    } finally {
      enVuelo.current = false;
      setLeyendo(false);
      onIntento?.();
    }
  }, [onTerminado, onIntento]);

  if (!hasFuncion('sync.sync.lanzar')) return null;
  return (
    <button type="button" className={`${flitBtnSecondary} whitespace-nowrap`} style={flitBtnSecondaryStyle}
      disabled={leyendo} aria-busy={leyendo} title="Lee lo nuevo de FLIT 2 desde la última lectura"
      onClick={() => { void sincronizar(); }}>
      {leyendo ? 'Sincronizando FLIT 2…' : 'Sincronizar FLIT 2'}
    </button>
  );
}
