// FLITO — Gestión Trámites · «Probar conexión» con FLIT 2 (HU #13069, Feature #13057).
// Spec UX: `docs/ux/hu-13064-13069-acceso-flit2.md` § «Probar conexión». Contrato:
// `Flit2PruebaResultado` (shared-types) de `POST /api/flito/sync/flit2/acceso/probar`.
//
// Vive dentro del panel de `AccesoFlit2.tsx`, que decide cuándo se pinta el botón (solo con
// «guardar» y `configurado: true`) y dónde va el aviso. Reglas:
//   · el resultado es un AVISO en la sección, nunca un toast (AC2);
//   · el copy es propio, por `resultado`: la pantalla no pinta `mensaje` ni `scope` del API, ni el
//     cuerpo de un error HTTP;
//   · mientras prueba, un segundo clic no sale (AC3): guarda por `ref` además del `disabled`, porque
//     dos clics en el mismo tick llegan antes de que React repinte.

import { useCallback, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import type { Flit2PruebaResultado } from '@operaciones/shared-types';
import { ApiError, api } from '../../../lib/api';
import { flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';

const RUTA_PROBAR = '/flito/sync/flit2/acceso/probar';

type TonoPrueba = 'ok' | 'advertencia' | 'error';
export interface AvisoPrueba { tono: TonoPrueba; texto: string }

const fmtHora = new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', hour: 'numeric', minute: '2-digit' });

/**
 * «después de las 10:57 a. m.» o, sin hora legible, «en unos minutos». Cierra la frase: la hora de
 * es-CO ya termina en punto («a. m.») y un segundo punto se leería «a. m..».
 */
function cuando(iso: string | null): string {
  const d = iso ? new Date(iso) : null;
  const texto = d && !Number.isNaN(d.getTime()) ? `después de las ${fmtHora.format(d)}` : 'en unos minutos';
  return texto.endsWith('.') ? texto : `${texto}.`;
}

const GENERICO: AvisoPrueba = { tono: 'error', texto: 'No se pudo probar la conexión. Vuelve a intentarlo.' };

/** Copy de la spec por `resultado`. Un valor fuera de la lista cerrada cae en el genérico. */
function avisoDeResultado(r: Flit2PruebaResultado): AvisoPrueba {
  switch (r.resultado) {
    case 'conectado':
      return { tono: 'ok', texto: 'Conectado. FLITO puede leer los trámites de FLIT 2.' };
    case 'conectado_sin_pii':
      return {
        tono: 'advertencia',
        texto: 'Conectado, pero sin permiso de datos personales. Los trámites se leen; el SOAT y los impuestos '
          + 'de los trámites de FLIT 2 quedarán en espera hasta que FLIT 2 conceda ese permiso.',
      };
    case 'rechazado':
      return { tono: 'error', texto: 'FLIT 2 rechazó el usuario o la contraseña. Revísalos y guarda el acceso de nuevo.' };
    case 'cambio_clave':
      return {
        tono: 'error',
        texto: 'FLIT 2 exige cambiar la contraseña de este usuario. Pide la nueva a quien administra FLIT 2 y guárdala aquí.',
      };
    case 'bloqueado': {
      const c = cuando(r.bloqueadoHasta);
      return { tono: 'advertencia', texto: `FLIT 2 bloqueó el acceso 15 minutos por intentos fallidos. Prueba de nuevo ${c}` };
    }
    case 'espera': {
      const c = cuando(r.bloqueadoHasta);
      return { tono: 'advertencia', texto: `FLIT 2 pidió esperar antes de otro intento. Prueba de nuevo ${c}` };
    }
    case 'no_responde':
      return { tono: 'error', texto: 'FLIT 2 no responde. Puede ser una caída momentánea: prueba de nuevo en unos minutos.' };
    case 'no_configurado':
      return { tono: 'error', texto: 'FLIT 2 no está configurado en este ambiente. Avísale a quien administra el servidor.' };
    case 'sin_acceso':
      return { tono: 'error', texto: 'FLITO ya no tiene acceso guardado. Guárdalo antes de probar.' };
    default:
      return GENERICO;
  }
}

function avisoDeError(e: unknown): AvisoPrueba {
  if (e instanceof ApiError && e.status === 429) {
    return { tono: 'advertencia', texto: 'Ya probaste la conexión varias veces en el último minuto. Espera un minuto.' };
  }
  const codigo = e instanceof ApiError ? (e.rawDetails as { codigo?: unknown } | null | undefined)?.codigo : undefined;
  if (e instanceof ApiError && e.status === 503 && codigo === 'llave_maestra') {
    return {
      tono: 'error',
      texto: 'El servidor no puede leer el acceso guardado: falta la llave de cifrado. Avísale a quien administra el ambiente.',
    };
  }
  return GENERICO;
}

/**
 * Estado de la prueba. `alTerminar` refresca la meta SIN esqueleto (el chip puede pasar a rechazado
 * o bloqueado); corre también cuando la prueba falla, porque el servidor pudo registrar la pausa.
 */
export function usePruebaConexion(alTerminar: () => void) {
  const [probando, setProbando] = useState(false);
  const [aviso, setAviso] = useState<AvisoPrueba | null>(null);
  const enVuelo = useRef(false);

  const probar = useCallback(async () => {
    if (enVuelo.current) return;
    enVuelo.current = true;
    setProbando(true);
    try {
      const r = await api.post<Flit2PruebaResultado>(RUTA_PROBAR, {});
      setAviso(typeof r?.resultado === 'string' ? avisoDeResultado(r) : GENERICO);
    } catch (e) {
      setAviso(avisoDeError(e));
    } finally {
      enVuelo.current = false;
      setProbando(false);
      alTerminar();
    }
  }, [alTerminar]);

  const limpiar = useCallback(() => setAviso(null), []);
  return { probando, aviso, probar, limpiar };
}

const ESTILO: Record<TonoPrueba, { tinta: string; fondo: string; Icono: typeof CheckCircle2 }> = {
  ok: { tinta: 'var(--flit-success-ink)', fondo: 'var(--flit-chip-success-bg)', Icono: CheckCircle2 },
  advertencia: { tinta: 'var(--flit-warning-ink)', fondo: 'var(--flit-chip-warning-bg)', Icono: AlertTriangle },
  error: { tinta: 'var(--flit-danger-ink)', fondo: 'var(--flit-chip-danger-bg)', Icono: XCircle },
};

/** Aviso del resultado: el tono va en icono + texto, no solo en color. Error = `alert`. */
export function AvisoPruebaFlit2({ aviso }: { aviso: AvisoPrueba }) {
  const { tinta, fondo, Icono } = ESTILO[aviso.tono];
  return (
    <div
      role={aviso.tono === 'error' ? 'alert' : 'status'}
      data-tono={aviso.tono}
      className="flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm"
      style={{ border: '1px solid var(--flit-border-soft)', background: fondo, color: tinta }}
    >
      <Icono aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <p>{aviso.texto}</p>
    </div>
  );
}

/** Botón secundario junto a la ficha. Quien lo monta decide si se pinta (AC1, AC4). */
export function BotonProbarConexion({ probando, onProbar }: { probando: boolean; onProbar: () => void }) {
  return (
    <div className="flex justify-end">
      <button
        type="button"
        className={`${flitBtnSecondary} w-full sm:w-auto`}
        style={flitBtnSecondaryStyle}
        onClick={onProbar}
        disabled={probando}
        aria-busy={probando}
      >
        {probando ? 'Probando…' : 'Probar conexión'}
      </button>
    </div>
  );
}
