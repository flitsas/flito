// HU #12873 (ADR-0025 regla 4) — El paso «todos los del grupo» en memoria: lo MISMO que hace la
// migración de reparto (0233), sobre filas, sin base. Lo usan el reporte en seco
// (`npm run permisos:en-seco -w apps/api -- --hu 12873`), el catálogo del código (roles de partida de
// cada acción) y los tests de AC4/AC5 y de paridad con el SQL.
//
//   1. Rol R recibe la acción A si R tenía TODAS las operaciones del grupo de A (ALGUNA si A es de
//      lectura, decisión del PO del 2026-10-13; `cumpleGrupo`).
//   2. Usuario U: con `viejo(U)` = (rol ∪ conceder) \ revocar sobre el grupo, `conceder A` si U tenía
//      todas y su rol (ya repartido) no tiene A; `revocar A` si su rol tiene A y a U le faltaba alguna.
//   1b. HU #13428 (P-22): las de reparto universal (y la página de su ítem) a CADA rol, si ningún rol la tenía.
//   2b. AC8 (PO, 2026-10-13): `ROL_CON_TODAS_LAS_ACCIONES` recibe TODAS las acciones (después del 2).
//   3. Se borran las marcas de los códigos absorbidos (roles y usuarios).
// Una acción cuyo grupo ya no existe (`existentes`) no se toca: es la segunda corrida (idempotencia).
// Sin PII (Ley 1581): el detalle es `user_id` + rol.
import type { FilaRolEnSeco, FilaUsuarioEnSeco, UsuarioEnSeco } from '../reparto-en-seco.js';
import {
  ACCIONES_ARBOL, ACCIONES_UNIVERSALES, CODIGOS_ABSORBIDOS, CONJUNCIONES_ARBOL, cumpleGrupo, esUniversal, expandir, operacionesDe,
  PARTIDAS_DE_OPERACIONES_NUEVAS as PARTIDA_DE_OPERACION_NUEVA, predecesoresDe, predecesorNoAbsorbido, ROL_CON_TODAS_LAS_ACCIONES,
} from './expansion.js';

export interface FilasReparto { filasRol: FilaRolEnSeco[]; filasUsuario: FilaUsuarioEnSeco[] }

const porRol = (filas: FilaRolEnSeco[]) => {
  const m = new Map<string, Set<string>>();
  for (const f of filas) (m.get(f.rol) ?? m.set(f.rol, new Set()).get(f.rol)!).add(f.codigo);
  return m;
};

/** Todas las acciones del árbol, ordenadas (el alcance por defecto de un reparto). */
const TODAS = Object.keys(ACCIONES_ARBOL).sort();

/**
 * Las acciones que el paso reparte: las del alcance (`acciones`, por defecto todo el árbol; un área cuando
 * se simula SU migración) cuyo grupo existe entero en `existentes`.
 */
function accionesVivas(existentes?: ReadonlySet<string>, acciones: readonly string[] = TODAS): string[] {
  return [...acciones].sort()
    .filter((a) => !existentes || predecesoresDe(a).every((p) => existentes.has(p)));
}

/**
 * Lo que el paso 3 retira dados los `existentes`: los grupos vivos (menos los predecesores de página que la
 * acción no concede, HU #13427 P-19) y las conjunciones con todas sus acciones vivas.
 */
export function absorbidosVivos(existentes?: ReadonlySet<string>, acciones: readonly string[] = TODAS): Set<string> {
  const vivas = new Set(accionesVivas(existentes, acciones));
  return new Set([
    ...[...vivas].flatMap((a) => predecesoresDe(a).filter((p) => !predecesorNoAbsorbido(a, p))),
    ...CONJUNCIONES_ARBOL.filter((c) => c.acciones.every((a) => vivas.has(a))).map((c) => c.operacion),
  ]);
}

/** Paso 1 sobre `rol → códigos`: devuelve las acciones que gana cada rol (sin borrar nada). */
export function accionesPorTodos(codigosDelRol: ReadonlySet<string>, existentes?: ReadonlySet<string>, acciones: readonly string[] = TODAS): string[] {
  return accionesVivas(existentes, acciones).filter((a) => cumpleGrupo(a, (p) => codigosDelRol.has(p)));
}

/** Los pasos 1-3 de la migración, sobre las filas de `permisos_rol_funcion` y `permisos_usuario_funcion`. */
export function repartirPorTodos(
  usuarios: UsuarioEnSeco[], filas: FilasReparto, existentes?: ReadonlySet<string>, acciones: readonly string[] = TODAS,
): FilasReparto {
  const roles = porRol(filas.filasRol);
  const nuevasRol: FilaRolEnSeco[] = [];
  for (const [rol, codigos] of roles) {
    for (const a of accionesPorTodos(codigos, existentes, acciones)) {
      if (!codigos.has(a) && !esUniversal(a)) nuevasRol.push({ rol, codigo: a });
    }
  }
  // Paso 1b, como la 0237: a cada rol conocido (los de las filas y los de los usuarios), si ningún rol la tenía.
  const todosLosRoles = [...new Set([...roles.keys(), ...usuarios.map((u) => u.rol)])].sort();
  for (const { accion, pagina } of ACCIONES_UNIVERSALES.filter((u) => acciones.includes(u.accion))) {
    if (filas.filasRol.some((f) => f.codigo === accion)) continue;
    for (const rol of todosLosRoles) {
      for (const codigo of [accion, pagina]) {
        if (!(roles.get(rol)?.has(codigo)) && !nuevasRol.some((f) => f.rol === rol && f.codigo === codigo)) nuevasRol.push({ rol, codigo });
      }
    }
  }
  const rolesDespues = porRol([...filas.filasRol, ...nuevasRol]);
  const ocupadas = new Set(filas.filasUsuario.map((f) => `${f.userId}\u0000${f.codigo}`));
  const nuevasUsuario: FilaUsuarioEnSeco[] = [];
  const vivas = accionesVivas(existentes, acciones).filter((a) => !esUniversal(a)); // la CTE de usuarios no toca las universales
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
    for (const a of [...acciones].sort()) if (!ya.has(a)) nuevasRol.push({ rol: ROL_CON_TODAS_LAS_ACCIONES, codigo: a });
  }
  // Paso 3, como la 0233: se retira SOLO lo de los grupos que sobreviven al recorte (y la conjunción si
  // sobreviven todas sus acciones). Un grupo incompleto no reparte su acción ni pierde a sus miembros.
  const retirados = absorbidosVivos(existentes, acciones);
  return {
    filasRol: [...filas.filasRol, ...nuevasRol].filter((f) => !retirados.has(f.codigo)),
    filasUsuario: [...filas.filasUsuario, ...nuevasUsuario].filter((f) => !retirados.has(f.codigo)),
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

/**
 * HU #13427 — Los códigos viejos que se PARTEN en operaciones nuevas y ya no los pide ninguna guarda (el
 * transitorio `siigo.parametrizacion.administrar`): no son una pérdida, los representan sus operaciones nuevas.
 */
const PARTIDAS_RETIRADAS: ReadonlySet<string> = new Set(Object.values(PARTIDA_DE_OPERACION_NUEVA)
  .filter((p) => !p.startsWith('pagina.') && !Object.values(ACCIONES_ARBOL).some((a) => a.operaciones.includes(p))));

/** Los códigos cuyo acceso puede cambiar con el paso: los absorbidos y los de apoyo (no las partidas retiradas). */
export function codigosVigilados(acciones: readonly string[] = TODAS): string[] {
  return [...new Set([
    ...(acciones === TODAS ? CODIGOS_ABSORBIDOS : acciones.flatMap((a) => predecesoresDe(a))),
    ...acciones.flatMap((a) => operacionesDe(a)),
  ])].filter((c) => !PARTIDAS_RETIRADAS.has(c)).sort();
}

/**
 * El efectivo de HOY con las operaciones nuevas que ya da su código de partida (la guarda de hoy pide la
 * partida): quien tiene `finanzas.reporte_costos.ver` hoy exporta. Sin esto el informe contaría como
 * «ganancia» lo que la persona ya podía hacer.
 */
function conOperacionesNuevas(efectivas: Map<number, Set<string>>): Map<number, Set<string>> {
  // HU #13428: lo de una acción universal lo hace hoy CUALQUIERA (contraseña propia desde #13425, `/me`).
  const deTodos = ACCIONES_UNIVERSALES.flatMap((u) => operacionesDe(u.accion));
  for (const s of efectivas.values()) {
    for (const [nueva, partida] of Object.entries(PARTIDA_DE_OPERACION_NUEVA)) if (s.has(partida)) s.add(nueva);
    for (const op of deTodos) s.add(op);
  }
  return efectivas;
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
export function informeArbol(
  usuarios: UsuarioEnSeco[], antes: FilasReparto, existentes?: ReadonlySet<string>, acciones: readonly string[] = TODAS,
): InformeArbol {
  const despues = repartirPorTodos(usuarios, antes, existentes, acciones);
  const hoy = conOperacionesNuevas(efectivasExpandidas(usuarios, antes));
  const manana = efectivasExpandidas(usuarios, despues);
  const vigilados = codigosVigilados(acciones);
  const cambios: CambioUsuario[] = [];
  for (const u of [...usuarios].sort((x, y) => x.id - y.id)) {
    const a = hoy.get(u.id)!;
    const m = manana.get(u.id)!;
    const pierde = vigilados.filter((c) => a.has(c) && !m.has(c));
    const gana = vigilados.filter((c) => !a.has(c) && m.has(c));
    if (pierde.length || gana.length) cambios.push({ userId: u.id, rol: u.rol, pierde, gana });
  }
  const filasAccion = [...acciones].sort().map((codigo) => ({
    codigo,
    roles: [...new Set(despues.filasRol.filter((f) => f.codigo === codigo).map((f) => f.rol))].sort(),
    conceder: despues.filasUsuario.filter((f) => f.codigo === codigo && f.efecto === 'conceder').length,
    revocar: despues.filasUsuario.filter((f) => f.codigo === codigo && f.efecto === 'revocar').length,
  }));
  const rolesAntes = porRol(antes.filasRol);
  const rolesDespues = porRol(despues.filasRol);
  const absorbidos = [...absorbidosVivos(undefined, acciones)];
  const rolesConTodo = [...rolesAntes].sort(([a], [b]) => a.localeCompare(b))
    .map(([rol, c]) => ({ rol, faltabanAntes: absorbidos.filter((x) => !c.has(x)).sort() }))
    .filter((r) => r.faltabanAntes.length <= 3)
    .map((r) => ({ ...r, faltan: [...acciones].filter((x) => !rolesDespues.get(r.rol)?.has(x)).sort() }));
  return { acciones: filasAccion, cambios, rolesConTodo };
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
