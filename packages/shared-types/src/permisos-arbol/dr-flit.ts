// HU #13941 (decisión de David, 2026-10-24) — General → Dr. Flit. Dr. Flit está disponible para cualquier
// usuario (sin exclusión por tipo de usuario ni por enlace); lo que puede hacer en él lo dicen cuatro
// acciones. La migración 0254 reparte a TODOS los roles el ítem + «Ver los manuales» (reparto universal: un
// rol creado después nace con ambos) y a `admin` las cuatro (ADR-0022: `admin` tiene todas las acciones).
import type { NodoArbolDef } from './index.js';
import { itemsANodos, type ItemDef } from './nodos.js';

export const ITEMS_DR_FLIT: readonly ItemDef[] = [
  { slug: 'flito_dr_flit', clave: 'dr_flit', nombre: 'Dr. Flit', elemento: 'general', orden: 20, acciones: [
    { clave: 'ver_manuales', nombre: 'Ver los manuales', descripcion: 'Consultar en Dr. Flit las fichas de ayuda de las pantallas que puede abrir.' },
    { clave: 'usar_ia', nombre: 'Usar la IA', descripcion: 'Preguntarle a la IA de Dr. Flit sobre los manuales de sus pantallas.' },
    { clave: 'consultar_gestion', nombre: 'Consultar la gestión', descripcion: 'Buscar desde Dr. Flit el estado de trámites, SOAT, impuestos y derechos que puede ver.' },
    { clave: 'radicar_soporte', nombre: 'Radicar casos de soporte', descripcion: 'Enviar desde Dr. Flit un caso a la mesa de soporte, con adjuntos.' },
  ] },
];

/** Ítem y acciones del área, padres antes que hijos. */
export const ARBOL_DR_FLIT: readonly NodoArbolDef[] = itemsANodos(ITEMS_DR_FLIT);
