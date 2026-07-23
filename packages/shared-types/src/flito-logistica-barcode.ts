// FLITO Logística — lectura del código PDF417 del reverso de la Licencia de Tránsito (LT).
//
// Módulo PURO (sin deps): lo usan la web (previsualizar el escaneo) y la API (fuente autoritativa
// al persistir). El `rawValue` que entrega BarcodeDetector trae los campos separados por espacios;
// la FOTO embebida (JPEG base64 que empieza por `/9j/`) es el ancla que parte el string en dos:
//
//   <n.º licencia> <tipo doc> <n.º doc> <NOMBRE…> <DIRECCIÓN…> </9j/…foto…> <placa> <VIN> <chasis> <motor> <combustible>
//
// El número de la LT NO viaja en el código (va impreso debajo del código): se captura aparte (OCR/manual).

export interface LicenciaTransitoParseada {
  /** N.º de la licencia (no confundir con el n.º de LT, que va aparte). */
  numeroLicencia: string;
  tipoDocumento: string | null;
  propietarioDocumento: string | null;
  propietarioNombre: string | null;
  direccion: string | null;
  /** Foto del propietario embebida (JPEG base64, sin encabezado data:). */
  fotoBase64: string | null;
  placa: string;
  /** VIN / n.º de chasis (17 caracteres). */
  vin: string;
  numeroMotor: string | null;
  combustible: string | null;
}

// Palabras-vía con las que arranca una dirección colombiana: marcan el corte nombre|dirección.
const VIA = new Set([
  'CL', 'CLL', 'CALLE', 'CR', 'CRA', 'KR', 'CARRERA', 'AV', 'AVE', 'AVENIDA', 'AC', 'AK',
  'DG', 'DIAG', 'DIAGONAL', 'TV', 'TRANSV', 'TRANSVERSAL', 'MZ', 'MANZANA', 'VIA', 'KM',
  'AUT', 'AUTOPISTA', 'CTGE', 'CIRCULAR', 'CIR',
]);
const TIPO_DOC = /^(C\.?C\.?|N\.?I\.?T\.?|C\.?E\.?|T\.?I\.?|PA|PAS|PEP|NUIP)$/i;
// VIN: 17 caracteres, alfanuméricos sin I/O/Q (estándar ISO 3779).
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

/**
 * Interpreta el `rawValue` del PDF417 de una LT. Devuelve null si no se reconocen los campos
 * críticos (placa y VIN), para que el llamador trate el código como ilegible.
 */
export function parseLicenciaTransito(raw: string): LicenciaTransitoParseada | null {
  if (typeof raw !== 'string') return null;
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 5) return null;

  // Ancla: la foto (JPEG `/9j/` o PNG `iVBOR`). Parte en pre (identidad) y post (vehículo).
  const fotoIdx = tokens.findIndex((t) => t.startsWith('/9j/') || t.startsWith('iVBOR'));
  let pre: string[]; let post: string[]; let fotoBase64: string | null;
  if (fotoIdx >= 0) {
    pre = tokens.slice(0, fotoIdx);
    post = tokens.slice(fotoIdx + 1);
    fotoBase64 = tokens[fotoIdx];
  } else {
    // Sin foto: ancla de respaldo en el VIN (la placa va justo antes).
    fotoBase64 = null;
    const vinIdx = tokens.findIndex((t) => VIN_RE.test(t));
    if (vinIdx < 1) return null;
    pre = tokens.slice(0, vinIdx - 1);
    post = tokens.slice(vinIdx - 1);
  }
  if (pre.length < 1 || post.length < 2) return null;

  const numeroLicencia = pre[0];
  let tipoDocumento: string | null = null;
  let propietarioDocumento: string | null = null;
  let resto = pre.slice(1);
  if (resto[0] && TIPO_DOC.test(resto[0])) { tipoDocumento = resto[0]; resto = resto.slice(1); }
  if (resto[0] && /^\d{5,}$/.test(resto[0])) { propietarioDocumento = resto[0]; resto = resto.slice(1); }
  // El resto es NOMBRE + DIRECCIÓN; se corta en la primera palabra-vía.
  const corte = resto.findIndex((t) => VIA.has(t.toUpperCase()));
  const propietarioNombre = (corte === -1 ? resto : resto.slice(0, corte)).join(' ').trim() || null;
  const direccion = corte === -1 ? null : resto.slice(corte).join(' ').trim() || null;

  const placa = post[0].toUpperCase();
  const vin = (post.find((t) => VIN_RE.test(t)) ?? post[1]).toUpperCase();
  const numeroMotor = post.slice(1).find((t) => /^\d{9,}$/.test(t)) ?? null;
  const combustible = post[post.length - 1].toUpperCase();
  if (!placa || !vin) return null;

  return { numeroLicencia, tipoDocumento, propietarioDocumento, propietarioNombre, direccion, fotoBase64, placa, vin, numeroMotor, combustible };
}
