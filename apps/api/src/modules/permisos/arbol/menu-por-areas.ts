// Épica #14678 (ADR-0048, expand → contract) — El menú por áreas de la empresa: las páginas que la 0315 cambia de
// elemento (`menu.*`), con el elemento y el orden que tenían ANTES. El árbol vivo (`@operaciones/shared-types`) ya
// dice el destino; esta lista es la historia, y sirve a tres cosas:
//   · el catálogo (`catalogoCompleto`): un elemento conserva los roles de las páginas que se le fueron. Los ocho
//     deprecados y `menu.administracion` NO pierden marcas en la 0315 (expand), así que el catálogo tampoco;
//   · los generadores de las migraciones históricas (0232-0239, 0303-0309): las reescriben tal como se aplicaron,
//     con el árbol de antes (`catalogoAntesDeAreas`, `padreAntesDeAreas`); una migración aplicada no cambia;
//   · el test de la 0315: su `VALUES` es exactamente esta lista.
// Sin PII: son códigos de permiso.
import { ARBOL_PERMISOS } from '@operaciones/shared-types';
import type { FuncionCatalogo } from '../catalogo.js';
import { PADRE } from './expansion.js';

/** Los elementos que siembra la 0315 (opciones del menú con entradas). `menu.administracion` se reutiliza. */
export const ELEMENTOS_NUEVOS_14678: readonly string[] = ['menu.operaciones', 'menu.financiera', 'menu.gerencial', 'menu.kyverum'];

/**
 * Las cinco áreas sin pantallas que siembra la 0316 (PR 4): sin hijos y sin marca para ningún rol, `admin` incluido
 * (decisión de David del 2026-11-25, enmienda 1 de ADR-0048). No existían antes de la 0315 ni de la 0316, así que el
 * árbol de antes tampoco las tiene.
 */
export const ELEMENTOS_AREAS_VACIAS_14678: readonly string[] = [
  'menu.comercial', 'menu.diseno', 'menu.tecnologia', 'menu.infraestructura', 'menu.producto',
];

/** El elemento de antes → sus páginas que se mueven, con el orden que tenían (árbol de `develop` antes de la 0315). */
const ANTES: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, number]>]> = [
  ['menu.gestion', [
    ['flito_tramites', 10], ['flito_soat', 20], ['flito_impuestos', 30], ['flito_derechos', 40], ['flito_revisiones', 50],
    ['flito_logistica', 60], ['flito_logistica_ruta', 70], ['flito_comparendos', 80], ['clients', 90], ['flito_bitacora', 100],
    ['vehicles', 110], ['tramite', 120], ['soat', 130], ['tax_reader', 140],
  ]],
  ['menu.transito', [['transito_organismos', 10], ['transito', 20]]],
  ['menu.flota', [['fleet', 10]]],
  ['menu.mantenimiento', [['maintenance_inicio', 10], ['maintenance_ordenes', 20], ['maintenance_indicadores', 30], ['maintenance', 40]]],
  ['menu.pesv', [
    'pesv', 'pesv_conductores', 'pesv_capacitaciones', 'pesv_incidentes', 'pesv_siniestralidad', 'pesv_checklists',
    'pesv_alcoholimetria', 'pesv_emergencias', 'pesv_indicadores_operacion', 'pesv_politica', 'pesv_comite', 'pesv_plan',
    'pesv_diagnostico', 'pesv_tablero_ejecutivo', 'pesv_reportar_incidente', 'pesv_auditorias', 'pesv_comunicaciones',
    'pesv_contratistas', 'pesv_jornadas', 'pesv_mi_jornada', 'pesv_rutas', 'pesv_pernocta', 'pesv_raci', 'pesv_normativa',
    'pesv_retencion',
  ].map((s, i) => [s, (i + 1) * 10] as const)],
  ['menu.rndc', [['rndc', 10], ['rndc_admin', 20]]],
  ['menu.laft', [
    ['laft', 10], ['laft_unusual', 20], ['laft_trainings', 30], ['laft_manual', 40], ['laft_oficial', 50], ['laft_audit_plan', 60],
    ['laft_dashboard', 70],
  ]],
  ['menu.finanzas', [
    ['finanzas_reporte_costos', 10], ['finanzas_gastos_diarios', 20], ['flito_bolsas', 30], ['flito_tarifas', 40],
    ['flito_servicios_adicionales', 50], ['flito_comprobantes', 60], ['flito_conciliacion', 70], ['siigo_parametrizacion', 80],
    ['siigo_operacion', 90],
  ]],
  ['menu.administracion', [['siigo_credenciales', 30], ['torre_umbrales', 70]]],
  ['menu.general', [
    ['dashboard', 10], ['torre_360', 30], ['torre_comercial', 40], ['torre_operativa', 50], ['torre_financiera', 60],
    ['torre_explorador', 70], ['torre_detalle', 80], ['torre_productos', 90], ['torre_logistica', 100],
  ]],
];

export interface MovimientoDeArea { pagina: string; viejo: string; ordenViejo: number; nuevo: string; orden: number }

const NODO = new Map(ARBOL_PERMISOS.map((n) => [n.codigo, n]));

/** Las páginas que la 0315 re-parenta, ordenadas por código: de dónde vienen y adónde van (y su orden en cada sitio). */
export const MENU_POR_AREAS: readonly MovimientoDeArea[] = ANTES.flatMap(([viejo, paginas]) => paginas.map(([slug, ordenViejo]) => {
  const pagina = `pagina.${slug}`;
  const nodo = NODO.get(pagina);
  if (!nodo?.padre) throw new Error(`menu-por-areas: ${pagina} no está en el árbol`);
  return { pagina, viejo, ordenViejo, nuevo: nodo.padre, orden: nodo.orden };
})).sort((a, b) => a.pagina.localeCompare(b.pagina));

/** La página que la 0315 movió → el elemento del que colgaba antes. */
export const ELEMENTO_ANTERIOR: ReadonlyMap<string, string> = new Map(MENU_POR_AREAS.map((m) => [m.pagina, m.viejo]));
const ORDEN_ANTERIOR: ReadonlyMap<string, number> = new Map(MENU_POR_AREAS.map((m) => [m.pagina, m.ordenViejo]));
/** Lo que no existía en el árbol de antes: los cuatro de la 0315 y las cinco áreas vacías de la 0316. */
const NUEVOS = new Set([...ELEMENTOS_NUEVOS_14678, ...ELEMENTOS_AREAS_VACIAS_14678]);

/** El árbol de antes de la 0315 (nodo → padre), para los reportes en seco de la 0239 y la 0240 (su resolutor). */
export const PADRE_ANTES_DE_AREAS: ReadonlyMap<string, string | null> = new Map(
  [...PADRE].filter(([c]) => !NUEVOS.has(c)).map(([c, p]) => [c, ELEMENTO_ANTERIOR.get(c) ?? p]),
);

/** El padre de un nodo en el árbol de antes de la 0315 (lo que escriben las migraciones históricas). */
export function padreAntesDeAreas(codigo: string): string | null {
  return ELEMENTO_ANTERIOR.get(codigo) ?? PADRE.get(codigo) ?? null;
}

/**
 * El catálogo como era antes de la 0315: sin los cuatro elementos nuevos (ni las cinco áreas de la 0316) y con cada página movida en su elemento y
 * orden de antes. Solo para regenerar migraciones históricas; los roles no se tocan (ningún generador histórico emite
 * los roles de un elemento).
 */
export function catalogoAntesDeAreas(catalogo: FuncionCatalogo[]): FuncionCatalogo[] {
  return catalogo.filter((f) => !NUEVOS.has(f.codigo)).map((f) => {
    const viejo = ELEMENTO_ANTERIOR.get(f.codigo);
    return viejo ? { ...f, padre: viejo, orden: ORDEN_ANTERIOR.get(f.codigo)! } : f;
  });
}
