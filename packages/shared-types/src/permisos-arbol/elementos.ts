// HU #12873 — Los elementos de nivel 1 (`menu.*`) en el orden del menú (diseño Feature #13416 §9 R1).
// Se DECLARAN aquí porque los ítems los nombran como padre; se SIEMBRAN en la base con la #13429.
// «LAFT» y no «Cumplimiento» (P-13: manda el nombre del catálogo aprobado). «Ayuda» es derivada: no
// tiene permiso propio (la ve quien tenga ≥1 capítulo visible) y el panel la pinta sin casilla.
import type { NodoArbolDef } from './index.js';

// Épica #14678 (ADR-0048, expand → contract): `deprecado` = elemento del menú viejo por dominios. Se sigue
// sembrando y devolviendo (sus marcas no se tocan, el arranque no ve códigos huérfanos) pero ya no tiene hijos:
// sus páginas cuelgan de la opción nueva. El panel lo oculta. Se retira en el contract (Épica posterior).
type Marca = 'derivado' | 'deprecado';

const elemento = (clave: string, nombre: string, orden: number, marca?: Marca): NodoArbolDef => ({
  codigo: `menu.${clave}`, nombre, tipo: 'elemento', padre: null, orden, ...(marca ? { [marca]: true } : {}),
});

// Épica #14678 (ADR-0048): las opciones del menú por áreas van primero, en el orden del menú (Operaciones,
// Financiera, Gerencial, Kyverum, Administración, Ayuda). `menu.administracion` se REUTILIZA (no se depreca).
// General (Dr. Flit), Ayuda y Perfil quedan fuera de las áreas. Los ocho deprecados conservan código, nombre y orden;
// por eso las opciones nuevas van en 1-9: ordenar por `orden` da el orden del menú sin empatar con los de antes.
export const ELEMENTOS_PERMISOS: readonly NodoArbolDef[] = [
  elemento('operaciones', 'Operaciones', 1),
  elemento('financiera', 'Financiera', 2),
  // PR 4 (decisión de David, 2026-11-25): las cinco áreas sin pantallas existen como elemento para activarlas por
  // rol; con el elemento marcado el menú pinta el área con «Próximamente». Ningún rol las recibe al sembrarlas.
  elemento('comercial', 'Comercial', 3),
  elemento('diseno', 'Diseño', 4),
  elemento('tecnologia', 'Tecnología', 5),
  elemento('infraestructura', 'Infraestructura', 6),
  elemento('producto', 'Producto', 7),
  elemento('gerencial', 'Gerencial', 8),
  elemento('kyverum', 'Kyverum', 9),
  elemento('general', 'General', 10),
  elemento('gestion', 'Gestión', 20, 'deprecado'),
  elemento('transito', 'Tránsito', 30, 'deprecado'),
  elemento('flota', 'Flota', 40, 'deprecado'),
  elemento('mantenimiento', 'Mantenimiento', 50, 'deprecado'),
  elemento('pesv', 'PESV', 60, 'deprecado'),
  elemento('rndc', 'RNDC', 70, 'deprecado'),
  elemento('laft', 'LAFT', 80, 'deprecado'),
  elemento('finanzas', 'Finanzas', 90, 'deprecado'),
  elemento('administracion', 'Administración', 100),
  elemento('ayuda', 'Ayuda', 110, 'derivado'),
  elemento('perfil', 'Perfil', 120),
];

/** Épica #14678 — Los elementos del menú viejo por dominios (ADR-0048): sin hijos, ocultos en el panel. */
export const ELEMENTOS_DEPRECADOS: readonly string[] = ELEMENTOS_PERMISOS.filter((e) => e.deprecado).map((e) => e.codigo);
