// HU #12875 (AC9, diseño §10) — Núcleo PURO del reporte en seco de la frontera por enlace: por rol,
// qué montajes de la API alcanza HOY (modelo interno/externo + lista del canal) y cuáles alcanzará con
// la frontera por enlace (ADR-0024). Sin base ni red: el script `scripts/permisos-reparto-en-seco.ts`
// (`--hu 12875`) le pasa las filas leídas en una transacción READ ONLY y los montajes leídos de
// `app.ts` como texto. Sin PII: códigos de rol y conteos, nunca ids ni nombres de usuario.
//
// Es el ÚNICO código fuera del esquema y las migraciones que nombra el tipo interno/externo retirado:
// el «antes» del reporte ES ese tipo. Lo declara la excepción nombrada del centinela de grep.
import {
  FRONTERA_POR_ENLACE, MODULOS_FRONTERA, type ModuloFrontera, type TipoEnlace,
} from '@operaciones/shared-types';
import { enlaceConocido } from '../../shared/permisos-efectivos.js';

/** Una fila por rol, como la lee el script (tipo crudo: la columna sigue existiendo, retirada). */
export interface RolFronteraEnSeco {
  codigo: string;
  /** `permisos_roles.tipo_principal` crudo (`interno` | `externo`), la foto del «antes». */
  tipoAntes: string | null;
  /** `permisos_roles.tipo_enlace` crudo; `proveedor_soat` se normaliza a `proveedor`. */
  tipoEnlace: string;
  activo: boolean;
  /** Usuarios activos y vivos con ese rol. */
  usuarios: number;
  /** De ellos, cuántos no tienen el id que su enlace exige (compañía, proveedor u organismos). */
  sinIdDeEnlace: number;
}

export interface MontajeEnSeco {
  prefijo: string;
  /** El módulo que declara `conAlcance`, o `null` si el montaje no lo declara (cerrado a enlaces). */
  modulo: ModuloFrontera | null;
}

/** Montajes que no autentican a nadie: ni el antes ni el después los cierran. Fuera del reporte. */
export const PREFIJOS_PUBLICOS: readonly string[] = Object.freeze([
  '/api/rum', '/api/files', '/api/auth/login',
]);

/** Foto CONGELADA de la lista del canal externo (17 rutas, `canal-cliente.ts` en develop 73222e1e). */
export const CANAL_EXTERNO_ANTES = Object.freeze({
  transversales: 4,
  soat: 13,
  prefijoSoat: '/api/flito/soat',
});

const SESION = 'sesión (me, permisos/mios, logout, contraseña propia)';

export interface FilaInforme {
  codigo: string;
  tipoAntes: string;
  enlace: TipoEnlace | null;
  enlaceCrudo: string;
  usuarios: number;
  sinIdDeEnlace: number;
  pierde: string[];
  gana: string[];
}

export interface InformeFrontera {
  filas: FilaInforme[];
  bloqueantes: FilaInforme[];
  ac7: FilaInforme[];
  interinos: { enlace: TipoEnlace; roles: string[]; abiertos: string[]; cerradosHasta13426: string[] }[];
  totalPrefijos: number;
}

const unicos = (xs: string[]): string[] => [...new Set(xs)].sort();

/** Lo que el rol alcanzaba HOY, en unidades comparables (prefijos de montaje + sesión). */
function alcanceAntes(r: RolFronteraEnSeco, prefijos: string[]): { unidades: string[]; soatSoloCanal: boolean } {
  if (r.tipoAntes === 'externo') return { unidades: [SESION, CANAL_EXTERNO_ANTES.prefijoSoat], soatSoloCanal: true };
  return { unidades: [SESION, ...prefijos], soatSoloCanal: false };
}

/** Lo que alcanzará con la frontera por enlace. */
function alcanceDespues(enlace: TipoEnlace | null, montajes: MontajeEnSeco[], prefijos: string[]): string[] {
  if (enlace === 'ninguno') return [SESION, ...prefijos];
  if (enlace === null) return [SESION];
  const abiertos = montajes.filter((m) => m.modulo && (FRONTERA_POR_ENLACE[m.modulo] as readonly string[]).includes(enlace));
  return [SESION, ...unicos(abiertos.map((m) => m.prefijo))];
}

export function fronteraEnSeco(roles: RolFronteraEnSeco[], montajes: MontajeEnSeco[]): InformeFrontera {
  const prefijos = unicos(montajes.map((m) => m.prefijo).filter((p) => !PREFIJOS_PUBLICOS.includes(p)));
  const filas: FilaInforme[] = [...roles].sort((a, b) => a.codigo.localeCompare(b.codigo)).map((r) => {
    const enlace = enlaceConocido(r.tipoEnlace);
    const antes = alcanceAntes(r, prefijos);
    const despues = alcanceDespues(enlace, montajes, prefijos);
    const pierde = antes.unidades.filter((u) => !despues.includes(u));
    const gana = despues.filter((u) => !antes.unidades.includes(u));
    if (antes.soatSoloCanal && despues.includes(CANAL_EXTERNO_ANTES.prefijoSoat)) {
      gana.unshift(`${CANAL_EXTERNO_ANTES.prefijoSoat} entero (antes solo las ${CANAL_EXTERNO_ANTES.soat} rutas del canal; ahora lo que su función permita, acotado a su enlace)`);
    }
    if (antes.soatSoloCanal && enlace === 'ninguno') {
      gana.unshift('SOAT sin acotar (antes: rol externo sin enlace → «nada»)');
    }
    return {
      codigo: r.codigo, tipoAntes: r.tipoAntes ?? '?', enlace, enlaceCrudo: r.tipoEnlace,
      usuarios: r.usuarios, sinIdDeEnlace: r.sinIdDeEnlace, pierde, gana,
    };
  });
  const bloqueantes = filas.filter((f) => f.tipoAntes === 'externo' && f.enlace === 'ninguno');
  const ac7 = filas.filter((f) => f.tipoAntes !== 'externo' && f.enlace === 'compania');
  const enlaces: TipoEnlace[] = ['compania', 'proveedor', 'organismos_transito'];
  const interinos = enlaces.map((enlace) => ({
    enlace,
    roles: filas.filter((f) => f.enlace === enlace).map((f) => f.codigo),
    abiertos: MODULOS_FRONTERA.filter((m) => (FRONTERA_POR_ENLACE[m] as readonly string[]).includes(enlace)),
    cerradosHasta13426: MODULOS_FRONTERA.filter((m) => !(FRONTERA_POR_ENLACE[m] as readonly string[]).includes(enlace)),
  })).filter((i) => i.roles.length > 0);
  return { filas, bloqueantes, ac7, interinos, totalPrefijos: prefijos.length };
}

const celda = (xs: string[], max = 6): string =>
  xs.length === 0 ? '—' : xs.length <= max ? xs.join(', ') : `${xs.slice(0, max).join(', ')} … (+${xs.length - max})`;

export function informeFronteraMarkdown(inf: InformeFrontera, titulo: string): string {
  const l: string[] = [`# Reporte en seco — frontera por enlace — ${titulo}`, '',
    `Montajes autenticados medidos en app.ts: ${inf.totalPrefijos}. «Antes» = tipo interno/externo + lista del canal `
    + `(${CANAL_EXTERNO_ANTES.transversales + CANAL_EXTERNO_ANTES.soat} rutas); «después» = FRONTERA_POR_ENLACE + rutas transversales.`, '',
    '## 1. Por rol', '',
    '| Rol | Tipo (antes) | Enlace (después) | Usuarios activos | Sin id de enlace | Deja de alcanzar | Gana |', '|---|---|---|---|---|---|---|'];
  for (const f of inf.filas) {
    const enl = f.enlace ?? `desconocido («${f.enlaceCrudo}»)`;
    l.push(`| \`${f.codigo}\` | ${f.tipoAntes} | ${enl} | ${f.usuarios} | ${f.sinIdDeEnlace} | ${celda(f.pierde)} (${f.pierde.length}) | ${celda(f.gana)} (${f.gana.length}) |`);
  }
  l.push('', '## 2. BLOQUEANTE — rol externo sin enlace (pasaría a verlo todo)', '');
  if (inf.bloqueantes.length === 0) l.push('Ninguno. Limpio.');
  else {
    for (const f of inf.bloqueantes) {
      l.push(`- \`${f.codigo}\` (${f.usuarios} usuarios): asignarle enlace ANTES del merge`
        + (f.usuarios > 0 ? ' — tiene usuarios: el enlace se cambia con 0 usuarios, hay que moverlos antes.' : ' — 0 usuarios: se cambia desde el panel.'));
    }
  }
  l.push('', '## 3. AC7 — rol interno ligado a compañía (queda acotado a SOAT de su compañía y a la proyección del canal Cliente)', '');
  if (inf.ac7.length === 0) l.push('Ninguno.');
  else for (const f of inf.ac7) l.push(`- \`${f.codigo}\` (${f.usuarios} usuarios): deja de alcanzar ${f.pierde.length} montajes.`);
  l.push('', '## 4. Lo que cada enlace pierde hasta #13426', '');
  if (inf.interinos.length === 0) l.push('Ningún rol con enlace.');
  else {
    for (const i of inf.interinos) {
      l.push(`- **${i.enlace}** (${i.roles.map((r) => `\`${r}\``).join(', ')}): abierto ${i.abiertos.join(', ') || 'solo sesión'}; `
        + `cerrado hasta #13426: ${i.cerradosHasta13426.join(', ')}; además todo montaje legacy y de configuración.`);
    }
  }
  const marcados = inf.bloqueantes.length + inf.ac7.length;
  l.push('', marcados === 0 ? 'Resultado: sin roles marcados (ni BLOQUEANTE ni AC7).'
    : `Resultado: ${inf.bloqueantes.length} BLOQUEANTE, ${inf.ac7.length} AC7.`);
  return l.join('\n');
}

/** Lee los montajes de `app.ts` como texto (patrón de `inventario-guardas.ts`: fuente, no runtime). */
export function montajesDeAppTs(fuente: string): MontajeEnSeco[] {
  const re = /app\.use\(\s*'([^']+)'\s*,\s*(conAlcance\(\s*'([a-z_]+)'\s*,\s*)?([A-Za-z_]\w*)/g;
  const salida: MontajeEnSeco[] = [];
  for (const m of fuente.matchAll(re)) {
    const prefijo = m[1]!;
    // Limitadores (no son routers) y routers públicos (no autentican: ni antes ni después cierran).
    if (!prefijo.startsWith('/api') || !/Routes$/.test(m[4]!) || /Public|Webhook|^(files|rum)Routes$/.test(m[4]!)) continue;
    const modulo = m[3] && (MODULOS_FRONTERA as readonly string[]).includes(m[3]) ? (m[3] as ModuloFrontera) : null;
    salida.push({ prefijo, modulo });
  }
  return salida;
}
