// HU #13421 (ADR-0023 §D4) — El REPORTE EN SECO de un cambio de guardas: quién pasa hoy cada ruta y
// quién pasaría mañana, con las filas de reparto PROPUESTAS simuladas en memoria. Núcleo PURO: recibe
// filas y devuelve el diff; no toca la base ni el logger. Lo usa `scripts/permisos-reparto-en-seco.ts`
// (lectura en transacción READ ONLY) y lo prueba `__tests__/services/permisos-reparto-en-seco.test.ts`.
//
// Semántica de «pasa»:
//   · `codigos`: TODAS las funciones exigidas (página + operación), resueltas como el motor:
//     `(R ∪ C) \ V` — R = reparto del rol, C = excepciones `conceder`, V = excepciones `revocar`.
//   · `roles` (solo en «antes»): `requireRole`, que mira `users.role` y nada más.
// Sin PII (Ley 1581): el detalle es `user_id` + rol. Nunca nombre, correo ni cédula.

export interface UsuarioEnSeco { id: number; rol: string }
export interface FilaRolEnSeco { rol: string; codigo: string }
export interface FilaUsuarioEnSeco { userId: number; codigo: string; efecto: 'conceder' | 'revocar' }

/** Lo que exige una ruta: todas las funciones de `codigos` y, si viene, `users.role ∈ roles`. */
export interface RequisitoEnSeco { codigos: string[]; roles?: string[] }

export interface RutaEnSeco { llave: string; antes: RequisitoEnSeco; despues: RequisitoEnSeco }

/** Las filas que la migración propone: copias vivas (origen → destinos) y filas literales por rol. */
export interface PropuestaEnSeco {
  copias: { origen: string; destinos: string[] }[];
  literales: FilaRolEnSeco[];
}

export interface EntradaEnSeco {
  usuarios: UsuarioEnSeco[];
  filasRol: FilaRolEnSeco[];
  filasUsuario: FilaUsuarioEnSeco[];
  propuesta: PropuestaEnSeco;
  rutas: RutaEnSeco[];
  /** Rutas sin guarda de función (públicas o solo `authMiddleware`), con el motivo. */
  abiertas?: { llave: string; motivo: string }[];
}

export interface CodigoEnSeco { codigo: string; roles: string[]; excepciones: number }
export interface RutaDiff {
  llave: string;
  antes: number;
  despues: number;
  ganan: Record<string, number>;
  pierden: Record<string, number>;
}
export interface DetalleEnSeco { llave: string; userId: number; rol: string; cambio: 'gana' | 'pierde' }

export interface InformeEnSeco {
  codigos: CodigoEnSeco[];
  rutas: RutaDiff[];
  detalle: DetalleEnSeco[];
  abiertas: { llave: string; motivo: string }[];
  diferencias: number;
}

/** Aplica la propuesta sobre las filas vivas, como lo haría la migración (`ON CONFLICT DO NOTHING`). */
export function simularPropuesta(
  filasRol: FilaRolEnSeco[], filasUsuario: FilaUsuarioEnSeco[], propuesta: PropuestaEnSeco,
): { filasRol: FilaRolEnSeco[]; filasUsuario: FilaUsuarioEnSeco[] } {
  const rol = new Map(filasRol.map((f) => [`${f.rol}\u0000${f.codigo}`, f]));
  const usr = new Map(filasUsuario.map((f) => [`${f.userId}\u0000${f.codigo}`, f]));
  for (const { origen, destinos } of propuesta.copias) {
    for (const f of filasRol.filter((x) => x.codigo === origen)) {
      for (const d of destinos) if (!rol.has(`${f.rol}\u0000${d}`)) rol.set(`${f.rol}\u0000${d}`, { rol: f.rol, codigo: d });
    }
    for (const f of filasUsuario.filter((x) => x.codigo === origen)) {
      for (const d of destinos) {
        if (!usr.has(`${f.userId}\u0000${d}`)) usr.set(`${f.userId}\u0000${d}`, { userId: f.userId, codigo: d, efecto: f.efecto });
      }
    }
  }
  for (const f of propuesta.literales) if (!rol.has(`${f.rol}\u0000${f.codigo}`)) rol.set(`${f.rol}\u0000${f.codigo}`, f);
  return { filasRol: [...rol.values()], filasUsuario: [...usr.values()] };
}

/** El conjunto efectivo de cada usuario: `(R ∪ C) \ V`, igual que `resolverPermisos`. */
export function efectivas(
  usuarios: UsuarioEnSeco[], filasRol: FilaRolEnSeco[], filasUsuario: FilaUsuarioEnSeco[],
): Map<number, Set<string>> {
  const porRol = new Map<string, Set<string>>();
  for (const f of filasRol) (porRol.get(f.rol) ?? porRol.set(f.rol, new Set()).get(f.rol)!).add(f.codigo);
  const salida = new Map<number, Set<string>>();
  for (const u of usuarios) {
    const s = new Set(porRol.get(u.rol) ?? []);
    for (const f of filasUsuario) if (f.userId === u.id && f.efecto === 'conceder') s.add(f.codigo);
    for (const f of filasUsuario) if (f.userId === u.id && f.efecto === 'revocar') s.delete(f.codigo);
    salida.set(u.id, s);
  }
  return salida;
}

function pasa(u: UsuarioEnSeco, funciones: Set<string>, r: RequisitoEnSeco): boolean {
  if (r.roles && !r.roles.includes(u.rol)) return false;
  return r.codigos.every((c) => funciones.has(c));
}

const sumar = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };

/** El diff completo. Determinista: rutas en el orden recibido; detalle por ruta y `user_id`. */
export function repartoEnSeco(e: EntradaEnSeco): InformeEnSeco {
  const hoy = efectivas(e.usuarios, e.filasRol, e.filasUsuario);
  const sim = simularPropuesta(e.filasRol, e.filasUsuario, e.propuesta);
  const manana = efectivas(e.usuarios, sim.filasRol, sim.filasUsuario);

  const nuevos = [...new Set([...e.propuesta.copias.flatMap((c) => c.destinos), ...e.propuesta.literales.map((f) => f.codigo)])].sort();
  const codigos = nuevos.map((codigo) => ({
    codigo,
    roles: [...new Set(sim.filasRol.filter((f) => f.codigo === codigo).map((f) => f.rol))].sort(),
    excepciones: sim.filasUsuario.filter((f) => f.codigo === codigo).length,
  }));

  const rutas: RutaDiff[] = [];
  const detalle: DetalleEnSeco[] = [];
  for (const r of e.rutas) {
    const d: RutaDiff = { llave: r.llave, antes: 0, despues: 0, ganan: {}, pierden: {} };
    for (const u of [...e.usuarios].sort((a, b) => a.id - b.id)) {
      const a = pasa(u, hoy.get(u.id)!, r.antes);
      const m = pasa(u, manana.get(u.id)!, r.despues);
      if (a) d.antes++;
      if (m) d.despues++;
      if (m && !a) { sumar(d.ganan, u.rol); detalle.push({ llave: r.llave, userId: u.id, rol: u.rol, cambio: 'gana' }); }
      if (a && !m) { sumar(d.pierden, u.rol); detalle.push({ llave: r.llave, userId: u.id, rol: u.rol, cambio: 'pierde' }); }
    }
    rutas.push(d);
  }
  return { codigos, rutas, detalle, abiertas: e.abiertas ?? [], diferencias: detalle.length };
}

const lista = (m: Record<string, number>) =>
  Object.entries(m).sort(([a], [b]) => a.localeCompare(b)).map(([r, n]) => `${r} (${n})`).join(', ') || '—';

/** El informe en Markdown (lo que el script imprime a stdout). */
export function informeMarkdown(i: InformeEnSeco, titulo: string): string {
  const l: string[] = [`# Reporte en seco — ${titulo}`, ''];
  l.push('## 1. Funciones nuevas y su reparto simulado', '', '| Código | Roles | Excepciones por usuario |', '|---|---|---|');
  for (const c of i.codigos) l.push(`| \`${c.codigo}\` | ${c.roles.join(', ') || '—'} | ${c.excepciones} |`);
  l.push('', '## 2. Por ruta: quién pasa antes y después (usuarios activos)', '',
    '| Ruta | Antes | Después | Ganan (rol) | Pierden (rol) |', '|---|---|---|---|---|');
  for (const r of i.rutas) l.push(`| \`${r.llave}\` | ${r.antes} | ${r.despues} | ${lista(r.ganan)} | ${lista(r.pierden)} |`);
  l.push('', '## 3. Detalle por usuario (solo ganancias y pérdidas; `user_id` + rol, sin PII)', '');
  if (i.detalle.length === 0) l.push('Ninguno.');
  else {
    l.push('| Ruta | user_id | Rol | Cambio |', '|---|---|---|---|');
    for (const d of i.detalle) l.push(`| \`${d.llave}\` | ${d.userId} | ${d.rol} | ${d.cambio} |`);
  }
  l.push('', '## 4. Rutas sin guarda de función (sin cambio)', '');
  if (i.abiertas.length === 0) l.push('Ninguna.');
  else for (const a of i.abiertas) l.push(`- \`${a.llave}\` — ${a.motivo}`);
  l.push('', `## 5. Veredicto: ${i.diferencias === 0 ? 'PARIDAD' : `DIFERENCIAS (${i.diferencias})`}`, '');
  return l.join('\n');
}
