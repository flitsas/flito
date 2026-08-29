// HU #11913 — Identidad: rol `cliente`, compañía obligatoria y flag «SOAT sin trámite».
//
// Lo que este spec protege no es una pantalla nueva —esta HU no trae ninguna— sino cuatro fronteras
// que se rompen en silencio:
//
//   · AC1  el menú del Cliente tiene UNA entrada, y su sesión ATERRIZA en ella.
//   · AC2  crear un Cliente sin compañía no manda la petición.
//   · AC3  «SOAT sin trámite» se llama como debe, nace apagada y viaja SOLA en el PATCH.
//   · AC4  el Cliente no entra al legado `/soat`, y los tres roles de siempre no cambian.
//
// Dos apuntes de método, porque sin ellos varios asertos pasarían por vacío:
//
//   1. **El menú se CUENTA antes de nombrarse.** `getByRole('link', { name: 'SOAT' })` está verde
//      también con «Ayuda FLITO» al lado, que es exactamente el fallo que el AC1 prohíbe; el conteo
//      es lo que lo mata. Y se cuentan además los BOTONES del dock: una sección con dos o más ítems
//      no se pinta como enlace sino como disparador de panel, así que una entrada colada por esa
//      vía no subiría el número de enlaces.
//   2. **El AC4 se mide por CONTENIDO, no por URL.** Que `/soat` no cambie de dirección no prueba
//      nada; lo que hay que afirmar es que la cadena exclusiva del legado —«Gestión SOAT», el
//      encabezado de `Soat.tsx`— no está en la página.
//
// El backend va mockeado, como en el resto de la carpeta.
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, CLIENTE_USER, OPERACIONES_USER, PROVEEDOR_USER } from '../helpers/auth';

const COMPANIAS = [
  { id: 1, nombre: 'Concesionario Norte', nit: '900111', soatAutogestionable: true, soatSinTramite: false },
  { id: 2, nombre: 'Transportes Sur', nit: '900222', soatAutogestionable: false, soatSinTramite: false },
];

// Dos filas con la bandera nueva en valores OPUESTOS, y a propósito.
//
// Con una sola fila apagada, `not.toBeChecked()` pasa igual si la casilla ignora el campo y pinta
// siempre `false` —que es exactamente el mutante que hay que matar—. La segunda fila, encendida, es
// la que obliga a que el valor venga del payload. Y las dos llevan `soatAutogestionable` al revés
// que `soatSinTramite`: si alguien cruzara las dos banderas, el par se rompe.
const CLIENTES = [
  {
    id: 1, name: 'Concesionario Norte', document: '900111', documentType: 'NIT',
    phone: '3001112233', email: 'norte@x.co', address: null, city: 'Manizales',
    soatAutogestionable: true, soatSinTramite: false, impuestosAutogestionable: false,
    logisticaAutogestionable: false, logisticaPermiteParcial: false,
  },
  {
    id: 2, name: 'Transportes Sur', document: '900222', documentType: 'NIT',
    phone: null, email: null, address: null, city: 'Pereira',
    soatAutogestionable: false, soatSinTramite: true, impuestosAutogestionable: false,
    logisticaAutogestionable: false, logisticaPermiteParcial: false,
  },
];

const NAV = { name: 'Navegación principal' };

/** La cola SOAT vacía, que es lo que el Cliente ve hasta que la #11914 le deje radicar. */
async function mockSoat(page: Page) {
  await page.route(/\/api\/flito\/soat\?/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ items: [], total: 0, page: 1, pageSize: 50 }),
  }));
  await page.route(/\/api\/flito\/soat\/facetas/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ companias: [], organismos: [], proveedores: [] }),
  }));
}

async function mockCompanias(page: Page, companias: typeof COMPANIAS = COMPANIAS) {
  await page.route(/\/api\/flito\/parametrizacion\/companias$/, (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(companias),
  }));
}

// ───────────────────────────── AC1 · el menú y el aterrizaje ─────────────────────────────────────

test.describe('HU #11913 · AC1 — el Cliente ve SOAT y nada más', () => {
  test('el menú tiene UNA sola entrada, y es SOAT → /flito/soat', async ({ page }) => {
    await loginAs(page, CLIENTE_USER);
    await mockSoat(page);

    await page.goto('/flito/soat');
    const nav = page.getByRole('navigation', NAV);

    // Primero el conteo. Sin él, el aserto de presencia de abajo pasa igual con una segunda
    // entrada al lado, que es el falso verde más barato de esta HU.
    await expect(nav.getByRole('link')).toHaveCount(1);
    // Y ningún disparador de panel: una sección con 2+ ítems se pinta como botón, no como enlace.
    await expect(nav.getByRole('button')).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'SOAT' })).toHaveAttribute('href', '/flito/soat');
  });

  test('las ausencias, una por una y por su nombre', async ({ page }) => {
    await loginAs(page, CLIENTE_USER);
    await mockSoat(page);

    await page.goto('/flito/soat');
    const nav = page.getByRole('navigation', NAV);

    // «Ayuda FLITO» es la que se cuela sola: no se filtra por slug sino por «≥1 ficha visible», y
    // la ficha de SOAT cuelga ahora de `flito_soat`, que el Cliente SÍ tiene.
    for (const ausente of ['Tablero', 'Ayuda FLITO', 'Usuarios', 'Clientes y proveedores', 'Impuestos']) {
      await expect(nav.getByRole('link', { name: ausente })).toHaveCount(0);
    }
  });

  test('la sesión aterriza en /flito/soat y no en el NoAccess del tablero', async ({ page }) => {
    await loginAs(page, CLIENTE_USER);
    await mockSoat(page);

    // `/` es la ruta a la que navega el login por defecto. Antes de `rutaInicio` esto era
    // «No tienes acceso a Tablero de control» con un botón que volvía aquí mismo.
    await page.goto('/');
    await expect(page).toHaveURL(/\/flito\/soat$/);
    await expect(page.getByText('No tienes acceso a Tablero de control')).toHaveCount(0);
  });

  test('una URL inexistente pasa por el comodín y acaba también en /flito/soat', async ({ page }) => {
    await loginAs(page, CLIENTE_USER);
    await mockSoat(page);

    await page.goto('/no-existe');
    await expect(page).toHaveURL(/\/flito\/soat$/);
  });
});

// ───────────────────────────── AC4 · el legado y la salida ───────────────────────────────────────

test.describe('HU #11913 · AC4 — el legado /soat le queda cerrado', () => {
  test('/soat no pinta Soat.tsx: el Cliente no tiene la llave `soat`', async ({ page }) => {
    await loginAs(page, CLIENTE_USER);
    await mockSoat(page);

    await page.goto('/soat');
    // Medido por contenido: «Gestión SOAT» es el encabezado exclusivo del legado.
    await expect(page.getByText('Gestión SOAT')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /No tienes acceso a SOAT/ })).toBeVisible();
  });

  test('el NoAccess ofrece salida al Cliente en vez de devolverlo al bucle', async ({ page }) => {
    await loginAs(page, CLIENTE_USER);
    await mockSoat(page);

    await page.goto('/users');
    const salida = page.getByRole('link', { name: 'Ir a SOAT' });
    await expect(salida).toBeVisible();
    await salida.click();
    await expect(page).toHaveURL(/\/flito\/soat$/);
  });

  test('el proveedor no cambia: conserva el portal, el legado y su «Volver al tablero»', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await mockSoat(page);

    // Sigue teniendo el slug nuevo (aditivo): el portal le abre igual que antes de la HU.
    await page.goto('/flito/soat');
    await expect(page.getByRole('heading', { name: 'SOAT', exact: true })).toBeVisible();

    // Y su NoAccess sigue diciendo lo de siempre, palabra por palabra.
    await page.goto('/users');
    await expect(page.getByRole('link', { name: 'Volver al tablero' })).toBeVisible();
  });
});

// ───────────────────────────── AC2 · la compañía del Cliente ─────────────────────────────────────

/** Abre «Nuevo usuario» con los campos obligatorios ajenos ya rellenos y el rol en Cliente. */
async function abrirAltaCliente(page: Page) {
  await page.route(/\/api\/users$/, (route) => (route.request().method() === 'GET'
    ? route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
    : route.fallback()));
  await mockCompanias(page);

  await page.goto('/users');
  await page.getByRole('button', { name: 'Nuevo usuario' }).click();
  await page.getByLabel('Username (login)').fill('cliente_e2e');
  await page.getByLabel('Nombre completo').fill('Cliente E2E');
  await page.getByLabel(/^Contraseña/).fill('Abcdef1!');
  await page.getByLabel('Rol base').selectOption('cliente');
}

test.describe('HU #11913 · AC2 — un Cliente sin compañía no se crea', () => {
  test('el campo Compañía aparece solo con el rol Cliente', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await abrirAltaCliente(page);

    await expect(page.getByLabel('Compañía')).toBeVisible();
    // Cambiar de rol lo retira Y limpia lo elegido: volver a Cliente no reaparece con valor.
    await page.getByLabel('Compañía').selectOption('1');
    await page.getByLabel('Rol base').selectOption('proveedor');
    await expect(page.getByLabel('Compañía')).toHaveCount(0);
    await page.getByLabel('Rol base').selectOption('cliente');
    await expect(page.getByLabel('Compañía')).toHaveValue('');
  });

  test('enviar sin compañía se rechaza AQUÍ: mensaje en español, foco al control y CERO POST', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const posts: unknown[] = [];
    await page.route(/\/api\/users$/, async (route) => {
      if (route.request().method() === 'POST') { posts.push(route.request().postDataJSON()); return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' }); }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await mockCompanias(page);

    await page.goto('/users');
    await page.getByRole('button', { name: 'Nuevo usuario' }).click();
    await page.getByLabel('Username (login)').fill('cliente_e2e');
    await page.getByLabel('Nombre completo').fill('Cliente E2E');
    await page.getByLabel(/^Contraseña/).fill('Abcdef1!');
    await page.getByLabel('Rol base').selectOption('cliente');

    await page.getByRole('button', { name: 'Crear usuario' }).click();

    await expect(page.getByRole('alert')).toHaveText('Selecciona la compañía del usuario Cliente.');
    await expect(page.getByLabel('Compañía')).toBeFocused();
    await expect(page.getByLabel('Compañía')).toHaveAttribute('aria-invalid', 'true');
    // El aserto que mata al mutante «quitar la validación y confiar en el 400 del servidor».
    expect(posts).toHaveLength(0);
  });

  test('con la compañía elegida, el alta la manda como número y el mensaje desaparece', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    let body: Record<string, unknown> | null = null;
    await page.route(/\/api\/users$/, async (route) => {
      if (route.request().method() === 'POST') {
        body = route.request().postDataJSON() as Record<string, unknown>;
        return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await mockCompanias(page);

    await page.goto('/users');
    await page.getByRole('button', { name: 'Nuevo usuario' }).click();
    await page.getByLabel('Username (login)').fill('cliente_e2e');
    await page.getByLabel('Nombre completo').fill('Cliente E2E');
    await page.getByLabel(/^Contraseña/).fill('Abcdef1!');
    await page.getByLabel('Rol base').selectOption('cliente');
    await page.getByLabel('Compañía').selectOption('2');
    await page.getByRole('button', { name: 'Crear usuario' }).click();

    await expect.poll(() => body).not.toBeNull();
    expect(body).toMatchObject({ role: 'cliente', companiaId: 2 });
  });

  test('los 4 estados del selector: sin catálogo, el envío queda bloqueado y hay reintento', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await page.route(/\/api\/users$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    // UNA sola ruta con un interruptor, y no dos `page.route` encadenados: el catálogo se pide dos
    // veces al montar (`React.StrictMode` invoca el efecto dos veces en desarrollo), y con dos
    // rutas del mismo patrón lo que decide la respuesta es el orden de registro contra el orden de
    // las peticiones en vuelo. Aquí lo decide el test, y en el momento exacto en que quiere.
    let catalogo: 'error' | 'vacio' = 'error';
    await page.route(/\/api\/flito\/parametrizacion\/companias$/, (route) => (catalogo === 'error'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Catálogo caído' }) })
      : route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })));

    // Estado 2 — error. El botón de reintento es la ÚNICA parada de tabulador del callejón: un
    // `<select disabled>` no recibe foco y su descripción queda inalcanzable por teclado.
    await page.goto('/users');
    await page.getByRole('button', { name: 'Nuevo usuario' }).click();
    await page.getByLabel('Rol base').selectOption('cliente');
    await expect(page.getByText('No se pudieron cargar las compañías.')).toBeVisible();
    await expect(page.getByLabel('Compañía')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Volver a cargar compañías' })).toBeVisible();

    // Estado 3 — vacío. Mensaje distinto y SIN reintento: volver a pedir no crea compañías.
    catalogo = 'vacio';
    await page.getByRole('button', { name: 'Volver a cargar compañías' }).click();
    await expect(page.getByText(/No hay compañías registradas/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Volver a cargar compañías' })).toHaveCount(0);
    await expect(page.getByLabel('Compañía')).toBeDisabled();
  });
});

// ───────────────────────────── AC3 · el flag de la compañía ──────────────────────────────────────

test.describe('HU #11913 · AC3 — «SOAT sin trámite» en Clientes', () => {
  test('la casilla se lee del listado —apagada y encendida— y se llama por su nombre, no «Autogestión…»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    // UNA sola ruta: el flag viaja en `GET /clients` como sus cuatro vecinas. Si la pantalla
    // volviera a cruzarlo con `/flito/parametrizacion/companias`, el catch-all del fixture le
    // devolvería `[]` y la fila encendida de abajo se pintaría apagada.
    await page.route(/\/api\/clients(\?|$)/, (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(CLIENTES),
    }));

    await page.goto('/clients');
    await expect(page.getByRole('columnheader', { name: 'SOAT sin trámite' })).toBeVisible();
    // Apagada Y encendida. Solo el par prueba que el valor sale del payload y no de un `false` fijo.
    await expect(page.getByRole('checkbox', { name: 'SOAT sin trámite de Concesionario Norte' })).not.toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'SOAT sin trámite de Transportes Sur' })).toBeChecked();
    // El nombre por defecto de `CeldaFlag` afirmaría lo contrario de lo que hace la casilla. El
    // aserto positivo solo no lo detecta: hace falta el negativo.
    await expect(page.getByLabel(/Autogestión SOAT sin trámite/)).toHaveCount(0);
    // Y las vecinas van al revés en cada fila: si alguien cruzara las dos banderas, esto se rompe.
    await expect(page.getByRole('checkbox', { name: 'Autogestión SOAT de Concesionario Norte' })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Autogestión SOAT de Transportes Sur' })).not.toBeChecked();
  });

  test('encenderla manda SOLO su clave y no toca la casilla de autogestión', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await page.route(/\/api\/clients(\?|$)/, (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(CLIENTES),
    }));
    let body: Record<string, unknown> | null = null;
    await page.route(/\/api\/flito\/parametrizacion\/companias\/1$/, async (route) => {
      body = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 1 }) });
    });

    await page.goto('/clients');
    await page.getByRole('checkbox', { name: 'SOAT sin trámite de Concesionario Norte' }).check();

    await expect.poll(() => body).not.toBeNull();
    // `toEqual` y no `toMatchObject`: lo que se comprueba es que NO viaja ninguna clave más.
    expect(body).toEqual({ soatSinTramite: true });
    await expect(page.getByRole('checkbox', { name: 'SOAT sin trámite de Concesionario Norte' })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Autogestión SOAT de Concesionario Norte' })).toBeChecked();
  });

  test('un fallo del listado se ve como fallo, y no como «No hay clientes.»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await page.route(/\/api\/clients(\?|$)/, (route) => route.fulfill({
      status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Listado caído' }),
    }));

    await page.goto('/clients');
    await expect(page.getByRole('alert')).toHaveText('Listado caído');
    // El estado que esta HU paga: sin él, perder lo que se acaba de marcar y no haber cargado nunca
    // se leen exactamente igual — en la tabla donde se verifica el AC3.
    await expect(page.getByText('No hay clientes.')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reintentar' })).toBeVisible();
  });
});
