// HU #11330 — la única puerta de entrada del estado ante la DIAN (Feature #11243).
//
// Lo que esta suite protege no es «que guarde bien»: es que las cinco HU que cuelgan de aquí puedan
// construirse sin volver a discutir el modelo. Tres propiedades, y cada test dice cuál sostiene:
//
//   1. El estado ante la DIAN NO toca el estado de emisión. Son dos ejes.
//   2. La ingesta es agnóstica del origen. Si mañana el webhook de Siigo resulta que notifica el
//      estado, el sondeo pasa a ser respaldo y ningún consumidor se entera.
//   3. El historial no se reescribe, y un sondeo que repite lo mismo no lo llena de ruido.
//
// La base va mockeada, así que lo que aquí NO se puede probar son las garantías que viven en la
// migración `0137` —los disparadores de append-only, los `CHECK`, el `FOR NO KEY UPDATE`—. Esas se
// verificaron aplicando la cadena contra un PostgreSQL 16 real y provocando cada violación; el
// resultado está en el PR. `siigo-estado-dian-esquema.test.ts` cubre la otra mitad: que las dos
// copias del catálogo no se separen.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chain } from '../helpers/db.js';

const selectMock = vi.fn();
const executeMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn(),
    execute: executeMock, transaction: transactionMock,
  },
  getPoolStats: vi.fn(),
}));

// La bitácora se sustituye entera: escribe con el mismo `db` y, sin mockearla, cada llamada se
// comería un mock destinado al servicio. `sanearCuerpo` se conserva porque el saneamiento del
// payload es parte de lo que se quiere comprobar.
const registrarOperacionMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/siigo/siigo.operaciones.repo.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/modules/siigo/siigo.operaciones.repo.js')>();
  return { ...real, registrarOperacion: registrarOperacionMock };
});

const { siigoFacturaEstadosDian, siigoFacturas } = await import('../../src/db/schema.js');
const {
  aplicarEstadoDian, estadoDianVigente, historialEstadoDian, estadosDianVigentes,
  SiigoEstadoDianError,
} = await import('../../src/modules/siigo/siigo.estado-dian.service.js');

const FACTURA = '8f14e45f-ea8d-4b3a-9c2e-1a2b3c4d5e6f';
const OTRA_FACTURA = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
const CUFE = 'a'.repeat(96);

/** Una fila del historial, con lo mínimo para que el servicio la trate como «la última». */
function filaEstado(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'fila-1', facturaId: FACTURA, secuencia: 7,
    estado: 'en_validacion', cufe: null, motivo: null, fuente: 'emision',
    payload: null, registradoPor: null,
    createdAt: new Date('2026-08-01T10:00:00Z'), verificadoEn: new Date('2026-08-01T10:00:00Z'),
    ...over,
  };
}

/**
 * Monta la transacción. `factura` null = no existe. `ultima` null = la factura nunca se ha
 * consultado. Devuelve los espías para poder afirmar QUÉ tabla se tocó, que es justo la propiedad
 * número 1: el estado de emisión no se toca nunca.
 */
function montarTx(opts: {
  factura?: { id: string; ambiente: string; cufe: string | null } | null;
  ultima?: ReturnType<typeof filaEstado> | null;
} = {}) {
  const factura = opts.factura === undefined
    ? { id: FACTURA, ambiente: 'produccion', cufe: null }
    : opts.factura;
  const ultima = opts.ultima ?? null;

  const txSelect = vi.fn()
    .mockReturnValueOnce(chain(factura ? [factura] : []))
    .mockReturnValueOnce(chain(ultima ? [ultima] : []));
  const insertValues = vi.fn(() => chain([filaEstado({ id: 'fila-nueva', secuencia: 8 })]));
  const txInsert = vi.fn(() => ({ values: insertValues }));
  const updateSet = vi.fn(() => chain([]));
  const txUpdate = vi.fn(() => ({ set: updateSet }));

  transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({
    select: txSelect,
    insert: txInsert,
    // `.set()` devuelve el chain, así que `.where()` sigue funcionando sobre él.
    update: (tabla: unknown) => { txUpdate(tabla); return { set: updateSet }; },
  }));

  return { txSelect, txInsert, insertValues, txUpdate, updateSet };
}

/** Lo que se pasó a `.values()` del INSERT del historial. */
function filaInsertada(espias: ReturnType<typeof montarTx>): Record<string, unknown> {
  expect(espias.insertValues).toHaveBeenCalledTimes(1);
  return espias.insertValues.mock.calls[0]![0] as Record<string, unknown>;
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  // AC7 se afirma de la única forma que no admite discusión: si algo saliera a la red, este espía
  // lo vería.
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AC1 — el estado ante la DIAN es un eje propio', () => {
  it('registrar que la DIAN la aceptó no toca la fila de la factura', async () => {
    // La propiedad que sostiene toda la Feature: `estado` de `siigo_facturas` pertenece a la
    // Feature #11242. Si esta función lo tocara, una factura anulada dejaría de constar como
    // emitida — y el documento existe ante la DIAN y existirá siempre.
    const espias = montarTx({ factura: { id: FACTURA, ambiente: 'produccion', cufe: CUFE } });

    await aplicarEstadoDian({ facturaId: FACTURA, estado: 'aceptada', fuente: 'sondeo' });

    expect(espias.txInsert).toHaveBeenCalledWith(siigoFacturaEstadosDian);
    expect(espias.txUpdate).not.toHaveBeenCalledWith(siigoFacturas);
  });

  it('admite los cuatro estados, incluida anulada, sin migrar nada', async () => {
    // `anulada` está en el catálogo desde el primer día porque la nota crédito es una pregunta
    // abierta: la respuesta no puede llegar acompañada de un ALTER TABLE.
    for (const estado of ['en_validacion', 'aceptada', 'rechazada', 'anulada'] as const) {
      const espias = montarTx();
      await aplicarEstadoDian({ facturaId: FACTURA, estado, fuente: 'manual' });
      expect(filaInsertada(espias).estado).toBe(estado);
    }
  });

  it('un estado que no está en el catálogo se rechaza antes de abrir transacción', async () => {
    await expect(aplicarEstadoDian({
      facturaId: FACTURA, estado: 'devuelta' as never, fuente: 'sondeo',
    })).rejects.toMatchObject({ codigo: 'estado_invalido' });
    expect(transactionMock).not.toHaveBeenCalled();
  });
});

describe('AC2 — una sola puerta de entrada, venga de donde venga', () => {
  it('los cuatro orígenes entran por la misma función y quedan registrados', async () => {
    // Incluido `webhook`, que hoy nadie escribe: el grupo Webhooks de Siigo está sin revisar. Si
    // mañana notifica el estado, el sondeo pasa a ser respaldo y el consumidor no se entera.
    for (const fuente of ['emision', 'sondeo', 'webhook', 'manual'] as const) {
      const espias = montarTx();
      await aplicarEstadoDian({ facturaId: FACTURA, estado: 'aceptada', fuente });
      expect(filaInsertada(espias).fuente).toBe(fuente);
    }
  });

  it('un origen inventado se rechaza: nadie escribe en el historial por su cuenta', async () => {
    await expect(aplicarEstadoDian({
      facturaId: FACTURA, estado: 'aceptada', fuente: 'correo' as never,
    })).rejects.toMatchObject({ codigo: 'fuente_invalida' });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('el payload se sanea antes de guardarse: la clave de facturación no se persiste', async () => {
    const espias = montarTx();
    await aplicarEstadoDian({
      facturaId: FACTURA, estado: 'aceptada', fuente: 'webhook',
      payload: { cufe: CUFE, auth: { access_key: 'secreto-de-siigo' } },
    });
    expect(filaInsertada(espias).payload).toEqual({
      cufe: CUFE, auth: { access_key: '[REDACTED]' },
    });
  });

  it('quien registra a mano queda identificado; el sondeo no inventa un autor', async () => {
    const aMano = montarTx();
    await aplicarEstadoDian({
      facturaId: FACTURA, estado: 'anulada', fuente: 'manual', registradoPor: 42,
    });
    expect(filaInsertada(aMano).registradoPor).toBe(42);

    const automatico = montarTx();
    await aplicarEstadoDian({ facturaId: FACTURA, estado: 'aceptada', fuente: 'sondeo' });
    expect(filaInsertada(automatico).registradoPor).toBeNull();
  });
});

describe('AC3 — el historial no se reescribe', () => {
  it('un estado nuevo agrega una fila y no modifica la anterior', async () => {
    const espias = montarTx({ ultima: filaEstado({ estado: 'en_validacion' }) });

    const r = await aplicarEstadoDian({
      facturaId: FACTURA, estado: 'rechazada', fuente: 'sondeo',
      motivo: 'La resolución DIAN está vencida',
    });

    expect(r.cambio).toBe(true);
    expect(espias.txUpdate).not.toHaveBeenCalledWith(siigoFacturaEstadosDian);
    expect(filaInsertada(espias)).toMatchObject({
      estado: 'rechazada', motivo: 'La resolución DIAN está vencida',
    });
  });

  it('el motivo de un rechazo no se arrastra a la fila que dice aceptada', async () => {
    // Heredar el motivo entre estados distintos escribiría una explicación falsa en el historial:
    // «aceptada — la resolución DIAN está vencida».
    const espias = montarTx({
      ultima: filaEstado({ estado: 'rechazada', motivo: 'La resolución DIAN está vencida' }),
    });

    await aplicarEstadoDian({ facturaId: FACTURA, estado: 'aceptada', fuente: 'sondeo' });

    expect(filaInsertada(espias).motivo).toBeNull();
  });
});

describe('AC4 — un estado repetido no ensucia el historial', () => {
  it('vuelve a llegar aceptada con los mismos datos: no hay fila nueva, solo verificación', async () => {
    // Con una fila por consulta, un mes de sondeos cada quince minutos dejaría ~2900 filas
    // idénticas por factura y el historial dejaría de responder «¿cuándo cambió y por qué?».
    const espias = montarTx({
      factura: { id: FACTURA, ambiente: 'produccion', cufe: CUFE },
      ultima: filaEstado({ estado: 'aceptada', cufe: CUFE, fuente: 'emision' }),
    });

    const r = await aplicarEstadoDian({
      facturaId: FACTURA, estado: 'aceptada', cufe: CUFE, fuente: 'sondeo',
    });

    expect(r.cambio).toBe(false);
    expect(espias.txInsert).not.toHaveBeenCalled();
    expect(espias.txUpdate).toHaveBeenCalledWith(siigoFacturaEstadosDian);
    expect(espias.updateSet).toHaveBeenCalledWith({ verificadoEn: expect.any(Date) });
    expect(r.registro.verificadoEn > r.registro.createdAt).toBe(true);
  });

  it('el mismo estado con un motivo distinto SÍ es un hecho nuevo', async () => {
    // Un segundo rechazo por otra causa no es la repetición de nada: es información que ahora no
    // existe en ninguna parte.
    const espias = montarTx({
      ultima: filaEstado({ estado: 'rechazada', motivo: 'La resolución DIAN está vencida' }),
    });

    const r = await aplicarEstadoDian({
      facturaId: FACTURA, estado: 'rechazada', fuente: 'sondeo',
      motivo: 'El NIT del adquiriente no corresponde',
    });

    expect(r.cambio).toBe(true);
    expect(filaInsertada(espias).motivo).toBe('El NIT del adquiriente no corresponde');
  });

  it('una observación que no trae CUFE no lo borra ni finge un cambio', async () => {
    // RN-02. Sin esto, un sondeo con una respuesta más escueta que la anterior parecería un hecho
    // nuevo y dejaría el historial diciendo que el documento perdió su CUFE.
    const espias = montarTx({
      factura: { id: FACTURA, ambiente: 'produccion', cufe: CUFE },
      ultima: filaEstado({ estado: 'aceptada', cufe: CUFE }),
    });

    const r = await aplicarEstadoDian({ facturaId: FACTURA, estado: 'aceptada', fuente: 'sondeo' });

    expect(r.cambio).toBe(false);
    expect(r.registro.cufe).toBe(CUFE);
    expect(espias.txInsert).not.toHaveBeenCalled();
  });

  it('que el CUFE aparezca por primera vez sí es un hecho nuevo', async () => {
    const espias = montarTx({ ultima: filaEstado({ estado: 'en_validacion', cufe: null }) });

    const r = await aplicarEstadoDian({
      facturaId: FACTURA, estado: 'en_validacion', cufe: CUFE, fuente: 'sondeo',
    });

    expect(r.cambio).toBe(true);
    expect(filaInsertada(espias).cufe).toBe(CUFE);
  });

  it('la repetición también se anota en la bitácora: un sondeo mudo no se distingue de uno caído', async () => {
    montarTx({
      factura: { id: FACTURA, ambiente: 'produccion', cufe: CUFE },
      ultima: filaEstado({ estado: 'aceptada', cufe: CUFE }),
    });

    await aplicarEstadoDian({ facturaId: FACTURA, estado: 'aceptada', fuente: 'sondeo' });

    expect(registrarOperacionMock).toHaveBeenCalledWith(expect.objectContaining({
      operacion: 'estado_dian.aplicar', entidadId: FACTURA, resultado: 'ok', ambiente: 'produccion',
    }));
  });
});

describe('AC5 — el CUFE se guarda donde ya está previsto', () => {
  it('queda en la fila del historial y completa el campo vacío de la factura', async () => {
    const espias = montarTx({ factura: { id: FACTURA, ambiente: 'produccion', cufe: null } });

    const r = await aplicarEstadoDian({
      facturaId: FACTURA, estado: 'aceptada', cufe: CUFE, fuente: 'emision',
    });

    expect(filaInsertada(espias).cufe).toBe(CUFE);
    expect(r.cufeCompletado).toBe(true);
    expect(espias.txUpdate).toHaveBeenCalledWith(siigoFacturas);
    // Solo `cufe` y la marca de tiempo: ni `estado`, ni `requiere_revision`, ni nada de la Feature
    // #11242. La lista literal es el test.
    expect(espias.updateSet).toHaveBeenCalledWith({ cufe: CUFE, updatedAt: expect.any(Date) });
  });

  it('si la factura ya tenía CUFE no se sobrescribe', async () => {
    const espias = montarTx({ factura: { id: FACTURA, ambiente: 'produccion', cufe: CUFE } });

    const r = await aplicarEstadoDian({
      facturaId: FACTURA, estado: 'aceptada', cufe: CUFE, fuente: 'sondeo',
    });

    expect(r.cufeCompletado).toBe(false);
    expect(espias.txUpdate).not.toHaveBeenCalledWith(siigoFacturas);
  });

  it('un CUFE distinto del que ya constaba se señala, no se corrige', async () => {
    // Dos CUFE para una misma factura es una contradicción que tiene que mirar una persona. Y el
    // campo es de la Feature de emisión: aquí no se pisa.
    const espias = montarTx({ factura: { id: FACTURA, ambiente: 'produccion', cufe: CUFE } });

    const r = await aplicarEstadoDian({
      facturaId: FACTURA, estado: 'aceptada', cufe: 'b'.repeat(96), fuente: 'webhook',
    });

    expect(r.cufeDiscrepante).toBe(true);
    expect(espias.txUpdate).not.toHaveBeenCalledWith(siigoFacturas);
    expect(filaInsertada(espias).cufe).toBe('b'.repeat(96));
  });
});

describe('AC6 — una factura desconocida no crea historial', () => {
  it('se rechaza con un error de dominio que dice cuál es el identificador', async () => {
    const primera = montarTx({ factura: null });
    await expect(aplicarEstadoDian({
      facturaId: OTRA_FACTURA, estado: 'aceptada', fuente: 'webhook',
    })).rejects.toThrow(SiigoEstadoDianError);
    expect(primera.txInsert).not.toHaveBeenCalled();

    // El identificador desconocido va EN el mensaje: un «no existe» a secas obliga a bucear en los
    // logs para saber a qué factura apuntaba el webhook.
    const segunda = montarTx({ factura: null });
    await expect(aplicarEstadoDian({
      facturaId: OTRA_FACTURA, estado: 'aceptada', fuente: 'webhook',
    })).rejects.toThrow(OTRA_FACTURA);
    expect(segunda.txInsert).not.toHaveBeenCalled();
  });

  it('un identificador que ni siquiera es un uuid no llega a la base', async () => {
    // Sin esta comprobación, PostgreSQL devolvería un error de sintaxis: ni es de dominio, ni dice
    // qué pasó, y además se lleva por delante la transacción.
    await expect(aplicarEstadoDian({
      facturaId: 'lo-que-mandó-el-webhook', estado: 'aceptada', fuente: 'webhook',
    })).rejects.toMatchObject({ codigo: 'factura_desconocida' });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('el intento fallido sí queda en la bitácora: es lo que hay que poder investigar', async () => {
    montarTx({ factura: null });
    await expect(aplicarEstadoDian({
      facturaId: OTRA_FACTURA, estado: 'aceptada', fuente: 'webhook',
    })).rejects.toThrow();

    expect(registrarOperacionMock).toHaveBeenCalledWith(expect.objectContaining({
      resultado: 'error_negocio', codigo: 'factura_desconocida', entidadId: OTRA_FACTURA,
    }));
  });
});

describe('AC7 — consultar el estado no gasta cuota', () => {
  it('el estado vigente sale de la base y no de Siigo', async () => {
    selectMock.mockReturnValueOnce(chain([filaEstado({ estado: 'aceptada', cufe: CUFE })]));

    const vigente = await estadoDianVigente(FACTURA);

    expect(vigente).toMatchObject({ estado: 'aceptada', cufe: CUFE, secuencia: 7 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('una factura que nunca se ha consultado devuelve null, no un estado inventado', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    expect(await estadoDianVigente(FACTURA)).toBeNull();
  });

  it('el historial se devuelve entero y tampoco sale a la red', async () => {
    selectMock.mockReturnValueOnce(chain([
      filaEstado({ id: 'f1', secuencia: 1, estado: 'en_validacion' }),
      filaEstado({ id: 'f2', secuencia: 2, estado: 'rechazada', motivo: 'NIT inválido' }),
    ]));

    const historial = await historialEstadoDian(FACTURA);

    expect(historial.map((h) => h.estado)).toEqual(['en_validacion', 'rechazada']);
    expect(historial[1]!.motivo).toBe('NIT inválido');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('la bandeja pide muchas facturas de una vez y no una consulta por fila', async () => {
    // Sin esto, una bandeja de cien facturas serían cien consultas — y es exactamente la pantalla
    // que va a consumir esto.
    executeMock.mockResolvedValueOnce([
      {
        id: 'f1', factura_id: FACTURA, secuencia: '9', estado: 'aceptada', cufe: CUFE,
        motivo: null, fuente: 'sondeo',
        created_at: new Date('2026-08-02T10:00:00Z'),
        verificado_en: new Date('2026-08-09T10:00:00Z'),
      },
    ]);

    const mapa = await estadosDianVigentes([FACTURA, OTRA_FACTURA, FACTURA]);

    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(mapa.get(FACTURA)).toMatchObject({ estado: 'aceptada', secuencia: 9 });
    // La que no tiene historial simplemente no está: «sin consultar» no es un estado.
    expect(mapa.has(OTRA_FACTURA)).toBe(false);
  });

  it('sin ids válidos no se consulta nada', async () => {
    const mapa = await estadosDianVigentes(['no-es-un-uuid']);
    expect(mapa.size).toBe(0);
    expect(executeMock).not.toHaveBeenCalled();
  });
});
