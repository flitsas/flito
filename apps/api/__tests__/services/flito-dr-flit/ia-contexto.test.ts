// HU #13853 (Feature #13696, IA-1 · ADR-0027) — contexto de fichas para la IA: visibilidad por permiso
// (AC4, AC5), presupuesto (AC6) y paridad del ranking con `buscarSecciones` del web (AC7).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Request } from 'express';
import type { PermisosResueltos } from '../../../src/shared/permisos-efectivos.js';

const resolverMock = vi.fn<(userId: number) => Promise<PermisosResueltos>>();

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

const {
  CODIGOS_PAGINA_FICHAS, armarContexto, costoSeccion, fichasVisibles, filtrarFichasVisibles, presupuestoDeEnv,
  rankearSecciones,
} = await import('../../../src/modules/flito-dr-flit/dr-flit-ia.contexto.js');
const { FICHAS_AYUDA } = await import('../../../src/modules/flito-dr-flit/ayuda/fichas-ayuda.generated.js');
type FichaAyudaApi = (typeof FICHAS_AYUDA)[number];
const { CATALOGO_AYUDA } = await import('../../../../web/src/content/ayuda/catalogo');
const { parsearFicha } = await import('../../../../web/src/lib/ayudaFicha');
const { buscarSecciones } = await import('../../../../web/src/lib/drFlitBusqueda');
const { DIR_FICHAS } = await import('../../../scripts/generar-ayuda-drflit');

const permisos = (userId: number, rol: string, funciones: string[]): PermisosResueltos => ({
  ok: true, userId, rol, tipoEnlace: 'ninguno', funciones: new Set(funciones), version: `v${userId}`, resueltoEn: new Date(),
});
const req = (sub: number, role = 'admin') => ({ user: { sub, role } }) as unknown as Request;
const claves = (fs: readonly { clave: string }[]) => fs.map((f) => f.clave);

beforeEach(() => { resolverMock.mockReset(); });

describe('AC4 — fichas visibles por `pagina.<permiso>` del catálogo, no por rol', () => {
  it('con pagina.flito_soat y sin pagina.flito_impuestos → solo la ficha soat', async () => {
    resolverMock.mockResolvedValue(permisos(11, 'proveedor', ['pagina.flito_soat', 'pagina.otra_cosa']));
    expect(claves(await fichasVisibles(req(11)))).toEqual(['soat']);
  });

  it('funcionesConcedidas consulta el motor UNA sola vez por petición, con los códigos de todas las fichas', async () => {
    resolverMock.mockResolvedValue(permisos(12, 'gestor_impuestos', ['pagina.flito_impuestos']));
    expect(claves(await fichasVisibles(req(12)))).toEqual(['flito_impuestos']);
    expect(resolverMock).toHaveBeenCalledTimes(1);
    expect(CODIGOS_PAGINA_FICHAS).toEqual([...new Set(FICHAS_AYUDA.map((f) => `pagina.${f.permiso}`))]);
  });

  it('pagina.privacy abre «Privacidad» y «Log accesos PII» (privacy_log_pii → privacy)', () => {
    expect(claves(filtrarFichasVisibles(new Set(['pagina.privacy']))).sort()).toEqual(['privacy', 'privacy_log_pii']);
  });

  it('el permiso de la clave no basta: pagina.soat (legacy) no abre la ficha soat', () => {
    expect(filtrarFichasVisibles(new Set(['pagina.soat', 'pagina.privacy_log_pii']))).toEqual([]);
  });

  it('el nombre del rol no cuenta: un `admin` sin funciones no ve fichas', async () => {
    resolverMock.mockResolvedValue(permisos(1, 'admin', []));
    expect(await fichasVisibles(req(1, 'admin'))).toEqual([]);
  });

  it('resolutor caído (ok:false) → ninguna ficha (falla cerrado)', async () => {
    resolverMock.mockResolvedValue({ ok: false, userId: 9, motivo: 'resolucion' });
    expect(await fichasVisibles(req(9))).toEqual([]);
  });
});

describe('AC5 — usuario sin fichas visibles', () => {
  it('índice y secciones vacíos, sin error', () => {
    expect(armarContexto([], 'cómo radico un trámite', { contextoMaxChars: 4000, seccionMaxChars: 500 }))
      .toEqual({ indice: [], secciones: [], seleccionado: false });
  });
});

// ── AC6 — presupuesto ─────────────────────────────────────────────────────────────────────────

const ficha = (clave: string, secciones: [string, string][], extra: Partial<FichaAyudaApi> = {}): FichaAyudaApi => ({
  clave, permiso: clave, etiqueta: `Etiqueta ${clave}`, resumen: `Resumen ${clave}`, version: '1.0', fecha: '2026-10-20',
  palabrasClave: [], consultas: [], secciones: secciones.map(([titulo, texto], i) => ({ ancla: `${clave}-${i}`, titulo, texto })),
  ...extra,
});

describe('AC6 — presupuesto de contexto', () => {
  it('defaults del ambiente: 32 000 de contexto y 6 000 por sección', () => {
    expect(presupuestoDeEnv()).toEqual({ contextoMaxChars: 32_000, seccionMaxChars: 6000 });
  });

  it('si todas las secciones caben, van todas completas y en el orden del catálogo', () => {
    const fichas = [ficha('a', [['Uno', 'x'.repeat(900)], ['Dos', 'y'.repeat(900)]]), ficha('b', [['Tres', 'z'.repeat(900)]])];
    const c = armarContexto(fichas, 'nada que ver', { contextoMaxChars: 4000, seccionMaxChars: 500 });
    expect(c.seleccionado).toBe(false);
    expect(c.secciones.map((s) => s.ancla)).toEqual(['a-0', 'a-1', 'b-0']);
    expect(c.secciones.every((s) => s.texto.length === 900)).toBe(true);
    expect(c.indice).toEqual([
      { clave: 'a', etiqueta: 'Etiqueta a', resumen: 'Resumen a' },
      { clave: 'b', etiqueta: 'Etiqueta b', resumen: 'Resumen b' },
    ]);
  });

  it('si no caben: índice completo siempre, secciones por ranking, recortadas al tope, sin pasar el presupuesto', () => {
    const fichas = [
      ficha('a', [['Pagos', 'pago '.repeat(400)], ['Ajenos', 'otra cosa '.repeat(400)]]),
      ficha('b', [['Pagos del trámite', 'pago tramite '.repeat(400)], ['Pago parcial', 'pago '.repeat(400)]]),
      ficha('c', [['Sin relación', 'nada '.repeat(400)]]),
    ];
    const presupuesto = { contextoMaxChars: 4000, seccionMaxChars: 1500 };
    const c = armarContexto(fichas, 'pago del tramite', presupuesto);
    expect(c.seleccionado).toBe(true);
    expect(claves(c.indice)).toEqual(['a', 'b', 'c']);
    // Orden de ranking: 2 términos cubiertos primero (b-0), luego por puntos/orden.
    expect(c.secciones.map((s) => s.ancla)).toEqual(rankearSecciones(fichas, 'pago del tramite').map((s) => s.ancla).slice(0, c.secciones.length));
    expect(c.secciones[0].ancla).toBe('b-0');
    expect(c.secciones.every((s) => costoSeccion(s) <= presupuesto.seccionMaxChars)).toBe(true);
    expect(c.secciones.reduce((n, s) => n + costoSeccion(s), 0)).toBeLessThanOrEqual(presupuesto.contextoMaxChars);
    expect(c.secciones.map((s) => s.ancla)).not.toContain('c-0');
    expect(c.secciones.length).toBe(3);
  });

  it('con el artefacto real y un presupuesto chico, el índice trae TODAS las fichas visibles', () => {
    const c = armarContexto(FICHAS_AYUDA, 'soat', { contextoMaxChars: 4000, seccionMaxChars: 500 });
    expect(claves(c.indice)).toEqual(claves(FICHAS_AYUDA));
    expect(c.secciones.reduce((n, s) => n + costoSeccion(s), 0)).toBeLessThanOrEqual(4000);
    expect(c.secciones.length).toBeGreaterThan(0);
  });
});

describe('AC6 — variables de ambiente (rangos)', () => {
  async function cargarEnv(vars: Record<string, string>) {
    vi.resetModules();
    for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
    return import('../../../src/config/env.js');
  }
  afterEach(() => { vi.unstubAllEnvs(); });

  it('en blanco = default; dentro de rango se respeta', async () => {
    expect((await cargarEnv({ DRFLIT_IA_CONTEXTO_MAX_CHARS: '', DRFLIT_IA_SECCION_MAX_CHARS: '' })).env)
      .toMatchObject({ DRFLIT_IA_CONTEXTO_MAX_CHARS: 32_000, DRFLIT_IA_SECCION_MAX_CHARS: 6000 });
    expect((await cargarEnv({ DRFLIT_IA_CONTEXTO_MAX_CHARS: '4000', DRFLIT_IA_SECCION_MAX_CHARS: '20000' })).env)
      .toMatchObject({ DRFLIT_IA_CONTEXTO_MAX_CHARS: 4000, DRFLIT_IA_SECCION_MAX_CHARS: 20_000 });
  });

  it('fuera de rango → la API no arranca', async () => {
    await expect(cargarEnv({ DRFLIT_IA_CONTEXTO_MAX_CHARS: '3999' })).rejects.toThrow(/DRFLIT_IA_CONTEXTO_MAX_CHARS/);
    await expect(cargarEnv({ DRFLIT_IA_CONTEXTO_MAX_CHARS: '120001' })).rejects.toThrow(/DRFLIT_IA_CONTEXTO_MAX_CHARS/);
    await expect(cargarEnv({ DRFLIT_IA_SECCION_MAX_CHARS: '499' })).rejects.toThrow(/DRFLIT_IA_SECCION_MAX_CHARS/);
    await expect(cargarEnv({ DRFLIT_IA_SECCION_MAX_CHARS: '20001' })).rejects.toThrow(/DRFLIT_IA_SECCION_MAX_CHARS/);
  });
});

// ── AC7 — paridad del ranking API ↔ web ──────────────────────────────────────────────────────

describe('AC7 — paridad del ranking con `buscarSecciones` del web', () => {
  const fichasWeb = CATALOGO_AYUDA
    .filter((e) => e.permiso && existsSync(path.join(DIR_FICHAS, `${e.clave}.md`)))
    .map((entrada) => ({ entrada, ficha: parsearFicha(readFileSync(path.join(DIR_FICHAS, `${entrada.clave}.md`), 'utf8')) }));

  const CORPUS = [
    'cómo pago el SOAT',
    'dónde veo los comparendos de una placa',
    'liquidar impuesto vehicular',
    'crear un usuario nuevo y asignar rol',
    'conciliación bancaria de comprobantes',
    'estado del trámite de traspaso',
  ];

  it.each(CORPUS)('«%s» → mismo orden de secciones', (consulta) => {
    const web = buscarSecciones(fichasWeb, consulta, 10_000).map((c) => `${c.clave}#${c.ancla}`);
    const api = rankearSecciones(FICHAS_AYUDA, consulta).map((s) => `${s.clave}#${s.ancla}`);
    expect(web.length).toBeGreaterThan(0);
    expect(api).toEqual(web);
  });

  it('también con un subconjunto visible (el orden de ficha es el del subconjunto)', () => {
    const visibles = filtrarFichasVisibles(new Set(['pagina.flito_soat', 'pagina.flito_impuestos', 'pagina.privacy']));
    const set = new Set(claves(visibles));
    const web = buscarSecciones(fichasWeb.filter((f) => set.has(f.entrada.clave)), 'pago placa', 10_000).map((c) => `${c.clave}#${c.ancla}`);
    expect(rankearSecciones(visibles, 'pago placa').map((s) => `${s.clave}#${s.ancla}`)).toEqual(web);
  });
});
