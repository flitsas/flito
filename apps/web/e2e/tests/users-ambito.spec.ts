// HU #12053 (Feature #12052) — Ámbito del usuario: proveedor SOAT (uno) y organismos del gestor
// (varios). Plan de casos y mutantes: `docs/ux/usuarios-ambito-proveedor-y-gestor-impuestos.md`,
// sección «Notas para QA». Contrato: `docs/diseno-hu-12053-atadura-proveedor-organismos.md` §3.
//
// El backend va mockeado con `page.route`, como el resto de la carpeta: estos casos certifican la
// PANTALLA —qué se ofrece, qué se bloquea, qué viaja y qué se pinta—, no la persistencia.
//
// Tres apuntes de método, porque sin ellos varios asertos pasarían por vacío:
//
//   1. **Los asertos negativos son la mitad del AC1.** «Aparece el campo del rol» está verde también
//      si la pantalla pinta los dos campos siempre. Lo que lo mata es `toHaveCount(0)` del otro.
//   2. **`expect(posts).toHaveLength(0)` es el único aserto que mata el mutante del AC3** «quitar el
//      `preventDefault` y confiar en el 400 del servidor»: el mensaje se vería igual.
//   3. **El catálogo se afirma contra el ENDPOINT DE PARAMETRIZACIÓN.** Un organismo sin impuestos
//      en cola tiene que aparecer, así que el TC-06 comprueba además que la pantalla no pide nada a
//      `/api/flito/impuestos`: si alguien poblara el campo con las facetas de la cola, el caso
//      seguiría verde con un aserto que solo mirase la casilla.
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER } from '../helpers/auth';

// ─────────────────────────────────── Fixtures ────────────────────────────────────────────────────

const SURA = '11111111-1111-4111-8111-111111111111';
const MUNDIAL = '22222222-2222-4222-8222-222222222222';
const PREVISORA = '33333333-3333-4333-8333-333333333333';

/** Tal como los sirve `GET /flito/parametrizacion/proveedores-soat`: activos E INACTIVOS. */
const PROVEEDORES = [
  { id: SURA, nombre: 'SURA', estrategia: 'ocr', umbralOcr: 0.8, slaHoras: 24, activo: true },
  { id: MUNDIAL, nombre: 'Mundial de Seguros', estrategia: 'ocr', umbralOcr: null, slaHoras: null, activo: true },
  { id: PREVISORA, nombre: 'La Previsora', estrategia: 'ocr', umbralOcr: null, slaHoras: null, activo: false },
];

/** `GET /flito/parametrizacion/organismos`: los PARAMETRIZADOS, ordenados por código. */
const ORGANISMOS = [
  { codigo: '05001', nombre: 'Medellín', alias: 'Medellín', activo: true, modalidadVigente: 'AUTOGESTIONADO' },
  { codigo: '05266', nombre: 'Envigado', alias: 'Envigado', activo: true, modalidadVigente: 'AUTOGESTIONADO' },
  { codigo: '05360', nombre: 'Itagüí', alias: 'Itagüí', activo: true, modalidadVigente: 'AUTOGESTIONADO' },
  { codigo: '05631', nombre: 'Sabaneta', alias: 'Sabaneta', activo: true, modalidadVigente: 'AUTOGESTIONADO' },
  { codigo: '76001', nombre: 'Cali', alias: 'Cali', activo: true, modalidadVigente: 'ASUMIDO_OPERACIONES' },
];

type Fila = Record<string, unknown>;

/** Un usuario del listado, con la forma COMPLETA del contrato: `organismosCodigos` SIEMPRE array. */
function usuario(over: Fila): Fila {
  return {
    id: 2, username: 'u', name: 'Usuario', email: null, role: 'admin', active: true,
    allowedPages: [], transitoCodigo: null, companiaId: null,
    flitoProveedorSoatId: null, organismosCodigos: [],
    createdAt: '2026-01-01T00:00:00.000Z', ...over,
  };
}

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function mockCatalogos(page: Page, opts: { proveedores?: unknown[]; organismos?: unknown[] } = {}) {
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat$/, (r) => r.fulfill(json(opts.proveedores ?? PROVEEDORES)));
  await page.route(/\/api\/flito\/parametrizacion\/organismos$/, (r) => r.fulfill(json(opts.organismos ?? ORGANISMOS)));
}

/** Listado + captura de lo que viaja en el POST y en el PATCH. */
function mockUsers(page: Page, filas: Fila[] = []) {
  const posts: any[] = [];
  const patches: any[] = [];
  page.route(/\/api\/users$/, async (route) => {
    if (route.request().method() === 'POST') {
      posts.push(route.request().postDataJSON());
      return route.fulfill(json(usuario({ id: 99 }), 201));
    }
    return route.fulfill(json(filas));
  });
  page.route(/\/api\/users\/\d+$/, async (route) => {
    if (route.request().method() === 'PATCH') {
      patches.push(route.request().postDataJSON());
      return route.fulfill(json(filas[0] ?? usuario({})));
    }
    return route.fulfill(json({}, 405));
  });
  return { posts, patches };
}

const grupoOrganismos = (page: Page) => page.getByRole('group', { name: 'Organismos de tránsito' });
const casilla = (page: Page, nombre: string) => page.getByRole('checkbox', { name: nombre });

/** La celda «Ámbito» es la QUINTA de la fila: usuario, nombre, email, rol, ámbito, estado, acciones. */
const celdaAmbito = (page: Page, username: string) =>
  page.getByRole('row', { name: new RegExp(username.replace('.', '\\.')) }).getByRole('cell').nth(4);

/** Abre «Nuevo usuario» con los campos obligatorios ajenos ya rellenos y el rol pedido. */
async function abrirAlta(page: Page, role: string) {
  await page.goto('/users');
  await page.getByRole('button', { name: 'Nuevo usuario' }).click();
  await page.getByLabel('Username (login)').fill('nuevo_e2e');
  await page.getByLabel('Nombre completo').fill('Nuevo E2E');
  await page.getByLabel(/^Contraseña/).fill('Abcdef1!');
  await page.getByLabel('Rol base').selectOption(role);
}

// ───────────────────────── AC1 · el campo aparece con el rol, y solo con él ──────────────────────

test.describe('HU #12053 · AC1 — un rol, un campo de ámbito', () => {
  test('TC-12053-01 · el rol Proveedor trae su selector y NO el grupo de organismos', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    mockUsers(page);
    await mockCatalogos(page);
    await abrirAlta(page, 'proveedor');

    await expect(page.getByLabel('Proveedor SOAT')).toBeVisible();
    // El aserto negativo es el único que mata «pintar los dos campos sin condicionar al rol».
    await expect(grupoOrganismos(page)).toHaveCount(0);
  });

  test('TC-12053-02 · el rol Gestor de Impuestos trae el grupo y NO el selector de proveedor', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    mockUsers(page);
    await mockCatalogos(page);
    await abrirAlta(page, 'gestor_impuestos');

    await expect(grupoOrganismos(page)).toBeVisible();
    await expect(page.getByLabel('Proveedor SOAT')).toHaveCount(0);
    // Y los ocho roles sin ámbito no traen ninguno de los dos.
    await page.getByLabel('Rol base').selectOption('auditor');
    await expect(grupoOrganismos(page)).toHaveCount(0);
    await expect(page.getByLabel('Proveedor SOAT')).toHaveCount(0);
  });
});

// ───────────────────────── Catálogos · qué se ofrece y qué no se pierde ──────────────────────────

test.describe('HU #12053 · los catálogos: activos al ofrecer, sin perder al asignado', () => {
  test('TC-12053-03 · solo ofrece proveedores ACTIVOS aunque el endpoint devuelva inactivos', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    mockUsers(page);
    await mockCatalogos(page);
    await abrirAlta(page, 'proveedor');

    const select = page.getByLabel('Proveedor SOAT');
    // Opción vacía + los dos activos. «La Previsora» viene en la respuesta y NO se ofrece: dar de
    // alta a alguien atado a una aseguradora que ya no opera es crear el problema.
    await expect(select.getByRole('option')).toHaveText(['Seleccione proveedor…', 'SURA', 'Mundial de Seguros']);
    await expect(select.getByRole('option', { name: /Previsora/ })).toHaveCount(0);
  });

  test('TC-12053-04 · el proveedor inactivo ASIGNADO se reinyecta con «(inactivo)» y no se pierde al guardar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const heredado = usuario({ id: 5, username: 'gestor.previsora', name: 'Heredado', role: 'proveedor', flitoProveedorSoatId: PREVISORA });
    const { patches } = mockUsers(page, [heredado]);
    await mockCatalogos(page);

    await page.goto('/users');
    await page.getByRole('button', { name: 'Editar' }).first().click();

    const select = page.getByLabel('Proveedor SOAT');
    // Mutante: filtrar por `activo` sin reinyectar → el `<select>` se pinta en blanco y guardar se
    // lleva la atadura por delante. El valor es lo que lo mata; el matiz es lo que lo explica.
    await expect(select).toHaveValue(PREVISORA);
    await expect(select.getByRole('option', { name: 'La Previsora (inactivo)' })).toHaveCount(1);

    await page.getByLabel('Nombre completo').fill('Heredado editado');
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0]).toEqual({ name: 'Heredado editado' });
  });

  test('TC-12053-05 · el organismo inactivo MARCADO sigue en la lista, marcado y con el matiz', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const gestor = usuario({ id: 6, username: 'gestor.cali', name: 'Gestor Cali', role: 'gestor_impuestos', organismosCodigos: ['76001'] });
    mockUsers(page, [gestor]);
    await mockCatalogos(page, { organismos: ORGANISMOS.map((o) => (o.codigo === '76001' ? { ...o, activo: false } : o)) });

    await page.goto('/users');
    await page.getByRole('button', { name: 'Editar' }).first().click();

    await expect(casilla(page, 'Cali · 76001 (inactivo)')).toBeChecked();
    // Y ningún otro inactivo se cuela: solo el que ya estaba atado.
    await expect(grupoOrganismos(page).getByRole('checkbox')).toHaveCount(5);
  });

  test('TC-12053-06 · un organismo SIN impuestos en cola aparece y es seleccionable (se puebla del catálogo, no de las facetas)', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const { posts } = mockUsers(page);
    await mockCatalogos(page);
    // Si el campo se poblara de la cola, esta ruta se pediría. Se registra para CONTARLA.
    const facetas: string[] = [];
    await page.route(/\/api\/flito\/impuestos/, (route) => {
      facetas.push(route.request().url());
      return route.fulfill(json({ items: [], total: 0, organismos: [] }));
    });

    await abrirAlta(page, 'gestor_impuestos');
    // Sabaneta no tiene un solo recibo en este mock y se lista igual: el catálogo es de
    // parametrización, no de carga de trabajo.
    await casilla(page, 'Sabaneta · 05631').check();
    await expect(casilla(page, 'Sabaneta · 05631')).toBeChecked();
    expect(facetas).toHaveLength(0);

    await page.getByRole('button', { name: 'Crear usuario' }).click();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0].organismosCodigos).toEqual(['05631']);
  });
});

// ───────────────────────────── AC2 · multi de verdad ─────────────────────────────────────────────

test.describe('HU #12053 · AC2 — varios organismos, y todos viajan', () => {
  test('TC-12053-07 · marcar tres los manda los TRES en el POST', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const { posts } = mockUsers(page);
    await mockCatalogos(page);
    await abrirAlta(page, 'gestor_impuestos');

    await casilla(page, 'Medellín · 05001').check();
    await casilla(page, 'Envigado · 05266').check();
    await casilla(page, 'Itagüí · 05360').check();
    await expect(grupoOrganismos(page).getByText('3 marcados')).toBeVisible();

    await page.getByRole('button', { name: 'Crear usuario' }).click();
    await expect.poll(() => posts.length).toBe(1);
    // Mutante clásico al pasar de columna única a lista: mandar solo el último marcado.
    expect(posts[0].organismosCodigos.slice().sort()).toEqual(['05001', '05266', '05360']);
  });

  test('TC-12053-08 · desmarcar uno manda los DOS que quedan, y el contador lo dice', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const gestor = usuario({ id: 7, username: 'gestor.medellin', name: 'Gestor Medellín', role: 'gestor_impuestos', organismosCodigos: ['05001', '05266', '05360'] });
    const { patches } = mockUsers(page, [gestor]);
    await mockCatalogos(page);

    await page.goto('/users');
    await page.getByRole('button', { name: 'Editar' }).first().click();
    await expect(grupoOrganismos(page).getByText('3 marcados')).toBeVisible();

    await casilla(page, 'Itagüí · 05360').uncheck();
    await expect(grupoOrganismos(page).getByText('2 marcados')).toBeVisible();
    await page.getByRole('button', { name: 'Guardar cambios' }).click();

    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0].organismosCodigos.slice().sort()).toEqual(['05001', '05266']);
  });

  test('TC-12053-09 · el orden de la lista NO baila al marcar y desmarcar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const gestor = usuario({ id: 8, username: 'gestor.itagui', name: 'Gestor Itagüí', role: 'gestor_impuestos', organismosCodigos: ['05360'] });
    mockUsers(page, [gestor]);
    await mockCatalogos(page);

    await page.goto('/users');
    await page.getByRole('button', { name: 'Editar' }).first().click();

    const etiquetas = grupoOrganismos(page).locator('label span');
    // Marcados al abrir primero, luego alfabético. Fijado al llegar el catálogo.
    const inicial = await etiquetas.allTextContents();
    expect(inicial[0]).toContain('Itagüí');

    await casilla(page, 'Medellín · 05001').check();
    await casilla(page, 'Itagüí · 05360').uncheck();
    // Mutante: reordenar por «marcados primero» en cada render — la fila salta bajo el cursor.
    expect(await etiquetas.allTextContents()).toEqual(inicial);
  });
});

// ───────────────────────────── AC3 · sin atadura no se envía ─────────────────────────────────────

test.describe('HU #12053 · AC3 — el rechazo se ve, se enfoca y NO viaja', () => {
  test('TC-12053-10 · la pantalla bloquea el submit con los DOS mensajes, con foco y con CERO POST', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const { posts } = mockUsers(page);
    await mockCatalogos(page);

    await abrirAlta(page, 'proveedor');
    await page.getByRole('button', { name: 'Crear usuario' }).click();
    await expect(page.getByRole('alert')).toHaveText('Selecciona el proveedor SOAT del usuario Proveedor.');
    await expect(page.getByLabel('Proveedor SOAT')).toBeFocused();
    await expect(page.getByLabel('Proveedor SOAT')).toHaveAttribute('aria-invalid', 'true');

    await page.getByLabel('Rol base').selectOption('gestor_impuestos');
    // Cambiar de rol se lleva también el mensaje del campo anterior: si no, reaparecería robando
    // el foco en un formulario que ya no tiene ese campo.
    await expect(page.getByRole('alert')).toHaveCount(0);

    await page.getByRole('button', { name: 'Crear usuario' }).click();
    await expect(page.getByRole('alert')).toHaveText('Marca al menos un organismo para el usuario Gestor de Impuestos.');
    await expect(casilla(page, 'Cali · 76001')).toBeFocused();
    await expect(grupoOrganismos(page)).toHaveAttribute('aria-invalid', 'true');

    // El aserto que mata «quitar el preventDefault y confiar en el 400 del servidor».
    expect(posts).toHaveLength(0);
  });

  test('TC-12053-11 · un gestor HEREDADO sin organismos no se guarda ni cambiándole solo el nombre', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const huerfano = usuario({ id: 9, username: 'gestor.envigado', name: 'Gestor Envigado', role: 'gestor_impuestos', organismosCodigos: [] });
    const { patches } = mockUsers(page, [huerfano]);
    await mockCatalogos(page);

    await page.goto('/users');
    await page.getByRole('button', { name: 'Editar' }).first().click();
    await page.getByLabel('Nombre completo').fill('Gestor Envigado corregido');
    await page.getByRole('button', { name: 'Guardar cambios' }).click();

    // Mutante: validar solo en el alta. Es la mitad del AC3, y la que ven los usuarios que YA están.
    await expect(page.getByRole('alert')).toHaveText('Marca al menos un organismo para el usuario Gestor de Impuestos.');
    expect(patches).toHaveLength(0);
  });
});

// ───────────────────────────── AC4 · la sesión que se cierra ─────────────────────────────────────

test.describe('HU #12053 · AC4 — el aviso antes y el toast después', () => {
  test('TC-12053-12 · el toast de re-login sale al CAMBIAR la atadura y no sale si no cambió', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const gestor = usuario({ id: 10, username: 'gestor.medellin', name: 'Gestor Medellín', role: 'gestor_impuestos', organismosCodigos: ['05001'] });
    mockUsers(page, [gestor]);
    await mockCatalogos(page);

    // (a) Sin tocar el ámbito: se guarda el nombre y NO sale el aviso de sesión.
    await page.goto('/users');
    await page.getByRole('button', { name: 'Editar' }).first().click();
    await page.getByLabel('Nombre completo').fill('Gestor Medellín II');
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(page.getByText('Usuario actualizado')).toBeVisible();
    // Mutante: disparar el toast siempre que se guarde.
    await expect(page.getByText('para aplicar los nuevos organismos')).toHaveCount(0);

    // (b) Cambiando el ámbito: sale, y con el literal de los organismos.
    await page.getByRole('button', { name: 'Editar' }).first().click();
    await casilla(page, 'Envigado · 05266').check();
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(page.getByText('El usuario debe volver a iniciar sesión para aplicar los nuevos organismos.')).toBeVisible();
  });

  test('TC-12053-13 · «Al guardar, este usuario deberá volver a iniciar sesión.» está en Editar y NO en Nuevo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const prov = usuario({ id: 11, username: 'gestor.sura', name: 'Gestor SURA', role: 'proveedor', flitoProveedorSoatId: SURA });
    mockUsers(page, [prov]);
    await mockCatalogos(page);

    await page.goto('/users');
    await page.getByRole('button', { name: 'Editar' }).first().click();
    await expect(page.getByText('Al guardar, este usuario deberá volver a iniciar sesión.')).toBeVisible();
    await page.getByRole('button', { name: 'Cancelar' }).click();

    // En el alta la frase sería falsa: no hay sesión que cerrar.
    await page.getByRole('button', { name: 'Nuevo usuario' }).click();
    await expect(page.getByLabel('Proveedor SOAT')).toBeVisible();
    await expect(page.getByText('Al guardar, este usuario deberá volver a iniciar sesión.')).toHaveCount(0);
    await expect(page.getByText('Define qué cola de SOAT ve este usuario')).toBeVisible();
  });
});

// ───────────────────── Cambiar de rol a mitad: qué se conserva y qué no ──────────────────────────

test.describe('HU #12053 · el ida y vuelta entre roles', () => {
  test('TC-12053-14 · en Editar vuelven las marcas GUARDADAS; en Nuevo, nada', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const gestor = usuario({ id: 12, username: 'gestor.medellin', name: 'Gestor Medellín', role: 'gestor_impuestos', organismosCodigos: ['05001', '05266', '05360'] });
    mockUsers(page, [gestor]);
    await mockCatalogos(page);

    await page.goto('/users');
    await page.getByRole('button', { name: 'Editar' }).first().click();
    await page.getByLabel('Rol base').selectOption('proveedor');
    await expect(grupoOrganismos(page)).toHaveCount(0);
    await expect(page.getByLabel('Proveedor SOAT')).toBeVisible();

    await page.getByLabel('Rol base').selectOption('gestor_impuestos');
    // Vuelven las TRES guardadas: rehacer seis casillas por un clic mal dado en el rol no es
    // «un clic». Mutante: no restaurar, o restaurar el borrador sin guardar.
    await expect(grupoOrganismos(page).getByText('3 marcados')).toBeVisible();
    await expect(casilla(page, 'Itagüí · 05360')).toBeChecked();

    // En el ALTA el mismo ida y vuelta deja el campo VACÍO: nada se ha guardado todavía.
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await page.getByRole('button', { name: 'Nuevo usuario' }).click();
    await page.getByLabel('Rol base').selectOption('gestor_impuestos');
    await casilla(page, 'Medellín · 05001').check();
    await page.getByLabel('Rol base').selectOption('proveedor');
    await page.getByLabel('Rol base').selectOption('gestor_impuestos');
    await expect(casilla(page, 'Medellín · 05001')).not.toBeChecked();
    // Por casilla y no por el contador: el texto «marcado» también está en la ayuda del campo
    // («…los de los organismos marcados.»), así que un aserto sobre el rótulo se mediría contra
    // la frase equivocada.
    await expect(grupoOrganismos(page).getByRole('checkbox', { checked: true })).toHaveCount(0);
  });

  test('TC-12053-15 · degradar de rol limpia la atadura del rol viejo en el PATCH', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const gestor = usuario({ id: 13, username: 'gestor.medellin', name: 'Gestor Medellín', role: 'gestor_impuestos', organismosCodigos: ['05001'] });
    const { patches } = mockUsers(page, [gestor]);
    await mockCatalogos(page);

    await page.goto('/users');
    await page.getByRole('button', { name: 'Editar' }).first().click();
    await page.getByLabel('Rol base').selectOption('auditor');
    await page.getByRole('button', { name: 'Guardar cambios' }).click();

    await expect.poll(() => patches.length).toBe(1);
    // Un ex-Gestor no se queda con organismos colgados que nadie vuelve a mirar. Y `[]`, no `null`:
    // el contrato dice que este campo es SIEMPRE un array.
    expect(patches[0]).toEqual({ role: 'auditor', organismosCodigos: [] });
  });
});

// ─────────────────────────── Los 4 estados de cada catálogo ──────────────────────────────────────

test.describe('HU #12053 · los 4 estados, los dos catálogos', () => {
  test('TC-12053-16 · proveedores: cargando, error con reintento y vacío que nombra la pantalla', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const { posts } = mockUsers(page);
    await page.route(/\/api\/flito\/parametrizacion\/organismos$/, (r) => r.fulfill(json(ORGANISMOS)));

    // UNA sola ruta con un interruptor, y no tres `page.route` encadenados: el catálogo se pide dos
    // veces al montar (`React.StrictMode`), y con varias rutas del mismo patrón lo que decide la
    // respuesta es el orden de registro contra el de las peticiones en vuelo.
    let estado: 'colgado' | 'error' | 'vacio' = 'colgado';
    let soltar: () => void = () => {};
    const colgada = new Promise<void>((resolve) => { soltar = resolve; });
    await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat$/, async (route) => {
      if (estado === 'colgado') { await colgada; return route.fulfill(json([])); }
      if (estado === 'error') return route.fulfill(json({ error: 'Catálogo caído' }, 500));
      return route.fulfill(json([]));
    });

    // Estado 1 — cargando. El control está inhabilitado y el envío, bloqueado.
    await abrirAlta(page, 'proveedor');
    await expect(page.getByText('Cargando proveedores SOAT…')).toBeVisible();
    await expect(page.getByLabel('Proveedor SOAT')).toBeDisabled();
    await page.getByRole('button', { name: 'Crear usuario' }).click();
    expect(posts).toHaveLength(0);

    // Estado 2 — error. El botón de reintento es la ÚNICA parada de tabulador del callejón: un
    // `<select disabled>` no recibe foco y su descripción queda inalcanzable por teclado.
    estado = 'error';
    soltar();
    await page.reload();
    await page.getByRole('button', { name: 'Nuevo usuario' }).click();
    await expect(page.getByText('No se pudieron cargar los proveedores SOAT.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Volver a cargar proveedores' })).toBeVisible();

    // Estado 3 — vacío. Mensaje DISTINTO del de error, y sin reintento: recargar no crea nada.
    estado = 'vacio';
    await page.getByRole('button', { name: 'Volver a cargar proveedores' }).click();
    await expect(page.getByText('No hay proveedores SOAT activos. Crea uno en Clientes y proveedores antes de crear un usuario Proveedor.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Volver a cargar proveedores' })).toHaveCount(0);
    await expect(page.getByLabel('Proveedor SOAT')).toBeDisabled();
  });

  test('TC-12053-17 · organismos: sin caja en los tres estados, reintento solo en el error', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const { posts } = mockUsers(page);
    await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat$/, (r) => r.fulfill(json(PROVEEDORES)));

    let estado: 'error' | 'vacio' | 'lleno' = 'error';
    await page.route(/\/api\/flito\/parametrizacion\/organismos$/, (route) => {
      if (estado === 'error') return route.fulfill(json({ error: 'Catálogo caído' }, 500));
      return route.fulfill(json(estado === 'vacio' ? [] : ORGANISMOS));
    });

    await abrirAlta(page, 'gestor_impuestos');
    // Estado 2 — error: sin caja (una caja vacía es un rectángulo decorativo), con reintento.
    await expect(page.getByText('No se pudieron cargar los organismos.')).toBeVisible();
    await expect(grupoOrganismos(page).getByRole('checkbox')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Volver a cargar organismos' })).toBeVisible();
    await page.getByRole('button', { name: 'Crear usuario' }).click();
    expect(posts).toHaveLength(0);

    // Estado 3 — vacío: mensaje que NOMBRA la pantalla donde se desbloquea, y sin reintento.
    estado = 'vacio';
    await page.getByRole('button', { name: 'Volver a cargar organismos' }).click();
    await expect(page.getByText('No hay organismos parametrizados. Parametriza uno en Organismos STT antes de crear un usuario Gestor de Impuestos.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Volver a cargar organismos' })).toHaveCount(0);
    await expect(grupoOrganismos(page).getByRole('checkbox')).toHaveCount(0);
  });
});

// ───────────────────────────────── AC5 · la tabla ────────────────────────────────────────────────

test.describe('HU #12053 · AC5 — la columna «Ámbito»', () => {
  test('TC-12053-18 · siete columnas, ni una más, y la quinta se llama «Ámbito»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    mockUsers(page, [usuario({ id: 1, username: 'admin', name: 'Operaciones FLIT' })]);
    await mockCatalogos(page);

    await page.goto('/users');
    // Mutante: la disposición B, con «Organismo STT», «Proveedor» y «Secretarías». El conteo la mata.
    await expect(page.getByRole('columnheader')).toHaveCount(7);
    await expect(page.getByRole('columnheader').nth(4)).toHaveText('Ámbito');
    await expect(page.getByRole('columnheader', { name: 'Organismo / Compañía' })).toHaveCount(0);
    // Los roles sin ámbito siguen con su guion.
    await expect(celdaAmbito(page, 'admin')).toHaveText('—');
  });

  test('TC-12053-19 · el proveedor se pinta por NOMBRE, no por uuid', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    mockUsers(page, [
      usuario({ id: 2, username: 'gestor.sura', name: 'Gestor SURA (1)', role: 'proveedor', flitoProveedorSoatId: SURA }),
      usuario({ id: 3, username: 'gestor.sura2', name: 'Gestor SURA (2)', role: 'proveedor', flitoProveedorSoatId: SURA }),
      usuario({ id: 4, username: 'prov.huerfano', name: 'Proveedor sin atar', role: 'proveedor', flitoProveedorSoatId: null }),
    ]);
    await mockCatalogos(page);

    await page.goto('/users');
    await expect(celdaAmbito(page, 'gestor.sura')).toHaveText('SURA');
    // Compartir proveedor NO es colisión: es el caso normal, y la tabla no lo señala.
    await expect(celdaAmbito(page, 'gestor.sura2')).toHaveText('SURA');
    // Mutante: pintar el identificador crudo. El uuid no puede estar en ninguna parte de la tabla.
    await expect(page.getByText(SURA)).toHaveCount(0);
    // El hueco que el AC5 hace visible: hasta hoy no se veía desde la lista.
    await expect(celdaAmbito(page, 'prov.huerfano')).toHaveText('Sin asignar');
  });

  test('TC-12053-20 · el gestor: uno, dos, «y N más», y «Sin asignar»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    mockUsers(page, [
      usuario({ id: 2, username: 'gestor.uno', name: 'Uno', role: 'gestor_impuestos', organismosCodigos: ['05001'] }),
      usuario({ id: 3, username: 'gestor.dos', name: 'Dos', role: 'gestor_impuestos', organismosCodigos: ['05001', '05266'] }),
      usuario({ id: 4, username: 'gestor.cinco', name: 'Cinco', role: 'gestor_impuestos', organismosCodigos: ['05001', '05266', '05360', '05631', '76001'] }),
      usuario({ id: 5, username: 'gestor.cero', name: 'Cero', role: 'gestor_impuestos', organismosCodigos: [] }),
    ]);
    await mockCatalogos(page);

    await page.goto('/users');
    await expect(celdaAmbito(page, 'gestor.uno')).toHaveText('Medellín');
    await expect(celdaAmbito(page, 'gestor.dos')).toHaveText('Medellín, Envigado');
    // Mutante: pintar los cinco nombres y reventar la fila. Y el orden es el del CATÁLOGO: una fila
    // que cambia de texto según en qué orden se marcaron las casillas no se puede afirmar.
    await expect(celdaAmbito(page, 'gestor.cinco')).toHaveText('Medellín, Envigado y 3 más');
    await expect(celdaAmbito(page, 'gestor.cero')).toHaveText('Sin asignar');
  });
});

// ─────────────────── Regresión · el rol `transito` no se toca, y ya no se le borra ───────────────

test.describe('HU #12053 · regresión del rol `transito`', () => {
  test('TC-12053-21 · el combobox de tránsito sigue igual y no aparece ningún selector nuevo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    mockUsers(page);
    await mockCatalogos(page);
    await abrirAlta(page, 'transito');

    await expect(page.getByText('Organismo de tránsito', { exact: true })).toBeVisible();
    await expect(page.getByText('Define qué bandeja verá este usuario (aislamiento Medellín ≠ Envigado).')).toBeVisible();
    // Su campo es de UN valor y sigue siendo el suyo: ni grupo de casillas ni selector de proveedor.
    await expect(grupoOrganismos(page)).toHaveCount(0);
    await expect(page.getByLabel('Proveedor SOAT')).toHaveCount(0);
  });

  test('TC-12053-22 · editarle el nombre a un gestor NO le manda `transitoCodigo: null`', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    // El defecto vivo en `develop`: `if (f.role !== 'transito' && user.transitoCodigo)` le borraba
    // el ámbito al gestor —que vivía en esa misma columna— con solo cambiarle el nombre, en
    // silencio. Aquí se fija la regla: solo se limpia al SALIR del rol que posee la atadura.
    const gestor = usuario({
      id: 14, username: 'gestor.medellin', name: 'Gestor Medellín', role: 'gestor_impuestos',
      transitoCodigo: '05001', organismosCodigos: ['05001'],
    });
    const { patches } = mockUsers(page, [gestor]);
    await mockCatalogos(page);

    await page.goto('/users');
    await page.getByRole('button', { name: 'Editar' }).first().click();
    await page.getByLabel('Nombre completo').fill('Gestor Medellín corregido');
    await page.getByRole('button', { name: 'Guardar cambios' }).click();

    await expect.poll(() => patches.length).toBe(1);
    // `toEqual` y no `toMatchObject`: lo que se comprueba es que NO viaja ninguna clave más.
    expect(patches[0]).toEqual({ name: 'Gestor Medellín corregido' });
  });

  test('TC-12053-23 · un usuario `transito` degradado SÍ pierde su código, como siempre', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const transito = usuario({ id: 15, username: 'transito.med', name: 'Ana Ruiz', role: 'transito', transitoCodigo: '05001' });
    const { patches } = mockUsers(page, [transito]);
    await mockCatalogos(page);

    await page.goto('/users');
    await page.getByRole('button', { name: 'Editar' }).first().click();
    await page.getByLabel('Rol base').selectOption('auditor');
    await page.getByRole('button', { name: 'Guardar cambios' }).click();

    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0]).toEqual({ role: 'auditor', transitoCodigo: null });
  });
});
