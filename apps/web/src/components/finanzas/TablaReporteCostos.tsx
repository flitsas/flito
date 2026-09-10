// La tabla del detalle del reporte de costos, en tres secciones (HU #12434, CF-16).
//
// La cabecera lleva dos filas: arriba el GRUPO —Identificación, Datos del trámite, Valores— y debajo
// cada columna. Es el Excel de 31 columnas en pantalla, y por eso las dos primeras secciones se
// pueden compactar: quien concilia no necesita el VIN ni el documento del titular en cada fila, y
// quien cierra el mes con el Excel abierto sí. La preferencia se guarda por sección en
// `localStorage`; arranca ampliada (todas las columnas a la vista). Valores no se compacta: es lo
// que se vino a ver.
//
// Las columnas son DATOS (`COLUMNAS`), no JSX suelto: la fila de grupos, la de columnas, cada
// celda y el pie de totales se recorren de la misma lista, así que una columna no puede aparecer
// en la cabecera y faltar en el cuerpo, ni caer bajo un grupo distinto del que declara.

import { Fragment, useState, type CSSProperties, type ReactNode } from 'react';
import StatusChip from '../flit/StatusChip';
import { CeldaFechas, documentoConTipo } from '../flit/columnasComunes';
import { FlitTable, FlitTh, FlitTr, flitInp, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle } from '../flit/flitPageKit';
import CeldaFacturacion from './CeldaFacturacion';
import MarcaSoatConciliado from './MarcaSoatConciliado';
import Monto from './Monto';
import TotalesReporteCostos from './TotalesReporteCostos';
import type { FacturacionTramite } from './tiposFacturacion';
import {
  CONCEPTO, CONCEPTOS_REINTEGRO, CONCEPTOS_SERVICIO, faltaDe, faltaDeSubtotal, faltantes,
  type Fila, type Reporte, type Totales,
} from './tiposReporteCostos';
import type { SiigoEstadoReporte } from '@operaciones/shared-types';

export type Grupo = 'identificacion' | 'datos' | 'valores';

/** Lo que cada celda necesita de la página además de su fila. */
interface Contexto {
  fichasFe: Map<string, FacturacionTramite>;
  estadoFeDe: (f: Fila) => SiigoEstadoReporte;
  onAbrirDetalle: (f: Fila) => void;
}

export interface Columna {
  titulo: string;
  grupo: Grupo;
  /** Sigue a la vista con la sección compactada. Valores lo lleva entero. */
  compacta?: boolean;
  center?: boolean;
  /** La celda ENTERA (`<td>`), para que `CeldaFechas` —que ya es un td— entre sin envolverla. */
  celda: (f: Fila, ctx: Contexto) => ReactNode;
  /** Qué va en el pie de totales bajo esta columna. Sin él, la celda del pie queda vacía. */
  total?: (t: Totales) => ReactNode;
}

const texto = (v: string | null, extra = '') =>
  <td className={`px-4 py-2 whitespace-nowrap ${extra}`}>{v ?? ''}</td>;
const monto = (n: ReactNode, extra?: CSSProperties) =>
  <td className="px-4 py-2 text-right tabular-nums" style={extra}>{n}</td>;
const pie = (n: ReactNode, extra?: CSSProperties) =>
  <span className="font-semibold" style={extra}>{n}</span>;

/** Un subtotal en null se dice con su motivo y con qué falta en el `title` (RN-02), nunca «$ 0». */
function subtotal(f: Fila, v: number | null, conceptos: readonly string[]): ReactNode {
  const { falta, faltan } = faltaDeSubtotal(f, conceptos);
  return <Monto v={v} falta={falta} title={faltan.length ? `Falta: ${faltan.join(', ')}` : undefined} />;
}

const AZUL = { color: 'var(--flit-blue-text)' } as const;

/** En el orden de la HU (AC1). Los títulos son los de RN-08: «Flit», «Línea», «Trámite», «Tipo», «OT». */
export const COLUMNAS: Columna[] = [
  { titulo: 'Empresa', grupo: 'identificacion', compacta: true, celda: (f) => texto(f.empresa) },
  { titulo: 'Flit', grupo: 'identificacion', compacta: true, celda: (f) => texto(f.idFlit, 'font-semibold') },
  { titulo: 'Placa', grupo: 'identificacion', compacta: true, celda: (f) => texto(f.placa, 'font-mono') },
  { titulo: 'VIN', grupo: 'identificacion', celda: (f) => texto(f.vin, 'font-mono text-xs') },
  { titulo: 'Nombres', grupo: 'identificacion', celda: (f) => texto(f.titularNombres) },
  { titulo: 'Apellidos', grupo: 'identificacion', celda: (f) => texto(f.titularApellidos) },
  { titulo: 'Razón social', grupo: 'identificacion', celda: (f) => texto(f.titularRazonSocial) },
  { titulo: 'Tipo', grupo: 'identificacion', celda: (f) => texto(f.titularTipoDocumento) },
  // El código de tipo delante del número lo pone el ayudante que ya usan las otras tres tablas con
  // titular: la regla del null vive allí y solo allí.
  { titulo: 'Documento', grupo: 'identificacion', celda: (f) => texto(f.titularDocumento ? documentoConTipo(f.titularTipoDocumento, f.titularDocumento) : null, 'tabular-nums') },

  { titulo: 'Tipo trámite', grupo: 'datos', compacta: true, celda: (f) => texto(f.tipoTramite) },
  { titulo: 'Marca', grupo: 'datos', celda: (f) => texto(f.marca) },
  { titulo: 'Línea', grupo: 'datos', celda: (f) => texto(f.linea) },
  { titulo: 'OT', grupo: 'datos', compacta: true, celda: (f) => texto(f.organismoNombre) },
  { titulo: 'Estado', grupo: 'datos', compacta: true, celda: (f) => texto(f.estado) },
  { titulo: 'Fechas', grupo: 'datos', compacta: true, celda: (f) => <CeldaFechas creado={f.fechaCreacion} aprobado={f.fechaAprobacion} /> },
  { titulo: 'Mes', grupo: 'datos', celda: (f) => texto(f.mes, 'tabular-nums') },
  { titulo: 'Trimestre', grupo: 'datos', celda: (f) => texto(f.trimestre, 'tabular-nums') },
  {
    titulo: 'Factura DIAN', grupo: 'datos', compacta: true, center: true,
    celda: (f, ctx) => (
      <td className="px-3 py-2 text-center">
        <CeldaFacturacion ficha={ctx.fichasFe.get(f.tramiteId)} estadoFila={ctx.estadoFeDe(f)}
          numeroFila={f.facturaNumero} requiereRevision={f.facturaRequiereRevision}
          onAbrir={() => ctx.onAbrirDetalle(f)} />
      </td>
    ),
  },

  {
    titulo: CONCEPTO.soat, grupo: 'valores', center: true, total: (t) => pie(<Monto v={t.soat} />),
    // SOAT e impuesto nunca entran en `noConfigurados`: no hay tarifa que configurar. Su celda vacía
    // puede ser un pago pendiente, una compañía que los autogestiona o un trámite exento.
    celda: (f) => (
      <td className="px-4 py-2 text-right tabular-nums">
        <Monto v={f.soat} falta={faltaDe(f, CONCEPTO.soat)} />
        {/* Debajo del valor, y solo si está conciliado: el componente no pinta nada cuando no. */}
        <MarcaSoatConciliado conciliado={f.soatConciliado} referencia={f.boletaReferencia} conciliadoEn={f.soatConciliadoEn} />
      </td>
    ),
  },
  { titulo: CONCEPTO.impuesto, grupo: 'valores', center: true, total: (t) => pie(<Monto v={t.impuesto} />), celda: (f) => monto(<Monto v={f.impuesto} falta={faltaDe(f, CONCEPTO.impuesto)} />) },
  // «Trámite» son los PESOS del derecho de tránsito (RN-08); el concepto sigue llamándose «Derecho
  // de tránsito» en los motivos, que es como lo nombra el API.
  { titulo: 'Trámite', grupo: 'valores', center: true, total: (t) => pie(<Monto v={t.derechoTramite} />), celda: (f) => monto(<Monto v={f.derechoTramite} falta={faltaDe(f, CONCEPTO.derecho)} />) },
  { titulo: 'GMF', grupo: 'valores', center: true, total: (t) => pie(<Monto v={t.gmf} />), celda: (f) => monto(<Monto v={f.gmf} />) },
  { titulo: CONCEPTO.logistica, grupo: 'valores', center: true, total: (t) => pie(<Monto v={t.logistica} />), celda: (f) => monto(<Monto v={f.logistica} falta={faltaDe(f, CONCEPTO.logistica)} />) },
  { titulo: 'Total reintegro', grupo: 'valores', center: true, total: (t) => pie(<Monto v={t.totalReintegro} />), celda: (f) => monto(subtotal(f, f.totalReintegro, CONCEPTOS_REINTEGRO)) },
  { titulo: CONCEPTO.digital, grupo: 'valores', center: true, total: (t) => pie(<Monto v={t.tramiteDigital} />), celda: (f) => monto(<Monto v={f.tramiteDigital} falta={faltaDe(f, CONCEPTO.digital)} />) },
  { titulo: 'Servicio', grupo: 'valores', center: true, total: (t) => pie(<Monto v={t.totalServicio} />), celda: (f) => monto(subtotal(f, f.totalServicio, CONCEPTOS_SERVICIO)) },
  { titulo: 'Total', grupo: 'valores', center: true, total: (t) => pie(<Monto v={t.total} />, AZUL), celda: (f) => monto(<Monto v={f.total} negrita />, AZUL) },
  {
    titulo: 'Liquidación', grupo: 'valores',
    celda: (f) => (
      <td className="px-4 py-2 whitespace-nowrap">
        {f.estadoLiquidacion === 'facturado'
          ? <StatusChip tone="success">Facturado</StatusChip>
          : f.sellada
            ? <StatusChip tone="active">Liquidado</StatusChip>
            : <StatusChip tone="draft">Estimado</StatusChip>}
      </td>
    ),
  },
];

const GRUPOS: Array<{ clave: Grupo; titulo: string; compactable: boolean }> = [
  { clave: 'identificacion', titulo: 'Identificación', compactable: true },
  { clave: 'datos', titulo: 'Datos del trámite', compactable: true },
  { clave: 'valores', titulo: 'Valores', compactable: false },
];

const CLAVE_ALMACEN = (g: Grupo) => `flito.reporteCostos.seccion.${g}`;

/** Compacta/ampliada por sección, recordada en `localStorage`. Arranca ampliada (AC1). */
function useSecciones() {
  const [compactas, setCompactas] = useState<Set<Grupo>>(() => {
    const s = new Set<Grupo>();
    try {
      for (const g of GRUPOS) if (localStorage.getItem(CLAVE_ALMACEN(g.clave)) === 'compacta') s.add(g.clave);
    } catch { /* sin almacenamiento (modo privado): arranca ampliada y no se recuerda */ }
    return s;
  });
  const alternar = (g: Grupo) => setCompactas((prev) => {
    const n = new Set(prev);
    if (n.has(g)) n.delete(g); else n.add(g);
    try { localStorage.setItem(CLAVE_ALMACEN(g), n.has(g) ? 'compacta' : 'ampliada'); } catch { /* idem */ }
    return n;
  });
  return { compactas, alternar };
}

export default function TablaReporteCostos({
  data, puedeLiquidar, puedeReversar, enProceso, seleccion, onSeleccion, accionable,
  fichasFe, estadoFeDe, onAbrirDetalle, onLiquidar, onFacturar, onReversar, onSoportes, accionEnvio,
  onPrev, onNext,
}: {
  data: Reporte; puedeLiquidar: boolean; puedeReversar: boolean; enProceso: boolean;
  seleccion: Set<string>; onSeleccion: (s: Set<string>) => void;
  /** Sobre qué filas hay alguna acción: solo esas llevan casilla. */
  accionable: (f: Fila) => boolean;
  fichasFe: Map<string, FacturacionTramite>; estadoFeDe: (f: Fila) => SiigoEstadoReporte;
  onAbrirDetalle: (f: Fila) => void;
  onLiquidar: (f: Fila) => void; onFacturar: (f: Fila) => void; onReversar: (f: Fila, motivo: string) => void;
  onSoportes: (f: Fila) => void;
  /** La acción de facturación electrónica de la fila, cuando aplica (HU #11329). */
  accionEnvio: (f: Fila) => ReactNode;
  onPrev: () => void; onNext: () => void;
}) {
  const { compactas, alternar } = useSecciones();
  const filas = data.items;
  const accionables = filas.filter(accionable);
  const totalPaginas = Math.max(1, Math.ceil(data.total / data.pageSize));
  const ctx: Contexto = { fichasFe, estadoFeDe, onAbrirDetalle };

  // Compactar OCULTA columnas enteras, no las apila: la lista visible es la que recorren las tres
  // filas de la tabla.
  const visibles = COLUMNAS.filter((c) => !compactas.has(c.grupo) || c.compacta);
  const delGrupo = (g: Grupo) => visibles.filter((c) => c.grupo === g).length;

  const alternarFila = (id: string) => {
    const n = new Set(seleccion);
    if (n.has(id)) n.delete(id); else n.add(id);
    onSeleccion(n);
  };

  const paginacion = (
    <Paginacion total={data.total} page={data.page} totalPaginas={totalPaginas} onPrev={onPrev} onNext={onNext} />
  );

  return (
    <>
      <div className="mb-3">{paginacion}</div>
      <div className="overflow-x-auto">
        <FlitTable>
          <thead>
            <tr>
              {puedeLiquidar && (
                <ThGrupo rowSpan={2}>
                  {/* Selecciona TODO lo accionable de la página, no solo lo liquidable: desde la
                      HU #11329 hay dos acciones sobre la selección. */}
                  <input type="checkbox" aria-label="Seleccionar los trámites con acciones de esta página"
                    checked={accionables.length > 0 && accionables.every((f) => seleccion.has(f.tramiteId))}
                    onChange={(e) => onSeleccion(e.target.checked ? new Set(accionables.map((f) => f.tramiteId)) : new Set())} />
                </ThGrupo>
              )}
              {GRUPOS.map((g) => {
                const total = COLUMNAS.filter((c) => c.grupo === g.clave).length;
                const compacta = compactas.has(g.clave);
                return (
                  <ThGrupo key={g.clave} scope="colgroup" colSpan={delGrupo(g.clave)}>
                    <span className="inline-flex items-center gap-2">
                      {g.titulo}
                      {g.compactable && (
                        <>
                          <span className="font-normal normal-case tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>
                            · {delGrupo(g.clave)} de {total}
                          </span>
                          {/* Un botón de texto con `aria-expanded`: controla columnas, no un panel,
                              así que no hay `aria-controls` que apuntar. El foco se queda en él. */}
                          <button type="button" className="flit-focus text-[11px] font-semibold normal-case underline"
                            style={{ color: 'var(--flit-blue-text)' }} aria-expanded={!compacta}
                            onClick={() => alternar(g.clave)}>
                            {compacta ? 'Mostrar todas' : 'Compactar'}
                          </button>
                        </>
                      )}
                    </span>
                  </ThGrupo>
                );
              })}
              <ThGrupo rowSpan={2} />
            </tr>
            <FlitTr>
              {visibles.map((c) => <FlitTh key={c.titulo} center={c.center}>{c.titulo}</FlitTh>)}
            </FlitTr>
          </thead>
          <tbody>
            {filas.map((f) => (
              <FlitTr key={f.tramiteId}>
                {puedeLiquidar && (
                  <td className="px-3 py-2">
                    {/* Sin casilla en las filas sobre las que no hay ninguna acción. No es un
                        hueco: es que ahí no hay nada que marcar. */}
                    {accionable(f) && (
                      <input type="checkbox" aria-label={`Seleccionar ${f.idFlit}`}
                        checked={seleccion.has(f.tramiteId)} onChange={() => alternarFila(f.tramiteId)} />
                    )}
                  </td>
                )}
                {visibles.map((c) => <Fragment key={c.titulo}>{c.celda(f, ctx)}</Fragment>)}
                <td className="px-3 py-2">
                  <Acciones fila={f} puedeLiquidar={puedeLiquidar} puedeReversar={puedeReversar} enProceso={enProceso}
                    onLiquidar={() => onLiquidar(f)} onFacturar={() => onFacturar(f)}
                    onReversar={(m) => onReversar(f, m)} onSoportes={() => onSoportes(f)}
                    accionEnvio={accionEnvio(f)} />
                </td>
              </FlitTr>
            ))}
          </tbody>
          <TotalesReporteCostos columnas={visibles} totales={data.totales} total={data.total} conCasilla={puedeLiquidar} />
        </FlitTable>
      </div>
      <div className="mt-3">{paginacion}</div>
    </>
  );
}

/**
 * El `th` de la fila de grupos. `FlitTh` fija `scope="col"` y aquí hace falta `colgroup` (y
 * `rowSpan` en las dos esquinas), así que se compone con los mismos tokens en vez de tocar el kit.
 */
function ThGrupo({ children, scope, colSpan, rowSpan }: {
  children?: ReactNode; scope?: 'colgroup'; colSpan?: number; rowSpan?: number;
}) {
  return (
    <th scope={scope} colSpan={colSpan} rowSpan={rowSpan}
      className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-wide"
      style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)', borderBottom: '1px solid var(--flit-border-input)' }}>
      {children}
    </th>
  );
}

function Acciones({ fila, puedeLiquidar, puedeReversar, enProceso, onLiquidar, onFacturar, onReversar, onSoportes, accionEnvio }: {
  fila: Fila; puedeLiquidar: boolean; puedeReversar: boolean; enProceso: boolean;
  onLiquidar: () => void; onFacturar: () => void; onReversar: (motivo: string) => void; onSoportes: () => void;
  accionEnvio?: ReactNode;
}) {
  const [reversando, setReversando] = useState(false);
  const [motivo, setMotivo] = useState('');
  // Las tres ausencias bloquean, y se nombran juntas: a quien lee le da igual si lo que falta es una
  // tarifa, un recibo o un pago, lo que necesita saber es qué le impide liquidar.
  const falta = faltantes(fila);
  const bloqueado = falta.length > 0;

  return (
    <div className="flex flex-wrap items-center gap-1">
      <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onSoportes}>Soporte</button>

      {puedeLiquidar && !fila.sellada && (
        <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={enProceso || bloqueado}
          title={bloqueado ? `Falta: ${falta.join(', ')}` : 'Sellar los valores de este trámite'}
          onClick={onLiquidar}>Liquidar</button>
      )}
      {/* Por qué NO se puede liquidar, sin obligar a pasar el ratón por encima del botón. */}
      {puedeLiquidar && !fila.sellada && bloqueado && (
        <span className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>Falta: {falta.join(', ')}</span>
      )}

      {puedeLiquidar && fila.estadoLiquidacion === 'liquidado' && (
        <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={enProceso} onClick={onFacturar}>Facturar</button>
      )}
      {/* Tras facturar ya no se ofrece reversar: los valores quedan congelados de verdad. */}
      {puedeReversar && fila.estadoLiquidacion === 'liquidado' && (
        reversando ? (
          <span className="flex items-center gap-1">
            <input className={`${flitInp} h-8 w-40 text-xs`} placeholder="Motivo del reverso" aria-label="Motivo del reverso"
              value={motivo} onChange={(e) => setMotivo(e.target.value)} />
            <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} disabled={motivo.trim().length < 5 || enProceso}
              onClick={() => { onReversar(motivo.trim()); setReversando(false); setMotivo(''); }}>Confirmar</button>
          </span>
        ) : (
          <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setReversando(true)}>Reversar</button>
        )
      )}

      {/* «Facturar» y «Enviar a facturación» NUNCA coinciden en la misma fila: el primero solo se
          pinta con `liquidado` y el segundo solo con `facturado`. */}
      {accionEnvio}
    </div>
  );
}

export function Paginacion({ total, page, totalPaginas, onPrev, onNext }: {
  total: number; page: number; totalPaginas: number; onPrev: () => void; onNext: () => void;
}) {
  const btn = 'rounded-lg border px-3 py-1.5 text-sm font-semibold disabled:opacity-40';
  const btnStyle = { borderColor: 'var(--flit-border-input)', color: 'var(--flit-blue-text)' } as const;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
        <strong style={{ color: 'var(--flit-text-primary)' }}>{total.toLocaleString('es-CO')}</strong> trámites · página {page} de {totalPaginas}
      </span>
      <div className="flex gap-2">
        <button className={btn} style={btnStyle} disabled={page <= 1} onClick={onPrev}>← Anterior</button>
        <button className={btn} style={btnStyle} disabled={page >= totalPaginas} onClick={onNext}>Siguiente →</button>
      </div>
    </div>
  );
}
