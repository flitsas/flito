import { test, expect } from '../helpers/fixtures';
import {
  loginAs, ADMIN_USER, FINANCIERA_USER, AUDITOR_USER, CONDUCTOR_USER,
} from '../helpers/auth';

// Facturación electrónica — parametrización del mapeo de conceptos (HU #11287).
//
// Backend mockeado. Lo que se prueba es la pantalla: qué ve cada rol, los cuatro estados, cómo se
// distingue un concepto sin mapear de uno confirmado, y que los avisos que la HU pide —la
// confirmación que se perderá, el modo simulado— estén donde tienen que estar.

const SIN_MAPEAR = {
  id: '11111111-1111-4111-8111-111111111111',
  ambiente: 'pruebas',
  concepto: 'logistica',
  tipoTramite: null,
  codigoProducto: null,
  nombreProducto: null,
  clasificacionTributaria: null,
  impuestos: [],
  unidadMedida: null,
  ingresoParaTerceros: false,
  lineaPropiaPendiente: false,
  confirmadoContabilidad: false,
  confirmadoPorId: null,
  confirmadoEn: null,
  validacionEstado: 'sin_validar',
  validacionMensaje: null,
  listoParaFacturar: false,
};

const SIN_CONFIRMAR = {
  ...SIN_MAPEAR,
  id: '22222222-2222-4222-8222-222222222222',
  concepto: 'soat',
  codigoProducto: 'FLIT-SOAT',
  nombreProducto: 'SOAT — Seguro Obligatorio',
  clasificacionTributaria: 'excluido',
  unidadMedida: '94',
};

const CONFIRMADO = {
  ...SIN_CONFIRMAR,
  id: '33333333-3333-4333-8333-333333333333',
  concepto: 'tramite_digital',
  codigoProducto: 'FLIT-TRAMITE-DIGITAL',
  nombreProducto: 'Trámite digital',
  clasificacionTributaria: 'gravado',
  ingresoParaTerceros: true,
  confirmadoContabilidad: true,
  confirmadoPorId: 7,
  confirmadoEn: '2026-08-01T09:00:00Z',
  validacionEstado: 'valido',
  listoParaFacturar: true,
};

type Page = import('@playwright/test').Page;

async function mockMapeo(page: Page, filas: unknown[], modo: 'mock' | 'real' = 'real') {
  await page.route(/\/api\/siigo\/mapeo-conceptos\?/, (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ambiente: 'pruebas', data: filas }),
    }));
  await page.route(/\/api\/siigo\/compuerta(\?|$)/, (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        ambiente: 'pruebas', modo, compuertaActiva: modo === 'real',
        emisionRealHabilitada: false, motivos: [], conceptosEvaluados: [],
      }),
    }));
}

test.describe('AC1 — acceso y permisos por acción', () => {
  test('un rol sin permiso no ve la opción en el menú ni entra por el enlace directo', async ({ page }) => {
    await loginAs(page, CONDUCTOR_USER);
    await mockMapeo(page, [SIN_CONFIRMAR]);
    await page.goto('/siigo/parametrizacion');

    // La guarda rechaza el acceso directo.
    await expect(page.getByRole('heading', { name: /No tienes acceso/ })).toBeVisible();
    // Y no llega a pintarse nada del mapeo: el rechazo es antes de los datos.
    await expect(page.getByText('FLIT-SOAT')).toHaveCount(0);
    // Tampoco aparece la opción en el menú (la otra mitad del AC1).
    await expect(page.getByRole('navigation').getByRole('link', { name: 'Facturación electrónica' }))
      .toHaveCount(0);
  });

  test('admin ve la pantalla y puede editar', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockMapeo(page, [SIN_CONFIRMAR]);
    await page.goto('/siigo/parametrizacion');

    await expect(page.getByRole('heading', { name: /Facturación electrónica/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Editar' })).toBeVisible();
  });

  test('financiera confirma pero NO edita el resto del mapeo', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockMapeo(page, [SIN_CONFIRMAR]);
    await page.goto('/siigo/parametrizacion');

    await expect(page.getByRole('heading', { name: /Facturación electrónica/ })).toBeVisible();
    // Firma la confirmación —es su trabajo— pero no toca el tratamiento tributario.
    await expect(page.getByRole('button', { name: 'Confirmar' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Editar' })).toHaveCount(0);
  });

  test('auditor lee y no ve ninguna acción de escritura', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mockMapeo(page, [SIN_CONFIRMAR]);
    await page.goto('/siigo/parametrizacion');

    await expect(page.getByText('FLIT-SOAT')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Editar' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Confirmar' })).toHaveCount(0);
  });
});

test.describe('AC2 — los cuatro estados', () => {
  test('cargando, con datos, vacío y error', async ({ page }) => {
    await loginAs(page, ADMIN_USER);

    // 1. Cargando: la petición se retiene y el indicador tiene que estar.
    let soltar: (() => void) | null = null;
    await page.route(/\/api\/siigo\/mapeo-conceptos\?/, async (route) => {
      await new Promise<void>((r) => { soltar = r; });
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ambiente: 'pruebas', data: [SIN_CONFIRMAR] }),
      });
    });
    await page.route(/\/api\/siigo\/compuerta(\?|$)/, (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        ambiente: 'pruebas', modo: 'real', compuertaActiva: true,
        emisionRealHabilitada: false, motivos: [], conceptosEvaluados: [],
      }),
    }));

    await page.goto('/siigo/parametrizacion');
    await expect(page.getByText('Cargando la parametrización…')).toBeVisible();

    // 2. Lleno.
    soltar!();
    await expect(page.getByText('FLIT-SOAT')).toBeVisible();
  });

  test('vacío explica cuál es el primer paso', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockMapeo(page, []);
    await page.goto('/siigo/parametrizacion');

    await expect(page.getByText('Todavía no hay conceptos en este ambiente.')).toBeVisible();
    // Un vacío que no dice qué hacer es un callejón sin salida.
    await expect(page.getByText(/aplicar las migraciones pendientes/)).toBeVisible();
  });

  test('el error ofrece reintentar, y el reintento vuelve a pedir', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    let intentos = 0;
    await page.route(/\/api\/siigo\/mapeo-conceptos\?/, (route) => {
      intentos += 1;
      if (intentos === 1) {
        return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Se cayó la base' }) });
      }
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ambiente: 'pruebas', data: [SIN_CONFIRMAR] }),
      });
    });
    await page.route(/\/api\/siigo\/compuerta(\?|$)/, (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        ambiente: 'pruebas', modo: 'real', compuertaActiva: true,
        emisionRealHabilitada: false, motivos: [], conceptosEvaluados: [],
      }),
    }));

    await page.goto('/siigo/parametrizacion');
    await page.getByRole('button', { name: 'Reintentar' }).click();

    await expect(page.getByText('FLIT-SOAT')).toBeVisible();
    expect(intentos).toBeGreaterThan(1);
  });
});

test.describe('AC3 — estado por concepto de un vistazo', () => {
  test('los tres estados se distinguen y se ven los cinco datos', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockMapeo(page, [SIN_MAPEAR, SIN_CONFIRMAR, CONFIRMADO]);
    await page.goto('/siigo/parametrizacion');

    await expect(page.getByText('Sin mapear')).toBeVisible();
    await expect(page.getByText('Sin confirmar')).toBeVisible();
    await expect(page.getByText('Confirmado', { exact: true })).toBeVisible();

    // Producto, clasificación, unidad, terceros y confirmación, todo en la fila.
    await expect(page.getByText('FLIT-TRAMITE-DIGITAL')).toBeVisible();
    await expect(page.getByText('Gravado')).toBeVisible();
    await expect(page.getByText('94').first()).toBeVisible();
    // AC5 — quién y cuándo, visible.
    await expect(page.getByText(/Usuario 7/)).toBeVisible();
  });

  test('un producto que dejó de ser válido se señala en la fila', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockMapeo(page, [{
      ...SIN_CONFIRMAR,
      validacionEstado: 'inactivo',
      validacionMensaje: 'El producto FLIT-SOAT existe en Siigo pero está INACTIVO.',
    }]);
    await page.goto('/siigo/parametrizacion');

    await expect(page.getByText(/está INACTIVO/)).toBeVisible();
  });
});

test.describe('AC4 y AC5 — edición, validación y consecuencia de la confirmación', () => {
  test('el mensaje del servidor se muestra y el valor anterior sigue visible', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockMapeo(page, [SIN_CONFIRMAR]);
    await page.route(/\/api\/siigo\/mapeo-conceptos\/[0-9a-f-]+$/, (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      return route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'El producto NO-EXISTE no existe en Siigo en el ambiente pruebas.', codigo: 'validacion' }),
      });
    });

    await page.goto('/siigo/parametrizacion');
    await page.getByRole('button', { name: 'Editar' }).click();
    await page.getByLabel('Código de producto en Siigo').fill('NO-EXISTE');
    await page.getByRole('button', { name: 'Guardar' }).click();

    // El mensaje es el TRADUCIDO POR EL SERVIDOR, no uno inventado por la pantalla.
    await expect(page.getByText(/no existe en Siigo en el ambiente pruebas/)).toBeVisible();
    // Y el valor anterior sigue a la vista: el modal no se cerró.
    await expect(page.getByText('Valor actual:')).toBeVisible();
  });

  test('editar un campo tributario de un concepto confirmado avisa que la confirmación se perderá', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockMapeo(page, [CONFIRMADO]);
    await page.goto('/siigo/parametrizacion');

    await page.getByRole('button', { name: 'Editar' }).click();
    // Antes de tocar nada, no hay aviso.
    await expect(page.getByText(/la confirmación se perderá/i)).toHaveCount(0);

    await page.getByLabel('Clasificación tributaria').selectOption('exento');

    // El aviso llega ANTES de guardar: que se caiga sin avisar es lo que hace que se deje de
    // confiar en la confirmación.
    await expect(page.getByText(/la confirmación se perderá/i)).toBeVisible();
  });

  test('un código con formato inválido no llega a enviarse', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockMapeo(page, [SIN_CONFIRMAR]);
    let enviado = false;
    await page.route(/\/api\/siigo\/mapeo-conceptos\/[0-9a-f-]+$/, (route) => {
      if (route.request().method() === 'PATCH') enviado = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/siigo/parametrizacion');
    await page.getByRole('button', { name: 'Editar' }).click();
    await page.getByLabel('Código de producto en Siigo').fill('CON ESPACIOS');

    await expect(page.getByText(/sin espacios y máximo 30/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Guardar' })).toBeDisabled();
    expect(enviado).toBe(false);
  });
});

test.describe('AC6 — crear el producto faltante desde la fila', () => {
  test('propone el código, deja ajustarlo y avisa de que no marca la confirmación', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockMapeo(page, [SIN_MAPEAR]);
    await page.route(/\/api\/siigo\/parametrizacion\/catalogos\/account_group/, (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          tipo: 'account_group', etiqueta: 'Grupos de inventario', ambiente: 'pruebas',
          sincronizadoEn: '2026-08-06T09:00:00Z',
          elementos: [{ codigo: '1253', nombre: 'Servicios de trámites', activo: true }],
        }),
      }));

    let cuerpo: Record<string, unknown> | null = null;
    await page.route(/\/api\/siigo\/mapeo-conceptos\/[0-9a-f-]+\/producto$/, (route) => {
      cuerpo = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({
        status: 201, contentType: 'application/json',
        body: JSON.stringify({ desenlace: 'creado', codigo: 'FLIT-LOGISTICA-2', nombre: 'Servicio de logística' }),
      });
    });

    await page.goto('/siigo/parametrizacion');
    await page.getByRole('button', { name: 'Crear producto' }).click();

    // El código propuesto se deriva del concepto.
    await expect(page.getByLabel('Código del producto')).toHaveValue('FLIT-LOGISTICA');
    // Y la pantalla dice que crear no es firmar.
    await expect(page.getByText(/no se marca\s*automáticamente/i)).toBeVisible();

    await page.getByLabel('Código del producto').fill('FLIT-LOGISTICA-2');
    await page.getByLabel('Grupo de inventario').selectOption('1253');
    await page.getByRole('button', { name: 'Crear y vincular' }).click();

    await expect.poll(() => cuerpo).toMatchObject({
      codigo: 'FLIT-LOGISTICA-2', grupoInventarioCodigo: '1253',
    });
  });

  test('sin grupos sincronizados avisa y no deja crear', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockMapeo(page, [SIN_MAPEAR]);
    await page.route(/\/api\/siigo\/parametrizacion\/catalogos\/account_group/, (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ tipo: 'account_group', elementos: [] }),
      }));

    await page.goto('/siigo/parametrizacion');
    await page.getByRole('button', { name: 'Crear producto' }).click();

    await expect(page.getByText(/Sincroniza los catálogos/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Crear y vincular' })).toBeDisabled();
  });
});

test.describe('AC7 — el modo simulado se señaliza', () => {
  test('aviso permanente que además aclara que la compuerta no aplica', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockMapeo(page, [SIN_CONFIRMAR], 'mock');
    await page.goto('/siigo/parametrizacion');

    // Permanente: no es un toast que se va y deja la pantalla igual que en modo real.
    await expect(page.getByText(/los datos vienen del simulador/i)).toBeVisible();
    await expect(page.getByText(/no aplica/i)).toBeVisible();
  });

  test('en modo real no hay aviso de simulador', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockMapeo(page, [SIN_CONFIRMAR], 'real');
    await page.goto('/siigo/parametrizacion');

    await expect(page.getByText('FLIT-SOAT')).toBeVisible();
    await expect(page.getByText(/los datos vienen del simulador/i)).toHaveCount(0);
  });
});
