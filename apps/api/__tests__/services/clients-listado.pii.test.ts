// HU #11299 AC8 — el padrón de clientes deja rastro y entrega solo lo que la ficha necesita.
//
// El bloqueante que la auditoría de seguridad del ciclo anterior levantó y que entonces se declaró
// como deuda de otro módulo: `GET /clients` resolvía con un `db.select()` SIN proyección —la fila
// COMPLETA de hasta 500 clientes: nombre, documento, dirección, teléfono, correo, contacto y todo lo
// que se le añadiera mañana a la tabla— y en todo el router `clients/` no había una sola llamada a
// `logPiiAccess`, mientras `drivers/`, `flito-comparendos/`, `flito-conciliacion/` y `pesv/` sí
// registraban (AGENTS.md §16, Ley 1581 art. 17). Es la lectura de datos personales más grande que
// provoca el panel de Terceros: la ficha fiscal la pide con `?limit=500` cada vez que se abre.
//
// Lo que se demuestra, y por qué cada cosa:
//
//   1. **Leer el padrón deja rastro**, con recurso, acción, campos y el tramo entregado. Sin esto,
//      mañana alguien quita la línea y nada se pone rojo — que es exactamente cómo llegamos aquí.
//   2. **La respuesta se proyecta**, y la proyección es la unión medida de lo que leen los CINCO
//      consumidores de la ruta. La lista está escrita consumidor por consumidor más abajo: un
//      recorte que rompe una pantalla sería peor que la deuda que corrige.
//   3. **El registro se DERIVA de la proyección.** No puede declarar un campo que la ruta no
//      entregue —el bloqueante del ciclo anterior fue un inventario que exageraba su alcance— ni
//      callarse uno personal que sí entregue.
//   4. **Un 401 y un 403 no registran acceso**: nadie llegó a mirar los datos de nadie.
//   5. **El rastro no copia lo leído**: nombres de columna, nunca valores.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn(),
    transaction: vi.fn(), execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

vi.mock('../../src/shared/middleware/audit.js', () => ({
  audit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

/** Igual que en `siigo-validador-cliente.pii.test.ts`: se fija el contrato, no el INSERT. */
const logPiiAccessMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/pii-audit.js', () => ({
  logPiiAccess: (...args: unknown[]) => logPiiAccessMock(...args),
}));

const { CAMPOS_PII_LISTADO, COLUMNAS_LISTADO } = await import('../../src/modules/clients/clients.pii.js');
const { clients } = await import('../../src/db/schema.js');

beforeEach(() => {
  selectMock.mockReset();
  logPiiAccessMock.mockClear();
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/clients/clients.routes.js');
  app.use('/api/clients', router);
  return app;
}

const auth = async (role: string = 'admin') => `Bearer ${await testToken({ sub: 7, role })}`;

/** Dos fichas, una de persona natural: `clients` mezcla naturales y jurídicas en la misma tabla. */
const PADRON = [
  { id: 41, name: 'PEDRO ANTONIO GÓMEZ', document: '79345612', city: 'CHIA' },
  { id: 42, name: 'ACME S.A.S.', document: '900123456', city: 'MEDELLIN' },
];

/** Lo que el helper recibió en su última llamada. */
const ultimoAcceso = () => logPiiAccessMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;

/** La proyección con la que se llamó a `db.select()`. */
const proyeccionUsada = () => selectMock.mock.calls[0]?.[0] as Record<string, unknown> | undefined;

describe('AC8 — la consulta del listado queda registrada', () => {
  it('registra recurso, acción, campos y el tramo entregado', async () => {
    selectMock.mockReturnValueOnce(chain(PADRON));
    const app = await buildApp();

    const r = await request(app).get('/api/clients').set('Authorization', await auth('auditor'));

    expect(r.status).toBe(200);
    expect(logPiiAccessMock).toHaveBeenCalledTimes(1);
    expect(ultimoAcceso()).toMatchObject({
      resourceTipo: 'client',
      accion: 'search',
      camposAccedidos: [...CAMPOS_PII_LISTADO],
      // Un listado no apunta a una ficha, sino a un tramo del padrón.
      resourceId: null,
    });
    expect(ultimoAcceso().motivo).toContain('filas=2');
    // Nombrados a mano, para que esta prueba no dependa solo de la constante que ella misma
    // importa: la lista derivada se comprueba aparte, contra la proyección.
    expect(ultimoAcceso().camposAccedidos)
      .toEqual(expect.arrayContaining(['name', 'document', 'address', 'city', 'contact_email']));
  });

  it('el motivo reconstruye QUÉ tramo se llevó, no solo cuántas filas', async () => {
    // `filas` sin `limit`/`offset` no distingue «las 50 primeras» de «las 50 de la página nueve».
    selectMock.mockReturnValueOnce(chain(PADRON));
    const app = await buildApp();

    await request(app).get('/api/clients?limit=50&offset=100').set('Authorization', await auth());

    const motivo = String(ultimoAcceso().motivo);
    expect(motivo).toContain('limit="50"');
    expect(motivo).toContain('offset="100"');
  });

  it('el mismo recurso que usa la bitácora de escrituras: `client`', async () => {
    // Cruzar «quién modificó esta ficha» con «quién la leyó» tiene que ser UNA consulta. Es el
    // criterio que `siigo.pii.ts` deja escrito para `RECURSO_CLIENTE`, y este módulo lo hereda
    // llamando a su contrato en vez de escribir el suyo.
    const { RECURSO_CLIENTE } = await import('../../src/modules/siigo/siigo.pii.js');
    selectMock.mockReturnValueOnce(chain(PADRON));
    const app = await buildApp();

    await request(app).get('/api/clients').set('Authorization', await auth());

    expect(ultimoAcceso().resourceTipo).toBe(RECURSO_CLIENTE);
  });

  it('el rastro no copia lo leído: nombres de columna, nunca valores', async () => {
    selectMock.mockReturnValueOnce(chain(PADRON));
    const app = await buildApp();

    await request(app).get('/api/clients').set('Authorization', await auth());

    const escrito = JSON.stringify(ultimoAcceso());
    expect(escrito).not.toContain('PEDRO');
    expect(escrito).not.toContain('79345612');
    expect(escrito).not.toContain('CHIA');
    // Lo que sí lleva son NOMBRES de columna, que es lo que hace consultable el log.
    expect(escrito).toContain('document');
    expect(escrito).toContain('contact_email');
  });
});

describe('AC8 — la respuesta entrega columnas, no la fila entera', () => {
  it('la consulta va con la proyección explícita, no con un `select()` desnudo', async () => {
    selectMock.mockReturnValueOnce(chain(PADRON));
    const app = await buildApp();

    await request(app).get('/api/clients').set('Authorization', await auth());

    // `db.select()` sin argumentos —lo de antes— deja `calls[0][0]` en `undefined`, que es
    // exactamente el defecto que este AC corrige.
    expect(proyeccionUsada()).toBe(COLUMNAS_LISTADO);
  });

  it('la proyección es lo que leen los cinco consumidores de la ruta, ni un campo menos', () => {
    // Medido en `apps/web` archivo por archivo, y por eso la lista va aquí y no en un comentario
    // suelto: si mañana alguien recorta una columna, esta prueba nombra a quién se la quita.
    const clientsTsx = [
      // `pages/Clients.tsx` — la tabla del padrón y sus interruptores de autogestión, más la
      // casilla «SOAT sin trámite» (Feature #11912, HU #11913). Viaja en ESTA ruta y no en
      // `/flito/parametrizacion/companias`: `financiera` ve esta pantalla y no aquella ruta, así
      // que por el otro camino la columna le quedaría vacía sin saber por qué.
      'id', 'name', 'document', 'documentType', 'city', 'phone', 'email',
      'soatAutogestionable', 'soatSinTramite', 'impuestosAutogestionable',
      'logisticaAutogestionable', 'logisticaPermiteParcial',
    ];
    const fichaFiscal = [
      // `components/clientes/FichaFiscal.tsx` — pide `/clients?limit=500` y arma el formulario.
      'id', 'name', 'document', 'city', 'address', 'personType', 'idType', 'checkDigit',
      'fiscalResponsibilities', 'countryCode', 'stateCode', 'cityCode', 'commercialName',
      'branchOffice', 'contactFirstName', 'contactLastName', 'contactEmail',
      'phoneIndicative', 'phoneNumber',
    ];
    // `pages/FlitoBolsas.tsx` y `pages/FlitoConciliacion.tsx` — selectores: `id` y `name`.
    const selectores = ['id', 'name'];
    // `pages/RndcRemesaForm.tsx` — el remitente de una remesa.
    const rndc = ['id', 'name', 'document'];

    const necesarias = new Set([...clientsTsx, ...fichaFiscal, ...selectores, ...rndc]);
    const proyectadas = new Set(Object.keys(COLUMNAS_LISTADO));

    expect([...necesarias].filter((c) => !proyectadas.has(c))).toEqual([]);
    expect([...proyectadas].filter((c) => !necesarias.has(c))).toEqual([]);
  });

  it('deja fuera lo que ninguna pantalla lee, empezando por lo personal', () => {
    // El recorte no es cosmético aunque sean diez columnas de treinta y seis: `notes` es texto
    // libre —donde acaba cualquier cosa—, `cityTextoOrigen` es la ubicación que tenía la ficha
    // antes de confirmarse y `flitoCarpetaStorage` se deriva del NIT.
    for (const fuera of [
      'notes', 'active', 'cityTextoOrigen', 'flitoCarpetaStorage', 'flitoToleranciaValorImpuesto',
      'personTypeOrigen', 'cityConfirmadaPor', 'cityConfirmadaEn', 'facturacionBloqueos', 'createdAt',
    ]) {
      expect(Object.keys(COLUMNAS_LISTADO)).not.toContain(fuera);
      // Y son columnas de verdad: si mañana se renombran en el esquema, esta lista deja de
      // proteger nada y hay que enterarse aquí.
      expect(Object.keys(clients)).toContain(fuera);
    }
  });

  it('lo que se declara leído es exactamente lo personal que se entrega', () => {
    const nombresProyectados = Object.values(COLUMNAS_LISTADO).map((c) => c.name);

    // Ni un campo declarado que la ruta no entregue: es el bloqueante del ciclo anterior, y aquí
    // no se puede escribir porque la lista se deriva de la proyección.
    for (const campo of CAMPOS_PII_LISTADO) expect(nombresProyectados).toContain(campo);

    // Y ni uno personal callado. Los nombres son los de la BASE, para poder cruzar el log con la
    // tabla y no con el DTO de una pantalla.
    expect([...CAMPOS_PII_LISTADO]).toEqual([
      'name', 'document', 'phone', 'email', 'address', 'city',
      'country_code', 'state_code', 'city_code', 'commercial_name',
      'contact_first_name', 'contact_last_name', 'contact_email',
      'phone_indicative', 'phone_number',
    ]);

    // Los códigos de catálogo NO son datos personales: clasifican a un tercero, no identifican ni
    // ubican a nadie. Es el criterio que este módulo ya fija en `CAMPOS_FISCALES_TRAZABLES`.
    for (const codigo of ['id', 'document_type', 'person_type', 'id_type', 'branch_office']) {
      expect(CAMPOS_PII_LISTADO).not.toContain(codigo);
    }
  });
});

describe('lo que NO se registra', () => {
  it('sin token (401) no hay lectura ni rastro', async () => {
    const app = await buildApp();

    const r = await request(app).get('/api/clients');

    expect(r.status).toBe(401);
    expect(logPiiAccessMock).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('un rol sin lectura (403) no llega a mirar el padrón', async () => {
    const app = await buildApp();

    const r = await request(app).get('/api/clients').set('Authorization', await auth('conductor'));

    expect(r.status).toBe(403);
    expect(logPiiAccessMock).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
  });
});
