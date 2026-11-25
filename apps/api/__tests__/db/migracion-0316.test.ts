// Épica #14678 PR 4 (ADR-0048, enmienda 1) — La 0316 (áreas sin pantallas) EJECUTADA sobre una base poblada, dentro de
// una transacción que siempre se deshace (`enTx`). Antes de sembrar, la base vuelve a como estaba sin la 0316 con su
// inverso (`docs/arquitectura/epica-14678-0316-rollback.sql`): sirve en una base con la 0316 ya aplicada (local) o sin
// ella, y prueba de paso el inverso. Fixtures sintéticos (roles y usuarios `t14678p4_*`):
//   (a) rol con una página efectiva de Financiera;
//   (b) usuario de ese rol con `conceder` de Operaciones + SOAT y `revocar` de Tarifas.
// Criterio (AC1, AC2, AC3):
//   · los cinco quedan sembrados (nivel 1, sin padre, orden 3-7) y Gerencial/Kyverum en 8/9;
//   · ninguna fila de rol (admin incluido) ni de usuario con los cinco;
//   · páginas efectivas de TODOS los roles y de los usuarios de prueba idénticas antes / después;
//   · la 2.ª corrida no cambia ninguna fila;
//   · un área marcada después (como desde el panel) no da ninguna página;
//   · el inverso deja la base exactamente como antes de la 0316.
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { abrirBase, enTx, leerMigracion, URL_BASE } from '../helpers/base-en-tx.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQL_0316 = leerMigracion('0316_flito_menu_areas_proximamente.sql');
/** El inverso sin su transacción ni el borrado del ledger (aquí manda `enTx`). */
const INVERSO = readFileSync(path.resolve(__dirname, '../../../../docs/arquitectura/epica-14678-0316-rollback.sql'), 'utf8')
  .split('\n').filter((l) => !/^(BEGIN|COMMIT);/.test(l) && !l.includes('_kyverum_applied_migrations')).join('\n');

const AREAS = ['menu.comercial', 'menu.diseno', 'menu.tecnologia', 'menu.infraestructura', 'menu.producto'];
const R = (s: string) => `t14678p4_${s}`;

type Foto = { roles: string[]; usuarios: string[] };

/** Páginas efectivas (marcada y con su elemento marcado; en el usuario sobre (R ∪ C) \ V) de todos los roles y de los usuarios de prueba. */
async function foto(tx: postgres.TransactionSql): Promise<Foto> {
  const roles = await tx`
    SELECT r.rol_codigo || ' ' || f.codigo AS k FROM permisos_rol_funcion r
      JOIN permisos_funciones f ON f.codigo = r.funcion_codigo AND f.tipo = 'pagina'
     WHERE EXISTS (SELECT 1 FROM permisos_rol_funcion e WHERE e.rol_codigo = r.rol_codigo AND e.funcion_codigo = f.padre_codigo)
     ORDER BY 1`;
  const usuarios = await tx`
    WITH m AS (
      (SELECT u.username, r.funcion_codigo AS codigo FROM users u JOIN permisos_rol_funcion r ON r.rol_codigo = u.role
        WHERE u.username LIKE 't14678p4\\_%'
       UNION SELECT u.username, k.funcion_codigo FROM permisos_usuario_funcion k JOIN users u ON u.id = k.user_id
        WHERE k.efecto = 'conceder' AND u.username LIKE 't14678p4\\_%')
      EXCEPT SELECT u.username, k.funcion_codigo FROM permisos_usuario_funcion k JOIN users u ON u.id = k.user_id
        WHERE k.efecto = 'revocar' AND u.username LIKE 't14678p4\\_%')
    SELECT m.username || ' ' || f.codigo AS k FROM m JOIN permisos_funciones f ON f.codigo = m.codigo AND f.tipo = 'pagina'
     WHERE EXISTS (SELECT 1 FROM m e WHERE e.username = m.username AND e.codigo = f.padre_codigo)
     ORDER BY 1`;
  return { roles: roles.map((x) => x.k as string), usuarios: usuarios.map((x) => x.k as string) };
}

/** Todas las filas de permisos (marcas de rol, excepciones de usuario y el catálogo con padre, nivel y orden). */
async function filas(tx: postgres.TransactionSql): Promise<string[]> {
  const rs = await tx`
    SELECT 'r ' || rol_codigo || ' ' || funcion_codigo AS k FROM permisos_rol_funcion
    UNION ALL SELECT 'u ' || user_id || ' ' || funcion_codigo || ' ' || efecto FROM permisos_usuario_funcion
    UNION ALL SELECT 'f ' || codigo || ' ' || tipo || ' ' || coalesce(padre_codigo, '-') || ' ' || coalesce(nivel::text, '-')
      || ' ' || coalesce(orden::text, '-') || ' ' || modulo || ' ' || nombre_negocio FROM permisos_funciones
    ORDER BY 1`;
  return rs.map((x) => x.k as string);
}

async function sembrar(tx: postgres.TransactionSql): Promise<number> {
  await tx`INSERT INTO permisos_roles (codigo, nombre) VALUES (${R('a')}, 'Prueba 0316 a')`;
  for (const m of ['menu.financiera', 'pagina.flito_tarifas', 'pagina.flito_bolsas']) {
    await tx`INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES (${R('a')}, ${m})`;
  }
  const [u] = await tx`INSERT INTO users (username, name, password_hash, role) VALUES (${R('ub')}, 'ub', 'h', ${R('a')}) RETURNING id`;
  for (const [codigo, efecto] of [['menu.operaciones', 'conceder'], ['pagina.flito_soat', 'conceder'], ['pagina.flito_tarifas', 'revocar']] as const) {
    await tx`INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto) VALUES (${u!.id}, ${codigo}, ${efecto})`;
  }
  return u!.id as number;
}

describe.skipIf(!URL_BASE)('0316 — ejecutada sobre una base poblada (en transacción, siempre con ROLLBACK)', () => {
  const sql = URL_BASE ? abrirBase() : (null as unknown as postgres.Sql);
  afterAll(async () => { await sql?.end(); });

  it('siembra sin reparto; pérdidas = 0 y ganancias = 0; 2.ª corrida sin cambios; el inverso deja la base como antes', async () => {
    const r = await enTx(sql, async (tx) => {
      await tx.unsafe(INVERSO); // la base vuelve a como estaba sin la 0316
      const userId = await sembrar(tx);
      const antes = await foto(tx);
      const filasAntes = await filas(tx);
      await tx.unsafe(SQL_0316);
      const filasTras1 = await filas(tx);
      const despues = await foto(tx);
      await tx.unsafe(SQL_0316);
      const filasTras2 = await filas(tx);
      const elementos = await tx`
        SELECT codigo, tipo, nivel::text AS nivel, orden::int AS orden, padre_codigo FROM permisos_funciones
         WHERE codigo IN ${tx([...AREAS, 'menu.gerencial', 'menu.kyverum'])} ORDER BY orden`;
      const marcas = await tx`
        SELECT 'r ' || rol_codigo AS k FROM permisos_rol_funcion WHERE funcion_codigo IN ${tx(AREAS)}
        UNION ALL SELECT 'u ' || user_id FROM permisos_usuario_funcion WHERE funcion_codigo IN ${tx(AREAS)}`;
      // AC3: un administrador marca un área vacía desde el panel (rol y usuario): no da ninguna página.
      await tx`INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES (${R('a')}, 'menu.comercial')`;
      await tx`INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto) VALUES (${userId}, 'menu.producto', 'conceder')`;
      const conArea = await foto(tx);
      await tx.unsafe(INVERSO);
      const filasTrasInverso = await filas(tx);
      return {
        antes, despues, conArea, filasAntes, filasTras1, filasTras2, filasTrasInverso,
        elementos: elementos.map((e) => ({ ...e })), marcas: marcas.map((x) => x.k as string),
      };
    });

    // AC1: los cinco, nivel 1, sin padre, orden 3-7; Gerencial y Kyverum detrás (8 y 9).
    expect(r.elementos).toEqual([
      ...AREAS.map((codigo, i) => ({ codigo, tipo: 'elemento', nivel: '1', orden: i + 3, padre_codigo: null })),
      { codigo: 'menu.gerencial', tipo: 'elemento', nivel: '1', orden: 8, padre_codigo: null },
      { codigo: 'menu.kyverum', tipo: 'elemento', nivel: '1', orden: 9, padre_codigo: null },
    ]);
    // AC1: ningún rol (admin incluido) ni usuario tiene fila con los cinco.
    expect(r.marcas).toEqual([]);
    // La 0316 solo cambia el catálogo: ni una marca de rol ni de usuario de diferencia.
    const marcasDe = (xs: string[]) => xs.filter((x) => !x.startsWith('f '));
    expect(marcasDe(r.filasTras1)).toEqual(marcasDe(r.filasAntes));
    // Los fixtures ven lo que deben antes (si no, el test no prueba nada).
    expect(r.antes.roles).toEqual(expect.arrayContaining([`${R('a')} pagina.flito_tarifas`, `${R('a')} pagina.flito_bolsas`]));
    expect(r.antes.usuarios).toEqual([`${R('ub')} pagina.flito_bolsas`, `${R('ub')} pagina.flito_soat`]);
    // AC2: páginas efectivas idénticas antes y después (todos los roles; usuarios de prueba).
    expect(r.despues).toEqual(r.antes);
    // AC3: con un área vacía marcada, nadie gana una página.
    expect(r.conArea).toEqual(r.antes);
    // Idempotencia: la 2.ª corrida no cambia ninguna fila.
    expect(r.filasTras2).toEqual(r.filasTras1);
    // El inverso (también con marcas puestas desde el panel) deja la base exactamente como antes de la 0316.
    expect(r.filasTrasInverso).toEqual(r.filasAntes);
  });
});
