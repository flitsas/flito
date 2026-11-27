// FLITO — Gestión Trámites: lateral «Estado de la gestión» del detalle apaisado (Épica #14707, bloque 4; UX
// `docs/ux/flito-tramites-rediseno.md` §9.2). Un `dl` pintado desde la FILA (ya en memoria: sin parpadeo); solo el
// semáforo viene del detalle. SIN botones: las acciones viven en el bloque Vehículo. En un trámite muerto (14707)
// cada dato dice por qué ya no aplica, en tenue.

import { EstadoImpuesto, EstadoSoat, type TramiteDetalle as DetalleTramite } from '@operaciones/shared-types';
import StatusChip from '../../../flit/StatusChip';
import ChipEstadoSoat from '../../soat/ChipEstadoSoat';
import ChipEstadoImpuesto from '../../impuestos/ChipEstadoImpuesto';
import type { TramiteFila } from '../tiposTramites';
import { ChipSemaforo } from './SeccionesDetalle';

const Tenue = ({ children }: { children: string }) => (
  <span className="text-xs font-normal italic text-[color:var(--color-text-tertiary)]">{children}</span>
);

function paraEntregar(f: TramiteFila) {
  if (f.listoParaEntregar) return <StatusChip tone="success">Listo para entregar</StatusChip>;
  const falta = [!f.soatResuelto && 'SOAT', !f.impuestosResueltos && 'Impuestos'].filter(Boolean).join(' y ');
  return falta ? `Falta: ${falta}` : <Tenue>Sin dato</Tenue>;
}

function soat(f: TramiteFila, muerto: boolean, revocado: boolean) {
  // Revocado que llegó a Pagado: su último estado, de solo lectura (histórico). Si no, «Descartado».
  if (muerto) return revocado && f.soat?.estado === EstadoSoat.PAGADO ? <ChipEstadoSoat estado={f.soat.estado} /> : <Tenue>Descartado</Tenue>;
  if (f.soat) return <ChipEstadoSoat estado={f.soat.estado} />;
  return f.soatAutogestionado ? <StatusChip tone="neutral">Autogestionado</StatusChip> : <Tenue>Sin solicitar</Tenue>;
}

function impuesto(f: TramiteFila, muerto: boolean, revocado: boolean) {
  if (muerto) {
    return revocado && f.impuesto?.estado === EstadoImpuesto.PAGADO ? <ChipEstadoImpuesto estado={f.impuesto.estado} /> : <Tenue>Descartado</Tenue>;
  }
  if (f.impuesto) return <ChipEstadoImpuesto estado={f.impuesto.estado} />;
  return f.impuestosAutogestionado ? <StatusChip tone="neutral">Autogestionado</StatusChip> : <Tenue>Sin solicitar</Tenue>;
}

export default function PanelEstadoTramite({ fila, detalle, errorDetalle }: {
  fila: TramiteFila; detalle: DetalleTramite | null; errorDetalle: boolean;
}) {
  const muerto = fila.vigenciaTramite !== 'vigente';
  const revocado = fila.vigenciaTramite === 'revocado';
  const semaforo = muerto || errorDetalle ? <Tenue>Sin dato</Tenue>
    : detalle ? <ChipSemaforo semaforo={detalle.resumen.semaforo} />
    : <Tenue>Cargando…</Tenue>;
  return (
    <div className="lateral-bloque">
      <h3 className="lateral-titulo">Estado de la gestión</h3>
      <dl className="dl-lateral">
        <dt>Para entregar</dt><dd>{muerto ? <Tenue>No aplica</Tenue> : paraEntregar(fila)}</dd>
        <dt>Semáforo</dt><dd>{semaforo}</dd>
        <dt>SOAT</dt><dd>{soat(fila, muerto, revocado)}</dd>
        <dt>Impuestos</dt><dd>{impuesto(fila, muerto, revocado)}</dd>
        <dt>Logística</dt><dd>{fila.logistica?.estado ?? <Tenue>Sin registro</Tenue>}</dd>
      </dl>
    </div>
  );
}
