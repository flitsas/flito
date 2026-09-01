import { test, expect } from '@playwright/test';
import {
  SIIGO_BANDEJA_TOPE_REENVIO, SIIGO_BANDEJA_TOPE_REINTENTO,
} from '@operaciones/shared-types';
import {
  admiteLote, previsualizarLote, type CasoLote,
} from '../../src/components/siigo/operacion/previsualizarLote';

// AC4 — la ARITMÉTICA del lote, probada sin montar React y sin abrir un navegador.
//
// El número que alguien lee justo antes de confirmar merece pruebas propias. Dentro del componente
// solo podría comprobarse a través de un `<span>`, que es exactamente la clase de prueba que sigue
// en verde cuando el número está mal. Este archivo no usa `page`: es un test unitario que corre con
// el mismo runner que el resto del repo (el patrón ya existe: `flito-comparendos-detalle.spec.ts`
// importa constantes de `@operaciones/shared-types`).

let secuencia = 0;

function caso(parcial: Partial<CasoLote> = {}): CasoLote {
  secuencia += 1;
  return {
    clave: `emision:${secuencia}`,
    etiqueta: `FLIT-${2000 + secuencia}`,
    fuente: 'emision',
    facturaId: `f-${secuencia}`,
    // Cada caso nace un día más nuevo que el anterior: el orden por antigüedad se puede afirmar.
    ocurridoEn: new Date(Date.UTC(2026, 0, secuencia % 27 + 1)).toISOString(),
    sirveReintentar: true,
    descartado: false,
    descripcion: 'Falta el código de ciudad del cliente.',
    accion: 'Complétalo en la ficha fiscal.',
    ...parcial,
  };
}

test.describe('AC4 — la previsualización del lote', () => {
  test('el número de la frase y el del botón son la MISMA variable', () => {
    const previa = previsualizarLote([
      caso(), caso(), caso({ fuente: 'correo' }),
      caso({ sirveReintentar: false }),
      caso({ descartado: true }),
      caso({ fuente: 'dian' }),
    ]);

    expect(previa.seleccionados).toBe(6);
    // 2 de emisión + 1 de correo entran; 3 quedan fuera, cada uno por su motivo.
    expect(previa.aIntentar).toBe(3);
    expect(previa.emision.casos).toHaveLength(2);
    expect(previa.correo.casos).toHaveLength(1);
    expect(previa.aIntentar).toBe(previa.emision.casos.length + previa.correo.casos.length);
    expect(previa.totalFuera).toBe(3);
  });

  test('cada exclusión trae SU motivo, no un recuento', () => {
    const previa = previsualizarLote([
      caso({ sirveReintentar: false, descripcion: 'El cliente no existe como tercero en Siigo.', accion: 'Sincronízalo desde su ficha.' }),
      caso({ descartado: true }),
      caso({ fuente: 'dian' }),
    ]);

    expect(previa.noSirveReintentar[0].motivo)
      .toBe('El cliente no existe como tercero en Siigo. → Sincronízalo desde su ficha.');
    expect(previa.descartados[0].motivo).toContain('volver a ponerlo en la cola');
    expect(previa.dian[0].motivo).toContain('un segundo documento');
  });

  test('la palabra «descartar» no aparece en ningún motivo de la previsualización', () => {
    // Está ocupada por *dar por perdido*: «se van a descartar 4» se leería como «esos cuatro quedan
    // marcados como fallido definitivo», que es lo contrario de lo que pasa.
    const previa = previsualizarLote([
      caso({ sirveReintentar: false }), caso({ descartado: true }), caso({ fuente: 'dian' }),
      ...Array.from({ length: SIIGO_BANDEJA_TOPE_REENVIO + 1 }, () => caso({ fuente: 'correo' })),
    ]);
    const textos = [
      ...previa.noSirveReintentar, ...previa.descartados, ...previa.dian, ...previa.fueraDeTope,
    ].map((e) => e.motivo).join(' ').toLowerCase();

    expect(textos).not.toContain('descart');
  });

  test('con tope, entran los MÁS ANTIGUOS y el que queda fuera es el más reciente', () => {
    const correos = Array.from({ length: SIIGO_BANDEJA_TOPE_REENVIO + 1 }, (_, i) => caso({
      fuente: 'correo',
      etiqueta: `CORREO-${i}`,
      ocurridoEn: new Date(Date.UTC(2026, 0, 1, i)).toISOString(),
    }));
    // Se mezclan a propósito: la función ordena, no confía en el orden de entrada.
    const previa = previsualizarLote([...correos].reverse());

    expect(previa.correo.casos).toHaveLength(SIIGO_BANDEJA_TOPE_REENVIO);
    expect(previa.correo.casos[0].etiqueta).toBe('CORREO-0');
    expect(previa.fueraDeTope).toHaveLength(1);
    expect(previa.fueraDeTope[0].etiqueta).toBe(`CORREO-${SIIGO_BANDEJA_TOPE_REENVIO}`);
    expect(previa.fueraDeTope[0].motivo).toContain(String(SIIGO_BANDEJA_TOPE_REENVIO));
  });

  test('los dos bloques tienen topes DISTINTOS y no se comparten', () => {
    expect(SIIGO_BANDEJA_TOPE_REINTENTO).toBeGreaterThan(SIIGO_BANDEJA_TOPE_REENVIO);
    const previa = previsualizarLote([]);
    expect(previa.topeEmision).toBe(SIIGO_BANDEJA_TOPE_REINTENTO);
    expect(previa.topeCorreo).toBe(SIIGO_BANDEJA_TOPE_REENVIO);
  });

  test('los ids que viajan no se repiten aunque dos actas sean de la misma factura', () => {
    const previa = previsualizarLote([
      caso({ fuente: 'correo', facturaId: 'misma' }),
      caso({ fuente: 'correo', facturaId: 'misma' }),
    ]);
    expect(previa.correo.casos).toHaveLength(2);
    expect(previa.correo.facturaIds).toEqual(['misma']);
  });

  test('`admiteLote` es el mismo predicado que la casilla de la fila', () => {
    expect(admiteLote({ fuente: 'emision', descartado: false, sirveReintentar: true })).toBe(true);
    expect(admiteLote({ fuente: 'correo', descartado: false, sirveReintentar: true })).toBe(true);
    expect(admiteLote({ fuente: 'dian', descartado: false, sirveReintentar: true })).toBe(false);
    expect(admiteLote({ fuente: 'emision', descartado: true, sirveReintentar: true })).toBe(false);
    expect(admiteLote({ fuente: 'emision', descartado: false, sirveReintentar: false })).toBe(false);
  });

  test('sin nada seleccionado no hay nada que ofrecer', () => {
    const previa = previsualizarLote([]);
    expect(previa.aIntentar).toBe(0);
    expect(previa.totalFuera).toBe(0);
  });
});
