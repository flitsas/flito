// HU #13362 (AC9) — los documentos adicionales del alta de SOAT NO salen en la lista general de
// soportes (para ningún rol), ni en el ZIP, ni en la exportación del pago. Se leen solo por
// `GET /:id/documentos-adicionales` (ver flito-soat-documentos.routes.test.ts).
//
//   TC-19 `soportesDeSoat()` excluye el tipo nuevo para un rol INTERNO (sin recorte por allowlist):
//         se afirma sobre la condición SQL leída, no sobre filas del mock.
//   TC-20 el ZIP filtra por allowlist (`TipoSoporteZip`) y el tipo nuevo no está en ella.
//   TC-21 la fecha de comprobante de la exportación lee solo `factura_soat`.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { TipoSoporte, TipoSoporteZip } from '@operaciones/shared-types';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { renderizar } from '../helpers/sql-ligado.js';

const kdb = createKeyedDb();
const espia = crearEspia(kdb);

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/services/storage.js', () => ({ firmarDescargaEntidad: (k: string) => `/api/files?key=${k}` }));

const { soportesDeSoat, TIPOS_SOPORTE_FUERA_DE_LISTA } = await import('../../src/shared/soportes/soportes-consulta.js');
const { fechasComprobantePorSoat } = await import('../../src/modules/flito-soat/flito-soat.export-pago.js');

const SOAT_ID = '0d0c0000-0000-4000-8000-000000013362';
const TIPO = TipoSoporte.DOCUMENTO_ADICIONAL_SOAT;

const lecturasDeSoportes = () => espia.condicionesLeidas()
  .map((c) => renderizar(c as SQL))
  .filter((q) => q.sql.includes('"flito_soportes"."soat_id"') || q.sql.includes('"flito_soportes"."tipo"'));

beforeEach(() => { kdb.reset(); espia.reiniciar(); });

describe('TC-19 — soportesDeSoat() no devuelve documentos adicionales', () => {
  it.each([['admin'], ['proveedor'], ['auditor']])('rol interno %s: la consulta lleva `tipo NOT IN (documento_adicional_soat)`', async (rol) => {
    kdb.when.select('flito_soportes', []);
    await soportesDeSoat(SOAT_ID, { rol, externo: false, estadoSoat: 'solicitado' } as never);
    const [q] = lecturasDeSoportes();
    expect(q, 'la lectura por soat_id se emitió').toBeDefined();
    const m = /"flito_soportes"\."tipo" not in \(\$(\d+)\)/.exec(q.sql);
    expect(m, q.sql).not.toBeNull();
    expect(q.params[Number(m![1]) - 1]).toBe(TIPO);
  });

  it('rol externo (cliente): sigue la allowlist Y también la exclusión', async () => {
    kdb.when.select('flito_soportes', []);
    await soportesDeSoat(SOAT_ID, { rol: 'cliente', externo: true, estadoSoat: 'pagado' } as never);
    const [q] = lecturasDeSoportes();
    expect(q, 'en `pagado` el cliente sí tiene tipos visibles: la lectura se emite').toBeDefined();
    expect(q.sql).toMatch(/"flito_soportes"\."tipo" not in/);
    expect(q.params).toContain(TIPO);
  });

  it('la lista de exclusión es exactamente el tipo nuevo', () => {
    expect([...TIPOS_SOPORTE_FUERA_DE_LISTA]).toEqual([TIPO]);
  });
});

describe('TC-20 — el ZIP de soportes no incluye documentos adicionales', () => {
  it('el tipo nuevo no está en la allowlist del ZIP', () => {
    expect(Object.values(TipoSoporteZip)).not.toContain(TIPO);
  });
});

describe('TC-21 — la exportación del pago no lee documentos adicionales', () => {
  it('la lectura por lote filtra `tipo = factura_soat`', async () => {
    kdb.when.select('flito_soportes', []);
    await fechasComprobantePorSoat([SOAT_ID]);
    const [q] = lecturasDeSoportes();
    const m = /"flito_soportes"\."tipo" = \$(\d+)/.exec(q.sql);
    expect(m, q.sql).not.toBeNull();
    expect(q.params[Number(m![1]) - 1]).toBe(TipoSoporte.FACTURA_SOAT);
  });
});
