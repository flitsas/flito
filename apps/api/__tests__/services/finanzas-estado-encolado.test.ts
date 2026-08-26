// Reporte de costos — el estado `encolado` y los datos de la factura en cada fila (HU #11328).
//
// Lo que se puede probar sin motor es la FORMA del SQL y el mapeo de la fila. Que la escalera
// clasifique bien cada combinación es garantía de PostgreSQL, no de TypeScript; lo que estos tests
// fijan es lo que un refactor rompería sin que ninguna consulta fallara: el ORDEN de la escalera y
// que la celda de la fila salga de la misma expresión que el filtro.
//
// El invariante que de verdad importa aquí se comprueba POR MUTACIÓN: si alguien pone la cola antes
// que la factura en el COALESCE, un trámite con emisión fallida y su fila de cola en `error` pasaría
// a pintarse «En cola» —es decir, «tranquilo, va en camino»— cuando lo que hay es un fallo que
// alguien tiene que resolver. El test del orden falla.

import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { SIIGO_ESTADOS_REPORTE, SIIGO_ESTADO_REPORTE_ETIQUETA } from '@operaciones/shared-types';
import {
  EXPR_ESTADO_FACTURACION_COMPLETA, SELECT_FACTURACION_ELECTRONICA,
  componerResumen, condicionEstadoFacturacion, facturacionDeFila, resumenVacio,
} from '../../src/modules/finanzas/finanzas.facturacion-electronica.js';

const aTexto = (q: Parameters<PgDialect['sqlToQuery']>[0]) => new PgDialect().sqlToQuery(q).sql;

describe('AC4 — un trámite encolado deja de parecer «sin enviar»', () => {
  it('`encolado` está en el catálogo y tiene etiqueta propia', () => {
    expect(SIIGO_ESTADOS_REPORTE).toContain('encolado');
    // La etiqueta no puede coincidir con ninguna otra: el reporte es una pantalla de control y dos
    // estados distintos con el mismo rótulo se leen como uno solo.
    const etiquetas = SIIGO_ESTADOS_REPORTE.map((e) => SIIGO_ESTADO_REPORTE_ETIQUETA[e]);
    expect(new Set(etiquetas).size).toBe(etiquetas.length);
    expect(SIIGO_ESTADO_REPORTE_ETIQUETA.encolado)
      .not.toBe(SIIGO_ESTADO_REPORTE_ETIQUETA.no_enviado);
  });

  it('la expresión mira la cola, y solo lo que el trabajador va a volver a mirar', () => {
    const texto = aTexto(EXPR_ESTADO_FACTURACION_COMPLETA);

    expect(texto).toContain('siigo_cola_facturacion');
    // Por PERTENENCIA del lote: la huella no se puede invertir, así que sin el puente no hay forma
    // de saber qué trámites contiene una fila de cola.
    expect(texto).toContain('siigo_lote_tramites');
    expect(texto).toContain("c.estado IN ('pendiente', 'error')");
  });

  it('`enviado` y `fallido_definitivo` NO cuentan como encolado', () => {
    const texto = aTexto(EXPR_ESTADO_FACTURACION_COMPLETA);

    // `enviado` tiene factura y la manda la subconsulta de facturas. `fallido_definitivo` queda
    // fuera del alcance de esta historia a propósito: decidir si un lote dado por perdido SIN
    // factura es `fallido` toca la bandeja de fallidos (HU #11340), y se prefiere no afirmarlo.
    expect(texto).not.toContain("c.estado IN ('pendiente', 'error', 'enviado')");
    expect(texto).not.toContain('fallido_definitivo');
  });
});

describe('El ORDEN de la escalera: la factura manda sobre la cola', () => {
  it('la subconsulta de facturas va ANTES que la de la cola en el COALESCE', () => {
    const texto = aTexto(EXPR_ESTADO_FACTURACION_COMPLETA);

    // Una fila de cola en `error` convive con una factura `fallida`: es el reintento pendiente de
    // una emisión que falló. Si la cola fuera primero, esa fila se pintaría «En cola» y el estado
    // sobre el que alguien tiene que actuar desaparecería de la pantalla.
    const posFactura = texto.indexOf('siigo_factura_tramites');
    const posCola = texto.indexOf('siigo_cola_facturacion');
    expect(posFactura).toBeGreaterThan(-1);
    expect(posCola).toBeGreaterThan(posFactura);
  });

  it('y `encolado` va antes que el «nunca se pidió», que es el último recurso', () => {
    const texto = aTexto(EXPR_ESTADO_FACTURACION_COMPLETA);
    expect(texto.indexOf("'encolado'")).toBeLessThan(texto.indexOf("'no_enviado'"));
  });

  it('el fallo de emisión sigue mandando sobre lo que diga la DIAN', () => {
    const texto = aTexto(EXPR_ESTADO_FACTURACION_COMPLETA);
    // Se conserva de la HU #11336: si no salió, la DIAN no tiene nada que decir.
    expect(texto.indexOf("'fallido'")).toBeLessThan(texto.indexOf("'aceptado'"));
  });

  it('sigue siendo una sola definición: el filtro compara contra la MISMA escalera', () => {
    const filtro = aTexto(condicionEstadoFacturacion('encolado'));
    const expresion = aTexto(EXPR_ESTADO_FACTURACION_COMPLETA);

    // Si el filtro tuviera su propia copia, elegir «En cola» devolvería un conjunto que no coincide
    // con el contador que lo anuncia. La comparación de textos es lo que lo impide en frío.
    expect(filtro).toContain(expresion);
    expect(new PgDialect().sqlToQuery(condicionEstadoFacturacion('encolado')).params)
      .toEqual(['encolado']);
  });

  it('el contador de `encolado` cuadra con el total como cualquier otro', () => {
    const r = componerResumen([
      { estado: 'encolado', cuantos: 4 },
      { estado: 'no_enviado', cuantos: 6 },
    ]);
    expect(r.encolado).toBe(4);
    expect(r.total).toBe(10);
    expect(SIIGO_ESTADOS_REPORTE.reduce((acc, e) => acc + r[e], 0)).toBe(10);
    // Y arranca en cero como el resto: un estado sin casos no desaparece del desglose.
    expect(resumenVacio().encolado).toBe(0);
  });
});

describe('AC4 — cada fila trae número de factura y marca de revisión, en la misma consulta', () => {
  it('las dos columnas se resuelven con subconsultas, no con una llamada por fila', () => {
    const estado = aTexto(SELECT_FACTURACION_ELECTRONICA.estadoFacturacion);
    const datos = aTexto(SELECT_FACTURACION_ELECTRONICA.facturaDatos);

    expect(estado).toContain('COALESCE');
    expect(datos).toContain('jsonb_build_object');
    expect(datos).toContain('sf.numero');
    expect(datos).toContain('sf.requiere_revision');
    // Correlacionadas con el trámite de la fila: sin esto habría que consultar una por una.
    expect(datos).toContain('WHERE sft.tramite_id =');
  });

  it('número y marca salen de LA MISMA factura que el estado', () => {
    const datos = aTexto(SELECT_FACTURACION_ELECTRONICA.facturaDatos);

    // El mismo desempate que el estado. Con otro orden, una fila podría decir «Emitida» y enseñar
    // al lado el número del intento anterior, que es peor que no enseñar ninguno.
    expect(datos).toContain('ORDER BY sft.activo DESC, sf.created_at DESC');
    expect(datos).toContain("AND (sft.activo OR sf.estado = 'fallida')");
    expect(datos).toContain('LIMIT 1');
  });

  it('y no arrastra el historial DIAN, que esa proyección no lee', () => {
    const datos = aTexto(SELECT_FACTURACION_ELECTRONICA.facturaDatos);
    const estado = aTexto(SELECT_FACTURACION_ELECTRONICA.estadoFacturacion);

    // Son 200 accesos por página a una tabla que no aporta ninguna columna a este jsonb, y confiar
    // en que el planificador elimine el LEFT JOIN es confiar en algo que no está garantizado.
    expect(datos).not.toContain('siigo_factura_estados_dian');
    // El estado sí lo necesita: es uno de sus dos ejes.
    expect(estado).toContain('siigo_factura_estados_dian');
  });

  it('un trámite sin factura no inventa número ni marca', () => {
    const f = facturacionDeFila({ estadoFacturacion: 'no_enviado', facturaDatos: null });
    expect(f).toEqual({
      estadoFacturacion: 'no_enviado', facturaNumero: null, facturaRequiereRevision: false,
    });
  });

  it('lee el jsonb venga como objeto o como texto', () => {
    const objeto = facturacionDeFila({
      estadoFacturacion: 'emitido',
      facturaDatos: { numero: 'FV-1', requiereRevision: true },
    });
    const texto = facturacionDeFila({
      estadoFacturacion: 'emitido',
      facturaDatos: '{"numero":"FV-1","requiereRevision":true}',
    });

    // El driver puede parsear el jsonb o devolverlo crudo según versión. Que la fila cambie de forma
    // por eso sería un fallo invisible: la columna se vaciaría sin que nada avisara.
    expect(objeto).toEqual(texto);
    expect(objeto.facturaNumero).toBe('FV-1');
    expect(objeto.facturaRequiereRevision).toBe(true);
  });

  it('la marca de revisión es APARTE del estado: una emitida discrepante sigue emitida', () => {
    const f = facturacionDeFila({
      estadoFacturacion: 'aceptado',
      facturaDatos: { numero: 'FV-9', requiereRevision: true },
    });
    expect(f.estadoFacturacion).toBe('aceptado');
    expect(f.facturaRequiereRevision).toBe(true);
  });

  it('un estado fuera del catálogo cae a `no_enviado` en vez de viajar en crudo', () => {
    // La pantalla indexa un `Record` de etiquetas con este valor: uno inesperado pintaría
    // «undefined» en una celda del reporte de costos.
    expect(facturacionDeFila({ estadoFacturacion: 'lo_que_sea' }).estadoFacturacion)
      .toBe('no_enviado');
    expect(facturacionDeFila({}).estadoFacturacion).toBe('no_enviado');
  });

  it('un jsonb ilegible no tumba el reporte entero', () => {
    const f = facturacionDeFila({ estadoFacturacion: 'emitido', facturaDatos: '{no es json' });
    expect(f.facturaNumero).toBeNull();
    expect(f.facturaRequiereRevision).toBe(false);
  });
});
