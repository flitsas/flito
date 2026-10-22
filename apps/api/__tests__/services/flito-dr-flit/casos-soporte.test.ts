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
  17: ['admin', 'ninguno', ['pagina.flito_ayuda', 'pagina.users']],            // ninguna página con ficha
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
const clienteFalso: ClienteSoporteAdo = {
  modo: 'real',
  async crearBug(b) { llamadas.push(b); return comportamiento(); },
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
