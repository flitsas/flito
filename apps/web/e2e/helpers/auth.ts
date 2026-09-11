import { Page } from '@playwright/test';
import { PAGES, isValidPage, paginasPorDefecto, type UserRole } from '@operaciones/shared-types';

/**
 * Las páginas que `/auth/me` devuelve DE VERDAD para un admin de producción.
 *
 * Aquí decía `['*']`. Nunca fue un comodín: `getEffectivePages` filtra con `isValidPage`
 * (`slug in PAGES`), así que `'*'` se cae siempre. Funcionaba de rebote porque `permissions.ts`
 * tenía dos atajos cableados para `admin` —la fila `admin: Object.keys(PAGES)` de
 * `ROLE_DEFAULT_PAGES` y un `if (user.role === 'admin') return Object.keys(PAGES)`— que devolvían
 * todo antes de mirar el `'*'`. La HU #12081 los retiró: `admin` ya no es un caso especial del
 * código, sus 43 páginas se las da el reparto sembrado en base y el sobre de `/login` y `/me` viaja
 * ya resuelto. Como `loginAs` MOCKEA `/api/auth/me` y nunca toca el API, el fixture es el servidor:
 * si miente, el admin se queda con cero páginas y la pantalla no monta.
 *
 * Va `Object.keys(PAGES)` menos `flito_ayuda` porque eso es lo que el servidor reparte:
 * `flito_ayuda` existe solo para el label de `NoAccess` y el ítem de nav, su visibilidad es
 * derivada (`hasPage` de ≥1 slug del catálogo de fichas) y por eso no se concede a mano ni entra en
 * el catálogo de funciones.
 *
 * Si vuelve a aparecer un `['*']` en un fixture de admin, no es un atajo cómodo: es alguien tapando
 * un fallo de permisos en vez de verlo.
 */
export const ADMIN_ALLOWED_PAGES = Object.keys(PAGES).filter((slug) => slug !== 'flito_ayuda');

/**
 * Reproduce lo que el servidor pone en `/me`: ∪(defaults del rol, allowedPages del fixture).
 * HU #12087: la SPA ya no une en el cliente; el mock de `/me` tiene que traer la lista resuelta.
 */
export function sobreDeMe<T extends { role: string; allowedPages?: string[] | null }>(user: T): T & { allowedPages: string[] } {
  const fromRole = paginasPorDefecto(user.role as UserRole);
  const fromUser = (user.allowedPages ?? []).filter(isValidPage);
  return { ...user, allowedPages: Array.from(new Set([...fromRole, ...fromUser])) };
}

export const ADMIN_USER = {
  id: 1,
  username: 'e2e_admin',
  name: 'Admin E2E',
  role: 'admin' as const,
  allowedPages: ADMIN_ALLOWED_PAGES,
};

export const PROVEEDOR_USER = {
  id: 6,
  username: 'e2e_proveedor',
  name: 'Proveedor E2E',
  role: 'proveedor' as const,
  allowedPages: ['vehicles', 'soat'],
};

// FLITO — el operador del dominio ES admin (despliegue FLITO-only; el rol `operaciones` se
// fusionó en `admin`). Se conserva el nombre OPERACIONES_USER para no tocar los specs.
//
// Mismo reparto que `ADMIN_USER` porque es el mismo rol: ver `ADMIN_ALLOWED_PAGES` para por qué ya
// no hay `['*']` aquí.
export const OPERACIONES_USER = {
  id: 7,
  username: 'e2e_operaciones',
  name: 'Operaciones E2E',
  role: 'admin' as const,
  allowedPages: ADMIN_ALLOWED_PAGES,
};

// FLITO — Auditoría: mismas vistas FLITO pero solo lectura.
export const AUDITOR_USER = {
  id: 8,
  username: 'e2e_auditor',
  name: 'Auditoría E2E',
  role: 'auditor' as const,
  allowedPages: [] as string[],
};

// FLITO Logística — Mensajero (PWA de campo, Fase 2). Solo su ruta; no la consola de Operaciones.
export const MENSAJERO_USER = {
  id: 9,
  username: 'e2e_mensajero',
  name: 'Mensajero E2E',
  role: 'mensajero' as const,
  allowedPages: ['flito_logistica_ruta'],
};

// Finanzas — dueña de las bolsas prepago (Feature #11120). Sus páginas salen de los defaults del
// rol, así que `allowedPages` va vacío a propósito: el test comprueba el permiso real, no uno
// concedido a mano.
export const FINANCIERA_USER = {
  id: 10,
  username: 'e2e_financiera',
  name: 'Financiera E2E',
  role: 'financiera' as const,
  allowedPages: [] as string[],
};

// FLITO Impuestos — gestor atado a un organismo de tránsito. `allowedPages` vacío a propósito: sus
// páginas salen de los defaults del rol, así que el test comprueba el permiso real y no uno
// concedido a mano. Su frontera de datos (el organismo) la aplica el servidor, no la UI.
export const GESTOR_IMPUESTOS_USER = {
  id: 11,
  username: 'e2e_gestor_impuestos',
  name: 'Gestor Impuestos E2E',
  role: 'gestor_impuestos' as const,
  allowedPages: [] as string[],
};

// Conductor — el rol más acotado del sistema. Sirve de control negativo: si un módulo se le
// escapa a este, se le escapa a cualquiera.
export const CONDUCTOR_USER = {
  id: 12,
  username: 'e2e_conductor',
  name: 'Conductor E2E',
  role: 'conductor' as const,
  allowedPages: [] as string[],
};

// FLITO — Cliente (Feature #11912): el primer rol EXTERNO a la operación. Una sola página
// (`flito_soat`) y sin `dashboard`, así que es también el primer usuario que ejercita `rutaInicio`.
//
// `companiaId` va en el fixture aunque hoy la interfaz no lo lea: la compañía es su frontera de
// datos —el servidor la aplica, no la UI— y un Cliente de prueba sin ella no existe en producción.
// `allowedPages` vacío a propósito: sus permisos salen de los defaults del rol, que es lo que hay
// que comprobar, y no de una concesión a mano.
export const CLIENTE_USER = {
  id: 13,
  username: 'e2e_cliente',
  name: 'Cliente E2E',
  role: 'cliente' as const,
  allowedPages: [] as string[],
  companiaId: 1,
};

// El mismo Cliente, pero con el canal ENCENDIDO (HU #11914). `puedeSolicitarSoat` lo calcula el
// servidor en `/auth/me` a partir de `clients.soat_sin_tramite`; es lo que decide si aparece el botón
// «Solicitar SOAT» y si el formulario se monta o lo sustituye la tarjeta del AC5.
//
// Son DOS sesiones y no un campo que se cambia sobre la marcha a propósito: el AC5 se comprueba con
// la de arriba —la que NO tiene el canal— y todo lo demás con esta. Con una sola, el aserto negativo
// del AC5 pasaría por vacío el día que alguien invirtiera el valor por defecto.
export const CLIENTE_CON_CANAL = { ...CLIENTE_USER, puedeSolicitarSoat: true };

const TOKEN_E2E = 'fake.jwt.e2e';

/**
 * Deja la pestaña autenticada como `user` y aterrizada en `/login`.
 *
 * **Contrato que cambió con el Bug #12141:** desde que siembra el token con `addInitScript`, tras
 * llamar a `loginAs` ya **no se puede devolver la pestaña a un estado sin sesión** borrando el
 * token y navegando: el init script lo replanta en el documento siguiente. Un helper que quiera la
 * pantalla de login de verdad —como `irALoginConTema` en `kit-flit-tema-oscuro.spec.ts`— tiene que
 * usarse ANTES del primer `loginAs` de ese test. Hoy los tres que lo hacen ya lo cumplen; invertir
 * ese orden da un rojo desconcertante, con la app en `/` y sin formulario de login.
 */
export async function loginAs(page: Page, user = ADMIN_USER) {
  const me = sobreDeMe(user);
  // /me responde 200 con el user — necesario para que useAuth() considere la sesión válida.
  // HU #12087: lista resuelta como el servidor (`sobreDeMe`).
  await page.route('**/api/auth/me', async (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(me) })
  );
  // Pasamos por /login para tener un origin válido y poder escribir en localStorage.
  await page.goto('/login');
  await page.evaluate((token) => localStorage.setItem('token', token), TOKEN_E2E);

  // Y volvemos a sembrarlo ANTES de cada documento futuro (Bug #12141).
  //
  // Sin esto, la sesión se caía a mitad de test —5 de cada 6 corridas bajo carga— por esta cadena,
  // medida con `page.on('requestfailed')` y el token leído a cada paso:
  //
  //   1. Este `goto('/login')` resuelve en `load`. Si YA había token (todo re-login lo tiene, puesto
  //      por el `loginAs` anterior), `AuthProvider` dispara `GET /auth/me` al montar…
  //   2. …y `goto` no espera a esa petición: devuelve el control con ella EN VUELO.
  //   3. El siguiente `page.goto(...)` del test la aborta → `net::ERR_ABORTED`.
  //   4. Ese fallo entra por el `.catch(() => { clearToken(); … })` de `AuthProvider`
  //      (`src/lib/auth.tsx`), que hace `localStorage.removeItem('token')`. El `localStorage` es del
  //      ORIGEN, así que el borrado del documento que muere alcanza al que viene.
  //   5. El documento nuevo arranca sin token → `user` null → `ProtectedRoute` → pantalla de login.
  //
  // `addInitScript` corre antes que cualquier script de la página, en CADA documento: aunque el
  // documento anterior borre el token al morir, el siguiente lo encuentra puesto cuando
  // `AuthProvider` lo lee. Esperar aquí a que la sesión cuaje solo taparía el caso de este `goto`;
  // la carrera reaparece en cualquier navegación que pille un `/auth/me` en vuelo.
  //
  // Se registra DESPUÉS del `goto` a propósito: hacerlo antes daría token al propio documento de
  // /login, y `App.tsx` manda a `/` a quien ya tiene sesión — `loginAs` dejaría de aterrizar en
  // /login. Y eso importa porque **/login es una pantalla INERTE**: los specs registran sus mocks
  // DESPUÉS de llamar a `loginAs`, así que aterrizar en `/` hace que la pantalla de inicio pida
  // datos antes de que esos mocks existan. Medido: mover este `addInitScript` antes del `goto`
  // tumba `laft-smoke-vistas.spec.ts:86` (smoke 217/219). El mismo motivo está escrito en
  // `flito-conciliacion.spec.ts:1015`.
  //
  // (Aquí decía que /login era «donde varios specs siembran sessionStorage». Es falso y está
  // medido: `sessionStorage` es del ORIGEN, no de la ruta, así que se siembra igual desde `/` —
  // `flito-conciliacion` pasa 33/33 con el orden invertido. La razón buena es la de arriba.)
  await page.addInitScript((token) => {
    // El origen opaco (about:blank, iframes de otro origen) no da localStorage: ahí no hay sesión
    // que sembrar y el throw ensuciaría la página con un error no capturado.
    try { localStorage.setItem('token', token); } catch { /* sin storage: nada que hacer */ }
  }, TOKEN_E2E);
}
