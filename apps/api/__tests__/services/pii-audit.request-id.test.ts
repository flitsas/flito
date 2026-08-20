// Bug #11622 — un `X-Request-Id` no-UUID no puede borrar la fila de `pii_access_log`.
//
// ── Por qué este archivo existe y no bastaba con los tests del módulo ───────────────────────────
//
// `flito-comparendos-acceso-pii.test.ts` mockea `logPiiAccess`, y hace bien: lo que ese archivo
// tiene que fijar es QUÉ le pasa el módulo al helper. Pero por esa misma construcción **ningún test
// escrito sobre ese mock puede probar este bug**: sus 19 verdes acreditan que las rutas LLAMAN bien
// al helper, no que quede constancia. La distancia entre «lo llamé» y «quedó la fila» es
// exactamente el defecto — el INSERT reventaba con un 22P02 (`invalid input syntax for type uuid`)
// que el `catch` best-effort se tragaba, y la respuesta salía 200 sin rastro de nadie.
//
// Aquí, por tanto, **`logPiiAccess` NO se mockea**. Se mockea solo la capa de base y se afirma sobre
// el valor que llega a `db.insert(piiAccessLog).values(...)`, que es el que PostgreSQL habría
// rechazado. En este harness Postgres está mockeado (ver `__tests__/setup.ts`), así que el INSERT
// real no se puede ejercer; el sustituto fiel es mirar el payload en el borde.
//
// Dos capas, dos bloques de tests, porque son dos guardas independientes y cada uno tiene que poder
// morir por su cuenta:
//
//   1. **`app.ts`** — la causa: la cabecera se valida y se descarta si no es un UUID. Se ejerce
//      end-to-end con `createApp()`, porque el middleware vive ahí y un router montado a mano no lo
//      atravesaría.
//   2. **`shared/pii-audit.ts`** — el cinturón: aunque alguien monte una ruta fuera de `createApp`,
//      lo que no sea UUID entra como NULL. Se ejerce llamando al helper con peticiones fingidas.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Request } from 'express';
import { getTableName } from 'drizzle-orm';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken } from '../helpers/auth.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));
// Sin esto, `apiLimiter` (500/15min) y `lecturasPiiLimiter` cuentan entre tests del mismo worker.
vi.mock('express-rate-limit', () => ({
  default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  ipKeyGenerator: (ip: string) => ip,
}));

/** Todo lo que la aplicación logueó, con el componente que lo emitió. Ver el test del `log.warn`. */
const registroLog: Array<{ componente: string; metodo: string; args: unknown[] }> = [];
vi.mock('../../src/shared/logger.js', () => {
  const fake = (componente: string): unknown => new Proxy({}, {
    get: (_t, metodo: string) => (metodo === 'child'
      ? () => fake(componente)
      : (...args: unknown[]) => { registroLog.push({ componente, metodo, args }); }),
  });
  return { logger: fake('root'), loggerFor: (c: string) => fake(c) };
});

const { logPiiAccess } = await import('../../src/shared/pii-audit.js');
const { piiAccessLog, flitoComparendosNits } = await import('../../src/db/schema.js');

const TABLA_LOG = getTableName(piiAccessLog);
const RUTA_NITS = '/api/flito/comparendos/nits';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_CLIENTE = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
/** `$request_id` de nginx: 32 hex sin guiones. PostgreSQL lo admite en una columna `uuid`. */
const ID_NGINX = '3f2504e04f8911d39a0c0305e82c3301';
/** `ip_origen` es `varchar(45)`: 46 caracteres es el primer valor que provoca el 22001. */
const XFF_LARGO = 'a'.repeat(46);
/** El IPv6 más largo que existe — 45 caracteres exactos. De ahí sale el ancho de la columna. */
const IPV6_MAX = 'ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255';
/** Lo que se escribió en `ip_origen`, para no repetir el índice en cada test. */
const ipDelLog = () => filasLog()[0]!.ipOrigen;
const AHORA = new Date('2026-08-20T12:00:00Z');

/** Cada `db.insert(tabla).values(v)` que atravesó el mock, en orden. */
const inserts: Array<{ tabla: string; values: Record<string, unknown> }> = [];

/** Las filas que se escribieron en `pii_access_log`. */
const filasLog = () => inserts.filter((i) => i.tabla === TABLA_LOG).map((i) => i.values);

/**
 * Envuelve el `insert` del mock keyed para espiar el payload sin cambiar su comportamiento.
 *
 * `kdb.reset()` reinstala la implementación por defecto en cada `beforeEach`, así que la envoltura
 * se vuelve a poner después y delega en la que acaba de instalarse.
 */
function espiarInserts(): void {
  const original = kdb.insert.getMockImplementation()!;
  kdb.insert.mockImplementation((tbl: unknown) => {
    const cadena = original(tbl) as Record<string, unknown>;
    const values = cadena.values as (v: unknown) => unknown;
    cadena.values = (v: Record<string, unknown>) => {
      inserts.push({ tabla: safeName(tbl), values: v });
      return values.call(cadena, v);
    };
    return cadena;
  });
}

function safeName(tbl: unknown): string {
  try { return getTableName(tbl as never) || '__expr__'; } catch { return '__expr__'; }
}

const filaNit = () => ({
  id: '11111111-1111-1111-1111-111111111111', nit: '900123456', alias: 'Transportes ACME',
  activo: true, createdAt: AHORA, createdBy: 7, updatedAt: AHORA, updatedBy: 7,
});

// El `import` va en el cuerpo del módulo, no en un `beforeAll`: `createApp` arrastra el grafo entero
// de la API y en frío su transformación pasa de los 10 s de `hookTimeout`, lo que tumbaría el
// archivo por reloj y no por lo que prueba. La fase de import no tiene ese tope.
const { createApp } = await import('../../src/app.js');
const app = createApp();

beforeEach(() => {
  kdb.reset();
  espiarInserts();
  inserts.length = 0;
  kdb.when.select(getTableName(flitoComparendosNits), [filaNit()]);
});

const auth = async () => `Bearer ${await testToken({ sub: 7, username: 'ops@flit.io', role: 'admin' })}`;

// ─────────── (1) La causa: `app.ts` valida la cabecera antes de que nadie la use ────────────────

describe('TC-11622-01 — un X-Request-Id que no es UUID no puede borrar el rastro', () => {
  it('`X-Request-Id: x` → 200 con el catálogo Y la fila de acceso, con un request_id insertable', async () => {
    const r = await request(app).get(RUTA_NITS)
      .set('Authorization', await auth())
      .set('X-Request-Id', 'x');

    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(r.body[0].nit).toBe('900123456');

    // Lo que el bug se llevaba por delante: la fila entera.
    expect(filasLog()).toHaveLength(1);
    const fila = filasLog()[0]!;
    expect(fila.resourceTipo).toBe('flito_comparendos_nit');
    expect(fila.userId).toBe(7);

    // Y el valor exacto que PostgreSQL rechazaba con 22P02.
    expect(fila.requestId).not.toBe('x');
    // El AC admite «NULL o un UUID generado», pero se afirma lo ESTRICTO a propósito: una
    // disyunción con `null` pasaría también si el middleware de `app.ts` desapareciera y solo
    // quedara el cinturón de `pii-audit`, que es justo la distinción que este archivo separa.
    expect(fila.requestId).toMatch(UUID_RE);
  });

  it('el handler ve la cabecera ya saneada: `x` no sobrevive a la petición', async () => {
    const r = await request(app).get(RUTA_NITS)
      .set('Authorization', await auth())
      .set('X-Request-Id', 'x');

    expect(r.status).toBe(200);
    // Nadie aguas abajo (errorHandler, logs, el helper) puede volver a ver el valor del cliente.
    expect(filasLog()[0]!.requestId).toMatch(UUID_RE);
  });

  it('un UUID válido se CONSERVA tal cual — la correlación del cliente no se pierde', async () => {
    await request(app).get(RUTA_NITS)
      .set('Authorization', await auth())
      .set('X-Request-Id', UUID_CLIENTE);

    expect(filasLog()[0]!.requestId).toBe(UUID_CLIENTE);
  });

  it('el `$request_id` de nginx (32 hex sin guiones) sobrevive — no se rompe al proxy', async () => {
    await request(app).get(RUTA_NITS)
      .set('Authorization', await auth())
      .set('X-Request-Id', ID_NGINX);

    // Tal cual, sin canonizar: así la cadena del log del API sigue casando con la del proxy.
    expect(filasLog()[0]!.requestId).toBe(ID_NGINX);
  });

  it('sin cabecera se genera uno — el comportamiento previo al bug no se toca', async () => {
    await request(app).get(RUTA_NITS).set('Authorization', await auth());

    const id = filasLog()[0]!.requestId;
    expect(id).toMatch(UUID_RE);
  });

  it('cabecera repetida (Node las une con coma) tampoco pasa', async () => {
    await request(app).get(RUTA_NITS)
      .set('Authorization', await auth())
      .set('X-Request-Id', [UUID_CLIENTE, 'x'] as unknown as string);

    const id = String(filasLog()[0]!.requestId);
    expect(id).toMatch(UUID_RE);
    expect(id).not.toContain(',');
  });
});

// ─────────── (2) El cinturón: `pii-audit.ts` sanea aunque nadie haya pasado por (1) ─────────────

/** Petición fingida — el camino de quien NO atraviesa el middleware de `createApp`. */
const reqFalso = (requestId: unknown, xff?: unknown, ip: unknown = '10.0.0.1'): Request => ({
  headers: {
    ...(requestId === undefined ? {} : { 'x-request-id': requestId }),
    ...(xff === undefined ? {} : { 'x-forwarded-for': xff }),
  },
  ip,
  user: { sub: 7, role: 'admin' },
}) as unknown as Request;

const registrar = (requestId: unknown) => logPiiAccess(reqFalso(requestId), {
  resourceTipo: 'flito_comparendos_nit', accion: 'search', camposAccedidos: ['nit'],
});

const registrarConIp = (xff: unknown, ip: unknown = '10.0.0.1') => logPiiAccess(
  reqFalso(UUID_CLIENTE, xff, ip),
  { resourceTipo: 'flito_comparendos_nit', accion: 'search', camposAccedidos: ['nit'] },
);

describe('logPiiAccess — el saneo en el borde del INSERT', () => {
  it.each([
    ['texto suelto', 'x'],
    ['UUID truncado', '3f2504e0-4f89-11d3-9a0c'],
    ['UUID con basura pegada', `${UUID_CLIENTE}-nope`],
    ['cadena vacía tras espacios', '   '],
    ['inyección SQL de manual', "'; DROP TABLE pii_access_log; --"],
    ['31 hex — un dígito menos que la forma de nginx', ID_NGINX.slice(0, 31)],
    ['33 hex — uno de más', `${ID_NGINX}a`],
  ])('%s → request_id NULL, pero la fila SE ESCRIBE', async (_caso, valor) => {
    await registrar(valor);

    expect(filasLog()).toHaveLength(1);
    expect(filasLog()[0]!.requestId).toBeNull();
  });

  it('un UUID válido llega intacto al INSERT', async () => {
    await registrar(UUID_CLIENTE);
    expect(filasLog()[0]!.requestId).toBe(UUID_CLIENTE);
  });

  it('la forma de nginx llega intacta al INSERT — la canoniza PostgreSQL, no nosotros', async () => {
    await registrar(ID_NGINX);
    expect(filasLog()[0]!.requestId).toBe(ID_NGINX);
  });

  it('un UUID en mayúsculas se acepta — PostgreSQL lo normaliza', async () => {
    await registrar(UUID_CLIENTE.toUpperCase());
    expect(filasLog()[0]!.requestId).toBe(UUID_CLIENTE.toUpperCase());
  });

  it('el UUID nil se acepta: la columna `uuid` lo admite y es correlación legítima', async () => {
    await registrar('00000000-0000-0000-0000-000000000000');
    expect(filasLog()[0]!.requestId).toBe('00000000-0000-0000-0000-000000000000');
  });

  it('cabecera repetida como array → NULL (lo que ya hacía el guarda de `typeof`; no se rompe)', async () => {
    await registrar([UUID_CLIENTE, UUID_CLIENTE]);
    expect(filasLog()[0]!.requestId).toBeNull();
  });

  it('sin cabecera → NULL, y la fila también se escribe', async () => {
    await registrar(undefined);
    expect(filasLog()).toHaveLength(1);
    expect(filasLog()[0]!.requestId).toBeNull();
  });

  it('el helper sigue fallando ABIERTO si el INSERT revienta (fuera de alcance del bug)', async () => {
    kdb.insert.mockImplementationOnce(() => { throw new Error('22P02'); });
    // No lanza: la decisión de negarse a entregar PII cuando el rastro falla está pendiente
    // de decisión de negocio y este bug no la toma.
    await expect(registrar(UUID_CLIENTE)).resolves.toBeUndefined();
  });
});

// ─────────── El mismo defecto en la línea de al lado: `X-Forwarded-For` (22001) ─────────────────
//
// `ip_origen` es `varchar(45)` en la DDL real (mig. 0059) y el helper leía la cabecera cruda. Un
// XFF de 46 caracteres da un 22001 —el INSERT usa cast de asignación, que NO trunca— y lo traga el
// mismo `catch`: fila perdida otra vez, y otra vez a voluntad del cliente. Cerrarlo aquí y no en
// otro PR es lo que evita entregar un arreglo que cierra una puerta y deja abierta la de al lado.

describe('logPiiAccess — `ip_origen` no puede reventar el INSERT', () => {
  it('XFF de 46 caracteres → la fila SE ESCRIBE y `ip_origen` no lleva la basura', async () => {
    await registrarConIp(XFF_LARGO);

    expect(filasLog()).toHaveLength(1);
    expect(ipDelLog()).not.toBe(XFF_LARGO);
    // Cae al `req.ip`, que sí es una IP. Lo que no puede pasar es que entre lo que no cabe.
    expect(ipDelLog()).toBe('10.0.0.1');
  });

  it('ni con XFF ni con `req.ip` válidos entra nada: `ip_origen` NULL, pero queda la fila', async () => {
    // El caso real: `trust proxy` deriva `req.ip` del propio XFF y el paquete `forwarded` no
    // comprueba que cada elemento sea una IP, así que la basura puede llegar también por ahí.
    await registrarConIp(XFF_LARGO, XFF_LARGO);

    expect(filasLog()).toHaveLength(1);
    expect(ipDelLog()).toBeNull();
  });

  it('sin `req.ip` utilizable se cae al XFF, y entonces sí vale su primer elemento', async () => {
    await registrarConIp('203.0.113.7, 70.41.3.18, 150.172.238.178', null);
    expect(ipDelLog()).toBe('203.0.113.7');
  });

  it('el IPv6 más largo (45 caracteres) cabe y se guarda: la validación no recorta de más', async () => {
    await registrarConIp(IPV6_MAX, null);
    expect(String(ipDelLog())).toHaveLength(45);
    expect(ipDelLog()).toBe(IPV6_MAX);
  });

  it.each([
    ['inyección de manual', "'; DROP TABLE pii_access_log; --"],
    ['hostname, no IP', 'evil.example.com'],
    ['vacío', ''],
    // El agujero que `net.isIP` sola NO cierra: en Node 24 acepta IPv6 con zona y la zona no tiene
    // tope de longitud, así que sin la cota de 45 esto vuelve a ser un 22001 desde una cabecera.
    ['IPv6 con zona larga — 68 caracteres que `net.isIP` da por buenos', `fe80::1%${'a'.repeat(60)}`],
  ])('%s en el XFF → no llega a `ip_origen`', async (_caso, valor) => {
    // `req.ip` a `null` a propósito: si se dejara uno válido, ganaría por precedencia y este test
    // pasaría sin llegar a ejercer la validación del XFF, que es lo que quiere fijar.
    await registrarConIp(valor, null);

    expect(filasLog()).toHaveLength(1);
    expect(ipDelLog()).not.toBe(valor);
    expect(ipDelLog()).toBeNull();
  });

  it('un IPv6 con zona que SÍ cabe se conserva: la cota acota, no prohíbe', async () => {
    await registrarConIp('fe80::1%eth0', null);
    expect(ipDelLog()).toBe('fe80::1%eth0');
  });

  it('**`X-Forwarded-For: 8.8.8.8` no puede falsificar `ip_origen`**: gana la IP real', async () => {
    // Con `trust proxy = 1`, `req.ip` es el ÚLTIMO elemento del XFF —el que añadió nginx— y el
    // primero es el que eligió el cliente. Preferir `XFF[0]` dejaba escribir en la columna del
    // art. 17 la IP que uno quisiera teniendo la real a mano: no se pierde la fila, se falsifica,
    // que es peor porque nadie sabe que hay que desconfiar de ella.
    await registrarConIp('8.8.8.8', '203.0.113.7');

    expect(ipDelLog()).toBe('203.0.113.7');
    expect(ipDelLog()).not.toBe('8.8.8.8');
  });

  it('sin XFF se usa `req.ip`, como siempre — el camino bueno no se toca', async () => {
    await registrarConIp(undefined);
    expect(ipDelLog()).toBe('10.0.0.1');
  });

  it('end-to-end: `GET /nits` con un XFF de 46 caracteres responde 200 Y deja la fila', async () => {
    const r = await request(app).get(RUTA_NITS)
      .set('Authorization', await auth())
      .set('X-Forwarded-For', XFF_LARGO);

    expect(r.status).toBe(200);
    expect(filasLog()).toHaveLength(1);

    const ip = ipDelLog();
    expect(ip).not.toBe(XFF_LARGO);
    // `trust proxy = 1` hace que Express derive `req.ip` de ese mismo XFF, así que aquí la basura
    // también se cuela por el fallback: lo correcto es NULL, y con la fila escrita.
    expect(ip === null || String(ip).length <= 45).toBe(true);
  });
});

// ─────────── El `log.warn` del saneo no puede convertirse en la fuga (obs. de seguridad) ────────

describe('logPiiAccess — el aviso de descarte no vuelca el valor del cliente', () => {
  it('avisa del `x-request-id` descartado SIN escribir lo que mandó el cliente', async () => {
    const secreto = "'; DROP TABLE pii_access_log; --";
    registroLog.length = 0;
    await registrar(secreto);

    const avisos = registroLog.filter((l) => l.componente === 'pii-audit' && l.metodo === 'warn');
    expect(avisos).toHaveLength(1);

    // Un `{ valor: requestIdCrudo }` añadido «para depurar» pasaría el resto de la suite en verde.
    // El log de aplicación no es sitio para texto que elige quien está siendo auditado.
    expect(JSON.stringify(avisos[0]!.args)).not.toContain(secreto);
    expect(JSON.stringify(avisos[0]!.args)).not.toContain('DROP TABLE');
  });

  it('un `x-request-id` válido no genera aviso — el warn señala anomalías, no tráfico normal', async () => {
    registroLog.length = 0;
    await registrar(UUID_CLIENTE);

    expect(registroLog.filter((l) => l.componente === 'pii-audit' && l.metodo === 'warn')).toHaveLength(0);
  });
});
