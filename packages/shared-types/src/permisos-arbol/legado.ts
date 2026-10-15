// HU #13429 (Feature #13416 F3, diseño §5-quater.3) — Los 46 ítems ANTIGUOS del nivel 2: pantallas legacy que
// no tienen nivel 3 y conceden todo lo suyo (qué operaciones, lo dice el API en `arbol/acciones-legado.ts`).
// Nombre = el rótulo de `apps/web/src/components/shell/navItems.ts`, para que el menú de #13431 lea una sola fuente.
//
// Decisiones del PO que se leen aquí:
//   · P-27: «Privacidad y datos» y «Log accesos PII» son la MISMA página (`privacy`): un solo ítem.
//   · P-28: SOAT (antiguo), Lector de impuestos (antiguo) y Mantenimiento (general) quedan como ítems antiguos.
//   · P-24, alternativa A1 (David, 2026-10-13): los 20 ítems PESV con operaciones llevan UNA acción de nivel 3,
//     «Administrar», que absorbe sus transitorios. El ítem da la pantalla y la acción, la administración: así
//     el conductor conserva sus pantallas sin ganar la administración. Los 5 PESV sin operaciones siguen puros.
import type { NodoArbolDef } from './index.js';
import { itemsANodos, type AccionDef, type ItemDef } from './nodos.js';

const ADMINISTRAR: AccionDef[] = [{
  clave: 'administrar', nombre: 'Administrar', descripcion: 'Crear, editar y gestionar los registros de esta pantalla.',
}];

type Def = [slug: ItemDef['slug'], nombre: string, conAdministrar?: boolean];

function items(elemento: string, desde: number, defs: Def[]): ItemDef[] {
  return defs.map(([slug, nombre, conAdministrar], i) => ({
    slug, clave: slug, nombre, elemento, orden: desde + i * 10, legado: true, acciones: conAdministrar ? ADMINISTRAR : [],
  }));
}

/** Los ítems antiguos, por elemento y en el orden del menú (después de los ítems FLITO del mismo elemento). */
export const ITEMS_LEGADO: readonly ItemDef[] = [
  ...items('gestion', 110, [
    ['vehicles', 'Vehículos'], ['tramite', 'Trámite Digital'], ['soat', 'SOAT (antiguo)'], ['tax_reader', 'Lector de impuestos (antiguo)'],
  ]),
  ...items('transito', 20, [['transito', 'Bandeja de trámites']]),
  ...items('flota', 10, [['fleet', 'Flota']]),
  ...items('mantenimiento', 10, [
    ['maintenance_inicio', 'Mantenimiento'], ['maintenance_ordenes', 'Órdenes de trabajo'],
    ['maintenance_indicadores', 'Indicadores mant.'], ['maintenance', 'Mantenimiento (general)'],
  ]),
  ...items('pesv', 10, [
    ['pesv', 'Tablero PESV'], ['pesv_conductores', 'Conductores', true], ['pesv_capacitaciones', 'Capacitaciones', true],
    ['pesv_incidentes', 'Incidentes', true], ['pesv_siniestralidad', 'Estadística siniestros'], ['pesv_checklists', 'Checklists', true],
    ['pesv_alcoholimetria', 'Alcoholimetría', true], ['pesv_emergencias', 'Emergencias', true],
    ['pesv_indicadores_operacion', 'Indicadores op.'], ['pesv_politica', 'Política PSV', true], ['pesv_comite', 'Comité Seguridad Vial', true],
    ['pesv_plan', 'Plan Anual PESV', true], ['pesv_diagnostico', 'Diagnóstico PESV', true],
    ['pesv_tablero_ejecutivo', 'Tablero ejecutivo PESV', true], ['pesv_reportar_incidente', 'Reportar incidente'],
    ['pesv_auditorias', 'Auditorías PESV', true], ['pesv_comunicaciones', 'Comunicaciones', true], ['pesv_contratistas', 'Contratistas', true],
    ['pesv_jornadas', 'Control Jornada (admin)', true], ['pesv_mi_jornada', 'Mi Jornada'], ['pesv_rutas', 'Rutas operativas', true],
    ['pesv_pernocta', 'Zonas de pernocta', true], ['pesv_raci', 'Matriz RACI', true], ['pesv_normativa', 'Tracker normativo', true],
    ['pesv_retencion', 'Retención documental', true],
  ]),
  ...items('rndc', 10, [['rndc', 'RNDC'], ['rndc_admin', 'Credenciales RNDC']]),
  ...items('laft', 10, [
    ['laft', 'Cumplimiento LAFT'], ['laft_unusual', 'Operaciones inusuales'], ['laft_trainings', 'Capacitaciones LAFT'],
    ['laft_manual', 'Manual SARLAFT'], ['laft_oficial', 'Oficial cumplimiento'], ['laft_audit_plan', 'Plan de auditorías'],
    ['laft_dashboard', 'Tablero LAFT'],
  ]),
  ...items('administracion', 40, [['privacy', 'Privacidad y datos'], ['drive', 'Google Drive']]),
];

/** Ítems antiguos (y la acción «Administrar» de los PESV con operaciones), padres antes que hijos. */
export const ARBOL_LEGADO: readonly NodoArbolDef[] = itemsANodos(ITEMS_LEGADO);
