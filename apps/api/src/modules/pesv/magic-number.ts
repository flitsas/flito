// PESV-01 (BELK B1) — validación de magic-number para uploads de evidencia.
//
// El Content-Type que envía el navegador se deriva de la extensión y es
// trivialmente falsificable: un .exe renombrado a .pdf reporta
// `application/pdf` y supera el fileFilter de multer. Aquí olfateamos los bytes
// reales con `file-type` y rechazamos cualquier archivo cuyo contenido no sea un
// tipo permitido o cuyo tipo declarado no coincida con el detectado.

import { fileTypeFromBuffer } from 'file-type';

/** Mime detectado a partir del contenido (undefined si no se reconoce). */
export async function detectMime(buf: Buffer): Promise<string | undefined> {
  const ft = await fileTypeFromBuffer(buf);
  return ft?.mime;
}

/**
 * Valida el contenido real del archivo contra la allowlist y el mime declarado.
 * @returns `null` si es válido, o un mensaje de error (→ HTTP 400) si no.
 */
export async function checkMagicNumber(
  buf: Buffer,
  declaredMime: string,
  allowed: readonly string[],
): Promise<string | null> {
  const detected = await detectMime(buf);
  if (!detected || !allowed.includes(detected)) {
    return `Contenido de archivo no permitido (detectado: ${detected ?? 'desconocido'}). Tipos válidos: PDF, JPG, PNG, XLSX, DOCX.`;
  }
  if (detected !== declaredMime) {
    return `El tipo declarado (${declaredMime}) no coincide con el contenido real del archivo (${detected}).`;
  }
  return null;
}
