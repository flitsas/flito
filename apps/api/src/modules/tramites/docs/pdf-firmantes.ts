// Construye firmantes PKCS#7 desde sellos biométrica del payload (port _construirFirmantesPDF).

import type { PdfFirmante } from './pdf-signer.js';

export interface SelloFirmaInput {
  parte?: string; rol?: string; contexto?: string;
  nombre?: string; documento?: string; tipoDoc?: string; email?: string;
}

export function construirFirmantesPdf(placa: string | undefined, override: SelloFirmaInput[] | null | undefined): PdfFirmante[] {
  if (!Array.isArray(override) || !override.length) return [];
  return override.map((r) => ({
    nombre: r.nombre || '',
    documento: r.documento || '',
    tipoDoc: r.tipoDoc || 'CC',
    email: r.email || '',
    rol: String(r.rol || r.parte || r.contexto || '').toUpperCase() === 'VENDEDOR' ? 'Tradente' : 'Adquirente',
    razon: 'Firma electronica avanzada (Ley 527/1999) - Traspaso vehiculo ' + (placa || ''),
    ubicacion: 'Colombia',
  }));
}

export function mapSellosContrato(firmantes: SelloFirmaInput[]): { vendedor: SelloFirmaInput | null; comprador: SelloFirmaInput | null } {
  let vendedor: SelloFirmaInput | null = null;
  let comprador: SelloFirmaInput | null = null;
  for (const f of firmantes) {
    const ctx = String(f.parte || f.rol || f.contexto || '').toUpperCase();
    const row = { contexto: ctx, firma_serie: (f as any).firma_serie || (f as any).firmaSerie, firma_hash_documento: (f as any).firma_hash || (f as any).firmaHash, firma_timestamp: (f as any).firma_timestamp || (f as any).firmaTimestamp, nombre: f.nombre, documento: f.documento, tipoDoc: f.tipoDoc };
    if (ctx === 'VENDEDOR' && !vendedor) vendedor = row as SelloFirmaInput;
    else if (ctx === 'COMPRADOR' && !comprador) comprador = row as SelloFirmaInput;
  }
  return { vendedor, comprador };
}
