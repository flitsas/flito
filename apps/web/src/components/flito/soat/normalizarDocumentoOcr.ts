// Prellenado del número de documento leído por OCR: el formulario solo acepta letras y números.
// Solo se aplica a lo que viene de la factura; lo que el usuario escribe no se toca.
export function normalizarDocumentoOcr(tipoDocumento: string, valor: string): string {
  const crudo = valor.trim();
  // NIT con dígito de verificación («890903938-8» / «890.903.938 - 8»): el DV se descarta.
  const base = tipoDocumento === 'NIT' ? crudo.replace(/^(\d[\d.\s]{3,}\d)\s*-\s*\d$/, '$1') : crudo;
  return base.replace(/[^A-Za-z0-9]/g, '');
}
