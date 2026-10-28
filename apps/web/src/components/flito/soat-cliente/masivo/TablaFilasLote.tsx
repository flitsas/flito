// HU #14134 — tabla de filas del lote: Placa/VIN · Vehículo (RUNT) · Estado · Detalle. El estado
// siempre va en texto (chip con rótulo); el avance se actualiza sin recargar (AC2).
import { FlitTable, FlitTh, FlitTr } from '../../../flit/flitPageKit';
import StatusChip from '../../../flit/StatusChip';
import { COPY_MASIVO } from './copyMasivo';
import { ESTADO_FILA, type FilaLote, type TipoMasivo } from './tiposMasivo';

const TD = 'px-4 py-2 text-sm';

function vehiculo(f: FilaLote): string {
  const nombre = [f.marca, f.linea].filter(Boolean).join(' ');
  if (!nombre && f.modelo === null) return '—';
  return f.modelo !== null ? `${nombre} · ${f.modelo}` : nombre;
}

function detalle(f: FilaLote): string {
  if (f.motivo) return f.motivo.mensaje;
  return f.estado === 'por_validar' ? 'Quedó en Por validar para completarla.' : '—';
}

export function FilasEsqueleto() {
  return (
    <div role="status" aria-label="Cargando el avance" className="space-y-2">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} aria-hidden="true" className="h-9 animate-pulse rounded" style={{ background: 'var(--flit-bg-hover)' }} />
      ))}
    </div>
  );
}

export default function TablaFilasLote({ tipo, filas }: { tipo: TipoMasivo; filas: FilaLote[] }) {
  return (
    <FlitTable label="Filas de la carga en masa">
      <thead>
        <tr>
          <FlitTh>{COPY_MASIVO[tipo].columnaClave}</FlitTh>
          <FlitTh>Estado</FlitTh>
          <FlitTh>Vehículo (RUNT)</FlitTh>
          <FlitTh>Detalle</FlitTh>
        </tr>
      </thead>
      <tbody>
        {filas.map((f) => {
          const e = ESTADO_FILA[f.estado];
          return (
            <FlitTr key={f.nFila}>
              <td className={`${TD} font-medium tabular-nums`}>{(tipo === 'inicial' ? f.vin : f.placa) ?? '—'}</td>
              <td className={TD}><StatusChip tone={e.tone}>{e.rotulo}</StatusChip></td>
              <td className={TD}>{vehiculo(f)}</td>
              <td className={`${TD} min-w-[14rem]`} style={{ color: 'var(--flit-text-secondary)' }}>{detalle(f)}</td>
            </FlitTr>
          );
        })}
      </tbody>
    </FlitTable>
  );
}
