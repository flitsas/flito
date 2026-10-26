/**
 * HU #13769 AC3 — los fixtures de las capturas de la Ayuda FLITO no llevan PII real.
 *
 * Corre con Node nativo (sin Vitest en apps/web) y en CI (job `build + test`):
 *   node --experimental-strip-types --test apps/web/e2e/helpers/datos-demo.test.ts
 *
 * Qué garantiza:
 *   1. Cada dato del registro `DATOS_DEMO` cumple su regla de `REGLAS_DATOS_DEMO` (placa en serie ZZ,
 *      cédula 99…, NIT 999…, teléfono 3000000…, correo @ejemplo.test, VIN 9ZZDEMO…).
 *   2. Todo valor de los fixtures bajo una clave sensible (`placa`, `documento`, `contactoNombre`…)
 *      sale del registro: no hay un dato escrito a mano fuera de las reglas.
 *   3. Las LT de demo (cadena PDF417) solo contienen placa, cédula, nombre y VIN del registro.
 *   4. Las reglas rechazan datos con forma real (para que no pasen por accidente).
 *
 * Mutantes que mata:
 *   - Cambiar una placa del registro a `QOX858` → falla 1.
 *   - Poner `contactoNombre: 'Juan Pérez'` en `MI_RUTA_DEMO` → falla 2.
 *   - Relajar `REGLAS_DATOS_DEMO.correo` a cualquier dominio → falla 4.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAVES_SENSIBLES,
  DATOS_DEMO,
  FIXTURES_DEMO,
  LT_DEMO,
  NOMBRES_DEMO,
  REGLAS_DATOS_DEMO,
} from './datos-demo.ts';

const REGLA_POR_CATEGORIA: Partial<Record<keyof typeof DATOS_DEMO, RegExp>> = {
  placas: REGLAS_DATOS_DEMO.placa,
  cedulas: REGLAS_DATOS_DEMO.cedula,
  nits: REGLAS_DATOS_DEMO.nit,
  telefonos: REGLAS_DATOS_DEMO.telefono,
  correos: REGLAS_DATOS_DEMO.correo,
  vins: REGLAS_DATOS_DEMO.vin,
  // Área Super Admin (HU #13774): login con «demo» (y, si es correo, de `ejemplo.test`); IP de documentación
  // (RFC 5737: 192.0.2.0/24 y 198.51.100.0/24); navegador sintético.
  usuarios: /^[a-z0-9.]*demo[a-z0-9.]*(@ejemplo\.test)?$/,
  ips: /^(192\.0\.2|198\.51\.100)\.\d{1,3}$/,
  agentesUsuario: /Demo/,
};

function recorrer(valor: unknown, ruta: string, visitar: (clave: string, v: unknown, ruta: string) => void) {
  if (Array.isArray(valor)) valor.forEach((v, i) => recorrer(v, `${ruta}[${i}]`, visitar));
  else if (valor && typeof valor === 'object') {
    for (const [k, v] of Object.entries(valor)) {
      visitar(k, v, `${ruta}.${k}`);
      recorrer(v, `${ruta}.${k}`, visitar);
    }
  }
}

test('1 — cada dato del registro cumple la regla de su categoría', () => {
  for (const [cat, regla] of Object.entries(REGLA_POR_CATEGORIA)) {
    const datos = DATOS_DEMO[cat as keyof typeof DATOS_DEMO];
    assert.ok(datos.length > 0, `${cat} vacío`);
    for (const d of datos) assert.match(d, regla!, `${cat}: ${d}`);
  }
  for (const n of DATOS_DEMO.nombres) assert.match(n, /demo/i, `nombre sin marca demo: ${n}`);
  for (const e of DATOS_DEMO.empresas) assert.match(e, /demo/i, `empresa sin marca demo: ${e}`);
});

test('2 — todo valor sensible de los fixtures sale del registro demo', () => {
  let revisados = 0;
  recorrer(FIXTURES_DEMO, 'FIXTURES_DEMO', (clave, v, ruta) => {
    const cat = CLAVES_SENSIBLES[clave];
    if (!cat || v == null) return;
    revisados += 1;
    assert.equal(typeof v, 'string', `${ruta} no es texto`);
    assert.ok((DATOS_DEMO[cat] as readonly string[]).includes(v as string), `${ruta} = «${v}» no está en DATOS_DEMO.${cat}`);
  });
  assert.ok(revisados >= 5, `se esperaban ≥5 valores sensibles revisados, hubo ${revisados}`);
});

test('3 — las LT demo solo llevan placa, cédula, nombre y VIN del registro', () => {
  for (const [k, lt] of Object.entries(LT_DEMO)) {
    assert.ok(lt.raw.includes(lt.placa), `${k}: la cadena no trae su placa`);
    const numeros = lt.raw.match(/\b\d{8,10}\b/g) ?? [];
    for (const n of numeros) {
      if (n.length === 10 && !n.startsWith('35')) assert.match(n, REGLAS_DATOS_DEMO.cedula, `${k}: número con forma de cédula fuera de rango: ${n}`);
    }
    const placas = lt.raw.match(/\b[A-Z]{3}\d{3}\b/g) ?? [];
    for (const p of placas) assert.match(p, REGLAS_DATOS_DEMO.placa, `${k}: placa fuera de la serie demo: ${p}`);
    const vins = lt.raw.match(/\b[A-Z0-9]{17}\b/g) ?? []; // el VIN demo lleva «O»: imposible en un VIN real
    assert.ok(vins.length > 0, `${k}: sin VIN`);
    for (const v of vins) assert.match(v, REGLAS_DATOS_DEMO.vin, `${k}: VIN fuera de la serie demo: ${v}`);
    assert.ok(NOMBRES_DEMO.some((n) => lt.raw.includes(n)), `${k}: el propietario no es un nombre demo`);
  }
});

test('4 — las reglas rechazan datos con forma real', () => {
  assert.doesNotMatch('QOX858', REGLAS_DATOS_DEMO.placa);
  assert.doesNotMatch('1053786950', REGLAS_DATOS_DEMO.cedula);
  assert.doesNotMatch('900123456-1', REGLAS_DATOS_DEMO.nit);
  assert.doesNotMatch('3104567890', REGLAS_DATOS_DEMO.telefono);
  assert.doesNotMatch('persona@gmail.com', REGLAS_DATOS_DEMO.correo);
  assert.doesNotMatch('LRWYGCFJ0TC496126', REGLAS_DATOS_DEMO.vin);
});
