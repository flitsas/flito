// Siigo — el trabajador que vacía la cola de emisión (HU #11327). Un bloque por criterio.
//
// La mitad de la historia es una FUNCIÓN PURA —`planificarDesenlace`— y por eso se prueba con una
// tabla de casos: es donde se decide qué gasta intento, qué gasta espera y qué se da por perdido, y
// equivocarse ahí no produce una excepción sino una factura que deja de intentarse (o que se
// intenta para siempre). La otra mitad es el orden del ciclo, que se comprueba anotando qué pasó
// antes de qué: mirando solo el resultado, un ciclo que reconcilia después de emitir es idéntico a
// uno que lo hace antes.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ResultadoEmision } from '../../src/modules/siigo/facturacion.emision.service.js';

const emitirFacturaMock = vi.fn();
vi.mock('../../src/modules/siigo/facturacion.emision.service.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/facturacion.emision.service.js')>();
  return { ...real, emitirFactura: (ids: string[], o: unknown) => emitirFacturaMock(ids, o) };
});

const reconciliarHuerfanasMock = vi.fn().mockResolvedValue([]);
vi.mock('../../src/modules/siigo/facturacion.reconciliacion.service.js', () => ({
  reconciliarHuerfanas: (o: unknown) => reconciliarHuerfanasMock(o),
}));

const exigirIntegracionNoFrenadaMock = vi.fn().mockResolvedValue({});
vi.mock('../../src/modules/siigo/siigo.freno.service.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.freno.service.js')>();
  return { ...real, exigirIntegracionNoFrenada: (o: unknown) => exigirIntegracionNoFrenadaMock(o) };
});

const tomarLoteMock = vi.fn().mockResolvedValue([]);
const registrarDesenlaceMock = vi.fn().mockResolvedValue(true);
const liberarMock = vi.fn().mockResolvedValue(true);
vi.mock('../../src/modules/siigo/facturacion.cola.service.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/facturacion.cola.service.js')>();
  return {
    ...real,
    tomarLote: (o: unknown) => tomarLoteMock(o),
    registrarDesenlace: (i: unknown) => registrarDesenlaceMock(i),
    liberar: (a: unknown) => liberarMock(a),
  };
});

const tramitesDelLoteMock = vi.fn();
vi.mock('../../src/modules/siigo/facturacion.lote.repo.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/facturacion.lote.repo.js')>();
  return { ...real, tramitesDelLote: (id: string) => tramitesDelLoteMock(id) };
});

const circuitoAbiertoMock = vi.fn(() => false);
vi.mock('../../src/services/circuitBreaker.js', async (original) => {
  const real = await original<typeof import('../../src/services/circuitBreaker.js')>();
  return { ...real, circuitoAbierto: (n: string) => circuitoAbiertoMock(n) };
});

const { SiigoEmisionError } = await import('../../src/modules/siigo/facturacion.emision.service.js');
const { SiigoIntegracionFrenadaError } = await import('../../src/modules/siigo/siigo.freno.service.js');
const {
  LOTE_RECONCILIACION, planificarDesenlace, procesarCicloEmision,
} = await import('../../src/modules/siigo/facturacion.trabajador.service.js');

const AHORA = new Date('2026-08-11T15:00:00.000Z');
const FACTURA = 'ffffffff-1111-4111-8111-ffffffffffff';
const TRAMITE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

function fila(over: Record<string, unknown> = {}) {
  return {
    id: 'cola-1', loteId: 'lote-1', intentos: 0, esperas: 0, maxIntentos: 5, maxEsperas: 20, ...over,
  };
}

function resultado(over: Partial<ResultadoEmision> = {}): ResultadoEmision {
  return {
    desenlace: 'emitida',
    facturaId: FACTURA,
    siigoInvoiceId: 'inv-1', numero: '1', cufe: null, publicUrl: null, totalSiigo: '1000.00',
    requiereRevision: false, revisionMotivo: null, errorCode: null, errorDetalle: null, motivos: [],
    ...over,
  };
}

const CICLO = {
  ambiente: 'pruebas' as const,
  plazoMs: 150_000,
  lote: 15,
  ahora: () => AHORA,
  dormir: vi.fn().mockResolvedValue(undefined),
  tomadoPor: 'host-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  reconciliarHuerfanasMock.mockResolvedValue([]);
  exigirIntegracionNoFrenadaMock.mockResolvedValue({});
  tomarLoteMock.mockResolvedValue([]);
  registrarDesenlaceMock.mockResolvedValue(true);
  liberarMock.mockResolvedValue(true);
  tramitesDelLoteMock.mockResolvedValue([TRAMITE]);
  emitirFacturaMock.mockResolvedValue(resultado());
  circuitoAbiertoMock.mockReturnValue(false);
  CICLO.dormir.mockClear();
});

// ── AC2 y AC5 — la política de reintentos ──────────────────────────────────

describe('AC2/AC5 — qué gasta intento, qué gasta espera y qué se da por perdido', () => {
  it('emitida — la fila queda enviada con su factura', () => {
    const plan = planificarDesenlace(fila(), resultado(), AHORA);
    expect(plan).toMatchObject({ estado: 'enviado', facturaId: FACTURA, desenlace: 'emitida' });
  });

  it('I3 — ya emitida: la cola converge sola sin tocar la red', () => {
    // `ya_emitida` significa que la clave ya estaba emitida y que `emitirFactura` lo resolvió SIN
    // llamar a Siigo. El trabajo está hecho aunque no lo hiciéramos nosotros; tratarlo como fallo
    // dejaría en la cola una fila eterna con su factura ya emitida.
    const plan = planificarDesenlace(fila(), resultado({ desenlace: 'ya_emitida' }), AHORA);
    expect(plan).toMatchObject({ estado: 'enviado', desenlace: 'ya_emitida' });
  });

  it('un rechazo de Siigo gasta INTENTO y agenda cita', () => {
    const plan = planificarDesenlace(
      fila({ intentos: 1 }),
      resultado({ desenlace: 'fallida', errorCode: 'entry_service', errorDetalle: 'se cayó' }),
      AHORA,
    );
    expect(plan).toMatchObject({ estado: 'error', intentos: 2, esperas: 0, errorCode: 'entry_service' });
    expect((plan as { proximoIntentoAt: Date }).proximoIntentoAt.getTime()).toBeGreaterThan(AHORA.getTime());
  });

  it('agotados los intentos — fallido_definitivo con el código y el detalle del ÚLTIMO error', () => {
    const plan = planificarDesenlace(
      fila({ intentos: 4 }),
      resultado({ desenlace: 'fallida', errorCode: 'entry_service', errorDetalle: 'sigue caído' }),
      AHORA,
    );
    expect(plan).toMatchObject({
      estado: 'fallido_definitivo', intentos: 5, errorCode: 'entry_service', errorDetalle: 'sigue caído',
    });
  });

  it('un error NO reintentable no agota intentos: se da por perdido en el primero', () => {
    // Reintentar un payload que Siigo ya evaluó y rechazó por un dato nuestro solo consigue el mismo
    // rechazo cuatro veces más, gastando cuota y engordando la proporción que mide el freno.
    const plan = planificarDesenlace(
      fila(),
      resultado({ desenlace: 'fallida', errorCode: 'parameter_required', errorDetalle: 'falta algo' }),
      AHORA,
    );
    expect(plan).toMatchObject({ estado: 'fallido_definitivo', intentos: 1 });
  });

  it('un ciclo SIN desenlace gasta espera y NO intento', () => {
    // Es la razón de que haya dos contadores. Con uno solo, un Siigo lento quema los cinco intentos
    // sin que nadie haya rechazado nada y la fila acaba dada por perdida con el documento
    // posiblemente vivo ante la DIAN.
    const plan = planificarDesenlace(
      fila({ intentos: 3 }),
      resultado({ desenlace: 'huerfana', errorCode: 'siigo_no_responde', errorDetalle: 'timeout' }),
      AHORA,
    );
    expect(plan).toMatchObject({ estado: 'error', intentos: 3, esperas: 1 });
  });

  it('otro proceso tenía la clave — espera, y con motivo legible', () => {
    const plan = planificarDesenlace(fila(), resultado({ desenlace: 'en_curso', facturaId: null }), AHORA);
    expect(plan).toMatchObject({ estado: 'error', esperas: 1, errorCode: 'emision_en_curso' });
  });

  it('agotadas las esperas — se deja de mirar, con su código', () => {
    const plan = planificarDesenlace(
      fila({ esperas: 19 }),
      resultado({ desenlace: 'huerfana', errorCode: 'siigo_no_responde', errorDetalle: 'timeout' }),
      AHORA,
    );
    expect(plan).toMatchObject({ estado: 'fallido_definitivo', esperas: 20, errorCode: 'siigo_no_responde' });
  });

  it('no elegible — las guardas ya decidieron, no hay nada que reintentar', () => {
    const plan = planificarDesenlace(
      fila(),
      resultado({ desenlace: 'no_elegible', facturaId: null, motivos: ['El cliente no tiene NIT.'] }),
      AHORA,
    );
    expect(plan).toMatchObject({
      estado: 'fallido_definitivo', intentos: 0, esperas: 0,
      errorCode: 'no_elegible', errorDetalle: 'El cliente no tiene NIT.',
    });
  });

  it('emitida sin fila local — no se queda pidiendo un trabajo que ya se hizo', () => {
    const plan = planificarDesenlace(fila(), resultado({ facturaId: null }), AHORA);
    expect(plan).toMatchObject({ estado: 'fallido_definitivo', errorCode: 'sin_factura_local' });
  });

  it('NINGÚN camino deja la fila viva sin gastar contador ni cita', () => {
    // Es el «ninguna condición produce peticiones en bucle» del AC5, comprobado sobre todos los
    // desenlaces que la emisión sabe devolver.
    const desenlaces = ['emitida', 'ya_emitida', 'en_curso', 'huerfana', 'fallida', 'no_elegible'] as const;
    for (const d of desenlaces) {
      const plan = planificarDesenlace(fila(), resultado({ desenlace: d, errorCode: 'entry_service' }), AHORA);
      if (plan.estado === 'error') {
        expect(plan.intentos + plan.esperas).toBeGreaterThan(0);
        expect(plan.proximoIntentoAt.getTime()).toBeGreaterThan(AHORA.getTime());
      } else {
        expect(['enviado', 'fallido_definitivo']).toContain(plan.estado);
      }
    }
  });

  it('el retroceso crece y tiene un techo propio, mucho mayor que el de memoria', () => {
    // `backoffMs` topaba en 30 s pasara lo que pasara: para un reintento en memoria está bien, pero
    // una fila persistida que vuelve cada 30 s contra un Siigo caído son 120 peticiones inútiles por
    // hora que además engordan la proporción de errores que mide el freno.
    const espera = (n: number): number => {
      const plan = planificarDesenlace(
        fila({ intentos: n - 1 }),
        resultado({ desenlace: 'fallida', errorCode: 'entry_service' }),
        AHORA,
      );
      return (plan as { proximoIntentoAt: Date }).proximoIntentoAt.getTime() - AHORA.getTime();
    };
    expect(espera(1)).toBe(60_000);
    expect(espera(2)).toBe(120_000);
    expect(espera(4)).toBe(480_000);
    expect(espera(4)).toBeGreaterThan(30_000);
  });
});

// ── AC4 — el barrido corre siempre ─────────────────────────────────────────

describe('AC4 — el barrido de huérfanas corre aunque no haya nada en la cola', () => {
  it('reconcilia con la cola vacía', async () => {
    tomarLoteMock.mockResolvedValue([]);
    reconciliarHuerfanasMock.mockResolvedValue([{ facturaId: 'f1', desenlace: 'emitida' }]);

    const r = await procesarCicloEmision(CICLO);

    expect(reconciliarHuerfanasMock).toHaveBeenCalledWith(
      expect.objectContaining({ ambiente: 'pruebas', limite: LOTE_RECONCILIACION }),
    );
    expect(r.reconciliadas).toBe(1);
  });

  it('reconcilia ANTES de emitir', async () => {
    // Una huérfana es, por definición, una fila que ya no tiene a nadie esperándola: si el barrido
    // fuera detrás de la emisión y el plazo se agotara, dejarían de rescatarse justo los días en que
    // hay más.
    const orden: string[] = [];
    reconciliarHuerfanasMock.mockImplementation(async () => { orden.push('reconciliar'); return []; });
    tomarLoteMock.mockImplementation(async () => { orden.push('tomar'); return []; });

    await procesarCicloEmision(CICLO);
    expect(orden).toEqual(['reconciliar', 'tomar']);
  });

  it('un barrido que falla no impide facturar', async () => {
    reconciliarHuerfanasMock.mockRejectedValue(new Error('la base falló'));
    tomarLoteMock.mockResolvedValue([fila()]);

    const r = await procesarCicloEmision(CICLO);
    expect(r.enviadas).toBe(1);
  });
});

// ── AC3 — límite de peticiones y cortacircuitos ────────────────────────────

describe('AC3 — con el cortacircuitos abierto no se hace NINGUNA petición', () => {
  it('ni siquiera se reconcilia: el circuito se mira antes que nada', async () => {
    // Las consultas del barrido morirían igual en el cortacircuitos, pero cada una dejaría un
    // `error_tecnico` en la bitácora que alimenta el freno: un servicio caído acabaría frenando la
    // integración con errores que nunca salieron de este proceso.
    circuitoAbiertoMock.mockReturnValue(true);

    const r = await procesarCicloEmision(CICLO);

    expect(r.circuitoAbierto).toBe(true);
    expect(reconciliarHuerfanasMock).not.toHaveBeenCalled();
    expect(tomarLoteMock).not.toHaveBeenCalled();
    expect(emitirFacturaMock).not.toHaveBeenCalled();
  });

  it('si se abre a mitad del ciclo, se deja de emitir y se libera lo tomado', async () => {
    tomarLoteMock.mockResolvedValue([fila({ id: 'c1' }), fila({ id: 'c2' }), fila({ id: 'c3' })]);
    let llamadas = 0;
    circuitoAbiertoMock.mockImplementation(() => {
      llamadas += 1;
      // Abierto justo antes de la segunda fila (la primera comprobación es la del ciclo).
      return llamadas > 2;
    });

    const r = await procesarCicloEmision(CICLO);

    expect(r.enviadas).toBe(1);
    expect(r.circuitoAbierto).toBe(true);
    expect(r.liberadas).toBe(2);
  });

  it('el freno se mide UNA vez por ciclo, no una por fila', async () => {
    // Es una consulta agregada sobre la bitácora: preguntarla quince veces serían quince
    // agregaciones para obtener el mismo número.
    tomarLoteMock.mockResolvedValue([fila({ id: 'c1' }), fila({ id: 'c2' })]);
    await procesarCicloEmision(CICLO);
    expect(exigirIntegracionNoFrenadaMock).toHaveBeenCalledTimes(1);
  });

  it('con la integración frenada no se toca la cola', async () => {
    exigirIntegracionNoFrenadaMock.mockRejectedValue(
      new SiigoIntegracionFrenadaError({ proporcion: 0.9, motivo: 'frenada' } as never),
    );

    const r = await procesarCicloEmision(CICLO);

    expect(r.frenada).toBe(true);
    expect(tomarLoteMock).not.toHaveBeenCalled();
    // El barrido sí corrió: rescatar huérfanas es lo que libera trámites, y no emite nada.
    expect(reconciliarHuerfanasMock).toHaveBeenCalled();
  });

  it('si el freno no se puede medir, tampoco se emite (falla cerrado)', async () => {
    // Emitir sin saber si la integración está sana es justo lo que el freno existe para impedir. El
    // coste de equivocarse por este lado son dos minutos; por el otro, que Siigo bloquee el usuario
    // API de la empresa entera.
    exigirIntegracionNoFrenadaMock.mockRejectedValue(new Error('la bitácora no responde'));

    const r = await procesarCicloEmision(CICLO);

    expect(r.frenada).toBe(true);
    expect(tomarLoteMock).not.toHaveBeenCalled();
  });

  it('ante el rechazo por límite de tasa el ciclo espera, y a la tercera se rinde', async () => {
    tomarLoteMock.mockResolvedValue([
      fila({ id: 'c1' }), fila({ id: 'c2' }), fila({ id: 'c3' }), fila({ id: 'c4' }),
    ]);
    emitirFacturaMock.mockResolvedValue(resultado({
      desenlace: 'huerfana', facturaId: null, errorCode: 'requests_limit', errorDetalle: 'cuota',
    }));

    const r = await procesarCicloEmision(CICLO);

    // Tres filas rechazadas por cuota, con espera creciente entre ellas; la cuarta ni se intenta.
    expect(emitirFacturaMock).toHaveBeenCalledTimes(3);
    expect(CICLO.dormir.mock.calls.map((c) => c[0])).toEqual([2_000, 4_000]);
    expect(r.liberadas).toBe(1);
  });
});

// ── AC6/AC7 — el ciclo, el plazo y el apagado ──────────────────────────────

describe('el ciclo procesa lo que toma y devuelve lo que no mira', () => {
  it('toma con el lote y el arrendamiento configurados', async () => {
    await procesarCicloEmision({ ...CICLO, lote: 7, arrendamientoMin: 25 });
    expect(tomarLoteMock).toHaveBeenCalledWith(expect.objectContaining({
      ambiente: 'pruebas', limite: 7, tomadoPor: 'host-1', arrendamientoMin: 25,
    }));
  });

  it('emite los trámites del lote, que salen de la pertenencia', async () => {
    tomarLoteMock.mockResolvedValue([fila({ loteId: 'lote-9' })]);
    tramitesDelLoteMock.mockResolvedValue([TRAMITE]);

    await procesarCicloEmision(CICLO);

    expect(tramitesDelLoteMock).toHaveBeenCalledWith('lote-9');
    expect(emitirFacturaMock).toHaveBeenCalledWith([TRAMITE], expect.objectContaining({
      ambiente: 'pruebas', usuarioId: null,
    }));
  });

  it('un lote sin contenido se da por perdido, no se reintenta veinte veces', async () => {
    tomarLoteMock.mockResolvedValue([fila()]);
    tramitesDelLoteMock.mockResolvedValue([]);

    const r = await procesarCicloEmision(CICLO);

    expect(emitirFacturaMock).not.toHaveBeenCalled();
    expect(r.definitivas).toBe(1);
    expect(registrarDesenlaceMock).toHaveBeenCalledWith(expect.objectContaining({
      estado: 'fallido_definitivo', errorCode: 'emision_sin_tramites',
    }));
  });

  it('un fallo de configuración no gasta los cinco intentos', async () => {
    tomarLoteMock.mockResolvedValue([fila()]);
    emitirFacturaMock.mockRejectedValue(
      new SiigoEmisionError('sin_configuracion', 'Falta el comprobante parametrizado.'),
    );

    const r = await procesarCicloEmision(CICLO);
    expect(r.definitivas).toBe(1);
    expect(registrarDesenlaceMock).toHaveBeenCalledWith(expect.objectContaining({
      estado: 'fallido_definitivo', errorCode: 'emision_sin_configuracion', intentos: 0,
    }));
  });

  it('un fallo nuestro pasajero solo gasta una espera', async () => {
    tomarLoteMock.mockResolvedValue([fila()]);
    emitirFacturaMock.mockRejectedValue(new Error('la conexión se cayó'));

    const r = await procesarCicloEmision(CICLO);
    expect(r.reintentables).toBe(1);
    expect(registrarDesenlaceMock).toHaveBeenCalledWith(expect.objectContaining({
      estado: 'error', esperas: 1, intentos: 0, desenlace: 'error_interno',
    }));
  });

  it('una fila que revienta no tumba a las otras', async () => {
    tomarLoteMock.mockResolvedValue([fila({ id: 'c1' }), fila({ id: 'c2' })]);
    emitirFacturaMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(resultado());

    const r = await procesarCicloEmision(CICLO);
    expect(r.enviadas).toBe(1);
    expect(r.reintentables).toBe(1);
  });

  it('si perdimos el arrendamiento, el desenlace no se pisa', async () => {
    tomarLoteMock.mockResolvedValue([fila()]);
    registrarDesenlaceMock.mockResolvedValue(false);

    const r = await procesarCicloEmision(CICLO);
    // No se cuenta como enviada: la fila es de otro y su desenlace lo escribirá él.
    expect(r.enviadas).toBe(0);
  });

  it('agotado el plazo, lo no mirado se libera con su cita intacta', async () => {
    tomarLoteMock.mockResolvedValue([fila({ id: 'c1' }), fila({ id: 'c2' }), fila({ id: 'c3' })]);
    // El reloj solo avanza cuando se emite, que es lo que de verdad tarda: con reintentos, un
    // timeout de 120 s y un limitador que duerme, una sola factura puede costar más que el plazo.
    let desfase = 0;
    emitirFacturaMock.mockImplementation(async () => { desfase += 2_000; return resultado(); });

    const r = await procesarCicloEmision({
      ...CICLO,
      plazoMs: 1_000,
      ahora: () => new Date(AHORA.getTime() + desfase),
    });

    expect(r.agotoPlazo).toBe(true);
    expect(r.enviadas).toBe(1);
    expect(r.liberadas).toBe(2);
    expect(liberarMock).toHaveBeenCalledWith(expect.objectContaining({ colaId: 'c2', tomadoPor: 'host-1' }));
  });

  it('AC7 — apagado limpio: se deja de tomar y se devuelve lo tomado', async () => {
    tomarLoteMock.mockResolvedValue([fila({ id: 'c1' }), fila({ id: 'c2' })]);
    let apagando = false;
    emitirFacturaMock.mockImplementation(async () => { apagando = true; return resultado(); });

    const r = await procesarCicloEmision({ ...CICLO, debeDetenerse: () => apagando });

    expect(r.detenido).toBe(true);
    expect(r.enviadas).toBe(1);
    expect(r.liberadas).toBe(1);
  });

  it('AC7 — en modo simulado el ciclo recorre la cola entera sin ambiente real', async () => {
    // No hay credenciales de Siigo en esta suite y no hace falta ninguna: el modo del módulo es
    // `mock`, y el ciclo llega hasta el final igual.
    const { modoSiigo } = await import('../../src/modules/siigo/siigo.mock.js');
    expect(modoSiigo()).toBe('mock');

    tomarLoteMock.mockResolvedValue([fila({ id: 'c1' }), fila({ id: 'c2' }), fila({ id: 'c3' })]);
    const r = await procesarCicloEmision({ ...CICLO, lote: 3 });

    expect(r).toMatchObject({ tomadas: 3, enviadas: 3, liberadas: 0, detenido: false, agotoPlazo: false });
  });
});
