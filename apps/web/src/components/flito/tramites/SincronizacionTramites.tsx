// FLITO — Gestión Trámites · sección «Sincronización» (HU #13238, Feature #13236, Épica #12736).
// Spec UX: `docs/ux/flito-tramites-sincronizacion-interruptores.md`. Todo lo de sincronización sale de la
// cabecera de la página y vive aquí, en dos grupos gemelos (FLIT 1 y FLIT 2), lado a lado desde `lg` y
// apilados debajo. Orden de cada grupo: fuente + interruptor + estado · quién/cuándo · línea de estado
// · motivo/aviso · barra de acciones (`mt-auto`, alineada entre grupos).
//
// Reglas:
//   · HU #13630/#13680: FLIT 1 se lee sola. El grupo dice cuándo leyó y si falló (aviso de página); los
//     parámetros pasan a una modal tras el secundario «Parámetros de lectura», que solo existe con `configurar`
//     (`LecturaFlit1.tsx`). La sección no tiene primaria: «Parámetros de lectura» y «Acceso a FLIT 2» son
//     secundarios gemelos, uno en la barra de cada grupo;
//   · visible con `configurar`, `sync.sync.ver_estado` o `tramites.flit2.ver_acceso` (la función de lanzar
//     la sincronización ya no pinta nada: no hay qué lanzar);
//   · los errores de la zona nunca pintan el texto crudo del API (ni en toast ni en aviso);
//   · acordeón (2.º PR de la HU #13238): contraído en CADA visita (no se recuerda), con un resumen por fuente
//     en la cabecera que no inventa valores mientras carga, y el distintivo «Requiere atención» con la misma
//     regla del aviso de cada grupo. Contraído, el cuerpo no se monta.

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { SyncEstadoFlit1 } from '@operaciones/shared-types';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import FlitAcordeon from '../../flit/FlitAcordeon';
import AccesoFlit2 from './AccesoFlit2';
import { AvisoEstadoFlit2, LineaEstadoFlit2, alertaFlit2, automaticaActivaFlit2, useEstadoFlit2 } from './EstadoFlit2';
import { CabeceraFuente, FUNCION_CONFIGURAR, useInterruptores } from './InterruptorSincronizacion';
import {
  AvisoFalloFlit1, LineaLecturaFlit1, ParametrosLecturaFlit1, Reintentar, falloVigenteFlit1, useEstadoLecturaFlit1,
} from './LecturaFlit1';

type FaseFlit1 = { fase: 'cargando' } | { fase: 'error' } | { fase: 'listo'; dato: SyncEstadoFlit1 };

const ID_MOTIVO_1 = 'sync-motivo-flit1';
const ID_MOTIVO_2 = 'sync-motivo-flit2';

const GRUPO = 'flex min-w-0 flex-col gap-3 rounded-lg border p-4';
const ESTILO_GRUPO = { borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-card)' } as const;
const AVISO = 'break-words rounded-lg px-3 py-2.5 text-sm';
const ESTILO_AVISO = { border: '1px solid var(--flit-border-soft)', background: 'var(--flit-bg-card)', color: 'var(--flit-text-primary)' } as const;
const BARRA = 'mt-auto flex flex-wrap items-center justify-end gap-3 pt-1';

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
          data-testid={`alerta-${testId}`}>
          <AlertTriangle aria-hidden="true" size={14} className="shrink-0" />
          Requiere atención
        </span>
      )}
    </span>
  );
}

export default function SincronizacionTramites() {
  const { hasFuncion } = useAuth();
  const configura = hasFuncion(FUNCION_CONFIGURAR);
  const verEstado = hasFuncion('sync.sync.ver_estado');
  const visible = configura || verEstado || hasFuncion('tramites.flit2.ver_acceso');
  const estadoFlit2 = useEstadoFlit2();
  const lectura1 = useEstadoLecturaFlit1(visible && (configura || verEstado));

  const [flit1, setFlit1] = useState<FaseFlit1>({ fase: 'cargando' });
  const cargarFlit1 = useCallback(async (silencioso: boolean) => {
    if (!silencioso) setFlit1({ fase: 'cargando' });
    try { setFlit1({ fase: 'listo', dato: await api.get<SyncEstadoFlit1>('/flito/sync/estado') }); }
    catch { if (!silencioso) setFlit1({ fase: 'error' }); }
  }, []);
  useEffect(() => { if (visible) void cargarFlit1(false); }, [visible, cargarFlit1]);

  const refrescarFlit2 = estadoFlit2.refrescar;
  const refrescarLectura1 = lectura1.refrescar;
  const alCambiarInterruptor = useCallback(() => { void cargarFlit1(true); refrescarFlit2(); refrescarLectura1(); },
    [cargarFlit1, refrescarFlit2, refrescarLectura1]);
  const inter = useInterruptores(configura, alCambiarInterruptor);
  const editable = configura && !inter.revocado;

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
  const alerta1 = !apagada1 && falloVigenteFlit1(lectura1);

  const resumen = (
    <span className="flex flex-wrap items-center gap-x-4 gap-y-1" data-testid="resumen-sincronizacion">
      {r1 && <ResumenFuente nombre="FLIT 1" valor={r1} alerta={alerta1} testId="resumen-flit1" />}
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
            <LineaLecturaFlit1 uso={lectura1} apagada={apagada1} />
            {apagada1 && (
              <div id={ID_MOTIVO_1} role="status" className={AVISO} style={ESTILO_AVISO} data-testid="motivo-flit1">
                {editable
                  ? 'FLIT 1 está apagada: FLITO no lee trámites de FLIT 1. Enciéndela con el interruptor para que la lectura automática siga.'
                  : 'FLIT 1 está apagada en este ambiente: FLITO no lee trámites de FLIT 1. Pídele a un administrador que la encienda.'}
              </div>
            )}
            <AvisoFalloFlit1 uso={lectura1} apagada={apagada1} />
            {configura && (
              <div className={BARRA}>
                <ParametrosLecturaFlit1 onGuardado={lectura1.refrescar} claseBoton="w-full justify-center sm:w-auto" />
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
