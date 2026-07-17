import { describe, it, expect } from 'vitest';
import { checkMagicNumber, detectMime } from '../../src/modules/pesv/magic-number.js';

const ALLOWED = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

// Bytes mínimos reconocibles por file-type.
const PDF = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]); // 'MZ' DOS/PE header

describe('PESV-01 · checkMagicNumber (BELK B1)', () => {
  it('PDF real con mime correcto → válido (null)', async () => {
    expect(await checkMagicNumber(PDF, 'application/pdf', ALLOWED)).toBeNull();
  });

  it('PNG real con mime correcto → válido', async () => {
    expect(await detectMime(PNG)).toBe('image/png');
    expect(await checkMagicNumber(PNG, 'image/png', ALLOWED)).toBeNull();
  });

  it('JPEG real con mime correcto → válido', async () => {
    expect(await checkMagicNumber(JPG, 'image/jpeg', ALLOWED)).toBeNull();
  });

  it('.exe (MZ) renombrado y declarado como application/pdf → rechazado', async () => {
    const err = await checkMagicNumber(EXE, 'application/pdf', ALLOWED);
    expect(err).not.toBeNull();
    expect(err).toMatch(/no permitido|no coincide/i);
  });

  it('mismatch: contenido PNG declarado como PDF → rechazado por discrepancia', async () => {
    const err = await checkMagicNumber(PNG, 'application/pdf', ALLOWED);
    expect(err).not.toBeNull();
    expect(err).toMatch(/no coincide/i);
  });

  it('contenido irreconocible (basura) → rechazado', async () => {
    const garbage = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    const err = await checkMagicNumber(garbage, 'application/pdf', ALLOWED);
    expect(err).not.toBeNull();
    expect(err).toMatch(/desconocido|no permitido/i);
  });
});
