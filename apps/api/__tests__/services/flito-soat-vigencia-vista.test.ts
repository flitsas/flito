import { describe, it, expect } from 'vitest';
// El módulo bajo prueba es del FRONT (`apps/web/src/lib/vigenciaSoatCola.ts`) y se prueba desde
// aquí porque este es el único runner de pruebas unitarias del monorepo; hay precedente
// (`permissions.authz.test.ts` y `flito-comparendos-pagina-router.test.ts` leen `apps/web/src`).
// Se puede importar sin navegador porque la función es PURA: sin React, sin DOM y con la fecha
// inyectada. Ese es justo el motivo por el que el mapeo no vive dentro del `.tsx`.
import { pintarVigenciaSoat, textoVigenciaSoat } from '../../../web/src/lib/vigenciaSoatCola';

/**
 * HU #12097 — cómo se pinta la vigencia del SOAT en la cola.
 *
 * **Todo el archivo corre con la zona forzada dentro del módulo** (`America/Bogota` explícita en
 * `Intl`), y las fechas de referencia están elegidas para que el huso del que ejecuta no pueda
 * salvar a un mutante: si alguien quita la zona, `TZ=UTC` y `TZ=America/Bogota` dan resultados
 * distintos y al menos uno de estos asertos cae.
 */

// 02:00 en Bogotá del 7 de septiembre de 2026 (07:00 UTC). La hora importa: es DESPUÉS de la
// medianoche y ANTES de que hayan pasado 24 h desde el reintento de las 03:10 del día anterior.
const AHORA = new Date('2026-09-07T07:00:00Z');
/** La corrida de las 00:10 de HOY en Bogotá. */
const HOY_0010 = '2026-09-07T05:10:00Z';
/** El reintento de las 03:10 de AYER en Bogotá: 22,8 h antes de `AHORA`. */
const AYER_0310 = '2026-09-06T08:10:00Z';
/** La corrida de las 00:10 del 4 de septiembre: tres días de calendario. */
const HACE_3_DIAS = '2026-09-04T05:10:00Z';

describe('pintarVigenciaSoat — las cuatro superficies (AC1, AC3)', () => {
  it('vigente con fecha: chip verde con el hasta, y la línea abre con «Verificado»', () => {
    const p = pintarVigenciaSoat({ estado: 'vigente', verificadaEn: HOY_0010, venceEl: '2027-03-12' }, AHORA);
    expect(p).toEqual({ chip: { etiqueta: 'Vigente hasta 12/03/27', tono: 'success' }, linea: 'Verificado hoy' });
  });

  it('vigente SIN fecha de vencimiento: otra redacción entera, no «Vigente hasta —»', () => {
    // El RUNT reporta a veces por estado y sin fecha, y es legítimo.
    const p = pintarVigenciaSoat({ estado: 'vigente', verificadaEn: HOY_0010, venceEl: null }, AHORA);
    expect(p?.chip).toEqual({ etiqueta: 'Vigente', tono: 'success' });
    expect(p?.linea).toBe('Verificado hoy');
  });

  it('vencido: «Venció el …» en warning, no en el rojo de «Sin SOAT en el RUNT»', () => {
    const p = pintarVigenciaSoat({ estado: 'vencido', verificadaEn: HOY_0010, venceEl: '2026-03-12' }, AHORA);
    expect(p?.chip).toEqual({ etiqueta: 'Venció el 12/03/26', tono: 'warning' });
  });

  it('sin_registro: nombra al RUNT y a la póliza, y NO se confunde con «No se pudo consultar»', () => {
    const p = pintarVigenciaSoat({ estado: 'sin_registro', verificadaEn: HOY_0010, venceEl: null }, AHORA);
    expect(p?.chip).toEqual({ etiqueta: 'Sin SOAT en el RUNT', tono: 'danger' });
    // El discriminador del AC3 que no depende del color: hubo respuesta, así que abre con «Verificado».
    expect(p?.linea).toBe('Verificado hoy');
  });

  it('no_verificado CON fecha: azul, y la línea cambia de gramática a «Último dato:»', () => {
    const p = pintarVigenciaSoat({ estado: 'no_verificado', verificadaEn: HACE_3_DIAS, venceEl: null }, AHORA);
    expect(p).toEqual({
      chip: { etiqueta: 'No se pudo consultar', tono: 'active' },
      // La línea NO repite lo que dice el chip: dice desde cuándo no sabemos nada. Y es la fecha de
      // la última RESPUESTA, no la del intento fallido de hoy.
      linea: 'Último dato: hace 3 días (4/09/26)',
    });
    expect(p?.linea).not.toContain('Verificado');
  });

  it('los cuatro chips usan los cuatro tonos que valen en tema oscuro, y ninguno repite', () => {
    // `neutral` y `draft` redefinen su tinta en oscuro contra un fondo fijo (1,98:1 y 1,37:1). El
    // mutante que hay que matar es el instinto de pintar «No se pudo consultar» en gris.
    const tonos = [
      pintarVigenciaSoat({ estado: 'vigente', verificadaEn: HOY_0010, venceEl: '2027-03-12' }, AHORA),
      pintarVigenciaSoat({ estado: 'vencido', verificadaEn: HOY_0010, venceEl: '2026-03-12' }, AHORA),
      pintarVigenciaSoat({ estado: 'sin_registro', verificadaEn: HOY_0010, venceEl: null }, AHORA),
      pintarVigenciaSoat({ estado: 'no_verificado', verificadaEn: HOY_0010, venceEl: null }, AHORA),
    ].map((p) => p?.chip?.tono);
    expect(tonos).toEqual(['success', 'warning', 'danger', 'active']);
    expect(new Set(tonos).size).toBe(4);
  });
});

describe('pintarVigenciaSoat — manda `verificadaEn`, no `estado`', () => {
  // El error más fácil de toda la HU: escribir el mapeo como un `switch (estado)`. Con ese mutante,
  // los CUATRO casos de abajo devuelven chip, y tres de ellos afirman algo del vehículo que nadie
  // ha comprobado.
  for (const estado of ['vigente', 'vencido', 'sin_registro', 'no_verificado'] as const) {
    it(`${estado} con verificadaEn nulo → «Sin verificar», sin chip`, () => {
      const p = pintarVigenciaSoat({ estado, verificadaEn: null, venceEl: '2027-03-12' }, AHORA);
      expect(p).toEqual({ chip: null, linea: 'Sin verificar' });
    });
  }

  it('«Sin verificar» no promete una espera: sin «todavía»', () => {
    // Sobre un VIN que el RUNT nunca acepta, «todavía» se leería como benigno para siempre.
    const p = pintarVigenciaSoat({ estado: 'no_verificado', verificadaEn: null, venceEl: null }, AHORA);
    expect(p?.linea).toBe('Sin verificar');
    expect(p?.linea).not.toContain('todavía');
  });

  it('la fila que no entra en la verificación no pinta NADA, ni un «—»', () => {
    // `null` = sin comprobante cargado. `undefined` = el API es anterior a la HU (en DEV el merge es
    // el deploy y el bundle puede ir por delante), o el lector es el rol `cliente`.
    expect(pintarVigenciaSoat(null, AHORA)).toBeNull();
    expect(pintarVigenciaSoat(undefined, AHORA)).toBeNull();
  });
});

describe('pintarVigenciaSoat — la antigüedad son días de CALENDARIO en Bogotá (AC1)', () => {
  it('la corrida de las 00:10 de hoy es «hoy»', () => {
    expect(pintarVigenciaSoat({ estado: 'vigente', verificadaEn: HOY_0010, venceEl: null }, AHORA)?.linea)
      .toBe('Verificado hoy');
  });

  it('el reintento de las 03:10 de AYER es «ayer», aunque no hayan pasado 24 horas', () => {
    // 22,8 h antes de `AHORA`: con `Math.floor(ms/86400000)` esto sale «hoy». Es el mutante que la
    // HU nombra por su nombre, y solo muere si el corte es el día de calendario.
    expect(AHORA.getTime() - new Date(AYER_0310).getTime()).toBeLessThan(24 * 3600 * 1000);
    expect(pintarVigenciaSoat({ estado: 'vigente', verificadaEn: AYER_0310, venceEl: null }, AHORA)?.linea)
      .toBe('Verificado ayer');
  });

  it('a partir de dos días entra la fecha absoluta, con año', () => {
    expect(pintarVigenciaSoat({ estado: 'vigente', verificadaEn: HACE_3_DIAS, venceEl: null }, AHORA)?.linea)
      .toBe('Verificado hace 3 días (4/09/26)');
  });

  it('la zona es Bogotá y no UTC: las 21:00 de ayer en Colombia no son «hoy»', () => {
    // 2026-09-07T02:00:00Z es el DÍA 7 en UTC y el 6 a las 21:00 en Bogotá. Quien quite la zona —o
    // use el reloj del navegador— dice «hoy» aquí.
    expect(pintarVigenciaSoat({ estado: 'vigente', verificadaEn: '2026-09-07T02:00:00Z', venceEl: null }, AHORA)?.linea)
      .toBe('Verificado ayer');
  });

  it('la fecha de vencimiento se formatea sin pasar por la medianoche UTC', () => {
    // `new Date('2027-03-01').toLocaleDateString('es-CO')` da «28/02» en Colombia. La frontera de
    // mes es donde ese error se ve.
    expect(pintarVigenciaSoat({ estado: 'vigente', verificadaEn: HOY_0010, venceEl: '2027-03-01' }, AHORA)?.chip?.etiqueta)
      .toBe('Vigente hasta 1/03/27');
  });

  it('vence HOY sigue siendo vigente: el front no re-deriva «vencido»', () => {
    // La frontera. `vencido` lo deriva el SERVIDOR sobre el conjunto entero, porque el filtro corre
    // en SQL; una segunda derivación aquí haría que el chip y el filtro se contradijeran justo el
    // día del vencimiento. Si alguien compara `venceEl` con hoy en el front, este aserto cae.
    const p = pintarVigenciaSoat({ estado: 'vigente', verificadaEn: HOY_0010, venceEl: '2026-09-07' }, AHORA);
    expect(p?.chip).toEqual({ etiqueta: 'Vigente hasta 7/09/26', tono: 'success' });
    expect(p?.chip?.etiqueta).not.toContain('Venció');
  });
});

describe('textoVigenciaSoat — el mismo texto para el modal (AC4: solo lectura)', () => {
  it('devuelve la etiqueta del chip cuando hay chip', () => {
    expect(textoVigenciaSoat({ estado: 'sin_registro', verificadaEn: HOY_0010, venceEl: null }, AHORA))
      .toBe('Sin SOAT en el RUNT');
  });

  it('y la línea cuando no lo hay', () => {
    expect(textoVigenciaSoat({ estado: 'no_verificado', verificadaEn: null, venceEl: null }, AHORA))
      .toBe('Sin verificar');
  });

  it('«—» solo en el modal, y solo cuando la fila no entra en la verificación', () => {
    expect(textoVigenciaSoat(null, AHORA)).toBe('—');
    expect(textoVigenciaSoat(undefined, AHORA)).toBe('—');
  });
});
