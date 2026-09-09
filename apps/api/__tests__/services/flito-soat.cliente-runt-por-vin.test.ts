// HU #12090 (Feature #12073) — **el RUNT se consulta SOLO POR VIN**.
//
// Las dos suites hermanas conservan, invertidos en su sitio, los casos que dejaron de ser ciertos:
// `flito-soat.cliente-alta.test.ts` (el contrato de los dos endpoints) y
// `flito-soat.cliente-alta-runt-compuerta.test.ts` (la compuerta y la placa que pasa de entrada a
// salida). Aquí vive lo que esta HU ESTRENA y que allí no tenía sitio, que son cuatro cosas y todas
// se pueden romper en silencio:
//
//   1. **`tipoDocPropietario` es RELLENO FIJO y no se persiste ni se muestra** (AC2). En la modalidad
//      de VIN la vía directa lo devuelve siempre como `'C'` —`tiposAIntentar = ['C']`—, así que no
//      es lo que el registro dice del propietario sino el tipo con el que se intentó la consulta.
//      Se afirma sobre TODOS los INSERT y sobre el cuerpo de la preconsulta, no sobre la clave que
//      uno se acuerde de mirar.
//   2. **La procedencia (HU #12093) no puede certificar como «del RUNT» lo que el RUNT no dio.** El
//      alta nunca escribe `runt` por su cuenta, y el mapa persistido no tiene ninguna clave para el
//      tipo de documento del propietario que devuelve el registro.
//   3. **El ORDEN de evaluación de los cuatro desenlaces se conserva entero** (AC4), medido donde se
//      decide (`clasificarDesenlaceRunt`) y con payloads que disparan DOS condiciones a la vez: un
//      test que ejerciera una sola por caso no vería un reordenamiento.
//   4. **RN-B1 (AC6)**: cada consulta deja rastro con `registrarAccesoRuntCliente`, el VIN viaja en
//      el CUERPO y nunca en la URL, y la ruta sigue bajo el limitador del canal.
//
// ── Y lo que añade la auditoría de seguridad (bloqueantes 1 y 3) ────────────────────────────────
//
//   5. **El piso del VIN se mide sobre lo NORMALIZADO**, no sobre lo trimeado. Es la diferencia
//      entre un piso que vale y uno que no: `'A-B-C'` tiene cinco caracteres al entrar y TRES al
//      salir hacia el RUNT, y la de salida es la que se consulta y la que busca en las dos guardas.
//   6. **La preconsulta lleva DOS limitadores, y en un orden concreto**: el compartido del canal
//      primero —para que un sondeo gaste también ese presupuesto— y el sub-límite propio después.
//
// Montaje calcado del de la compuerta: router real, `authMiddleware` real y el INSERT medido con
// `espia-drizzle` —afirmar sobre el cuerpo de la respuesta probaría el mock—. Un `sub` distinto por
// caso: el limitador del canal es por usuario y su ventana dura 15 minutos.

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

const COMPANIA = 7;
const VEHICULO_ID = 55;
const ORGANISMO_FUNZA = '25286';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n');

/** VIN y placa sintéticos: ni un VIN ni una cédula reales en esta suite. */
const VIN_RUNT = '9FKRG2222T2042405';
const PLACA = 'JNH38H';
/** La placa que el formulario todavía manda hasta la HU #12091, distinta de la del RUNT. */
const PLACA_TECLEADA = 'ZZZ999';
const DOCUMENTO = '1020304050';

/**
 * La respuesta del RUNT **con la forma REAL de la vía directa**, `tipoDocPropietario` incluido.
 *
 * Ese campo es hermano de `vehiculo` y no hijo suyo (`{ ok, data: { vehiculo, tipoDocPropietario,
 * … } }`), y en la modalidad de VIN vale siempre `'C'`. Está aquí a propósito: sin él, los asertos
 * de «no se persiste» pasarían en verde por no haber nada que persistir.
 */
function runtOk(over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
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
      tipoDocPropietario: 'C',
      soat: { estadoSoat: 'NO VIGENTE', fechaVencimSoat: '01/01/2020' },
      ...extra,
    },
  };
}

let sub = 900;
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
    clients: [{
      id: COMPANIA, sinTramite: true, carpeta: 'clientes/acme',
      proveedorId: '55555555-5555-4555-8555-555555555555', activo: true,
    }],
    flito_soat: [],
    organismos_transito_config: [{ codigo: ORGANISMO_FUNZA, alias: 'FUNZA' }],
    vehicles: [],
    ...(over as Record<string, unknown[]>),
  });
  kdb.when.insert('vehicles', [{ id: VEHICULO_ID }]);
}

/** El cuerpo del alta, con las claves que el front sigue mandando hasta la HU #12091. */
const CAMPOS: Record<string, string> = {
  placa: PLACA_TECLEADA.toLowerCase(), vin: VIN_RUNT.toLowerCase(),
  tipoDocumento: 'CC', numeroDocumento: DOCUMENTO,
  nombres: 'JUANA', apellidos: 'PEREZ',
  correo: 'juana@empresa.co', celular: '3001234567', direccion: 'CALLE 1 # 2-3',
  municipio: 'FUNZA', departamento: 'CUNDINAMARCA',
};

function alta(app: express.Express, token: string, campos: Record<string, string | null> = {}) {
  const req = request(app).post('/api/flito/soat/cliente').set('Authorization', token);
  for (const [k, v] of Object.entries({ ...CAMPOS, ...campos })) {
    if (v !== null) req.field(k, v);
  }
  return req.attach('facturaVenta', PDF, { filename: 'factura.pdf', contentType: 'application/pdf' });
}

const preconsultar = (app: express.Express, token: string, cuerpo: Record<string, string> = { vin: VIN_RUNT }) =>
  request(app).post('/api/flito/soat/cliente/preconsulta').set('Authorization', token).send(cuerpo);

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  consultarVehiculoRuntMock.mockReset().mockResolvedValue(runtOk());
  uploadMock.mockReset().mockResolvedValue('clientes/acme/soat/facturas-venta/abc.pdf');
  auditMock.mockClear();
  piiMock.mockClear();
});

// ═══════════ Bloqueante 1 — el piso del VIN se mide sobre lo que SALE ════════

describe('bloqueante 1 — el `min` del VIN cuenta sobre el valor NORMALIZADO, no sobre el trimeado', () => {
  /**
   * Los fragmentos que el piso anterior dejaba pasar, con su longitud real al salir.
   *
   * `.trim()` solo quita espacios; `normalizarId()` quita ADEMÁS los separadores, y era su salida la
   * que se le mandaba a Kyverum y la que buscaban `verificarRn01` y `verificarTenenciaVehiculo`. Los
   * tres pasaban un `min(5)` sobre el trimeado y consultaban un registro nacional de pago con uno,
   * tres y CERO caracteres respectivamente.
   */
  const FRAGMENTOS: readonly [string, string][] = [
    ['--A--', 'A'],
    ['A-B-C', 'ABC'],
    ['-----', ''],
    ['....!', ''],
    ['  9fkrg-2222 ', '9FKRG2222'],
  ];

  it.each(FRAGMENTOS)('**`%s` → 400: normaliza a `%s` y nunca llega al RUNT**', async (crudo) => {
    escenario();
    const r = await preconsultar(await buildApp(), await auth(siguienteUsuario()), { vin: crudo });

    expect(r.status).toBe(400);
    expect(r.body.details?.fieldErrors ?? {}).toHaveProperty('vin');
    // Lo que de verdad importa: el fragmento no sale del perímetro. Un 400 que igualmente hubiera
    // consultado sería el mismo agujero con otra respuesta.
    expect(consultarVehiculoRuntMock).not.toHaveBeenCalled();
  });

  it('el mismo piso rige en el ALTA, no solo en la preconsulta', async () => {
    // Las dos rutas comparten `vehiculoSchema`. Si alguien las separara, el alta seguiría
    // consultando con fragmentos —y además subiría el PDF a S3 antes de descubrirlo—.
    escenario();
    const r = await alta(await buildApp(), await auth(siguienteUsuario()), { vin: 'A-B-C' });

    expect(r.status).toBe(400);
    expect(consultarVehiculoRuntMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('**el borde de 11: diez caracteres normalizados es 400, once es 200**', async () => {
    // La otra mitad, y hace falta: un test que solo mirara los fragmentos pasaría igual con un piso
    // de 17, que rechazaría chasis legítimos más cortos. Aquí queda fijado CUÁL es el piso elegido.
    const app = await buildApp();

    escenario();
    const diez = await preconsultar(app, await auth(siguienteUsuario()), { vin: '9FKRG-2222-T' });
    expect(diez.status, '«9FKRG2222T» son DIEZ al normalizar: por debajo del piso').toBe(400);
    expect(consultarVehiculoRuntMock).not.toHaveBeenCalled();

    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk({ vin: '9FKRG2222T2' }));
    const once = await preconsultar(app, await auth(siguienteUsuario()), { vin: '9FKRG-2222-T2' });
    expect(once.status, '«9FKRG2222T2» son ONCE: justo en el piso').toBe(200);
    expect(consultarVehiculoRuntMock).toHaveBeenCalledWith(undefined, '9FKRG2222T2', '', '');
  });

  it('**lo que se consulta es exactamente lo normalizado**, y el `max(17)` también cuenta ahí', async () => {
    // Efecto lateral BUENO del cambio: un VIN legítimo tecleado con separadores mide 19 en crudo y
    // 17 al normalizar. Antes era un 400; ahora entra, y sale a Kyverum ya limpio. El aserto fija
    // las dos cosas a la vez —que entra y con qué cadena se consulta—, que es lo que impide
    // «arreglarlo» devolviendo el `max` al valor crudo.
    escenario();
    const r = await preconsultar(await buildApp(), await auth(siguienteUsuario()), {
      vin: '9FKRG-2222-T2042405',
    });

    expect(r.status).toBe(200);
    expect(consultarVehiculoRuntMock).toHaveBeenCalledWith(undefined, VIN_RUNT, '', '');
  });

  it('`normalizarId` es idempotente y hace lo que el piso supone (prueba de la FUNCIÓN, no del router)', async () => {
    // **Este caso NO es estructural, y decirlo importa**: prueba el comportamiento de la función, no
    // que el router use ese símbolo. Antes decía que «una copia equivalente en el router pondría
    // rojo el caso de arriba», y el gate B midió que era FALSO: con un clon idéntico pegado en el
    // router, los 202 tests seguían verdes. Quien vigila la deriva es la tabla `POR LA RUTA` de
    // abajo, cuyo esperado se calcula con esta misma función; esto solo fija sus propiedades.
    const { normalizarId } = await import('../../src/modules/flito-soat/flito-soat-cliente.service.js');

    expect(normalizarId('A-B-C')).toBe('ABC');
    expect(normalizarId('  9fkrg-2222 t2042405 ')).toBe(VIN_RUNT);
    expect(normalizarId('-----')).toBe('');
    // Idempotente: el servicio la vuelve a aplicar sobre lo que el borde ya normalizó.
    expect(normalizarId(normalizarId('9fkrg-2222-t2042405'))).toBe(VIN_RUNT);
  });

  /**
   * **La red que sí atrapa una copia divergente en el router.**
   *
   * El esperado NO es un literal: se calcula llamando a `normalizarId()`, la función del servicio.
   * Así el test compara la salida del ROUTER contra la función real, y un clon que se separe —aunque
   * sea en un solo carácter de la clase— deja de coincidir. Con literales, un clon derivado seguiría
   * pasando mientras el literal coincidiera con su salida.
   *
   * Los casos cubren las CUATRO reglas por separado, y esa separación es el punto: el gate B midió
   * que un clon derivado a `trim().toUpperCase()` —que quita espacios pero no guiones— solo tumbaba
   * dos casos, porque el piso de 11 absorbe los fragmentos y `'A-B-C'` fallaba igual por corto. Una
   * deriva PARCIAL (quita guiones y no espacios, o al revés) se escapaba entera. Aquí cada regla
   * tiene un caso cuyo VIN normalizado SÍ pasa el piso, así que ninguna puede caerse en silencio.
   */
  const NORMALIZACIÓN_POR_LA_RUTA: readonly [string, string][] = [
    ['minúsculas', '9fkrg2222t2042405'],
    ['guiones', '9FKRG-2222-T2042405'],
    ['espacios', '9FKRG 2222 T2042405'],
    ['puntos y barras', '9FKRG.2222/T2042405'],
    ['todo junto', '  9fkrg-2222 . t2042405  '],
  ];

  it.each(NORMALIZACIÓN_POR_LA_RUTA)(
    '**POR LA RUTA (%s): lo que sale a Kyverum es exactamente `normalizarId(crudo)`**',
    async (_regla, crudo) => {
      const { normalizarId } = await import('../../src/modules/flito-soat/flito-soat-cliente.service.js');
      escenario();

      const r = await preconsultar(await buildApp(), await auth(siguienteUsuario()), { vin: crudo });

      // El esperado sale de la función REAL, no de una cadena escrita a mano.
      expect(r.status).toBe(200);
      expect(consultarVehiculoRuntMock).toHaveBeenCalledWith(undefined, normalizarId(crudo), '', '');
      // Y es el VIN del RUNT: los cinco crudos describen el mismo vehículo, así que si alguno se
      // normalizara distinto, además de no coincidir aquí saldría 422 por no cuadrar.
      expect(normalizarId(crudo)).toBe(VIN_RUNT);
    },
  );
});

// ═══════════ Bloqueante 3 — el sub-límite de la preconsulta ══════════════════

describe('bloqueante 3 — la preconsulta lleva su propio sub-límite, anidado bajo el del canal', () => {
  /** Los middlewares montados en una ruta del router, en ORDEN. */
  const middlewaresDe = async (patron: string) => {
    const { default: router } = await import('../../src/modules/flito-soat/flito-soat-cliente.routes.js');
    const capa = (router as unknown as { stack: { route?: { path: string; stack: { handle: unknown }[] } }[] })
      .stack.find((c) => c.route?.path === patron);
    expect(capa, `la ruta ${patron} tiene que existir`).toBeDefined();
    return capa!.route!.stack.map((h) => h.handle);
  };

  it('**los dos limitadores están, y el COMPARTIDO va primero**', async () => {
    // El orden es la decisión, no un detalle: con el sub-límite delante, un sondeo frenado por él no
    // gastaría el presupuesto del canal y la preconsulta tendría de hecho un presupuesto aparte —que
    // es justo lo que el docblock del limitador compartido decidió no darle.
    const { soatClienteLimiter, soatPreconsultaLimiter } = await import('../../src/shared/middleware/rateLimiter.js');
    const cadena = await middlewaresDe('/cliente/preconsulta');

    expect(cadena).toContain(soatClienteLimiter);
    expect(cadena).toContain(soatPreconsultaLimiter);
    expect(cadena.indexOf(soatClienteLimiter)).toBeLessThan(cadena.indexOf(soatPreconsultaLimiter));
  });

  it('**el sub-límite NO se aplica al alta**, que sigue bajo el contador del canal', async () => {
    // Es de la preconsulta y de nadie más: ponerlo en el alta frenaría la petición que sí crea una
    // fila, que es la que no hay motivo para racionar más allá del contador del canal.
    const { soatClienteLimiter, soatPreconsultaLimiter } = await import('../../src/shared/middleware/rateLimiter.js');
    const cadena = await middlewaresDe('/cliente');

    expect(cadena, 'el alta sigue bajo el contador del canal').toContain(soatClienteLimiter);
    expect(cadena, 'el alta no lleva el sub-límite de la preconsulta').not.toContain(soatPreconsultaLimiter);
  });

  it('**la lectura de factura ya NO cuelga del contador del canal** (HU #12214, AC2)', async () => {
    // Hasta la #12214 esta ruta iba con `soatClienteLimiter` y cada relectura le quitaba presupuesto
    // al envío. Ahora lleva el suyo y NINGUNO de los otros dos: si alguien devuelve el compartido a
    // esta cadena «para no bajar la guardia», el AC2 vuelve a estar roto aunque el limitador nuevo
    // siga puesto — por eso el aserto que manda aquí es el `not.toContain`.
    const { soatClienteLimiter, soatPreconsultaLimiter, soatLecturaFacturaLimiter } =
      await import('../../src/shared/middleware/rateLimiter.js');
    const cadena = await middlewaresDe('/cliente/factura/lectura');

    expect(cadena, 'la lectura lleva su limitador propio').toContain(soatLecturaFacturaLimiter);
    expect(cadena, 'la lectura NO puede gastar el presupuesto del envío').not.toContain(soatClienteLimiter);
    expect(cadena, 'ni el sub-límite de la preconsulta').not.toContain(soatPreconsultaLimiter);
  });

  it('**el techo son 15: la 15.ª preconsulta pasa y la 16.ª es 429 sin consultar el RUNT** (HU #12214, AC1)', async () => {
    // El comportamiento, y no la introspección del middleware: `express-rate-limit` v8 no publica
    // sus `options` en el objeto devuelto, así que el número se afirma ejerciéndolo. Mismo usuario
    // en las dieciséis peticiones para que el contador cuente.
    //
    // Las DOS mitades hacen falta: sin la 15.ª en 200 este test seguiría verde con el techo viejo de
    // 8, que es justo el número que la HU #12214 viene a subir.
    const app = await buildApp();
    const token = await auth(siguienteUsuario());

    for (let i = 0; i < 15; i++) {
      escenario();
      expect((await preconsultar(app, token)).status, `la petición ${i + 1} debería pasar`).toBe(200);
    }
    expect(consultarVehiculoRuntMock).toHaveBeenCalledTimes(15);

    escenario();
    const decimosexta = await preconsultar(app, token);
    expect(decimosexta.status).toBe(429);
    // Y el freno actúa ANTES de gastar la consulta de pago: dieciséis intentos, quince consultas.
    expect(consultarVehiculoRuntMock).toHaveBeenCalledTimes(15);
  });

  it('**el sub-límite tiene contador PROPIO: agotarlo NO deja al usuario sin poder radicar**', async () => {
    // Es lo que separa un sub-límite de un límite a secas, y se mide por comportamiento. Con el
    // mismo prefijo de llave que el compartido, los dos limitadores escribirían sobre el mismo
    // contador: agotar las 15 preconsultas dejaría al usuario a 15 de 20 —no a 0—, pero un contador
    // compartido y mal prefijado haría que el `max` más estricto ganara también para el alta, y este
    // 201 sería un 429. El alta es la petición que SÍ crea valor y no hay motivo para racionarla más
    // allá del contador del canal.
    const app = await buildApp();
    const token = await auth(siguienteUsuario());

    for (let i = 0; i < 15; i++) { escenario(); await preconsultar(app, token); }
    escenario();
    expect((await preconsultar(app, token)).status, 'el sub-límite está agotado').toBe(429);

    escenario();
    const radicar = await alta(app, token);
    expect(radicar.status, 'el alta sigue viva bajo el contador compartido').toBe(201);
  });

  it('el sub-límite es POR USUARIO: agotarlo con una cuenta no frena a otra de la misma compañía', async () => {
    // `userOrIpKey`. Es la decisión ya escrita del limitador compartido y el sub-límite la hereda:
    // frenar por IP castigaría a toda la compañía por lo que hace una cuenta. Se deja medido porque
    // también es el límite de lo que este freno puede prometer — una compañía con N usuarios dispone
    // de 15N preconsultas por ventana, y eso está dicho en el docblock.
    const app = await buildApp();
    const primero = await auth(siguienteUsuario());

    for (let i = 0; i < 15; i++) { escenario(); await preconsultar(app, primero); }
    escenario();
    expect((await preconsultar(app, primero)).status).toBe(429);

    escenario();
    expect((await preconsultar(app, await auth(siguienteUsuario()))).status).toBe(200);
  });
});

// ═══════════ HU #12214 — la lectura sale del contador del envío ══════════════

describe('HU #12214 — agotar la LECTURA no le quita presupuesto al envío, y NINGÚN no-200 del RUNT sale como 429', () => {
  /**
   * Una lectura SIN adjunto. Sirve porque el limitador va delante de multer y del handler (eso lo
   * mide la suite hermana, `flito-soat.cliente-lectura-factura.test.ts`), así que la petición gasta
   * su punto igual y muere en un 400 «falta la factura» **sin llamar al OCR** — que es lo que
   * permite ejercer aquí el contador de la lectura sin montar el mock de Anthropic.
   */
  const lecturaSinAdjunto = (app: express.Express, token: string) =>
    request(app).post('/api/flito/soat/cliente/factura/lectura').set('Authorization', token);

  it('**agotado el contador de la lectura, el alta sigue radicando** (AC2)', async () => {
    // El aserto central de la HU. Veintiuna lecturas: doce pasan el limitador y mueren en 400, y las
    // nueve siguientes son 429. Ese reparto es idéntico con el cableado VIEJO —la lectura anidada
    // bajo el compartido daría los mismos doce 400 y los mismos nueve 429—, así que lo que separa un
    // cableado del otro es SOLO la última línea: con el compartido puesto, esas 21 peticiones habrían
    // consumido las 20 del canal y el alta saldría 429.
    const app = await buildApp();
    const token = await auth(siguienteUsuario());

    const estados: number[] = [];
    for (let i = 0; i < 21; i++) estados.push((await lecturaSinAdjunto(app, token)).status);

    expect(estados.slice(0, 12), 'las doce primeras pasan el limitador').toEqual(Array(12).fill(400));
    expect(estados.slice(12), 'de la 13.ª en adelante, 429').toEqual(Array(9).fill(429));

    escenario();
    const radicar = await alta(app, token);
    expect(radicar.status, 'el envío no gastó ni una petición en las lecturas').toBe(201);
  });

  it('**la lectura tampoco consume el sub-límite de la preconsulta** (AC5, por comportamiento)', async () => {
    // Tres contadores independientes: con las 13 lecturas gastadas, las 15 preconsultas siguen
    // enteras. Un prefijo de llave compartido entre estos dos se vería aquí y en ningún otro sitio.
    const app = await buildApp();
    const token = await auth(siguienteUsuario());

    for (let i = 0; i < 13; i++) await lecturaSinAdjunto(app, token);

    for (let i = 0; i < 15; i++) {
      escenario();
      expect((await preconsultar(app, token)).status, `preconsulta ${i + 1} tras agotar la lectura`).toBe(200);
    }
  });

  /**
   * Un `https` falso que contesta con el status pedido y **un cuerpo PERFECTAMENTE VÁLIDO**.
   *
   * Las dos mitades importan.
   *
   * · **La capa**: `consultarVehiculoProxy` evalúa `r.status !== 200` sobre lo que devuelve
   *   `httpsReq`, y ahí —en `fallo()`— es donde el status upstream muere. Mockear `runt.service`
   *   —como hace el resto de esta suite— saltaría justamente el trozo de código que el AC6 afirma, y
   *   es lo que dejaba el `429` como decoración: cambiarlo por `418` no movía nada porque ese valor
   *   no lo leía nadie.
   *
   * · **El cuerpo**: es `runtOk()`, el mismo payload que produce un 200 legítimo. Sin eso el 503
   *   saldría igual pero POR EL CUERPO —un JSON que la compuerta no reconoce también acaba en
   *   `caido`— y el test volvería a no medir el status. Con un cuerpo bueno, lo ÚNICO que separa el
   *   200 del 503 es el código HTTP, que es exactamente la afirmación del AC6. Medido: con este
   *   cuerpo y `status: 200` la ruta responde 200 (el control positivo de más abajo).
   */
  function httpsQueContesta(status: number) {
    const request = (_opciones: unknown, cb: (r: unknown) => void) => {
      const oyentes: Record<string, ((...a: unknown[]) => void)[]> = {};
      const respuesta = {
        statusCode: status,
        headers: {},
        on(ev: string, fn: (...a: unknown[]) => void) { (oyentes[ev] ||= []).push(fn); return respuesta; },
      };
      const peticion = {
        setTimeout() { return peticion; },
        on() { return peticion; },
        write() { return true; },
        destroy() { /* no usado */ },
        end() {
          cb(respuesta);
          queueMicrotask(() => {
            for (const fn of oyentes.data ?? []) fn(Buffer.from(JSON.stringify(runtOk())));
            for (const fn of oyentes.end ?? []) fn();
          });
        },
      };
      return peticion;
    };
    return { default: { request }, request };
  }

  /**
   * La respuesta REAL del canal cuando la pasarela del RUNT contesta `status`.
   *
   * Desmoquea `runt.service` —para que corra `consultarVehiculoProxy` de verdad— y moquea `https` en
   * su lugar, con el registro de módulos reiniciado a ambos lados para no contaminar al resto de la
   * suite, que sí depende del mock del servicio.
   */
  async function respuestaConUpstream(status: number) {
    vi.resetModules();
    vi.doUnmock('../../src/modules/runt/runt.service.js');
    vi.doMock('https', () => httpsQueContesta(status));
    try {
      escenario();
      return await preconsultar(await buildApp(), await auth(siguienteUsuario()));
    } finally {
      vi.doUnmock('https');
      vi.doMock('../../src/modules/runt/runt.service.js', () => ({
        consultarVehiculoRunt: consultarVehiculoRuntMock,
        consultarPersonaRunt: vi.fn(),
      }));
      vi.resetModules();
    }
  }

  it('**control positivo: con 200 y ESE MISMO cuerpo, la pasarela falsa produce una preconsulta OK**', async () => {
    // Sin este caso, los cuatro de abajo probarían «un JSON cualquiera acaba en 503» y no «el status
    // decide». Aquí se fija el otro extremo: mismo transporte, mismo cuerpo, mismo montaje, y el
    // canal responde 200. A partir de aquí, cualquier 503 de los siguientes es atribuible al código
    // HTTP y a nada más.
    const r = await respuestaConUpstream(200);

    expect(r.status, 'el cuerpo inyectado es una respuesta válida del RUNT').toBe(200);
  });

  it('**un 429 de la pasarela del RUNT sale como 503 `runt_no_disponible`** (AC6, camino real)', async () => {
    // Lo que de verdad ocurre, y no lo que la nota técnica decía: este canal NO pasa por
    // `upstreamHttpStatus` (esa es la vía del proxy CEA de trámites). El 429 muere antes, en
    // `runt.service.consultarVehiculoProxy`, que colapsa cualquier respuesta no-200 en `{ok:false}`
    // vía `fallo()`; la compuerta lo clasifica como `caido` y la ruta responde 503.
    //
    // Si esta ruta llegara a devolver un 429 de verdad, el front lo leería como «límite del canal» y
    // mandaría al usuario a esperar quince minutos por un fallo del proveedor. El 429 de este canal
    // es SIEMPRE de un limitador propio.
    const r = await respuestaConUpstream(429);

    expect(r.status, 'un 429 upstream jamás se repite tal cual').not.toBe(429);
    expect(r.status).toBe(503);
    expect(r.body.codigo).toBe('runt_no_disponible');
  });

  it.each([500, 503, 418, 404])(
    '**y con %i pasa EXACTAMENTE lo mismo: el status upstream no se ramifica en ningún punto**',
    async (status) => {
      // La mitad que convierte la afirmación del AC6 en estructural y no en una coincidencia. Que el
      // 429 salga como 503 no probaría nada por sí solo si hubiera una rama por status en alguna
      // parte: bastaría con que alguien la añadiera para OTRO código y el caso de arriba seguiría
      // verde. Aquí se afirma la ausencia de ramificación — cuatro códigos distintos, incluidos dos
      // que ni siquiera son errores de servicio, con el MISMO desenlace y con el MISMO cuerpo bueno
      // que en 200 daba 200.
      const r = await respuestaConUpstream(status);

      expect(r.status, `el upstream ${status} no puede cambiar el desenlace`).toBe(503);
      expect(r.body.codigo).toBe('runt_no_disponible');
    },
  );
});

// ═══════════ ADR-0012 — el HMAC del VIN (y de la placa) en `motivo` ══════════

describe('ADR-0012 — el rastro correlaciona por HMAC, y el VIN no vuelve al log', () => {
  const ultimoMotivo = (): string => String(piiMock.mock.calls.at(-1)?.[1]?.motivo ?? '');
  const ultimoRegistro = () => piiMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;

  it('**el motivo empieza por `vin=v1:` y el hex es el del VIN NORMALIZADO**', async () => {
    const { hmacVin, tokenPii } = await import('../../src/shared/utils/crypto.js');
    escenario();

    await preconsultar(await buildApp(), await auth(siguienteUsuario()));

    expect(ultimoMotivo().startsWith(`vin=${tokenPii(hmacVin(VIN_RUNT))}`)).toBe(true);
    // Delante y no detrás: `motivo` se recorta por el final, así que un token al final se pierde en
    // silencio el día que alguien alargue la prosa. El mutante que mata: moverlo detrás.
    expect(ultimoMotivo().indexOf('vin=')).toBe(0);
  });

  it('**el VIN en claro NO vuelve al log por ninguna vía**', async () => {
    // La regla que este archivo defiende desde su primera línea: lo que entra es un identificador
    // OPACO. Se mira el registro entero serializado, no solo el motivo.
    escenario();
    await preconsultar(await buildApp(), await auth(siguienteUsuario()));

    const escrito = JSON.stringify(ultimoRegistro());
    expect(escrito).not.toContain(VIN_RUNT);
    expect(escrito).not.toContain(PLACA);
    expect(escrito).not.toContain(DOCUMENTO);
  });

  it('**un VIN con separadores y en minúsculas produce el MISMO token**', async () => {
    // La correlación tiene que sobrevivir a cómo lo teclee la persona. Es la misma premisa del
    // bloqueante 1: el token se calcula sobre `parsed.data.vin`, la salida del `preprocess`.
    const app = await buildApp();

    escenario();
    await preconsultar(app, await auth(siguienteUsuario()), { vin: VIN_RUNT });
    const limpio = ultimoMotivo();

    escenario();
    await preconsultar(app, await auth(siguienteUsuario()), { vin: '9fkrg-2222-t2042405' });
    expect(ultimoMotivo()).toBe(limpio);
  });

  it('**la placa del RUNT viaja como SEGUNDO token, y su ausencia no rompe el formato**', async () => {
    // El titular que solo conoce su placa —que es como la gente identifica su carro— no podría ser
    // emparejado con solo el HMAC del VIN, y la traducción placa→VIN por `vehicles` falla justo para
    // la población de este canal: los vehículos que no tienen fila ahí.
    const { hmacPlaca, tokenPii } = await import('../../src/shared/utils/crypto.js');
    const app = await buildApp();

    escenario();
    await preconsultar(app, await auth(siguienteUsuario()));
    expect(ultimoMotivo()).toContain(`placa=${tokenPii(hmacPlaca(PLACA))}`);

    // Y sin placa del RUNT —caso medido en esta misma HU— el token simplemente no está: ni `placa=`,
    // ni `placa=null`, ni un hueco. El del VIN sigue delante y la prosa sigue detrás.
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk({ placa: null }));
    await preconsultar(app, await auth(siguienteUsuario()));
    expect(ultimoMotivo()).not.toContain('placa=');
    expect(ultimoMotivo().indexOf('vin=')).toBe(0);
    expect(ultimoMotivo()).toContain('Preconsulta RUNT del canal Cliente');
  });

  it('**el motivo cabe en `varchar(200)` con los dos tokens y la prosa entera**', async () => {
    // El presupuesto medido del ADR (163). El aserto no es solo la longitud: es que la prosa NO se
    // haya recortado, que es lo que diría que el margen se agotó.
    escenario();
    await preconsultar(await buildApp(), await auth(siguienteUsuario()));

    expect(ultimoMotivo().length).toBeLessThanOrEqual(200);
    expect(ultimoMotivo()).toContain('(paso previo al alta de solicitud de SOAT)');
  });

  it('el alta escribe su propio token, con la misma forma y su prosa distinta', async () => {
    const { hmacVin, hmacPlaca, tokenPii } = await import('../../src/shared/utils/crypto.js');
    escenario();

    const r = await alta(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(201);

    expect(ultimoMotivo().startsWith(`vin=${tokenPii(hmacVin(VIN_RUNT))}`)).toBe(true);
    expect(ultimoMotivo()).toContain(`placa=${tokenPii(hmacPlaca(PLACA))}`);
    expect(ultimoMotivo()).toMatch(/durante el alta/);
    expect(ultimoMotivo().length).toBeLessThanOrEqual(200);
  });

  it('**el 201 sigue siendo `{ id, estado }`: la placa del rastro NO se le devuelve al cliente**', async () => {
    // `SolicitudCreada` gana `placa` para poder escribir el token, y eso no puede filtrarse a la
    // respuesta — el mismo patrón que mordió con `destino` en la HU #12078.
    escenario();
    const r = await alta(await buildApp(), await auth(siguienteUsuario()));

    expect(Object.keys(r.body).sort()).toEqual(['estado', 'id']);
    expect(JSON.stringify(r.body)).not.toContain(PLACA);
  });

  it('**la invariante PROBADA: si el VIN del RUNT difiere, no se escribe ninguna línea de ACCESO**', async () => {
    // Es lo que sostiene que se pueda tomar el VIN TECLEADO para el token en vez del efectivo. La
    // compuerta corta con 422, así que nunca puede escribirse un token divergente: la única línea
    // que queda es la de INTENTO, que declara `campos_accedidos` vacío.
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk({ vin: 'OTROVIN000000001' }));

    const r = await preconsultar(await buildApp(), await auth(siguienteUsuario()));

    expect(r.status).toBe(422);
    expect(r.body.codigo).toBe('runt_no_cuadra');
    const accesos = piiMock.mock.calls.filter(
      (c) => ((c[1] as { camposAccedidos: string[] }).camposAccedidos ?? []).length > 0,
    );
    expect(accesos, 'ninguna línea puede declarar campos entregados').toHaveLength(0);
  });
});

// ═══════════ ADR-0012 §8.2 — los intentos FALLIDOS también dejan rastro ══════

describe('ADR-0012 §8.2 — el sondeo es visible: los intentos que no entregan nada se registran', () => {
  const ultimoRegistro = () => piiMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;

  /** Los tres desenlaces que cortan, con el código que la ruta tiene que anotar. */
  const FALLOS = [
    {
      nombre: '503 RUNT caído',
      preparar: () => { consultarVehiculoRuntMock.mockResolvedValue({ ok: false, message: 'x' }); },
      montar: () => escenario(),
      status: 503, codigo: 'runt_no_disponible',
    },
    {
      nombre: '422 el VIN no cuadra',
      preparar: () => { consultarVehiculoRuntMock.mockResolvedValue(runtOk({ vin: 'OTROVIN000000001' })); },
      montar: () => escenario(),
      status: 422, codigo: 'runt_no_cuadra',
    },
    {
      nombre: '409 el vehículo ya está en FLITO',
      preparar: () => undefined,
      montar: () => escenario({ flito_soat: [{ id: 'aaaa', estado: 'pagado', companiaId: COMPANIA }] }),
      status: 409, codigo: 'vin_ya_tiene_soat',
    },
  ] as const;

  it.each(FALLOS)('**$nombre → se registra el INTENTO con `resultado=$codigo`**', async ({ preparar, montar, status, codigo }) => {
    const { hmacVin, tokenPii } = await import('../../src/shared/utils/crypto.js');
    montar();
    preparar();

    const r = await preconsultar(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(status);

    // Se escribió UNA línea, con el token del VIN sondeado: es lo que hace VISIBLE la enumeración.
    // Sin ella, el registro solo veía los aciertos, que enumerando son la minoría.
    expect(piiMock).toHaveBeenCalledTimes(1);
    expect(String(ultimoRegistro().motivo).startsWith(`vin=${tokenPii(hmacVin(VIN_RUNT))}`)).toBe(true);
    expect(String(ultimoRegistro().motivo)).toContain(`resultado=${codigo}`);
  });

  it('**un intento NO declara campos accedidos: `campos_accedidos` va VACÍO**', async () => {
    // La distinción que pedía el AC: «se intentó» no es «se accedió». Un 503 del RUNT caído no
    // entregó ni la placa, ni el VIN, ni el nombre — declararlos convertiría el registro en una
    // cuenta de divulgaciones que nunca ocurrieron.
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue({ ok: false, message: 'x' });

    await preconsultar(await buildApp(), await auth(siguienteUsuario()));

    expect(ultimoRegistro().camposAccedidos).toEqual([]);
  });

  it('y un acceso REAL sí los declara: las dos líneas se distinguen sin leer el motivo', async () => {
    // La otra mitad. Sin ella, marcar TODO como vacío también pasaría.
    escenario();
    await preconsultar(await buildApp(), await auth(siguienteUsuario()));

    expect(ultimoRegistro().camposAccedidos).toEqual(expect.arrayContaining(['placa', 'vin']));
    expect(String(ultimoRegistro().motivo)).not.toContain('resultado=');
  });

  it('**el registro del intento no cambia el código de respuesta ni se come el error**', async () => {
    // La regla operativa: `manejarError` sigue mandando. Si el rastro fallara —aquí se le hace
    // lanzar—, el cliente tiene que seguir viendo su 422 de dominio y no un 500 de la bitácora.
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk({ vin: 'OTROVIN000000001' }));
    piiMock.mockRejectedValueOnce(new Error('la bitácora está caída'));

    const r = await preconsultar(await buildApp(), await auth(siguienteUsuario()));

    expect(r.status, 'el error de dominio manda sobre el del rastro').toBe(422);
    expect(r.body.codigo).toBe('runt_no_cuadra');
  });

  it('el alta también registra su intento fallido, con su propia prosa', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue({ ok: false, message: 'x' });

    const r = await alta(await buildApp(), await auth(siguienteUsuario()));

    expect(r.status).toBe(503);
    expect(String(ultimoRegistro().motivo)).toContain('resultado=runt_no_disponible');
    expect(String(ultimoRegistro().motivo)).toMatch(/durante el alta/);
    expect(ultimoRegistro().camposAccedidos).toEqual([]);
  });

  it('**un 400 del BORDE no escribe nada: no hubo consulta que registrar**', async () => {
    // El límite del alcance. Un cuerpo inválido no llega al servicio ni al RUNT; escribir una línea
    // de «intento de acceso a datos personales» por un formulario mal llenado inflaría la tabla del
    // artículo 17 con ruido que no describe ninguna consulta a un tercero.
    escenario();
    const r = await preconsultar(await buildApp(), await auth(siguienteUsuario()), { vin: 'A-B-C' });

    expect(r.status).toBe(400);
    expect(piiMock).not.toHaveBeenCalled();
  });

  // ── El hueco que encontró el gate B: fallos que NO hablan de ningún vehículo ───────────────────

  /**
   * **Los tres desenlaces que pasan por el mismo `catch` y que NO pueden escribir.**
   *
   * El `catch` de las dos rutas envuelve también las guardas anteriores a la compuerta, así que sin
   * el filtro se escribía «Consulta RUNT del canal Cliente durante el alta…» para peticiones que
   * nunca consultaron el RUNT: un EVENTO sobredeclarado en una tabla con seis años de retención.
   * Medido por el gate B con `archivo_no_pdf`, que `security-agent` no había visto —solo tenía los
   * dos 403—.
   *
   * La regla que los une: **la respuesta habría sido idéntica con cualquier otro VIN.** Habla del
   * llamante o de su adjunto, no del vehículo.
   */
  const NO_HABLAN_DEL_VEHICULO = [
    {
      nombre: 'archivo_no_pdf (400) — el adjunto no es un PDF por contenido',
      montar: () => escenario(),
      peticion: (app: express.Express, token: string) =>
        request(app).post('/api/flito/soat/cliente').set('Authorization', token)
          .field(CAMPOS).attach('facturaVenta', Buffer.from('MZ no soy un pdf'), {
            filename: 'factura.pdf', contentType: 'application/pdf',
          }),
      status: 400, codigo: 'archivo_no_pdf',
    },
    {
      nombre: 'canal_desactivado (403) — la compañía no tiene el canal abierto',
      montar: () => escenario({ clients: [{ id: COMPANIA, sinTramite: false, carpeta: null }] }),
      peticion: (app: express.Express, token: string) => preconsultar(app, token),
      status: 403, codigo: 'canal_desactivado',
    },
    {
      nombre: 'sin_compania (403) — el usuario no tiene compañía asignada',
      montar: () => escenario({ users: [{ c: null, s: null }] }),
      peticion: (app: express.Express, token: string) => preconsultar(app, token),
      status: 403, codigo: 'sin_compania',
    },
  ] as const;

  it.each(NO_HABLAN_DEL_VEHICULO)('**$nombre → NO escribe en `pii_access_log`**', async ({ montar, peticion, status, codigo }) => {
    montar();

    const r = await peticion(await buildApp(), await auth(siguienteUsuario()));

    expect(r.status).toBe(status);
    expect(r.body.codigo).toBe(codigo);
    // Ni una línea. El mutante que mata: quitar el filtro de `DESENLACE_HABLA_DEL_VEHICULO`.
    expect(piiMock).not.toHaveBeenCalled();
    // Y no es que el RUNT fallara: es que ni se le preguntó.
    expect(consultarVehiculoRuntMock).not.toHaveBeenCalled();
  });

  it('**el criterio es un `Record` TOTAL: un código nuevo no compila hasta clasificarse**', async () => {
    // Lo que impide que esto vuelva a derivar. Una lista de códigos sigue compilando cuando el enum
    // crece; un `Record<CodigoErrorSolicitudSoat, boolean>` no. Aquí se afirma la TOTALIDAD contra el
    // enum compartido —el build ya la exige, y este caso la deja visible— y las dos clasificaciones
    // que el gate B midió mal.
    const { CodigoErrorSolicitudSoat } = await import('@operaciones/shared-types');
    const { DESENLACE_HABLA_DEL_VEHICULO } = await import('../../src/modules/flito-soat/flito-soat-cliente.service.js');

    expect(Object.keys(DESENLACE_HABLA_DEL_VEHICULO).sort())
      .toEqual(Object.values(CodigoErrorSolicitudSoat).sort());

    // Los que sí hablan del vehículo: la respuesta habría sido distinta con otro VIN.
    expect(DESENLACE_HABLA_DEL_VEHICULO[CodigoErrorSolicitudSoat.RUNT_NO_DISPONIBLE]).toBe(true);
    expect(DESENLACE_HABLA_DEL_VEHICULO[CodigoErrorSolicitudSoat.RUNT_NO_CUADRA]).toBe(true);
    expect(DESENLACE_HABLA_DEL_VEHICULO[CodigoErrorSolicitudSoat.RUNT_SIN_REGISTRO]).toBe(true);
    expect(DESENLACE_HABLA_DEL_VEHICULO[CodigoErrorSolicitudSoat.RUNT_SIN_VIN]).toBe(true);
    expect(DESENLACE_HABLA_DEL_VEHICULO[CodigoErrorSolicitudSoat.SOAT_VIGENTE]).toBe(true);
    // El 409 de RN-01 entra aunque corte ANTES del RUNT: confirma que ese VIN está en FLITO.
    expect(DESENLACE_HABLA_DEL_VEHICULO[CodigoErrorSolicitudSoat.VIN_YA_TIENE_SOAT]).toBe(true);

    // Y los tres del gate B: hablan del llamante o de su adjunto.
    expect(DESENLACE_HABLA_DEL_VEHICULO[CodigoErrorSolicitudSoat.ARCHIVO_NO_PDF]).toBe(false);
    expect(DESENLACE_HABLA_DEL_VEHICULO[CodigoErrorSolicitudSoat.CANAL_DESACTIVADO]).toBe(false);
    expect(DESENLACE_HABLA_DEL_VEHICULO[CodigoErrorSolicitudSoat.SIN_COMPANIA]).toBe(false);
  });

  // ── Por qué NO hay test del guarda `!(e instanceof SolicitudSoatError)` ───────────────────────
  //
  // **Porque es REDUNDANTE en runtime y ningún test por HTTP podría distinguir su presencia.** Con
  // un `Error` pelado, `e.codigo` es `undefined` y `DESENLACE_HABLA_DEL_VEHICULO[undefined]` es
  // `undefined` —falsy—, así que el SEGUNDO guarda ya corta solo. Medido por el gate B: quitando
  // únicamente el `instanceof`, la sonda sigue verde; quitando los dos, muere. Un caso escrito «para
  // el primer guarda» sería verde con y sin él: exactamente la clase de test que estos gates existen
  // para cazar, y el mismo defecto que esta suite corrigió en su propio aserto de normalización.
  //
  // El guarda se conserva como defensa en profundidad: hace explícito que aquí solo entran errores
  // del canal y deja de depender de que `undefined` case en falsy si mañana el mapa cambia de forma.
  //
  // **Corrección de una versión anterior de este comentario, que afirmaba dos cosas falsas** y las
  // dejo escritas para que no vuelvan: decía que en Express 4 el rechazo de un handler `async` no
  // llega a ningún middleware de error y que la petición se queda colgada. No es así —`app.ts:1`
  // importa `express-async-errors`, así que en producción ese caso es un **500** limpio—, y el
  // timeout de 22 s que se midió era del HARNESS (`buildApp()` monta un express pelado, sin ese
  // import), no del router ni de producción. Cargar en la sonda lo que producción ya carga la habría
  // hecho MÁS fiel, no menos.
});

// ═══════════ AC2 — `tipoDocPropietario` es relleno, y el relleno no se guarda ═

describe('AC2 — el `tipoDocPropietario` de la vía directa no se persiste ni se muestra', () => {
  it('**no aparece en NINGÚN INSERT del alta**, ni con su nombre ni con su valor bajo otra clave', async () => {
    // Se serializa TODO lo escrito y se busca el nombre del campo: un aserto por tabla se quedaría
    // corto el día que alguien lo cuele en una que hoy no existe. El extractor del canal
    // (`extraerDatosCanal`) simplemente no lo lee, y esto es lo que fija esa omisión.
    escenario();

    const r = await alta(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(201);

    const escrito = JSON.stringify(espia.inserts.map((m) => m.datos));
    expect(escrito).not.toContain('tipoDocPropietario');
    expect(escrito).not.toContain('tipo_doc_propietario');
  });

  it('**no sale en el cuerpo de la preconsulta**, que es la única lectura que publica el RUNT', async () => {
    escenario();
    const r = await preconsultar(await buildApp(), await auth(siguienteUsuario()));

    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain('tipoDocPropietario');
    // La proyección de la preconsulta es cerrada: vehículo, organismo, propietario y —desde la
    // HU #12212— el aviso de vigencia próxima, que va SIEMPRE presente y vale `null` cuando no hay.
    // Si alguien devolviera `datos` entero, esta comparación de claves lo vería antes que ninguna otra.
    expect(Object.keys(r.body).sort()).toEqual(['organismo', 'propietario', 'vehiculo', 'vigenciaProxima']);
  });

  it('el tipo de documento que SÍ se guarda es el del formulario, no el del RUNT', async () => {
    // La otra mitad: `flito_compradores.tipo_documento` existe y se llena — con lo que tecleó la
    // persona. El caso lo hace visible eligiendo un tipo que NO es `'C'`, que es lo que el RUNT
    // rellena: si alguien conectara el relleno a esa columna, aquí se vería.
    escenario();

    const r = await alta(await buildApp(), await auth(siguienteUsuario()), { tipoDocumento: 'PPT' });
    expect(r.status).toBe(201);

    const comprador = espia.ultimoInsertEn('flito_compradores');
    expect(comprador.tipoDocumento).toBe('PPT');
    expect(comprador.tipoDocumento).not.toBe('C');
  });

  it('`extraerDatosCanal` no lo extrae: los trece campos del canal son los que son', async () => {
    // El predicado, sin pasar por HTTP. Es donde se ve que la ausencia es de diseño y no una
    // casualidad de la proyección de la ruta.
    const { extraerDatosCanal } = await import('../../src/modules/flito-soat/flito-soat-cliente-runt.js');
    const datos = extraerDatosCanal(runtOk().data);

    expect(Object.keys(datos)).not.toContain('tipoDocPropietario');
    expect(Object.values(datos)).not.toContain('C');
    // Y lo que sí extrae sigue estando, para que este test no pase por extraer nada.
    expect(datos.vin).toBe(VIN_RUNT);
    expect(datos.placa).toBe(PLACA);
  });
});

// ═══════════ La procedencia no puede certificar lo que el RUNT no dio ════════

describe('HU #12093 · el mapa de procedencia no certifica como «del RUNT» un relleno fijo', () => {
  it('**el alta nunca escribe `runt` por su cuenta: sin declarar, los nueve campos son `manual`**', async () => {
    // `procedenciaCompleta` rellena con `manual` (AC3 de la #12093) y no tiene ninguna rama que
    // escriba `runt`. El mutante que mata: derivar la procedencia de la respuesta del RUNT.
    escenario();

    const r = await alta(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(201);

    const procedencia = espia.ultimoInsertEn('flito_compradores').procedencia as Record<string, string>;
    expect(Object.values(procedencia)).not.toContain('runt');
    expect(new Set(Object.values(procedencia))).toEqual(new Set(['manual']));
  });

  it('**el mapa no tiene clave para el tipo de documento del RUNT**: sus nueve claves son del comprador', async () => {
    // La pregunta que hay que poder responder: ¿podría el mapa afirmar «este dato lo trajo el RUNT»
    // sobre `tipoDocPropietario`? No: no hay clave donde escribirlo. `tipoDocumento`, que sí está,
    // es el del COMPRADOR —el que se teclea o se lee de la factura— y va a otra columna.
    const { CAMPOS_COMPRADOR_FACTURA } = await import('@operaciones/shared-types');
    escenario();

    const r = await alta(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(201);

    const procedencia = espia.ultimoInsertEn('flito_compradores').procedencia as Record<string, string>;
    expect(Object.keys(procedencia).sort()).toEqual([...CAMPOS_COMPRADOR_FACTURA].sort());
    expect(Object.keys(procedencia)).not.toContain('tipoDocPropietario');
    expect(Object.keys(procedencia)).not.toContain('placa');
  });

  it('una procedencia `runt` declarada por el formulario se guarda tal cual: el borde no la deriva', async () => {
    // Deja MEDIDO el hueco que la HU no cierra y que el HANDOFF declara: el vocabulario de la #12093
    // permite declarar `runt` sobre cualquiera de los nueve, y de esos nueve el RUNT solo puede
    // aportar el NOMBRE (`propietarioNombre` de la preconsulta). Nada en el backend comprueba la
    // afirmación, así que un formulario podría declarar `runt` sobre un dato que el registro nunca
    // dio. No es un defecto que esta HU introduzca —el mapa es de la #12093 y su único escritor será
    // la #12094— y no se tapa aquí; se fija en verde para que el cambio de criterio sea visible.
    escenario();

    const r = await alta(await buildApp(), await auth(siguienteUsuario()), {
      procedencia: JSON.stringify({ nombres: 'runt', tipoDocumento: 'runt' }),
    });
    expect(r.status).toBe(201);

    const procedencia = espia.ultimoInsertEn('flito_compradores').procedencia as Record<string, string>;
    expect(procedencia.nombres).toBe('runt');
    expect(procedencia.tipoDocumento, 'lo declarado se guarda sin comprobar').toBe('runt');
    expect(procedencia.celular, 'y lo no declarado sigue siendo manual').toBe('manual');
  });
});

// ═══════════ AC4 — el ORDEN de evaluación, con dos condiciones a la vez ══════

describe('AC4 — los cuatro desenlaces y su ORDEN de evaluación se conservan enteros', () => {
  /** El clasificador, que es donde se DECIDE. La traducción a HTTP es del servicio. */
  const clasificar = async (respuesta: unknown, vin = VIN_RUNT) => {
    const { clasificarDesenlaceRunt } = await import('../../src/modules/flito-soat/flito-soat-cliente-runt.js');
    return clasificarDesenlaceRunt(respuesta as never, vin);
  };

  /** El mismo, con el DÍA congelado (HU #12212): el umbral no puede depender de cuándo se corra. */
  const clasificarEn = async (respuesta: unknown, hoy: string, vin = VIN_RUNT) => {
    const { clasificarDesenlaceRunt } = await import('../../src/modules/flito-soat/flito-soat-cliente-runt.js');
    return clasificarDesenlaceRunt(respuesta as never, vin, hoy);
  };

  it('**1.º `ok:false` gana sobre todo lo demás**: no se mira el cuerpo aunque venga poblado', async () => {
    // El payload trae un vehículo entero y un VIN que cuadra: si el orden se invirtiera, saldría
    // `ok`. Un `ok:false` con datos dentro no es un desenlace mixto, es un «no».
    const desenlace = await clasificar({ ...runtOk(), ok: false, httpStatus: 200 });
    expect(desenlace).toEqual({ clase: 'revise', codigo: 'runt_no_cuadra' });
  });

  it('**2.º «sin registro» gana sobre «no cuadra»**: el eco de la consulta no es un vehículo', async () => {
    // `vehiculo` con SOLO placa y VIN —ninguna señal de registro— y además el VIN difiere del
    // tecleado. Las dos condiciones a la vez: la que se evalúa primero es la que responde.
    const desenlace = await clasificar({ ok: true, data: { vehiculo: { placa: PLACA, vin: 'OTROVIN000000001' } } });
    expect(desenlace).toEqual({ clase: 'revise', codigo: 'runt_sin_registro' });
    expect(desenlace).not.toMatchObject({ codigo: 'runt_no_cuadra' });
  });

  it('**3.º «no cuadra» gana sobre «vigente»**: no se afirma nada de un vehículo sin confirmar', async () => {
    // VIN que difiere Y SOAT vigente. Decir «ya tiene SOAT» sería afirmar algo sobre un vehículo que
    // no se ha confirmado que sea el que se radica.
    const desenlace = await clasificar(runtOk(
      { vin: 'OTROVIN000000001' },
      { soat: { estadoSoat: 'VIGENTE', fechaVencimSoat: '01/02/2030' } },
    ));
    expect(desenlace).toEqual({ clase: 'revise', codigo: 'runt_no_cuadra', campo: 'vin' });
  });

  it('**4.º «sin VIN» gana sobre «vigente»**: sin VIN efectivo no hay fila posible (RN-01)', async () => {
    const desenlace = await clasificar(runtOk(
      { vin: null },
      { soat: { estadoSoat: 'VIGENTE', fechaVencimSoat: '01/02/2030' } },
    ));
    expect(desenlace).toEqual({ clase: 'revise', codigo: 'runt_sin_vin' });
  });

  it('**5.º «vigente» gana sobre `ok`**, y trae la fecha normalizada', async () => {
    const desenlace = await clasificar(runtOk({}, { soat: { estadoSoat: 'VIGENTE', fechaVencimSoat: '01/02/2030' } }));
    expect(desenlace).toEqual({ clase: 'vigente', fechaVencimiento: '2030-02-01' });
  });

  // ── El paso 5, BIFURCADO desde la HU #12212 ────────────────────────────────────────────────────
  //
  // El umbral (frontera inclusive, clamp de fin de mes, `null` ⇒ bloquea) se prueba en
  // `flito-soat.cliente-renovacion-anticipada.test.ts`, que es donde vive con `hoy` congelado. Aquí
  // solo se mide lo que esta suite protege: que la bifurcación esté DENTRO del paso 5 y que no haya
  // movido ni un puesto del orden.

  it('**5.a — vigente a menos de un mes es `renovacion_anticipada`**, y sigue detrás de los cuatro', async () => {
    escenario();
    const desenlace = await clasificarEn(
      runtOk({}, { soat: { estadoSoat: 'VIGENTE', fechaVencimSoat: '2026-10-05', numeroPoliza: '99887766' } }),
      '2026-09-09',
    );
    expect(desenlace).toMatchObject({
      clase: 'renovacion_anticipada', venceEl: '2026-10-05', poliza: '99887766',
      vinEfectivo: VIN_RUNT, organismoCodigo: ORGANISMO_FUNZA,
    });
  });

  it('**5.b — a más de un mes NO se bifurca**: sigue siendo `vigente` con su fecha', async () => {
    escenario();
    expect(await clasificarEn(
      runtOk({}, { soat: { estadoSoat: 'VIGENTE', fechaVencimSoat: '2026-10-20' } }),
      '2026-09-09',
    )).toEqual({ clase: 'vigente', fechaVencimiento: '2026-10-20' });
  });

  it('**5.c — el orden aguanta la bifurcación**: VIN que no cuadra + vence en 3 días → 422, no aviso', async () => {
    escenario();
    // Las dos condiciones a la vez. Si la renovación anticipada se hubiera colado delante de los
    // «revise», este caso saldría como un alta permitida sobre un vehículo sin confirmar.
    expect(await clasificarEn(
      runtOk({ vin: 'OTROVIN000000001' }, { soat: { estadoSoat: 'VIGENTE', fechaVencimSoat: '2026-09-12' } }),
      '2026-09-09',
    )).toEqual({ clase: 'revise', codigo: 'runt_no_cuadra', campo: 'vin' });
  });

  it('**el camino feliz es el ÚLTIMO**: `ok` con el VIN del RUNT y el organismo cruzado', async () => {
    escenario();
    const desenlace = await clasificar(runtOk());
    expect(desenlace).toMatchObject({ clase: 'ok', vinEfectivo: VIN_RUNT, organismoCodigo: ORGANISMO_FUNZA });
  });

  it('**el desenlace DESCONOCIDO cae en `caido`, y `caido` no crea nada**', async () => {
    // Una respuesta que no es ni `ok` ni una negativa reconocible: sin `httpStatus` y sin la palabra
    // que el predicado heredado busca. El defecto seguro es 503, no un alta.
    expect(await clasificar({ ok: false, message: 'algo que nadie ha visto nunca' })).toEqual({ clase: 'caido' });
    expect(await clasificar(undefined)).toEqual({ clase: 'caido' });

    escenario();
    consultarVehiculoRuntMock.mockResolvedValue({ ok: false, message: 'algo que nadie ha visto nunca' });
    const r = await alta(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(503);
    expect(espia.insertsEn('flito_soat')).toHaveLength(0);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('las CINCO clases son las que son: no se estrena ninguna ni se pierde ninguna', async () => {
    // El vocabulario cerrado, ejercido de una vez. Eran cuatro hasta la HU #12212, que añadió
    // `renovacion_anticipada` —y la añadió como CLASE justamente para que el `switch` sin `default`
    // de `verificarRuntCompuerta` no compilara hasta traducirla a HTTP—. Si mañana entrara una
    // sexta, este aserto la ve; y el build la ve antes.
    escenario();
    const clases = [
      (await clasificar(runtOk())).clase,
      (await clasificar(runtOk({}, { soat: { estadoSoat: 'VIGENTE' } }))).clase,
      (await clasificarEn(runtOk({}, { soat: { estadoSoat: 'VIGENTE', fechaVencimSoat: '2026-09-12' } }), '2026-09-09')).clase,
      (await clasificar(runtOk({ vin: null }))).clase,
      (await clasificar({ ok: false, message: 'x' })).clase,
    ];
    expect(clases).toEqual(['ok', 'vigente', 'renovacion_anticipada', 'revise', 'caido']);
  });
});

// ═══════════ AC6 — RN-B1: rastro, límite y el VIN fuera de la URL ════════════

describe('AC6 (RN-B1) — la consulta por VIN no acredita al titular, pero sigue dejando rastro', () => {
  it('**cada preconsulta deja su línea en `pii_access_log`, con placa y VIN declarados**', async () => {
    escenario();
    await preconsultar(await buildApp(), await auth(siguienteUsuario()));

    expect(piiMock).toHaveBeenCalledTimes(1);
    const registro = piiMock.mock.calls[0][1];
    expect(registro.accion).toBe('read');
    // La lista declara lo que la RESPUESTA entrega, no lo que la petición manda: la preconsulta
    // sigue devolviendo placa y VIN, así que las dos siguen declaradas aunque solo el VIN entre.
    expect(registro.camposAccedidos).toEqual(expect.arrayContaining(['placa', 'vin']));
    expect(String(registro.motivo)).toMatch(/preconsulta/i);
  });

  it('**`conPropietario` se sigue declarando caso a caso**: solo cuando el RUNT trae el nombre', async () => {
    const app = await buildApp();

    escenario();
    await preconsultar(app, await auth(siguienteUsuario()));
    expect(piiMock.mock.calls[0][1].camposAccedidos).toContain('nombre_completo');

    piiMock.mockClear();
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk({ nombrePropietario: null }));
    await preconsultar(app, await auth(siguienteUsuario()));
    expect(piiMock.mock.calls[0][1].camposAccedidos).not.toContain('nombre_completo');
  });

  it('**el VIN no acaba en el motivo del registro que lo protege**', async () => {
    escenario();
    await preconsultar(await buildApp(), await auth(siguienteUsuario()));
    expect(String(piiMock.mock.calls[0][1].motivo)).not.toContain(VIN_RUNT);
  });

  it('**el VIN viaja en el CUERPO: la ruta permitida no tiene parámetros ni `:id`**', async () => {
    // AGENTS.md §14. La allowlist del canal es la que decide qué URL puede tocar un `cliente`, y su
    // patrón es literal: no hay forma de meter el VIN en la ruta sin cambiarla.
    const { rutaPermitidaParaCliente } = await import('../../src/shared/middleware/canal-cliente.js');

    expect(rutaPermitidaParaCliente('POST', '/api/flito/soat/cliente/preconsulta')).toBe(true);
    expect(rutaPermitidaParaCliente('GET', '/api/flito/soat/cliente/preconsulta')).toBe(false);
    expect(rutaPermitidaParaCliente('POST', `/api/flito/soat/cliente/preconsulta/${VIN_RUNT}`)).toBe(false);
  });

  it('**la preconsulta sigue bajo el limitador del canal**, que es lo que frena el sondeo de VINs', async () => {
    // Los VIN de una flota son consecutivos: sin límite, esta ruta sería un lector de fichas del
    // RUNT a razón de una petición por intento. El aserto es sobre el MIDDLEWARE montado, no sobre
    // una ventana de 15 minutos que un test no puede agotar sin volverse lento y frágil.
    const { soatClienteLimiter } = await import('../../src/shared/middleware/rateLimiter.js');
    const { default: router } = await import('../../src/modules/flito-soat/flito-soat-cliente.routes.js');

    const capa = (router as unknown as { stack: { route?: { path: string; stack: { handle: unknown }[] } }[] })
      .stack.find((c) => c.route?.path === '/cliente/preconsulta');
    expect(capa, 'la ruta tiene que existir para poder afirmar sobre sus middlewares').toBeDefined();
    expect(capa!.route!.stack.map((h) => h.handle)).toContain(soatClienteLimiter);
  });

  it('el alta consulta el RUNT una sola vez y su rastro se distingue del de la preconsulta', async () => {
    escenario();
    await alta(await buildApp(), await auth(siguienteUsuario()));

    expect(consultarVehiculoRuntMock).toHaveBeenCalledTimes(1);
    expect(piiMock).toHaveBeenCalledTimes(1);
    expect(String(piiMock.mock.calls[0][1].motivo)).toMatch(/alta/i);
    expect(String(piiMock.mock.calls[0][1].motivo)).not.toMatch(/preconsulta/i);
  });
});
