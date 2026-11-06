import crypto from 'crypto';

// TRAM-F3 — Firma electrónica avanzada (Ley 527/1999) generada al aprobar la
// biométrica. Espejo de CEA: documento canónico → SHA-256 → serie KYV-FEA-...
// El sello (serie+hash) viaja luego al contrato/FUR (proxy CEA con override).
export function generarSelloFirma(input: { tramiteId: number; parte: string | null; nombre: string; tipoDoc: string; documento: string; email: string; placa: string; vehiculo: string; score: number; bio: any }) {
  try {
    const ts = new Date().toISOString();
    const canonico = JSON.stringify({
      tipoDocumento: 'FIRMA_ELECTRONICA_AVANZADA_TRASPASO_VEHICULO',
      ley: 'Ley 527 de 1999 / Decreto 2364 de 2012',
      tramiteId: input.tramiteId,
      rolFirmante: (input.parte || '').toUpperCase(),
      firmante: { nombre: input.nombre, tipoDocumento: input.tipoDoc, numeroDocumento: input.documento, email: input.email },
      objeto: { placa: input.placa, vehiculo: input.vehiculo },
      identidadBiometrica: { scoreFacial: input.score, documentoOficial: input.bio?.documento_ocr?.es_documento_oficial === true, livenessOk: input.bio?.liveness?.es_persona_real === true },
      firmadoEn: ts,
    });
    const hash = crypto.createHash('sha256').update(canonico).digest('hex');
    const serie = 'KYV-FEA-' + ts.replace(/[-:T.Z]/g, '').slice(0, 14) + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    return { firmaSerie: serie, firmaHash: hash, firmaTimestamp: new Date(ts) };
  } catch {
    return { firmaSerie: null, firmaHash: null, firmaTimestamp: null };
  }
}
