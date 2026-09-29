import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, AUDITOR_USER, funcionesDe } from '../helpers/auth';

// FLITO — Gestión Trámites · «Acceso a FLIT 2» (HU #13064). Backend mockeado: se verifica el
// cableado de la UI contra el contrato `Flit2AccesoMeta` (GET/PUT /api/flito/sync/flit2/acceso).

const RUTA = /\/api\/flito\/sync\/flit2\/acceso$/;
const CLAVE = 'CLAVE-SECRETA-e2e-13064';

const SIN_ACCESO = {
  configurado: false, clientId: null, actualizadoPor: null, actualizadoEn: null, estado: null, bloqueadoHasta: null,
};
const CON_ACCESO = {
  configurado: true, clientId: 'flito-dev', actualizadoPor: { id: 1, nombre: 'Ana Pérez' },
  actualizadoEn: '2026-09-29T15:42:00.000Z', estado: 'vigente', bloqueadoHasta: null,
};

/** Admin con «ver» pero sin «guardar» (AC5). */
const SOLO_VER = funcionesDe(OPERACIONES_USER).filter((f) => f !== 'tramites.flit2.guardar_acceso');

async function mockCola(page: Page) {
  await page.route(/\/api\/flito\/tramites\/facetas/, (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ estados: [], tramites: [], ciudades: [], transitos: [] }),
  }));
  await page.route(/\/api\/flito\/tramites\?/, (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], total: 0, page: 1, pageSize: 50 }),
  }));
}

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function abrirPanel(page: Page) {
  await page.goto('/flito/tramites');
  await page.getByRole('button', { name: 'Acceso a FLIT 2' }).click();
  return page.getByRole('dialog', { name: 'Acceso a FLIT 2' });
}

test.describe('FLITO — Gestión Trámites · Acceso a FLIT 2 (HU #13064)', () => {
  test('AC1: sin «ver el acceso» no hay botón', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mockCola(page);
    await page.goto('/flito/tramites');
    await expect(page.getByRole('heading', { name: 'Gestión Trámites', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Acceso a FLIT 2' })).toHaveCount(0);
  });

  test('AC1: el administrador ve el botón y la cola no consulta el acceso hasta abrir el panel', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    let gets = 0;
    await page.route(RUTA, (r) => { gets += 1; return json(r, 200, CON_ACCESO); });
    await page.goto('/flito/tramites');
    const boton = page.getByRole('button', { name: 'Acceso a FLIT 2' });
    await expect(boton).toBeVisible();
    expect(gets).toBe(0);
    await boton.click();
    await expect(page.getByRole('dialog', { name: 'Acceso a FLIT 2' })).toBeVisible();
    // ≥ 1 y no 1: en dev, StrictMode monta el efecto dos veces (en build sale una sola).
    await expect.poll(() => gets).toBeGreaterThanOrEqual(1);
  });

  test('AC2: con acceso se ven usuario, quién y desde cuándo; nunca la contraseña', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    await page.route(RUTA, (r) => json(r, 200, CON_ACCESO));
    const panel = await abrirPanel(page);
    await expect(panel.getByText('Vigente', { exact: true })).toBeVisible();
    await expect(panel.getByText('flito-dev', { exact: true })).toBeVisible();
    await expect(panel.getByText('Ana Pérez', { exact: true })).toBeVisible();
    // Hora de Colombia (15:42 UTC = 10:42 a. m.).
    await expect(panel.getByText(/29 de sept?\.? de 2026, 10:42/)).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Reemplazar acceso' })).toBeVisible();
    // La contraseña no se pinta: el campo está vacío y no hay dato de clave en la ficha.
    await expect(panel.getByLabel('Contraseña')).toHaveValue('');
    await expect(panel.getByText(/contraseña:/i)).toHaveCount(0);
  });

  test('AC3: sin acceso, aviso claro con el siguiente paso según el permiso', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    await page.route(RUTA, (r) => json(r, 200, SIN_ACCESO));
    const panel = await abrirPanel(page);
    await expect(panel.getByText('Sin acceso', { exact: true })).toBeVisible();
    await expect(panel.getByRole('status').filter({ hasText: 'FLITO aún no tiene acceso a FLIT 2 en este ambiente.' })).toBeVisible();
    await expect(panel.getByText('Escribe el usuario de servicio y la contraseña que entregó FLIT 2.')).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Configurar acceso' })).toBeVisible();
    await expect(panel.getByText('Guardado por')).toHaveCount(0);
  });

  test('AC5: con «ver» y sin «guardar», estado sin formulario', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER, { funciones: SOLO_VER });
    await mockCola(page);
    let respuesta: unknown = CON_ACCESO;
    await page.route(RUTA, (r) => json(r, 200, respuesta));
    let panel = await abrirPanel(page);
    await expect(panel.getByText('flito-dev', { exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Guardar acceso' })).toHaveCount(0);
    await expect(panel.getByLabel('Contraseña')).toHaveCount(0);

    // Sin acceso y sin «guardar»: el siguiente paso es pedirlo a quien puede.
    respuesta = SIN_ACCESO;
    await panel.getByRole('button', { name: 'Cerrar' }).click();
    panel = await abrirPanel(page);
    await expect(panel.getByText('Pídele a un administrador con permiso de guardar el acceso que lo configure.')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Guardar acceso' })).toHaveCount(0);
  });

  test('AC4: guardar confirma, actualiza el estado y deja los campos vacíos; la clave no se serializa', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    let cuerpoPut: unknown = null;
    await page.route(RUTA, (r) => {
      if (r.request().method() === 'PUT') {
        cuerpoPut = r.request().postDataJSON();
        return json(r, 200, { ...CON_ACCESO, clientId: 'flito-nuevo', estado: null, actualizadoPor: { id: 7, nombre: 'Operaciones E2E' } });
      }
      return json(r, 200, CON_ACCESO);
    });
    const panel = await abrirPanel(page);
    // Validación en línea: los dos campos son obligatorios.
    await panel.getByRole('button', { name: 'Guardar acceso' }).click();
    await expect(panel.getByText('Escribe el usuario de servicio.')).toBeVisible();
    await expect(panel.getByText('Escribe la contraseña.')).toBeVisible();
    expect(cuerpoPut).toBeNull();

    await panel.getByLabel('Usuario de servicio').fill('flito-nuevo');
    await panel.getByLabel('Contraseña').fill(CLAVE);
    await expect(panel.getByLabel('Contraseña')).toHaveAttribute('type', 'password');
    await expect(panel.getByLabel('Contraseña')).toHaveAttribute('autocomplete', 'new-password');
    expect(await panel.getByLabel('Contraseña').getAttribute('name')).toBeNull();
    // Input no controlado: lo tecleado no llega al DOM serializado.
    expect(await page.content()).not.toContain(CLAVE);

    await panel.getByRole('button', { name: 'Guardar acceso' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Acceso a FLIT 2 guardado.' })).toBeVisible();
    expect(cuerpoPut).toEqual({ clientId: 'flito-nuevo', clientSecret: CLAVE });
    await expect(panel.getByText('flito-nuevo', { exact: true })).toBeVisible();
    await expect(panel.getByText('Operaciones E2E', { exact: true })).toBeVisible();
    await expect(panel.getByText('Sin probar', { exact: true })).toBeVisible();
    await expect(panel.getByLabel('Usuario de servicio')).toHaveValue('');
    await expect(panel.getByLabel('Contraseña')).toHaveValue('');
    expect(page.url()).not.toContain(CLAVE);
    // El toast del kit es cerrable.
    await page.getByRole('button', { name: 'Cerrar aviso' }).first().click();
    await expect(page.getByRole('status').filter({ hasText: 'Acceso a FLIT 2 guardado.' })).toHaveCount(0);
  });

  test('AC6: error al cargar → aviso con Reintentar, sin «Vigente» residual; Reintentar recupera', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    let falla = true;
    await page.route(RUTA, (r) => (falla
      ? json(r, 500, { error: 'boom interno pg_crypto', codigo: 'x' })
      : json(r, 200, CON_ACCESO)));
    const panel = await abrirPanel(page);
    await expect(panel.getByRole('alert')).toContainText('No se pudo consultar el acceso a FLIT 2. Vuelve a intentarlo.');
    await expect(panel.getByText('boom interno')).toHaveCount(0);
    await expect(panel.getByText('Vigente', { exact: true })).toHaveCount(0);
    falla = false;
    await panel.getByRole('button', { name: 'Reintentar' }).click();
    await expect(panel.getByText('Vigente', { exact: true })).toBeVisible();
  });

  test('AC6: error al guardar → copy propio, conserva el usuario, nunca el error crudo ni la clave', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    let respuestaPut: { status: number; body: unknown } = {
      status: 409, body: { error: 'Otra actualización del acceso crudo', codigo: 'acceso_rotacion_concurrente' },
    };
    let gets = 0;
    await page.route(RUTA, (r) => {
      if (r.request().method() === 'PUT') return json(r, respuestaPut.status, respuestaPut.body);
      gets += 1;
      return json(r, 200, CON_ACCESO);
    });
    const panel = await abrirPanel(page);
    await panel.getByLabel('Usuario de servicio').fill('flito-nuevo');
    await panel.getByLabel('Contraseña').fill(CLAVE);
    await panel.getByRole('button', { name: 'Guardar acceso' }).click();

    const alerta = panel.getByRole('alert');
    await expect(alerta).toContainText('Alguien más guardó el acceso en este momento. Actualiza el estado y vuelve a intentarlo.');
    await expect(panel.getByText('crudo')).toHaveCount(0);
    await expect(panel.getByLabel('Usuario de servicio')).toHaveValue('flito-nuevo');
    expect(await page.content()).not.toContain(CLAVE);

    // 503 llave_maestra: copy propio.
    respuestaPut = { status: 503, body: { error: 'FLIT2_ENC_KEY ausente', codigo: 'llave_maestra' } };
    await panel.getByLabel('Contraseña').fill(CLAVE);
    await panel.getByRole('button', { name: 'Guardar acceso' }).click();
    await expect(panel.getByRole('alert')).toContainText('falta la llave de cifrado. Avísale a quien administra el ambiente.');
    await expect(panel.getByText('FLIT2_ENC_KEY')).toHaveCount(0);

    // 500 genérico: reintentar el guardado con el mismo botón.
    respuestaPut = { status: 500, body: { error: 'stack crudo' } };
    await panel.getByLabel('Contraseña').fill(CLAVE);
    await panel.getByRole('button', { name: 'Guardar acceso' }).click();
    await expect(panel.getByRole('alert')).toContainText('No se pudo guardar el acceso a FLIT 2. Vuelve a intentarlo.');

    // 409 ofrece «Actualizar estado», que recarga la meta.
    respuestaPut = { status: 409, body: { error: 'x', codigo: 'acceso_rotacion_concurrente' } };
    await panel.getByLabel('Contraseña').fill(CLAVE);
    await panel.getByRole('button', { name: 'Guardar acceso' }).click();
    const antes = gets;
    await panel.getByRole('button', { name: 'Actualizar estado' }).click();
    await expect.poll(() => gets).toBe(antes + 1);
    await expect(panel.getByText('Vigente', { exact: true })).toBeVisible();
  });
});

// ── HU #13069 · «Probar conexión» ──────────────────────────────────────────────────────────────
// POST /api/flito/sync/flit2/acceso/probar → 200 `Flit2PruebaResultado` · 429 limitador · 503.
// El `mensaje` y el `scope` de la API llevan una marca que la pantalla no debe pintar nunca.

const RUTA_PROBAR = /\/api\/flito\/sync\/flit2\/acceso\/probar$/;
const CRUDO = 'MENSAJE-CRUDO-DE-LA-API';
const SCOPE_CRUDO = 'scope:pii-crudo';
/** 15:57 UTC = 10:57 a. m. en Colombia. */
const HASTA = '2026-09-29T15:57:00.000Z';

function prueba(resultado: string, bloqueadoHasta: string | null = null) {
  return { resultado, mensaje: CRUDO, bloqueadoHasta, scope: [SCOPE_CRUDO] };
}

type Caso = { nombre: string; status: number; body: unknown; tono: 'ok' | 'advertencia' | 'error'; copy: string | RegExp };

const CASOS: Caso[] = [
  { nombre: 'conectado', status: 200, body: prueba('conectado'), tono: 'ok',
    copy: 'Conectado. FLITO puede leer los trámites de FLIT 2.' },
  { nombre: 'conectado_sin_pii', status: 200, body: prueba('conectado_sin_pii'), tono: 'advertencia',
    copy: /Conectado, pero sin permiso de datos personales\..*el SOAT y los impuestos de los trámites de FLIT 2 quedarán en espera/ },
  { nombre: 'rechazado', status: 200, body: prueba('rechazado'), tono: 'error',
    copy: 'FLIT 2 rechazó el usuario o la contraseña. Revísalos y guarda el acceso de nuevo.' },
  { nombre: 'cambio_clave', status: 200, body: prueba('cambio_clave'), tono: 'error',
    copy: 'FLIT 2 exige cambiar la contraseña de este usuario. Pide la nueva a quien administra FLIT 2 y guárdala aquí.' },
  { nombre: 'bloqueado', status: 200, body: prueba('bloqueado', HASTA), tono: 'advertencia',
    copy: /FLIT 2 bloqueó el acceso 15 minutos por intentos fallidos\. Prueba de nuevo después de las 10:57 a\.\s?m\.$/ },
  { nombre: 'espera', status: 200, body: prueba('espera', HASTA), tono: 'advertencia',
    copy: /FLIT 2 pidió esperar antes de otro intento\. Prueba de nuevo después de las 10:57 a\.\s?m\.$/ },
  { nombre: 'no_responde', status: 200, body: prueba('no_responde'), tono: 'error',
    copy: 'FLIT 2 no responde. Puede ser una caída momentánea: prueba de nuevo en unos minutos.' },
  { nombre: 'no_configurado', status: 200, body: prueba('no_configurado'), tono: 'error',
    copy: 'FLIT 2 no está configurado en este ambiente. Avísale a quien administra el servidor.' },
  { nombre: 'sin_acceso', status: 200, body: prueba('sin_acceso'), tono: 'error',
    copy: 'FLITO ya no tiene acceso guardado. Guárdalo antes de probar.' },
  { nombre: 'HTTP 429 del limitador propio', status: 429, body: { error: CRUDO }, tono: 'advertencia',
    copy: 'Ya probaste la conexión varias veces en el último minuto. Espera un minuto.' },
  { nombre: 'HTTP 503 llave_maestra', status: 503, body: { error: CRUDO, codigo: 'llave_maestra' }, tono: 'error',
    copy: 'El servidor no puede leer el acceso guardado: falta la llave de cifrado. Avísale a quien administra el ambiente.' },
  { nombre: 'HTTP 503 acceso_descifrado (otro fallo)', status: 503, body: { error: CRUDO, codigo: 'acceso_descifrado' }, tono: 'error',
    copy: 'No se pudo probar la conexión. Vuelve a intentarlo.' },
  { nombre: 'resultado fuera de la lista (otro fallo)', status: 200, body: prueba('inventado'), tono: 'error',
    copy: 'No se pudo probar la conexión. Vuelve a intentarlo.' },
];

test.describe('FLITO — Gestión Trámites · Probar conexión con FLIT 2 (HU #13069)', () => {
  test('AC1: con «ver» y sin «guardar» no hay «Probar conexión»; con «guardar» sí', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER, { funciones: SOLO_VER });
    await mockCola(page);
    await page.route(RUTA, (r) => json(r, 200, CON_ACCESO));
    let panel = await abrirPanel(page);
    await expect(panel.getByText('flito-dev', { exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Probar conexión' })).toHaveCount(0);

    await loginAs(page, OPERACIONES_USER);
    panel = await abrirPanel(page);
    await expect(panel.getByRole('button', { name: 'Probar conexión' })).toBeVisible();
  });

  test('AC4: sin acceso configurado no hay botón y la sección pide guardar primero', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    await page.route(RUTA, (r) => json(r, 200, SIN_ACCESO));
    const panel = await abrirPanel(page);
    await expect(panel.getByRole('status').filter({ hasText: 'FLITO aún no tiene acceso a FLIT 2 en este ambiente.' })).toBeVisible();
    await expect(panel.getByText('Escribe el usuario de servicio y la contraseña que entregó FLIT 2.')).toBeVisible();
    await expect(panel.getByRole('button', { name: /Probar conexión|Probando/ })).toHaveCount(0);
  });

  test('AC3: mientras prueba, «Probando…» ocupado, un solo POST aunque haya doble clic y el panel no se cierra', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    await page.route(RUTA, (r) => json(r, 200, CON_ACCESO));
    let posts = 0;
    let soltar: () => void = () => {};
    const liberado = new Promise<void>((res) => { soltar = res; });
    await page.route(RUTA_PROBAR, async (r) => {
      posts += 1;
      await liberado;
      return json(r, 200, prueba('conectado'));
    });
    const panel = await abrirPanel(page);
    await panel.getByRole('button', { name: 'Probar conexión' }).dblclick();
    const ocupado = panel.getByRole('button', { name: 'Probando…' });
    await expect(ocupado).toBeDisabled();
    await expect(ocupado).toHaveAttribute('aria-busy', 'true');
    await ocupado.click({ force: true });
    await page.keyboard.press('Escape');
    await expect(panel).toBeVisible();
    soltar();
    await expect(panel.getByRole('status').filter({ hasText: 'Conectado. FLITO puede leer los trámites de FLIT 2.' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Probar conexión' })).toBeEnabled();
    expect(posts).toBe(1);
  });

  for (const caso of CASOS) {
    test(`AC2: ${caso.nombre} → aviso ${caso.tono} con copy propio, sin mensaje ni scope de la API`, async ({ page }) => {
      await loginAs(page, OPERACIONES_USER);
      await mockCola(page);
      await page.route(RUTA, (r) => json(r, 200, CON_ACCESO));
      await page.route(RUTA_PROBAR, (r) => json(r, caso.status, caso.body));
      const panel = await abrirPanel(page);
      await panel.getByRole('button', { name: 'Probar conexión' }).click();
      const rol = caso.tono === 'error' ? 'alert' : 'status';
      const aviso = panel.locator(`[data-tono="${caso.tono}"]`);
      await expect(aviso).toHaveAttribute('role', rol);
      await expect(aviso).toContainText(caso.copy);
      await expect(panel.getByText(CRUDO)).toHaveCount(0);
      await expect(panel.getByText(SCOPE_CRUDO)).toHaveCount(0);
      // Aviso en la sección, nunca toast.
      await expect(page.getByRole('button', { name: 'Cerrar aviso' })).toHaveCount(0);
    });
  }

  test('AC2: tras probar se refresca la ficha sin esqueleto, y guardar un acceso nuevo borra el aviso', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    let meta: unknown = CON_ACCESO;
    let gets = 0;
    let soltarGet: () => void = () => {};
    let retenerGet = false;
    await page.route(RUTA, async (r) => {
      if (r.request().method() === 'PUT') return json(r, 200, { ...CON_ACCESO, clientId: 'flito-nuevo', estado: null });
      gets += 1;
      if (retenerGet) await new Promise<void>((res) => { soltarGet = res; });
      return json(r, 200, meta);
    });
    await page.route(RUTA_PROBAR, (r) => json(r, 200, prueba('rechazado')));
    const panel = await abrirPanel(page);
    await expect(panel.getByText('Vigente', { exact: true })).toBeVisible();
    const antes = gets;
    meta = { ...CON_ACCESO, estado: 'rechazado' };
    retenerGet = true;
    await panel.getByRole('button', { name: 'Probar conexión' }).click();
    await expect.poll(() => gets).toBe(antes + 1);
    // Con el GET en vuelo, la ficha sigue a la vista: no vuelve el esqueleto.
    await expect(panel.getByLabel('Cargando el acceso a FLIT 2')).toHaveCount(0);
    await expect(panel.getByText('flito-dev', { exact: true })).toBeVisible();
    retenerGet = false;
    soltarGet();
    await expect(panel.getByText('Rechazado por FLIT 2', { exact: true })).toBeVisible();
    await expect(panel.getByRole('alert')).toContainText('FLIT 2 rechazó el usuario o la contraseña.');

    await panel.getByLabel('Usuario de servicio').fill('flito-nuevo');
    await panel.getByLabel('Contraseña').fill(CLAVE);
    await panel.getByRole('button', { name: 'Guardar acceso' }).click();
    await expect(panel.getByText('flito-nuevo', { exact: true })).toBeVisible();
    await expect(panel.locator('[data-tono]')).toHaveCount(0);
  });
});
