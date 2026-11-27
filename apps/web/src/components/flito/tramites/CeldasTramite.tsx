// FLITO — Trámites: celdas de la bandeja (SOAT, impuestos, factura de venta y tracking logístico).
// Movidas desde `pages/FlitoTramites.tsx` al partirla (rediseño UI Kit 2026, Épica #14560).
//
// Épica #14707, bloque 4 (UX §5.3, R5): cada celda SOAT/Impuestos responde UNA pregunta: un chip de estado
// y, como mucho, una cosa más, por prioridad: «Solicitar» (secundario `sm`, nombra la placa) · el motivo de
// la novedad en una línea · «Sin gestión n d» · el valor pagado. Enviado, liquidado, Desbloqueado y Diferencia
// de valor pasan al detalle. Trámite muerto (14707 §3): «Descartado» en tenue y sin botón; un revocado que
// llegó a Pagado conserva su chip como histórico, de solo lectura.

import {
  ESTADO_IMPUESTO_LABEL, ESTADO_SOAT_LABEL, EstadoImpuesto, EstadoSoat,
  ESTADO_LOGISTICA_SIMPLE_LABEL, ESTADOS_LOGISTICA_SIMPLE_ORDEN, simplificarEstadoLogistica,
  type EstadoLogisticaSimple,
} from '@operaciones/shared-types';
import type { ReactNode } from 'react';
import StatusChip, { type ChipTone } from '../../flit/StatusChip';
import GradientButton from '../../flit/GradientButton';
import { esAccionable, pesos, type TramiteFila } from './tiposTramites';

// Semáforo de estados (SOAT e impuestos): pendiente naranja, solicitado azul, con novedad rojo,
// pagado verde. `descartado` (Épica #14707) no se pinta como chip: es «Descartado» en tenue.
const TONO_SOAT: Record<EstadoSoat, ChipTone> = {
  pendiente: 'warning', solicitado: 'active', con_novedad: 'danger', pagado: 'success', descartado: 'neutral',
};
const TONO_IMP: Record<EstadoImpuesto, ChipTone> = { pendiente: 'warning', solicitado: 'active', con_novedad: 'danger', pagado: 'success', descartado: 'neutral' };

const tenue = 'text-[color:var(--color-text-tertiary)]';
const peligro = 'text-[color:var(--kit-rojo-texto)]';
const enlace = 'flit-focus rounded text-xs font-semibold text-[color:var(--color-action)] underline transition-colors hover:text-[color:var(--color-text-primary)]';

/** «Descartado»: misma clase tenue que «Sin aprobar» / «Sin recibo» (14707 §3). */
const Descartado = () => <span className={`text-xs italic ${tenue}`}>Descartado</span>;

const diasDesde = (iso: string | null) => (iso ? Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)) : null);

interface Concepto {
  estado: EstadoSoat | EstadoImpuesto; tono: ChipTone; etiqueta: string; estancado: boolean; enviadoEn: string | null;
  motivoRechazo: string | null; valorPagado: number | null;
}

/** Chip + la única cosa más que admite la celda (R5). */
function CeldaConcepto({ c, solicitar }: { c: Concepto; solicitar: ReactNode }) {
  const dias = c.estancado ? diasDesde(c.enviadoEn) : null;
  const pagado = pesos(c.valorPagado);
  const extra = solicitar
    ?? (c.motivoRechazo ? <p className={`m-0 max-w-[12rem] truncate text-xs ${peligro}`} title={c.motivoRechazo}>{c.motivoRechazo}</p>
      : c.estancado ? <p className={`m-0 text-xs font-semibold ${peligro}`}>{dias !== null ? `Sin gestión ${dias} d` : 'Sin gestión'}</p>
        : pagado ? <p className="m-0 text-xs font-semibold tabular-nums">{pagado}</p> : null);
  return (
    <div className="space-y-1">
      <StatusChip tone={c.tono}>{c.etiqueta}</StatusChip>
      {extra && <div>{extra}</div>}
    </div>
  );
}

/** Fila muerta: nada que solicitar. Un revocado conserva su Pagado como histórico; lo demás, «Descartado». */
function celdaMuerta(fila: TramiteFila, estado: EstadoSoat | EstadoImpuesto | undefined, tono: ChipTone, etiqueta: string) {
  if (fila.vigenciaTramite === 'revocado' && estado === 'pagado') return <StatusChip tone={tono}>{etiqueta}</StatusChip>;
  return <Descartado />;
}

export function CeldaSoat({ fila, onSolicitar }: { fila: TramiteFila; onSolicitar?: () => void }) {
  // Un concepto desbloqueado deja de estar autogestionado PARA ESTE TRÁMITE.
  const desbloqueado = fila.excepcionesAutogestion.includes('soat');
  const s = fila.soat;
  if (fila.vigenciaTramite !== 'vigente') return celdaMuerta(fila, s?.estado, s ? TONO_SOAT[s.estado] : 'neutral', s ? ESTADO_SOAT_LABEL[s.estado] : '');
  if (fila.soatAutogestionado && !desbloqueado) return <StatusChip tone="neutral">SOAT autogestionado</StatusChip>;
  if (!s) return <span className={`text-xs italic ${tenue}`}>Sin registro</span>;
  if (s.estado === EstadoSoat.DESCARTADO) return <Descartado />;
  const puede = onSolicitar && esAccionable(fila) && s.estado === EstadoSoat.PENDIENTE;
  return (
    <CeldaConcepto c={{ ...s, tono: TONO_SOAT[s.estado], etiqueta: ESTADO_SOAT_LABEL[s.estado] }}
      solicitar={puede ? (
        <GradientButton type="button" variant="secondary" size="sm" onClick={onSolicitar}
          aria-label={`Solicitar SOAT de ${fila.vehiculo.placa ?? fila.idFlit}`}>Solicitar</GradientButton>
      ) : null} />
  );
}

export function CeldaImpuesto({ fila, onSolicitar }: { fila: TramiteFila; onSolicitar?: () => void }) {
  // La autogestión la decide la bandera de la empresa (no la ausencia de registro): igual que SOAT.
  const desbloqueado = fila.excepcionesAutogestion.includes('impuesto');
  const imp = fila.impuesto;
  if (fila.vigenciaTramite !== 'vigente') return celdaMuerta(fila, imp?.estado, imp ? TONO_IMP[imp.estado] : 'neutral', imp ? ESTADO_IMPUESTO_LABEL[imp.estado] : '');
  if (fila.impuestosAutogestionado && !desbloqueado) return <StatusChip tone="neutral">Impuestos autogestionado</StatusChip>;
  if (!imp) return <span className={`text-xs italic ${tenue}`}>Sin registro</span>;
  if (imp.estado === EstadoImpuesto.DESCARTADO) return <Descartado />;
  const puede = onSolicitar && esAccionable(fila) && imp.estado === EstadoImpuesto.PENDIENTE;
  return (
    <CeldaConcepto c={{ ...imp, tono: TONO_IMP[imp.estado], etiqueta: ESTADO_IMPUESTO_LABEL[imp.estado] }}
      solicitar={puede ? (
        <GradientButton type="button" variant="secondary" size="sm" onClick={onSolicitar}
          aria-label={`Solicitar impuesto de ${fila.vehiculo.placa ?? fila.idFlit}`}>Solicitar</GradientButton>
      ) : null} />
  );
}

// Factura de venta (viene de FLIT): en la celda Soportes, como enlace. El visor va por el impuesto (la factura
// vive en FLIT); sin impuesto no hay a qué apuntar y se dice en tenue.
export function CeldaFacturaVenta({ fila, onVer }: { fila: TramiteFila; onVer: (fila: TramiteFila) => void }) {
  if (!fila.facturaVentaFlitId) return null;
  return fila.impuesto
    ? <button type="button" className={enlace} onClick={() => onVer(fila)}>Factura de venta</button>
    : <span className={`text-xs ${tenue}`}>Factura en FLIT</span>;
}

// Tracking logístico de la LT: línea horizontal con un punto por paso y, arriba, el estado actual
// (estilo seguimiento de pedido). Novedad/Devuelta se marcan en rojo sobre el paso donde ocurren.
// Tracking con el vocabulario SIMPLE (4 pasos lineales; «Con novedad» es un desvío lateral, no un paso).
const PASOS_LOG = ESTADOS_LOGISTICA_SIMPLE_ORDEN.map((key) => ({ key, label: ESTADO_LOGISTICA_SIMPLE_LABEL[key] }));
const IDX_SIMPLE: Record<EstadoLogisticaSimple, { idx: number; danger: boolean }> = {
  pendiente: { idx: 0, danger: false }, registrada: { idx: 1, danger: false },
  en_flit: { idx: 1, danger: false },
  despachada: { idx: 2, danger: false }, entregada: { idx: 3, danger: false },
  novedad: { idx: 1, danger: true }, // se pinta en rojo sobre el paso de recogida
};

export function TrackingLogistica({ estado }: { estado: string | null }) {
  if (!estado) return <span className={`text-xs ${tenue}`}>No aplica</span>;
  const simple = simplificarEstadoLogistica(estado);
  const info = IDX_SIMPLE[simple];
  // Texto con el rol `-texto` (AA); trazo y puntos con el relleno del manual.
  const texto = info.danger ? 'var(--kit-rojo-texto)' : simple === 'entregada' ? 'var(--kit-verde-texto)' : 'var(--color-action)';
  const trazo = info.danger ? 'var(--kit-rojo)' : simple === 'entregada' ? 'var(--kit-verde)' : 'var(--kit-azul)';
  const pct = (info.idx / (PASOS_LOG.length - 1)) * 100;
  return (
    <div className="min-w-[190px]">
      <div className="mb-2 text-xs font-semibold" style={{ color: texto }}>{ESTADO_LOGISTICA_SIMPLE_LABEL[simple]}</div>
      <div className="relative flex items-center justify-between px-0.5">
        <div className="absolute inset-x-1 top-1/2 h-0.5 -translate-y-1/2 rounded" style={{ background: 'var(--color-border)' }} />
        <div className="absolute left-1 top-1/2 h-0.5 -translate-y-1/2 rounded" style={{ width: `calc(${pct}% - 4px)`, background: trazo }} />
        {PASOS_LOG.map((p, i) => {
          const hecho = i <= info.idx;
          const actual = i === info.idx;
          return (
            <span key={p.key} title={p.label} className="relative z-10 rounded-full transition-colors"
              style={{
                width: actual ? 12 : 9, height: actual ? 12 : 9,
                background: hecho ? trazo : 'var(--color-surface-elevated)',
                border: `2px solid ${hecho ? trazo : 'var(--color-border)'}`,
                outline: actual ? `3px solid color-mix(in srgb, ${trazo} 22%, transparent)` : 'none',
              }} />
          );
        })}
      </div>
    </div>
  );
}
