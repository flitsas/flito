// Contratos de la ficha fiscal del cliente (HU #11298, Feature #11241).
//
// Viven aparte de la pantalla porque los comparten el modal, la cascada de ubicación y la señal de
// «no facturable» del listado.

export interface DatosFiscalesCliente {
  id: number;
  name: string;
  document: string | null;
  documentType: string | null;
  city: string | null;
  address: string | null;
  personType: string | null;
  idType: string | null;
  checkDigit: number | null;
  fiscalResponsibilities: string[] | null;
  countryCode: string | null;
  stateCode: string | null;
  cityCode: string | null;
  commercialName: string | null;
  branchOffice: number | null;
  contactFirstName: string | null;
  contactLastName: string | null;
  contactEmail: string | null;
  phoneIndicative: string | null;
  phoneNumber: string | null;
}

export interface FaltanteCliente {
  motivo: string;
  detalle: string;
  campo?: string;
}

export interface VeredictoCliente {
  clienteId: number;
  facturable: boolean;
  pendienteClasificacion: boolean;
  faltantes: FaltanteCliente[];
}

export interface OpcionUbicacion { codigo: string; nombre: string }

export interface CandidataCiudad {
  countryCode: string;
  stateCode: string;
  stateName: string;
  cityCode: string;
  cityName: string;
}

export interface PropuestaCiudad {
  textoOrigen: string;
  certeza: 'exacta' | 'aproximada' | 'ambigua' | 'sin_equivalencia';
  candidatas: CandidataCiudad[];
}
