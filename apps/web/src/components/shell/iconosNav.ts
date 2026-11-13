/*
 * Íconos del menú en la piel del UI Kit 2026. SOLO PRESENTACIÓN.
 *
 * Las secciones, su orden y sus ítems NO se deciden aquí: salen de `useNavSections` (SECTION_ORDER + NAV_ENTRADAS,
 * alineados con el catálogo de permisos de Roles y permisos). Este archivo solo dice con qué glifo se pinta cada
 * sección del dock y cada ruta de sus paneles (y del buscador). Íconos inyectivos dentro de cada panel y sin
 * check/flechas/punto (regla del kit). Una ruta sin entrada cae en `documento`: nunca se pierde un ítem.
 */
import type { NavItem } from './navEntradas';
import type { NombreIcono } from '../flit/kit/Icono';

export type IconoNav = NombreIcono | `@${string}`;

/** Glifo de cada sección del dock (inyectivo en el dock). */
export const ICONO_SECCION: Record<NavItem['section'], NombreIcono> = {
  general: 'rejilla',
  gestion: 'tramites',
  transito: 'radicacion',
  flota: 'carro',
  mantenimiento: 'reintento',
  pesv: 'escudo',
  rndc: 'fuentes-oficiales',
  laft: 'identidad',
  finanzas: 'pesos',
  admin: 'ajustes',
  ayuda: 'ayuda',
};

interface MetaRuta { icono: IconoNav; descripcion?: string }

// Ruta exacta → glifo (y una línea de ayuda opcional bajo el nombre en el panel).
const META_RUTA: Record<string, MetaRuta> = {
  '/': { icono: 'rejilla' },
  // Gestión
  '/vehicles': { icono: 'placa', descripcion: 'Placas y RUNT' },
  '/clients': { icono: 'empresas' },
  '/tramite': { icono: '@tramite-traspaso', descripcion: 'Traspasos' },
  '/flito/tramites': { icono: 'tramites', descripcion: 'Gestión unificada de trámites' },
  '/flito/derechos': { icono: 'mazo' },
  '/flito/revisiones': { icono: 'historial-placa' },
  '/flito/bitacora': { icono: 'portapapeles' },
  '/flito/comparendos': { icono: 'comparendos' },
  '/flito/logistica': { icono: 'ruta' },
  '/flito/ruta': { icono: 'marcador' },
  '/flito/soat': { icono: 'vencido' },
  '/flito/impuestos': { icono: 'pesos' },
  // Tránsito
  '/transito': { icono: 'radicacion', descripcion: 'Bandeja de tránsito' },
  '/transito/organismos': { icono: 'banco', descripcion: 'Organismos de tránsito' },
  // Flota y Mantenimiento
  '/fleet': { icono: 'carro' },
  '/maintenance': { icono: 'reintento' },
  '/maintenance/work-orders': { icono: 'lista' },
  '/maintenance/indicators': { icono: 'medidor' },
  // PESV
  '/pesv': { icono: 'escudo' },
  '/pesv/tablero': { icono: 'reportes' },
  '/pesv/diagnostico': { icono: 'consulta' },
  '/pesv/plan': { icono: 'calendario' },
  '/pesv/politica': { icono: 'firma' },
  '/pesv/comite': { icono: 'usuarios' },
  '/pesv/raci': { icono: 'rol' },
  '/pesv/normativa': { icono: 'fuentes-oficiales' },
  '/pesv/auditorias': { icono: 'lista' },
  '/pesv/retencion': { icono: 'archivo' },
  '/pesv/comunicaciones': { icono: 'correo' },
  '/pesv/contratistas': { icono: 'empresas' },
  '/pesv/conductores': { icono: 'credencial' },
  '/pesv/capacitaciones': { icono: 'medalla' },
  '/pesv/alcoholimetria': { icono: 'biometria' },
  '/pesv/jornadas': { icono: 'reloj' },
  '/pesv/mi-jornada': { icono: 'cronometro' },
  '/pesv/incidentes': { icono: 'alerta' },
  '/pesv/incidentes/stats': { icono: 'reporte-detallado' },
  '/pesv/reportar': { icono: 'megafono' },
  '/pesv/checklists': { icono: 'doble-check' },
  '/pesv/emergencias': { icono: 'exclamacion' },
  '/pesv/rutas': { icono: 'ruta' },
  '/pesv/pernocta': { icono: 'marcador' },
  '/pesv/operacion-indicadores': { icono: 'medidor' },
  // RNDC
  '/rndc': { icono: 'fuentes-oficiales' },
  '/rndc/remesas': { icono: 'documento' },
  '/rndc/manifiestos': { icono: 'portapapeles' },
  '/rndc/maestros': { icono: 'lista' },
  '/rndc/admin/credenciales': { icono: 'candado' },
  // LAFT
  '/laft': { icono: 'identidad' },
  '/laft/unusual': { icono: 'alerta' },
  '/laft/trainings': { icono: 'medalla' },
  '/laft/manual': { icono: 'archivo' },
  '/laft/oficial': { icono: 'persona' },
  '/laft/plan-auditorias': { icono: 'calendario' },
  '/laft/tablero': { icono: 'reportes' },
  // Finanzas
  '/finanzas/reporte-costos': { icono: 'reportes' },
  '/finanzas/gastos-diarios': { icono: 'calendario' },
  '/flito/bolsas': { icono: 'carpeta' },
  '/flito/tarifas': { icono: 'porcentaje' },
  '/flito/servicios-adicionales': { icono: 'asterisco' },
  '/flito/comprobantes': { icono: 'documento' },
  '/flito/conciliacion': { icono: 'intercambio' },
  '/siigo/parametrizacion': { icono: 'ajustes' },
  '/siigo/operacion': { icono: 'integraciones' },
  // Administración
  '/privacy/log-pii': { icono: 'log-mensajes' },
  '/users': { icono: 'usuarios', descripcion: 'Quién entra y qué puede hacer' },
  '/roles-permisos': { icono: 'rol', descripcion: 'Qué ve y hace cada rol' },
  '/drive': { icono: 'nube-bajar', descripcion: 'Carpetas y archivos de Drive' },
  '/privacy': { icono: 'candado' },
  '/siigo/credenciales': { icono: 'candado-abierto' },
  '/admin/rendimiento': { icono: 'medidor', descripcion: 'Velocidad de la plataforma' },
  // Ayuda
  '/flito/ayuda': { icono: 'ayuda' },
};

/** Glifo de una ruta del menú (dock y buscador). */
export function iconoDeRuta(to: string): IconoNav {
  return META_RUTA[to]?.icono ?? 'documento';
}

/** Línea de ayuda opcional bajo el nombre de la ruta en el panel del dock. */
export function descripcionDeRuta(to: string): string | undefined {
  return META_RUTA[to]?.descripcion;
}
