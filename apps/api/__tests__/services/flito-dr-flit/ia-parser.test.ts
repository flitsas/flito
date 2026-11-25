// HU #13856 (Feature #13696, IA-4) — parser estricto de la salida del modelo. AC5 (fuera de contrato) y
// AC6 (normalización). Reglas 1..8 del diseño (`dr-flit-ia.parser.ts`). Puro: sin BD ni red.
import { describe, it, expect } from 'vitest';
import {
  ESQUEMA_JSON_SALIDA_IA, parsearSalidaIa, textoPlano, type ContextoParser,
} from '../../../src/modules/flito-dr-flit/dr-flit-ia.parser.js';
import type { FichaAyudaApi } from '../../../src/modules/flito-dr-flit/dr-flit-ia.contexto.js';

const ficha = (clave: string, etiqueta: string, anclas: Array<[string, string]>): FichaAyudaApi => ({
  clave, permiso: clave, etiqueta, resumen: `Resumen de ${etiqueta}`, version: '1', fecha: '2026-10-01',
  palabrasClave: [], consultas: [], secciones: anclas.map(([ancla, titulo]) => ({ ancla, titulo, texto: `Texto ${titulo}` })),
});

const FICHAS = [
  ficha('soat', 'SOAT', [['como-certificar', 'Cómo certificar'], ['estados', 'Estados']]),
  ficha('flito_impuestos', 'Impuestos', [['liquidar', 'Liquidar']]),
];
const CTX: ContextoParser = { fichas: FICHAS, tokensPeticion: ['[PLACA_1]', '[VIN_1]', '[DOC_1]', '[TRAMITE_1]'] };

const salida = (o: Record<string, unknown> = {}) => JSON.stringify({
  intent: 'duda', reply: 'Use el botón Certificar.', enManuales: true,
  citas: [{ clave: 'soat', ancla: 'como-certificar' }], gestionTarget: null, gestionRef: null, ...o,
});

const parsear = (o: Record<string, unknown> = {}) => parsearSalidaIa(salida(o), CTX);

describe('parser IA — AC5: fuera de contrato → respuesta-invalida (regla 1, 2 y 4)', () => {
  it.each([
    ['JSON no parseable', '{"intent": "duda", '],
    ['texto fuera del objeto', `Claro: ${salida()}`],
    ['campo extra', salida({ extra: 1 })],
    ['intent fuera del enum', salida({ intent: 'ventas' })],
    ['tipo erróneo', salida({ enManuales: 'si' })],
    ['falta un campo', JSON.stringify({ intent: 'duda', reply: 'x', enManuales: false, citas: [], gestionTarget: null })],
    ['campo extra en una cita', salida({ citas: [{ clave: 'soat', ancla: null, url: 'x' }] })],
    ['más de 3 citas', salida({ citas: Array.from({ length: 4 }, () => ({ clave: 'soat', ancla: null })) })],
    ['reply de más de 1200', salida({ reply: 'a'.repeat(1201) })],
    ['gestionTarget fuera del enum', salida({ intent: 'gestion', gestionTarget: 'telefono' })],
  ])('%s', (_n, crudo) => {
    expect(parsearSalidaIa(crudo, CTX)).toEqual({ ok: false });
  });

  it('regla 2: cita a una ficha que no se envió → inválida (aunque otra cita sea válida)', () => {
    expect(parsear({ citas: [{ clave: 'soat', ancla: null }, { clave: 'flito_tramites', ancla: null }] })).toEqual({ ok: false });
  });

  it('regla 4: duda con enManuales=true y sin citas → inválida', () => {
    expect(parsear({ citas: [] })).toEqual({ ok: false });
  });

  it('regla 4: duda con enManuales=false y sin citas → válida', () => {
    const r = parsear({ enManuales: false, citas: [], reply: 'Eso no está en los manuales.' });
    expect(r).toMatchObject({ ok: true, salida: { intent: 'duda', enManuales: false, citas: [], citedSlugs: [] } });
  });

  it('regla 5: gestion sin gestionTarget → inválida', () => {
    expect(parsear({ intent: 'gestion', citas: [], gestionTarget: null })).toEqual({ ok: false });
  });
});

describe('parser IA — AC1/AC6: normalización', () => {
  it('duda válida: citas con títulos, citedSlugs únicos, gestion en null', () => {
    const r = parsear({
      citas: [{ clave: 'soat', ancla: 'como-certificar' }, { clave: 'soat', ancla: 'estados' }, { clave: 'flito_impuestos', ancla: 'liquidar' }],
    });
    expect(r).toEqual({
      ok: true,
      salida: {
        intent: 'duda', reply: 'Use el botón Certificar.', enManuales: true,
        citas: [
          { clave: 'soat', ancla: 'como-certificar', tituloFicha: 'SOAT', tituloSeccion: 'Cómo certificar' },
          { clave: 'soat', ancla: 'estados', tituloFicha: 'SOAT', tituloSeccion: 'Estados' },
          { clave: 'flito_impuestos', ancla: 'liquidar', tituloFicha: 'Impuestos', tituloSeccion: 'Liquidar' },
        ],
        citedSlugs: ['soat', 'flito_impuestos'],
        gestionTarget: null, gestionRef: null,
      },
    });
  });

  it('regla 3: ancla inexistente en su ficha → la cita se conserva sin ancla', () => {
    const r = parsear({ citas: [{ clave: 'soat', ancla: 'no-existe' }] });
    expect(r).toMatchObject({ ok: true, salida: { citas: [{ clave: 'soat', ancla: null, tituloFicha: 'SOAT', tituloSeccion: null }] } });
  });

  it('regla 3: un ancla de OTRA ficha tampoco vale', () => {
    const r = parsear({ citas: [{ clave: 'soat', ancla: 'liquidar' }] });
    expect(r).toMatchObject({ ok: true, salida: { citas: [{ clave: 'soat', ancla: null }] } });
  });

  it('citas repetidas (misma ficha y ancla) se devuelven una vez', () => {
    const r = parsear({ citas: [{ clave: 'soat', ancla: 'x' }, { clave: 'soat', ancla: null }] });
    expect(r).toMatchObject({ ok: true, salida: { citas: [{ clave: 'soat', ancla: null }] } });
  });

  it('regla 5: gestion → reply null y gestionRef válido del tipo pedido', () => {
    const r = parsear({ intent: 'gestion', reply: 'Consultando…', citas: [], gestionTarget: 'placa', gestionRef: '[PLACA_1]' });
    expect(r).toMatchObject({ ok: true, salida: { intent: 'gestion', reply: null, gestionTarget: 'placa', gestionRef: '[PLACA_1]' } });
  });

  it.each([
    ['token que no está en la petición', 'placa', '[PLACA_2]'],
    ['token de otro tipo', 'placa', '[VIN_1]'],
    ['valor en claro', 'placa', 'ABC123'],
    ['cliente con token que no es DOC', 'cliente', '[TRAMITE_1]'],
  ])('regla 5: gestionRef con %s → null', (_n, target, ref) => {
    const r = parsear({ intent: 'gestion', citas: [], gestionTarget: target, gestionRef: ref });
    expect(r).toMatchObject({ ok: true, salida: { gestionTarget: target, gestionRef: null } });
  });

  it.each([['vin', '[VIN_1]'], ['tramite', '[TRAMITE_1]'], ['cliente', '[DOC_1]']])(
    'regla 5: %s acepta %s', (target, ref) => {
      const r = parsear({ intent: 'gestion', citas: [], gestionTarget: target, gestionRef: ref });
      expect(r).toMatchObject({ ok: true, salida: { gestionRef: ref } });
    },
  );

  it('regla 6: soporte → reply null', () => {
    expect(parsear({ intent: 'soporte', citas: [], enManuales: false })).toMatchObject({ ok: true, salida: { intent: 'soporte', reply: null } });
  });

  it('regla 8: fuera de gestion, gestionTarget y gestionRef salen null', () => {
    for (const intent of ['duda', 'soporte', 'no_claro']) {
      const r = parsear({ intent, enManuales: false, citas: [], gestionTarget: 'placa', gestionRef: '[PLACA_1]' });
      expect(r).toMatchObject({ ok: true, salida: { gestionTarget: null, gestionRef: null } });
    }
  });

  it('regla 7: reply como texto plano, sin URLs ni etiquetas HTML', () => {
    const r = parsear({ intent: 'no_claro', enManuales: false, citas: [], reply: 'Vea <a href="https://x.co">aquí</a> o https://evil.example/p?q=1 y www.malo.co <script>alert(1)</script>fin' });
    expect(r.ok).toBe(true);
    const reply = r.ok ? r.salida.reply! : '';
    expect(reply).not.toMatch(/https?:|www\.|<|>/);
    expect(reply).toContain('fin');
  });

  it('textoPlano conserva saltos de línea y el texto normal', () => {
    expect(textoPlano('Paso 1: abra SOAT.\nPaso 2: <b>Certificar</b>.')).toBe('Paso 1: abra SOAT.\nPaso 2: Certificar .');
  });
});

describe('JSON Schema de la salida estructurada', () => {
  it('es estricto: additionalProperties false y todos los campos requeridos (también en citas)', () => {
    expect(ESQUEMA_JSON_SALIDA_IA.additionalProperties).toBe(false);
    expect([...ESQUEMA_JSON_SALIDA_IA.required].sort()).toEqual(Object.keys(ESQUEMA_JSON_SALIDA_IA.properties).sort());
    const items = ESQUEMA_JSON_SALIDA_IA.properties.citas.items;
    expect(items.additionalProperties).toBe(false);
    expect([...items.required].sort()).toEqual(['ancla', 'clave']);
  });
});
