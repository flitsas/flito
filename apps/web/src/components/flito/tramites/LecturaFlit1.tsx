// FLITO — Gestión Trámites · lectura automática de FLIT 1 (HU #13630, Feature #13612, Épica #13576).
// Spec UX: `docs/ux/flito-tramites-sincronizacion-interruptores.md`, sección «Delta HU #13630». Contrato:
// HU #13628 (`GET/PUT /api/flito/sync/flit1/parametros-lectura`, `GET …/flit1/estado-lectura`).
//
// Reglas:
//   · ya no hay nada que lanzar: FLIT 1 se lee sola. El grupo dice cuándo leyó, cuándo vuelve a leer y si
//     la última lectura falló (aviso de página, nunca toast);
//   · el estado lo pide quien tiene `configurar` o `sync.sync.ver_estado`; los parámetros, solo `configurar`
//     (sin ella ni se pintan ni sale el GET). Ninguno de los dos bloquea el interruptor (AC4);
//   · fallo VIGENTE = posterior a la última lectura buena (o sin ninguna) y con FLIT 1 encendida; un fallo
//     superado es una línea muted. Jamás se pinta el código ni el status: cada código tiene su frase;
//   · los rangos salen de `LIMITES_PARAMETROS_LECTURA_FLIT1`, no se escriben a mano. Validación local al salir
//     del campo y al guardar: con errores no sale el PUT y el foco va al primero inválido (AC3);
//   · el borrador vive en el hook, que monta `SincronizacionTramites` fuera del panel del acordeón: contraer
//     y volver a abrir conserva lo escrito.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { LIMITES_PARAMETROS_LECTURA_FLIT1 } from '@operaciones/shared-types';
import type { EstadoLecturaFlit1, ParametrosLecturaFlit1, ParametrosLecturaFlit1Input } from '@operaciones/shared-types';
import { ApiError, api } from '../../../lib/api';
import { flitBtnPrimary, flitBtnPrimaryStyle, flitInp } from '../../flit/flitPageKit';
import { toastError, toastOk } from '../../flit/ToastFlito';
import { ALas, fin, momento, type Momento } from './EstadoFlit2';

const RUTA_ESTADO = '/flito/sync/flit1/estado-lectura';
const RUTA_PARAMETROS = '/flito/sync/flit1/parametros-lectura';
/** Mismo pulso que FLIT 2: un GET silencioso cada 2 min con la pestaña visible. */
const CADA_MS = 2 * 60 * 1000;
const fmtClaveDia = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' });
const hoyBogota = () => fmtClaveDia.format(new Date());

const MUTED = { color: 'var(--flit-text-muted)' } as const;
const VALOR = { color: 'var(--flit-text-secondary)' } as const;
const PELIGRO = { color: 'var(--flit-danger-text)' } as const;
const HUECO = { background: 'var(--flit-bg-hover)' } as const;
const AVISO = 'break-words rounded-lg px-3 py-2.5 text-sm';
const ESTILO_AVISO = { border: '1px solid var(--flit-border-soft)', background: 'var(--flit-bg-card)', color: 'var(--flit-text-primary)' } as const;

/** «hoy a las 3:24 p. m.» / «el 14 oct. 2026 a las 3:24 p. m.». */
const hoyOEl = (m: Momento) => (m.dia ? `el ${m.dia} a las ${m.hora}` : `hoy a las ${m.hora}`);

export function Reintentar({ onClick, etiqueta }: { onClick: () => void; etiqueta: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={etiqueta}
      className="flit-focus rounded font-semibold underline-offset-2 transition-colors hover:underline"
      style={{ color: 'var(--flit-blue-text)' }}>
      Reintentar
    </button>
  );
}

// ── Estado de la lectura ────────────────────────────────────────────────────────────────────────

export type FaseEstadoLectura = { fase: 'oculto' } | { fase: 'cargando' } | { fase: 'error' } | { fase: 'listo'; dato: EstadoLecturaFlit1 };

export interface UsoEstadoLectura {
  estado: FaseEstadoLectura;
  /** GET silencioso: si falla, conserva lo que había. */
  refrescar: () => void;
  /** GET visible (esqueleto → dato o error). */
  reintentar: () => void;
}

export function useEstadoLecturaFlit1(puede: boolean): UsoEstadoLectura {
  const [estado, setEstado] = useState<FaseEstadoLectura>({ fase: 'cargando' });
  const sinPermiso = useRef(!puede);
  const secuencia = useRef(0);
  useEffect(() => { sinPermiso.current = !puede; }, [puede]);

  const cargar = useCallback(async (silencioso: boolean) => {
    if (sinPermiso.current) return;
    const mia = ++secuencia.current;
    try {
      const r = await api.get<EstadoLecturaFlit1>(RUTA_ESTADO);
      if (mia === secuencia.current) setEstado({ fase: 'listo', dato: r });
    } catch (e) {
      if (mia !== secuencia.current) return;
      if (e instanceof ApiError && e.status === 403) { sinPermiso.current = true; setEstado({ fase: 'oculto' }); }
      else if (!silencioso) setEstado({ fase: 'error' });
    }
  }, []);

  useEffect(() => {
    if (!puede) return undefined;
    void cargar(false);
    const siVisible = () => { if (document.visibilityState === 'visible') void cargar(true); };
    const t = window.setInterval(siVisible, CADA_MS);
    document.addEventListener('visibilitychange', siVisible);
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', siVisible); };
  }, [puede, cargar]);

  const refrescar = useCallback(() => { void cargar(true); }, [cargar]);
  const reintentar = useCallback(() => { setEstado({ fase: 'cargando' }); void cargar(false); }, [cargar]);
  return { estado: puede ? estado : { fase: 'oculto' }, refrescar, reintentar };
}

/** El fallo es vigente si no hubo una lectura buena después de él. La regla de la luz la añade `apagada`. */
export function falloVigenteFlit1(uso: UsoEstadoLectura): boolean {
  if (uso.estado.fase !== 'listo') return false;
  const { ultimoFallo, ultimaLecturaBuenaEn } = uso.estado.dato;
  if (!ultimoFallo) return false;
  return !ultimaLecturaBuenaEn || Date.parse(ultimoFallo.en) > Date.parse(ultimaLecturaBuenaEn);
}

/** Frase humana del fallo. El código jamás se pinta. */
export function fraseFalloFlit1(codigo: string, en: string): string {
  const C = ALas(momento(en));
  const http = /^flit1_http_(\d{3})$/.exec(codigo);
  if (http) {
    const s = Number(http[1]);
    if (s === 401 || s === 403) return `${C}, FLIT 1 rechazó el acceso de FLITO. Avísale a quien administra el ambiente: hay que revisar el acceso a FLIT 1.`;
    if (s === 429) return `${C}, FLIT 1 pidió esperar antes de seguir. La lectura automática continúa en la próxima vuelta.`;
    if (s >= 500 && s <= 599) return `${C}, FLIT 1 tuvo un error de su lado. FLITO vuelve a intentarlo solo; si se repite, avísale a soporte técnico.`;
    return `${C}, FLIT 1 no aceptó la lectura. FLITO vuelve a intentarlo solo; si se repite, avísale a soporte técnico.`;
  }
  switch (codigo) {
    case 'flit1_timeout': return `${C}, FLIT 1 no respondió a tiempo. FLITO vuelve a intentarlo solo en la próxima lectura.`;
    case 'flit1_red': return `${C}, FLITO no pudo conectarse con FLIT 1. Vuelve a intentarlo solo; si se repite, avísale a quien administra el ambiente.`;
    case 'flit1_respuesta_invalida': return `${C}, FLIT 1 respondió de forma inesperada. FLITO vuelve a intentarlo solo; si se repite, avísale a soporte técnico.`;
    case 'base_datos': return `${C}, FLITO leyó FLIT 1 pero no pudo guardar lo leído. Se reintenta sola; si se repite, avísale a soporte técnico.`;
    case 'tramites_con_fallo': return 'La última lectura terminó, pero algunos trámites no se pudieron aplicar. Revísalos en la Bitácora; se reintentan en la siguiente lectura y en la lectura nocturna.';
    default: return `${C}, la lectura de FLIT 1 falló en FLITO. Se reintenta sola; si se repite, avísale a soporte técnico.`;
  }
}

function Par({ rotulo, children }: { rotulo: string; children: ReactNode }) {
  return (
    <div className="min-w-0 text-[11px] leading-tight" style={MUTED}>
      <div>{rotulo}</div>
      <div className="font-semibold" style={VALOR}>{children}</div>
    </div>
  );
}

/** «Última lectura» · «Próxima lectura» + líneas muted (vacío útil, fallo superado). */
export function LineaLecturaFlit1({ uso, apagada }: { uso: UsoEstadoLectura; apagada: boolean }) {
  const e = uso.estado;
  if (e.fase === 'oculto') return null;
  if (e.fase === 'error') {
    return (
      <p className="text-[11px] leading-tight" style={MUTED} data-testid="linea-lectura-flit1">
        No se pudo consultar ·{' '}
        <Reintentar onClick={uso.reintentar} etiqueta="Reintentar la consulta del estado de la lectura de FLIT 1" />
      </p>
    );
  }
  const hueco = <span aria-hidden="true" className="mt-1 block h-3 w-28 animate-pulse rounded" style={HUECO} />;
  let ultima: ReactNode = hueco;
  let proxima: ReactNode = hueco;
  let notas: ReactNode = null;
  if (e.fase === 'listo') {
    const d = e.dato;
    const mu = momento(d.ultimaLecturaBuenaEn);
    ultima = mu ? hoyOEl(mu) : 'Aún sin lecturas';
    const mp = momento(d.proximaLecturaPrevistaEn);
    proxima = apagada ? 'Lectura detenida'
      : !mp ? 'En unos minutos'
        : Date.parse(d.proximaLecturaPrevistaEn ?? '') <= Date.now() ? 'En cualquier momento'
          : mp.dia ? `hacia el ${mp.dia} a las ${mp.hora}` : `hacia las ${mp.hora}`;
    const vigente = falloVigenteFlit1(uso);
    const mf = d.ultimoFallo ? momento(d.ultimoFallo.en) : null;
    notas = (
      <>
        {!mu && !apagada && <p>La primera lectura trae los trámites desde la fecha de arranque.</p>}
        {mf && !vigente && <p data-testid="fallo-superado-flit1">Último fallo: {hoyOEl(mf)}, ya leyó bien después.</p>}
        {mf && vigente && apagada && <p data-testid="fallo-superado-flit1">Último fallo: {fin(hoyOEl(mf))}</p>}
      </>
    );
  }
  return (
    <div className="flex flex-col gap-1" data-testid="linea-lectura-flit1">
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <Par rotulo="Última lectura">{ultima}</Par>
        <Par rotulo="Próxima lectura">{proxima}</Par>
      </div>
      {notas && <div className="break-words text-[11px] leading-tight" style={MUTED}>{notas}</div>}
    </div>
  );
}

/** Aviso de página del fallo vigente (nunca toast). Con FLIT 1 apagada gana el aviso de apagada. */
export function AvisoFalloFlit1({ uso, apagada }: { uso: UsoEstadoLectura; apagada: boolean }) {
  if (apagada || !falloVigenteFlit1(uso) || uso.estado.fase !== 'listo' || !uso.estado.dato.ultimoFallo) return null;
  const f = uso.estado.dato.ultimoFallo;
  return (
    <div role="status" className={AVISO} style={ESTILO_AVISO} data-testid="aviso-fallo-flit1">
      <p className="font-semibold" style={PELIGRO}>Falló la última lectura de FLIT 1.</p>
      <p className="mt-0.5">{fraseFalloFlit1(f.codigo, f.en)}</p>
    </div>
  );
}

// ── Parámetros de lectura ───────────────────────────────────────────────────────────────────────

type Campo = 'frecuenciaMinutos' | 'ventanaDias' | 'ventanaNocturnaDias' | 'arranque';
type Numerico = Exclude<Campo, 'arranque'>;
const CAMPOS: readonly Campo[] = ['frecuenciaMinutos', 'ventanaDias', 'ventanaNocturnaDias', 'arranque'];
const NUMERICOS: readonly Numerico[] = ['frecuenciaMinutos', 'ventanaDias', 'ventanaNocturnaDias'];
const L = LIMITES_PARAMETROS_LECTURA_FLIT1;
const VACIO: Record<Numerico, string> = {
  frecuenciaMinutos: 'Escribe la frecuencia en minutos.',
  ventanaDias: 'Escribe la ventana en días.',
  ventanaNocturnaDias: 'Escribe la ventana nocturna en días.',
};
const ETIQUETA: Record<Campo, string> = {
  frecuenciaMinutos: 'Frecuencia (minutos)', ventanaDias: 'Ventana (días)',
  ventanaNocturnaDias: 'Ventana nocturna (días)', arranque: 'Fecha de arranque',
};
const idCampo = (c: Campo) => `flit1-param-${c}`;

type Borrador = Record<Campo, string>;
type Errores = Partial<Record<Campo, string>>;

const aBorrador = (p: ParametrosLecturaFlit1): Borrador => ({
  frecuenciaMinutos: String(p.frecuenciaMinutos), ventanaDias: String(p.ventanaDias),
  ventanaNocturnaDias: String(p.ventanaNocturnaDias), arranque: p.arranque,
});

function validar(b: Borrador, hoy: string): Errores {
  const e: Errores = {};
  for (const c of NUMERICOS) {
    const v = b[c].trim();
    const { min, max } = L[c];
    if (!v) e[c] = VACIO[c];
    else if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) e[c] = `Debe ser un número entero de ${min} a ${max}.`;
  }
  if (!e.ventanaDias && !e.ventanaNocturnaDias && Number(b.ventanaNocturnaDias) < Number(b.ventanaDias)) {
    e.ventanaNocturnaDias = `No puede ser menor que la ventana (${Number(b.ventanaDias)} días).`;
  }
  if (!b.arranque) e.arranque = 'Elige la fecha de arranque.';
  else if (b.arranque > hoy) e.arranque = 'No puede ser una fecha futura.';
  return e;
}

export type FaseParametros = { fase: 'oculto' } | { fase: 'cargando' } | { fase: 'error' } | { fase: 'listo'; dato: ParametrosLecturaFlit1 };

export interface UsoParametrosFlit1 {
  fase: FaseParametros;
  borrador: Borrador;
  errores: Errores;
  sucio: boolean;
  guardando: boolean;
  soloLectura: boolean;
  alertaCampos: boolean;
  cambiar: (c: Campo, v: string) => void;
  salir: (c: Campo) => void;
  guardar: () => void;
  reintentar: () => void;
}

const BORRADOR_VACIO: Borrador = { frecuenciaMinutos: '', ventanaDias: '', ventanaNocturnaDias: '', arranque: '' };

export function useParametrosFlit1(puede: boolean, alGuardar: () => void): UsoParametrosFlit1 {
  const [fase, setFase] = useState<FaseParametros>({ fase: 'cargando' });
  const [borrador, setBorrador] = useState<Borrador>(BORRADOR_VACIO);
  const [errores, setErrores] = useState<Errores>({});
  const [nocturnaTocada, setNocturnaTocada] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [soloLectura, setSoloLectura] = useState(false);
  const [alertaCampos, setAlertaCampos] = useState(false);

  const cargar = useCallback(async () => {
    setFase({ fase: 'cargando' });
    try {
      const r = await api.get<ParametrosLecturaFlit1>(RUTA_PARAMETROS);
      setFase({ fase: 'listo', dato: r });
      setBorrador(aBorrador(r));
      setErrores({});
    } catch { setFase({ fase: 'error' }); }
  }, []);
  useEffect(() => { if (puede) void cargar(); }, [puede, cargar]);

  const vigente = fase.fase === 'listo' ? aBorrador(fase.dato) : null;
  const sucio = !!vigente && CAMPOS.some((c) => vigente[c] !== borrador[c]);

  const cambiar = (c: Campo, v: string) => {
    const nuevo = { ...borrador, [c]: v };
    setBorrador(nuevo);
    setAlertaCampos(false);
    const e = validar(nuevo, hoyBogota());
    setErrores((prev) => {
      const sig = { ...prev };
      if (prev[c]) sig[c] = e[c];
      if (c === 'ventanaDias' && nocturnaTocada) sig.ventanaNocturnaDias = e.ventanaNocturnaDias;
      return sig;
    });
  };
  const salir = (c: Campo) => {
    if (c === 'ventanaNocturnaDias') setNocturnaTocada(true);
    const e = validar(borrador, hoyBogota());
    setErrores((prev) => ({ ...prev, [c]: e[c] }));
  };

  const enfocar = (es: Errores) => {
    const primero = CAMPOS.find((c) => es[c]);
    if (primero) document.getElementById(idCampo(primero))?.focus();
    return !!primero;
  };

  const guardar = async () => {
    if (fase.fase !== 'listo' || guardando || !sucio || soloLectura) return;
    const locales = validar(borrador, hoyBogota());
    setErrores(locales);
    setAlertaCampos(false);
    if (enfocar(locales)) return;
    const cuerpo: ParametrosLecturaFlit1Input = {
      frecuenciaMinutos: Number(borrador.frecuenciaMinutos), ventanaDias: Number(borrador.ventanaDias),
      ventanaNocturnaDias: Number(borrador.ventanaNocturnaDias), arranque: borrador.arranque,
    };
    setGuardando(true);
    try {
      const r = await api.put<ParametrosLecturaFlit1>(RUTA_PARAMETROS, cuerpo);
      setFase({ fase: 'listo', dato: r });
      setBorrador(aBorrador(r));
      setErrores({});
      toastOk('Parámetros de lectura guardados. FLITO los usa desde la próxima lectura.', { id: 'sync-parametros-flit1' });
      alGuardar();
    } catch (e) {
      const det = e instanceof ApiError ? e.rawDetails as { campos?: unknown } | null : null;
      const campos = Array.isArray(det?.campos) ? det.campos.filter((c): c is Campo => CAMPOS.includes(c as Campo)) : [];
      if (e instanceof ApiError && e.status === 400 && campos.length > 0) {
        const es: Errores = {};
        for (const c of campos) es[c] = locales[c] ?? 'Revisa este valor.';
        setErrores(es);
        setAlertaCampos(true);
        enfocar(es);
      } else if (e instanceof ApiError && e.status === 403) {
        setSoloLectura(true);
        toastError('No tienes permiso para cambiar los parámetros de lectura. Pídeselo a un administrador.', undefined, { id: 'sync-parametros-flit1' });
      } else {
        toastError('No se pudieron guardar los parámetros de lectura. Inténtalo de nuevo.', () => { void guardar(); }, { id: 'sync-parametros-flit1' });
      }
    } finally { setGuardando(false); }
  };

  return {
    fase: puede ? fase : { fase: 'oculto' }, borrador, errores, sucio, guardando, soloLectura, alertaCampos,
    cambiar, salir, guardar: () => { void guardar(); }, reintentar: () => { void cargar(); },
  };
}

function Etiqueta({ c }: { c: Campo }) {
  return (
    <label htmlFor={idCampo(c)} className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
      {ETIQUETA[c]}
    </label>
  );
}

const SubTitulo = () => <h4 className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Parámetros de lectura</h4>;
const SEPARADOR = 'border-t pt-3';
const ESTILO_SEPARADOR = { borderColor: 'var(--flit-border-soft)' } as const;
const REJILLA = 'grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2';

/** Bloque «Parámetros de lectura» (solo con `configurar`). Sus hijos van directos al grupo: la barra usa `mt-auto`. */
export function ParametrosLecturaFlit1Form({ uso, barra }: { uso: UsoParametrosFlit1; barra: string }) {
  const f = uso.fase;
  if (f.fase === 'oculto') return null;
  if (f.fase === 'cargando') {
    return (
      <div className={`${SEPARADOR} flex flex-col gap-3`} style={ESTILO_SEPARADOR} aria-busy="true" data-testid="parametros-flit1">
        <SubTitulo />
        <div className={REJILLA}>
          {CAMPOS.map((c) => (
            <div key={c} className="min-w-0">
              <span className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{ETIQUETA[c]}</span>
              <span aria-hidden="true" className="block h-10 w-full animate-pulse rounded-[10px]" style={HUECO} />
            </div>
          ))}
        </div>
        <div className="flex justify-end"><span aria-hidden="true" className="block h-10 w-40 animate-pulse rounded-[999px]" style={HUECO} /></div>
      </div>
    );
  }
  if (f.fase === 'error') {
    return (
      <div className={`${SEPARADOR} flex flex-col gap-2`} style={ESTILO_SEPARADOR} data-testid="parametros-flit1">
        <SubTitulo />
        <p role="alert" className="text-sm" style={PELIGRO}>
          No se pudieron cargar los parámetros de lectura.{' '}
          <Reintentar onClick={uso.reintentar} etiqueta="Reintentar la carga de los parámetros de lectura de FLIT 1" />
        </p>
      </div>
    );
  }

  const d = f.dato;
  const m = momento(d.actualizadoEn);
  const quien = !d.actualizadoEn || !m ? 'Valores por defecto: nadie los ha cambiado en este ambiente.'
    : d.actualizadoPor ? `Cambiados por ${d.actualizadoPor.nombre} ${fin(hoyOEl(m))}` : `Cambiados ${fin(hoyOEl(m))}`;
  const nNoche = /^\d+$/.test(uso.borrador.ventanaNocturnaDias.trim()) ? Number(uso.borrador.ventanaNocturnaDias) : d.ventanaNocturnaDias;
  const ayuda: Record<Campo, string> = {
    frecuenciaMinutos: `Cada cuánto lee FLITO a FLIT 1. De ${L.frecuenciaMinutos.min} a ${L.frecuenciaMinutos.max}.`,
    ventanaDias: `Cuántos días hacia atrás revisa cada lectura. De ${L.ventanaDias.min} a ${L.ventanaDias.max}.`,
    ventanaNocturnaDias: `Cada noche, a las 02:00, FLITO relee los trámites creados en los últimos ${nNoche} días para recoger cambios de trámites más antiguos. De ${L.ventanaNocturnaDias.min} a ${L.ventanaNocturnaDias.max} y no menos que la ventana.`,
    arranque: `FLITO no lee trámites anteriores a esta fecha. Hoy o antes.${d.arranquePorDefecto ? ' Por defecto, un mes antes de hoy.' : ''}`,
  };
  const ro = uso.guardando || uso.soloLectura;
  const inactivo = !uso.sucio || uso.guardando;

  return (
    <>
      <div className={`${SEPARADOR} flex flex-col gap-3`} style={ESTILO_SEPARADOR} data-testid="parametros-flit1">
        <div>
          <SubTitulo />
          <p className="mt-0.5 break-words text-[11px] leading-tight" style={MUTED} data-testid="parametros-flit1-quien">{quien}</p>
          {uso.soloLectura && (
            <p className="mt-0.5 text-[11px] leading-tight" style={MUTED}>Solo lectura: pídele a un administrador si hay que cambiarlos.</p>
          )}
        </div>
        <div className={REJILLA}>
          {CAMPOS.map((c) => {
            const err = uso.errores[c];
            const idAyuda = `${idCampo(c)}-ayuda`;
            const idError = `${idCampo(c)}-error`;
            const numerico = c !== 'arranque';
            return (
              <div key={c} className="min-w-0">
                <Etiqueta c={c} />
                <input id={idCampo(c)} className={`${flitInp} h-10`} value={uso.borrador[c]} readOnly={ro}
                  {...(numerico
                    ? { type: 'number', inputMode: 'numeric' as const, min: L[c].min, max: L[c].max, step: 1 }
                    : { type: 'date', max: hoyBogota() })}
                  aria-invalid={err ? true : undefined}
                  aria-describedby={err ? `${idAyuda} ${idError}` : idAyuda}
                  onChange={(e) => uso.cambiar(c, e.target.value)}
                  onBlur={() => uso.salir(c)} />
                <p id={idAyuda} className="mt-1 text-[11px] leading-tight" style={MUTED}>{ayuda[c]}</p>
                {err && <p id={idError} className="mt-0.5 text-[11px] leading-tight" style={PELIGRO}>{err}</p>}
              </div>
            );
          })}
        </div>
        {uso.alertaCampos && (
          <p role="alert" className="text-sm" style={PELIGRO} data-testid="parametros-flit1-alerta">No se guardó: revisa los campos marcados.</p>
        )}
      </div>
      {!uso.soloLectura && (
        <div className={barra}>
          <span id="flit1-param-sin-cambios" className="sr-only">Cambia un valor para guardar.</span>
          <button type="button" className={`${flitBtnPrimary} w-full justify-center sm:w-auto`} style={flitBtnPrimaryStyle}
            aria-disabled={inactivo ? true : undefined} aria-busy={uso.guardando ? true : undefined}
            aria-describedby={!uso.sucio && !uso.guardando ? 'flit1-param-sin-cambios' : undefined}
            onClick={() => { if (!inactivo) uso.guardar(); }}>
            {uso.guardando ? 'Guardando…' : 'Guardar parámetros'}
          </button>
        </div>
      )}
    </>
  );
}
