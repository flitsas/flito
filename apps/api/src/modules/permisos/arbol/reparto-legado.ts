// HU #13429 (diseño §5-quater.8, AC3 y AC9) — La 0239 en memoria y su REPORTE EN SECO: lo MISMO que hace la
// migración (`sql-legado.ts`), sobre filas, sin base. Lo usa `npm run permisos:en-seco -w apps/api -- --hu 13429`
// (antes de aplicar la 0239, sobre una copia de DEV) y lo prueba `permisos-reparto-en-seco.test.ts`.
//
// «Hoy» = la expansión plana de antes (`expandirSinCadena`); «mañana» = el resolutor en cadena (`expandir`) sobre las
// filas que dejaría la 0239. Se comparan operaciones y páginas (los `menu.*` y `accion.*` son contenedores). Toda
// pérdida bloquea el PR; toda ganancia se clasifica: transitorio retirado (AC3), página sembrada (P-30) u otra (no
// aprobada: también bloquea). Sin PII (Ley 1581): el detalle es `user_id` + rol.
import type { FilaRolEnSeco, FilaUsuarioEnSeco, UsuarioEnSeco } from '../reparto-en-seco.js';
import { ACCIONES_POR_AREA, expandir, expandirSinCadena } from './expansion.js';
import { TRANSITORIOS_RETIRADOS } from './acciones-legado.js';
import { repartirPorTodos, type FilasReparto } from './reparto-arbol.js';
import { cadenaDelArbol, paresLegado } from './sql-legado.js';

const clave = (a: string | number, b: string) => `${a}\u0000${b}`;

/** Los pasos de la 0239 (1-3 genéricos, A, B, C, D) sobre las filas. `existentes` = `permisos_funciones` de hoy. */
export function repartirLegado(usuarios: UsuarioEnSeco[], filas: FilasReparto, existentes?: ReadonlySet<string>): FilasReparto {
  const tras = repartirPorTodos(usuarios, filas, existentes, ACCIONES_POR_AREA.legado);
  const legado = paresLegado();
  const itemsDe = new Map<string, string[]>();
  for (const [fn, item] of legado) itemsDe.set(fn, [...(itemsDe.get(fn) ?? []), item].sort());
  const primera = !existentes || legado.some(([fn]) => existentes.has(fn));
  const rol = new Map(tras.filasRol.map((f) => [clave(f.rol, f.codigo), f]));
  const usr = new Map(tras.filasUsuario.map((f) => [clave(f.userId, f.codigo), f]));
  const rolTiene = (r: string, c: string) => rol.has(clave(r, c));
  const propia = (id: number, c: string) => usr.get(clave(id, c))?.efecto;
  const rolDe = new Map(usuarios.map((u) => [u.id, u.rol]));

  // Paso A — rol con operación antigua sin ítem que la expanda → el primer ítem.
  for (const f of [...rol.values()]) {
    const items = itemsDe.get(f.codigo);
    if (items && !items.some((i) => rolTiene(f.rol, i))) rol.set(clave(f.rol, items[0]!), { rol: f.rol, codigo: items[0]! });
  }
  // Paso B — `conceder` de operación antigua sin ítem efectivo → `conceder` del primer ítem no revocado.
  for (const f of [...usr.values()].filter((x) => x.efecto === 'conceder')) {
    const items = itemsDe.get(f.codigo);
    const r = rolDe.get(f.userId);
    if (!items || r === undefined) continue;
    if (items.some((i) => (rolTiene(r, i) || propia(f.userId, i) === 'conceder') && propia(f.userId, i) !== 'revocar')) continue;
    const item = items.find((i) => propia(f.userId, i) !== 'revocar');
    if (item && !usr.has(clave(f.userId, item))) usr.set(clave(f.userId, item), { userId: f.userId, codigo: item, efecto: 'conceder' });
  }
  if (primera) {
    const cadena = cadenaDelArbol();
    // Paso C1/C2 — roles: el ítem de cada acción y el elemento de cada nodo.
    for (const col of [1, 2] as const) {
      for (const f of [...rol.values()]) {
        for (const t of cadena) if (t[0] === f.codigo && t[col] !== t[0]) rol.set(clave(f.rol, t[col]), { rol: f.rol, codigo: t[col] });
      }
    }
    // Paso C3 — usuarios: el ítem y el elemento que le falten a cada `conceder`, salvo los que tenga revocados.
    for (const col of [1, 2] as const) {
      for (const f of [...usr.values()].filter((x) => x.efecto === 'conceder')) {
        const r = rolDe.get(f.userId);
        if (r === undefined) continue;
        for (const t of cadena) {
          if (t[0] !== f.codigo || t[col] === t[0] || rolTiene(r, t[col]) || usr.has(clave(f.userId, t[col]))) continue;
          usr.set(clave(f.userId, t[col]), { userId: f.userId, codigo: t[col], efecto: 'conceder' });
        }
      }
    }
  }
  // Paso D — fuera las operaciones de los ítems antiguos.
  const fuera = new Set(legado.map(([fn]) => fn));
  return {
    filasRol: [...rol.values()].filter((f) => !fuera.has(f.codigo)),
    filasUsuario: [...usr.values()].filter((f) => !fuera.has(f.codigo)),
  };
}

const acceso = (s: Set<string>) => new Set([...s].filter((c) => !c.startsWith('menu.') && !c.startsWith('accion.')));

function efectivoDe(rolCodigos: Iterable<string>, propias: FilaUsuarioEnSeco[], cadena: boolean): Set<string> {
  const m = new Set(rolCodigos);
  for (const f of propias) if (f.efecto === 'conceder') m.add(f.codigo);
  const revocados = propias.filter((f) => f.efecto === 'revocar').map((f) => f.codigo);
  for (const r of revocados) m.delete(r);
  return acceso(cadena ? expandir(m, revocados) : expandirSinCadena(m, revocados));
}

const TRANSITORIOS = new Set(TRANSITORIOS_RETIRADOS);
export type ClaseGanancia = 'ac3' | 'visibilidad' | 'no_aprobada';
export function claseDeGanancia(codigo: string): ClaseGanancia {
  if (TRANSITORIOS.has(codigo)) return 'ac3';
  return codigo.startsWith('pagina.') ? 'visibilidad' : 'no_aprobada';
}

export interface CambioLegado { pierde: string[]; gana: string[] }
export interface InformeLegado {
  roles: ({ rol: string; usuarios: number } & CambioLegado)[];
  usuarios: ({ userId: number; rol: string } & CambioLegado)[];
  sembrado: { rol: string; codigos: string[] }[];
  perdidas: number;
  noAprobadas: number;
}

/** El diff de la 0239 por rol (sus filas, sin excepciones) y por usuario (con las suyas). */
export function informeLegado(usuarios: UsuarioEnSeco[], antes: FilasReparto, existentes?: ReadonlySet<string>): InformeLegado {
  const despues = repartirLegado(usuarios, antes, existentes);
  const porRol = (filas: FilaRolEnSeco[]) => {
    const m = new Map<string, Set<string>>();
    for (const f of filas) (m.get(f.rol) ?? m.set(f.rol, new Set()).get(f.rol)!).add(f.codigo);
    return m;
  };
  const ra = porRol(antes.filasRol);
  const rd = porRol(despues.filasRol);
  const diff = (a: Set<string>, m: Set<string>): CambioLegado => ({
    pierde: [...a].filter((c) => !m.has(c)).sort(), gana: [...m].filter((c) => !a.has(c)).sort(),
  });
  const nombres = [...new Set([...ra.keys(), ...usuarios.map((u) => u.rol)])].sort();
  const roles = nombres.map((rol) => ({
    rol, usuarios: usuarios.filter((u) => u.rol === rol).length,
    ...diff(efectivoDe(ra.get(rol) ?? [], [], false), efectivoDe(rd.get(rol) ?? [], [], true)),
  }));
  const cambios = [...usuarios].sort((x, y) => x.id - y.id).map((u) => ({
    userId: u.id, rol: u.rol,
    ...diff(
      efectivoDe(ra.get(u.rol) ?? [], antes.filasUsuario.filter((f) => f.userId === u.id), false),
      efectivoDe(rd.get(u.rol) ?? [], despues.filasUsuario.filter((f) => f.userId === u.id), true),
    ),
  })).filter((c) => c.pierde.length || c.gana.length);
  const sembrado = nombres.map((rol) => ({
    rol, codigos: [...(rd.get(rol) ?? [])].filter((c) => /^(menu|pagina)\./.test(c) && !ra.get(rol)?.has(c)).sort(),
  })).filter((s) => s.codigos.length);
  const todos = [...roles, ...cambios];
  return {
    roles, usuarios: cambios, sembrado,
    perdidas: todos.reduce((n, c) => n + c.pierde.length, 0),
    noAprobadas: todos.reduce((n, c) => n + c.gana.filter((g) => claseDeGanancia(g) === 'no_aprobada').length, 0),
  };
}

const porClase = (gana: string[], clase: ClaseGanancia) => gana.filter((g) => claseDeGanancia(g) === clase);
const lista = (xs: string[]) => (xs.length ? xs.map((x) => `\`${x}\``).join(', ') : '—');

/** El informe en Markdown (lo que imprime el script). Sin PII. */
export function informeLegadoMarkdown(i: InformeLegado, titulo: string): string {
  const l = [`# Reporte en seco — ${titulo}`, '',
    '## 1. Por rol (sus filas, sin excepciones): pérdidas por gating y ganancias', '',
    '| Rol | Usuarios | Pierde | Gana AC3 (transitorio retirado) | Gana visibilidad (P-30) | Gana sin aprobar |', '|---|---|---|---|---|---|'];
  for (const r of i.roles) {
    l.push(`| ${r.rol} | ${r.usuarios} | ${lista(r.pierde)} | ${porClase(r.gana, 'ac3').length} ${lista(porClase(r.gana, 'ac3'))} | ${lista(porClase(r.gana, 'visibilidad'))} | ${lista(porClase(r.gana, 'no_aprobada'))} |`);
  }
  l.push('', '## 2. Por usuario (solo con cambios; `user_id` + rol, sin PII)', '');
  if (i.usuarios.length === 0) l.push('Ninguno.');
  else {
    l.push('| user_id | Rol | Pierde | Gana |', '|---|---|---|---|');
    for (const c of i.usuarios) l.push(`| ${c.userId} | ${c.rol} | ${lista(c.pierde)} | ${lista(c.gana)} |`);
  }
  l.push('', '## 3. Visibilidad sembrada (`menu.*` y páginas que la cadena añade a cada rol)', '');
  for (const s of i.sembrado) l.push(`- ${s.rol}: ${s.codigos.join(', ')}`);
  l.push('', `## 4. Veredicto: ${i.perdidas === 0 && i.noAprobadas === 0 ? 'PARIDAD (0 pérdidas; solo ganancias aprobadas)' : `DIFERENCIAS (${i.perdidas} pérdidas, ${i.noAprobadas} ganancias sin aprobar)`}`, '');
  return l.join('\n');
}
