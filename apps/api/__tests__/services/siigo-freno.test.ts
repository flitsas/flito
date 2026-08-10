// Siigo — freno por proporción de errores (HU #11341, Feature #11244). Un bloque por criterio.
//
// Lo que se prueba aquí es la DECISIÓN: qué cuenta, qué no, cuándo frena y qué se dice. La bitácora
// sobre la que se mide tiene su propio spec (siigo-bitacora.test.ts), así que se mockea: repetir
// aquí que el INSERT sanea secretos no probaría nada nuevo y escondería lo que sí importa.
//
// El reloj se inyecta —igual que en `siigo.resiliencia.ts`— para poder recorrer una ventana de 24
// horas sin esperarla.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Modo simulado o real, controlado por test (AC1). */
let modo: 'mock' | 'real' = 'real';
vi.mock('../../src/modules/siigo/siigo.mock.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.mock.js')>();
  return { ...real, modoSiigo: () => modo, enModoMock: () => modo === 'mock' };
});

/**
 * La bitácora se mockea entera y sin cargar la original: importarla arrastraría el cliente de base
 * de datos, y lo que hay que ejercer es el cálculo, no el driver.
 */
const contarMock = vi.fn();
const marcaMock = vi.fn();
const registrarMock = vi.fn();
vi.mock('../../src/modules/siigo/siigo.operaciones.repo.js', () => ({
  contarPorResultado: (...args: unknown[]) => contarMock(...args),
  marcaDeOperacion: (...args: unknown[]) => marcaMock(...args),
  registrarOperacion: (...args: unknown[]) => registrarMock(...args),
  consultarBitacora: vi.fn(),
  sanearCuerpo: vi.fn(),
}));

const {
  OPERACION_FRENO, OPERACION_REACTIVACION, SiigoIntegracionFrenadaError,
  estadoFreno, exigirIntegracionNoFrenada, medirIntegracion, reactivarIntegracion,
} = await import('../../src/modules/siigo/siigo.freno.service.js');

/** Instante fijo para que las ventanas sean comprobables a mano. */
const AHORA = new Date('2026-08-10T12:00:00.000Z');
const ahora = () => AHORA.getTime();

/** Parámetros explícitos en cada prueba: el veredicto no debe depender del `.env` de quien corre. */
const PARAMS = { ahora, ventanaHoras: 24, umbral: 0.6, minimoOperaciones: 20 };

type Conteo = { resultado: string; total: number };

/** Devuelve los conteos dados como si vinieran de la bitácora. */
function conBitacora(conteos: Conteo[]): void {
  contarMock.mockResolvedValue(conteos);
}

/** Argumentos con los que se consultó la bitácora. */
function consultaHecha(): Record<string, unknown> {
  return contarMock.mock.calls[0]![0] as Record<string, unknown>;
}

beforeEach(() => {
  modo = 'real';
  contarMock.mockReset();
  marcaMock.mockReset();
  registrarMock.mockReset();
  contarMock.mockResolvedValue([]);
  marcaMock.mockResolvedValue(null);
  registrarMock.mockResolvedValue(undefined);
});

describe('AC1 — la proporción se mide sobre lo que ya se registra', () => {
  it('lee la bitácora existente: no hay tabla ni contador paralelo', async () => {
    // La única fuente de datos del módulo es `siigo.operaciones.repo`. Si un día alguien añade un
    // contador propio, este archivo importará algo más y la lista deja de cuadrar.
    const fuente = readFileSync(resolve(RAIZ, 'src/modules/siigo/siigo.freno.service.ts'), 'utf8');
    const modulos = [...fuente.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);

    expect(modulos).toContain('./siigo.operaciones.repo.js');
    expect(modulos.filter((m) => m.includes('db/schema') || m.includes('db/client'))).toEqual([]);
  });

  it('la ventana es configurable y se aplica al consultar', async () => {
    conBitacora([{ resultado: 'ok', total: 10 }]);
    await medirIntegracion({ ...PARAMS, ventanaHoras: 6 });

    const desde = consultaHecha().desde as Date;
    expect(AHORA.getTime() - desde.getTime()).toBe(6 * 3_600_000);
  });

  it('el modo simulado y el real no se mezclan', async () => {
    conBitacora([{ resultado: 'ok', total: 10 }]);

    modo = 'real';
    await medirIntegracion(PARAMS);
    expect(consultaHecha().modo).toBe('real');

    contarMock.mockClear();
    modo = 'mock';
    await medirIntegracion(PARAMS);
    expect(consultaHecha().modo).toBe('mock');
  });

  it('mide por ambiente: pruebas y produccion son empresas distintas de Siigo', async () => {
    conBitacora([{ resultado: 'ok', total: 10 }]);
    await medirIntegracion({ ...PARAMS, ambiente: 'produccion' });
    expect(consultaHecha().ambiente).toBe('produccion');
  });
});

describe('AC2 — superado el umbral, se frena', () => {
  /** 30 operaciones medibles, 21 fallos de servicio → 70 %, por encima del umbral de 60 %. */
  const VENTANA_ROTA: Conteo[] = [
    { resultado: 'ok', total: 9 },
    { resultado: 'error_tecnico', total: 18 },
    { resultado: 'timeout', total: 3 },
  ];

  it('la proporción por encima del umbral deja la integración frenada', async () => {
    conBitacora(VENTANA_ROTA);
    const estado = await estadoFreno(PARAMS);

    expect(estado.total).toBe(30);
    expect(estado.errores).toBe(21);
    expect(estado.proporcion).toBeCloseTo(0.7, 5);
    expect(estado.frenada).toBe(true);
  });

  it('la operación se rechaza ANTES de salir a la red', async () => {
    conBitacora(VENTANA_ROTA);
    // No hay ninguna llamada a Siigo de por medio: lo que lanza es el propio guardián, y por eso
    // sirve para no gastar cuota ni acercar el bloqueo del usuario API.
    await expect(exigirIntegracionNoFrenada(PARAMS)).rejects
      .toBeInstanceOf(SiigoIntegracionFrenadaError);
  });

  it('el motivo dice qué se midió y contra qué, no un «no se puede»', async () => {
    conBitacora(VENTANA_ROTA);
    const estado = await estadoFreno(PARAMS);

    expect(estado.motivo).toContain('21 de 30');
    expect(estado.motivo).toContain('70.0 %');
    expect(estado.motivo).toContain('60.0 %');
    expect(estado.motivo).toContain('24 h');
  });

  it('el freno queda registrado en la bitácora', async () => {
    conBitacora(VENTANA_ROTA);
    await expect(exigirIntegracionNoFrenada({ ...PARAMS, usuarioId: 7 })).rejects.toThrow();

    expect(registrarMock).toHaveBeenCalledTimes(1);
    expect(registrarMock.mock.calls[0]![0]).toMatchObject({
      operacion: OPERACION_FRENO, codigo: 'integracion_frenada', createdBy: 7,
    });
  });

  it('el propio rechazo NO se cuenta: un freno activo no puede mantenerse solo', async () => {
    // Sin esta exclusión, cada rechazo escribe un `error_negocio` que alimenta la siguiente
    // medición y la integración quedaría frenada para siempre sin que Siigo tenga nada que ver.
    conBitacora(VENTANA_ROTA);
    await medirIntegracion(PARAMS);

    const excluidas = consultaHecha().excluir as string[];
    expect([...excluidas]).toEqual(
      expect.arrayContaining([OPERACION_FRENO, OPERACION_REACTIVACION]),
    );
  });

  it('por debajo del umbral no frena y no escribe nada', async () => {
    conBitacora([{ resultado: 'ok', total: 80 }, { resultado: 'error_tecnico', total: 20 }]);

    const estado = await exigirIntegracionNoFrenada(PARAMS);
    expect(estado.frenada).toBe(false);
    expect(estado.proporcion).toBeCloseTo(0.2, 5);
    expect(registrarMock).not.toHaveBeenCalled();
  });

  it('en modo simulado se mide pero no se bloquea: no hay usuario API que Siigo pueda bloquear', async () => {
    modo = 'mock';
    conBitacora(VENTANA_ROTA);

    const estado = await exigirIntegracionNoFrenada(PARAMS);
    expect(estado.frenoActivo).toBe(false);
    expect(estado.frenada).toBe(false);
    // La medición se publica igual: un simulador que dijera «todo bien» sería un placebo.
    expect(estado.superaUmbral).toBe(true);
  });
});

describe('AC3 — los errores de datos no cuentan para el freno', () => {
  it('una tanda de clientes mal capturados no frena la integración entera', async () => {
    conBitacora([{ resultado: 'ok', total: 25 }, { resultado: 'error_negocio', total: 95 }]);

    const estado = await estadoFreno(PARAMS);
    expect(estado.errores).toBe(0);
    expect(estado.proporcion).toBe(0);
    expect(estado.frenada).toBe(false);
  });

  it('tampoco entran en el denominador, o taparían un servicio realmente roto', async () => {
    // 30 operaciones cuyo desenlace dependía de Siigo, 21 fallidas → 70 %, se frena.
    // Si los 200 errores de datos contaran abajo, la fracción sería 21/230 ≈ 9 % y el freno
    // dormiría mientras la integración se cae a pedazos.
    conBitacora([
      { resultado: 'ok', total: 9 },
      { resultado: 'error_tecnico', total: 21 },
      { resultado: 'error_negocio', total: 200 },
    ]);

    const estado = await estadoFreno(PARAMS);
    expect(estado.total).toBe(30);
    expect(estado.proporcion).toBeCloseTo(0.7, 5);
    expect(estado.frenada).toBe(true);
  });

  it('siguen visibles y contados aparte: el freno no los cuenta, pero no los esconde', async () => {
    conBitacora([{ resultado: 'ok', total: 25 }, { resultado: 'error_negocio', total: 95 }]);

    const estado = await estadoFreno(PARAMS);
    expect(estado.erroresDeDatos).toBe(95);
  });

  it('solo el error de datos vivo: sin denominador no hay proporción que superar', async () => {
    conBitacora([{ resultado: 'error_negocio', total: 500 }]);

    const estado = await estadoFreno(PARAMS);
    expect(estado.total).toBe(0);
    expect(estado.muestraSuficiente).toBe(false);
    expect(estado.frenada).toBe(false);
  });
});

describe('AC4 — el freno se puede levantar a mano', () => {
  const REACTIVACION = new Date('2026-08-10T11:30:00.000Z');

  it('escribe en la bitácora quién reactivó y cuándo', async () => {
    conBitacora([]);
    await reactivarIntegracion({ usuarioId: 42, ambiente: 'pruebas' });

    expect(registrarMock).toHaveBeenCalledTimes(1);
    expect(registrarMock.mock.calls[0]![0]).toMatchObject({
      operacion: OPERACION_REACTIVACION, resultado: 'ok', createdBy: 42, ambiente: 'pruebas',
    });
  });

  it('la nota del operador viaja al registro', async () => {
    conBitacora([]);
    await reactivarIntegracion({ usuarioId: 42, nota: 'Se corrigió el Partner-Id' });

    expect(registrarMock.mock.calls[0]![0]).toMatchObject({
      mensaje: expect.stringContaining('Se corrigió el Partner-Id'),
    });
  });

  it('tras reactivar, la medición arranca ahí y no espera a que expire la ventana', async () => {
    marcaMock.mockResolvedValue({ createdAt: REACTIVACION, createdBy: 42 });
    conBitacora([]);

    await medirIntegracion(PARAMS);

    // Media hora atrás y no 24 horas: lo anterior ya se dio por revisado.
    expect(consultaHecha().desde).toEqual(REACTIVACION);
  });

  it('una reactivación anterior a la ventana no adelanta nada', async () => {
    marcaMock.mockResolvedValue(null); // fuera de la ventana, la bitácora no la devuelve
    conBitacora([]);

    await medirIntegracion(PARAMS);
    const desde = consultaHecha().desde as Date;
    expect(AHORA.getTime() - desde.getTime()).toBe(24 * 3_600_000);
  });

  it('el estado informa quién la reactivó y cuándo', async () => {
    marcaMock.mockResolvedValue({ createdAt: REACTIVACION, createdBy: 42 });
    conBitacora([]);

    const estado = await estadoFreno(PARAMS);
    expect(estado.ultimaReactivacion).toEqual({
      fecha: REACTIVACION.toISOString(), usuarioId: 42,
    });
  });

  it('si la reactivación no llegó a escribirse, el estado devuelto no miente', async () => {
    // `registrarOperacion` se traga sus errores para no tumbar operaciones de negocio. Devolver un
    // `{ ok: true }` fijo daría por levantado un freno que sigue puesto.
    marcaMock.mockResolvedValue(null);
    conBitacora([{ resultado: 'error_tecnico', total: 40 }]);

    const estado = await reactivarIntegracion({ usuarioId: 42 });
    expect(estado.frenada).toBe(true);
  });
});

describe('AC5 — el freno no sustituye al cortacircuitos', () => {
  it('no toca el cortacircuitos ni el limitador de tasa', async () => {
    // Miden cosas distintas: cuota por empresa y salud por endpoint viven en `siigo.resiliencia`;
    // aquí solo se mide la proporción acumulada, que es lo único que Siigo penaliza con bloqueo.
    const fuente = readFileSync(resolve(RAIZ, 'src/modules/siigo/siigo.freno.service.ts'), 'utf8');
    const modulos = [...fuente.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);

    expect(modulos).not.toContain('./siigo.resiliencia.js');
    expect(modulos).not.toContain('../../services/circuitBreaker.js');
  });

  it('el cortacircuitos sigue sin saber nada del freno', async () => {
    const fuente = readFileSync(resolve(RAIZ, 'src/modules/siigo/siigo.resiliencia.ts'), 'utf8');
    expect(fuente).not.toContain('siigo.freno.service');
  });

  it('un solo endpoint caído no frena la integración', async () => {
    // 10 fallos de un recurso concreto entre 90 operaciones sanas: su cortacircuitos se abrirá y
    // hará su trabajo, pero la proporción acumulada de la empresa sigue lejos del umbral.
    conBitacora([{ resultado: 'ok', total: 90 }, { resultado: 'error_tecnico', total: 10 }]);

    const estado = await estadoFreno(PARAMS);
    expect(estado.proporcion).toBeCloseTo(0.1, 5);
    expect(estado.frenada).toBe(false);
  });
});

describe('AC6 — el estado del freno es consultable', () => {
  it('devuelve proporción, ventana, umbral y los conteos que los sostienen', async () => {
    conBitacora([{ resultado: 'ok', total: 60 }, { resultado: 'error_tecnico', total: 40 }]);

    const estado = await estadoFreno(PARAMS);
    expect(estado).toMatchObject({
      ambiente: expect.any(String),
      modo: 'real',
      ventanaHoras: 24,
      umbral: 0.6,
      minimoOperaciones: 20,
      total: 100,
      errores: 40,
      muestraSuficiente: true,
      frenada: false,
    });
    expect(estado.hasta).toBe(AHORA.toISOString());
  });

  it('si está frenada, dice desde cuándo, tomado del primer rechazo registrado', async () => {
    const PRIMER_RECHAZO = new Date('2026-08-10T09:15:00.000Z');
    conBitacora([{ resultado: 'error_tecnico', total: 40 }]);
    marcaMock.mockImplementation(async (f: { operacion: string }) => (
      f.operacion === OPERACION_FRENO ? { createdAt: PRIMER_RECHAZO, createdBy: null } : null
    ));

    const estado = await estadoFreno(PARAMS);
    expect(estado.frenada).toBe(true);
    expect(estado.frenadaDesde).toBe(PRIMER_RECHAZO.toISOString());
  });

  it('sin frenar no se busca fecha de inicio ni se inventa una', async () => {
    conBitacora([{ resultado: 'ok', total: 40 }]);

    const estado = await estadoFreno(PARAMS);
    expect(estado.frenadaDesde).toBeNull();
    expect(estado.motivo).toBeNull();
  });
});

describe('la muestra tiene que significar algo', () => {
  it('tres operaciones fallidas no frenan la facturación de la empresa', async () => {
    conBitacora([{ resultado: 'error_tecnico', total: 3 }]);

    const estado = await estadoFreno(PARAMS);
    expect(estado.proporcion).toBe(1);
    expect(estado.muestraSuficiente).toBe(false);
    expect(estado.frenada).toBe(false);
  });

  it('la ventana vacía no es una integración enferma', async () => {
    conBitacora([]);

    const estado = await estadoFreno(PARAMS);
    expect(estado.total).toBe(0);
    expect(estado.proporcion).toBe(0);
    expect(estado.frenada).toBe(false);
  });

  it('justo en el umbral todavía no frena: el AC dice «supera»', async () => {
    conBitacora([{ resultado: 'ok', total: 40 }, { resultado: 'error_tecnico', total: 60 }]);

    const estado = await estadoFreno({ ...PARAMS, umbral: 0.6 });
    expect(estado.proporcion).toBeCloseTo(0.6, 5);
    expect(estado.frenada).toBe(false);
  });
});
