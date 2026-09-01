// HU #11916 (Feature #11912), AC1 — el gestor del proveedor ve `solicitado` y `pagado` VENGAN DEL
// TRÁMITE O DEL CANAL, y no ve los dos estados del canal.
//
// ── Por qué esta HU no escribe código para su AC1, y qué se prueba entonces ──────────────────────
//
// El AC1 ya se cumplía cuando esta HU empezó, y se cumplía por construcción, no por una regla que
// alguien escribiera pensando en él. Son DOS piezas de HUs anteriores:
//
//   1. `ESTADOS_SOAT_VISIBLES_GESTOR` es una LISTA BLANCA (`['solicitado','pagado']`, #11913). Los
//      dos estados del canal quedan fuera sin nombrarlos. Convertirla en lista negra —«todos menos
//      estos dos»— daría el mismo resultado HOY y abriría el siguiente estado que se añada.
//   2. `FRONTERA_AUTOGESTION_SOAT` ganó la rama `origen = 'cliente'` (#11914). Sin ella, una compañía
//      con «autogestiona SOAT» y «SOAT sin trámite» encendidos a la vez —los dos flags son
//      independientes y la combinación es esperada— radicaría solicitudes que, una vez validadas, NO
//      llegarían a la cola del gestor: la frontera las escondería por la primera condición.
//
// Así que el trabajo del AC1 es la PRUEBA, y tiene que ser una prueba que muera si cualquiera de las
// dos piezas se rompe. De ahí que aquí no se afirme sobre las filas que el mock devuelve —eso pasa
// igual con el filtro borrado— sino sobre el SQL renderizado y sobre el valor ligado a cada `$N`.
//
// Los mutantes que estas pruebas tienen que atrapar, nombrados:
//   · la lista blanca convertida en lista negra              → «lista blanca, no negra» (los 3 casos)
//   · la frontera sin la rama `origen`                        → «la frontera del canal también rige…»
//   · un filtro por `origen` colado en la cola del gestor      → «la cola del gestor NO filtra por origen»
//   · la lista blanca quitada de `buscarConAcceso`             → los 4 casos del detalle

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import type { SQL } from 'drizzle-orm';
import { testToken } from '../helpers/auth.js';
import { ligadosA, renderizar } from '../helpers/sql-ligado.js';

const selectMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock, update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn(),
    // La cola registra el acceso a PII (`logPiiAccess`); con un `vi.fn()` pelado su catch llena la
    // salida de ERROR que no son de esta prueba.
    insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
  },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

/** Los WHERE que el servicio le pasó a Drizzle, en orden. */
const wheres: SQL[] = [];

/** Chain de Drizzle que ESPÍA el `where(...)` (el helper compartido lo descarta). */
function chainEspia(rows: unknown[]) {
  const t: Record<string, unknown> = {};
  const paso = () => t;
  for (const m of ['from', 'leftJoin', 'innerJoin', 'limit', 'offset', 'orderBy', 'groupBy', 'having', '$dynamic', 'for']) {
    t[m] = paso;
  }
  t.where = (w: SQL) => { wheres.push(w); return t; };
  t.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(rows).then(res, rej);
  t.catch = (rej: (e: unknown) => unknown) => Promise.resolve(rows).catch(rej);
  t.finally = (cb: () => void) => Promise.resolve(rows).finally(cb);
  return t;
}

const PROVEEDOR = '22222222-2222-2222-2222-222222222222';

beforeEach(() => { selectMock.mockReset(); wheres.length = 0; });

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat.routes.js');
  app.use('/api/flito/soat', router);
  return app;
}
const auth = async (role: string) => `Bearer ${await testToken({ sub: 1, username: 'u', role: role as never })}`;

/**
 * Corre la cola para este rol y esta query, y devuelve los WHERE de la cola ya renderizados.
 *
 * `contextoSoat` consulta `users` para `proveedor` y `cliente`; para `admin` no consulta nada. Esa
 * primera consulta se descarta: sus condiciones son las de la lectura del usuario, no las de la cola.
 */
async function colaDe(rol: 'proveedor' | 'admin', query = '') {
  selectMock.mockReset(); wheres.length = 0;
  if (rol !== 'admin') selectMock.mockImplementationOnce(() => chainEspia([{ p: PROVEEDOR }]));
  selectMock.mockImplementationOnce(() => chainEspia([{ total: 0 }])); // conteo
  selectMock.mockImplementationOnce(() => chainEspia([]));             // página
  const r = await request(await buildApp()).get(`/api/flito/soat${query}`).set('Authorization', await auth(rol));
  expect(r.status).toBe(200);
  return {
    respuesta: r,
    consultas: selectMock.mock.calls.length,
    wheres: (rol === 'admin' ? wheres : wheres.slice(1)).map(renderizar),
  };
}

const COL_ESTADO = '"flito_soat"."estado"';
const COL_ORIGEN = '"flito_soat"."origen"';

describe('AC1 — la cola del gestor no discrimina por ORIGEN', () => {
  it('no hay ni un filtro por `origen` fuera de la frontera: el canal y el trámite entran iguales', async () => {
    const { wheres: qs } = await colaDe('proveedor');
    expect(qs).toHaveLength(2); // conteo y página: los dos llevan lo mismo o el total miente

    for (const q of qs) {
      // `origen` aparece UNA sola vez, y es la de la frontera —dentro del `OR` que la abre—. Una
      // segunda aparición sería un `AND origen = …` en la cola del gestor, es decir, el AC1 al revés:
      // el gestor dejaría de ver uno de los dos orígenes.
      expect(q.sql.match(/"flito_soat"\."origen"/g)).toHaveLength(1);
      expect(q.sql).toContain(`OR ${COL_ORIGEN} =`);
      // Y su frontera de siempre sigue intacta.
      expect(ligadosA(q, '"flito_soat"."proveedor_soat_id"')).toEqual([PROVEEDOR]);
      expect(ligadosA(q, '"flito_soat"."gestion_operaciones"')).toEqual([false]);
    }
  });

  it('la frontera del canal también rige para el GESTOR: sin la rama `origen` pierde lo del canal', async () => {
    // Es la pieza 2 y la única que puede romperse sin tocar nada del gestor: la frontera es una
    // constante compartida. Si alguien le quita la tercera condición, una solicitud del canal ya
    // VALIDADA (`solicitado`, de una compañía que autogestiona) desaparece de la cola de quien tiene
    // que comprarla, en verde y sin que ninguna prueba de la #11914 lo note — allí se mide con un
    // `admin`. La aserción es posicional: `toContain('cliente')` sobre los parámetros pasaría
    // aunque la comparación ligara otro valor a esta columna.
    const { wheres: qs } = await colaDe('proveedor');
    for (const q of qs) {
      expect(ligadosA(q, COL_ORIGEN)).toEqual(['cliente']);
      expect(q.sql).toContain('"clients"."soat_autogestionable"');
      expect(q.sql).toContain('"flito_soat"."excepcion_autogestion"');
    }
  });
});

describe('AC1 — `ESTADOS_SOAT_VISIBLES_GESTOR` es lista BLANCA, no negra', () => {
  it('sin filtro, la cola del gestor parte de `solicitado` y de nada más', async () => {
    const { wheres: qs } = await colaDe('proveedor');
    for (const q of qs) expect(ligadosA(q, COL_ESTADO)).toEqual(['solicitado']);
  });

  it('pidiendo los dos visibles, los recibe los dos (AC1: «ve solicitado y pagado»)', async () => {
    const { wheres: qs } = await colaDe('proveedor', '?estado=solicitado,pagado');
    for (const q of qs) expect(ligadosA(q, COL_ESTADO)).toEqual(['solicitado', 'pagado']);
  });

  it('pidiendo un estado del canal MEZCLADO con uno visible, solo pasa el visible', async () => {
    // El mutante que este caso mata: `filter((e) => !VISIBLES.includes(e))` —la lista blanca leída al
    // revés— dejaría pasar `rechazada` y filtraría `solicitado`. Se comprueban las dos mitades: lo
    // que entra Y que el estado del canal no está entre los valores ligados de la consulta.
    const { wheres: qs } = await colaDe('proveedor', '?estado=solicitado,rechazada');
    for (const q of qs) {
      expect(ligadosA(q, COL_ESTADO)).toEqual(['solicitado']);
      expect(q.params).not.toContain('rechazada');
    }
  });

  it('pidiendo SOLO estados del canal, no se consulta `flito_soat` en absoluto', async () => {
    // `condicionesCola` devuelve `null` → `cola()` sale sin tocar la tabla. Con una lista negra esto
    // sería la consulta MÁS peligrosa de todas: le devolvería al gestor las solicitudes que ningún
    // admin ha validado todavía. Se cuenta la consulta, no las filas.
    const { respuesta, consultas } = await colaDe('proveedor', '?estado=pendiente_revision,rechazada');
    expect(respuesta.body).toEqual({ items: [], total: 0, page: 1, pageSize: 50 });
    expect(consultas).toBe(1); // solo la de `contextoSoat`
    expect(wheres).toHaveLength(1);
  });

  it('el ADMIN sí puede filtrar por los dos estados del canal (la lista blanca es SOLO del gestor)', async () => {
    // La contraparte obligatoria. Sin ella, «no aparece `rechazada` en la consulta» pasaría también
    // si alguien rompiera el filtro para todo el mundo, y la cola de revisión del admin —que es la
    // razón de ser de la #11915— se quedaría sin sus dos pills.
    const { wheres: qs } = await colaDe('admin', '?estado=pendiente_revision,rechazada');
    for (const q of qs) expect(ligadosA(q, COL_ESTADO)).toEqual(['pendiente_revision', 'rechazada']);
  });
});

describe('AC1 — el detalle: `buscarConAcceso` aplica la MISMA lista blanca', () => {
  // Sin esto, el AC1 se cumpliría en la lista y no «consultando por ID directo» (CA-09): el gestor
  // que conociera el uuid de una solicitud sin validar leería su detalle, su historial y sus
  // soportes, que es por donde entra el propietario.
  const filaDe = (estado: string, origen: string) => ({
    soat: {
      id: '00000000-0000-0000-0000-0000000000aa', companiaId: 3, estado, origen,
      proveedorSoatId: PROVEEDOR, gestionOperaciones: false,
    },
    dentroDeFrontera: true,
  });
  const ctxGestor = { userId: 1, username: 'u', role: 'proveedor', proveedorSoatId: PROVEEDOR, companiaId: null };

  const buscar = async (estado: string, origen: string) => {
    selectMock.mockImplementationOnce(() => chainEspia([filaDe(estado, origen)]));
    const { buscarConAcceso } = await import('../../src/modules/flito-soat/flito-soat.service.js');
    return buscarConAcceso('00000000-0000-0000-0000-0000000000aa', ctxGestor);
  };

  it('`pendiente_revision` → null (la ruta lo sirve como 404, no como 403)', async () => {
    expect(await buscar('pendiente_revision', 'cliente')).toBeNull();
  });

  it('`rechazada` → null', async () => {
    expect(await buscar('rechazada', 'cliente')).toBeNull();
  });

  it('`solicitado` DEL CANAL → lo obtiene igual que uno de trámite (es el AC1 en positivo)', async () => {
    const soat = await buscar('solicitado', 'cliente');
    expect(soat?.estado).toBe('solicitado');
    expect(soat?.origen).toBe('cliente');
  });

  it('`pagado` DEL CANAL → también', async () => {
    const soat = await buscar('pagado', 'cliente');
    expect(soat?.estado).toBe('pagado');
    expect(soat?.origen).toBe('cliente');
  });
});
