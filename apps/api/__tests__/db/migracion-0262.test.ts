// HU #13967 (AC8/AC9) — Migración 0262: «SOAT sin trámite» por proveedor.
//
// Estático (siempre corre): el archivo trae el conteo previo y el aviso de `pg_dump`, no hace DROP
// COLUMN, retira el CHECK con IF EXISTS y su renombre es parseable (sin «;» en los textos).
// Contra PostgreSQL (solo con `TEST_DATABASE_URL`, en una tx con ROLLBACK): las compañías cerradas
// pierden el proveedor, las abiertas lo conservan, el CHECK se va, la acción se renombra y la segunda
// pasada no cambia nada.
import { describe, it, expect } from 'vitest';
import { abrirBase, enTx, leerMigracion, URL_BASE } from '../helpers/base-en-tx.js';
import { leerRenombresSembrados } from '../helpers/permisos-seed-sql.js';
import { catalogoCompleto } from '../../src/modules/permisos/catalogo.js';

const ARCHIVO = '0262_flito_soat_canal_por_proveedor.sql';
const SQL = leerMigracion(ARCHIVO);
const sinComentarios = SQL.replace(/--[^\n]*/g, '');
const NOMBRE = 'Elegir proveedor de SOAT sin trámite';
const DESCRIPCION = 'Elegir el proveedor al que van los SOAT sin trámite de un cliente.';

describe('0262 — el archivo', () => {
  it('AC8: la cabecera documenta el conteo previo para PDN y el `pg_dump`', () => {
    expect(SQL).toMatch(/count\(\*\) FILTER \(WHERE soat_sin_tramite\) AS abiertas/);
    expect(SQL).toMatch(/AS pierden_proveedor/);
    expect(SQL).toMatch(/AS incoherentes_debe_ser_0/);
    expect(SQL).toMatch(/pg_dump/);
  });

  it('AC8: no borra la columna obsoleta y retira el CHECK de forma idempotente', () => {
    expect(sinComentarios).not.toMatch(/DROP COLUMN/i);
    expect(sinComentarios).toMatch(/ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_sin_tramite_gestor_chk;/);
    expect(sinComentarios).toMatch(/information_schema\.columns/);
  });

  it('AC9: el renombre se lee igual que lo siembran los demás (código intacto) y coincide con el catálogo', () => {
    const renombres = leerRenombresSembrados([ARCHIVO]);
    expect(renombres.get('accion.clientes.soat_sin_tramite')).toEqual({ nombre: NOMBRE, descripcion: DESCRIPCION });
    const enCatalogo = catalogoCompleto().find((f) => f.codigo === 'accion.clientes.soat_sin_tramite');
    expect(enCatalogo).toMatchObject({ nombreNegocio: NOMBRE, descripcion: DESCRIPCION });
  });
});

describe.skipIf(!URL_BASE)('0262 — contra PostgreSQL (tx con ROLLBACK)', () => {
  it('AC8: cerradas sin proveedor, abiertas con el suyo, CHECK fuera, acción renombrada; la 2.ª pasada no cambia nada', async () => {
    const sql = abrirBase();
    try {
      await enTx(sql, async (tx) => {
        const [p] = await tx`INSERT INTO flito_proveedores_soat (nombre) VALUES ('zz_prueba13967 gestor') RETURNING id`;
        // El CHECK de la 0175 tal como estaba (si esta base ya aplicó la 0262, se repone dentro de la tx).
        await tx.unsafe(`ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_sin_tramite_gestor_chk;
          ALTER TABLE clients ADD CONSTRAINT clients_sin_tramite_gestor_chk
            CHECK (soat_sin_tramite = false OR flito_proveedor_soat_sin_tramite_id IS NOT NULL)`);
        await tx`UPDATE permisos_funciones SET nombre_negocio = 'Configurar «SOAT sin trámite»' WHERE codigo = 'accion.clientes.soat_sin_tramite'`;
        const [abierta] = await tx`INSERT INTO clients (name, soat_sin_tramite, flito_proveedor_soat_sin_tramite_id)
          VALUES ('zz_prueba13967 abierta', true, ${p!.id}) RETURNING id`;
        const [cerrada] = await tx`INSERT INTO clients (name, soat_sin_tramite, flito_proveedor_soat_sin_tramite_id)
          VALUES ('zz_prueba13967 cerrada', false, ${p!.id}) RETURNING id`;

        await tx.unsafe(SQL);

        const estado = async () => tx`SELECT id, flito_proveedor_soat_sin_tramite_id AS prov FROM clients
          WHERE id IN (${abierta!.id}, ${cerrada!.id}) ORDER BY id`;
        expect(await estado()).toEqual([
          { id: abierta!.id, prov: p!.id },
          { id: cerrada!.id, prov: null },
        ]);
        expect(await tx`SELECT 1 FROM pg_constraint WHERE conname = 'clients_sin_tramite_gestor_chk'`).toHaveLength(0);
        const [f] = await tx`SELECT nombre_negocio, descripcion FROM permisos_funciones WHERE codigo = 'accion.clientes.soat_sin_tramite'`;
        expect(f).toEqual({ nombre_negocio: NOMBRE, descripcion: DESCRIPCION });
        // La columna obsoleta sigue ahí (#13968), con su DEFAULT.
        const [col] = await tx`SELECT column_default FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'clients' AND column_name = 'soat_sin_tramite'`;
        expect(col?.column_default).toBe('false');

        // Idempotente: la segunda pasada no cambia nada.
        const antes = await estado();
        await tx.unsafe(SQL);
        expect(await estado()).toEqual(antes);
      });
    } finally { await sql.end(); }
  });
});
