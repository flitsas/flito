// Reporte de costos — las acciones de una fila: UN botón y el ⋮ (rediseño, Épica #13763, spec §3.6).
//
// Antes la fila llevaba hasta siete botones y el campo del motivo del reverso en línea, y medía
// ~225 px. Ahora: la acción que toca (Liquidar / Facturar / Enviar a facturación) como SECUNDARIA
// —la primaria de la visita es la masiva— y lo demás en `MenuFila` (Soporte, Servicios, Viajes,
// Aceptar diferencia, Reversar…). Sin el permiso, la opción no se pinta: la regla de siempre.
// Reversar pide el motivo en un `FlitModal`, no en un campo dentro de la celda.

import { useState, type ReactNode } from 'react';
import FlitModal from '../flit/FlitModal';
import { MenuFila, type OpcionMenuFila } from '../flit/MenuFila';
import { flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle, flitBtnSecondarySm, flitInp } from '../flit/flitPageKit';
import { faltantes, type Fila } from './tiposReporteCostos';
import { nombreAccesibleAceptar, pendientesDe, ROTULO_ACEPTAR, tituloAceptar } from '../../lib/diferenciaDocumental';
import { nombreAccesibleBotonViajes, rotuloBotonViajes } from '../../lib/viajesLogisticaReporte';

/** «2 asignados» · «1 asignado» · «ninguno» (también con `null`: no se sabe, no se cuenta). */
function nombreDeCantidad(n: number | null): string {
  if (n === null || n <= 0) return 'ninguno';
  return n === 1 ? '1 asignado' : `${n} asignados`;
}

export default function AccionesFilaReporteCostos({
  fila, puedeLiquidar, puedeReversar, puedeVerServicios, puedeAceptarDiferencia, enProceso,
  onLiquidar, onFacturar, onReversar, onSoportes, onServicios, onViajes, onAceptarDiferencia, accionEnvio,
}: {
  fila: Fila; puedeLiquidar: boolean; puedeReversar: boolean; puedeVerServicios: boolean; puedeAceptarDiferencia: boolean; enProceso: boolean;
  onLiquidar: () => void; onFacturar: () => void; onReversar: (motivo: string) => void; onSoportes: () => void;
  onServicios: () => void; onViajes: () => void; onAceptarDiferencia: () => void;
  /** «Enviar a facturación» y su «¿Por qué no?», cuando aplica (HU #11329). */
  accionEnvio?: ReactNode;
}) {
  const [reversando, setReversando] = useState(false);
  const [motivo, setMotivo] = useState('');
  const falta = faltantes(fila);
  const bloqueado = falta.length > 0;
  const pendientes = pendientesDe(fila);
  const liquidado = fila.estadoLiquidacion === 'liquidado';
  const n = fila.serviciosAdicionalesCantidad;

  const opciones: OpcionMenuFila[] = [
    { id: 'soporte', texto: 'Soporte', onElegir: onSoportes },
    ...(puedeVerServicios ? [{
      id: 'servicios', texto: n && n > 0 ? `Servicios · ${n}` : 'Servicios', onElegir: onServicios,
      nombreAccesible: `Servicios adicionales de ${fila.idFlit}: ${nombreDeCantidad(n)}`,
    }] : []),
    {
      id: 'viajes', texto: rotuloBotonViajes(fila.logisticaViajesCantidad), onElegir: onViajes,
      nombreAccesible: nombreAccesibleBotonViajes(fila.idFlit, fila.logisticaViajesCantidad),
    },
    ...(puedeAceptarDiferencia && pendientes.length > 0
      ? [{
        id: 'aceptar', texto: ROTULO_ACEPTAR, onElegir: onAceptarDiferencia, deshabilitada: enProceso,
        nombreAccesible: nombreAccesibleAceptar(fila.idFlit, pendientes), motivo: tituloAceptar(fila, pendientes),
      }]
      : []),
    ...(puedeReversar && liquidado
      ? [{ id: 'reversar', texto: 'Reversar…', onElegir: () => setReversando(true), deshabilitada: enProceso }]
      : []),
  ];

  const confirmar = () => {
    onReversar(motivo.trim());
    setReversando(false);
    setMotivo('');
  };

  return (
    <div className="ml-auto flex w-max flex-wrap items-center justify-end gap-1 whitespace-nowrap">
      {puedeLiquidar && !fila.sellada && (
        <button type="button" className={flitBtnSecondarySm} disabled={enProceso || bloqueado}
          aria-label={`Liquidar ${fila.idFlit}`}
          title={bloqueado ? `Falta: ${falta.join(', ')}` : 'Sellar los valores de este trámite'}
          onClick={onLiquidar}>Liquidar</button>
      )}
      {puedeLiquidar && liquidado && (
        <button type="button" className={flitBtnSecondarySm} disabled={enProceso}
          aria-label={`Facturar ${fila.idFlit}`} onClick={onFacturar}>Facturar</button>
      )}
      {accionEnvio}
      <MenuFila etiqueta={`Más acciones de ${fila.idFlit}`} opciones={opciones} />

      {reversando && (
        <FlitModal title={`Reversar la liquidación de ${fila.idFlit}`} onClose={() => { setReversando(false); setMotivo(''); }}>
          <label className="block text-sm font-medium" htmlFor={`motivo-reverso-${fila.tramiteId}`}
            style={{ color: 'var(--flit-text-primary)' }}>
            Motivo del reverso
          </label>
          <input id={`motivo-reverso-${fila.tramiteId}`} className={`${flitInp} mt-1`} value={motivo}
            onChange={(e) => setMotivo(e.target.value)} placeholder="Al menos 5 caracteres" />
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
              onClick={() => { setReversando(false); setMotivo(''); }}>Cancelar</button>
            <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle}
              disabled={motivo.trim().length < 5 || enProceso} onClick={confirmar}>Confirmar</button>
          </div>
        </FlitModal>
      )}
    </div>
  );
}
