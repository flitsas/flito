// HU #12873 (ADR-0025 regla 4) — El paso «todos los del grupo» en memoria: lo MISMO que hace la
// migración de reparto (0233), sobre filas, sin base. Lo usan el reporte en seco
// (`npm run permisos:en-seco -w apps/api -- --hu 12873`), el catálogo del código (roles de partida de
// cada acción) y los tests de AC4/AC5 y de paridad con el SQL.
//
//   1. Rol R recibe la acción A si R tenía TODAS las operaciones del grupo de A (ALGUNA si A es de
//      lectura, decisión del PO del 2026-10-13; `cumpleGrupo`).
//   2. Usuario U: con `viejo(U)` = (rol ∪ conceder) \ revocar sobre el grupo, `conceder A` si U tenía
//      todas y su rol (ya repartido) no tiene A; `revocar A` si su rol tiene A y a U le faltaba alguna.
//   2b. AC8 (PO, 2026-10-13): `ROL_CON_TODAS_LAS_ACCIONES` recibe TODAS las acciones (después del 2).
//   3. Se borran las marcas de los códigos absorbidos (roles y usuarios).
// Una acción cuyo grupo ya no existe (`existentes`) no se toca: es la segunda corrida (idempotencia).
// Sin PII (Ley 1581): el detalle es `user_id` + rol.
import type { FilaRolEnSeco, FilaUsuarioEnSeco, UsuarioEnSeco } from '../reparto-en-seco.js';
import { ACCIONES_ARBOL, CODIGOS_ABSORBIDOS, cumpleGrupo, expandir, operacionesDe, predecesoresDe, ROL_CON_TODAS_LAS_ACCIONES } from './expansion.js';

export interface FilasReparto { filasRol: FilaRolEnSeco[]; filasUsuario: FilaUsuarioEnSeco[] }

const porRol = (filas: FilaRolEnSeco[]) => {
  const m = new Map<string, Set<string>>();
  for (const f of filas) (m.get(f.rol) ?? m.set(f.rol, new Set()).get(f.rol)!).add(f.codigo);
  return m;
};

/** Las acciones que el paso reparte: todas las del árbol cuyo grupo existe entero en `existentes`. */
function accionesVivas(existentes?: ReadonlySet<string>): string[] {
  return Object.keys(ACCIONES_ARBOL).sort()
    .filter((a) => !existentes || predecesoresDe(a).every((p) => existentes.has(p)));
}

/** Paso 1 sobre `rol → códigos`: devuelve las acciones que gana cada rol (sin borrar nada). */
export function accionesPorTodos(codigosDelRol: ReadonlySet<string>, existentes?: ReadonlySet<string>): string[] {
  return accionesVivas(existentes).filter((a) => cumpleGrupo(a, (p) => codigosDelRol.has(p)));
}

/** Los pasos 1-3 de la migración, sobre las filas de `permisos_rol_funcion` y `permisos_usuario_funcion`. */
export function repartirPorTodos(
  usuarios: UsuarioEnSeco[], filas: FilasReparto, existentes?: ReadonlySet<string>,
): FilasReparto {
  const roles = porRol(filas.filasRol);
  const nuevasRol: FilaRolEnSeco[] = [];
  for (const [rol, codigos] of roles) {
    for (const a of accionesPorTodos(codigos, existentes)) if (!codigos.has(a)) nuevasRol.push({ rol, codigo: a });
  }
  const rolesDespues = porRol([...filas.filasRol, ...nuevasRol]);
  const ocupadas = new Set(filas.filasUsuario.map((f) => `${f.userId}\u0000${f.codigo}`));
  const nuevasUsuario: FilaUsuarioEnSeco[] = [];
  const vivas = accionesVivas(existentes);
  for (const u of usuarios) {
    const delRol = roles.get(u.rol) ?? new Set<string>();
    const propias = filas.filasUsuario.filter((f) => f.userId === u.id);
    const tiene = (c: string) => (delRol.has(c) || propias.some((f) => f.codigo === c && f.efecto === 'conceder'))
      && !propias.some((f) => f.codigo === c && f.efecto === 'revocar');
    for (const a of vivas) {
      const todos = cumpleGrupo(a, tiene);
      const rolTiene = rolesDespues.get(u.rol)?.has(a) ?? false;
      if (todos === rolTiene || ocupadas.has(`${u.id}\u0000${a}`)) continue;
      nuevasUsuario.push({ userId: u.id, codigo: a, efecto: todos ? 'conceder' : 'revocar' });
    }
  }
  // Paso 2b, como la 0233: después de los usuarios (a los suyos no se les escribe un `revocar`), a todas
  // las acciones del árbol y solo si el rol existe (en la base, el JOIN a `permisos_roles`).
  if (roles.has(ROL_CON_TODAS_LAS_ACCIONES) || usuarios.some((u) => u.rol === ROL_CON_TODAS_LAS_ACCIONES)) {
    const ya = rolesDespues.get(ROL_CON_TODAS_LAS_ACCIONES) ?? new Set<string>();
    for (const a of Object.keys(ACCIONES_ARBOL).sort()) if (!ya.has(a)) nuevasRol.push({ rol: ROL_CON_TODAS_LAS_ACCIONES, codigo: a });
  }
  return {
    filasRol: [...filas.filasRol, ...nuevasRol].filter((f) => !CODIGOS_ABSORBIDOS.has(f.codigo)),
    filasUsuario: [...filas.filasUsuario, ...nuevasUsuario].filter((f) => !CODIGOS_ABSORBIDOS.has(f.codigo)),
  };
}

/** El conjunto efectivo EXPANDIDO de cada usuario: `expandir((R ∪ C) \ V, V)`, igual que el resolutor. */
export function efectivasExpandidas(usuarios: UsuarioEnSeco[], filas: FilasReparto): Map<number, Set<string>> {
  const roles = porRol(filas.filasRol);
  const salida = new Map<number, Set<string>>();
  for (const u of usuarios) {
    const s = new Set(roles.get(u.rol) ?? []);
    const propias = filas.filasUsuario.filter((f) => f.userId === u.id);
    for (const f of propias) if (f.efecto === 'conceder') s.add(f.codigo);
    const revocados = propias.filter((f) => f.efecto === 'revocar').map((f) => f.codigo);
    for (const r of revocados) s.delete(r);
    salida.set(u.id, expandir(s, revocados));
  }
  return salida;
}

/** Los códigos cuyo acceso puede cambiar con el paso: los absorbidos y los de apoyo. */
export function codigosVigilados(): string[] {
  return [...new Set([...CODIGOS_ABSORBIDOS, ...Object.keys(ACCIONES_ARBOL).flatMap((a) => operacionesDe(a))])].sort();
}

export interface CambioUsuario { userId: number; rol: string; pierde: string[]; gana: string[] }
export interface InformeArbol {
  acciones: { codigo: string; roles: string[]; conceder: number; revocar: number }[];
  cambios: CambioUsuario[];
  /**
   * AC8: los roles a los que antes les faltaban como mucho 3 códigos absorbidos (el «rol con todo» y
   * los casi completos), con lo que les faltaba y las acciones que les faltan después. El que tenía
   * todo debe quedar con todas; el que no tenía un grupo entero, sin esa acción y nada más.
   */
  rolesConTodo: { rol: string; faltabanAntes: string[]; faltan: string[] }[];
}

/** El diff del paso para los usuarios dados: pérdidas y ganancias de operaciones efectivas. */
export function informeArbol(usuarios: UsuarioEnSeco[], antes: FilasReparto, existentes?: ReadonlySet<string>): InformeArbol {
  const despues = repartirPorTodos(usuarios, antes, existentes);
  const hoy = efectivasExpandidas(usuarios, antes);
  const manana = efectivasExpandidas(usuarios, despues);
  const vigilados = codigosVigilados();
  const cambios: CambioUsuario[] = [];
  for (const u of [...usuarios].sort((x, y) => x.id - y.id)) {
    const a = hoy.get(u.id)!;
    const m = manana.get(u.id)!;
    const pierde = vigilados.filter((c) => a.has(c) && !m.has(c));
    const gana = vigilados.filter((c) => !a.has(c) && m.has(c));
    if (pierde.length || gana.length) cambios.push({ userId: u.id, rol: u.rol, pierde, gana });
  }
  const acciones = Object.keys(ACCIONES_ARBOL).sort().map((codigo) => ({
    codigo,
    roles: [...new Set(despues.filasRol.filter((f) => f.codigo === codigo).map((f) => f.rol))].sort(),
    conceder: despues.filasUsuario.filter((f) => f.codigo === codigo && f.efecto === 'conceder').length,
    revocar: despues.filasUsuario.filter((f) => f.codigo === codigo && f.efecto === 'revocar').length,
  }));
  const rolesAntes = porRol(antes.filasRol);
  const rolesDespues = porRol(despues.filasRol);
  const absorbidos = [...CODIGOS_ABSORBIDOS];
  const rolesConTodo = [...rolesAntes].sort(([a], [b]) => a.localeCompare(b))
    .map(([rol, c]) => ({ rol, faltabanAntes: absorbidos.filter((x) => !c.has(x)).sort() }))
    .filter((r) => r.faltabanAntes.length <= 3)
    .map((r) => ({ ...r, faltan: Object.keys(ACCIONES_ARBOL).filter((x) => !rolesDespues.get(r.rol)?.has(x)).sort() }));
  return { acciones, cambios, rolesConTodo };
}

const conteo = (cambios: CambioUsuario[], campo: 'pierde' | 'gana') => {
  const m = new Map<string, number>();
  for (const c of cambios) for (const x of c[campo]) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m].sort(([a], [b]) => a.localeCompare(b)).map(([x, n]) => `${x} (${n})`).join(', ') || '—';
};

/** El informe en Markdown (lo que imprime el script). Sin PII. */
export function informeArbolMarkdown(i: InformeArbol, titulo: string, usuarios: UsuarioEnSeco[], filasRol: FilaRolEnSeco[]): string {
  const l: string[] = [`# Reporte en seco — ${titulo}`, '', '## 1. Acciones nuevas y su reparto simulado (regla «todos»; «alguna» en las de lectura)', '',
    '| Acción | Roles | Excepciones conceder | Excepciones revocar |', '|---|---|---|---|'];
  for (const a of i.acciones) l.push(`| \`${a.codigo}\` | ${a.roles.join(', ') || '—'} | ${a.conceder} | ${a.revocar} |`);
  l.push('', '## 2. Por rol: operaciones efectivas que se pierden y se ganan (usuarios activos)', '',
    '| Rol | Usuarios | Con cambios | Pierden (operación: usuarios) | Ganan (operación: usuarios) |', '|---|---|---|---|---|');
  const rolesConUsuarios = [...new Set([...usuarios.map((u) => u.rol), ...filasRol.map((f) => f.rol)])].sort();
  for (const rol of rolesConUsuarios) {
    const delRol = i.cambios.filter((c) => c.rol === rol);
    l.push(`| ${rol} | ${usuarios.filter((u) => u.rol === rol).length} | ${delRol.length} | ${conteo(delRol, 'pierde')} | ${conteo(delRol, 'gana')} |`);
  }
  l.push('', '## 3. Por usuario (solo con cambios; `user_id` + rol, sin PII)', '');
  if (i.cambios.length === 0) l.push('Ninguno.');
  else {
    l.push('| user_id | Rol | Pierde | Gana |', '|---|---|---|---|');
    for (const c of i.cambios) l.push(`| ${c.userId} | ${c.rol} | ${c.pierde.join(', ') || '—'} | ${c.gana.join(', ') || '—'} |`);
  }
  l.push('', '## 4. Roles con todo (o casi) lo absorbido → acciones que les faltan después (AC8)', '');
  if (i.rolesConTodo.length === 0) l.push('Ningún rol tenía todo lo absorbido (ni le faltaban ≤3).');
  for (const r of i.rolesConTodo) {
    l.push(`- ${r.rol}: antes le faltaban ${r.faltabanAntes.join(', ') || 'ninguno'} → después ${r.faltan.length === 0 ? 'tiene todas las acciones' : `le faltan ${r.faltan.join(', ')}`}`);
  }
  const perdidas = i.cambios.filter((c) => c.pierde.length).length;
  const ganancias = i.cambios.filter((c) => c.gana.length).length;
  l.push('', `## 5. Veredicto: ${i.cambios.length === 0 ? 'PARIDAD' : `DIFERENCIAS (${perdidas} usuarios pierden, ${ganancias} ganan)`}`, '');
  return l.join('\n');
}
