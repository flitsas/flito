// La tabla del detalle del reporte de costos, en tres secciones (HU #12434, CF-16; compacta por
// defecto desde la HU #12537; compacta de NUEVE columnas que cabe en un portátil desde la #12539).
//
// La cabecera lleva dos filas: arriba el GRUPO —Identificación, Datos del trámite, Valores— y debajo
// cada columna. Es el Excel en pantalla, y el Excel no cabe en un portátil: por eso la tabla ARRANCA
// COMPACTA —lo que hace falta para decidir «abro esta fila / liquido / no»— y se amplía con UN solo
// control («Mostrar todas las columnas» / «Compactar columnas») en la línea del conteo. Quien
// concilia no necesita el VIN ni el documento del titular en cada fila; quien quiere todos los campos
// los tiene en el Excel (las 31 columnas de Financiero, HU #12536) o a un clic (las 28 de la
// tabla). La preferencia es una sola clave de `localStorage`; su ausencia —o cualquier valor que no
// sea `todas`— es compacta. Las tres claves por sección de la #12434 se ignoran: no se migran ni se
// borran.
//
// La compacta de la #12537 (12 columnas) medía 1628 px con 10 filas con acciones frente a 1258 px de
// contenedor en 1366×768: seguía habiendo scroll. La de la #12539 recorta a nueve —Empresa, Flit,
// Placa · Aprobación, Factura DIAN · Total reintegro, Servicio, Total, Liquidación— y aprieta lo que
// queda: `px-3` en las celdas de datos (D-21), Empresa con tope y `title` (D-16), el tipo de trámite
// en segundo renglón bajo el Flit (D-17), una sola fecha (D-18) y el rótulo del pie fuera de la
// columna Empresa (D-15). OT, Estado y Creado siguen en la ampliada, en los filtros y en el Excel.
//
// Las columnas son DATOS (`COLUMNAS`), no JSX suelto: la fila de grupos, la de columnas, cada
// celda y el pie de totales se recorren de la misma lista, así que una columna no puede aparecer
// en la cabecera y faltar en el cuerpo, ni caer bajo un grupo distinto del que declara. Una columna
// que en compacta se pinta DISTINTO (Flit con el tipo debajo, Fechas → Aprobación) lo declara con
// `celdaCompacta` / `tituloCompacto` en la misma entrada: sigue siendo una columna, con un solo sitio
// en el orden y un solo `key`.

import { Fragment, useState, type CSSProperties, type ReactNode } from 'react';
import StatusChip from '../flit/StatusChip';
import { CeldaFechas, documentoConTipo, fechaCorta } from '../flit/columnasComunes';
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
  /** Sigue a la vista en la vista compacta (D-14: las 9 que deciden «liquido / no» y caben en 1366). */
  compacta?: boolean;
  center?: boolean;
  /** La celda ENTERA (`<td>`), para que `CeldaFechas` —que ya es un td— entre sin envolverla. */
  celda: (f: Fila, ctx: Contexto) => ReactNode;
  /** Solo si en compacta la columna se pinta distinto (D-17, D-18). Sin él, `celda` en los dos modos. */
  celdaCompacta?: (f: Fila, ctx: Contexto) => ReactNode;
  /** Solo si en compacta la columna se titula distinto («Fechas» → «Aprobación», D-18). */
  tituloCompacto?: string;
  /** Qué va en el pie de totales bajo esta columna. Sin él, la celda del pie queda vacía. */
  total?: (t: Totales) => ReactNode;
}

// `px-3` y no `px-4` en TODAS las celdas de datos, en los dos modos (D-21): un punto menos de
// relleno por lado son ≈ 50 px en nueve columnas, y son los que faltaban para caber en 1366.
const texto = (v: string | null, extra = '') =>
  <td className={`px-3 py-2 whitespace-nowrap ${extra}`}>{v ?? ''}</td>;
const monto = (n: ReactNode, extra?: CSSProperties) =>
  <td className="px-3 py-2 text-right tabular-nums" style={extra}>{n}</td>;
const pie = (n: ReactNode, extra?: CSSProperties) =>
  <span className="font-semibold" style={extra}>{n}</span>;

const SECUNDARIO = { color: 'var(--flit-text-secondary)' } as const;
const TENUE = { color: 'var(--flit-text-muted)' } as const;

/**
 * Un texto con tope de ancho: recorta con puntos suspensivos y deja el entero en el `title` (y en el
 * DOM, que es lo que lee un lector de pantalla). Sin tope, una razón social larga decidía sola si la
 * tabla cabía (D-16). `8rem` y no `9rem`: es la palanca de D-21, aplicada porque en 1280×720 la
 * compacta medía 1192 px frente a 1172 de contenedor (medido con facturadas «Aceptada por la DIAN»
 * con su número, que es lo ancho de verdad). No es enfocable: cero paradas de tabulador nuevas.
 */
const truncado = (v: string | null) =>
  <td className="px-3 py-2 whitespace-nowrap"><span className="block max-w-[8rem] truncate" title={v ?? undefined}>{v ?? ''}</span></td>;

/**
 * En compacta el tipo de trámite va debajo del Flit, como `CeldaTramite` en las otras cinco tablas
 * (D-17); no se reutiliza porque aquella lleva `px-4` y `align-top`, y aquí la fila se alinea al
 * centro como el resto de celdas. El tipo es texto libre de FLIT (hasta 60 caracteres): con tope de
 * `7rem` la columna nunca pasa de 136 px, venga el tipo que venga; el entero queda en el `title`.
 */
const celdaFlitConTipo = (f: Fila) => (
  <td className="px-3 py-2 whitespace-nowrap">
    <div className="font-semibold tabular-nums">{f.idFlit ?? ''}</div>
    <div className="max-w-[7rem] truncate text-xs" style={SECUNDARIO} title={f.tipoTramite ?? undefined}>{f.tipoTramite ?? ''}</div>
  </td>
);

/** Una sola fecha en compacta (D-18): la de aprobación, que es la que define el periodo. */
const celdaAprobacion = (f: Fila) => (
  <td className="px-3 py-2 text-xs whitespace-nowrap" style={SECUNDARIO}>
    {f.fechaAprobacion
      ? fechaCorta(f.fechaAprobacion)
      : <span className="italic" style={TENUE}>Sin aprobar</span>}
  </td>
);

/** Un subtotal en null se dice con su motivo y con qué falta en el `title` (RN-02), nunca «$ 0». */
function subtotal(f: Fila, v: number | null, conceptos: readonly string[]): ReactNode {
  const { falta, faltan } = faltaDeSubtotal(f, conceptos);
  return <Monto v={v} falta={falta} title={faltan.length ? `Falta: ${faltan.join(', ')}` : undefined} />;
}

const AZUL = { color: 'var(--flit-blue-text)' } as const;

/** En el orden de la HU (AC1). Los títulos son los de RN-08: «Flit», «Línea», «Trámite», «Tipo», «OT». */
export const COLUMNAS: Columna[] = [
  { titulo: 'Empresa', grupo: 'identificacion', compacta: true, celda: (f) => truncado(f.empresa) },
  { titulo: 'Flit', grupo: 'identificacion', compacta: true, celda: (f) => texto(f.idFlit, 'font-semibold tabular-nums'), celdaCompacta: celdaFlitConTipo },
  { titulo: 'Placa', grupo: 'identificacion', compacta: true, celda: (f) => texto(f.placa, 'font-mono') },
  { titulo: 'VIN', grupo: 'identificacion', celda: (f) => texto(f.vin, 'font-mono text-xs') },
  { titulo: 'Nombres', grupo: 'identificacion', celda: (f) => texto(f.titularNombres) },
  { titulo: 'Apellidos', grupo: 'identificacion', celda: (f) => texto(f.titularApellidos) },
  { titulo: 'Razón social', grupo: 'identificacion', celda: (f) => texto(f.titularRazonSocial) },
  { titulo: 'Tipo', grupo: 'identificacion', celda: (f) => texto(f.titularTipoDocumento) },
  // El código de tipo delante del número lo pone el ayudante que ya usan las otras tres tablas con
  // titular: la regla del null vive allí y solo allí.
  { titulo: 'Documento', grupo: 'identificacion', celda: (f) => texto(f.titularDocumento ? documentoConTipo(f.titularTipoDocumento, f.titularDocumento) : null, 'tabular-nums') },

  // En compacta el tipo va bajo el Flit (D-17); OT y Estado se callan (D-19, D-20): la OT es
  // contexto, no decide «liquido / no», y el estado lo acota el filtro (Aprobado por defecto).
  { titulo: 'Tipo trámite', grupo: 'datos', celda: (f) => texto(f.tipoTramite) },
  { titulo: 'Marca', grupo: 'datos', celda: (f) => texto(f.marca) },
  { titulo: 'Línea', grupo: 'datos', celda: (f) => texto(f.linea) },
  { titulo: 'OT', grupo: 'datos', celda: (f) => texto(f.organismoNombre) },
  { titulo: 'Estado', grupo: 'datos', celda: (f) => texto(f.estado) },
  {
    titulo: 'Fechas', grupo: 'datos', compacta: true, tituloCompacto: 'Aprobación',
    celda: (f) => <CeldaFechas creado={f.fechaCreacion} aprobado={f.fechaAprobacion} />,
    celdaCompacta: celdaAprobacion,
  },
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
      <td className="px-3 py-2 text-right tabular-nums">
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
  { titulo: 'Total reintegro', grupo: 'valores', compacta: true, center: true, total: (t) => pie(<Monto v={t.totalReintegro} />), celda: (f) => monto(subtotal(f, f.totalReintegro, CONCEPTOS_REINTEGRO)) },
  { titulo: CONCEPTO.digital, grupo: 'valores', center: true, total: (t) => pie(<Monto v={t.tramiteDigital} />), celda: (f) => monto(<Monto v={f.tramiteDigital} falta={faltaDe(f, CONCEPTO.digital)} />) },
  { titulo: 'Servicio', grupo: 'valores', compacta: true, center: true, total: (t) => pie(<Monto v={t.totalServicio} />), celda: (f) => monto(subtotal(f, f.totalServicio, CONCEPTOS_SERVICIO)) },
  { titulo: 'Total', grupo: 'valores', compacta: true, center: true, total: (t) => pie(<Monto v={t.total} />, AZUL), celda: (f) => monto(<Monto v={f.total} negrita />, AZUL) },
  {
    titulo: 'Liquidación', grupo: 'valores', compacta: true,
    celda: (f) => (
      <td className="px-3 py-2 whitespace-nowrap">
        {f.estadoLiquidacion === 'facturado'
          ? <StatusChip tone="success">Facturado</StatusChip>
          : f.sellada
            ? <StatusChip tone="active">Liquidado</StatusChip>
            : <StatusChip tone="draft">Estimado</StatusChip>}
      </td>
    ),
  },
];

/**
 * Un grupo que no fuera `compactable` seguiría entero en la vista compacta. Desde la HU #12537 los
 * tres lo son: Valores también se calla (los conceptos sueltos van al Excel o a un clic).
 */
const GRUPOS: Array<{ clave: Grupo; titulo: string; compactable: boolean }> = [
  { clave: 'identificacion', titulo: 'Identificación', compactable: true },
  { clave: 'datos', titulo: 'Datos del trámite', compactable: true },
  { clave: 'valores', titulo: 'Valores', compactable: true },
];

/** Las que se ven en compacta: la misma lista, en el mismo orden, con las demás quitadas. */
const COMPACTAS = COLUMNAS.filter((c) => c.compacta || !GRUPOS.find((g) => g.clave === c.grupo)?.compactable);

/** Una clave; solo `todas` amplía. Las `flito.reporteCostos.seccion.*` de la #12434 no se leen. */
const CLAVE_ALMACEN = 'flito.reporteCostos.columnas';

/**
 * Compacta/ampliada para la tabla entera, recordada en `localStorage`. Arranca compacta (D-01):
 * la preferencia se lee en el `useState` inicial, así que no hay parpadeo ampliada → compacta.
 */
function useColumnas(anunciar: (texto: string) => void) {
  const [ampliada, setAmpliada] = useState<boolean>(() => {
    try { return localStorage.getItem(CLAVE_ALMACEN) === 'todas'; }
    catch { return false; /* sin almacenamiento (modo privado): compacta y no se recuerda */ }
  });
  const alternar = () => {
    const n = !ampliada;
    setAmpliada(n);
    try { localStorage.setItem(CLAVE_ALMACEN, n ? 'todas' : 'compacta'); } catch { /* idem */ }
    // Las cifras salen de las listas, nunca escritas: añadir una columna las mueve solas.
    anunciar(n ? `Todas las columnas: ${COLUMNAS.length}.` : `Vista compacta: ${COMPACTAS.length} de ${COLUMNAS.length} columnas.`);
  };
  return { ampliada, visibles: ampliada ? COLUMNAS : COMPACTAS, alternar };
}

export default function TablaReporteCostos({
  data, puedeLiquidar, puedeReversar, enProceso, seleccion, onSeleccion, accionable,
  fichasFe, estadoFeDe, onAbrirDetalle, onLiquidar, onFacturar, onReversar, onSoportes, accionEnvio,
  onPrev, onNext, anunciar,
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
  /** La región `role="status"` de la página (D-07): el cambio de columnas se anuncia por ahí, no por una segunda. */
  anunciar: (texto: string) => void;
}) {
  const { ampliada, visibles, alternar } = useColumnas(anunciar);
  const filas = data.items;
  const accionables = filas.filter(accionable);
  const totalPaginas = Math.max(1, Math.ceil(data.total / data.pageSize));
  const ctx: Contexto = { fichasFe, estadoFeDe, onAbrirDetalle };

  // Compactar OCULTA columnas enteras, no las apila: `visibles` es la lista que recorren la fila de
  // columnas, el cuerpo y el pie de totales; la fila de grupos la cuenta para su `colSpan`.
  const delGrupo = (g: Grupo) => visibles.filter((c) => c.grupo === g).length;

  const alternarFila = (id: string) => {
    const n = new Set(seleccion);
    if (n.has(id)) n.delete(id); else n.add(id);
    onSeleccion(n);
  };

  const paginacion = (extra?: { control: ReactNode; nota?: ReactNode }) => (
    <Paginacion total={data.total} page={data.page} totalPaginas={totalPaginas} onPrev={onPrev} onNext={onNext} {...extra} />
  );

  // UN control para la tabla entera (D-03/D-04), tras el conteo de la línea superior. Botón de
  // texto con `aria-expanded`: controla columnas, no un panel, así que no hay `aria-controls` que
  // apuntar; el foco se queda en él y solo cambia su texto.
  const control = (
    <>
      <span className="tabular-nums">{ampliada ? `${COLUMNAS.length} columnas` : `${visibles.length} de ${COLUMNAS.length} columnas`}</span>
      {' · '}
      <button type="button" className="flit-focus font-semibold underline" style={AZUL} aria-expanded={ampliada} onClick={alternar}>
        {ampliada ? 'Compactar columnas' : 'Mostrar todas las columnas'}
      </button>
    </>
  );
  // Solo en compacta: en ampliada no hay nada oculto que explicar. El enlace LLEVA al botón de la
  // cabecera (`id="exportar-excel"`), no es un segundo disparador del export (D-05): un solo botón,
  // un solo «Generando…», una sola banda de resultado.
  const nota = ampliada ? undefined : (
    <span className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
      Las demás van en el Excel ·{' '}
      <a href="#exportar-excel" className="flit-focus underline" style={AZUL}
        onClick={(e) => {
          // Lo que haría el navegador con el fragmento, pero sin dejar `#exportar-excel` en la URL
          // del SPA. `focus()` ya desplaza hasta el botón.
          const boton = document.getElementById('exportar-excel');
          if (boton) { e.preventDefault(); boton.focus(); }
        }}>
        Exportar a Excel
      </a>
    </span>
  );

  return (
    <>
      <div className="mb-3">{paginacion({ control, nota })}</div>
      {/* UNA región de scroll, la de `FlitTable` (D-23): es la que mide `useDesbordaX` y la que gana
          `tabindex` cuando desborda. Un `div.overflow-x-auto` alrededor era una segunda que el usuario
          desplazaba sin que la primera se enterase. */}
      <FlitTable label="Reporte de costos, detalle">
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
            {/* La fila de grupos solo titula: sin botones ni «n de m» (D-03). El `colSpan` es el
                de las columnas visibles del grupo, así que sigue la vista. */}
            {GRUPOS.map((g) => (
              <ThGrupo key={g.clave} scope="colgroup" colSpan={delGrupo(g.clave)}>{g.titulo}</ThGrupo>
            ))}
            <ThGrupo rowSpan={2} />
          </tr>
          <FlitTr>
            {/* `estrecha` (px-3) en los dos modos, D-21; el título compacto solo si la columna lo declara. */}
            {visibles.map((c) => (
              <FlitTh key={c.titulo} center={c.center} estrecha>{ampliada ? c.titulo : (c.tituloCompacto ?? c.titulo)}</FlitTh>
            ))}
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
              {visibles.map((c) => <Fragment key={c.titulo}>{(ampliada ? c.celda : (c.celdaCompacta ?? c.celda))(f, ctx)}</Fragment>)}
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
      <div className="mt-3">{paginacion()}</div>
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
      className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide"
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

export function Paginacion({ total, page, totalPaginas, onPrev, onNext, control, nota }: {
  total: number; page: number; totalPaginas: number; onPrev: () => void; onNext: () => void;
  /** Lo que sigue al conteo en la línea superior (el control de columnas); la inferior no lo lleva. */
  control?: ReactNode;
  /** Una segunda frase bajo el conteo, `text-xs`; baja de línea sola en una ventana estrecha. */
  nota?: ReactNode;
}) {
  const btn = 'rounded-lg border px-3 py-1.5 text-sm font-semibold disabled:opacity-40';
  const btnStyle = { borderColor: 'var(--flit-border-input)', color: 'var(--flit-blue-text)' } as const;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          <strong style={{ color: 'var(--flit-text-primary)' }}>{total.toLocaleString('es-CO')}</strong> trámites · página {page} de {totalPaginas}
          {control && <> · {control}</>}
        </span>
        {nota}
      </div>
      <div className="flex gap-2">
        <button className={btn} style={btnStyle} disabled={page <= 1} onClick={onPrev}>← Anterior</button>
        <button className={btn} style={btnStyle} disabled={page >= totalPaginas} onClick={onNext}>Siguiente →</button>
      </div>
    </div>
  );
}
