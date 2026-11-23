// HU #14673 (Feature F5 #14327, ADR-0039 §5.2) — la 0313 mantiene las columnas viejas de los perfiles como espejo del
// padre mientras existan, ahora que el código ya no las declara ni las escribe (AC3, AC5).
//
// Estática (siempre) + contra PostgreSQL solo con TEST_DATABASE_URL, todo en una transacción con ROLLBACK: la base local
// la comparten otras sesiones y la 0313 se aplica dentro de la transacción.
//
// Mutantes que mata: quitar la rama «padre existe» de `perfil_crea_padre` (el perfil insertado solo con `id` violaría el
// NOT NULL de `nombre`); quitar el vaciado de la baja de logística (NIT, contacto y teléfono seguirían en el perfil);
// quitar la copia al reactivar (el espejo quedaría desfasado del padre).
process.env.TZ = 'UTC';

import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { abrirBase, enTx, leerMigracion, URL_BASE } from '../helpers/base-en-tx.js';

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));

const ARCHIVO = '0313_flito_proveedores_perfil_espejo.sql';
const SQL = leerMigracion(ARCHIVO);
const SIN_COMENTARIOS = SQL.replace(/--[^\n]*/g, '');

describe('0313 — reglas del archivo (estática)', () => {
  it('sin control de transacción propio y con lock_timeout', () => {
    expect(scanForTxControl(ARCHIVO, SQL)).toEqual([]);
    expect(SIN_COMENTARIOS).toMatch(/SET LOCAL lock_timeout = '30s';/);
  });

  it('idempotente: CREATE OR REPLACE y DROP TRIGGER IF EXISTS antes de cada CREATE TRIGGER', () => {
    expect(SIN_COMENTARIOS).toMatch(/CREATE OR REPLACE FUNCTION flito_proveedor_perfil_crea_padre\(\)/);
    expect(SIN_COMENTARIOS).toMatch(/CREATE OR REPLACE FUNCTION flito_proveedor_perfil_espejo_baja\(\)/);
    for (const tabla of ['flito_proveedores_soat', 'flito_proveedores_logistica']) {
      expect(SIN_COMENTARIOS).toMatch(new RegExp(
        `DROP TRIGGER IF EXISTS perfil_espejo_baja ON ${tabla};\\s*CREATE TRIGGER perfil_espejo_baja BEFORE UPDATE OF deleted_at ON ${tabla}`,
      ));
    }
  });

  it('no toca columnas, tablas ni los triggers de sincronización que no cambian', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/\b(ALTER TABLE|DROP COLUMN|DROP TABLE|DROP FUNCTION)\b/i);
    expect(SIN_COMENTARIOS).not.toMatch(/flito_proveedor_padre_a_perfil|flito_proveedor_perfil_a_padre|users_proveedor_sincroniza/);
  });
});

type Tx = postgres.TransactionSql;
const sufijo = () => randomUUID().slice(0, 8);

async function crearPadre(tx: Tx, datos: { nit?: string | null; contacto?: string | null; telefono?: string | null } = {}) {
  const nombre = `Prov 0313 ${sufijo()}`;
  const [p] = await tx`INSERT INTO flito_proveedores (nombre, nit, contacto, telefono)
    VALUES (${nombre}, ${datos.nit ?? null}, ${datos.contacto ?? null}, ${datos.telefono ?? null}) RETURNING id, nombre`;
  return { id: p!.id as string, nombre };
}

const logistica = async (tx: Tx, id: string) =>
  (await tx`SELECT nombre, activo, estrategia, nit, contacto, telefono, deleted_at FROM flito_proveedores_logistica WHERE id = ${id}`)[0]!;
const soat = async (tx: Tx, id: string) =>
  (await tx`SELECT nombre, activo, estrategia, deleted_at FROM flito_proveedores_soat WHERE id = ${id}`)[0]!;
const padre = async (tx: Tx, id: string) =>
  (await tx`SELECT nombre, activo, nit, contacto, telefono, deleted_at FROM flito_proveedores WHERE id = ${id}`)[0]!;

describe.skipIf(!URL_BASE)('0313 — contra PostgreSQL (tx con ROLLBACK)', () => {
  const conLa0313 = async (fn: (tx: Tx) => Promise<void>) => {
    const sql = abrirBase();
    try {
      await enTx(sql, async (tx) => {
        await tx.unsafe(SQL);
        await fn(tx);
      });
    } finally { await sql.end(); }
  };

  it('AC5: aplicada dos veces, sin error y sin cambiar las funciones ni los triggers', async () => {
    const sql = abrirBase();
    try {
      await enTx(sql, async (tx) => {
        const leer = async () => tx`
          SELECT p.proname, md5(p.prosrc) AS cuerpo FROM pg_proc p
           WHERE p.proname IN ('flito_proveedor_perfil_crea_padre', 'flito_proveedor_perfil_espejo_baja')
          UNION ALL
          SELECT t.tgrelid::regclass::text || '.' || t.tgname, pg_get_triggerdef(t.oid) FROM pg_trigger t
           WHERE t.tgname IN ('perfil_espejo_baja', 'perfil_crea_padre', 'perfil_a_padre') AND NOT t.tgisinternal
          ORDER BY 1`;
        await tx.unsafe(SQL);
        const primera = await leer();
        await tx.unsafe(SQL);
        expect(await leer()).toEqual(primera);
        expect(primera.filter((f) => String(f.proname).endsWith('.perfil_espejo_baja'))).toHaveLength(2);
      });
    } finally { await sql.end(); }
  });

  it('AC3: crear los perfiles solo con su id → el espejo es igual al padre (y logística toma su estrategia por DEFAULT)', async () => {
    await conLa0313(async (tx) => {
      const p = await crearPadre(tx, { nit: `9${Date.now() % 1e8}-1`, contacto: 'Ana', telefono: '3000000000' });
      await tx`UPDATE flito_proveedores SET activo = false WHERE id = ${p.id}`;
      await tx`INSERT INTO flito_proveedores_logistica (id) VALUES (${p.id})`;
      await tx`INSERT INTO flito_proveedores_soat (id, estrategia) VALUES (${p.id}, 'portal')`;

      const padreFila = await padre(tx, p.id);
      expect(await logistica(tx, p.id)).toMatchObject({
        nombre: p.nombre, activo: false, estrategia: 'pwa_propia',
        nit: padreFila.nit, contacto: 'Ana', telefono: '3000000000',
      });
      expect(await soat(tx, p.id)).toMatchObject({ nombre: p.nombre, activo: false, estrategia: 'portal' });
    });
  });

  it('AC3: retirar logística vacía NIT, contacto y teléfono del perfil, no del padre (RN-PSERV-4)', async () => {
    await conLa0313(async (tx) => {
      const p = await crearPadre(tx, { nit: `8${Date.now() % 1e8}-2`, contacto: 'Luis', telefono: '3111111111' });
      await tx`INSERT INTO flito_proveedores_soat (id) VALUES (${p.id})`;
      await tx`INSERT INTO flito_proveedores_logistica (id) VALUES (${p.id})`;

      await tx`UPDATE flito_proveedores_logistica SET deleted_at = now() WHERE id = ${p.id}`;

      expect(await logistica(tx, p.id)).toMatchObject({ nit: null, contacto: null, telefono: null, nombre: p.nombre });
      // SOAT sigue vigente: el padre conserva sus datos (la 0293 no sube nada de un perfil de baja).
      expect(await padre(tx, p.id)).toMatchObject({ contacto: 'Luis', telefono: '3111111111', deleted_at: null });
    });
  });

  it('AC3: reactivar copia el espejo del padre, también lo que cambió mientras el perfil estaba de baja', async () => {
    await conLa0313(async (tx) => {
      const p = await crearPadre(tx, { contacto: 'Eva', telefono: '3222222222' });
      await tx`INSERT INTO flito_proveedores_soat (id) VALUES (${p.id})`;
      await tx`INSERT INTO flito_proveedores_logistica (id) VALUES (${p.id})`;
      // Uno de los dos queda siempre vigente: retirar el último perfil es eliminar el proveedor (perfil_a_padre, 0293).
      // Logística de baja: el padre cambia y padre_a_perfil no se lo copia a un perfil de logística de baja.
      await tx`UPDATE flito_proveedores_logistica SET deleted_at = now() WHERE id = ${p.id}`;
      const nuevoNombre = `Prov 0313 renombrado ${sufijo()}`;
      await tx`UPDATE flito_proveedores SET contacto = 'Eva Nueva', nombre = ${nuevoNombre} WHERE id = ${p.id}`;
      expect(await logistica(tx, p.id)).toMatchObject({ contacto: null, telefono: null });
      await tx`UPDATE flito_proveedores_logistica SET deleted_at = NULL WHERE id = ${p.id}`;
      expect(await logistica(tx, p.id)).toMatchObject({
        nombre: nuevoNombre, activo: true, contacto: 'Eva Nueva', telefono: '3222222222', deleted_at: null,
      });

      // SOAT de baja y desfasado a mano: perfil_a_padre no sube nada de un perfil de baja.
      await tx`UPDATE flito_proveedores_soat SET deleted_at = now() WHERE id = ${p.id}`;
      await tx`UPDATE flito_proveedores_soat SET nombre = ${`desfasado ${sufijo()}`}, activo = false WHERE id = ${p.id}`;
      await tx`UPDATE flito_proveedores_soat SET deleted_at = NULL WHERE id = ${p.id}`;
      expect(await soat(tx, p.id)).toMatchObject({ nombre: nuevoNombre, activo: true, deleted_at: null });
      expect(await padre(tx, p.id)).toMatchObject({ nombre: nuevoNombre, contacto: 'Eva Nueva', activo: true });
    });
  });

  it('AC3: la imagen anterior (#14354) sigue funcionando: manda las columnas viejas al crear, retirar y reactivar', async () => {
    await conLa0313(async (tx) => {
      // Alta de SOAT sin padre (seed anterior): `perfil_crea_padre` conserva el cuerpo de la 0292 y crea el padre.
      const huerfano = randomUUID();
      const nombreHuerfano = `Prov 0313 viejo ${sufijo()}`;
      await tx`INSERT INTO flito_proveedores_soat (id, nombre, estrategia, activo) VALUES (${huerfano}, ${nombreHuerfano}, 'portal', true)`;
      expect(await padre(tx, huerfano)).toMatchObject({ nombre: nombreHuerfano, activo: true });
      expect(await soat(tx, huerfano)).toMatchObject({ nombre: nombreHuerfano });

      // `crearProveedor` anterior: padre primero y el perfil con los datos generales repetidos.
      const p = await crearPadre(tx, { contacto: 'Old', telefono: '3333333333' });
      await tx`INSERT INTO flito_proveedores_logistica (id, nombre, estrategia, activo, contacto, telefono)
        VALUES (${p.id}, ${p.nombre}, 'pwa_propia', true, 'Old', '3333333333')`;
      expect(await logistica(tx, p.id)).toMatchObject({ nombre: p.nombre, contacto: 'Old', telefono: '3333333333' });

      // `retirarPerfil` y `darPerfil` anteriores: escriben ellas mismas el vaciado y la copia.
      await tx`INSERT INTO flito_proveedores_soat (id, nombre) VALUES (${p.id}, ${p.nombre})`;
      await tx`UPDATE flito_proveedores_logistica SET deleted_at = now(), nit = NULL, contacto = NULL, telefono = NULL WHERE id = ${p.id}`;
      expect(await logistica(tx, p.id)).toMatchObject({ contacto: null, telefono: null });
      await tx`UPDATE flito_proveedores_logistica SET nombre = ${p.nombre}, activo = true, contacto = 'Old', telefono = '3333333333',
        deleted_at = NULL, deleted_by = NULL WHERE id = ${p.id}`;
      expect(await logistica(tx, p.id)).toMatchObject({ nombre: p.nombre, contacto: 'Old', telefono: '3333333333', deleted_at: null });
      expect(await padre(tx, p.id)).toMatchObject({ contacto: 'Old', telefono: '3333333333', deleted_at: null });
    });
  });
});
