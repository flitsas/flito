// HU #14338 (Feature #14325, ADR-0039 §6.1) — La capa de servicio de `guardiaFrontera` y del menú. Corre siempre, sin base: lo doble es la
// LECTURA de filas (`fijarFuenteDePermisos`); la regla, el hash y la caché son los reales. De punta a punta: `db/proveedores-frontera-usuarios.test.ts`.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express, { Router, type Request, type Response } from 'express';
import request from 'supertest';
import { SignJWT } from 'jose';

vi.mock('../../src/db/client.js', () => {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit', 'innerJoin', 'leftJoin']) c[m] = () => c;
  (c as { then: unknown }).then = (res: (v: unknown) => void) => res([]);
  return { db: { select: () => c, insert: () => ({ values: () => Promise.resolve() }) }, getPoolStats: vi.fn() };
});
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const permisos = await import('../../src/shared/permisos-efectivos.js');
const { authMiddleware } = await import('../../src/shared/middleware/auth.js');
const { conAlcance, proveedorAlcanzaModulo, moduloAbiertoA } = await import('../../src/shared/middleware/frontera-enlace.js');
import type { FilasPermisos, ProveedorDePermisos } from '../../src/shared/permisos-efectivos.js';
import { conCadena } from '../helpers/auth.js';

const ROL = ['pagina.flito_soat', 'pagina.flito_logistica', 'pagina.users', 'pagina.perfil'];
const P = (servicios: ('soat' | 'logistica')[], activo = true): ProveedorDePermisos => ({ id: 'p-a', activo, servicios });
const filas = new Map<number, FilasPermisos>();
const fuente = vi.fn(async (id: number) => filas.get(id) ?? null);
const de = (id: number, proveedor: ProveedorDePermisos | null, tipoEnlace = 'proveedor', funcionesDelRol = ROL) => {
  filas.set(id, { rol: 'r', tipoEnlace, proveedor, funcionesDelRol: conCadena(funcionesDelRol), excepciones: [] });
};
const paginas = (id: number) => permisos.paginasEfectivasDeUsuario(id);

const token = (sub: number) => new SignJWT({ username: 'u', role: 'x' }).setProtectedHeader({ alg: 'HS256' }).setSubject(String(sub))
  .setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));

function app() {
  const a = express();
  const abierto = (modulo: 'soat' | 'logistica' | 'tablero') => {
    const r = Router();
    r.use(authMiddleware);
    r.get('/', (_q: Request, s: Response) => { s.json({ ok: true }); });
    a.use(`/api/${modulo}`, conAlcance(modulo, r));
  };
  abierto('soat'); abierto('logistica'); abierto('tablero');
  const cerrado = Router();
  cerrado.use(authMiddleware);
  cerrado.get('/', (_q: Request, s: Response) => { s.json({ ok: true }); });
  a.use('/api/users', cerrado);
  return a;
}
const pide = async (ruta: string, sub: number) => request(app()).get(ruta).set('Authorization', `Bearer ${await token(sub)}`);

beforeEach(() => { filas.clear(); fuente.mockClear(); permisos.fijarFuenteDePermisos(fuente); });

describe('Frontera por servicio', () => {
  it('AC1: proveedor solo de Logística → SOAT 403 «Sin permisos»; con SOAT → 200', async () => {
    de(1, P(['logistica']));
    de(2, P(['soat']));
    const r = await pide('/api/soat', 1);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'Sin permisos' });
    expect((await pide('/api/soat', 2)).status).toBe(200);
  });

  it('AC3: con los dos servicios, Logística sigue cerrada al enlace hasta F4.2', async () => {
    de(1, P(['soat', 'logistica']));
    expect((await pide('/api/soat', 1)).status).toBe(200);
    expect((await pide('/api/logistica', 1)).status).toBe(403);
  });

  it('AC4 y R5: sin proveedor, inexistente o inactivo → 403; un módulo sin servicio queda cerrado', async () => {
    de(1, null);
    de(2, P(['soat'], false));
    expect((await pide('/api/soat', 1)).status).toBe(403);
    expect((await pide('/api/soat', 2)).status).toBe(403);
    expect(proveedorAlcanzaModulo('tablero', P(['soat', 'logistica']))).toBe(false);
    expect(proveedorAlcanzaModulo('soat', null)).toBe(false);
    expect(moduloAbiertoA('soat', 'proveedor')).toBe(true);
  });

  it('#14343 fuera de la épica: `/api/users` sigue cerrado al enlace proveedor; sin montaje declarado', async () => {
    de(1, P(['soat', 'logistica']), 'proveedor', [...ROL, 'usuarios.usuario.listar']);
    expect((await pide('/api/users', 1)).status).toBe(403);
    expect(await paginas(1)).not.toContain('users');
  });

  it('AC6: invalidar el proveedor tras el commit corta la sesión viva sin esperar la caché; solo a los suyos', async () => {
    de(1, P(['soat', 'logistica']));
    filas.set(2, { rol: 'r', tipoEnlace: 'proveedor', proveedor: { id: 'p-b', activo: true, servicios: ['soat'] }, funcionesDelRol: conCadena(ROL), excepciones: [] });
    expect((await pide('/api/soat', 1)).status).toBe(200);
    expect((await pide('/api/soat', 2)).status).toBe(200);
    de(1, P(['logistica']));
    expect((await pide('/api/soat', 1)).status).toBe(200); // aún en caché: es lo que la invalidación corrige
    fuente.mockClear();
    permisos.invalidarPermisosDeProveedor('p-a');
    expect((await pide('/api/soat', 1)).status).toBe(403);
    await pide('/api/soat', 2);
    expect(fuente).not.toHaveBeenCalledWith(2); // el otro proveedor conserva su entrada
  });

  it('AC6 (carrera): una lectura en curso al invalidar no deja en caché la foto vieja', async () => {
    de(1, P(['soat']));
    let soltar!: (v: FilasPermisos) => void;
    fuente.mockImplementationOnce(() => new Promise<FilasPermisos>((r) => { soltar = r; }));
    const enCurso = permisos.resolverPermisos(1);
    permisos.invalidarPermisosDeProveedor('p-a');
    soltar(filas.get(1)!);
    await enCurso;
    de(1, P([]));
    expect((await pide('/api/soat', 1)).status).toBe(403);
  });

  it('AC7: los otros enlaces no leen proveedor ni cambian', async () => {
    de(1, null, 'compania');
    de(2, null, 'ninguno');
    expect((await pide('/api/soat', 1)).status).toBe(200);
    expect((await pide('/api/tablero', 1)).status).toBe(200);
    expect((await pide('/api/users', 1)).status).toBe(403);
    expect((await pide('/api/soat', 2)).status).toBe(200);
    expect(await paginas(1)).toEqual(expect.arrayContaining(['flito_soat', 'flito_logistica', 'users', 'perfil']));
  });
});

describe('Menú y versión', () => {
  it('AC1 y AC3: quita lo que su servicio o el enlace cierran; deja la sesión', async () => {
    de(1, P(['logistica']));
    de(2, P(['soat', 'logistica']));
    de(3, P(['soat'], false));
    expect(await paginas(1)).toEqual(['perfil']);
    expect((await paginas(2)).sort()).toEqual(['flito_soat', 'perfil']);
    expect(await paginas(3)).toEqual(['perfil']);
  });

  it('AC2: rol sin la página, aunque preste el servicio → fuera', async () => {
    de(1, P(['soat']), 'proveedor', ['pagina.perfil']);
    expect(await paginas(1)).toEqual(['perfil']);
  });

  it('la versión cambia si cambian los servicios o el estado, y es estable con lo demás', async () => {
    de(1, P(['soat', 'logistica']));
    const v = async () => { permisos.invalidarPermisosDe(1); const p = await permisos.resolverPermisos(1); return p.ok ? p.version : ''; };
    const base = await v();
    expect(await v()).toBe(base);
    de(1, P(['logistica']));
    expect(await v()).not.toBe(base);
    de(1, P(['soat', 'logistica'], false));
    expect(await v()).not.toBe(base);
  });

  it('ignora un `proveedor` en filas de otro enlace', async () => {
    de(1, P(['soat']), 'ninguno');
    const p = await permisos.resolverPermisos(1);
    expect(p.ok && p.proveedor).toBeNull();
  });
});
