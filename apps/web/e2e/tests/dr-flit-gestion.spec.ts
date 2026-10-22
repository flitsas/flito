// HU #13836 (G1, Feature #13834) — Dr. Flit: consultas de gestión de Trámites sin IA.
// UX: docs/ux/flito-dr-flit-f6.md · diseño: docs/diseno/feature-13834-dr-flit-consultas-gestion.md
// El API se mockea (`page.route`) como en los specs dr-flit vecinos. Un test por comportamiento.
import { test, expect, type Page, type Request } from '@playwright/test';
import { loginAs, FINANCIERA_USER } from '../helpers/ayuda-fixtures';

const BUSCAR = '**/api/flito/tramites/buscar';
const COPY_429 = 'Hizo muchas consultas seguidas; intente en un momento.';

// Financiera con Gestión Trámites (página) y la función de la cola.
const CON_TRAMITES = {
  ...FINANCIERA_USER, allowedPages: ['flito_tramites'], funciones: ['tramites.cola.ver'],
};

const panel = (page: Page) => page.getByRole('complementary', { name: 'Dr. Flit' });
const conversacion = (page: Page) => panel(page).getByRole('log', { name: 'Conversación con Dr. Flit' });
const caja = (page: Page) => panel(page).getByLabel('Escriba su pregunta');

async function abrirPanel(page: Page) {
  await page.getByRole('button', { name: 'Abrir Dr. Flit' }).click();
  await expect(panel(page)).toBeVisible();
}

async function entrar(page: Page, user: Parameters<typeof loginAs>[1] = CON_TRAMITES) {
  await loginAs(page, user);
  await page.goto('/');
  await abrirPanel(page);
}

async function enviar(page: Page, texto: string) {
  await caja(page).fill(texto);
  await caja(page).press('Enter');
}

function tarjetas(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-4000-8000-00000000000${i}`,
    placa: 'ABC123',
    idFlit: `FLIT-01324${50 + i}`,
    estado: i === 0 ? 'Asignado' : 'En trámite',
    asignado: i === 0,
    tipoTramite: 'Traspaso',
    empresa: 'Autos del Sur',
    creado: '2026-10-14T15:00:00.000Z',
  }));
}

/** Mock del `POST …/buscar` que registra las peticiones. */
async function mockBuscar(page: Page, respuestas: { status: number; body?: unknown }[]) {
  const pedidas: Request[] = [];
  let i = 0;
  await page.route(BUSCAR, async (route) => {
    pedidas.push(route.request());
    const r = respuestas[Math.min(i, respuestas.length - 1)];
    i += 1;
    await route.fulfill({
      status: r.status, contentType: 'application/json',
      body: JSON.stringify(r.body ?? { error: 'Detalle interno que no debe verse' }),
    });
  });
  return pedidas;
}

const ok = (total: number, n = Math.min(total, 5)) => ({ status: 200, body: { total, items: tarjetas(n) } });

test.describe('HU #13836 · Dr. Flit — consultas de gestión (Trámites)', () => {
  test('AC1 · placa, VIN e id FLIT ofrecen la consulta; nada sale sin confirmar', async ({ page }) => {
    const pedidas = await mockBuscar(page, [ok(1)]);
    await entrar(page);
    const casos = [
      ['¿en qué va abc123?', 'Encontré la placa ABC123. ¿Quiere ver en qué va?', 'ABC123'],
      ['moto XYZ12D', 'Encontré la placa XYZ12D. ¿Quiere ver en qué va?', 'XYZ12D'],
      ['9BWZZZ377VT004251', 'Encontré el VIN 9BWZZZ377VT004251. ¿Quiere ver en qué va?', '9BWZZZ377VT004251'],
      ['estado de flit-0132456', 'Encontré el id FLIT FLIT-0132456. ¿Quiere ver en qué va?', 'FLIT-0132456'],
    ] as const;
    for (const [texto, oferta, valor] of casos) {
      await enviar(page, texto);
      await expect(conversacion(page).getByText(oferta)).toBeVisible();
      await expect(conversacion(page).getByRole('button', { name: `Consultar ${valor} en sus módulos` })).toBeVisible();
      await expect(conversacion(page).getByRole('button', { name: 'Buscar en los manuales' })).toHaveCount(1);
    }
    // Una sola oferta viva: las anteriores quedan como «No consulté …» sin botones.
    await expect(conversacion(page).getByText('No consulté ABC123.')).toBeVisible();
    await expect(conversacion(page).getByRole('button', { name: /^Consultar / })).toHaveCount(1);
    expect(pedidas).toHaveLength(0);
  });

  test('AC2 · un número suelto o texto sin patrón no ofrece nada', async ({ page }) => {
    const pedidas = await mockBuscar(page, [ok(1)]);
    await entrar(page);
    for (const texto of ['1032456789', 'hola']) {
      await enviar(page, texto);
      await expect(conversacion(page).getByText(new RegExp(`^Usted: ${texto}$`))).toBeVisible();
      // Va a la Ayuda (F3): mientras busca en los manuales la caja no envía.
      await expect(conversacion(page).getByText('Dr. Flit está buscando…')).toHaveCount(0);
    }
    await expect(conversacion(page).getByText(/¿Quiere ver en qué va\?/)).toHaveCount(0);
    await expect(conversacion(page).getByRole('button', { name: /^Consultar / })).toHaveCount(0);
    expect(pedidas).toHaveLength(0);
  });

  test('AC6 · confirmar → 5 tarjetas, total, «Ver más» a la cola sin query; valor en el body, no en la URL', async ({ page }) => {
    const pedidas = await mockBuscar(page, [ok(12)]);
    await entrar(page);
    await enviar(page, '¿en qué va ABC123?');
    await conversacion(page).getByRole('button', { name: 'Consultar ABC123 en sus módulos' }).click();

    const bloque = conversacion(page).getByRole('region', { name: 'Resultados para ABC123' });
    await expect(bloque.getByRole('heading', { name: 'Resultados para ABC123', level: 3 })).toBeFocused();
    await expect(bloque.getByText('Encontré 12 coincidencias en 1 módulo.')).toBeVisible();
    const grupo = bloque.getByRole('region', { name: 'Trámites' });
    await expect(grupo.getByText('12 en total')).toBeVisible();
    await expect(grupo.getByRole('list', { name: 'Trámites encontrados' }).getByRole('listitem')).toHaveCount(5);
    await expect(grupo.getByText('Mostrando 5 de 12.')).toBeVisible();
    await expect(grupo.getByText('Asignado')).toBeVisible();
    const verMas = grupo.getByRole('link', { name: 'Ver más en la pantalla' });
    await expect(verMas).toHaveAttribute('href', '/flito/tramites');
    // Tarjetas no clicables: ningún enlace dentro de la lista.
    await expect(grupo.getByRole('list').getByRole('link')).toHaveCount(0);
    // La oferta pierde sus botones.
    await expect(conversacion(page).getByRole('button', { name: /^Consultar / })).toHaveCount(0);

    expect(pedidas).toHaveLength(1);
    expect(pedidas[0].method()).toBe('POST');
    expect(pedidas[0].postDataJSON()).toEqual({ valor: 'ABC123' });
    expect(pedidas[0].url()).not.toContain('ABC123');
    expect(new URL(pedidas[0].url()).search).toBe('');
  });

  test('AC6 · total ≤ 5 → «Abrir la pantalla de Trámites» sin query', async ({ page }) => {
    await mockBuscar(page, [ok(3)]);
    await entrar(page);
    await enviar(page, 'FT2-0000180');
    await conversacion(page).getByRole('button', { name: 'Consultar FT2-0000180 en sus módulos' }).click();
    const grupo = conversacion(page).getByRole('region', { name: 'Trámites' });
    await expect(grupo.getByRole('listitem')).toHaveCount(3);
    await expect(grupo.getByText(/Mostrando/)).toHaveCount(0);
    await expect(grupo.getByRole('link', { name: 'Abrir la pantalla de Trámites' })).toHaveAttribute('href', '/flito/tramites');
  });

  test('AC7 · 0 resultados → «No encontré resultados en sus módulos» y sin grupo', async ({ page }) => {
    await mockBuscar(page, [{ status: 200, body: { total: 0, items: [] } }]);
    await entrar(page);
    await enviar(page, 'ABC123');
    await conversacion(page).getByRole('button', { name: 'Consultar ABC123 en sus módulos' }).click();
    await expect(conversacion(page).getByText('No encontré resultados en sus módulos.')).toBeVisible();
    await expect(conversacion(page).getByRole('region', { name: 'Trámites' })).toHaveCount(0);
  });

  for (const [caso, usuario] of [
    ['sin la función tramites.cola.ver', { ...FINANCIERA_USER, allowedPages: ['flito_tramites'], funciones: [] }],
    ['sin la página flito_tramites', { ...FINANCIERA_USER, allowedPages: [], funciones: ['tramites.cola.ver'] }],
  ] as const) {
    test(`AC7 · ${caso} → no se ofrece la consulta ni sale petición`, async ({ page }) => {
      const pedidas = await mockBuscar(page, [ok(1)]);
      await entrar(page, usuario);
      await enviar(page, 'ABC123');
      await expect(conversacion(page).getByText('Usted: ABC123')).toBeVisible();
      await expect(conversacion(page).getByText(/¿Quiere ver en qué va\?/)).toHaveCount(0);
      await expect(conversacion(page).getByRole('button', { name: /^Consultar / })).toHaveCount(0);
      expect(pedidas).toHaveLength(0);
    });
  }

  test('AC9 · error → aviso sin el mensaje del API + «Reintentar» que vuelve a consultar', async ({ page }) => {
    const pedidas = await mockBuscar(page, [{ status: 500 }, ok(2)]);
    await entrar(page);
    await enviar(page, 'ABC123');
    await conversacion(page).getByRole('button', { name: 'Consultar ABC123 en sus módulos' }).click();
    const bloque = conversacion(page).getByRole('region', { name: 'Resultados para ABC123' });
    await expect(bloque.getByRole('alert')).toHaveText('No pude consultar sus módulos. Revise su conexión e intente de nuevo.');
    await expect(bloque.getByText('Detalle interno que no debe verse')).toHaveCount(0);
    await bloque.getByRole('button', { name: 'Reintentar' }).click();
    await expect(bloque.getByRole('region', { name: 'Trámites' }).getByRole('listitem')).toHaveCount(2);
    await expect(bloque.getByRole('alert')).toHaveCount(0);
    expect(pedidas).toHaveLength(2);
  });

  test('AC9 · 429 → «Hizo muchas consultas seguidas; intente en un momento.»', async ({ page }) => {
    await mockBuscar(page, [{ status: 429 }]);
    await entrar(page);
    await enviar(page, 'ABC123');
    await conversacion(page).getByRole('button', { name: 'Consultar ABC123 en sus módulos' }).click();
    await expect(conversacion(page).getByRole('alert')).toHaveText(COPY_429);
    await expect(conversacion(page).getByRole('button', { name: 'Reintentar' })).toBeVisible();
  });

  test('«Buscar en los manuales» corre la Ayuda y no consulta los módulos', async ({ page }) => {
    const pedidas = await mockBuscar(page, [ok(1)]);
    await entrar(page);
    await enviar(page, '¿cómo hago traspaso de ABC123?');
    await conversacion(page).getByRole('button', { name: 'Buscar en los manuales' }).click();
    await expect(conversacion(page).getByRole('button', { name: /^Consultar / })).toHaveCount(0);
    await expect(conversacion(page).getByText(/en sus manuales/).last()).toBeVisible();
    expect(pedidas).toHaveLength(0);
  });

  test('AC8 · tras recargar: marcador sin valor, «Volver a consultar» lleva el foco a la caja; el almacén no tiene la placa', async ({ page }) => {
    await mockBuscar(page, [ok(12)]);
    await entrar(page);
    await enviar(page, 'XYZ987');
    await enviar(page, '¿en qué va ABC123?');
    await conversacion(page).getByRole('button', { name: 'Consultar ABC123 en sus módulos' }).click();
    await expect(conversacion(page).getByRole('region', { name: 'Trámites' }).getByRole('listitem')).toHaveCount(5);

    const almacen = async () => page.evaluate(() => JSON.stringify(Object.entries(sessionStorage)));
    const guardado = await almacen();
    for (const prohibido of ['ABC123', 'XYZ987', 'FLIT-0132450', 'Autos del Sur', 'Traspaso', 'En trámite']) {
      expect(guardado).not.toContain(prohibido);
    }

    await page.reload();
    await abrirPanel(page);
    await expect(conversacion(page).getByText(
      'Aquí hubo una consulta de gestión. Por seguridad, sus resultados no se guardan en el navegador.',
    )).toBeVisible();
    await expect(conversacion(page).getByText(
      'Aquí hubo un mensaje con una placa, un VIN o un id FLIT; no se guarda en el navegador.',
    )).toBeVisible();
    await expect(panel(page).getByText('ABC123')).toHaveCount(0);
    await expect(panel(page).getByText('XYZ987')).toHaveCount(0);
    await expect(conversacion(page).getByRole('listitem')).toHaveCount(0);

    await conversacion(page).getByRole('button', { name: 'Volver a consultar' }).click();
    await expect(caja(page)).toBeFocused();
    await expect(panel(page).getByText('Escriba la placa, el VIN o el id FLIT que quiere consultar.')).toBeVisible();
    expect(await almacen()).not.toContain('ABC123');
  });
  test('Ley 1581 · «Cerrar sesión» borra la memoria de gestión y una respuesta tardía no la repuebla', async ({ page }) => {
    // La memoria vive en el módulo (no en el almacén): se lee la MISMA instancia que usa la app vía Vite.
    const memoria = () => page.evaluate(async () => {
      const ruta = '/src/lib/drFlitGestionConsulta.ts';
      const m = await import(/* @vite-ignore */ ruta);
      return { grupos: m.resultadosGestion().size as number, texto: JSON.stringify([...m.resultadosGestion()]) };
    });
    const salir = async () => {
      await page.getByRole('button', { name: /Menú de usuario/ }).click();
      await page.getByRole('menuitem', { name: 'Cerrar sesión' }).click();
      await expect(page).toHaveURL(/\/login$/);
    };

    // 1. Respuesta ya pintada → cerrar sesión → la memoria queda vacía (sin el valor ni las tarjetas).
    await mockBuscar(page, [ok(12)]);
    await entrar(page);
    await enviar(page, '¿en qué va ABC123?');
    await conversacion(page).getByRole('button', { name: 'Consultar ABC123 en sus módulos' }).click();
    await expect(conversacion(page).getByRole('region', { name: 'Trámites' }).getByRole('listitem')).toHaveCount(5);
    expect((await memoria()).grupos).toBe(1);
    await salir();
    expect(await memoria()).toEqual({ grupos: 0, texto: '[]' });

    // 2. Respuesta en vuelo al cerrar sesión: llega después y no revive la memoria.
    await page.unroute(BUSCAR);
    let soltar: () => void = () => {};
    const liberada = new Promise<void>((r) => { soltar = r; });
    let atendida = false;
    await page.route(BUSCAR, async (route) => {
      await liberada;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ok(12).body) })
        .catch(() => { /* la petición pudo abortarse con la sesión: igual cuenta como tardía */ });
      atendida = true;
    });
    await entrar(page);
    await enviar(page, '¿en qué va XYZ987?');
    await conversacion(page).getByRole('button', { name: 'Consultar XYZ987 en sus módulos' }).click();
    await expect.poll(async () => (await memoria()).texto).toContain('cargando');
    await salir();
    soltar();
    await expect.poll(() => atendida).toBe(true);
    await page.waitForTimeout(300);
    const despues = await memoria();
    expect(despues).toEqual({ grupos: 0, texto: '[]' });
    expect(despues.texto).not.toContain('FLIT-0132450');
  });
});

// ── HU #13837 (G2) · SOAT ────────────────────────────────────────────────────────────────────────
const BUSCAR_SOAT = '**/api/flito/soat/buscar';
const CON_TRAMITES_Y_SOAT = {
  ...FINANCIERA_USER,
  allowedPages: ['flito_tramites', 'flito_soat'],
  funciones: ['tramites.cola.ver', 'soat.cola.ver'],
};
const VIN_G2 = '9BWZZZ377VT004251';

function tarjetasSoat(n: number, conPlaca = true) {
  return Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-4000-9000-00000000000${i}`,
    placa: conPlaca ? 'ABC123' : null,
    ...(conPlaca ? {} : { vin: VIN_G2 }),
    estado: i === 0 ? 'pagado' : 'solicitado',
    compania: 'Seguros Andinos',
    solicitado: '2026-10-10T15:00:00.000Z',
    pagado: i === 0 ? '2026-10-12T15:00:00.000Z' : null,
  }));
}

async function mockSoat(page: Page, respuestas: { status: number; body?: unknown }[]) {
  const pedidas: Request[] = [];
  let i = 0;
  await page.route(BUSCAR_SOAT, async (route) => {
    pedidas.push(route.request());
    const r = respuestas[Math.min(i, respuestas.length - 1)];
    i += 1;
    await route.fulfill({
      status: r.status, contentType: 'application/json',
      body: JSON.stringify(r.body ?? { error: 'Detalle interno que no debe verse' }),
    });
  });
  return pedidas;
}

const okSoat = (total: number, conPlaca = true) =>
  ({ status: 200, body: { total, items: tarjetasSoat(Math.min(total, 5), conPlaca) } });

async function consultar(page: Page, valor: string) {
  await enviar(page, valor);
  await conversacion(page).getByRole('button', { name: `Consultar ${valor} en sus módulos` }).click();
  return conversacion(page).getByRole('region', { name: `Resultados para ${valor}` });
}

test.describe('HU #13837 · Dr. Flit — consultas de gestión (SOAT)', () => {
  test('AC5 · Trámites y SOAT en ese orden; SOAT con ≤5 tarjetas, total y enlace a la cola sin query', async ({ page }) => {
    const pt = await mockBuscar(page, [ok(2)]);
    const ps = await mockSoat(page, [okSoat(7)]);
    await entrar(page, CON_TRAMITES_Y_SOAT);
    const bloque = await consultar(page, 'ABC123');
    await expect(bloque.getByText('Encontré 9 coincidencias en 2 módulos.')).toBeVisible();
    const grupos = bloque.getByRole('heading', { level: 4 });
    await expect(grupos).toHaveText(['Trámites', 'SOAT']);
    const soat = bloque.getByRole('region', { name: 'SOAT' });
    await expect(soat.getByText('7 en total')).toBeVisible();
    await expect(soat.getByRole('list', { name: 'SOAT encontrados' }).getByRole('listitem')).toHaveCount(5);
    await expect(soat.getByText('Mostrando 5 de 7.')).toBeVisible();
    await expect(soat.getByRole('link', { name: 'Ver más en la pantalla' })).toHaveAttribute('href', '/flito/soat');
    await expect(soat.getByRole('list').getByRole('link')).toHaveCount(0);
    const primera = soat.getByRole('listitem').first();
    await expect(primera.getByText('Seguros Andinos')).toBeVisible();
    await expect(primera.getByRole('term')).toHaveText(['Compañía', 'Solicitado', 'Pagado']);
    expect(ps).toHaveLength(1);
    expect(ps[0].postDataJSON()).toEqual({ valor: 'ABC123' });
    expect(new URL(ps[0].url()).search).toBe('');
    expect(pt).toHaveLength(1);
  });

  test('F6.6 · sin placa el título es el VIN; sin compañía en el DTO no hay fila Compañía', async ({ page }) => {
    await mockBuscar(page, [{ status: 200, body: { total: 0, items: [] } }]);
    const sinCompania = { status: 200, body: { total: 1, items: [{ ...tarjetasSoat(1, false)[0], compania: undefined }] } };
    await mockSoat(page, [sinCompania]);
    await entrar(page, CON_TRAMITES_Y_SOAT);
    const bloque = await consultar(page, VIN_G2);
    const tarjeta = bloque.getByRole('region', { name: 'SOAT' }).getByRole('listitem');
    await expect(tarjeta).toHaveCount(1);
    await expect(tarjeta.getByText(VIN_G2, { exact: true })).toBeVisible();
    await expect(tarjeta.getByRole('term')).toHaveText(['Solicitado', 'Pagado']);
    await expect(bloque.getByRole('region', { name: 'Trámites' })).toHaveCount(0);
  });

  test('AC5 · SOAT con 0 resultados no aparece; Trámites se muestra lleno', async ({ page }) => {
    await mockBuscar(page, [ok(2)]);
    await mockSoat(page, [{ status: 200, body: { total: 0, items: [] } }]);
    await entrar(page, CON_TRAMITES_Y_SOAT);
    const bloque = await consultar(page, 'ABC123');
    await expect(bloque.getByRole('region', { name: 'Trámites' }).getByRole('listitem')).toHaveCount(2);
    await expect(bloque.getByRole('region', { name: 'SOAT' })).toHaveCount(0);
    await expect(bloque.getByText('Encontré 2 coincidencias en 1 módulo.')).toBeVisible();
  });

  test('AC7 · SOAT falla y Trámites responde: error solo en SOAT y «Reintentar» repite solo SOAT', async ({ page }) => {
    const pt = await mockBuscar(page, [ok(2)]);
    const ps = await mockSoat(page, [{ status: 500 }, okSoat(1)]);
    await entrar(page, CON_TRAMITES_Y_SOAT);
    const bloque = await consultar(page, 'ABC123');
    await expect(bloque.getByRole('region', { name: 'Trámites' }).getByRole('listitem')).toHaveCount(2);
    const soat = bloque.getByRole('region', { name: 'SOAT' });
    await expect(soat.getByText('No pude consultar SOAT.')).toBeVisible();
    await expect(bloque.getByRole('alert')).toHaveCount(0);
    await expect(bloque.getByText('Detalle interno que no debe verse')).toHaveCount(0);
    await expect(bloque.getByRole('button', { name: 'Reintentar' })).toHaveCount(1);
    await soat.getByRole('button', { name: 'Reintentar' }).click();
    await expect(soat.getByRole('listitem')).toHaveCount(1);
    await expect(soat.getByText('No pude consultar SOAT.')).toHaveCount(0);
    expect(ps).toHaveLength(2);
    expect(pt).toHaveLength(1);
  });

  test('AC8 · un id FLIT no consulta SOAT ni lo muestra', async ({ page }) => {
    await mockBuscar(page, [ok(1)]);
    const ps = await mockSoat(page, [okSoat(1)]);
    await entrar(page, CON_TRAMITES_Y_SOAT);
    const bloque = await consultar(page, 'FLIT-0132456');
    await expect(bloque.getByRole('region', { name: 'Trámites' }).getByRole('listitem')).toHaveCount(1);
    await expect(bloque.getByRole('region', { name: 'SOAT' })).toHaveCount(0);
    expect(ps).toHaveLength(0);
  });

  for (const [caso, usuario] of [
    ['sin la página flito_soat', { ...CON_TRAMITES_Y_SOAT, allowedPages: ['flito_tramites'] }],
    ['sin la función soat.cola.ver', { ...CON_TRAMITES_Y_SOAT, funciones: ['tramites.cola.ver'] }],
  ] as const) {
    test(`AC6 · ${caso} → SOAT no se llama ni aparece`, async ({ page }) => {
      await mockBuscar(page, [ok(1)]);
      const ps = await mockSoat(page, [okSoat(1)]);
      await entrar(page, usuario);
      const bloque = await consultar(page, 'ABC123');
      await expect(bloque.getByRole('region', { name: 'Trámites' }).getByRole('listitem')).toHaveCount(1);
      await expect(bloque.getByRole('region', { name: 'SOAT' })).toHaveCount(0);
      expect(ps).toHaveLength(0);
    });
  }

  test('AC8 (G1) · tras consultar un VIN con SOAT, el almacén no guarda el VIN ni la placa', async ({ page }) => {
    await mockBuscar(page, [ok(1)]);
    await mockSoat(page, [okSoat(2, false)]);
    await entrar(page, CON_TRAMITES_Y_SOAT);
    const bloque = await consultar(page, VIN_G2);
    await expect(bloque.getByRole('region', { name: 'SOAT' }).getByRole('listitem')).toHaveCount(2);
    await page.reload();
    await abrirPanel(page);
    const guardado = await page.evaluate(() => JSON.stringify(Object.entries(sessionStorage)));
    for (const prohibido of [VIN_G2, 'ABC123', 'Seguros Andinos']) expect(guardado).not.toContain(prohibido);
    await expect(panel(page).getByText(VIN_G2)).toHaveCount(0);
  });
});
