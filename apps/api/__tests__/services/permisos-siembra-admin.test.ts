// HU #13424 (Feature #13414) · ADR-0022 §D2 — AC2: todo permiso del catálogo está marcado en `admin`.
//
// Puro, sin base: el CI no levanta Postgres (los tests de base se saltan en verde), así que la garantía
// se toma sobre lo único que viaja en el PR — los archivos SQL de las migraciones —. Hasta la HU #13424
// la daba el arranque del API mirando la base viva, y eso volvía a `admin` no editable (desmarcarle una
// función dejaba la API sin arrancar). Ahora:
//
//   1. Toda migración ≥ 0226 que INSERTE en `permisos_funciones` marca a `admin` cada código nuevo en
//      el MISMO archivo: una fila literal `('admin', '<codigo>')` en `permisos_rol_funcion`, o el
//      `SELECT 'admin', … FROM permisos_funciones` genérico (con su `NOT IN` de exclusiones, si lo hay).
//      Las únicas funciones que pueden quedar sin `admin` son `EXCLUIDAS_DE_ADMIN`, y ninguna
//      migración ≥ 0226 puede marcárselas.
//   2. Red contra el parser: todo código de `catalogoCompleto()` que no aparezca en ninguna migración
//      ≤ 0225 tiene que aparecer en una ≥ 0226. Si una siembra se escribe con otra forma (`COPY`, un
//      DO-block) y el parser no la ve, este aserto se pone rojo en vez de dejar pasar el hueco.
//   3. Regresión: la 0226 existe y contiene el INSERT … SELECT 'admin' (si alguien la «limpia», rojo).
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { catalogoCompleto } from '../../src/modules/permisos/catalogo.js';

/**
 * Las tres funciones del canal SOAT sin trámite que `admin` NO tiene (decisión del PO del 2026-10-07).
 * Motivo: sus rutas (`flito-soat-cliente.routes.ts`: `POST /cliente`, `/cliente/preconsulta`,
 * `/cliente/factura/lectura`) no tienen otra guarda que la función; marcarlas daría a `admin` acceso
 * real a radicar, a la preconsulta RUNT (coste externo y PII del propietario) y al OCR de la factura.
 * Se le podrán marcar cuando la HU #12874 permita radicar escogiendo la compañía — entonces se
 * retira de aquí y una migración nueva se las marca. Ampliar esta lista exige decisión del PO.
 */
const EXCLUIDAS_DE_ADMIN: readonly string[] = ['soat.factura.leer', 'soat.runt.preconsultar', 'soat.solicitud.crear'];

const DIR = fileURLToPath(new URL('../../src/db/migrations/', import.meta.url));
const PRIMERA_VIGILADA = 226;

const archivos = readdirSync(DIR)
  .filter((f) => /^\d{4}_.+\.sql$/.test(f))
  .sort()
  .map((nombre) => ({ nombre, numero: Number(nombre.slice(0, 4)), sql: readFileSync(DIR + nombre, 'utf8') }));

/** Quita comentarios `-- …` para que una explicación en prosa no cuente como siembra ni como marca. */
function sinComentarios(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

/** Los códigos que un archivo inserta en `permisos_funciones` (primer literal de cada tupla del VALUES). */
export function codigosSembrados(sql: string): string[] {
  const limpio = sinComentarios(sql);
  const codigos: string[] = [];
  for (const m of limpio.matchAll(/insert\s+into\s+permisos_funciones\s*\([^)]*\)\s*values([\s\S]*?);/gi)) {
    for (const t of m[1].matchAll(/\(\s*'([a-z0-9_]+\.[a-z0-9_.]+)'\s*,/gi)) codigos.push(t[1]);
  }
  return codigos;
}

/**
 * Las exclusiones del SELECT genérico de `admin` (`… FROM permisos_funciones f WHERE f.codigo NOT IN
 * (…)`): `null` si el archivo no tiene SELECT genérico; `[]` si lo tiene sin exclusiones.
 */
export function exclusionesDelSelectGenerico(sql: string): string[] | null {
  const m = sinComentarios(sql).match(
    /insert\s+into\s+permisos_rol_funcion[^;]*?select\s+'admin'\s*,\s*\w+\.?codigo\s+from\s+permisos_funciones([^;]*);/i,
  );
  if (!m) return null;
  const notIn = m[1].match(/not\s+in\s*\(([^)]*)\)/i);
  return notIn ? [...notIn[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort() : [];
}

/** ¿El archivo marca `codigo` a `admin`? Fila literal, o el SELECT genérico si no lo excluye. */
export function marcaAAdmin(sql: string, codigo: string): boolean {
  const limpio = sinComentarios(sql);
  const excluidas = exclusionesDelSelectGenerico(sql);
  if (excluidas !== null && !excluidas.includes(codigo)) return true;
  for (const m of limpio.matchAll(/insert\s+into\s+permisos_rol_funcion\s*\([^)]*\)\s*values([\s\S]*?);/gi)) {
    const fila = new RegExp(`\\(\\s*'admin'\\s*,\\s*'${codigo.replace(/\./g, '\\.')}'\\s*\\)`, 'i');
    if (fila.test(m[1])) return true;
  }
  return false;
}

/** Los códigos que un archivo siembra sin marcarlos a `admin`. */
function sinMarcarAAdmin(sql: string): string[] {
  return codigosSembrados(sql).filter((c) => !marcaAAdmin(sql, c));
}

describe('HU #13424 AC2 — el parser de siembras detecta lo que dice detectar', () => {
  const SIEMBRA = `INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('modulo.nueva.ver', 'modulo', 'Ver (algo)', 'Descripción, con comas', 'operacion'),
  ('pagina.nueva', 'modulo', 'Nueva', 'x', 'pagina')
ON CONFLICT (codigo) DO NOTHING;`;

  it('una siembra SIN marcar a `admin` sale con sus dos códigos (el caso que pone el test en rojo)', () => {
    expect(sinMarcarAAdmin(SIEMBRA)).toEqual(['modulo.nueva.ver', 'pagina.nueva']);
  });

  it('marcar solo una de las dos deja fuera la otra', () => {
    const sql = `${SIEMBRA}\nINSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES\n  ('admin', 'pagina.nueva'), ('gerente', 'modulo.nueva.ver')\nON CONFLICT DO NOTHING;`;
    expect(sinMarcarAAdmin(sql)).toEqual(['modulo.nueva.ver']);
  });

  it('el SELECT genérico de `admin` sobre `permisos_funciones` las cubre todas', () => {
    const sql = `${SIEMBRA}\nINSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)\nSELECT 'admin', f.codigo FROM permisos_funciones f\nON CONFLICT DO NOTHING;`;
    expect(sinMarcarAAdmin(sql)).toEqual([]);
  });

  it('el SELECT genérico con NOT IN deja fuera exactamente lo excluido', () => {
    const sql = `${SIEMBRA}\nINSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)\nSELECT 'admin', f.codigo FROM permisos_funciones f\nWHERE f.codigo NOT IN ('pagina.nueva')\nON CONFLICT DO NOTHING;`;
    expect(exclusionesDelSelectGenerico(sql)).toEqual(['pagina.nueva']);
    expect(sinMarcarAAdmin(sql)).toEqual(['pagina.nueva']);
  });

  it('un comentario que menciona la marca no cuenta como marca', () => {
    const sql = `${SIEMBRA}\n-- INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES ('admin', 'pagina.nueva');`;
    expect(sinMarcarAAdmin(sql)).toEqual(['modulo.nueva.ver', 'pagina.nueva']);
  });
});

describe('HU #13424 AC2 — toda siembra desde la 0226 marca a `admin`', () => {
  it('las 0224 y 0225 de la Épica 13201 (HU #13409 / #13410) no siembran permisos: quedan fuera de la vigilancia sin hueco', () => {
    // La 0226 es la primera vigilada porque la numeración la ocuparon antes dos migraciones ajenas.
    // Si alguna de ellas sembrara una función, el aserto de «catálogo nuevo» de abajo no la vería.
    for (const n of [224, 225]) {
      const a = archivos.find((x) => x.numero === n);
      expect(a, `migración ${n}`).toBeDefined();
      expect(codigosSembrados(a!.sql), a!.nombre).toEqual([]);
    }
  });

  const vigiladas = archivos.filter((a) => a.numero >= PRIMERA_VIGILADA);

  it('ninguna migración ≥ 0226 siembra un permiso sin marcárselo a `admin` en el mismo archivo (salvo las tres excluidas)', () => {
    const huecos = vigiladas.flatMap((a) => sinMarcarAAdmin(a.sql)
      .filter((c) => !EXCLUIDAS_DE_ADMIN.includes(c)).map((c) => `${a.nombre}: ${c}`));
    expect(huecos).toEqual([]);
  });

  it('ninguna migración ≥ 0226 le marca a `admin` una de las tres excluidas (ni por fila ni por SELECT genérico sin excluirla)', () => {
    const marcadas = vigiladas.flatMap((a) => EXCLUIDAS_DE_ADMIN
      .filter((c) => marcaAAdmin(a.sql, c)).map((c) => `${a.nombre}: ${c}`));
    expect(marcadas).toEqual([]);
  });

  it('las tres excluidas existen en el catálogo (una exclusión de un código muerto no excluye nada)', () => {
    const codigos = new Set(catalogoCompleto().map((f) => f.codigo));
    for (const c of EXCLUIDAS_DE_ADMIN) expect(codigos, c).toContain(c);
  });

  it('todo código del catálogo nuevo desde la 0226 aparece en una migración ≥ 0226 (el parser no se perdió una siembra)', () => {
    const literal = (sql: string, c: string) => sinComentarios(sql).includes(`'${c}'`);
    const anteriores = archivos.filter((a) => a.numero < PRIMERA_VIGILADA);
    const nuevos = catalogoCompleto().map((f) => f.codigo)
      .filter((c) => !anteriores.some((a) => literal(a.sql, c)));
    const sinSiembraVista = nuevos.filter((c) => !vigiladas.some((a) => codigosSembrados(a.sql).includes(c)));
    expect(sinSiembraVista).toEqual([]);
  });

  it('la 0226 existe y marca a `admin` todo el catálogo con el SELECT genérico, excluyendo EXACTAMENTE las tres', () => {
    const la0226 = archivos.find((a) => a.numero === PRIMERA_VIGILADA);
    expect(la0226?.nombre).toBe('0226_permisos_admin_todo_marcado.sql');
    expect(sinComentarios(la0226!.sql)).toMatch(
      /insert\s+into\s+permisos_rol_funcion\s*\(rol_codigo,\s*funcion_codigo\)\s*select\s+'admin',\s*f\.codigo\s+from\s+permisos_funciones\s+f\s+where\s+f\.codigo\s+not\s+in\s*\([^)]*\)\s*on\s+conflict\s+do\s+nothing;/i,
    );
    expect(exclusionesDelSelectGenerico(la0226!.sql)).toEqual([...EXCLUIDAS_DE_ADMIN].sort());
    // `impuestos.recibos.reemplazar` (P-1) sí entra: no está excluida.
    expect(marcaAAdmin(la0226!.sql, 'impuestos.recibos.reemplazar')).toBe(true);
  });
});
