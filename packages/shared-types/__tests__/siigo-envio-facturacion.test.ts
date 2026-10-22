// Contrato de «enviar a facturación electrónica» (HU #11328).
//
// Vive en shared-types porque lo leen los dos lados: el servidor lo produce y la pantalla contará y
// pintará el desglose. Lo que se fija aquí es lo que se rompería en silencio: que la lista de
// resultados de la ruta se DERIVE de la del encolado —no que coincida por costumbre— y que la
// aritmética del resumen no deje ningún desenlace sin contar.

import { describe, it, expect } from 'vitest';
import {
  SIIGO_RESULTADOS_ENCOLADO, SIIGO_RESULTADOS_ENVIO,
  SIIGO_RESULTADOS_ENVIO_ENCOLADO, SIIGO_RESULTADOS_ENVIO_RECHAZO,
  resumenEnvioVacio, resumirEnvio,
  type SiigoEnvioTramite, type SiigoResultadoEnvio,
} from '../src/siigo-cola.js';
import { SIIGO_ESTADOS_REPORTE, SIIGO_ESTADO_REPORTE_ETIQUETA } from '../src/siigo-factura.js';
import * as siigoPermisos from '../src/siigo-permisos.js';

const item = (
  resultado: SiigoResultadoEnvio, tramiteId = 't1',
): SiigoEnvioTramite => ({
  tramiteId, resultado, motivos: [], estado: null, colaId: null, loteId: null, detalle: null,
});

describe('La lista de resultados de la ruta se deriva de la del encolado', () => {
  it('contiene todos los del encolado, más los dos que ocurren antes de llegar a la cola', () => {
    for (const r of SIIGO_RESULTADOS_ENCOLADO) expect(SIIGO_RESULTADOS_ENVIO).toContain(r);
    expect(SIIGO_RESULTADOS_ENVIO).toContain('no_elegible');
    expect(SIIGO_RESULTADOS_ENVIO).toContain('error');
    expect(SIIGO_RESULTADOS_ENVIO).toHaveLength(SIIGO_RESULTADOS_ENCOLADO.length + 2);
  });

  it('cada resultado cae en exactamente un cajón del resumen', () => {
    // Si uno quedara fuera de los tres cajones, `total` dejaría de ser la suma de los otros números
    // y el recuento del envío mentiría sin fallar.
    for (const r of SIIGO_RESULTADOS_ENVIO) {
      const enEncolado = SIIGO_RESULTADOS_ENVIO_ENCOLADO.includes(r);
      const enRechazo = SIIGO_RESULTADOS_ENVIO_RECHAZO.includes(r);
      expect(enEncolado && enRechazo).toBe(false);
    }
    expect(SIIGO_RESULTADOS_ENVIO_ENCOLADO).toEqual(['encolado', 'reactivado']);
    // `ya_en_cola` y `ya_enviado` NO son rechazos: son respuestas idempotentes a una petición
    // repetida. Contarlas como rechazo haría que refrescar una pantalla pareciera un problema.
    expect(SIIGO_RESULTADOS_ENVIO_RECHAZO).not.toContain('ya_en_cola');
    expect(SIIGO_RESULTADOS_ENVIO_RECHAZO).not.toContain('ya_enviado');
  });
});

describe('El resumen del envío cuadra siempre', () => {
  it('parte de todos los resultados a cero: ninguno desaparece por no tener casos', () => {
    const r = resumenEnvioVacio();
    for (const k of SIIGO_RESULTADOS_ENVIO) expect(r.porResultado[k]).toBe(0);
    expect(r.total).toBe(0);
  });

  it('los tres números suman el total, y el desglose también', () => {
    const r = resumirEnvio([
      item('encolado', 'a'), item('reactivado', 'b'),
      item('ya_en_cola', 'c'), item('ya_enviado', 'd'),
      item('no_elegible', 'e'), item('fallido_definitivo', 'f'), item('error', 'g'),
    ]);

    expect(r.total).toBe(7);
    expect(r.encolados).toBe(2);
    expect(r.yaEstaban).toBe(2);
    expect(r.rechazados).toBe(3);
    expect(r.encolados + r.yaEstaban + r.rechazados).toBe(r.total);
    expect(Object.values(r.porResultado).reduce((a, b) => a + b, 0)).toBe(r.total);
  });

  it('un envío vacío no inventa números', () => {
    expect(resumirEnvio([])).toEqual(resumenEnvioVacio());
  });
});

describe('AC6 — quién emite ya no se decide aquí (HU #13423)', () => {
  it('shared-types solo declara las acciones: el reparto es la función `siigo.factura.emitir` del motor', () => {
    // La tabla de roles por acción se retiró: su reparto (emitir → admin y financiera; consultar añade
    // auditor) lo sembró la 0230 y lo prueban los tests del API contra el catálogo.
    expect(siigoPermisos.ACCIONES_SIIGO).toContain('emitir');
    expect('ROLES_POR_ACCION' in siigoPermisos).toBe(false);
    expect('puedeEjecutar' in siigoPermisos).toBe(false);
  });
});

describe('El catálogo del reporte incluye `encolado` con su etiqueta', () => {
  it('cada estado tiene nombre propio en pantalla', () => {
    expect(SIIGO_ESTADOS_REPORTE).toContain('encolado');
    // El `Record` obliga a traducirlo; esto fija además que no se traduzca igual que otro, que en
    // una pantalla de control se lee como si fueran el mismo estado.
    const etiquetas = SIIGO_ESTADOS_REPORTE.map((e) => SIIGO_ESTADO_REPORTE_ETIQUETA[e]);
    expect(new Set(etiquetas).size).toBe(etiquetas.length);
  });

  it('`encolado` va antes que `en_proceso`, que es el orden del ciclo', () => {
    // La pantalla pinta los contadores en este orden. `en_proceso` significa que la clave de
    // idempotencia ya está reservada, o sea que el documento existe a medio hacer; en cola todavía
    // no hay documento ninguno.
    expect(SIIGO_ESTADOS_REPORTE.indexOf('encolado'))
      .toBeLessThan(SIIGO_ESTADOS_REPORTE.indexOf('en_proceso'));
  });
});
