// HU #14147 (Feature C1 #14091, ADR-0030 §17.1/§17.4) — qué LT cuentan como «pendientes de firma»: la regla vive en
// SQL, así que se prueba contra PostgreSQL (TEST_DATABASE_URL; sin ella se SALTA) dentro de una tx con ROLLBACK.
// Cada regla tiene su caso que la DISCRIMINA: propia vs ajena, ya con acta, ya firmada, ya sin pendiente y estado.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type postgres from 'postgres';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { abrirBase, enTx, URL_BASE } from '../helpers/base-en-tx.js';

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { condicionPendientesFirma } = await import('../../src/modules/flito-logistica/flito-logistica.pendientes-firma.js');
const { flitoLogisticaDocumentos } = await import('../../src/db/schema.js');

describe.skipIf(!URL_BASE)('LT pendientes de firma — regla de selección contra PostgreSQL (HU #14147)', () => {
  let sql: postgres.Sql;
  beforeAll(() => { sql = abrirBase(); });
  afterAll(async () => { await sql?.end(); });

  it('lista solo las propias, sin acta, sin firma, con pendiente y en estado confirmable; operar_ajenas lista todas', async () => {
    const r = await enTx(sql, async (tx) => {
      const [org] = await tx`SELECT codigo FROM organismos_transito_config LIMIT 1`;
      const sello = String(Date.now()).slice(-8);
      const usuario = async (n: string) => (await tx`INSERT INTO users (username, name, password_hash, role) VALUES (${`hu14147-${n}-${sello}`}, ${`HU14147 ${n}`}, 'x', 'mensajero') RETURNING id`)[0]!.id as number;
      const yo = await usuario('yo'); const otro = await usuario('otro');
      const [cli] = await tx`INSERT INTO clients (name, document) VALUES (${`HU14147 ${sello}`}, ${`14147-${sello}`}) RETURNING id`;
      const [fir] = await tx`INSERT INTO flito_logistica_recogida_firmantes (id, organismo_codigo, nombre, firma_storage_key, registrado_por_id)
        VALUES (gen_random_uuid(), ${org!.codigo}, 'F', 'k', ${yo}) RETURNING id`;
      let n = 0;
      const doc = async (nombre: string, o: { actor?: number; estado?: string; pendiente?: boolean; firmante?: boolean; conActa?: boolean }) => {
        const [v] = await tx`INSERT INTO vehicles (plate) VALUES (${`H${sello.slice(-4)}${n++}`}) RETURNING id`;
        const [d] = await tx`INSERT INTO flito_logistica_documentos (tipo, estado, organismo_codigo, vehiculo_id, identificador, acta_organismo_pendiente, recogida_firmante_id)
          VALUES ('licencia_transito', ${o.estado ?? 'recogido'}, ${org!.codigo}, ${v!.id}, ${nombre}, ${o.pendiente ?? true}, ${o.firmante ? fir!.id : null}) RETURNING id`;
        await tx`INSERT INTO flito_logistica_documento_eventos (documento_id, estado_anterior, estado_nuevo, actor_id, origen) VALUES (${d!.id}, NULL, 'recogido', ${o.actor ?? yo}, 'usuario')`;
        if (o.conActa) {
          const [a] = await tx`INSERT INTO flito_logistica_actas (compania_id, punto, organismo_codigo, firmante_id, estado) VALUES (${cli!.id}, 'organismo', ${org!.codigo}, ${fir!.id}, 'entregada') RETURNING id`;
          await tx`INSERT INTO flito_logistica_acta_lineas (acta_id, documento_id, punto, compania_id) VALUES (${a!.id}, ${d!.id}, 'organismo', ${cli!.id})`;
        }
        return d!.id as string;
      };
      const ids = {
        propia: await doc('propia', {}),
        propiaClasificada: await doc('clasificada', { estado: 'clasificado' }),
        ajena: await doc('ajena', { actor: otro }),
        conActa: await doc('conActa', { conActa: true }),
        yaFirmada: await doc('yaFirmada', { firmante: true }),
        sinPendiente: await doc('sinPendiente', { pendiente: false }),
        estadoNoConfirmable: await doc('novedad', { estado: 'novedad' }),
      };
      const q = (operaAjenas: boolean) => {
        const cond = condicionPendientesFirma({ userId: yo, username: 'u', role: 'mensajero', operaAjenas });
        const { sql: texto, params } = new QueryBuilder().select({ id: flitoLogisticaDocumentos.id }).from(flitoLogisticaDocumentos).where(cond).toSQL();
        return tx.unsafe(texto, params as never[]).values();
      };
      const propias = new Set((await q(false)).map((f) => f[0] as string));
      const todas = new Set((await q(true)).map((f) => f[0] as string));
      return { ids, propias, todas };
    });
    const { ids, propias, todas } = r;
    expect(propias.has(ids.propia)).toBe(true);
    expect(propias.has(ids.propiaClasificada)).toBe(true); // estado confirmable distinto de recogido
    expect(propias.has(ids.ajena)).toBe(false);            // LT de otro usuario no se lista
    expect(propias.has(ids.conActa)).toBe(false);          // ya con acta de organismo
    expect(propias.has(ids.yaFirmada)).toBe(false);        // la pendiente de trámite ya firmada no se vuelve a firmar
    expect(propias.has(ids.sinPendiente)).toBe(false);     // acta_organismo_pendiente = false
    expect(propias.has(ids.estadoNoConfirmable)).toBe(false);
    expect(todas.has(ids.ajena)).toBe(true);               // operar_ajenas lista las de todos…
    expect(todas.has(ids.conActa) || todas.has(ids.yaFirmada) || todas.has(ids.sinPendiente) || todas.has(ids.estadoNoConfirmable)).toBe(false); // …pero no las que no aplican
  });
});
