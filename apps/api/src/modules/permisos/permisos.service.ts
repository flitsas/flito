// HU #12081 — Lectura del catálogo de funciones (AC5) y la comprobación de arranque (AC6).
import { asc } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { permisosFunciones, permisosRolFuncion } from '../../db/schema.js';
import { catalogoCompleto } from './catalogo.js';

export interface FuncionDeGrupo {
  codigo: string;
  nombreNegocio: string;
  descripcion: string;
  tipo: string;
}

export interface GrupoDeFunciones {
  modulo: string;
  funciones: FuncionDeGrupo[];
}

/** El catálogo agrupado por módulo, que es como lo pinta la pantalla de permisos. */
export async function catalogoAgrupado(): Promise<GrupoDeFunciones[]> {
  const filas = await db.select({
    codigo: permisosFunciones.codigo,
    modulo: permisosFunciones.modulo,
    nombreNegocio: permisosFunciones.nombreNegocio,
    descripcion: permisosFunciones.descripcion,
    tipo: permisosFunciones.tipo,
  }).from(permisosFunciones)
    .orderBy(asc(permisosFunciones.modulo), asc(permisosFunciones.codigo));

  const grupos = new Map<string, FuncionDeGrupo[]>();
  for (const f of filas) {
    const lista = grupos.get(f.modulo) ?? [];
    lista.push({ codigo: f.codigo, nombreNegocio: f.nombreNegocio, descripcion: f.descripcion, tipo: f.tipo });
    grupos.set(f.modulo, lista);
  }
  return [...grupos.entries()].map(([modulo, funciones]) => ({ modulo, funciones }));
}

/**
 * Las funciones del catálogo que NO se le conceden a `admin`, y por qué está bien (AC6).
 *
 * Son las tres del canal Cliente, guardadas con `requireRole('cliente')` a secas: `admin` NO entra a
 * ellas hoy, y sembrárselas para que la cuenta cuadre sería inventar un permiso que el código no da.
 * El AC6 pedía «falla si alguna función no está concedida a admin»; medido contra el código, eso es
 * falso para estas tres, así que la comprobación las nombra una a una en vez de aflojarse. Añadir una
 * función nueva sigue obligando a decidir: o se le concede a `admin`, o se escribe aquí y se explica.
 */
export const FUNCIONES_SIN_ADMIN: readonly string[] = [
  'soat.solicitud.crear',   // POST /flito/soat/cliente          — requireRole('cliente')
  'soat.runt.preconsultar', // POST /flito/soat/cliente/preconsulta
  'soat.factura.leer',      // POST /flito/soat/cliente/factura/lectura
];

export class ArranquePermisosError extends Error {}

/**
 * Comprobación de arranque (AC6): el catálogo que el CÓDIGO declara y el que hay en la BASE son el
 * mismo, y `admin` no se ha quedado sin ninguna función en silencio.
 *
 * Falla ruidosamente y a propósito: un catálogo desincronizado no se manifiesta como un error, se
 * manifiesta como una pantalla que desaparece para alguien. Si la tabla está vacía —una base sin la
 * 0179— el mensaje lo dice con esas palabras en vez de listar 260 funciones que «faltan».
 */
export async function verificarCatalogoAlArrancar(): Promise<void> {
  const enCodigo = catalogoCompleto();  // ya valida guarda ↔ nombre en los dos sentidos
  const filas = await db.select({ codigo: permisosFunciones.codigo }).from(permisosFunciones);

  if (filas.length === 0) {
    throw new ArranquePermisosError(
      'permisos_funciones está vacía: falta aplicar la migración 0179_permisos_modelo.sql.',
    );
  }

  const enBase = new Set(filas.map((f) => f.codigo));
  const faltan = enCodigo.filter((f) => !enBase.has(f.codigo)).map((f) => f.codigo);
  const sobran = [...enBase].filter((c) => !enCodigo.some((f) => f.codigo === c));
  if (faltan.length || sobran.length) {
    throw new ArranquePermisosError(
      'El catálogo de la base y el del código no coinciden.\n' +
      (faltan.length ? `  El código exige y la base no declara (${faltan.length}): ${faltan.join(', ')}\n` : '') +
      (sobran.length ? `  La base declara y el código no usa (${sobran.length}): ${sobran.join(', ')}\n` : '') +
      '  Regenera el seed con `npm run permisos:seed -w apps/api` y añade la migración que falte.',
    );
  }

  const sinAdmin = await funcionesSinAdmin();
  const inesperadas = sinAdmin.filter((c) => !FUNCIONES_SIN_ADMIN.includes(c));
  if (inesperadas.length) {
    throw new ArranquePermisosError(
      `El rol admin no tiene concedidas ${inesperadas.length} funciones del catálogo: ` +
      `${inesperadas.join(', ')}. O se le conceden, o se declaran en FUNCIONES_SIN_ADMIN con su ` +
      'motivo: una función nueva no puede dejar al administrador fuera en silencio (AC6).',
    );
  }
}

/** Los códigos del catálogo que `admin` NO tiene concedidos hoy en la base. */
export async function funcionesSinAdmin(): Promise<string[]> {
  const todas = await db.select({ codigo: permisosFunciones.codigo }).from(permisosFunciones);
  const filas = await db.select({
    rol: permisosRolFuncion.rolCodigo,
    codigo: permisosRolFuncion.funcionCodigo,
  }).from(permisosRolFuncion);
  const deAdmin = new Set(filas.filter((f) => f.rol === 'admin').map((f) => f.codigo));
  return todas.map((f) => f.codigo).filter((c) => !deAdmin.has(c)).sort();
}
