// TRAM-INNOV-B3 — contrato del proveedor de firma electrónica (adapter pattern).

export interface CrearFirmaInput {
  tramiteId: number;
  rol: 'comprador' | 'vendedor';
  docTipo: string;
  firmante: { nombre: string | null; email: string };
}

export interface CrearFirmaResult {
  /** Id del sobre/documento en el proveedor (envelope/doc token). */
  envelopeId: string;
  /** URL a la que se envía al firmante. Mock: página simulada; ZapSign: signer URL. */
  signUrl: string;
}

export interface FirmaProvider {
  readonly nombre: string;
  crearSolicitud(input: CrearFirmaInput): Promise<CrearFirmaResult>;
}
