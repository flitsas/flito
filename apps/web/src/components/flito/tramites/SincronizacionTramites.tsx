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
//     texto crudo del API (ni en toast ni en la tarjeta de error de la página).

import { useCallback, useEffect, useState } from 'react';
import type { SyncEstadoFlit1 } from '@operaciones/shared-types';
import { ApiError, api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { FlitCard, flitBtnPrimary, flitBtnPrimaryStyle, flitInp } from '../../flit/flitPageKit';
import { toastError, toastOk } from '../../flit/ToastFlito';
import AccesoFlit2 from './AccesoFlit2';
import { AvisoEstadoFlit2, LineaEstadoFlit2, automaticaActivaFlit2, useEstadoFlit2 } from './EstadoFlit2';
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

  return (
    <FlitCard>
      <section aria-labelledby="sync-titulo" aria-busy={inter.estado.fase === 'cargando' || flit1.fase === 'cargando' ? true : undefined}
        data-testid="seccion-sincronizacion">
        <h2 id="sync-titulo" className="text-base font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Sincronización</h2>
        <p className="mt-1 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
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
      </section>
    </FlitCard>
  );
}
