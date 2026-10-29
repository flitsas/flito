// HU #13429 (diseño §5-quater.6) — El SQL de la 0238 (siembra) y de la 0239 (reparto), GENERADO desde el código:
// `npm run permisos:seed -w apps/api -- --arbol legado [--reparto]`. Lo pegado entre las marcas «ÁRBOL GENERADO»
// de cada migración es EXACTAMENTE esta salida; el test de cada una lo compara byte a byte.
//
// Reglas que el texto cumple por construcción (las mismas de `sql-arbol.ts`):
//   · Idempotente: upserts y UPDATE con `IS DISTINCT FROM`; el reparto de la cadena solo corre en la PRIMERA
//     pasada (`tmp_primera_13429`: aún existen las operaciones de los ítems antiguos), y en la segunda no hay
//     nada que retirar. Así un `menu.*` quitado desde el panel entre dos corridas no vuelve.
//   · Sin literales de rol: todo reparto es `INSERT … SELECT` desde filas existentes; el único literal es el
//     de `admin` del paso 2b genérico, por `JOIN permisos_roles`.
//   · Las tablas temporales llevan el sufijo de la HU (`_13429`).
import { ARBOL_ITEMS_Y_ACCIONES, ELEMENTOS_PERMISOS } from '@operaciones/shared-types';
import { catalogoCompleto, type FuncionCatalogo } from '../catalogo.js';
import { ACCIONES_POR_AREA, PADRE, paginaDeAccion } from './expansion.js';
import { ITEMS_LEGADO_OPS } from './acciones-legado.js';
import { ACCIONES_NACIDAS_TRAS_LA_SIEMBRA } from './acciones-finanzas.js';
import { ITEM_DR_FLIT } from './acciones-dr-flit.js';
import { lit, sqlRepartoArbol } from './sql-arbol.js';

export const TMP_LEGADO = 'tmp_legado_13429';
export const TMP_CADENA = 'tmp_cadena_13429';
export const TMP_PRIMERA = 'tmp_primera_13429';

/**
 * HU #13588 — Los nodos del árbol nacidos DESPUÉS de la 0239 (los siembra la 0240). La 0238 y la 0239 ya están
 * aplicadas: su texto no cambia, así que el generador que lo reproduce byte a byte (TC-24) los deja fuera.
 */
export const NACIDOS_DESPUES_DE_0239: ReadonlySet<string> = new Set([
  'pagina.admin_rendimiento',
  // HU #13889 (ADR-0028): las acciones del expediente documental, sembradas por la 0248; y desde la HU
  // #13941 las de Dr. Flit, que siembra la 0254 junto con su ítem.
  ...ACCIONES_NACIDAS_TRAS_LA_SIEMBRA,
  ITEM_DR_FLIT,
  // HU #14110: opcional de `accion.logistica.ver_actas`; su `padre_codigo` lo siembra la 0280 (la 0238 ya está aplicada).
  'logistica.actas.ver_documento_firmante',
  // HU #14110: opcional de `accion.mi_ruta.escanear`; su `padre_codigo` lo siembra también la 0280.
  'logistica.recogida.confirmar',
  // HU #14143: opcional de `accion.logistica.reversar_paso`; su `padre_codigo` lo siembra la 0281.
  'logistica.documento.resolver_tramite',
]);

/** Operación de ítem antiguo → ítem, ordenado (lo que lee la 0239 y el pliegue del test). */
export function paresLegado(): [string, string][] {
  return Object.entries(ITEMS_LEGADO_OPS).flatMap(([item, i]) => i.operaciones.map((fn) => [fn, item] as [string, string]))
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
}

/** Cada ítem y cada acción del árbol con su ítem y su elemento (la cadena que la 0239 completa). */
export function cadenaDelArbol(): [string, string, string][] {
  return ARBOL_ITEMS_Y_ACCIONES.filter((n) => !NACIDOS_DESPUES_DE_0239.has(n.codigo)).map((n) => {
    const item = n.tipo === 'item' ? n.codigo : paginaDeAccion(n.codigo);
    return [n.codigo, item, PADRE.get(item)!] as [string, string, string];
  }).sort((a, b) => a[0].localeCompare(b[0]));
}

const upsertFunciones = (cols: string, filas: string[], set: string[]): string[] => [
  `INSERT INTO permisos_funciones (${cols}) VALUES`,
  filas.join(',\n'),
  `ON CONFLICT (codigo) DO UPDATE SET ${set.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`,
  `  WHERE (${set.map((c) => `permisos_funciones.${c}`).join(', ')})`,
  `    IS DISTINCT FROM (${set.map((c) => `EXCLUDED.${c}`).join(', ')});`,
];

/** 0238 — elementos, padre/nivel/orden de toda página, acciones «Administrar» de PESV y padre de los opcionales. */
export function sqlSiembraLegado(catalogo: FuncionCatalogo[] = catalogoCompleto()): string {
  const porCodigo = new Map(catalogo.map((f) => [f.codigo, f]));
  const elementos = ELEMENTOS_PERMISOS.filter((e) => !e.derivado).map((e) => porCodigo.get(e.codigo)!);
  const paginas = catalogo.filter((f) => f.tipo === 'pagina' && !NACIDOS_DESPUES_DE_0239.has(f.codigo));
  const delArea = new Set(ACCIONES_POR_AREA.legado);
  const acciones = catalogo.filter((f) => delArea.has(f.codigo));
  const opcionales = catalogo.filter((f) => f.tipo === 'operacion' && f.padre && !NACIDOS_DESPUES_DE_0239.has(f.codigo));
  const fila = (vs: string[]) => `  (${vs.map(lit).join(', ')})`;
  return [
    `-- ${elementos.length} elementos (nivel 1; «Ayuda» no: es derivada). Generado: no editar a mano.`,
    '-- Regenerar con: npm run permisos:seed -w apps/api -- --arbol legado',
    ...upsertFunciones('codigo, modulo, nombre_negocio, descripcion, tipo, nivel, orden',
      elementos.map((f) => fila([f.codigo, f.modulo, f.nombreNegocio, f.descripcion, f.tipo, String(f.nivel), String(f.orden)])),
      ['modulo', 'nombre_negocio', 'descripcion', 'tipo', 'nivel', 'orden']),
    '',
    `-- ${paginas.length} páginas: todas son ítem (nivel 2) y cuelgan de su elemento.`,
    'UPDATE permisos_funciones AS f',
    '   SET padre_codigo = v.padre, nivel = v.nivel::smallint, orden = v.orden::integer',
    '  FROM (VALUES',
    paginas.map((f) => `    (${[f.codigo, f.padre!, '2', String(f.orden)].map(lit).join(', ')})`).join(',\n'),
    '  ) AS v(codigo, padre, nivel, orden)',
    ' WHERE f.codigo = v.codigo',
    '   AND (f.padre_codigo, f.nivel, f.orden) IS DISTINCT FROM (v.padre, v.nivel::smallint, v.orden::integer);',
    '',
    `-- ${acciones.length} acciones «Administrar» de los ítems PESV con operaciones (P-24, A1).`,
    ...upsertFunciones('codigo, modulo, nombre_negocio, descripcion, tipo, padre_codigo, nivel, orden',
      acciones.map((f) => fila([f.codigo, f.modulo, f.nombreNegocio, f.descripcion, f.tipo, f.padre!, String(f.nivel), String(f.orden)])),
      ['modulo', 'nombre_negocio', 'descripcion', 'tipo', 'padre_codigo', 'nivel', 'orden']),
    '',
    `-- ${opcionales.length} opcionales: cuelgan de su acción o de su ítem antiguo (nivel NULL: no son nodos).`,
    'UPDATE permisos_funciones AS f',
    '   SET padre_codigo = v.padre',
    '  FROM (VALUES',
    opcionales.map((f) => `    (${lit(f.codigo)}, ${lit(f.padre!)})`).join(',\n'),
    '  ) AS v(codigo, padre)',
    ' WHERE f.codigo = v.codigo',
    '   AND f.padre_codigo IS DISTINCT FROM v.padre;',
  ].join('\n');
}

/** 0239 — reparto de «Administrar» de PESV (regla genérica) y luego la cadena y el retiro del legado. */
export function sqlRepartoLegado(): string {
  const primera = `(SELECT si FROM ${TMP_PRIMERA})`;
  const rolTiene = (rol: string, fn: string) => `EXISTS (SELECT 1 FROM permisos_rol_funcion rx WHERE rx.rol_codigo = ${rol} AND rx.funcion_codigo = ${fn})`;
  return [
    sqlRepartoArbol('legado'),
    '',
    '-- ── Ítems antiguos (§5-quater.3) ──',
    `-- ${paresLegado().length} pares operación → ítem antiguo que la expande (una operación puede estar en varios).`,
    `DROP TABLE IF EXISTS ${TMP_LEGADO};`,
    `CREATE TEMP TABLE ${TMP_LEGADO} (fn varchar(80) NOT NULL, item varchar(80) NOT NULL, PRIMARY KEY (fn, item));`,
    `INSERT INTO ${TMP_LEGADO} (fn, item) VALUES`,
    paresLegado().map(([fn, item]) => `  (${lit(fn)}, ${lit(item)})`).join(',\n') + ';',
    '',
    `-- ${cadenaDelArbol().length} nodos (ítems y acciones) con su ítem y su elemento.`,
    `DROP TABLE IF EXISTS ${TMP_CADENA};`,
    `CREATE TEMP TABLE ${TMP_CADENA} (codigo varchar(80) PRIMARY KEY, item varchar(80) NOT NULL, elemento varchar(80) NOT NULL);`,
    `INSERT INTO ${TMP_CADENA} (codigo, item, elemento) VALUES`,
    cadenaDelArbol().map((t) => `  (${t.map(lit).join(', ')})`).join(',\n') + ';',
    '',
    '-- Primera pasada = aún existen operaciones de ítems antiguos (el paso D las borra). La segunda no reparte nada.',
    `DROP TABLE IF EXISTS ${TMP_PRIMERA};`,
    `CREATE TEMP TABLE ${TMP_PRIMERA} AS SELECT EXISTS (SELECT 1 FROM permisos_funciones f JOIN ${TMP_LEGADO} l ON l.fn = f.codigo) AS si;`,
    '',
    '-- Paso A — Roles: quien tiene una operación de ítem antiguo sin ningún ítem que la expanda recibe el primero.',
    'INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)',
    'SELECT rf.rol_codigo, min(l.item)',
    `  FROM permisos_rol_funcion rf JOIN ${TMP_LEGADO} l ON l.fn = rf.funcion_codigo`,
    ` WHERE NOT EXISTS (SELECT 1 FROM ${TMP_LEGADO} l2 WHERE l2.fn = rf.funcion_codigo AND ${rolTiene('rf.rol_codigo', 'l2.item')})`,
    ' GROUP BY rf.rol_codigo, rf.funcion_codigo',
    'ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;',
    '',
    '-- Paso B — Usuarios: el `conceder` de una operación de ítem antiguo sin ítem efectivo concede el primer ítem',
    '-- no revocado. Si el usuario los tiene todos revocados, no se toca: pérdida declarada en el reporte en seco.',
    'INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto)',
    "SELECT c.user_id, min(l.item), 'conceder'",
    '  FROM permisos_usuario_funcion c',
    '  JOIN users u ON u.id = c.user_id',
    `  JOIN ${TMP_LEGADO} l ON l.fn = c.funcion_codigo`,
    " WHERE c.efecto = 'conceder'",
    "   AND NOT EXISTS (SELECT 1 FROM permisos_usuario_funcion x WHERE x.user_id = c.user_id AND x.funcion_codigo = l.item AND x.efecto = 'revocar')",
    `   AND NOT EXISTS (SELECT 1 FROM ${TMP_LEGADO} l2 WHERE l2.fn = c.funcion_codigo`,
    `                    AND (${rolTiene('u.role', 'l2.item')}`,
    "                         OR EXISTS (SELECT 1 FROM permisos_usuario_funcion k WHERE k.user_id = c.user_id AND k.funcion_codigo = l2.item AND k.efecto = 'conceder'))",
    "                    AND NOT EXISTS (SELECT 1 FROM permisos_usuario_funcion v WHERE v.user_id = c.user_id AND v.funcion_codigo = l2.item AND v.efecto = 'revocar'))",
    ' GROUP BY c.user_id, c.funcion_codigo',
    'ON CONFLICT (user_id, funcion_codigo) DO NOTHING;',
    '',
    '-- Paso C1 — Roles: el ítem de cada acción que tienen (en el pliegue: auditor y transito → Organismos STT,',
    '-- mensajero → Logística). La acción anidada sin su madre NO recibe la madre: pérdida declarada.',
    'INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)',
    'SELECT DISTINCT rf.rol_codigo, c.item',
    `  FROM permisos_rol_funcion rf JOIN ${TMP_CADENA} c ON c.codigo = rf.funcion_codigo`,
    ` WHERE c.item <> c.codigo AND ${primera}`,
    'ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;',
    '',
    '-- Paso C2 — Roles: el elemento de cada ítem (y de cada acción) que tienen; incluye `menu.perfil` a todos.',
    'INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)',
    'SELECT DISTINCT rf.rol_codigo, c.elemento',
    `  FROM permisos_rol_funcion rf JOIN ${TMP_CADENA} c ON c.codigo = rf.funcion_codigo`,
    ` WHERE ${primera}`,
    'ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;',
    '',
    '-- Paso C3 — Usuarios: el `conceder` de un nodo cuyo ítem o elemento no le da su rol recibe el que falte,',
    '-- salvo que el usuario lo tenga revocado (la revocación fue explícita): pérdida declarada en el reporte.',
    ...['item', 'elemento'].flatMap((col) => [
      'INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto)',
      `SELECT DISTINCT k.user_id, c.${col}, 'conceder'`,
      '  FROM permisos_usuario_funcion k',
      '  JOIN users u ON u.id = k.user_id',
      `  JOIN ${TMP_CADENA} c ON c.codigo = k.funcion_codigo`,
      ` WHERE k.efecto = 'conceder' AND c.${col} <> c.codigo AND ${primera}`,
      `   AND NOT ${rolTiene('u.role', `c.${col}`)}`,
      `   AND NOT EXISTS (SELECT 1 FROM permisos_usuario_funcion x WHERE x.user_id = k.user_id AND x.funcion_codigo = c.${col})`,
      'ON CONFLICT (user_id, funcion_codigo) DO NOTHING;',
    ]),
    '',
    '-- Paso D — Lo que expanden los ítems antiguos (43 transitorios en total con los de PESV, y las permanentes)',
    '-- deja de concederse directo: fuera sus marcas y su fila. Las guardas siguen pidiendo esas operaciones.',
    `DELETE FROM permisos_rol_funcion WHERE funcion_codigo IN (SELECT fn FROM ${TMP_LEGADO});`,
    `DELETE FROM permisos_usuario_funcion WHERE funcion_codigo IN (SELECT fn FROM ${TMP_LEGADO});`,
    `DELETE FROM permisos_funciones WHERE codigo IN (SELECT fn FROM ${TMP_LEGADO});`,
    '',
    `DROP TABLE ${TMP_PRIMERA};`,
    `DROP TABLE ${TMP_CADENA};`,
    `DROP TABLE ${TMP_LEGADO};`,
  ].join('\n');
}
