// Errores de pdf.js traducidos a copy para la persona (BUG #14569).
//
// pdf.js rechaza un PDF cifrado con `PasswordException` y mensaje en inglés («No password given»),
// y los visores lo pintaban tal cual. Ningún visor muestra el `message` de pdf.js: el protegido
// tiene su frase, y cualquier otro fallo de pdf.js una genérica en español. Los errores de NEGOCIO
// del API (HTTP con frase propia) no pasan por aquí: los sigue resolviendo cada visor.

export const COPY_PDF_PROTEGIDO = 'Este documento está protegido con contraseña y no se puede previsualizar';
export const COPY_PDF_ILEGIBLE = 'No pudimos mostrar la vista previa de este documento.';

/** Nombres de las excepciones propias de pdf.js (`BaseException` y derivadas). */
const EXCEPCIONES_PDFJS = new Set([
  'PasswordException', 'InvalidPDFException', 'MissingPDFException', 'UnexpectedResponseException',
  'ResponseException', 'FormatError', 'UnknownErrorException', 'AbortException',
]);

function nombreDe(e: unknown): string | undefined {
  const nombre = (e as { name?: unknown } | null | undefined)?.name;
  return typeof nombre === 'string' ? nombre : undefined;
}

/** `true` si pdf.js no pudo abrir el documento porque está cifrado con contraseña. */
export function esPdfProtegido(e: unknown): boolean {
  return nombreDe(e) === 'PasswordException';
}

/** `true` si el error lo lanzó pdf.js (y su `message` no debe llegar a la pantalla). */
export function esErrorPdfjs(e: unknown): boolean {
  const nombre = nombreDe(e);
  return nombre !== undefined && EXCEPCIONES_PDFJS.has(nombre);
}

/**
 * Copy del error de un visor: protegido, genérico de pdf.js, o —si no vino de pdf.js— lo que diga
 * el visor (`respaldo`), que es donde viven los errores HTTP/de negocio que ya se mostraban bien.
 */
export function mensajeErrorPdf(e: unknown, respaldo: () => string): string {
  if (esPdfProtegido(e)) return COPY_PDF_PROTEGIDO;
  if (esErrorPdfjs(e)) return COPY_PDF_ILEGIBLE;
  return respaldo();
}
