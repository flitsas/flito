// HU #12082 — `resolverPermisos`: el motor único, contra la fuente REAL de filas y un chain espía.
//
// Aquí no se usa `helpers/auth.ts` a propósito: ese helper sustituye la lectura de filas por un
// registro, y lo que estos casos afirman es justamente la lectura —las tres consultas, su `where`
// renderizado, qué fuente decide cada familia— además de la regla `(R ∪ C) \ V`, la caché de 60 s y
// el fail-closed. Memoria del repo: el mock `chain` devuelve la fila entera aunque el `select` pida
// menos, así que los asertos sobre columnas van sobre el SQL renderizado, no sobre la forma de la fila.
//
// Tasks de QA que fija este fichero: #12258, #12259, #12262 (caché), #12263, #12273 (M1) y #12275 (M3).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const selectMock = vi.fn();
const warnMock = vi.fn();

/** Cada consulta captura su `where` y devuelve las filas que le toquen por orden. */
let condiciones: unknown[] = [];
let selecciones: unknown[] = [];
let respuestas: unknown[][] = [];

function chainEspia(seleccion: unknown) {
  selecciones.push(seleccion);
  const filas = respuestas.shift() ?? [];
  const t: Record<string, unknown> = {
    from: () => t,
    innerJoin: () => t,
    where: (c: unknown) => { condiciones.push(c); return t; },
    limit: () => t,
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      (filas instanceof Error ? Promise.reject(filas) : Promise.resolve(filas)).then(res, rej),
  };
  return t;
}

vi.mock('../../src/db/client.js', () => ({
  db: { select: (...a: unknown[]) => selectMock(...a), insert: vi.fn(), update: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/logger.js', () => ({
  loggerFor: () => ({ warn: warnMock, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  logger: { warn: warnMock, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  resolverPermisos, invalidarPermisosDe, invalidarPermisosDeRol, paginasEfectivasDeUsuario,
  fijarFuenteDePermisos, PERMISOS_CACHE_TTL_MS,
} = await import('../../src/shared/permisos-efectivos.js');

const render = (c: unknown) => new PgDialect().sqlToQuery(c as never);

/**
 * La tanda entera: fila de users⋈permisos_roles, filas del rol, filas del usuario. HU #12087: la fila
 * de `users` ya no trae `allowed_pages` (congelada, 0188); las páginas propias son filas `conceder
 * pagina.<slug>` de `permisos_usuario_funcion`, en `propias` como cualquier otra excepción.
 */
function base(opts: {
  usuario?: { rol: string; tipoPrincipal?: string } | null;
  rol?: string[];
  propias?: { codigo: string; efecto: string }[];
}) {
  const u = opts.usuario === null ? [] : [{
    rol: opts.usuario?.rol ?? 'gestor',
    tipoPrincipal: opts.usuario?.tipoPrincipal ?? 'interno',
  }];
  respuestas = [u, (opts.rol ?? []).map((codigo) => ({ codigo })), opts.propias ?? []];
}

const conjunto = async (userId: number) => {
  const p = await resolverPermisos(userId);
  if (!p.ok) throw new Error(`no resolvió: ${p.motivo}`);
  return [...p.funciones].sort();
};

beforeEach(() => {
  condiciones = []; selecciones = []; respuestas = [];
  selectMock.mockReset().mockImplementation(chainEspia);
  warnMock.mockReset();
  // Cada caso parte sin caché: la fuente real, recién fijada, la vacía.
  fijarFuenteDePermisos(null);
});
afterEach(() => { vi.useRealTimers(); });

describe('TC #12258 AC1 — resolverPermisos: (rol ∪ conceder) \\ revocar, con el where atado a userId y a rolCodigo', () => {
  it('la concesión del usuario suma lo que el rol no da y la revocación quita lo que el rol sí da (RN-A6, los dos sentidos)', async () => {
    base({
      usuario: { rol: 'gestor' },
      rol: ['soat.cola.ver', 'soat.solicitud.crear', 'pagina.dashboard'],
      propias: [
        { codigo: 'tramite.lote.crear', efecto: 'conceder' },
        { codigo: 'soat.solicitud.crear', efecto: 'revocar' },
      ],
    });
    expect(await conjunto(7)).toEqual(['pagina.dashboard', 'soat.cola.ver', 'tramite.lote.crear']);
  });

  it('el where de permisos_rol_funcion lleva el rol LEÍDO de users (no un literal) y el de permisos_usuario_funcion lleva user_id = 7', async () => {
    base({ usuario: { rol: 'gestor' }, rol: ['soat.cola.ver'] });
    await resolverPermisos(7);

    expect(selectMock).toHaveBeenCalledTimes(3);
    const [qUsuario, qRol, qPropias] = condiciones.map(render);
    expect(qUsuario!.sql).toMatch(/"users"\."id" = \$1/);
    expect(qUsuario!.params).toEqual([7]);
    expect(qRol!.sql).toMatch(/"permisos_rol_funcion"\."rol_codigo" = \$1/);
    expect(qRol!.params).toEqual(['gestor']);
    expect(qPropias!.sql).toMatch(/"permisos_usuario_funcion"\."user_id" = \$1/);
    expect(qPropias!.params).toEqual([7]);
  });

  it('el rol del where cambia con el usuario: no está cableado a admin', async () => {
    base({ usuario: { rol: 'mensajero' } });
    await resolverPermisos(1);
    expect(render(condiciones[1]).params).toEqual(['mensajero']);
    invalidarPermisosDe(2);
    base({ usuario: { rol: 'compliance' } });
    await resolverPermisos(2);
    expect(render(condiciones[4]).params).toEqual(['compliance']);
  });

  it('de users pide role y el tipo del rol; NUNCA allowed_pages (congelada, HU #12087), email, name, username ni password_hash', async () => {
    base({ usuario: { rol: 'gestor' } });
    await resolverPermisos(7);
    const columnas = selecciones.map((s) => Object.keys(s as object));
    expect(columnas[0]).toEqual(['rol', 'tipoPrincipal']);
    expect(columnas[1]).toEqual(['codigo']);
    expect(columnas[2]).toEqual(['codigo', 'efecto']);
    // Las columnas reales que cada campo del select apunta, por si alguien renombra el alias.
    const sql = selecciones.map((s) => Object.values(s as Record<string, { name?: string }>).map((c) => c.name)).flat();
    expect(sql).toEqual(['role', 'tipo_principal', 'funcion_codigo', 'funcion_codigo', 'efecto']);
    for (const prohibida of ['allowed_pages', 'email', 'name', 'username', 'password_hash', 'documento', 'telefono']) {
      expect(sql).not.toContain(prohibida);
    }
  });
});

describe('TC #12259 AC1 — borde: rol sin funciones devuelve vacío sin lanzar; revocar lo que el rol no da no lanza; pagina.* y operacion.* salen las dos de permisos_usuario_funcion (HU #12087)', () => {
  it('(a) un rol nuevo_desde_panel sin filas y un usuario sin filas propias → Set vacío, sin rechazar, sin log', async () => {
    base({ usuario: { rol: 'nuevo_desde_panel' } });
    const p = await resolverPermisos(11);
    expect(p.ok).toBe(true);
    expect(p.ok && p.funciones.size).toBe(0);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('(b) revocar una función que el rol no da → Set vacío, sin lanzar', async () => {
    base({ usuario: { rol: 'gestor' }, propias: [{ codigo: 'soat.solicitud.crear', efecto: 'revocar' }] });
    expect(await conjunto(12)).toEqual([]);
  });

  it('(c) `conceder pagina.*` y `conceder operacion.*` de permisos_usuario_funcion CUENTAN los dos: la tabla es la única fuente de las excepciones (HU #12087, AC6)', async () => {
    base({
      usuario: { rol: 'gestor' },
      rol: ['pagina.dashboard'],
      propias: [
        { codigo: 'pagina.users', efecto: 'conceder' },
        { codigo: 'tramite.lote.crear', efecto: 'conceder' },
      ],
    });
    expect(await conjunto(13)).toEqual(['pagina.dashboard', 'pagina.users', 'tramite.lote.crear']);
  });

  it('un `conceder pagina.<slug>` cuyo slug ya no está en el catálogo no concede nada', async () => {
    base({ usuario: { rol: 'gestor' }, propias: [
      { codigo: 'pagina.no_existe', efecto: 'conceder' }, { codigo: 'pagina.laft', efecto: 'conceder' },
    ] });
    expect(await conjunto(14)).toEqual(['pagina.laft']);
  });

  it('un código de operación cuyo recorte parece un slug tampoco se cuela como página (`bolsas.transito`)', async () => {
    base({ usuario: { rol: 'financiera' }, rol: ['bolsas.transito'] });
    expect(await paginasEfectivasDeUsuario(15)).toEqual([]);
  });

  it('un usuario que no existe → { ok:false, motivo:sin_usuario }, sin lanzar', async () => {
    base({ usuario: null });
    expect(await resolverPermisos(99)).toEqual({ ok: false, userId: 99, motivo: 'sin_usuario' });
  });

  it('devuelve el rol y el tipo_principal LEÍDOS de la base junto al conjunto', async () => {
    base({ usuario: { rol: 'aseguradora_x', tipoPrincipal: 'externo' }, rol: ['pagina.flito_soat'] });
    const p = await resolverPermisos(16);
    expect(p.ok && p.rol).toBe('aseguradora_x');
    expect(p.ok && p.tipoPrincipal).toBe('externo');
  });
});

describe('TC #12273 AC9 M1 — colisión conceder/revocar: la resta va ÚLTIMA y revocar gana', () => {
  it('el MISMO código con los dos efectos en la capa de usuario → NO está en el conjunto', async () => {
    base({
      usuario: { rol: 'gestor' },
      rol: ['soat.cola.ver'],
      propias: [
        { codigo: 'soat.solicitud.crear', efecto: 'conceder' },
        { codigo: 'soat.solicitud.crear', efecto: 'revocar' },
      ],
    });
    // Mutante (R \ V) ∪ C: la concesión se aplicaría después de la resta y el código aparecería.
    expect(await conjunto(7)).toEqual(['soat.cola.ver']);
  });

  it('`revocar pagina.fleet` contra `pagina.fleet` del ROL → la página NO está (AC2 de la #12087; mutante AC8: quitar el bucle de revocar)', async () => {
    base({
      usuario: { rol: 'gestor' },
      rol: ['pagina.fleet', 'pagina.dashboard'],
      propias: [{ codigo: 'pagina.fleet', efecto: 'revocar' }],
    });
    expect(await conjunto(8)).toEqual(['pagina.dashboard']);
    expect(await paginasEfectivasDeUsuario(8)).toEqual(['dashboard']);
  });
});

describe('TC #12262 AC4 — caché de 60 s por user_id, invalidación por usuario y por rol', () => {
  it('(i) a los 30 s no hay consultas nuevas; (ii) invalidarPermisosDe(7) obliga a releer; (iii) a los 61 s vence sola', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-10T15:00:00Z') });
    base({ usuario: { rol: 'gestor' }, rol: ['soat.cola.ver'] });
    await resolverPermisos(7);
    expect(selectMock).toHaveBeenCalledTimes(3);

    vi.setSystemTime(new Date('2026-09-10T15:00:30Z'));
    await resolverPermisos(7);
    expect(selectMock).toHaveBeenCalledTimes(3);

    invalidarPermisosDe(7);
    base({ usuario: { rol: 'gestor' }, rol: ['soat.cola.ver', 'tramite.lote.crear'] });
    const p = await resolverPermisos(7);
    expect(selectMock).toHaveBeenCalledTimes(6);
    expect(p.ok && p.funciones.has('tramite.lote.crear')).toBe(true);

    vi.setSystemTime(new Date('2026-09-10T15:01:31Z'));
    base({ usuario: { rol: 'gestor' }, rol: [] });
    await resolverPermisos(7);
    expect(selectMock).toHaveBeenCalledTimes(9);
    expect(PERMISOS_CACHE_TTL_MS).toBe(60_000);
  });

  it('invalidarPermisosDeRol alcanza a TODOS los usuarios del rol y a ninguno de otro', async () => {
    base({ usuario: { rol: 'gestor' } }); await resolverPermisos(1);
    base({ usuario: { rol: 'gestor' } }); await resolverPermisos(2);
    base({ usuario: { rol: 'auditor' } }); await resolverPermisos(3);
    expect(selectMock).toHaveBeenCalledTimes(9);

    invalidarPermisosDeRol('gestor');
    base({ usuario: { rol: 'gestor' } }); await resolverPermisos(1);
    base({ usuario: { rol: 'gestor' } }); await resolverPermisos(2);
    await resolverPermisos(3);
    expect(selectMock).toHaveBeenCalledTimes(15); // 1 y 2 releídos; 3 sigue en caché
  });

  it('la version es un hash del conjunto: igual si nada cambia, distinta si cambia lo que puede', async () => {
    base({ usuario: { rol: 'gestor' }, rol: ['soat.cola.ver'] });
    const a = await resolverPermisos(7);
    invalidarPermisosDe(7);
    base({ usuario: { rol: 'gestor' }, rol: ['soat.cola.ver'] });
    const b = await resolverPermisos(7);
    invalidarPermisosDe(7);
    base({ usuario: { rol: 'gestor' }, rol: ['soat.cola.ver', 'tramite.lote.crear'] });
    const c = await resolverPermisos(7);
    expect(a.ok && b.ok && a.version === b.version).toBe(true);
    expect(a.ok && c.ok && a.version !== c.version).toBe(true);
    expect(a.ok && a.version).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('TC #12263 AC4 — el fallo de base NO abre la puerta: niega de forma distinguible, lo registra y no cachea el fallo', () => {
  it('la consulta rechaza → { ok:false, motivo:resolucion }, log.warn con userId y sin PII, y NO es un Set vacío', async () => {
    respuestas = [new Error('ECONNREFUSED') as unknown as unknown[]];
    const p = await resolverPermisos(7);
    expect(p).toEqual({ ok: false, userId: 7, motivo: 'resolucion' });
    expect('funciones' in p).toBe(false);
    expect(warnMock).toHaveBeenCalledTimes(1);
    const [meta, msg] = warnMock.mock.calls[0]!;
    expect(meta).toMatchObject({ userId: 7, err: 'ECONNREFUSED' });
    expect(String(msg)).toMatch(/se niega/);
  });

  it('el fallo NO queda cacheado: la segunda llamada dentro de los 60 s vuelve a la base y resuelve', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-10T15:00:00Z') });
    respuestas = [new Error('ECONNREFUSED') as unknown as unknown[]];
    expect((await resolverPermisos(7)).ok).toBe(false);
    expect(selectMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-09-10T15:00:05Z'));
    base({ usuario: { rol: 'gestor' }, rol: ['soat.solicitud.crear'] });
    const p = await resolverPermisos(7);
    expect(selectMock).toHaveBeenCalledTimes(4);
    expect(p.ok && p.funciones.has('soat.solicitud.crear')).toBe(true);
  });

  it('un fallo en la SEGUNDA o TERCERA consulta también niega (no se decide con media tanda)', async () => {
    respuestas = [[{ rol: 'gestor', tipoPrincipal: 'interno' }], new Error('timeout') as unknown as unknown[]];
    expect(await resolverPermisos(7)).toEqual({ ok: false, userId: 7, motivo: 'resolucion' });
  });

  it('paginasEfectivasDeUsuario (login y /me) devuelve [] ante el fallo: pinta un menú, no decide', async () => {
    respuestas = [new Error('ECONNREFUSED') as unknown as unknown[]];
    expect(await paginasEfectivasDeUsuario(7)).toEqual([]);
  });
});

describe('el seam de pruebas', () => {
  it('fijarFuenteDePermisos rechaza en producción', () => {
    const antes = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => fijarFuenteDePermisos(null)).toThrow(/solo para pruebas/);
    } finally {
      process.env.NODE_ENV = antes;
    }
  });

  it('sustituye las FILAS y no la regla: la resta sigue ganando sobre el double', async () => {
    fijarFuenteDePermisos(async () => ({
      rol: 'gestor', tipoPrincipal: 'interno',
      funcionesDelRol: ['soat.cola.ver', 'pagina.fleet'], excepciones: [{ codigo: 'pagina.fleet', efecto: 'revocar' }],
    }));
    expect(await conjunto(7)).toEqual(['soat.cola.ver']);
    expect(selectMock).not.toHaveBeenCalled();
  });
});
