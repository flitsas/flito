// FLITO — Gestión Trámites · indicador en vivo de la lectura automática de FLIT 2 (HU #13189,
// Feature #13060). Spec UX: `docs/ux/hu-13189-flit2-en-vivo.md` (delta sobre la de la HU #13098).
// Contrato: `Flit2EstadoConexion.automatica` (HU #13188).
//
// Reglas:
//   · la cuenta se corrige con el reloj del servidor: `restante = proximaEn − (Date.now() + desfase)`,
//     con `desfase = generadoEn − hora local al recibir` (lo mide el hook del estado);
//   · `restante ≤ 0` → «en unos segundos»: nunca negativos ni un «0:00» congelado;
//   · el tic de 1 s existe solo si lo visible lleva `m:ss`, y se pausa con la pestaña oculta;
//   · la línea visible es `aria-hidden`: la región viva lleva solo la frase del ESTADO (no cambia con
//     la cuenta) y la hora absoluta va en un sr-only fuera de la región (se lee, no se anuncia);
//   · el punto es estático (sin pulso) y usa tokens `-text`, que tienen par oscuro;
//   · jamás se pinta un código ni el texto del API.

import { useEffect, useState, type ReactNode } from 'react';
import type { Flit2EstadoConexion } from '@operaciones/shared-types';

const ZONA = 'America/Bogota';
const fmtDia = new Intl.DateTimeFormat('es-CO', { timeZone: ZONA, day: 'numeric', month: 'short', year: 'numeric' });
const fmtHora = new Intl.DateTimeFormat('es-CO', { timeZone: ZONA, hour: 'numeric', minute: '2-digit' });
const fmtClaveDia = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' });

function instante(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** «las 9:45 a. m.» si es de hoy en Bogotá; si no, «el 1 oct. 2026 a las 9:45 a. m.». */
function lasHora(t: number): { art: 'las' | 'el'; texto: string } {
  const d = new Date(t);
  const hoy = fmtClaveDia.format(new Date()) === fmtClaveDia.format(d);
  return hoy ? { art: 'las', texto: `las ${fmtHora.format(d)}` } : { art: 'el', texto: `el ${fmtDia.format(d)} a las ${fmtHora.format(d)}` };
}

/** Cierra con punto sin duplicarlo: la hora de es-CO ya termina en «p. m.». */
const fin = (t: string) => (t.endsWith('.') ? t : `${t}.`);

/** `m:ss` con redondeo hacia arriba (0,3 s → 0:01); null si ya venció. */
export function mss(restanteMs: number | null): string | null {
  if (restanteMs === null || restanteMs <= 0) return null;
  const s = Math.ceil(restanteMs / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Milisegundos hasta `objetivo` en el reloj del servidor, recalculados cada segundo mientras `activo`
 * y la pestaña esté visible. null sin objetivo o inactivo (sin tic).
 */
export function useRestante(objetivo: string | null | undefined, desfaseMs: number, activo: boolean): number | null {
  const [ahora, setAhora] = useState(() => Date.now());
  const meta = activo ? instante(objetivo) : null;

  useEffect(() => {
    if (meta === null) return undefined;
    let timer: ReturnType<typeof setInterval> | null = null;
    const parar = () => { if (timer) { clearInterval(timer); timer = null; } };
    const arrancar = () => {
      parar();
      setAhora(Date.now());
      timer = setInterval(() => setAhora(Date.now()), 1000);
    };
    const alCambiar = () => { if (document.visibilityState === 'visible') arrancar(); else parar(); };
    if (document.visibilityState === 'visible') arrancar();
    document.addEventListener('visibilitychange', alCambiar);
    return () => { parar(); document.removeEventListener('visibilitychange', alCambiar); };
  }, [meta]);

  return meta === null ? null : meta - (ahora + desfaseMs);
}

/** Cuenta visible: el `m:ss` con cifras tabulares, o «unos segundos» si ya venció. */
function Cuenta({ restante }: { restante: number | null }) {
  const c = mss(restante);
  return c ? <span className="whitespace-nowrap tabular-nums">{c}</span> : <>unos segundos</>;
}

type Tono = 'blue' | 'muted' | 'danger' | 'warning' | 'success';
const COLOR_PUNTO: Record<Tono, string> = {
  blue: 'var(--flit-blue-text)',
  muted: 'var(--flit-text-muted)',
  danger: 'var(--flit-danger-text)',
  warning: 'var(--flit-warning-text)',
  success: 'var(--flit-success-text)',
};

interface Vista {
  tono: Tono;
  /** La línea visible (aria-hidden). */
  linea: ReactNode;
  /** Frase de la región viva: solo cambia con el estado. */
  anuncio: string;
  /** sr-only fuera de la región viva (hora absoluta de la próxima). */
  lector?: string;
}

/** Tramo de la frecuencia: «cada 5 min», o nada si no da un entero ≥ 1. */
function cada(intervaloMs: number | null): string {
  if (intervaloMs === null) return '';
  const min = Math.round(intervaloMs / 60_000);
  return Number.isFinite(min) && min >= 1 ? ` cada ${min} min` : '';
}

type Caso = 'curso' | 'apagada' | 'rechazado' | 'bloqueado_hasta' | 'bloqueado' | 'lectura' | 'alerta' | 'encendida';

/** Precedencia de la spec (gana la primera que aplique). */
function casoDe(d: Flit2EstadoConexion, hastaBloqueo: number | null): Caso {
  const a = d.automatica;
  if (a.enCurso) return 'curso';
  if (!a.activa) return 'apagada';
  if (d.problema?.tipo === 'rechazado') return 'rechazado';
  if (d.problema?.tipo === 'bloqueado') return hastaBloqueo !== null && hastaBloqueo > Date.now() ? 'bloqueado_hasta' : 'bloqueado';
  if (d.problema?.tipo === 'lectura') return 'lectura';
  if (d.alerta) return 'alerta';
  return 'encendida';
}

const CON_CUENTA: ReadonlySet<Caso> = new Set<Caso>(['bloqueado', 'lectura', 'alerta', 'encendida']);

function lectorProxima(caso: Caso, proxima: number | null, restante: number | null): string | undefined {
  if (!CON_CUENTA.has(caso) || proxima === null) return undefined;
  const sujeto = caso === 'encendida' ? 'Próxima lectura' : 'Nuevo intento';
  if (restante === null || restante <= 0) return `${sujeto} en unos segundos.`;
  const h = lasHora(proxima);
  return fin(h.art === 'las' ? `${sujeto} a ${h.texto}` : `${sujeto} ${h.texto}`);
}

function vistaDe(caso: Caso, d: Flit2EstadoConexion, restante: number | null, hastaBloqueo: number | null): Vista {
  const a = d.automatica;
  const cuenta = <Cuenta restante={restante} />;
  switch (caso) {
    case 'curso':
      return { tono: 'blue', linea: 'Leyendo FLIT 2 ahora…', anuncio: 'Leyendo FLIT 2 ahora.' };
    case 'apagada':
      return { tono: 'muted', linea: 'La lectura automática está apagada en este ambiente', anuncio: 'La lectura automática de FLIT 2 está apagada en este ambiente.' };
    case 'rechazado':
      return {
        tono: 'danger',
        linea: <>Acceso rechazado · revisa <strong className="font-semibold">Acceso a FLIT 2</strong></>,
        anuncio: 'FLIT 2 rechazó el acceso guardado.',
      };
    case 'bloqueado_hasta': {
      const h = lasHora(hastaBloqueo ?? Date.now());
      // «después de las 9:45 a. m.» / «después del 1 oct. 2026 a las 9:45 a. m.» («de» + «el» = «del»).
      const despues = h.art === 'las' ? `después de ${h.texto}` : `después del ${h.texto.slice('el '.length)}`;
      return { tono: 'warning', linea: `Acceso bloqueado · vuelve a leer ${despues}`, anuncio: 'FLIT 2 bloqueó el acceso por un tiempo.' };
    }
    case 'bloqueado':
      return { tono: 'warning', linea: <>Acceso bloqueado · reintenta en {cuenta}</>, anuncio: 'FLIT 2 bloqueó el acceso por un tiempo.' };
    case 'lectura':
      return { tono: 'warning', linea: <>Falló la última lectura · reintenta en {cuenta}</>, anuncio: 'La última lectura de FLIT 2 falló.' };
    case 'alerta':
      return { tono: 'danger', linea: <>Sin leer hace más de 30 min · reintenta en {cuenta}</>, anuncio: 'FLIT 2 lleva más de 30 minutos sin leer.' };
    default:
      return {
        tono: 'success',
        linea: a.proximaEn ? <>Lectura automática{cada(a.intervaloMs)} · próxima en {cuenta}</> : <>Lectura automática{cada(a.intervaloMs)}</>,
        anuncio: 'Lectura automática de FLIT 2 encendida.',
      };
  }
}

/** Tercera línea del bloque «Última lectura FLIT 2». Solo con el estado cargado y configurado. */
export function IndicadorFlit2({ dato, desfaseMs }: { dato: Flit2EstadoConexion; desfaseMs: number }) {
  const hastaBloqueo = dato.problema?.tipo === 'bloqueado' ? instante(dato.problema.hasta) : null;
  const caso = casoDe(dato, hastaBloqueo);
  const proxima = instante(dato.automatica.proximaEn);
  const restante = useRestante(dato.automatica.proximaEn, desfaseMs, CON_CUENTA.has(caso));
  const v = vistaDe(caso, dato, restante, hastaBloqueo);
  const lector = lectorProxima(caso, proxima, restante);
  return (
    <div className="mt-0.5 flex items-baseline gap-1.5 sm:justify-end" style={{ color: 'var(--flit-text-secondary)' }}
      data-testid="indicador-flit2" data-caso={caso}>
      <span aria-hidden="true" className="mt-[3px] inline-block h-2 w-2 shrink-0 self-start rounded-full"
        style={{ background: COLOR_PUNTO[v.tono] }} data-testid="punto-flit2" />
      <span aria-hidden="true" data-testid="texto-indicador-flit2">{v.linea}</span>
      <span role="status" className="sr-only">{v.anuncio}</span>
      {lector && <span className="sr-only">{lector}</span>}
    </div>
  );
}
