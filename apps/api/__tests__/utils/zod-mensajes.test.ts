// Bug #13928 — migración a zod 4. `mensajesDeTipo` reemplaza los `required_error` /
// `invalid_type_error` de zod 3 y debe conservar su semántica: solo el issue de TIPO toma el
// mensaje propio; las reglas sin mensaje (.max) siguen con el de zod, y `.guid()` acepta lo mismo
// que el `.uuid()` laxo de zod 3.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { mensajesDeTipo } from '../../src/shared/utils/zod-mensajes.js';

const mensajes = (schema: z.ZodType, valor: unknown): string[] => {
  const r = schema.safeParse(valor);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe('mensajesDeTipo (zod 4, semántica de zod 3)', () => {
  const nombre = z.object({
    nombre: z.string({ error: mensajesDeTipo({ requerido: 'es obligatorio', tipo: 'debe ser texto' }) })
      .trim().min(1, 'no puede estar en blanco').max(3),
  });

  it('ausente → `requerido`; tipo incorrecto → `tipo`', () => {
    expect(mensajes(nombre, {})).toEqual(['es obligatorio']);
    expect(mensajes(nombre, { nombre: 7 })).toEqual(['debe ser texto']);
  });

  it('las reglas conservan su mensaje propio y, sin él, el de zod (no heredan `tipo`)', () => {
    expect(mensajes(nombre, { nombre: '  ' })).toEqual(['no puede estar en blanco']);
    const [msg] = mensajes(nombre, { nombre: 'abcd' });
    expect(msg).not.toBe('debe ser texto');
  });

  it('solo `tipo` en z.coerce: lo que no convierte (incluido undefined → NaN) toma el mensaje', () => {
    const valor = z.coerce.number({ error: mensajesDeTipo({ tipo: 'debe ser mayor que cero' }) })
      .positive({ message: 'debe ser mayor que cero (positivo)' });
    expect(mensajes(valor, 'abc')).toEqual(['debe ser mayor que cero']);
    expect(mensajes(valor, undefined)).toEqual(['debe ser mayor que cero']);
    expect(mensajes(valor, '-1')).toEqual(['debe ser mayor que cero (positivo)']);
    expect(valor.parse('5')).toBe(5);
  });

  it('`.guid()` acepta un identificador sin versión RFC (como `.uuid()` de zod 3)', () => {
    expect(z.string().guid().safeParse('00000000-0000-0000-0000-000000000001').success).toBe(true);
    expect(z.string().guid().safeParse('no-es-un-id').success).toBe(false);
  });
});
