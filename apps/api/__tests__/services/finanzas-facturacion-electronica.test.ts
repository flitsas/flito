// Reporte de costos — resumen del estado de facturación electrónica (HU #11336).
//
// Lo que aquí se puede probar de verdad es la COMPOSICIÓN de los contadores y la forma del SQL que
// se manda. Que el `CASE` clasifique bien cada combinación de los dos ejes se verificó contra
// PostgreSQL 16 real con las cinco combinaciones —aceptado, rechazado, emitido, fallido y un trámite
// sin factura—, porque es una garantía del motor y no de TypeScript.

import { describe, it, expect } from 'vitest';
import {
  SIIGO_ESTADOS_REPORTE, SIIGO_ESTADO_REPORTE_ETIQUETA, esEstadoReporte,
} from '@operaciones/shared-types';
import {
  EXPR_ESTADO_FACTURACION_COMPLETA, componerResumen, condicionEstadoFacturacion, resumenVacio,
} from '../../src/modules/finanzas/finanzas.facturacion-electronica.js';

describe('AC1 — los contadores dicen en qué punto está todo', () => {
  it('parte de todos los estados a cero: ninguno desaparece', () => {
    const r = resumenVacio();

    // Un contador que desaparece se lee como «no aplica», que no es lo mismo que «ninguno». En una
    // pantalla de control esa diferencia decide si alguien va a mirar o no.
    for (const e of SIIGO_ESTADOS_REPORTE) expect(r[e]).toBe(0);
    expect(r.total).toBe(0);
  });

  it('la suma de los grupos cuadra con el total', () => {
    const r = componerResumen([
      { estado: 'no_enviado', cuantos: 12 },
      { estado: 'emitido', cuantos: 5 },
      { estado: 'aceptado', cuantos: 30 },
      { estado: 'rechazado', cuantos: 2 },
      { estado: 'fallido', cuantos: 1 },
    ]);

    const suma = SIIGO_ESTADOS_REPORTE.reduce((acc, e) => acc + r[e], 0);
    expect(suma).toBe(50);
    expect(r.total).toBe(50);
  });

  it('un estado que no está en el catálogo suma al total en vez de esconderse', () => {
    const r = componerResumen([
      { estado: 'aceptado', cuantos: 3 },
      { estado: 'un_estado_que_nadie_previo', cuantos: 2 },
    ]);

    // Descartarlo en silencio produciría un cuadre falso: los grupos sumarían 3 y el reporte tendría
    // 5 trámites. Que la incoherencia se vea es el punto.
    expect(r.aceptado).toBe(3);
    expect(r.total).toBe(5);
    expect(SIIGO_ESTADOS_REPORTE.reduce((acc, e) => acc + r[e], 0)).toBe(3);
  });

  it('valores no numéricos no rompen el cuadre', () => {
    const r = componerResumen([{ estado: 'aceptado', cuantos: NaN as unknown as number }]);
    expect(r.aceptado).toBe(0);
    expect(r.total).toBe(0);
  });
});

describe('AC4 — un trámite sin factura no se cuenta como fallido', () => {
  it('«sin enviar» y «falló» son estados distintos del catálogo', () => {
    expect(SIIGO_ESTADOS_REPORTE).toContain('no_enviado');
    expect(SIIGO_ESTADOS_REPORTE).toContain('fallido');
    // Y se llaman distinto en la pantalla: quien lee no debe tener que deducirlo.
    expect(SIIGO_ESTADO_REPORTE_ETIQUETA.no_enviado).not.toBe(SIIGO_ESTADO_REPORTE_ETIQUETA.fallido);
  });

  it('la expresión envuelve la subconsulta en COALESCE a «no_enviado»', async () => {
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const { sql: texto } = new PgDialect().sqlToQuery(EXPR_ESTADO_FACTURACION_COMPLETA);

    // Sin el COALESCE, un trámite al que nunca se le pidió factura devolvería NULL —un SELECT sin
    // filas no ejecuta su CASE—, no encajaría en ningún grupo y la suma dejaría de cuadrar con el
    // total, que es justo lo que el AC1 exige.
    expect(texto).toContain('COALESCE');
    expect(texto).toContain("'no_enviado'");
  });
});

describe('El estado se deriva de DOS ejes, y el orden de las ramas importa', () => {
  it('un fallo de emisión manda sobre lo que diga la DIAN', async () => {
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const { sql: texto } = new PgDialect().sqlToQuery(EXPR_ESTADO_FACTURACION_COMPLETA);

    // Si no salió, la DIAN no tiene nada que decir. La rama de `fallida` va antes que las de la
    // DIAN a propósito, y este test lo fija por si alguien reordena el CASE.
    const posFallida = texto.indexOf("'fallido'");
    const posAceptado = texto.indexOf("'aceptado'");
    expect(posFallida).toBeGreaterThan(-1);
    expect(posFallida).toBeLessThan(posAceptado);
  });

  it('solo mira los enlaces activos: una factura descartada no describe el trámite de hoy', async () => {
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const { sql: texto } = new PgDialect().sqlToQuery(EXPR_ESTADO_FACTURACION_COMPLETA);
    expect(texto).toContain('sft.activo');
  });

  it('con varios intentos manda el último', async () => {
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const { sql: texto } = new PgDialect().sqlToQuery(EXPR_ESTADO_FACTURACION_COMPLETA);

    // Un trámite puede tener un intento fallido y una emisión posterior. `activo` primero para que
    // la emisión con éxito gane al intento fallido anterior; la fecha desempata dentro de cada
    // grupo, porque lo que alguien quiere saber cuando pregunta «¿ya salió?» es lo último que pasó.
    expect(texto).toContain('ORDER BY sft.activo DESC, sf.created_at DESC');
    expect(texto).toContain('LIMIT 1');
  });

  it('es una subconsulta correlacionada, NO un join que multiplique filas', async () => {
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const { sql: texto } = new PgDialect().sqlToQuery(EXPR_ESTADO_FACTURACION_COMPLETA);

    // El reporte ya arrastra ocho joins y cuadra sus totales con un `count(distinct)`. Añadir dos
    // joins más multiplicaría filas y el total dejaría de cuadrar sin que nada avisara.
    expect(texto.trim().startsWith('COALESCE((')).toBe(true);
    expect(texto).toContain('WHERE sft.tramite_id =');
  });
});

describe('Corrección de la auditoría — la rama `fallido` tiene que ser alcanzable', () => {
  it('la condición deja pasar las fallidas explícitamente', async () => {
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const { sql: texto } = new PgDialect().sqlToQuery(EXPR_ESTADO_FACTURACION_COMPLETA);

    // El disparador de la 0135 define `activo = (estado <> 'fallida')`: es el espejo exacto de «su
    // factura no falló». Filtrar SOLO por `activo` eliminaba justo las filas que la rama `fallido`
    // clasifica, así que el contador habría marcado cero para siempre y toda emisión fallida se
    // habría contado como `no_enviado` — lo que el AC4 prohíbe. Verificado contra PostgreSQL 16:
    // con el filtro viejo ese trámite devolvía `no_enviado`; con este, `fallido`.
    expect(texto).toContain("sft.activo OR sf.estado = 'fallida'");
    expect(texto).not.toMatch(/AND sft\.activo\s*\n?\s*ORDER/);
  });

  it('no queda ninguna rama muerta que aparente cubrir algo', async () => {
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const { sql: texto } = new PgDialect().sqlToQuery(EXPR_ESTADO_FACTURACION_COMPLETA);

    // `factura_id` es NOT NULL, así que dentro de la subconsulta siempre hay factura. Una rama
    // `WHEN sf.id IS NULL` aparentaba cubrir el caso del trámite sin factura, que en realidad lo
    // resuelve el COALESCE. Una rama muerta que parece cubrir algo es peor que no tenerla.
    expect(texto).not.toContain('sf.id IS NULL');
    expect(texto).toContain('JOIN siigo_facturas sf');
  });

  it('una factura anulada no se muestra como emitida', async () => {
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const { sql: texto } = new PgDialect().sqlToQuery(EXPR_ESTADO_FACTURACION_COMPLETA);

    // Contabilidad usa este reporte para cuadrar. Enseñar una anulada como «Emitida» es una
    // afirmación falsa en una pantalla de control.
    expect(texto).toContain("dian.estado = 'anulada'");
    expect(texto).toContain("'anulado'");
  });
});

describe('AC2 — el filtro usa la MISMA expresión que los contadores', () => {
  it('la condición compara la expresión completa con el estado pedido', async () => {
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const { sql: texto, params } = new PgDialect().sqlToQuery(condicionEstadoFacturacion('rechazado'));

    // Dos definiciones de «en qué punto está esta factura» acabarían discrepando, y el filtro y los
    // números dirían cosas distintas de la misma fila: un bicho que no falla, solo miente.
    expect(texto).toContain('COALESCE');
    expect(texto).toContain('sft.activo');
    // El estado viaja parametrizado, no concatenado.
    expect(params).toEqual(['rechazado']);
  });

  it('el catálogo de estados admitidos es cerrado', () => {
    expect(esEstadoReporte('aceptado')).toBe(true);
    expect(esEstadoReporte('lo_que_sea')).toBe(false);
    expect(esEstadoReporte(null)).toBe(false);
    // Cada estado tiene su etiqueta: añadir uno sin nombrarlo rompe el tipo, no la pantalla.
    for (const e of SIIGO_ESTADOS_REPORTE) {
      expect(SIIGO_ESTADO_REPORTE_ETIQUETA[e]).toBeTruthy();
    }
  });
});
