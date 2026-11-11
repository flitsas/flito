// Reporte de costos — las columnas del detalle, como DATOS (rediseño, Épica #13763).
//
// Spec: `docs/ux/flito-reporte-costos-rediseno.md` §3.2 más los retoques del humano al aprobar la
// maqueta. La fila de grupos, la de columnas, cada celda y el pie se recorren de esta misma lista:
// una columna no puede aparecer en la cabecera y faltar en el cuerpo, ni caer bajo otro grupo.
//
// Grupos, en este orden: las dos fijas (Trámite y Placa), Esencial, Cobro al cliente, Costo de
// proveedor, Más del trámite y Titular. `porDefecto` dice qué se ve sin preferencia guardada; lo
// demás está en «Columnas» y siempre en el Excel. Total reintegro, Servicio y Viajes salen de la
// vista por defecto (decisión del humano) y conservan su sitio dentro del cobro.
//
// Cada `celda` devuelve el `<td>` ENTERO: la tabla le añade el borde de grupo y el `sticky` de las
// fijas con `cloneElement`, sin que cada celda tenga que saberlo.

import type { ReactElement, ReactNode } from 'react';
import StatusChip from '../flit/StatusChip';
import { documentoConTipo, fechaCorta } from '../flit/columnasComunes';
import CeldaFacturacion from './CeldaFacturacion';
import CeldaHonorario, { ChipsDocumentales } from './CeldaHonorario';
import { CeldaCosto, CeldaProveedor, CeldaTotalCostos } from './CeldaCostoProveedor';
import MarcaSoatConciliado from './MarcaSoatConciliado';
import Monto from './Monto';
import type { FacturacionTramite } from './tiposFacturacion';
import {
  CONCEPTO, CONCEPTOS_REINTEGRO, CONCEPTOS_SERVICIO, faltaDe, faltaDeSubtotal, faltantes,
  type Fila, type Totales,
} from './tiposReporteCostos';
import { TITULO_SIN_DATO, textoCeldaServicios } from '../../lib/serviciosAdicionalesTramite';
import { textoCeldaViajes } from '../../lib/viajesLogisticaReporte';
import type { SiigoEstadoReporte } from '@operaciones/shared-types';

export type Grupo = 'fija' | 'esencial' | 'cobro' | 'costo' | 'tramite' | 'titular';

/** Lo que cada celda necesita de la página además de su fila. */
export interface Contexto {
  fichasFe: Map<string, FacturacionTramite>;
  estadoFeDe: (f: Fila) => SiigoEstadoReporte;
  onAbrirDetalle: (f: Fila) => void;
}

export interface Columna {
  /** Clave estable: es lo que se guarda en `flito.reporteCostos.columnas.v2`. */
  id: string;
  titulo: string;
  grupo: Grupo;
  porDefecto: boolean;
  center?: boolean;
  /** `title` de la cabecera, cuando el título corto no lo dice todo. */
  ayuda?: string;
  celda: (f: Fila, ctx: Contexto) => ReactElement;
  /** Qué va en el pie de totales bajo esta columna. Sin él, la celda del pie queda vacía. */
  total?: (t: Totales) => ReactNode;
}

export const GRUPOS: Array<{ clave: Grupo; titulo: string; ayuda?: string }> = [
  { clave: 'fija', titulo: '' },
  { clave: 'esencial', titulo: 'Esencial' },
  { clave: 'cobro', titulo: 'Cobro al cliente' },
  { clave: 'costo', titulo: 'Costo de proveedor', ayuda: 'Lo que FLITO le paga al proveedor. No se suma al cobro.' },
  { clave: 'tramite', titulo: 'Más del trámite' },
  { clave: 'titular', titulo: 'Titular' },
];

const SECUNDARIO = { color: 'var(--flit-text-secondary)' } as const;
const TENUE = { color: 'var(--flit-text-muted)' } as const;
const AZUL = { color: 'var(--flit-blue-text)' } as const;

const texto = (v: string | null, extra = '') =>
  <td className={`px-3 py-2 whitespace-nowrap ${extra}`}>{v ?? ''}</td>;
const monto = (n: ReactNode, extra?: { color: string }) =>
  <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap" style={extra}>{n}</td>;
const pie = (n: ReactNode, extra?: { color: string }) =>
  <span className="font-semibold" style={extra}>{n}</span>;

/** Un subtotal en null se dice con su motivo y con qué falta en el `title` (RN-02), nunca «$ 0». */
function subtotal(f: Fila, v: number | null, conceptos: readonly string[]): ReactNode {
  const { falta, faltan } = faltaDeSubtotal(f, conceptos);
  return <Monto v={v} falta={falta} title={faltan.length ? `Falta: ${faltan.join(', ')}` : undefined} />;
}

const fecha = (v: string | null) => (
  <td className="px-3 py-2 text-xs whitespace-nowrap" style={SECUNDARIO}>
    {v ? fechaCorta(v) : <span className="italic" style={TENUE}>Sin aprobar</span>}
  </td>
);

/**
 * «Adicionales»: el importe en UN renglón. Cuántos son pasa al nombre accesible y al «Servicios · n»
 * del ⋮ (spec §3.2). Lo que decide qué se pinta sigue siendo la CANTIDAD (`textoCeldaServicios`).
 */
function celdaAdicionales(f: Fila) {
  const celda = textoCeldaServicios(f);
  if (celda.clase === 'vacio') return monto(<Monto v={null} />);
  if (celda.clase === 'sin_dato') {
    return (
      <td className="px-3 py-2 text-right">
        <span className="text-xs italic" style={TENUE} title={TITULO_SIN_DATO}>Sin dato</span>
      </td>
    );
  }
  return (
    <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap" aria-label={celda.accesible}>
      <Monto v={celda.valor} />
      <ChipsDocumentales fila={f} concepto="serviciosAdicionales" />
    </td>
  );
}

/** «Viajes» (HU #12628): nunca «0» para `null`. Fuera de la vista por defecto. */
function celdaViajes(f: Fila) {
  const celda = textoCeldaViajes(f.logisticaViajesCantidad);
  if (celda.clase === 'vacio') return monto(<Monto v={null} title={celda.title} />);
  if (celda.clase === 'sin_dato') {
    return (
      <td className="px-3 py-2 text-right">
        <span className="text-xs italic" style={TENUE} title={celda.title}>{celda.texto}</span>
      </td>
    );
  }
  return <td className="px-3 py-2 text-right tabular-nums" aria-label={celda.accesible}>{celda.texto}</td>;
}

/**
 * «Liquidación»: vacía mientras el trámite no esté liquidado ni facturado (retoque 3 del humano).
 * No hay «Estimado»: solo se dice lo que ya pasó.
 */
function celdaLiquidacion(f: Fila) {
  return (
    <td className="px-3 py-2 whitespace-nowrap">
      {f.estadoLiquidacion === 'facturado'
        ? <StatusChip tone="success">Facturado</StatusChip>
        : f.sellada
          ? <StatusChip tone="active">Liquidado</StatusChip>
          : null}
    </td>
  );
}

/** «Falta»: lo que BLOQUEA liquidar. El costo de proveedor nunca aparece aquí. */
function celdaFalta(f: Fila) {
  const falta = faltantes(f);
  return (
    <td className="px-3 py-2 text-xs whitespace-nowrap" style={SECUNDARIO}>
      {falta.length ? falta.join(', ') : <span style={TENUE}>—</span>}
    </td>
  );
}

export const COLUMNAS: Columna[] = [
  // ── Fijas ──
  { id: 'tramite', titulo: 'Trámite', grupo: 'fija', porDefecto: true, celda: (f) => texto(f.idFlit, 'font-semibold tabular-nums') },
  { id: 'placa', titulo: 'Placa', grupo: 'fija', porDefecto: true, celda: (f) => texto(f.placa, 'font-mono') },

  // ── Esencial ── Empresa sin recortar (retoque 1): la columna crece, la fila sigue en un renglón y
  // la tabla desplaza en el scroll del kit.
  { id: 'empresa', titulo: 'Empresa', grupo: 'esencial', porDefecto: true, celda: (f) => texto(f.empresa) },
  { id: 'tipo', titulo: 'Tipo', grupo: 'esencial', porDefecto: true, celda: (f) => texto(f.tipoTramite) },
  { id: 'aprobacion', titulo: 'Aprobación', grupo: 'esencial', porDefecto: true, celda: (f) => fecha(f.fechaAprobacion) },
  { id: 'liquidacion', titulo: 'Liquidación', grupo: 'esencial', porDefecto: true, celda: celdaLiquidacion },
  { id: 'falta', titulo: 'Falta', grupo: 'esencial', porDefecto: true, ayuda: 'Lo que impide liquidar el trámite.', celda: celdaFalta },

  // ── Cobro al cliente ──
  {
    id: 'soat', titulo: CONCEPTO.soat, grupo: 'cobro', porDefecto: true, center: true, total: (t) => pie(<Monto v={t.soat} />),
    celda: (f) => (
      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
        <Monto v={f.soat} falta={faltaDe(f, CONCEPTO.soat)} />
        <MarcaSoatConciliado conciliado={f.soatConciliado} referencia={f.boletaReferencia} conciliadoEn={f.soatConciliadoEn} />
      </td>
    ),
  },
  { id: 'impuesto', titulo: CONCEPTO.impuesto, grupo: 'cobro', porDefecto: true, center: true, total: (t) => pie(<Monto v={t.impuesto} />), celda: (f) => monto(<Monto v={f.impuesto} falta={faltaDe(f, CONCEPTO.impuesto)} />) },
  // Los PESOS del derecho de tránsito (RN-08). Se titula «Derecho» porque «Trámite» es ya la columna fija.
  { id: 'derecho', titulo: 'Derecho', grupo: 'cobro', porDefecto: true, center: true, ayuda: 'Derecho de tránsito', total: (t) => pie(<Monto v={t.derechoTramite} />), celda: (f) => monto(<Monto v={f.derechoTramite} falta={faltaDe(f, CONCEPTO.derecho)} />) },
  { id: 'logistica', titulo: CONCEPTO.logistica, grupo: 'cobro', porDefecto: true, center: true, total: (t) => pie(<Monto v={t.logistica} />), celda: (f) => <CeldaHonorario fila={f} concepto="logistica" valor={f.logistica} falta={faltaDe(f, CONCEPTO.logistica)} /> },
  { id: 'digital', titulo: CONCEPTO.digital, grupo: 'cobro', porDefecto: true, center: true, total: (t) => pie(<Monto v={t.tramiteDigital} />), celda: (f) => <CeldaHonorario fila={f} concepto="tramiteDigital" valor={f.tramiteDigital} falta={faltaDe(f, CONCEPTO.digital)} /> },
  { id: 'adicionales', titulo: 'Adicionales', grupo: 'cobro', porDefecto: true, center: true, ayuda: 'Servicios adicionales', total: (t) => pie(<Monto v={t.serviciosAdicionales} />), celda: celdaAdicionales },
  { id: 'gmf', titulo: 'GMF', grupo: 'cobro', porDefecto: true, center: true, total: (t) => pie(<Monto v={t.gmf} />), celda: (f) => monto(<Monto v={f.gmf} />) },
  { id: 'totalReintegro', titulo: 'Total reintegro', grupo: 'cobro', porDefecto: false, center: true, total: (t) => pie(<Monto v={t.totalReintegro} />), celda: (f) => monto(subtotal(f, f.totalReintegro, CONCEPTOS_REINTEGRO)) },
  { id: 'servicio', titulo: 'Servicio', grupo: 'cobro', porDefecto: false, center: true, total: (t) => pie(<Monto v={t.totalServicio} />), celda: (f) => monto(subtotal(f, f.totalServicio, CONCEPTOS_SERVICIO)) },
  { id: 'viajes', titulo: 'Viajes', grupo: 'cobro', porDefecto: false, center: true, celda: celdaViajes },
  { id: 'total', titulo: 'Total', grupo: 'cobro', porDefecto: true, center: true, total: (t) => pie(<Monto v={t.total} />, AZUL), celda: (f) => monto(<Monto v={f.total} negrita />, AZUL) },

  // ── Costo de proveedor ── Sin pie: el API no agrega el costo en los totales del detalle y la
  // pantalla no suma (el consolidado sí lo trae).
  { id: 'costoSoat', titulo: 'Costo SOAT', grupo: 'costo', porDefecto: true, center: true, celda: (f) => <CeldaCosto fila={f} concepto="soat" /> },
  { id: 'proveedorSoat', titulo: 'Proveedor SOAT', grupo: 'costo', porDefecto: true, celda: (f) => <CeldaProveedor fila={f} concepto="soat" /> },
  { id: 'costoLogistica', titulo: 'Costo logística', grupo: 'costo', porDefecto: true, center: true, celda: (f) => <CeldaCosto fila={f} concepto="logistica" /> },
  { id: 'proveedorLogistica', titulo: 'Proveedor logística', grupo: 'costo', porDefecto: true, celda: (f) => <CeldaProveedor fila={f} concepto="logistica" /> },
  { id: 'totalCostos', titulo: 'Total costos', grupo: 'costo', porDefecto: true, center: true, celda: (f) => <CeldaTotalCostos fila={f} /> },

  // ── Más del trámite ──
  { id: 'creacion', titulo: 'Creación', grupo: 'tramite', porDefecto: false, celda: (f) => fecha(f.fechaCreacion) },
  { id: 'estado', titulo: 'Estado', grupo: 'tramite', porDefecto: false, celda: (f) => texto(f.estado) },
  { id: 'ot', titulo: 'OT', grupo: 'tramite', porDefecto: false, celda: (f) => texto(f.organismoNombre) },
  { id: 'mes', titulo: 'Mes', grupo: 'tramite', porDefecto: false, celda: (f) => texto(f.mes, 'tabular-nums') },
  { id: 'trimestre', titulo: 'Trimestre', grupo: 'tramite', porDefecto: false, celda: (f) => texto(f.trimestre, 'tabular-nums') },
  {
    id: 'facturaDian', titulo: 'Factura DIAN', grupo: 'tramite', porDefecto: false, center: true,
    celda: (f, ctx) => (
      <td className="px-3 py-2 text-center">
        <CeldaFacturacion ficha={ctx.fichasFe.get(f.tramiteId)} estadoFila={ctx.estadoFeDe(f)}
          numeroFila={f.facturaNumero} requiereRevision={f.facturaRequiereRevision}
          onAbrir={() => ctx.onAbrirDetalle(f)} />
      </td>
    ),
  },
  { id: 'marca', titulo: 'Marca', grupo: 'tramite', porDefecto: false, celda: (f) => texto(f.marca) },
  { id: 'linea', titulo: 'Línea', grupo: 'tramite', porDefecto: false, celda: (f) => texto(f.linea) },
  { id: 'vin', titulo: 'VIN', grupo: 'tramite', porDefecto: false, celda: (f) => texto(f.vin, 'font-mono text-xs') },

  // ── Titular ──
  { id: 'nombres', titulo: 'Nombres', grupo: 'titular', porDefecto: false, celda: (f) => texto(f.titularNombres) },
  { id: 'apellidos', titulo: 'Apellidos', grupo: 'titular', porDefecto: false, celda: (f) => texto(f.titularApellidos) },
  { id: 'razonSocial', titulo: 'Razón social', grupo: 'titular', porDefecto: false, celda: (f) => texto(f.titularRazonSocial) },
  { id: 'tipoDocumento', titulo: 'Tipo de documento', grupo: 'titular', porDefecto: false, celda: (f) => texto(f.titularTipoDocumento) },
  // El código de tipo delante del número lo pone el ayudante compartido: la regla del null vive allí.
  { id: 'documento', titulo: 'Documento', grupo: 'titular', porDefecto: false, celda: (f) => texto(f.titularDocumento ? documentoConTipo(f.titularTipoDocumento, f.titularDocumento) : null, 'tabular-nums') },
];

/** Las que no se pueden ocultar (spec §3.5). */
export const FIJAS = new Set(COLUMNAS.filter((c) => c.grupo === 'fija').map((c) => c.id));
export const POR_DEFECTO = COLUMNAS.filter((c) => c.porDefecto).map((c) => c.id);
