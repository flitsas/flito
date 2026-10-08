// HU #13423 (Feature #13413, ADR-0023) — La 0230: LAFT, Privacidad, Firma, Drive, SOAT antiguo y Siigo
// piden permiso, no rol; y las cuatro operaciones que solo exigían sesión piden un permiso nuevo.
// Siembra 42 operaciones: 38 con la lista literal de su `requireRole` (o de la fila de su acción en la
// vieja tabla de roles por acción de Siigo) y 4 con COPIA VIVA del reparto de las páginas que las usan.
// `admin` recibe todo lo nuevo en el mismo archivo (AC8, ADR-0022).
//
// Solo la mitad ESTÁTICA (el CI no levanta Postgres). La idempotencia y el control del bloque DO se
// acreditan a mano sobre la base local (dos pasadas, AC10). Mutantes nombrados:
//   · M1 — quitar `pagina.soat` de los orígenes de `vehicles.vehiculos.consultar`: cae «la copia viva
//     sale de las páginas que llaman cada operación».
//   · M2 — quitar `('admin', 'drive.archivos.administrar')`: cae «admin recibe todo lo nuevo» (AC8).
//   · M3 — añadir `('auditor', 'siigo.factura.emitir')`: cae «el reparto literal es el del catálogo»
//     (sería una ganancia, AC6).
//   · M6 — volver a `INSERT INTO permisos_rol_funcion (…) VALUES (…)` con roles literales: cae el aserto
//     del JOIN con permisos_roles (lección del CD de DEV con la 0227).
//   · M7 — volver a copiar las excepciones de `vehicles.vehiculos.consultar` página a página (gana la
//     primera con ON CONFLICT): caen los escenarios por efecto de la mitad CON BASE (TEST_DATABASE_URL).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { catalogoCompleto } from '../../src/modules/permisos/catalogo.js';
import {
  MIGRACIONES_CON_REPARTO, copiasDeReparto, leerFuncionesSembradas, leerRenombresSembrados,
  leerRepartoSembrado, leerRetirosSembrados,
} from '../helpers/permisos-seed-sql.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0230_permisos_sensibles_por_permiso.sql';
const ANTERIOR = '0229_permisos_operacion_por_item.sql';
const RUTA = path.resolve(__dirname, '../../src/db/migrations', ARCHIVO);
const SQL = readFileSync(RUTA, 'utf8');
const SIN_COMENTARIOS = SQL.replace(/--[^\n]*/g, '');

const CATALOGO = catalogoCompleto();
/** Las cuatro operaciones que solo exigían sesión y las páginas cuyas pantallas las llaman (grep sobre apps/web/src). */
const SESION: Record<string, string[]> = {
  'vehicles.vehiculos.consultar': ['pagina.fleet', 'pagina.soat', 'pagina.tramite', 'pagina.vehicles'],
  'runt.persona.consultar': ['pagina.tramite'],
  'runt.cedula.leer': ['pagina.tramite'],
  'integraciones.fasecolda.buscar': ['pagina.tramite'],
};
const OPERACIONES = CATALOGO.filter((f) => f.tipo === 'operacion'
  && (/^(laft|privacy|firma|drive|siigo|runt|integraciones)\.|^soat\.antiguo\./.test(f.codigo) || f.codigo === 'vehicles.vehiculos.consultar'));
const LITERALES = OPERACIONES.filter((f) => !(f.codigo in SESION));

describe('0230 — reglas del archivo (análisis estático)', () => {
  it('no trae control de transacción propio (ADR-DB-001) y el bloque DO lleva dollar-quoting etiquetado', () => {
    expect(scanForTxControl(ARCHIVO, SQL)).toEqual([]);
    expect(SQL).toMatch(/DO \$resumen0230\$/);
    expect(SQL).toMatch(/END \$resumen0230\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    expect(SQL.match(/--[^\n]*\$/g)).toBeNull();
  });

  it('la cabecera cumple la convención 5 del README: archivo, motivo y autor', () => {
    const cabecera = SQL.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/Feature #13413/);
    expect(cabecera).toMatch(/HU #13423/);
  });

  it('el número no colisiona y la anterior es la 0229 (sin hueco)', () => {
    const sqls = readdirSync(path.dirname(RUTA)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0230_'))).toEqual([ARCHIVO]);
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toBe(ANTERIOR);
  });

  it('idempotente (AC10): todo INSERT con ON CONFLICT DO NOTHING; ni UPDATE, ni DELETE, ni tablas temporales', () => {
    const inserts = SIN_COMENTARIOS.match(/INSERT INTO permisos_/g) ?? [];
    // funciones + literal + rol × 4 páginas de origen + usuario de pagina.tramite + conceder/revocar agregados de vehículos
    expect(inserts).toHaveLength(9);
    expect(SIN_COMENTARIOS.match(/ON CONFLICT \([a-z_, ]+\) DO NOTHING;/g)).toHaveLength(9);
    expect(SIN_COMENTARIOS).not.toMatch(/DO UPDATE|UPDATE permisos_|DELETE FROM|CREATE TEMP/);
  });

  it('M6: toda fila de rol LITERAL pasa por JOIN con permisos_roles; el resto copia de filas existentes sin nombrar roles', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/INSERT INTO permisos_rol_funcion\s*\([^)]*\)\s*VALUES/);
    const conJoin = [...SIN_COMENTARIOS.matchAll(/INSERT INTO permisos_rol_funcion \(rol_codigo, funcion_codigo\)\s+SELECT v\.rol, v\.fn FROM \(VALUES([\s\S]*?)\) AS v\(rol, fn\)\s+JOIN permisos_roles r ON r\.codigo = v\.rol\s+ON CONFLICT \(rol_codigo, funcion_codigo\) DO NOTHING;/g)];
    expect(conJoin).toHaveLength(1);
    const filas = [...conJoin[0]![1]!.matchAll(/\('([a-z_]+)', '[a-z0-9_.]+'\)/g)].map((m) => m[1]!);
    const porRol = filas.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r]: (acc[r] ?? 0) + 1 }), {});
    expect(porRol).toEqual({ admin: 42, auditor: 3, compliance: 15, financiera: 11, proveedor: 1, transito: 1 });
    const otros = [...SIN_COMENTARIOS.matchAll(/INSERT INTO permisos_rol_funcion[\s\S]*?;/g)].map((m) => m[0]).filter((b) => !/JOIN permisos_roles r/.test(b));
    expect(otros).toHaveLength(4);
    for (const b of otros) expect(b).not.toMatch(/'(admin|auditor|compliance|financiera|proveedor|transito|lider_pesv|supervisor_flota)'/);
  });

  it('el bloque DO no aborta si falta un rol no-admin: solo comprueba catálogo, admin (si existe) y la copia viva', () => {
    const bloque = /DO \$resumen0230\$([\s\S]*?)END \$resumen0230\$;/.exec(SIN_COMENTARIOS)![1]!;
    expect(bloque).not.toMatch(/'(auditor|compliance|financiera|proveedor|transito)'/);
    expect(bloque).toMatch(/IF EXISTS \(SELECT 1 FROM permisos_roles WHERE codigo = 'admin'\) THEN/);
    expect(bloque).toMatch(/IF n_ops <> 42 THEN\s*RAISE EXCEPTION/);
    expect(bloque).toMatch(/IF n_sin_admin <> 0 THEN\s*RAISE EXCEPTION/);
    expect(bloque).toMatch(/IF n_cortas <> 0 THEN\s*RAISE EXCEPTION/);
  });

  it('las operaciones se cuentan con la lista CERRADA de las 42, no por prefijo', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/LIKE/);
    const listas = [...SIN_COMENTARIOS.matchAll(/codigo IN \(('[a-z_.]+'(?:,'[a-z_.]+')*)\)/g)]
      .map((m) => m[1]!.split(',').map((x) => x.slice(1, -1)));
    expect(listas).toHaveLength(3);
    for (const l of listas) expect([...l].sort()).toEqual(OPERACIONES.map((f) => f.codigo).sort());
  });
});

describe('0230 — lo que siembra es lo que el catálogo del código declara', () => {
  const previas = leerFuncionesSembradas(MIGRACIONES_CON_REPARTO.filter((m) => m !== ARCHIVO));
  const sembradas = new Map([...leerFuncionesSembradas()].filter(([c]) => !previas.has(c)));

  it('siembra exactamente las 42 operaciones, con los textos y el módulo del catálogo', () => {
    expect(OPERACIONES).toHaveLength(42);
    expect([...sembradas.keys()].sort()).toEqual(OPERACIONES.map((f) => f.codigo).sort());
    for (const [codigo, f] of sembradas) {
      const c = CATALOGO.find((x) => x.codigo === codigo)!;
      expect(f, codigo).toEqual({ codigo, modulo: c.modulo, nombre: c.nombreNegocio, descripcion: c.descripcion, tipo: 'operacion' });
    }
  });

  it('todo código es `<modulo>.<objeto>.<accion>` y los transitorios llevan nombre «Administrar …» y la marca de la HU #13429', () => {
    for (const f of OPERACIONES) expect(f.codigo, f.codigo).toMatch(/^[a-z]+\.[a-z_]+\.[a-z_]+$/);
    for (const f of OPERACIONES.filter((x) => x.codigo.endsWith('.administrar'))) {
      expect(f.nombreNegocio, f.codigo).toMatch(/^Administrar /);
      expect(f.descripcion, f.codigo).toMatch(/^Transitorio \(retira la HU #13429\)/);
    }
  });

  it('no renombra ni retira nada', () => {
    expect(leerRenombresSembrados([ARCHIVO])).toEqual(new Map());
    expect(leerRetirosSembrados([ARCHIVO])).toEqual({ funciones: new Set(), reparto: new Set() });
  });
});

describe('0230 — reparto con paridad (AC6) y admin explícito (AC8)', () => {
  it('M1: la copia viva de cada operación de solo sesión sale de las páginas que la llaman (roles)', () => {
    const porDestino = new Map<string, string[]>();
    for (const { origen, destinos } of copiasDeReparto(SQL)) {
      for (const d of destinos) porDestino.set(d, [...(porDestino.get(d) ?? []), origen]);
    }
    expect(Object.fromEntries([...porDestino].map(([d, os]) => [d, [...os].sort()]))).toEqual(SESION);
  });

  it('las excepciones por usuario de los destinos de UNA página se copian con su `efecto`; las de vehículos no se copian página a página', () => {
    const re = /INSERT INTO permisos_usuario_funcion \(user_id, funcion_codigo, efecto\)\s+SELECT o\.user_id, v\.fn, o\.efecto FROM permisos_usuario_funcion o CROSS JOIN \(VALUES([\s\S]*?)\) AS v\(fn\)\s+WHERE o\.funcion_codigo = '([a-z_.]+)'\s+ON CONFLICT \(user_id, funcion_codigo\) DO NOTHING;/g;
    const porDestino = new Map<string, string[]>();
    for (const m of SIN_COMENTARIOS.matchAll(re)) {
      for (const d of [...m[1]!.matchAll(/'([a-z_.]+)'/g)].map((x) => x[1]!)) porDestino.set(d, [...(porDestino.get(d) ?? []), m[2]!]);
    }
    const unaPagina = Object.fromEntries(Object.entries(SESION).filter(([, ps]) => ps.length === 1));
    expect(Object.fromEntries([...porDestino].map(([d, os]) => [d, [...os].sort()]))).toEqual(unaPagina);
    // vehicles.vehiculos.consultar: un INSERT de `conceder` y otro de `revocar`, agregados sobre las cuatro páginas.
    const agregados = [...SIN_COMENTARIOS.matchAll(/SELECT DISTINCT o\.user_id, 'vehicles\.vehiculos\.consultar', '(conceder|revocar)' FROM permisos_usuario_funcion o\s+JOIN \(VALUES ([^)]*\)(?:, \('[a-z_.]+'\))*)\)/g)];
    expect(agregados.map((m) => m[1])).toEqual(['conceder', 'revocar']);
    for (const m of agregados) expect([...m[2]!.matchAll(/'([a-z_.]+)'/g)].map((x) => x[1]).sort()).toEqual(SESION['vehicles.vehiculos.consultar']);
  });

  it('M2: admin recibe TODO lo nuevo en este mismo archivo (AC8)', () => {
    const admin = leerRepartoSembrado([ARCHIVO]).get('admin')!;
    for (const f of OPERACIONES) expect(admin.has(f.codigo), f.codigo).toBe(true);
  });

  it('M3: el reparto literal de cada operación es EXACTAMENTE el del catálogo (la lista de su guarda vieja); las de sesión solo van literales a admin', () => {
    const literal = leerRepartoSembrado([ARCHIVO]);
    const rolesDe = (codigo: string) => [...literal.entries()].filter(([, cs]) => cs.has(codigo)).map(([r]) => r).sort();
    // Sin plegar las anteriores, la copia viva no tiene origen: queda el literal.
    for (const f of LITERALES) expect(rolesDe(f.codigo), f.codigo).toEqual([...f.roles].sort());
    for (const c of Object.keys(SESION)) expect(rolesDe(c), c).toEqual(['admin']);
    const de = (c: string) => OPERACIONES.find((f) => f.codigo === c)!.roles;
    expect(de('siigo.factura.consultar')).toEqual(['admin', 'auditor', 'financiera']);
    for (const a of ['emitir', 'reintentar', 'reenviar_correo', 'marcar_fallido', 'reactivar', 'corregir', 'anular']) {
      expect(de(`siigo.factura.${a}`), a).toEqual(['admin', 'financiera']);
    }
    expect(de('laft.tablero.ver')).toEqual(['admin', 'auditor', 'compliance']);
    expect(de('firma.estado.ver')).toEqual(['admin', 'transito']);
    expect(de('soat.antiguo.operar')).toEqual(['admin', 'proveedor']);
  });

  it('plegadas todas las migraciones, cada operación de sesión la tiene EXACTAMENTE quien tiene alguna de sus páginas', () => {
    expect(MIGRACIONES_CON_REPARTO).toContain(ARCHIVO);
    expect(MIGRACIONES_CON_REPARTO.indexOf(ARCHIVO)).toBe(MIGRACIONES_CON_REPARTO.indexOf(ANTERIOR) + 1);
    const total = leerRepartoSembrado();
    for (const [rol, cs] of total) {
      for (const [codigo, paginas] of Object.entries(SESION)) {
        expect(cs.has(codigo), `${rol} ${codigo}`).toBe(paginas.some((p) => cs.has(p)));
      }
    }
  });

  it('la foto del catálogo de las cuatro de sesión coincide con el reparto plegado (los tests firman tokens con ella)', () => {
    const total = leerRepartoSembrado();
    for (const c of Object.keys(SESION)) {
      const sembrado = [...total.entries()].filter(([, cs]) => cs.has(c)).map(([r]) => r).sort();
      expect(OPERACIONES.find((f) => f.codigo === c)!.roles.slice().sort(), c).toEqual(sembrado);
    }
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;
const VVC = 'vehicles.vehiculos.consultar';

// Escenarios por EFECTO del destino de cuatro páginas, con la semántica del motor (shared/permisos-efectivos.ts:
// (R ∪ C) \ V, revocar gana). Todo en una transacción que se revierte; requiere la base ya migrada.
describe.skipIf(!URL_BASE)('0230 — excepciones de vehicles.vehiculos.consultar por efecto (BD, rollback)', () => {
  let sql: postgres.Sql;
  const ROLLBACK = Symbol('rollback');
  beforeAll(() => { sql = postgres(URL_BASE!, { max: 1, onnotice: () => {} }); });
  afterAll(async () => { await sql?.end(); });

  async function enTx<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    let salida!: T;
    try {
      await sql.begin(async (tx) => { salida = await fn(tx); throw ROLLBACK; });
    } catch (e) { if (e !== ROLLBACK) throw e; }
    return salida;
  }

  /** Dos roles de prueba (fleet+soat y ninguna página) y un usuario por escenario con sus excepciones. */
  async function sembrar(tx: postgres.TransactionSql, usuarios: { clave: string; rol: 'fs' | 'nada'; excepciones: [string, 'conceder' | 'revocar'][] }[]) {
    await tx`INSERT INTO permisos_roles (codigo, nombre) VALUES ('t13423_fs', 'Prueba fleet+soat'), ('t13423_nada', 'Prueba sin páginas')`;
    await tx`INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES ('t13423_fs', 'pagina.fleet'), ('t13423_fs', 'pagina.soat')`;
    const ids: Record<string, number> = {};
    for (const u of usuarios) {
      const [fila] = await tx<{ id: number }[]>`INSERT INTO users (name, username, password_hash, role)
        VALUES (${'Prueba ' + u.clave}, ${'t13423_' + u.clave}, 'x', ${'t13423_' + u.rol}) RETURNING id`;
      ids[u.clave] = fila!.id;
      for (const [codigo, efecto] of u.excepciones) {
        await tx`INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto) VALUES (${fila!.id}, ${codigo}, ${efecto})`;
      }
    }
    return ids;
  }

  async function efectoVvc(tx: postgres.TransactionSql, userId: number): Promise<string | null> {
    const filas = await tx<{ efecto: string }[]>`SELECT efecto FROM permisos_usuario_funcion WHERE user_id = ${userId} AND funcion_codigo = ${VVC}`;
    return filas[0]?.efecto ?? null;
  }

  it('revocar en fleet con rol que da soat: NO queda revocado (conserva SOAT, conserva /api/vehicles)', async () => {
    await enTx(async (tx) => {
      const ids = await sembrar(tx, [{ clave: 'r1', rol: 'fs', excepciones: [['pagina.fleet', 'revocar']] }]);
      await tx.unsafe(SQL);
      expect(await efectoVvc(tx, ids.r1!)).toBeNull();
      const [rol] = await tx`SELECT 1 FROM permisos_rol_funcion WHERE rol_codigo = 't13423_fs' AND funcion_codigo = ${VVC}`;
      expect(rol).toBeDefined();
    });
  }, 60_000);

  it('sin acceso efectivo a ninguna de las cuatro (revocadas las del rol, o rol sin ellas): SÍ queda revocado', async () => {
    await enTx(async (tx) => {
      const ids = await sembrar(tx, [
        { clave: 'r2a', rol: 'fs', excepciones: [['pagina.fleet', 'revocar'], ['pagina.soat', 'revocar'], ['pagina.tramite', 'revocar'], ['pagina.vehicles', 'revocar']] },
        { clave: 'r2b', rol: 'nada', excepciones: [['pagina.fleet', 'revocar']] },
      ]);
      await tx.unsafe(SQL);
      expect(await efectoVvc(tx, ids.r2a!)).toBe('revocar');
      expect(await efectoVvc(tx, ids.r2b!)).toBe('revocar');
    });
  }, 60_000);

  it('conceder en soat + revocar en fleet: queda conceder', async () => {
    await enTx(async (tx) => {
      const ids = await sembrar(tx, [{ clave: 'r3', rol: 'nada', excepciones: [['pagina.fleet', 'revocar'], ['pagina.soat', 'conceder']] }]);
      await tx.unsafe(SQL);
      expect(await efectoVvc(tx, ids.r3!)).toBe('conceder');
    });
  }, 60_000);

  it('el bloque DO aborta si alguien queda revocado en vehículos mientras conserva acceso efectivo a una página de origen', async () => {
    await expect(enTx(async (tx) => {
      const ids = await sembrar(tx, [{ clave: 'r4', rol: 'fs', excepciones: [['pagina.fleet', 'revocar']] }]);
      await tx`INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto) VALUES (${ids.r4!}, ${VVC}, 'revocar')`;
      await tx.unsafe(SQL);
    })).rejects.toThrow(/revocar en vehicles\.vehiculos\.consultar y acceso efectivo/);
  }, 60_000);
});
