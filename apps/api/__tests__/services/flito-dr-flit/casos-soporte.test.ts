// HU #13804 (Feature #13695) — Dr. Flit: radicar el caso como Bug en FLIT - SOPORTE. AC1–AC6, AC8–AC10.
// AC7 (tabla sin texto del caso, consultas reales, purga) vive en `__tests__/db/migracion-0246.test.ts`
// y `purga.test.ts`; el cliente ADO real (fetch) en `ado-cliente.test.ts`; el mapeo en `ado-mapeo.test.ts`.
//
// App mínima con el router REAL, `authMiddleware` REAL (con las `RUTAS_TRANSVERSALES` reales),
// `rechazarEnlaceCompania` + `exigirPaginaConAyuda` reales (permiso por página con ficha de Ayuda, no
// por rol) y `drflitCasosLimiter` REAL (store en memoria: Redis mockeado a null). Dobles:
// `resolverPermisos` (enlace y funciones por `sub`), los repositorios (almacén en memoria con las mismas claves únicas que 0245/0246),
// `logPiiAccess`, el logger (captura) y el cliente ADO (inyectado con `fijarClienteSoporteAdoParaTests`).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { SignJWT } from 'jose';
import type { PermisosResueltos } from '../../../src/shared/permisos-efectivos.js';
import type { ConfigDrFlit } from '../../../src/modules/flito-dr-flit/dr-flit.config.js';
import type { ClienteSoporteAdo, BugSoporteAdo } from '../../../src/modules/flito-dr-flit/dr-flit-ado.client.js';

const resolverMock = vi.fn<(userId: number) => Promise<PermisosResueltos>>();
const piiMock = vi.fn();
const lineasLog: string[] = [];
const CFG: ConfigDrFlit = { NODE_ENV: 'production', DRFLIT_ADO_MODO: 'simulado', DEPLOY_ENVIRONMENT: 'QA' };

vi.mock('../../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../../src/shared/permisos-efectivos.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/shared/permisos-efectivos.js')>()),
  resolverPermisos: (id: number) => resolverMock(id),
}));
vi.mock('../../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../src/shared/pii-audit.js', () => ({ logPiiAccess: (...a: unknown[]) => piiMock(...a) }));
vi.mock('../../../src/shared/logger.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/shared/logger.js')>();
  const captura = (nivel: string) => (...a: unknown[]) => { lineasLog.push(`${nivel} ${JSON.stringify(a)}`); };
  const falso = (): Record<string, unknown> => ({
    info: captura('info'), warn: captura('warn'), error: captura('error'), debug: captura('debug'),
    trace: captura('trace'), fatal: captura('fatal'), child: () => falso(),
  });
  return { ...real, loggerFor: () => falso() };
});
vi.mock('../../../src/modules/flito-dr-flit/dr-flit.config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/modules/flito-dr-flit/dr-flit.config.js')>();
  return {
    ...real,
    ambienteDespliegue: () => real.ambienteDespliegue(CFG),
    soporteDisponible: () => real.soporteDisponible(CFG),
  };
});

const { default: drFlitRoutes } = await import('../../../src/modules/flito-dr-flit/dr-flit.routes.js');
const { repoAutorizaciones } = await import('../../../src/modules/flito-dr-flit/dr-flit.service.js');
const { repoCasos } = await import('../../../src/modules/flito-dr-flit/dr-flit-casos.service.js');
const {
  fijarClienteSoporteAdoParaTests, AdoNoDisponibleError, AdoRechazoError, ClienteSoporteAdoSimulado, PRIMER_NUMERO_SIMULADO,
} = await import('../../../src/modules/flito-dr-flit/dr-flit-ado.client.js');
const { drflitCasosLimiter } = await import('../../../src/shared/middleware/rateLimiter.js');
const { AUTORIZACIONES_DRFLIT } = await import('@operaciones/shared-types');

const RUTA = '/api/flito/dr-flit/casos-soporte';
const VIGENTE = AUTORIZACIONES_DRFLIT.soporte.version;
const PAT_FALSO = 'pat-secreto-que-no-debe-salir';

type Enlace = 'ninguno' | 'compania' | 'proveedor' | 'organismos_transito' | null;
const ok = (userId: number, rol: string, tipoEnlace: Enlace, funciones: string[]): PermisosResueltos => ({
  ok: true, userId, rol, tipoEnlace, funciones: new Set(funciones), version: `v${userId}`, resueltoEn: new Date(),
});
/** Por `sub`: [rol del token, enlace resuelto en base, funciones efectivas]. */
const USUARIOS: Record<number, [string, Enlace, string[]]> = {
  10: ['financiera', 'ninguno', ['pagina.finanzas_gastos_diarios']],
  11: ['proveedor', 'proveedor', ['pagina.flito_soat']],                       // Corredor SOAT
  12: ['gestor_impuestos', 'organismos_transito', ['pagina.flito_impuestos']], // Corredor Impuestos
  13: ['cliente', 'compania', ['pagina.flito_soat']],                          // tiene página con ficha: lo saca el enlace
  16: ['admin', 'ninguno', ['pagina.flito_tablero']],                          // sin autorización aceptada
  17: ['admin', 'ninguno', ['pagina.flito_ayuda', 'pagina.admin_rendimiento']], // ninguna página con ficha (HU #13774: `users` ya tiene ficha)
};
const secret = () => new TextEncoder().encode(process.env.JWT_SECRET);
const token = (sub: number) => new SignJWT({ username: 'u', role: USUARIOS[sub]![0] })
  .setProtectedHeader({ alg: 'HS256' }).setSubject(String(sub)).setIssuedAt().setExpirationTime('1h').sign(secret());

function app(): Express {
  const a = express();
  a.use(express.json());
  a.use('/api/flito/dr-flit', drFlitRoutes);
  return a;
}

let claveN = 0;
const nuevaClave = () => `00000000-0000-4000-8000-${String(++claveN).padStart(12, '0')}`;
const caso = (extra: Record<string, unknown> = {}) => ({
  claveIdempotencia: nuevaClave(),
  contacto: { nombre: 'Ana <b>Pérez</b>', correo: 'ana.perez@ejemplo.com', telefono: '+57 300 123 4567' },
  area: 'corredor_soat',
  titulo: 'No carga la póliza',
  detalle: 'Al abrir la póliza\nsale un error en blanco & no avanza.',
  resultadoEsperado: 'Ver la póliza completa',
  frecuencia: 'siempre',
  prioridad: 'alta',
  ...extra,
});
const post = async (sub: number | null, body: unknown) => {
  const r = request(app()).post(RUTA);
  return (sub === null ? r : r.set('Authorization', `Bearer ${await token(sub)}`)).send(body as object);
};

/** Almacén de intentos en memoria con la clave única (usuario, clave) de la 0246. */
interface Intento {
  id: number; usuarioId: number; autorizacionId: number; clave: string;
  estado: 'pendiente' | 'creado' | 'fallido'; numeroAdo: number | null; errorCodigo: string | null;
  reintentos: number; vencido: boolean; ambiente: string;
}
let intentos: Intento[] = [];
const AUTORIZADOS = new Set([10, 11, 12]);

let llamadas: BugSoporteAdo[] = [];
let siguiente = 13_900;
let comportamiento: () => Promise<{ numero: number; tagOmitido: boolean }>;
/** HU #13805: subidas de adjuntos vistas por el cliente (nombre genérico, tipo, bytes). */
let subidas: Array<{ nombre: string; tipo: string; bytes: number }> = [];
let subir: (n: number) => Promise<{ url: string }>;
const clienteFalso: ClienteSoporteAdo = {
  modo: 'real',
  async crearBug(b) { llamadas.push(b); return comportamiento(); },
  async subirAdjunto(nombre, tipo, contenido) {
    subidas.push({ nombre, tipo, bytes: contenido.length });
    return subir(subidas.length);
  },
};
const op = (b: BugSoporteAdo, path: string) => b.operaciones.find((o) => o.path === path)?.value;

beforeEach(() => {
  intentos = [];
  llamadas = [];
  lineasLog.length = 0;
  vi.restoreAllMocks();
  for (const id of Object.keys(USUARIOS)) drflitCasosLimiter.resetKey(`drflit-casos:-${id}`);
  piiMock.mockReset().mockResolvedValue(undefined);
  Object.assign(CFG, { NODE_ENV: 'production', DRFLIT_ADO_MODO: 'simulado', DEPLOY_ENVIRONMENT: 'QA' });
  comportamiento = async () => ({ numero: siguiente++, tagOmitido: false });
  subidas = [];
  subir = async (n) => ({ url: `https://dev.azure.com/flitsas/_apis/wit/attachments/a-${n}` });
  fijarClienteSoporteAdoParaTests(clienteFalso);
  resolverMock.mockReset().mockImplementation(async (id) => {
    const u = USUARIOS[id];
    return u ? ok(id, u[0], u[1], u[2]) : { ok: false, userId: id, motivo: 'sin_usuario' };
  });
  vi.spyOn(repoAutorizaciones, 'buscar').mockImplementation(async (usuarioId, finalidad, version) =>
    (AUTORIZADOS.has(usuarioId) && finalidad === 'soporte' && version === VIGENTE
      ? { id: 500 + usuarioId, version, aceptadaEn: new Date() } : null));
  const vista = (i: Intento) => ({ id: i.id, estado: i.estado, numeroAdo: i.numeroAdo });
  vi.spyOn(repoCasos, 'insertar').mockImplementation(async (n) => {
    if (intentos.some((i) => i.usuarioId === n.usuarioId && i.clave === n.claveIdempotencia)) return null;
    const i: Intento = {
      id: intentos.length + 1, usuarioId: n.usuarioId, autorizacionId: n.autorizacionId, clave: n.claveIdempotencia,
      estado: 'pendiente', numeroAdo: null, errorCodigo: null, reintentos: 0, vencido: false, ambiente: n.ambiente,
    };
    intentos.push(i);
    return vista(i);
  });
  vi.spyOn(repoCasos, 'buscar').mockImplementation(async (usuarioId, clave) => {
    const i = intentos.find((x) => x.usuarioId === usuarioId && x.clave === clave);
    return i ? vista(i) : null;
  });
  vi.spyOn(repoCasos, 'reclamar').mockImplementation(async (id, usuarioId) => {
    const i = intentos.find((x) => x.id === id && x.usuarioId === usuarioId);
    if (!i || !(i.estado === 'fallido' || (i.estado === 'pendiente' && i.vencido))) return null;
    Object.assign(i, { estado: 'pendiente', reintentos: i.reintentos + 1, errorCodigo: null, vencido: false });
    return vista(i);
  });
  vi.spyOn(repoCasos, 'marcarCreado').mockImplementation(async (id, numero, errorCodigo) => {
    Object.assign(intentos.find((x) => x.id === id)!, { estado: 'creado', numeroAdo: numero, errorCodigo });
  });
  vi.spyOn(repoCasos, 'marcarFallido').mockImplementation(async (id, errorCodigo) => {
    Object.assign(intentos.find((x) => x.id === id)!, { estado: 'fallido', errorCodigo });
  });
});

afterEach(() => fijarClienteSoporteAdoParaTests(null));

describe('AC1 — radicación exitosa', () => {
  it('proveedor autorizado → 201 { numero, repetido:false }, sin URLs; Bug con título, tag y ReproSteps', async () => {
    const r = await post(11, caso());
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ numero: 13_900, repetido: false });
    expect(JSON.stringify(r.body)).not.toMatch(/http|_links|url/i);
    expect(llamadas).toHaveLength(1);
    const b = llamadas[0]!;
    expect(op(b, '/fields/System.Title')).toBe('[ DR. FLIT FLITO ] No carga la póliza');
    expect(op(b, '/fields/System.Tags')).toBe('FLITO; FLITO-PRUEBAS');
    expect(b.operaciones.some((o) => o.path === '/fields/System.AssignedTo')).toBe(false);
    const repro = String(op(b, '/fields/Microsoft.VSTS.TCM.ReproSteps'));
    expect(repro).toContain('Ana &lt;b&gt;Pérez&lt;/b&gt;');
    expect(repro).toContain('ana.perez@ejemplo.com');
    expect(repro).toContain('Al abrir la póliza<br>sale un error en blanco &amp; no avanza.');
    expect(repro).toContain('Ref. FLITO: DRF-1');
    expect(intentos[0]).toMatchObject({ estado: 'creado', numeroAdo: 13_900, autorizacionId: 511, ambiente: 'QA' });
  });

  it.each([10, 12])('rol %i (financiera / Corredor Impuestos) también radica', async (sub) => {
    expect((await post(sub, caso())).status).toBe(201);
  });
});

describe('AC2 — sin autorización no se radica', () => {
  it('403 autorizacion-requerida, sin intento ni llamada a ADO', async () => {
    const r = await post(16, caso());
    expect(r.status).toBe(403);
    expect(r.body.codigo).toBe('autorizacion-requerida');
    expect(llamadas).toHaveLength(0);
    expect(intentos).toHaveLength(0);
    expect(piiMock).not.toHaveBeenCalled();
  });
});

describe('AC3 — validación sin eco del valor', () => {
  it.each([
    ['sin título', { titulo: undefined }, 'titulo'],
    ['título corto', { titulo: 'ab' }, 'titulo'],
    ['correo mal formado', { contacto: { nombre: 'Ana', correo: 'correo-raro<x>@' } }, 'contacto.correo'],
    ['prioridad fuera de Alta/Media/Baja', { prioridad: 'URGENTISIMA<script>' }, 'prioridad'],
    ['área inexistente', { area: 'area-inventada-xyz' }, 'area'],
    ['clave que no es uuid', { claveIdempotencia: 'clave-xyz-123' }, 'claveIdempotencia'],
  ])('%s → 400 campo-invalido con `campo`, sin el valor', async (_n, extra, campo) => {
    const body = caso(extra);
    const r = await post(11, body);
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ codigo: 'campo-invalido', campo });
    const crudo = JSON.stringify(r.body);
    for (const v of ['correo-raro', 'URGENTISIMA', 'area-inventada-xyz', 'clave-xyz-123', 'received']) {
      expect(crudo).not.toContain(v);
    }
    expect(llamadas).toHaveLength(0);
  });

  it('campos no permitidos → 400 sin `campo` y sin eco', async () => {
    const r = await post(11, { ...caso(), severidad: 'dato-extra-raro' });
    expect(r.status).toBe(400);
    expect(r.body.codigo).toBe('campo-invalido');
    expect(JSON.stringify(r.body)).not.toContain('dato-extra-raro');
  });

  it('los 400 no consumen cupo del limitador', async () => {
    for (let i = 0; i < 6; i++) expect((await post(11, caso({ titulo: '' }))).status).toBe(400);
    expect((await post(11, caso())).status).toBe(201);
  });
});

describe('AC4 — mapeo configurado (Bug #13713)', () => {
  it('Alta + Corredor SOAT desde DEV → Priority 1, Custom.Environment DEV, FLITO-PRUEBAS, área en ReproSteps, sin Severity', async () => {
    Object.assign(CFG, { DEPLOY_ENVIRONMENT: 'DEV' });
    expect((await post(11, caso({ prioridad: 'alta', area: 'corredor_soat' }))).status).toBe(201);
    const b = llamadas[0]!;
    expect(op(b, '/fields/Microsoft.VSTS.Common.Priority')).toBe(1);
    expect(op(b, '/fields/Custom.Environment')).toBe('DEV');
    expect(op(b, '/fields/System.Tags')).toBe('FLITO; FLITO-PRUEBAS');
    expect(String(op(b, '/fields/Microsoft.VSTS.TCM.ReproSteps'))).toContain('Corredor SOAT');
    const rutas = b.operaciones.map((o) => o.path);
    for (const prohibida of ['Severity', 'SolutionArea', 'AffectedModule', 'AssignedTo']) {
      expect(rutas.join(' ')).not.toContain(prohibida);
    }
  });

  it('PDN (real con PAT) → solo FLITO y Custom.Environment PDN, aunque NODE_ENV sea production', async () => {
    Object.assign(CFG, {
      DEPLOY_ENVIRONMENT: 'PDN', DRFLIT_ADO_MODO: 'real', DRFLIT_ADO_PAT: PAT_FALSO, DRFLIT_ADO_ORG_URL: 'https://dev.azure.com/x',
    });
    expect((await post(11, caso({ prioridad: 'baja' }))).status).toBe(201);
    const b = llamadas[0]!;
    expect(op(b, '/fields/System.Tags')).toBe('FLITO');
    expect(op(b, '/fields/Custom.Environment')).toBe('PDN');
    expect(op(b, '/fields/Microsoft.VSTS.Common.Priority')).toBe(3);
  });

  it('soporte no disponible (producción sin DEPLOY_ENVIRONMENT) → 503 soporte-no-disponible, sin ADO', async () => {
    Object.assign(CFG, { DEPLOY_ENVIRONMENT: undefined });
    const r = await post(11, caso());
    expect(r.status).toBe(503);
    expect(r.body.codigo).toBe('soporte-no-disponible');
    expect(llamadas).toHaveLength(0);
  });
});

describe('AC5 — ADO no responde o rechaza', () => {
  it.each([
    [new AdoNoDisponibleError('timeout'), 503, 'ado-no-disponible', 'timeout'],
    [new AdoNoDisponibleError('ado-5xx'), 503, 'ado-no-disponible', 'ado-5xx'],
    [new AdoRechazoError('ado-auth'), 502, 'ado-error', 'ado-auth'],
    [new Error(`fallo raro con ${PAT_FALSO} https://dev.azure.com/x`), 502, 'ado-error', 'interno'],
  ])('%s → %i %s reintentable, sin error crudo ni PAT; intento fallido con su clase', async (err, status, codigo, clase) => {
    comportamiento = async () => { throw err; };
    const r = await post(11, caso());
    expect(r.status).toBe(status);
    expect(r.body).toMatchObject({ codigo, reintentable: true });
    const crudo = JSON.stringify(r.body);
    expect(crudo).not.toContain(PAT_FALSO);
    expect(crudo).not.toMatch(/azure\.com|ADO no|fallo raro/);
    expect(intentos[0]).toMatchObject({ estado: 'fallido', errorCodigo: clase });
    expect(Object.keys(intentos[0]!)).not.toContain('titulo');
  });
});

describe('AC6 — reintento sin duplicar', () => {
  it('misma clave ya creada → 200 con el mismo número, sin segunda llamada ni segunda auditoría', async () => {
    const body = caso();
    const r1 = await post(11, body);
    const r2 = await post(11, body);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(200);
    expect(r2.body).toEqual({ numero: r1.body.numero, repetido: true });
    expect(llamadas).toHaveLength(1);
    expect(piiMock).toHaveBeenCalledTimes(1);
  });

  it('fallido → el reintento con la misma clave reclama el MISMO intento (DRF-1) y radica', async () => {
    const body = caso();
    comportamiento = async () => { throw new AdoNoDisponibleError('timeout'); };
    expect((await post(11, body)).status).toBe(503);
    comportamiento = async () => ({ numero: 777, tagOmitido: false });
    const r = await post(11, body);
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ numero: 777, repetido: false });
    expect(intentos).toHaveLength(1);
    expect(intentos[0]).toMatchObject({ estado: 'creado', reintentos: 1 });
    expect(String(op(llamadas[1]!, '/fields/Microsoft.VSTS.TCM.ReproSteps'))).toContain('Ref. FLITO: DRF-1');
  });

  it('pendiente reciente (doble clic) → 409 radicacion-en-curso sin llamar a ADO; vencido → se reclama', async () => {
    const body = caso();
    intentos.push({
      id: 1, usuarioId: 11, autorizacionId: 511, clave: body.claveIdempotencia, estado: 'pendiente',
      numeroAdo: null, errorCodigo: null, reintentos: 0, vencido: false, ambiente: 'QA',
    });
    const r = await post(11, body);
    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('radicacion-en-curso');
    expect(llamadas).toHaveLength(0);
    intentos[0]!.vencido = true;
    expect((await post(11, body)).status).toBe(201);
  });

  it('la misma clave de OTRO usuario no colisiona', async () => {
    const body = caso();
    expect((await post(11, body)).status).toBe(201);
    expect((await post(12, body)).status).toBe(201);
    expect(llamadas).toHaveLength(2);
  });

  it('TF401289 omitido por el cliente → 201 y el intento queda creado con tag-rechazado', async () => {
    comportamiento = async () => ({ numero: 4242, tagOmitido: true });
    expect((await post(11, caso())).status).toBe(201);
    expect(intentos[0]).toMatchObject({ estado: 'creado', errorCodigo: 'tag-rechazado' });
  });
});

describe('AC8 — nada sensible en logs ni en auditoría', () => {
  const VALORES = ['Ana', 'ana.perez@ejemplo.com', '300 123 4567', 'No carga la póliza', 'error en blanco', 'Ver la póliza', PAT_FALSO];

  it.each([
    ['éxito', async () => ({ numero: 1, tagOmitido: false })],
    ['fallo', async () => { throw new AdoNoDisponibleError('red'); }],
  ] as const)('%s: logPiiAccess export con id del intento y solo nombres; logs sin valores', async (_n, comp) => {
    comportamiento = comp as typeof comportamiento;
    await post(11, caso());
    expect(piiMock).toHaveBeenCalledTimes(1);
    const [, opts] = piiMock.mock.calls[0]!;
    expect(opts).toEqual({
      resourceTipo: 'drflit_caso_soporte', resourceId: 1, accion: 'export', motivo: 'radicacion-soporte-ado',
      camposAccedidos: ['contacto.nombre', 'contacto.correo', 'contacto.telefono', 'area', 'titulo', 'detalle',
        'resultadoEsperado', 'frecuencia', 'prioridad'],
    });
    expect(lineasLog.length).toBeGreaterThan(0);
    const todo = lineasLog.join('\n');
    for (const v of VALORES) expect(todo).not.toContain(v);
  });

  it('sin teléfono, `contacto.telefono` no figura en los campos auditados', async () => {
    await post(11, caso({ contacto: { nombre: 'Ana', correo: 'ana@ejemplo.com' } }));
    expect(piiMock.mock.calls[0]![1].camposAccedidos).not.toContain('contacto.telefono');
  });
});

describe('AC9 — seguridad del endpoint', () => {
  it('cliente (enlace compania, aunque tenga página con ficha) → 403; sin token → 401; sin llamar a ADO', async () => {
    expect((await post(13, caso())).status).toBe(403);
    expect((await post(null, caso())).status).toBe(401);
    expect(llamadas).toHaveLength(0);
    expect(intentos).toHaveLength(0);
  });

  it('usuario sin ninguna página con ficha de Ayuda → 403, sin registrar intento ni llamar a ADO', async () => {
    AUTORIZADOS.add(17);
    try {
      const r = await post(17, caso());
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ error: 'Sin permisos' });
      expect(llamadas).toHaveLength(0);
      expect(intentos).toHaveLength(0);
    } finally {
      AUTORIZADOS.delete(17);
    }
  });

  it('la 6.ª radicación en la hora → 429, sin llamar a ADO', async () => {
    for (let i = 0; i < 5; i++) expect((await post(11, caso())).status).toBe(201);
    const r = await post(11, caso());
    expect(r.status).toBe(429);
    expect(llamadas).toHaveLength(5);
    expect((await post(10, caso())).status).toBe(201); // el cupo es por usuario
  });

  it('los fallos de ADO (5xx) SÍ consumen cupo', async () => {
    comportamiento = async () => { throw new AdoNoDisponibleError('ado-5xx'); };
    for (let i = 0; i < 5; i++) expect((await post(11, caso())).status).toBe(503);
    expect((await post(11, caso())).status).toBe(429);
  });
});

describe('AC10 — modo simulado acotado', () => {
  it('en DEV con el simulado devuelve un número de prueba sin red (PDN lo rechaza env.ts: env-dr-flit.test.ts)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      Object.assign(CFG, { DEPLOY_ENVIRONMENT: 'DEV', DRFLIT_ADO_MODO: 'simulado' });
      fijarClienteSoporteAdoParaTests(new ClienteSoporteAdoSimulado('Microsoft.VSTS.TCM.ReproSteps'));
      const r = await post(11, caso());
      expect(r.status).toBe(201);
      expect(r.body.numero).toBeGreaterThanOrEqual(PRIMER_NUMERO_SIMULADO);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ── HU #13805 — adjuntos en el mismo POST multipart (AC1–AC6) ───────────────────────────────────
const relleno = (n: number) => Buffer.alloc(n, 0x20);
// Firma PNG + cabecera del chunk IHDR: `file-type` recorre los chunks, la firma sola no le basta.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]), Buffer.alloc(64),
]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]), relleno(64)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n'), relleno(64)]);
const NO_PNG = Buffer.from('esto es texto plano y no una imagen PNG, aunque se llame .png');
/** Nombres que NO deben aparecer en respuestas, logs ni auditoría (AC4). */
const NOMBRE_PNG = 'pantallazo-cedula-1032456789.png';
const NOMBRE_PDF = 'factura-ana-perez.pdf';

interface Archivo { buf: Buffer; nombre: string; tipo: string; campo?: string }
const png = (nombre = NOMBRE_PNG): Archivo => ({ buf: PNG, nombre, tipo: 'image/png' });
const pdf = (nombre = NOMBRE_PDF): Archivo => ({ buf: PDF, nombre, tipo: 'application/pdf' });

async function postMultipart(sub: number, c: unknown, archivos: Archivo[], extra?: (r: request.Test) => request.Test) {
  let r = request(app()).post(RUTA).set('Authorization', `Bearer ${await token(sub)}`);
  if (c !== undefined) r = r.field('caso', JSON.stringify(c));
  for (const a of archivos) r = r.attach(a.campo ?? 'adjuntos', a.buf, { filename: a.nombre, contentType: a.tipo });
  return extra ? extra(r) : r;
}

/** Nada del nombre del archivo en respuesta, logs ni `logPiiAccess` (AC4). */
function sinNombres(r: { body: unknown }) {
  const visto = `${JSON.stringify(r.body)} ${lineasLog.join(' ')} ${JSON.stringify(piiMock.mock.calls.map((c) => c[1]))}`;
  for (const n of [NOMBRE_PNG, NOMBRE_PDF, 'pantallazo', 'factura-ana', '1032456789']) expect(visto).not.toContain(n);
}

describe('HU #13805 AC1 — adjuntos válidos', () => {
  it('PNG + PDF → 201 solo con el número; subidos con nombre genérico y vinculados al Bug en el mismo json-patch', async () => {
    const insertar = vi.mocked(repoCasos.insertar);
    const r = await postMultipart(11, caso(), [png(), pdf()]);
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ numero: siguiente - 1, repetido: false });
    expect(Object.keys(r.body)).toEqual(['numero', 'repetido']);
    expect(subidas).toEqual([
      { nombre: 'adjunto-1.png', tipo: 'image/png', bytes: PNG.length },
      { nombre: 'adjunto-2.pdf', tipo: 'application/pdf', bytes: PDF.length },
    ]);
    expect(llamadas).toHaveLength(1);
    const rel = llamadas[0]!.operaciones.filter((o) => o.path === '/relations/-');
    expect(rel.map((o) => o.value)).toEqual([
      { rel: 'AttachedFile', url: 'https://dev.azure.com/flitsas/_apis/wit/attachments/a-1' },
      { rel: 'AttachedFile', url: 'https://dev.azure.com/flitsas/_apis/wit/attachments/a-2' },
    ]);
    expect(String(op(llamadas[0]!, '/fields/Microsoft.VSTS.TCM.ReproSteps'))).toContain('Sí (2)');
    expect(insertar.mock.calls[0]![0]).toMatchObject({ adjuntosCantidad: 2 });
    expect(intentos[0]).toMatchObject({ estado: 'creado' });
    sinNombres(r);
  });

  it('JPG declarado como application/octet-stream se acepta por contenido (adjunto-1.jpg); también `adjuntos[]`', async () => {
    const r = await postMultipart(10, caso(), [{ buf: JPG, nombre: 'foto.jpeg', tipo: 'application/octet-stream', campo: 'adjuntos[]' }]);
    expect(r.status).toBe(201);
    expect(subidas).toEqual([{ nombre: 'adjunto-1.jpg', tipo: 'image/jpeg', bytes: JPG.length }]);
  });

  it('modo simulado: urls falsas .invalid en las relaciones', async () => {
    fijarClienteSoporteAdoParaTests(new ClienteSoporteAdoSimulado('Microsoft.VSTS.TCM.ReproSteps'));
    const r = await postMultipart(11, caso(), [png()]);
    expect(r.status).toBe(201);
    expect(r.body.numero).toBe(PRIMER_NUMERO_SIMULADO);
  });
});

describe('HU #13805 AC2 — MIME real por bytes', () => {
  it('.png que no es PNG → 400 adjunto-invalido con su posición y motivo; sin intento ni ADO; sin el nombre', async () => {
    const r = await postMultipart(11, caso(), [pdf(), { buf: NO_PNG, nombre: NOMBRE_PNG, tipo: 'image/png' }]);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({
      error: expect.stringContaining('archivo 2'), codigo: 'adjunto-invalido',
      adjunto: { indice: 1, motivo: 'contenido-no-coincide' },
    });
    expect(intentos).toHaveLength(0);
    expect(subidas).toHaveLength(0);
    expect(llamadas).toHaveLength(0);
    expect(piiMock).not.toHaveBeenCalled();
    sinNombres(r);
  });

  it('un PDF declarado como image/png → 400 contenido-no-coincide (el tipo declarado no coincide)', async () => {
    const r = await postMultipart(11, caso(), [{ buf: PDF, nombre: 'x.png', tipo: 'image/png' }]);
    expect(r.status).toBe(400);
    expect(r.body.adjunto).toEqual({ indice: 0, motivo: 'contenido-no-coincide' });
  });

  it('tipo y extensión no admitidos (fileFilter) → 400 tipo-no-permitido en su posición, sin intento', async () => {
    const r = await postMultipart(11, caso(), [png(), { buf: Buffer.from('MZ'), nombre: 'programa.exe', tipo: 'application/x-msdownload' }]);
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ codigo: 'adjunto-invalido', adjunto: { indice: 1, motivo: 'tipo-no-permitido' } });
    expect(JSON.stringify(r.body)).not.toContain('programa');
    expect(intentos).toHaveLength(0);
  });

  it('archivo vacío → 400 vacio', async () => {
    const r = await postMultipart(11, caso(), [{ buf: Buffer.alloc(0), nombre: 'a.pdf', tipo: 'application/pdf' }]);
    expect(r.status).toBe(400);
    expect(r.body.adjunto).toEqual({ indice: 0, motivo: 'vacio' });
  });
});

describe('HU #13805 AC3 — límites (3 archivos, 5 MB por defecto)', () => {
  it('4 archivos → 413 adjuntos-limite con el máximo; sin intento ni ADO', async () => {
    const r = await postMultipart(11, caso(), [png(), png(), pdf(), pdf()]);
    expect(r.status).toBe(413);
    expect(r.body).toEqual({ error: 'Puede adjuntar hasta 3 archivos.', codigo: 'adjuntos-limite', limite: { maxArchivos: 3 } });
    expect(intentos).toHaveLength(0);
    expect(subidas).toHaveLength(0);
  });

  it('uno de 6 MB → 413 adjunto-muy-grande con su posición y el máximo en bytes; sin intento', async () => {
    const grande = Buffer.concat([PDF, Buffer.alloc(6 * 1024 * 1024)]);
    const r = await postMultipart(11, caso(), [png(), { buf: grande, nombre: NOMBRE_PDF, tipo: 'application/pdf' }]);
    expect(r.status).toBe(413);
    expect(r.body).toEqual({
      error: 'El archivo 2 supera el máximo de 5 MB por archivo.', codigo: 'adjunto-muy-grande',
      adjunto: { indice: 1, motivo: 'muy-grande' }, limite: { maxBytesArchivo: 5 * 1024 * 1024 },
    });
    expect(intentos).toHaveLength(0);
    sinNombres(r);
  });

  it('parte de archivo con otro nombre o un campo de texto de más → 400 campo-invalido', async () => {
    const r1 = await postMultipart(11, caso(), [{ ...png(), campo: 'otro' }]);
    expect(r1.status).toBe(400);
    expect(r1.body.codigo).toBe('campo-invalido');
    const r2 = await postMultipart(11, caso(), [], (r) => r.field('extra', 'x'));
    expect(r2.status).toBe(400);
    expect(r2.body.codigo).toBe('campo-invalido');
    expect(intentos).toHaveLength(0);
  });

  it('multipart sin la parte `caso` o con JSON roto → 400 campo caso', async () => {
    const r = await postMultipart(11, undefined, [png()]);
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ codigo: 'campo-invalido', campo: 'caso' });
    const r2 = await postMultipart(11, undefined, [], (x) => x.field('caso', '{no-json'));
    expect(r2.body).toMatchObject({ codigo: 'campo-invalido', campo: 'caso' });
  });

  it('multer va después de las guardas: sin autorización → 403 aunque el archivo sea inválido', async () => {
    const r = await postMultipart(16, caso(), [{ buf: NO_PNG, nombre: 'x.png', tipo: 'image/png' }]);
    expect(r.status).toBe(403);
    expect(r.body.codigo).toBe('autorizacion-requerida');
  });
});

describe('HU #13805 AC4 — nada queda en FLITO', () => {
  it('la tabla recibe solo la cantidad; logPiiAccess nombra `adjuntos` sin nombres; los logs no traen nombres', async () => {
    const r = await postMultipart(11, caso(), [png(), pdf()]);
    expect(r.status).toBe(201);
    const fila = vi.mocked(repoCasos.insertar).mock.calls[0]![0];
    expect(Object.keys(fila).sort()).toEqual(['adjuntosCantidad', 'ambiente', 'autorizacionId', 'claveIdempotencia', 'usuarioId']);
    expect(piiMock).toHaveBeenCalledTimes(1);
    expect(piiMock.mock.calls[0]![1].camposAccedidos).toContain('adjuntos');
    expect(lineasLog.join(' ')).toContain('"adjuntosCantidad":2');
    sinNombres(r);
  });

  it('el servicio no conoce el nombre y suelta los buffers al terminar', async () => {
    const { radicarCaso } = await import('../../../src/modules/flito-dr-flit/dr-flit-casos.service.js');
    const adjuntos = [{ contenido: PNG, tipoDeclarado: 'image/png' }];
    await radicarCaso({ user: { sub: 11 } } as never, {
      usuarioId: 11, autorizacionId: 511, ambiente: 'QA', caso: caso() as never, adjuntos,
    });
    expect(adjuntos).toHaveLength(0);
  });
});

describe('HU #13805 AC5 — fallo de la subida a ADO', () => {
  it('falla el 2.º adjunto → 503 reintentable, sin Bug, intento fallido; la misma clave reintenta y radica', async () => {
    subir = async (n) => { if (n === 2) throw new AdoNoDisponibleError('timeout'); return { url: `https://x/a-${n}` }; };
    const c = caso();
    const r = await postMultipart(11, c, [png(), pdf()]);
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ codigo: 'ado-no-disponible', reintentable: true });
    expect(llamadas).toHaveLength(0);
    expect(intentos[0]).toMatchObject({ estado: 'fallido', errorCodigo: 'timeout' });
    expect(piiMock).toHaveBeenCalledTimes(1); // los datos pudieron salir: se audita igual
    sinNombres(r);

    subir = async (n) => ({ url: `https://x/b-${n}` });
    const r2 = await postMultipart(11, c, [png(), pdf()]);
    expect(r2.status).toBe(201);
    expect(intentos).toHaveLength(1);
    expect(intentos[0]).toMatchObject({ estado: 'creado', reintentos: 1 });
    expect(llamadas[0]!.operaciones.filter((o) => o.path === '/relations/-')).toHaveLength(2);
  });

  it('ADO rechaza la subida → 502 ado-error reintentable, sin Bug', async () => {
    subir = async () => { throw new AdoRechazoError('ado-4xx'); };
    const r = await postMultipart(11, caso(), [pdf()]);
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ codigo: 'ado-error', reintentable: true });
    expect(llamadas).toHaveLength(0);
    expect(intentos[0]).toMatchObject({ estado: 'fallido', errorCodigo: 'ado-4xx' });
  });
});

describe('HU #13805 AC6 — caso sin adjuntos', () => {
  it('multipart solo con `caso` → 201 igual que HU-2: sin subidas ni relaciones, Adjuntos «No»', async () => {
    const r = await postMultipart(12, caso(), []);
    expect(r.status).toBe(201);
    expect(subidas).toHaveLength(0);
    expect(llamadas[0]!.operaciones.some((o) => o.path.startsWith('/relations'))).toBe(false);
    expect(String(op(llamadas[0]!, '/fields/Microsoft.VSTS.TCM.ReproSteps'))).toContain('<td><b>Adjuntos</b></td><td>No</td>');
    expect(piiMock.mock.calls[0]![1].camposAccedidos).not.toContain('adjuntos');
  });

  it('JSON sin archivos sigue funcionando (compatibilidad HU-2)', async () => {
    const r = await post(12, caso());
    expect(r.status).toBe(201);
    expect(subidas).toHaveLength(0);
  });
});
