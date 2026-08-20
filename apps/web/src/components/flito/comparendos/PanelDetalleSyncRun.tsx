// FLITO — Comparendos · Sincronización: el detalle de una corrida del historial (HU #11636, AC2).
//
// El modal responde tres preguntas que la fila del historial deliberadamente no responde: **sobre
// qué NIT** se corrió, **quién** la lanzó y **qué pasó en cada fuente**. La fila se queda en el
// conteo porque volcar veinte NIT en una celda de una tabla densa es ilegible y es esparcir
// cuasi-PII por una superficie que se mira de pasada (AC1). Aquí sí se listan: quien abre el detalle
// está preguntando exactamente por eso.
//
// ── Lo que este archivo NO reimplementa ─────────────────────────────────────────────────────────
//
// Los contadores, los avisos y la tabla de pasos los pinta `ResultadoSyncComparendos`, que nació en
// un archivo propio en la HU #11635 para esto. El detalle de una corrida es el detalle de una
// corrida, se mire recién lanzada o tres días después; una segunda copia aquí sería cómo se arregla
// el redondeo de una duración en un sitio y no en el otro, o cómo la etiqueta «SIMIT» acaba
// existiendo en una pantalla y no en la otra.
//
// ── Tres decisiones de accesibilidad ────────────────────────────────────────────────────────────
//
//   1. **Sin región viva.** La vista Sincronización tiene UNA (`role="status"`, en
//      `VistaSyncComparendos`) y este modal no monta otra, ni siquiera para su carga o su error. Lo
//      que sitúa a quien usa lector al abrirlo es la trampa de foco de `FlitModal`, no un anuncio.
//      Por eso el esqueleto de aquí no lleva `role="status"` —el de `EsqueletoBloque` sí lo lleva, y
//      por eso tampoco se reutiliza— y el error no lleva `role="alert"`.
//   2. **`restoreFocusRef` al encabezado del historial.** La lista de debajo puede haberse
//      refrescado mientras el modal estaba abierto (el desenlace de una corrida la refresca), así
//      que el botón que lo abrió puede no existir ya: `.focus()` sobre un nodo desmontado no hace
//      nada y el foco se quedaría en `<body>`. Mismo respaldo, y por el mismo motivo, que el panel
//      de detalle del visor (HU #11562, nota QA #63).
//   3. **La cabecera lleva el instante COMPLETO** —«14 de ago de 2026, 15:02»—, no el corto de la
//      tabla: aquí es una frase suelta, sin columna ordenada alrededor que dé el contexto del día
//      (enmienda de UX, decisión 15).
//
// ── `iniciadoPor` es un id, y se queda en un id ─────────────────────────────────────────────────
//
// «Usuario 7» o «—». El contrato entrega `number | null` a propósito y el módulo no tiene directorio
// de usuarios: inventar un nombre —o pedir uno a un endpoint de otro módulo para adornar una fila de
// historial— es peor que el id, porque un nombre equivocado sí se cree.

import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { ComparendosSyncResultado, ComparendosSyncRun } from '@operaciones/shared-types';
import { ApiError, api } from '../../../lib/api';
import FlitModal from '../../flit/FlitModal';
import { flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';
import ResultadoSyncComparendos from './ResultadoSyncComparendos';
import { RUTA_COMPARENDOS } from './bloqueConfigComparendos';
import { SIN_DATO, fechaHoraColombia } from './formato';

const RUTA_RUNS = `${RUTA_COMPARENDOS}/sync/runs`;

/** Quién la lanzó, con lo único que el contrato da. Ver la cabecera. */
export function etiquetaIniciador(iniciadoPor: number | null): string {
  return iniciadoPor === null ? SIN_DATO : `Usuario ${iniciadoPor}`;
}

interface ErrorDetalle {
  texto: string;
  /** El 404 no se reintenta: la corrida no está, y volver a pedirla dará el mismo 404. */
  reintentable: boolean;
}

/**
 * El detalle de la corrida y sus tres estados. No hay «vacío»: una corrida sin pasos es anómala, no
 * un catálogo sin elementos, y eso lo dice `ResultadoSyncComparendos` dentro de su propia tabla.
 *
 * ── UNA petición por corrida abierta, aunque el efecto corra dos veces ──────────────────────────
 *
 * En desarrollo `StrictMode` monta, limpia y vuelve a montar los efectos sobre la MISMA instancia, y
 * un `let vigente` local no lo impide: descarta la respuesta de la primera pasada, pero la petición
 * ya salió. Aquí eso no es «una petición de más en desarrollo»: **cada `GET /sync/runs/:id` escribe
 * una fila de `pii_access_log`** (el `scope_nits` de la corrida y el `nit` de cada paso son datos
 * personales, HU #11511), así que abrir un modal dejaría dos accesos anotados donde hubo uno.
 * Duplicar accesos a datos personales en la bitácora es peor que duplicar una petición: la bitácora
 * existe para poder responder «quién miró qué», y deja de servir en cuanto sus filas no se
 * corresponden con lo que la gente hizo.
 *
 * La guardia es la misma que la hidratación de `useComparendosSync` —una bandera en `ref`, que
 * sobrevive al ciclo de `StrictMode` porque las refs no se recrean—, con una diferencia: aquí la
 * bandera guarda QUÉ se pidió (`runId` + número de intento) y no un simple booleano, para que
 * «Reintentar» siga funcionando y para que la guardia no se coma la petición si algún día este hook
 * deja de ir con `key={runId}` y le cambian la corrida en caliente.
 */
function useDetalleCorrida(runId: string) {
  const [detalle, setDetalle] = useState<ComparendosSyncResultado | null>(null);
  const [error, setError] = useState<ErrorDetalle | null>(null);
  const [intento, setIntento] = useState(0);
  const ctrl = useRef<{ vigente: boolean; pedido: string | null }>({ vigente: true, pedido: null });

  useEffect(() => {
    const c = ctrl.current;
    c.vigente = true;
    const clave = `${runId}#${intento}`;
    // Ya se pidió esto mismo: es la segunda pasada de `StrictMode`. La respuesta de la primera sigue
    // en camino y `vigente` acaba de volver a `true`, así que llegará a su sitio.
    if (c.pedido === clave) return () => { c.vigente = false; };
    c.pedido = clave;

    setDetalle(null);
    setError(null);
    api.get<ComparendosSyncResultado>(`${RUTA_RUNS}/${runId}`)
      .then((r) => { if (c.vigente) setDetalle(r); })
      .catch((e: unknown) => {
        if (!c.vigente) return;
        // Sin eco del mensaje del servidor (decisión 12 de la spec): se ramifica por el estado y el
        // copy es propio. Lo único que el operador necesita saber es si tiene sentido reintentar.
        const noEsta = e instanceof ApiError && e.status === 404;
        setError({
          texto: noEsta
            ? 'Esta corrida ya no está en el historial.'
            : 'No se pudo cargar el detalle de la corrida.',
          reintentable: !noEsta,
        });
      });
    return () => { c.vigente = false; };
  }, [runId, intento]);

  const recargar = useCallback(() => setIntento((i) => i + 1), []);
  return { detalle, error, recargar };
}

interface Props {
  /**
   * La fila que abrió el modal. Da el título, el alcance y el iniciador **antes** de que llegue
   * ninguna respuesta: son los mismos campos que trae el detalle, así que enseñarlos ya —en vez de
   * dejar el modal en blanco medio segundo— no adelanta nada que el servidor no haya dicho.
   */
  fila: ComparendosSyncRun;
  onCerrar: () => void;
  /** Dónde dejar el foco si la fila que abrió el modal ya no está en el DOM. Ver la cabecera. */
  respaldoFocoRef: RefObject<HTMLElement | null>;
}

export default function PanelDetalleSyncRun({ fila, onCerrar, respaldoFocoRef }: Props) {
  const { detalle, error, recargar } = useDetalleCorrida(fila.runId);
  // Manda el detalle cuando llega; mientras tanto, la fila. Son la misma corrida.
  const corrida: ComparendosSyncRun = detalle ?? fila;

  return (
    <FlitModal
      title={`Corrida · ${fechaHoraColombia(corrida.iniciadoEn)}`}
      onClose={onCerrar}
      wide
      restoreFocusRef={respaldoFocoRef}
    >
      <div className="space-y-5">
        <dl className="divide-y divide-[color:var(--flit-border-soft)]">
          <Dato etiqueta="Iniciada por" valor={etiquetaIniciador(corrida.iniciadoPor)} />
          <Dato
            etiqueta="Alcance"
            ayuda="Los NIT sobre los que se consultó."
            valor={<Alcance nits={corrida.scopeNits} />}
          />
        </dl>

        {!detalle && !error && <EsqueletoDetalle />}

        {error && (
          <div className="space-y-3">
            <p className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>{error.texto}</p>
            <div className="flex flex-wrap gap-2">
              {error.reintentable && (
                <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={recargar}>
                  Reintentar
                </button>
              )}
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onCerrar}>
                Cerrar
              </button>
            </div>
          </div>
        )}

        {detalle && (
          // El título cambia porque aquí NO es «el resultado de lo que acabas de lanzar»: puede ser
          // una corrida de hace tres días, o una que sigue en curso. Y de paso deja un solo nombre
          // accesible «Resultado de la corrida» en la vista, que es el de la tarjeta de la consola.
          <ResultadoSyncComparendos resultado={detalle} titulo="Detalle de la corrida" />
        )}
      </div>
    </FlitModal>
  );
}

/**
 * Una fila de la ficha. Copia deliberada del `Dato` del panel del visor, incluido el «Sin dato»
 * para lector: un guion solo se lee como un guion —o no se lee— y quien navega con lector no puede
 * distinguir «no hay dato» de «hay un dato que no se anunció».
 */
function Dato({ etiqueta, valor, ayuda }: { etiqueta: string; valor: ReactNode; ayuda?: string }) {
  const ausente = valor === SIN_DATO;
  return (
    <div className="grid gap-0.5 py-1.5 sm:grid-cols-[11rem_1fr] sm:gap-3">
      <dt className="text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
        {etiqueta}
        {ayuda && (
          <span className="mt-0.5 block text-[11px] font-normal" style={{ color: 'var(--flit-text-muted)' }}>
            {ayuda}
          </span>
        )}
      </dt>
      <dd className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
        {ausente ? <>{SIN_DATO}<span className="sr-only">Sin dato</span></> : valor}
      </dd>
    </div>
  );
}

/**
 * Los NIT del alcance, en fichas y precedidos de su conteo.
 *
 * El conteo va delante y no solo al final porque con un alcance global son decenas de fichas, y
 * «12 NIT» es la respuesta a la pregunta que trae a casi todo el mundo aquí. Cada NIT en su propio
 * nodo —y no en una frase separada por puntos— para que se pueda leer uno a uno con lector y para
 * que ninguno quede partido a mitad al ajustar la línea.
 */
function Alcance({ nits }: { nits: string[] }) {
  if (nits.length === 0) {
    return <>{SIN_DATO}<span className="sr-only">Sin dato</span></>;
  }
  return (
    <div className="space-y-1.5">
      <p>{`${nits.length} NIT`}</p>
      <ul className="flex flex-wrap gap-1.5">
        {nits.map((nit) => (
          <li
            key={nit}
            className="rounded-[999px] border px-2 py-0.5 text-xs"
            style={{ borderColor: 'var(--flit-border-soft)', color: 'var(--flit-text-primary)' }}
          >
            {nit}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Esqueleto del cuerpo. Sin `role="status"`: la vista ya tiene su única región viva y una segunda
 * aquí competiría con ella justo cuando puede estar anunciando el desenlace de otra corrida (ver la
 * cabecera).
 *
 * Lo que la sustituye son dos cosas que no anuncian solas: `aria-busy` sobre el bloque y una línea
 * `sr-only` que dice qué está pasando. Quien recorra el modal la lee; a quien esté escuchando otra
 * cosa no se le interrumpe. Un `aria-label` a secas sobre un `div` sin rol no habría servido: sin
 * rol, ningún lector expone ese nombre.
 */
function EsqueletoDetalle() {
  return (
    <div aria-busy="true" className="space-y-2">
      <p className="sr-only">Cargando el detalle de la corrida…</p>
      <div className="animate-pulse space-y-2 motion-reduce:animate-none">
        {Array.from({ length: 6 }, (_, fila) => (
          <div key={fila} className="h-9" style={{ background: 'var(--flit-border-soft)', borderRadius: 8 }} />
        ))}
      </div>
    </div>
  );
}
