// HU #11916 (Feature #11912), AC2 y AC3 — el Cliente descarga la PÓLIZA cuando su solicitud está
// `pagado`, y ni antes, ni ningún otro documento, ni por otra vía que el OCR.
//
// ── Lo que hay que saber para leer estas pruebas ─────────────────────────────────────────────────
//
// En este sistema NO existe un `TipoSoporte.POLIZA`: el documento que el gestor sube por
// `POST /:id/factura` es `factura_soat`, el prompt del OCR lo llama «PÓLIZA/FACTURA DE SOAT» y la
// propia HU lo nombra «la factura-póliza». Abrirle ESE tipo al cliente es el AC2; lo que sigue
// cerrado es el comprobante del pago PSE (`ROLES_COMPROBANTE_PSE` no gana `cliente`).
//
// Los mutantes que estas pruebas atrapan, nombrados:
//   · `TIPOS_SOPORTE_VISIBLES_CLIENTE` abierta a un tipo interno   → «ni un tipo interno…»
//   · la descarga permitida antes de `pagado` (quitar `soloEn`)     → los cuatro estados de A2
//   · el recorte por tipo aplicado solo en la ruta y no al armado   → A1 (se prueba el servicio)
//   · una segunda vía a `pagado` (carga manual de PDF y valor)      → C
//
// El doble de drizzle no filtra por `where`: devuelve lo que el test registró para esa tabla. Por eso
// aquí se le dan SIEMPRE los cuatro soportes —los dos del cliente y los dos internos— y lo que se
// afirma es lo que la función DEJA PASAR. Un test que solo cargara la póliza pasaría igual con el
// recorte borrado.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import express from 'express';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { ligadosA, renderizar } from '../helpers/sql-ligado.js';
import { testToken, type TestRole } from '../helpers/auth.js';

const kdb = createKeyedDb();

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const SOAT_ID = '50a70000-0000-4000-8000-00000000aa01';
const COMPANIA = 7;
const AHORA = new Date('2026-08-25T12:00:00Z');

const soporte = (id: string, tipo: string, nombre: string) => ({
  id, tipo, nombreArchivo: nombre, storageKey: `flito/${id}`, subidoEn: AHORA,
});

/** Los CUATRO documentos que pueden colgar de un SOAT. El mock no esconde ninguno. */
const TODOS = [
  soporte('sop-poliza', 'factura_soat', 'poliza-soat.pdf'),
  soporte('sop-venta', 'factura_venta', 'factura-venta.pdf'),
  soporte('sop-fe', 'factura_electronica_pdf', 'FV-1.pdf'),
  soporte('sop-pse', 'comprobante_pse', 'pse.pdf'),
];

beforeEach(() => { kdb.reset(); });

// ═════════════════ A · El armado: qué deja pasar `soportesDeSoat` ════════════════════════════════

describe('AC2/AC3 · A — la allowlist del cliente, por tipo Y por estado', () => {
  const pedir = async (rol: string, estadoSoat: string) => {
    kdb.when.select('flito_soportes', TODOS).select('flito_conciliacion_lineas', [TODOS[3]]);
    const { soportesDeSoat } = await import('../../src/shared/soportes/soportes-consulta.js');
    return (await soportesDeSoat(SOAT_ID, { rol, estadoSoat })).map((s) => s.tipo).sort();
  };

  it('cliente + `pagado` → la póliza y su propia factura de venta, y NADA más (AC2)', async () => {
    expect(await pedir('cliente', 'pagado')).toEqual(['factura_soat', 'factura_venta']);
  });

  for (const estado of ['pendiente_revision', 'rechazada', 'solicitado', 'con_novedad']) {
    it(`cliente + \`${estado}\` → sin póliza: solo lo que él mismo subió (AC3)`, async () => {
      // La mitad negativa del AC3. La factura de venta SÍ está, y es una decisión declarada de esta
      // HU: es su propio adjunto —la única forma de que un `factura_venta` cuelgue de un `soat_id` es
      // que lo subiera él al radicar o al subsanar— y sin ella la pantalla de corregir un rechazo no
      // puede responder «¿qué factura tengo cargada?».
      expect(await pedir('cliente', estado)).toEqual(['factura_venta']);
    });
  }

  it('ni un tipo INTERNO se le cuela, ni siquiera en `pagado` (el PSE y la factura electrónica)', async () => {
    const tipos = await pedir('cliente', 'pagado');
    expect(tipos).not.toContain('comprobante_pse');
    expect(tipos).not.toContain('factura_electronica_pdf');
  });

  it('la consulta del comprobante PSE ni se EMITE para el cliente', async () => {
    // `ROLES_COMPROBANTE_PSE` es allowlist y no gana `cliente` (ADR-0008 §6). Se mide la consulta y
    // no la respuesta: filtrar después de leer también dejaría la lista limpia, pero habría leído.
    const { getTableName } = await import('drizzle-orm');
    const tablas: string[] = [];
    const selectBase = kdb.select.getMockImplementation() as (...a: unknown[]) => Record<string, unknown>;
    kdb.select.mockImplementation((...args: unknown[]) => {
      const c = selectBase(...args);
      const from = c.from as (t: unknown) => unknown;
      c.from = (tbl: unknown) => {
        try { tablas.push(getTableName(tbl as never)); } catch { /* no es una tabla */ }
        return from(tbl);
      };
      return c;
    });
    kdb.when.select('flito_soportes', TODOS).select('flito_conciliacion_lineas', [TODOS[3]]);

    const { soportesDeSoat } = await import('../../src/shared/soportes/soportes-consulta.js');
    await soportesDeSoat(SOAT_ID, { rol: 'cliente', estadoSoat: 'pagado' });

    expect(tablas).not.toContain('flito_conciliacion_lineas');
  });

  it('los ONCE roles internos no cambian: ven lo de siempre en cualquier estado (no-regresión)', async () => {
    // El recorte vive dentro de un `if (rol === cliente)`. Si alguien lo sacara de ahí, el gestor
    // dejaría de ver su propia factura mientras el SOAT no estuviera pagado —que es justo cuando la
    // sube—, y ninguna prueba del canal Cliente lo notaría.
    //
    // El `comprobante_pse` sale DOS veces para quien tiene derecho a los dos bloques, y es el
    // fixture diciendo la verdad: se le ha colgado uno del propio SOAT (`flito_soportes.soat_id`, el
    // caso que al cliente hay que negarle) y otro de la boleta conciliada (el bloque de la #11678).
    const INTERNO_CON_PSE = [
      'comprobante_pse', 'comprobante_pse', 'factura_electronica_pdf', 'factura_soat', 'factura_venta',
    ];
    expect(await pedir('admin', 'solicitado')).toEqual(INTERNO_CON_PSE);
    expect(await pedir('proveedor', 'solicitado')).toEqual(INTERNO_CON_PSE);
    // Auditoría no recibe el bloque de conciliación desde la #11678, pero sí todo lo del registro.
    expect(await pedir('auditor', 'solicitado'))
      .toEqual(['comprobante_pse', 'factura_electronica_pdf', 'factura_soat', 'factura_venta']);
  });

  it('el recorte por tipo viaja al WHERE: no se LEE lo que no se va a devolver', async () => {
    // La otra mitad del criterio que la #11913 dejó escrito para el comprobante PSE. Se mide sobre
    // el SQL renderizado y de forma POSICIONAL: `params` contendría los tipos aunque la condición
    // los comparara contra otra columna.
    const { crearEspia } = await import('../helpers/espia-drizzle.js');
    const espia = crearEspia(kdb);
    kdb.when.select('flito_soportes', TODOS);
    const { soportesDeSoat } = await import('../../src/shared/soportes/soportes-consulta.js');

    await soportesDeSoat(SOAT_ID, { rol: 'cliente', estadoSoat: 'pagado' });
    const pagado = espia.condicionesLeidas().map((c) => renderizar(c as never));
    expect(ligadosA(pagado[0], '"flito_soportes"."tipo"')).toEqual(['factura_soat', 'factura_venta']);

    espia.reiniciar();
    kdb.when.select('flito_soportes', TODOS);
    await soportesDeSoat(SOAT_ID, { rol: 'cliente', estadoSoat: 'rechazada' });
    const rechazada = espia.condicionesLeidas().map((c) => renderizar(c as never));
    expect(ligadosA(rechazada[0], '"flito_soportes"."tipo"')).toEqual(['factura_venta']);

    // Y para un rol interno no hay recorte por tipo en absoluto (`ligadosA` lanza si no lo hay).
    espia.reiniciar();
    kdb.when.select('flito_soportes', TODOS).select('flito_conciliacion_lineas', []);
    await soportesDeSoat(SOAT_ID, { rol: 'admin', estadoSoat: 'rechazada' });
    const admin = espia.condicionesLeidas().map((c) => renderizar(c as never));
    expect(() => ligadosA(admin[0], '"flito_soportes"."tipo"')).toThrow();
  });

  it('la lista es una ALLOWLIST con motivo: cada entrada dice qué tipo, desde qué estado y por qué', async () => {
    const { TIPOS_SOPORTE_VISIBLES_CLIENTE } = await import('../../src/shared/soportes/soportes-consulta.js');
    const { TipoSoporte, EstadoSoat } = await import('@operaciones/shared-types');

    // El mutante directo: añadir aquí un tipo interno. Se enumera lo permitido, no lo prohibido.
    expect(TIPOS_SOPORTE_VISIBLES_CLIENTE.map((s) => s.tipo).sort())
      .toEqual([TipoSoporte.FACTURA_SOAT, TipoSoporte.FACTURA_VENTA].sort());
    // Y la póliza lleva su condición de estado: sin ella el AC3 se cae sin que nada más cambie.
    const poliza = TIPOS_SOPORTE_VISIBLES_CLIENTE.find((s) => s.tipo === TipoSoporte.FACTURA_SOAT);
    expect(poliza?.soloEn).toBe(EstadoSoat.PAGADO);
    for (const s of TIPOS_SOPORTE_VISIBLES_CLIENTE) {
      expect(s.porque.trim().length, s.tipo).toBeGreaterThan(20);
    }
  });
});

// ═════════════════ B · La ruta: el estado que manda es el de la FILA ═════════════════════════════

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat.routes.js');
  app.use('/api/flito/soat', router);
  return app;
}

const auth = async (role: TestRole) =>
  `Bearer ${await testToken({ sub: 42, username: 'compras@acme.io', role })}`;

/** La fila que lee `buscarConAcceso`: el SOAT entero más la frontera ya evaluada. */
const conAcceso = (estado: string) => ({
  soat: {
    id: SOAT_ID, estado, origen: 'cliente', companiaId: COMPANIA,
    proveedorSoatId: null, gestionOperaciones: false, extraccion: null,
    pagadoEn: estado === 'pagado' ? AHORA : null,
  },
  dentroDeFrontera: true,
});

/** La fila plana de la proyección del detalle (segunda consulta a `flito_soat`). */
const filaDetalle = (estado: string) => ({
  id: SOAT_ID, vin: 'VIN0000000000AA01', estado, origen: 'cliente', proveedorSoatId: null,
  gestionOperaciones: false, enviadoEn: null, pagadoEn: estado === 'pagado' ? AHORA : null,
  valorPagado: estado === 'pagado' ? '740800.00' : null, motivoRechazo: null, createdAt: AHORA,
  placa: 'ABC123', marca: 'RENAULT', linea: 'LOGAN', cilindraje: '1600', carroceria: 'SEDAN',
  tipoServicio: 'PARTICULAR', companiaNombre: 'ACME S.A.S.', organismoNombre: 'Chía',
  proveedorSoatNombre: null, proveedorSlaHoras: null, enviadoPorNombre: null,
});

/** El cliente de la compañía 7 abre SU solicitud, que está en este estado. */
function escenarioCliente(estado: string): void {
  kdb.when
    .select('users', [{ c: COMPANIA }])
    .selectOnce('flito_soat', [conAcceso(estado)])
    .selectOnce('flito_soat', [filaDetalle(estado)])
    .select('flito_tramites', [])
    .select('flito_compradores', [])
    .select('flito_soat_solicitud', [{
      solicitadoEn: AHORA, revisadoPorNombre: null, revisadoEn: null,
      causalNombre: null, observacion: null, reenvios: 0,
    }])
    .select('flito_soportes', TODOS)
    .select('flito_conciliacion_lineas', [TODOS[3]]);
}

describe('AC2 · B — `GET /:id/soportes` con el token del cliente', () => {
  it('solicitud PAGADA → la póliza sale, con su enlace firmado (el PDF se pinta en la SPA)', async () => {
    escenarioCliente('pagado');

    const r = await request(await buildApp()).get(`/api/flito/soat/${SOAT_ID}/soportes`)
      .set('Authorization', await auth('cliente'));

    expect(r.status).toBe(200);
    const poliza = (r.body as Array<{ tipo: string; url: string; origen: string }>)
      .find((s) => s.tipo === 'factura_soat');
    expect(poliza).toBeDefined();
    // El storage no se expone: la URL es el enlace firmado con caducidad que ya usan las otras tres
    // pantallas. Por eso el AC2 no necesita ninguna ruta de descarga nueva.
    expect(poliza!.url).toMatch(/^\/api\/files\?key=.*&exp=\d+&sig=[a-f0-9]{64}$/);
    expect(poliza!.origen).toBe('soat');
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('solicitud EN REVISIÓN → 200 sin la póliza: pedirla antes de `pagado` no la entrega (AC3)', async () => {
    escenarioCliente('pendiente_revision');

    const r = await request(await buildApp()).get(`/api/flito/soat/${SOAT_ID}/soportes`)
      .set('Authorization', await auth('cliente'));

    expect(r.status).toBe(200);
    const tipos = (r.body as Array<{ tipo: string }>).map((s) => s.tipo);
    expect(tipos).not.toContain('factura_soat');
    expect(tipos).not.toContain('comprobante_pse');
    // Y no es que la respuesta venga vacía por accidente: su factura de venta sigue ahí.
    expect(tipos).toContain('factura_venta');
  });

  it('el estado sale de la FILA, no de nada que el cliente pueda mandar', async () => {
    // El intento obvio de saltarse el AC3: colgar el estado de la query. La ruta no lee ningún
    // parámetro para esto —el estado viene del detalle que acaba de autorizar el acceso—, así que
    // pedirlo con `?estado=pagado` da exactamente lo mismo que sin él.
    escenarioCliente('rechazada');

    const r = await request(await buildApp())
      .get(`/api/flito/soat/${SOAT_ID}/soportes?estado=pagado&estadoSoat=pagado`)
      .set('Authorization', await auth('cliente'));

    expect(r.status).toBe(200);
    expect((r.body as Array<{ tipo: string }>).map((s) => s.tipo)).toEqual(['factura_venta']);
  });

  it('la descarga NO necesitó ninguna entrada nueva en la allowlist del canal', async () => {
    // `GET /api/flito/soat/:id/soportes` ya estaba inscrita desde la #11913 y el archivo baja por
    // `GET /api/files?…`, que es público y va firmado: no pasa por `authMiddleware` y por tanto
    // tampoco por este guarda. Lo que se afirma aquí es que abrir la póliza no se convierta en la
    // excusa para inscribir una ruta más «de paso».
    const { RUTAS_PERMITIDAS_CLIENTE, rutaPermitidaParaCliente } =
      await import('../../src/shared/middleware/canal-cliente.js');

    expect(rutaPermitidaParaCliente('GET', `/api/flito/soat/${SOAT_ID}/soportes`)).toBe(true);
    expect(rutaPermitidaParaCliente('GET', '/api/files')).toBe(false);

    // Por CONTENIDO y no por conteo. Hasta la #12092 esto era un `toHaveLength(10)`, y el conteo
    // solo no bastaba: cuando esa HU inscribió la 11.ª entrada el aserto se pudo «arreglar»
    // cambiando el 10 por un 11, y a partir de ahí el centinela habría dejado pasar CUALQUIER ruta
    // futura mientras el número cuadrara —justo lo que existe para impedir—. Enumerado el conjunto
    // exacto, inscribir una ruta nueva, o cambiarle el método o el patrón a una ya inscrita, pone
    // rojo este test NOMBRANDO la intrusa, y abrirle algo al rol `cliente` obliga a escribirlo aquí.
    //
    // Esta lista es además el sitio donde se lee, fuera del middleware, QUÉ puede alcanzar el rol
    // externo: seis lecturas (GET) y cinco escrituras (cuatro POST y un PATCH). Las diez primeras
    // las fijó la #11915. La 11.ª
    // —`POST …/cliente/factura/lectura`, de la #12092— es la primera ruta de ESCRITURA del canal
    // que NO PERSISTE NADA: lee el PDF adjunto, devuelve el comprador y el buffer muere con la
    // petición (ni objeto en storage, ni soporte, ni fila). Entra igual por `requireRole('cliente')`
    // y el rate limit del canal, y por eso está en la lista pese a no escribir en FLITO.
    //
    // El orden es el de declaración del middleware —lecturas, luego escrituras por HU—: se afirma
    // tal cual para que el diff del rojo señale el sitio exacto de la lista.
    expect(RUTAS_PERMITIDAS_CLIENTE.map((r) => `${r.metodo} ${r.patron}`)).toEqual([
      'GET /api/auth/me',
      'POST /api/auth/logout',
      'GET /api/flito/soat',
      'GET /api/flito/soat/facetas',
      'GET /api/flito/soat/:id',
      'GET /api/flito/soat/:id/historial',
      'GET /api/flito/soat/:id/soportes',
      'POST /api/flito/soat/cliente/preconsulta',
      'POST /api/flito/soat/cliente',
      'PATCH /api/flito/soat/:id/solicitud',
      'POST /api/flito/soat/cliente/factura/lectura',
    ]);
  });
});

// ═════════════════ C · AC3: sin OCR no hay `pagado` ══════════════════════════════════════════════

const fuente = (rel: string) => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8');

describe('AC3 · C — `POST /:id/factura` (OCR) sigue siendo la única puerta a `pagado`', () => {
  it('un solo punto del código escribe `estado: pagado`, y es el del OCR', async () => {
    // La forma honesta de afirmar «no hay otra vía»: contar los escritores. `pagarEnTx` es el único,
    // y ya revalida que exista una factura viva antes de mover el estado (CA-11).
    //
    // La EXCEPCIÓN declarada, para que esta prueba no mienta: `reversar()` (RN-06) puede llevar un
    // SOAT a `pagado` a mano. Es de `admin`, exige motivo, queda en el historial, es anterior a este
    // Feature y no acepta ni PDF ni valor —`valor_pagado` no se escribe— así que no es «la carga
    // manual de PDF y valor» que el AC3 prohíbe. Escribe `estado: estadoDestino`, no el literal, y
    // por eso no aparece en esta cuenta.
    const servicio = fuente('modules/flito-soat/flito-soat.service.ts');
    expect(servicio.match(/estado:\s*EstadoSoat\.PAGADO/g)).toHaveLength(1);

    // Y ningún otro módulo del API lo escribe por su cuenta.
    for (const rel of [
      'modules/flito-soat/flito-soat-cliente.service.ts',
      'modules/flito-soat/flito-soat-cliente.routes.ts',
      'modules/flito-soat/flito-soat.routes.ts',
      'modules/flito-revisiones/flito-revisiones.service.ts',
    ]) {
      expect(fuente(rel), rel).not.toMatch(/estado:\s*EstadoSoat\.PAGADO/);
    }
  });

  it('el canal Cliente no expone ninguna ruta que pague: sus cuatro escrituras son otras', async () => {
    // El `\s*` tras el paréntesis NO es cosmético: la #12092 declara su ruta partiendo la llamada en
    // varias líneas (`router.post(\n  '/cliente/factura/lectura',`) y el patrón anterior —anclado a
    // `router.post('`— no la veía. El centinela seguía verde CONTANDO SEIS mientras el fichero
    // declaraba siete: una ruta nueva escrita así habría entrado sin ponerlo rojo, que es el mutante
    // que este test debe matar. Se enumeran todas y se comprueba que ninguna paga.
    const rutas = fuente('modules/flito-soat/flito-soat-cliente.routes.ts');
    const declaradas = [...rutas.matchAll(/^router\.(get|post|patch|put|delete)\(\s*'([^']+)'/gm)]
      .map((m) => `${m[1].toUpperCase()} ${m[2]}`);
    expect(declaradas.sort()).toEqual([
      'GET /causales-rechazo',
      'PATCH /:id/solicitud',
      'POST /:id/rechazar-solicitud',
      'POST /:id/validar',
      'POST /cliente',
      // La cuarta escritura del canal (#12092). Es de escritura por el verbo y el adjunto, no por
      // efecto: lee el PDF y responde; no toca storage, ni `flito_soportes`, ni ninguna fila.
      'POST /cliente/factura/lectura',
      'POST /cliente/preconsulta',
    ]);
  });

  it('el cliente pidiendo `POST /:id/factura` → 403, dos veces (rol y allowlist)', async () => {
    const { rutaPermitidaParaCliente } = await import('../../src/shared/middleware/canal-cliente.js');
    expect(rutaPermitidaParaCliente('POST', `/api/flito/soat/${SOAT_ID}/factura`)).toBe(false);
    expect(rutaPermitidaParaCliente('POST', '/api/flito/soat/facturas')).toBe(false);

    const r = await request(await buildApp()).post(`/api/flito/soat/${SOAT_ID}/factura`)
      .set('Authorization', await auth('cliente'));
    expect(r.status).toBe(403);
  });

  it('las tres transiciones del canal dan el MISMO 409 de carrera perdida (deuda de la #11915)', async () => {
    // `carreraPerdida()` promete en su docblock «un solo sitio para que las tres digan lo mismo», y
    // hasta esta HU era falso en la letra: `validarSolicitud` repetía el literal. Se compara el
    // TEXTO que queda en el módulo: una segunda copia del mensaje vuelve a romper la promesa.
    const canal = fuente('modules/flito-soat/flito-soat-cliente.service.ts');
    const frase = 'Otra persona acaba de mover esta solicitud.';
    expect(canal.split(frase)).toHaveLength(2); // una sola aparición: la del helper
    expect(canal.match(/throw carreraPerdida\(\)/g)).toHaveLength(3);
  });
});
