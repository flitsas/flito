// Siigo — el cron de la cola de emisión (HU #11327).
//
// Lo único que decide este archivo es cada cuánto corre, quién lo corre cuando hay varias instancias
// y qué pasa al apagar. Lo demás vive en el trabajador y se prueba allí.
//
// Se prueba porque los tres fallos posibles son silenciosos: un cron que arranca dos temporizadores
// duplica peticiones, uno que no respeta el interruptor de apagado emite en un entorno donde no
// debía, y uno que no propaga la señal de parada deja filas arrendadas veinte minutos cada vez que
// se despliega.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * El interruptor de los crons se lee del esquema validado, no de `process.env` (Bug #11649), así
 * que aquí se mockea `config/env.js`. Antes bastaba con tocar `process.env` porque el cron leía la
 * variable cruda — que era precisamente el defecto: cualquier valor distinto de la cadena `'0'`,
 * la variable ausente incluida, lo dejaba encendido.
 *
 * Ojo con el defecto: `SIIGO_CRONS` vale `off` si nadie dice lo contrario, así que los casos que
 * esperan que el cron CORRA tienen que encenderlo a propósito. Eso es la corrección, no una
 * incomodidad del test.
 */
const envMock = { SIIGO_CRONS: 'on' as 'on' | 'off', SIIGO_AMBIENTE: 'pruebas' as const };
vi.mock('../../src/config/env.js', () => ({ env: envMock }));

const procesarCicloEmisionMock = vi.fn().mockResolvedValue({
  reconciliadas: 0, tomadas: 0, enviadas: 0, reintentables: 0, definitivas: 0, liberadas: 0,
  frenada: false, circuitoAbierto: false, detenido: false, agotoPlazo: false,
});
vi.mock('../../src/modules/siigo/facturacion.trabajador.service.js', () => ({
  procesarCicloEmision: (o: unknown) => procesarCicloEmisionMock(o),
}));

/** El cerrojo real toca la base. Aquí se sustituye por uno que siempre concede. */
const withLockMock = vi.fn(async (_n: string, _ttl: number, fn: () => Promise<unknown>) => fn());
vi.mock('../../src/shared/utils/lock.js', () => ({
  withLock: (n: string, ttl: number, fn: () => Promise<unknown>) => withLockMock(n, ttl, fn),
}));

const { NOMBRE_CERROJO, startSiigoColaCron, stopSiigoColaCron } = await import(
  '../../src/modules/siigo/siigo.cola.cron.js');

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  envMock.SIIGO_CRONS = 'on';
});

afterEach(() => {
  stopSiigoColaCron();
  vi.useRealTimers();
});

describe('el cron de la cola de emisión', () => {
  it('corre cada dos minutos, dentro del cerrojo y con un plazo menor que su TTL', async () => {
    startSiigoColaCron();
    // Arranque diferido: al levantar el proceso hay cosas más urgentes que emitir facturas.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(withLockMock).toHaveBeenCalledTimes(1);
    const [nombre, ttl] = withLockMock.mock.calls[0]!;
    expect(nombre).toBe(NOMBRE_CERROJO);

    const opciones = procesarCicloEmisionMock.mock.calls[0]![0] as { plazoMs: number; lote: number };
    // El ciclo se rinde antes de perder el cerrojo: si no, el tick siguiente lo readquiere y arranca
    // un SEGUNDO ciclo mientras el primero sigue vivo, gastando los dos la misma cuota.
    expect(opciones.plazoMs).toBeLessThan(ttl as number);
    expect(opciones.lote).toBe(15);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(withLockMock).toHaveBeenCalledTimes(2);
  });

  it('no arranca dos veces aunque se le pida dos veces', async () => {
    startSiigoColaCron();
    startSiigoColaCron();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(withLockMock).toHaveBeenCalledTimes(1);
  });

  it('con SIIGO_CRONS=off no hace absolutamente nada', async () => {
    envMock.SIIGO_CRONS = 'off';
    startSiigoColaCron();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(withLockMock).not.toHaveBeenCalled();
  });

  // Bug #11649 — el defecto, que es lo que estaba mal. La guarda anterior comparaba contra la
  // cadena `'0'`: sin variable, con la variable mal escrita o con cualquier otro valor, el cron
  // arrancaba y emitía ante la DIAN. Ahora solo `on` arranca, y `on` hay que escribirlo.
  it('sin un `on` explícito NO arranca: emitir exige un acto deliberado', async () => {
    for (const valor of ['off', '', '0', '1', 'true', 'ON', undefined]) {
      vi.clearAllMocks();
      stopSiigoColaCron();
      (envMock as { SIIGO_CRONS: unknown }).SIIGO_CRONS = valor;
      startSiigoColaCron();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(withLockMock, `SIIGO_CRONS=${String(valor)} no debe arrancar el cron`).not.toHaveBeenCalled();
    }
  });

  it('AC7 — al parar, el ciclo en vuelo se entera: `debeDetenerse` pasa a decir que sí', async () => {
    startSiigoColaCron();
    await vi.advanceTimersByTimeAsync(60_000);

    const { debeDetenerse } = procesarCicloEmisionMock.mock.calls[0]![0] as { debeDetenerse: () => boolean };
    expect(debeDetenerse()).toBe(false);

    stopSiigoColaCron();
    // La bandera se levanta ANTES de parar el temporizador: si hay un ciclo en vuelo, lo que hace
    // falta es que se entere ya, no que no vuelva a arrancar dentro de dos minutos.
    expect(debeDetenerse()).toBe(true);
  });

  it('un ciclo que falla no tumba el cron: el siguiente vuelve a intentarlo', async () => {
    procesarCicloEmisionMock.mockRejectedValueOnce(new Error('la base falló'));
    startSiigoColaCron();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(procesarCicloEmisionMock).toHaveBeenCalledTimes(2);
  });

  it('no se solapa consigo mismo: un ciclo lento salta el tick siguiente', async () => {
    // `setInterval` no espera a que la ejecución anterior termine. El cerrojo distribuido no cubre
    // este caso: es el MISMO proceso, y `withLock` daría el cerrojo por propio.
    let resolver: (() => void) | null = null;
    procesarCicloEmisionMock.mockImplementationOnce(() => new Promise<void>((res) => { resolver = () => res(); }));

    startSiigoColaCron();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(procesarCicloEmisionMock).toHaveBeenCalledTimes(1);

    resolver!();
  });
});
