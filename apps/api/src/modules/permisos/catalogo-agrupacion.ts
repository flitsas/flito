// HU #12716 — El módulo con el que se AGRUPA cada función en la pantalla de permisos (y en la bitácora
// del 403). No cambia códigos ni reparto: solo la columna `modulo`. El prefijo del código sigue siendo
// el módulo del FICHERO (lo comprueba `catalogoDeOperaciones`); esto se aplica DESPUÉS de esa
// comprobación, sobre el catálogo ya construido.
//
// Por qué códigos exactos y no prefijos: una entrada que apunte a un código inexistente revienta en
// `catalogoCompleto()` (entrada muerta = error, igual que «función declarada sin guarda viva»). Un
// prefijo (`parametrizacion.tarifas.`) absorbería en silencio una operación futura sin que nadie
// decidiera su módulo.
//
// `reagrupaciones()` es la única fuente de la migración 0205 (`generar-seed-permisos.ts --reagrupar`)
// y de los tests que la comparan: 47 pares en el mapa; 46 cambian de valor respecto a lo estructural
// (`pagina.transito_organismos` ya caía en `transito` por PAGE_GROUPS y va aquí para declarar la
// intención completa, no para cambiar nada).
import type { PageSlug } from '@operaciones/shared-types';

/** Página → módulo de sus acciones. Una página sin acciones NO va aquí: conserva su grupo. */
export const AGRUPACION_DE_PAGINA: Readonly<Partial<Record<PageSlug, string>>> = {
  flito_tramites: 'tramites',
  flito_soat: 'soat',
  flito_impuestos: 'impuestos',
  flito_derechos: 'derechos',
  drive: 'derechos',
  flito_revisiones: 'revisiones',
  flito_compuerta: 'compuerta',
  flito_tablero: 'tablero',
  flito_bitacora: 'bitacora',
  flito_logistica: 'logistica',
  flito_logistica_ruta: 'logistica',
  flito_bolsas: 'bolsas',
  flito_comparendos: 'comparendos',
  flito_conciliacion: 'conciliacion',
  flito_comprobantes: 'comprobantes',
  finanzas_reporte_costos: 'liquidacion',
  users: 'usuarios',
  roles_permisos: 'permisos',
  tramite: 'tramite',
  transito: 'transito',
  transito_organismos: 'transito',
  clients: 'clientes',
  flito_tarifas: 'tarifas',
  flito_servicios_adicionales: 'servicios_adicionales',
};

/** Código de operación (exacto, no prefijo) → módulo de agrupación. */
export const AGRUPACION_DE_OPERACION: Readonly<Record<string, string>> = {
  // El sincronizador vive con los trámites, que es lo que sincroniza.
  'sync.sync.lanzar': 'tramites',
  'sync.sync.ver_estado': 'tramites',
  // Compañías y proveedores: con la pantalla de clientes.
  'parametrizacion.companias.editar': 'clientes',
  'parametrizacion.proveedores.crear': 'clientes',
  'parametrizacion.proveedores.editar': 'clientes',
  // Tarifas: su propia pantalla.
  'parametrizacion.tarifas.crear': 'tarifas',
  'parametrizacion.tarifas.editar': 'tarifas',
  'parametrizacion.tarifas.historial': 'tarifas',
  'parametrizacion.tarifas.listar': 'tarifas',
  'parametrizacion.tarifas.ver_por_cliente': 'tarifas',
  // Servicios adicionales: el catálogo (parametrizacion.*) y la asignación al trámite (finanzas.*)
  // se conceden desde la misma pantalla.
  'parametrizacion.servicios_adicionales.crear': 'servicios_adicionales',
  'parametrizacion.servicios_adicionales.dar_de_baja': 'servicios_adicionales',
  'parametrizacion.servicios_adicionales.editar': 'servicios_adicionales',
  'parametrizacion.servicios_adicionales.listar': 'servicios_adicionales',
  'finanzas.servicios_adicionales.asignar': 'servicios_adicionales',
  'finanzas.servicios_adicionales.quitar': 'servicios_adicionales',
  'finanzas.servicios_adicionales.ver': 'servicios_adicionales',
  // Organismos de tránsito: con la pantalla de tránsito.
  'parametrizacion.organismos.editar': 'transito',
  'parametrizacion.organismos.fijar_modalidad': 'transito',
  'parametrizacion.organismos.ver_vigencias': 'transito',
  // Los tres `.listar` los usan varias pantallas: catálogo compartido, sin pantalla propia.
  'parametrizacion.companias.listar': 'catalogos_compartidos',
  'parametrizacion.proveedores.listar': 'catalogos_compartidos',
  'parametrizacion.organismos.listar': 'catalogos_compartidos',
};

/**
 * HU #13421 (ADR-0023): las operaciones legacy cuyo prefijo (módulo del fichero) no es el de su
 * pantalla. Mapa APARTE de `AGRUPACION_DE_OPERACION` porque aquel es la fuente congelada de la 0205
 * (`reagrupaciones()`): estas funciones nacen ya con su módulo agrupado en la migración que las
 * siembra, no hay nada que reagrupar. Códigos exactos, mismas reglas (entrada muerta = error).
 */
export const AGRUPACION_DE_OPERACION_LEGADO: Readonly<Record<string, string>> = {
  // Conductores, capacitaciones, incidentes, checklists, alcoholimetría, emergencias y jornada viven
  // en el menú PESV aunque sus rutas estén bajo /api/drivers y /api/jornadas.
  'drivers.conductores.administrar': 'pesv',
  'drivers.capacitaciones.administrar': 'pesv',
  'drivers.incidentes.administrar': 'pesv',
  'drivers.incidentes_registro.administrar': 'pesv',
  'drivers.checklists.administrar': 'pesv',
  'drivers.alcoholimetria.administrar': 'pesv',
  'drivers.emergencias.administrar': 'pesv',
  'jornadas.control.administrar': 'pesv',  // HU #13422: cada operación con la pantalla (y el módulo de su página) donde se usa.
  'maintenance.inicio.administrar': 'mantenimiento',
  'maintenance.ordenes.administrar': 'mantenimiento',
  'liquidacion.pago_manual.administrar': 'mantenimiento', // el panel de liquidación vive en la orden de trabajo
  'vehicles.vehiculos.administrar': 'operaciones',
  'vehicles.propietario.ver_documento': 'operaciones',
  'fleet.flota.administrar': 'flota',
  'rutas.rutas.administrar': 'pesv',
  'rutas.pernocta.administrar': 'pesv',
  'finanzas.reporte_costos.ver': 'liquidacion', // como `pagina.finanzas_reporte_costos`
  'clients.clientes.ver': 'clientes',
  'clients.clientes.administrar': 'clientes',
};

/** El módulo de agrupación de un código, o el estructural si el código no está en ningún mapa. */
export function moduloAgrupado(codigo: string, moduloEstructural: string): string {
  if (codigo.startsWith('pagina.')) {
    return AGRUPACION_DE_PAGINA[codigo.slice('pagina.'.length) as PageSlug] ?? moduloEstructural;
  }
  return AGRUPACION_DE_OPERACION[codigo] ?? AGRUPACION_DE_OPERACION_LEGADO[codigo] ?? moduloEstructural;
}

/** Los pares `[codigo, modulo]` de los dos mapas, ordenados por código: lo que la 0205 escribe. */
export function reagrupaciones(): readonly [string, string][] {
  const pares: [string, string][] = [
    ...Object.entries(AGRUPACION_DE_PAGINA).map(([slug, modulo]): [string, string] => [`pagina.${slug}`, modulo!]),
    ...Object.entries(AGRUPACION_DE_OPERACION).map(([codigo, modulo]): [string, string] => [codigo, modulo]),
  ];
  return pares.sort((a, b) => a[0].localeCompare(b[0]));
}
