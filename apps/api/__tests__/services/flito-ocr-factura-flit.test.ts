// HU #12826 — parser determinístico de la factura de venta FLIT (AC1). Todo el texto es INVENTADO:
// el fixture imita el formato de `pdftotext -layout` de las facturas reales sin copiar ningún dato.
// El test no depende de `pdftotext`: se prueba sobre texto.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  anioVehiculoN, cilindradaN, descripcionProducto, lineaDesdeDescripcion, parsearAdquiriente, parsearNotasFinales,
} from '../../src/modules/flito-ocr/flito-ocr-factura-flit.js';

const FIXTURE = readFileSync(fileURLToPath(new URL('../fixtures/factura-flit-notas-finales.txt', import.meta.url)), 'utf8');
/** Lo que da `pdftotext -raw` de la fila de producto: la descripción sale con las palabras enteras. */
const RAW_UN_PRODUCTO = [
  'Detalles de',
  'Productos',
  '1 ABC000000001 Modelox Turbo Unid 1 $10.000.000,00 $0,00 $0,00 $10.000.000,00',
  'Nro. Tipo Código Descripción % Monto',
].join('\n');
const notas = (cuerpo: string) => `Notas Finales\n\n${cuerpo}\nDatos Totales\n`;

describe('parsearNotasFinales (AC1)', () => {
  it('el fixture da los 6 campos de Notas Finales con confianza 1 y el VIN reconstruido pese al corte de línea', () => {
    const r = parsearNotasFinales(FIXTURE)!;
    expect(r.vin).toEqual({ valor: '9ABCD1234EF567890', confianza: 1, confiable: true });
    expect(r.marca).toEqual({ valor: 'MarcaX', confianza: 1, confiable: true });
    expect(r.anioVehiculo).toEqual({ valor: '2026', confianza: 1, confiable: true });
    expect(r.color).toEqual({ valor: 'Blanco Perla', confianza: 1, confiable: true });
    expect(r.cilindrada).toEqual({ valor: '1598', confianza: 1, confiable: true });
    expect(r.clase).toEqual({ valor: 'Automóvil', confianza: 1, confiable: true });
    // La línea no viene en Notas Finales: ausente aquí, la pone la regla de la Descripción.
    expect(r.linea).toEqual({ valor: null, confianza: 0, confiable: false });
  });

  it('«AñoVehiculo» sin tilde y «AñoVehículo» con tilde dan lo mismo', () => {
    const a = parsearNotasFinales(notas('AñoVehiculo:2025|Marca:X'))!;
    const b = parsearNotasFinales(notas('AñoVehículo:2025|Marca:X'))!;
    expect(a.anioVehiculo).toEqual({ valor: '2025', confianza: 1, confiable: true });
    expect(b.anioVehiculo).toEqual(a.anioVehiculo);
  });

  it('el teléfono (Numerodecontacto1) y las claves fuera de la tabla no salen del parser', () => {
    const r = parsearNotasFinales(FIXTURE)!;
    expect(Object.keys(r).sort()).toEqual(['anioVehiculo', 'cilindrada', 'clase', 'color', 'linea', 'marca', 'vin']);
    expect(JSON.stringify(r)).not.toContain('3000000000');
    expect(JSON.stringify(r)).not.toContain('XX000000'); // Motor
  });

  it('`Modelo:` va a `linea`, y un año de 4 dígitos ahí es no confiable', () => {
    expect(parsearNotasFinales(notas('Modelo:Modelox|Marca:X'))!.linea).toEqual({ valor: 'Modelox', confianza: 1, confiable: true });
    expect(parsearNotasFinales(notas('Modelo:2026|Marca:X'))!.linea).toMatchObject({ valor: '2026', confiable: false, confianza: 0.5 });
  });

  it('un VIN de 16 caracteres es no confiable', () => {
    expect(parsearNotasFinales(notas('VIN:9ABCD1234EF56789'))!.vin).toMatchObject({ confiable: false, confianza: 0.5 });
  });

  it('`Cilindrada:0` (eléctrico) es confiable; «1.598 cc» se normaliza', () => {
    expect(parsearNotasFinales(notas('Cilindrada:0'))!.cilindrada).toEqual({ valor: '0', confianza: 1, confiable: true });
    expect(cilindradaN('1.598 cc')).toBe('1598');
  });

  it('una clave repetida con valores distintos es no confiable', () => {
    expect(parsearNotasFinales(notas('Color:Rojo|Color:Azul'))!.color).toMatchObject({ confiable: false, confianza: 0.5 });
  });

  it('año fuera de rango (antes de 1950 o más de año actual + 2) no es válido', () => {
    const ahora = new Date('2026-09-23T00:00:00Z');
    expect(anioVehiculoN('1949', ahora)).toBeNull();
    expect(anioVehiculoN('2029', ahora)).toBeNull();
    expect(anioVehiculoN('2028', ahora)).toBe('2028');
  });

  it('sin cabecera Notas Finales, o sin ninguna clave conocida, devuelve null (→ OCR)', () => {
    expect(parsearNotasFinales('Factura sin bloque\nVIN:9ABCD1234EF567890')).toBeNull();
    expect(parsearNotasFinales(notas('Responsables de IVA|Numerodecontacto1:3000000000'))).toBeNull();
  });
});

describe('parsearAdquiriente (AC1)', () => {
  it('dirección, ciudad y departamento salen del ADQUIRIENTE, no del Emisor que va antes', () => {
    expect(parsearAdquiriente(FIXTURE)).toEqual({
      direccion: { valor: 'CL 1 # 2-3 OF 4', confianza: 0.9, confiable: true },
      municipio: { valor: 'CIUDADX', confianza: 0.9, confiable: true },
      departamento: { valor: 'DPX', confianza: 0.9, confiable: true },
    });
  });

  it('sin bloque del Adquiriente los tres quedan ausentes', () => {
    const r = parsearAdquiriente('Datos del Emisor\nX  Dirección  AV 1\n');
    expect(r.direccion).toEqual({ valor: null, confianza: 0, confiable: false });
  });
});

describe('línea desde la «Descripción» del producto (decisión del humano 2026-09-23)', () => {
  it('una sola fila de producto: la descripción (texto -raw) es la línea, confiable', () => {
    const p = descripcionProducto(RAW_UN_PRODUCTO);
    expect(p).toEqual({ descripcion: 'Modelox Turbo', unica: true });
    expect(lineaDesdeDescripcion(p, 'MarcaX')).toEqual({ valor: 'Modelox Turbo', confianza: 1, confiable: true });
  });

  it('si la descripción empieza por la marca, se le quita', () => {
    expect(lineaDesdeDescripcion({ descripcion: 'MARCAX Modelox', unica: true }, 'MarcaX').valor).toBe('Modelox');
  });

  it('con etiqueta LINEA toma el valor hasta la siguiente etiqueta', () => {
    expect(lineaDesdeDescripcion({ descripcion: 'VEHICULO LÍNEA: Modelox MODELO 2026 COLOR ROJO', unica: false }))
      .toEqual({ valor: 'Modelox', confianza: 1, confiable: true });
  });

  it('dudosa → valor null y no confiable, sin lanzar: varias filas, etiquetas ajenas o sin tabla', () => {
    const varias = `${RAW_UN_PRODUCTO}\n2 ACC0001 Tapetes Unid 1 $100.000,00 $0,00 $0,00 $100.000,00`;
    const vacio = { valor: null, confianza: 0, confiable: false };
    expect(lineaDesdeDescripcion(descripcionProducto(varias))).toEqual(vacio);
    expect(lineaDesdeDescripcion({ descripcion: 'AUTOMOVIL MODELO 2026', unica: true })).toEqual(vacio);
    expect(lineaDesdeDescripcion({ descripcion: '2026', unica: true })).toEqual(vacio);
    expect(lineaDesdeDescripcion(descripcionProducto('sin tabla de productos'))).toEqual(vacio);
  });
});
