// Siigo — enviar una selección a facturación electrónica (HU #11328). AC1, AC2, AC3.
//
// Este servicio no decide casi nada, y por eso lo que hay que probar no es el camino feliz sino que
// COMPONE bien: que no reimplemente la elegibilidad, que no reimplemente la idempotencia y que un
// trámite malo no se lleve por delante a los demás. Los tres se comprueban por mutación:
//
//   * si alguien pasa la lista entera a `encolar` en vez de trámite a trámite, sale UN lote para
//     todos y falla el test del AC1;
//   * si alguien redacta aquí los motivos del rechazo, dejan de ser los objetos que devolvió la
//     elegibilidad y falla el de la propagación literal;
//   * si alguien quita el `try` del bucle, un fallo en el segundo trámite deja sin respuesta a los
//     otros dos y falla el de la selección.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ElegibilidadTramite, MotivoElegibilidad } from '@operaciones/shared-types';

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(),
    transaction: vi.fn(), execute: vi.fn(),
  },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const elegibilidadMock = vi.fn();
vi.mock('../../src/modules/siigo/facturacion.elegibilidad.service.js', () => ({
  evaluarElegibilidad: (...a: unknown[]) => elegibilidadMock(...a),
  TOPE_TRAMITES_ELEGIBILIDAD: 400,
}));

const encolarMock = vi.fn();
vi.mock('../../src/modules/siigo/facturacion.cola.service.js', () => ({
  encolar: (...a: unknown[]) => encolarMock(...a),
  colaDeTramites: vi.fn(),
  SiigoColaError: class SiigoColaError extends Error {},
}));

const frenoMock = vi.fn();
vi.mock('../../src/modules/siigo/siigo.freno.service.js', () => ({
  exigirIntegracionNoFrenada: (...a: unknown[]) => frenoMock(...a),
  SiigoIntegracionFrenadaError: class SiigoIntegracionFrenadaError extends Error {},
  OPERACION_ENCOLAR: 'factura_encolar',
}));

const { enviarAFacturacion, TOPE_TRAMITES_ENVIO } =
  await import('../../src/modules/siigo/facturacion.encolado.service.js');

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const B = 'bbbbbbbb-2222-4111-8111-bbbbbbbbbbbb';
const C = 'cccccccc-3333-4111-8111-cccccccccccc';

const elegible = (tramiteId: string): ElegibilidadTramite =>
  ({ tramiteId, elegible: true, motivos: [] });

const noElegible = (tramiteId: string, motivos: MotivoElegibilidad[]): ElegibilidadTramite =>
  ({ tramiteId, elegible: false, motivos });

function colaOk(tramiteId: string) {
  return {
    colaId: `cola-${tramiteId.slice(0, 4)}`,
    loteId: `lote-${tramiteId.slice(0, 4)}`,
    estado: 'pendiente',
    resultado: 'encolado',
  };
}

const entrada = (tramiteIds: string[], over: Record<string, unknown> = {}) =>
  ({ tramiteIds, ambiente: 'pruebas' as const, usuarioId: 7, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  frenoMock.mockResolvedValue({ frenada: false });
  elegibilidadMock.mockImplementation(async (ids: string[]) => ids.map(elegible));
  encolarMock.mockImplementation(async (e: { tramiteIds: string[] }) => colaOk(e.tramiteIds[0]!));
});

describe('AC1 — un trámite o una selección, y cada uno con su propio lote', () => {
  it('encola trámite a trámite, no la lista entera de una vez', async () => {
    const r = await enviarAFacturacion(entrada([A, B, C]));

    // Con la lista entera saldría UN lote de tres trámites: una sola clave de idempotencia y una
    // sola factura para los tres. Además la estrategia vigente es `por_tramite`, así que ese lote
    // ni siquiera sería facturable — sería un cambio de granularidad tomado por accidente.
    expect(encolarMock).toHaveBeenCalledTimes(3);
    for (const c of encolarMock.mock.calls) expect(c[0].tramiteIds).toHaveLength(1);
    expect(encolarMock.mock.calls.map((c) => c[0].tramiteIds[0])).toEqual([A, B, C]);

    const lotes = r.items.map((i) => i.loteId);
    expect(new Set(lotes).size).toBe(3);
  });

  it('la elegibilidad se evalúa UNA sola vez para toda la selección', async () => {
    await enviarAFacturacion(entrada([A, B, C]));

    // Esa función arrastra los ocho joins del reporte de costos: una llamada por fila serían
    // doscientas consultas pesadas para responder a un botón.
    expect(elegibilidadMock).toHaveBeenCalledTimes(1);
    expect(elegibilidadMock.mock.calls[0]![0]).toEqual([A, B, C]);
  });

  it('la respuesta dice cuántos se encolaron y cuántos se rechazaron', async () => {
    elegibilidadMock.mockResolvedValue([
      elegible(A),
      noElegible(B, [{ motivo: 'ya_facturado', detalle: 'Ya tiene factura viva.' }]),
      elegible(C),
    ]);

    const r = await enviarAFacturacion(entrada([A, B, C]));

    expect(r.resumen).toMatchObject({ total: 3, encolados: 2, rechazados: 1, yaEstaban: 0 });
    // La suma del desglose cuadra con el total: ningún desenlace se pierde por el camino.
    const suma = Object.values(r.resumen.porResultado).reduce((a, b) => a + b, 0);
    expect(suma).toBe(3);
  });

  it('un trámite rechazado NO impide que los demás de la selección se encolen', async () => {
    elegibilidadMock.mockResolvedValue([
      noElegible(A, [{ motivo: 'documentacion_incompleta', detalle: 'Falta el SOAT.' }]),
      elegible(B),
      elegible(C),
    ]);

    const r = await enviarAFacturacion(entrada([A, B, C]));

    // Quien selecciona cincuenta trámites del reporte no ha comprobado uno por uno que sean
    // elegibles. Si el primero malo tumbara la petición, la única forma de facturar sería ir de uno
    // en uno.
    expect(r.items[0]!.resultado).toBe('no_elegible');
    expect(r.items[1]!.resultado).toBe('encolado');
    expect(r.items[2]!.resultado).toBe('encolado');
    expect(encolarMock).toHaveBeenCalledTimes(2);
  });

  it('un fallo INESPERADO al encolar uno tampoco tumba a los demás', async () => {
    encolarMock.mockImplementation(async (e: { tramiteIds: string[] }) => {
      if (e.tramiteIds[0] === B) throw new Error('la base dijo que no');
      return colaOk(e.tramiteIds[0]!);
    });

    const r = await enviarAFacturacion(entrada([A, B, C]));

    expect(r.items.map((i) => i.resultado)).toEqual(['encolado', 'error', 'encolado']);
    expect(r.resumen).toMatchObject({ encolados: 2, rechazados: 1 });
    expect(r.items[1]!.detalle).toContain('la base dijo que no');
  });

  it('el detalle de un fallo se sanea: un error de drizzle trae la sentencia dentro', async () => {
    encolarMock.mockRejectedValue(new Error(
      'duplicate key value violates unique constraint\n'
      + 'failed query: insert into "siigo_cola_facturacion" ("lote_id") values ($1)\n'
      + `params: ${A}`,
    ));

    const r = await enviarAFacturacion(entrada([A]));

    // Este texto acaba en pantalla, y la sentencia que drizzle adjunta arrastra los identificadores
    // enlazados —aquí, el del trámite—. Lo que sirve para operar es lo de antes de la marca.
    expect(r.items[0]!.detalle).not.toContain('insert into');
    expect(r.items[0]!.detalle).not.toContain(A);
    expect(r.items[0]!.detalle).toContain('duplicate key');
  });

  it('los identificadores repetidos se envían una sola vez, en el orden pedido', async () => {
    const r = await enviarAFacturacion(entrada([C, A, C]));

    expect(r.items.map((i) => i.tramiteId)).toEqual([C, A]);
    expect(encolarMock).toHaveBeenCalledTimes(2);
  });

  it('el tope de la selección es el tamaño de página del reporte, y menor que el de la lectura', () => {
    // Quien marca «toda la página» tiene que poder enviarla; más alto no sirve a ninguna pantalla y
    // sí cuesta, porque son ~4 sentencias por trámite dentro de la misma petición HTTP.
    expect(TOPE_TRAMITES_ENVIO).toBe(200);
    expect(TOPE_TRAMITES_ENVIO).toBeLessThan(400);
  });
});

describe('AC2 — el rechazo llega con los motivos de la elegibilidad, TAL CUAL', () => {
  it('propaga los objetos de motivo sin reescribirlos', async () => {
    const motivos: MotivoElegibilidad[] = [
      { motivo: 'tercero_sin_vincular', detalle: 'La compañía todavía no existe como tercero.' },
      { motivo: 'compuerta_cerrada', detalle: 'Falta confirmar el concepto «logistica».' },
    ];
    elegibilidadMock.mockResolvedValue([noElegible(A, motivos)]);

    const r = await enviarAFacturacion(entrada([A]));

    // Palabra por palabra, y enumerados uno por uno: una segunda redacción del mismo diagnóstico
    // sería siempre la que se quedara vieja, y quien lee el rechazo aquí y la elegibilidad allá
    // vería dos explicaciones distintas del mismo hecho.
    expect(r.items[0]!.motivos).toEqual(motivos);
    expect(r.items[0]!.motivos).toHaveLength(2);
    expect(r.items[0]!.detalle).toBeNull();
  });

  it('no se encola nada de lo que la elegibilidad frenó', async () => {
    elegibilidadMock.mockResolvedValue([
      noElegible(A, [{ motivo: 'liquidacion_no_facturada', detalle: 'Todavía no está facturada.' }]),
    ]);

    await enviarAFacturacion(entrada([A]));

    // Ni lote, ni fila de cola: un rechazo que además deja rastro de trabajo pendiente haría que el
    // trabajador intentara emitir justo lo que se acaba de descartar.
    expect(encolarMock).not.toHaveBeenCalled();
  });

  it('un trámite sin veredicto es `error`, nunca un «no elegible» sin motivos', async () => {
    elegibilidadMock.mockResolvedValue([]);

    const r = await enviarAFacturacion(entrada([A]));

    // Un «no elegible» con la lista de motivos vacía sería justo el mensaje genérico que toda la
    // elegibilidad existe para no dar, y además taparía un fallo real haciéndolo pasar por regla de
    // negocio.
    expect(r.items[0]!.resultado).toBe('error');
    expect(r.items[0]!.motivos).toEqual([]);
    expect(r.items[0]!.detalle).toBeTruthy();
  });
});

describe('AC3 — encolar dos veces no duplica; una fallida sí admite reenvío', () => {
  it('devuelve el estado en que ya estaba, sin crear una segunda fila', async () => {
    encolarMock.mockResolvedValue({
      colaId: 'cola-1', loteId: 'lote-1', estado: 'pendiente', resultado: 'ya_en_cola',
    });

    const r = await enviarAFacturacion(entrada([A]));

    expect(r.items[0]!.resultado).toBe('ya_en_cola');
    expect(r.items[0]!.estado).toBe('pendiente');
    // No es un rechazo: refrescar una pantalla no es un problema que haya que contar como tal.
    expect(r.resumen).toMatchObject({ encolados: 0, rechazados: 0, yaEstaban: 1 });
  });

  it('lo ya enviado se informa y no se vuelve a encolar', async () => {
    encolarMock.mockResolvedValue({
      colaId: 'cola-1', loteId: 'lote-1', estado: 'enviado', resultado: 'ya_enviado',
    });

    const r = await enviarAFacturacion(entrada([A]));
    expect(r.items[0]!.resultado).toBe('ya_enviado');
    expect(r.resumen.yaEstaban).toBe(1);
  });

  it('`reactivar` viaja al encolado, y apagado por omisión', async () => {
    await enviarAFacturacion(entrada([A]));
    expect(encolarMock.mock.calls[0]![0].reactivar).toBeUndefined();

    vi.clearAllMocks();
    encolarMock.mockResolvedValue({
      colaId: 'c', loteId: 'l', estado: 'pendiente', resultado: 'reactivado',
    });
    const r = await enviarAFacturacion(entrada([A], { reactivar: true }));

    // Reactivar lo dado por perdido es una decisión de quien opera, no un efecto secundario de
    // volver a pulsar: si el encolado normal reactivara, el techo de intentos dejaría de significar
    // nada y una pantalla que reenvía al refrescar resucitaría lo que ya se descartó.
    expect(encolarMock.mock.calls[0]![0].reactivar).toBe(true);
    expect(r.items[0]!.resultado).toBe('reactivado');
    expect(r.resumen.encolados).toBe(1);
  });

  it('sin `reactivar`, lo dado por perdido se cuenta como rechazado', async () => {
    encolarMock.mockResolvedValue({
      colaId: 'c', loteId: 'l', estado: 'fallido_definitivo', resultado: 'fallido_definitivo',
    });

    const r = await enviarAFacturacion(entrada([A]));
    expect(r.resumen).toMatchObject({ encolados: 0, rechazados: 1 });
  });
});

describe('El freno corta el envío entero, y antes de tocar nada', () => {
  it('si la integración está frenada, no se evalúa ni se encola', async () => {
    frenoMock.mockRejectedValue(new Error('frenada'));

    await expect(enviarAFacturacion(entrada([A, B]))).rejects.toThrow('frenada');

    // Llenar una cola que nadie va a vaciar deja a quien envió creyendo que hay trabajo en marcha, y
    // al operador con una cola que crece mientras diagnostica.
    expect(elegibilidadMock).not.toHaveBeenCalled();
    expect(encolarMock).not.toHaveBeenCalled();
  });

  it('el freno se consulta para el ambiente del envío y con quién lo pidió', async () => {
    await enviarAFacturacion(entrada([A]));
    expect(frenoMock.mock.calls[0]![0]).toMatchObject({ ambiente: 'pruebas', usuarioId: 7 });
  });
});

describe('El ambiente lo pone quien llama al servicio, y viaja a todo lo de abajo', () => {
  it('el mismo ambiente llega a la elegibilidad y al encolado', async () => {
    await enviarAFacturacion(entrada([A], { ambiente: 'produccion' }));

    // Evaluar en un ambiente y encolar en otro daría un veredicto de la parametrización de pruebas
    // sobre una factura que sale en producción.
    expect(elegibilidadMock.mock.calls[0]![1]).toBe('produccion');
    expect(encolarMock.mock.calls[0]![0].ambiente).toBe('produccion');
    expect((await enviarAFacturacion(entrada([A], { ambiente: 'produccion' }))).ambiente)
      .toBe('produccion');
  });
});
