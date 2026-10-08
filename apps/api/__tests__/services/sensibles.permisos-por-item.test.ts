// HU #13423 (ADR-0023) — LAFT, Privacidad, Firma, Drive, SOAT antiguo y Siigo piden permiso, no rol; y
// las cuatro operaciones que solo exigían sesión piden su permiso. Comportamiento HTTP de las guardas
// contra el motor real (`exigirFuncion`/`tieneFuncion` → `resolverPermisos`), con la lectura de filas
// sustituida por el double de `helpers/auth.ts`. Mismo esquema que operacion.permisos-por-item.test.ts.
//
//   · AC1: un rol LLAMADO como uno que pasaba el `requireRole` de hoy, sin la función → 403 con
//     `funcion`; con ella (y cualquier nombre de rol) → pasa la guarda.
//   · AC2: las acciones de Siigo deciden por su función `siigo.factura.<accion>`, no por el rol.
//   · AC3: /api/vehicles, consulta-persona, ocr-cedula y fasecolda → 403 sin su función.
//   · AC4: el 403 sale ANTES de leer el cuerpo: ni el documento ni la cédula llegan a la bitácora de
//     intentos denegados ni al log.
//   · AC5: con el ítem habilitado y sin «Administrar <ítem>», la escritura → 403.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { SignJWT } from 'jose';
import { chain } from '../helpers/db.js';
import { registrarUsuarioDePrueba } from '../helpers/auth.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const deleteMock = vi.fn();
const executeMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock, delete: deleteMock, execute: executeMock, transaction: transactionMock },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('express-rate-limit', () => ({ default: () => (_req: any, _res: any, next: any) => next() }));
const consultarPersonaRuntMock = vi.fn();
vi.mock('../../src/modules/runt/runt.service.js', () => ({
  consultarVehiculoRunt: vi.fn(), consultarPersonaRunt: (...a: unknown[]) => consultarPersonaRuntMock(...a),
}));
const registrarOperacionMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/siigo/siigo.operaciones.repo.js', () => ({
  registrarOperacion: (...args: unknown[]) => registrarOperacionMock(...args),
}));

const CEDULA = '1036640908';

let app: any;
let escrito: string[];
let espias: { mockRestore: () => void }[];
beforeEach(async () => {
  selectMock.mockReset(); insertMock.mockReset(); updateMock.mockReset();
  deleteMock.mockReset(); executeMock.mockReset(); transactionMock.mockReset();
  consultarPersonaRuntMock.mockReset(); registrarOperacionMock.mockClear();
  executeMock.mockResolvedValue([]);
  selectMock.mockImplementation(() => chain([]));
  insertMock.mockImplementation(() => ({ values: () => ({ returning: async () => [], onConflictDoNothing: async () => [], then: (r: any) => r([]) }) }));
  escrito = [];
  const capturar = (chunk: unknown) => { escrito.push(String(chunk)); return true; };
  espias = [
    vi.spyOn(process.stdout, 'write').mockImplementation(capturar as never),
    vi.spyOn(console, 'log').mockImplementation(capturar as never),
    vi.spyOn(console, 'warn').mockImplementation(capturar as never),
    vi.spyOn(console, 'error').mockImplementation(capturar as never),
  ];
  const { createApp } = await import('../../src/app.js');
  app = createApp();
});
afterEach(() => { for (const e of espias) e.mockRestore(); });

/** Un usuario con EXACTAMENTE estas funciones en su rol (nombre de rol a elección). */
async function usuario(sub: number, rol: string, funciones: string[]): Promise<string> {
  await registrarUsuarioDePrueba(sub, { rol, tipoPrincipal: 'interno', tipoEnlace: 'ninguno', funcionesDelRol: funciones, excepciones: [] });
  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  const jwt = await new SignJWT({ username: `u${sub}`, role: rol })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(String(sub)).setExpirationTime('1h').sign(secret);
  return `Bearer ${jwt}`;
}

/** Todo lo que el 403 pudo dejar escrito: bitácora de intentos (insert), bitácora WORM de Siigo y log. */
function rastro(): string {
  return JSON.stringify([insertMock.mock.calls, registrarOperacionMock.mock.calls]) + escrito.join('');
}

type Caso = [metodo: 'get' | 'post' | 'patch', ruta: string, funcion: string, rolDeHoy: string, cuerpo?: object];

/** Una ruta por directorio (y por guarda distinta donde hay más de una), con el rol que hoy la pasaba. */
const CASOS_AC1: Caso[] = [
  ['get', '/api/laft/counterparties', 'laft.contrapartes.operar', 'compliance'],
  ['get', '/api/laft/unusual', 'laft.inusuales.operar', 'compliance'],
  ['get', '/api/laft/ros', 'laft.ros.operar', 'compliance'],
  ['get', '/api/laft/trainings', 'laft.capacitaciones.operar', 'compliance'],
  ['get', '/api/laft/employees', 'laft.empleados.operar', 'compliance'],
  ['get', '/api/laft/cash', 'laft.efectivo.operar', 'compliance'],
  ['get', '/api/laft/sync/jobs', 'laft.sincronizacion.ver', 'compliance'],
  ['get', '/api/privacy/pii-access-log', 'privacy.accesos_pii.ver', 'compliance'],
  ['get', '/api/tramites/1/firma', 'firma.estado.ver', 'transito'],
  ['get', '/api/drive/search?q=ab', 'drive.archivos.administrar', 'admin'],
  ['get', '/api/soat', 'soat.antiguo.operar', 'proveedor'],
  ['get', '/api/soat/stats', 'soat.antiguo.administrar', 'admin'],
  ['get', '/api/siigo/compuerta', 'siigo.parametrizacion.ver', 'auditor'],
  ['get', '/api/siigo/credenciales', 'siigo.parametrizacion.administrar', 'admin'],
  ['get', '/api/siigo/parametrizacion/catalogos', 'siigo.emision.ver', 'financiera'],
  ['get', '/api/siigo/linea-tiempo/00000000-0000-4000-8000-000000000001', 'siigo.factura.consultar', 'auditor'],
];

describe('AC1 — los seis directorios piden su permiso, no el nombre del rol', () => {
  let sub = 9400;
  for (const [metodo, ruta, funcion, rolDeHoy] of CASOS_AC1) {
    it(`${metodo.toUpperCase()} ${ruta}: «${rolDeHoy}» sin \`${funcion}\` → 403; con ella → pasa la guarda`, async () => {
      const sin = await usuario(++sub, rolDeHoy, []);
      const r = await (request(app) as any)[metodo](ruta).set('Authorization', sin);
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ funcion });

      const con = await usuario(++sub, 'rol_cualquiera', [funcion]);
      const ok = await (request(app) as any)[metodo](ruta).set('Authorization', con);
      expect(ok.status, JSON.stringify(ok.body)).not.toBe(403);
      expect(ok.body?.funcion).toBeUndefined();
    });
  }
});

describe('AC2 — las acciones de Siigo deciden por `siigo.factura.<accion>`', () => {
  it('`financiera` sin `siigo.factura.consultar` → 403 de la acción (y su fila en la bitácora WORM); con ella, otro rol pasa', async () => {
    const sin = await usuario(9450, 'financiera', ['siigo.parametrizacion.ver']);
    const r = await request(app).get('/api/siigo/facturacion').set('Authorization', sin);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ accion: 'consultar' });
    expect(registrarOperacionMock).toHaveBeenCalledWith(expect.objectContaining({ operacion: 'permiso_denegado', entidadId: 'consultar' }));

    const con = await usuario(9451, 'rol_cualquiera', ['siigo.factura.consultar']);
    const ok = await request(app).get('/api/siigo/facturacion').set('Authorization', con);
    expect(ok.status).not.toBe(403);
  });
});

describe('AC3 — las cuatro operaciones que solo exigían sesión piden su permiso', () => {
  const CASOS: Caso[] = [
    ['get', '/api/vehicles', 'vehicles.vehiculos.consultar', 'gestor_impuestos'],
    ['get', '/api/vehicles/9BWZZZ377VT004251/historial', 'vehicles.vehiculos.consultar', 'gestor_impuestos'],
    ['post', '/api/runt/consulta-persona', 'runt.persona.consultar', 'gestor_impuestos', {}],
    ['post', '/api/runt/ocr-cedula', 'runt.cedula.leer', 'gestor_impuestos', {}],
    ['get', '/api/fasecolda/buscar', 'integraciones.fasecolda.buscar', 'gestor_impuestos'],
  ];
  let sub = 9460;
  for (const [metodo, ruta, funcion, rol, cuerpo] of CASOS) {
    it(`${metodo.toUpperCase()} ${ruta}: con sesión y sin \`${funcion}\` → 403; con ella → responde como hoy (sin cuerpo válido, 400/200)`, async () => {
      const sin = await usuario(++sub, rol, []);
      let q = (request(app) as any)[metodo](ruta).set('Authorization', sin);
      if (cuerpo) q = q.send(cuerpo);
      const r = await q;
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ funcion });

      const con = await usuario(++sub, rol, [funcion]);
      let q2 = (request(app) as any)[metodo](ruta).set('Authorization', con);
      if (cuerpo) q2 = q2.send(cuerpo);
      const ok = await q2;
      expect([200, 400, 404], JSON.stringify(ok.body)).toContain(ok.status);
    });
  }
});

describe('AC4 — un 403 no deja la cédula ni el documento en la bitácora ni en el log', () => {
  it('consulta-persona: 403 antes de leer el cuerpo; el RUNT no se consulta y el documento no aparece en ningún rastro', async () => {
    const sin = await usuario(9480, 'auditor', []);
    const r = await request(app).post('/api/runt/consulta-persona').set('Authorization', sin)
      .send({ documento: CEDULA, tipoDocumento: 'CC' });
    expect(r.status).toBe(403);
    expect(consultarPersonaRuntMock).not.toHaveBeenCalled();
    expect(JSON.stringify(r.body)).not.toContain(CEDULA);
    expect(rastro()).not.toContain(CEDULA);
  });

  it('privacy: la previsualización de un titular con la cédula en el PATH → 403 y la cédula no queda en ningún rastro', async () => {
    const sin = await usuario(9481, 'compliance', ['privacy.accesos_pii.ver']);
    const r = await request(app).get(`/api/privacy/preview/${CEDULA}`).set('Authorization', sin);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ funcion: 'privacy.titulares.operar' });
    expect(rastro()).not.toContain(CEDULA);
  });

  it('ocr-cedula: 403 sin leer la imagen (no llega al modelo de pago)', async () => {
    const sin = await usuario(9482, 'mensajero', []);
    const r = await request(app).post('/api/runt/ocr-cedula').set('Authorization', sin)
      .send({ image: `data:image/png;base64,${'A'.repeat(200)}`, lado: 'frontal' });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ funcion: 'runt.cedula.leer' });
  });
});

describe('AC5 — con el ítem habilitado y sin «Administrar <ítem>», la escritura → 403', () => {
  const CASOS: [metodo: 'post' | 'patch', ruta: string, administrar: string, tiene: string | string[], cuerpo: object][] = [
    ['post', '/api/laft/lists/OFAC/sync', 'laft.listas.administrar', 'laft.listas.operar', {}],
    ['post', '/api/laft/sync/run/OFAC', 'laft.sincronizacion.administrar', 'laft.sincronizacion.ver', {}],
    ['post', '/api/privacy/forget', 'privacy.olvido.administrar', 'privacy.titulares.operar', { docNumber: CEDULA }],
    // El manual conserva su página a nivel de router (`pagina.laft_manual`): se la damos para llegar a la guarda.
    ['post', '/api/laft/manual', 'laft.manual.administrar', ['pagina.laft_manual', 'laft.manual.firmar'], {}],
    ['post', '/api/siigo/freno/reactivar', 'siigo.parametrizacion.administrar', 'siigo.parametrizacion.ver', {}],
    ['patch', '/api/soat/1/verify', 'soat.antiguo.administrar', 'soat.antiguo.operar', {}],
    ['post', '/api/tramites/1/firma/solicitar', 'firma.solicitud.administrar', 'firma.estado.ver', { rol: 'comprador' }],
  ];
  let sub = 9490;
  for (const [metodo, ruta, administrar, tiene, cuerpo] of CASOS) {
    it(`${metodo.toUpperCase()} ${ruta}: con \`${tiene}\` y sin \`${administrar}\` → 403`, async () => {
      const auth = await usuario(++sub, 'admin', ([] as string[]).concat(tiene));
      const r = await (request(app) as any)[metodo](ruta).set('Authorization', auth).send(cuerpo);
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ funcion: administrar });
      expect(rastro()).not.toContain(CEDULA);
    });
  }
});
