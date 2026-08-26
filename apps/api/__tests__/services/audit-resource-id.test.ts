// `audit()` con identificadores de lote.
//
// Varios sitios auditaban una operación en lote con `ids.join(',')` en `resourceId`. La columna
// `audit_logs.resource_id` es varchar(50) y dos UUID unidos por coma son 73 caracteres: Postgres
// RECHAZA el INSERT —no lo trunca— y como `audit()` absorbe sus errores para no tumbar la petición,
// la operación se completaba SIN dejar ninguna fila de auditoría.
//
// Silencioso y del lado malo: cuanto más grande el lote, más seguro que no quedara rastro. Se
// comprobó contra la base real: no hay una sola fila con comas en `resource_id`, así que se
// perdieron todas.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const values = vi.fn().mockResolvedValue(undefined);
const insertMock = vi.fn(() => ({ values }));

vi.mock('../../src/db/client.js', () => ({
  db: { insert: insertMock, select: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));

const { audit } = await import('../../src/shared/middleware/audit.js');

const UUID_A = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const UUID_B = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12';
const req = { user: { sub: 1, username: 'ops' }, headers: {}, ip: '127.0.0.1' } as never;

beforeEach(() => { vi.clearAllMocks(); });

/** Lo que se pasó a `.values()` en la última llamada. */
const escrito = () => values.mock.calls.at(-1)![0] as { resourceId: string | null; detail: string | null };

describe('audit — resourceId que no cabe en la columna', () => {
  it('un solo UUID entra tal cual', async () => {
    await audit(req, { action: 'update', resource: 'flito_soat', resourceId: UUID_A, detail: 'Rechazo' });
    expect(escrito().resourceId).toBe(UUID_A);
    expect(escrito().detail).toBe('Rechazo');
  });

  it('dos UUID unidos por coma NO se pierden: pasan al detalle', async () => {
    const lote = `${UUID_A},${UUID_B}`;
    expect(lote.length).toBeGreaterThan(50); // 73: la razón del fallo

    await audit(req, { action: 'update', resource: 'flito_impuesto', resourceId: lote, detail: 'Enviados al gestor: 2' });

    // La columna queda nula en vez de llevar un id recortado, que sería peor que ninguno: un UUID a
    // medias parece un identificador y no lo es.
    expect(escrito().resourceId).toBeNull();
    // Y los ids siguen ahí, en `detail`, que es `text` y no tiene tope.
    expect(escrito().detail).toContain(UUID_A);
    expect(escrito().detail).toContain(UUID_B);
    expect(escrito().detail).toContain('Enviados al gestor: 2');
  });

  it('sin detalle previo, el detalle se compone solo con los registros', async () => {
    await audit(req, { action: 'update', resource: 'flito_soat', resourceId: `${UUID_A},${UUID_B}` });
    expect(escrito().detail).toBe(`Registros: ${UUID_A},${UUID_B}`);
  });

  it('sobre todo: SIEMPRE queda una fila', async () => {
    await audit(req, { action: 'update', resource: 'flito_impuesto', resourceId: `${UUID_A},${UUID_B}` });
    // El fallo original no era un dato mal guardado, era que no se guardaba nada.
    expect(insertMock).toHaveBeenCalledTimes(1);
  });
});
