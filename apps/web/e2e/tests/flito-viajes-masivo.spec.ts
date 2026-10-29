import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, AUDITOR_USER } from '../helpers/auth';
import { correrAxe, esperarSinViolacionesGraves } from '../helpers/axe';

// FLITO — Logística · pestaña «Viajes adicionales»: registro masivo con valor por LT (HU #14128,
// Feature #14095, Épica 13758). Diseño: `docs/ux/viajes-adicionales-masivo-14128-slim.md`.
// El backend está mockeado: se verifica el cableado de la UI, el body (placa solo en el body) y el copy
// por código de rechazo (nunca el texto crudo del servidor).

type Page = import('@playwright/test').Page;
type Json = Record<string, unknown>;

const viaje = (n: number, valor: number) => ({
  id: `vj-${n}`, numero: n, modo: 'manual', valor, tarifaVigente: null, motivo: 'devolucion', motivoDetalle: null,
  registradoPorId: 7, registradoPorNombre: 'Operaciones E2E', registradoEn: '2026-10-28T10:00:00Z',
});

async function mockBase(page: Page) {
  const ok = (body: unknown) => (route: import('@playwright/test').Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route(/\/api\/flito\/logistica\/facetas/, ok({ estados: [], empresas: [], organismos: [], companiasCerrables: [], mensajeros: [] }));
  await page.route(/\/api\/flito\/logistica\/actas$/, ok([]));
  await page.route(/\/api\/flito\/logistica\?/, ok({ items: [], total: 0, page: 1, pageSize: 50 }));
}

type Responder = (body: { items: { placa: string; valor: number }[] }, intento: number) => { status: number; body: unknown };

async function mockMasivo(page: Page, responder: Responder) {
  const llamadas: { body: Json; llave: string | undefined; url: string }[] = [];
  await page.route(/\/api\/flito\/logistica\/viajes\/masivo$/, async (route) => {
    const req = route.request();
    const body = req.postDataJSON() as { items: { placa: string; valor: number }[] };
    llamadas.push({ body: body as unknown as Json, llave: req.headers()['idempotency-key'], url: req.url() });
    const r = responder(body, llamadas.length);
    return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body) });
  });
  return llamadas;
}

async function abrir(page: Page) {
  await loginAs(page, OPERACIONES_USER);
  await mockBase(page);
  await page.goto('/flito/logistica');
  await page.getByRole('button', { name: 'Viajes adicionales' }).click();
}

const pegar = async (page: Page, texto: string) => {
  await page.getByLabel('Placas', { exact: true }).fill(texto);
  await page.getByRole('button', { name: 'Agregar a la lista' }).click();
};
const elegirMotivo = (page: Page) => page.getByLabel('Motivo del viaje (obligatorio)').selectOption('devolucion');

test.describe('FLITO — Logística · registro masivo de viajes adicionales', () => {
  test('sin la función registrar la pestaña no se pinta', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mockBase(page);
    await page.goto('/flito/logistica');
    await expect(page.getByRole('button', { name: 'Trámites' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Viajes adicionales' })).toHaveCount(0);
  });

  test('estado vacío: contador 0/200, siguiente paso y sin primaria', async ({ page }) => {
    await abrir(page);
    await expect(page.getByText('0 / 200')).toBeVisible();
    await expect(page.getByText('Aún no hay placas en la lista.')).toBeVisible();
    await expect(page.getByRole('button', { name: /Registrar \d+ viaje/ })).toHaveCount(0);
  });

  test('AC1-AC2: pega placas (una y dos columnas), valor común a las seleccionadas, fila editable, repetidas omitidas', async ({ page }) => {
    await abrir(page);
    await pegar(page, 'abc123\t$ 280.000\ndef456\nGHI789\nabc123');
    await expect(page.getByRole('status').filter({ hasText: 'Se omitió 1 placa repetida.' })).toBeVisible();
    await expect(page.getByText('3 / 200')).toBeVisible();
    await expect(page.getByLabel('Valor (COP) de ABC123')).toHaveValue('280000');
    await expect(page.getByLabel('Valor (COP) de DEF456')).toHaveValue('');

    await page.getByRole('checkbox', { name: /GHI789/ }).uncheck();
    await expect(page.getByText('2 de 3 seleccionadas')).toBeVisible();
    await page.getByLabel('Valor para todas (COP)').fill('350.000');
    await page.getByRole('button', { name: 'Aplicar a las seleccionadas' }).click();
    await expect(page.getByText('Valor aplicado a 2 placas.')).toBeVisible();
    await expect(page.getByLabel('Valor (COP) de ABC123')).toHaveValue('350000');
    await expect(page.getByLabel('Valor (COP) de DEF456')).toHaveValue('350000');
    await expect(page.getByLabel('Valor (COP) de GHI789')).toHaveValue('');
    // Cada fila sigue editable.
    await page.getByLabel('Valor (COP) de DEF456').fill('0');
    await expect(page.getByLabel('Valor (COP) de DEF456')).toHaveValue('0');
  });

  test('la primaria exige valor y motivo; deshabilitada dice por qué; Enter pasa al valor siguiente', async ({ page }) => {
    await abrir(page);
    await pegar(page, 'AAA111\nBBB222');
    const primaria = page.getByRole('button', { name: /^Registrar/ });
    await expect(primaria).toBeDisabled();
    await expect(page.getByText('Falta el valor en 2 placas seleccionadas.')).toBeVisible();
    await expect(page.getByText('Escribe el valor.').first()).toBeVisible();
    await page.getByLabel('Valor (COP) de AAA111').fill('1000');
    await page.getByLabel('Valor (COP) de AAA111').press('Enter');
    await expect(page.getByLabel('Valor (COP) de BBB222')).toBeFocused();
    await page.getByLabel('Valor (COP) de BBB222').fill('0');
    await expect(page.getByText('Elige el motivo del viaje.')).toBeVisible();
    await elegirMotivo(page);
    await expect(page.getByRole('button', { name: 'Registrar 2 viajes' })).toBeEnabled();
  });

  test('AC3: resumen mixto con el copy por código, nunca el texto crudo; placa solo en el body', async ({ page }) => {
    await abrir(page);
    const llamadas = await mockMasivo(page, () => ({
      status: 201,
      body: {
        creados: [{ placa: 'AAA111', tramiteId: 't1', idFlit: 'FLIT-1', viaje: viaje(2, 350000) }],
        rechazados: [
          { placa: 'BBB222', motivo: 'CRUDO-NO-ENC', codigo: 'NO_ENCONTRADO' },
          { placa: 'CCC333', motivo: 'CRUDO-VARIOS', codigo: 'VARIOS_TRAMITES_APROBADOS', candidatos: [{ tramiteId: 'a', idFlit: 'FLIT-10234' }, { tramiteId: 'b', idFlit: 'FLIT-10311' }] },
          { placa: 'DDD444', motivo: 'CRUDO-LIQ', codigo: 'TRAMITE_LIQUIDADO' },
          { placa: 'EEE555', motivo: 'CRUDO-AUTO', codigo: 'LOGISTICA_AUTOGESTIONADA' },
          { placa: 'FFF666', motivo: 'CRUDO-INV', codigo: 'PLACA_INVALIDA' },
          { placa: 'GGG777', motivo: 'CRUDO-VAL', codigo: 'VALOR_INVALIDO' },
          { placa: 'HHH888', motivo: 'CRUDO-REP', codigo: 'PLACA_REPETIDA' },
          { placa: 'III999', motivo: 'CRUDO-RARO', codigo: 'XYZ' },
        ],
      },
    }));
    await pegar(page, 'AAA111 350000\nBBB222 1\nCCC333 2');
    await elegirMotivo(page);
    await page.getByRole('button', { name: 'Registrar 3 viajes' }).click();

    await expect(page.getByRole('heading', { name: 'Resultado del registro' })).toBeFocused();
    await expect(page.getByText('Se registraron 1')).toBeVisible();
    await expect(page.getByText('No se registraron 8', { exact: true })).toBeVisible();
    const tabla = page.getByRole('region', { name: 'Placas no registradas' });
    await expect(tabla).toContainText('No encontramos un trámite aprobado para esta placa.');
    await expect(tabla).toContainText('varios trámites aprobados (FLIT-10234, FLIT-10311)');
    await expect(tabla).toContainText('ya está liquidado');
    await expect(tabla).toContainText('la gestiona el cliente');
    await expect(tabla).toContainText('formato válido');
    await expect(tabla).toContainText('El valor no es válido');
    await expect(tabla).toContainText('más de una vez');
    await expect(tabla).toContainText('No se pudo registrar este viaje.');
    await expect(page.locator('body')).not.toContainText('CRUDO-');
    // Registradas plegadas.
    await expect(page.getByRole('region', { name: 'Viajes registrados' })).toHaveCount(0);
    await page.getByRole('button', { name: /Registrados/ }).click();
    await expect(page.getByRole('region', { name: 'Viajes registrados' })).toContainText('FLIT-1');

    expect(llamadas).toHaveLength(1);
    expect(llamadas[0].body).toMatchObject({ items: [{ placa: 'AAA111', valor: 350000 }, { placa: 'BBB222', valor: 1 }, { placa: 'CCC333', valor: 2 }], motivo: 'devolucion' });
    expect(llamadas[0].llave).toBeTruthy();
    expect(llamadas[0].url).not.toContain('AAA111');
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain('AAA111');
  });

  test('«Corregir y reintentar» recarga solo las corregibles, con su motivo en línea y llave nueva', async ({ page }) => {
    await abrir(page);
    const llamadas = await mockMasivo(page, (_b, n) => (n === 1
      ? {
        status: 201,
        body: {
          creados: [{ placa: 'AAA111', tramiteId: 't1', idFlit: 'FLIT-1', viaje: viaje(2, 100) }],
          rechazados: [
            { placa: 'BBB222', motivo: 'x', codigo: 'NO_ENCONTRADO' },
            { placa: 'DDD444', motivo: 'x', codigo: 'TRAMITE_LIQUIDADO' },
          ],
        },
      }
      : { status: 201, body: { creados: [{ placa: 'BBB222', tramiteId: 't2', idFlit: 'FLIT-2', viaje: viaje(2, 100) }], rechazados: [] } }));
    await pegar(page, 'AAA111 100\nBBB222 100\nDDD444 100');
    await elegirMotivo(page);
    await page.getByRole('button', { name: 'Registrar 3 viajes' }).click();
    await page.getByRole('button', { name: 'Corregir y reintentar 1' }).click();
    await expect(page.getByLabel('Valor (COP) de BBB222')).toHaveValue('100');
    await expect(page.getByText('No encontramos un trámite aprobado')).toBeVisible();
    await expect(page.getByLabel('Valor (COP) de AAA111')).toHaveCount(0);
    await expect(page.getByLabel('Valor (COP) de DDD444')).toHaveCount(0);
    await page.getByRole('button', { name: 'Registrar 1 viaje' }).click();
    await expect(page.getByText('Se registraron 1 viaje.')).toBeVisible();
    expect(llamadas[1].llave).not.toBe(llamadas[0].llave);
  });

  test('todo registrado: una frase y solo «Nueva carga»', async ({ page }) => {
    await abrir(page);
    await mockMasivo(page, (b) => ({
      status: 201,
      body: { creados: b.items.map((i, k) => ({ placa: i.placa, tramiteId: `t${k}`, idFlit: `FLIT-${k}`, viaje: viaje(2, i.valor) })), rechazados: [] },
    }));
    await pegar(page, 'AAA111 5\nBBB222 6');
    await elegirMotivo(page);
    await page.getByRole('button', { name: 'Registrar 2 viajes' }).click();
    await expect(page.getByText('Se registraron 2 viajes.')).toBeVisible();
    await expect(page.getByRole('button', { name: /Corregir/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Nueva carga' }).click();
    await expect(page.getByText('Aún no hay placas en la lista.')).toBeVisible();
  });

  test('todo rechazado: «No se registró ningún viaje.»', async ({ page }) => {
    await abrir(page);
    await mockMasivo(page, (b) => ({ status: 200, body: { creados: [], rechazados: b.items.map((i) => ({ placa: i.placa, motivo: 'x', codigo: 'TRAMITE_LIQUIDADO' })) } }));
    await pegar(page, 'AAA111 5');
    await elegirMotivo(page);
    await page.getByRole('button', { name: 'Registrar 1 viaje' }).click();
    await expect(page.getByText('No se registró ningún viaje.')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Placas no registradas' })).toContainText('ya está liquidado');
  });

  test('error de la solicitud: lista intacta, copy propio y «Reintentar» reutiliza la Idempotency-Key', async ({ page }) => {
    await abrir(page);
    const llamadas = await mockMasivo(page, (b, n) => (n === 1
      ? { status: 500, body: { error: 'SQLSTATE 23505 volcado interno' } }
      : { status: 201, body: { creados: b.items.map((i) => ({ placa: i.placa, tramiteId: 't', idFlit: 'FLIT-9', viaje: viaje(2, i.valor) })), rechazados: [] } }));
    await pegar(page, 'AAA111 5');
    await elegirMotivo(page);
    await page.getByRole('button', { name: 'Registrar 1 viaje' }).click();
    const alerta = page.getByRole('alert');
    await expect(alerta).toContainText('No pudimos registrar los viajes. Tus placas siguen en la lista');
    await expect(page.locator('body')).not.toContainText('SQLSTATE');
    await expect(page.getByLabel('Valor (COP) de AAA111')).toHaveValue('5');
    await alerta.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByText('Se registraron 1 viaje.')).toBeVisible();
    expect(llamadas).toHaveLength(2);
    expect(llamadas[1].llave).toBe(llamadas[0].llave);
  });

  test('403: aviso de permiso sin «Reintentar»', async ({ page }) => {
    await abrir(page);
    await mockMasivo(page, () => ({ status: 403, body: { error: 'Forbidden' } }));
    await pegar(page, 'AAA111 5');
    await elegirMotivo(page);
    await page.getByRole('button', { name: 'Registrar 1 viaje' }).click();
    await expect(page.getByRole('alert')).toContainText('No tienes permiso para registrar viajes.');
    await expect(page.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
  });

  test('tope 200: entran 200, las 50 que sobran se quedan en el cuadro con aviso exacto', async ({ page }) => {
    await abrir(page);
    const placas = Array.from({ length: 250 }, (_, i) => `P${String(i).padStart(5, '0')}`);
    await pegar(page, placas.join('\n'));
    await expect(page.getByText('200 / 200')).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Se agregaron 200 placas. Quedan 50 por fuera: regístralas en otra tanda cuando termines esta.' })).toBeVisible();
    await expect(page.getByLabel('Placas', { exact: true })).toHaveValue(placas.slice(200).join('\n'));
    await expect(page.getByRole('button', { name: 'Agregar a la lista' })).toBeDisabled();
    // Al quitar una, vuelve a haber lugar.
    await page.getByRole('button', { name: 'Quitar P00000' }).click();
    await expect(page.getByRole('button', { name: 'Agregar a la lista' })).toBeEnabled();
  });

  test('a11y: axe sin violaciones graves en la lista y en el resumen (QA_AXE_CDN=1)', async ({ page }) => {
    await abrir(page);
    await mockMasivo(page, (b) => ({ status: 200, body: { creados: [], rechazados: b.items.map((i) => ({ placa: i.placa, motivo: 'x', codigo: 'NO_ENCONTRADO' })) } }));
    await pegar(page, 'AAA111 5\nBBB222');
    await elegirMotivo(page);
    esperarSinViolacionesGraves(await correrAxe(page));
    await page.getByLabel('Valor (COP) de BBB222').fill('7');
    await page.getByRole('button', { name: 'Registrar 2 viajes' }).click();
    await expect(page.getByRole('heading', { name: 'Resultado del registro' })).toBeVisible();
    esperarSinViolacionesGraves(await correrAxe(page));
  });
});
