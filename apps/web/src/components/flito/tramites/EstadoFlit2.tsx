// FLITO — Gestión Trámites · estado de la conexión con FLIT 2 (HU #13098, Feature #13060).
// Spec UX: `docs/ux/hu-13098-estado-conexion-flit2.md`. Contrato: `Flit2EstadoConexion`
// (shared-types) de `GET /api/flito/sync/flit2/estado`.
//
// Reglas:
//   · existe solo con `sync.sync.ver_estado`: sin ella ni se pinta ni sale el GET (un 403 se trata
//     igual y detiene el polling);
//   · `alerta` la calcula el servidor: el reloj del cliente no decide los 30 minutos;
//   · refrescos silenciosos (polling, tras «Sincronizar FLIT 2», vuelta a la pestaña): si fallan se
//     conserva el último dato; el estado de error es solo del primer GET o de un [Reintentar];
//   · el aviso es de página (nunca toast) y no lleva botones: la acción ya está en la cabecera;
//   · título de la alerta en `--flit-danger-text` (par oscuro legible), no `-ink` (~2,5:1 en oscuro);
//   · jamás se pinta el `codigo`, el `status` ni el texto del API: cada código tiene su frase.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Flit2EstadoConexion, Flit2EstadoProblema } from '@operaciones/shared-types';
import { ApiError, api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';

const RUTA_ESTADO = '/flito/sync/flit2/estado';
/** La lectura automática corre cada 5 min: con 2 min el aviso llega con ~2 min de retraso máximo. */
const CADA_MS = 2 * 60 * 1000;
const ZONA = 'America/Bogota';

const fmtFechaHora = new Intl.DateTimeFormat('es-CO', {
  timeZone: ZONA, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
});
const fmtDia = new Intl.DateTimeFormat('es-CO', { timeZone: ZONA, day: 'numeric', month: 'short', year: 'numeric' });
const fmtHora = new Intl.DateTimeFormat('es-CO', { timeZone: ZONA, hour: 'numeric', minute: '2-digit' });
/** Clave de día en Bogotá (AAAA-MM-DD) para saber si un instante es de hoy. */
const fmtClaveDia = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' });

function fecha(iso: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fechaHora(iso: string | null): string | null {
  const d = fecha(iso);
  return d ? fmtFechaHora.format(d) : null;
}

/** Hora sola si es de hoy en Bogotá; si no, también el día. */
interface Momento { dia: string | null; hora: string }

function momento(iso: string | null): Momento | null {
  const d = fecha(iso);
  if (!d) return null;
  const hoy = fmtClaveDia.format(new Date()) === fmtClaveDia.format(d);
  return { dia: hoy ? null : fmtDia.format(d), hora: fmtHora.format(d) };
}

const aLas = (m: Momento | null) => (!m ? 'hace poco' : m.dia ? `el ${m.dia} a las ${m.hora}` : `a las ${m.hora}`);
const ALas = (m: Momento | null) => { const t = aLas(m); return t.charAt(0).toUpperCase() + t.slice(1); };
const deLas = (m: Momento | null) => (!m ? 'más reciente' : m.dia ? `del ${m.dia} a las ${m.hora}` : `de las ${m.hora}`);

/** Cierra con punto sin duplicarlo: la hora de es-CO ya termina en «p. m.». */
const fin = (t: string) => (t.endsWith('.') ? t : `${t}.`);

function B({ children }: { children: ReactNode }) {
  return <strong className="font-semibold">{children}</strong>;
}

// ── Hook ────────────────────────────────────────────────────────────────────────────────────────

export type FaseEstadoFlit2 =
  | { fase: 'oculto' }
  | { fase: 'cargando' }
  | { fase: 'error' }
  | { fase: 'listo'; dato: Flit2EstadoConexion };

export interface UsoEstadoFlit2 {
  estado: FaseEstadoFlit2;
  /** GET silencioso: si falla, conserva lo que había. */
  refrescar: () => void;
  /** GET visible (esqueleto → dato o error). Lo usa el [Reintentar] de la cabecera. */
  reintentar: () => void;
}

function esEstado(r: unknown): r is Flit2EstadoConexion {
  const o = r as Partial<Flit2EstadoConexion> | null;
  return !!o && typeof o === 'object' && typeof o.configurado === 'boolean' && typeof o.alerta === 'boolean';
}

export function useEstadoFlit2(): UsoEstadoFlit2 {
  const { hasFuncion } = useAuth();
  const puede = hasFuncion('sync.sync.ver_estado');
  const [estado, setEstado] = useState<FaseEstadoFlit2>(puede ? { fase: 'cargando' } : { fase: 'oculto' });
  const sinPermiso = useRef(!puede);
  const secuencia = useRef(0);

  useEffect(() => { sinPermiso.current = !puede; }, [puede]);

  const cargar = useCallback(async (silencioso: boolean) => {
    if (sinPermiso.current) return;
    const mia = ++secuencia.current;
    try {
      const r = await api.get<Flit2EstadoConexion>(RUTA_ESTADO);
      if (mia !== secuencia.current) return;
      if (esEstado(r)) setEstado({ fase: 'listo', dato: r });
      else if (!silencioso) setEstado({ fase: 'error' });
    } catch (e) {
      if (mia !== secuencia.current) return;
      if (e instanceof ApiError && e.status === 403) {
        sinPermiso.current = true;
        setEstado({ fase: 'oculto' });
      } else if (!silencioso) {
        setEstado({ fase: 'error' });
      }
    }
  }, []);

  const refrescar = useCallback(() => { void cargar(true); }, [cargar]);
  const reintentar = useCallback(() => {
    if (sinPermiso.current) return;
    setEstado({ fase: 'cargando' });
    void cargar(false);
  }, [cargar]);

  useEffect(() => {
    if (!puede) return undefined;
    void cargar(false);
    let timer: ReturnType<typeof setInterval> | null = null;
    const parar = () => { if (timer) { clearInterval(timer); timer = null; } };
    const arrancar = () => { parar(); timer = setInterval(() => { void cargar(true); }, CADA_MS); };
    const alCambiarVisibilidad = () => {
      if (document.visibilityState === 'visible') { void cargar(true); arrancar(); } else parar();
    };
    if (document.visibilityState === 'visible') arrancar();
    document.addEventListener('visibilitychange', alCambiarVisibilidad);
    return () => {
      parar();
      document.removeEventListener('visibilitychange', alCambiarVisibilidad);
      secuencia.current += 1; // descarta respuestas en vuelo tras desmontar
    };
  }, [puede, cargar]);

  return { estado, refrescar, reintentar };
}

// ── Cabecera ────────────────────────────────────────────────────────────────────────────────────

export function LineaEstadoFlit2({ estado }: { estado: UsoEstadoFlit2 }) {
  const e = estado.estado;
  if (e.fase === 'oculto') return null;
  let valor: ReactNode;
  if (e.fase === 'cargando') {
    valor = <div className="mt-0.5 h-3 w-24 animate-pulse rounded sm:ml-auto" style={{ background: 'var(--flit-bg-hover)' }} aria-hidden="true" />;
  } else if (e.fase === 'error') {
    valor = (
      <>
        No se pudo consultar{' '}
        <button type="button" onClick={estado.reintentar} aria-label="Reintentar la consulta del estado de FLIT 2"
          className="flit-focus rounded font-semibold underline-offset-2 transition-colors hover:underline"
          style={{ color: 'var(--flit-blue-text)' }}>
          Reintentar
        </button>
      </>
    );
  } else if (!e.dato.configurado) {
    valor = 'Sin configurar';
  } else if (!e.dato.ultimaExitosaEn) {
    valor = 'Aún sin lecturas';
  } else {
    valor = (
      <>
        {fechaHora(e.dato.ultimaExitosaEn) ?? 'Aún sin lecturas'}
        {e.dato.atrasada && (
          <>
            {' · lectura atrasada'}
            <span className="sr-only"> Quedan trámites por leer; la lectura automática sigue donde quedó.</span>
          </>
        )}
      </>
    );
  }
  return (
    <div className="text-left text-[11px] leading-tight sm:text-right" style={{ color: 'var(--flit-text-muted)' }}
      aria-busy={e.fase === 'cargando' ? true : undefined} data-testid="linea-estado-flit2">
      <div>Última lectura FLIT 2</div>
      <div className="font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>{valor}</div>
    </div>
  );
}

// ── Frases ──────────────────────────────────────────────────────────────────────────────────────

const ACCESO = <B>Acceso a FLIT 2</B>;

/** Frase del problema. Nunca el código ni el texto del API: un código desconocido cae en el genérico. */
export function fraseProblema(p: Flit2EstadoProblema): ReactNode {
  const m = momento(p.en);
  if (p.tipo === 'rechazado') {
    if (p.motivo === 'credenciales') return <>FLIT 2 rechazó el acceso guardado {fin(aLas(m))} Revisa el usuario y la contraseña en {ACCESO}.</>;
    if (p.motivo === 'cambio_clave') {
      return <>FLIT 2 pide cambiar la contraseña del usuario de servicio (aviso {deLas(m)}). Cámbiala en FLIT 2 y guárdala de nuevo en {ACCESO}.</>;
    }
    return <>FLIT 2 rechazó el acceso guardado {fin(aLas(m))} Revísalo en {ACCESO}; «Probar conexión» te dice la causa.</>;
  }
  if (p.tipo === 'bloqueado') {
    const hasta = fecha(p.hasta);
    const h = hasta && hasta.getTime() > Date.now() ? momento(p.hasta) : null;
    if (h) {
      const hastaTxt = h.dia ? `hasta el ${h.dia} a las ${h.hora}` : `hasta las ${h.hora}`;
      return <>FLIT 2 bloqueó el acceso por intentos fallidos {aLas(m)}, {fin(hastaTxt)} FLITO vuelve a leer solo después; no hace falta hacer nada.</>;
    }
    return <>FLIT 2 bloqueó el acceso por intentos fallidos {fin(aLas(m))} FLITO vuelve a intentarlo en la siguiente lectura automática.</>;
  }
  switch (p.codigo) {
    case 'invalid_cursor':
      return <>La lectura {deLas(m)} falló: FLIT 2 no reconoció el punto donde iba la lectura. FLITO no avanza para no perder trámites. Avísale a soporte técnico.</>;
    case 'insufficient_scope':
      return <>La lectura {deLas(m)} falló: el usuario de servicio no tiene permiso para leer trámites en FLIT 2. Pídele a FLIT 2 que lo habilite.</>;
    case 'espera':
      return <>{ALas(m)}, FLIT 2 pidió esperar antes de seguir. La lectura automática continúa donde quedó.</>;
    case 'no_responde':
      return <>{ALas(m)}, FLIT 2 no respondió. FLITO vuelve a intentarlo solo cada pocos minutos.</>;
    case 'flit2_respuesta':
      return <>{ALas(m)}, FLIT 2 respondió de forma inesperada. FLITO vuelve a intentarlo solo; si se repite, avísale a soporte técnico.</>;
    case 'llave_maestra':
    case 'acceso_descifrado':
      return <>{ALas(m)}, el servidor no pudo leer el acceso guardado. Avísale a quien administra el ambiente.</>;
    default:
      return <>La lectura {deLas(m)} falló en FLITO. Se reintenta sola; si se repite, avísale a soporte técnico.</>;
  }
}

function frasePii(n: number): string {
  const cabeza = n === 1
    ? '1 trámite de FLIT 2 llegó sin los datos del comprador: su SOAT y sus impuestos quedan en espera.'
    : `${n} trámites de FLIT 2 llegaron sin los datos del comprador: su SOAT y sus impuestos quedan en espera.`;
  return `${cabeza} Pídele a FLIT 2 que habilite el permiso de datos personales para el usuario de servicio; al habilitarlo, FLITO los vuelve a leer solo.`;
}

// ── Aviso de página ─────────────────────────────────────────────────────────────────────────────

export function AvisoEstadoFlit2({ estado }: { estado: UsoEstadoFlit2 }) {
  const { hasFuncion } = useAuth();
  const e = estado.estado;
  if (e.fase !== 'listo') return null;
  const d = e.dato;
  // Sin configurar nunca hay alerta (AC), aunque llegue marcada por datos viejos.
  const alerta = d.configurado && d.alerta;
  const pii = typeof d.piiEnmascarada?.tramites === 'number' && d.piiEnmascarada.tramites > 0 ? d.piiEnmascarada.tramites : 0;

  let titulo: string | null = null;
  let fechaLinea: string | null = null;
  let cuerpo: ReactNode = null;
  if (!d.configurado) {
    cuerpo = d.motivoSinConfigurar === 'ambiente'
      ? 'FLIT 2 no está configurado en este servidor. Avísale a quien administra el ambiente.'
      : hasFuncion('tramites.flit2.guardar_acceso')
        ? <>FLIT 2 sin configurar: FLITO aún no lee trámites de FLIT 2. Configura el acceso en {ACCESO}.</>
        : 'FLIT 2 sin configurar: FLITO aún no lee trámites de FLIT 2. Pídele a un administrador que configure el acceso.';
  } else if (alerta) {
    titulo = 'FLIT 2 lleva más de 30 minutos sin leer trámites.';
    const ultima = fechaHora(d.ultimaExitosaEn);
    fechaLinea = ultima ? `Última lectura exitosa: ${fin(ultima)}` : 'Todavía no hay ninguna lectura exitosa.';
    cuerpo = d.problema
      ? fraseProblema(d.problema)
      : <>Pulsa <B>Sincronizar FLIT 2</B> para intentarlo ahora; si no lee, revisa {ACCESO}.</>;
  } else if (d.problema) {
    cuerpo = fraseProblema(d.problema);
  }
  if (!cuerpo && pii === 0) return null;

  return (
    <div role={alerta ? 'alert' : 'status'} data-testid="aviso-estado-flit2"
      className="break-words rounded-lg px-3 py-2.5 text-sm"
      style={{ border: '1px solid var(--flit-border-soft)', background: 'var(--flit-bg-card)', color: 'var(--flit-text-primary)' }}>
      {titulo && <p className="font-semibold" style={{ color: 'var(--flit-danger-text)' }}>{titulo}</p>}
      {fechaLinea && <p className="mt-0.5" style={{ color: 'var(--flit-text-secondary)' }}>{fechaLinea}</p>}
      {cuerpo && <p className={titulo ? 'mt-1' : undefined}>{cuerpo}</p>}
      {pii > 0 && (
        <p className={cuerpo ? 'mt-2 border-t pt-2' : undefined} style={cuerpo ? { borderColor: 'var(--flit-border-soft)' } : undefined}>
          {frasePii(pii)}
        </p>
      )}
    </div>
  );
}
