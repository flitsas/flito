// Enmascaramiento de PII para logs y audit trails (ISO 27001 A.8.11, Ley 1581 Colombia).
// Las funciones devuelven una versión OCULTANTE del dato — útil para console.log y audit detail.
// NO usar para datos que se vayan a procesar o almacenar — solo para observabilidad.

/**
 * Enmascara un documento (cédula/NIT/pasaporte) mostrando primeros 2 y últimos 3 caracteres.
 * - "1036640908" → "10*****908"
 * - "ABC" → "***"
 * - null/undefined/'' → ''
 */
export function maskDocument(doc: string | null | undefined): string {
  if (!doc) return '';
  const s = String(doc).trim();
  if (s.length <= 4) return '*'.repeat(s.length);
  if (s.length <= 6) return s.slice(0, 1) + '*'.repeat(s.length - 2) + s.slice(-1);
  return s.slice(0, 2) + '*'.repeat(s.length - 5) + s.slice(-3);
}

/**
 * Enmascara un nombre completo: muestra iniciales y oculta el resto.
 * - "ANALEANDRA HINCAPIE OSPINA" → "A. H. O."
 * - "JUAN" → "J."
 * - null → ''
 */
export function maskName(name: string | null | undefined): string {
  if (!name) return '';
  return String(name).trim().split(/\s+/).map((word) => word.charAt(0).toUpperCase() + '.').join(' ');
}

/**
 * Enmascara email: oculta el local part dejando primer y último carácter.
 * - "ana.hincapie@yahoo.es" → "a***e@yahoo.es"
 * - "ab@x.com" → "**@x.com"
 */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return '';
  const s = String(email).trim();
  const at = s.indexOf('@');
  if (at < 0) return '***';
  const local = s.slice(0, at);
  const domain = s.slice(at);
  if (local.length <= 2) return '*'.repeat(local.length) + domain;
  return local.charAt(0) + '*'.repeat(Math.max(1, local.length - 2)) + local.charAt(local.length - 1) + domain;
}

/**
 * Enmascara teléfono: oculta los dígitos centrales.
 * - "3003427829" → "300***7829"
 * - "+57 300 342 7829" → mantiene formato pero enmascara dígitos
 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length <= 4) return '*'.repeat(digits.length);
  return digits.slice(0, 3) + '*'.repeat(digits.length - 7) + digits.slice(-4);
}

/**
 * Enmascara TODOS los campos PII de un objeto antes de loggear o auditar.
 * Útil para `audit({ detail: JSON.stringify(maskPII(obj)) })`.
 */
export function maskPII<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) { out[k] = v; continue; }
    if (typeof v !== 'string') { out[k] = v; continue; }
    const lk = k.toLowerCase();
    if (lk.includes('document') || lk.includes('cedula') || lk.includes('cédula') || lk.includes('doc_number') || lk.includes('nit')) {
      out[k] = maskDocument(v);
    } else if (lk.includes('email') || lk.includes('correo')) {
      out[k] = maskEmail(v);
    } else if (lk.includes('phone') || lk.includes('celular') || lk.includes('telefono') || lk.includes('teléfono') || lk.includes('movil')) {
      out[k] = maskPhone(v);
    } else if (lk.includes('name') || lk.includes('nombre') || lk.includes('apellido') || lk.includes('full_name') || lk.includes('owner_name') || lk.includes('propietario')) {
      out[k] = maskName(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
