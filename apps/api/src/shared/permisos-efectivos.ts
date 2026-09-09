// HU #12081 — Las páginas efectivas de un usuario, con el reparto del ROL leído de la base.
//
// Por qué existe este fichero y no basta `getEffectivePages`: el AC4 retira los dos atajos que le
// daban todo a `admin`, y `getEffectivePages` vive en `packages/shared-types`, que es un módulo puro
// —no puede consultar nada—. Si nadie leyera el reparto sembrado, el día del merge el administrador
// se quedaría con CERO pantallas. Aquí es donde `permisos_rol_funcion` vuelve a ser una lista de
// páginas.
//
// ── Lo que SÍ cambia de sitio y lo que NO ───────────────────────────────────────────────────────
//
// Las páginas del ROL pasan a leerse de la base: es el cambio de esta HU y lo que hace que retirar
// los atajos sea neutro (CF-16). El reparto sembrado reproduce `ROLE_DEFAULT_PAGES` exactamente, y
// eso lo fija el test de paridad del AC7 contra PostgreSQL.
//
// Las páginas del USUARIO se siguen leyendo de `users.allowed_pages`, y **a propósito**. La 0179
// también las copió a `permisos_usuario_funcion`, pero esa tabla no la escribe nadie todavía: el
// alta y la edición de usuarios (`users.routes.ts:381` y `:503`) siguen escribiendo la columna. Leer
// la tabla aquí congelaría los permisos por usuario en la foto del día de la migración: un
// administrador concedería una página desde la pantalla de usuarios, la columna cambiaría, y el
// usuario no vería nada distinto. Quien se lleva esa mitad —y con ella el efecto `revocar`, que hoy
// no tiene ni una fila— es la HU de permisos por usuario.
//
// Las funciones de tipo `operacion` están sembradas pero **todavía no deciden nada**: las guardas
// siguen siendo los `requireRole` de siempre y quien las cambia por el catálogo es la HU #12082.
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { permisosRolFuncion } from '../db/schema.js';
import { isValidPage, type PageSlug } from '@operaciones/shared-types';

const PREFIJO = 'pagina.';

/**
 * Las páginas que este usuario ve hoy: las que su ROL tiene sembradas más las suyas propias.
 *
 * `isValidPage` filtra los códigos que no son de una página viva — el mismo filtro que
 * `getEffectivePages` aplica a `allowedPages`, y por el mismo motivo: un slug retirado del catálogo
 * no debe conceder nada aunque siga escrito en una fila.
 */
export async function paginasEfectivasDeUsuario(
  user: { id: number; role: string; allowedPages?: string[] | null },
): Promise<PageSlug[]> {
  const delRol = await db.select({ codigo: permisosRolFuncion.funcionCodigo })
    .from(permisosRolFuncion)
    .where(eq(permisosRolFuncion.rolCodigo, user.role));

  const paginas = new Set<PageSlug>();
  for (const { codigo } of delRol) {
    // El `startsWith` NO es redundante con `isValidPage`, aunque hoy lo parezca. Medido con un
    // mutante el 9/09/2026: quitarlo deja los tests en verde, porque los códigos de operación de hoy
    // tienen tres segmentos (`soat.cola.ver`) y al cortarles siete caracteres sale algo con un punto
    // dentro, que `isValidPage` rechaza. Lo que lo hace necesario es un código de DOS segmentos con
    // un módulo de seis letras: `bolsas.transito` se convertiría en la página `transito` y le
    // concedería a quien tuviera esa operación una pantalla que nadie le dio. El prefijo es la
    // afirmación —«esto es una función de página»— y `isValidPage` es el filtro de slugs retirados.
    if (!codigo.startsWith(PREFIJO)) continue;
    const slug = codigo.slice(PREFIJO.length);
    if (isValidPage(slug)) paginas.add(slug);
  }
  for (const slug of user.allowedPages ?? []) {
    if (isValidPage(slug)) paginas.add(slug);
  }
  return [...paginas];
}
