// UUID v7 (RFC 9562): 48 bits de milisegundos Unix + aleatorio. Ordenable por tiempo, que es lo que
// pide el contrato `ia-consumo` v1 para `id` y `correlacion_id`. Sin dependencia nueva.
import { randomBytes } from 'node:crypto';

export function uuidv7(ahoraMs: number = Date.now()): string {
  const b = randomBytes(16);
  let ts = Math.max(0, Math.floor(ahoraMs));
  for (let i = 5; i >= 0; i--) { b[i] = ts % 256; ts = Math.floor(ts / 256); }
  b[6] = (b[6]! & 0x0f) | 0x70; // versión 7
  b[8] = (b[8]! & 0x3f) | 0x80; // variante RFC
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
