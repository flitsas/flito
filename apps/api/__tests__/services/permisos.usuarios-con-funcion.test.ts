// HU #13425 — `usuariosConFuncion` (quién tiene HOY una función, sin leer el nombre del rol) frente al
// resolutor `resolverPermisos`, sobre el MISMO fixture (riesgo R3 del diseño: que diverjan en las
// excepciones por usuario, en el revocar o en un rol renombrado).
//
// Dos comparaciones: (1) el pliegue puro `filtrarPorFuncion` contra `resolverPermisos` usuario a
// usuario; (2) `usuariosConFuncion` —el que lee la base— con las filas del fixture servidas por el
// mock de `db`, contra el mismo resultado. Si el lector olvida las excepciones o el revocar, (2) cae.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chain } from '../helpers/db.js';
import type { FilasPermisos } from '../../src/shared/permisos-efectivos.js';

const selectMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: vi.fn(), update: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));

const {
  filtrarPorFuncion, fijarFuenteDePermisos, resolverPermisos, usuariosConFuncion,
} = await import('../../src/shared/permisos-efectivos.js');

const ENTREGAR = 'logistica.actas.entregar';
const AJENAS = 'logistica.actas.operar_ajenas';

const fila = (rol: string, funcionesDelRol: string[], excepciones: FilasPermisos['excepciones'] = []): FilasPermisos =>
  ({ rol, tipoPrincipal: 'interno', tipoEnlace: 'ninguno', funcionesDelRol, excepciones });

/** Reparto por rol (como `permisos_rol_funcion`) y usuarios con sus excepciones. */
const REPARTO: Record<string, string[]> = {
  mensajero: [ENTREGAR, 'logistica.ruta.ver'],
  repartidor_norte: [ENTREGAR, 'logistica.ruta.ver'], // mismo reparto, OTRO nombre (AC7)
  admin: [ENTREGAR, AJENAS],
  coordinador: [ENTREGAR, AJENAS],
  auditor: ['logistica.actas.listar'],
};
const FIXTURE = new Map<number, FilasPermisos>([
  [1, fila('mensajero', REPARTO.mensajero!)],
  [2, fila('repartidor_norte', REPARTO.repartidor_norte!)],
  [3, fila('admin', REPARTO.admin!)],
  [4, fila('coordinador', REPARTO.coordinador!)],
  [5, fila('auditor', REPARTO.auditor!, [{ codigo: ENTREGAR, efecto: 'conceder' }])], // excepción: entrega
  [6, fila('mensajero', REPARTO.mensajero!, [{ codigo: ENTREGAR, efecto: 'revocar' }])], // revocado
  [7, fila('mensajero', REPARTO.mensajero!, [{ codigo: AJENAS, efecto: 'conceder' }])], // opera ajenas
  [8, fila('admin', REPARTO.admin!, [{ codigo: AJENAS, efecto: 'revocar' }])], // admin SIN ajenas → asignable
  [9, fila('auditor', REPARTO.auditor!)],
]);

beforeEach(() => {
  selectMock.mockReset();
  fijarFuenteDePermisos(async (id) => FIXTURE.get(id) ?? null);
});

/** Lo que diría el resolutor, usuario a usuario. */
async function segunResolutor(codigo: string, sin?: string): Promise<number[]> {
  const ids: number[] = [];
  for (const id of FIXTURE.keys()) {
    const p = await resolverPermisos(id);
    if (p.ok && p.funciones.has(codigo) && !(sin && p.funciones.has(sin))) ids.push(id);
  }
  return ids.sort((a, b) => a - b);
}

/** Sirve las filas del fixture con la forma de las tres consultas de `usuariosConFuncion`. */
function servirFixture() {
  const principales = [...FIXTURE].map(([id, f]) => ({ id, rol: f.rol, tipoPrincipal: f.tipoPrincipal, tipoEnlace: f.tipoEnlace }));
  const delRol = Object.entries(REPARTO).flatMap(([rol, cs]) => cs.map((codigo) => ({ rol, codigo })));
  const propias = [...FIXTURE].flatMap(([userId, f]) => f.excepciones.map((e) => ({ userId, codigo: e.codigo, efecto: e.efecto })));
  selectMock
    .mockReturnValueOnce(chain(principales))
    .mockReturnValueOnce(chain(delRol))
    .mockReturnValueOnce(chain(propias));
}

describe('HU #13425 — usuariosConFuncion coincide con resolverPermisos sobre el mismo fixture', () => {
  it('asignables (entrega y NO opera ajenas): el pliegue puro da lo mismo que el resolutor', async () => {
    const esperado = await segunResolutor(ENTREGAR, AJENAS);
    // 1 y 2 (mismo reparto, otro nombre), 5 (excepción conceder), 8 (admin con ajenas revocada).
    expect(esperado).toEqual([1, 2, 5, 8]);
    expect(filtrarPorFuncion(FIXTURE, ENTREGAR, AJENAS)).toEqual(esperado);
  });

  it('una sola función: idéntico al resolutor', async () => {
    expect(filtrarPorFuncion(FIXTURE, AJENAS)).toEqual(await segunResolutor(AJENAS));
    expect(filtrarPorFuncion(FIXTURE, ENTREGAR)).toEqual(await segunResolutor(ENTREGAR));
  });

  it('usuariosConFuncion (lector de base) con las filas del fixture da lo mismo que el resolutor', async () => {
    servirFixture();
    expect(await usuariosConFuncion(ENTREGAR, { sin: AJENAS })).toEqual(await segunResolutor(ENTREGAR, AJENAS));
    servirFixture();
    expect(await usuariosConFuncion(AJENAS)).toEqual(await segunResolutor(AJENAS));
  });

  it('sin usuarios activos devuelve [] sin leer el reparto', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    expect(await usuariosConFuncion(ENTREGAR)).toEqual([]);
    expect(selectMock).toHaveBeenCalledTimes(1);
  });
});
