// HU #14134 — tabla de filas del lote: Placa/VIN · Vehículo (RUNT) · Estado · Detalle. El estado
// siempre va en texto (chip con rótulo); el avance se actualiza sin recargar (AC2).
import { Icono } from '../../../flit/kit/Icono';
import DataTable, { type ColumnaTabla } from '../../../flit/DataTable';
import StatusChip from '../../../flit/StatusChip';
import { COPY_MASIVO } from './copyMasivo';
import { ESTADO_FILA, type FilaLote, type TipoMasivo } from './tiposMasivo';

/** En Inicial el VIN es la clave, así que la placa que responde el RUNT se dice aquí (solo en memoria). */
function vehiculo(f: FilaLote, tipo: TipoMasivo): string {
  const nombre = [f.marca, f.linea].filter(Boolean).join(' ');
  const partes = [nombre, f.modelo !== null ? String(f.modelo) : '', tipo === 'inicial' ? (f.placa ?? '') : ''].filter(Boolean);
  return partes.length ? partes.join(' · ') : '—';
}

function detalle(f: FilaLote): string {
  if (f.motivo) return f.motivo.mensaje;
  return f.estado === 'por_validar' ? 'Quedó en Por validar para completarla.' : '—';
}

export function FilasEsqueleto() {
  return (
    <div role="status" aria-label="Cargando el avance" className="space-y-2">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} aria-hidden="true" className="kit-esqueleto h-9" />
      ))}
    </div>
  );
}

export default function TablaFilasLote({ tipo, filas }: { tipo: TipoMasivo; filas: FilaLote[] }) {
  const columnas: ColumnaTabla<FilaLote>[] = [
    {
      key: 'clave', header: COPY_MASIVO[tipo].columnaClave, className: 'font-medium tabular-nums',
      render: (f) => (tipo === 'inicial' ? f.vin : f.placa) ?? '—',
    },
    {
      key: 'estado', header: 'Estado',
      render: (f) => {
        const e = ESTADO_FILA[f.estado];
        return (
          <StatusChip tone={e.tone} icono={f.estado === 'consultando'
            ? <Icono nombre="girador" size={10} className="animate-spin motion-reduce:animate-none" /> : undefined}>
            {e.rotulo}
          </StatusChip>
        );
      },
    },
    { key: 'vehiculo', header: 'Vehículo (RUNT)', render: (f) => vehiculo(f, tipo) },
    {
      key: 'detalle', header: 'Detalle', className: 'min-w-[14rem] text-[color:var(--color-text-secondary)]',
      render: (f) => detalle(f),
    },
  ];
  return (
    <DataTable
      ariaLabel={tipo === 'inicial' ? 'Detalle por VIN' : 'Filas de la carga en masa'}
      columnas={columnas} filas={filas} getKey={(f) => String(f.nFila)}
    />
  );
}
