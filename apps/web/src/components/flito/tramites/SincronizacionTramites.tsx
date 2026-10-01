// FLITO — Gestión Trámites · sección «Sincronización» (HU #13238, Feature #13236, Épica #12736).
// Spec UX: `docs/ux/flito-tramites-sincronizacion-interruptores.md`. Todo lo de sincronización sale de la
// cabecera de la página y vive aquí, en dos grupos gemelos (FLIT 1 y FLIT 2), lado a lado desde `lg` y
// apilados debajo. Orden de cada grupo: fuente + interruptor + estado · quién/cuándo · línea de estado
// · motivo/aviso · barra de acciones (`mt-auto`, alineada entre grupos).
//
// Reglas:
//   · una sola primaria en toda la zona: «Sincronizar FLIT». «Acceso a FLIT 2» va con peso secundario;
//   · con FLIT 1 apagada «Sincronizar FLIT» queda aria-disabled (enfocable) y describe el motivo; un 409
//     `FUENTE_APAGADA` muestra ese mismo motivo y refresca el estado;
//   · el resultado de sincronizar es un toast de una frase; los errores de la zona nunca pintan el
//     texto crudo del API (ni en toast ni en la tarjeta de error de la página);
//   · acordeón (2.º PR de la HU): contraído en CADA visita (no se recuerda), con un resumen por fuente en la
//     cabecera que no inventa valores mientras carga, y el distintivo de alerta de FLIT 2 con la misma
//     regla de la tarjeta de aviso (`alertaFlit2`). Contraído, el cuerpo no se monta (nada enfocable).

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { SyncEstadoFlit1 } from '@operaciones/shared-types';
import { ApiError, api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import FlitAcordeon from '../../flit/FlitAcordeon';
import { flitBtnPrimary, flitBtnPrimaryStyle, flitInp } from '../../flit/flitPageKit';
import { toastError, toastOk } from '../../flit/ToastFlito';
import AccesoFlit2 from './AccesoFlit2';
import { AvisoEstadoFlit2, LineaEstadoFlit2, alertaFlit2, automaticaActivaFlit2, useEstadoFlit2 } from './EstadoFlit2';
import { CabeceraFuente, FUNCION_CONFIGURAR, useInterruptores } from './InterruptorSincronizacion';

const fechaHora = (iso: string | null) => (iso
  ? new Date(iso).toLocaleString('es-CO', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  : null);
const hace30 = () => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10); };

type FaseFlit1 = { fase: 'cargando' } | { fase: 'error' } | { fase: 'listo'; dato: SyncEstadoFlit1 };

interface RespuestaSincronizar {
  tramitesNuevos?: number; tramitesActualizados?: number;
  companiasFaltantes?: number; organismosSinEmparejar?: number; ultimaSincronizacion?: string;
}

const ID_MOTIVO_1 = 'sync-motivo-flit1';
const ID_MOTIVO_2 = 'sync-motivo-flit2';

const GRUPO = 'flex min-w-0 flex-col gap-3 rounded-lg border p-4';
const ESTILO_GRUPO = { borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-card)' } as const;
const AVISO = 'break-words rounded-lg px-3 py-2.5 text-sm';
const ESTILO_AVISO = { border: '1px solid var(--flit-border-soft)', background: 'var(--flit-bg-card)', color: 'var(--flit-text-primary)' } as const;
const BARRA = 'mt-auto flex flex-wrap items-center justify-end gap-3 pt-1';
const ROTULO = 'text-[11px] leading-tight';

/** Valor de una fuente en el resumen de la cabecera. `null` = la fuente no se muestra (sin permiso). */
type ValorResumen = { tipo: 'cargando' } | { tipo: 'error' } | { tipo: 'valor'; texto: string } | null;

function ResumenFuente({ nombre, valor, alerta = false, testId }: {
  nombre: string; valor: Exclude<ValorResumen, null>; alerta?: boolean; testId: string;
}) {
  const texto = valor.tipo === 'cargando' ? 'Cargando…' : valor.tipo === 'error' ? 'estado no disponible' : valor.texto;
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
      <span data-testid={testId}>
        {nombre}: <span className="font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>{texto}</span>
      </span>
      {alerta && (
        <span className="inline-flex items-center gap-1 font-semibold" style={{ color: 'var(--flit-danger-text)' }}
          data-testid="alerta-resumen-flit2">
          <AlertTriangle aria-hidden="true" size={14} className="shrink-0" />
          Requiere atención
        </span>
      )}
    </span>
  );
}

function Reintentar({ onClick, etiqueta }: { onClick: () => void; etiqueta: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={etiqueta}
      className="flit-focus rounded font-semibold underline-offset-2 transition-colors hover:underline"
      style={{ color: 'var(--flit-blue-text)' }}>
      Reintentar
    </button>
  );
}

export default function SincronizacionTramites({ esOperaciones, onSincronizado }: {
  /** Misma guarda de hoy para «Sincronizar FLIT» (`tramites.solicitud.pedir_soat`). */
  esOperaciones: boolean;
  /** Tras sincronizar: recarga la tabla de la página. */
  onSincronizado: () => void;
}) {
  const { hasFuncion } = useAuth();
  const configura = hasFuncion(FUNCION_CONFIGURAR);
  const visible = configura || esOperaciones || hasFuncion('sync.sync.ver_estado') || hasFuncion('sync.sync.lanzar')
    || hasFuncion('tramites.flit2.ver_acceso');
  const estadoFlit2 = useEstadoFlit2();

  const [flit1, setFlit1] = useState<FaseFlit1>({ fase: 'cargando' });
  const cargarFlit1 = useCallback(async (silencioso: boolean) => {
    if (!silencioso) setFlit1({ fase: 'cargando' });
    try { setFlit1({ fase: 'listo', dato: await api.get<SyncEstadoFlit1>('/flito/sync/estado') }); }
    catch { if (!silencioso) setFlit1({ fase: 'error' }); }
  }, []);
  useEffect(() => { if (visible) void cargarFlit1(false); }, [visible, cargarFlit1]);

  const refrescarFlit2 = estadoFlit2.refrescar;
  const alCambiarInterruptor = useCallback(() => { void cargarFlit1(true); refrescarFlit2(); }, [cargarFlit1, refrescarFlit2]);
  const inter = useInterruptores(configura, alCambiarInterruptor);
  const editable = configura && !inter.revocado;

  const [fechaInicial, setFechaInicial] = useState(hace30);
  const [fechaManual, setFechaManual] = useState(false);
  const [sincronizando, setSincronizando] = useState(false);
  // Contraído en cada visita: el estado vive solo en este montaje (decisión 1 del acordeón).
  const [abierto, setAbierto] = useState(false);

  if (!visible) return null;

  // ── Motivos (se combinan el interruptor y el estado efectivo: converge al refrescar) ──
  const i = inter.estado.fase === 'listo' ? inter.estado.dato : null;
  const i1 = i?.fuentes.find((f) => f.fuente === 'flit1');
  const i2 = i?.fuentes.find((f) => f.fuente === 'flit2');
  const d1 = flit1.fase === 'listo' ? flit1.dato : null;
  const d2 = estadoFlit2.estado.fase === 'listo' ? estadoFlit2.estado.dato : null;
  const apagada1 = (i1 ? !i1.encendido : false) || d1?.habilitada === false;
  const maestro2 = (i ? !i.maestroFlit2 : false) || d2?.motivoDeshabilitada === 'maestro';
  const motivo2 = maestro2 ? 'maestro'
    : ((i2 ? !i2.encendido : false) || d2?.motivoDeshabilitada === 'interruptor') ? 'interruptor' : null;

  // ── Resumen de la cabecera (mismas fuentes de verdad que los grupos) ──
  const porInterruptor = (fila: typeof i1, texto: (x: NonNullable<typeof i1>) => string): ValorResumen => (
    inter.estado.fase === 'cargando' ? { tipo: 'cargando' }
      : fila ? { tipo: 'valor', texto: texto(fila) } : { tipo: 'error' });
  const r1: ValorResumen = configura
    ? porInterruptor(i1, (x) => (x.encendido ? 'Encendida' : 'Apagada'))
    : flit1.fase === 'cargando' ? { tipo: 'cargando' }
      : d1 ? { tipo: 'valor', texto: d1.habilitada ? 'Encendida' : 'Apagada' } : { tipo: 'error' };
  const fase2 = estadoFlit2.estado.fase;
  const r2: ValorResumen = configura
    ? porInterruptor(i2, (x) => (!x.encendido ? 'Apagada' : i && !i.maestroFlit2 ? 'Apagada en el servidor' : 'Encendida'))
    : fase2 === 'oculto' ? null
      : fase2 === 'cargando' ? { tipo: 'cargando' }
        : d2 ? { tipo: 'valor', texto: d2.habilitada ? 'Encendida' : d2.motivoDeshabilitada === 'maestro' ? 'Apagada en el servidor' : 'Apagada' }
          : { tipo: 'error' };
  const alerta2 = alertaFlit2(estadoFlit2, motivo2 !== null);

  const ultimaSync = d1?.ultimaSincronizacion ?? null;
  const primeraVez = d1 !== null && ultimaSync === null;
  const mostrarCampoFecha = primeraVez || fechaManual;

  const sincronizar = async () => {
    if (apagada1) return;
    setSincronizando(true);
    try {
      const cuerpo = mostrarCampoFecha ? { initialDate: fechaInicial } : {};
      const r = await api.post<RespuestaSincronizar>('/flito/sync/sincronizar', cuerpo);
      const faltan = (r.companiasFaltantes ?? 0) + (r.organismosSinEmparejar ?? 0);
      toastOk(`Sincronización lista: ${r.tramitesNuevos ?? 0} nuevos y ${r.tramitesActualizados ?? 0} con cambios.`
        + (faltan > 0 ? ` ${faltan} quedaron sin empresa o sin secretaría.` : ''), { id: 'sync-flit1', duracionMs: 6_000 });
      if (r.ultimaSincronizacion && d1) setFlit1({ fase: 'listo', dato: { ...d1, ultimaSincronizacion: r.ultimaSincronizacion } });
      setFechaManual(false); // tras sincronizar, vuelve a modo incremental
      onSincronizado();
    } catch (e) {
      const cuerpo = e instanceof ApiError ? e.rawDetails as { codigo?: string } | null : null;
      if (e instanceof ApiError && e.status === 409 && cuerpo?.codigo === 'FUENTE_APAGADA') {
        toastError('No se sincronizó: FLIT 1 está apagada en este ambiente.', undefined, { id: 'sync-flit1' });
        if (d1) setFlit1({ fase: 'listo', dato: { ...d1, habilitada: false, motivoDeshabilitada: 'interruptor' } });
        void cargarFlit1(true);
        inter.refrescar();
      } else {
        toastError('No se pudo sincronizar con FLIT 1. Inténtalo de nuevo en unos minutos.', () => { void sincronizar(); }, { id: 'sync-flit1' });
      }
    } finally { setSincronizando(false); }
  };

  let valor1: React.ReactNode;
  if (flit1.fase === 'cargando') {
    valor1 = <span aria-hidden="true" className="mt-1 block h-3 w-32 animate-pulse rounded" style={{ background: 'var(--flit-bg-hover)' }} />;
  } else if (flit1.fase === 'error') {
    valor1 = <>No se pudo consultar · <Reintentar onClick={() => { void cargarFlit1(false); }} etiqueta="Reintentar la consulta del estado de FLIT 1" /></>;
  } else {
    valor1 = fechaHora(ultimaSync) ?? 'Nunca sincronizado';
  }

  const resumen = (
    <span className="flex flex-wrap items-center gap-x-4 gap-y-1" data-testid="resumen-sincronizacion">
      {r1 && <ResumenFuente nombre="FLIT 1" valor={r1} testId="resumen-flit1" />}
      {r2 && <ResumenFuente nombre="FLIT 2" valor={r2} alerta={alerta2} testId="resumen-flit2" />}
    </span>
  );

  return (
    <div data-testid="seccion-sincronizacion"
      aria-busy={inter.estado.fase === 'cargando' || flit1.fase === 'cargando' ? true : undefined}>
      <FlitAcordeon titulo="Sincronización" nivel={2} resumen={resumen} abierto={abierto}
        onToggle={() => setAbierto((v) => !v)} testId="cabecera-sincronizacion">
        <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          Cada fuente trae trámites a FLITO en este ambiente. Apagarla detiene la entrada; lo que ya entró no cambia.
        </p>
        {inter.estado.fase === 'error' && (
          <p role="alert" className="mt-2 text-sm" style={{ color: 'var(--flit-danger-text)' }} data-testid="error-interruptores">
            No se pudo consultar los interruptores de sincronización.{' '}
            <Reintentar onClick={inter.reintentar} etiqueta="Reintentar la consulta de los interruptores de sincronización" />
          </p>
        )}

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* ── FLIT 1 ── */}
          <div className={GRUPO} style={ESTILO_GRUPO} data-testid="grupo-flit1">
            <CabeceraFuente fuente="flit1" uso={inter} editable={editable} idMotivo={apagada1 ? ID_MOTIVO_1 : undefined}
              efectiva={d1 ? d1.habilitada : null} />
            <div className={ROTULO} style={{ color: 'var(--flit-text-muted)' }} data-testid="linea-estado-flit1">
              <div>Última actualización</div>
              <div className="font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>{valor1}</div>
              {primeraVez && esOperaciones && !apagada1 && (
                <p className="mt-1">Elige desde qué fecha traer trámites y pulsa Sincronizar FLIT.</p>
              )}
            </div>
            {apagada1 && (
              <div id={ID_MOTIVO_1} role="status" className={AVISO} style={ESTILO_AVISO} data-testid="motivo-flit1">
                La sincronización con FLIT 1 está apagada desde Sincronización.{' '}
                {editable ? 'Enciéndela con el interruptor para volver a sincronizar.' : 'Pídele a un administrador que la encienda.'}
              </div>
            )}
            {esOperaciones && (
              <div className={BARRA}>
                {!primeraVez && (
                  <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-[999px] px-3 text-xs transition-colors hover:bg-[var(--flit-bg-hover)]"
                    style={{ color: 'var(--flit-text-secondary)' }}>
                    <input type="checkbox" className="flit-focus" checked={fechaManual} onChange={(e) => setFechaManual(e.target.checked)} />
                    Elegir fecha
                  </label>
                )}
                {mostrarCampoFecha && (
                  <label className="flex min-w-0 flex-1 items-center gap-2 text-xs sm:flex-none" style={{ color: 'var(--flit-text-muted)' }}>
                    Desde
                    <input type="date" className={`${flitInp} h-10 min-w-0 flex-1`} value={fechaInicial} max={new Date().toISOString().slice(0, 10)}
                      onChange={(e) => setFechaInicial(e.target.value)} />
                  </label>
                )}
                <button type="button" className={`${flitBtnPrimary} w-full justify-center sm:w-auto`} style={flitBtnPrimaryStyle}
                  disabled={sincronizando || (mostrarCampoFecha && !fechaInicial)}
                  aria-disabled={apagada1 && !sincronizando ? true : undefined}
                  aria-describedby={apagada1 ? ID_MOTIVO_1 : undefined}
                  title={apagada1 ? undefined : mostrarCampoFecha ? 'Sincroniza desde la fecha elegida' : 'Sincroniza desde la última actualización'}
                  onClick={() => { void sincronizar(); }}>
                  {sincronizando ? 'Sincronizando…' : 'Sincronizar FLIT'}
                </button>
              </div>
            )}
          </div>

          {/* ── FLIT 2 ── */}
          <div className={GRUPO} style={ESTILO_GRUPO} data-testid="grupo-flit2">
            <CabeceraFuente fuente="flit2" uso={inter} editable={editable} idMotivo={motivo2 ? ID_MOTIVO_2 : undefined}
              efectiva={d2 ? d2.habilitada : null} />
            <LineaEstadoFlit2 estado={estadoFlit2} />
            {motivo2 && (
              <div id={ID_MOTIVO_2} role="status" className={AVISO} style={ESTILO_AVISO} data-testid="motivo-flit2">
                {motivo2 === 'maestro'
                  ? (editable
                    ? 'La lectura automática de FLIT 2 está apagada en el servidor; este interruptor no tendrá efecto hasta que se encienda allí.'
                    : 'La lectura automática de FLIT 2 está apagada en el servidor de este ambiente. Avísale a quien administra el ambiente.')
                  : (editable
                    ? 'FLIT 2 está apagada: FLITO no lee trámites nuevos de FLIT 2. Al encenderla, la lectura sigue donde quedó.'
                    : 'FLIT 2 está apagada en este ambiente: FLITO no lee trámites nuevos de FLIT 2. Pídele a un administrador que la encienda.')}
              </div>
            )}
            <AvisoEstadoFlit2 estado={estadoFlit2} apagada={motivo2 !== null} />
            <div className={BARRA}>
              <AccesoFlit2 automaticaActiva={automaticaActivaFlit2(estadoFlit2)} onGuardado={estadoFlit2.refrescar}
                claseBoton="w-full justify-center sm:w-auto" />
            </div>
          </div>
        </div>
      </FlitAcordeon>
    </div>
  );
}
