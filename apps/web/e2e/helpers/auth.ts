import { Page } from '@playwright/test';

export const ADMIN_USER = {
  id: 1,
  username: 'e2e_admin',
  name: 'Admin E2E',
  role: 'admin' as const,
  allowedPages: ['*'],
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
export const OPERACIONES_USER = {
  id: 7,
  username: 'e2e_operaciones',
  name: 'Operaciones E2E',
  role: 'admin' as const,
  allowedPages: ['*'],
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

export async function loginAs(page: Page, user = ADMIN_USER) {
  // /me responde 200 con el user — necesario para que useAuth() considere la sesión válida.
  await page.route('**/api/auth/me', async (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(user) })
  );
  // Pasamos por /login para tener un origin válido y poder escribir en localStorage.
  await page.goto('/login');
  await page.evaluate(() => localStorage.setItem('token', 'fake.jwt.e2e'));
}
