// HU #13855 (IA-3, Feature #13696) — enmascaramiento de PII antes de enviar texto a la IA.
import { describe, it, expect } from 'vitest';
import {
  crearMapaMascara, enmascarar, restaurar, restaurarTexto, tokensDe, tipoDeTokenMascara,
  PLACA_CARRO, PLACA_MOTO, PLACA_CON_GUION, VIN, ID_FLIT, DOCUMENTO, NIT_DV, CORREO,
} from '../src/flito-dr-flit-mascara';

describe('AC1 — enmascara placa, VIN, cédula con puntos, correo y trámite', () => {
  it('cada valor cambia por su token y ningún original queda', () => {
    const original = 'el SOAT de ABC123, VIN 9BWZZZ377VT004251, cédula 1.020.304.050, correo ana@correo.co, trámite FLIT-4521';
    const salida = enmascarar(original);
    expect(salida).toBe('el SOAT de [PLACA_1], VIN [VIN_1], cédula [DOC_1], correo [CORREO_1], trámite [TRAMITE_1]');
    for (const v of ['ABC123', '9BWZZZ377VT004251', '1.020.304.050', '1020304050', 'ana@correo.co', 'correo.co', 'FLIT-4521', '4521']) {
      expect(salida).not.toContain(v);
    }
  });
});

describe('AC2 — moto, NIT con DV, cédula sin puntos, FT2 y teléfono', () => {
  it('moto ABC12D → PLACA', () => expect(enmascarar('moto ABC12D')).toBe('moto [PLACA_1]'));
  it('NIT 900123456-7 y 900.123.456-7 → DOC (el mismo)', () => {
    const mapa = crearMapaMascara();
    expect(enmascarar('NIT 900123456-7', mapa)).toBe('NIT [DOC_1]');
    expect(enmascarar('NIT 900.123.456-7', mapa)).toBe('NIT [DOC_1]');
    expect(restaurar('[DOC_1]', mapa)).toBe('900123456-7');
  });
  it('52345678 → DOC', () => expect(enmascarar('cc 52345678.')).toBe('cc [DOC_1].'));
  it('FT2-45 (también en minúsculas) → TRAMITE', () => {
    expect(enmascarar('el FT2-45')).toBe('el [TRAMITE_1]');
    expect(enmascarar('el ft2-45 y flit-9')).toBe('el [TRAMITE_1] y [TRAMITE_2]');
  });
  it('teléfono de 10 dígitos → DOC (sobre-enmascarar aceptado)', () => {
    expect(enmascarar('llámeme al 3001234567')).toBe('llámeme al [DOC_1]');
    // HU #13855 retrabajo: el prefijo +57 ya no queda suelto; el valor guarda solo los 10 dígitos.
    expect(enmascarar('+57 3001234567')).toBe('[DOC_1]');
  });
  it('placa en minúsculas → PLACA', () => expect(enmascarar('la abc123')).toBe('la [PLACA_1]'));
  it('correo con números en la parte local no deja dígitos sueltos', () => {
    expect(enmascarar('juan1020304050@x.com.co')).toBe('[CORREO_1]');
  });
  it('correo ANTES que candidatos: parte local enmascarable por sí sola', () => {
    expect(enmascarar('abc123@correo.co')).toBe('[CORREO_1]');
    expect(enmascarar('ana.1020304050@x.co')).toBe('[CORREO_1]');
    expect(enmascarar('52345678@correo.co')).toBe('[CORREO_1]');
  });
});

describe('Formatos con separadores (decisión humana 2026-10-23)', () => {
  it.each([
    ['cédula 1 020 304 050', 'cédula [DOC_1]', '1020304050'],
    ['cédula 1020 304 050', 'cédula [DOC_1]', '1020304050'],
    ['cédula 1,020,304,050.', 'cédula [DOC_1].', '1020304050'],
    ['cc 52 345 678', 'cc [DOC_1]', '52345678'],
    ['tel +573001234567', 'tel [DOC_1]', '3001234567'],
    ['tel +57 300 123 4567', 'tel [DOC_1]', '3001234567'],
    ['tel +57-300-123-4567', 'tel [DOC_1]', '3001234567'],
    ['tel 300 123 4567', 'tel [DOC_1]', '3001234567'],
    ['tel 300-123-4567', 'tel [DOC_1]', '3001234567'],
    ['tel 300.123.4567', 'tel [DOC_1]', '3001234567'],
    ['NIT 900123456 - 7', 'NIT [DOC_1]', '900123456-7'],
    ['NIT 900123456 -7', 'NIT [DOC_1]', '900123456-7'],
    ['NIT 900 123 456 - 7', 'NIT [DOC_1]', '900123456-7'],
    ['NIT 900.123.456-7', 'NIT [DOC_1]', '900123456-7'],
    ['la ABC-123', 'la [PLACA_1]', 'ABC123'],
    ['la ABC 123', 'la [PLACA_1]', 'ABC123'],
    ['moto abc-12d', 'moto [PLACA_1]', 'ABC12D'],
    ['moto ABC 12D', 'moto [PLACA_1]', 'ABC12D'],
    ['ancho completo ABC１２３', 'ancho completo [PLACA_1]', 'ABC123'],
    ['cc １０２０３０４０５０', 'cc [DOC_1]', '1020304050'],
    ['número de 12: 573001234567', 'número de 12: [DOC_1]', '573001234567'],
  ])('%s', (texto, esperado, valor) => {
    const mapa = crearMapaMascara();
    expect(enmascarar(texto, mapa)).toBe(esperado);
    const token = esperado.match(/\[[A-Z]+_\d+\]/)![0];
    expect(restaurar(token, mapa)).toBe(valor);
  });
  it('mismo valor con y sin separadores → mismo token', () => {
    const mapa = crearMapaMascara();
    expect(enmascarar('ABC-123, ABC 123, abc123', mapa)).toBe('[PLACA_1], [PLACA_1], [PLACA_1]');
    expect(enmascarar('300 123 4567 o +573001234567 o 3001234567', mapa)).toBe('[DOC_1] o [DOC_1] o [DOC_1]');
  });
  it('el DV no queda suelto', () => {
    const s = enmascarar('NIT 900123456 - 7 gracias');
    expect(s).toBe('NIT [DOC_1] gracias');
    expect(s.replace(/\[[A-Z]+_\d+\]/g, '')).not.toMatch(/\d/);
  });
  it('13 dígitos o más no es documento (no se une ni se parte)', () => {
    expect(enmascarar('ref 1234567890123')).toBe('ref 1234567890123');
    expect(enmascarar('ref 1 234 567 890 123')).toBe('ref 1 234 567 890 123');
  });
});

describe('Frases normales que NO cambian (regla de agrupación de dígitos)', () => {
  it.each([
    'tengo 30 días para el trámite del año 2026',
    'entre 2026 y 30 días',
    'del 2025 2026 al 2027',
    'el 2026 300 personas pagaron',
    'vence el 2026-10-23',
    'son 500 pesos y con 100 basta',
    'el código 123 456 no aplica',
    'van 10 20 30 40',
    'paso 1, 2, 3',
    'son 1.500 o 12.000',
    'abc 123 en minúsculas es frase',
    'ABC-1234 no es placa',
    'la hora 10:30 - 2',
  ])('%s', (t) => expect(enmascarar(t)).toBe(t));
});

describe('AC3 — menos de 6 dígitos no se oculta', () => {
  it.each([
    'tengo 30 días para el trámite del año 2026',
    'son 12345 pesos',
    'vale 1.500',
    'el paso 2 de 3',
  ])('%s', (t) => expect(enmascarar(t)).toBe(t));
});

describe('AC4 — numeración consistente en todo el envío', () => {
  it('mismo valor → mismo token con el mismo mapa; valores distintos → n distinto', () => {
    const mapa = crearMapaMascara();
    expect(enmascarar('ABC123 y XYZ987', mapa)).toBe('[PLACA_1] y [PLACA_2]');
    expect(enmascarar('otra vez abc123', mapa)).toBe('otra vez [PLACA_1]');
    expect(enmascarar('1.020.304.050 o 1020304050', mapa)).toBe('[DOC_1] o [DOC_1]');
  });
  it('llamadas repetidas no arrastran estado de regex globales (lastIndex)', () => {
    for (let i = 0; i < 3; i++) expect(enmascarar('ABC123 ABC123')).toBe('[PLACA_1] [PLACA_1]');
  });
  it('un token ya presente se respeta y no se re-enmascara', () => {
    expect(enmascarar('[PLACA_1] y ABC123')).toBe('[PLACA_1] y [PLACA_1]');
  });
});

describe('AC5 — el mapa no se serializa', () => {
  it('JSON.stringify del mapa no lleva valores', () => {
    const mapa = crearMapaMascara();
    enmascarar('ABC123 ana@correo.co', mapa);
    const json = JSON.stringify(mapa);
    expect(json).not.toContain('ABC123');
    expect(json).not.toContain('ana@correo.co');
  });
});

describe('AC6 — restaurar', () => {
  it('token existente → valor; inexistente → null', () => {
    const mapa = crearMapaMascara();
    enmascarar('ABC123 y XYZ98K', mapa);
    expect(restaurar('[PLACA_2]', mapa)).toBe('XYZ98K');
    expect(restaurar('[PLACA_3]', mapa)).toBeNull();
    expect(restaurar('[VIN_1]', mapa)).toBeNull();
    expect(restaurarTexto('su [PLACA_1] y [DOC_9]', mapa)).toBe('su ABC123 y [DOC_9]');
  });
  it('tokensDe y tipoDeTokenMascara', () => {
    expect(tokensDe('[PLACA_1] [DOC_2] [PLACA_1] [OTRO_1]')).toEqual(['[PLACA_1]', '[DOC_2]']);
    expect(tipoDeTokenMascara('[TRAMITE_3]')).toBe('TRAMITE');
    expect(tipoDeTokenMascara('PLACA_3')).toBeNull();
  });
});

describe('Patrones exportados (anclados, sin bandera g)', () => {
  it('no tienen estado entre llamadas', () => {
    for (const re of [PLACA_CARRO, PLACA_MOTO, PLACA_CON_GUION, VIN, ID_FLIT, DOCUMENTO, NIT_DV, CORREO]) expect(re.global).toBe(false);
  });
  it('casos de borde', () => {
    expect(VIN.test('9BWZZZ377VT00425I')).toBe(false); // I no es válida
    expect(enmascarar('12345678901234567')).toBe('12345678901234567'); // 17 dígitos: ni VIN ni documento
    expect(enmascarar('ABC1234')).toBe('ABC1234');
  });
});
