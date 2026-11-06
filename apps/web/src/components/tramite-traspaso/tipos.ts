// Tipos del asistente de traspaso (HU #13988: extraídos de pages/TramiteTraspaso.tsx).

export interface Parte { nombre: string; documento: string; tipoDoc: string; direccion: string; telefono: string; email: string; ciudad: string }
export interface PreflightCheck { key: string; label: string; status: string; message: string }
export interface RuntConsultaPersist { documento?: string; tipoDoc?: string; consultado?: boolean; consultadoAt?: string; nombreRunt?: string }
