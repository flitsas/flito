// HU #14349 (Feature #14326, ADR-0039 §6.3) — la fecha de corte y la normalización de dueños, contra PostgreSQL de verdad y
// dentro de una transacción con ROLLBACK (se SALTA sin TEST_DATABASE_URL). Cada caso borra la tabla y aplica la 0298 entera:
// en una transacción `now()` no avanza, así que lo «anterior al corte» se fabrica con `created_at` en el pasado.
import { describe, it, expect } from 'vitest';
import type postgres from 'postgres';
import { abrirBase, enTx, leerMigracion, URL_BASE } from '../helpers/base-en-tx.js';

type Tx = postgres.TransactionSql;
const MIGRACION = leerMigracion('0298_flito_logistica_corte_proveedor.sql');
const AYER = new Date(Date.now() - 86_400_000).toISOString();
const TRAS_EL_CORTE = new Date(Date.now() + 3_600_000).toISOString(); // `now()` no avanza en la tx y un Date recorta los microsegundos
let n = 0;
const sello = () => `${String(Date.now()).slice(-6)}${n++}`;

interface Mundo {
  tx: Tx; A: string; B: string;
  aplicar: () => Promise<void>;
  cia: (proveedor: string | null) => Promise<number>;
  doc: (cia: number | null, o?: { estado?: string; dueno?: string | null; tipo?: string; creado?: string; actaId?: string }) => Promise<string>;
  acta: (cia: number, estado: string, o?: { dueno?: string | null; creado?: string }) => Promise<string>;
  linea: (actaId: string, documentoId: string, cia: number) => Promise<void>;
  dueno: (id: string) => Promise<string | null>;
  corte: () => Promise<Date>;
}

async function conMundo(fn: (m: Mundo) => Promise<void>) {
  const sql = abrirBase();
  try {
    await enTx(sql, async (tx) => {
      await tx`DROP TABLE IF EXISTS flito_logistica_corte_proveedor`;
      const prov = async (nombre: string) => (await tx`INSERT INTO flito_proveedores_logistica (nombre, activo, nit)
        VALUES (${`${nombre} ${sello()}`}, true, ${`9${sello()}`}) RETURNING id`)[0]!.id as string;
      const A = await prov('Proveedor A'); const B = await prov('Proveedor B');
      const org = (await tx`SELECT codigo FROM organismos_transito_config LIMIT 1`)[0]?.codigo as string
        ?? (await tx`INSERT INTO organismos_transito_config (codigo, activo) VALUES ('99999', true) RETURNING codigo`)[0]!.codigo as string;
      await fn({
        tx, A, B,
        aplicar: async () => { await tx.unsafe(MIGRACION); },
        cia: async (proveedor) => (await tx`INSERT INTO clients (name, document, flito_proveedor_logistica_id, logistica_autogestionable)
          VALUES (${`Cia ${sello()}`}, ${`D${sello()}`}, ${proveedor}, false) RETURNING id`)[0]!.id as number,
        doc: async (cia, o = {}) => {
          const placa = `Z${sello().slice(-6)}`;
          const [v] = await tx`INSERT INTO vehicles (plate, vin) VALUES (${placa}, ${`VIN${placa}`}) RETURNING id`;
          const tramite = cia === null ? null : (await tx`INSERT INTO flito_tramites (id_flit, sincronizado_en, vehiculo_id, compania_id, compania_nit, organismo_codigo, flit_estado)
            VALUES (${`F${sello()}`}, now(), ${v!.id}, ${cia}, '900', ${org}, 'Aprobado') RETURNING id`)[0]!.id as string;
          return (await tx`INSERT INTO flito_logistica_documentos (tramite_id, tipo, estado, organismo_codigo, compania_id, vehiculo_id, proveedor_logistica_id, acta_id, created_at)
            VALUES (${tramite}, ${o.tipo ?? 'licencia_transito'}, ${o.estado ?? 'clasificado'}, ${org}, ${cia}, ${v!.id}, ${o.dueno ?? null}, ${o.actaId ?? null}, ${o.creado ?? AYER}) RETURNING id`)[0]!.id as string;
        },
        acta: async (cia, estado, o = {}) => (await tx`INSERT INTO flito_logistica_actas (compania_id, punto, estado, proveedor_logistica_id, created_at)
          VALUES (${cia}, 'cliente', ${estado}, ${o.dueno ?? null}, ${o.creado ?? AYER}) RETURNING id`)[0]!.id as string,
        linea: async (actaId, documentoId, cia) => {
          await tx`INSERT INTO flito_logistica_acta_lineas (acta_id, documento_id, punto, compania_id) VALUES (${actaId}, ${documentoId}, 'cliente', ${cia})`;
        },
        dueno: async (id) => (await tx`SELECT proveedor_logistica_id p FROM flito_logistica_documentos WHERE id = ${id}`)[0]!.p as string | null,
        corte: async () => (await tx`SELECT corte_en FROM flito_logistica_corte_proveedor`)[0]!.corte_en as Date,
      });
    });
  } finally { await sql.end(); }
}

describe.skipIf(!URL_BASE)('fecha de corte del proveedor (PostgreSQL, tx con ROLLBACK)', () => {
  describe('AC1 — registro al desplegar', () => {
    it('sin fecha, la migración deja exactamente una, sin ningún dato de entrada', () => conMundo(async ({ tx, aplicar }) => {
      await aplicar();
      const filas = await tx`SELECT unica, corte_en, (corte_en = now()) AS con_now FROM flito_logistica_corte_proveedor`;
      expect(filas).toHaveLength(1);
      expect(filas[0]!.con_now).toBe(true);
    }));

    it.each([[true, 'la PK no admite una segunda fila'], [false, 'el CHECK no admite otro valor de `unica`']])(
      'INSERT con unica=%s falla: %s', (unica) => conMundo(async ({ tx, aplicar }) => {
        await aplicar();
        await expect(tx.savepoint((sp) => sp`INSERT INTO flito_logistica_corte_proveedor (unica, corte_en) VALUES (${unica}, now())`)).rejects.toThrow();
        expect((await tx`SELECT count(*)::int AS c FROM flito_logistica_corte_proveedor`)[0]!.c).toBe(1);
      }),
    );
  });

  describe('AC2 — la fecha no se mueve', () => {
    it('reaplicar la migración conserva el valor registrado', () => conMundo(async ({ tx, aplicar, corte }) => {
      await aplicar();
      await tx`UPDATE flito_logistica_corte_proveedor SET corte_en = ${AYER}`;
      const antes = await corte();
      await aplicar();
      expect(await corte()).toEqual(antes);
      expect(antes.toISOString()).toBe(AYER);
    }));
  });

  describe('AC5 — licencia anterior sin terminar y sin acta abierta', () => {
    it('queda con el proveedor actual de su compañía, aunque tuviera otro dueño', () => conMundo(async ({ A, B, aplicar, cia, doc, dueno }) => {
      const c = await cia(A);
      const sinDueno = await doc(c);
      const conOtro = await doc(c, { dueno: B });
      await aplicar();
      expect(await dueno(sinDueno)).toBe(A);
      expect(await dueno(conOtro)).toBe(A);
    }));

    it('con su acta ya cerrada, también pasa al proveedor actual', () => conMundo(async ({ A, aplicar, cia, acta, doc, dueno }) => {
      const c = await cia(A);
      const cerrada = await acta(c, 'devuelta');
      const d = await doc(c, { estado: 'devuelto', actaId: cerrada });
      await aplicar();
      expect(await dueno(d)).toBe(A);
    }));

    it('si la compañía no tiene proveedor, queda sin dueño', () => conMundo(async ({ A, aplicar, cia, doc, dueno }) => {
      const d = await doc(await cia(null), { dueno: A });
      await aplicar();
      expect(await dueno(d)).toBeNull();
    }));

    it('una compañía autogestionada queda sin dueño, aunque conserve un proveedor asignado (decisión del agente, declarada)', () => conMundo(async ({ tx, A, aplicar, cia, doc, dueno }) => {
      const c = await cia(A);
      await tx`UPDATE clients SET logistica_autogestionable = true WHERE id = ${c}`;
      const d = await doc(c, { dueno: A });
      await aplicar();
      expect(await dueno(d)).toBeNull();
    }));

    it('una licencia pendiente de trámite, sin compañía, queda sin dueño', () => conMundo(async ({ A, aplicar, doc, dueno }) => {
      const d = await doc(null, { dueno: A });
      await aplicar();
      expect(await dueno(d)).toBeNull();
    }));
  });

  describe('AC6 — licencias que quedan con Operaciones', () => {
    it('entregada con dueño estampado → sin dueño', () => conMundo(async ({ A, aplicar, cia, doc, dueno }) => {
      const d = await doc(await cia(A), { estado: 'entregado', dueno: A });
      await aplicar();
      expect(await dueno(d)).toBeNull();
    }));

    it.each(['generada', 'despachada'])('en un acta %s anterior, por `documentos.acta_id` → sin dueño', (estado) => conMundo(async ({ A, aplicar, cia, acta, doc, dueno }) => {
      const c = await cia(A);
      const d = await doc(c, { dueno: A, actaId: await acta(c, estado, { dueno: A }) });
      await aplicar();
      expect(await dueno(d)).toBeNull();
    }));

    it('en un acta abierta anterior, solo por las líneas del acta → sin dueño', () => conMundo(async ({ A, aplicar, cia, acta, doc, linea, dueno }) => {
      const c = await cia(A);
      const d = await doc(c, { dueno: A });
      await linea(await acta(c, 'generada', { dueno: A }), d, c);
      await aplicar();
      expect(await dueno(d)).toBeNull();
    }));

    it('aplicar la normalización dos veces da el mismo resultado', () => conMundo(async ({ A, aplicar, cia, acta, doc, dueno }) => {
      const c = await cia(A);
      const ids = [await doc(c), await doc(c, { estado: 'entregado', dueno: A }), await doc(c, { dueno: A, actaId: await acta(c, 'generada') }), await doc(await cia(null), { dueno: A })];
      await aplicar();
      const primera = await Promise.all(ids.map(dueno));
      await aplicar();
      expect(await Promise.all(ids.map(dueno))).toEqual(primera);
      expect(primera).toEqual([A, null, null, null]);
    }));
  });

  describe('la segunda corrida no deshace lo que pasó después del corte', () => {
    it('no toca una licencia que el proveedor entregó después del corte', () => conMundo(async ({ tx, A, aplicar, cia, doc, dueno }) => {
      const d = await doc(await cia(A));
      await aplicar();
      await tx`UPDATE flito_logistica_documentos SET estado = 'entregado' WHERE id = ${d}`;
      await aplicar();
      expect(await dueno(d)).toBe(A);
    }));

    it('no toca una licencia cuya compañía se quedó sin proveedor (quitar el proveedor no reasigna)', () => conMundo(async ({ tx, A, aplicar, cia, doc, dueno }) => {
      const c = await cia(A);
      const d = await doc(c);
      await aplicar();
      await tx`UPDATE clients SET flito_proveedor_logistica_id = NULL WHERE id = ${c}`;
      await aplicar();
      expect(await dueno(d)).toBe(A);
    }));

    it('no entrega al proveedor nuevo una licencia que sigue con Operaciones hasta cerrar su acta', () => conMundo(async ({ tx, A, B, aplicar, cia, acta, doc, dueno }) => {
      const c = await cia(A);
      const abierta = await acta(c, 'generada');
      const d = await doc(c, { dueno: A, actaId: abierta });
      await aplicar();
      await tx`UPDATE clients SET flito_proveedor_logistica_id = ${B} WHERE id = ${c}`;
      await aplicar();
      expect(await dueno(d)).toBeNull();
    }));
  });

  describe('lo que no es de la normalización', () => {
    it('no toca una licencia creada desde el corte: se evalúa contra la fecha registrada', () => conMundo(async ({ A, B, aplicar, cia, doc, dueno }) => {
      const d = await doc(await cia(A), { dueno: B, creado: TRAS_EL_CORTE });
      await aplicar();
      expect(await dueno(d)).toBe(B);
    }));

    it('no toca una licencia anterior que está solo en un acta abierta posterior al corte', () => conMundo(async ({ A, B, aplicar, cia, acta, doc, dueno }) => {
      const c = await cia(A);
      const d = await doc(c, { dueno: B, actaId: await acta(c, 'generada', { dueno: B, creado: TRAS_EL_CORTE }) });
      await aplicar();
      expect(await dueno(d)).toBe(B);
    }));

    it('no toca documentos que no son licencia', () => conMundo(async ({ B, A, aplicar, cia, doc, dueno }) => {
      const d = await doc(await cia(A), { tipo: 'placa', dueno: B });
      await aplicar();
      expect(await dueno(d)).toBe(B);
    }));

    it('no cambia `updated_at`', () => conMundo(async ({ tx, A, aplicar, cia, doc, dueno }) => {
      const d = await doc(await cia(A));
      await tx`UPDATE flito_logistica_documentos SET updated_at = ${AYER} WHERE id = ${d}`;
      await aplicar();
      expect(await dueno(d)).toBe(A);
      const [f] = await tx`SELECT updated_at FROM flito_logistica_documentos WHERE id = ${d}`;
      expect((f!.updated_at as Date).toISOString()).toBe(AYER);
    }));
  });
});
