// Fila de una solicitud aparcada porque el RUNT no respondió (HU #12997, UX §3.1).
//
// Tiene las MISMAS columnas que la fila de un SOAT, para que la tabla no cambie de forma, pero lo
// que no existe se dice: la incompleta no se ha enviado (Solicitado y Pagado «—»), no tiene placa ni
// marca (el VIN hace de identificador y una línea dice por qué faltan), no envejece contra un ANS
// (sin `AntiguedadPill`) y no se puede marcar (no tiene RUNT resuelto para el envío masivo ni
// comprobante para el ZIP). La descartada es un cierre: solo «Ver».
//
// El VIN se pinta en la celda, como el de cualquier SOAT de la cola; nunca entra en un `aria-label`.

import { ChevronRight } from 'lucide-react';
import type { SolicitudIncompletaFila } from '@operaciones/shared-types';
import { FlitTr, flitBtnSecondarySm } from '../../flit/flitPageKit';
import { ChipIncompletaSoat } from './ChipEstadoSoat';
import { fecha } from './tipos';

export default function FilaIncompletaSoat({ fila, conCasillas, conCompania, esCliente, puedeVer, onVer }: {
  fila: SolicitudIncompletaFila; conCasillas: boolean; conCompania: boolean; esCliente: boolean;
  /** `soat.incompleta.ver`: sin ella no hay «Ver» (no se pinta deshabilitado). */
  puedeVer: boolean;
  onVer: (f: SolicitudIncompletaFila) => void;
}) {
  const incompleta = fila.estado === 'incompleta';
  return (
    <FlitTr>
      {/* Celda vacía y no una casilla deshabilitada: no hay nada que marcar, y una casilla gris
          invita a preguntar por qué. Mantiene alineadas las columnas. */}
      {conCasillas && <td className="px-3 py-2" />}
      <td className="px-4 py-2 align-top">
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
          {puedeVer && (
            <button type="button" className={flitBtnSecondarySm} onClick={() => onVer(fila)}>
              Ver
              <ChevronRight size={16} aria-hidden="true" className="-mr-1 shrink-0" />
            </button>
          )}
        </div>
      </td>
    </FlitTr>
  );
}
