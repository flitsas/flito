// HU #13588 (P-35..P-37) — La 0240 en memoria y su REPORTE EN SECO (AC7): lo MISMO que hace la migración, sobre
// filas, sin base. Lo usa `npm run permisos:en-seco -w apps/api -- --hu 13588` ANTES de aplicar la 0240.
//
// «Hoy» = el resolutor de la #13429, en el que las 5 operaciones eran TRANSVERSALES (marcadas → efectivas, sin
// cadena); «mañana» = el resolutor de esta HU (cada una solo por su ítem) sobre las filas que deja la 0240. Se
// comparan operaciones y páginas (los `menu.*` y `accion.*` son contenedores). Toda pérdida sale nombrada con su
// rol: quien tenía una de las 4 de ítems antiguos SIN ninguno de los ítems que ahora la dan. Sin PII (Ley 1581):
// el detalle es `user_id` + rol.
import type { FilaRolEnSeco, FilaUsuarioEnSeco, UsuarioEnSeco } from '../reparto-en-seco.js';
import { expandir, expandirComoEn13429, SUELTAS_INCORPORADAS_13588 } from './expansion.js';
import type { FilasReparto } from './reparto-arbol.js';
import { OPERACIONES_INCORPORADAS_13588 } from './acciones-legado.js';

/** El ítem nuevo de Administración (`pagina.admin_rendimiento`) y su elemento. */
export const ITEM_RENDIMIENTO = 'pagina.admin_rendimiento';
const ELEMENTO_ADMINISTRACION = 'menu.administracion';
const RUM = 'rum.resumen.ver';
const SUELTAS: ReadonlySet<string> = new Set(SUELTAS_INCORPORADAS_13588);

/**
 * Paso 3c — Los pares operación → ítem antiguo que ahora la concede, ordenados. Es el `tmp_sueltas_13588` de la
 * 0240: el test de la migración compara su VALUES con esta lista.
 */
export function paresSueltas13588(): [string, string][] {
  return Object.entries(OPERACIONES_INCORPORADAS_13588).flatMap(([item, ops]) => ops.map((fn) => [fn, item] as [string, string]))
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
}

const porRol = (filas: FilaRolEnSeco[]) => {
  const m = new Map<string, Set<string>>();
  for (const f of filas) (m.get(f.rol) ?? m.set(f.rol, new Set()).get(f.rol)!).add(f.codigo);
  return m;
};

/** Los pasos 2-4 de la 0240 sobre las filas (el paso 1 siembra el catálogo, no reparte). */
export function repartirSueltos(usuarios: UsuarioEnSeco[], filas: FilasReparto): FilasReparto {
  const rol = porRol(filas.filasRol);
  const filasRol = [...filas.filasRol];
  const tiene = (r: string, c: string) => filasRol.some((f) => f.rol === r && f.codigo === c);
  // Paso 2: el ítem y su elemento a cada rol con `rum.resumen.ver`.
  for (const [r, cs] of rol) {
    if (!cs.has(RUM)) continue;
    for (const fn of [ITEM_RENDIMIENTO, ELEMENTO_ADMINISTRACION]) if (!tiene(r, fn)) filasRol.push({ rol: r, codigo: fn });
  }
  const filasUsuario = filas.filasUsuario.map((f) => ({ ...f }));
  const rolDe = new Map(usuarios.map((u) => [u.id, u.rol]));
  const filaPropia = (id: number, c: string) => filasUsuario.some((f) => f.userId === id && f.codigo === c);
  for (const k of filas.filasUsuario.filter((f) => f.codigo === RUM)) {
    const r = rolDe.get(k.userId);
    if (r === undefined) continue; // la migración hace JOIN con users
    if (k.efecto === 'conceder') {
      // Paso 3a.
      for (const fn of [ITEM_RENDIMIENTO, ELEMENTO_ADMINISTRACION]) {
        if (!tiene(r, fn) && !filaPropia(k.userId, fn)) filasUsuario.push({ userId: k.userId, codigo: fn, efecto: 'conceder' });
      }
    } else if (rol.get(r)?.has(RUM) && !filaPropia(k.userId, ITEM_RENDIMIENTO)) {
      // Paso 3b.
      filasUsuario.push({ userId: k.userId, codigo: ITEM_RENDIMIENTO, efecto: 'revocar' });
    }
  }
  // Paso 3c (fallo cerrado): el `revocar` de una de las 4 de ítems antiguos pasa a `revocar` de cada ítem que ahora
  // la concede y que el usuario tiene marcado por su rol o por un `conceder` propio (que se convierte).
  const pares = paresSueltas13588();
  for (const k of filas.filasUsuario.filter((f) => f.efecto === 'revocar')) {
    const r = rolDe.get(k.userId);
    if (r === undefined) continue;
    for (const [, item] of pares.filter(([fn]) => fn === k.codigo)) {
      const propia = filasUsuario.find((f) => f.userId === k.userId && f.codigo === item);
      if (propia?.efecto === 'conceder') propia.efecto = 'revocar';
      else if (!propia && tiene(r, item)) filasUsuario.push({ userId: k.userId, codigo: item, efecto: 'revocar' });
    }
  }
  // Paso 4: fuera las marcas de las 5.
  return { filasRol: filasRol.filter((f) => !SUELTAS.has(f.codigo)), filasUsuario: filasUsuario.filter((f) => !SUELTAS.has(f.codigo)) };
}

const acceso = (s: Set<string>) => new Set([...s].filter((c) => !c.startsWith('menu.') && !c.startsWith('accion.')));

/** Efectivo de un rol (sin excepciones) o de un usuario (con las suyas); `antes` = las 5 como transversales. */
function efectivoDe(rolCodigos: Iterable<string>, propias: FilaUsuarioEnSeco[], antes: boolean): Set<string> {
  const m = new Set(rolCodigos);
  for (const f of propias) if (f.efecto === 'conceder') m.add(f.codigo);
  const revocados = propias.filter((f) => f.efecto === 'revocar').map((f) => f.codigo);
  for (const r of revocados) m.delete(r);
  // «Hoy» = el resolutor de la #13429: la transversal marcada valía sola; ningún ítem la daba.
  return acceso(antes ? expandirComoEn13429(m, revocados) : expandir(m, revocados));
}

export interface CambioSueltos { pierde: string[]; gana: string[] }
export interface InformeSueltos {
  roles: ({ rol: string; usuarios: number } & CambioSueltos)[];
  usuarios: ({ userId: number; rol: string } & CambioSueltos)[];
  perdidas: number;
  /**
   * Ganancias que NO son la pantalla «Rendimiento» de quien ya veía el resumen RUM: un rol con el ítem y sin la
   * operación marcada la gana (antes no la tenía), y eso también exige aprobación.
   */
  noAprobadas: number;
}

/** El diff de la 0240 por rol (sus filas) y por usuario con excepciones (con las suyas). */
export function informeSueltos(usuarios: UsuarioEnSeco[], antes: FilasReparto): InformeSueltos {
  const despues = repartirSueltos(usuarios, antes);
  const ra = porRol(antes.filasRol);
  const rd = porRol(despues.filasRol);
  const diff = (a: Set<string>, m: Set<string>): CambioSueltos & { noAprobadas: number } => {
    const gana = [...m].filter((c) => !a.has(c)).sort();
    return {
      pierde: [...a].filter((c) => !m.has(c)).sort(), gana,
      noAprobadas: gana.filter((g) => !(g === ITEM_RENDIMIENTO && a.has(RUM))).length,
    };
  };
  const nombres = [...new Set([...ra.keys(), ...usuarios.map((u) => u.rol)])].sort();
  const roles = nombres.map((rol) => ({
    rol, usuarios: usuarios.filter((u) => u.rol === rol).length,
    ...diff(efectivoDe(ra.get(rol) ?? [], [], true), efectivoDe(rd.get(rol) ?? [], [], false)),
  }));
  const conExcepciones = new Set(antes.filasUsuario.map((f) => f.userId));
  const cambios = [...usuarios].filter((u) => conExcepciones.has(u.id)).sort((x, y) => x.id - y.id).map((u) => ({
    userId: u.id, rol: u.rol,
    ...diff(
      efectivoDe(ra.get(u.rol) ?? [], antes.filasUsuario.filter((f) => f.userId === u.id), true),
      efectivoDe(rd.get(u.rol) ?? [], despues.filasUsuario.filter((f) => f.userId === u.id), false),
    ),
  })).filter((c) => c.pierde.length || c.gana.length);
  const todos = [...roles, ...cambios];
  const sinCuenta = <T extends { noAprobadas: number }>({ noAprobadas: _n, ...resto }: T) => resto;
  return {
    roles: roles.map(sinCuenta), usuarios: cambios.map(sinCuenta),
    perdidas: todos.reduce((n, c) => n + c.pierde.length, 0),
    noAprobadas: todos.reduce((n, c) => n + c.noAprobadas, 0),
  };
}

/** Código de salida del script: 0 = paridad (solo «Rendimiento» para quien veía el RUM); 3 = requiere aprobación. */
export const EXIT_REQUIERE_APROBACION = 3;

/** AC7 — Lo que decide el exit code de `permisos:en-seco --hu 13588` y el mensaje que lo acompaña. */
export function veredictoSueltos(i: InformeSueltos): { exitCode: number; mensaje: string } {
  if (i.perdidas === 0 && i.noAprobadas === 0) {
    return { exitCode: 0, mensaje: 'PARIDAD: 0 pérdidas; solo «Rendimiento» para quien ya veía el resumen RUM. Se puede aplicar la 0240.' };
  }
  return {
    exitCode: EXIT_REQUIERE_APROBACION,
    mensaje: `DIFERENCIAS: ${i.perdidas} pérdidas y ${i.noAprobadas} ganancias sin aprobar. Hace falta la aprobación de David `
      + 'antes de aplicar la 0240 en este ambiente (AC7): adjunta este reporte a la HU #13588.',
  };
}

const lista = (xs: string[]) => (xs.length ? xs.map((x) => `\`${x}\``).join(', ') : '—');

/** El informe en Markdown (lo que imprime el script). Sin PII. */
export function informeSueltosMarkdown(i: InformeSueltos, titulo: string): string {
  const l = [`# Reporte en seco — ${titulo}`, '',
    'Las 5 operaciones sueltas (P-29) pasan a su ítem: `vehicles.vehiculos.consultar` → Vehículos, SOAT, Flota y',
    'Trámite Digital; `runt.persona.consultar`, `runt.cedula.leer`, `integraciones.fasecolda.buscar` → Trámite Digital;',
    '`rum.resumen.ver` → Administración · Rendimiento (`pagina.admin_rendimiento`, nuevo).', '',
    '## 1. Por rol (sus filas, sin excepciones)', '',
    '| Rol | Usuarios | Pierde | Gana |', '|---|---|---|---|'];
  for (const r of i.roles) l.push(`| ${r.rol} | ${r.usuarios} | ${lista(r.pierde)} | ${lista(r.gana)} |`);
  l.push('', '## 2. Por usuario con excepciones (solo con cambios; `user_id` + rol, sin PII)', '');
  if (i.usuarios.length === 0) l.push('Ninguno.');
  else {
    l.push('| user_id | Rol | Pierde | Gana |', '|---|---|---|---|');
    for (const c of i.usuarios) l.push(`| ${c.userId} | ${c.rol} | ${lista(c.pierde)} | ${lista(c.gana)} |`);
  }
  l.push('', `## 3. Veredicto: ${veredictoSueltos(i).mensaje}`, '');
  return l.join('\n');
}
