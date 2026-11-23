// Fila de una solicitud aparcada porque el RUNT no respondió (HU 12997, UX §3.1).
//
// Tiene las MISMAS columnas que la fila de un SOAT, para que la tabla no cambie de forma, pero lo
// que no existe se dice: la incompleta no se ha enviado (Solicitado y Pagado «—»), no tiene placa ni
// marca (el VIN hace de identificador y una línea dice por qué faltan), no envejece contra un ANS
// (sin `AntiguedadPill`) y no se puede marcar (no tiene RUNT resuelto para el envío masivo ni
// comprobante para el ZIP). La descartada es un cierre: solo «Ver».
//
// El VIN se pinta en la celda, como el de cualquier SOAT de la cola; nunca entra en un `aria-label`.
//
// Épica #14560: la fila vive dentro del `DataTable` de la cola (filas previas): `<tr>` plano, cada celda
// con su `data-etiqueta` para el modo tarjeta (<900 px), y el relleno lo pone el kit (`.tabla-wrap td`).
//
// HU 12998: «Reintentar consulta» (UX §3.3) solo en la incompleta y solo con el permiso — sin él no
// se pinta. El botón se describe con la celda del vehículo (`aria-describedby`), no con el VIN en su
// nombre. En vuelo: `disabled` + `aria-busy` + «Consultando…», solo en ESTA fila.

import EtiquetaTipoSoat from './EtiquetaTipoSoat';
import { Icono } from '../../flit/kit/Icono';
import { Girador } from '../../flit/Cargador';
import type { SolicitudIncompletaFila } from '@operaciones/shared-types';
import { flitBtnSecondarySm } from '../../flit/flitPageKit';
import { claseBoton } from '../../flit/GradientButton';
import { ChipIncompletaSoat } from './ChipEstadoSoat';
import { fecha } from './tipos';

export default function FilaIncompletaSoat({
  fila, conCasillas, conCompania, esCliente, puedeVer, onVer, puedeReintentar = false, consultando = false, onReintentar,
  puedeCompletar = false,
}: {
  fila: SolicitudIncompletaFila; conCasillas: boolean; conCompania: boolean; esCliente: boolean;
  /** `soat.incompleta.ver`: sin ella no hay «Ver» (no se pinta deshabilitado). */
  puedeVer: boolean;
  onVer: (f: SolicitudIncompletaFila) => void;
  /** `soat.solicitud.reintentar_runt` (HU 12998). */
  puedeReintentar?: boolean;
  /** La consulta de ESTA fila está en vuelo. */
  consultando?: boolean;
  onReintentar?: (f: SolicitudIncompletaFila) => void;
  /** `soat.solicitud.crear` (HU 14137): con ella, las pendientes de la carga masiva dicen «Completar». */
  puedeCompletar?: boolean;
}) {
  const incompleta = fila.estado === 'incompleta';
  // HU 14137: el RUNT SÍ respondió; lo que falta es la factura o el propietario. Otra fila, otra acción.
  const porCompletar = incompleta && (fila.motivoPendiente === 'falta_factura_venta' || fila.motivoPendiente === 'faltan_datos_propietario');
  const motivoTexto = fila.motivoPendiente === 'falta_factura_venta' ? 'Falta factura de venta' : 'Faltan datos del propietario';
  const idVehiculo = `inc-vehiculo-${fila.id}`;
  return (
    <tr data-fila="incompleta">
      {/* Celda vacía y no una casilla deshabilitada: no hay nada que marcar, y una casilla gris
          invita a preguntar por qué. Mantiene alineadas las columnas. */}
      {conCasillas && <td data-etiqueta="Seleccionar" />}
      <td id={idVehiculo} data-etiqueta="Vehículo" className="align-top">
        {/* Renovación con RUNT caído: `vin` es null y el identificador es la PLACA (HU 14019, AC7/AC9). */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="whitespace-nowrap font-mono text-sm font-semibold">{fila.vin ?? fila.placa ?? '—'}</span>
          <EtiquetaTipoSoat tipo={fila.tipoSoat} />
        </div>
        {!porCompletar && <div className="text-xs text-[color:var(--color-text-tertiary)]">Datos del RUNT pendientes</div>}
      </td>
      <td data-etiqueta="Estado">
        <div className="flex flex-col items-start gap-1">
          <ChipIncompletaSoat estado={fila.estado} />
          {porCompletar && <span className="text-xs text-[color:var(--color-text-secondary)]">{motivoTexto}</span>}
          {incompleta && !porCompletar && (
            <span className="text-xs tabular-nums text-[color:var(--color-text-tertiary)]">
              Último intento: {fecha(fila.ultimoIntentoRuntEn)}
            </span>
          )}
          {incompleta && fila.motivoPendiente === 'runt_sin_respuesta' && (
            <span className="text-xs text-[color:var(--color-text-tertiary)]">El RUNT no respondió</span>
          )}
        </div>
      </td>
      {conCompania && <td data-etiqueta="Compañía" className="text-sm">{fila.companiaNombre ?? '—'}</td>}
      {!esCliente && <td data-etiqueta="Gestiona" className="text-sm">—</td>}
      <td data-etiqueta="Solicitado" className="text-sm">—</td>
      <td data-etiqueta="Pagado" className="text-sm">—</td>
      {!esCliente && <td data-etiqueta="Valor" className="text-right text-sm">—</td>}
      <td className="fila-abrir">
        <div className="flex items-center gap-2 whitespace-nowrap">
          {incompleta && !porCompletar && puedeReintentar && onReintentar && (
            <button type="button" className={flitBtnSecondarySm} aria-describedby={idVehiculo}
              disabled={consultando} aria-busy={consultando || undefined} onClick={() => onReintentar(fila)}>
              {consultando
                ? <Girador className="shrink-0" />
                : <Icono nombre="reintento" size={16} className="shrink-0" />}
              {consultando ? 'Consultando…' : 'Reintentar consulta'}
            </button>
          )}
          {puedeVer && (
            <button type="button" className={claseBoton('secondary', 'sm')} data-variante="secundario" data-ver-incompleta={fila.id} onClick={() => onVer(fila)}>
              {porCompletar && puedeCompletar ? 'Completar' : 'Ver'}
              <Icono nombre="derecha" size={16} />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
