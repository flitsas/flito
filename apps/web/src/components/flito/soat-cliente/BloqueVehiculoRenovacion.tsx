// FLITO — canal Cliente del SOAT: los campos del bloque «1 · Vehículo» de la RENOVACIÓN (HU #14019).
//
// Placa + documento del propietario y «Consultar» en el mismo renglón. **Sin tipo de documento** (AC2): el
// RUNT valida el número contra la placa. Placa y documento viajan SOLO en el cuerpo de un `POST`: nunca en
// la URL, en un `aria-label` ni en un título de modal. Lo que resulta de la consulta (banda, tarjeta,
// esqueleto) lo pinta la página debajo, como en el VIN.

import type { ReactNode, RefObject } from 'react';
import { Info } from 'lucide-react';
import { normalizarPlaca } from '../../../lib/mensajesTipoSoat';
import { Campo } from './bloques';

export const ID_PLACA = 'sol-placa';
export const ID_DOC_VEHICULO = 'sol-doc-vehiculo';

export default function BloqueVehiculoRenovacion({
  placa, documento, onPlaca, onDocumento, onBlurPlaca, onBlurDocumento, errorPlaca, errorDocumento,
  placaRef, documentoRef, readOnly, placaInvalida, documentoInvalido, describedByExtra, accion,
}: {
  placa: string; documento: string;
  onPlaca: (v: string) => void; onDocumento: (v: string) => void;
  onBlurPlaca: () => void; onBlurDocumento: () => void;
  errorPlaca?: string; errorDocumento?: string;
  placaRef: RefObject<HTMLInputElement>; documentoRef: RefObject<HTMLInputElement>;
  /** La consulta está en vuelo: `readOnly` y no `disabled`, como el VIN. */
  readOnly: boolean;
  /** Una banda de fuera explica el desenlace: marca el campo sin repetir el texto. */
  placaInvalida: boolean; documentoInvalido: boolean;
  describedByExtra?: string;
  accion: ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Campo
        id={ID_PLACA} label="Placa" valor={placa} inputRef={placaRef} codigo
        onCambio={(v) => onPlaca(normalizarPlaca(v))} onBlur={onBlurPlaca} error={errorPlaca}
        maxLength={7} autoComplete="off" readOnly={readOnly}
        invalido={placaInvalida} describedByExtra={placaInvalida ? describedByExtra : undefined}
      />
      <Campo
        id={ID_DOC_VEHICULO} label="Documento del propietario" valor={documento} inputRef={documentoRef}
        onCambio={onDocumento} onBlur={onBlurDocumento} error={errorDocumento}
        ayuda={(
          <span className="flex items-start gap-1.5">
            <Info size={14} aria-hidden="true" className="mt-px shrink-0" />
            Sin tipo de documento: el RUNT valida el número contra la placa.
          </span>
        )}
        maxLength={30} autoComplete="off" readOnly={readOnly}
        invalido={documentoInvalido} describedByExtra={documentoInvalido ? describedByExtra : undefined}
        accion={accion}
      />
    </div>
  );
}
