// Columnas de la cola de Impuestos para el `DataTable` del kit (UI Kit 2026, molde `#tramites`).
//
// Orden canónico de la Épica #14560 (`docs/ux/flito-soat-impuestos-patron-unificado.md` §3.3), el mismo
// que la cola SOAT: Vehículo · **Estado** · Compañía · Gestiona · Solicitado · Pagado · Valor · acciones.
// Antes eran 12 columnas con el Estado en 8.ª posición. Lo que salió de la tabla pasó al detalle
// (`DetalleImpuesto`, zona 5): «Fechas» (creado/aprobado del trámite en FLIT) y el «Liquidado» cuando ya
// hay «Pagado». El N.º de trámite FLIT va bajo la placa (es el otro identificador que se busca) y la
// certificación/semáforo RUNT, dentro de la celda de Estado: son señales de la misma intención, igual
// que la vigencia RUNT en la celda de Estado del SOAT.
import type { ReactNode } from 'react';
import { EstadoImpuesto } from '@operaciones/shared-types';
import type { ColumnaTabla } from '../../flit/DataTable';
import StatusChip from '../../flit/StatusChip';
import AntiguedadPill from '../../flit/AntiguedadPill';
import ChipSinGestion from '../../flit/ChipSinGestion';
import ChipEstadoImpuesto from './ChipEstadoImpuesto';
import { ChipDocumentos, fecha, pesos, type ImpuestoItem } from '../ImpuestoCola';

const TENUE = 'text-[color:var(--color-text-tertiary)]';

export interface ContextoColumnas {
  /** Casilla de «toda la página» y de cada fila; null = sin columna (cuelga del permiso, AC7). */
  seleccion: null | {
    todas: boolean; onTodas: (marcar: boolean) => void;
    marcada: (f: ImpuestoItem) => boolean; onFila: (f: ImpuestoItem) => void;
  };
  /** Certificación / semáforo RUNT de la fila: se pinta dentro de la celda de Estado. */
  accionCertificacion: (f: ImpuestoItem) => ReactNode;
  /** Última columna: descarga de soportes y «Ver». */
  acciones: (f: ImpuestoItem) => ReactNode;
}

const num = (c: ReactNode) => <span className="tabular-nums">{c}</span>;

export function columnasImpuestos({ seleccion, accionCertificacion, acciones }: ContextoColumnas): ColumnaTabla<ImpuestoItem>[] {
  return [
    ...(seleccion ? [{
      key: 'sel', etiqueta: 'Seleccionar', className: 'w-10',
      // El nombre accesible cambia con el sentido: ya no marca «los que admiten acción masiva».
      header: (
        <input type="checkbox" className="size-4 accent-[var(--kit-azul)]" aria-label="Seleccionar las filas de esta página"
          checked={seleccion.todas} onChange={(e) => seleccion.onTodas(e.target.checked)} />
      ),
      render: (f: ImpuestoItem) => (
        <input type="checkbox" className="size-4 accent-[var(--kit-azul)]" aria-label={`Seleccionar ${f.placa}`}
          checked={seleccion.marcada(f)} onChange={() => seleccion.onFila(f)} />
      ),
    }] : []),
    {
      // Misma estructura que `CeldaVehiculoSoat` (Épica #14560, ronda 2): placa en negrita, VIN en mono
      // pequeño y UNA línea descriptiva, que aquí es el trámite FLIT.
      key: 'vehiculo', header: 'Vehículo',
      render: (f) => (
        <div className="align-top">
          <span className="text-sm font-semibold">{f.placa ?? '—'}</span>
          <div className="font-mono text-[11px]" style={{ color: 'var(--color-text-secondary)' }}>{f.vin ?? '—'}</div>
          <div className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
            Trámite FLIT <span className="tabular-nums">{f.idFlit ?? '—'}</span>
            {f.tipoTramite && <> · {f.tipoTramite}</>}
          </div>
        </div>
      ),
    },
    {
      key: 'estado', header: 'Estado',
      render: (f) => (
        // Chips en una fila que envuelve, no en columna: con la certificación ya dentro de esta celda,
        // apilarlos daba cuatro alturas por fila y una cola mucho más alta que antes.
        <div className="flex flex-col items-start gap-1">
          <div className="flex flex-wrap items-center gap-1">
            <ChipEstadoImpuesto estado={f.estado} />
            {f.estancado && <ChipSinGestion desde={f.enviadoEn} />}
            {f.marcadoPorDiferencia && <StatusChip tone="warning">Diferencia de valor</StatusChip>}
            <ChipDocumentos imp={f} />
          </div>
          {accionCertificacion(f)}
        </div>
      ),
    },
    { key: 'compania', header: 'Compañía', render: (f) => <span className="text-sm">{f.companiaNombre}</span> },
    {
      // Mismo dato y mismo lugar que el «Gestiona» del SOAT. El organismo se sigue viendo en los dos
      // casos, porque el impuesto se paga ante él igual; el distintivo lleva texto y no solo color.
      key: 'gestiona', header: 'Gestiona',
      render: (f) => {
        // Misma estructura que el «Gestiona» del SOAT: quién gestiona en la primera línea (el nombre, o
        // el chip «Operaciones» si se retomó) y debajo, en pequeño, el dato que lo completa.
        const organismo = f.organismoNombre ?? f.organismoCodigo;
        return f.gestionOperaciones
          ? (
            <div className="text-sm">
              <StatusChip tone="warning">Operaciones</StatusChip>
              {organismo && <div className={`mt-0.5 text-xs ${TENUE}`}>{organismo}</div>}
            </div>
          )
          : (
            <div className="text-sm">
              <span>{organismo ?? '—'}</span>
              <div className={`mt-0.5 text-xs ${TENUE}`}>Gestor del organismo</div>
            </div>
          );
      },
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
    { key: 'pago', header: 'Pagado', render: (f) => <span className="text-sm">{num(f.pagadoEn ? fecha(f.pagadoEn) : '—')}</span> },
    {
      // P-1 (default del PO): una sola columna de dinero. Pagado si existe; si no, el liquidado con su
      // rótulo, para que no se lea como lo ya pagado. El otro valor vive en el detalle (zona 5).
      key: 'valor', header: 'Valor', align: 'right',
      render: (f) => (
        <span className="whitespace-nowrap text-sm">
          {f.valorPagado !== null
            ? num(pesos(f.valorPagado))
            : f.valorLiquidado !== null
              ? <>{num(pesos(f.valorLiquidado))} <small className={TENUE}>liquidado</small></>
              : '—'}
        </span>
      ),
    },
    { key: 'acciones', header: <span className="sr-only">Acciones</span>, acciones: true, render: acciones },
  ];
}
