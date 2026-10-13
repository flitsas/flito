// HU #12873 (ADR-0025, diseño Feature #13416 §4.1) — El SQL del árbol, GENERADO desde el código:
// `npm run permisos:seed -w apps/api -- --arbol gestion [--reparto]`. Lo pegado entre las marcas
// «ÁRBOL GENERADO» de la 0232 (siembra) y la 0233 (reparto) es EXACTAMENTE esta salida; el test de cada
// migración lo compara byte a byte.
//
// Reglas que el texto cumple por construcción:
//   · Idempotente: la siembra es un upsert con `IS DISTINCT FROM`; el reparto descarta las acciones
//     cuyo grupo ya no existe (segunda corrida = nada que repartir, nada que borrar).
//   · Sin literales de rol SUELTOS: el reparto es `INSERT … SELECT` desde filas existentes (un rol
//     ausente = 0 filas, nunca una FK rota como la de la 0227). La única excepción es AC8 (decisión del
//     PO del 2026-10-13): `admin` recibe TODAS las acciones, y su literal va en la forma `JOIN
//     permisos_roles` de la 0227 corregida, que en un ambiente sin el rol también da 0 filas.
//   · Solo literales del código (códigos, nombres): comilla doblada, nada de entrada externa (regla 3).
import { catalogoCompleto, type FuncionCatalogo } from '../catalogo.js';
import {
  ACCIONES_LECTURA, ACCIONES_POR_AREA, ACCIONES_UNIVERSALES, CONJUNCIONES_ARBOL, predecesoresDe, predecesorNoAbsorbido,
  ROL_CON_TODAS_LAS_ACCIONES, type AreaArbol,
} from './expansion.js';

const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** La HU dueña de cada área: sufijo de las tablas temporales, para que dos repartos no compartan nombre. */
export const HU_DE_AREA: Readonly<Record<AreaArbol, string>> = { gestion: '12873', finanzas: '13427', administracion: '13428' };

/** Las tablas temporales del reparto de un área. */
export function tablasTemporales(area: AreaArbol) {
  const hu = HU_DE_AREA[area];
  return { grupos: `tmp_arbol_${hu}`, absorbidas: `tmp_absorbidas_${hu}`, lectura: `tmp_lectura_${hu}`, umbral: `tmp_umbral_${hu}` };
}

/** Las de Gestión (#12873), con su nombre de siempre. */
export const TMP_GRUPOS = 'tmp_arbol_12873';
export const TMP_ABSORBIDAS = 'tmp_absorbidas_12873';
export const TMP_LECTURA = 'tmp_lectura_12873';
export const TMP_UMBRAL = 'tmp_umbral_12873';

/** Siembra de un área: sus acciones (padres antes que hijas) y el `nivel`/`orden` de sus páginas que son ítem. */
export function sqlSiembraArbol(area: AreaArbol = 'gestion', catalogo: FuncionCatalogo[] = catalogoCompleto()): string {
  const delArea = new Set(ACCIONES_POR_AREA[area]);
  const acciones = catalogo.filter((f) => f.tipo === 'accion' && delArea.has(f.codigo));
  const paginasDelArea = new Set(acciones.map((f) => itemDe(f, catalogo)));
  // Padres antes que hijas: la FK `padre_codigo` se comprueba fila a fila dentro del INSERT.
  const nivelDe = (f: FuncionCatalogo): number => (f.padre?.startsWith('accion.') ? 1 : 0);
  const ordenadas = [...acciones].sort((a, b) => nivelDe(a) - nivelDe(b) || a.codigo.localeCompare(b.codigo));
  const items = catalogo.filter((f) => f.tipo === 'pagina' && f.nivel === 2 && paginasDelArea.has(f.codigo));
  return [
    `-- ${acciones.length} acciones (nivel 3). Generado: no editar a mano.`,
    `-- Regenerar con: npm run permisos:seed -w apps/api -- --arbol ${area}`,
    'INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo, padre_codigo, nivel, orden) VALUES',
    ordenadas.map((f) => `  (${[f.codigo, f.modulo, f.nombreNegocio, f.descripcion, f.tipo, f.padre!, String(f.nivel), String(f.orden)].map(lit).join(', ')})`).join(',\n'),
    'ON CONFLICT (codigo) DO UPDATE SET modulo = EXCLUDED.modulo, nombre_negocio = EXCLUDED.nombre_negocio,',
    '  descripcion = EXCLUDED.descripcion, tipo = EXCLUDED.tipo, padre_codigo = EXCLUDED.padre_codigo,',
    '  nivel = EXCLUDED.nivel, orden = EXCLUDED.orden',
    '  WHERE (permisos_funciones.modulo, permisos_funciones.nombre_negocio, permisos_funciones.descripcion,',
    '         permisos_funciones.tipo, permisos_funciones.padre_codigo, permisos_funciones.nivel, permisos_funciones.orden)',
    '    IS DISTINCT FROM (EXCLUDED.modulo, EXCLUDED.nombre_negocio, EXCLUDED.descripcion,',
    '         EXCLUDED.tipo, EXCLUDED.padre_codigo, EXCLUDED.nivel, EXCLUDED.orden);',
    '',
    `-- ${items.length} páginas que son ítem (nivel 2). Su padre (\`menu.*\`) lo pone la HU #13429.`,
    'UPDATE permisos_funciones AS f',
    '   SET nivel = v.nivel::smallint, orden = v.orden::integer',
    '  FROM (VALUES',
    items.map((f) => `    (${lit(f.codigo)}, '2', ${lit(String(f.orden))})`).join(',\n'),
    '  ) AS v(codigo, nivel, orden)',
    ' WHERE f.codigo = v.codigo',
    '   AND (f.nivel, f.orden) IS DISTINCT FROM (v.nivel::smallint, v.orden::integer);',
  ].join('\n');
}

/** La página (ítem) de una acción: se sube por `padre` hasta un `pagina.*`. */
function itemDe(f: FuncionCatalogo, catalogo: FuncionCatalogo[]): string {
  const porCodigo = new Map(catalogo.map((x) => [x.codigo, x]));
  let padre = f.padre!;
  while (padre.startsWith('accion.')) padre = porCodigo.get(padre)!.padre!;
  return padre;
}

/** Reparto de un área: grupos «todos», roles, usuarios, y retiro de lo absorbido. Ver la cabecera de la 0233. */
export function sqlRepartoArbol(area: AreaArbol = 'gestion'): string {
  catalogoCompleto(); // valida árbol ↔ catálogo antes de escribir una migración sobre nada
  const { grupos: TMP_GRUPOS, absorbidas: TMP_ABSORBIDAS, lectura: TMP_LECTURA, umbral: TMP_UMBRAL } = tablasTemporales(area);
  const delArea = ACCIONES_POR_AREA[area];
  const pares = delArea
    .flatMap((a) => [...predecesoresDe(a)].sort().map((fn) => `  (${lit(a)}, ${lit(fn)})`));
  const conjuncionesDelArea = CONJUNCIONES_ARBOL.filter((c) => c.acciones.every((a) => delArea.includes(a)));
  const conjunciones = conjuncionesDelArea.flatMap((c) => [...c.acciones].sort().map((a) => `  (${lit(c.operacion)}, ${lit(a)})`));
  // HU #13427 (P-19): el predecesor de página que la acción no concede no se absorbe (la página sigue siendo el ítem).
  const paginasNoAbsorbidas = [...new Set(delArea.flatMap((a) => predecesoresDe(a).filter((p) => predecesorNoAbsorbido(a, p))))].sort();
  const lectura = delArea.filter((a) => ACCIONES_LECTURA.has(a));
  const universales = ACCIONES_UNIVERSALES.filter((u) => delArea.includes(u.accion));
  return [
    `-- ${pares.length} pares acción → código de su grupo «todos». Generado: no editar a mano.`,
    `-- Regenerar con: npm run permisos:seed -w apps/api -- --arbol ${area} --reparto`,
    `DROP TABLE IF EXISTS ${TMP_GRUPOS};`,
    `CREATE TEMP TABLE ${TMP_GRUPOS} (accion varchar(80) NOT NULL, fn varchar(80) NOT NULL, PRIMARY KEY (accion, fn));`,
    `INSERT INTO ${TMP_GRUPOS} (accion, fn) VALUES`,
    pares.join(',\n') + ';',
    '',
    '-- Idempotencia: una acción se reparte solo si su grupo existe ENTERO. En la segunda corrida ya no',
    '-- existe ninguno (paso 3) y no se reparte ni se revoca nada.',
    `DELETE FROM ${TMP_GRUPOS} t WHERE t.accion IN (`,
    `  SELECT x.accion FROM ${TMP_GRUPOS} x`,
    '   WHERE NOT EXISTS (SELECT 1 FROM permisos_funciones f WHERE f.codigo = x.fn));',
    '',
    '-- Lo absorbido, DESPUÉS del recorte: solo los códigos de los grupos que sobreviven, y la operación de',
    '-- una conjunción solo si sobreviven TODAS sus acciones. Un grupo incompleto no reparte su acción y',
    '-- tampoco pierde ninguno de sus miembros (nota de db-review, 2026-10-13).',
    `DROP TABLE IF EXISTS ${TMP_ABSORBIDAS};`,
    `CREATE TEMP TABLE ${TMP_ABSORBIDAS} (fn varchar(80) PRIMARY KEY);`,
    paginasNoAbsorbidas.length === 0
      ? `INSERT INTO ${TMP_ABSORBIDAS} (fn) SELECT DISTINCT fn FROM ${TMP_GRUPOS};`
      : [
        '-- La página que es predecesor sin que la acción la conceda NO se absorbe: sigue siendo el ítem.',
        `INSERT INTO ${TMP_ABSORBIDAS} (fn) SELECT DISTINCT fn FROM ${TMP_GRUPOS}`,
        ` WHERE fn NOT IN (${paginasNoAbsorbidas.map(lit).join(', ')});`,
      ].join('\n'),
    ...(conjunciones.length === 0 ? [] : [
      `INSERT INTO ${TMP_ABSORBIDAS} (fn)`,
      'SELECT c.fn FROM (VALUES',
      conjunciones.join(',\n'),
      ') AS c(fn, accion)',
      ' GROUP BY c.fn',
      `HAVING bool_and(EXISTS (SELECT 1 FROM ${TMP_GRUPOS} t WHERE t.accion = c.accion))`,
      'ON CONFLICT (fn) DO NOTHING;',
    ]),
    '',
    '-- Acciones de LECTURA (decisión del PO del 2026-10-13): se reciben con ALGUNA operación del grupo.',
    `DROP TABLE IF EXISTS ${TMP_LECTURA};`,
    `CREATE TEMP TABLE ${TMP_LECTURA} (accion varchar(80) PRIMARY KEY);`,
    `INSERT INTO ${TMP_LECTURA} (accion) VALUES`,
    lectura.map((a) => `  (${lit(a)})`).join(',\n') + ';',
    '',
    '-- Umbral de cada acción viva: cuántos códigos del grupo hay que tener (todos; 1 si es de lectura).',
    `DROP TABLE IF EXISTS ${TMP_UMBRAL};`,
    `CREATE TEMP TABLE ${TMP_UMBRAL} AS`,
    `SELECT t.accion, CASE WHEN l.accion IS NULL THEN count(*) ELSE 1 END AS k`,
    `  FROM ${TMP_GRUPOS} t LEFT JOIN ${TMP_LECTURA} l ON l.accion = t.accion`,
    ' GROUP BY t.accion, l.accion;',
    '',
    '-- Paso 1 — Roles: la acción, al rol que tenía TODOS los códigos de su grupo (ALGUNO si es de lectura).',
    'INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)',
    'SELECT rf.rol_codigo, t.accion',
    '  FROM permisos_rol_funcion rf',
    `  JOIN ${TMP_GRUPOS} t ON t.fn = rf.funcion_codigo`,
    ' GROUP BY rf.rol_codigo, t.accion',
    `HAVING count(DISTINCT rf.funcion_codigo) >= (SELECT u.k FROM ${TMP_UMBRAL} u WHERE u.accion = t.accion)`,
    'ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;',
    '',
    ...(universales.length === 0 ? [] : [
      '-- Paso 1b — Reparto UNIVERSAL (HU #13428, P-22): la acción y la página de su ítem, a CADA rol de',
      '-- permisos_roles (sin literales de rol: un rol ausente = 0 filas). Solo si la acción existe y aún no la',
      '-- tiene ningún rol: en la segunda corrida (o tras quitársela a un rol desde el panel) no reparte nada.',
      'INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)',
      'SELECT r.codigo, v.fn',
      '  FROM permisos_roles r',
      ' CROSS JOIN (VALUES',
      universales.flatMap((u) => [`  (${lit(u.accion)}, ${lit(u.accion)})`, `  (${lit(u.accion)}, ${lit(u.pagina)})`]).join(',\n'),
      ' ) AS v(accion, fn)',
      ' WHERE EXISTS (SELECT 1 FROM permisos_funciones f WHERE f.codigo = v.accion)',
      '   AND NOT EXISTS (SELECT 1 FROM permisos_rol_funcion x WHERE x.funcion_codigo = v.accion)',
      'ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;',
      '',
    ]),
    '-- Paso 2 — Usuarios: la misma regla (todos / alguno) sobre SU conjunto efectivo viejo, (rol ∪ conceder) \\ revocar.',
    '-- conceder si lo tenía todo y su rol (ya repartido) no da la acción; revocar si su rol la da y le',
    '-- faltaba algo. Así cada persona queda con exactamente la regla «todos» (AC5).',
    'INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto)',
    "SELECT o.user_id, o.accion, CASE WHEN o.todos THEN 'conceder' ELSE 'revocar' END",
    '  FROM (',
    '    SELECT u.id AS user_id, a.accion,',
    `           (SELECT count(*) FROM ${TMP_GRUPOS} t`,
    '             WHERE t.accion = a.accion',
    '               AND (EXISTS (SELECT 1 FROM permisos_rol_funcion rf WHERE rf.rol_codigo = u.role AND rf.funcion_codigo = t.fn)',
    "                    OR EXISTS (SELECT 1 FROM permisos_usuario_funcion c WHERE c.user_id = u.id AND c.funcion_codigo = t.fn AND c.efecto = 'conceder'))",
    "               AND NOT EXISTS (SELECT 1 FROM permisos_usuario_funcion v WHERE v.user_id = u.id AND v.funcion_codigo = t.fn AND v.efecto = 'revocar')",
    '           ) >= a.k AS todos,',
    '           EXISTS (SELECT 1 FROM permisos_rol_funcion rf WHERE rf.rol_codigo = u.role AND rf.funcion_codigo = a.accion) AS rol_tiene',
    '      FROM users u',
    `     CROSS JOIN ${TMP_UMBRAL} a`,
    '  ) o',
    ' WHERE o.todos <> o.rol_tiene',
    'ON CONFLICT (user_id, funcion_codigo) DO NOTHING;',
    '',
    '-- Paso 2b — AC8 (decisión del PO del 2026-10-13): `admin` recibe TODAS las acciones, también las que',
    '-- la regla «todos» no le daba (solicitar sin trámite: la 0226 le excluyó su grupo hasta la #12874).',
    '-- Va DESPUÉS del paso 2 para que a sus usuarios no se les escriba un `revocar` por un grupo que el',
    '-- rol no tenía entero. JOIN a permisos_roles: un ambiente sin el rol recibe 0 filas, no una FK rota.',
    'INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)',
    'SELECT v.rol, v.fn FROM (VALUES',
    delArea.map((a) => `  (${lit(ROL_CON_TODAS_LAS_ACCIONES)}, ${lit(a)})`).join(',\n'),
    ') AS v(rol, fn)',
    'JOIN permisos_roles r ON r.codigo = v.rol',
    'ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;',
    '',
    '-- Paso 3 — Lo absorbido deja de concederse directo: fuera sus marcas y su fila del catálogo.',
    `DELETE FROM permisos_rol_funcion WHERE funcion_codigo IN (SELECT fn FROM ${TMP_ABSORBIDAS});`,
    `DELETE FROM permisos_usuario_funcion WHERE funcion_codigo IN (SELECT fn FROM ${TMP_ABSORBIDAS});`,
    `DELETE FROM permisos_funciones WHERE codigo IN (SELECT fn FROM ${TMP_ABSORBIDAS});`,
    '',
    `DROP TABLE ${TMP_UMBRAL};`,
    `DROP TABLE ${TMP_LECTURA};`,
    `DROP TABLE ${TMP_ABSORBIDAS};`,
    `DROP TABLE ${TMP_GRUPOS};`,
  ].join('\n');
}
