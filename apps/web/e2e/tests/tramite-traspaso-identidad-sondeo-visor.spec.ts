// Feature #14284 — cada consulta de estado y cada entrega de documentos biométricos deja auditoría.
// · Sondeo de TraspasoStepIdentidad: no consulta cuando ninguna parte puede cambiar sola, y sí en
//   cualquier otro caso. `rechazado` con enlace vigente e intentos NO es final: el participante
//   reintenta desde el mismo correo (POST /validacion-identidad/completar/:token).
// · ExpedienteVisor: si el API no entrega documentos o certificado, aviso en página con Reintentar.

import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER } from '../helpers/auth';
import type { Page } from '@playwright/test';

const INTERVALO_MS = 5000;
const FUTURO = '2099-01-01T00:00:00.000Z';
const PASADO = '2020-01-01T00:00:00.000Z';

interface Fila { id: number; parte: string; documento: string; estado: string; score?: number; intentos?: number; expiraAt?: string }

const vendedor = (estado: string, extra: Partial<Fila> = {}): Fila =>
  ({ id: 1, parte: 'vendedor', documento: '111', estado, intentos: 1, expiraAt: FUTURO, ...extra });
const comprador = (estado: string, extra: Partial<Fila> = {}): Fila =>
  ({ id: 2, parte: 'comprador', documento: '222', estado, intentos: 1, expiraAt: FUTURO, ...extra });

const tramite88 = {
  id: 88, vin: 'VIN88', placa: 'ABC123', estado: 'radicado', paso: 6,
  modalidadEntrada: 'traspaso', tipologiaCodigo: 'traspaso_standard', numeroRadicado: 'TD-2026-00001',
  checklistEstado: {},
  vehiculo: {
    marca: 'Mazda', linea: 'CX-30', vin: 'VIN88',
    _vendedor: { nombre: 'Carlos Vendedor', documento: '111', ciudad: 'Medellín', email: 'ven@x.co' },
    _runtVendedor: { documento: '111', tipoDoc: 'CC', consultado: true, consultadoAt: '2026-01-01T00:00:00.000Z' },
    _comprador: { nombre: 'Ana Compradora', documento: '222', ciudad: 'Medellín', email: 'comp@x.co' },
    _runtComprador: { documento: '222', tipoDoc: 'CC', consultado: true, consultadoAt: '2026-01-01T00:00:00.000Z' },
    _simitComprador: { documento: '222', consultado: true, total: 0 },
    _comercial: { valorVenta: 20000000, causal: 'COMPRAVENTA' },
  },
  comprador: { nombre: 'Ana Compradora', documento: '222', email: 'comp@x.co' },
};

/** Paso 6 con el reloj del navegador instalado. `estado.filas` es lo que responde el API en cada consulta. */
async function abrirPaso6(page: Page, filas: Fila[]) {
  const estado = { filas, peticiones: 0 };
  await page.clock.install();
  await loginAs(page, ADMIN_USER);
  await page.route('**/api/tramites/88/documentos', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/tramites/88/firma', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ firmas: [] }) }));
  await page.route('**/api/validacion-identidad/estado/88', (r) => {
    estado.peticiones += 1;
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, validaciones: estado.filas }) });
  });
  await page.route('**/api/tramites/88', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tramite88) }));
  await page.goto('/tramite/traspaso?id=88');
  await expect(seccionIdentidad(page)).toBeVisible();
  return estado;
}

const seccionIdentidad = (page: Page) => page.getByRole('region', { name: 'Validación de identidad' });

/** Avanza el reloj `ciclos` intervalos y devuelve cuántas consultas salieron. */
async function consultasEn(page: Page, estado: { peticiones: number }, ciclos: number) {
  const antes = estado.peticiones;
  await page.clock.runFor(INTERVALO_MS * ciclos);
  // Las respuestas mockeadas se resuelven fuera del reloj falso.
  await page.waitForTimeout(300);
  return estado.peticiones - antes;
}

test.describe('Feature #14284 · sondeo del estado biométrico en el traspaso', () => {
  test('ambas aprobadas: deja de consultar y sigue mostrando Validado', async ({ page }) => {
    const estado = await abrirPaso6(page, [vendedor('aprobado', { score: 95 }), comprador('aprobado', { score: 92 })]);
    await expect(page.getByText('✓ Ambas identidades validadas.')).toBeVisible();
    expect(await consultasEn(page, estado, 6)).toBe(0);
    await expect(page.getByText('✓ Ambas identidades validadas.')).toBeVisible();
  });

  test('una aprobada y otra en curso: sigue consultando y ve el aprobado de otra sesión', async ({ page }) => {
    const estado = await abrirPaso6(page, [vendedor('aprobado'), comprador('en_proceso')]);
    await expect(seccionIdentidad(page).getByText('En proceso', { exact: true })).toBeVisible();
    expect(await consultasEn(page, estado, 3)).toBeGreaterThanOrEqual(2);

    estado.filas = [vendedor('aprobado'), comprador('aprobado')];
    await page.clock.runFor(INTERVALO_MS);
    await expect(page.getByText('✓ Ambas identidades validadas.')).toBeVisible();
    expect(await consultasEn(page, estado, 6)).toBe(0);
  });

  test('una aprobada y la otra por iniciar: sigue consultando', async ({ page }) => {
    const estado = await abrirPaso6(page, [vendedor('aprobado')]);
    await expect(seccionIdentidad(page).getByText('Validado', { exact: true })).toBeVisible();
    expect(await consultasEn(page, estado, 3)).toBeGreaterThanOrEqual(2);
  });

  test('rechazada con enlace vigente e intentos: sigue consultando y ve el reintento desde el correo', async ({ page }) => {
    const estado = await abrirPaso6(page, [vendedor('aprobado'), comprador('rechazado', { intentos: 2 })]);
    await expect(seccionIdentidad(page).getByText('Rechazado', { exact: true })).toBeVisible();
    expect(await consultasEn(page, estado, 3)).toBeGreaterThanOrEqual(2);

    estado.filas = [vendedor('aprobado'), comprador('aprobado')];
    await page.clock.runFor(INTERVALO_MS);
    await expect(page.getByText('✓ Ambas identidades validadas.')).toBeVisible();
  });

  test('rechazada sin intentos y con enlace vencido: deja de consultar; reenviar reanuda', async ({ page }) => {
    const estado = await abrirPaso6(page, [
      vendedor('rechazado', { intentos: 5 }),
      comprador('rechazado', { intentos: 1, expiraAt: PASADO }),
    ]);
    await expect(seccionIdentidad(page).getByText('Rechazado', { exact: true })).toHaveCount(2);
    expect(await consultasEn(page, estado, 6)).toBe(0);

    await page.route('**/api/validacion-identidad/iniciar-partes', (r) => {
      estado.filas = [vendedor('enviado', { id: 3, intentos: 0 }), comprador('enviado', { id: 4, intentos: 0 })];
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, partes: [
        { parte: 'vendedor', email: 'ven@x.co', emailEnviado: true },
        { parte: 'comprador', email: 'comp@x.co', emailEnviado: true },
      ] }) });
    });
    await seccionIdentidad(page).getByRole('button', { name: /Reenviar validación/ }).click();
    await expect(seccionIdentidad(page).getByText('Correo enviado', { exact: true })).toHaveCount(2);
    expect(await consultasEn(page, estado, 3)).toBeGreaterThanOrEqual(2);
  });
});

// PDF mínimo: pdf.js reconstruye el xref y renderiza una página en blanco.
const PDF_MINIMO = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF';

const ERROR_API = { status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Error interno del servidor' }) };

async function abrirVisor(page: Page, pestana: 'Doc. identidad' | 'Validación' | 'Certificación') {
  await abrirPaso6(page, [vendedor('aprobado'), comprador('aprobado')]);
  const panel = page.getByRole('region', { name: 'Expediente del traspaso' });
  await panel.getByRole('button', { name: /Expediente del traspaso/ }).click();
  await panel.getByRole('button', { name: 'Documentos', exact: true }).first().click();
  await panel.getByRole('button', { name: pestana, exact: true }).click();
  return panel;
}

async function expectAvisoSinCrudo(panel: ReturnType<Page['getByRole']>, mensaje: RegExp) {
  const aviso = panel.getByRole('alert');
  await expect(aviso).toContainText(mensaje);
  await expect(aviso).not.toContainText(/\b\d{3}\b|interno|servidor|auditor/i);
  await expect(panel).not.toContainText(/Error \d{3}|Error interno/);
}

test.describe('Feature #14284 · aviso del visor cuando el API no entrega', () => {
  for (const pestana of ['Doc. identidad', 'Validación'] as const) {
    test(`documentos, pestaña ${pestana}: 500 → aviso; Reintentar entrega en el 200`, async ({ page }) => {
      let peticiones = 0;
      await page.route('**/api/validacion-identidad/documentos/88', (r) => {
        peticiones += 1;
        if (peticiones === 1) return r.fulfill(ERROR_API);
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, documentos: [
          { id: 2, estado: 'aprobado', nombre: 'Ana Compradora', documento: '222', tipoDoc: 'CC', score: 92 },
        ] }) });
      });
      const panel = await abrirVisor(page, pestana);
      await panel.getByRole('button', { name: pestana === 'Validación' ? 'Cargar validación' : 'Cargar documento de identidad' }).click();

      await expectAvisoSinCrudo(panel, /No pudimos abrir los documentos\. Intenta de nuevo en unos minutos\./);
      await panel.getByRole('button', { name: 'Reintentar' }).click();

      await expect(panel.getByRole('alert')).toHaveCount(0);
      await expect(panel.getByText('Ana Compradora').last()).toBeVisible();
      expect(peticiones).toBe(2);
    });
  }

  test('certificado: 500 → aviso; Reintentar entrega el PDF en el 200', async ({ page }) => {
    let peticiones = 0;
    await page.route('**/api/validacion-identidad/certificado/88', (r) => {
      peticiones += 1;
      if (peticiones === 1) return r.fulfill(ERROR_API);
      return r.fulfill({ status: 200, contentType: 'application/pdf', body: PDF_MINIMO });
    });
    const panel = await abrirVisor(page, 'Certificación');
    await panel.getByRole('button', { name: 'Generar', exact: true }).click();

    await expectAvisoSinCrudo(panel, /No pudimos generar la certificación\. Intenta de nuevo en unos minutos\./);
    await panel.getByRole('button', { name: 'Reintentar' }).click();

    await expect(panel.getByText('1 pág.')).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByRole('alert')).toHaveCount(0);
    expect(peticiones).toBe(2);
  });

  const OTROS = [
    { caso: '403', responde: { status: 403, contentType: 'application/json', body: '{"error":"Sin permiso"}' }, mensaje: /No tienes permiso/ },
    { caso: '404', responde: { status: 404, contentType: 'application/json', body: '{"error":"Sin validaciones"}' }, mensaje: /No encontramos los documentos/ },
    { caso: 'cuerpo no JSON', responde: { status: 502, contentType: 'text/html', body: '<html>Bad Gateway</html>' }, mensaje: /No pudimos abrir los documentos/ },
    { caso: 'sin red', responde: null, mensaje: /No pudimos conectarnos/ },
  ];
  for (const { caso, responde, mensaje } of OTROS) {
    test(`documentos, ${caso}: mensaje propio del caso, sin texto crudo`, async ({ page }) => {
      await page.route('**/api/validacion-identidad/documentos/88', (r) => (responde ? r.fulfill(responde) : r.abort('failed')));
      const panel = await abrirVisor(page, 'Doc. identidad');
      await panel.getByRole('button', { name: 'Cargar documento de identidad' }).click();
      await expectAvisoSinCrudo(panel, mensaje);
    });
  }

  test('certificado, 404 (trámite sin validaciones): lo dice sin texto crudo', async ({ page }) => {
    await page.route('**/api/validacion-identidad/certificado/88', (r) =>
      r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Sin validaciones para este trámite"}' }));
    const panel = await abrirVisor(page, 'Certificación');
    await panel.getByRole('button', { name: 'Generar', exact: true }).click();
    await expectAvisoSinCrudo(panel, /aún no tiene validaciones de identidad/);
  });
});
