// FLITO — Trámites: celdas de la bandeja (SOAT, impuestos, factura de venta y tracking logístico).
// Movidas desde `pages/FlitoTramites.tsx` al partirla (rediseño UI Kit 2026, Épica #14560): misma
// lógica, piel del kit (etiquetas con punta, botón píldora, tokens con par oscuro).

import {
  ESTADO_IMPUESTO_LABEL, ESTADO_SOAT_LABEL, EstadoImpuesto, EstadoSoat,
  ESTADO_LOGISTICA_SIMPLE_LABEL, ESTADOS_LOGISTICA_SIMPLE_ORDEN, simplificarEstadoLogistica,
  type EstadoLogisticaSimple,
} from '@operaciones/shared-types';
import StatusChip, { type ChipTone } from '../../flit/StatusChip';
import ChipSinGestion from '../../flit/ChipSinGestion';
import GradientButton from '../../flit/GradientButton';
import { esAccionable, fecha, pesos, type TramiteFila } from './tiposTramites';

// Semáforo de estados (SOAT e impuestos): pendiente naranja, solicitado azul, con novedad rojo,
// pagado verde. La autogestión (sin registro) se pinta aparte en gris.
// `pendiente_revision` y `rechazada` (canal Cliente) no nacían de un trámite, así que nunca asomaron
// por esta pantalla; se completaban solo porque el `Record` es exhaustivo. La HU #12080 los quita de
// `EstadoSoat` y del enum de Postgres, así que las dos entradas se van con ellos.
const TONO_SOAT: Record<EstadoSoat, ChipTone> = {
  pendiente: 'warning', solicitado: 'active', con_novedad: 'danger', pagado: 'success', descartado: 'neutral', // Épica #14707
};
const TONO_IMP: Record<EstadoImpuesto, ChipTone> = { pendiente: 'warning', solicitado: 'active', con_novedad: 'danger', pagado: 'success', descartado: 'neutral' };

const tenue = 'text-[color:var(--color-text-tertiary)]';
const peligro = 'text-[color:var(--kit-rojo-texto)]';

// Botón "Solicitar" por fila (SOAT/impuestos): píldora pequeña del kit (avanza = azul).
function BotonSolicitar({ onClick }: { onClick: () => void }) {
  return (
    <GradientButton type="button" size="sm" className="mt-1.5" onClick={onClick}>
      Solicitar
    </GradientButton>
  );
}

export function CeldaSoat({ fila, onSolicitar }: { fila: TramiteFila; onSolicitar?: () => void }) {
  // Un concepto desbloqueado deja de estar autogestionado PARA ESTE TRÁMITE: seguir rotulándolo así
  // contradiría al registro que sí existe unas líneas más abajo.
  const desbloqueado = fila.excepcionesAutogestion.includes('soat');
  if (fila.soatAutogestionado && !desbloqueado) return <StatusChip tone="neutral">SOAT autogestionado</StatusChip>;
  if (!fila.soat) return <span className={`text-xs ${tenue}`}>Sin registro</span>;
  const s = fila.soat;
  const v = pesos(s.valorPagado);
  // Solicitud directa desde la columna (sin marcar el check): SOAT en Pendiente y trámite accionable.
  const puedeSolicitar = onSolicitar && esAccionable(fila) && s.estado === EstadoSoat.PENDIENTE;
  return (
    <div className="space-y-0.5">
      <StatusChip tone={TONO_SOAT[s.estado]}>{ESTADO_SOAT_LABEL[s.estado]}</StatusChip>
      {desbloqueado && <div><StatusChip tone="warning">Desbloqueado</StatusChip></div>}
      {s.estancado && <div><ChipSinGestion desde={s.enviadoEn} tone="danger" /></div>}
      {s.enviadoEn && <p className={`text-xs ${tenue}`}>Enviado {fecha(s.enviadoEn)}</p>}
      {v && <p className="text-xs font-semibold tabular-nums">{v}</p>}
      {s.motivoRechazo && <p className={`text-xs ${peligro}`} title={s.motivoRechazo}>{s.motivoRechazo.slice(0, 40)}</p>}
      {puedeSolicitar && <div><BotonSolicitar onClick={onSolicitar} /></div>}
    </div>
  );
}

// Factura de venta (viene de FLIT, id S3). Con factura → botón para verla; sin factura → aviso.
export function CeldaFacturaVenta({ fila, onVer }: { fila: TramiteFila; onVer: (fila: TramiteFila) => void }) {
  if (fila.facturaVentaFlitId) {
    // El visor va por el impuesto (la factura vive en FLIT). Sin impuesto no hay a qué apuntar.
    return fila.impuesto
      ? <button className="flit-focus rounded text-xs font-semibold text-[color:var(--color-action)] underline transition-colors hover:text-[color:var(--color-text-primary)]"
          onClick={() => onVer(fila)}>Ver factura de venta</button>
      : <span className={`text-xs ${tenue}`}>Factura en FLIT</span>;
  }
  return <span className={`text-xs ${tenue}`}>Sin factura de venta</span>;
}

export function CeldaImpuesto({ fila, onSolicitar }: { fila: TramiteFila; onSolicitar?: () => void }) {
  // La autogestión la decide la bandera de la empresa (no la ausencia de registro): igual que SOAT.
  const desbloqueado = fila.excepcionesAutogestion.includes('impuesto');
  if (fila.impuestosAutogestionado && !desbloqueado) return <StatusChip tone="neutral">Impuestos autogestionado</StatusChip>;
  // Sin bandera y sin registro (p.ej. trámite no Asignado): sin registro, mismo criterio que SOAT.
  if (!fila.impuesto) return <span className={`text-xs ${tenue}`}>Sin registro</span>;
  const imp = fila.impuesto;
  const liq = pesos(imp.valorLiquidado);
  const pag = pesos(imp.valorPagado);
  const puedeSolicitar = onSolicitar && esAccionable(fila) && imp.estado === EstadoImpuesto.PENDIENTE;
  return (
    <div className="space-y-0.5">
      <StatusChip tone={TONO_IMP[imp.estado]}>{ESTADO_IMPUESTO_LABEL[imp.estado]}</StatusChip>
      {desbloqueado && <div><StatusChip tone="warning">Desbloqueado</StatusChip></div>}
      {imp.estancado && <div><ChipSinGestion desde={imp.enviadoEn} tone="danger" /></div>}
      {imp.marcadoPorDiferencia && <div><StatusChip tone="warning">Diferencia de valor</StatusChip></div>}
      {imp.enviadoEn && <p className={`text-xs ${tenue}`}>Enviado {fecha(imp.enviadoEn)}</p>}
      {liq && <p className={`text-xs ${tenue}`}>Liquidado {liq}</p>}
      {pag && <p className="text-xs font-semibold tabular-nums">{pag}</p>}
      {imp.motivoRechazo && <p className={`text-xs ${peligro}`} title={imp.motivoRechazo}>{imp.motivoRechazo.slice(0, 40)}</p>}
      {puedeSolicitar && <div><BotonSolicitar onClick={onSolicitar} /></div>}
    </div>
  );
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
