import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, MENSAJERO_USER } from '../helpers/auth';
import { correrAxe, esperarSinViolacionesGraves } from '../helpers/axe';

// HU #14111 (C1.4) — Mi ruta · «Confirmar recogida» con la firma del funcionario. El backend está mockeado; se
// verifica el cableado de la UI. En headless no hay BarcodeDetector, así que las LT entran con «Ingresar a mano»
// (placa + licencia + sustrato LT…), que además es el flujo nuevo. La cédula del funcionario NUNCA va a la URL
// ni a la consola.

const CEDULA = '52123456';
const FUNCIONES = ['logistica.ruta.ver', 'logistica.documento.escanear', 'logistica.recogida.confirmar'] as const;
const SIN_CONFIRMAR = ['logistica.ruta.ver', 'logistica.documento.escanear'] as const;

const cand = (o: Partial<Record<string, unknown>>) => ({
  tramiteId: 't-1', idFlit: 'FLIT-1', companiaNombre: 'Transportes del Norte S.A.S.', organismoCodigo: '11001', gestionable: true,
  vin: 'VIN0000000000001', organismoNombre: 'STT Bogotá', vehiculo: { marca: 'Renault', linea: 'Duster', modelo: 2024 }, ...o,
});
const CANDIDATOS: Record<string, unknown[]> = {
  ABC123: [cand({ tramiteId: 't-a' })],
  DEF456: [cand({ tramiteId: 't-b', idFlit: 'FLIT-2', companiaNombre: 'Rápido del Valle S.A.' })],
  MUL111: [cand({ tramiteId: 't-m1', idFlit: 'FLIT-31' }), cand({ tramiteId: 't-m2', idFlit: 'FLIT-32', companiaNombre: 'Rápido del Valle S.A.' }),
    cand({ tramiteId: 't-m3', idFlit: 'FLIT-33', companiaNombre: 'Autogestión S.A.', gestionable: false })],
};

interface Espias { escanear: Array<Record<string, unknown>>; confirmar: Array<Record<string, unknown>>; claves: Array<string | undefined>; consola: string[] }

async function preparar(page: Page, funciones: readonly string[] = FUNCIONES): Promise<Espias> {
  const espias: Espias = { escanear: [], confirmar: [], claves: [], consola: [] };
  page.on('console', (m) => espias.consola.push(m.text()));
  await loginAs(page, MENSAJERO_USER, { funciones });
  await page.route(/\/api\/flito\/logistica\/mi-ruta/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entregas: [] }) }));
  await page.route(/\/api\/flito\/logistica\/consultar-vehiculo$/, (r) => {
    const { placa } = r.request().postDataJSON() as { placa: string };
    const candidatos = CANDIDATOS[placa];
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(candidatos ? { encontrado: true, candidatos } : { encontrado: false }) });
  });
  let n = 0;
  await page.route(/\/api\/flito\/logistica\/escanear$/, (r: Route) => {
    const b = r.request().postDataJSON() as Record<string, unknown>;
    espias.escanear.push(b);
    n += 1;
    const c0 = (CANDIDATOS[b.placa as string]?.[0] ?? null) as { organismoCodigo: string; companiaNombre: string } | null;
    const base = { placa: b.placa, organismoCodigo: c0?.organismoCodigo ?? null, companiaNombre: b.dejarPendiente ? null : (c0?.companiaNombre ?? null), vin: 'VIN0000000000001', numeroLicencia: b.numeroLicencia, propietarioNombre: 'Propietario de Prueba' };
    const multiple = b.placa === 'MUL111' && !b.tramiteId && !b.dejarPendiente;
    const body = multiple
      ? { ...base, resultado: 'elegir_tramite', candidatos: CANDIDATOS.MUL111 }
      : { ...base, resultado: 'recogido', documentoId: `doc-${n}`, ...(b.dejarPendiente ? { pendienteTramite: true } : {}) };
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route(/\/api\/flito\/logistica\/recogidas\/confirmar$/, (r) => {
    espias.confirmar.push(r.request().postDataJSON() as Record<string, unknown>);
    espias.claves.push(r.request().headers()['idempotency-key']);
    const ids = (espias.confirmar.at(-1)!.documentoIds as string[]);
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ firmanteId: 'f-1', actas: ids.map((_, i) => ({ actaId: `a-${i}`, companiaId: i + 1, documentos: 1 })), pendientesTramite: 0 }) });
  });
  await page.goto('/flito/ruta');
  await expect(page.getByRole('heading', { name: 'Mi ruta' })).toBeVisible();
  return espias;
}

async function agregarManual(page: Page, placa: string, licencia: string, lt: string) {
  await page.getByRole('button', { name: 'Ingresar a mano' }).click();
  await page.getByLabel('Placa', { exact: true }).fill(placa);
  await expect(page.getByText('Confirma que es el vehículo')).toBeVisible();
  await page.getByLabel(/licencia de tránsito/).fill(licencia);
  await page.getByLabel(/sustrato/).fill(lt);
  await page.getByRole('button', { name: 'Agregar LT' }).click();
  await expect(page.getByRole('dialog', { name: 'Ingresar a mano' })).toBeHidden();
}

async function firmar(page: Page) {
  await page.getByRole('img', { name: /Firma del funcionario/ }).evaluate((el: HTMLCanvasElement) => {
    const r = el.getBoundingClientRect();
    const pe = (type: string, x: number, y: number) => el.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true, pointerId: 1 }));
    pe('pointerdown', 20, 20); pe('pointermove', 90, 60); pe('pointermove', 140, 30); pe('pointerup', 140, 30);
  });
}

async function llenarFuncionario(page: Page) {
  await page.getByLabel('Nombre', { exact: true }).fill('Funcionario de Prueba');
  await page.getByLabel('Cédula', { exact: true }).fill(CEDULA);
  await firmar(page);
}

test.describe('HU #14111 — Confirmar recogida con firma del funcionario', () => {
  test('AC1/AC2: LT de dos compañías → una firma, resumen por compañía, cédula fuera de URL y consola', async ({ page }) => {
    const e = await preparar(page);
    await expect(page.getByText(/Aún no has escaneado licencias/)).toBeVisible(); // vacío con siguiente paso
    await agregarManual(page, 'ABC123', '10038156339', 'LT10000848803');
    await agregarManual(page, 'DEF456', '10038156340', 'LT10000848804');

    await expect(page.getByRole('article', { name: 'LT ABC123' }).getByText('A mano')).toBeVisible();
    await expect(page.getByRole('article', { name: 'LT ABC123' }).getByText('Lista', { exact: true })).toBeVisible();
    expect(e.escanear[0]).toMatchObject({ placa: 'ABC123', numeroLicencia: '10038156339', numeroLt: 'LT10000848803', tramiteId: 't-a' });

    await page.getByRole('button', { name: /Continuar a la firma \(2\)/ }).click();
    await expect(page.getByRole('region', { name: 'Transportes del Norte S.A.S.' })).toContainText('ABC123');
    await expect(page.getByRole('region', { name: 'Rápido del Valle S.A.' })).toContainText('DEF456');

    // Validación en línea (sin llamar al API).
    await page.getByRole('button', { name: 'Confirmar recogida' }).click();
    await expect(page.getByText('Escribe el nombre completo del funcionario')).toBeVisible();
    await expect(page.getByText('La cédula debe tener solo números (5 a 12 dígitos)')).toBeVisible();
    await expect(page.getByText('Falta la firma del funcionario')).toBeVisible();
    expect(e.confirmar).toHaveLength(0);

    await llenarFuncionario(page);
    await page.getByRole('button', { name: 'Confirmar recogida' }).click();
    await expect(page.getByRole('heading', { name: /Recogida confirmada/ })).toBeVisible();
    await expect(page.getByText('2 actas generadas con una firma.')).toBeVisible();

    expect(e.confirmar).toHaveLength(1);
    expect(e.confirmar[0]).toMatchObject({ organismoCodigo: '11001', documentoIds: ['doc-1', 'doc-2'], firmante: { nombre: 'Funcionario de Prueba', documento: CEDULA } });
    expect((e.confirmar[0].firmante as { firma: string }).firma).toMatch(/^data:image\/png;base64,/);
    expect(e.claves[0]).toBeTruthy();
    expect(page.url()).not.toContain(CEDULA);
    expect(e.consola.join('\n')).not.toContain(CEDULA);
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(CEDULA);

    await page.getByRole('button', { name: 'Listo' }).click();
    await expect(page.getByText(/Aún no has escaneado licencias/)).toBeVisible();
  });

  test('AC3: elegir_tramite con candidato no gestionable; «No sé cuál» deja la LT pendiente y se firma sin acta', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const e = await preparar(page);
    await page.getByRole('button', { name: 'Ingresar a mano' }).click();
    await page.getByLabel('Placa', { exact: true }).fill('MUL111');
    await expect(page.getByText(/Esta placa tiene 3 trámites/)).toBeVisible();
    await page.getByLabel(/licencia de tránsito/).fill('10038156341');
    await page.getByLabel(/sustrato/).fill('LT10000848805');
    await page.getByRole('button', { name: 'Agregar LT' }).click();

    const hoja = page.getByRole('dialog', { name: /MUL111 tiene varios trámites/ });
    await expect(hoja).toBeVisible();
    // En móvil es una hoja anclada abajo con esquinas superiores redondeadas.
    const caja = await hoja.boundingBox();
    expect(Math.round(caja!.y + caja!.height)).toBe(812);
    expect(caja!.width).toBe(375);
    await expect(hoja).toHaveCSS('border-top-left-radius', '20px');
    for (const f of await hoja.getByRole('button').all()) expect((await f.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const noGestionable = hoja.getByRole('button', { name: /Autogestión/ });
    await expect(noGestionable).toBeDisabled();
    await expect(hoja.getByText('No la recoge FLITO: lo gestiona el cliente.')).toBeVisible();
    await hoja.getByRole('button', { name: 'No sé cuál: dejar pendiente' }).click();

    await expect(page.getByRole('article', { name: 'LT MUL111' }).getByText('Pendiente de trámite').first()).toBeVisible();
    await expect.poll(() => e.escanear.length).toBe(2);
    expect(e.escanear.at(-1)).toMatchObject({ placa: 'MUL111', dejarPendiente: true, organismoCodigo: '11001' });
    await page.getByRole('button', { name: /Continuar a la firma \(1\)/ }).click();
    await expect(page.getByRole('region', { name: 'Pendientes de trámite' })).toContainText('Quedan con la firma, sin acta');
  });

  test('AC3: Cancelar en la hoja quita la LT de la lista', async ({ page }) => {
    await preparar(page);
    await page.getByRole('button', { name: 'Ingresar a mano' }).click();
    await page.getByLabel('Placa', { exact: true }).fill('MUL111');
    await expect(page.getByText(/Esta placa tiene 3 trámites/)).toBeVisible();
    await page.getByLabel(/licencia de tránsito/).fill('10038156341');
    await page.getByLabel(/sustrato/).fill('LT10000848805');
    await page.getByRole('button', { name: 'Agregar LT' }).click();
    await page.getByRole('button', { name: 'Cancelar (quitar esta LT)' }).click();
    await expect(page.getByRole('article', { name: 'LT MUL111' })).toHaveCount(0);
  });

  test('AC3: confirmar sin firma NO confirma; las LT quedan con acta pendiente y luego se firma con el mismo endpoint', async ({ page }) => {
    const e = await preparar(page);
    await agregarManual(page, 'ABC123', '10038156339', 'LT10000848803');
    await page.getByRole('button', { name: /Continuar a la firma/ }).click();
    await page.getByRole('button', { name: 'Confirmar sin firma' }).click();
    await page.getByRole('dialog', { name: 'Confirmar sin firma' }).getByRole('button', { name: 'Confirmar sin firma' }).click();

    await expect(page.getByRole('status').filter({ hasText: 'acta pendiente de firma' })).toBeVisible();
    expect(e.confirmar).toHaveLength(0);
    await page.getByRole('button', { name: /Firmar acta \(1\)/ }).click();
    await llenarFuncionario(page);
    await page.getByRole('button', { name: 'Confirmar recogida' }).click();
    await expect(page.getByRole('heading', { name: /Recogida confirmada/ })).toBeVisible();
    expect(e.confirmar).toHaveLength(1);
    expect(e.escanear).toHaveLength(1); // no se re-registra
  });

  test('AC4: errores de confirmar con copy pulido (nunca el mensaje crudo) y datos conservados', async ({ page }) => {
    const e = await preparar(page);
    await agregarManual(page, 'ABC123', '10038156339', 'LT10000848803');
    await page.getByRole('button', { name: /Continuar a la firma/ }).click();
    await page.unroute(/\/api\/flito\/logistica\/recogidas\/confirmar$/);
    await page.route(/\/api\/flito\/logistica\/recogidas\/confirmar$/, (r) => r.fulfill({
      status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'SQLSTATE 23505 uq_flito_log_acta_linea_organismo', codigo: 'LT_YA_EN_ACTA_ORGANISMO' }),
    }));
    await llenarFuncionario(page);
    await page.getByRole('button', { name: 'Confirmar recogida' }).click();
    const alerta = page.getByRole('alert').filter({ hasText: 'ya está en un acta de recogida' });
    await expect(alerta).toBeVisible();
    await expect(page.getByText('SQLSTATE')).toHaveCount(0);
    await expect(page.getByLabel('Nombre', { exact: true })).toHaveValue('Funcionario de Prueba'); // se conserva
    expect(e.confirmar).toHaveLength(0);

    await page.unroute(/\/api\/flito\/logistica\/recogidas\/confirmar$/);
    await page.route(/\/api\/flito\/logistica\/recogidas\/confirmar$/, (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom stack' }) }));
    await alerta.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'No pudimos confirmar la recogida' })).toBeVisible();
    await expect(page.getByText('boom stack')).toHaveCount(0);
  });

  test('AC4: el reintento reutiliza la Idempotency-Key; si se edita un dato, la clave cambia', async ({ page }) => {
    await preparar(page);
    await agregarManual(page, 'ABC123', '10038156339', 'LT10000848803');
    await page.getByRole('button', { name: /Continuar a la firma/ }).click();
    const claves: Array<string | undefined> = [];
    let falla = 2;
    await page.unroute(/\/api\/flito\/logistica\/recogidas\/confirmar$/);
    await page.route(/\/api\/flito\/logistica\/recogidas\/confirmar$/, (r) => {
      claves.push(r.request().headers()['idempotency-key']);
      if (falla-- > 0) return r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'x' }) });
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ firmanteId: 'f-1', actas: [{ actaId: 'a-1', companiaId: 1, documentos: 1 }], pendientesTramite: 0 }) });
    });
    await llenarFuncionario(page);
    await page.getByRole('button', { name: 'Confirmar recogida' }).click();
    const alerta = page.getByRole('alert').filter({ hasText: 'No pudimos confirmar la recogida' });
    await expect(alerta).toBeVisible();
    await alerta.getByRole('button', { name: 'Reintentar' }).click();
    await expect.poll(() => claves.length).toBe(2);
    expect(claves[0]).toBeTruthy();
    expect(claves[1]).toBe(claves[0]); // mismo intento lógico → misma clave: no duplica actas

    await expect(alerta).toBeVisible();
    await page.getByLabel('Nombre', { exact: true }).fill('Funcionario Corregido');
    await page.getByRole('button', { name: 'Confirmar recogida' }).click();
    await expect(page.getByRole('heading', { name: /Recogida confirmada/ })).toBeVisible();
    expect(claves).toHaveLength(3);
    expect(claves[2]).toBeTruthy();
    expect(claves[2]).not.toBe(claves[0]); // cuerpo distinto → clave nueva
  });

  test('sin señal: la LT ingresada a mano se encola y no se puede confirmar', async ({ page, context }) => {
    const e = await preparar(page);
    await page.getByRole('button', { name: 'Ingresar a mano' }).click();
    await page.getByLabel('Placa', { exact: true }).fill('ABC123');
    await expect(page.getByText('Confirma que es el vehículo')).toBeVisible();
    await page.getByLabel(/licencia de tránsito/).fill('10038156339');
    await page.getByLabel(/sustrato/).fill('LT10000848803');
    await context.setOffline(true);
    await page.getByRole('button', { name: 'Agregar LT' }).click();
    await expect(page.getByRole('article', { name: 'LT ABC123' }).getByText('En cola')).toBeVisible();
    expect(e.escanear).toHaveLength(0);
    await page.getByRole('button', { name: /Continuar a la firma/ }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Sin señal' })).toBeVisible();
    await expect(page.getByLabel('Cédula', { exact: true })).toHaveCount(0);
    expect(e.confirmar).toHaveLength(0);
    await context.setOffline(false);
  });

  test('AC4: sin el permiso de confirmar el mensajero escanea y guarda, pero no ve la firma ni Mis recogidas', async ({ page }) => {
    const e = await preparar(page, SIN_CONFIRMAR);
    await expect(page.getByRole('button', { name: /Mis recogidas/ })).toHaveCount(0);
    await agregarManual(page, 'ABC123', '10038156339', 'LT10000848803');
    await expect(page.getByRole('button', { name: /Guardar LT escaneadas \(1\)/ })).toBeDisabled(); // ya quedó guardada al agregarla
    expect(e.escanear).toHaveLength(1);
    await expect(page.getByLabel('Cédula', { exact: true })).toHaveCount(0);
  });

  test('formulario manual: sin trámite, con trámite, prefijo LT y límite de consultas', async ({ page }) => {
    await preparar(page);
    await page.getByRole('button', { name: 'Ingresar a mano' }).click();
    const agregar = page.getByRole('button', { name: 'Agregar LT' });
    await expect(agregar).toBeDisabled();

    // Sin trámite.
    await page.getByLabel('Placa', { exact: true }).fill('ZZZ999');
    await expect(page.getByText('Esta placa no coincide con ningún trámite.')).toBeVisible();
    await page.getByLabel(/licencia de tránsito/).fill('10038156339');
    await page.getByLabel(/sustrato/).fill('LT10000848803');
    await expect(agregar).toBeDisabled();

    // Con trámite: tarjeta de solo lectura; Agregar se activa solo con los 3 campos.
    await page.getByLabel('Placa', { exact: true }).fill('ABC123');
    await expect(page.getByText('Confirma que es el vehículo')).toBeVisible();
    await expect(page.getByText('VIN0000000000001')).toBeVisible();
    await expect(page.getByText('Renault Duster 2024')).toBeVisible();
    await expect(agregar).toBeEnabled();

    // Sustrato sin «LT».
    await page.getByLabel(/sustrato/).fill('10000848803');
    await page.getByLabel(/sustrato/).blur();
    await expect(page.getByText(/empieza siempre por LT/)).toBeVisible();
    await expect(agregar).toBeDisabled();

    // 429 en la consulta.
    await page.unroute(/\/api\/flito\/logistica\/consultar-vehiculo$/);
    await page.route(/\/api\/flito\/logistica\/consultar-vehiculo$/, (r) => r.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'Demasiadas consultas. Espera un minuto.' }) }));
    await page.getByLabel('Placa', { exact: true }).fill('QWE456');
    await expect(page.getByRole('alert').filter({ hasText: 'Demasiadas consultas seguidas' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reintentar' })).toBeVisible();
    await expect(page.url()).not.toContain('QWE456'); // la placa va en el body
  });

  test('Mis recogidas: cargando, error con reintento, lleno (cédula enmascarada) y vacío', async ({ page }) => {
    await preparar(page);
    let intento = 0;
    await page.route(/\/api\/flito\/logistica\/recogidas\/pendientes-firma$/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendientes: [] }) }));
    await page.route(/\/api\/flito\/logistica\/recogidas\/mias$/, (r) => {
      intento += 1;
      if (intento === 1) return r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'x' }) });
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ recogidas: [{ firmanteId: 'f-1', organismoCodigo: '11001', nombre: 'Funcionario de Prueba', documentoEnmascarado: '••••3456', firmadoEn: '2026-10-28T15:00:00Z', actas: 2, pendientesTramite: 1, estadoFirma: 'firmada' }], pendientesFirma: 0 }) });
    });
    await page.route(/\/api\/flito\/logistica\/recogidas\/f-1$/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      firmanteId: 'f-1', organismoCodigo: '11001', nombre: 'Funcionario de Prueba', documentoEnmascarado: '••••3456', firmadoEn: '2026-10-28T15:00:00Z',
      actas: [{ actaId: 'a-1', companiaId: 1, companiaNombre: 'Transportes del Norte S.A.S.', documentoIds: ['d1', 'd2'] }], pendientesTramite: ['d3'] }) }));

    await page.getByRole('button', { name: /Mis recogidas/ }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'No pudimos cargar tus recogidas.' })).toBeVisible();
    await page.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByText('2 actas · 1 LT pendiente')).toBeVisible();
    await page.getByRole('button', { name: /Org\. 11001/ }).click();
    await expect(page.getByText('••••3456')).toBeVisible();
    await expect(page.getByText('Acta 1 · Transportes del Norte S.A.S.')).toBeVisible();
    await expect(page.getByText(/Pendientes de trámite: 1/)).toBeVisible();
    await page.getByRole('button', { name: /^.*Mis recogidas$/ }).click();
    await page.getByRole('button', { name: /Mi ruta$/ }).click();
    await expect(page.getByRole('heading', { name: 'Recoger licencias' })).toBeVisible();

    // Vacío.
    await page.unroute(/\/api\/flito\/logistica\/recogidas\/mias$/);
    await page.route(/\/api\/flito\/logistica\/recogidas\/mias$/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ recogidas: [], pendientesFirma: 0 }) }));
    await page.getByRole('button', { name: /Mis recogidas/ }).click();
    await expect(page.getByText(/Todavía no has confirmado recogidas/)).toBeVisible();
    await page.getByRole('button', { name: 'Ir a escanear' }).click();
    await expect(page.getByRole('heading', { name: 'Recoger licencias' })).toBeVisible();
  });

  test('Mis recogidas: LT pendientes de firma con contador y firma desde ahí', async ({ page }) => {
    const espias = await preparar(page);
    let firmadas = false;
    const pend = [
      { documentoId: 'p-1', placa: 'ABC123', numeroLt: 'LT10000848803', idFlit: 'FLIT-1', companiaId: 1, companiaNombre: 'Transportes del Norte S.A.S.', organismoCodigo: '11001', pendienteTramite: false, estado: 'recogido', fecha: '2026-10-28T15:00:00Z' },
      { documentoId: 'p-2', placa: 'DEF456', numeroLt: 'LT10000848804', idFlit: null, companiaId: null, companiaNombre: null, organismoCodigo: '11001', pendienteTramite: true, estado: 'recogido', fecha: '2026-10-28T16:00:00Z' },
    ];
    await page.route(/\/api\/flito\/logistica\/recogidas\/pendientes-firma$/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendientes: firmadas ? [] : pend }) }));
    await page.route(/\/api\/flito\/logistica\/recogidas\/mias$/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      recogidas: firmadas ? [{ firmanteId: 'f-1', organismoCodigo: '11001', nombre: 'Funcionario de Prueba', documentoEnmascarado: '••••3456', firmadoEn: '2026-10-28T17:00:00Z', actas: 1, pendientesTramite: 1, estadoFirma: 'firmada' }] : [],
      pendientesFirma: firmadas ? 0 : 2 }) }));

    await page.getByRole('button', { name: /Mis recogidas/ }).click();
    await expect(page.getByText('Falta firma · 2')).toBeVisible();
    await expect(page.getByText('ABC123 · LT10000848803')).toBeVisible();
    await expect(page.getByText(/Transportes del Norte S\.A\.S\. · Org\. 11001/)).toBeVisible();
    await expect(page.getByText(/^Pendiente de trámite · Org\. 11001/)).toBeVisible();
    expect(page.url()).not.toContain('ABC123');
    await page.getByRole('button', { name: 'Firmar 2 LT' }).click();
    await expect(page.getByRole('heading', { name: 'Confirmar recogida' })).toBeVisible();
    await llenarFuncionario(page);
    firmadas = true;
    await page.getByRole('button', { name: 'Confirmar recogida' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Firmaste' })).toBeVisible();
    expect(espias.confirmar[0].documentoIds).toEqual(['p-1', 'p-2']);
    await expect(page.getByText('Falta firma · 2')).toHaveCount(0);
    await expect(page.locator('[data-flit-chip]').filter({ hasText: 'Firmada' })).toBeVisible();
    expect(espias.consola.join(' ')).not.toContain('ABC123');
  });

  test('móvil 375: sin scroll horizontal en lista y firma', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await preparar(page);
    const sinDesborde = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    await agregarManual(page, 'ABC123', '10038156339', 'LT10000848803');
    expect(await sinDesborde()).toBe(true);
    await page.getByRole('button', { name: /Continuar a la firma/ }).click();
    await expect(page.getByRole('button', { name: 'Confirmar recogida' })).toBeVisible();
    expect(await sinDesborde()).toBe(true);
  });

  test('a11y (axe): formulario manual y paso de firma', async ({ page }) => {
    test.skip(!process.env.QA_AXE_CDN && !process.env.QA_AXE_PATH, 'axe requiere QA_AXE_CDN=1 o QA_AXE_PATH');
    await preparar(page);
    await page.getByRole('button', { name: 'Ingresar a mano' }).click();
    await page.getByLabel('Placa', { exact: true }).fill('ABC123');
    await expect(page.getByText('Confirma que es el vehículo')).toBeVisible();
    esperarSinViolacionesGraves(await correrAxe(page), 'formulario manual');
    await page.getByLabel(/licencia de tránsito/).fill('10038156339');
    await page.getByLabel(/sustrato/).fill('LT10000848803');
    await page.getByRole('button', { name: 'Agregar LT' }).click();
    await page.getByRole('button', { name: /Continuar a la firma/ }).click();
    await expect(page.getByRole('button', { name: 'Confirmar recogida' })).toBeVisible();
    esperarSinViolacionesGraves(await correrAxe(page), 'paso de firma');
  });
});
