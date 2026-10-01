// FLITO — Gestión Trámites · interruptor de sincronización por fuente (HU #13238, Feature #13236).
// Spec UX: `docs/ux/flito-tramites-sincronizacion-interruptores.md`. Contrato (HU #13237):
// `GET /api/flito/sync/interruptores` y `PUT /api/flito/sync/interruptores/:fuente`.
//
// Reglas:
//   · solo con `tramites.sincronizacion.configurar` se llama al GET y se pinta el interruptor; sin ella
//     el grupo dice su estado efectivo EN TEXTO, sin switch (AC3 de la HU manda sobre la spec);
//   · no optimista: el valor cambia con la respuesta del PUT; mientras tanto «Guardando…» y el control
//     queda aria-disabled sin perder el foco;
//   · apagar pide confirmación con el foco en Cancelar; encender no;
//   · jamás se pinta el `e.message`, el código ni el status del API: cada caso tiene su frase.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FuenteSincronizacion, InterruptorFuente, InterruptoresSincronizacion } from '@operaciones/shared-types';
import { ApiError, api } from '../../../lib/api';
import FlitModal from '../../flit/FlitModal';
import FlitSwitch from '../../flit/FlitSwitch';
import { toastError, toastOk } from '../../flit/ToastFlito';
import { flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';

export const FUNCION_CONFIGURAR = 'tramites.sincronizacion.configurar';
const RUTA = '/flito/sync/interruptores';

export const NOMBRE_FUENTE: Record<FuenteSincronizacion, string> = { flit1: 'FLIT 1', flit2: 'FLIT 2' };

// ── Hook ────────────────────────────────────────────────────────────────────────────────────────

export type FaseInterruptores =
  | { fase: 'oculto' }
  | { fase: 'cargando' }
  | { fase: 'error' }
  | { fase: 'listo'; dato: InterruptoresSincronizacion };

export interface UsoInterruptores {
  estado: FaseInterruptores;
  /** Fuente con un PUT en vuelo. */
  guardando: Partial<Record<FuenteSincronizacion, boolean>>;
  /** El PUT respondió 403: el permiso se cayó y la sección pasa a solo lectura. */
  revocado: boolean;
  cambiar: (fuente: FuenteSincronizacion, encendido: boolean) => void;
  reintentar: () => void;
  /** GET silencioso: si falla, conserva lo que había. */
  refrescar: () => void;
}

function esInterruptores(r: unknown): r is InterruptoresSincronizacion {
  const o = r as Partial<InterruptoresSincronizacion> | null;
  return !!o && Array.isArray(o.fuentes) && typeof o.maestroFlit2 === 'boolean';
}

function toastExito(fuente: FuenteSincronizacion, encendido: boolean, maestroFlit2: boolean) {
  const id = `sync-interruptor-${fuente}`;
  if (fuente === 'flit1') {
    toastOk(encendido
      ? 'FLIT 1 quedó encendida: ya puedes usar «Sincronizar FLIT».'
      : 'FLIT 1 quedó apagada: «Sincronizar FLIT» queda deshabilitado.', { id });
  } else if (!encendido) {
    toastOk('FLIT 2 quedó apagada: no entran trámites nuevos de FLIT 2.', { id });
  } else if (!maestroFlit2) {
    toastOk('FLIT 2 quedó encendida aquí, pero el servidor de este ambiente la mantiene apagada: no entra nada hasta que lo enciendan.', { id, duracionMs: 6_000 });
  } else {
    toastOk('FLIT 2 quedó encendida: la lectura sigue donde quedó en la próxima vuelta automática.', { id });
  }
}

/** `puede` = tiene `tramites.sincronizacion.configurar`. `alCambiar` refresca los estados de las fuentes. */
export function useInterruptores(puede: boolean, alCambiar: () => void): UsoInterruptores {
  const [estado, setEstado] = useState<FaseInterruptores>(puede ? { fase: 'cargando' } : { fase: 'oculto' });
  const [guardando, setGuardando] = useState<Partial<Record<FuenteSincronizacion, boolean>>>({});
  const [revocado, setRevocado] = useState(false);
  const secuencia = useRef(0);
  const estadoRef = useRef(estado);
  useEffect(() => { estadoRef.current = estado; }, [estado]);
  const alCambiarRef = useRef(alCambiar);
  useEffect(() => { alCambiarRef.current = alCambiar; }, [alCambiar]);

  const cargar = useCallback(async (silencioso: boolean) => {
    const mia = ++secuencia.current;
    try {
      const r = await api.get<InterruptoresSincronizacion>(RUTA);
      if (mia !== secuencia.current) return;
      if (esInterruptores(r)) setEstado({ fase: 'listo', dato: r });
      else if (!silencioso) setEstado({ fase: 'error' });
    } catch {
      if (mia === secuencia.current && !silencioso) setEstado({ fase: 'error' });
    }
  }, []);

  useEffect(() => {
    if (!puede) { setEstado({ fase: 'oculto' }); return undefined; }
    void cargar(false);
    return () => { secuencia.current += 1; };
  }, [puede, cargar]);

  const reintentar = useCallback(() => { setEstado({ fase: 'cargando' }); void cargar(false); }, [cargar]);
  const refrescar = useCallback(() => { void cargar(true); }, [cargar]);

  const cambiar = useCallback((fuente: FuenteSincronizacion, encendido: boolean) => {
    const guardar = async () => {
      setGuardando((g) => ({ ...g, [fuente]: true }));
      try {
        const r = await api.put<InterruptorFuente>(`${RUTA}/${fuente}`, { encendido });
        const previo = estadoRef.current;
        const maestro = previo.fase === 'listo' ? previo.dato.maestroFlit2 : true;
        setEstado((e) => {
          if (e.fase !== 'listo') return e;
          return { fase: 'listo', dato: { ...e.dato, fuentes: e.dato.fuentes.map((f) => (f.fuente === fuente ? r : f)) } };
        });
        toastExito(fuente, r.encendido, maestro);
        alCambiarRef.current();
      } catch (e) {
        const status = e instanceof ApiError ? e.status : 0;
        const id = `sync-interruptor-${fuente}`;
        if (status === 403) {
          setRevocado(true);
          toastError('No tienes permiso para cambiar la sincronización. Pídeselo a un administrador.', undefined, { id });
        } else if (status === 400) {
          toastError('No se pudo guardar el cambio. Recarga la página e inténtalo de nuevo.', undefined, { id });
        } else {
          toastError(`No se pudo guardar el cambio de ${NOMBRE_FUENTE[fuente]}. Inténtalo de nuevo.`, () => { void guardar(); }, { id });
        }
      } finally {
        setGuardando((g) => ({ ...g, [fuente]: false }));
      }
    };
    void guardar();
  }, []);

  return { estado, guardando, revocado, cambiar, reintentar, refrescar };
}

// ── Fecha de la línea quién/cuándo ──────────────────────────────────────────────────────────────

const ZONA = 'America/Bogota';
const fmtDia = new Intl.DateTimeFormat('es-CO', { timeZone: ZONA, day: 'numeric', month: 'short' });
const fmtHora = new Intl.DateTimeFormat('es-CO', { timeZone: ZONA, hour: 'numeric', minute: '2-digit' });
const fmtClaveDia = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' });

/** «Apagada por Ana Pérez el 1 oct. a las 3:20 p. m.» / «… hoy a las …». null si nadie la ha cambiado. */
export function quienCuando(i: InterruptorFuente): string | null {
  if (!i.actualizadoEn) return null;
  const d = new Date(i.actualizadoEn);
  if (Number.isNaN(d.getTime())) return null;
  const hoy = fmtClaveDia.format(new Date()) === fmtClaveDia.format(d);
  const cuando = hoy ? `hoy a las ${fmtHora.format(d)}` : `el ${fmtDia.format(d)} a las ${fmtHora.format(d)}`;
  const quien = i.actualizadoPor ? ` por ${i.actualizadoPor.nombre}` : '';
  return `${i.encendido ? 'Encendida' : 'Apagada'}${quien} ${cuando}`;
}

// ── Diálogo de apagado ──────────────────────────────────────────────────────────────────────────

const CUERPO_APAGAR: Record<FuenteSincronizacion, string> = {
  flit1: 'Mientras esté apagada, no entran trámites de FLIT 1 en este ambiente y nadie puede usar «Sincronizar FLIT». Lo que ya entró no cambia.',
  flit2: 'Mientras esté apagada, FLITO no lee trámites nuevos de FLIT 2 en este ambiente. Si hay una lectura en curso, termina la página actual y se detiene. Lo que ya entró no cambia y, al encenderla, la lectura sigue donde quedó.',
};

function DialogoApagar({ fuente, onCancelar, onConfirmar, restoreFocusRef }: {
  fuente: FuenteSincronizacion; onCancelar: () => void; onConfirmar: () => void;
  restoreFocusRef: React.RefObject<HTMLElement | null>;
}) {
  const cancelarRef = useRef<HTMLButtonElement>(null);
  // La trampa de foco del modal enfoca el primer control al montar; Cancelar gana un tic después.
  useEffect(() => { const t = setTimeout(() => cancelarRef.current?.focus(), 0); return () => clearTimeout(t); }, []);
  const nombre = NOMBRE_FUENTE[fuente];
  return (
    <FlitModal title={`¿Apagar ${nombre}?`} onClose={onCancelar} restoreFocusRef={restoreFocusRef}>
      <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{CUERPO_APAGAR[fuente]}</p>
      <div className="mt-5 flex flex-wrap justify-end gap-3">
        <button ref={cancelarRef} type="button" className={`${flitBtnSecondary} w-full sm:w-auto`} style={flitBtnSecondaryStyle}
          onClick={onCancelar}>Cancelar</button>
        <button type="button" className={`${flitBtnPrimary} w-full sm:w-auto`} style={flitBtnPrimaryStyle}
          onClick={onConfirmar}>Apagar {nombre}</button>
      </div>
    </FlitModal>
  );
}

// ── Cabecera de cada grupo ──────────────────────────────────────────────────────────────────────

export interface PropsCabeceraFuente {
  fuente: FuenteSincronizacion;
  uso: UsoInterruptores;
  /** Puede mover el interruptor (tiene la función y no se la revocaron). */
  editable: boolean;
  /** Sin la función: estado efectivo de la fuente (`habilitada`); null si no se sabe todavía. */
  efectiva: boolean | null;
  /** id del aviso del motivo, para el aria-describedby del interruptor. */
  idMotivo?: string;
}

const LINEA_MUTED = 'break-words text-[11px] leading-tight';

export function CabeceraFuente({ fuente, uso, editable, efectiva, idMotivo }: PropsCabeceraFuente) {
  const nombre = NOMBRE_FUENTE[fuente];
  const [confirmar, setConfirmar] = useState(false);
  const switchRef = useRef<HTMLButtonElement>(null);
  const idEstado = `sync-estado-texto-${fuente}`;
  const e = uso.estado;
  const inter = e.fase === 'listo' ? e.dato.fuentes.find((f) => f.fuente === fuente) ?? null : null;
  const maestroApagado = e.fase === 'listo' && fuente === 'flit2' && !e.dato.maestroFlit2;
  const ocupado = !!uso.guardando[fuente];

  let control: React.ReactNode = null;
  let textoEstado: string | null = null;
  let linea: React.ReactNode = null;
  if (editable) {
    if (e.fase === 'cargando') {
      control = <span aria-hidden="true" className="inline-block h-6 w-11 animate-pulse rounded-full" style={{ background: 'var(--flit-bg-hover)' }} data-testid={`esqueleto-switch-${fuente}`} />;
    } else if (inter) {
      textoEstado = ocupado ? 'Guardando…' : inter.encendido ? (maestroApagado ? 'Encendida · apagada en el servidor' : 'Encendida') : 'Apagada';
      control = (
        <FlitSwitch ref={switchRef} checked={inter.encendido} ocupado={ocupado} etiqueta={`Recibir trámites de ${nombre}`}
          describedBy={[idEstado, idMotivo].filter(Boolean).join(' ')} testId={`switch-${fuente}`}
          onToggle={(siguiente) => { if (siguiente) uso.cambiar(fuente, true); else setConfirmar(true); }} />
      );
      const qc = quienCuando(inter);
      if (qc) linea = <p className={LINEA_MUTED} style={{ color: 'var(--flit-text-muted)' }} data-testid={`quien-cuando-${fuente}`}>{qc}</p>;
    }
    // error: el hueco queda vacío (no se adivina el valor); la línea de error vive bajo el subtítulo.
  } else if (efectiva !== null) {
    textoEstado = efectiva ? 'Encendida' : 'Apagada';
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{nombre}</h3>
        <div className="flex min-w-0 items-center gap-x-2">
          {control}
          {textoEstado && (
            <span id={idEstado} className="min-w-0 break-words text-sm font-medium" style={{ color: 'var(--flit-text-secondary)' }}
              data-testid={`estado-fuente-${fuente}`} aria-live={editable ? 'polite' : undefined}>
              {!editable && <span className="sr-only">{nombre}: </span>}{textoEstado}
            </span>
          )}
        </div>
      </div>
      {linea}
      {confirmar && (
        <DialogoApagar fuente={fuente} restoreFocusRef={switchRef}
          onCancelar={() => setConfirmar(false)}
          onConfirmar={() => { setConfirmar(false); uso.cambiar(fuente, false); }} />
      )}
    </div>
  );
}
