// HU #12827 — comparación PURA factura de venta vs RUNT y semáforo. Sin red ni base. Valores
// INVENTADOS (ningún VIN/placa real).

import { describe, it, expect } from 'vitest';
import type { CampoExtraido, ExtraccionFacturaVentaImpuesto } from '@operaciones/shared-types';
import {
  cilindradaDentroDeTolerancia, compararFacturaConRunt, facturaIlegible, inclusionPorTokens, textoComparable,
  type DatosComparablesRunt,
} from '../../src/modules/flito-impuestos/flito-impuestos.comparacion-factura-runt.js';
import { extraerColorCilindrajeRunt } from '../../src/modules/flito-impuestos/certificacion-runt.js';

const AHORA = new Date('2026-09-23T15:00:00Z');
const ok = (valor: string | null): CampoExtraido => ({ valor, confianza: 0.99, confiable: true });
const dudoso = (valor: string | null): CampoExtraido => ({ valor, confianza: 0.3, confiable: false });

const factura = (over: Partial<ExtraccionFacturaVentaImpuesto> = {}): ExtraccionFacturaVentaImpuesto => ({
  vin: ok('9ZZTEST0000000001'), marca: ok('KIA'), linea: ok('K3 CROSS'), anioVehiculo: ok('2026'),
  color: ok('BLANCO'), cilindrada: ok('1598'), clase: ok('AUTOMOVIL'),
  direccion: ok('CALLE FALSA 1'), municipio: ok('BOGOTA'), departamento: ok('CUNDINAMARCA'),
  fuente: 'notas_finales', ...over,
});
const runt = (over: Partial<DatosComparablesRunt> = {}): DatosComparablesRunt => ({
  vin: '9ZZTEST0000000001', marca: 'KIA', linea: 'K3 CROSS', modelo: '2026', color: 'BLANCO', cilindraje: '1598', ...over,
});
const campo = (r: ReturnType<typeof compararFacturaConRunt>, c: string) => r.comparacion.campos.find((x) => x.campo === c)!;

describe('AC1 — verde / naranja', () => {
  it('los 6 campos iguales → verde, en orden, sin motivo', () => {
    const r = compararFacturaConRunt(factura(), runt(), AHORA);
    expect(r.semaforo).toBe('verde');
    expect(r.comparacion.campos.map((c) => c.campo)).toEqual(['vin', 'marca', 'linea', 'anio', 'color', 'cilindrada']);
    expect(r.comparacion.motivo).toBeNull();
    expect(r.comparacion.resumen).toEqual({ coinciden: 6, difieren: 0, noVerificables: 0 });
    expect(r.comparacion.calculadoEn).toBe('2026-09-23T15:00:00.000Z');
  });

  it('un campo distinto (color) → naranja', () => {
    const r = compararFacturaConRunt(factura(), runt({ color: 'NEGRO' }), AHORA);
    expect(r.semaforo).toBe('naranja');
    expect(campo(r, 'color').resultado).toBe('difiere');
  });

  it('la placa NO se compara: no está entre los campos', () => {
    const r = compararFacturaConRunt(factura(), runt(), AHORA);
    expect(r.comparacion.campos.some((c) => (c.campo as string) === 'placa')).toBe(false);
  });

  it('el año se compara contra el AÑO MODELO del RUNT (`modelo`)', () => {
    expect(campo(compararFacturaConRunt(factura(), runt({ modelo: '2025' }), AHORA), 'anio').resultado).toBe('difiere');
    expect(campo(compararFacturaConRunt(factura(), runt({ modelo: '2026' }), AHORA), 'anio').resultado).toBe('coincide');
  });

  it('la línea de la factura se compara contra la línea del RUNT', () => {
    const r = compararFacturaConRunt(factura({ linea: ok('SPORTAGE') }), runt(), AHORA);
    expect(campo(r, 'linea')).toMatchObject({ resultado: 'difiere', valorFactura: 'SPORTAGE', valorRunt: 'K3 CROSS' });
    expect(r.semaforo).toBe('naranja');
  });
});

describe('VIN obligatorio para el verde (decisión 2026-09-23)', () => {
  it('VIN con un carácter distinto → difiere → naranja', () => {
    const r = compararFacturaConRunt(factura(), runt({ vin: '9ZZTEST0000000002' }), AHORA);
    expect(campo(r, 'vin').resultado).toBe('difiere');
    expect(r.semaforo).toBe('naranja');
  });

  it('VIN no confiable en la factura y el resto igual → naranja, no verde', () => {
    const r = compararFacturaConRunt(factura({ vin: dudoso('9ZZTEST0000000001') }), runt(), AHORA);
    expect(campo(r, 'vin')).toMatchObject({ resultado: 'no_verificable', origenNoVerificable: 'factura' });
    expect(r.comparacion.resumen.difieren).toBe(0);
    expect(r.semaforo).toBe('naranja');
  });

  it('VIN que el RUNT no publica → naranja', () => {
    const r = compararFacturaConRunt(factura(), runt({ vin: null }), AHORA);
    expect(campo(r, 'vin')).toMatchObject({ resultado: 'no_verificable', origenNoVerificable: 'runt' });
    expect(r.semaforo).toBe('naranja');
  });

  it('VIN coincide y los demás no verificables → verde (no_verificable no es diferencia)', () => {
    const r = compararFacturaConRunt(factura(), runt({ marca: null, linea: null, modelo: null, color: null, cilindraje: null }), AHORA);
    expect(r.comparacion.resumen).toEqual({ coinciden: 1, difieren: 0, noVerificables: 5 });
    expect(r.semaforo).toBe('verde');
  });

  it('todos no_verificable → naranja', () => {
    const r = compararFacturaConRunt(factura(), { vin: null, marca: null, linea: null, modelo: null, color: null, cilindraje: null }, AHORA);
    expect(r.comparacion.resumen).toEqual({ coinciden: 0, difieren: 0, noVerificables: 6 });
    expect(r.semaforo).toBe('naranja');
  });
});

describe('campos no confiables', () => {
  it('línea no confiable NO cuenta como diferencia y el semáforo sigue verde', () => {
    const r = compararFacturaConRunt(factura({ linea: dudoso('OTRA COSA') }), runt(), AHORA);
    expect(campo(r, 'linea')).toMatchObject({ resultado: 'no_verificable', origenNoVerificable: 'factura', valorFactura: null });
    expect(r.semaforo).toBe('verde');
  });
});

describe('cilindrada — tolerancia 1 % o 10 cc (decisión 2026-09-23)', () => {
  it('1598 vs 1600 → coincide → verde', () => {
    const r = compararFacturaConRunt(factura({ cilindrada: ok('1598') }), runt({ cilindraje: '1600' }), AHORA);
    expect(campo(r, 'cilindrada').resultado).toBe('coincide');
    expect(r.semaforo).toBe('verde');
  });

  it('1598 vs 1800 → difiere → naranja', () => {
    const r = compararFacturaConRunt(factura({ cilindrada: ok('1598') }), runt({ cilindraje: '1800' }), AHORA);
    expect(campo(r, 'cilindrada').resultado).toBe('difiere');
    expect(r.semaforo).toBe('naranja');
  });

  it('el tope es el mayor de 10 cc y el 1 %', () => {
    expect(cilindradaDentroDeTolerancia(100, 110)).toBe(true);
    expect(cilindradaDentroDeTolerancia(100, 111)).toBe(false);
    expect(cilindradaDentroDeTolerancia(4000, 4040)).toBe(true);
    expect(cilindradaDentroDeTolerancia(4000, 4041)).toBe(false);
  });

  it('formato con separador de miles o unidad: solo dígitos', () => {
    const r = compararFacturaConRunt(factura({ cilindrada: ok('1.598 CC') }), runt({ cilindraje: '1598' }), AHORA);
    expect(campo(r, 'cilindrada').resultado).toBe('coincide');
  });
});

describe('AC3 — eléctricos', () => {
  it.each([['0'], [null]])('factura 0 y RUNT %s → coincide con nota eléctrico', (cil) => {
    const r = compararFacturaConRunt(factura({ cilindrada: ok('0') }), runt({ cilindraje: cil }), AHORA);
    expect(campo(r, 'cilindrada')).toMatchObject({ resultado: 'coincide', nota: 'electrico' });
    expect(r.semaforo).toBe('verde');
  });

  it('factura 0 y RUNT 1598 → difiere', () => {
    const r = compararFacturaConRunt(factura({ cilindrada: ok('0') }), runt({ cilindraje: '1598' }), AHORA);
    expect(campo(r, 'cilindrada').resultado).toBe('difiere');
    expect(r.semaforo).toBe('naranja');
  });
});

describe('normalización de texto', () => {
  it('línea por inclusión de tokens (K3 vs K3 CROSS)', () => {
    expect(campo(compararFacturaConRunt(factura({ linea: ok('K3') }), runt(), AHORA), 'linea').resultado).toBe('coincide');
  });

  it('un corto sin token alfabético no alcanza (4X4, 2.0)', () => {
    expect(inclusionPorTokens('4X4', 'HILUX 4X4')).toBe(false);
    expect(inclusionPorTokens('2 0', 'CRETA 2 0')).toBe(false);
    expect(campo(compararFacturaConRunt(factura({ linea: ok('2.0') }), runt({ linea: 'CRETA 2.0' }), AHORA), 'linea').resultado)
      .toBe('difiere');
  });

  it('marca VW vs VOLKSWAGEN coincide; marca desconocida distinta difiere', () => {
    expect(campo(compararFacturaConRunt(factura({ marca: ok('VW') }), runt({ marca: 'VOLKSWAGEN' }), AHORA), 'marca').resultado).toBe('coincide');
    expect(campo(compararFacturaConRunt(factura({ marca: ok('MAZDA') }), runt({ marca: 'KIA' }), AHORA), 'marca').resultado).toBe('difiere');
  });

  it('color: género (BLANCA) e inclusión (BLANCO PERLA); paréntesis fuera', () => {
    expect(campo(compararFacturaConRunt(factura({ color: ok('BLANCA') }), runt({ color: 'BLANCO PERLA' }), AHORA), 'color').resultado)
      .toBe('coincide');
    expect(textoComparable('Gris (V).')).toBe('GRIS');
  });
});

describe('AC2 — facturaIlegible', () => {
  it('ningún campo comparable confiable → ilegible (aunque la dirección sí lo sea)', () => {
    expect(facturaIlegible(factura({
      vin: dudoso('X'), marca: dudoso(null), linea: dudoso(null), anioVehiculo: dudoso(null), color: dudoso(null), cilindrada: dudoso(null),
    }))).toBe(true);
  });
  it('uno solo confiable basta para no ser ilegible', () => {
    expect(facturaIlegible(factura({
      vin: dudoso('X'), marca: ok('KIA'), linea: dudoso(null), anioVehiculo: dudoso(null), color: dudoso(null), cilindrada: dudoso(null),
    }))).toBe(false);
  });
  it('confiable pero con valor vacío no cuenta', () => {
    expect(facturaIlegible({ vin: ok('  '), fuente: 'ocr' })).toBe(true);
  });
});

describe('extraerColorCilindrajeRunt', () => {
  it('por `vehiculo`', () => {
    expect(extraerColorCilindrajeRunt({ vehiculo: { color: 'ROJO', cilindraje: '1598' } })).toEqual({ color: 'ROJO', cilindraje: '1598' });
  });
  it('por `datosTecnicos` y alias', () => {
    expect(extraerColorCilindrajeRunt({ vehiculo: {}, datosTecnicos: { nombreColor: 'AZUL', capacidadMotor: 2000 } }))
      .toEqual({ color: 'AZUL', cilindraje: '2000' });
  });
  it('sin datos → null', () => {
    expect(extraerColorCilindrajeRunt(null)).toEqual({ color: null, cilindraje: null });
  });
});
