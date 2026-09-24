/**
 * HU #12655 — Funciones puras del origen del valor y la diferencia documental en el reporte de costos.
 *
 * Corre con Node nativo (sin Vitest en apps/web):
 *   node --experimental-strip-types --test apps/web/src/lib/diferenciaDocumental.test.ts
 *
 * Mutantes que este archivo mata (TC-01…TC-08, TC-13 del QA):
 *   1. Invertir el mapa de origen ('documental' → «Tarifa») → falla «documental es Documento».
 *   2. `Math.abs` en el signo (perder el «−») → falla «−$20.000 conserva el signo».
 *   3. «Difiere de tarifa» en servicios adicionales → falla «SA dice Difiere del catálogo».
 *   4. Decidir por `valorDocumental` en vez de por `origenes` (AC3) → falla «autogestionada sin pendientes».
 *   5. Rótulo «Sin tarifa +$95.000» en vez de «Sin tarifa configurada» → falla «sin tarifa».
 *   6. Motivo de 4 caracteres válido → falla «5 es el mínimo».
 *   7. `aria-label` sin el concepto o sin el idFlit → falla «nombre accesible del botón».
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  avisoAceptadas, importeConSigno, lineaModal, motivoDiferenciaValido, nombreAccesibleAceptar, pendientesDe,
  referenciaComprobante, textoDiferencia, textoOrigen, tituloAceptar, tituloModalAceptar, valorDelComprobante,
} from './diferenciaDocumental.ts';

const vd = (extra: Partial<Parameters<typeof textoDiferencia>[1] & object> = {}) => ({
  comprobanteId: 'c-1', numero: 'FS-1023', fecha: '2026-09-12T15:00:00.000Z',
  tarifaReferencia: 80000 as number | null, diferencia: 15000 as number | null, aceptada: false,
  aceptadaPorNombre: null as string | null, aceptadaEn: null as string | null, aceptadaMotivo: null as string | null,
  ...extra,
});

describe('textoOrigen (AC1)', () => {
  it('documental es Documento y tarifa es Tarifa; null y undefined, sin chip', () => {
    assert.equal(textoOrigen('documental'), 'Documento');
    assert.equal(textoOrigen('tarifa'), 'Tarifa');
    assert.equal(textoOrigen(null), null);
    assert.equal(textoOrigen(undefined), null);
  });
});

describe('importeConSigno (AC2)', () => {
  it('−$20.000 conserva el signo, pegado y tipográfico; +$5.000 lleva el más', () => {
    assert.equal(importeConSigno(-20000), '−$20.000');
    assert.equal(importeConSigno(5000), '+$5.000');
    assert.equal(importeConSigno(0), '$0');
  });
});

describe('textoDiferencia (AC2)', () => {
  it('pendiente contra tarifa: Difiere de tarifa +$15.000, warning, y el nombre accesible lo dice todo', () => {
    const c = textoDiferencia('tramiteDigital', vd());
    assert.ok(c);
    assert.equal(c.texto, 'Difiere de tarifa +$15.000');
    assert.equal(c.tono, 'warning');
    assert.equal(c.pendiente, true);
    assert.match(c.accesible, /^Trámite digital: el comprobante dice \$\s?95\.000 y la tarifa \$\s?80\.000\. Diferencia \+\$15\.000\. Sin aceptar\.$/);
    assert.match(c.globo, /Comprobante \$\s?95\.000 · Tarifa \$\s?80\.000 · N\.º FS-1023/);
  });
  it('SA dice Difiere del catálogo −$20.000 y que lo que suma es aplicar el comprobante con su tipo (Bug #12913)', () => {
    const c = textoDiferencia('serviciosAdicionales', vd({ tarifaReferencia: 125000, diferencia: -20000 }));
    assert.ok(c);
    assert.equal(c.texto, 'Difiere del catálogo −$20.000');
    assert.match(c.accesible, /el catálogo suma \$\s?125\.000/);
    assert.match(c.accesible, /El costo usa el valor del comprobante; el catálogo queda como referencia\.$/);
    assert.match(c.globo, /Catálogo \$\s?125\.000/);
  });
  it('sin tarifa: «Sin tarifa configurada» sin importe en el chip, warning, y el importe en el nombre accesible', () => {
    const c = textoDiferencia('tramiteDigital', vd({ tarifaReferencia: null, diferencia: 95000 }));
    assert.ok(c);
    assert.equal(c.texto, 'Sin tarifa configurada');
    assert.equal(c.tono, 'warning');
    assert.match(c.accesible, /no hay tarifa configurada\. Diferencia \+\$95\.000\. Sin aceptar\.$/);
  });
  it('aceptada: «Diferencia aceptada +$15.000», neutral, con quién, cuándo y motivo; sin tramos «null»', () => {
    const c = textoDiferencia('logistica', vd({ aceptada: true, aceptadaPorNombre: 'ana.perez', aceptadaEn: '2026-09-16T14:00:00.000Z', aceptadaMotivo: 'Factura del proveedor con IVA' }));
    assert.ok(c);
    assert.equal(c.texto, 'Diferencia aceptada +$15.000');
    assert.equal(c.tono, 'neutral');
    assert.equal(c.pendiente, false);
    assert.match(c.accesible, /^Logística: diferencia \+\$15\.000 aceptada por ana\.perez el 16 sep 2026: «Factura del proveedor con IVA»\.$/);
    assert.match(c.globo, /^Aceptada por ana\.perez · 16 sep 2026 · «Factura del proveedor con IVA»$/);
    const sinDatos = textoDiferencia('logistica', vd({ aceptada: true, aceptadaPorNombre: null, aceptadaEn: null, aceptadaMotivo: null }));
    assert.ok(sinDatos);
    assert.doesNotMatch(sinDatos.accesible, /null/);
  });
  it('sin comprobante, sin diferencia marcada o con diferencia 0 contra tarifa: sin chip', () => {
    assert.equal(textoDiferencia('tramiteDigital', null), null);
    assert.equal(textoDiferencia('tramiteDigital', undefined), null);
    assert.equal(textoDiferencia('tramiteDigital', vd({ diferencia: null })), null);
    assert.equal(textoDiferencia('tramiteDigital', vd({ diferencia: 0 })), null);
  });
  it('el comprobante vale tarifa + diferencia, o la diferencia entera sin tarifa', () => {
    assert.equal(valorDelComprobante({ tarifaReferencia: 80000, diferencia: 15000 }), 95000);
    assert.equal(valorDelComprobante({ tarifaReferencia: null, diferencia: 95000 }), 95000);
  });
  it('la referencia omite el tramo que falte, nunca «N.º null»', () => {
    assert.match(referenciaComprobante({ numero: 'FS-1', fecha: null }) ?? '', /^N\.º FS-1$/);
    assert.equal(referenciaComprobante({ numero: null, fecha: null }), null);
    assert.equal(referenciaComprobante({ numero: null, fecha: 'basura' }), null);
  });
});

describe('pendientesDe (AC3, mutante 9)', () => {
  const base = { origenes: { tramiteDigital: 'documental' as const, logistica: 'tarifa' as const }, valorDocumental: { tramiteDigital: vd(), logistica: null, serviciosAdicionales: null } };
  it('lista los conceptos con diferencia sin aceptar, en el orden de la tabla', () => {
    assert.deepEqual(pendientesDe(base), ['tramiteDigital']);
    assert.deepEqual(pendientesDe({ ...base, valorDocumental: { ...base.valorDocumental, serviciosAdicionales: vd({ tarifaReferencia: 125000, diferencia: -20000 }) } }), ['tramiteDigital', 'serviciosAdicionales']);
  });
  it('autogestionada: origenes.logistica null con comprobante NO es pendiente aunque valorDocumental exista', () => {
    const auto = { origenes: { tramiteDigital: 'tarifa' as const, logistica: null }, valorDocumental: { tramiteDigital: null, logistica: vd({ diferencia: 5000 }), serviciosAdicionales: null } };
    assert.deepEqual(pendientesDe(auto), []);
  });
  it('aceptada no es pendiente; sin el bloque del DTO, nada', () => {
    assert.deepEqual(pendientesDe({ ...base, valorDocumental: { ...base.valorDocumental, tramiteDigital: vd({ aceptada: true }) } }), []);
    assert.deepEqual(pendientesDe({}), []);
  });
});

describe('textos del botón, el modal y el aviso (AC5)', () => {
  it('nombre accesible del botón: «Aceptar diferencia de <concepto> de <idFlit>», unidos con « y »', () => {
    assert.equal(nombreAccesibleAceptar('FLIT-10234', ['tramiteDigital']), 'Aceptar diferencia de trámite digital de FLIT-10234');
    assert.equal(nombreAccesibleAceptar('FLIT-10234', ['tramiteDigital', 'logistica']), 'Aceptar diferencia de trámite digital y logística de FLIT-10234');
  });
  it('el title del botón lleva los importes con signo', () => {
    const f = { origenes: { tramiteDigital: 'documental' as const, logistica: 'documental' as const }, valorDocumental: { tramiteDigital: vd(), logistica: vd({ diferencia: -5000 }), serviciosAdicionales: null } };
    assert.equal(tituloAceptar(f, ['tramiteDigital', 'logistica']), 'Trámite digital +$15.000 · Logística −$5.000');
  });
  it('aviso en singular y plural; título del modal con y sin placa', () => {
    assert.equal(avisoAceptadas('FLIT-1', ['tramiteDigital']), 'Diferencia de trámite digital de FLIT-1 aceptada.');
    assert.equal(avisoAceptadas('FLIT-1', ['tramiteDigital', 'logistica']), 'Diferencias de trámite digital y logística de FLIT-1 aceptadas.');
    assert.equal(tituloModalAceptar('FLIT-1', 'ABC123'), 'Aceptar diferencia · FLIT-1 · ABC123');
    assert.equal(tituloModalAceptar('FLIT-1', null), 'Aceptar diferencia · FLIT-1');
  });
  it('líneas del modal: tarifa, sin tarifa y catálogo con su nota', () => {
    const t = lineaModal('tramiteDigital', vd());
    assert.match(t.linea1, /^Comprobante \$\s?95\.000 · Tarifa \$\s?80\.000$/);
    assert.equal(t.diferencia, '+$15.000');
    assert.match(t.linea2 ?? '', /^N\.º FS-1023 · 12 sep 2026$/);
    assert.match(lineaModal('logistica', vd({ tarifaReferencia: null, diferencia: 95000 })).linea1, /· Sin tarifa configurada$/);
    const sa = lineaModal('serviciosAdicionales', vd({ tarifaReferencia: 125000, diferencia: -20000, numero: null, fecha: null }));
    assert.match(sa.linea1, /· Catálogo \$\s?125\.000$/);
    assert.equal(sa.linea2, 'El costo usa el valor del comprobante; el catálogo queda como referencia.');
  });
  it('5 es el mínimo del motivo y 500 el máximo, sin contar espacios en los bordes', () => {
    assert.equal(motivoDiferenciaValido('abcd'), false);
    assert.equal(motivoDiferenciaValido('  abcd  '), false);
    assert.equal(motivoDiferenciaValido('abcde'), true);
    assert.equal(motivoDiferenciaValido('x'.repeat(500)), true);
    assert.equal(motivoDiferenciaValido('x'.repeat(501)), false);
  });
});
