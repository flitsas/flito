// Fila de una solicitud aparcada porque el RUNT no respondió (HU #12997, UX §3.1).
//
// Tiene las MISMAS columnas que la fila de un SOAT, para que la tabla no cambie de forma, pero lo
// que no existe se dice: la incompleta no se ha enviado (Solicitado y Pagado «—»), no tiene placa ni
// marca (el VIN hace de identificador y una línea dice por qué faltan), no envejece contra un ANS
// (sin `AntiguedadPill`) y no se puede marcar (no tiene RUNT resuelto para el envío masivo ni
// comprobante para el ZIP). La descartada es un cierre: solo «Ver».
//
// El VIN se pinta en la celda, como el de cualquier SOAT de la cola; nunca entra en un `aria-label`.
//
// HU #12998: «Reintentar consulta» (UX §3.3) solo en la incompleta y solo con el permiso — sin él no
// se pinta. El botón se describe con la celda del vehículo (`aria-describedby`), no con el VIN en su
// nombre. En vuelo: `disabled` + `aria-busy` + «Consultando…», solo en ESTA fila.

import { ChevronRight, Loader2, RotateCw } from 'lucide-react';
import type { SolicitudIncompletaFila } from '@operaciones/shared-types';
import { FlitTr, flitBtnSecondarySm } from '../../flit/flitPageKit';
import { ChipIncompletaSoat } from './ChipEstadoSoat';
import { fecha } from './tipos';

export default function FilaIncompletaSoat({
  fila, conCasillas, conCompania, esCliente, puedeVer, onVer, puedeReintentar = false, consultando = false, onReintentar,
}: {
  fila: SolicitudIncompletaFila; conCasillas: boolean; conCompania: boolean; esCliente: boolean;
  /** `soat.incompleta.ver`: sin ella no hay «Ver» (no se pinta deshabilitado). */
  puedeVer: boolean;
  onVer: (f: SolicitudIncompletaFila) => void;
  /** `soat.solicitud.reintentar_runt` (HU #12998). */
  puedeReintentar?: boolean;
  /** La consulta de ESTA fila está en vuelo. */
  consultando?: boolean;
  onReintentar?: (f: SolicitudIncompletaFila) => void;
}) {
  const incompleta = fila.estado === 'incompleta';
  const idVehiculo = `inc-vehiculo-${fila.id}`;
  return (
    <FlitTr>
      {/* Celda vacía y no una casilla deshabilitada: no hay nada que marcar, y una casilla gris
          invita a preguntar por qué. Mantiene alineadas las columnas. */}
      {conCasillas && <td className="px-3 py-2" />}
      <td id={idVehiculo} className="px-4 py-2 align-top">
        <div className="whitespace-nowrap font-mono text-sm font-semibold">{fila.vin}</div>
        <div className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Datos del RUNT pendientes</div>
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-col items-start gap-1">
          <ChipIncompletaSoat estado={fila.estado} />
          {incompleta && (
            <span className="text-[11px] tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>
              Último intento: {fecha(fila.ultimoIntentoRuntEn)}
            </span>
          )}
        </div>
      </td>
      {conCompania && <td className="px-3 py-2 text-sm">{fila.companiaNombre ?? '—'}</td>}
      {!esCliente && <td className="px-3 py-2 text-sm">—</td>}
      <td className="px-3 py-2 text-sm">—</td>
      <td className="px-3 py-2 text-sm">—</td>
      {!esCliente && <td className="px-3 py-2 text-sm">—</td>}
      <td className="px-3 py-2">
        <div className="flex items-center gap-2 whitespace-nowrap">
          {incompleta && puedeReintentar && onReintentar && (
            <button type="button" className={flitBtnSecondarySm} aria-describedby={idVehiculo}
              disabled={consultando} aria-busy={consultando || undefined} onClick={() => onReintentar(fila)}>
              {consultando
                ? <Loader2 size={16} aria-hidden="true" className="shrink-0 animate-spin motion-reduce:animate-none" />
                : <RotateCw size={16} aria-hidden="true" className="shrink-0" />}
              {consultando ? 'Consultando…' : 'Reintentar consulta'}
            </button>
          )}
          {puedeVer && (
            <button type="button" className={flitBtnSecondarySm} data-ver-incompleta={fila.id} onClick={() => onVer(fila)}>
              Ver
              <ChevronRight size={16} aria-hidden="true" className="-mr-1 shrink-0" />
            </button>
          )}
        </div>
      </td>
    </FlitTr>
  );
}
