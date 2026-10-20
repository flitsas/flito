// FLITO — Gestión Trámites · estado de la conexión con FLIT 2 (HU #13098, Feature #13060).
// Spec UX: `docs/ux/hu-13098-estado-conexion-flit2.md`. Contrato: `Flit2EstadoConexion`
// (shared-types) de `GET /api/flito/sync/flit2/estado`.
//
// Reglas:
//   · existe solo con `sync.sync.ver_estado`: sin ella ni se pinta ni sale el GET (un 403 se trata
//     igual y detiene el polling);
//   · `alerta` la calcula el servidor (rechazo, bloqueo, avisos con firma rechazada o sin lectura buena
//     en `U = 2 · intervaloMs + 5 min`). El título de la tarjeta dice la causa (Bug #13198, HU #13634):
//     rechazo y bloqueo ganan; el atraso solo si de verdad pasó `U`, medido con el reloj corregido por
//     `automatica.generadoEn`; luego los avisos con firma no válida, el fallo de lectura y un tipo
//     desconocido. La web no fija el umbral: lo saca del pulso (`automatica.intervaloMs`);
//   · HU #13678: el grupo dice solo «Conexión» y «Última actualización» (la más reciente entre
//     `ultimoAvisoEn` y `ultimaExitosaEn`). Sin frecuencia, próxima lectura, cuentas ni reintentos: si
//     no hay conexión, el aviso da el motivo y la acción. Spec:
//     `docs/ux/flito-tramites-sincronizacion-simplificada.md` (sección #13678);
//   · refrescos silenciosos (polling, vuelta a la pestaña, tras guardar el acceso, y el ritmo rápido
//     de la HU #13189: ~10 s tras vencer la cuenta y cada 15 s con una lectura en curso): si fallan se
//     conserva el último dato; el estado de error es solo del primer GET o de un [Reintentar];
//   · HU #13189: sin botón «Sincronizar FLIT 2»; la lectura es automática;
//   · región viva solo en el valor de «Conexión» (cambia pocas veces): el polling no re-anuncia nada;
//   · el aviso es de página (nunca toast) y no lleva botones: la acción ya está en la barra;
//   · título de la alerta en `--flit-danger-text` (par oscuro legible), no `-ink` (~2,5:1 en oscuro);
//   · jamás se pinta el `codigo`, el `status` ni el texto del API: cada código tiene su frase.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Flit2EstadoConexion, Flit2EstadoProblema } from '@operaciones/shared-types';
import { ApiError, api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { PuntoFlit2, conexionFlit2, duracionUmbral, umbralMin, type DetenidaFlit2 } from './IndicadorFlit2';

const RUTA_ESTADO = '/flito/sync/flit2/estado';
/** La lectura automática corre cada 5 min: con 2 min el aviso llega con ~2 min de retraso máximo. */
const CADA_MS = 2 * 60 * 1000;
/** Tras vencer la cuenta, el GET sale ~10 s después (le da tiempo a la lectura a arrancar). */
const TRAS_VENCER_MS = 10_000;
/** Con una lectura en curso, un GET cada 15 s hasta que termine. */
const EN_CURSO_MS = 15_000;
/** Una `proximaEn` vencida hace más de esto ya no acelera el refresco: manda el ciclo de 2 min. */
const VENCIDA_MAX_MS = 60_000;
const ZONA = 'America/Bogota';

const fmtDia = new Intl.DateTimeFormat('es-CO', { timeZone: ZONA, day: 'numeric', month: 'short', year: 'numeric' });
const fmtHora = new Intl.DateTimeFormat('es-CO', { timeZone: ZONA, hour: 'numeric', minute: '2-digit' });
/** Clave de día en Bogotá (AAAA-MM-DD) para saber si un instante es de hoy. */
const fmtClaveDia = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' });

function fecha(iso: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Hora sola si es de hoy en Bogotá; si no, también el día. */
export interface Momento { dia: string | null; hora: string }

export function momento(iso: string | null): Momento | null {
  const d = fecha(iso);
  if (!d) return null;
  const hoy = fmtClaveDia.format(new Date()) === fmtClaveDia.format(d);
  return { dia: hoy ? null : fmtDia.format(d), hora: fmtHora.format(d) };
}

export const aLas = (m: Momento | null) => (!m ? 'hace poco' : m.dia ? `el ${m.dia} a las ${m.hora}` : `a las ${m.hora}`);
export const ALas = (m: Momento | null) => { const t = aLas(m); return t.charAt(0).toUpperCase() + t.slice(1); };

/** Cierra con punto sin duplicarlo: la hora de es-CO ya termina en «p. m.». */
export const fin = (t: string) => (t.endsWith('.') ? t : `${t}.`);

function B({ children }: { children: ReactNode }) {
  return <strong className="font-semibold">{children}</strong>;
}

// ── Hook ────────────────────────────────────────────────────────────────────────────────────────

export type FaseEstadoFlit2 =
  | { fase: 'oculto' }
  | { fase: 'cargando' }
  | { fase: 'error' }
  /** `desfaseMs` = reloj del servidor (`automatica.generadoEn`) − reloj local al recibir. */
  | { fase: 'listo'; dato: Flit2EstadoConexion; desfaseMs: number };

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
      if (esEstado(r)) {
        const servidor = Date.parse(r.automatica?.generadoEn ?? '');
        setEstado({ fase: 'listo', dato: r, desfaseMs: Number.isNaN(servidor) ? 0 : servidor - Date.now() });
      }
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

  // Ritmo rápido (AC4): ~10 s tras vencer la cuenta; cada 15 s mientras una lectura corre. Con la
  // pestaña oculta el GET no sale: al volver, el `visibilitychange` ya consulta.
  const dato = estado.fase === 'listo' ? estado.dato : null;
  const desfaseMs = estado.fase === 'listo' ? estado.desfaseMs : 0;
  useEffect(() => {
    const a = dato?.automatica;
    if (!a) return undefined;
    let espera: number | null = null;
    if (a.enCurso) espera = EN_CURSO_MS;
    else if (a.activa && a.proximaEn) {
      const restante = Date.parse(a.proximaEn) - (Date.now() + desfaseMs);
      if (!Number.isNaN(restante) && restante > -VENCIDA_MAX_MS) espera = Math.max(0, restante) + TRAS_VENCER_MS;
    }
    if (espera === null) return undefined;
    const t = setTimeout(() => { if (document.visibilityState === 'visible') void cargar(true); }, espera);
    return () => clearTimeout(t);
  }, [dato, desfaseMs, cargar]);

  return { estado, refrescar, reintentar };
}

/** Para el toast de «Acceso a FLIT 2»: null si el estado no está (sin permiso, cargando o error). */
export function automaticaActivaFlit2(uso: UsoEstadoFlit2): boolean | null {
  const e = uso.estado;
  return e.fase === 'listo' && typeof e.dato.automatica?.activa === 'boolean' ? e.dato.automatica.activa : null;
}

// ── Cabecera ────────────────────────────────────────────────────────────────────────────────────

const MUTED = { color: 'var(--flit-text-muted)' } as const;
const VALOR = { color: 'var(--flit-text-secondary)' } as const;
const HUECO = { background: 'var(--flit-bg-hover)' } as const;

/** Rótulo + valor, el mismo `Par` del grupo FLIT 1 (`LecturaFlit1.tsx`). */
function Par({ rotulo, testId, children }: { rotulo: string; testId?: string; children: ReactNode }) {
  return (
    <div className="min-w-0 text-[11px] leading-tight" style={MUTED}>
      <div>{rotulo}</div>
      <div className="font-semibold" style={VALOR} data-testid={testId}>{children}</div>
    </div>
  );
}

const PARES = 'flex flex-wrap gap-x-6 gap-y-2';

/** Lo más reciente entre el último aviso y la última lectura buena; null si no hay ninguno. */
function ultimaActualizacion(d: Flit2EstadoConexion): string | null {
  const aviso = fecha(d.ultimoAvisoEn ?? null);
  const lectura = fecha(d.ultimaExitosaEn);
  const max = aviso && lectura ? (aviso > lectura ? aviso : lectura) : aviso ?? lectura;
  if (!max) return null;
  const m = momento(max.toISOString());
  return !m ? null : m.dia ? `el ${m.dia} a las ${m.hora}` : `hoy a las ${m.hora}`;
}

/**
 * Par «Conexión» + «Última actualización» (HU #13678). `detenida` viene de la sección Sincronización
 * (interruptor o maestro) para que «Apagada» coincida con el aviso `motivo-flit2`.
 */
export function LineaEstadoFlit2({ estado, detenida = null }: { estado: UsoEstadoFlit2; detenida?: DetenidaFlit2 }) {
  const e = estado.estado;
  if (e.fase === 'oculto') return null;
  let cuerpo: ReactNode;
  if (e.fase === 'cargando') {
    const hueco = <div className="mt-0.5 h-3 w-28 animate-pulse rounded" style={HUECO} aria-hidden="true" />;
    cuerpo = (
      <div className={PARES}>
        <Par rotulo="Conexión">{hueco}</Par>
        <Par rotulo="Última actualización">{hueco}</Par>
      </div>
    );
  } else if (e.fase === 'error') {
    cuerpo = (
      <div className="font-semibold" style={VALOR}>
        No se pudo consultar ·{' '}
        <button type="button" onClick={estado.reintentar} aria-label="Reintentar la consulta del estado de FLIT 2"
          className="flit-focus rounded font-semibold underline-offset-2 transition-colors hover:underline"
          style={{ color: 'var(--flit-blue-text)' }}>
          Reintentar
        </button>
      </div>
    );
  } else {
    const d = e.dato;
    const conexion = conexionFlit2(d, detenida);
    cuerpo = (
      <div className={PARES}>
        <Par rotulo="Conexión">
          <span className="inline-flex items-center gap-1.5">
            <PuntoFlit2 conexion={conexion} />
            <span role="status" data-testid="conexion-flit2">{conexion}</span>
          </span>
        </Par>
        {/* Sin configurar no se habla de actualizaciones: el aviso da el siguiente paso. */}
        {d.configurado && (
          <Par rotulo="Última actualización" testId="ultima-actualizacion-flit2">{ultimaActualizacion(d) ?? 'Aún sin datos'}</Par>
        )}
      </div>
    );
  }
  return (
    <div className="min-w-0 text-left text-[11px] leading-tight" style={MUTED}
      aria-busy={e.fase === 'cargando' ? true : undefined} data-testid="linea-estado-flit2">
      {cuerpo}
    </div>
  );
}

// ── Motivo y acción ─────────────────────────────────────────────────────────────────────────────

const ACCESO = <B>Acceso a FLIT 2</B>;
const ADMIN = 'Avísale a quien administra el ambiente.';
const SOPORTE = 'Si sigue así, avísale a soporte técnico.';

interface Motivo { motivo: string; accion: ReactNode }

/** Atraso por umbral `U` del pulso; sin intervalo no se afirma un tiempo. */
function motivoAtraso(u: number | null): Motivo {
  return {
    motivo: u === null
      ? 'FLITO no ha leído trámites de FLIT 2 en el tiempo esperado.'
      : `FLITO lleva más de ${duracionUmbral(u)} sin leer trámites de FLIT 2.`,
    accion: <>Revisa {ACCESO}; si el acceso está bien, avísale a quien administra el ambiente.</>,
  };
}

/**
 * Motivo y acción del problema. Nunca el tipo, el código ni el texto del API: un código de lectura
 * desconocido cae en el genérico de lectura, y un tipo desconocido en la frase de reserva.
 */
function motivoProblema(p: Flit2EstadoProblema): Motivo {
  if (p.tipo === 'rechazado') {
    if (p.motivo === 'credenciales') return { motivo: 'FLIT 2 rechazó el usuario y la contraseña guardados.', accion: <>Revísalos en {ACCESO}.</> };
    if (p.motivo === 'cambio_clave') {
      return { motivo: 'FLIT 2 pide cambiar la contraseña del usuario de servicio.', accion: <>Cámbiala en FLIT 2 y guárdala de nuevo en {ACCESO}.</> };
    }
    return { motivo: 'FLIT 2 rechazó el acceso de FLITO.', accion: <>Revisa {ACCESO}; «Probar conexión» te dice la causa.</> };
  }
  if (p.tipo === 'bloqueado') {
    const hasta = fecha(p.hasta);
    const h = hasta && hasta.getTime() > Date.now() ? momento(p.hasta) : null;
    if (h) {
      const hastaTxt = h.dia ? `hasta el ${h.dia} a las ${h.hora}` : `hasta las ${h.hora}`;
      return { motivo: `FLIT 2 bloqueó el acceso por intentos fallidos ${fin(hastaTxt)}`, accion: 'No hace falta hacer nada: FLITO vuelve a leer solo después.' };
    }
    return { motivo: 'FLIT 2 bloqueó el acceso por intentos fallidos.', accion: <>FLITO lo vuelve a intentar solo. Si no se resuelve, revisa {ACCESO}.</> };
  }
  if (p.tipo === 'avisos_firma') {
    return {
      motivo: 'FLIT 2 está enviando avisos con firma no válida y FLITO los rechaza.',
      accion: 'Avísale a quien administra el ambiente: la clave compartida de los avisos debe ser la misma en FLIT 2 y en FLITO.',
    };
  }
  if (p.tipo !== 'lectura') return { motivo: 'Hay un problema con la conexión a FLIT 2.', accion: SOPORTE };
  switch (p.codigo) {
    case 'invalid_cursor':
      return { motivo: 'FLIT 2 no reconoció el punto donde iba la lectura; FLITO no avanza para no perder trámites.', accion: 'Avísale a soporte técnico.' };
    case 'insufficient_scope':
      return { motivo: 'El usuario de servicio no tiene permiso para leer trámites en FLIT 2.', accion: 'Pídele a FLIT 2 que lo habilite.' };
    case 'espera':
      return { motivo: 'FLIT 2 pidió esperar antes de seguir.', accion: 'No hace falta hacer nada: la lectura sigue donde quedó.' };
    case 'no_responde':
      return { motivo: 'FLIT 2 no respondió.', accion: 'FLITO lo vuelve a intentar solo. Si sigue así, avísale a quien administra el ambiente.' };
    case 'flit2_respuesta':
      return { motivo: 'FLIT 2 respondió de forma inesperada.', accion: SOPORTE };
    case 'llave_maestra':
    case 'acceso_descifrado':
      return { motivo: 'El servidor no pudo leer el acceso guardado.', accion: ADMIN };
    default:
      return { motivo: 'Falló la última lectura de FLIT 2 en FLITO.', accion: SOPORTE };
  }
}

/**
 * Motivo de «Sin conexión», con la precedencia del Bug #13198: rechazo y bloqueo ganan; el atraso solo
 * si de verdad pasó `U` (reloj corregido con `desfaseMs`); luego el problema; sin problema, el atraso.
 */
function motivoSinConexion(d: Flit2EstadoConexion, desfaseMs: number): Motivo {
  const p = d.problema;
  if (p?.tipo === 'rechazado' || p?.tipo === 'bloqueado') return motivoProblema(p);
  const u = umbralMin(d.automatica?.intervaloMs);
  const ultima = fecha(d.ultimaExitosaEn);
  if (d.alerta && u !== null && ultima && Date.now() + desfaseMs - ultima.getTime() >= u * 60_000) return motivoAtraso(u);
  return p ? motivoProblema(p) : motivoAtraso(u);
}

/**
 * ¿FLIT 2 está en alerta a la vista? La decide el servidor (rechazo, bloqueo, avisos con firma
 * rechazada o sin lectura buena en `U`); aquí solo se anula con la fuente detenida (AC5) o sin configurar (aunque llegue marcada por
 * datos viejos). Única regla: la usan la tarjeta de aviso y el distintivo de la cabecera del acordeón.
 */
export function alertaFlit2(uso: UsoEstadoFlit2, apagada = false): boolean {
  const e = uso.estado;
  if (e.fase !== 'listo') return false;
  const detenida = apagada || e.dato.habilitada === false;
  return !detenida && e.dato.configurado && e.dato.alerta;
}

function frasePii(n: number): string {
  const cabeza = n === 1
    ? '1 trámite de FLIT 2 llegó sin los datos del comprador: su SOAT y sus impuestos quedan en espera.'
    : `${n} trámites de FLIT 2 llegaron sin los datos del comprador: su SOAT y sus impuestos quedan en espera.`;
  return `${cabeza} Pídele a FLIT 2 que habilite el permiso de datos personales para el usuario de servicio; al habilitarlo, FLITO los vuelve a leer solo.`;
}

// ── Aviso de página ─────────────────────────────────────────────────────────────────────────────

/**
 * `apagada` (HU #13238): la fuente está apagada (interruptor o maestro). El aviso «apagada» lo pinta la
 * sección Sincronización y SUSTITUYE al motivo de conexión; aquí solo queda lo que sigue siendo cierto
 * (sin configurar y el párrafo de PII). Con «Sin conexión» (HU #13678): motivo en la primera línea
 * (`--flit-danger-text` solo con alerta) y la acción en la segunda.
 */
export function AvisoEstadoFlit2({ estado, apagada = false }: { estado: UsoEstadoFlit2; apagada?: boolean }) {
  const { hasFuncion } = useAuth();
  const e = estado.estado;
  if (e.fase !== 'listo') return null;
  const d = e.dato;
  const alerta = alertaFlit2(estado, apagada);
  const pii = typeof d.piiEnmascarada?.tramites === 'number' && d.piiEnmascarada.tramites > 0 ? d.piiEnmascarada.tramites : 0;

  let motivo: Motivo | null = null;
  let cuerpo: ReactNode = null;
  if (!d.configurado) {
    cuerpo = d.motivoSinConfigurar === 'ambiente'
      ? 'FLIT 2 no está configurado en este servidor. Avísale a quien administra el ambiente.'
      : hasFuncion('tramites.flit2.guardar_acceso')
        ? <>FLIT 2 sin configurar: FLITO aún no lee trámites de FLIT 2. Configura el acceso en {ACCESO}.</>
        : 'FLIT 2 sin configurar: FLITO aún no lee trámites de FLIT 2. Pídele a un administrador que configure el acceso.';
  } else if (conexionFlit2(d, apagada ? 'interruptor' : null) === 'Sin conexión') {
    motivo = motivoSinConexion(d, e.desfaseMs);
  }
  const hayTexto = !!motivo || !!cuerpo;
  if (!hayTexto && pii === 0) return null;

  return (
    <div role={alerta ? 'alert' : 'status'} data-testid="aviso-estado-flit2"
      className="break-words rounded-lg px-3 py-2.5 text-sm"
      style={{ border: '1px solid var(--flit-border-soft)', background: 'var(--flit-bg-card)', color: 'var(--flit-text-primary)' }}>
      {motivo && (
        <>
          <p className="font-semibold" style={alerta ? { color: 'var(--flit-danger-text)' } : undefined} data-testid="motivo-conexion-flit2">
            {motivo.motivo}
          </p>
          <p className="mt-0.5" data-testid="accion-conexion-flit2">{motivo.accion}</p>
        </>
      )}
      {cuerpo && <p>{cuerpo}</p>}
      {pii > 0 && (
        <p className={hayTexto ? 'mt-2 border-t pt-2' : undefined} style={hayTexto ? { borderColor: 'var(--flit-border-soft)' } : undefined}>
          {frasePii(pii)}
        </p>
      )}
    </div>
  );
}
