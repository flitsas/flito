import { describe, it, expect } from 'vitest';
import {
  vehiculoSchema, compradorSchema, documentosSchema, validacionIdentidadSchema,
} from '../../src/modules/tramites/tramites.schemas.js';

describe('TRAM-08 · contratos Zod JSONB del trámite', () => {
  describe('vehiculoSchema', () => {
    it('acepta campos conocidos y preserva extras RUNT (passthrough)', () => {
      const r = vehiculoSchema.safeParse({ marca: 'Mazda', linea: 'CX-30', modelo: '2024', organismoTransito: 'BTA', runtExtra: 'x' });
      expect(r.success).toBe(true);
      if (r.success) expect((r.data as any).organismoTransito).toBe('BTA');
    });
    it('rechaza tipo incorrecto en campo conocido', () => {
      expect(vehiculoSchema.safeParse({ marca: 123 }).success).toBe(false);
    });
    it('rechaza string excesivamente largo', () => {
      expect(vehiculoSchema.safeParse({ marca: 'x'.repeat(201) }).success).toBe(false);
    });
  });

  describe('compradorSchema', () => {
    const base = { nombre: 'Ana Pérez', tipoDoc: 'CC', documento: '1020304050' };
    it('acepta comprador válido', () => {
      expect(compradorSchema.safeParse({ ...base, email: 'a@x.com' }).success).toBe(true);
    });
    it('acepta email vacío', () => {
      expect(compradorSchema.safeParse({ ...base, email: '' }).success).toBe(true);
    });
    it('rechaza si falta nombre/tipoDoc/documento', () => {
      expect(compradorSchema.safeParse({ tipoDoc: 'CC', documento: '1' }).success).toBe(false);
      expect(compradorSchema.safeParse({ ...base, documento: '' }).success).toBe(false);
    });
    it('rechaza email con formato inválido', () => {
      expect(compradorSchema.safeParse({ ...base, email: 'no-es-email' }).success).toBe(false);
    });
  });

  describe('documentos / validacionIdentidad (objeto acotado)', () => {
    it('acepta objeto plano', () => {
      expect(documentosSchema.safeParse({ factura: { ok: true }, impronta: { ok: false } }).success).toBe(true);
      expect(validacionIdentidadSchema.safeParse({ score: 0.97, aprobado: true }).success).toBe(true);
    });
    it('rechaza array (no es objeto plano)', () => {
      expect(documentosSchema.safeParse(['x']).success).toBe(false);
    });
    it('rechaza objeto con demasiadas claves (>50)', () => {
      const big: Record<string, unknown> = {};
      for (let i = 0; i < 51; i++) big[`k${i}`] = i;
      expect(documentosSchema.safeParse(big).success).toBe(false);
    });
  });
});
