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

const { calcular, facturar, liquidacionDe, liquidar, reversar, LiquidacionBloqueadaError, LiquidacionError, TASA_GMF } =
  await import('../../src/modules/flito-liquidacion/flito-liquidacion.service.js');

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
 * El `select` del `tx` (HU #12546). Dentro de la transacción, `liquidar()` consulta DOS veces y en
 * este orden: el `FOR UPDATE` sobre el trámite y, con el bloqueo tomado, la puente de servicios.
 * Invertir el orden dejaría de serializar contra asignar/quitar, y es lo que este doble fija.
 */
function txSelect(servicios: unknown[]) {
  return vi.fn()
    .mockReturnValueOnce(chain([{ id: 't1', idFlit: 'FLIT-1' }]))
    .mockReturnValue(chain(servicios));
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
      valor: 85000, origen: 'asignacion', bloquea: false,
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

/** Espía del sellado: devuelve el `tx`, lo escrito y el orden de las consultas de dentro. */
function espiarSellado(serviciosEnTx: unknown[]) {
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
  let n = 0;
  const select = vi.fn(() => {
    const esBloqueo = n++ === 0;
    const c = chain(esBloqueo ? [{ id: 't1', idFlit: 'FLIT-1' }] : serviciosEnTx) as unknown as Record<string, unknown>;
    // El bloqueo tiene que ser `FOR UPDATE` DE VERDAD: sin `.for('update')` no serializa nada.
    c.for = (modo: unknown) => { orden.push(`bloqueo:for:${String(modo)}`); return c; };
    if (!esBloqueo) orden.push('servicios');
    return c;
  });
  return { tx: { insert, select }, escritas, orden };
}

describe('liquidar — sella los servicios adicionales leyéndolos DENTRO de la transacción (AC3)', () => {
  const sinBolsa = { companiaId: null, soatId: null, soatOrganismo: null, impuestoId: null, impuestoOrganismo: null, derechoId: null, derechoOrganismo: null };

  function encolarSellado(serviciosPrevios: unknown[] = []) {
    selectMock
      .mockReturnValueOnce(chain([]))                            // liquidacionDe: no hay sellada
      .mockReturnValueOnce(chain([filaCompleta()]))              // calcular
      .mockReturnValueOnce(chain(serviciosPrevios))              // serviciosAsignadosDe (previsualización)
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

    expect(espia.orden).toEqual(['bloqueo:for:update', 'servicios']);
    expect(espia.tx.select).toHaveBeenCalledTimes(2);
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

    expect(dto!.serviciosAdicionales).toEqual({ valor: null, origen: 'Sellado', bloquea: false, items: [] });
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
    expect(txSelects).toContain('flito_bolsa_movimientos');
  });
});
