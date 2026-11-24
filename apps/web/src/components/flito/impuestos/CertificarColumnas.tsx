// Columnas de «Certificar sin trámite» para el `DataTable` del kit (HU #14665). Orden canónico de la
// Épica #14560 (`docs/ux/flito-soat-impuestos-patron-unificado.md` §3.3), adaptado a este modelo
// (`docs/ux/flito-impuestos-certificar-patron-unificado.md` §3): casilla · Vehículo · Estado ·
// Propietario · Registrado · acciones. Placa y VIN se funden en la celda Vehículo, como en la cola.
// Compañía, Gestiona, Solicitado, Pagado y Valor no existen aquí y no se rellenan. Solo presentación:
// la lógica de eliminar y abrir llega por `acciones`.
import type { ReactNode } from 'react';
import type { ComparacionCampoFacturaRunt } from '@operaciones/shared-types';
import type { ColumnaTabla } from '../../flit/DataTable';
import ChipEstadoCertificacion, { type EstadoCertificacion } from './ChipEstadoCertificacion';

const TENUE = 'text-[color:var(--color-text-tertiary)]';

/** Lo que las columnas leen de una fila de la lista. */
export interface FilaCertificacion {
  id: string;
  placa: string | null;
  vin: string;
  marca: string;
  linea: string;
  anio: string;
  nombrePropietario: string | null;
  estado: EstadoCertificacion;
  comparacion: ComparacionCampoFacturaRunt[] | null;
  certificadoEn: string | null;
  createdAt: string;
}

export interface ContextoColumnasCertificar<F extends FilaCertificacion> {
  seleccion: {
    todas: boolean; onTodas: (marcar: boolean) => void;
    marcada: (f: F) => boolean; onFila: (f: F) => void;
  };
  /** Última columna: «Eliminar» (si no está certificada) y «Abrir». */
  acciones: (f: F) => ReactNode;
}

/** dd/mm/aaaa en hora de Colombia. */
export function fechaCorta(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('es-CO', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Bogota' });
}

function noCoinciden(f: FilaCertificacion): number {
  return (f.comparacion ?? []).filter((c) => c.resultado === 'difiere').length;
}

export function columnasCertificar<F extends FilaCertificacion>(
  { seleccion, acciones }: ContextoColumnasCertificar<F>,
): ColumnaTabla<F>[] {
  return [
    {
      key: 'sel', etiqueta: 'Seleccionar', className: 'w-10',
      // Marca las filas VISIBLES (las del filtro puesto), no las 100 cargadas.
      header: (
        <input type="checkbox" className="size-4 accent-[var(--kit-azul)]" aria-label="Seleccionar las filas de esta página"
          checked={seleccion.todas} onChange={(e) => seleccion.onTodas(e.target.checked)} />
      ),
      render: (f) => (
        <input type="checkbox" className="size-4 accent-[var(--kit-azul)]"
          aria-label={`Seleccionar certificación ${f.placa || f.vin}`}
          checked={seleccion.marcada(f)} onChange={() => seleccion.onFila(f)} />
      ),
    },
    {
      // Misma estructura que la celda Vehículo de la cola: placa en negrita, VIN en mono pequeño y una
      // línea descriptiva (aquí, marca, línea y año).
      key: 'vehiculo', header: 'Vehículo',
      render: (f) => {
        const descripcion = [f.marca, f.linea].filter(Boolean).join(' ');
        return (
          <div className="min-w-0 align-top">
            {f.placa
              ? <span className="text-sm font-semibold">{f.placa}</span>
              : <span className={`text-sm ${TENUE}`}>Sin placa</span>}
            <div className="break-all font-mono text-[11px] text-[color:var(--color-text-secondary)]">{f.vin}</div>
            {(descripcion || f.anio) && (
              <div className={`text-xs ${TENUE}`}>
                {descripcion}{descripcion && f.anio ? ' · ' : ''}<span className="tabular-nums">{f.anio}</span>
              </div>
            )}
          </div>
        );
      },
    },
    {
      key: 'estado', header: 'Estado',
      render: (f) => {
        const n = f.estado === 'sin_coincidencia' ? noCoinciden(f) : 0;
        return (
          <div className="flex flex-col items-start gap-1">
            <ChipEstadoCertificacion estado={f.estado} />
            {n > 0 && (
              <span className="text-xs text-[color:var(--color-text-secondary)]">
                {n === 1 ? '1 dato no coincide' : `${n} datos no coinciden`}
              </span>
            )}
          </div>
        );
      },
    },
    { key: 'propietario', header: 'Propietario', render: (f) => <span className="text-sm">{f.nombrePropietario || '—'}</span> },
    {
      key: 'registrado', header: 'Registrado',
      render: (f) => (
        <div className="tabular-nums">
          <span className="text-sm">{fechaCorta(f.createdAt)}</span>
          {f.certificadoEn && <div className={`text-xs ${TENUE}`}>Certificado {fechaCorta(f.certificadoEn)}</div>}
        </div>
      ),
    },
    {
      key: 'acciones', etiqueta: 'Acciones', header: <span className="sr-only">Acciones</span>, acciones: true,
      render: acciones,
    },
  ];
}
