// HU #10965 — liquidación sellada del trámite (Feature #10939 §2.3).
//
// Lo que se prueba aquí: qué bloquea, qué se considera «no aplica», y sobre qué se calcula el
// 4x1000. El comportamiento transaccional (sellar, reversar, facturar) se verifica además contra
// Postgres real, porque los mocks no detectan un constraint mal escrito.
//
// HU #12374 (RN-07): la compuerta resuelve la tarifa con la FECHA DE APROBACIÓN del trámite. Aquí
// se afirma que las DOS llamadas a `tarifaDe` llevan esa fecha (mutantes M1/M3) y que sellar con un
// faltante lanza `LiquidacionBloqueadaError` sin abrir transacción ni insertar (AC9).
// TZ=UTC: el faltante nombra el día en Colombia y se compara como texto.
process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { chain } from '../helpers/db.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const transactionMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, update: vi.fn(), delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const tarifaDeMock = vi.fn();
vi.mock('../../src/modules/flito-parametrizacion/flito-tarifas.service.js', () => ({
  tarifaDe: tarifaDeMock,
}));

const {
  calcular, conceptoLogistica, facturar, liquidacionDe, liquidar, reversar, salidasDe,
  LiquidacionBloqueadaError, LiquidacionError, TASA_GMF,
} = await import('../../src/modules/flito-liquidacion/flito-liquidacion.service.js');

/**
 * Una fila de la puente de servicios adicionales, tal como la devuelve `serviciosAsignadosDe`
 * (HU #12545): `valor` llega como texto porque la columna es `numeric`.
 */
function servicio(over: Record<string, unknown> = {}) {
  return {
    id: 'sa-1', tipoId: 'tipo-1', nombre: 'Paz y salvo', descripcion: null, valor: '50000',
    asignadoPorId: 9, asignadoPorNombre: 'Ana', asignadoEn: new Date('2026-07-30T15:00:00Z'),
    ...over,
  };
}

/**
 * Fila del trámite con todo pagado, una compañía que no autogestiona nada y un organismo que sí
 * entrega el impuesto en gestión: FLITO gestiona los cinco conceptos, así que los cinco se exigen.
 */
function filaCompleta(over: Record<string, unknown> = {}) {
  return {
    tramiteId: 't1', idFlit: 'FLIT-1', tipoTramite: 'Traspaso', companiaId: 7,
    fechaAprobacion: null,
    logisticaAutogestionable: false, soatAutogestionable: false, impuestosAutogestionable: false,
    modalidadOrganismo: 'requiere_gestion',
    // Sin desbloqueos excepcionales: la parametrización de la compañía decide sola (HU #10980).
    soatExcepcion: false, impuestoExcepcion: false, logisticaExcepcion: false,
    soatId: 's1', soatEstado: 'pagado', soatValorPagado: '450000',
    impuestoId: 'i1', impuestoEstado: 'pagado', impuestoValorPagado: '120000',
    derechoValor: '80000',
    ...over,
  };
}

/** Por defecto ambas tarifas configuradas: trámite digital 200.000 y logística 15.000. */
function tarifasConfiguradas() {
  tarifaDeMock.mockImplementation(async (_c: unknown, concepto: string) =>
    concepto === 'tramite_digital'
      ? { valor: 200000, origen: 'especifica' }
      : { valor: 15000, origen: 'generica' });
}

beforeEach(() => {
  selectMock.mockReset();
  insertMock.mockReset();
  transactionMock.mockReset();
  tarifaDeMock.mockReset();
  tarifasConfiguradas();
  // HU #12546 — `calcular()` hace un SELECT más (los servicios adicionales del trámite). Este
  // fallback lo deja en «sin servicios» para los casos que no hablan de ellos, DESPUÉS de los
  // `mockReturnValueOnce` que cada test encola: la cola se consume primero y esto responde al resto.
  //
  // Cuidado con lo que este fallback compra: convierte un mock AUSENTE en `[]` en vez de reventar.
  // Por eso los casos de `liquidar` siguen encolando su SELECT de servicios EN SU POSICIÓN —entre
  // el cálculo y los identificadores—: si no, la fila de identificadores la consumiría la consulta
  // de servicios y el test afirmaría sobre otra cosa.
  selectMock.mockReturnValue(chain([]));
});

/**
 * El `select` del `tx` (HU #12546, HU #12626, HU #12654). Dentro de la transacción, `liquidar()`
 * consulta CUATRO veces y en este orden: el `FOR UPDATE` sobre el trámite y, con el bloqueo tomado,
 * las filas documentales de comprobantes, la puente de servicios y los viajes adicionales de
 * logística. Invertir el orden dejaría de serializar contra aplicar/asignar/quitar/registrar, y es
 * lo que este doble fija.
 */
function txSelect(servicios: unknown[], viajes: unknown[] = [], documental: unknown[] = []) {
  return vi.fn()
    .mockReturnValueOnce(chain([{ id: 't1', idFlit: 'FLIT-1' }]))
    .mockReturnValueOnce(chain(documental))
    .mockReturnValueOnce(chain(servicios))
    .mockReturnValue(chain(viajes));
}

// ───────── HU #12374: la tarifa que se congela es la vigente en la FECHA DE APROBACIÓN ─────────

describe('calcular — resuelve la tarifa con la fecha de aprobación del trámite (RN-07, AC7)', () => {
  const FECHA = new Date('2026-07-15T12:00:00Z');

  it('las DOS tarifas (trámite digital y logística) se piden con la fecha de aprobación, en ese orden', async () => {
    selectMock.mockReturnValueOnce(chain([filaCompleta({ fechaAprobacion: FECHA })]));
    await calcular('t1');
    expect(tarifaDeMock).toHaveBeenCalledTimes(2);
    expect(tarifaDeMock).toHaveBeenNthCalledWith(1, 7, 'tramite_digital', 'Traspaso', FECHA);
    expect(tarifaDeMock).toHaveBeenNthCalledWith(2, 7, 'logistica', 'Traspaso', FECHA);
  });

  it('sin fecha de aprobación se resuelve con «ahora»: el cuarto argumento es null en las dos (AC3)', async () => {
    selectMock.mockReturnValueOnce(chain([filaCompleta({ fechaAprobacion: null })]));
    await calcular('t1');
    expect(tarifaDeMock).toHaveBeenNthCalledWith(1, 7, 'tramite_digital', 'Traspaso', null);
    expect(tarifaDeMock).toHaveBeenNthCalledWith(2, 7, 'logistica', 'Traspaso', null);
  });

  it('el faltante nombra la fecha de aprobación (día en Colombia) cuando la hay (AC9)', async () => {
    tarifaDeMock.mockResolvedValue({ valor: null, origen: 'no_configurada' });
    // 2026-08-21T03:00Z es todavía el 20 de agosto en Colombia: el día que se nombra es el de allá.
    selectMock.mockReturnValueOnce(chain([filaCompleta({ fechaAprobacion: new Date('2026-08-21T03:00:00Z') })]));
    const c = await calcular('t1');
    expect(c.faltantes).toContain('Tarifa de trámite digital no configurada para la compañía en la fecha de aprobación (2026-08-20)');
    expect(c.faltantes).toContain('Tarifa de logística no configurada para la compañía en la fecha de aprobación (2026-08-20)');
    expect(c.tramiteDigital.valor).toBeNull();
  });
});

describe('liquidar — sellar con un faltante se bloquea SIN crear liquidación (AC9)', () => {
  it('lanza LiquidacionBloqueadaError (subclase de LiquidacionError) con los faltantes, y no abre transacción ni inserta', async () => {
    tarifaDeMock.mockResolvedValue({ valor: null, origen: 'no_configurada' });
    selectMock
      .mockReturnValueOnce(chain([]))                                    // liquidacionDe: no hay sellada
      .mockReturnValueOnce(chain([filaCompleta({ fechaAprobacion: new Date('2026-08-20T12:00:00Z') })]));
    const e = await liquidar('t1', 1).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(LiquidacionBloqueadaError);
    expect(e).toBeInstanceOf(LiquidacionError);
    expect((e as InstanceType<typeof LiquidacionBloqueadaError>).faltantes).toEqual([
      'Tarifa de trámite digital no configurada para la compañía en la fecha de aprobación (2026-08-20)',
      'Tarifa de logística no configurada para la compañía en la fecha de aprobación (2026-08-20)',
    ]);
    expect(transactionMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('AC7: lo que se ESCRIBE en flito_liquidaciones es la tarifa vigente en la fecha de aprobación, no la de hoy', async () => {
    // El double de `tarifaDe` solo devuelve 270000/45000 cuando la fecha pedida es EXACTAMENTE la de
    // aprobación; con cualquier otra (hoy, null) devuelve la tarifa «de hoy» 300000/50000. Así, si la
    // compuerta dejara de pasar la fecha, la fila sellada llevaría '300000' y este test lo nombra.
    const FECHA = new Date('2026-07-15T12:00:00Z');
    tarifaDeMock.mockImplementation(async (_c: unknown, concepto: string, _t: unknown, enFecha: unknown) => {
      const enAprobacion = enFecha instanceof Date && enFecha.getTime() === FECHA.getTime();
      return concepto === 'tramite_digital'
        ? { valor: enAprobacion ? 270000 : 300000, origen: 'especifica' }
        : { valor: enAprobacion ? 45000 : 50000, origen: 'generica' };
    });
    selectMock
      .mockReturnValueOnce(chain([]))                                                        // liquidacionDe
      .mockReturnValueOnce(chain([filaCompleta({ fechaAprobacion: FECHA })]))               // calcular
      .mockReturnValueOnce(chain([]))                                                        // serviciosAsignadosDe (previsualización)
      .mockReturnValueOnce(chain([]))                                                        // viajesDe (previsualización, HU #12626)
      .mockReturnValueOnce(chain([{ companiaId: null, soatId: null, soatOrganismo: null, impuestoId: null, impuestoOrganismo: null, derechoId: null, derechoOrganismo: null }])); // identificadoresDe: sin bolsa

    // Espía del insert DENTRO de la transacción (patrón de flito-bolsas-transito.test.ts): tabla + values.
    const escritas: Array<{ tabla: string; datos: Record<string, unknown> }> = [];
    const filaSellada = {
      id: 'l1', tramiteId: 't1', estado: 'liquidado', detalle: {}, valorSoat: null, valorImpuesto: null, valorDerecho: '80000',
      valorTramiteDigital: '270000', valorLogistica: '45000', baseGmf: '1', tasaGmf: '0.004', valorGmf: '0', total: '1',
      liquidadoEn: new Date(), facturadoEn: null,
    };
    const txInsert = vi.fn((tabla: unknown) => {
      const c = chain(escritas.length === 0 ? [filaSellada] : []) as unknown as Record<string, (a: unknown) => unknown>;
      c.values = (datos: unknown) => { escritas.push({ tabla: getTableName(tabla as never), datos: datos as Record<string, unknown> }); return c; };
      return c;
    });
    transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({ insert: txInsert, select: txSelect([]) }));

    await liquidar('t1', 1);

    const liquidacion = escritas.find((e) => e.tabla === 'flito_liquidaciones');
    expect(liquidacion, 'insert en flito_liquidaciones').toBeDefined();
    expect(liquidacion!.datos).toMatchObject({ tramiteId: 't1', valorTramiteDigital: '270000', valorLogistica: '45000' });
    expect(liquidacion!.datos.valorTramiteDigital).not.toBe('300000');
    // La bitácora también congela lo mismo (es lo que el reporte enseña como sellado, AC7).
    const evento = escritas.find((e) => e.tabla === 'flito_liquidacion_eventos');
    expect(evento!.datos.snapshot).toMatchObject({ tramiteDigital: { valor: 270000 }, logistica: { valor: 45000 } });
    expect(insertMock).not.toHaveBeenCalled(); // nada se escribe fuera de la transacción
  });

  it('un trámite ya liquidado sigue siendo LiquidacionError a secas (400), no «bloqueado»', async () => {
    selectMock
      .mockReturnValueOnce(chain([{ id: 'l1', tramiteId: 't1', estado: 'liquidado', detalle: {}, total: '1', liquidadoEn: new Date(), facturadoEn: null }]))
      .mockReturnValueOnce(chain([{ idFlit: 'FLIT-1' }]));
    const e = await liquidar('t1', 1).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(LiquidacionError);
    expect(e).not.toBeInstanceOf(LiquidacionBloqueadaError);
    expect(transactionMock).not.toHaveBeenCalled();
  });
});

describe('calcular — el 4x1000 va sobre el total del trámite', () => {
  it('la base son los cinco conceptos, y el GMF se suma encima', async () => {
    selectMock.mockReturnValueOnce(chain([filaCompleta()]));
    const c = await calcular('t1');

    // 450.000 + 120.000 + 80.000 + 200.000 + 15.000 = 865.000. El gravamen se calcula sobre esa
    // suma y se añade al final, así que el total es la base más su propio GMF.
    expect(c.baseGmf).toBe(865000);
    expect(c.tasaGmf).toBe(TASA_GMF);
    expect(c.valorGmf).toBe(3460);
    expect(c.total).toBe(865000 + 3460);
    expect(c.faltantes).toEqual([]);
  });

  it('la tasa aplicada viaja con el cálculo, no se asume al leer', async () => {
    selectMock.mockReturnValueOnce(chain([filaCompleta()]));
    const c = await calcular('t1');
    expect(c.tasaGmf).toBe(0.004);
  });
});

describe('calcular — qué NO aplica (null, nunca cero)', () => {
  it('la compañía que autogestiona el SOAT no lo paga ni suma a la base', async () => {
    selectMock.mockReturnValueOnce(chain([filaCompleta({ soatAutogestionable: true })]));
    const c = await calcular('t1');
    expect(c.soat.valor).toBeNull();
    expect(c.soat.bloquea).toBe(false);
    expect(c.baseGmf).toBe(120000 + 80000 + 200000 + 15000);
    expect(c.faltantes).toEqual([]);
  });

  it('la compañía que autogestiona la logística no la paga', async () => {
    selectMock.mockReturnValueOnce(chain([filaCompleta({ logisticaAutogestionable: true })]));
    const c = await calcular('t1');
    expect(c.logistica.valor).toBeNull();
    expect(c.logistica.bloquea).toBe(false);
    // Sin los 15.000 de logística: ni en la base ni, por tanto, en el GMF.
    expect(c.baseGmf).toBe(850000);
    expect(c.total).toBe(850000 + 3400);
  });

  it('la compañía que autogestiona el impuesto no lo paga', async () => {
    selectMock.mockReturnValueOnce(chain([filaCompleta({
      impuestosAutogestionable: true, impuestoId: null, impuestoEstado: null, impuestoValorPagado: null,
    })]));
    const c = await calcular('t1');
    expect(c.impuesto.valor).toBeNull();
    expect(c.impuesto.bloquea).toBe(false);
    expect(c.faltantes).toEqual([]);
  });

  it('el organismo que no entrega el impuesto en gestión tampoco lo hace exigible (RN-01)', async () => {
    // El segundo eje de la regla: la compañía querría que FLITO se lo gestionara, pero ese organismo
    // no lo entrega. Sin vigencia abierta el default es el mismo, autogestionado.
    selectMock.mockReturnValueOnce(chain([filaCompleta({
      modalidadOrganismo: null, impuestoId: null, impuestoEstado: null, impuestoValorPagado: null,
    })]));
    const c = await calcular('t1');
    expect(c.impuesto.bloquea).toBe(false);
    expect(c.impuesto.origen).toBe('El organismo no requiere gestión del impuesto');
    expect(c.faltantes).toEqual([]);
  });

  it('lo desbloqueado excepcionalmente SÍ se cobra, aunque la compañía autogestione (HU #10980)', async () => {
    // Renting autogestiona su SOAT y aun así encarga trámites puntuales. En esos FLITO desembolsa de
    // verdad: dejarlo fuera del total sería regalarlo.
    selectMock.mockReturnValueOnce(chain([filaCompleta({
      soatAutogestionable: true, soatExcepcion: true,
    })]));
    const c = await calcular('t1');
    expect(c.soat.valor).toBe(450000);
    expect(c.baseGmf).toBe(865000);
    expect(c.faltantes).toEqual([]);
  });

  it('un SOAT desbloqueado y todavía sin pagar bloquea el sellado', async () => {
    // Si FLITO lo asumió, el desembolso está por venir: sellar antes congelaría un total corto.
    selectMock.mockReturnValueOnce(chain([filaCompleta({
      soatAutogestionable: true, soatExcepcion: true,
      soatEstado: 'pendiente', soatValorPagado: null,
    })]));
    const c = await calcular('t1');
    expect(c.soat.bloquea).toBe(true);
    expect(c.faltantes).toContain('SOAT en estado "pendiente"');
  });

  it('el impuesto desbloqueado se cobra aunque el organismo no lo entregue en gestión', async () => {
    selectMock.mockReturnValueOnce(chain([filaCompleta({
      impuestosAutogestionable: true, modalidadOrganismo: null, impuestoExcepcion: true,
    })]));
    const c = await calcular('t1');
    expect(c.impuesto.valor).toBe(120000);
    expect(c.faltantes).toEqual([]);
  });

  it('la logística desbloqueada se cobra por tarifa, aunque la compañía la autogestione', async () => {
    // La logística no tiene registro donde marcar la excepción: la lleva la excepción vigente.
    selectMock.mockReturnValueOnce(chain([filaCompleta({
      logisticaAutogestionable: true, logisticaExcepcion: true,
    })]));
    const c = await calcular('t1');
    expect(c.logistica.valor).toBe(15000);
    expect(c.baseGmf).toBe(865000);
  });

  it('a la compañía que lo autogestiona todo solo se le cobran trámite digital y derecho', async () => {
    // Es el caso que describe la operación: sin SOAT, sin impuesto y sin logística de FLITO, el
    // trámite se liquida igual — con esos dos conceptos y nada más.
    selectMock.mockReturnValueOnce(chain([filaCompleta({
      soatAutogestionable: true, impuestosAutogestionable: true, logisticaAutogestionable: true,
      soatId: null, soatEstado: null, soatValorPagado: null,
      impuestoId: null, impuestoEstado: null, impuestoValorPagado: null,
    })]));
    const c = await calcular('t1');
    expect(c.faltantes).toEqual([]);
    expect(c.baseGmf).toBe(80000 + 200000);
  });
});

describe('calcular — lo que FLITO gestiona TIENE que tener valor', () => {
  // El fallo que esto cierra: la ausencia de registro se leía como «exento» y dejaba sellar. Pero el
  // sync tampoco crea el registro cuando el trámite no llegó a Asignado o le faltaba emparejar
  // compañía u organismo, así que una compañía a la que FLITO le gestiona TODO se liquidaba sin SOAT
  // y sin impuesto, congelando un total al que le faltaban dos desembolsos reales.

  it('sin SOAT gestionado no se puede liquidar, aunque no exista el registro', async () => {
    selectMock.mockReturnValueOnce(chain([filaCompleta({
      soatId: null, soatEstado: null, soatValorPagado: null,
    })]));
    const c = await calcular('t1');
    expect(c.soat.bloquea).toBe(true);
    expect(c.faltantes).toContain('Sin SOAT gestionado');
  });

  it('sin impuesto gestionado tampoco, si el organismo lo entrega en gestión', async () => {
    selectMock.mockReturnValueOnce(chain([filaCompleta({
      impuestoId: null, impuestoEstado: null, impuestoValorPagado: null,
    })]));
    const c = await calcular('t1');
    expect(c.impuesto.bloquea).toBe(true);
    expect(c.faltantes).toContain('Sin impuesto gestionado');
  });
});

describe('calcular — qué bloquea el sellado', () => {
  it('un impuesto sin pagar impide liquidar y dice por qué', async () => {
    selectMock.mockReturnValueOnce(chain([filaCompleta({ impuestoEstado: 'solicitado', impuestoValorPagado: null })]));
    const c = await calcular('t1');
    expect(c.impuesto.bloquea).toBe(true);
    expect(c.faltantes).toContain('Impuesto en estado "solicitado"');
  });

  it('un SOAT sin pagar impide liquidar', async () => {
    selectMock.mockReturnValueOnce(chain([filaCompleta({ soatEstado: 'pendiente', soatValorPagado: null })]));
    const c = await calcular('t1');
    expect(c.faltantes).toContain('SOAT en estado "pendiente"');
  });

  it('sin recibo de derecho de tránsito no se puede liquidar', async () => {
    // El derecho es el dato que este Feature vino a hacer real: sellar sin él sería volver a inventar.
    selectMock.mockReturnValueOnce(chain([filaCompleta({ derechoValor: null })]));
    const c = await calcular('t1');
    expect(c.derecho.bloquea).toBe(true);
    expect(c.faltantes).toContain('Sin recibo de derecho de tránsito');
  });

  it('sin tarifa configurada bloquea y NO cuenta como cero', async () => {
    tarifaDeMock.mockResolvedValue({ valor: null, origen: 'no_configurada' });
    selectMock.mockReturnValueOnce(chain([filaCompleta()]));
    const c = await calcular('t1');
    expect(c.tramiteDigital.valor).toBeNull();
    expect(c.tramiteDigital.origen).toBe('No configurado');
    expect(c.faltantes).toContain('Tarifa de trámite digital no configurada para la compañía');
    expect(c.faltantes).toContain('Tarifa de logística no configurada para la compañía');
  });

  it('acumula todos los faltantes, no solo el primero', async () => {
    // Quien va a liquidar necesita la lista completa; arreglar de uno en uno es una tortura.
    tarifaDeMock.mockResolvedValue({ valor: null, origen: 'no_configurada' });
    selectMock.mockReturnValueOnce(chain([filaCompleta({
      soatEstado: 'pendiente', soatValorPagado: null,
      impuestoEstado: 'solicitado', impuestoValorPagado: null,
      derechoValor: null,
    })]));
    const c = await calcular('t1');
    expect(c.faltantes.length).toBe(5);
  });

  it('un trámite inexistente falla claro', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    await expect(calcular('no-existe')).rejects.toThrow(/no existe/i);
  });
});

describe('calcular — redondeo', () => {
  it('el GMF se redondea a dos decimales', async () => {
    selectMock.mockReturnValueOnce(chain([filaCompleta({ soatValorPagado: '333333', impuestoValorPagado: null, impuestoId: null, derechoValor: '1' })]));
    const c = await calcular('t1');
    // 333.333 + 1 + 200.000 (digital) + 15.000 (logística) = 548.334; × 0,004 = 2.193,336
    expect(c.baseGmf).toBe(548334);
    expect(c.valorGmf).toBe(2193.34);
  });
});


// ───────── HU #12546: servicios adicionales en el cálculo y en el sello ─────────
//
// Mutantes que estos casos matan:
//   · M-SA1 — dejar los servicios fuera de `baseGmf`: cae la base y el gravamen de «con servicios».
//   · M-SA2 — devolver `valor: 0` en vez de `null` sin servicios: cae «null, nunca cero».
//   · M-SA3 — meter los servicios en `faltantes` o poner `bloquea: true`: cae «no bloquea».
//   · M-SA4 — leer la puente con `db` en vez de con `tx` (o antes del `FOR UPDATE`): cae el orden
//     dentro de la transacción y cae «lo que se sella es la lectura bajo bloqueo».
//   · M-SA5 — no escribir la clave cuando no hay servicios: cae `items: []` en el detalle sellado.
//   · M-SA6 — recalcular desde la puente al leer una liquidación sellada: cae el conteo de SELECT.

describe('calcular — los servicios adicionales suman a la base y nunca bloquean (AC2)', () => {
  it('con servicios: la suma va en `valor`, el desglose en `items` y el 4x1000 se calcula CON ellos (M-SA1)', async () => {
    selectMock
      .mockReturnValueOnce(chain([filaCompleta()]))
      .mockReturnValueOnce(chain([servicio(), servicio({ id: 'sa-2', tipoId: 'tipo-2', nombre: 'Diagnóstico', valor: '35000' })]));
    const c = await calcular('t1');

    expect(c.serviciosAdicionales).toEqual({
      valor: 85000, origen: 'asignacion', bloquea: false, origenValor: 'catalogo', diferencia: null,
      items: [
        { tipoId: 'tipo-1', nombre: 'Paz y salvo', valor: 50000 },
        { tipoId: 'tipo-2', nombre: 'Diagnóstico', valor: 35000 },
      ],
    });
    // 865.000 de los cinco conceptos + 85.000 de servicios = 950.000; ×0,004 = 3.800.
    expect(c.baseGmf).toBe(950000);
    expect(c.valorGmf).toBe(3800);
    expect(c.total).toBe(953800);
    expect(c.faltantes).toEqual([]);
  });

  it('sin servicios: `valor` null (nunca cero), `items` vacío, no bloquea y no entra en faltantes (M-SA2, M-SA3)', async () => {
    selectMock
      .mockReturnValueOnce(chain([filaCompleta()]))
      .mockReturnValueOnce(chain([]));
    const c = await calcular('t1');

    expect(c.serviciosAdicionales.valor).toBeNull();
    expect(c.serviciosAdicionales.items).toEqual([]);
    expect(c.serviciosAdicionales.bloquea).toBe(false);
    expect(c.faltantes).toEqual([]);
    // La base es la de siempre: un `0` disfrazado la dejaría igual, pero el gravamen de 3.460 y el
    // `null` de arriba juntos sí distinguen «no aplica» de «cero».
    expect(c.baseGmf).toBe(865000);
    expect(c.valorGmf).toBe(3460);
  });

  it('los items conservan el ORDEN de la puente (asignado_en ASC, id ASC): no se reordenan por valor ni por nombre', async () => {
    selectMock
      .mockReturnValueOnce(chain([filaCompleta()]))
      .mockReturnValueOnce(chain([
        servicio({ id: 'sa-9', tipoId: 'tipo-9', nombre: 'Zeta', valor: '10000' }),
        servicio({ id: 'sa-1', tipoId: 'tipo-1', nombre: 'Alfa', valor: '90000' }),
      ]));
    const c = await calcular('t1');
    expect(c.serviciosAdicionales.items.map((i) => i.nombre)).toEqual(['Zeta', 'Alfa']);
  });
});

/**
 * Espía del sellado: devuelve el `tx`, lo escrito y el orden de las consultas de dentro. Los
 * `select` se distinguen por POSICIÓN: 1.º el bloqueo, 2.º las filas documentales (HU #12654),
 * 3.º la puente de servicios, 4.º los viajes de logística (HU #12626). Un 5.º select respondería `[]`.
 */
function espiarSellado(serviciosEnTx: unknown[], viajesEnTx: unknown[] = [], documentalEnTx: unknown[] = []) {
  const escritas: Array<{ tabla: string; datos: Record<string, unknown> }> = [];
  const orden: string[] = [];
  const filaSellada = {
    id: 'l1', tramiteId: 't1', estado: 'liquidado', detalle: {}, valorSoat: '450000',
    valorImpuesto: '120000', valorDerecho: '80000', valorTramiteDigital: '200000',
    valorLogistica: '15000', valorServiciosAdicionales: null, baseGmf: '1', tasaGmf: '0.004',
    valorGmf: '0', total: '1', liquidadoEn: new Date(), facturadoEn: null,
  };
  const insert = vi.fn((tabla: unknown) => {
    const c = chain(escritas.length === 0 ? [filaSellada] : []) as unknown as Record<string, (a: unknown) => unknown>;
    c.values = (datos: unknown) => { escritas.push({ tabla: getTableName(tabla as never), datos: datos as Record<string, unknown> }); return c; };
    return c;
  });
  const respuestas: Array<[string, unknown[]]> = [
    ['bloqueo', [{ id: 't1', idFlit: 'FLIT-1' }]], ['documental', documentalEnTx], ['servicios', serviciosEnTx], ['viajes', viajesEnTx],
  ];
  let n = 0;
  const select = vi.fn(() => {
    const [nombre, filas] = respuestas[n++] ?? ['otro', []];
    const c = chain(filas) as unknown as Record<string, unknown>;
    // El bloqueo tiene que ser `FOR UPDATE` DE VERDAD: sin `.for('update')` no serializa nada.
    c.for = (modo: unknown) => { orden.push(`bloqueo:for:${String(modo)}`); return c; };
    if (nombre !== 'bloqueo') orden.push(nombre);
    return c;
  });
  return { tx: { insert, select }, escritas, orden };
}

describe('liquidar — sella los servicios adicionales leyéndolos DENTRO de la transacción (AC3)', () => {
  const sinBolsa = { companiaId: null, soatId: null, soatOrganismo: null, impuestoId: null, impuestoOrganismo: null, derechoId: null, derechoOrganismo: null };

  function encolarSellado(serviciosPrevios: unknown[] = [], viajesPrevios: unknown[] = []) {
    selectMock
      .mockReturnValueOnce(chain([]))                            // liquidacionDe: no hay sellada
      .mockReturnValueOnce(chain([filaCompleta()]))              // calcular
      .mockReturnValueOnce(chain(serviciosPrevios))              // serviciosAsignadosDe (previsualización)
      .mockReturnValueOnce(chain(viajesPrevios))                 // viajesDe (previsualización, HU #12626)
      .mockReturnValueOnce(chain([sinBolsa]));                   // identificadoresDe
  }

  it('la columna y el detalle llevan la suma y los items; el total sellado incluye su gravamen', async () => {
    encolarSellado([servicio()]);
    const espia = espiarSellado([servicio(), servicio({ id: 'sa-2', tipoId: 'tipo-2', nombre: 'Diagnóstico', valor: '35000' })]);
    transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(espia.tx));

    await liquidar('t1', 1);

    const liquidacion = espia.escritas.find((e) => e.tabla === 'flito_liquidaciones')!;
    expect(liquidacion.datos.valorServiciosAdicionales).toBe('85000');
    expect(liquidacion.datos.detalle).toMatchObject({
      serviciosAdicionales: {
        valor: 85000, origen: 'asignacion', bloquea: false,
        items: [
          { tipoId: 'tipo-1', nombre: 'Paz y salvo', valor: 50000 },
          { tipoId: 'tipo-2', nombre: 'Diagnóstico', valor: 35000 },
        ],
      },
    });
    // 950.000 de base y 3.800 de gravamen: si el sellado hubiera usado el cálculo de la
    // previsualización (un solo servicio, 915.000), estos tres números serían otros.
    expect(liquidacion.datos.baseGmf).toBe('950000');
    expect(liquidacion.datos.valorGmf).toBe('3800');
    expect(liquidacion.datos.total).toBe('953800');
  });

  it('primero el FOR UPDATE del trámite y DESPUÉS la puente, las dos con el `tx` (M-SA4)', async () => {
    encolarSellado();
    const espia = espiarSellado([servicio()]);
    transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(espia.tx));

    await liquidar('t1', 1);

    expect(espia.orden).toEqual(['bloqueo:for:update', 'documental', 'servicios', 'viajes']);
    expect(espia.tx.select).toHaveBeenCalledTimes(4);
  });

  it('sin servicios, la columna va NULL y la clave del detalle se escribe igual, con items vacío (M-SA5)', async () => {
    encolarSellado();
    const espia = espiarSellado([]);
    transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(espia.tx));

    await liquidar('t1', 1);

    const liquidacion = espia.escritas.find((e) => e.tabla === 'flito_liquidaciones')!;
    expect(liquidacion.datos.valorServiciosAdicionales).toBeNull();
    // La clave EXISTE aunque esté vacía: es lo que hace que `jsonb_array_length` responda 0 en el
    // reporte y no NULL, y así se distinga de una liquidación sellada antes de esta HU.
    expect(liquidacion.datos.detalle).toMatchObject({
      serviciosAdicionales: { valor: null, origen: 'asignacion', bloquea: false, items: [] },
    });
    expect(liquidacion.datos.total).toBe('868460');
  });

  it('la bitácora del sellado congela el mismo desglose que la fila', async () => {
    encolarSellado();
    const espia = espiarSellado([servicio()]);
    transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(espia.tx));

    await liquidar('t1', 1);

    const evento = espia.escritas.find((e) => e.tabla === 'flito_liquidacion_eventos')!;
    expect(evento.datos.snapshot).toMatchObject({
      serviciosAdicionales: { valor: 50000, items: [{ tipoId: 'tipo-1', nombre: 'Paz y salvo', valor: 50000 }] },
      total: 918660,
    });
  });
});

describe('leer una liquidación sellada — lo sellado NO se recalcula desde la puente (AC4)', () => {
  const base = {
    id: 'l1', tramiteId: 't1', estado: 'liquidado', valorSoat: '450000', valorImpuesto: '120000',
    valorDerecho: '80000', valorTramiteDigital: '200000', valorLogistica: '15000',
    baseGmf: '950000', tasaGmf: '0.004', valorGmf: '3800', total: '953800',
    liquidadoEn: new Date('2026-08-01T10:00:00Z'), facturadoEn: null,
  };

  it('devuelve los items del detalle aunque el tipo se haya dado de baja después, y sin consultar la puente (M-SA6)', async () => {
    selectMock
      .mockReturnValueOnce(chain([{
        ...base, valorServiciosAdicionales: '85000',
        detalle: {
          serviciosAdicionales: {
            valor: 85000, origen: 'asignacion', bloquea: false,
            items: [{ tipoId: 'tipo-1', nombre: 'Paz y salvo', valor: 50000 }, { tipoId: 'tipo-2', nombre: 'Diagnóstico', valor: 35000 }],
          },
        },
      }]))
      .mockReturnValueOnce(chain([{ idFlit: 'FLIT-1' }]));

    const dto = await liquidacionDe('t1');

    expect(dto!.serviciosAdicionales.valor).toBe(85000);
    expect(dto!.serviciosAdicionales.items.map((i) => i.nombre)).toEqual(['Paz y salvo', 'Diagnóstico']);
    // DOS consultas y ninguna más: la liquidación y el idFlit. Una tercera sería la puente, y eso es
    // exactamente lo que no puede pasar — quitar el servicio después no cambia lo sellado.
    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  it('una liquidación sellada ANTES de esta HU se lee sin romper: valor de la columna e items vacío', async () => {
    // Sin la clave en el detalle y con la columna en NULL (la 0194 no hace backfill). El respaldo por
    // columna es el patrón vigente de `aDto`, y aquí es lo único que hay.
    selectMock
      .mockReturnValueOnce(chain([{ ...base, valorServiciosAdicionales: null, detalle: { soat: { valor: 450000, origen: 'Valor pagado del SOAT', bloquea: false } } }]))
      .mockReturnValueOnce(chain([{ idFlit: 'FLIT-1' }]));

    const dto = await liquidacionDe('t1');

    expect(dto!.serviciosAdicionales).toEqual({ valor: null, origen: 'Sellado', bloquea: false, items: [], origenValor: null, diferencia: null });
    expect(dto!.total).toBe(953800);
  });
});

describe('facturar — no toca la columna sellada ni la puente (AC4)', () => {
  it('el UPDATE solo cambia estado, actor y fechas; no se consulta la puente', async () => {
    const filaSellada = {
      id: 'l1', tramiteId: 't1', estado: 'liquidado', detalle: {}, valorSoat: null, valorImpuesto: null,
      valorDerecho: null, valorTramiteDigital: null, valorLogistica: null,
      valorServiciosAdicionales: '85000', baseGmf: '85000', tasaGmf: '0.004', valorGmf: '340',
      total: '85340', liquidadoEn: new Date(), facturadoEn: null,
    };
    selectMock
      .mockReturnValueOnce(chain([filaSellada]))          // la liquidación a facturar
      .mockReturnValueOnce(chain([{ idFlit: 'FLIT-1' }])); // el idFlit del DTO

    const sets: Array<Record<string, unknown>> = [];
    const txUpdate = vi.fn(() => {
      const c = chain([{ ...filaSellada, estado: 'facturado', facturadoEn: new Date() }]) as unknown as Record<string, unknown>;
      c.set = (datos: unknown) => { sets.push(datos as Record<string, unknown>); return c; };
      return c;
    });
    const txSelectPuente = vi.fn(() => chain([]));
    transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({ update: txUpdate, insert: () => chain([]), select: txSelectPuente }));

    const dto = await facturar('t1', 7);

    expect(Object.keys(sets[0]!).sort()).toEqual(['estado', 'facturadoEn', 'facturadoPorId', 'updatedAt']);
    expect(txSelectPuente).not.toHaveBeenCalled();
    // Y lo sellado sigue ahí: facturar no recalcula ni un peso.
    expect(dto.serviciosAdicionales.valor).toBe(85000);
  });
});

describe('reversar — el evento conserva el snapshot CON items y la puente no se toca (AC4)', () => {
  it('la bitácora guarda el desglose sellado, se borra la liquidación y nadie consulta la puente', async () => {
    const detalle = {
      derecho: { valor: 80000, origen: 'Recibo de derecho de tránsito', bloquea: false },
      serviciosAdicionales: {
        valor: 85000, origen: 'asignacion', bloquea: false,
        items: [{ tipoId: 'tipo-1', nombre: 'Paz y salvo', valor: 50000 }, { tipoId: 'tipo-2', nombre: 'Diagnóstico', valor: 35000 }],
      },
    };
    selectMock.mockReturnValueOnce(chain([{
      id: 'l1', tramiteId: 't1', estado: 'liquidado', detalle,
      baseGmf: '165000', tasaGmf: '0.004', valorGmf: '660', total: '165660',
      liquidadoEn: new Date('2026-08-01T10:00:00Z'), facturadoEn: null,
    }]));

    const eventos: Array<Record<string, unknown>> = [];
    const borrados: unknown[] = [];
    const txSelects: unknown[] = [];
    const txInsert = vi.fn(() => {
      const c = chain([]) as unknown as Record<string, unknown>;
      c.values = (datos: unknown) => { eventos.push(datos as Record<string, unknown>); return c; };
      return c;
    });
    // Se anota de QUÉ TABLA lee cada select de dentro de la transacción: el nombre del `from` es lo
    // único que demuestra que la puente no se consulta (los argumentos del `select` no lo dicen).
    const txSel = vi.fn(() => {
      const c = chain([]) as unknown as Record<string, unknown>;
      c.from = (tbl: unknown) => { txSelects.push(getTableName(tbl as never)); return c; };
      return c;
    });
    transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({
      insert: txInsert, select: txSel, update: () => chain([]),
      delete: (t: unknown) => { borrados.push(t); return chain([]); },
    }));

    await reversar('t1', 'Error en el valor del derecho', 9);

    // El snapshot es el detalle ENTERO más el total: los items sellados sobreviven al reverso, que
    // es lo único que permite auditar después qué servicios se cobraron en ese sellado.
    expect(eventos[0]!.accion).toBe('reversar');
    expect(eventos[0]!.snapshot).toMatchObject({
      serviciosAdicionales: { valor: 85000, items: [{ nombre: 'Paz y salvo', valor: 50000 }, { nombre: 'Diagnóstico', valor: 35000 }] },
      total: 165660,
    });
    expect(borrados).toHaveLength(1);
    // Los `select` de dentro son los del barrido de las bolsas (movimientos); ninguno va a la puente:
    // reversar NO devuelve, quita ni toca los servicios asignados al trámite.
    // Mutante «releer la puente al reversar»: aparecería `flito_tramite_servicios_adicionales`.
    expect(txSelects.length).toBeGreaterThan(0);
    expect(txSelects).not.toContain('flito_tramite_servicios_adicionales');
    // Ni la de viajes (HU #12626): reversar borra la fila y su snapshot; los viajes siguen vivos.
    expect(txSelects).not.toContain('flito_tramite_viajes_logistica');
    expect(txSelects).toContain('flito_bolsa_movimientos');
  });
});

// ───────── HU #12626: la logística es el viaje 1 (tarifa) + los viajes adicionales ─────────
//
// Mutantes que estos casos matan:
//   · M-VL1 — contar el viaje 1 dos veces (tarifa + Σ de TODOS los viajes incluido uno inicial
//     duplicado): cae AC1 (90.000, no 125.000).
//   · M-VL2 — sumar solo los adicionales sin la tarifa: cae AC1 (90.000, no 55.000) y AC2.
//   · M-VL3 — recalcular cada viaje con `tarifaDe` de hoy en vez de su precio congelado: cae AC3.
//   · M-VL4 — sumar los viajes aunque la compañía autogestione: cae AC4.
//   · M-VL5 — dar valor y no bloquear cuando falta la tarifa: cae AC5.
//   · M-VL6 — leer los viajes con `db` en vez de `tx`, o antes del FOR UPDATE: cae el orden del espía
//     y el conteo de selects de `db` en AC6.
//   · M-VL7 — una salida por viaje, o por la tarifa sola: cae AC7.
//   · M-VL8 — `viajes ?? []` / `totalViajes ?? 1` al leer un sello sin snapshot: cae AC9.
//   · M-VL9 — rellenar los viajes desde la tabla al leer: cae el conteo de selects de AC9.

/** Una fila de `viajesDe` (HU #12619): `valor` y `tarifaVigente` llegan como texto (`numeric`). */
function viaje(over: Record<string, unknown> = {}) {
  return {
    id: 'v-2', numero: 2, modo: 'inicial', valor: '35000', tarifaVigente: '35000',
    motivo: 'devolucion', motivoDetalle: null, registradoPorId: 4, registradoPorNombre: 'Luis',
    registradoEn: new Date('2026-09-10T14:00:00Z'),
    ...over,
  };
}
const VIAJE_MANUAL = viaje({
  id: 'v-3', numero: 3, modo: 'manual', valor: '20000', tarifaVigente: '35000',
  motivo: 'otro', motivoDetalle: 'Recogida en otra sede', registradoPorId: 5, registradoPorNombre: 'Marta',
  registradoEn: new Date('2026-09-11T09:30:00Z'),
});

/** Tarifas con la logística en 35.000, que es la cifra de los AC de la HU. */
function tarifaLogistica35() {
  tarifaDeMock.mockImplementation(async (_c: unknown, concepto: string) =>
    concepto === 'tramite_digital'
      ? { valor: 200000, origen: 'especifica' }
      : { valor: 35000, origen: 'generica' });
}

/** Encola la previsualización: fila del trámite, servicios y viajes (en ese orden). */
function encolarCalculo(fila: Record<string, unknown>, viajes: unknown[], servicios: unknown[] = []) {
  selectMock
    .mockReturnValueOnce(chain([filaCompleta(fila)]))
    .mockReturnValueOnce(chain(servicios))
    .mockReturnValueOnce(chain(viajes));
}

describe('calcular — la logística suma la tarifa (viaje 1) y los viajes adicionales (AC1..AC5)', () => {
  it('AC1: tarifa 35.000 + inicial 35.000 + manual 20.000 = 90.000, con el desglose congelado y el GMF sobre la suma (M-VL1, M-VL2)', async () => {
    tarifaLogistica35();
    encolarCalculo({}, [viaje(), VIAJE_MANUAL]);
    const c = await calcular('t1');

    expect(c.logistica).toEqual({
      valor: 90000, bloquea: false, tarifa: 35000, totalViajes: 3, origenValor: 'tarifa', diferencia: null,
      origen: 'Tarifa genérica + 2 viajes adicionales',
      viajes: [
        {
          id: 'v-2', numero: 2, modo: 'inicial', valor: 35000, tarifaVigente: 35000, motivo: 'devolucion',
          motivoDetalle: null, registradoPorNombre: 'Luis', registradoEn: '2026-09-10T14:00:00.000Z',
        },
        {
          id: 'v-3', numero: 3, modo: 'manual', valor: 20000, tarifaVigente: 35000, motivo: 'otro',
          motivoDetalle: 'Recogida en otra sede', registradoPorNombre: 'Marta', registradoEn: '2026-09-11T09:30:00.000Z',
        },
      ],
    });
    // Ni 125.000 (viaje 1 contado dos veces) ni 55.000 (solo los adicionales): 90.000.
    expect(c.logistica.valor).not.toBe(125000);
    expect(c.logistica.valor).not.toBe(55000);
    // 450.000 + 120.000 + 80.000 + 200.000 + 90.000 = 940.000; × 0,004 = 3.760.
    expect(c.baseGmf).toBe(940000);
    expect(c.valorGmf).toBe(Math.round(940000 * 0.004 * 100) / 100);
    expect(c.total).toBe(943760);
    expect(c.faltantes).toEqual([]);
  });

  it('el snapshot de cada viaje NO lleva el id del actor (solo su nombre)', async () => {
    tarifaLogistica35();
    encolarCalculo({}, [viaje()]);
    const c = await calcular('t1');
    expect(c.logistica.viajes![0]).not.toHaveProperty('registradoPorId');
    expect(c.logistica.viajes![0]!.registradoPorNombre).toBe('Luis');
  });

  it('AC2: sin viajes, la logística es la tarifa a secas: origen sin sufijo, `viajes []`, `totalViajes 1`', async () => {
    tarifaLogistica35();
    encolarCalculo({}, []);
    const c = await calcular('t1');
    expect(c.logistica).toEqual({
      valor: 35000, origen: 'Tarifa genérica', bloquea: false, tarifa: 35000, viajes: [], totalViajes: 1,
      origenValor: 'tarifa', diferencia: null,
    });
    expect(c.baseGmf).toBe(885000);
  });

  it('con UN viaje el sufijo va en singular', async () => {
    tarifaLogistica35();
    encolarCalculo({}, [viaje()]);
    const c = await calcular('t1');
    expect(c.logistica.origen).toBe('Tarifa genérica + 1 viaje adicional');
    expect(c.logistica.totalViajes).toBe(2);
  });

  it('AC3: cada viaje se suma con el precio con que se registró, no con la tarifa de hoy (M-VL3)', async () => {
    // Tarifa 50.000 en la fecha de aprobación, 100.000 «hoy» (cualquier otra fecha, incluida null):
    // si algún viaje se recalculara con `tarifaDe` de hoy, el total se iría a 150.000 o 130.000.
    const FECHA = new Date('2026-07-15T12:00:00Z');
    tarifaDeMock.mockImplementation(async (_c: unknown, concepto: string, _t: unknown, enFecha: unknown) => {
      const enAprobacion = enFecha instanceof Date && enFecha.getTime() === FECHA.getTime();
      return concepto === 'tramite_digital'
        ? { valor: 200000, origen: 'especifica' }
        : { valor: enAprobacion ? 50000 : 100000, origen: 'generica' };
    });
    encolarCalculo({ fechaAprobacion: FECHA }, [viaje({ valor: '30000', tarifaVigente: '30000' })]);
    const c = await calcular('t1');
    expect(c.logistica.valor).toBe(80000);
    expect(c.logistica.tarifa).toBe(50000);
    expect(c.logistica.viajes![0]!.valor).toBe(30000);
    // `tarifaDe` se pidió DOS veces (digital y logística) y ninguna más: no hay una por viaje.
    expect(tarifaDeMock).toHaveBeenCalledTimes(2);
  });

  it('AC4: la compañía que autogestiona su logística no paga ni la tarifa ni los viajes que queden registrados (M-VL4)', async () => {
    tarifaLogistica35();
    encolarCalculo({ logisticaAutogestionable: true }, [viaje(), VIAJE_MANUAL]);
    const c = await calcular('t1');
    expect(c.logistica).toEqual({
      valor: null, origen: 'La compañía autogestiona su logística', bloquea: false,
      tarifa: null, viajes: [], totalViajes: 0, origenValor: null, diferencia: null,
    });
    // Sin logística en la base: 450.000 + 120.000 + 80.000 + 200.000.
    expect(c.baseGmf).toBe(850000);
    expect(c.faltantes).toEqual([]);
  });

  it('AC4: con la excepción de autogestión viva, suma como cualquier otra', async () => {
    tarifaLogistica35();
    encolarCalculo({ logisticaAutogestionable: true, logisticaExcepcion: true }, [viaje(), VIAJE_MANUAL]);
    const c = await calcular('t1');
    expect(c.logistica.valor).toBe(90000);
    expect(c.logistica.totalViajes).toBe(3);
    expect(c.baseGmf).toBe(940000);
  });

  it('AC5: sin tarifa de logística vigente, sigue bloqueando con el mismo faltante aunque haya un viaje manual (M-VL5)', async () => {
    tarifaDeMock.mockImplementation(async (_c: unknown, concepto: string) =>
      concepto === 'tramite_digital'
        ? { valor: 200000, origen: 'especifica' }
        : { valor: null, origen: 'no_configurada' });
    encolarCalculo({}, [VIAJE_MANUAL]);
    const c = await calcular('t1');
    expect(c.logistica.bloquea).toBe(true);
    expect(c.logistica.valor).toBeNull();
    expect(c.logistica.tarifa).toBeNull();
    expect(c.logistica.origen).toBe('No configurado');
    // El desglose se conserva para que la pantalla enseñe qué hay registrado; no cambia el bloqueo.
    expect(c.logistica.viajes).toHaveLength(1);
    expect(c.logistica.totalViajes).toBe(2);
    expect(c.faltantes).toEqual(['Tarifa de logística no configurada para la compañía']);
    expect(c.baseGmf).toBe(850000);
  });

  it('los viajes se leen SIEMPRE de la tabla viva: tras un reverso, el siguiente cálculo toma los vigentes (AC8)', async () => {
    // Antes del reverso había inicial 35.000 + manual 20.000; después se quitó el 3 y se registró un
    // manual de 5.000: el cálculo nuevo es tarifa + 35.000 + 5.000, sin rastro del sello anterior.
    tarifaLogistica35();
    encolarCalculo({}, [viaje(), viaje({ id: 'v-4', numero: 4, modo: 'manual', valor: '5000' })]);
    const c = await calcular('t1');
    expect(c.logistica.valor).toBe(75000);
    expect(c.logistica.viajes!.map((v) => v.numero)).toEqual([2, 4]);
    // Tres selects de `db`: trámite, servicios y viajes. La tabla de viajes se consulta en cada cálculo.
    expect(selectMock).toHaveBeenCalledTimes(3);
  });
});

describe('conceptoLogistica — la función pura', () => {
  it('redondea la suma a dos decimales', () => {
    const c = conceptoLogistica({ valor: 10.005, origen: 'Tarifa genérica', bloquea: false }, [viaje({ valor: '0.001' })]);
    expect(c.valor).toBe(10.01);
  });

  it('con base bloqueada, `valor` es null y el origen se conserva tal cual', () => {
    const c = conceptoLogistica({ valor: null, origen: 'No configurado', bloquea: true }, [viaje()]);
    expect(c).toMatchObject({ valor: null, origen: 'No configurado', bloquea: true, tarifa: null, totalViajes: 2 });
  });
});

describe('liquidar — sella la logística con los viajes leídos DENTRO de la transacción (AC6)', () => {
  const sinBolsa = { companiaId: null, soatId: null, soatOrganismo: null, impuestoId: null, impuestoOrganismo: null, derechoId: null, derechoOrganismo: null };

  function encolar(viajesPrevios: unknown[]) {
    selectMock
      .mockReturnValueOnce(chain([]))                 // liquidacionDe
      .mockReturnValueOnce(chain([filaCompleta()]))   // calcular
      .mockReturnValueOnce(chain([]))                 // serviciosAsignadosDe (previsualización)
      .mockReturnValueOnce(chain(viajesPrevios))      // viajesDe (previsualización)
      .mockReturnValueOnce(chain([sinBolsa]));        // identificadoresDe
  }

  it('la columna lleva tarifa + Σ de los DOS viajes (el segundo registrado entre la previsualización y la tx) y el detalle el desglose', async () => {
    // Previsualización con un viaje; bajo bloqueo hay dos. Lo sellado es lo de la lectura bajo bloqueo.
    encolar([viaje()]);
    const espia = espiarSellado([], [viaje(), VIAJE_MANUAL]);
    transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(espia.tx));

    await liquidar('t1', 1);

    const liquidacion = espia.escritas.find((e) => e.tabla === 'flito_liquidaciones')!;
    // 15.000 (tarifa por defecto de este archivo) + 35.000 + 20.000.
    expect(liquidacion.datos.valorLogistica).toBe('70000');
    expect((liquidacion.datos.detalle as Record<string, unknown>).logistica).toEqual({
      valor: 70000, origen: 'Tarifa genérica + 2 viajes adicionales', bloquea: false, tarifa: 15000,
      origenValor: 'tarifa', diferencia: null,
      viajes: [
        {
          id: 'v-2', numero: 2, modo: 'inicial', valor: 35000, tarifaVigente: 35000, motivo: 'devolucion',
          motivoDetalle: null, registradoPorNombre: 'Luis', registradoEn: '2026-09-10T14:00:00.000Z',
        },
        {
          id: 'v-3', numero: 3, modo: 'manual', valor: 20000, tarifaVigente: 35000, motivo: 'otro',
          motivoDetalle: 'Recogida en otra sede', registradoPorNombre: 'Marta', registradoEn: '2026-09-11T09:30:00.000Z',
        },
      ],
      totalViajes: 3,
    });
    // 865.000 + 55.000 = 920.000 de base; × 0,004 = 3.680. Con la previsualización (un viaje) serían
    // 900.000 / 3.600 / 903.600.
    expect(liquidacion.datos.baseGmf).toBe('920000');
    expect(liquidacion.datos.valorGmf).toBe('3680');
    expect(liquidacion.datos.total).toBe('923680');
    // La bitácora congela el mismo desglose.
    const evento = espia.escritas.find((e) => e.tabla === 'flito_liquidacion_eventos')!;
    expect(evento.datos.snapshot).toMatchObject({
      logistica: { valor: 70000, tarifa: 15000, totalViajes: 3, viajes: [{ numero: 2 }, { numero: 3 }] },
      total: 923680,
    });
  });

  it('los viajes se leen con el `tx` y DESPUÉS del FOR UPDATE, nunca con `db` (M-VL6)', async () => {
    encolar([]);
    const espia = espiarSellado([], [viaje()]);
    transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(espia.tx));

    await liquidar('t1', 1);

    expect(espia.orden).toEqual(['bloqueo:for:update', 'documental', 'servicios', 'viajes']);
    // Los CINCO selects de `db` son los de fuera de la tx (liquidación, cálculo, servicios, viajes,
    // identificadores). Un sexto sería la relectura de viajes con `db`, que es justo el mutante.
    expect(selectMock).toHaveBeenCalledTimes(5);
    // Y lo sellado es lo leído bajo bloqueo (un viaje), no lo de la previsualización (ninguno).
    const liquidacion = espia.escritas.find((e) => e.tabla === 'flito_liquidaciones')!;
    expect(liquidacion.datos.valorLogistica).toBe('50000');
  });

  it('sin viajes, `viajes` se escribe igual como array vacío y `totalViajes` 1', async () => {
    encolar([]);
    const espia = espiarSellado([], []);
    transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(espia.tx));

    await liquidar('t1', 1);

    const liquidacion = espia.escritas.find((e) => e.tabla === 'flito_liquidaciones')!;
    expect(liquidacion.datos.valorLogistica).toBe('15000');
    expect((liquidacion.datos.detalle as Record<string, unknown>).logistica).toEqual({
      valor: 15000, origen: 'Tarifa genérica', bloquea: false, tarifa: 15000, viajes: [], totalViajes: 1,
      origenValor: 'tarifa', diferencia: null,
    });
  });
});

describe('salidasDe — la logística con viajes es UNA salida por la suma (AC7)', () => {
  it('90.000 en tres viajes → una sola salida `logistica`, sin organismo, llave por trámite; ninguna por viaje (M-VL7)', async () => {
    tarifaLogistica35();
    encolarCalculo({}, [viaje(), VIAJE_MANUAL]);
    const c = await calcular('t1');
    const salidas = salidasDe(c, {
      companiaId: 7, soatId: 's1', soatOrganismo: 'ORG', impuestoId: 'i1', impuestoOrganismo: 'ORG',
      derechoId: 'd1', derechoOrganismo: 'ORG',
    });

    const logistica = salidas.filter((s) => s.concepto === 'logistica');
    expect(logistica).toEqual([{ concepto: 'logistica', valor: 90000, organismoCodigo: null, llave: 'tramite:t1:logistica' }]);
    expect(salidas.some((s) => s.concepto.includes('viaje') || s.llave.includes('viaje'))).toBe(false);
    expect(salidas.filter((s) => s.valor === 35000)).toHaveLength(0);
    expect(salidas.at(-1)).toEqual({ concepto: 'gmf', valor: c.valorGmf, organismoCodigo: null, llave: 'tramite:t1:gmf' });
    expect(c.valorGmf).toBe(3760);
  });
});

describe('leer una liquidación sellada — la logística sale del detalle y nunca de la tabla de viajes (AC9)', () => {
  const base = {
    id: 'l1', tramiteId: 't1', estado: 'liquidado', valorSoat: '450000', valorImpuesto: '120000',
    valorDerecho: '80000', valorTramiteDigital: '200000', valorLogistica: '35000', valorServiciosAdicionales: null,
    baseGmf: '885000', tasaGmf: '0.004', valorGmf: '3540', total: '888540',
    liquidadoEn: new Date('2026-08-01T10:00:00Z'), facturadoEn: null,
  };

  it('sello anterior a esta HU (detalle.logistica sin `viajes`): valor de la columna, `viajes` y `totalViajes` null (M-VL8)', async () => {
    selectMock
      .mockReturnValueOnce(chain([{ ...base, detalle: { logistica: { valor: 35000, origen: 'Tarifa genérica', bloquea: false } } }]))
      .mockReturnValueOnce(chain([{ idFlit: 'FLIT-1' }]));
    const dto = await liquidacionDe('t1');
    expect(dto!.logistica).toEqual({
      valor: 35000, origen: 'Tarifa genérica', bloquea: false, tarifa: null, viajes: null, totalViajes: null,
      origenValor: null, diferencia: null,
    });
  });

  it('sello sin `detalle.logistica`: valor de la columna, origen «Sellado» y nulos', async () => {
    selectMock
      .mockReturnValueOnce(chain([{ ...base, detalle: {} }]))
      .mockReturnValueOnce(chain([{ idFlit: 'FLIT-1' }]));
    const dto = await liquidacionDe('t1');
    expect(dto!.logistica).toEqual({
      valor: 35000, origen: 'Sellado', bloquea: false, tarifa: null, viajes: null, totalViajes: null,
      origenValor: null, diferencia: null,
    });
  });

  it('sello de esta HU con `viajes: []`: se lee vacío y con `totalViajes` 1, sin confundirlo con «sin snapshot»', async () => {
    selectMock
      .mockReturnValueOnce(chain([{
        ...base,
        detalle: { logistica: { valor: 35000, origen: 'Tarifa genérica', bloquea: false, tarifa: 35000, viajes: [], totalViajes: 1 } },
      }]))
      .mockReturnValueOnce(chain([{ idFlit: 'FLIT-1' }]));
    const dto = await liquidacionDe('t1');
    expect(dto!.logistica).toEqual({
      valor: 35000, origen: 'Tarifa genérica', bloquea: false, tarifa: 35000, viajes: [], totalViajes: 1,
      origenValor: null, diferencia: null,
    });
  });

  it('sello con desglose: devuelve los viajes congelados aunque la tabla viva haya cambiado, sin consultarla (M-VL9)', async () => {
    const snapshot = [{
      id: 'v-2', numero: 2, modo: 'inicial', valor: 35000, tarifaVigente: 35000, motivo: 'devolucion',
      motivoDetalle: null, registradoPorNombre: 'Luis', registradoEn: '2026-09-10T14:00:00.000Z',
    }];
    selectMock
      .mockReturnValueOnce(chain([{
        ...base, valorLogistica: '70000',
        detalle: { logistica: { valor: 70000, origen: 'Tarifa genérica + 1 viaje adicional', bloquea: false, tarifa: 35000, viajes: snapshot, totalViajes: 2 } },
      }]))
      .mockReturnValueOnce(chain([{ idFlit: 'FLIT-1' }]));
    const dto = await liquidacionDe('t1');
    expect(dto!.logistica.viajes).toEqual(snapshot);
    expect(dto!.logistica.valor).toBe(70000);
    expect(dto!.logistica.totalViajes).toBe(2);
    // DOS consultas y ninguna más: la liquidación y el idFlit. Una tercera sería la tabla de viajes.
    expect(selectMock).toHaveBeenCalledTimes(2);
  });
});

// ───────── HU #12654: el valor documental manda en trámite digital y en el viaje 1 de la logística ─────────
//
// Mutantes que estos casos matan (los del AC y los del diseño):
//   · AC1-M1 — leer `tarifaDe()` aunque haya documental (y sellar la tarifa): cae «85.000, no 80.000»
//     y «tarifaDe no se consulta para el trámite digital».
//   · AC1-M2 — escribir `origenValor: 'tarifa'` con documental: cae el `toEqual` del detalle.
//   · AC1-M3 — con documental y tarifa no configurada, seguir bloqueando: cae «no bloquea».
//   · (9)     — mirar el documental ANTES de decidir `gestionaLogistica`: cae «autogestionada + comprobante ⇒ NULL».
//   · AC2-M  — poner el documental sobre la suma (tarifa + viajes) o sumar el viaje 1 dos veces: cae «155.000».
//   · (10)    — sumar la diferencia documental al valor de `conceptoServicios`: cae «se sella 50.000 y Σ items cuadra».
//   · AC4-M  — meter la diferencia pendiente en `faltantes`: cae «se sella con diferencia pendiente».
//   · AC5-M  — sellar con `previo.tramiteDigital` sin releer con el `tx`: cae «comprobante aplicado entre calcular y la tx».
//   · AC5-M2 — `aDto` lanzando o devolviendo `undefined` sin las claves: cae «sello anterior se lee con null».

const { baseDeLogistica, conceptoServicios, documentalesDe } = await import('../../src/modules/flito-liquidacion/flito-liquidacion.service.js');

/** Las columnas documentales de la fila del cálculo para UN concepto (`td` | `lg` | `sa`). */
function doc(concepto: 'Td' | 'Lg' | 'Sa', valor: string, diferencia: string, aceptada = false) {
  const valorKey = { Td: 'docTramiteDigital', Lg: 'docLogistica', Sa: 'docServiciosAdicionales' }[concepto];
  return {
    [valorKey]: valor, [`docComprobante${concepto}Id`]: `c-${concepto.toLowerCase()}`,
    [`docDiferencia${concepto}`]: diferencia, [`docAceptada${concepto}`]: aceptada,
  };
}

/** Tarifas de los AC: trámite digital 80.000 y logística 120.000. */
function tarifasDeLosAc() {
  tarifaDeMock.mockImplementation(async (_c: unknown, concepto: string) =>
    concepto === 'tramite_digital'
      ? { valor: 80000, origen: 'especifica' }
      : { valor: 120000, origen: 'generica' });
}

const SIN_BOLSA = { companiaId: null, soatId: null, soatOrganismo: null, impuestoId: null, impuestoOrganismo: null, derechoId: null, derechoOrganismo: null };

describe('AC1 — trámite digital se sella con el documental y deja origen y diferencia en el detalle', () => {
  beforeEach(tarifasDeLosAc);

  it('con documental se sella 85.000, no 80.000: calcular() lo proyecta con faltantes vacío y NO consulta tarifaDe para el trámite digital (AC1-M1, AC1-M2)', async () => {
    encolarCalculo(doc('Td', '85000', '5000'), []);
    const c = await calcular('t1');
    expect(c.tramiteDigital).toEqual({
      valor: 85000, origen: 'Valor documental (comprobante c-td)', bloquea: false, origenValor: 'documental',
      diferencia: { comprobanteId: 'c-td', importe: 5000, aceptada: false },
    });
    expect(c.faltantes).toEqual([]);
    expect(tarifaDeMock.mock.calls.map((a) => a[1])).toEqual(['logistica']);
    // 450.000 + 120.000 + 80.000 + 85.000 + 120.000 = 855.000; con la tarifa serían 850.000.
    expect(c.baseGmf).toBe(855000);
    expect(c.valorGmf).toBe(3420);
    expect(c.total).toBe(858420);
    // Las salidas de las bolsas se calculan con el documental.
    const salidas = salidasDe(c, { ...SIN_BOLSA, companiaId: 7 });
    expect(salidas.find((s) => s.concepto === 'tramite_digital')).toEqual({ concepto: 'tramite_digital', valor: 85000, organismoCodigo: null, llave: 'tramite:t1:tramite_digital' });
  });

  it('liquidar: la columna, el detalle, la base del GMF y el total llevan el documental; el detalle conserva origenValor y la diferencia (no aceptada)', async () => {
    selectMock
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([filaCompleta(doc('Td', '85000', '5000'))]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([SIN_BOLSA]));
    const espia = espiarSellado([], [], [doc('Td', '85000', '5000')]);
    transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(espia.tx));

    const dto = await liquidar('t1', 1);

    const liquidacion = espia.escritas.find((e) => e.tabla === 'flito_liquidaciones')!;
    expect(liquidacion.datos.valorTramiteDigital).toBe('85000');
    expect((liquidacion.datos.detalle as Record<string, unknown>).tramiteDigital).toEqual({
      valor: 85000, origen: 'Valor documental (comprobante c-td)', bloquea: false, origenValor: 'documental',
      diferencia: { comprobanteId: 'c-td', importe: 5000, aceptada: false },
    });
    expect(liquidacion.datos.baseGmf).toBe('855000');
    expect(liquidacion.datos.valorGmf).toBe('3420');
    expect(liquidacion.datos.total).toBe('858420');
    expect(dto.estado).toBe('liquidado');
  });

  it('sin comprobante: la tarifa, como hoy, con origenValor tarifa y diferencia null', async () => {
    encolarCalculo({}, []);
    const c = await calcular('t1');
    expect(c.tramiteDigital).toEqual({ valor: 80000, origen: 'Tarifa de Traspaso', bloquea: false, origenValor: 'tarifa', diferencia: null });
    expect(tarifaDeMock).toHaveBeenCalledWith(7, 'tramite_digital', 'Traspaso', null);
  });

  it('tarifa NO configurada + comprobante: no bloquea, el valor es el documental y la diferencia es el valor entero (AC1-M3)', async () => {
    tarifaDeMock.mockResolvedValue({ valor: null, origen: 'no_configurada' });
    // `diferencia_tarifa` la escribió aplicar como valor − 0: el importe es el valor.
    encolarCalculo({ ...doc('Td', '85000', '85000'), logisticaAutogestionable: true }, []);
    const c = await calcular('t1');
    expect(c.tramiteDigital).toMatchObject({ valor: 85000, bloquea: false, origenValor: 'documental', diferencia: { importe: 85000, comprobanteId: 'c-td' } });
    expect(c.faltantes).toEqual([]);
  });
});

describe('AC2 — logística: el documental es el viaje 1 dentro de baseLogistica; los viajes se suman encima; la autogestión manda', () => {
  beforeEach(tarifasDeLosAc);
  const VIAJES = [viaje({ valor: '30000', tarifaVigente: '120000' }), viaje({ id: 'v-3', numero: 3, modo: 'manual', valor: '25000', tarifaVigente: '120000', registradoPorNombre: 'Marta' })];

  it('100.000 documental + 30.000 + 25.000 = 155.000, tarifa (viaje 1) 100.000, 3 viajes, origen documental con el sufijo, diferencia −20.000 (AC2-M)', async () => {
    encolarCalculo(doc('Lg', '100000', '-20000'), VIAJES);
    const c = await calcular('t1');
    expect(c.logistica).toMatchObject({
      valor: 155000, tarifa: 100000, totalViajes: 3, bloquea: false,
      origen: 'Valor documental (comprobante c-lg) + 2 viajes adicionales', origenValor: 'documental',
      diferencia: { comprobanteId: 'c-lg', importe: -20000, aceptada: false },
    });
    expect(c.logistica.viajes!.map((v) => v.valor)).toEqual([30000, 25000]);
    expect(tarifaDeMock.mock.calls.map((a) => a[1])).toEqual(['tramite_digital']);
    // La inversa exacta sigue funcionando con el origen nuevo.
    expect(baseDeLogistica(c.logistica)).toEqual({
      valor: 100000, origen: 'Valor documental (comprobante c-lg)', bloquea: false, origenValor: 'documental',
      diferencia: { comprobanteId: 'c-lg', importe: -20000, aceptada: false },
    });
  });

  it('liquidar sella valor_logistica = 155.000 con el mismo detalle', async () => {
    selectMock
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([filaCompleta(doc('Lg', '100000', '-20000'))]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain(VIAJES))
      .mockReturnValueOnce(chain([SIN_BOLSA]));
    const espia = espiarSellado([], VIAJES, [doc('Lg', '100000', '-20000')]);
    transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(espia.tx));
    await liquidar('t1', 1);
    const liquidacion = espia.escritas.find((e) => e.tabla === 'flito_liquidaciones')!;
    expect(liquidacion.datos.valorLogistica).toBe('155000');
    expect((liquidacion.datos.detalle as Record<string, unknown>).logistica).toMatchObject({
      valor: 155000, tarifa: 100000, totalViajes: 3, origenValor: 'documental', diferencia: { importe: -20000, aceptada: false, comprobanteId: 'c-lg' },
    });
  });

  it('autogestionada + comprobante ⇒ NULL: la autogestión decide antes de mirar el documental (mutante (9))', async () => {
    encolarCalculo({ ...doc('Lg', '100000', '-20000'), logisticaAutogestionable: true }, VIAJES);
    const c = await calcular('t1');
    expect(c.logistica).toEqual({
      valor: null, origen: 'La compañía autogestiona su logística', tarifa: null, viajes: [], totalViajes: 0,
      bloquea: false, origenValor: null, diferencia: null,
    });
    expect(c.baseGmf).toBe(730000);
  });

  it('autogestionada CON excepción vigente + comprobante: se sella con el documental + viajes', async () => {
    encolarCalculo({ ...doc('Lg', '100000', '-20000'), logisticaAutogestionable: true, logisticaExcepcion: true }, VIAJES);
    const c = await calcular('t1');
    expect(c.logistica).toMatchObject({ valor: 155000, tarifa: 100000, origenValor: 'documental' });
  });
});

describe('AC3 — servicios adicionales se sellan con el catálogo; el comprobante solo deja la diferencia (mutante (10))', () => {
  beforeEach(tarifasDeLosAc);
  const DOS = [servicio({ valor: '30000' }), servicio({ id: 'sa-2', tipoId: 'tipo-2', nombre: 'Diagnóstico', valor: '20000' })];

  it('se sella 50.000 y Σ items cuadra: valor = catálogo, origenValor catalogo, diferencia 5.000 del comprobante de 55.000', async () => {
    selectMock
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([filaCompleta(doc('Sa', '55000', '5000'))]))
      .mockReturnValueOnce(chain(DOS))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([SIN_BOLSA]));
    const espia = espiarSellado(DOS, [], [doc('Sa', '55000', '5000')]);
    transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(espia.tx));
    await liquidar('t1', 1);
    const liquidacion = espia.escritas.find((e) => e.tabla === 'flito_liquidaciones')!;
    expect(liquidacion.datos.valorServiciosAdicionales).toBe('50000');
    const sa = (liquidacion.datos.detalle as Record<string, unknown>).serviciosAdicionales as { items: Array<{ valor: number }> };
    expect(sa).toEqual({
      valor: 50000, origen: 'asignacion', bloquea: false, origenValor: 'catalogo',
      items: [{ tipoId: 'tipo-1', nombre: 'Paz y salvo', valor: 30000 }, { tipoId: 'tipo-2', nombre: 'Diagnóstico', valor: 20000 }],
      diferencia: { comprobanteId: 'c-sa', importe: 5000, aceptada: false },
    });
    // Σ items == columna: lo que Siigo factura línea a línea (servicios_no_cuadran) sigue cuadrando.
    expect(sa.items.reduce((a, i) => a + i.valor, 0)).toBe(Number(liquidacion.datos.valorServiciosAdicionales));
    // 450.000 + 120.000 + 80.000 + 80.000 + 120.000 + 50.000 = 900.000 (con 55.000 serían 905.000).
    expect(liquidacion.datos.baseGmf).toBe('900000');
  });

  it('conceptoServicios es pura: el documental no cambia el valor ni los items, solo anota la diferencia', () => {
    const c = conceptoServicios(DOS, { valor: 55000, diferencia: { comprobanteId: 'c-sa', importe: 5000, aceptada: true } });
    expect(c.valor).toBe(50000);
    expect(c.diferencia).toEqual({ comprobanteId: 'c-sa', importe: 5000, aceptada: true });
    expect(conceptoServicios(DOS).diferencia).toBeNull();
  });

  it('ninguna línea «Ajuste por comprobante» en siigo/ ni en flito-liquidacion/', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const archivos = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? archivos(p) : p.endsWith('.ts') ? [p] : []; });
    for (const modulo of ['siigo', 'flito-liquidacion']) {
      for (const f of archivos(join(process.cwd(), 'src/modules', modulo))) expect(readFileSync(f, 'utf8'), f).not.toMatch(/Ajuste por comprobante/);
    }
  });
});

describe('AC4 — una diferencia no aceptada no bloquea; el sello la conserva como pendiente', () => {
  beforeEach(tarifasDeLosAc);

  it('se sella con diferencia pendiente: 200 liquidado, faltantes vacío, aceptada: false en el detalle (AC4-M)', async () => {
    selectMock
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([filaCompleta(doc('Td', '85000', '5000'))]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([SIN_BOLSA]));
    const espia = espiarSellado([], [], [doc('Td', '85000', '5000')]);
    transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(espia.tx));
    // Ni LiquidacionBloqueadaError ni LiquidacionError: la diferencia pendiente no es un faltante.
    await expect(liquidar('t1', 1)).resolves.toMatchObject({ estado: 'liquidado', faltantes: [] });
    expect(transactionMock).toHaveBeenCalledTimes(1);
    const liquidacion = espia.escritas.find((e) => e.tabla === 'flito_liquidaciones')!;
    expect((liquidacion.datos.detalle as { tramiteDigital: { diferencia: { aceptada: boolean } } }).tramiteDigital.diferencia.aceptada).toBe(false);
  });

  it('la diferencia (aceptada o no) nunca entra en faltantes ni en LiquidacionBloqueadaError', async () => {
    encolarCalculo({ ...doc('Td', '85000', '5000'), ...doc('Lg', '100000', '-20000', true) }, []);
    const c = await calcular('t1');
    expect(c.faltantes).toEqual([]);
    expect(c.logistica.diferencia).toEqual({ comprobanteId: 'c-lg', importe: -20000, aceptada: true });
  });

  it('liquidacionDe() devuelve el detalle sellado tal cual (aceptada: false congelado) sin consultar flito_comprobantes', async () => {
    const detalle = {
      tramiteDigital: { valor: 85000, origen: 'Valor documental (comprobante c-td)', bloquea: false, origenValor: 'documental', diferencia: { comprobanteId: 'c-td', importe: 5000, aceptada: false } },
      logistica: { valor: 120000, origen: 'Tarifa genérica', bloquea: false, tarifa: 120000, viajes: [], totalViajes: 1, origenValor: 'tarifa', diferencia: null },
      serviciosAdicionales: { valor: null, origen: 'asignacion', bloquea: false, items: [], origenValor: 'catalogo', diferencia: null },
    };
    selectMock
      .mockReturnValueOnce(chain([{ id: 'l1', tramiteId: 't1', estado: 'liquidado', detalle, valorTramiteDigital: '85000', valorLogistica: '120000', valorServiciosAdicionales: null, baseGmf: '1', tasaGmf: '0.004', valorGmf: '0', total: '1', liquidadoEn: new Date(), facturadoEn: null }]))
      .mockReturnValueOnce(chain([{ idFlit: 'FLIT-1' }]));
    const dto = await liquidacionDe('t1');
    expect(dto!.tramiteDigital).toEqual(detalle.tramiteDigital);
    expect(dto!.logistica).toEqual(detalle.logistica);
    expect(dto!.serviciosAdicionales).toEqual(detalle.serviciosAdicionales);
    expect(selectMock).toHaveBeenCalledTimes(2);
  });
});

describe('AC5 — el documental se relee bajo el bloqueo del trámite (lo sellado es lo aplicado al COMMIT)', () => {
  beforeEach(tarifasDeLosAc);

  it('comprobante aplicado entre calcular y la tx se sella: la relectura va con el tx, tras el FOR UPDATE y antes de servicios y viajes (AC5-M)', async () => {
    // Previsualización SIN comprobante (tarifa 80.000); bajo bloqueo hay uno de 85.000.
    selectMock
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([filaCompleta()]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([SIN_BOLSA]));
    const espia = espiarSellado([], [], [doc('Td', '85000', '5000')]);
    transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(espia.tx));

    await liquidar('t1', 1);

    expect(espia.orden).toEqual(['bloqueo:for:update', 'documental', 'servicios', 'viajes']);
    expect(espia.tx.select).toHaveBeenCalledTimes(4);
    // Los CINCO selects de `db` son los de fuera de la tx: ninguna relectura documental con `db`.
    expect(selectMock).toHaveBeenCalledTimes(5);
    const liquidacion = espia.escritas.find((e) => e.tabla === 'flito_liquidaciones')!;
    expect(liquidacion.datos.valorTramiteDigital).toBe('85000');
    expect((liquidacion.datos.detalle as Record<string, unknown>).tramiteDigital).toMatchObject({ origenValor: 'documental', diferencia: { comprobanteId: 'c-td' } });
    expect(liquidacion.datos.baseGmf).toBe('855000');
  });

  it('la logística también se relee: comprobante de logística aplicado entre medias ⇒ viaje 1 documental + viajes', async () => {
    selectMock
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([filaCompleta()]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([SIN_BOLSA]));
    const espia = espiarSellado([], [viaje({ valor: '30000' })], [doc('Lg', '100000', '-20000')]);
    transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(espia.tx));
    await liquidar('t1', 1);
    const liquidacion = espia.escritas.find((e) => e.tabla === 'flito_liquidaciones')!;
    expect(liquidacion.datos.valorLogistica).toBe('130000');
    expect((liquidacion.datos.detalle as Record<string, unknown>).logistica).toMatchObject({ tarifa: 100000, totalViajes: 2, origenValor: 'documental' });
  });

  it('documentalesDe(): trámite sin fila ⇒ las tres en null; con fila, la lee por concepto', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    expect(await documentalesDe(kdbLike(), 't1')).toEqual({ tramiteDigital: null, logistica: null, serviciosAdicionales: null });
    selectMock.mockReturnValueOnce(chain([{ ...doc('Td', '85000', '5000'), ...doc('Sa', '55000', '5000', true) }]));
    expect(await documentalesDe(kdbLike(), 't1')).toEqual({
      tramiteDigital: { valor: 85000, diferencia: { comprobanteId: 'c-td', importe: 5000, aceptada: false } },
      logistica: null,
      serviciosAdicionales: { valor: 55000, diferencia: { comprobanteId: 'c-sa', importe: 5000, aceptada: true } },
    });
  });

  it('un sello anterior a esta HU se lee con origenValor null y diferencia null (nunca lanza) (AC5-M2)', async () => {
    selectMock
      .mockReturnValueOnce(chain([{
        id: 'l1', tramiteId: 't1', estado: 'liquidado',
        detalle: { tramiteDigital: { valor: 200000, origen: 'Tarifa de Traspaso', bloquea: false }, logistica: { valor: 15000, origen: 'Tarifa genérica', bloquea: false, tarifa: 15000, viajes: [], totalViajes: 1 }, serviciosAdicionales: { valor: null, origen: 'asignacion', bloquea: false, items: [] } },
        valorTramiteDigital: '200000', valorLogistica: '15000', valorServiciosAdicionales: null, baseGmf: '1', tasaGmf: '0.004', valorGmf: '0', total: '1', liquidadoEn: new Date(), facturadoEn: null,
      }]))
      .mockReturnValueOnce(chain([{ idFlit: 'FLIT-1' }]));
    const dto = await liquidacionDe('t1');
    expect(dto!.tramiteDigital).toEqual({ valor: 200000, origen: 'Tarifa de Traspaso', bloquea: false, origenValor: null, diferencia: null });
    expect(dto!.logistica).toMatchObject({ valor: 15000, tarifa: 15000, origenValor: null, diferencia: null });
    expect(dto!.serviciosAdicionales).toMatchObject({ valor: null, items: [], origenValor: null, diferencia: null });
  });
});

/** `db` del mock como ejecutor de `documentalesDe` (mismo `select` que el resto del archivo). */
function kdbLike() {
  return { select: selectMock } as never;
}
