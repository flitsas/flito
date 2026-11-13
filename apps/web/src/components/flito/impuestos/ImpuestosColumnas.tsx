// Columnas de la cola de Impuestos para el `DataTable` del kit (UI Kit 2026, molde `#tramites`).
//
// Trámite, vehículo y fechas repiten EXACTAMENTE el contenido de `columnasComunes.tsx` (mismos datos,
// mismo orden, mismos rótulos): aquellas celdas pintan su propio `<td>` y el `DataTable` ya pone el
// suyo, así que no se pueden anidar. Si el kit expone su contenido sin `<td>`, esto vuelve a usarlas.
import type { ReactNode } from 'react';
import { ESTADO_IMPUESTO_LABEL, EstadoImpuesto } from '@operaciones/shared-types';
import type { ColumnaTabla } from '../../flit/DataTable';
import StatusChip from '../../flit/StatusChip';
import AntiguedadPill from '../../flit/AntiguedadPill';
import ChipSinGestion from '../../flit/ChipSinGestion';
import { ENCABEZADOS_COMUNES, fechaCorta } from '../../flit/columnasComunes';
import { ChipDocumentos, TONO_IMPUESTO as TONO, fecha, pesos, type ImpuestoItem } from '../ImpuestoCola';

const SUAVE = 'text-[color:var(--color-text-secondary)]';
const TENUE = 'text-[color:var(--color-text-tertiary)]';

export interface ContextoColumnas {
  /** Casilla de «toda la página» y de cada fila; null = sin columna (cuelga del permiso, AC7). */
  seleccion: null | {
    todas: boolean; onTodas: (marcar: boolean) => void;
    marcada: (f: ImpuestoItem) => boolean; onFila: (f: ImpuestoItem) => void;
  };
  /** Acción bajo el tipo de trámite (Certificar / semáforo). */
  accionTramite: (f: ImpuestoItem) => ReactNode;
  /** Última columna: descarga de soportes y «Ver». */
  acciones: (f: ImpuestoItem) => ReactNode;
}

const num = (c: ReactNode) => <span className="tabular-nums">{c}</span>;

export function columnasImpuestos({ seleccion, accionTramite, acciones }: ContextoColumnas): ColumnaTabla<ImpuestoItem>[] {
  const [hTramite, hVehiculo, hFechas] = ENCABEZADOS_COMUNES;
  return [
    ...(seleccion ? [{
      key: 'sel', etiqueta: 'Seleccionar', className: 'w-10',
      // El nombre accesible cambia con el sentido: ya no marca «los que admiten acción masiva».
      header: (
        <input type="checkbox" className="h-4 w-4 accent-[var(--kit-azul)]" aria-label="Seleccionar las filas de esta página"
          checked={seleccion.todas} onChange={(e) => seleccion.onTodas(e.target.checked)} />
      ),
      render: (f: ImpuestoItem) => (
        <input type="checkbox" className="h-4 w-4 accent-[var(--kit-azul)]" aria-label={`Seleccionar ${f.placa}`}
          checked={seleccion.marcada(f)} onChange={() => seleccion.onFila(f)} />
      ),
    }] : []),
    {
      key: 'tramite', header: hTramite,
      render: (f) => (
        <div className="align-top">
          <div className="text-sm font-medium tabular-nums">{f.idFlit ?? '—'}</div>
          <div className={`text-xs ${SUAVE}`}>{f.tipoTramite ?? '—'}</div>
          <div className="mt-1.5">{accionTramite(f)}</div>
        </div>
      ),
    },
    {
      key: 'vehiculo', header: hVehiculo,
      render: (f) => {
        const vehiculo = [f.marca, f.linea].filter(Boolean).join(' ');
        return (
          <div>
            <div className="text-sm font-semibold">{f.placa ?? '—'}</div>
            <div className={`mono text-[11px] ${SUAVE}`}>{f.vin ?? '—'}</div>
            {vehiculo && <div className={`text-xs ${TENUE}`}>{vehiculo}</div>}
          </div>
        );
      },
    },
    {
      key: 'fechas', header: hFechas,
      render: (f) => (
        <div className={`whitespace-nowrap text-xs ${SUAVE}`}>
          <div><span className={TENUE}>Creado </span>{fechaCorta(f.fechaCreacion)}</div>
          <div>
            <span className={TENUE}>Aprob. </span>
            {f.fechaAprobacion ? fechaCorta(f.fechaAprobacion) : <span className={`italic ${TENUE}`}>Sin aprobar</span>}
          </div>
        </div>
      ),
    },
    { key: 'compania', header: 'Compañía', render: (f) => <span className="text-sm">{f.companiaNombre}</span> },
    { key: 'organismo', header: 'Organismo', render: (f) => <span className="text-sm">{f.organismoNombre ?? f.organismoCodigo}</span> },
    {
      // Columna propia y no sobre la de organismo: el organismo se sigue viendo en los dos casos,
      // porque el impuesto se paga ante él igual. El distintivo lleva texto y no solo color.
      key: 'gestiona', header: 'Gestiona',
      render: (f) => f.gestionOperaciones
        ? <StatusChip tone="warning">Operaciones</StatusChip>
        : <span className={`text-sm ${SUAVE}`}>Gestor del organismo</span>,
    },
    {
      key: 'estado', header: 'Estado',
      render: (f) => (
        <div className="flex flex-col items-start gap-1">
          <StatusChip tone={TONO[f.estado]}>{ESTADO_IMPUESTO_LABEL[f.estado]}</StatusChip>
          {f.estancado && <ChipSinGestion desde={f.enviadoEn} />}
          {f.marcadoPorDiferencia && <StatusChip tone="warning">Diferencia de valor</StatusChip>}
          <ChipDocumentos imp={f} />
        </div>
      ),
    },
    {
      key: 'solicitado', header: 'Solicitado',
      render: (f) => (
        <div className="text-sm">
          {num(f.enviadoEn ? fecha(f.enviadoEn) : '—')}
          {/* Ya pagado: los días desde la solicitud dejan de ser señal de riesgo y solo ensucian.
              El semáforo de antigüedad es la etiqueta con punta del kit (decisión D2). */}
          {f.enviadoEn && f.estado !== EstadoImpuesto.PAGADO && (
            <div className="mt-1"><AntiguedadPill desde={f.enviadoEn} /></div>
          )}
        </div>
      ),
    },
    { key: 'pago', header: 'Fecha pago', render: (f) => <span className="text-sm">{num(f.pagadoEn ? fecha(f.pagadoEn) : '—')}</span> },
    { key: 'liquidado', header: 'Liquidado', align: 'right', render: (f) => <span className="text-sm">{num(pesos(f.valorLiquidado))}</span> },
    { key: 'pagado', header: 'Pagado', align: 'right', render: (f) => <span className="text-sm">{num(pesos(f.valorPagado))}</span> },
    { key: 'acciones', header: <span className="sr-only">Acciones</span>, acciones: true, render: acciones },
  ];
}
