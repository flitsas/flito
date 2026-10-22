/**
 * HU #13836 (G1, Feature #13834) — detector, despachador, resumen y forma guardable de Dr. Flit gestión.
 *
 * Corre con Node nativo (sin Vitest en apps/web):
 *   node --experimental-strip-types --test apps/web/src/lib/drFlitGestion.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectarValorGestion, faseBloque, modulosAConsultar, sinValoresDeGestion, textoResumen,
  type ModuloGestionWeb,
} from './drFlitGestion.ts';

describe('detectarValorGestion (AC1/AC2)', () => {
  it('placa de carro, de moto, VIN e id FLIT (FLIT 1 y FLIT 2)', () => {
    assert.deepEqual(detectarValorGestion('¿en qué va ABC123?'), { tipo: 'placa', valor: 'ABC123' });
    assert.deepEqual(detectarValorGestion('moto ABC12D por favor'), { tipo: 'placa', valor: 'ABC12D' });
    assert.deepEqual(detectarValorGestion('VIN 9BWZZZ377VT004251'), { tipo: 'vin', valor: '9BWZZZ377VT004251' });
    assert.deepEqual(detectarValorGestion('FLIT-0132456'), { tipo: 'idFlit', valor: 'FLIT-0132456' });
    assert.deepEqual(detectarValorGestion('el ft2-0000180 ya salió?'), { tipo: 'idFlit', valor: 'FT2-0000180' });
  });

  it('normaliza a mayúsculas', () => {
    assert.deepEqual(detectarValorGestion('abc123'), { tipo: 'placa', valor: 'ABC123' });
  });

  it('varios valores: el primero en orden de lectura', () => {
    assert.deepEqual(detectarValorGestion('XYZ987 y ABC123'), { tipo: 'placa', valor: 'XYZ987' });
  });

  it('AC2: número suelto, cédula, texto o nombre no ofrecen nada', () => {
    for (const t of ['1032456789', '123456', 'hola', 'Juan Pérez', '¿cómo se entra a trámites?', '', 'AB123', 'ABCD123']) {
      assert.equal(detectarValorGestion(t), null, t);
    }
  });

  it('VIN: 17 sin I/O/Q, con al menos una letra y un dígito', () => {
    assert.equal(detectarValorGestion('12345678901234567'), null); // solo dígitos
    assert.equal(detectarValorGestion('ABCDEFGHJKLMNPRST'), null); // solo letras
    assert.equal(detectarValorGestion('9BWZZZ377VT00425I'), null); // con I
    assert.equal(detectarValorGestion('9BWZZZ377VT0042511'), null); // 18
  });

  it('id FLIT: solo los prefijos FLIT- y FT2- con dígitos', () => {
    assert.equal(detectarValorGestion('DEMO-ABC'), null);
    assert.equal(detectarValorGestion('FT1-0005555'), null);
    assert.equal(detectarValorGestion('FLIT-ABC'), null);
  });
});

describe('modulosAConsultar (AC7 y tabla del despachador)', () => {
  const todo = () => true;
  it('G1+G2+G3: placa → los 4; VIN → Trámites, SOAT, Impuestos (AC3); id FLIT → Trámites, Impuestos, Derechos (AC8)', () => {
    assert.deepEqual(modulosAConsultar('placa', todo), ['tramites', 'soat', 'impuestos', 'derechos']);
    assert.deepEqual(modulosAConsultar('vin', todo), ['tramites', 'soat', 'impuestos']);
    assert.deepEqual(modulosAConsultar('idFlit', todo), ['tramites', 'impuestos', 'derechos']);
  });

  it('sin página o sin la función tramites.cola.ver → no se consulta Trámites', () => {
    const vistos: string[] = [];
    const sinFuncion = (page: string, funcion: string) => {
      vistos.push(`${page}|${funcion}`);
      return page === 'flito_tramites' && funcion !== 'tramites.cola.ver';
    };
    assert.deepEqual(modulosAConsultar('placa', sinFuncion), []);
    assert.deepEqual(vistos, [
      'flito_tramites|tramites.cola.ver', 'flito_soat|soat.cola.ver',
      'flito_impuestos|impuestos.cola.ver', 'flito_derechos|derechos.cola.ver',
    ]);
    assert.deepEqual(modulosAConsultar('placa', () => false), []);
  });

  it('AC6 G2: sin la página flito_soat o sin soat.cola.ver → SOAT no se consulta', () => {
    const sinPaginaSoat = (page: string) => page !== 'flito_soat';
    assert.deepEqual(modulosAConsultar('vin', sinPaginaSoat), ['tramites', 'impuestos']);
    const sinFuncionSoat = (_p: string, funcion: string) => funcion !== 'soat.cola.ver';
    assert.deepEqual(modulosAConsultar('placa', sinFuncionSoat), ['tramites', 'impuestos', 'derechos']);
    const soloSoat = (page: string, funcion: string) => page === 'flito_soat' && funcion === 'soat.cola.ver';
    assert.deepEqual(modulosAConsultar('vin', soloSoat), ['soat']);
    assert.deepEqual(modulosAConsultar('idFlit', soloSoat), []);
  });

  it('G3: permisos parciales de Impuestos y Derechos (página o función faltante → no se consulta)', () => {
    const sinPaginaImp = (page: string) => page !== 'flito_impuestos';
    assert.deepEqual(modulosAConsultar('placa', sinPaginaImp), ['tramites', 'soat', 'derechos']);
    const sinFuncionImp = (_p: string, funcion: string) => funcion !== 'impuestos.cola.ver';
    assert.deepEqual(modulosAConsultar('idFlit', sinFuncionImp), ['tramites', 'derechos']);
    const sinFuncionDer = (_p: string, funcion: string) => funcion !== 'derechos.cola.ver';
    assert.deepEqual(modulosAConsultar('placa', sinFuncionDer), ['tramites', 'soat', 'impuestos']);
    // AC7: solo Derechos (página + función) → solo se llama Derechos; un VIN no consulta nada.
    const soloDer = (page: string, funcion: string) => page === 'flito_derechos' && funcion === 'derechos.cola.ver';
    assert.deepEqual(modulosAConsultar('placa', soloDer), ['derechos']);
    assert.deepEqual(modulosAConsultar('idFlit', soloDer), ['derechos']);
    assert.deepEqual(modulosAConsultar('vin', soloDer), []);
    // La página sin la función (o al revés) no basta.
    assert.deepEqual(modulosAConsultar('placa', (p, f) => p === 'flito_derechos' && f === 'impuestos.cola.ver'), []);
  });

  it('registro extensible: VIN no consulta derechos, id FLIT no consulta SOAT; orden fijo', () => {
    const reg: ModuloGestionWeb[] = [
      { modulo: 'tramites', page: 'a', funcion: 'a', acepta: ['placa', 'vin', 'idFlit'], etiqueta: 'Trámites', ruta: '/a' },
      { modulo: 'soat', page: 'b', funcion: 'b', acepta: ['placa', 'vin'], etiqueta: 'SOAT', ruta: '/b' },
      { modulo: 'impuestos', page: 'c', funcion: 'c', acepta: ['placa', 'vin', 'idFlit'], etiqueta: 'Impuestos', ruta: '/c' },
      { modulo: 'derechos', page: 'd', funcion: 'd', acepta: ['placa', 'idFlit'], etiqueta: 'Derechos', ruta: '/d' },
    ];
    assert.deepEqual(modulosAConsultar('placa', todo, reg), ['tramites', 'soat', 'impuestos', 'derechos']);
    assert.deepEqual(modulosAConsultar('vin', todo, reg), ['tramites', 'soat', 'impuestos']);
    assert.deepEqual(modulosAConsultar('idFlit', todo, reg), ['tramites', 'impuestos', 'derechos']);
    assert.deepEqual(modulosAConsultar('placa', (p) => p !== 'c', reg), ['tramites', 'soat', 'derechos']);
  });
});

describe('faseBloque / textoResumen (AC6/AC7/AC9)', () => {
  it('cargando, lleno, vacío, error, 429 y mixto', () => {
    assert.deepEqual(faseBloque([{ estado: 'cargando' }]), { fase: 'cargando' });
    assert.deepEqual(faseBloque([{ estado: 'ok', total: 12, items: [] }, { estado: 'oculto' }]),
      { fase: 'lleno', coincidencias: 12, modulos: 1, conError: false });
    assert.deepEqual(faseBloque([{ estado: 'oculto' }]), { fase: 'vacio' });
    assert.deepEqual(faseBloque([]), { fase: 'vacio' });
    assert.deepEqual(faseBloque([{ estado: 'error', status: 500 }]), { fase: 'error', todos429: false });
    assert.deepEqual(faseBloque([{ estado: 'error', status: 429 }]), { fase: 'error', todos429: true });
    assert.deepEqual(faseBloque([{ estado: 'error', status: 0 }, { estado: 'oculto' }]), { fase: 'mixto' });
  });
  it('singulares', () => {
    assert.equal(textoResumen(1, 1), 'Encontré 1 coincidencia en 1 módulo.');
    assert.equal(textoResumen(13, 2), 'Encontré 13 coincidencias en 2 módulos.');
  });
});

describe('sinValoresDeGestion (AC8)', () => {
  const base = { ts: 1 };
  it('el turno con valor queda como marcador sin valor; oferta y resultado no se guardan', () => {
    const guardado = sinValoresDeGestion([
      { ...base, id: 'u0', de: 'usuario', tipo: 'pregunta', texto: '¿cómo se entra?' },
      { ...base, id: 'u1', de: 'usuario', tipo: 'pregunta', texto: '¿en qué va ABC123?' },
      { ...base, id: 'o1', de: 'drflit', tipo: 'ofertaGestion', respondeA: 'u1', valor: 'ABC123', tipoValor: 'placa', estado: 'consultada' },
      { ...base, id: 'r1', de: 'drflit', tipo: 'resultadoGestion', valor: 'ABC123', tipoValor: 'placa', modulos: ['tramites'] },
      { ...base, id: 'u2', de: 'usuario', tipo: 'pregunta', texto: 'XYZ987' },
      { ...base, id: 'o2', de: 'drflit', tipo: 'ofertaGestion', respondeA: 'u2', valor: 'XYZ987', tipoValor: 'placa', estado: 'ignorada' },
    ]);
    assert.deepEqual(guardado, [
      { ...base, id: 'u0', de: 'usuario', tipo: 'pregunta', texto: '¿cómo se entra?' },
      { ...base, id: 'u1', de: 'drflit', tipo: 'marcadorGestion', consulta: true },
      { ...base, id: 'u2', de: 'drflit', tipo: 'marcadorGestion', consulta: false },
    ]);
    const json = JSON.stringify(guardado);
    assert.ok(!json.includes('ABC123') && !json.includes('XYZ987'));
  });
});
