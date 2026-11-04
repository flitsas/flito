// HU #12826 — parser determinístico de la factura de venta FLIT (AC1). Todo el texto es INVENTADO:
// el fixture imita el formato de `pdftotext -layout` de las facturas reales sin copiar ningún dato.
// El test no depende de `pdftotext`: se prueba sobre texto.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  anioVehiculoN, avaluoDesdeFactura, CAMPOS_DIRECCION_FACTURA, CAMPOS_DOCUMENTO_FACTURA, CAMPOS_VEHICULO_FACTURA,
  cilindradaN, descripcionProducto, extraccionCompleta, fechaFacturaN, filasProducto, importeFacturaN,
  lineaDesdeDescripcion, numeroFacturaN, parsearAdquiriente, parsearDatosDocumento, parsearFechaEmision,
  parsearNotasFinales, parsearNumeroFactura, parsearSubtotalBaseGravable,
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

// ─────────────────────────────── HU #14293 — datos del documento ───────────────────────────────

const PLANTILLA_A = readFileSync(fileURLToPath(new URL('../fixtures/factura-flit-plantilla-a.txt', import.meta.url)), 'utf8');
const AUSENTE_ESPERADO = { valor: null, confianza: 0, confiable: false };
const VIN_A = '9ABCD1234EF567890';
/** `-raw`: una fila de producto y la de su IVA, que también casa con `FILA_PRODUCTO` y no es un producto. */
const RAW_A = [
  'Detalles de Productos',
  '1 ABC000000001 Modelox Turbo Unid 1 $ 1,234,567.89 $ 0.00 $ 0.00 $ 1,234,567.89',
  'Nro. Tipo Código Descripción % Monto',
  '1 IVA 01 IVA 5 $ 61,728.39',
].join('\n');
const FILA_ACCESORIO = '2 ACC0001 Tapetes Unid 1 $ 100,000.00 $ 0.00 $ 0.00 $ 100,000.00';
const FILA_VEHICULO_CON_VIN = `1 ABC000000001 Modelox VIN ${VIN_A} Unid 1 $ 1,134,567.89 $ 0.00 $ 0.00 $ 1,134,567.89`;

describe('numeroFactura (AC1, plantilla A)', () => {
  it('toma el token de la línea siguiente a la cabecera, sin concatenar `Prefijo:` y sin el CUFE', () => {
    expect(parsearNumeroFactura(PLANTILLA_A)).toEqual({ valor: 'ZZ000012345', confianza: 1, confiable: true });
  });

  it('el hash puede ir primero en la línea: gana el primer token que no es hash', () => {
    const hash = 'abcdef0123456789'.repeat(4);
    expect(parsearNumeroFactura(`Número de Factura:   CUFE: ${hash}\n  ${hash}   ZZ991234\n`).valor).toBe('ZZ991234');
  });

  it('con el valor en la misma línea, y con otros espacios, también', () => {
    expect(parsearNumeroFactura('Numero  de   Factura: ZZ991234').valor).toBe('ZZ991234');
  });

  it('sin la cabecera, o sin valor antes de la siguiente etiqueta, queda ausente', () => {
    expect(parsearNumeroFactura('FACTURA ELECTRÓNICA DE VENTA No. ZZ-0001')).toEqual(AUSENTE_ESPERADO);
    expect(parsearNumeroFactura('Número de Factura:\n\nTipo de Operación: Estándar\n')).toEqual(AUSENTE_ESPERADO);
  });

  it('un token inválido, o dos valores distintos, es dudoso', () => {
    expect(parsearNumeroFactura('Número de Factura:\n  abc123\n')).toMatchObject({ confiable: false, confianza: 0.5 });
    expect(parsearNumeroFactura('Número de Factura: ZZ1234\nNúmero de Factura: ZZ9999\n')).toMatchObject({ confiable: false });
  });

  it('numeroFacturaN une prefijo y consecutivo separados y rechaza lo que no es un número', () => {
    expect(numeroFacturaN('FV99 1234')).toBe('FV991234');
    expect(numeroFacturaN('FC991234')).toBe('FC991234');
    expect(numeroFacturaN('ZZ-0001')).toBe('ZZ-0001');
    for (const malo of ['abcd1234', 'FACTURA', 'A1', 'ZZ_12', 'A'.repeat(29) + '12', 'ABCDEF0123456789ABCDEF0123', '-ZZ12']) {
      expect(numeroFacturaN(malo), malo).toBeNull();
    }
  });
});

describe('fechaFactura (AC2, AC3)', () => {
  it('plantilla A: la emisión, en AAAA-MM-DD, aunque comparta línea con el vencimiento', () => {
    expect(parsearFechaEmision(PLANTILLA_A)).toEqual({ valor: '2030-01-31', confianza: 1, confiable: true });
  });

  it('sin emisión no toma el vencimiento, la recepción ni la generación: ausente', () => {
    const sinEmision = PLANTILLA_A.replace('Fecha de Emisión: 31/01/2030', '');
    expect(parsearFechaEmision(sinEmision)).toEqual(AUSENTE_ESPERADO);
    expect(parsearFechaEmision('Fecha de Emisión:      Fecha de Vencimiento: 02/03/2030')).toEqual(AUSENTE_ESPERADO);
    expect(parsearFechaEmision('Fecha de Emisión: Fecha de Vencimiento: 02/03/2030')).toEqual(AUSENTE_ESPERADO);
  });

  it('una fecha imposible es dudosa, no se corrige', () => {
    expect(parsearFechaEmision('Fecha de Emisión: 31/02/2030')).toMatchObject({ confiable: false, confianza: 0.5 });
  });

  it('fechaFacturaN: los dos formatos, sin la hora, con el calendario real y sin mover el día', () => {
    expect(fechaFacturaN('2030-01-31')).toBe('2030-01-31');
    expect(fechaFacturaN('31/01/2030')).toBe('2030-01-31');
    expect(fechaFacturaN('31/01/2030 14:05:00')).toBe('2030-01-31');
    expect(fechaFacturaN('01/01/2030 00:00:00')).toBe('2030-01-01');
    expect(fechaFacturaN('29/02/2028')).toBe('2028-02-29');
    expect(fechaFacturaN('31/01/2030, 15:48')).toBe('2030-01-31');
    expect(fechaFacturaN('31/01/2030,15:48')).toBe('2030-01-31');
    for (const malo of ['29/02/2030', '31/02/2030', '31/04/2030', '2030-13-01', '00/01/2030', '01/31/2030', '31/01/2030 25:00', 'hoy', '2030-01-31T10:00:00', '31/01/2030,', '31/02/2030, 15:48', '31/01/2030, 25:00']) {
      expect(fechaFacturaN(malo), malo).toBeNull();
    }
  });
});

describe('avalúo: normalizador de importe (AC5)', () => {
  it.each([
    ['1,234,567.89', '1234567.89'], ['1.234.567,89', '1234567.89'], ['68496063', '68496063'],
    ['1234567.89', '1234567.89'], ['0', '0'], ['0.00', '0.00'], ['$ 1,234,567.89', '1234567.89'],
    ['  $1.234.567,89 ', '1234567.89'], ['1234,5', '1234.5'], ['1,234,567', '1234567'], ['1.234.567', '1234567'], ['123,456.78', '123456.78'],
  ])('%s → %s', (crudo, esperado) => {
    expect(importeFacturaN(crudo)).toBe(esperado);
  });

  it.each(['123,456', '1.234', '1234.567', '1,234.567', '1.234,567', '-100', '-1,234.50', '12a', 'COP 100', '1,234,56', '1.234,567.89', '1 234', '', '$', '12345678901234'])(
    'rechaza %s', (crudo) => {
      expect(importeFacturaN(crudo)).toBeNull();
    },
  );

  it('conserva los centavos sin pasar por coma flotante', () => {
    expect(importeFacturaN('9,999,999,999,999.99')).toBe('9999999999999.99');
  });
});

describe('avaluoComercial (AC4, AC5, AC6)', () => {
  it('una fila de producto (la del IVA no cuenta): el Subtotal Base gravable, nunca el total', () => {
    expect(avaluoDesdeFactura(PLANTILLA_A, RAW_A, VIN_A)).toEqual({ valor: '1234567.89', confianza: 1, confiable: true });
  });

  it('un avalúo en 0 es 0 y confiable; sin subtotal queda ausente, sin relleno', () => {
    const conCero = PLANTILLA_A.replace('Subtotal Base gravable (=) $ 1,234,567.89', 'Subtotal Base gravable (=) $ 0.00');
    expect(avaluoDesdeFactura(conCero, RAW_A, VIN_A)).toEqual({ valor: '0.00', confianza: 1, confiable: true });
    const sinSubtotal = PLANTILLA_A.replace('Subtotal Base gravable (=) $ 1,234,567.89\n', '');
    expect(avaluoDesdeFactura(sinSubtotal, RAW_A, VIN_A)).toEqual(AUSENTE_ESPERADO);
  });

  it('sin subtotal no cae a «Totalmás impuestos» ni a «Valor total»', () => {
    const sinSubtotal = PLANTILLA_A.replace('Subtotal Base gravable (=) $ 1,234,567.89\n', '');
    expect(JSON.stringify(parsearSubtotalBaseGravable(sinSubtotal))).not.toContain('1296296');
  });

  it('un importe ambiguo es dudoso', () => {
    const ambiguo = PLANTILLA_A.replace('Subtotal Base gravable (=) $ 1,234,567.89', 'Subtotal Base gravable (=) $ 123,456');
    expect(avaluoDesdeFactura(ambiguo, RAW_A, VIN_A)).toMatchObject({ confiable: false, confianza: 0.5 });
  });

  it('varios productos y la descripción trae el VIN confiable: sale de esa fila', () => {
    const raw = `${FILA_VEHICULO_CON_VIN}\n1 IVA 01 IVA 5 $ 56,728.39\n${FILA_ACCESORIO}\n1 IVA 01 IVA 5 $ 5,000.00`;
    expect(filasProducto(raw)).toHaveLength(2);
    expect(avaluoDesdeFactura(PLANTILLA_A, raw, VIN_A)).toEqual({ valor: '1134567.89', confianza: 1, confiable: true });
  });

  it('varios productos sin certeza de la fila del vehículo: ausente, nunca el subtotal', () => {
    const sinVin = `${RAW_A}\n${FILA_ACCESORIO}`;
    expect(avaluoDesdeFactura(PLANTILLA_A, sinVin, VIN_A)).toEqual(AUSENTE_ESPERADO);
    expect(avaluoDesdeFactura(PLANTILLA_A, `${FILA_VEHICULO_CON_VIN}\n${FILA_ACCESORIO}`, null)).toEqual(AUSENTE_ESPERADO);
    const dosConVin = `${FILA_VEHICULO_CON_VIN}\n${FILA_VEHICULO_CON_VIN.replace(/^1/, '2')}`;
    expect(avaluoDesdeFactura(PLANTILLA_A, dosConVin, VIN_A)).toEqual(AUSENTE_ESPERADO);
  });

  it('sin filas de producto reconocibles no se sabe qué cubre el subtotal: ausente', () => {
    expect(avaluoDesdeFactura(PLANTILLA_A, '', VIN_A)).toEqual(AUSENTE_ESPERADO);
    expect(avaluoDesdeFactura(PLANTILLA_A, '1 IVA 01 IVA 5 $ 61,728.39', VIN_A)).toEqual(AUSENTE_ESPERADO);
  });
});

describe('cada dato por separado y minimización (AC7, AC10)', () => {
  it('parsearDatosDocumento: uno dudoso y otro ausente no tocan al tercero', () => {
    const texto = PLANTILLA_A
      .replace('Fecha de Emisión: 31/01/2030', 'Fecha de Emisión: 31/02/2030')
      .replace('Subtotal Base gravable (=) $ 1,234,567.89\n', '');
    const r = parsearDatosDocumento(texto, RAW_A, VIN_A);
    expect(r.numeroFactura).toEqual({ valor: 'ZZ000012345', confianza: 1, confiable: true });
    expect(r.fechaFactura).toMatchObject({ confiable: false, confianza: 0.5 });
    expect(r.avaluoComercial).toEqual(AUSENTE_ESPERADO);
  });

  it('parsearNotasFinales sigue con su tabla cerrada: ni estas claves ni el teléfono', () => {
    const r = parsearNotasFinales(PLANTILLA_A)!;
    expect(Object.keys(r).sort()).toEqual(['anioVehiculo', 'cilindrada', 'clase', 'color', 'linea', 'marca', 'vin']);
    expect(JSON.stringify(r)).not.toContain('3000000000');
  });

  it('los 3 datos no entran en las listas del vehículo ni de la dirección', () => {
    const decisorias: readonly string[] = [...CAMPOS_VEHICULO_FACTURA, ...CAMPOS_DIRECCION_FACTURA];
    for (const c of CAMPOS_DOCUMENTO_FACTURA) expect(decisorias).not.toContain(c);
  });

  it('extraccionCompleta da las 10 claves de siempre más las 3, ausentes si no llegan', () => {
    const r = extraccionCompleta({}, {});
    expect(Object.keys(r)).toEqual([...CAMPOS_VEHICULO_FACTURA, ...CAMPOS_DIRECCION_FACTURA, ...CAMPOS_DOCUMENTO_FACTURA]);
    expect(r.avaluoComercial).toEqual(AUSENTE_ESPERADO);
  });
});
