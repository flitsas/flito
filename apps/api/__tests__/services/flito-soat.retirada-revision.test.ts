// HU #12080 (Feature #12074) — el canal Cliente del SOAT deja de pasar por la revisión de
// Operaciones. Este archivo prueba las DOS mitades de esa retirada:
//
//   AC1 — las cuatro operaciones de la revisión ya no existen.
//   AC2 — las tres vías del gestor y de Operaciones que se PARECEN a ellas siguen exactamente igual.
//
// ── El AC1 dice «responden 404» y eso es FALSO para un rol. Se prueba la verdad ──────────────────
//
// El enunciado del AC pide afirmar 404 en las cuatro. Para tres de ellas —`GET /causales-rechazo`,
// `POST /:id/validar` y `POST /:id/rechazar-solicitud`— es correcto: eran de `admin`, ningún router
// las declara ya y Express responde su 404 por defecto.
//
// **`PATCH /:id/solicitud` llamada por un `cliente` responde 403, no 404**, y no es un detalle de
// forma. `guardiaCanalCliente` se invoca desde el final de `authMiddleware`
// (`shared/middleware/auth.ts`), o sea ANTES de que Express intente enrutar: al sacar la ruta de
// `RUTAS_PERMITIDAS_CLIENTE` la petición muere allí con `{ error: 'Sin permisos' }` y nunca llega al
// router que ya no la tiene. Los demás roles no pasan por esa lista, así que ellos sí ven el 404.
//
// Se afirman los DOS códigos, cada uno con su rol, porque un test que afirmara 404 para los dos
// estaría verde contra un supuesto equivocado el día que alguien mueva el guarda de sitio: el 403
// del `cliente` no prueba que la ruta no exista, prueba que el rol no la alcanza. Por eso la
// inexistencia de la ruta se comprueba ADEMÁS con el `admin`, para quien el 404 sí significa eso.
//
// ── Por qué el AC2 necesita un test propio y no basta con «no las toqué» ─────────────────────────
//
// Las tres vías que sobreviven se llaman casi igual que las que se van: `POST /:id/rechazar` (el
// rechazo del GESTOR, que lleva a `con_novedad`) convivía con `POST /:id/rechazar-solicitud` (el
// rechazo del ADMIN, que llevaba a `rechazada`). Un borrado por nombre, un `grep -v rechaz` o un
// «ya que estamos, esto también sobra» se lleva la que no era. Este bloque las ejerce de verdad
// —router real, `requireRole` real— para que ese error salga rojo aquí y no en producción.
//
// Se ejercen por HTTP y no comprobando que la función existe: lo que el AC2 promete es que el gestor
// puede seguir trabajando, y eso incluye el rol que puede llamarlas.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken, type TestRole } from '../helpers/auth.js';

// Mocks EXPLÍCITOS de `select`/`update`/`transaction`, como en `flito-soat.contingencia.test.ts`.
// El doble keyed no sirve para este archivo: el AC2 necesita llegar a 200 y afirmar el `set`, y para
// eso hay que montar la transacción a mano.
const selectMock = vi.fn();
const updateMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock, update: updateMock, insert: vi.fn(), delete: vi.fn(),
    transaction: transactionMock, execute: vi.fn(),
  },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const SOAT_ID = '7c000000-0000-4000-8000-0000000012a0';
const PROVEEDOR = '7c000000-0000-4000-8000-0000000012b0';
const OTRO_PROVEEDOR = '7c000000-0000-4000-8000-0000000012b1';
const COMPANIA = 7;

/**
 * Los DOS routers, en el MISMO orden que `app.ts` (`app.use('/api/flito/soat', cliente)` y luego el
 * del módulo). El orden importa para este archivo más que para ningún otro: si se montara solo uno,
 * el 404 del `admin` probaría que la ruta no está en ESE router, no que no está en ninguno.
 */
async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: cliente } = await import('../../src/modules/flito-soat/flito-soat-cliente.routes.js');
  const { default: modulo } = await import('../../src/modules/flito-soat/flito-soat.routes.js');
  app.use('/api/flito/soat', cliente);
  app.use('/api/flito/soat', modulo);
  return app;
}

const auth = async (role: TestRole, sub = 42) =>
  `Bearer ${await testToken({ sub, username: 'quien@flito.co', role })}`;

beforeEach(() => { selectMock.mockReset(); updateMock.mockReset(); transactionMock.mockReset(); });

/** La fila del canal sobre la que se ejerce el AC2: `solicitado`, del gestor, `origen = 'cliente'`. */
const soatDelCanal = (over: Record<string, unknown> = {}) => ({
  id: SOAT_ID, estado: 'solicitado', origen: 'cliente', companiaId: COMPANIA,
  proveedorSoatId: PROVEEDOR, gestionOperaciones: false, motivoRechazo: null,
  enviadoEn: new Date('2026-09-01T10:00:00Z'), pagadoEn: null, valorPagado: null, extraccion: null,
  ...over,
});

/** `contextoSoat` (el proveedor del token) y luego `buscarConAcceso`. */
const comoGestor = (fila: Record<string, unknown>) => {
  selectMock.mockReturnValueOnce(chain([{ p: PROVEEDOR }]));
  selectMock.mockReturnValueOnce(chain([{ soat: fila, dentroDeFrontera: true }]));
  selectMock.mockReturnValue(chain([]));
};

/**
 * El traspaso NO pasa por `buscarConAcceso`: `asumirEnOperaciones` y `devolverAlGestor` leen la fila
 * PLANA con `db.select().from(flitoSoat)`. Y para un `admin`, `contextoSoat` no consulta nada, así
 * que la primera lectura de la petición ya es la del SOAT.
 *
 * El `mockReturnValue` de cola devuelve el PROVEEDOR: es la segunda consulta de `devolverAlGestor`
 * («¿existe el proveedor al que se devuelve?»), y sin ella esa ruta da 404 antes de escribir.
 */
const comoOperaciones = (fila: Record<string, unknown>) => {
  selectMock.mockReturnValueOnce(chain([fila]));
  selectMock.mockReturnValue(chain([{ id: OTRO_PROVEEDOR }]));
};

/** La transacción de la mutación: devuelve los payloads de `update().set()`. Calcado de la #11153. */
function montarTx(filaActualizada: unknown = { id: SOAT_ID, estado: 'solicitado' }) {
  const sets: Record<string, unknown>[] = [];
  const txSelect = vi.fn().mockReturnValue(chain([{ id: SOAT_ID }]));
  const txUpdate = vi.fn(() => {
    const c = chain([filaActualizada]);
    return { ...c, set: (v: Record<string, unknown>) => { sets.push(v); return c; } };
  });
  const txInsert = vi.fn(() => {
    const c = chain([]);
    return { ...c, values: () => c };
  });
  transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({ select: txSelect, update: txUpdate, insert: txInsert }));
  return { sets, txUpdate };
}

// ═════════════════ AC1 — las cuatro operaciones de la revisión no existen ════════════════════════

describe('AC1 — las cuatro rutas de la revisión ya no están montadas', () => {
  // ── Las cuatro dan 404 al `admin`, pero NO todas por el mismo motivo ────────────────────────────
  //
  // Aquí había un solo bucle con las cuatro y el comentario «un 404 aquí solo puede venir de que
  // ningún router declara el patrón». Es cierto para TRES y **falso para `GET /causales-rechazo`**,
  // que tiene tres segmentos y cae dentro de `GET /:id` con `id = 'causales-rechazo'`: ahí lo que
  // responde es la guarda de forma de uuid que esta HU añadió a esa ruta, no la ausencia de patrón.
  //
  // Se separan porque el aserto acertaba y su explicación no, que es exactamente el fallo que este
  // repo persigue: un test verde cuya frase enseña a razonar mal sobre el sistema. Y porque los dos
  // 404 tienen forma distinta y se pueden distinguir: el de Express es HTML («Cannot GET …») y el
  // nuestro es el JSON del módulo.

  /** Las TRES que de verdad se quedaron sin patrón en ningún router. */
  const SIN_PATRON: Array<{ metodo: 'post' | 'patch'; ruta: string }> = [
    { metodo: 'post', ruta: `/api/flito/soat/${SOAT_ID}/validar` },
    { metodo: 'post', ruta: `/api/flito/soat/${SOAT_ID}/rechazar-solicitud` },
    { metodo: 'patch', ruta: `/api/flito/soat/${SOAT_ID}/solicitud` },
  ];

  for (const { metodo, ruta } of SIN_PATRON) {
    it(`\`${metodo.toUpperCase()} ${ruta}\` → 404 **de Express**: ningún router declara el patrón`, async () => {
      // El `admin` es el rol con el que este aserto significa «no existe»: era el dueño de dos de las
      // tres y no pasa por la allowlist del canal, así que nada puede detenerlo antes del enrutado.
      const r = await request(await buildApp())[metodo](ruta).set('Authorization', await auth('admin'));

      expect(r.status).toBe(404);
      // Que sea el 404 de ENRUTADO y no uno de handler: `finalhandler` responde HTML con el verbo y
      // la ruta. Sin esta línea, un `res.status(404)` escrito dentro de un handler resucitado pasaría
      // por «la ruta no existe».
      expect(r.text).toMatch(new RegExp(`Cannot ${metodo.toUpperCase()}`, 'i'));
      expect(r.body).not.toHaveProperty('error');
      // Y no llegó a la base: no hay handler que consulte.
      expect(selectMock).not.toHaveBeenCalled();
    });
  }

  it('**`GET /causales-rechazo` → 404, pero lo da la guarda de uuid de `GET /:id`**, no el enrutado', async () => {
    // La cuarta, y la que no encaja en el bucle de arriba. `/causales-rechazo` es UN segmento colgando
    // de la base, igual que un uuid, así que `GET /:id` lo casa con `id = 'causales-rechazo'`.
    // Mientras la ruta del catálogo existió en el router del canal —montado ANTES en `app.ts`—
    // ganaba ella y la cuestión no se planteaba; al retirarla, la URL cae aquí.
    //
    // Sin la guarda de forma, ese `id` llegaría a `WHERE id = 'causales-rechazo'` contra una columna
    // `uuid`: **22P02 y 500**, no 404. O sea que lo que hace verdad el «responde 404» del AC en esta
    // ruta es la guarda, y por eso el caso la nombra.
    //
    // `selectMock` se arma con una respuesta VACÍA a propósito, y es lo que convierte este caso en un
    // centinela de verdad: si alguien quita la guarda, la petición ya no muere en un rechazo sin
    // capturar —que daba un rojo MUDO por timeout de 20 s— sino que sigue hasta `buscarConAcceso`,
    // responde igualmente 404 (el mock no sabe de sintaxis de uuid) y falla **el último aserto**,
    // diciendo qué se rompió: se consultó la base con un id que la base no puede ni parsear.
    selectMock.mockReturnValue(chain([]));

    const r = await request(await buildApp())
      .get('/api/flito/soat/causales-rechazo')
      .set('Authorization', await auth('admin'));

    expect(r.status).toBe(404);
    // El cuerpo es el JSON del módulo, no el HTML de Express: se responde DENTRO del handler.
    expect(r.body).toEqual({ error: 'El SOAT no existe' });
    // Y el mismo cuerpo que un uuid bien formado que no existe: quien sondee no puede deducir de la
    // respuesta qué forma tienen los identificadores de este sistema.
    expect(r.text).not.toMatch(/Cannot GET/i);
    // **El aserto que muere si se quita la guarda**: se contesta SIN tocar la base.
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('cualquier `:id` que no sea un uuid se corta igual, sin consultar (no es un caso especial de esa URL)', async () => {
    // La generalización, para que el caso de arriba no se lea como un parche con nombre propio: la
    // guarda mira la FORMA, así que cualquier segmento que no sea un uuid canónico recibe el mismo
    // 404 y ninguno llega a la base.
    //
    // El segmento elegido está MEDIDO contra la BD real, no supuesto: `SELECT 'no-es-un-uuid'::uuid`
    // responde `ERROR: invalid input syntax for type uuid` (22P02), que con el handler global de
    // Express es un 500. Eso es lo que daba esta URL antes de la guarda —y lo que siguen dando las
    // demás rutas con `:id`, deuda preexistente declarada en el docblock de `UUID_RE`.
    selectMock.mockReturnValue(chain([]));

    const r = await request(await buildApp())
      .get('/api/flito/soat/no-es-un-uuid')
      .set('Authorization', await auth('admin'));

    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'El SOAT no existe' });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('**`PATCH /:id/solicitud` para el `cliente` → 403, y NO 404**: el guarda corre antes del enrutado', async () => {
    // La corrección al enunciado del AC. `guardiaCanalCliente` vive al final de `authMiddleware`, o
    // sea dentro del primer router que Express entra y antes de que intente casar ningún patrón. Al
    // salir de `RUTAS_PERMITIDAS_CLIENTE`, la subsanación deja de estar inscrita y el rol externo
    // recibe el 403 genérico —el MISMO cuerpo que devuelve `requireRole`, para que quien sondee no
    // pueda distinguir «no está en mi lista» de «exige otro rol» y mapear la API a base de códigos—.
    // Ni un mock de base: la petición muere en `authMiddleware`, antes de tocar nada.
    const r = await request(await buildApp())
      .patch(`/api/flito/soat/${SOAT_ID}/solicitud`)
      .set('Authorization', await auth('cliente'))
      .field('tipoDocumento', 'CC');

    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'Sin permisos' });
  });

  it('la subsanación tampoco está inscrita en la allowlist, medido en la lista y no en la respuesta', async () => {
    // La otra mitad del caso de arriba: el 403 se obtendría igual si alguien rompiera el guarda para
    // TODO. Esto pregunta directamente a la función que decide.
    const { rutaPermitidaParaCliente, RUTAS_PERMITIDAS_CLIENTE } =
      await import('../../src/shared/middleware/canal-cliente.js');

    expect(rutaPermitidaParaCliente('PATCH', `/api/flito/soat/${SOAT_ID}/solicitud`)).toBe(false);
    // Y la de al lado sigue abierta: sin esto, «devuelve false» pasaría con la lista vacía.
    expect(rutaPermitidaParaCliente('POST', '/api/flito/soat/cliente')).toBe(true);
    // Ninguna entrada de la lista menciona ya la subsanación, ni en su patrón ni en su `porque`: un
    // `porque` que describe un flujo inexistente es lo que convierte una allowlist en folclore.
    for (const entrada of RUTAS_PERMITIDAS_CLIENTE) {
      expect(entrada.patron, 'la subsanación sigue inscrita').not.toContain('/solicitud');
      expect(entrada.porque.toLowerCase(), `el «porque» de ${entrada.patron} cita la subsanación`)
        .not.toMatch(/subsan/);
    }
  });

  it('**el filtro `?estado=` de la cola ya no acepta los dos estados retirados** (si no, es un 500)', async () => {
    // Ningún AC nombra esta lista y sin embargo podarla es obligatorio. Un enlace guardado con
    // `?estado=pendiente_revision` —el que tenía en favoritos quien revisaba— sigue llegando al API.
    // Si el valor SIGUIERA en `ESTADOS`, Drizzle lo mandaría como literal contra una columna cuyo
    // tipo ya no lo tiene y PostgreSQL respondería `22P02 invalid input value for enum`: la cola
    // entera en 500. Podado, cae en el camino ya documentado de «un filtro desconocido se ignora».
    //
    // Se lee el fuente porque `ESTADOS` no se exporta, y se enumera el CONJUNTO y no su tamaño: así
    // tanto reañadir un estado retirado como perder uno de los cuatro ponen rojo este aserto.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const fuente = readFileSync(
      fileURLToPath(new URL('../../src/modules/flito-soat/flito-soat.routes.ts', import.meta.url)), 'utf8',
    );
    const bloque = fuente.match(/const ESTADOS = \[([\s\S]*?)\] as const;/);
    expect(bloque, 'no se encontró la lista ESTADOS del filtro de la cola').not.toBeNull();
    const estados = [...bloque![1].matchAll(/EstadoSoat\.([A-Z_]+)/g)].map((m) => m[1]).sort();
    expect(estados).toEqual(['CON_NOVEDAD', 'PAGADO', 'PENDIENTE', 'SOLICITADO']);
    // Y ni rastro de los dos retirados por su literal, que es como volverían: el enum de
    // shared-types ya no tiene la constante, así que quien los reañada tendrá que teclear la cadena.
    expect(bloque![1]).not.toMatch(/pendiente_revision|rechazada/);
  });

  it('el servicio del canal ya no exporta ninguna de las cuatro funciones de la revisión', async () => {
    // El borrado tiene que llegar al servicio y no quedarse en el router: una función exportada sin
    // ruta es la que alguien vuelve a montar dentro de seis meses «porque ya estaba escrita».
    const canal = await import('../../src/modules/flito-soat/flito-soat-cliente.service.js');
    for (const nombre of ['validarSolicitud', 'rechazarSolicitud', 'subsanarSolicitud', 'listarCausalesRechazo']) {
      expect(canal, `\`${nombre}\` sigue exportada`).not.toHaveProperty(nombre);
    }
    // Y lo que el canal SÍ conserva, para que este aserto no pase con el módulo entero vacío.
    expect(canal).toHaveProperty('crearSolicitud');
    expect(canal).toHaveProperty('preconsulta');
  });
});

// ═════════════════ AC2 — lo que NO se toca ═══════════════════════════════════════════════════════

/**
 * El AC2 se prueba con mocks EXPLÍCITOS de `select`/`transaction` y no con el doble keyed de arriba,
 * y la razón es la que este archivo entero defiende: aquí no basta con «no dio 404». Un 404 puede
 * venir de Express (la ruta no existe: la regresión que se teme) o del servicio (`buscarConAcceso`
 * no encontró la fila: un defecto del escenario). Los dos son 404 y solo uno es una regresión.
 *
 * Con la transacción montada a mano, los tres casos llegan a **200** y se puede afirmar QUÉ
 * escribieron, que es lo único que demuestra que la vía sigue funcionando y no solo respondiendo.
 */
describe('AC2 (regresión) — las tres vías del gestor y de Operaciones sobreviven intactas', () => {
  it('**`POST /:id/rechazar` (el rechazo del GESTOR → `con_novedad`) sigue viva** y sigue siendo suya', async () => {
    // La vecina peligrosa de `POST /:id/rechazar-solicitud`, que sí se borra en esta HU. Otro actor
    // (el gestor, no el admin), otro estado destino (`con_novedad`, no `rechazada`) y otra columna
    // (`flito_soat.motivo_rechazo`, no el satélite del canal). Un borrado por nombre o un
    // `grep -v rechazar` se lleva esta, y el usuario que lo nota es el gestor con una póliza que no
    // puede expedir.
    comoGestor(soatDelCanal());
    const { sets, txUpdate } = montarTx();

    const r = await request(await buildApp()).post(`/api/flito/soat/${SOAT_ID}/rechazar`)
      .set('Authorization', await auth('proveedor'))
      .send({ motivo: 'La aseguradora no expide sobre este vehículo' });

    expect(r.status).toBe(200);
    expect(txUpdate).toHaveBeenCalledTimes(1);
    expect(sets[0]).toMatchObject({
      estado: 'con_novedad',
      motivoRechazo: 'La aseguradora no expide sobre este vehículo',
    });
    // Y sigue siendo el rechazo del GESTOR sobre una fila del CANAL: si alguien hubiera colado un
    // `origen === 'cliente' → 409` al retirar el circuito, este caso lo vería.
    expect(r.body).toBeDefined();
  });

  it('`POST /:id/asumir-operaciones` sigue viva, sigue siendo de Operaciones y escribe lo mismo', async () => {
    comoOperaciones(soatDelCanal());
    const { sets, txUpdate } = montarTx();

    const r = await request(await buildApp()).post(`/api/flito/soat/${SOAT_ID}/asumir-operaciones`)
      .set('Authorization', await auth('admin'))
      .send({ motivo: 'El gestor no responde desde el martes' });

    expect(r.status).toBe(200);
    expect(txUpdate).toHaveBeenCalledTimes(1);
    expect(sets[0]).toMatchObject({ gestionOperaciones: true });
    // El traspaso NO mueve el estado: es la mitad del contrato de la HU #11153 y lo que distingue
    // esta ruta de una reversa. Se afirma en negativo porque es lo que un descuido rompería.
    expect(sets[0]).not.toHaveProperty('estado');
  });

  it('`POST /:id/devolver-gestor` sigue viva, sigue siendo de Operaciones y escribe lo mismo', async () => {
    comoOperaciones(soatDelCanal({ gestionOperaciones: true, proveedorSoatId: null }));
    const { sets, txUpdate } = montarTx();

    const r = await request(await buildApp()).post(`/api/flito/soat/${SOAT_ID}/devolver-gestor`)
      .set('Authorization', await auth('admin'))
      .send({ motivo: 'La aseguradora ya puede retomarlo', proveedorSoatId: OTRO_PROVEEDOR });

    expect(r.status).toBe(200);
    expect(txUpdate).toHaveBeenCalledTimes(1);
    expect(sets[0]).toMatchObject({ gestionOperaciones: false, proveedorSoatId: OTRO_PROVEEDOR });
    expect(sets[0]).not.toHaveProperty('estado');
  });

  it('las tres siguen exigiendo su ROL: el `cliente` no alcanza ninguna', async () => {
    // La otra mitad del «no se tocan»: que sigan existiendo no puede significar que se hayan
    // abierto. El rol externo se topa con la allowlist del canal —ninguna de las tres está
    // inscrita—, así que ni siquiera llega al `requireRole` de su router.
    const { rutaPermitidaParaCliente } = await import('../../src/shared/middleware/canal-cliente.js');
    for (const ruta of ['rechazar', 'asumir-operaciones', 'devolver-gestor']) {
      expect(rutaPermitidaParaCliente('POST', `/api/flito/soat/${SOAT_ID}/${ruta}`), ruta).toBe(false);
    }
  });

  it('**las tres siguen DECLARADAS en `flito-soat.routes.ts`**, con su verbo y su patrón exactos', async () => {
    // La garantía estructural, y la que caza el borrado por nombre aunque los casos de arriba se
    // quedaran verdes por un mock demasiado permisivo. Se lee el fuente, como el resto de
    // centinelas de este módulo, y se enumeran los patrones: un renombrado también lo pone rojo.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const fuente = readFileSync(
      fileURLToPath(new URL('../../src/modules/flito-soat/flito-soat.routes.ts', import.meta.url)), 'utf8',
    );
    const declaradas = [...fuente.matchAll(/^router\.(get|post|patch|put|delete)\(\s*'([^']+)'/gm)]
      .map((m) => `${m[1].toUpperCase()} ${m[2]}`);

    for (const ruta of ['POST /:id/rechazar', 'POST /:id/asumir-operaciones', 'POST /:id/devolver-gestor']) {
      expect(declaradas, `${ruta} desapareció del router del módulo`).toContain(ruta);
    }
    // Y las del canal que se PARECEN no volvieron aquí de rebote al borrarlas de su archivo.
    expect(declaradas).not.toContain('POST /:id/rechazar-solicitud');
    expect(declaradas).not.toContain('POST /:id/validar');
    expect(declaradas).not.toContain('PATCH /:id/solicitud');
  });
});
