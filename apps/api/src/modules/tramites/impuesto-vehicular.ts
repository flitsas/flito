// TRAM-TRASPASO-P1 — consulta impuesto vehicular (integración directa, sin CEA).

import {
  departamentoKeyFromOrganismoCodigo,
  impuestoIndicaPazSalvo,
  type ImpuestoConsultaDatosLike,
} from '@operaciones/shared-types';
import {
  consultarImpuestoVehicularDirect,
  type ImpuestoConsultaDatos,
  type ImpuestoConsultaInput,
  type ImpuestoConsultaResult,
} from '../integraciones/impuesto-vehicular.direct.js';

export { departamentoKeyFromOrganismoCodigo, impuestoIndicaPazSalvo };
export type { ImpuestoConsultaDatos, ImpuestoConsultaInput, ImpuestoConsultaResult };

export async function consultarImpuestoVehicular(input: ImpuestoConsultaInput): Promise<ImpuestoConsultaResult> {
  return consultarImpuestoVehicularDirect(input);
}
