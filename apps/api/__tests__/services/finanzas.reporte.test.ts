// HU #10966 — reporte de costos con valores reales (Feature #10941).
//
// El módulo `finanzas` no tenía NINGÚN test pese a ser el que alimenta la conciliación con
// contabilidad. Aquí se cubre lo que es puro; el SQL —que es casi todo el servicio— se verifica
// contra Postgres real, porque el helper `chain()` descarta los argumentos de `where()` y no
// distingue un CASE bien escrito de uno que devuelve siempre NULL.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { aCsv, agruparEmpresas } = await import('../../src/modules/finanzas/finanzas.service.js');

type Fila = Parameters<typeof aCsv>[0][number];

function fila(over: Partial<Fila> = {}): Fila {
  return {
    tramiteId: 't1', idFlit: 'FLIT-1', placa: 'ABC123', estado: 'Aprobado', empresa: 'ACME',
    tipoTramite: 'Traspaso', fechaAprobacion: '2026-07-14T15:30:00.000Z',
    soat: 450000, impuesto: 120000, derechoTramite: 80000,
    logistica: 15000, tramiteDigital: 200000, gmf: 3460, total: 868460,
    sellada: true, estadoLiquidacion: 'liquidado', noConfigurados: [],
    sinRecibo: [], pendientesPago: [], autogestionados: [],
    ...over,
  };
}

describe('aCsv — el archivo que abre contabilidad', () => {
  it('usa punto y coma y BOM, que es lo que Excel en español abre sin asistente', () => {
    const csv = aCsv([fila()]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.split('\r\n')[0]).toContain('Trámite;Placa');
  });

  it('distingue sellado, facturado y estimado', () => {
    const csv = aCsv([
      fila({ estadoLiquidacion: 'liquidado' }),
      fila({ estadoLiquidacion: 'facturado' }),
      fila({ sellada: false, estadoLiquidacion: null }),
    ]);
    const filas = csv.trim().split('\r\n').slice(1);
    expect(filas[0]).toContain('Liquidado');
    expect(filas[1]).toContain('Facturado');
    expect(filas[2]).toContain('Estimado');
  });

  it('la fecha de aprobación sale como día, que es lo que Excel reconoce', () => {
    // Con el instante completo Excel lo trata como texto y no deja ordenar ni filtrar por fecha.
    const csv = aCsv([fila()]);
    expect(csv.split('\r\n')[0]).toContain('Aprobado');
    expect(csv.split('\r\n')[1]).toContain('2026-07-14');
    expect(csv).not.toContain('T15:30:00');
  });

  it('un trámite sin aprobar deja la celda vacía', () => {
    const csv = aCsv([fila({ fechaAprobacion: null })]);
    expect(csv.split('\r\n')[1].split(';')[5]).toBe('');
  });

  it('un concepto no configurado sale vacío, no como cero', () => {
    // Un cero en el CSV se sumaría en la hoja de cálculo y cuadraría un total que no existe.
    const csv = aCsv([fila({ tramiteDigital: null, noConfigurados: ['Trámite digital'] })]);
    const celdas = csv.trim().split('\r\n')[1].split(';');
    expect(celdas).toContain('');
    expect(csv).toContain('Trámite digital');
    expect(celdas.filter((c) => c === '0')).toHaveLength(0);
  });

  it('escapa las comillas y entrecomilla lo que lleva el separador', () => {
    // Una empresa llamada «GÓMEZ; HIJOS» partiría la fila en dos columnas sin esto.
    const csv = aCsv([fila({ empresa: 'GÓMEZ; HIJOS', placa: 'A"B' })]);
    expect(csv).toContain('"GÓMEZ; HIJOS"');
    expect(csv).toContain('"A""B"');
  });

  it('lista los conceptos sin configurar en su propia columna', () => {
    const csv = aCsv([fila({ sellada: false, estadoLiquidacion: null, noConfigurados: ['Derecho de tránsito', 'Logística'] })]);
    expect(csv).toContain('Derecho de tránsito | Logística');
  });

  it('la columna de faltantes recoge los tres motivos, no solo las tarifas', () => {
    // A quien concilia le da igual si lo que falta es una tarifa, un recibo o un pago: lo que
    // necesita es la lista completa de lo que hay que resolver para poder liquidar.
    const csv = aCsv([fila({
      sellada: false, estadoLiquidacion: null,
      noConfigurados: ['Logística'], sinRecibo: ['Derecho de tránsito'], pendientesPago: ['SOAT'],
    })]);
    expect(csv.split('\r\n')[0]).toContain('Qué falta para liquidar');
    expect(csv).toContain('Logística | Derecho de tránsito | SOAT');
  });

  it('sin filas devuelve solo la cabecera', () => {
    expect(aCsv([]).trim().split('\r\n')).toHaveLength(1);
  });
});

describe('agruparEmpresas — el desplegable de empresas del filtro', () => {
  const MAESTRO = [
    { id: 1, nombre: 'RENTING S.A.S', documento: '811011779' },
    { id: 2, nombre: 'BANCOLOMBIA S.A.', documento: '890903938-8' },
  ];

  it('una empresa aparece UNA vez, aunque sus trámites traigan el NIT de dos maneras', () => {
    // El bicho: FLIT manda unas veces el NIT con dígito de verificación y otras sin él. El sync
    // solo empareja los exactos, así que la misma empresa salía dos veces en el desplegable: una
    // con su nombre y otra como un NIT crudo, y filtrar por una dejaba fuera la mitad de sus
    // trámites.
    const r = agruparEmpresas([
      { nit: '811011779', companiaId: 1 },
      { nit: '8110117795', companiaId: null },
    ], MAESTRO);

    expect(r).toHaveLength(1);
    expect(r[0].nombre).toBe('RENTING S.A.S');
    // Y elegirla filtra por sus dos escrituras, no solo por la que emparejó.
    expect(r[0].valor.split(',').sort()).toEqual(['811011779', '8110117795']);
  });

  it('empareja también cuando el dígito de verificación lo lleva el maestro', () => {
    const r = agruparEmpresas([{ nit: '890903938', companiaId: null }], MAESTRO);
    expect(r).toEqual([{ valor: '890903938', nombre: 'BANCOLOMBIA S.A.' }]);
  });

  it('el NIT con puntos y guion es el mismo NIT', () => {
    const r = agruparEmpresas([{ nit: '811.011.779', companiaId: null }], MAESTRO);
    expect(r).toEqual([{ valor: '811.011.779', nombre: 'RENTING S.A.S' }]);
  });

  it('no recorta un NIT de nueve dígitos: dos empresas distintas no pueden fundirse', () => {
    // Quitar el último dígito a un documento que ya es la raíz cruzaría empresas que solo se
    // parecen. Solo se prueba a quitarlo cuando hay diez o más.
    const r = agruparEmpresas([{ nit: '811011770', companiaId: null }], MAESTRO);
    expect(r).toHaveLength(1);
    expect(r[0].nombre).toContain('sin empresa registrada');
  });

  it('un NIT sin empresa dada de alta se rotula como tal, no como si fuera un nombre', () => {
    const r = agruparEmpresas([{ nit: '900077718', companiaId: null }], []);
    expect(r).toEqual([{ valor: '900077718', nombre: 'NIT 900077718 (sin empresa registrada)' }]);
  });

  it('manda el emparejamiento del sync sobre el del NIT', () => {
    // Si el sync ya dijo de quién es el trámite, esa es la empresa: el NIT normalizado es solo el
    // recurso para los que se quedaron sin emparejar.
    const r = agruparEmpresas([{ nit: '890903938', companiaId: 1 }], MAESTRO);
    expect(r[0].nombre).toBe('RENTING S.A.S');
  });

  it('sale ordenado por nombre, que es como se busca en una lista', () => {
    const r = agruparEmpresas([
      { nit: '811011779', companiaId: 1 },
      { nit: '890903938-8', companiaId: 2 },
    ], MAESTRO);
    expect(r.map((e) => e.nombre)).toEqual(['BANCOLOMBIA S.A.', 'RENTING S.A.S']);
  });
});
