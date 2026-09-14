/**
 * HU #12533 — `seccionesVisibles` (AC1/AC2/AC3/AC4 en la función pura).
 *
 * Corre con Node nativo (sin Vitest en apps/web), igual que `permissions-funciones.test.ts`:
 *   node --experimental-strip-types --test apps/web/src/pages/roles-permisos/modulos.test.ts
 *
 * Mutantes que este archivo mata:
 *   1. Ordenar las secciones alfabéticamente → falla «orden fijo».
 *   2. Mandar una clave desconocida a la sección 3 (o descartarla) → falla «desconocida → FLITO».
 *   3. Dejar `pagina.transito` en `operaciones` o pintarla en los dos → falla «reubica» y «Σ».
 *   4. Pintar «0 de 0» (devolver la sección vacía) → falla «sección sin módulos no se devuelve».
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { etiquetaModulo, kDeNMarcadas, seccionDeModulo, seccionesVisibles } from './modulos.ts';

const f = (codigo: string) => ({ codigo, nombreNegocio: codigo, descripcion: null, tipo: 'pagina' as const });
const g = (modulo: string, ...codigos: string[]) => ({ modulo, funciones: codigos.map(f) });

describe('seccionesVisibles (HU #12533)', () => {
  it('reparte en orden fijo FLITO → Ya existía → Existe, alfabético por etiqueta dentro', () => {
    const s = seccionesVisibles([g('usuarios', 'a'), g('pesv', 'b'), g('impuestos', 'c'), g('bitacora', 'd'), g('general', 'e')]);
    assert.deepEqual(s.map((x) => x.titulo), ['FLITO', 'Ya existía y FLITO lo usa', 'Existe pero no se usa']);
    assert.deepEqual(s[0].grupos.map((x) => x.modulo), ['bitacora', 'impuestos']);
    assert.deepEqual(s[1].grupos.map((x) => x.modulo), ['general', 'usuarios']);
    assert.deepEqual(s[2].grupos.map((x) => x.modulo), ['pesv']);
    assert.equal(s[2].ayuda, 'Si se marcan, el rol sí entra a esas pantallas. FLITO no las usa hoy.');
    assert.equal(s[0].ayuda, undefined);
    assert.equal(s[1].ayuda, undefined);
  });

  it('clave desconocida → FLITO, sin romper', () => {
    assert.equal(seccionDeModulo('modulo_nuevo_xyz'), 'flito');
    const s = seccionesVisibles([g('modulo_nuevo_xyz', 'nuevo.entrar')]);
    assert.equal(s.length, 1);
    assert.equal(s[0].clave, 'flito');
    assert.deepEqual(s[0].grupos.map((x) => x.modulo), ['modulo_nuevo_xyz']);
  });

  it('una sección sin módulos no se devuelve; un módulo vacío tampoco', () => {
    const s = seccionesVisibles([g('impuestos', 'c'), g('pesv')]);
    assert.deepEqual(s.map((x) => x.clave), ['flito']);
  });

  it('reubica transito/drive/privacy y crea el módulo destino si falta; el origen vacío no se pinta', () => {
    const s = seccionesVisibles([
      g('operaciones', 'pagina.transito', 'pagina.drive'),
      g('administracion', 'pagina.privacy'),
    ]);
    const modulos = Object.fromEntries(s.flatMap((x) => x.grupos.map((m) => [m.modulo, { seccion: x.clave, codigos: m.funciones.map((q) => q.codigo) }])));
    assert.deepEqual(modulos, {
      derechos: { seccion: 'flito', codigos: ['pagina.drive'] },
      transito: { seccion: 'previo_en_uso', codigos: ['pagina.transito'] },
      privacidad: { seccion: 'previo_sin_uso', codigos: ['pagina.privacy'] },
    });
    assert.equal(etiquetaModulo('privacidad'), 'Privacidad y datos');
  });

  it('reubica dentro del módulo destino existente y deja «Operaciones» con lo suyo; Σ == total sin duplicados', () => {
    const entrada = [
      g('operaciones', 'pagina.vehiculos', 'pagina.soat', 'pagina.tramite_digital', 'pagina.lectura_impuestos', 'pagina.transito', 'pagina.drive'),
      g('administracion', 'pagina.privacy', 'pagina.admin'),
      g('transito', 'transito.bandeja'),
      g('derechos', 'derechos.consultar'),
    ];
    const s = seccionesVisibles(entrada);
    const porModulo = new Map(s.flatMap((x) => x.grupos.map((m) => [m.modulo, m.funciones.map((q) => q.codigo)])));
    assert.deepEqual(porModulo.get('operaciones'), ['pagina.vehiculos', 'pagina.soat', 'pagina.tramite_digital', 'pagina.lectura_impuestos']);
    assert.deepEqual(porModulo.get('transito'), ['transito.bandeja', 'pagina.transito']);
    assert.deepEqual(porModulo.get('derechos'), ['derechos.consultar', 'pagina.drive']);
    assert.deepEqual(porModulo.get('administracion'), ['pagina.admin']);
    assert.deepEqual(porModulo.get('privacidad'), ['pagina.privacy']);
    const todas = s.flatMap((x) => x.grupos.flatMap((m) => m.funciones.map((q) => q.codigo))).sort();
    const esperadas = entrada.flatMap((m) => m.funciones.map((q) => q.codigo)).sort();
    assert.deepEqual(todas, esperadas);
    assert.equal(new Set(todas).size, esperadas.length);
    // La entrada no se muta: el padre sigue contando el total sobre `grupos`.
    assert.equal(entrada[0].funciones.length, 6);
  });

  it('kDeNMarcadas: singular solo con k = 1', () => {
    assert.equal(kDeNMarcadas(0, 5), '0 de 5 marcadas');
    assert.equal(kDeNMarcadas(1, 5), '1 de 5 marcada');
    assert.equal(kDeNMarcadas(5, 5), '5 de 5 marcadas');
  });
});
