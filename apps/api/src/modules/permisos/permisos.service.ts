// HU #12081 — Lectura del catálogo de funciones (AC5) y la comprobación de arranque (AC6).
import { asc, desc } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { permisosFunciones } from '../../db/schema.js';
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

/**
 * El catálogo agrupado por módulo, que es como lo pinta la pantalla de permisos.
 *
 * Dentro de cada grupo van primero las páginas y después las operaciones (HU #12716 AC4), y por
 * código dentro de cada tipo. `desc(tipo)` basta: `'pagina' > 'operacion'` alfabéticamente y el
 * CHECK `permisos_funciones_tipo_chk` solo admite esos dos valores, así que no hace falta un CASE.
 * El orden lo pone el SQL y nada más: aquí no se reordena en memoria.
 */
export async function catalogoAgrupado(): Promise<GrupoDeFunciones[]> {
  const filas = await db.select({
    codigo: permisosFunciones.codigo,
    modulo: permisosFunciones.modulo,
    nombreNegocio: permisosFunciones.nombreNegocio,
    descripcion: permisosFunciones.descripcion,
    tipo: permisosFunciones.tipo,
  }).from(permisosFunciones)
    .orderBy(asc(permisosFunciones.modulo), desc(permisosFunciones.tipo), asc(permisosFunciones.codigo));

  const grupos = new Map<string, FuncionDeGrupo[]>();
  for (const f of filas) {
    const lista = grupos.get(f.modulo) ?? [];
    lista.push({ codigo: f.codigo, nombreNegocio: f.nombreNegocio, descripcion: f.descripcion, tipo: f.tipo });
    grupos.set(f.modulo, lista);
  }
  return [...grupos.entries()].map(([modulo, funciones]) => ({ modulo, funciones }));
}

export class ArranquePermisosError extends Error {}

/**
 * Comprobación de arranque (AC6): el catálogo que el CÓDIGO declara y el que hay en la BASE son el
 * mismo. HU #13424 (ADR-0022 §D1): ya NO mira qué tiene `admin` en la base viva —eso volvía al rol no
 * editable: desmarcarle una función desde el panel dejaba la API sin arrancar—. Que toda siembra le
 * marque a `admin` lo nuevo lo vigila en CI `permisos-siembra-admin.test.ts`, sobre las migraciones.
 *
 * Falla ruidosamente y a propósito: un catálogo desincronizado no se manifiesta como un error, se
 * manifiesta como una pantalla que desaparece para alguien. Si la tabla está vacía —una base sin la
 * 0179— el mensaje lo dice con esas palabras en vez de listar 260 funciones que «faltan».
 */
export async function verificarCatalogoAlArrancar(): Promise<void> {
  const enCodigo = catalogoCompleto();  // ya valida guarda ↔ nombre en los dos sentidos
  const filas = await db.select({
    codigo: permisosFunciones.codigo,
    modulo: permisosFunciones.modulo,
  }).from(permisosFunciones);

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

  // HU #12716 AC7: mismos códigos, pero el módulo de AGRUPACIÓN también tiene que coincidir fila a
  // fila. Una base sin la 0205 sigue con `flito_soat_e_impuestos` / `parametrizacion` y la pantalla
  // de permisos pintaría los grupos viejos mientras el 403 nombra los nuevos.
  const moduloEnBase = new Map(filas.map((f) => [f.codigo, f.modulo]));
  const difieren = enCodigo
    .filter((f) => moduloEnBase.get(f.codigo) !== f.modulo)
    .map((f) => `«${f.codigo}»: base «${moduloEnBase.get(f.codigo)}» → código «${f.modulo}»`);
  if (difieren.length) {
    const MOSTRAR = 10;
    const lista = difieren.slice(0, MOSTRAR).join('\n    ') +
      (difieren.length > MOSTRAR ? `\n    … y ${difieren.length - MOSTRAR} más` : '');
    throw new ArranquePermisosError(
      `El módulo de agrupación difiere entre la base y el código en ${difieren.length} funciones:\n    ${lista}\n` +
      '  Falta aplicar 0205_permisos_reagrupar_modulos.sql (o la que la sustituya); se regenera con ' +
      '`npm run permisos:seed -w apps/api -- --reagrupar`.',
    );
  }
}
