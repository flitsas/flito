// ADR-0045 — servicio de vistas de columnas contra PostgreSQL real, cada prueba dentro de una transacción
// que termina en ROLLBACK (helper `enTx`). Se SALTA sin TEST_DATABASE_URL: un skipped NO es verde.
// Cubre: pertenencia de punteros, cascadas (vista y usuario), límite de 20 personales, nombre duplicado
// (409), VERSION_CONFLICTO (409), COLUMNA_NO_PERMITIDA (403), CLAVE_DESCONOCIDA (422) y admin vs no admin.
import { describe, it, expect, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { abrirBase, enTx, URL_BASE } from '../helpers/base-en-tx.js';

const actual: { db: ReturnType<typeof drizzle<typeof schema>> | null } = { db: null };
vi.mock('../../src/db/client.js', () => ({
  db: new Proxy({}, {
    get(_t, prop) {
      if (prop === 'transaction') return (fn: (tx: unknown) => unknown) => fn(actual.db);
      const d = actual.db as unknown as Record<string | symbol, unknown>;
      const v = d[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(d) : v;
    },
  }),
  getPoolStats: vi.fn(),
}));

const svc = await import('../../src/modules/flito-vistas-columnas/flito-vistas-columnas.service.js');
const { TABLAS_VISTAS } = await import('../../src/modules/flito-vistas-columnas/flito-vistas-columnas.catalogo.js');
const tabla = TABLAS_VISTAS['flito-tramites'];

type Tx = postgres.TransactionSql;
const SIN_PII = new Set<string>();
const CON_PII = new Set<string>(['tramites.cola.ver']);

let n = 0;
const etiqueta = (base: string) => `${base}_${Date.now().toString(36)}_${n++}`;

/** Una prueba: transacción propia, `actual.db` apunta a ella y todo se deshace al salir. */
function prueba(fn: (tx: Tx) => Promise<void>) {
  return async () => {
    const sql = abrirBase();
    try {
      await enTx(sql, async (tx) => {
        actual.db = drizzle(Object.assign(tx, { options: sql.options }) as unknown as postgres.Sql, { schema });
        await fn(tx);
      });
    } finally {
      await sql.end();
    }
  };
}

// `auditor` como usuario sin admin: el rol `proveedor` exige un proveedor SOAT en la base (trigger), que aquí no aplica.
async function usuario(tx: Tx, rol = 'auditor'): Promise<number> {
  const [u] = await tx`INSERT INTO users (username, name, password_hash, role, active)
    VALUES (${etiqueta('vc_user')}, 'Prueba vistas', 'h', ${rol}, true) RETURNING id`;
  return u!.id as number;
}

const admin = (userId: number) => ({ userId, puedeAdministrar: true });
const noAdmin = (userId: number) => ({ userId, puedeAdministrar: false });

describe.skipIf(!URL_BASE)('ADR-0045 servicio de vistas de columnas (PostgreSQL real)', () => {
  it('una vista personal solo la ve su dueño; la predeterminada personal se resuelve al puntero', prueba(async (tx) => {
    const u1 = await usuario(tx);
    const u2 = await usuario(tx);
    const v = await svc.crearVista(tabla, noAdmin(u1), SIN_PII, { nombre: 'Cobranza', alcance: 'personal', columnas: ['fuente', 'creado'] });
    const del1 = await svc.listarVistas(tabla, noAdmin(u1), SIN_PII);
    const del2 = await svc.listarVistas(tabla, noAdmin(u2), SIN_PII);
    expect(del1.vistas.map((x) => x.id)).toContain(v.id);
    expect(del2.vistas.map((x) => x.id)).not.toContain(v.id);

    expect(del1.vistaActiva.origen).toBe('sistema');
    await svc.fijarPredeterminadaPersonal(tabla, noAdmin(u1), v.id);
    const tras = await svc.listarVistas(tabla, noAdmin(u1), SIN_PII);
    expect(tras.vistaActiva).toMatchObject({ id: v.id, origen: 'personal' });
    expect(tras.vistaActiva.columnas).toEqual(['tramite', 'fuente', 'creado']);
    expect(tras.vistas.find((x) => x.id === v.id)?.esPredeterminada).toBe(true);
    // Cada vista trae sus columnas efectivas (mismo cálculo que la vista activa), sin fijar el puntero.
    expect(tras.vistas.find((x) => x.id === v.id)?.columnas).toEqual(['tramite', 'fuente', 'creado']);
  }));

  it('VistaColumnas.columnas: intersecada con el permiso y con fijas primero; la vista no ve lo que no puede ver', prueba(async (tx) => {
    const u1 = await usuario(tx);
    const v = await svc.crearVista(tabla, noAdmin(u1), CON_PII, { nombre: 'Con PII', alcance: 'personal', columnas: ['correo', 'fuente', 'comprador'] });
    const sinPermiso = await svc.listarVistas(tabla, noAdmin(u1), SIN_PII);
    expect(sinPermiso.vistas.find((x) => x.id === v.id)?.columnas).toEqual(['tramite', 'fuente']);
    const conPermiso = await svc.listarVistas(tabla, noAdmin(u1), CON_PII);
    // Fija primero; luego, en el orden guardado en la vista.
    expect(conPermiso.vistas.find((x) => x.id === v.id)?.columnas).toEqual(['tramite', 'correo', 'fuente', 'comprador']);
  }));

  it('RN-VC6: el puntero personal no acepta una vista ajena ni una compartida', prueba(async (tx) => {
    const u1 = await usuario(tx);
    const u2 = await usuario(tx);
    const ajena = await svc.crearVista(tabla, noAdmin(u1), SIN_PII, { nombre: 'Ajena', alcance: 'personal', columnas: ['fuente'] });
    await expect(svc.fijarPredeterminadaPersonal(tabla, noAdmin(u2), ajena.id)).rejects.toMatchObject({ codigo: 'VISTA_NO_ENCONTRADA', status: 404 });
    const compartida = await svc.crearVista(tabla, admin(u1), SIN_PII, { nombre: 'Compartida', alcance: 'compartida', columnas: ['fuente'] });
    await expect(svc.fijarPredeterminadaPersonal(tabla, noAdmin(u2), compartida.id)).rejects.toMatchObject({ codigo: 'VISTA_NO_ENCONTRADA' });
  }));

  it('RN-VC6: el puntero general solo acepta vistas compartidas (422 si es personal)', prueba(async (tx) => {
    const u1 = await usuario(tx);
    const personal = await svc.crearVista(tabla, noAdmin(u1), SIN_PII, { nombre: 'Mia', alcance: 'personal', columnas: ['fuente'] });
    await expect(svc.fijarPredeterminadaGeneral(tabla, admin(u1), personal.id))
      .rejects.toMatchObject({ codigo: 'VISTA_NO_COMPARTIDA', status: 422 });
  }));

  it('«Restablecer» (personal a NULL) gana sobre la general', prueba(async (tx) => {
    const u1 = await usuario(tx);
    const compartida = await svc.crearVista(tabla, admin(u1), SIN_PII, { nombre: 'Para todos', alcance: 'compartida', columnas: ['fuente'] });
    await svc.fijarPredeterminadaGeneral(tabla, admin(u1), compartida.id);
    expect((await svc.listarVistas(tabla, noAdmin(u1), SIN_PII)).vistaActiva.origen).toBe('general');
    await svc.fijarPredeterminadaPersonal(tabla, noAdmin(u1), null);
    expect((await svc.listarVistas(tabla, noAdmin(u1), SIN_PII)).vistaActiva).toMatchObject({ id: null, origen: 'sistema' });
  }));

  it('cascada al borrar una vista: el puntero cae a la general, o al sistema si no hay general', prueba(async (tx) => {
    const u1 = await usuario(tx);
    const general = await svc.crearVista(tabla, admin(u1), SIN_PII, { nombre: 'General', alcance: 'compartida', columnas: ['fuente'] });
    await svc.fijarPredeterminadaGeneral(tabla, admin(u1), general.id);
    const personal = await svc.crearVista(tabla, noAdmin(u1), SIN_PII, { nombre: 'Propia', alcance: 'personal', columnas: ['ciudad'] });
    await svc.fijarPredeterminadaPersonal(tabla, noAdmin(u1), personal.id);
    await svc.borrarVista(tabla, noAdmin(u1), personal.id);
    expect((await svc.listarVistas(tabla, noAdmin(u1), SIN_PII)).vistaActiva.origen).toBe('general');

    await svc.fijarPredeterminadaGeneral(tabla, admin(u1), null);
    expect((await svc.listarVistas(tabla, noAdmin(u1), SIN_PII)).vistaActiva.origen).toBe('sistema');
  }));

  it('cascada al borrar un usuario: se van sus vistas personales y su puntero; la compartida se conserva sin creador', prueba(async (tx) => {
    const creador = await usuario(tx, 'admin');
    const u1 = await usuario(tx);
    const personal = await svc.crearVista(tabla, noAdmin(u1), SIN_PII, { nombre: 'Del que se va', alcance: 'personal', columnas: ['fuente'] });
    await svc.fijarPredeterminadaPersonal(tabla, noAdmin(u1), personal.id);
    const compartida = await svc.crearVista(tabla, admin(creador), SIN_PII, { nombre: 'Sobrevive', alcance: 'compartida', columnas: ['fuente'] });

    await tx`DELETE FROM users WHERE id = ${u1}`;
    const vistasPersonales = await tx`SELECT id FROM flito_vistas_columnas WHERE owner_user_id = ${u1}`;
    const puntero = await tx`SELECT id FROM flito_vistas_columnas_preferencias WHERE user_id = ${u1}`;
    expect(vistasPersonales).toHaveLength(0);
    expect(puntero).toHaveLength(0);

    await tx`DELETE FROM users WHERE id = ${creador}`;
    const [sobrevive] = await tx`SELECT id, creado_por_user_id FROM flito_vistas_columnas WHERE id = ${compartida.id}`;
    expect(sobrevive).toBeDefined();
    expect(sobrevive!.creado_por_user_id).toBeNull();
  }));

  it('límite: 20 vistas personales por usuario y tabla; la 21.ª responde 409 LIMITE_VISTAS', prueba(async (tx) => {
    const u1 = await usuario(tx);
    for (let i = 0; i < 20; i++) {
      await svc.crearVista(tabla, noAdmin(u1), SIN_PII, { nombre: `v${i}`, alcance: 'personal', columnas: ['fuente'] });
    }
    await expect(svc.crearVista(tabla, noAdmin(u1), SIN_PII, { nombre: 'v20', alcance: 'personal', columnas: ['fuente'] }))
      .rejects.toMatchObject({ codigo: 'LIMITE_VISTAS', status: 409 });
  }));

  it('nombre duplicado en el mismo alcance: 409 NOMBRE_DUPLICADO', prueba(async (tx) => {
    const u1 = await usuario(tx);
    await svc.crearVista(tabla, noAdmin(u1), SIN_PII, { nombre: 'Igual', alcance: 'personal', columnas: ['fuente'] });
    await expect(svc.crearVista(tabla, noAdmin(u1), SIN_PII, { nombre: 'Igual', alcance: 'personal', columnas: ['fuente'] }))
      .rejects.toMatchObject({ codigo: 'NOMBRE_DUPLICADO', status: 409 });
  }));

  it('versión desfasada: 409 VERSION_CONFLICTO y la vista no cambia', prueba(async (tx) => {
    const u1 = await usuario(tx);
    const v = await svc.crearVista(tabla, noAdmin(u1), SIN_PII, { nombre: 'Versionada', alcance: 'personal', columnas: ['fuente'] });
    await expect(svc.actualizarVista(tabla, noAdmin(u1), SIN_PII, v.id, { columnas: ['ciudad'], version: 99 }))
      .rejects.toMatchObject({ codigo: 'VERSION_CONFLICTO', status: 409 });
    const [fila] = await tx`SELECT columnas, version FROM flito_vistas_columnas WHERE id = ${v.id}`;
    expect(fila!.columnas).toEqual(['fuente']);
    expect(fila!.version).toBe(1);
    const ok = await svc.actualizarVista(tabla, noAdmin(u1), SIN_PII, v.id, { columnas: ['ciudad'], version: 1 });
    expect(ok.version).toBe(2);
  }));

  it('columna que el usuario no puede ver: 403 COLUMNA_NO_PERMITIDA al guardar, sin descarte silencioso', prueba(async (tx) => {
    const u1 = await usuario(tx);
    await expect(svc.crearVista(tabla, noAdmin(u1), SIN_PII, { nombre: 'Con correo', alcance: 'personal', columnas: ['fuente', 'correo'] }))
      .rejects.toMatchObject({ codigo: 'COLUMNA_NO_PERMITIDA', status: 403 });
    const [{ n: filas }] = await tx`SELECT count(*)::int AS n FROM flito_vistas_columnas WHERE owner_user_id = ${u1}`;
    expect(filas).toBe(0);
    const ok = await svc.crearVista(tabla, noAdmin(u1), CON_PII, { nombre: 'Con correo', alcance: 'personal', columnas: ['fuente', 'correo'] });
    expect(ok.id).toBeGreaterThan(0);
  }));

  it('clave fuera del catálogo: 422 CLAVE_DESCONOCIDA', prueba(async (tx) => {
    const u1 = await usuario(tx);
    await expect(svc.crearVista(tabla, noAdmin(u1), CON_PII, { nombre: 'Rara', alcance: 'personal', columnas: ['no_existe'] }))
      .rejects.toMatchObject({ codigo: 'CLAVE_DESCONOCIDA', status: 422 });
  }));

  it('vistas generales: no admin recibe 403 ALCANCE_NO_PERMITIDO al crear, editar o marcar la general', prueba(async (tx) => {
    const creador = await usuario(tx, 'admin');
    const otro = await usuario(tx);
    await expect(svc.crearVista(tabla, noAdmin(otro), SIN_PII, { nombre: 'Global', alcance: 'compartida', columnas: ['fuente'] }))
      .rejects.toMatchObject({ codigo: 'ALCANCE_NO_PERMITIDO', status: 403 });
    const compartida = await svc.crearVista(tabla, admin(creador), SIN_PII, { nombre: 'Global', alcance: 'compartida', columnas: ['fuente'] });
    await expect(svc.actualizarVista(tabla, noAdmin(otro), SIN_PII, compartida.id, { nombre: 'Mía', version: 1 }))
      .rejects.toMatchObject({ codigo: 'ALCANCE_NO_PERMITIDO' });
    await expect(svc.borrarVista(tabla, noAdmin(otro), compartida.id)).rejects.toMatchObject({ codigo: 'ALCANCE_NO_PERMITIDO' });
    await expect(svc.fijarPredeterminadaGeneral(tabla, noAdmin(otro), compartida.id)).rejects.toMatchObject({ codigo: 'ALCANCE_NO_PERMITIDO' });
    await svc.fijarPredeterminadaGeneral(tabla, admin(creador), compartida.id);
    const vista = await svc.listarVistas(tabla, noAdmin(otro), SIN_PII);
    expect(vista.vistaActiva).toMatchObject({ id: compartida.id, origen: 'general' });
  }));

  it('propiedad: editar o borrar la vista personal de otro responde 404 (no revela que existe)', prueba(async (tx) => {
    const u1 = await usuario(tx);
    const u2 = await usuario(tx);
    const v = await svc.crearVista(tabla, noAdmin(u1), SIN_PII, { nombre: 'Ajena', alcance: 'personal', columnas: ['fuente'] });
    await expect(svc.actualizarVista(tabla, noAdmin(u2), SIN_PII, v.id, { nombre: 'X', version: 1 }))
      .rejects.toMatchObject({ codigo: 'VISTA_NO_ENCONTRADA', status: 404 });
    await expect(svc.borrarVista(tabla, noAdmin(u2), v.id)).rejects.toMatchObject({ codigo: 'VISTA_NO_ENCONTRADA' });
  }));
});
