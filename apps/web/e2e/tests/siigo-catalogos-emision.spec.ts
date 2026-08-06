import { test, expect } from '../helpers/fixtures';
import {
  loginAs, ADMIN_USER, FINANCIERA_USER, AUDITOR_USER, CONDUCTOR_USER,
} from '../helpers/auth';

// Facturación electrónica — catálogos, configuración de emisión y compuerta (HU #11288).
//
// Segunda pestaña de la MISMA pantalla que la HU #11287: comparten ruta, ítem de menú y permiso.
// Backend mockeado.

type Page = import('@playwright/test').Page;

const RESUMEN = [
  { tipo: 'document_type', etiqueta: 'Tipos de comprobante', total: 3, activos: 2, sincronizadoEn: '2026-08-06T09:00:00Z' },
  { tipo: 'user', etiqueta: 'Vendedores', total: 3, activos: 2, sincronizadoEn: '2026-08-06T09:00:00Z' },
  { tipo: 'payment_type', etiqueta: 'Formas de pago', total: 4, activos: 3, sincronizadoEn: '2026-08-06T09:00:00Z' },
  { tipo: 'tax', etiqueta: 'Impuestos', total: 5, activos: 4, sincronizadoEn: '2026-08-06T09:00:00Z' },
  { tipo: 'account_group', etiqueta: 'Grupos de inventario', total: 4, activos: 3, sincronizadoEn: '2026-08-06T09:00:00Z' },
  { tipo: 'cost_center', etiqueta: 'Centros de costo', total: 4, activos: 3, sincronizadoEn: '2026-08-06T09:00:00Z' },
];

const SIN_SINCRONIZAR = RESUMEN.map((c) => ({ ...c, total: 0, activos: 0, sincronizadoEn: null }));

const ELEMENTOS: Record<string, unknown[]> = {
  document_type: [{ codigo: '1', nombre: 'Factura de venta', activo: true }],
  user: [{ codigo: '35071', nombre: 'Ana Ramírez', activo: true }],
  payment_type: [{ codigo: '5636', nombre: 'Contado', activo: true }],
  cost_center: [{ codigo: '25732', nombre: 'Principal', activo: true }],
};

const CONFIG_OK = {
  id: 'cfg-1',
  documentoTipoCodigo: '1',
  vendedorCodigo: '35071',
  formaPagoCodigo: '5636',
  centroCostoCodigo: null,
  plazoVencimientoDias: 0,
  estrategiaNumeracion: 'siigo',
  notas: null,
  utilizable: true,
  campos: [
    { campo: 'documentoTipo', etiqueta: 'Tipo de comprobante', codigo: '1', nombre: 'Factura de venta', validez: 'ok', mensaje: null },
    { campo: 'vendedor', etiqueta: 'Vendedor', codigo: '35071', nombre: 'Ana Ramírez', validez: 'ok', mensaje: null },
    { campo: 'formaPago', etiqueta: 'Forma de pago', codigo: '5636', nombre: 'Contado', validez: 'ok', mensaje: null },
    { campo: 'centroCosto', etiqueta: 'Centro de costo', codigo: null, nombre: null, validez: 'no_aplica', mensaje: null },
  ],
};

interface Opciones {
  resumen?: unknown[];
  config?: unknown;
  compuerta?: Record<string, unknown>;
}

async function mock(page: Page, o: Opciones = {}) {
  await page.route(/\/api\/siigo\/parametrizacion\/catalogos\?/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ data: o.resumen ?? RESUMEN }),
  }));
  await page.route(/\/api\/siigo\/parametrizacion\/catalogos\/([a-z_]+)/, (route) => {
    const tipo = /catalogos\/([a-z_]+)/.exec(route.request().url())![1]!;
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ tipo, elementos: ELEMENTOS[tipo] ?? [] }),
    });
  });
  await page.route(/\/api\/siigo\/config-emision(\?|$)/, (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ambiente: 'pruebas', config: o.config === undefined ? CONFIG_OK : o.config }),
    });
  });
  await page.route(/\/api\/siigo\/mapeo-conceptos\?/, (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ambiente: 'pruebas', data: [] }),
  }));
  await page.route(/\/api\/siigo\/compuerta(\?|$)/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      ambiente: 'pruebas', modo: 'real', compuertaActiva: true,
      emisionRealHabilitada: true, motivos: [], conceptosEvaluados: [],
      ...(o.compuerta ?? {}),
    }),
  }));
}

/** Abre la pantalla y cambia a la pestaña de catálogos. */
async function abrirPestana(page: Page) {
  await page.goto('/siigo/parametrizacion');
  await page.getByRole('tab', { name: 'Catálogos y emisión' }).click();
}

test.describe('AC1 — acceso restringido', () => {
  test('un rol sin permiso no entra', async ({ page }) => {
    await loginAs(page, CONDUCTOR_USER);
    await mock(page);
    await page.goto('/siigo/parametrizacion');

    await expect(page.getByRole('heading', { name: /No tienes acceso/ })).toBeVisible();
  });

  test('solo administración sincroniza y guarda', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mock(page);
    await abrirPestana(page);

    await expect(page.getByRole('button', { name: 'Sincronizar ahora' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Guardar configuración' })).toBeVisible();
  });

  test('financiera ve la configuración pero no la escribe', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    await abrirPestana(page);

    // Ve los valores —es parte de su trabajo— pero no puede tocarlos.
    await expect(page.getByLabel(/^Vendedor/)).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Sincronizar ahora' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Guardar configuración' })).toHaveCount(0);
  });

  test('auditor NO ve la pestaña de catálogos: el backend le niega esa lectura', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mock(page);
    await page.goto('/siigo/parametrizacion');

    // `parametrizacion.routes.ts` excluye a `auditor` de la lectura de catálogos, y su spec lo fija
    // a propósito (HU #11281). Ofrecerle la pestaña sería llevarlo a un 403.
    await expect(page.getByRole('tab', { name: 'Mapeo de conceptos' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Catálogos y emisión' })).toHaveCount(0);
  });
});

test.describe('AC2 — los cuatro estados', () => {
  test('vacío invita a sincronizar por primera vez', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mock(page, { resumen: SIN_SINCRONIZAR, config: null });
    await abrirPestana(page);

    await expect(page.getByText('Todavía no se han traído los catálogos de Siigo en este ambiente.')).toBeVisible();
    // Y explica por qué importa, no solo que están vacíos.
    await expect(page.getByText(/Sin ellos no se puede elegir/)).toBeVisible();
  });

  test('el error ofrece reintentar y el reintento vuelve a pedir', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mock(page);
    let intentos = 0;
    await page.route(/\/api\/siigo\/parametrizacion\/catalogos\?/, (route) => {
      intentos += 1;
      if (intentos === 1) {
        return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Se cayó la base' }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: RESUMEN }) });
    });

    await abrirPestana(page);
    await page.getByRole('button', { name: 'Reintentar' }).click();

    await expect(page.getByText('Vendedores')).toBeVisible();
    expect(intentos).toBeGreaterThan(1);
  });
});

test.describe('AC3 — sincronizar catálogos desde la pantalla', () => {
  test('muestra el resultado por catálogo, incluido el que falló y por qué', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mock(page);
    await page.route(/\/api\/siigo\/parametrizacion\/catalogos\/sincronizar/, (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        ok: false, parcial: true, vaciadoMasivo: false,
        catalogos: [
          { tipo: 'user', etiqueta: 'Vendedores', ok: true, total: 3, inactivados: 0, descartados: 0, vaciadoMasivo: false, error: null },
          { tipo: 'tax', etiqueta: 'Impuestos', ok: false, total: 0, inactivados: 0, descartados: 0, vaciadoMasivo: false, error: { codigo: 'service_unavailable', mensaje: 'Siigo no está disponible en este momento.' } },
        ],
      }),
    }));

    await abrirPestana(page);
    await page.getByRole('button', { name: 'Sincronizar ahora' }).click();

    await expect(page.getByText('3 traídos')).toBeVisible();
    await expect(page.getByText('Falló')).toBeVisible();
    // No basta con decir que falló: hay que decir por qué.
    await expect(page.getByText('Siigo no está disponible en este momento.')).toBeVisible();
  });

  test('un catálogo que vuelve VACÍO no se anuncia en verde', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mock(page);
    await page.route(/\/api\/siigo\/parametrizacion\/catalogos\/sincronizar/, (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        ok: true, parcial: false, vaciadoMasivo: true,
        catalogos: [{ tipo: 'user', etiqueta: 'Vendedores', ok: true, total: 0, inactivados: 3, descartados: 0, vaciadoMasivo: true, error: null }],
      }),
    }));

    await abrirPestana(page);
    await page.getByRole('button', { name: 'Sincronizar ahora' }).click();

    // Técnicamente la sincronización fue un éxito; el efecto es que la parametrización se quedó
    // sin opciones. Sin señalarlo, la pantalla lo anunciaría en verde.
    await expect(page.getByText('Volvió vacío')).toBeVisible();
  });

  test('la acción se deshabilita mientras corre para no dispararla dos veces', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mock(page);
    let soltar: (() => void) | null = null;
    let llamadas = 0;
    await page.route(/\/api\/siigo\/parametrizacion\/catalogos\/sincronizar/, async (route) => {
      llamadas += 1;
      await new Promise<void>((r) => { soltar = r; });
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, parcial: false, vaciadoMasivo: false, catalogos: [] }),
      });
    });

    await abrirPestana(page);
    const boton = page.getByRole('button', { name: 'Sincronizar ahora' });
    await boton.click();

    await expect(page.getByRole('button', { name: 'Sincronizando…' })).toBeDisabled();
    soltar!();
    await expect(page.getByRole('button', { name: 'Sincronizar ahora' })).toBeVisible();
    expect(llamadas).toBe(1);
  });
});

test.describe('AC4 — identificadores elegidos, nunca escritos', () => {
  test('los cuatro campos son listas pobladas del catálogo', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mock(page);
    await abrirPestana(page);

    for (const etiqueta of ['Tipo de comprobante', 'Vendedor', 'Forma de pago', 'Centro de costo']) {
      const control = page.getByLabel(new RegExp(`^${etiqueta}`));
      // Un `<select>`, no un `<input>`: un identificador de Siigo escrito a mano es cómo se acaba
      // facturando contra el vendedor equivocado.
      await expect(control).toHaveJSProperty('tagName', 'SELECT');
    }
    await expect(page.getByLabel(/^Vendedor/).getByRole('option', { name: 'Ana Ramírez' })).toHaveCount(1);
  });

  test('no hay ningún campo de texto libre para un identificador', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mock(page);
    await abrirPestana(page);

    // El único input de la sección es el plazo, que es un número y no un identificador.
    const inputs = page.locator('form input');
    await expect(inputs).toHaveCount(1);
    await expect(inputs.first()).toHaveAttribute('type', 'number');
  });
});

test.describe('AC5 — un valor que dejó de ser válido se ve y bloquea', () => {
  test('el campo se marca con su motivo y no deja guardar', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mock(page, {
      config: {
        ...CONFIG_OK,
        utilizable: false,
        vendedorCodigo: '35073',
        campos: CONFIG_OK.campos.map((c) => (c.campo === 'vendedor'
          ? { ...c, codigo: '35073', nombre: 'Diana Osorio', validez: 'inactivo', mensaje: 'Vendedor «Diana Osorio» quedó INACTIVO en Siigo.' }
          : c)),
      },
    });
    await abrirPestana(page);

    await expect(page.getByText(/quedó INACTIVO en Siigo/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Guardar configuración' })).toBeDisabled();
    await expect(page.getByText(/Hay valores que dejaron de ser válidos/)).toBeVisible();
  });

  test('al elegir uno válido el bloqueo desaparece sin recargar', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mock(page, {
      config: {
        ...CONFIG_OK,
        utilizable: false,
        vendedorCodigo: '35073',
        campos: CONFIG_OK.campos.map((c) => (c.campo === 'vendedor'
          ? { ...c, codigo: '35073', nombre: 'Diana Osorio', validez: 'inactivo', mensaje: 'quedó INACTIVO' }
          : c)),
      },
    });
    await abrirPestana(page);

    await expect(page.getByRole('button', { name: 'Guardar configuración' })).toBeDisabled();
    await page.getByLabel(/^Vendedor/).selectOption('35071');

    // Bloquear por el diagnóstico del servidor sin mirar el formulario dejaría la pantalla trabada
    // aunque el problema ya estuviera resuelto.
    await expect(page.getByRole('button', { name: 'Guardar configuración' })).toBeEnabled();
  });
});

test.describe('AC6 — la compuerta encabeza la pantalla', () => {
  test('con la emisión bloqueada, se ve arriba y enumera lo que falta', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mock(page, {
      compuerta: {
        emisionRealHabilitada: false,
        motivos: [
          { tipo: 'concepto_sin_confirmar', detalle: 'Falta la confirmación de contabilidad en: soat.', conceptos: ['soat'] },
          { tipo: 'config_incompleta', detalle: 'Faltan valores en la configuración de emisión: Vendedor.', campos: ['vendedor'] },
        ],
      },
    });
    await page.goto('/siigo/parametrizacion');

    await expect(page.getByRole('heading', { name: /La emisión en producción está bloqueada/ })).toBeVisible();
    await expect(page.getByText('Falta la confirmación de contabilidad en: soat.')).toBeVisible();
    await expect(page.getByText('Faltan valores en la configuración de emisión: Vendedor.')).toBeVisible();
  });

  test('cada motivo lleva a la pestaña donde se corrige', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mock(page, {
      compuerta: {
        emisionRealHabilitada: false,
        motivos: [{ tipo: 'config_incompleta', detalle: 'Faltan valores en la configuración de emisión: Vendedor.', campos: ['vendedor'] }],
      },
    });
    await page.goto('/siigo/parametrizacion');

    // Arranca en el mapeo; el enlace del motivo de configuración lleva a la otra pestaña.
    await expect(page.getByRole('tab', { name: 'Mapeo de conceptos' })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: 'Ir a corregirlo' }).click();

    await expect(page.getByRole('tab', { name: 'Catálogos y emisión' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Configuración global de emisión' })).toBeVisible();
  });

  test('con todo listo, lo dice en positivo', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mock(page);
    await page.goto('/siigo/parametrizacion');

    await expect(page.getByText(/la emisión en producción está habilitada/)).toBeVisible();
  });
});

test.describe('AC7 — el modo simulado se señaliza', () => {
  test('aviso permanente que aclara que la compuerta no aplica', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mock(page, { compuerta: { modo: 'mock', compuertaActiva: false } });
    await abrirPestana(page);

    await expect(page.getByText(/los datos vienen del simulador/i)).toBeVisible();
    await expect(page.getByText(/no aplica/i)).toBeVisible();
  });
});
