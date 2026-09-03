// HU #11966 (Feature #11912) — **la COMPUERTA**: el RUNT vuelve a decidir si la solicitud existe.
// ADR-0010, que supersede al ADR-0009. Diseño: docs/diseno-hu-11966-runt-compuerta-excel-cliente.md
//
// La suite hermana (`flito-soat.cliente-alta.test.ts`) conserva los casos de la #11914/#11935 con sus
// afirmaciones INVERTIDAS. Aquí vive lo que la #11966 estrena y que allí no tenía sitio:
//
//   1. **EL DISCRIMINADOR (TC #11980).** Un solo caso que ejerce la negativa de negocio (HTTP 200) y
//      la caída de transporte, y afirma CUÁL ES CUÁL. No que difieran: cuál es cuál. Es el AC4
//      entero y es lo que se rompería en silencio si el criterio dependiera del texto del mensaje.
//   2. **La SIMETRÍA de los dos endpoints.** La preconsulta y el alta devuelven exactamente lo mismo
//      ante la misma respuesta de Kyverum, porque llaman a la misma función. Con dos copias, el paso
//      1 del wizard acaba negando lo que el paso 2 acepta.
//   3. **VIN opcional y VIN efectivo** (AC1): lo que se persiste es el del RUNT.
//   4. **`runt_sin_vin`** (AC5): sin VIN en la respuesta no se crea, y el código es propio.
//   5. **El propietario partido** (AC5): NIT ⇒ razón social; natural ⇒ nombres y apellidos; nunca
//      las dos cosas, ni en Zod ni en la fila.
//   6. **El rastro de PII del alta**, que la #11935 no necesitaba porque no consultaba el RUNT dentro
//      de la petición y la #11966 sí.
//
// Montaje: el router real, `authMiddleware` real (así el guarda de negación por defecto está vivo) y
// el INSERT medido con `espia-drizzle` — afirmar sobre el cuerpo de la respuesta probaría el mock.
// Un `sub` distinto por caso: el limitador del canal es por usuario y su ventana dura 15 minutos.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { testToken } from '../helpers/auth.js';

const kdb = createKeyedDb();
const espia = crearEspia(kdb);

const consultarVehiculoRuntMock = vi.fn();
const uploadMock = vi.fn();
const auditMock = vi.fn().mockResolvedValue(undefined);
const piiMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: piiMock }));
vi.mock('../../src/services/storage.js', () => ({ uploadEntityDocument: uploadMock }));
vi.mock('../../src/modules/runt/runt.service.js', () => ({
  consultarVehiculoRunt: consultarVehiculoRuntMock,
  consultarPersonaRunt: vi.fn(),
}));

/**
 * El logger, espiado. Es lo único con lo que se puede mirar la FORMA de lo que se escribe.
 *
 * Recupera el guardián que se fue con la suite del job de la #11935, que afirmaba
 * `{ soatId, verificacionEstado }` sin placa, VIN ni documento. El log de la compuerta no tenía
 * test de forma, y su rama `warn` echaba al log el `message` CRUDO del error — texto de un tercero
 * que puede traer dentro la placa con la que se consultó.
 */
const logMock = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
logMock.child.mockReturnValue(logMock);
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));

const COMPANIA = 7;
const VEHICULO_ID = 55;
const ORGANISMO_FUNZA = '25286';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n');

/** VIN sintético. Ni una cédula ni un VIN reales en esta suite. */
const VIN_RUNT = '9FKRG2222T2042405';
const PLACA = 'JNH38H';
/** Documento sintético: diez dígitos que no son la cédula de nadie. */
const DOCUMENTO = '1020304050';

function runtOk(over: Record<string, unknown> = {}, soat: unknown = { estadoSoat: 'NO VIGENTE', fechaVencimSoat: '01/01/2020' }) {
  return {
    ok: true,
    data: {
      vehiculo: {
        placa: PLACA, vin: VIN_RUNT,
        idAutomotor: '9911', estadoAutomotor: 'ACTIVO',
        marca: 'MAZDA', linea: 'CX-30', modelo: '2026', clase: 'CAMIONETA',
        cilindraje: '1598', tipoServicio: 'Particular',
        tipoCarroceria: 'WAGON', pasajerosSentados: '5', puertas: '5',
        organismoTransito: 'STRIA TTOyTTE MCPAL FUNZA',
        nombrePropietario: 'JUANA PEREZ',
        ...over,
      },
      soat,
    },
  };
}

/**
 * Los DOS `ok:false` que este archivo existe para separar.
 *
 * Se distinguen **solo** por `httpStatus`, y los mensajes son deliberadamente intercambiables: si el
 * discriminador mirara el texto, el par de abajo lo delataría. Ninguno de los dos contiene la
 * palabra «propietario», que es la que el predicado heredado (`/propietari/i`) reconoce.
 */
const NEGATIVA_DE_NEGOCIO = { ok: false, message: 'La consulta no pudo ser atendida', httpStatus: 200 };
const CAIDO_SIN_STATUS = { ok: false, message: 'La consulta no pudo ser atendida' };
/** Un no-200 de la pasarela: `runt.service.ts` anota el código real y sigue siendo transporte. */
const CAIDO_CON_502 = { ok: false, message: 'Bad gateway', httpStatus: 502 };

let sub = 700;
const siguienteUsuario = () => ++sub;

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat-cliente.routes.js');
  app.use('/api/flito/soat', router);
  return app;
}

const auth = async (id: number) => `Bearer ${await testToken({ sub: id, username: 'cliente@empresa.co', role: 'cliente' as never })}`;

function escenario(over: Partial<Record<string, unknown[]>> = {}) {
  kdb.when.scenario({
    users: [{ c: COMPANIA, s: null }],
    clients: [{ id: COMPANIA, sinTramite: true, carpeta: 'clientes/acme' }],
    flito_soat: [],
    organismos_transito_config: [{ codigo: ORGANISMO_FUNZA, alias: 'FUNZA' }],
    vehicles: [],
    ...(over as Record<string, unknown[]>),
  });
  kdb.when.insert('vehicles', [{ id: VEHICULO_ID }]);
}

/** El formulario del alta, con el propietario PARTIDO (AC5) y sin `nombreCompleto`. */
const CAMPOS: Record<string, string> = {
  placa: PLACA.toLowerCase(), vin: VIN_RUNT.toLowerCase(),
  tipoDocumento: 'CC', numeroDocumento: DOCUMENTO,
  nombres: 'JUANA', apellidos: 'PEREZ',
  correo: 'juana@empresa.co', celular: '3001234567', direccion: 'CALLE 1 # 2-3',
  municipio: 'FUNZA', departamento: 'CUNDINAMARCA',
};

function alta(app: express.Express, token: string, campos: Record<string, string | null> = {}) {
  const req = request(app).post('/api/flito/soat/cliente').set('Authorization', token);
  const cuerpo = { ...CAMPOS, ...campos };
  for (const [k, v] of Object.entries(cuerpo)) {
    // `null` = el campo NO se manda (a diferencia de `''`, que es «llegó vacío del formulario»).
    if (v !== null) req.field(k, v);
  }
  return req.attach('facturaVenta', PDF, { filename: 'factura.pdf', contentType: 'application/pdf' });
}

const preconsultar = (app: express.Express, token: string, cuerpo: Record<string, string> = {
  placa: PLACA, vin: VIN_RUNT, tipoDocumento: 'CC', numeroDocumento: DOCUMENTO,
}) => request(app).post('/api/flito/soat/cliente/preconsulta').set('Authorization', token).send(cuerpo);

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  consultarVehiculoRuntMock.mockReset().mockResolvedValue(runtOk());
  uploadMock.mockReset().mockResolvedValue('clientes/acme/soat/facturas-venta/abc.pdf');
  auditMock.mockClear();
  piiMock.mockClear();
  logMock.info.mockClear();
  logMock.warn.mockClear();
});

/** Lo que se le pasó al logger en la última llamada de ese nivel: el objeto, no el mensaje. */
const ultimoLog = (nivel: 'info' | 'warn'): Record<string, unknown> =>
  (logMock[nivel].mock.calls.at(-1)?.[0] ?? {}) as Record<string, unknown>;

// ═══════════════ TC #11980 — EL DISCRIMINADOR (AC2 vs AC4) ═══════════════════

describe('AC4 — «el RUNT no respondió» y «el RUNT respondió que no» son desenlaces DISTINTOS', () => {
  it('**TC #11980: los dos `ok:false` en el mismo test, y se afirma CUÁL ES CUÁL**', async () => {
    // ── Por qué UN solo caso y no dos ────────────────────────────────────────────────────────────
    //
    // Dos casos separados pasan en verde con un servicio que responda 503 a los dos, o 422 a los
    // dos, si alguien «unifica» la rama por descuido: cada uno afirmaría su estado y ninguno vería
    // que el otro dice lo mismo. Aquí se ejercen las dos respuestas en el mismo test y se comparan
    // ENTRE SÍ, además de contra su valor esperado. El AC4 no pide que difieran: pide que el 503 NO
    // se use cuando el RUNT sí respondió.
    //
    // ── Por qué los mensajes son IDÉNTICOS ───────────────────────────────────────────────────────
    //
    // Es la mitad que hace de este caso una prueba y no una tautología. Lo único que separa las dos
    // respuestas es `httpStatus`, la señal de TRANSPORTE que `runt.service.ts` anota. Si mañana
    // alguien sustituyera el criterio por un predicado sobre el texto —`/propietari/i`, que es el
    // precedente del repo—, las dos caerían en la misma rama y este test se pondría rojo.
    const app = await buildApp();

    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(NEGATIVA_DE_NEGOCIO);
    const negocio = await alta(app, await auth(siguienteUsuario()));

    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(CAIDO_SIN_STATUS);
    const caido = await alta(app, await auth(siguienteUsuario()));

    // CUÁL es cuál, no solo que difieren.
    expect(negocio.status, 'el RUNT respondió que no → 422 «revise los datos»').toBe(422);
    expect(negocio.body.codigo).toBe('runt_no_cuadra');
    expect(caido.status, 'el RUNT no respondió → 503 «vuelva a consultar»').toBe(503);
    expect(caido.body.codigo).toBe('runt_no_disponible');

    // Y no se confunden entre sí en NINGUNA dirección. Es el mutante (a) del diseño §6: cambiar el
    // 503 del RUNT caído por 422 mata este aserto, y también el simétrico.
    expect(negocio.status).not.toBe(503);
    expect(negocio.body.codigo).not.toBe('runt_no_disponible');
    expect(caido.status).not.toBe(422);
    expect(caido.body.codigo).not.toBe('runt_no_cuadra');

    // El mensaje del RUNT era el MISMO en los dos. Si el criterio fuera el texto, esto sería
    // imposible de cumplir.
    expect(NEGATIVA_DE_NEGOCIO.message).toBe(CAIDO_SIN_STATUS.message);

    // Y ninguno de los dos crea nada: el desenlace se separa para el usuario, no para la base.
    expect(espia.insertsEn('flito_soat')).toHaveLength(0);
  });

  it('un no-200 de la pasarela es TRANSPORTE, no negocio: 503 aunque traiga `httpStatus`', async () => {
    // `httpStatus` no significa «hubo HTTP»: significa «respondió 200». Un 502 anotado sigue siendo
    // el RUNT sin responder. El mutante que mata: `if (respuesta.httpStatus) return negocio`.
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(CAIDO_CON_502);

    const r = await alta(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(503);
    expect(r.body.codigo).toBe('runt_no_disponible');
  });

  it('el predicado heredado `/propietari/i` sigue vivo DEBAJO, para la vía que no trae `httpStatus`', async () => {
    // La vía directa del RUNT no pasa por la pasarela y no anota transporte. El mensaje de rechazo
    // por propietario es el que `certificacion-runt.ts` y `soat/refresh.service.ts` ya reconocen, y
    // se conserva como red: sin él, un rechazo de negocio por esa vía saldría como 503.
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue({
      ok: false, message: 'Los datos no corresponden con los propietarios activos del vehículo',
    });

    const r = await alta(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(422);
    expect(r.body.codigo).toBe('runt_no_cuadra');
  });

  it('**un `throw` de la pasarela es «caído», que es el defecto SEGURO: no crea nada**', async () => {
    escenario();
    consultarVehiculoRuntMock.mockRejectedValue(new Error('ECONNRESET'));

    const r = await alta(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(503);
    expect(r.body.codigo).toBe('runt_no_disponible');
    expect(espia.insertsEn('flito_soat')).toHaveLength(0);
    expect(uploadMock).not.toHaveBeenCalled();
  });
});

// ═══════════════ TC #11976 — lo que el RUNT NO TRAJO no es «no cuadra» ═══════

describe('AC2 — un campo que el RUNT no trajo NO es «no cuadra»: la solicitud SÍ se crea', () => {
  /**
   * **TC #11976, y el hueco que encontró el gate B.**
   *
   * Este aserto vivía en `flito-soat.cliente-verificacion-runt.test.ts`, la suite del job
   * post-commit que la HU #11966 borró. El borrado del job es legítimo —ya no existe—, pero este
   * aserto concreto se fue sin sustituto y era el ÚNICO que cubría las guardas de ausencia de
   * `campoQueNoCuadra`. Sin él, el mutante
   *
   *     -  if (placaRunt !== null && placaIn !== null && placaRunt !== placaIn) return 'placa';
   *     +  if (placaIn !== null && placaRunt !== placaIn) return 'placa';
   *
   * sobrevivía a los 301 tests del WI.
   *
   * ── Por qué el caso es ALCANZABLE y no una hipótesis ────────────────────────────────────────
   *
   * `placa` **no está en `SENALES_REGISTRO`** (`certificacion-runt.ts`), y es deliberado: la
   * pasarela devuelve el identificador con el que se consultó dentro de `vehiculo` aunque no
   * encuentre nada, así que fiarse de él es preguntar y creerse el eco. Consecuencia: una respuesta
   * `ok` con el vehículo POBLADO —`idAutomotor`, `marca`, `linea`…— pero sin `placa` pasa
   * `runtSinRegistro` y llega hasta la comparación con la guarda de null como única defensa.
   *
   * Lo que el mutante rompería no es un detalle: convertiría un alta legítima en un
   * `422 runt_no_cuadra`, es decir, le diría al Cliente que «revise los datos» cuando lo que falta
   * es un campo que el REGISTRO no publica y que él no puede corregir.
   */
  it('**TC #11976: el RUNT no trae `placa` → 201, no 422** (la guarda de ausencia)', async () => {
    escenario();
    // `placa: null` con el resto del vehículo poblado: `runtSinRegistro` ve `idAutomotor`, `marca`,
    // `linea`… y concluye —bien— que el vehículo SÍ está registrado.
    consultarVehiculoRuntMock.mockResolvedValue(runtOk({ placa: null }));

    const r = await alta(await buildApp(), await auth(siguienteUsuario()));

    expect(r.status, 'un campo NO VERIFICABLE no puede bloquear el alta').toBe(201);
    expect(r.body.codigo).toBeUndefined();
    expect(espia.insertsEn('flito_soat')).toHaveLength(1);
    // Y la placa que se persiste es la NORMALIZADA de la petición, que es la única que hay.
    expect(espia.ultimoInsertEn('vehicles').plate).toBe(PLACA);
  });

  it('**TC #11976 (simetría): el RUNT no trae `vin` pero el Cliente sí lo tecleó → no es «no cuadra»**', async () => {
    // El VIN tiene la MISMA forma de guarda y el hueco es idéntico, así que se cubre en el mismo
    // bloque: el mutante simétrico (`if (vinIn !== null && vinRunt !== vinIn)`) tiene que morir aquí.
    //
    // Ojo al desenlace: sin VIN del RUNT no hay VIN efectivo, así que el alta corta con
    // `runt_sin_vin` (AC5) — pero **no** con `runt_no_cuadra`. Esa diferencia ES el test: uno dice
    // «el registro no publica el VIN» y el otro «revise los datos», y solo el primero es cierto.
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk({ vin: null }));

    const r = await alta(await buildApp(), await auth(siguienteUsuario()));

    expect(r.body.codigo).toBe('runt_sin_vin');
    expect(r.body.codigo, 'un VIN que el RUNT no trajo no es «no cuadra»').not.toBe('runt_no_cuadra');
    expect(r.body.campo).toBeUndefined();
  });

  it('la guarda es de AUSENCIA, no de laxitud: un valor presente y distinto SÍ es «no cuadra»', async () => {
    // La otra mitad, y hace falta: un test que solo mirara el caso nulo pasaría igual con
    // `campoQueNoCuadra` devolviendo `null` siempre —el mutante contrario—, que dejaría entrar altas
    // sobre un vehículo que no es el que se radica.
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk({ placa: 'XXX999' }));

    const r = await alta(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(422);
    expect(r.body.codigo).toBe('runt_no_cuadra');
  });

  it('`campoQueNoCuadra`, llamada directamente: la tabla de verdad de las dos guardas', async () => {
    // El predicado, sin pasar por HTTP. Es donde se ve que la regla es «lo que el RUNT no trajo no
    // se compara», y no «a veces sale null».
    const { campoQueNoCuadra } = await import('../../src/modules/flito-soat/flito-soat-cliente-runt.js');
    const datos = (over: Record<string, unknown> = {}) => ({
      placa: PLACA, vin: VIN_RUNT, marca: null, linea: null, modelo: null, clase: null,
      cilindraje: null, tipoServicio: null, carroceria: null, pasajerosSentados: null,
      puertas: null, organismoNombre: null, propietarioNombre: null, ...over,
    });

    const entrada = { placa: PLACA, vin: VIN_RUNT };
    expect(campoQueNoCuadra(entrada, datos()), 'los dos coinciden').toBeNull();
    expect(campoQueNoCuadra(entrada, datos({ placa: null })), 'el RUNT no trajo placa').toBeNull();
    expect(campoQueNoCuadra(entrada, datos({ vin: null })), 'el RUNT no trajo VIN').toBeNull();
    expect(campoQueNoCuadra(entrada, datos({ placa: null, vin: null })), 'no trajo ninguno').toBeNull();
    // Y la entrada sin VIN tecleado tampoco compara: no hay nada que contrastar (AC1).
    expect(campoQueNoCuadra({ placa: PLACA, vin: null }, datos({ vin: 'OTROVIN000000001' }))).toBeNull();
    // Presentes y distintos: SÍ.
    expect(campoQueNoCuadra(entrada, datos({ placa: 'XXX999' }))).toBe('placa');
    expect(campoQueNoCuadra(entrada, datos({ vin: 'OTROVIN000000001' }))).toBe('vin');
    // La placa manda sobre el VIN cuando fallan las dos: el 422 sin `campo` es el más genérico.
    expect(campoQueNoCuadra(entrada, datos({ placa: 'XXX999', vin: 'OTROVIN000000001' }))).toBe('placa');
  });
});

// ═══════════════ La FORMA del log de la compuerta (PII en logs) ══════════════

describe('el log de la compuerta no lleva PII, en NINGUNA de sus dos ramas', () => {
  /** Todo lo que se escribió al log, aplanado, para buscar lo que no puede estar. */
  const textoDelLog = (): string =>
    JSON.stringify([...logMock.info.mock.calls, ...logMock.warn.mock.calls]);

  it('**rama `info` (el RUNT respondió que no): solo desenlace, código y transporte**', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(NEGATIVA_DE_NEGOCIO);
    await alta(await buildApp(), await auth(siguienteUsuario()));

    expect(logMock.info).toHaveBeenCalledTimes(1);
    // Las claves EXACTAS, no `toMatchObject`: lo que decide si esto es PII en logs es lo que NO
    // está, y un `toMatchObject` deja pasar cualquier campo añadido después.
    expect(Object.keys(ultimoLog('info')).sort()).toEqual(['codigo', 'desenlace', 'httpStatus']);
    expect(ultimoLog('info')).toEqual({ desenlace: 'revise', codigo: 'runt_no_cuadra', httpStatus: 200 });
  });

  it('**rama `warn` (un `throw`): causa de vocabulario CERRADO, nunca el mensaje crudo**', async () => {
    // El hueco que el gate B señaló. El mensaje de un `throw` es texto de un TERCERO: aquí lleva
    // dentro la placa y el documento, que es exactamente lo que podría venir de la pasarela.
    escenario();
    consultarVehiculoRuntMock.mockRejectedValue(
      new Error(`ETIMEDOUT consultando ${PLACA} para el documento ${DOCUMENTO}`),
    );

    await alta(await buildApp(), await auth(siguienteUsuario()));

    expect(logMock.warn).toHaveBeenCalledTimes(1);
    expect(Object.keys(ultimoLog('warn')).sort()).toEqual(['causa', 'desenlace', 'httpStatus']);
    expect(ultimoLog('warn')).toEqual({ desenlace: 'caido', causa: 'timeout', httpStatus: null });

    // Y la comprobación que de verdad importa: ni la placa, ni el VIN, ni el documento, ni un
    // fragmento del mensaje original en NADA de lo que se escribió.
    const escrito = textoDelLog();
    for (const pii of [PLACA, VIN_RUNT, DOCUMENTO, 'JUANA', 'juana@empresa.co']) {
      expect(escrito, `${pii} no puede acabar en el log`).not.toContain(pii);
    }
    expect(escrito).not.toContain('consultando');
  });

  it('la causa clasifica sin publicar: cuatro tokens y nada más', async () => {
    const { causaDeCaida } = await import('../../src/modules/flito-soat/flito-soat-cliente-runt.js');

    expect(causaDeCaida(new Error('Timeout 90s'))).toBe('timeout');
    expect(causaDeCaida(new Error('ETIMEDOUT'))).toBe('timeout');
    expect(causaDeCaida(new Error('ECONNRESET'))).toBe('red');
    expect(causaDeCaida(new Error('socket hang up'))).toBe('red');
    expect(causaDeCaida(new Error('Circuit breaker abierto'))).toBe('circuito');
    // Lo que no casa ninguna regla sale como `otro` — **nunca** como el texto original, que es la
    // propiedad que hace del vocabulario algo cerrado y no una lista de sugerencias.
    const conPii = causaDeCaida(new Error(`fallo raro con la placa ${PLACA}`));
    expect(conPii).toBe('otro');
    expect(conPii).not.toContain(PLACA);
    // Y no revienta con lo que no es un Error.
    expect(causaDeCaida(null)).toBe('otro');
    expect(causaDeCaida('ETIMEDOUT')).toBe('timeout');
  });

  it('un alta que SALE BIEN no escribe nada en el log de la compuerta', async () => {
    // El log es para medir los desenlaces que preocupan (ADR-0010). Escribir una línea por alta
    // correcta lo llenaría de ruido y, sobre todo, multiplicaría por N las ocasiones de fuga.
    escenario();
    await alta(await buildApp(), await auth(siguienteUsuario()));

    expect(logMock.info).not.toHaveBeenCalled();
    expect(logMock.warn).not.toHaveBeenCalled();
  });
});

// ═══════════════ La simetría de los dos endpoints ════════════════════════════

describe('los DOS endpoints devuelven lo mismo ante el mismo RUNT (una sola compuerta)', () => {
  /**
   * Los cinco desenlaces con los que la compuerta puede cortar, y el par (status, codigo) esperado.
   *
   * Se recorren contra `POST /cliente` y contra `POST /cliente/preconsulta` con el MISMO mock: si
   * alguien copiara la compuerta en uno de los dos, la copia divergiría en el primer cambio y este
   * bloque lo vería. El wizard bloqueando lo que la API acepta es el fallo que esto previene.
   */
  const DESENLACES = [
    { nombre: 'RUNT caído', runt: () => CAIDO_SIN_STATUS, status: 503, codigo: 'runt_no_disponible' },
    { nombre: 'negativa de negocio', runt: () => NEGATIVA_DE_NEGOCIO, status: 422, codigo: 'runt_no_cuadra' },
    { nombre: 'sin registro', runt: () => ({ ok: true, data: { vehiculo: { placa: PLACA, vin: VIN_RUNT } } }), status: 422, codigo: 'runt_sin_registro' },
    { nombre: 'VIN que no cuadra', runt: () => runtOk({ vin: 'VINQUENOCUADRA01' }), status: 422, codigo: 'runt_no_cuadra' },
    { nombre: 'SOAT vigente', runt: () => runtOk({}, { estadoSoat: 'VIGENTE', fechaVencimSoat: '01/02/2030' }), status: 409, codigo: 'soat_vigente' },
  ] as const;

  it.each(DESENLACES)('$nombre → $status `$codigo` en el ALTA y en la PRECONSULTA', async ({ runt, status, codigo }) => {
    const app = await buildApp();

    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runt());
    const rAlta = await alta(app, await auth(siguienteUsuario()));

    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runt());
    const rPre = await preconsultar(app, await auth(siguienteUsuario()));

    expect(rAlta.status).toBe(status);
    expect(rAlta.body.codigo).toBe(codigo);
    // La igualdad ENTRE los dos es el aserto que importa: fijar cada uno contra su constante deja
    // pasar que uno de los dos se quede atrás en el próximo cambio.
    expect(rPre.status).toBe(rAlta.status);
    expect(rPre.body.codigo).toBe(rAlta.body.codigo);
  });
});

// ═══════════════ AC1 — VIN opcional y VIN efectivo ═══════════════════════════

describe('AC1 — el VIN es opcional en la entrada y el que se guarda es el del RUNT', () => {
  it('**alta SIN VIN → 201, y `flito_soat.vin` es el del RUNT**', async () => {
    escenario();
    const r = await alta(await buildApp(), await auth(siguienteUsuario()), { vin: null });

    expect(r.status).toBe(201);
    expect(espia.ultimoInsertEn('flito_soat').vin).toBe(VIN_RUNT);
    expect(espia.ultimoInsertEn('vehicles').vin).toBe(VIN_RUNT);
    // Y la consulta salió por placa + documento, sin VIN.
    expect(consultarVehiculoRuntMock).toHaveBeenCalledWith(PLACA, undefined, DOCUMENTO, 'C');
  });

  it('el VIN tecleado se NORMALIZA antes de contrastarlo: minúsculas no son «no cuadra»', async () => {
    // `CAMPOS` manda el VIN en minúsculas a propósito, que es como llega de un formulario. Si el
    // contraste comparara la cadena cruda contra la del RUNT, TODA esta suite saldría 422 — así que
    // el caso fija además que la consulta a Kyverum sale con el identificador ya en mayúsculas.
    // (Un VIN con guiones no llega hasta aquí: `max(17)` lo corta en Zod, y eso no cambia con esta HU.)
    escenario();
    const r = await alta(await buildApp(), await auth(siguienteUsuario()), { vin: VIN_RUNT.toLowerCase() });

    expect(r.status).toBe(201);
    expect(espia.ultimoInsertEn('flito_soat').vin).toBe(VIN_RUNT);
    expect(consultarVehiculoRuntMock).toHaveBeenCalledWith(PLACA, VIN_RUNT, DOCUMENTO, 'C');
  });

  it('**sin VIN tecleado, la RN-01 se comprueba sobre el VIN EFECTIVO** (o el UNIQUE saldría como 500)', async () => {
    // Sin VIN no hay clave por la que buscar antes de consultar, así que la comprobación temprana no
    // corre. Si la autoritativa tampoco corriera, la RN-01 la aplicaría el UNIQUE de la base y el
    // cliente vería un 500 en vez de «este vehículo ya tiene SOAT».
    escenario({ flito_soat: [{ id: 'aaaa', estado: 'pagado', companiaId: COMPANIA }] });

    const r = await alta(await buildApp(), await auth(siguienteUsuario()), { vin: null });
    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('vin_ya_tiene_soat');
    expect(espia.insertsEn('flito_soat')).toHaveLength(0);
    // El RUNT SÍ se consultó —no había forma de saberlo antes—, y ese es el coste declarado de que
    // el VIN sea opcional.
    expect(consultarVehiculoRuntMock).toHaveBeenCalledTimes(1);
  });

  it('con VIN tecleado, la RN-01 corta ANTES de gastar la consulta a Kyverum', async () => {
    escenario({ flito_soat: [{ id: 'aaaa', estado: 'pagado', companiaId: COMPANIA }] });

    const r = await alta(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(409);
    expect(consultarVehiculoRuntMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('**el RUNT sin VIN → 422 `runt_sin_vin`, un código PROPIO y no «revise los datos»**', async () => {
    // AC5: «sin VIN en la respuesta del RUNT no se crea (RN-01)». Es un código aparte porque «revise
    // los datos» le pediría al usuario que corrija algo suyo, y aquí no hay nada que corregir: el
    // registro no publica el VIN.
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk({ vin: null }));

    const r = await alta(await buildApp(), await auth(siguienteUsuario()), { vin: null });
    expect(r.status).toBe(422);
    expect(r.body.codigo).toBe('runt_sin_vin');
    expect(r.body.codigo).not.toBe('runt_no_cuadra');
    expect(espia.insertsEn('flito_soat')).toHaveLength(0);
  });

  it('`CODIGOS_REVISE_LOS_DATOS` es la familia de los tres 422, y NO incluye el 503', async () => {
    const { CODIGOS_REVISE_LOS_DATOS, CodigoErrorSolicitudSoat } = await import('@operaciones/shared-types');
    expect([...CODIGOS_REVISE_LOS_DATOS]).toEqual(['runt_sin_registro', 'runt_no_cuadra', 'runt_sin_vin']);
    // La ausencia ES el AC4: si `runt_no_disponible` entrara aquí, la pantalla presentaría un fallo
    // de transporte como un error del usuario.
    expect(CODIGOS_REVISE_LOS_DATOS as readonly string[])
      .not.toContain(CodigoErrorSolicitudSoat.RUNT_NO_DISPONIBLE);
  });
});

// ═══════════════ AC5 — el propietario, partido ═══════════════════════════════

describe('AC5 — el titular va partido: NIT ⇒ razón social, natural ⇒ nombres y apellidos', () => {
  it('**NIT → se guarda `razonSocial` y NI nombres NI apellidos**', async () => {
    escenario();
    const r = await alta(await buildApp(), await auth(siguienteUsuario()), {
      tipoDocumento: 'NIT', numeroDocumento: '9001234561',
      nombres: null, apellidos: null, razonSocial: 'TRANSPORTES SINTETICOS SAS',
    });

    expect(r.status).toBe(201);
    const p = espia.ultimoInsertEn('flito_compradores');
    expect(p).toMatchObject({ razonSocial: 'TRANSPORTES SINTETICOS SAS', nombres: null, apellidos: null });
    // El derivado sale de la razón social, no de una concatenación vacía.
    expect(p.nombreCompleto).toBe('TRANSPORTES SINTETICOS SAS');
  });

  it('**un NIT con nombres → 400: lo prohibido se RECHAZA, no se ignora en silencio**', async () => {
    // La mitad negativa es la que respalda `flito_compradores_titular_chk`. Ignorar el campo dejaría
    // pasar un cuerpo que la base habría rechazado con 23514 → 500.
    escenario();
    const r = await alta(await buildApp(), await auth(siguienteUsuario()), {
      tipoDocumento: 'NIT', numeroDocumento: '9001234561',
      nombres: 'JUANA', apellidos: null, razonSocial: 'TRANSPORTES SINTETICOS SAS',
    });
    expect(r.status).toBe(400);
    expect(espia.insertsEn('flito_compradores')).toHaveLength(0);
  });

  it('una persona natural con razón social → 400', async () => {
    escenario();
    const r = await alta(await buildApp(), await auth(siguienteUsuario()), {
      razonSocial: 'TRANSPORTES SINTETICOS SAS',
    });
    expect(r.status).toBe(400);
  });

  it('un NIT sin razón social → 400; una persona natural sin apellidos → 400', async () => {
    const app = await buildApp();

    escenario();
    const nitSinRazon = await alta(app, await auth(siguienteUsuario()), {
      tipoDocumento: 'NIT', numeroDocumento: '9001234561', nombres: null, apellidos: null,
    });
    expect(nitSinRazon.status).toBe(400);

    escenario();
    const naturalSinApellidos = await alta(app, await auth(siguienteUsuario()), { apellidos: null });
    expect(naturalSinApellidos.status).toBe(400);
  });

  it.each(['correo', 'celular', 'direccion', 'municipio', 'departamento'])(
    '**`%s` es obligatorio para este canal → 400 sin él** (aunque la columna siga nullable en la tabla)',
    async (campo) => {
      escenario();
      const r = await alta(await buildApp(), await auth(siguienteUsuario()), { [campo]: null });
      expect(r.status).toBe(400);
      expect(espia.insertsEn('flito_soat')).toHaveLength(0);
    },
  );

  /**
   * **El 401 que encontró el `db-review-agent`, y por qué es un 400 y no un 500.**
   *
   * `nombres` y `apellidos` son dos cotas INDEPENDIENTES de 200 que alimentan una columna de 200:
   * `flito_compradores.nombre_completo` (NOT NULL) y `vehicles.owner_name`, los dos `varchar(200)`.
   * `nombreCompletoDe()` concatena sin truncar, así que el máximo alcanzable era `200 + 1 + 200`.
   * Sin la cota del derivado, ese alta moría con `22001 value too long` DENTRO de la transacción y
   * salía como 500 — un error de servidor por un cuerpo que el servidor aceptó.
   *
   * Es la misma familia de defecto que el CHECK del titular: el borde y la base tienen que decir lo
   * mismo, o el primer INSERT «válido» revienta.
   */
  it('**un nombre partido que SUMA más de 200 → 400, no 500** (la cota del derivado)', async () => {
    escenario();
    const r = await alta(await buildApp(), await auth(siguienteUsuario()), {
      nombres: 'N'.repeat(200), apellidos: 'A'.repeat(200),
    });

    expect(r.status, 'el 22001 tiene que atajarse en el borde, no en la transacción').toBe(400);
    expect(r.body.error).toBe('Datos inválidos');
    // Y el error cuelga de los DOS campos, para que el formulario pueda marcar los dos: el usuario
    // acorta el que quiera y ninguno es «el culpable».
    const campos = r.body.details?.fieldErrors ?? {};
    expect(Object.keys(campos)).toEqual(expect.arrayContaining(['nombres', 'apellidos']));
    // Nada escrito: ni la fila, ni la ficha del vehículo, ni el objeto en el bucket.
    expect(espia.insertsEn('flito_soat')).toHaveLength(0);
    expect(espia.insertsEn('flito_compradores')).toHaveLength(0);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('**el borde: exactamente 200 SÍ entra**, y 201 no es un rechazo de más', async () => {
    // La otra mitad, y hace falta: un test que solo mirara el caso largo pasaría igual con una cota
    // demasiado estricta —bajar los dos campos a 100— que rechazaría nombres legítimos. Aquí el
    // derivado mide 200 clavados (`99 + 1 + 100`).
    escenario();
    const r = await alta(await buildApp(), await auth(siguienteUsuario()), {
      nombres: 'N'.repeat(99), apellidos: 'A'.repeat(100),
    });

    expect(r.status).toBe(201);
    const guardado = String(espia.ultimoInsertEn('flito_compradores').nombreCompleto);
    expect(guardado).toHaveLength(200);
    // Y llega ENTERO a la columna: la cota rechaza, no trunca. Truncar dejaría la cola buscando
    // sobre una cadena recortada mientras el Excel publica los campos partidos completos.
    expect(guardado).toBe(`${'N'.repeat(99)} ${'A'.repeat(100)}`);
  });

  it('un nombre de pila largo con apellido corto entra: la cota es del DERIVADO, no de cada campo', async () => {
    // Bajar `nombres` y `apellidos` a `max(100)` cerraría el 401 por construcción y rechazaría esto,
    // que cabe de sobra. Este caso es el que fija cuál de las dos salidas se tomó.
    escenario();
    const r = await alta(await buildApp(), await auth(siguienteUsuario()), {
      nombres: 'N'.repeat(150), apellidos: 'A'.repeat(20),
    });
    expect(r.status).toBe(201);
  });

  it('una razón social de 200 entra: el derivado de un NIT es ella misma, sin concatenar', async () => {
    escenario();
    const r = await alta(await buildApp(), await auth(siguienteUsuario()), {
      tipoDocumento: 'NIT', numeroDocumento: '9001234561',
      nombres: null, apellidos: null, razonSocial: 'R'.repeat(200),
    });
    expect(r.status).toBe(201);
    expect(String(espia.ultimoInsertEn('flito_compradores').nombreCompleto)).toHaveLength(200);
  });

  it('`nombreCompleto` ya NO se acepta del cliente: mandarlo no cambia lo que se guarda', async () => {
    // Zod descarta las claves que no declara. Lo que importa es que el nombre persistido salga del
    // DERIVADO y no del campo colado: dos fuentes para el mismo nombre es lo que esta HU cierra.
    escenario();
    const r = await alta(await buildApp(), await auth(siguienteUsuario()), {
      nombreCompleto: 'NOMBRE COLADO POR EL FORMULARIO',
    });
    expect(r.status).toBe(201);
    expect(espia.ultimoInsertEn('flito_compradores').nombreCompleto).toBe('JUANA PEREZ');
  });

  it('la ficha de `vehicles` guarda el nombre DERIVADO como titular, no una cadena vacía', async () => {
    escenario();
    await alta(await buildApp(), await auth(siguienteUsuario()));
    expect(espia.ultimoInsertEn('vehicles').ownerName).toBe('JUANA PEREZ');
  });
});

// ═══════════════ PII — el alta vuelve a tocar un registro nacional ═══════════

describe('PII — el alta consulta el RUNT dentro de la petición, y deja rastro (Ley 1581 art. 17)', () => {
  it('**`POST /cliente` registra el acceso, con motivo propio y sin la placa**', async () => {
    // Bajo la #11935 esta ruta no lo necesitaba: la consulta ocurría después del COMMIT, fuera de
    // cualquier `req`. El mutante que mata: borrar la llamada de la ruta.
    escenario();
    await alta(await buildApp(), await auth(siguienteUsuario()));

    expect(piiMock).toHaveBeenCalledTimes(1);
    const registro = piiMock.mock.calls[0][1];
    expect(registro.accion).toBe('read');
    expect(registro.camposAccedidos).toEqual(expect.arrayContaining(['placa', 'vin']));
    // El motivo distingue el alta de la preconsulta: si las dos escribieran la misma línea,
    // «¿cuántas veces consultaron mi vehículo sin radicar nada?» dejaría de tener respuesta.
    expect(String(registro.motivo)).toMatch(/alta/i);
    expect(String(registro.motivo)).not.toMatch(/preconsulta/i);
    // La placa es uno de los campos que este registro protege: no puede acabar guardada como el
    // MOTIVO de su propia consulta.
    expect(String(registro.motivo)).not.toContain(PLACA);
    expect(String(registro.motivo)).not.toContain(DOCUMENTO);
  });

  it('el alta NO declara `nombre_completo`: su 201 no devuelve el nombre que trajo el RUNT', async () => {
    // La preconsulta sí lo declara, porque sí lo publica. Declarar de más hace que
    // `campos_accedidos` deje de decir la verdad, que es lo único que ese registro tiene que hacer.
    escenario();
    await alta(await buildApp(), await auth(siguienteUsuario()));
    expect(piiMock.mock.calls[0][1].camposAccedidos).not.toContain('nombre_completo');
  });

  it('un alta que la compuerta RECHAZA no escribe rastro de acceso… ni deja objeto en el bucket', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(CAIDO_SIN_STATUS);

    expect((await alta(await buildApp(), await auth(siguienteUsuario()))).status).toBe(503);
    // El rastro va DESPUÉS del 201 y solo cuando la solicitud se creó. Un 503 no entregó nada.
    expect(piiMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('**el payload crudo del RUNT no se persiste en ninguna fila** (ADR-0008 §1.6, conservado)', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue({
      ...runtOk(),
      data: { ...runtOk().data, licencias: [{ numero: 'L-1', documento: DOCUMENTO }] },
    });

    expect((await alta(await buildApp(), await auth(siguienteUsuario()))).status).toBe(201);

    const escrito = JSON.stringify(espia.inserts.map((m) => m.datos));
    expect(escrito).not.toContain('licencias');
    expect(escrito).not.toContain('idAutomotor');
    expect(escrito).not.toContain('estadoAutomotor');
  });
});

// ═══════════════ El job de la #11935 ya no existe ════════════════════════════

describe('AC6 — el satélite post-commit se BORRÓ: no hay reconsulta posible', () => {
  it('**el módulo del canal ya no exporta `verificarRuntPostAlta` ni `programarVerificacionRunt`**', async () => {
    // No es un aserto cosmético: mientras la función exista, cualquiera puede llamarla sobre una
    // fila radicada bajo la #11935 y reescribir su `verificacion_estado`, que es lo que el AC6
    // prohíbe. Sin función, no hay reconsulta posible por descuido.
    const mod = await import('../../src/modules/flito-soat/flito-soat-cliente-runt.js');
    expect(Object.keys(mod)).not.toContain('verificarRuntPostAlta');
    expect(Object.keys(mod)).not.toContain('programarVerificacionRunt');
    // Y tampoco la ficha en blanco que el alta escribía antes de consultar.
    expect(Object.keys(mod)).not.toContain('DATOS_RUNT_VACIOS');
  });

  it('el 201 no deja ninguna escritura pendiente sobre el satélite después de responder', async () => {
    escenario();
    const r = await alta(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(201);

    const updatesAlResponder = espia.updatesEn('flito_soat_solicitud').length;
    // Un `setImmediate` correría en el siguiente tick: si quedara alguno programado, aquí se vería.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(espia.updatesEn('flito_soat_solicitud')).toHaveLength(updatesAlResponder);
    expect(espia.updatesEn('flito_soat')).toHaveLength(0);
    // Y una sola consulta a Kyverum en total: la de la compuerta.
    expect(consultarVehiculoRuntMock).toHaveBeenCalledTimes(1);
  });
});
