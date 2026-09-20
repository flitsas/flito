/**
 * HU #12533 — `seccionesVisibles` (AC1/AC2/AC3/AC4 en la función pura).
 *
 * Corre con Node nativo (sin Vitest en apps/web), igual que `permissions-funciones.test.ts`:
 *   node --experimental-strip-types --test apps/web/src/pages/roles-permisos/modulos.test.ts
 *
 * Mutantes que este archivo mata:
 *   1. Ordenar las secciones alfabéticamente → falla «orden fijo».
 *   2. Mandar una clave desconocida a la sección 3 (o descartarla) → falla «desconocida → FLITO».
 *   3. Dejar `pagina.privacy` en `administracion` o pintarla en los dos → falla «reubica» y «Σ».
 *   4. Pintar «0 de 0» (devolver la sección vacía) → falla «sección sin módulos no se devuelve».
 *   5. (HU #12716) Volver a reubicar `pagina.transito`/`pagina.drive` por presentación → falla
 *      «llegan agrupadas del API»; resucitar la etiqueta «FLITO (SOAT e Impuestos)» → falla
 *      «etiquetas de la #12716».
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

  it('reubica privacy y crea el módulo destino si falta; el origen vacío no se pinta', () => {
    const s = seccionesVisibles([g('administracion', 'pagina.privacy')]);
    const modulos = Object.fromEntries(s.flatMap((x) => x.grupos.map((m) => [m.modulo, { seccion: x.clave, codigos: m.funciones.map((q) => q.codigo) }])));
    assert.deepEqual(modulos, {
      privacidad: { seccion: 'previo_sin_uso', codigos: ['pagina.privacy'] },
    });
    assert.equal(etiquetaModulo('privacidad'), 'Privacidad y datos');
  });

  it('HU #12716: transito y drive llegan agrupadas del API y se pintan donde llegan, sin reubicar', () => {
    // Si el API (o un mock viejo) las manda en `operaciones`, se quedan ahí: la pantalla ya no las mueve.
    const s = seccionesVisibles([
      g('operaciones', 'pagina.transito', 'pagina.drive'),
      g('transito', 'pagina.transito2'),
    ]);
    const porModulo = new Map(s.flatMap((x) => x.grupos.map((m) => [m.modulo, m.funciones.map((q) => q.codigo)])));
    assert.deepEqual(porModulo.get('operaciones'), ['pagina.transito', 'pagina.drive']);
    assert.deepEqual(porModulo.get('transito'), ['pagina.transito2']);
    assert.equal(porModulo.has('derechos'), false);
    // Y en su grupo real (pantalla primero, como las devuelve el API) no se tocan ni se reordenan.
    const real = seccionesVisibles([
      g('transito', 'pagina.transito', 'transito.bandeja'),
      g('derechos', 'pagina.drive', 'derechos.consultar'),
    ]);
    const porModuloReal = new Map(real.flatMap((x) => x.grupos.map((m) => [m.modulo, m.funciones.map((q) => q.codigo)])));
    assert.deepEqual(porModuloReal.get('transito'), ['pagina.transito', 'transito.bandeja']);
    assert.deepEqual(porModuloReal.get('derechos'), ['pagina.drive', 'derechos.consultar']);
    assert.deepEqual(real.map((x) => x.clave), ['flito', 'previo_en_uso']);
  });

  it('reubica dentro del módulo destino existente y deja «Administración» con lo suyo; Σ == total sin duplicados', () => {
    const entrada = [
      g('operaciones', 'pagina.vehiculos', 'pagina.soat', 'pagina.tramite_digital', 'pagina.lectura_impuestos'),
      g('administracion', 'pagina.privacy', 'pagina.admin'),
      g('privacidad', 'privacidad.exportar'),
      g('transito', 'pagina.transito', 'transito.bandeja'),
      g('derechos', 'pagina.drive', 'derechos.consultar'),
    ];
    const s = seccionesVisibles(entrada);
    const porModulo = new Map(s.flatMap((x) => x.grupos.map((m) => [m.modulo, m.funciones.map((q) => q.codigo)])));
    assert.deepEqual(porModulo.get('operaciones'), ['pagina.vehiculos', 'pagina.soat', 'pagina.tramite_digital', 'pagina.lectura_impuestos']);
    assert.deepEqual(porModulo.get('transito'), ['pagina.transito', 'transito.bandeja']);
    assert.deepEqual(porModulo.get('derechos'), ['pagina.drive', 'derechos.consultar']);
    assert.deepEqual(porModulo.get('administracion'), ['pagina.admin']);
    // La reubicada se pinta detrás de lo que ya era del destino.
    assert.deepEqual(porModulo.get('privacidad'), ['privacidad.exportar', 'pagina.privacy']);
    const todas = s.flatMap((x) => x.grupos.flatMap((m) => m.funciones.map((q) => q.codigo))).sort();
    const esperadas = entrada.flatMap((m) => m.funciones.map((q) => q.codigo)).sort();
    assert.deepEqual(todas, esperadas);
    assert.equal(new Set(todas).size, esperadas.length);
    // La entrada no se muta: el padre sigue contando el total sobre `grupos`.
    assert.equal(entrada[1].funciones.length, 2);
  });

  it('HU #12716: etiquetas de los módulos nuevos en FLITO; el cajón viejo ya no tiene etiqueta propia', () => {
    const nuevas: Record<string, string> = {
      clientes: 'Clientes',
      tarifas: 'Tarifas',
      servicios_adicionales: 'Servicios adicionales',
      catalogos_compartidos: 'Catálogos compartidos',
      comprobantes: 'Comprobantes',
    };
    for (const [clave, etiqueta] of Object.entries(nuevas)) {
      assert.equal(etiquetaModulo(clave), etiqueta, clave);
      assert.equal(seccionDeModulo(clave), 'flito', clave);
    }
    // Sin etiqueta propia → repliegue (clave capitalizada y sin `_`), no «FLITO (SOAT e Impuestos)».
    assert.equal(etiquetaModulo('flito_soat_e_impuestos'), 'Flito soat e impuestos');
    // Los otros tres módulos que desaparecen tampoco: «Parametrizacion» sin tilde y «Sync» a secas
    // son el repliegue, no la etiqueta que tenían.
    assert.equal(etiquetaModulo('parametrizacion'), 'Parametrizacion');
    assert.equal(etiquetaModulo('sync'), 'Sync');
    assert.equal(etiquetaModulo('finanzas'), 'Finanzas');
    // Un módulo de la sección 1 y otro de la 2 que sí conservan etiqueta, para anclar el mapa.
    assert.equal(etiquetaModulo('logistica'), 'Logística');
    assert.equal(etiquetaModulo('transito'), 'Tránsito');
  });

  it('kDeNMarcadas: singular solo con k = 1', () => {
    assert.equal(kDeNMarcadas(0, 5), '0 de 5 marcadas');
    assert.equal(kDeNMarcadas(1, 5), '1 de 5 marcada');
    assert.equal(kDeNMarcadas(5, 5), '5 de 5 marcadas');
  });
});
