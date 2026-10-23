/**
 * HU #13855 (IA-3, Feature #13696) — envío enmascarado a la IA y restauración.
 *
 * Corre con Node nativo (sin Vitest en apps/web):
 *   node --experimental-strip-types --test apps/web/src/lib/drFlitIa.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_HISTORIAL_IA, MAX_TEXTO_IA, TIPO_RESPUESTA_IA, prepararEnvioIa, restaurarRespuesta, restaurarToken,
  valorGestionDeRef,
} from './drFlitIa.ts';

let n = 0;
const u = (texto: string) => ({ id: `u${++n}`, ts: n, de: 'usuario', tipo: 'pregunta', texto });
const ia = (texto: string) => ({ id: `a${++n}`, ts: n, de: 'drflit', tipo: TIPO_RESPUESTA_IA, texto });

describe('prepararEnvioIa', () => {
  it('AC1: el mensaje sale enmascarado y sin valores originales', () => {
    const { envio } = prepararEnvioIa(
      'el SOAT de ABC123, VIN 9BWZZZ377VT004251, cédula 1.020.304.050, correo ana@correo.co, trámite FLIT-4521', [],
    );
    assert.equal(envio.mensaje, 'el SOAT de [PLACA_1], VIN [VIN_1], cédula [DOC_1], correo [CORREO_1], trámite [TRAMITE_1]');
    assert.deepEqual(envio.historial, []);
  });

  it('AC4: mismo valor → mismo token entre historial y mensaje', () => {
    const { envio } = prepararEnvioIa('¿y la XYZ987 con 52345678?', [u('cómo va el pago de 52345678'), ia('Revise [nada]')]);
    assert.equal(envio.historial[0].texto, 'cómo va el pago de [DOC_1]');
    assert.equal(envio.mensaje, '¿y la [PLACA_1] con [DOC_1]?');
  });

  it('AC5: el envío no lleva el mapa ni los valores; el mapa no se serializa', () => {
    const { envio, mapa } = prepararEnvioIa('ana@correo.co', []);
    const json = JSON.stringify(envio);
    assert.ok(!json.includes('ana@correo.co'));
    assert.deepEqual(Object.keys(envio).sort(), ['historial', 'mensaje']);
    assert.ok(!JSON.stringify(mapa).includes('ana@correo.co'));
  });

  it('AC7: máximo 12 más recientes, usuario e IA, sin gestión ni respuestas F3', () => {
    const panel = [
      ...Array.from({ length: 14 }, (_, i) => (i % 2 ? ia(`respuesta ${i}`) : u(`pregunta ${i}`))),
      { id: 'x1', ts: 99, de: 'drflit', tipo: 'citas', respondeA: 'u1', refs: [{ clave: 'soat' }] },
      { id: 'x2', ts: 99, de: 'drflit', tipo: 'sinResultados', respondeA: 'u1' },
      { id: 'x3', ts: 99, de: 'drflit', tipo: 'explicacion', ref: { clave: 'soat' } },
      { id: 'x4', ts: 99, de: 'drflit', tipo: 'casoRadicado', numero: 7 },
      { id: 'x5', ts: 99, de: 'drflit', tipo: 'resultadoGestion', valor: 'ABC123', tipoValor: 'placa', modulos: ['soat'] },
      { id: 'x6', ts: 99, de: 'drflit', tipo: 'ofertaGestion', respondeA: 'g1', valor: 'ABC123', tipoValor: 'placa', estado: 'viva' },
      { id: 'g1', ts: 99, de: 'usuario', tipo: 'pregunta', texto: 'en qué va ABC123' },
      { id: 'x7', ts: 99, de: 'drflit', tipo: 'marcadorGestion', consulta: true },
    ];
    const { envio } = prepararEnvioIa('hola', panel);
    assert.equal(envio.historial.length, MAX_HISTORIAL_IA);
    assert.deepEqual(envio.historial[0], { rol: 'usuario', texto: 'pregunta 2' });
    assert.deepEqual(envio.historial.at(-1), { rol: 'drflit', texto: 'respuesta 13' });
    assert.ok(!JSON.stringify(envio).includes('ABC123'));
    assert.ok(!JSON.stringify(envio).includes('[PLACA'));
  });

  it('AC7: cada texto se recorta a 2000 sin dejar medio token', () => {
    const largo = `${'a'.repeat(1995)} ABC123 fin`;
    const { envio } = prepararEnvioIa(largo, [u('b'.repeat(3000))]);
    assert.equal(envio.historial[0].texto.length, MAX_TEXTO_IA);
    assert.ok(envio.mensaje.length <= MAX_TEXTO_IA);
    assert.ok(!envio.mensaje.includes('ABC123'));
    assert.ok(!/\[[A-Z_\d]*$/.test(envio.mensaje));
  });

  it('el crudo se corta a 2 × MAX antes de enmascarar sin dejar un valor partido', () => {
    // 222 VIN (3996 crudos) se enmascaran a 1776: lo que cruza el corte de 4000 llegaría al envío.
    // La cédula que cruza el corte se quita entera: no viaja «1020» suelto (4 dígitos, sin máscara).
    const crudo = `${'9BWZZZ377VT004251 '.repeat(222)}1020304050 fin`;
    const { envio } = prepararEnvioIa(crudo, []);
    assert.ok(envio.mensaje.endsWith('[VIN_1]'));
    assert.ok(!envio.mensaje.includes('1020'));
    assert.ok(envio.mensaje.length <= MAX_TEXTO_IA);
  });

  it('rendimiento: 13 textos × 4000 caracteres adversos en tiempo razonable', () => {
    const adversos = [
      '1 '.repeat(2000), '111 '.repeat(1000), 'a'.repeat(4000), 'a@'.repeat(2000), 'a.'.repeat(2000),
      '1-'.repeat(2000), '1,'.repeat(2000), 'ABC '.repeat(1000), '9'.repeat(4000), 'ab1'.repeat(1333),
      `${'a'.repeat(3990)}@b.c`, '+57 '.repeat(1000), '- 1 '.repeat(1000),
    ].map((t) => t.slice(0, 4000));
    const t0 = performance.now();
    const { envio } = prepararEnvioIa(adversos[12], adversos.slice(0, 12).map((t, i) => (i % 2 ? ia(t) : u(t))));
    const ms = performance.now() - t0;
    assert.equal(envio.historial.length, 12);
    assert.ok(ms < 1500, `tardó ${ms.toFixed(0)} ms`);
  });
});

describe('restauración', () => {
  it('AC6: token → valor; inexistente → null', () => {
    const { mapa } = prepararEnvioIa('ABC123 y XYZ98K', []);
    assert.equal(restaurarToken('[PLACA_2]', mapa), 'XYZ98K');
    assert.equal(restaurarToken('[PLACA_9]', mapa), null);
    assert.equal(restaurarRespuesta('Su [PLACA_1] está al día.', mapa), 'Su ABC123 está al día.');
  });

  it('gestionRef → valor de F6 (placa, vin, tramite→idFlit); documento o desconocido → null', () => {
    const { mapa } = prepararEnvioIa('ABC123 9BWZZZ377VT004251 FT2-45 52345678', []);
    assert.deepEqual(valorGestionDeRef('[PLACA_1]', mapa), { tipo: 'placa', valor: 'ABC123' });
    assert.deepEqual(valorGestionDeRef('[VIN_1]', mapa), { tipo: 'vin', valor: '9BWZZZ377VT004251' });
    assert.deepEqual(valorGestionDeRef('[TRAMITE_1]', mapa), { tipo: 'idFlit', valor: 'FT2-45' });
    assert.equal(valorGestionDeRef('[DOC_1]', mapa), null);
    assert.equal(valorGestionDeRef('[PLACA_5]', mapa), null);
    assert.equal(valorGestionDeRef(null, mapa), null);
  });
});
