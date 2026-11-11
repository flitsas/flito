// La tabla del detalle del reporte de costos (rediseño «Esencial + desglose», Épica #13763).
//
// Spec: `docs/ux/flito-reporte-costos-rediseno.md` §3 y los retoques del humano al aprobar la
// maqueta, que mandan. Lo que cambia frente a la tabla de la HU #12539:
//   · El binario compacta/ampliada da paso al panel «Columnas» (`ColumnasReporteCostos`, clave v2).
//   · Grupos: Esencial, Cobro al cliente, Costo de proveedor, Más del trámite y Titular, con un
//     borde de 1 px en la primera celda de cada grupo. Sin fondos de color por grupo.
//   · Trámite y Placa (y la casilla) quedan fijas a la izquierda desde `lg`; las acciones, a la
//     derecha. Por debajo de `lg` nada es fijo, tampoco el encabezado de su grupo.
//   · Acciones: un botón y el ⋮ (`AccionesFilaReporteCostos`).
//   · «Exportar a Excel» sigue en la cabecera de la página (retoque 2), no aquí.
//
// UNA región de scroll, la de `FlitTable` (D-23): nunca un `div.overflow-x-auto` alrededor.

import { cloneElement, Fragment, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import { FlitTable, FlitTh, FlitTr } from '../flit/flitPageKit';
import AccionesFilaReporteCostos from './AccionesFilaReporteCostos';
import ColumnasReporteCostos, { useColumnasVisibles } from './ColumnasReporteCostos';
import { GRUPOS, type Columna, type Contexto, type Grupo } from './definicionColumnasReporteCostos';
import TotalesReporteCostos from './TotalesReporteCostos';
import type { FacturacionTramite } from './tiposFacturacion';
import type { Fila, Reporte } from './tiposReporteCostos';
import type { SiigoEstadoReporte } from '@operaciones/shared-types';

export type { Columna } from './definicionColumnasReporteCostos';

/** Anchos de las fijas: el desplazamiento de cada una es la suma de las anteriores. */
const ANCHO_CASILLA = '2.5rem';
const ANCHO_TRAMITE = '7rem';
const BORDE = '1px solid var(--flit-border-input)';
/** Fondo de tarjeta en las fijas: al desplazar, el contenido no se transparenta. */
const FIJA = 'lg:sticky lg:z-10 bg-flit-card';

/** Izquierda de cada fija; `--rc-izq` vale el ancho de la casilla si la hay, 0 si no. */
const izquierdaDe = (id: string): string | undefined =>
  id === 'tramite' ? 'var(--rc-izq)' : id === 'placa' ? `calc(var(--rc-izq) + ${ANCHO_TRAMITE})` : undefined;

type Decorable = ReactElement<{ className?: string; style?: CSSProperties }>;

/** Añade al `<td>` de la columna el borde de grupo y, si es fija, el `sticky` con su izquierda. */
function decorar(el: ReactElement, c: Columna, inicioDeGrupo: boolean): ReactElement {
  const d = el as Decorable;
  const izquierda = izquierdaDe(c.id);
  const style: CSSProperties = { ...d.props.style };
  if (inicioDeGrupo && c.grupo !== 'fija') style.borderLeft = BORDE;
  if (izquierda) {
    style.left = izquierda;
    if (c.id === 'tramite') { style.minWidth = ANCHO_TRAMITE; style.maxWidth = ANCHO_TRAMITE; }
  }
  const className = `${d.props.className ?? ''} ${izquierda ? FIJA : ''} ${c.id === 'placa' ? 'lg:shadow-[inset_-1px_0_0_var(--flit-border-input)]' : ''}`;
  return cloneElement(d, { className, style });
}

export default function TablaReporteCostos({
  data, cargando, puedeLiquidar, puedeReversar, puedeVerServicios, puedeAceptarDiferencia, enProceso, seleccion, onSeleccion, accionable,
  fichasFe, estadoFeDe, onAbrirDetalle, onLiquidar, onFacturar, onReversar, onSoportes, onServicios, onViajes, onAceptarDiferencia, accionEnvio,
  onPrev, onNext, anunciar,
}: {
  /** `null` solo mientras carga la primera vez. */
  data: Reporte | null;
  /** Cargando: barra con «Cargando trámites…» y 8 filas de esqueleto con las mismas columnas, sin pie. */
  cargando: boolean;
  puedeLiquidar: boolean; puedeReversar: boolean; enProceso: boolean;
  /** `finanzas.servicios_adicionales.ver`. Sin ella la opción «Servicios» NO se pinta. */
  puedeVerServicios: boolean;
  /** `comprobantes.diferencia.aceptar` (HU #12655). Sin ella la opción NO se pinta. */
  puedeAceptarDiferencia: boolean;
  seleccion: Set<string>; onSeleccion: (s: Set<string>) => void;
  /** Sobre qué filas hay alguna acción: solo esas llevan casilla. */
  accionable: (f: Fila) => boolean;
  fichasFe: Map<string, FacturacionTramite>; estadoFeDe: (f: Fila) => SiigoEstadoReporte;
  onAbrirDetalle: (f: Fila) => void;
  onLiquidar: (f: Fila) => void; onFacturar: (f: Fila) => void; onReversar: (f: Fila, motivo: string) => void;
  onSoportes: (f: Fila) => void;
  onViajes: (f: Fila) => void;
  onServicios: (f: Fila) => void;
  onAceptarDiferencia: (f: Fila) => void;
  /** La acción de facturación electrónica de la fila, cuando aplica (HU #11329). */
  accionEnvio: (f: Fila) => ReactNode;
  onPrev: () => void; onNext: () => void;
  /** La región `role="status"` de la página: el cambio de columnas se anuncia por ahí. */
  anunciar: (texto: string) => void;
}) {
  const { ids, visibles, alternar, restablecer } = useColumnasVisibles(anunciar);
  // Esqueleto solo sin filas que enseñar (primera carga, o un filtro que venía vacío). Al recargar
  // con filas, se quedan las de antes y la barra dice «Cargando trámites…»: si se desmontaran, el
  // foco que el kit devuelve al ⋮ tras un diálogo caería en `<body>`.
  const esqueleto = !data || (cargando && data.items.length === 0);
  const filas = esqueleto ? [] : data.items;
  const accionables = filas.filter(accionable);
  const totalPaginas = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const ctx: Contexto = { fichasFe, estadoFeDe, onAbrirDetalle };

  // La fila de grupos solo titula los grupos con alguna columna visible; su `colSpan` sale de ellas.
  const grupos = GRUPOS.map((g) => ({ ...g, n: visibles.filter((c) => c.grupo === g.clave).length })).filter((g) => g.n > 0);
  const inicio = (i: number) => i === 0 || visibles[i - 1].grupo !== visibles[i].grupo;

  const alternarFila = (id: string) => {
    const n = new Set(seleccion);
    if (n.has(id)) n.delete(id); else n.add(id);
    onSeleccion(n);
  };

  const barra = (arriba: boolean) => (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
        {cargando || !data
          ? <span role="status">Cargando trámites…</span>
          : <><strong style={{ color: 'var(--flit-text-primary)' }}>{data.total.toLocaleString('es-CO')}</strong> trámites · página {data.page} de {totalPaginas}</>}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        {arriba && <ColumnasReporteCostos ids={ids} onAlternar={alternar} onRestablecer={restablecer} />}
        <Paginacion page={data?.page ?? 1} totalPaginas={totalPaginas} deshabilitada={cargando || !data} onPrev={onPrev} onNext={onNext} />
      </div>
    </div>
  );

  const varIzq = { '--rc-izq': puedeLiquidar ? ANCHO_CASILLA : '0px' } as CSSProperties;
  const casillaFija = `${FIJA} lg:left-0`;

  return (
    <>
      <div className="mb-3">{barra(true)}</div>
      <div className="text-sm" style={varIzq} aria-busy={cargando || undefined}>
        <FlitTable label="Reporte de costos, detalle">
          <thead>
            <tr>
              {puedeLiquidar && (
                <ThGrupo rowSpan={2} className={`${casillaFija} lg:z-20`} style={{ width: ANCHO_CASILLA, minWidth: ANCHO_CASILLA }}>
                  <input type="checkbox" aria-label="Seleccionar los trámites con acciones de esta página"
                    disabled={filas.length === 0}
                    checked={accionables.length > 0 && accionables.every((f) => seleccion.has(f.tramiteId))}
                    onChange={(e) => onSeleccion(e.target.checked ? new Set(accionables.map((f) => f.tramiteId)) : new Set())} />
                </ThGrupo>
              )}
              {grupos.map((g) => (
                <ThGrupo key={g.clave} scope={g.titulo ? 'colgroup' : undefined} colSpan={g.n} title={g.ayuda}
                  className={g.clave === 'fija' ? 'lg:sticky lg:z-20 lg:shadow-[inset_-1px_0_0_var(--flit-border-input)]' : ''}
                  style={g.clave === 'fija' ? { left: 'var(--rc-izq)' } : { borderLeft: BORDE }}>
                  {g.titulo}
                </ThGrupo>
              ))}
              <ThGrupo rowSpan={2} className="lg:sticky lg:right-0 lg:z-20" style={{ borderLeft: BORDE }}>
                <span className="sr-only">Acciones</span>
              </ThGrupo>
            </tr>
            <FlitTr>
              {visibles.map((c, i) => {
                const izquierda = izquierdaDe(c.id);
                return (
                  <FlitTh key={c.id} center={c.center} estrecha
                    className={`whitespace-nowrap ${izquierda ? 'lg:sticky lg:z-20' : ''} ${c.id === 'placa' ? 'lg:shadow-[inset_-1px_0_0_var(--flit-border-input)]' : ''} ${inicio(i) && c.grupo !== 'fija' ? 'border-l border-[color:var(--flit-border-input)]' : ''} ${c.id === 'tramite' ? 'lg:left-[var(--rc-izq)]' : ''} ${c.id === 'placa' ? 'lg:left-[calc(var(--rc-izq)+7rem)]' : ''}`}>
                    <span title={c.ayuda}>{c.titulo}</span>
                  </FlitTh>
                );
              })}
            </FlitTr>
          </thead>
          <tbody>
            {esqueleto && Array.from({ length: 8 }, (_, k) => (
              <tr key={`esqueleto-${k}`} aria-hidden="true" className="border-t" style={{ borderColor: 'var(--flit-border-soft)' }}>
                {puedeLiquidar && <td className="px-3 py-3" />}
                {visibles.map((c) => (
                  <td key={c.id} className="px-3 py-3"><div className="h-3 w-16 rounded" style={{ background: 'var(--flit-bg-app)' }} /></td>
                ))}
                <td className="px-3 py-3" />
              </tr>
            ))}
            {filas.map((f) => (
              <FlitTr key={f.tramiteId}>
                {puedeLiquidar && (
                  <td className={`px-3 py-2 ${casillaFija}`} style={{ width: ANCHO_CASILLA, minWidth: ANCHO_CASILLA }}>
                    {accionable(f) && (
                      <input type="checkbox" aria-label={`Seleccionar ${f.idFlit}`}
                        checked={seleccion.has(f.tramiteId)} onChange={() => alternarFila(f.tramiteId)} />
                    )}
                  </td>
                )}
                {visibles.map((c, i) => <Fragment key={c.id}>{decorar(c.celda(f, ctx), c, inicio(i))}</Fragment>)}
                <td className="bg-flit-card px-3 py-2 lg:sticky lg:right-0 lg:z-10" style={{ borderLeft: BORDE }}>
                  <AccionesFilaReporteCostos fila={f} puedeLiquidar={puedeLiquidar} puedeReversar={puedeReversar}
                    puedeVerServicios={puedeVerServicios} puedeAceptarDiferencia={puedeAceptarDiferencia} enProceso={enProceso}
                    onLiquidar={() => onLiquidar(f)} onFacturar={() => onFacturar(f)}
                    onReversar={(m) => onReversar(f, m)} onSoportes={() => onSoportes(f)}
                    onServicios={() => onServicios(f)} onViajes={() => onViajes(f)}
                    onAceptarDiferencia={() => onAceptarDiferencia(f)}
                    accionEnvio={accionEnvio(f)} />
                </td>
              </FlitTr>
            ))}
          </tbody>
          {!esqueleto && data && (
            <TotalesReporteCostos columnas={visibles} totales={data.totales} total={data.total} conCasilla={puedeLiquidar} />
          )}
        </FlitTable>
      </div>
      <div className="mt-3">{barra(false)}</div>
    </>
  );
}

/**
 * El `th` de la fila de grupos. `FlitTh` fija `scope="col"` y aquí hace falta `colgroup` (y
 * `rowSpan` en las dos esquinas), así que se compone con los mismos tokens en vez de tocar el kit.
 */
function ThGrupo({ children, scope, colSpan, rowSpan, title, className = '', style }: {
  children?: ReactNode; scope?: 'colgroup'; colSpan?: number; rowSpan?: number; title?: string;
  className?: string; style?: CSSProperties;
}) {
  return (
    <th scope={scope} colSpan={colSpan} rowSpan={rowSpan} title={title}
      className={`px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap ${className}`}
      style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)', borderBottom: BORDE, ...style }}>
      {children}
    </th>
  );
}

/** Anterior / Siguiente a la altura de la barra (h-10), con hover y foco del kit. */
function Paginacion({ page, totalPaginas, deshabilitada, onPrev, onNext }: {
  page: number; totalPaginas: number; deshabilitada: boolean; onPrev: () => void; onNext: () => void;
}) {
  const btn = 'flit-focus inline-flex h-10 items-center rounded-[999px] border bg-flit-card px-4 text-sm font-semibold transition-colors hover:bg-[var(--flit-bg-hover)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-flit-card';
  const estilo = { borderColor: 'var(--flit-border-input)', color: 'var(--flit-blue-text)' } as const;
  return (
    <div className="flex gap-2">
      <button type="button" className={btn} style={estilo} disabled={deshabilitada || page <= 1} onClick={onPrev}>← Anterior</button>
      <button type="button" className={btn} style={estilo} disabled={deshabilitada || page >= totalPaginas} onClick={onNext}>Siguiente →</button>
    </div>
  );
}

export type { Grupo };
