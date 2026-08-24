// FLITO Conciliación — el CRUCE por número de póliza (HU #11676, AC1-AC6).
//
// Lo que se afirma aquí es el corazón de la HU: que cada fila del Excel acaba en UNO de los siete
// desenlaces, que cada uno llega con los campos que permiten explicarlo, y —lo que más importa— que
// dos casos concretos NO se resuelven en silencio:
//
//   · una póliza que aparece en DOS SOAT no elige uno (el índice de póliza es NO ÚNICO: un `LIMIT 1`
//     cruzaría contra el equivocado y descontaría de la bolsa el valor de otro vehículo);
//   · un peso de diferencia es `valor_distinto` y bloquea la boleta entera (AC3, sin tolerancia).
//
// El mock de drizzle devuelve en el INSERT de líneas **lo que el servicio acaba de escribir** (ver
// `ecoDeLineas`): sin eso, el test estaría afirmando sobre un fixture propio en vez de sobre lo que
// el cruce decidió, que sería una tautología con forma de test.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';
import { readFileSync } from 'node:fs';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import type { PgTable } from 'drizzle-orm/pg-core';
import { ResultadoCruce } from '@operaciones/shared-types';
import { flitoConciliacionLineas } from '../../src/db/schema.js';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';

const kdb = createKeyedDb();
const espia = crearEspia(kdb);

vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const COMPANIA = 3;
const OTRA_COMPANIA = 9;
const BOLETA_ID = 'b0000000-0000-4000-8000-000000000001';
const AHORA = new Date('2026-08-20T15:00:00Z');
const CTX = { userId: 9, nombre: 'financiera@flit.io' };

const S = (n: number) => `50a70000-0000-4000-8000-00000000000${n}`;

/** Cabecera del reporte del portal, reducida a lo que el parser mira. */
const ENCABEZADOS = ['Número de Póliza', 'Nombre', 'Total a Pagar'];

async function xlsx(filas: { poliza: string; total: number }[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Export');
  ws.addRow(ENCABEZADOS);
  // La columna «Nombre» se llena a propósito: el parser tiene que ignorarla (AC11).
  for (const f of filas) ws.addRow([f.poliza, 'PEREZ PEREZ, JUAN CARLOS', f.total]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Fila de `flito_soat` tal como la devuelve la proyección del cruce. */
function soat(over: Partial<Record<string, unknown>> & { id: string; numeroPoliza: string }) {
  return {
    estado: 'pagado',
    valorPagado: '740800.00',
    companiaId: COMPANIA,
    companiaNombre: 'ACME S.A.S.',
    placa: 'ABC123',
    ...over,
  };
}

/**
 * Devuelve en el `returning()` del INSERT las líneas que el servicio acaba de mandar, con un id.
 *
 * Es lo que convierte este test en una comprobación del CRUCE y no del fixture: `resultado`,
 * `detalle` y `soat_id` de la respuesta son los que el servicio escribió.
 */
function ecoDeLineas(): unknown[] {
  const datos = espia.ultimoInsertEn('flito_conciliacion_lineas') as unknown as Record<string, unknown>[];
  return (datos ?? []).map((l, i) => ({
    id: `11110000-0000-4000-8000-00000000000${i}`,
    filaNumero: l.filaNumero,
    numeroPolizaNorm: l.numeroPolizaNorm,
    valorDeclarado: l.valorDeclarado,
    soatId: l.soatId,
    resultado: l.resultado,
    detalle: l.detalle,
    conciliadaEn: null,
  }));
}

function filaBoleta(over: Record<string, unknown> = {}) {
  return {
    id: BOLETA_ID,
    referencia: 'BOL-000123',
    companiaId: COMPANIA,
    concepto: 'soat',
    estado: 'cargada',
    archivoNombre: 'REPORTE SOAT.xlsx',
    filas: 1,
    totalDeclarado: '740800.00',
    totalCruzado: null,
    fechaPago: '2026-08-13',
    cargadaPorNombre: 'financiera@flit.io',
    conciliadaEn: null,
    conciliadaPorNombre: null,
    createdAt: AHORA,
    ...over,
  };
}

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  kdb.when
    .select('clients', [{ id: COMPANIA, name: 'ACME S.A.S.' }])
    .select('flito_conciliacion_boletas', [])
    .select('flito_conciliacion_lineas', [])
    .select('flito_bolsa_movimientos', [])
    .insert('flito_conciliacion_boletas', [filaBoleta()])
    .insert('flito_conciliacion_lineas', ecoDeLineas)
    .update('flito_conciliacion_boletas', []);
});

async function cargar(filas: { poliza: string; total: number }[]) {
  const { cargarBoleta } = await import('../../src/modules/flito-conciliacion/flito-conciliacion.service.js');
  return await cargarBoleta(
    { nombre: 'REPORTE SOAT.xlsx', buffer: await xlsx(filas) },
    { companiaId: COMPANIA, fechaPago: '2026-08-13', maxFilas: 500 },
    CTX,
  );
}

describe('flito-conciliacion · AC1 y AC2 · los SIETE desenlaces, cada uno con lo que lo explica', () => {
  it('reparte las siete filas y cada una llega con sus campos estructurados', async () => {
    kdb.when
      .select('flito_soat', [
        soat({ id: S(1), numeroPoliza: 'P1' }),
        soat({ id: S(3), numeroPoliza: 'P3', estado: 'solicitado', valorPagado: null }),
        soat({ id: S(4), numeroPoliza: 'P4', valorPagado: '700000.00' }),
        soat({ id: S(5), numeroPoliza: 'P5', companiaId: OTRA_COMPANIA, companiaNombre: 'OTRO CLIENTE S.A.S.' }),
        soat({ id: S(6), numeroPoliza: 'P6', placa: 'AAA111' }),
        soat({ id: S(7), numeroPoliza: 'P6', placa: 'BBB222' }),
        soat({ id: S(8), numeroPoliza: 'P7' }),
      ])
      // El SOAT S8 ya se concilió en otra boleta.
      .select('flito_conciliacion_lineas', [
        { soatId: S(8), referencia: 'BOL-000009', fechaPago: '2026-07-30' },
      ])
      // Y del S1 la liquidación ya reservó la salida de bolsa — de ESTA compañía.
      .select('flito_bolsa_movimientos', [{
        llave: `salida:soat:${S(1)}`, origen: 'automatico', companiaId: COMPANIA,
      }])
      .insert('flito_conciliacion_boletas', [filaBoleta({ filas: 7 })]);

    const boleta = await cargar([
      { poliza: 'P1', total: 740800 },
      { poliza: 'P2', total: 740800 },
      { poliza: 'P3', total: 740800 },
      { poliza: 'P4', total: 740800 },
      { poliza: 'P5', total: 740800 },
      { poliza: 'P6', total: 740800 },
      { poliza: 'P7', total: 740800 },
    ]);

    expect(boleta.lineas.map((l) => l.resultado)).toEqual([
      'ok', 'no_encontrada', 'no_pagado', 'valor_distinto', 'otra_compania', 'poliza_duplicada',
      'ya_conciliada',
    ]);
    // AC1: el conteo trae LAS SIETE claves, y el total de filas.
    expect(boleta.conteo).toEqual({
      ok: 1, no_encontrada: 1, no_pagado: 1, valor_distinto: 1, poliza_duplicada: 1,
      otra_compania: 1, ya_conciliada: 1, cobrado_otro_cliente: 0,
    });
    expect(boleta.filas).toBe(7);
    expect(boleta.sinCuadrar).toBe(6);

    const [ok, noEncontrada, noPagado, valorDistinto, otraCompania, duplicada, yaConciliada] = boleta.lineas;

    // ok — con el aviso de que el sellado ya lo descontó (no bloquea, pero evita anunciar un
    // descuento que no va a ocurrir).
    expect(ok).toMatchObject({ soatId: S(1), placa: 'ABC123', valorSoat: 740800, detalle: null });
    expect(ok.yaDescontadoEnLiquidacion).toBe(true);

    // no_encontrada — no hay SOAT, así que no hay ni placa ni valor que enseñar. Nunca 0.
    expect(noEncontrada).toMatchObject({ soatId: null, placa: null, valorSoat: null, candidatos: null });

    // no_pagado — el estado de HOY, que es lo que la pantalla mete en el motivo.
    expect(noPagado).toMatchObject({ soatId: S(3), soatEstado: 'solicitado' });

    // valor_distinto — LOS DOS importes. La resta la hace la pantalla.
    expect(valorDistinto).toMatchObject({ valorDeclarado: 740800, valorSoat: 700000 });

    // otra_compania — el nombre del otro cliente, para poder nombrarlo.
    expect(otraCompania).toMatchObject({ soatId: S(5), companiaSoatNombre: 'OTRO CLIENTE S.A.S.' });

    // poliza_duplicada — CUÁNTOS son, y ningún SOAT elegido.
    expect(duplicada).toMatchObject({ candidatos: 2, soatId: null, placa: null, valorSoat: null });

    // ya_conciliada — en qué boleta y de cuándo.
    expect(yaConciliada).toMatchObject({
      soatId: S(8), boletaAnteriorRef: 'BOL-000009', boletaAnteriorFecha: '2026-07-30',
    });

    // AC2/arrastre 3: el DTO NO trae la frase redactada. `detalle` es el respaldo persistido y no
    // lleva ni la póliza ni la placa en claro.
    for (const linea of boleta.lineas) {
      if (linea.detalle === null) continue;
      expect(linea.detalle).not.toContain(linea.numeroPolizaNorm);
      expect(linea.detalle).not.toContain('ABC123');
    }
  });

  it('AC11 · el nombre de la columna «Nombre» no llega ni a la base ni a la respuesta', async () => {
    kdb.when.select('flito_soat', [soat({ id: S(1), numeroPoliza: 'P1' })]);
    const boleta = await cargar([{ poliza: 'P1', total: 740800 }]);

    const escrito = JSON.stringify(espia.inserts);
    expect(escrito).not.toContain('PEREZ');
    expect(JSON.stringify(boleta)).not.toContain('PEREZ');
    // Y las columnas que SÍ se escriben son exactamente las siete del contrato.
    const lineas = espia.ultimoInsertEn('flito_conciliacion_lineas') as unknown as Record<string, unknown>[];
    expect(Object.keys(lineas[0]).sort()).toEqual([
      'boletaId', 'detalle', 'filaNumero', 'numeroPolizaNorm', 'resultado', 'soatId', 'valorDeclarado',
    ]);
  });
});

describe('flito-conciliacion · AC3 · la comparación de valor es estricta', () => {
  it('UN PESO de diferencia es valor_distinto y bloquea la boleta', async () => {
    kdb.when.select('flito_soat', [soat({ id: S(1), numeroPoliza: 'P1', valorPagado: '740800.00' })]);
    const boleta = await cargar([{ poliza: 'P1', total: 740801 }]);
    expect(boleta.lineas[0].resultado).toBe('valor_distinto');
    expect(boleta.sinCuadrar).toBe(1);
  });

  it('los céntimos se comparan en enteros, no en flotantes', async () => {
    kdb.when.select('flito_soat', [soat({ id: S(1), numeroPoliza: 'P1', valorPagado: '740800.10' })]);
    const iguales = await cargar([{ poliza: 'P1', total: 740800.1 }]);
    expect(iguales.lineas[0].resultado).toBe('ok');

    kdb.reset(); espia.reiniciar();
    kdb.when
      .select('clients', [{ id: COMPANIA, name: 'ACME S.A.S.' }])
      .select('flito_conciliacion_boletas', [])
      .select('flito_conciliacion_lineas', [])
      .select('flito_bolsa_movimientos', [])
      .select('flito_soat', [soat({ id: S(1), numeroPoliza: 'P1', valorPagado: '740800.10' })])
      .insert('flito_conciliacion_boletas', [filaBoleta()])
      .insert('flito_conciliacion_lineas', ecoDeLineas)
      .update('flito_conciliacion_boletas', []);
    const distintos = await cargar([{ poliza: 'P1', total: 740800.11 }]);
    expect(distintos.lineas[0].resultado).toBe('valor_distinto');
  });

  it('un SOAT pagado SIN valor registrado no cuadra: no hay contra qué comparar', async () => {
    kdb.when.select('flito_soat', [soat({ id: S(1), numeroPoliza: 'P1', valorPagado: null })]);
    const boleta = await cargar([{ poliza: 'P1', total: 740800 }]);
    expect(boleta.lineas[0].resultado).toBe('valor_distinto');
    expect(boleta.lineas[0].valorSoat).toBeNull();
  });
});

describe('flito-conciliacion · AC4 · la compañía de referencia es la de la boleta', () => {
  it('toda fila de otro cliente sale otra_compania, aunque TODAS lo sean', async () => {
    // El caso importa: si la compañía se dedujera del primer SOAT que cruza, un Excel entero de
    // otro cliente cuadraría contra sí mismo y descontaría de la bolsa equivocada.
    kdb.when
      .select('flito_soat', [
        soat({ id: S(1), numeroPoliza: 'P1', companiaId: OTRA_COMPANIA, companiaNombre: 'OTRO CLIENTE S.A.S.' }),
        soat({ id: S(2), numeroPoliza: 'P2', companiaId: OTRA_COMPANIA, companiaNombre: 'OTRO CLIENTE S.A.S.' }),
      ])
      .insert('flito_conciliacion_boletas', [filaBoleta({ filas: 2 })]);

    const boleta = await cargar([{ poliza: 'P1', total: 740800 }, { poliza: 'P2', total: 740800 }]);
    expect(boleta.lineas.map((l) => l.resultado)).toEqual(['otra_compania', 'otra_compania']);
    expect(boleta.sinCuadrar).toBe(2);
  });

  it('la compañía manda por encima del estado: un SOAT ajeno y sin pagar es otra_compania', async () => {
    kdb.when.select('flito_soat', [
      soat({ id: S(1), numeroPoliza: 'P1', companiaId: OTRA_COMPANIA, estado: 'solicitado' }),
    ]);
    const boleta = await cargar([{ poliza: 'P1', total: 740800 }]);
    expect(boleta.lineas[0].resultado).toBe('otra_compania');
  });
});

describe('flito-conciliacion · el índice de póliza NO es único, y el cruce lo respeta', () => {
  it('con dos SOAT candidatos no se elige ninguno, ni siquiera si uno cuadraría al peso', async () => {
    kdb.when.select('flito_soat', [
      soat({ id: S(1), numeroPoliza: 'P1', valorPagado: '740800.00', placa: 'AAA111' }),
      soat({ id: S(2), numeroPoliza: 'P1', valorPagado: '999999.00', placa: 'BBB222' }),
    ]);
    const boleta = await cargar([{ poliza: 'P1', total: 740800 }]);

    expect(boleta.lineas[0].resultado).toBe('poliza_duplicada');
    expect(boleta.lineas[0].candidatos).toBe(2);
    // Lo que de verdad protege el dinero: no queda ningún SOAT apuntado en la línea.
    const lineas = espia.ultimoInsertEn('flito_conciliacion_lineas') as unknown as Record<string, unknown>[];
    expect(lineas[0].soatId).toBeNull();
  });

  it('con un solo candidato NO se informa «1 candidato»: eso sería ruido en las 499 buenas', async () => {
    kdb.when.select('flito_soat', [soat({ id: S(1), numeroPoliza: 'P1' })]);
    const boleta = await cargar([{ poliza: 'P1', total: 740800 }]);
    expect(boleta.lineas[0].candidatos).toBeNull();
  });
});

describe('flito-conciliacion · la carga y sus rechazos (AC7)', () => {
  it('no crea NADA si el Excel no se puede leer: ni boleta ni líneas', async () => {
    const { cargarBoleta } = await import('../../src/modules/flito-conciliacion/flito-conciliacion.service.js');
    await expect(cargarBoleta(
      { nombre: 'malo.xlsx', buffer: Buffer.from('no soy un xlsx') },
      { companiaId: COMPANIA, fechaPago: '2026-08-13', maxFilas: 500 },
      CTX,
    )).rejects.toMatchObject({ codigo: 'archivo_invalido' });
    expect(espia.inserts).toHaveLength(0);
  });

  it('rechaza la fecha de pago futura antes de tocar el archivo', async () => {
    const { cargarBoleta } = await import('../../src/modules/flito-conciliacion/flito-conciliacion.service.js');
    await expect(cargarBoleta(
      { nombre: 'b.xlsx', buffer: await xlsx([{ poliza: 'P1', total: 1 }]) },
      { companiaId: COMPANIA, fechaPago: '2099-01-01', maxFilas: 500 },
      CTX,
    )).rejects.toMatchObject({ estado: 400, codigo: 'fecha_invalida' });
    expect(espia.inserts).toHaveLength(0);
  });

  it('404 si el cliente elegido ya no existe', async () => {
    kdb.when.select('clients', []);
    const { cargarBoleta } = await import('../../src/modules/flito-conciliacion/flito-conciliacion.service.js');
    await expect(cargarBoleta(
      { nombre: 'b.xlsx', buffer: await xlsx([{ poliza: 'P1', total: 1 }]) },
      { companiaId: 777, fechaPago: '2026-08-13', maxFilas: 500 },
      CTX,
    )).rejects.toMatchObject({ estado: 404, codigo: 'compania_no_existe' });
  });

  it('409 con el id y la referencia de la boleta que ya tiene ese archivo', async () => {
    kdb.when.select('flito_conciliacion_boletas', [{ id: BOLETA_ID, referencia: 'BOL-000123' }]);
    const { cargarBoleta } = await import('../../src/modules/flito-conciliacion/flito-conciliacion.service.js');
    await expect(cargarBoleta(
      { nombre: 'b.xlsx', buffer: await xlsx([{ poliza: 'P1', total: 1 }]) },
      { companiaId: COMPANIA, fechaPago: '2026-08-13', maxFilas: 500 },
      CTX,
    )).rejects.toMatchObject({
      estado: 409, codigo: 'boleta_duplicada',
      extra: { boletaId: BOLETA_ID, referencia: 'BOL-000123' },
    });
  });

  it('el hash SOLO choca con boletas vivas: la descartada no reserva su archivo (AC6)', async () => {
    kdb.when.select('flito_soat', []);
    await cargar([{ poliza: 'P1', total: 740800 }]);
    // El filtro del duplicado lleva el estado 'descartada' enlazado, que es lo que hace que el
    // índice PARCIAL y la consulta digan lo mismo. Sin él, descartar no liberaría nada.
    expect(espia.filtrosUsados()).toContain('descartada');
  });

  it('la fecha del PAGO se guarda tal cual, no la de hoy', async () => {
    kdb.when.select('flito_soat', []);
    await cargar([{ poliza: 'P1', total: 740800 }]);
    expect(espia.ultimoInsertEn('flito_conciliacion_boletas')).toMatchObject({
      fechaPago: '2026-08-13', filas: 1, totalDeclarado: '740800.00',
    });
    // El estado no se escribe a mano: lo pone el DEFAULT 'cargada' de la columna.
    expect(Object.keys(espia.ultimoInsertEn('flito_conciliacion_boletas'))).not.toContain('estado');
  });

  it('total declarado y total cruzado se guardan por separado: son las dos verdades a comparar', async () => {
    kdb.when.select('flito_soat', [soat({ id: S(1), numeroPoliza: 'P1', valorPagado: '700000.00' })]);
    const boleta = await cargar([{ poliza: 'P1', total: 740800 }]);
    expect(boleta.totalDeclarado).toBe(740800);
    expect(boleta.totalCruzado).toBe(700000);
    expect(espia.updatesEn('flito_conciliacion_boletas')[0].datos).toMatchObject({
      totalCruzado: '700000.00',
    });
  });
});

describe('flito-conciliacion · AC5 · volver a cruzar', () => {
  const lineaGuardada = (over: Record<string, unknown> = {}) => ({
    id: '11110000-0000-4000-8000-000000000000',
    filaNumero: 1,
    numeroPolizaNorm: 'P1',
    valorDeclarado: '740800.00',
    soatId: null,
    resultado: 'no_pagado',
    detalle: 'El SOAT existe pero está en «solicitado», no en «pagado».',
    conciliadaEn: null,
    ...over,
  });

  it('reevalúa contra el estado de HOY y reescribe solo las líneas que cambiaron', async () => {
    kdb.when
      .select('flito_conciliacion_boletas', [filaBoleta()])
      // `selectOnce` y no `select`: la PRIMERA lectura de líneas es la de esta boleta y la segunda
      // es la de conciliaciones previas de otras boletas, que aquí no hay ninguna.
      .selectOnce('flito_conciliacion_lineas', [lineaGuardada({ soatId: S(1) })])
      .select('flito_conciliacion_lineas', [])
      // El gestor ya pagó el SOAT desde que se cargó la boleta.
      .select('flito_soat', [soat({ id: S(1), numeroPoliza: 'P1' })])
      .select('flito_bolsa_movimientos', [])
      .update('flito_conciliacion_lineas', [])
      .update('flito_conciliacion_boletas', []);

    const { recruzarBoleta } = await import('../../src/modules/flito-conciliacion/flito-conciliacion.service.js');
    const { detalle, cambiadas } = await recruzarBoleta(BOLETA_ID);

    expect(detalle.lineas[0].resultado).toBe('ok');
    expect(detalle.sinCuadrar).toBe(0);
    expect(cambiadas).toBe(1);
    expect(espia.updatesEn('flito_conciliacion_lineas')[0].datos).toMatchObject({
      resultado: 'ok', detalle: null, soatId: S(1),
    });
  });

  it('no toca el archivo ni el hash: solo resultado, detalle y soat_id', async () => {
    kdb.when
      .select('flito_conciliacion_boletas', [filaBoleta()])
      .selectOnce('flito_conciliacion_lineas', [lineaGuardada({ soatId: S(1) })])
      .select('flito_conciliacion_lineas', [])
      .select('flito_soat', [soat({ id: S(1), numeroPoliza: 'P1' })])
      .select('flito_bolsa_movimientos', [])
      .update('flito_conciliacion_lineas', [])
      .update('flito_conciliacion_boletas', []);

    const { recruzarBoleta } = await import('../../src/modules/flito-conciliacion/flito-conciliacion.service.js');
    await recruzarBoleta(BOLETA_ID);

    for (const u of espia.updates) {
      expect(Object.keys(u.datos)).not.toContain('archivoHash');
      expect(Object.keys(u.datos)).not.toContain('archivoNombre');
      expect(Object.keys(u.datos)).not.toContain('estado');
    }
  });

  it('no cambia nada —ni un UPDATE— si el estado del mundo sigue igual', async () => {
    kdb.when
      .select('flito_conciliacion_boletas', [filaBoleta()])
      .selectOnce('flito_conciliacion_lineas', [lineaGuardada({ soatId: S(1) })])
      .select('flito_conciliacion_lineas', [])
      .select('flito_soat', [soat({ id: S(1), numeroPoliza: 'P1', estado: 'solicitado', valorPagado: null })])
      .select('flito_bolsa_movimientos', [])
      .update('flito_conciliacion_boletas', []);

    const { recruzarBoleta } = await import('../../src/modules/flito-conciliacion/flito-conciliacion.service.js');
    const { cambiadas } = await recruzarBoleta(BOLETA_ID);
    expect(cambiadas).toBe(0);
    expect(espia.updatesEn('flito_conciliacion_lineas')).toHaveLength(0);
  });

  it('409 si la boleta ya está conciliada, y 409 distinto si está descartada', async () => {
    const { recruzarBoleta } = await import('../../src/modules/flito-conciliacion/flito-conciliacion.service.js');

    kdb.when.select('flito_conciliacion_boletas', [filaBoleta({ estado: 'conciliada', conciliadaEn: AHORA })]);
    await expect(recruzarBoleta(BOLETA_ID))
      .rejects.toMatchObject({ estado: 409, codigo: 'boleta_ya_conciliada' });

    kdb.when.select('flito_conciliacion_boletas', [filaBoleta({ estado: 'descartada' })]);
    await expect(recruzarBoleta(BOLETA_ID))
      .rejects.toMatchObject({ estado: 409, codigo: 'boleta_descartada' });

    expect(espia.updates).toHaveLength(0);
  });

  it('404 si la boleta no existe', async () => {
    kdb.when.select('flito_conciliacion_boletas', []);
    const { recruzarBoleta } = await import('../../src/modules/flito-conciliacion/flito-conciliacion.service.js');
    await expect(recruzarBoleta(BOLETA_ID))
      .rejects.toMatchObject({ estado: 404, codigo: 'boleta_no_existe' });
  });
});

describe('Bug #11773 · cobrado_otro_cliente — la llave en OTRA compañía no se adopta', () => {
  it('ROJO-antes / VERDE-después: cruce deja de devolver ok y no marca yaDescontadoEnLiquidacion', async () => {
    // Antes del fix, este mismo fixture devolvía `ok` + `yaDescontadoEnLiquidacion: true` porque el
    // cruce no miraba `companiaId` del asiento. Después: bloquea, nombra al dueño del asiento y el
    // detalle no lleva placa ni póliza.
    kdb.when
      .select('flito_soat', [soat({ id: S(1), numeroPoliza: 'P1' })])
      .select('flito_bolsa_movimientos', [{
        llave: `salida:soat:${S(1)}`,
        origen: 'automatico',
        companiaId: OTRA_COMPANIA,
        companiaNombre: 'OTRO CLIENTE S.A.S.',
      }]);

    const boleta = await cargar([{ poliza: 'P1', total: 740800 }]);
    expect(boleta.lineas[0].resultado).toBe('cobrado_otro_cliente');
    expect(boleta.lineas[0].companiaCobroNombre).toBe('OTRO CLIENTE S.A.S.');
    expect(boleta.lineas[0].yaDescontadoEnLiquidacion).toBe(false);
    expect(boleta.sinCuadrar).toBe(1);
    expect(boleta.conteo.cobrado_otro_cliente).toBe(1);
    expect(boleta.conteo.ok).toBe(0);
    expect(boleta.lineas[0].detalle).toBe('Este SOAT ya se descontó de la bolsa de otro cliente.');
    expect(boleta.lineas[0].detalle).not.toContain('P1');
    expect(boleta.lineas[0].detalle).not.toContain('ABC123');
  });

  it('cualquier origen, no solo automatico: un asiento de conciliación ajeno también bloquea', async () => {
    kdb.when
      .select('flito_soat', [soat({ id: S(1), numeroPoliza: 'P1' })])
      .select('flito_bolsa_movimientos', [{
        llave: `salida:soat:${S(1)}`,
        origen: 'conciliacion',
        companiaId: OTRA_COMPANIA,
        companiaNombre: 'OTRO CLIENTE S.A.S.',
      }]);

    const boleta = await cargar([{ poliza: 'P1', total: 740800 }]);
    expect(boleta.lineas[0].resultado).toBe('cobrado_otro_cliente');
    expect(boleta.lineas[0].yaDescontadoEnLiquidacion).toBe(false);
  });

  it('el automatico de ESTA compañía sigue en ok con yaDescontadoEnLiquidacion', async () => {
    kdb.when
      .select('flito_soat', [soat({ id: S(1), numeroPoliza: 'P1' })])
      .select('flito_bolsa_movimientos', [{
        llave: `salida:soat:${S(1)}`, origen: 'automatico', companiaId: COMPANIA,
      }]);

    const boleta = await cargar([{ poliza: 'P1', total: 740800 }]);
    expect(boleta.lineas[0].resultado).toBe('ok');
    expect(boleta.lineas[0].yaDescontadoEnLiquidacion).toBe(true);
    expect(boleta.lineas[0].companiaCobroNombre).toBeNull();
  });
});

describe('Bug #11773 · paridad CHECK 0162 ↔ ResultadoCruce ↔ schema.ts', () => {
  it('los tres vocabularios enumeran exactamente los mismos valores, incluido cobrado_otro_cliente', () => {
    const sql0162 = readFileSync(
      new URL('../../src/db/migrations/0162_flito_concil_resultado_cobrado_otro_cliente.sql', import.meta.url),
      'utf8',
    );
    const lista = sql0162.match(
      /ADD CONSTRAINT flito_concil_linea_resultado_chk CHECK \(resultado IN\s*\(([^)]+)\)/,
    );
    expect(lista, 'no se encontró el CHECK ensanchado en 0162').toBeTruthy();
    const delSql = new Set([...(lista![1].matchAll(/'([a-z_]+)'/g) ?? [])].map((m) => m[1]));
    const dialecto = new PgDialect();
    const chk = getTableConfig(flitoConciliacionLineas as PgTable).checks
      .find((c) => c.name === 'flito_concil_linea_resultado_chk');
    expect(chk, 'schema.ts no declara flito_concil_linea_resultado_chk').toBeDefined();
    const delSchema = new Set(
      [...dialecto.sqlToQuery(chk!.value).sql.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]),
    );
    const delTipo = new Set(Object.values(ResultadoCruce));

    expect(delTipo.has('cobrado_otro_cliente')).toBe(true);
    expect('cobrado_otro_cliente'.length).toBeLessThanOrEqual(20);
    expect(delSql).toEqual(delTipo);
    expect(delSchema).toEqual(delTipo);
  });

  it('NO se iguala ResultadoCruce al CHECK congelado de 0157', () => {
    const sql0157 = readFileSync(
      new URL('../../src/db/migrations/0157_flito_conciliacion_boletas.sql', import.meta.url),
      'utf8',
    );
    const chk0157 = sql0157.match(
      /flito_concil_linea_resultado_chk CHECK \(resultado IN\s*\(([^)]+)\)/,
    );
    expect(chk0157, 'no se encontró el CHECK de resultado en 0157').toBeTruthy();
    const del0157 = new Set([...(chk0157![1].matchAll(/'([a-z_]+)'/g) ?? [])].map((m) => m[1]));
    expect(del0157.has('cobrado_otro_cliente')).toBe(false);
    expect(new Set(Object.values(ResultadoCruce)).has('cobrado_otro_cliente')).toBe(true);
    expect(del0157).not.toEqual(new Set(Object.values(ResultadoCruce)));
  });

  it('la 0162 no toca idx_flito_bolsa_mov_llave ni edita 0157, y es 0162 no 0161', () => {
    const sql0162 = readFileSync(
      new URL('../../src/db/migrations/0162_flito_concil_resultado_cobrado_otro_cliente.sql', import.meta.url),
      'utf8',
    );
    expect(sql0162).not.toMatch(/DROP INDEX[\s\S]*idx_flito_bolsa_mov_llave/i);
    expect(sql0162).not.toMatch(/CREATE(?:\s+UNIQUE)?\s+INDEX[\s\S]*idx_flito_bolsa_mov_llave/i);
    expect(sql0162).not.toMatch(/ALTER INDEX idx_flito_bolsa_mov_llave/i);
    expect(sql0162).toMatch(/0162_flito_concil_resultado_cobrado_otro_cliente/);
    expect(sql0162).not.toMatch(/0161_flito_concil/);
    expect(sql0162).toMatch(/DROP CONSTRAINT IF EXISTS flito_concil_linea_resultado_chk/);
    expect(sql0162).toMatch(/ADD CONSTRAINT flito_concil_linea_resultado_chk/);
  });
});

describe('flito-conciliacion · AC6 · descartar', () => {
  it('pasa a descartada con un UPDATE —no un DELETE— y así libera el hash', async () => {
    kdb.when
      .select('flito_conciliacion_boletas', [filaBoleta()])
      .select('flito_conciliacion_lineas', [])
      .update('flito_conciliacion_boletas', []);

    const { descartarBoleta } = await import('../../src/modules/flito-conciliacion/flito-conciliacion.service.js');
    const boleta = await descartarBoleta(BOLETA_ID);

    expect(boleta.estado).toBe('descartada');
    expect(espia.updatesEn('flito_conciliacion_boletas')[0].datos).toMatchObject({ estado: 'descartada' });
    expect(kdb.delete).not.toHaveBeenCalled();
  });

  it('409 si ya está conciliada: es un documento contable con dinero detrás', async () => {
    kdb.when.select('flito_conciliacion_boletas', [filaBoleta({ estado: 'conciliada', conciliadaEn: AHORA })]);
    const { descartarBoleta } = await import('../../src/modules/flito-conciliacion/flito-conciliacion.service.js');
    await expect(descartarBoleta(BOLETA_ID))
      .rejects.toMatchObject({ estado: 409, codigo: 'boleta_ya_conciliada' });
    expect(espia.updates).toHaveLength(0);
  });

  it('descartar una ya descartada no vuelve a escribir: el estado final es el que se pedía', async () => {
    kdb.when
      .select('flito_conciliacion_boletas', [filaBoleta({ estado: 'descartada' })])
      .select('flito_conciliacion_lineas', []);
    const { descartarBoleta } = await import('../../src/modules/flito-conciliacion/flito-conciliacion.service.js');
    const boleta = await descartarBoleta(BOLETA_ID);
    expect(boleta.estado).toBe('descartada');
    expect(espia.updates).toHaveLength(0);
  });
});
