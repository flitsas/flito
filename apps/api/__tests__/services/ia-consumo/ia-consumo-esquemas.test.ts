// Épica #14548 (ADR-0051, bloque A) — esquemas Zod, ventana de consulta y validación del rango del visor de consumo de IA.
// Pura: sin base de datos. Las rutas y el servicio se prueban en `ia-consumo-registros.test.ts`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { IA_RANGO_MAX_DIAS } from '@operaciones/shared-types';
import { hoyColombia } from '../../../src/shared/utils/fecha-rango.js';
import { buscarIaSchema, esFechaIso, filtroIaSchema, sinQuery } from '../../../src/modules/ia-consumo/ia-consumo.esquemas.js';
import { calcularVentana, validarRango } from '../../../src/modules/ia-consumo/ia-consumo.service.js';
import { IaConsumoError, mensajeFueraDeVentana } from '../../../src/modules/ia-consumo/ia-consumo.errors.js';

/** Suma `dias` naturales a una fecha `YYYY-MM-DD`. */
const sumarDias = (fecha: string, dias: number): string =>
  new Date(Date.parse(`${fecha}T00:00:00Z`) + dias * 86_400_000).toISOString().slice(0, 10);

const hoy = hoyColombia();
const ventana = calcularVentana(hoy, 3);

/** El código de error de una validación, o `null` si pasó. */
function codigoDe(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof IaConsumoError ? e.codigo : 'otro';
  }
}

describe('ventana de consulta (D8, A-09)', () => {
  it.each([
    ['2026-11-27', 3, '2026-08-27'],
    ['2026-05-31', 3, '2026-02-28'],
    ['2026-03-31', 1, '2026-02-28'],
    ['2028-02-29', 12, '2027-02-28'],
  ])('calcularVentana(%s, %i) empieza el %s', (hoyDado, meses, desde) => {
    expect(calcularVentana(hoyDado, meses)).toEqual({ desde, hasta: hoyDado, meses });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('la variable está documentada en `.env.example`, junto a las IA_CONSUMO_* (A-30)', () => {
    const ejemplo = readFileSync(join(__dirname, '../../../.env.example'), 'utf8');
    expect(ejemplo).toMatch(/^IA_CONSUMO_VISOR_VENTANA_MESES=3$/m);
    expect(ejemplo.indexOf('IA_CONSUMO_VISOR_VENTANA_MESES')).toBeGreaterThan(ejemplo.indexOf('IA_CONSUMO_LOG='));
  });

  it('el defecto de `IA_CONSUMO_VISOR_VENTANA_MESES` es 3 cuando la variable no viene (A-10)', async () => {
    const { env } = await import('../../../src/config/env.js');
    expect(env.IA_CONSUMO_VISOR_VENTANA_MESES).toBe(3);
  });

  it('una variable vacía vale 3; 0, 25 o un texto hacen fallar el arranque (A-10)', async () => {
    vi.resetModules();
    vi.stubEnv('IA_CONSUMO_VISOR_VENTANA_MESES', '');
    const { env } = await import('../../../src/config/env.js');
    expect(env.IA_CONSUMO_VISOR_VENTANA_MESES).toBe(3);

    // Cada valor malo falla con el mensaje de zod de su regla (zod 4, `int().min(1).max(24)` con coerción a número).
    const motivos: [string, RegExp][] = [
      ['0', /Too small: expected number to be >=1/],
      ['25', /Too big: expected number to be <=24/],
      ['abc', /Invalid input: expected number, received NaN/],
    ];
    for (const [valor, motivo] of motivos) {
      vi.resetModules();
      vi.stubEnv('IA_CONSUMO_VISOR_VENTANA_MESES', valor);
      await expect(import('../../../src/config/env.js'), valor).rejects.toThrow(motivo);
    }
  });
});

describe('validación del rango (A-05 … A-08)', () => {
  it('31 días exactos pasan y 32 no (A-06)', () => {
    expect(validarRango({ desde: sumarDias(hoy, -30), hasta: hoy }, ventana, hoy)).toEqual({ desde: sumarDias(hoy, -30), hasta: hoy });
    expect(IA_RANGO_MAX_DIAS).toBe(31);
    expect(codigoDe(() => validarRango({ desde: sumarDias(hoy, -31), hasta: hoy }, ventana, hoy))).toBe('rango_demasiado_amplio');
  });

  it('desde posterior a hasta es un error y no se intercambian las fechas (A-05)', () => {
    expect(codigoDe(() => validarRango({ desde: hoy, hasta: sumarDias(hoy, -2) }, ventana, hoy))).toBe('rango_invalido');
  });

  it('hasta posterior a hoy en Colombia es un error (A-07)', () => {
    expect(codigoDe(() => validarRango({ desde: hoy, hasta: sumarDias(hoy, 1) }, ventana, hoy))).toBe('rango_invalido');
  });

  it('desde anterior a la ventana es `fuera_de_ventana` y el mensaje dice desde cuándo se puede ver (A-08)', () => {
    let error: unknown;
    try {
      validarRango({ desde: sumarDias(ventana.desde, -1), hasta: hoy }, ventana, hoy);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(IaConsumoError);
    expect((error as IaConsumoError).codigo).toBe('fuera_de_ventana');
    expect((error as IaConsumoError).status).toBe(400);
    expect((error as IaConsumoError).message).toContain(ventana.desde);
  });

  it('falta una fecha: `rango_invalido`', () => {
    expect(codigoDe(() => validarRango({ desde: hoy }, ventana, hoy))).toBe('rango_invalido');
    expect(codigoDe(() => validarRango({ hasta: hoy }, ventana, hoy))).toBe('rango_invalido');
  });

  it('el mensaje de la ventana distingue el singular: «el último mes»', () => {
    expect(mensajeFueraDeVentana('2026-10-01', 1)).toBe('Solo se puede consultar desde el 2026-10-01, el último mes.');
    expect(mensajeFueraDeVentana('2026-08-01', 3)).toBe('Solo se puede consultar desde el 2026-08-01, los últimos 3 meses.');
  });
});

describe('esquemas Zod (AGENTS §14; .strict() en todo)', () => {
  it('una fecha exige calendario válido', () => {
    expect(esFechaIso('2028-02-29')).toBe(true);
    expect(esFechaIso('2026-02-30')).toBe(false);
    expect(esFechaIso('2026-13-01')).toBe(false);
    expect(esFechaIso('26-11-27')).toBe(false);
  });

  it('el cuerpo de búsqueda rechaza claves que no existen', () => {
    expect(buscarIaSchema.safeParse({ desde: hoy, hasta: hoy, extra: 1 }).success).toBe(false);
    expect(buscarIaSchema.safeParse({ desde: hoy, hasta: hoy, filtros: { usuario: 'ana', extra: 1 } }).success).toBe(false);
    expect(buscarIaSchema.safeParse({ desde: hoy, hasta: hoy }).success).toBe(true);
  });

  it('un filtro fuera de catálogo o con formato libre es un 400 (A-17)', () => {
    expect(filtroIaSchema.safeParse({ origen: 'desconocido_x' }).success).toBe(false);
    expect(filtroIaSchema.safeParse({ modulo: 'SOAT-Mayus' }).success).toBe(false);
    expect(filtroIaSchema.safeParse({ proceso: 'ocr factura' }).success).toBe(false);
    expect(filtroIaSchema.safeParse({ tipoTarea: 'ocr', proveedor: 'anthropic', resultado: 'exito' }).success).toBe(true);
  });

  it('el modelo admite solo letras minúsculas, dígitos, punto y guion (A-16)', () => {
    expect(filtroIaSchema.safeParse({ modelo: 'claude-haiku-4-5' }).success).toBe(true);
    expect(filtroIaSchema.safeParse({ modelo: 'claude+haiku' }).success).toBe(false);
    expect(filtroIaSchema.safeParse({ modelo: 'x'.repeat(61) }).success).toBe(false);
  });

  it('una placa que no se puede normalizar es un 400', () => {
    expect(filtroIaSchema.safeParse({ placa: 'abc-123' }).success).toBe(true);
    expect(filtroIaSchema.safeParse({ placa: '---' }).success).toBe(false);
  });

  it('el cursor tiene como máximo 200 caracteres', () => {
    expect(buscarIaSchema.safeParse({ desde: hoy, hasta: hoy, cursor: 'a'.repeat(200) }).success).toBe(true);
    expect(buscarIaSchema.safeParse({ desde: hoy, hasta: hoy, cursor: 'a'.repeat(201) }).success).toBe(false);
  });

  it('las rutas sin parámetros rechazan cualquier query string', () => {
    expect(sinQuery.safeParse({}).success).toBe(true);
    expect(sinQuery.safeParse({ usuario: 'ana@ejemplo.co' }).success).toBe(false);
  });
});
