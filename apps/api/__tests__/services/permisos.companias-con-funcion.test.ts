// HU #13967 (AC7) — `companiasConUsuarioConFuncion` (de estas compañías, cuáles tienen HOY un usuario con
// la función) frente al resolutor `resolverPermisos`, sobre el MISMO fixture. Mismo patrón que
// `permisos.usuarios-con-funcion.test.ts`: (1) el pliegue puro `companiasConFuncion` contra el resolutor
// usuario a usuario; (2) el lector de base con las filas del fixture servidas por el mock de `db`.
// Cubre la regla de cadena (`conCadena`), revocar gana, la excepción conceder y el enlace `compania`.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chain } from '../helpers/db.js';
import type { FilasPermisos } from '../../src/shared/permisos-efectivos.js';

const selectMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: vi.fn(), update: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));

const {
  companiasConFuncion, companiasConUsuarioConFuncion, fijarFuenteDePermisos, resolverPermisos,
} = await import('../../src/shared/permisos-efectivos.js');
const { conCadena } = await import('../helpers/auth.js');

const CREAR = 'soat.solicitud.crear';
const ACCION = 'accion.soat.solicitar_sin_tramite';

const fila = (rol: string, tipoEnlace: string, funcionesDelRol: string[], excepciones: FilasPermisos['excepciones'] = []): FilasPermisos => ({
  rol, tipoEnlace, funcionesDelRol: conCadena(funcionesDelRol),
  excepciones: [
    ...conCadena(excepciones.filter((e) => e.efecto === 'conceder').map((e) => e.codigo)).map((codigo) => ({ codigo, efecto: 'conceder' as const })),
    ...excepciones.filter((e) => e.efecto === 'revocar'),
  ],
});

const REPARTO: Record<string, string[]> = {
  cliente: [ACCION],
  cliente_basico: ['soat.solicitudes.listar'],
  admin: [ACCION],
};
/** userId → compañía + filas. */
const USUARIOS = new Map<number, { companiaId: number; filas: FilasPermisos }>([
  [1, { companiaId: 10, filas: fila('cliente', 'compania', REPARTO.cliente!) }], // tiene → 10
  [2, { companiaId: 20, filas: fila('cliente_basico', 'compania', REPARTO.cliente_basico!) }], // no tiene
  [3, { companiaId: 20, filas: fila('cliente', 'compania', REPARTO.cliente!, [{ codigo: ACCION, efecto: 'revocar' }]) }], // revocado
  [4, { companiaId: 30, filas: fila('cliente_basico', 'compania', REPARTO.cliente_basico!, [{ codigo: ACCION, efecto: 'conceder' }]) }], // excepción → 30
  [5, { companiaId: 40, filas: fila('admin', 'ninguno', REPARTO.admin!) }], // tiene, pero NO es de enlace compañía
  [6, { companiaId: 50, filas: fila('cliente', 'compania', REPARTO.cliente!) }], // → 50
]);

beforeEach(() => {
  selectMock.mockReset();
  fijarFuenteDePermisos(async (id) => USUARIOS.get(id)?.filas ?? null);
});

/** Lo que diría el resolutor: compañías de usuarios con enlace `compania` y la función en su conjunto efectivo. */
async function segunResolutor(codigo: string): Promise<number[]> {
  const companias = new Set<number>();
  for (const [id, u] of USUARIOS) {
    const p = await resolverPermisos(id);
    if (p.ok && p.tipoEnlace === 'compania' && p.funciones.has(codigo)) companias.add(u.companiaId);
  }
  return [...companias].sort((a, b) => a - b);
}

const ordenado = (s: Set<number>) => [...s].sort((a, b) => a - b);

function servirFixture() {
  const principales = [...USUARIOS].map(([id, u]) => ({ id, companiaId: u.companiaId, rol: u.filas.rol, tipoEnlace: u.filas.tipoEnlace }));
  const delRol = Object.entries(REPARTO).flatMap(([rol, cs]) => conCadena(cs).map((codigo) => ({ rol, codigo })));
  const propias = [...USUARIOS].flatMap(([userId, u]) => u.filas.excepciones.map((e) => ({ userId, codigo: e.codigo, efecto: e.efecto })));
  selectMock
    .mockReturnValueOnce(chain(principales))
    .mockReturnValueOnce(chain(delRol))
    .mockReturnValueOnce(chain(propias));
}

describe('HU #13967 — companiasConUsuarioConFuncion coincide con resolverPermisos', () => {
  it('el pliegue puro da lo mismo que el resolutor: cadena, revocar gana, conceder y solo enlace compañía', async () => {
    const esperado = await segunResolutor(CREAR);
    expect(esperado).toEqual([10, 30, 50]);
    expect(ordenado(companiasConFuncion([...USUARIOS.values()], CREAR))).toEqual(esperado);
  });

  it('el lector de base con las filas del fixture da lo mismo que el resolutor', async () => {
    servirFixture();
    expect(ordenado(await companiasConUsuarioConFuncion(CREAR, [10, 20, 30, 40, 50]))).toEqual(await segunResolutor(CREAR));
  });

  it('sin compañías que consultar → conjunto vacío SIN tocar la base', async () => {
    expect((await companiasConUsuarioConFuncion(CREAR, [])).size).toBe(0);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('sin usuarios de enlace compañía → vacío sin leer el reparto', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5, companiaId: 40, rol: 'admin', tipoEnlace: 'ninguno' }]));
    expect((await companiasConUsuarioConFuncion(CREAR, [40])).size).toBe(0);
    expect(selectMock).toHaveBeenCalledTimes(1);
  });
});
