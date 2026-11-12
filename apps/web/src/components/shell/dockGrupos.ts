/*
 * Reparto del dock inferior del UI Kit 2026 para FLITO (briefing de diseño flit-de §3).
 *
 * SOLO PRESENTACIÓN: los ítems visibles siguen saliendo de `useNavSections` (permisos, slugs, funciones). Aquí se
 * decide en qué GRUPO del dock cae cada ruta y con qué ícono se pinta. Una ruta que ningún grupo reclama cae en el
 * cubo «Más» (trampa §12 de la guía del dock: nunca se pierde un ítem por no estar en el reparto).
 *
 * Íconos: inyectivos dentro de cada menú y sin check/flechas/punto (regla del kit).
 */
import type { NavItem } from './navItems';
import type { NombreIcono } from '../flit/kit/Icono';

export type GrupoDockId =
  | 'tramites' | 'impuestos-soat' | 'logistica' | 'flota' | 'finanzas' | 'cumplimiento' | 'administracion' | 'mas';

interface Regla { prefijo: string; icono: NombreIcono | `@${string}`; seccion?: string; descripcion?: string }
interface DefGrupo { id: GrupoDockId; titulo: string; icono: NombreIcono; lado: 'izq' | 'der'; reglas: Regla[] }

// El orden de las reglas dentro de un grupo es el orden de sus entradas en el menú. Prefijo exacto o «prefijo/…».
export const GRUPOS_DOCK: DefGrupo[] = [
  { id: 'tramites', titulo: 'Trámites', icono: 'tramites', lado: 'izq', reglas: [
    { prefijo: '/flito/tramites', icono: 'tramites', descripcion: 'Gestión unificada de trámites' },
    { prefijo: '/transito/organismos', icono: 'banco', descripcion: 'Organismos de tránsito' },
    { prefijo: '/transito', icono: 'radicacion', descripcion: 'Bandeja de tránsito' },
    { prefijo: '/tramite', icono: '@tramite-traspaso', descripcion: 'Traspasos' },
    { prefijo: '/vehicles', icono: 'placa', descripcion: 'Placas y RUNT' },
  ] },
  { id: 'impuestos-soat', titulo: 'Impuestos y SOAT', icono: 'pago', lado: 'izq', reglas: [
    { prefijo: '/flito/impuestos', icono: 'pesos', seccion: 'Obligaciones' },
    { prefijo: '/flito/soat', icono: 'vencido', seccion: 'Obligaciones' },
    { prefijo: '/flito/derechos', icono: 'mazo', seccion: 'Obligaciones' },
    { prefijo: '/flito/comparendos', icono: 'comparendos', seccion: 'Obligaciones' },
    { prefijo: '/flito/certificar', icono: 'medalla', seccion: 'Validación' },
    { prefijo: '/flito/revisiones', icono: 'historial-placa', seccion: 'Validación' },
    { prefijo: '/flito/compuerta', icono: 'candado-abierto', seccion: 'Validación' },
  ] },
  { id: 'logistica', titulo: 'Logística', icono: 'ruta', lado: 'izq', reglas: [
    { prefijo: '/flito/logistica', icono: 'ruta' },
    { prefijo: '/flito/ruta', icono: 'marcador' },
    { prefijo: '/flito/tarifas', icono: 'porcentaje' },
    { prefijo: '/flito/bolsas', icono: 'carpeta' },
    { prefijo: '/flito/bitacora', icono: 'portapapeles' },
    { prefijo: '/flito/servicios-adicionales', icono: 'asterisco' },
  ] },
  { id: 'flota', titulo: 'Flota', icono: 'carro', lado: 'der', reglas: [
    { prefijo: '/fleet', icono: 'carro', seccion: 'Activos' },
    { prefijo: '/pesv/conductores', icono: 'credencial', seccion: 'Activos' },
    { prefijo: '/pesv/jornadas', icono: 'reloj', seccion: 'Activos' },
    { prefijo: '/pesv/mi-jornada', icono: 'cronometro', seccion: 'Activos' },
    { prefijo: '/maintenance/work-orders', icono: 'lista', seccion: 'Taller' },
    { prefijo: '/maintenance/indicators', icono: 'medidor', seccion: 'Taller' },
    { prefijo: '/maintenance/repuestos', icono: 'procesos', seccion: 'Taller' },
    { prefijo: '/maintenance', icono: 'reintento', seccion: 'Taller' },
    { prefijo: '/pesv/checklists', icono: 'doble-check', seccion: 'Taller' },
    { prefijo: '/pesv/incidentes', icono: 'alerta', seccion: 'Taller' },
    { prefijo: '/pesv/reportar', icono: 'megafono', seccion: 'Taller' },
  ] },
  { id: 'finanzas', titulo: 'Finanzas', icono: 'ingreso', lado: 'der', reglas: [
    { prefijo: '/flito/comprobantes', icono: 'documento' },
    { prefijo: '/flito/conciliacion', icono: 'intercambio' },
    { prefijo: '/finanzas/gastos-diarios', icono: 'calendario' },
    { prefijo: '/finanzas/reporte-costos', icono: 'reportes' },
    { prefijo: '/finanzas', icono: 'pesos' },
    { prefijo: '/siigo/operacion', icono: 'integraciones' },
    { prefijo: '/siigo/parametrizacion', icono: 'ajustes' },
    { prefijo: '/clients', icono: 'empresas' },
  ] },
  { id: 'cumplimiento', titulo: 'Cumplimiento', icono: 'escudo', lado: 'der', reglas: [
    { prefijo: '/pesv', icono: 'medidor', seccion: 'PESV' },
    { prefijo: '/laft', icono: 'identidad', seccion: 'LAFT' },
    { prefijo: '/rndc', icono: 'fuentes-oficiales', seccion: 'RNDC' },
    { prefijo: '/privacy', icono: 'candado', seccion: 'Privacidad' },
  ] },
  { id: 'administracion', titulo: 'Administración', icono: 'ajustes', lado: 'der', reglas: [
    { prefijo: '/users', icono: 'usuarios' },
    { prefijo: '/roles-permisos', icono: 'rol' },
    { prefijo: '/drive', icono: 'nube-subir' },
    { prefijo: '/siigo/credenciales', icono: 'candado' },
    { prefijo: '/admin', icono: 'medidor' },
  ] },
];

/** Rutas que no van en el dock: Inicio es el botón central y Ayuda vive en el menú de usuario. */
const FUERA_DEL_DOCK = new Set(['/', '/flito/ayuda']);

const coincide = (to: string, prefijo: string) => to === prefijo || to.startsWith(`${prefijo}/`);

function reglaDe(to: string): { grupo: DefGrupo; regla: Regla } | null {
  for (const grupo of GRUPOS_DOCK) {
    const regla = grupo.reglas.find((r) => coincide(to, r.prefijo));
    if (regla) return { grupo, regla };
  }
  return null;
}

/** Glifo de una ruta del menú (también lo usa el buscador). */
export function iconoDeRuta(to: string): NombreIcono | `@${string}` {
  if (to === '/') return 'rejilla';
  if (to === '/flito/ayuda') return 'ayuda';
  return reglaDe(to)?.regla.icono ?? 'documento';
}

export interface EntradaDock { item: NavItem; icono: NombreIcono | `@${string}`; descripcion?: string }
export interface SeccionDock { titulo: string; entradas: EntradaDock[] }
export interface GrupoDock {
  id: GrupoDockId; titulo: string; icono: NombreIcono; lado: 'izq' | 'der';
  /** Una sola sección sin título = lista simple; varias = `dock__menu--ancho` con columnas. */
  secciones: SeccionDock[];
  total: number;
}

export function agruparDock(items: NavItem[]): GrupoDock[] {
  const porGrupo = new Map<GrupoDockId, Map<string, EntradaDock[]>>();
  const meter = (id: GrupoDockId, seccion: string, e: EntradaDock) => {
    const g = porGrupo.get(id) ?? new Map<string, EntradaDock[]>();
    g.set(seccion, [...(g.get(seccion) ?? []), e]);
    porGrupo.set(id, g);
  };
  // Orden estable: el de las reglas, y dentro de cada regla el del catálogo de navegación.
  for (const grupo of GRUPOS_DOCK) {
    for (const regla of grupo.reglas) {
      for (const item of items) {
        if (FUERA_DEL_DOCK.has(item.to)) continue;
        if (reglaDe(item.to)?.regla !== regla) continue;
        meter(grupo.id, regla.seccion ?? '', { item, icono: regla.icono, descripcion: regla.descripcion });
      }
    }
  }
  for (const item of items) {
    if (FUERA_DEL_DOCK.has(item.to) || reglaDe(item.to)) continue;
    meter('mas', '', { item, icono: 'rejilla' });
  }
  const defs: Array<Pick<GrupoDock, 'id' | 'titulo' | 'icono' | 'lado'>> = [
    ...GRUPOS_DOCK, { id: 'mas', titulo: 'Más', icono: 'rejilla', lado: 'der' },
  ];
  return defs.flatMap((d) => {
    const g = porGrupo.get(d.id);
    if (!g) return [];
    const secciones = Array.from(g, ([titulo, entradas]) => ({ titulo, entradas }));
    return [{ ...d, secciones, total: secciones.reduce((n, s) => n + s.entradas.length, 0) }];
  });
}

/** Grupo de la ruta actual: el de la entrada visible con el prefijo más largo que contiene `pathname`. */
export function grupoDeRuta(pathname: string, grupos: GrupoDock[]): GrupoDockId | null {
  let mejor: { id: GrupoDockId; largo: number } | null = null;
  for (const g of grupos) {
    for (const s of g.secciones) {
      for (const { item } of s.entradas) {
        if (coincide(pathname, item.to) && (!mejor || item.to.length > mejor.largo)) mejor = { id: g.id, largo: item.to.length };
      }
    }
  }
  return mejor?.id ?? null;
}
