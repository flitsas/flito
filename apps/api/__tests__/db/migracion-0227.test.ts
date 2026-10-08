// HU #13421 (Feature #13413, ADR-0023) — La 0227: PESV, Jornadas, Conductores y RUM piden permiso,
// no rol. Siembra las 21 páginas por ítem del menú PESV con reparto COPIADO de `pagina.pesv` (roles y
// excepciones por usuario), renombra `pagina.pesv` a «Tablero PESV», y siembra los 24 transitorios
// «Administrar <ítem>» más la operación permanente `rum.resumen.ver` con la lista literal de su
// `requireRole`. `admin` recibe todo lo nuevo en el mismo archivo (AC7, ADR-0022).
//
// Numerada 0227 en el rebase sobre develop 696fbb9a (la 0226 es de la HU #13424). Solo se aplica dentro
// de una transacción (CREATE TEMP TABLE … ON COMMIT DROP): lo dice la cabecera y lo comprueba este test.
//
// Solo la mitad ESTÁTICA (el CI no levanta Postgres). La idempotencia y el control de paridad del
// bloque DO se acreditan a mano sobre la base local (dos pasadas). Mutantes nombrados:
//   · M1 — quitar una página del VALUES de la copia de roles: cae «la copia lleva las 21 páginas».
//   · M2 — quitar `('admin', 'pesv.comite.administrar')`: cae «admin recibe todo lo nuevo» (AC7).
//   · M3 — añadir `('compliance', 'pesv.plan.administrar')`: cae «el reparto de cada operación es
//     el del catálogo» (sería una ganancia, AC5).
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGES, PAGINAS_PESV_POR_ITEM } from '@operaciones/shared-types';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { catalogoCompleto } from '../../src/modules/permisos/catalogo.js';
import {
  MIGRACIONES_CON_REPARTO, copiasDeReparto, leerFuncionesSembradas, leerRenombresSembrados,
  leerRepartoSembrado, leerRetirosSembrados,
} from '../helpers/permisos-seed-sql.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0227_permisos_pesv_por_item.sql';
const ANTERIOR = '0226_permisos_admin_todo_marcado.sql';
/** La anterior DENTRO de MIGRACIONES_CON_REPARTO (la 0226 de la #13424 no siembra en forma parseable). */
const ANTERIOR_CON_REPARTO = '0223_flito_soportes_documentos_adicionales_carga_eliminar.sql';
const RUTA = path.resolve(__dirname, '../../src/db/migrations', ARCHIVO);
const SQL = readFileSync(RUTA, 'utf8');
const SIN_COMENTARIOS = SQL.replace(/--[^\n]*/g, '');

const PAGINAS = PAGINAS_PESV_POR_ITEM.map((s) => `pagina.${s}`);
const CATALOGO = catalogoCompleto();
const OPERACIONES = CATALOGO.filter((f) => f.tipo === 'operacion' && /^(pesv|drivers|jornadas|rum)\./.test(f.codigo));

describe('0227 — reglas del archivo (análisis estático)', () => {
  it('no trae control de transacción propio (ADR-DB-001) y el bloque DO lleva dollar-quoting etiquetado', () => {
    expect(scanForTxControl(ARCHIVO, SQL)).toEqual([]);
    expect(SQL).toMatch(/DO \$resumen0227\$/);
    expect(SQL).toMatch(/END \$resumen0227\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    expect(SQL.match(/--[^\n]*\$/g)).toBeNull();
  });

  it('la cabecera cumple la convención 5 del README: archivo, motivo y autor', () => {
    const cabecera = SQL.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/Feature #13413/);
    expect(cabecera).toMatch(/HU #13421/);
  });

  it('el número no colisiona y la anterior es la 0226 de la HU #13424 (sin hueco)', () => {
    const sqls = readdirSync(path.dirname(RUTA)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0227_'))).toEqual([ARCHIVO]);
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toBe(ANTERIOR);
  });

  it('idempotente: todo INSERT con ON CONFLICT DO NOTHING, sin DO UPDATE; los dos DELETE son los del Paso 3b', () => {
    const inserts = SIN_COMENTARIOS.match(/INSERT INTO permisos_/g) ?? [];
    expect(inserts).toHaveLength(8);
    expect(SIN_COMENTARIOS.match(/ON CONFLICT \([a-z_, ]+\) DO NOTHING;/g)).toHaveLength(8);
    expect(SIN_COMENTARIOS).not.toMatch(/DO UPDATE/);
    expect(SIN_COMENTARIOS.match(/DELETE FROM/g)).toHaveLength(2);
    expect(SIN_COMENTARIOS).toMatch(/IS DISTINCT FROM/);
    // La tabla temporal se va con la transacción del runner: una segunda pasada la vuelve a crear.
    expect(SIN_COMENTARIOS).toMatch(/CREATE TEMP TABLE m0227_objetivo ON COMMIT DROP AS/);
    // db-review N-A: en autocommit fallaría a medias; la cabecera lo advierte con la forma de verificarla.
    const cabecera = SQL.split('\n').slice(0, 20).join('\n');
    expect(cabecera).toMatch(/SOLO DENTRO DE UNA TRANSACCION/);
    expect(cabecera).toMatch(/psql -1 -v ON_ERROR_STOP=1 -f/);
    expect(cabecera).toMatch(/BEGIN \.\.\. ROLLBACK/);
  });

  // Corrección del 2026-10-08: el CD de DEV cayó por la FK permisos_rol_funcion_rol_codigo_fkey porque
  // el Paso 5 insertaba `VALUES ('lider_pesv', …)` y DEV no tiene ese rol (ni supervisor_flota ni
  // compliance). Mutante nombrado M6: volver a `INSERT INTO permisos_rol_funcion (…) VALUES (…)` cae aquí.
  it('M6: toda fila de rol LITERAL pasa por JOIN con permisos_roles (solo entra si el rol existe en el ambiente)', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/INSERT INTO permisos_rol_funcion\s*\([^)]*\)\s*VALUES/);
    const conJoin = [...SIN_COMENTARIOS.matchAll(/INSERT INTO permisos_rol_funcion \(rol_codigo, funcion_codigo\)\s+SELECT v\.rol, v\.fn FROM \(VALUES([\s\S]*?)\) AS v\(rol, fn\)\s+JOIN permisos_roles r ON r\.codigo = v\.rol\s+ON CONFLICT \(rol_codigo, funcion_codigo\) DO NOTHING;/g)];
    expect(conJoin).toHaveLength(1);
    const filas = [...conJoin[0]![1]!.matchAll(/\('([a-z_]+)', '[a-z0-9_.]+'\)/g)].map((m) => m[1]!);
    const porRol = filas.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r]: (acc[r] ?? 0) + 1 }), {});
    expect(porRol).toEqual({ admin: 46, lider_pesv: 13, supervisor_flota: 2, compliance: 1 });
    // Ningún otro INSERT en permisos_rol_funcion nombra un rol entre comillas: los demás copian de filas existentes.
    const otros = [...SIN_COMENTARIOS.matchAll(/INSERT INTO permisos_rol_funcion[\s\S]*?;/g)].map((m) => m[0]).filter((b) => !/JOIN permisos_roles r/.test(b));
    for (const b of otros) expect(b).not.toMatch(/'(admin|lider_pesv|supervisor_flota|compliance)'/);
    const cabecera = SQL.split('\n').slice(0, 40).join('\n');
    expect(cabecera).toMatch(/Correccion del 2026-10-08 tras el fallo del CD en DEV/);
  });

  it('db-review N2: las operaciones se cuentan con la lista CERRADA de las 25, no por prefijo', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/LIKE/);
    const listas = [...SIN_COMENTARIOS.matchAll(/codigo IN \(('[a-z_.]+'(?:,'[a-z_.]+')*)\)/g)]
      .map((m) => m[1]!.split(',').map((x) => x.slice(1, -1)))
      .filter((l) => l.some((c) => !c.startsWith('pagina.')));
    expect(listas).toHaveLength(2);
    for (const l of listas) expect([...l].sort()).toEqual(OPERACIONES.map((f) => f.codigo).sort());
  });
});

describe('0227 — lo que siembra es lo que el catálogo del código declara', () => {
  // Lo que ESTE archivo añade al catálogo plegado (el UPDATE de `pagina.pesv` necesita la 0179 detrás).
  const previas = leerFuncionesSembradas(MIGRACIONES_CON_REPARTO.filter((m) => m !== ARCHIVO));
  const sembradas = new Map([...leerFuncionesSembradas()].filter(([c]) => !previas.has(c)));

  it('siembra exactamente las 21 páginas y las 25 operaciones, con los textos y el módulo del catálogo', () => {
    expect([...sembradas.keys()].sort()).toEqual([...PAGINAS, ...OPERACIONES.map((f) => f.codigo)].sort());
    expect(OPERACIONES).toHaveLength(25);
    for (const [codigo, f] of sembradas) {
      const c = CATALOGO.find((x) => x.codigo === codigo)!;
      expect(f, codigo).toEqual({ codigo, modulo: c.modulo, nombre: c.nombreNegocio, descripcion: c.descripcion, tipo: c.tipo });
    }
    for (const p of PAGINAS) expect(sembradas.get(p)!.modulo, p).toBe('pesv');
  });

  it('los nombres de las páginas son «PESV — <label del menú>» y los transitorios llevan el sufijo `.administrar`', () => {
    for (const s of PAGINAS_PESV_POR_ITEM) expect(PAGES[s], s).toMatch(/^PESV — /);
    expect(OPERACIONES.filter((f) => !f.codigo.endsWith('.administrar')).map((f) => f.codigo)).toEqual(['rum.resumen.ver']);
    for (const f of OPERACIONES.filter((x) => x.codigo.endsWith('.administrar'))) {
      expect(f.nombreNegocio, f.codigo).toMatch(/^Administrar /);
      expect(f.descripcion, f.codigo).toMatch(/^Transitorio \(retira la HU #13429\)/);
    }
  });

  it('`pagina.pesv` se renombra al ítem raíz «Tablero PESV» (no se retira)', () => {
    expect(leerRenombresSembrados([ARCHIVO])).toEqual(new Map([
      ['pagina.pesv', { nombre: 'PESV — Tablero PESV', descripcion: 'Entrar a la pantalla «PESV — Tablero PESV».' }],
    ]));
    expect(PAGES.pesv).toBe('PESV — Tablero PESV');
    expect(leerRetirosSembrados([ARCHIVO])).toEqual({ funciones: new Set(), reparto: new Set() });
  });
});

describe('0227 — reparto con paridad (AC5) y admin explícito (AC7)', () => {
  it('la copia de roles va de `pagina.pesv` a las 21 páginas (M1)', () => {
    expect(copiasDeReparto(SQL)).toEqual([{ origen: 'pagina.pesv', destinos: PAGINAS }]);
  });

  it('las excepciones por usuario se copian con su `efecto` (conceder y revocar) a las mismas 21 páginas', () => {
    const m = /INSERT INTO permisos_usuario_funcion \(user_id, funcion_codigo, efecto\)\s+SELECT o\.user_id, v\.fn, o\.efecto FROM permisos_usuario_funcion o CROSS JOIN \(VALUES([\s\S]*?)\) AS v\(fn\)\s+WHERE o\.funcion_codigo = 'pagina\.pesv'\s+ON CONFLICT \(user_id, funcion_codigo\) DO NOTHING;/.exec(SIN_COMENTARIOS);
    expect(m).not.toBeNull();
    expect([...m![1]!.matchAll(/'([a-z_.]+)'/g)].map((x) => x[1])).toEqual(PAGINAS);
  });

  it('admin recibe TODO lo nuevo en este mismo archivo (M2)', () => {
    const admin = leerRepartoSembrado([ARCHIVO]).get('admin')!;
    for (const c of [...PAGINAS, ...OPERACIONES.map((f) => f.codigo)]) expect(admin.has(c), c).toBe(true);
  });

  it('el reparto literal de cada operación es EXACTAMENTE el del catálogo, y ninguna página nueva va literal a otro rol que admin (M3)', () => {
    const literal = leerRepartoSembrado([ARCHIVO]);
    for (const f of OPERACIONES) {
      const roles = [...literal.entries()].filter(([, cs]) => cs.has(f.codigo)).map(([r]) => r).sort();
      expect(roles, f.codigo).toEqual([...f.roles].sort());
    }
    for (const [rol, cs] of literal) {
      if (rol === 'admin') continue;
      expect([...cs].filter((c) => c.startsWith('pagina.')), rol).toEqual([]);
    }
  });

  it('plegadas todas las migraciones, cada rol que tiene `pagina.pesv` tiene las 21 páginas, y nadie más las tiene', () => {
    expect(MIGRACIONES_CON_REPARTO).toContain(ARCHIVO);
    expect(MIGRACIONES_CON_REPARTO.indexOf(ARCHIVO)).toBe(MIGRACIONES_CON_REPARTO.indexOf(ANTERIOR_CON_REPARTO) + 1);
    const total = leerRepartoSembrado();
    for (const [rol, cs] of total) {
      for (const p of PAGINAS) expect(cs.has(p), `${rol} ${p}`).toBe(cs.has('pagina.pesv'));
    }
  });

  it('el bloque DO revienta si una página nueva queda con menos reparto que `pagina.pesv` o sin admin', () => {
    expect(SIN_COMENTARIOS).toMatch(/IF n_cortas <> 0 THEN\s*RAISE EXCEPTION/);
    expect(SIN_COMENTARIOS).toMatch(/IF n_sin_admin <> 0 THEN\s*RAISE EXCEPTION/);
    expect(SIN_COMENTARIOS).toMatch(/IF n_paginas <> 21 OR n_ops <> 25 THEN\s*RAISE EXCEPTION/);
  });
});

// security-agent (pre-PR, bloqueante): raci, normativa y retención pedían su página Y `pagina.pesv`
// (guarda de router filtrada en /api/pesv). Quitarla sin recortar el reparto daba acceso a quien tenía
// la página sin `pagina.pesv`. Mutantes nombrados (los dos se probaron también contra Postgres, en una
// transacción con ROLLBACK, y el DO abortó):
//   · M4 — quitar (a.2) (retirar el `conceder` sin pagina.pesv): cae «(a) recorta…» y el DO aborta.
//   · M5 — quitar el control (b) del DO: cae «(b) el DO aborta…».
describe('0227 — raci, normativa y retención recortadas a la intersección con pagina.pesv', () => {
  const TRES = ['pagina.pesv_raci', 'pagina.pesv_normativa', 'pagina.pesv_retencion'];
  const EFECTIVA_PESV = /\(EXISTS \(SELECT 1 FROM permisos_rol_funcion r WHERE r\.rol_codigo = u\.role AND r\.funcion_codigo = 'pagina\.pesv'\)\s+OR EXISTS \(SELECT 1 FROM permisos_usuario_funcion c WHERE c\.user_id = u\.id AND c\.funcion_codigo = 'pagina\.pesv' AND c\.efecto = 'conceder'\)\)\s+AND NOT EXISTS \(SELECT 1 FROM permisos_usuario_funcion x WHERE x\.user_id = u\.id AND x\.funcion_codigo = 'pagina\.pesv' AND x\.efecto = 'revocar'\)/;

  it('el objetivo se calcula ANTES de tocar filas, con la regla del motor (R ∪ C) \\ V sobre pagina.pesv y sobre la página', () => {
    const iObjetivo = SIN_COMENTARIOS.indexOf('CREATE TEMP TABLE m0227_objetivo');
    expect(iObjetivo).toBeGreaterThan(-1);
    expect(iObjetivo).toBeLessThan(SIN_COMENTARIOS.indexOf('DELETE FROM'));
    const objetivo = SIN_COMENTARIOS.slice(iObjetivo, SIN_COMENTARIOS.indexOf(';', iObjetivo));
    expect(objetivo).toMatch(EFECTIVA_PESV);
    for (const p of TRES) expect(objetivo).toContain(`('${p}')`);
  });

  it('(a) recorta: rol sin pagina.pesv deja de conceder, se retira el conceder de usuario sin objetivo, se copian las revocaciones de pagina.pesv y se revoca donde el rol aún concede (M4)', () => {
    expect(SIN_COMENTARIOS).toMatch(/DELETE FROM permisos_rol_funcion rf\s+WHERE rf\.funcion_codigo = ANY \(ARRAY\['pagina\.pesv_raci', 'pagina\.pesv_normativa', 'pagina\.pesv_retencion'\]\)\s+AND NOT EXISTS \(SELECT 1 FROM permisos_rol_funcion o WHERE o\.rol_codigo = rf\.rol_codigo AND o\.funcion_codigo = 'pagina\.pesv'\);/);
    expect(SIN_COMENTARIOS).toMatch(/DELETE FROM permisos_usuario_funcion p\s+USING m0227_objetivo t\s+WHERE p\.user_id = t\.user_id AND p\.funcion_codigo = t\.fn AND p\.efecto = 'conceder' AND NOT t\.objetivo;/);
    expect(SIN_COMENTARIOS).toMatch(/SELECT o\.user_id, v\.fn, 'revocar' FROM permisos_usuario_funcion o[\s\S]{0,200}WHERE o\.funcion_codigo = 'pagina\.pesv' AND o\.efecto = 'revocar'/);
    expect(SIN_COMENTARIOS).toMatch(/SELECT t\.user_id, t\.fn, 'revocar' FROM m0227_objetivo t\s+WHERE NOT t\.objetivo/);
    // Paridad hacia abajo: quien SÍ pasaba conserva la página como excepción propia.
    expect(SIN_COMENTARIOS).toMatch(/SELECT t\.user_id, t\.fn, 'conceder' FROM m0227_objetivo t\s+WHERE t\.objetivo/);
  });

  it('(b) el DO aborta si alguien queda con una de las tres sin pagina.pesv efectiva, o distinto del objetivo (M5)', () => {
    const iDo = SIN_COMENTARIOS.indexOf('DO $resumen0227$');
    const bloque = SIN_COMENTARIOS.slice(iDo);
    expect(bloque).toMatch(EFECTIVA_PESV);
    expect(bloque).toMatch(/IF n_sin_pesv <> 0 THEN\s*RAISE EXCEPTION/);
    expect(bloque).toMatch(/t\.objetivo IS DISTINCT FROM/);
    expect(bloque).toMatch(/IF n_difieren <> 0 THEN\s*RAISE EXCEPTION/);
  });

  it('el recorte no lo pliega el helper como retiro (ni la forma DELETE … IN): el reparto de partida no tiene roles con esas páginas sin pagina.pesv', () => {
    expect(leerRetirosSembrados([ARCHIVO])).toEqual({ funciones: new Set(), reparto: new Set() });
    const total = leerRepartoSembrado();
    for (const [rol, cs] of total) {
      for (const p of TRES) if (cs.has(p)) expect(cs.has('pagina.pesv'), `${rol} ${p}`).toBe(true);
    }
  });
});

