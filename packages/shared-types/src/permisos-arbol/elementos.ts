// HU #12873 — Los elementos de nivel 1 (`menu.*`) en el orden del menú (diseño Feature #13416 §9 R1).
// Se DECLARAN aquí porque los ítems los nombran como padre; se SIEMBRAN en la base con la #13429.
// «LAFT» y no «Cumplimiento» (P-13: manda el nombre del catálogo aprobado). «Ayuda» es derivada: no
// tiene permiso propio (la ve quien tenga ≥1 capítulo visible) y el panel la pinta sin casilla.
import type { NodoArbolDef } from './index.js';

const elemento = (clave: string, nombre: string, orden: number, derivado = false): NodoArbolDef => ({
  codigo: `menu.${clave}`, nombre, tipo: 'elemento', padre: null, orden, ...(derivado ? { derivado } : {}),
});

export const ELEMENTOS_PERMISOS: readonly NodoArbolDef[] = [
  elemento('general', 'General', 10),
  elemento('gestion', 'Gestión', 20),
  elemento('transito', 'Tránsito', 30),
  elemento('flota', 'Flota', 40),
  elemento('mantenimiento', 'Mantenimiento', 50),
  elemento('pesv', 'PESV', 60),
  elemento('rndc', 'RNDC', 70),
  elemento('laft', 'LAFT', 80),
  elemento('finanzas', 'Finanzas', 90),
  elemento('administracion', 'Administración', 100),
  elemento('ayuda', 'Ayuda', 110, true),
  elemento('perfil', 'Perfil', 120),
];
