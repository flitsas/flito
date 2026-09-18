/**
 * HU #12620 — Funciones puras de los viajes adicionales de logística.
 *
 * Corre con Node nativo (sin Vitest en apps/web):
 *   node --experimental-strip-types --test apps/web/src/lib/viajesLogistica.test.ts
 *
 * Mutantes que este archivo mata:
 *   1. `formularioValido` acepta «inicial» sin tarifa → falla «sin tarifa, inicial no vale».
 *   2. `cuerpoRegistro` manda `valor` en «inicial» → falla «el body inicial no lleva valor».
 *   3. `precioManualValido` acepta negativos/decimales → falla «-1 y 1.5 no valen; 0 sí».
 *   4. `falloDeEscritura` no sella con TRAMITE_LIQUIDADO → falla «409 liquidado → soloLectura».
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from './api.ts';
import {
  cuerpoRegistro, errorDeCarga, etiquetaFijacion, falloDeEscritura, formularioValido, precioManualValido,
  textoConfirmarQuitar, textoMotivo, textoTotalViajes, type FormularioViaje,
} from './viajesLogistica.ts';

const base: FormularioViaje = { motivo: 'devolucion', detalle: '', modo: 'inicial', valor: '' };
const fallo = (status: number, codigo?: string) => new ApiError(status, 'Mensaje del servidor', undefined, codigo ? { codigo } : undefined);

describe('formularioValido (AC2, AC7)', () => {
  it('motivo obligatorio', () => {
    assert.equal(formularioValido({ ...base, motivo: '' }, 45000), false);
    assert.equal(formularioValido(base, 45000), true);
  });
  it('«Otro» exige detalle no vacío y de 300 como máximo', () => {
    assert.equal(formularioValido({ ...base, motivo: 'otro' }, 45000), false);
    assert.equal(formularioValido({ ...base, motivo: 'otro', detalle: '   ' }, 45000), false);
    assert.equal(formularioValido({ ...base, motivo: 'otro', detalle: 'sede norte' }, 45000), true);
    assert.equal(formularioValido({ ...base, motivo: 'otro', detalle: 'x'.repeat(301) }, 45000), false);
  });
  it('sin tarifa, inicial no vale; manual sí con entero ≥ 0', () => {
    assert.equal(formularioValido(base, null), false);
    assert.equal(formularioValido({ ...base, modo: 'manual', valor: '0' }, null), true);
  });
  it('-1 y 1.5 no valen; 0 sí', () => {
    assert.equal(precioManualValido('-1'), false);
    assert.equal(precioManualValido('1.5'), false);
    assert.equal(precioManualValido(''), false);
    assert.equal(precioManualValido('0'), true);
    assert.equal(precioManualValido('62000'), true);
  });
});

describe('cuerpoRegistro (AC3)', () => {
  it('el body inicial no lleva valor', () => {
    assert.deepEqual(cuerpoRegistro({ ...base, motivo: 'segunda_entrega' }), { modo: 'inicial', motivo: 'segunda_entrega' });
  });
  it('el body manual lleva valor numérico y el detalle recortado', () => {
    assert.deepEqual(
      cuerpoRegistro({ motivo: 'otro', detalle: '  sede norte ', modo: 'manual', valor: ' 62000' }),
      { modo: 'manual', valor: 62000, motivo: 'otro', motivoDetalle: 'sede norte' },
    );
  });
});

describe('copy de la fila y los totales (AC3, AC4, AC5)', () => {
  it('fijación', () => {
    assert.equal(etiquetaFijacion({ modo: 'inicial', tarifaVigente: 45000 }), 'Tarifa vigente');
    assert.match(etiquetaFijacion({ modo: 'manual', tarifaVigente: 45000 }), /^Precio manual \(tarifa \$\s?45\.000\)$/);
    assert.equal(etiquetaFijacion({ modo: 'manual', tarifaVigente: null }), 'Precio manual · sin tarifa vigente');
  });
  it('motivo con y sin detalle', () => {
    assert.equal(textoMotivo({ motivo: 'devolucion', motivoDetalle: null }), 'Devolución');
    assert.equal(textoMotivo({ motivo: 'otro', motivoDetalle: 'sede norte' }), 'Otro: sede norte');
  });
  it('totales y confirmación', () => {
    assert.equal(textoTotalViajes(1), 'Viajes: 1 (incluye el viaje 1)');
    assert.match(textoConfirmarQuitar({ numero: 3, valor: 62000 }), /^Se quitará el viaje N\.º 3 de \$\s?62\.000\. Para corregirlo tendrás que registrarlo de nuevo\.$/);
  });
});

describe('errores (AC4, AC6, AC7, AC8)', () => {
  it('403 al cargar: sin permiso y sin Reintentar', () => {
    assert.deepEqual(errorDeCarga(fallo(403)), { mensaje: 'No tienes permiso para ver los viajes.', reintentable: false });
    assert.equal(errorDeCarga(fallo(500)).reintentable, true);
  });
  it('409 liquidado → soloLectura + recarga con el mensaje del servidor', () => {
    const f = falloDeEscritura(fallo(409, 'TRAMITE_LIQUIDADO'), 'registrar');
    assert.equal(f.soloLectura, true);
    assert.equal(f.recargarLista, true);
    assert.equal(f.mensaje, 'Mensaje del servidor');
  });
  it('409 autogestionada → recarga sin sellar', () => {
    const f = falloDeEscritura(fallo(409, 'LOGISTICA_AUTOGESTIONADA'), 'quitar');
    assert.equal(f.soloLectura, false);
    assert.equal(f.recargarLista, true);
  });
  it('422 sin tarifa → fuerza manual, no recarga', () => {
    const f = falloDeEscritura(fallo(422, 'TARIFA_LOGISTICA_NO_CONFIGURADA'), 'registrar');
    assert.equal(f.forzarManual, true);
    assert.equal(f.recargarLista, false);
    assert.match(f.mensaje, /Elige «Nuevo precio»/);
  });
});
