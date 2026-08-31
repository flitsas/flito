// HU #11936 — Formulario de SOAT en un paso y ficha RUNT en revisión (superficie Cliente).
//
// Continúa `soat-cliente-solicitud` de la #11914: la puerta, el canal y RN-01 siguen; el gate
// «Consultar el RUNT» desaparece. Un solo `POST /cliente`. El RUNT se intercepta NUNCA desde aquí
// (ya no hay preconsulta). Revisión admin: `soat-revision-rechazo.spec.ts`.
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, CLIENTE_USER, CLIENTE_CON_CANAL, OPERACIONES_USER } from '../helpers/auth';

const PLACA = 'ABC123';
const VIN = '9BWZZZ377VT004251';
const TIPO_DOC = 'CC';
const NUMERO_DOC = '1020304050';
const UUID_RECHAZADA = '11111111-2222-4333-8444-555555555555';

const RE_ALTA = /\/api\/flito\/soat\/cliente$/;
const RE_COLA = /\/api\/flito\/soat\?/;
const RE_PRECONSULTA = /\/api\/flito\/soat\/cliente\/preconsulta$/;

/** Una fila de la cola con la forma que `FlitoSoat` espera, ya recortada como al Cliente. */
function fila(over: Record<string, unknown> = {}) {
  return {
    id: UUID_RECHAZADA, vin: VIN, placa: PLACA, marca: 'RENAULT', linea: 'LOGAN',
    cilindraje: '1600', carroceria: 'SEDAN', tipoServicio: 'Particular',
    estado: 'pendiente_revision', esMultiplePropietario: false, companiaNombre: 'Transportes Sur',
    organismoNombre: 'STRIA TTEyTTO MEDELLIN',
    compradores: [{ nombreCompleto: 'María Gómez', numeroDocumento: '1020304050', orden: 0, porcentajeParticipacion: null }],
    tramitesFlit: [], tipoTramite: null, fechaAprobacion: null, fechaCreacion: '2026-08-01T10:00:00Z',
    enviadoEn: null, pagadoEn: null, estancado: false, motivoRechazo: null,
    creadoEn: '2026-08-01T10:00:00Z',
    ...over,
  };
}

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function mockCola(page: Page, items: unknown[] = []) {
  const estado = { items };
  await page.route(RE_COLA, (route) => json(route, 200, {
    items: estado.items, total: estado.items.length, page: 1, pageSize: 50,
  }));
  await page.route(/\/api\/flito\/soat\/facetas/, (route) =>
    json(route, 200, { companias: [], organismos: [], proveedores: [] }));
  return estado;
}

/** El fallo del canal, con el `codigo` que es su verdadero discriminador. */
const falloCanal = (status: number, codigo: string, error: string, extra: Record<string, unknown> = {}) =>
  ({ status, cuerpo: { error, codigo, ...extra } });

async function mockAlta(page: Page, respuesta?: { status: number; cuerpo: unknown }) {
  const altas: { url: string; method: string; post: string | null }[] = [];
  const preconsultas: string[] = [];
  await page.route(RE_ALTA, (route) => {
    altas.push({
      url: route.request().url(),
      method: route.request().method(),
      post: route.request().postData(),
    });
    return respuesta
      ? json(route, respuesta.status, respuesta.cuerpo)
      : json(route, 201, { id: UUID_RECHAZADA, estado: 'pendiente_revision' });
  });
  await page.route(RE_PRECONSULTA, (route) => {
    preconsultas.push(route.request().url());
    return json(route, 500, { error: 'la preconsulta ya no se llama desde el alta' });
  });
  return { altas, preconsultas };
}

async function llenarSolicitud(page: Page, { nombre = 'MARÍA FERNANDA GÓMEZ RUIZ' } = {}) {
  await page.getByLabel('Placa').fill(PLACA);
  await page.getByLabel('VIN').fill(VIN);
  await page.getByLabel('Tipo de documento').selectOption(TIPO_DOC);
  await page.getByLabel('Número de documento').fill(NUMERO_DOC);
  if (nombre) await page.getByLabel('Nombre completo o razón social').fill(nombre);
  await page.locator('input[type="file"]').setInputFiles({
    name: 'factura.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 e2e'),
  });
}

// ═════════════════════════ AC1 · un envío, sin Consultar el RUNT ═════════════════════════════════

test.describe('HU #11936 · AC1 — un paso, sin Consultar el RUNT', () => {
  test('la cola vacía del Cliente ya no le manda al Tablero, que no tiene', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);

    await page.goto('/flito/soat');
    await expect(page.getByText('Todavía no hay ningún SOAT de su compañía en FLITO.')).toBeVisible();
    await expect(page.getByText(/Sincroniza desde el Tablero/)).toHaveCount(0);
  });

  test('«Solicitar SOAT» lleva a la sub-ruta y el menú sigue teniendo UN ítem, marcado', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page, [fila()]);

    await page.goto('/flito/soat');
    const enlace = page.getByRole('link', { name: 'Solicitar SOAT' });
    await expect(enlace).toBeVisible();
    await expect(enlace).toHaveAttribute('href', '/flito/soat/solicitud');
    await enlace.click();
    await expect(page).toHaveURL(/\/flito\/soat\/solicitud$/);

    const nav = page.getByRole('navigation', { name: 'Navegación principal' });
    await expect(nav.getByRole('link')).toHaveCount(1);
    await expect(nav.getByRole('link', { name: 'SOAT' })).toHaveAttribute('aria-current', 'page');
  });

  test('cero botón Consultar el RUNT y los tres bloques se llenan desde el primer paint', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await mockAlta(page);
    await page.goto('/flito/soat/solicitud');

    await expect(page.getByRole('button', { name: /Consultar el RUNT|Consultar de nuevo|Volver a consultar/ })).toHaveCount(0);
    await expect(page.getByText('Se habilita cuando el RUNT responda.')).toHaveCount(0);
    await expect(page.getByLabel('Placa')).toBeVisible();
    await expect(page.getByLabel('Tipo de documento')).toBeVisible();
    await expect(page.getByLabel('Nombre completo o razón social')).toBeVisible();
    await expect(page.locator('input[type="file"]')).toHaveCount(1);
    const enviar = page.getByRole('button', { name: 'Enviar la solicitud' });
    await expect(enviar).toBeVisible();
    await expect(enviar).toBeEnabled();
  });

  test('no teclea marca, línea ni organismo: ni textbox ni input disabled', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await mockAlta(page);
    await page.goto('/flito/soat/solicitud');

    await expect(page.getByRole('textbox', { name: /Marca|Línea|Organismo/ })).toHaveCount(0);
    await expect(page.locator('input[disabled]')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Datos del RUNT' })).toHaveCount(0);
    await expect(page.getByText(/los consulta FLITO después/)).toBeVisible();
  });

  test('una sola petición POST /cliente, aterrizaje en la cola y chip Pendiente de revisión', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    const cola = await mockCola(page);
    const cap = await mockAlta(page);
    await page.goto('/flito/soat/solicitud');
    await llenarSolicitud(page);

    cola.items = [fila()];
    await page.getByRole('button', { name: 'Enviar la solicitud' }).click();

    await expect(page).toHaveURL(/\/flito\/soat$/);
    await expect(page.getByText('Solicitud enviada. FLITO la va a revisar.')).toBeVisible();
    await expect(page.getByText('Pendiente de revisión').first()).toBeVisible();
    expect(cap.altas).toHaveLength(1);
    expect(cap.altas[0].method).toBe('POST');
    expect(cap.preconsultas).toHaveLength(0);
  });
});

// ═════════════════════════ AC2 · RUNT caído no aborta el form ════════════════════════════════════

test.describe('HU #11936 · AC2 — el form no aborta', () => {
  test('el POST 201 no pinta alerta de RUNT ni «Volver a consultar»', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    const cola = await mockCola(page);
    await mockAlta(page);
    await page.goto('/flito/soat/solicitud');
    await llenarSolicitud(page);
    cola.items = [fila()];
    await page.getByRole('button', { name: 'Enviar la solicitud' }).click();

    await expect(page).toHaveURL(/\/flito\/soat$/);
    await expect(page.getByRole('alert').filter({ hasText: /RUNT/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Volver a consultar' })).toHaveCount(0);
  });
});

// ═════════════════════════ AC3 · vigente no bloquea al Cliente ═══════════════════════════════════

test.describe('HU #11936 · AC3 — vigente no impide crear', () => {
  test('tras enviar no hay dialog de SOAT vigente y el POST sí salió', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    const cola = await mockCola(page);
    const cap = await mockAlta(page);
    await page.goto('/flito/soat/solicitud');
    await llenarSolicitud(page);
    cola.items = [fila()];
    await page.getByRole('button', { name: 'Enviar la solicitud' }).click();

    await expect(page).toHaveURL(/\/flito\/soat$/);
    await expect(page.getByRole('dialog', { name: /SOAT vigente/ })).toHaveCount(0);
    expect(cap.altas).toHaveLength(1);
  });
});

// ═════════════════════════ AC5 · RN-01 intacto, subsanar sin Consultar el RUNT ═══════════════════

test.describe('HU #11936 · AC5 — RN-01 y subsanar', () => {
  test('propia y rechazada: modal RN-01, Abrir la solicitud rechazada, URL sin PII', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await page.route(/\/api\/flito\/soat\/[0-9a-f-]{36}$/, (route) =>
      json(route, 200, fila({ estado: 'rechazada' })));
    await mockAlta(page, falloCanal(409, 'vin_ya_tiene_soat', 'Esta solicitud ya existe y fue rechazada.', {
      propia: true, id: UUID_RECHAZADA, estado: 'rechazada',
    }));

    await page.goto('/flito/soat/solicitud');
    await llenarSolicitud(page);
    await page.getByRole('button', { name: 'Enviar la solicitud' }).click();

    const modal = page.getByRole('dialog', { name: 'Ese vehículo ya está en la cola de FLITO' });
    await expect(modal).toBeVisible();
    await expect(modal.getByText('No se puede crear otra solicitud')).toBeVisible();
    await modal.getByRole('link', { name: 'Abrir la solicitud rechazada' }).click();

    await expect(page).toHaveURL(new RegExp(`/flito/soat/solicitud/${UUID_RECHAZADA}$`));
    expect(page.url()).not.toContain(PLACA);
    expect(page.url()).not.toContain(VIN);
  });

  test('AJENA: sin botón primario, sin estado y sin fecha', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await mockAlta(page, falloCanal(409, 'vin_ya_tiene_soat', 'Este vehículo ya está registrado en FLITO con un SOAT.', {
      propia: false,
    }));

    await page.goto('/flito/soat/solicitud');
    await llenarSolicitud(page);
    await page.getByRole('button', { name: 'Enviar la solicitud' }).click();

    const modal = page.getByRole('dialog', { name: 'Ese vehículo ya está en la cola de FLITO' });
    await expect(modal.getByText('Escríbale a su contacto en FLIT si cree que es un error.')).toBeVisible();
    await expect(modal.getByRole('link', { name: 'Abrir la solicitud rechazada' })).toHaveCount(0);
    await expect(modal.getByRole('link', { name: 'Ver la solicitud' })).toHaveCount(0);
    await expect(modal.getByText(/Rechazada|Pendiente|Solicitado|Pagado|novedad/)).toHaveCount(0);
    await expect(modal.getByText(/\d{1,2}\/\d{1,2}\/\d{2,4}/)).toHaveCount(0);
  });

  test('en /solicitud/:id no hay Consultar el RUNT y Reenviar hace PATCH', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await page.route(/\/api\/flito\/soat\/[0-9a-f-]{36}$/, (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      return json(route, 200, fila({ estado: 'rechazada' }));
    });
    const patches: string[] = [];
    await page.route(/\/api\/flito\/soat\/[0-9a-f-]{36}\/solicitud$/, (route) => {
      patches.push(route.request().url());
      return json(route, 200, { id: UUID_RECHAZADA, estado: 'pendiente_revision' });
    });
    const preconsultas: string[] = [];
    await page.route(RE_PRECONSULTA, (route) => {
      preconsultas.push(route.request().url());
      return json(route, 500, {});
    });

    await page.goto(`/flito/soat/solicitud/${UUID_RECHAZADA}`);
    await expect(page.getByRole('button', { name: /Consultar el RUNT/ })).toHaveCount(0);
    await page.getByLabel('Tipo de documento').selectOption('CC');
    await page.getByRole('button', { name: 'Reenviar la solicitud' }).click();

    await expect.poll(() => patches.length).toBe(1);
    expect(preconsultas).toHaveLength(0);
    await expect(page.getByText('Solicitud enviada. FLITO la va a revisar.')).toBeVisible();
  });

  test('desde la cola: la pastilla «Rechazada» existe y su detalle no filtra la trastienda', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page, [fila({ estado: 'rechazada' })]);

    await page.goto('/flito/soat');
    await expect(page.getByRole('button', { name: 'Pendiente de revisión' })).toBeVisible();
    await page.getByRole('button', { name: 'Rechazada', exact: true }).click();

    await page.getByRole('button', { name: 'Ver' }).first().click();
    const detalle = page.getByRole('dialog');
    await expect(detalle).toBeVisible();
    await expect(detalle.getByText(/Gestiona|Enviado por|Valor pagado/)).toHaveCount(0);
    await expect(detalle.getByRole('button', { name: 'Ver el historial de estados' })).toHaveCount(0);
  });

  test('el historial SIGUE estando para Operaciones', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page, [fila({ estado: 'rechazada' })]);

    await page.goto('/flito/soat');
    await page.getByRole('button', { name: 'Ver' }).first().click();
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Ver el historial de estados' })).toBeVisible();
  });
});

// ═════════════════════════ Canal apagado, PDF y envío ════════════════════════════════════════════

test.describe('HU #11936 — la compañía sin canal, la carrera y el adjunto', () => {
  test('sin el flag no hay botón, hay tarjeta neutra, y la URL directa no dice «No tienes acceso»', async ({ page }) => {
    await loginAs(page, CLIENTE_USER);
    await mockCola(page, [fila()]);

    await page.goto('/flito/soat');
    await expect(page.getByRole('link', { name: 'Solicitar SOAT' })).toHaveCount(0);
    await expect(page.getByText('Su compañía todavía no tiene habilitado este canal, así que por ahora aquí solo puede consultar sus SOAT.')).toBeVisible();

    await page.goto('/flito/soat/solicitud');
    await expect(page.getByText('Su compañía todavía no tiene habilitado este canal, así que por ahora aquí solo puede consultar sus SOAT.')).toBeVisible();
    await expect(page.getByText(/No tienes acceso/)).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Volver a mis SOAT' })).toBeVisible();
  });

  test('la carrera: /me dice que sí y el POST responde 403 → «no se envió nada»', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await mockAlta(page, {
      status: 403,
      cuerpo: { error: 'Tu compañía no tiene habilitada la solicitud de SOAT sin trámite.', codigo: 'canal_desactivado' },
    });
    await page.goto('/flito/soat/solicitud');
    await llenarSolicitud(page);
    await page.getByRole('button', { name: 'Enviar la solicitud' }).click();

    await expect(page.getByText('El canal se deshabilitó mientras llenaba el formulario, así que no se envió nada.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enviar la solicitud' })).toHaveCount(0);
  });

  test('un PDF que no lo es: la caja queda rechazada y dice POR QUÉ', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await mockAlta(page, {
      status: 400,
      cuerpo: { error: 'La factura de venta debe ser un PDF.', codigo: 'archivo_no_pdf' },
    });
    await page.goto('/flito/soat/solicitud');
    await llenarSolicitud(page);
    await page.getByRole('button', { name: 'Enviar la solicitud' }).click();

    await expect(page.getByRole('alert')
      .filter({ hasText: 'Ese archivo no es un PDF válido, aunque se llame así.' })).toBeVisible();
    await expect(page.getByText('Rechazado — cargar otro')).toBeVisible();
  });

  test('enviar con el nombre vacío marca el campo, lo enfoca y no manda nada', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    const cap = await mockAlta(page);
    await page.goto('/flito/soat/solicitud');
    await llenarSolicitud(page, { nombre: '' });

    await page.getByRole('button', { name: 'Enviar la solicitud' }).click();

    const nombre = page.getByLabel('Nombre completo o razón social');
    await expect(nombre).toBeFocused();
    await expect(nombre).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('alert')
      .filter({ hasText: 'Escriba el nombre completo o la razón social del propietario.' })).toBeVisible();
    expect(cap.altas).toHaveLength(0);
  });

  test('si el envío se corta, se dice que NO se sabe si llegó — y dónde mirar', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await page.route(RE_ALTA, (route) => route.abort('connectionfailed'));

    await page.goto('/flito/soat/solicitud');
    await llenarSolicitud(page);
    await page.getByRole('button', { name: 'Enviar la solicitud' }).click();

    await expect(page.getByText(`No sabemos si la solicitud llegó a FLITO. Vuelva a sus SOAT y busque la placa ${PLACA} antes de volver a enviarla.`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enviar la solicitud' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Volver a mis SOAT' })).toBeVisible();
  });

  test('salir con datos escritos pide confirmación: no hay borradores que rescatar', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);

    await page.goto('/flito/soat/solicitud');
    await page.getByLabel('Placa').fill(PLACA);
    await page.getByRole('button', { name: '← Volver a mis SOAT' }).click();

    const dialogo = page.getByRole('dialog', { name: '¿Descartar la solicitud?' });
    await expect(dialogo.getByText('Lo que escribió no se guarda: no hay borradores.')).toBeVisible();
    await dialogo.getByRole('button', { name: 'Seguir llenando' }).click();
    await expect(page.getByLabel('Placa')).toHaveValue(PLACA);

    await page.getByRole('button', { name: '← Volver a mis SOAT' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Descartar' }).click();
    await expect(page).toHaveURL(/\/flito\/soat$/);
  });

  test('la PII viaja en el CUERPO y la URL no la toca en ningún punto del recorrido', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    const urls: string[] = [];
    page.on('framenavigated', () => urls.push(page.url()));

    const cap = await mockAlta(page);
    await page.goto('/flito/soat/solicitud');
    await llenarSolicitud(page);
    await page.getByRole('button', { name: 'Enviar la solicitud' }).click();
    await expect(page).toHaveURL(/\/flito\/soat$/);

    expect(cap.altas).toHaveLength(1);
    expect(new URL(cap.altas[0].url).search).toBe('');
    expect(cap.altas[0].post ?? '').toContain(PLACA);
    expect(cap.altas[0].post ?? '').toContain(VIN);
    expect(cap.altas[0].post ?? '').toContain(NUMERO_DOC);
    for (const url of [...urls, page.url()]) {
      expect(url).not.toContain(PLACA);
      expect(url).not.toContain(VIN);
      expect(url).not.toContain('1020304050');
    }
  });
});

// ═════════════════════════ Subsanación · cuatro estados ══════════════════════════════════════════

test.describe('HU #11936 · /flito/soat/solicitud/:id', () => {
  test('una solicitud que ya no está rechazada NO monta el formulario', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await page.route(/\/api\/flito\/soat\/[0-9a-f-]{36}$/, (route) =>
      json(route, 200, fila({ estado: 'pendiente_revision' })));

    await page.goto(`/flito/soat/solicitud/${UUID_RECHAZADA}`);
    await expect(page.getByText('Esta solicitud ya no está rechazada: FLITO la está revisando. No hay nada que corregir por ahora.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reenviar la solicitud' })).toHaveCount(0);
  });

  test('404 — no existe o no es de su compañía, y hay salida', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await page.route(/\/api\/flito\/soat\/[0-9a-f-]{36}$/, (route) =>
      json(route, 404, { error: 'El SOAT no existe' }));

    await page.goto(`/flito/soat/solicitud/${UUID_RECHAZADA}`);
    await expect(page.getByText('Esta solicitud no existe o no es de su compañía.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Volver a mis SOAT' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
  });

  test('un fallo de carga SÍ trae reintento, y el segundo intento pinta la solicitud', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    let carga: 'error' | 'ok' = 'error';
    await page.route(/\/api\/flito\/soat\/[0-9a-f-]{36}$/, (route) => (carga === 'error'
      ? json(route, 500, { error: 'Error del servidor' })
      : json(route, 200, fila({ estado: 'rechazada' }))));

    await page.goto(`/flito/soat/solicitud/${UUID_RECHAZADA}`);
    await expect(page.getByText('No pudimos cargar esta solicitud.')).toBeVisible();
    carga = 'ok';
    await page.getByRole('button', { name: 'Reintentar' }).click();

    await expect(page.getByRole('button', { name: 'Reenviar la solicitud' })).toBeVisible();
    const ficha = page.getByRole('region', { name: 'Datos del RUNT' });
    await expect(ficha.getByText(PLACA, { exact: true })).toBeVisible();
    await expect(ficha.getByText(VIN, { exact: true })).toBeVisible();
    await expect(page.getByLabel('Nombre completo o razón social')).toHaveValue('María Gómez');
  });
});
