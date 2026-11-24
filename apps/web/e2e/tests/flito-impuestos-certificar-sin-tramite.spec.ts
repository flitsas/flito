import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { funcionesDe, loginAs, OPERACIONES_USER } from '../helpers/auth';

// FLITO — Impuestos · «Certificar sin trámite» (Épica ADO 14163) como pestaña de /flito/impuestos.
// API mockeada con `page.route` (sin RUNT, OCR ni BD), mismo patrón que `flito-impuestos-*`. La sesión
// sale de `loginAs` (token y /me de fixture): el spec no usa credenciales reales.

const FN = 'impuestos.certificacion_directa.gestionar';
const CON = [...funcionesDe(OPERACIONES_USER), FN];
const SIN = funcionesDe(OPERACIONES_USER).filter((f) => f !== FN);
const API = /\/api\/flito\/impuestos\/certificacion-directa/;
const PDF_VALIDO = Buffer.from('%PDF-1.4\n%%EOF');
const FACTURA = { name: 'factura.pdf', mimeType: 'application/pdf', buffer: PDF_VALIDO };
const LECTURA = { vin: '9BGEB69K0TG118228', marca: 'Chevrolet', linea: 'Onix', anio: '2026', color: 'Blanco', cilindrada: '1200', aviso: null };

const fila = (extra: Record<string, unknown> = {}) => ({
  id: 'c1', placa: 'ABC123',
  tipoDocumentoPropietario: 'CC', documentoPropietario: '10101010', nombrePropietario: 'Ana Pérez', ...LECTURA, aviso: undefined,
  estado: 'radicado', comparacion: null, certificadoEn: null, createdAt: '2026-10-01T12:00:00Z', ...extra,
});

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Cola de impuestos (la pestaña por defecto). */
async function mockBase(page: Page) {
  await page.route(/\/api\/flito\/impuestos\/facetas/, (r) => r.fulfill(json({ companias: [], organismos: [] })));
  await page.route(/\/api\/flito\/impuestos\?/, (r) => r.fulfill(json({ items: [], total: 0, page: 1, pageSize: 50 })));
}

async function irACertificar(page: Page, funciones: string[] = CON) {
  await loginAs(page, OPERACIONES_USER, { funciones });
  await mockBase(page);
}

const nueva = async (page: Page) => {
  await page.goto('/flito/impuestos/certificar');
  await page.getByRole('button', { name: 'Nueva certificación' }).click();
};
const guardar = (page: Page) => page.getByRole('button', { name: 'Guardar', exact: true });

test.describe('FLITO — Impuestos · Certificar sin trámite', () => {
  test('1 · la pestaña solo existe con la función; la ruta antigua ya no existe', async ({ page }) => {
    await irACertificar(page);
    await page.route(API, (r) => r.fulfill(json([])));
    await page.goto('/flito/impuestos');
    const tabs = page.getByRole('tablist', { name: 'Secciones de Impuestos' });
    await expect(tabs.getByRole('tab', { name: 'Impuestos', exact: true })).toHaveAttribute('aria-selected', 'true');
    await tabs.getByRole('tab', { name: 'Certificar sin trámite' }).click();
    await expect(page).toHaveURL(/\/flito\/impuestos\/certificar$/);
    await expect(page.getByRole('heading', { name: 'Certificar sin trámite' })).toBeVisible();

    // La ruta antigua no se sirve.
    await page.goto('/flito/certificar-impuesto');
    await expect(page.getByRole('heading', { name: 'Certificar sin trámite' })).toHaveCount(0);
  });

  test('1b · sin la función no se pinta la barra de pestañas', async ({ page }) => {
    await irACertificar(page, SIN);
    await page.goto('/flito/impuestos');
    await expect(page.getByRole('heading', { name: 'Impuestos', exact: true })).toBeVisible();
    await expect(page.getByRole('tablist')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Certificar sin trámite' })).toHaveCount(0);
  });

  test('2 · listado propio sin «Compañía»; vacío con copy propio; error con «Reintentar»', async ({ page }) => {
    await irACertificar(page);
    // Modo y no contador: en desarrollo React monta el efecto dos veces y duplicaría la petición.
    let modo: 'vacio' | 'error' | 'ok' = 'vacio';
    await page.route(API, (r) => {
      if (r.request().method() !== 'GET' || /\/catalogo|\/factura/.test(r.request().url())) return r.fallback();
      if (modo === 'vacio') return r.fulfill(json([]));
      if (modo === 'error') return r.fulfill(json({ error: 'fallo' }, 500));
      return r.fulfill(json([fila()]));
    });
    await page.goto('/flito/impuestos/certificar');
    await expect(page.getByText('Todavía no hay certificaciones. Carga una factura de venta para empezar.')).toBeVisible();

    // Segundo listado: error, con salida de reintento.
    modo = 'error';
    await page.getByRole('tab', { name: 'Impuestos', exact: true }).click();
    await page.getByRole('tab', { name: 'Certificar sin trámite' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    modo = 'ok';
    await page.getByRole('button', { name: 'Reintentar' }).click();

    // HU #14665: orden canónico del patrón unificado; Placa y VIN se funden en «Vehículo».
    for (const col of ['Vehículo', 'Estado', 'Propietario', 'Registrado']) {
      await expect(page.getByRole('columnheader', { name: col, exact: true })).toBeVisible();
    }
    for (const col of ['Placa', 'VIN', 'Compañía']) {
      await expect(page.getByRole('columnheader', { name: col, exact: true })).toHaveCount(0);
    }
    await expect(page.getByRole('row').filter({ hasText: 'ABC123' })).toContainText('Guardado');
  });

  test('3 · alta: primero la factura; lectura automática sin botón; chips «Leído»; Guardar se habilita', async ({ page }) => {
    await irACertificar(page);
    let soltar!: () => void;
    const gate = new Promise<void>((res) => { soltar = res; });
    let lecturas = 0;
    await page.route(/\/certificacion-directa\/extraer$/, async (r) => {
      lecturas += 1;
      await gate;
      await r.fulfill(json(LECTURA));
    });
    await nueva(page);

    // Antes de elegir archivo: solo la caja de carga y Guardar deshabilitado.
    await expect(page.locator('input[type="file"]')).toHaveCount(1);
    await expect(guardar(page)).toBeDisabled();
    await expect(page.getByLabel(/^Placa/)).toHaveCount(0);

    await page.locator('input[type="file"]').setInputFiles(FACTURA);
    await expect(page.getByText('Leyendo la factura…')).toBeVisible();
    soltar();
    await expect(page.getByText('Leímos la factura. Revisa los datos antes de guardar.')).toBeVisible();
    expect(lecturas).toBe(1);
    await expect(page.getByRole('button', { name: 'Leer factura' })).toHaveCount(0);
    await expect(page.getByText('Leído', { exact: true })).toHaveCount(6);
    await expect(page.getByLabel('VIN', { exact: true })).toHaveValue(LECTURA.vin);
    await expect(page.getByText('Compañía')).toHaveCount(0);

    // Todo lo obligatorio llega de la lectura y ya no hay organismo que elegir (HU #14665): listo de inmediato.
    await expect(page.getByText('Listo para guardar.')).toBeVisible();
    await expect(guardar(page)).toBeEnabled();
    await page.getByLabel(/^Placa/).fill('ABC123');
    await page.getByLabel('Documento del propietario (opcional)').fill('10101010');
    await page.getByLabel('Tipo de documento', { exact: true }).selectOption('CC');
    await page.getByLabel('Nombre del propietario (opcional)').fill('Ana Pérez');
    await expect(page.getByText('Listo para guardar.')).toBeVisible();
    await expect(guardar(page)).toBeEnabled();
  });

  test('4 · lectura parcial nombra los campos; si el formulario difiere ofrece «Usar este dato»', async ({ page }) => {
    await irACertificar(page);
    await page.route(/\/certificacion-directa\/extraer$/, (r) =>
      r.fulfill(json({ ...LECTURA, linea: '', anio: '', color: '', cilindrada: '' })));
    await nueva(page);
    await page.locator('input[type="file"]').setInputFiles(FACTURA);

    await expect(page.getByText('No pudimos leer: línea, año, color, cilindraje.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reintentar lectura' })).toBeVisible();

    // El gestor escribe otro valor y la relectura no lo pisa: avisa de la diferencia.
    await page.getByLabel('Marca', { exact: true }).fill('Renault');
    await page.getByRole('button', { name: 'Reintentar lectura' }).click();
    await expect(page.getByText('Algunos datos del formulario no coinciden con esta factura.')).toBeVisible();
    await expect(page.getByLabel('Marca', { exact: true })).toHaveValue('Renault');
    const ayuda = page.locator('#cert-marca-ayuda');
    await expect(ayuda).toContainText('La factura dice: Chevrolet');

    await ayuda.getByRole('button', { name: 'Usar este dato' }).click();
    await expect(page.getByLabel('Marca', { exact: true })).toHaveValue('Chevrolet');
    await expect(ayuda).toHaveCount(0);
  });

  test('5 · un archivo que no es PDF no muestra errores crudos ni «Invalid PDF structure»', async ({ page }) => {
    await irACertificar(page);
    await page.route(/\/certificacion-directa\/extraer$/, (r) =>
      r.fulfill(json({ error: 'La factura de venta debe ser un PDF' }, 400)));
    await nueva(page);
    await page.locator('input[type="file"]').setInputFiles({ name: 'falsa.pdf', mimeType: 'application/pdf', buffer: Buffer.from('esto es texto plano') });

    await expect(page.getByText('No pudimos leer la factura.')).toBeVisible();
    await expect(page.getByText('No pudimos mostrar la vista previa de esta factura.')).toBeVisible();
    await expect(page.getByText(/Invalid PDF structure/i)).toHaveCount(0);
    await expect(page.getByText('La factura de venta debe ser un PDF')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Ampliar factura' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reemplazar factura', exact: false })).toHaveCount(0);
  });

  test('6 · registro guardado: vista previa y lupa; sin «Descargar factura»; consultar RUNT (no coincide y certificado)', async ({ page }) => {
    await irACertificar(page);
    let estado: 'sin_coincidencia' | 'certificado' = 'sin_coincidencia';
    const comparacion = [{ campo: 'vin', valorFactura: LECTURA.vin, valorRunt: '9BGEB69K0TG000000', resultado: 'difiere' }];
    await page.route(API, async (r) => {
      const url = r.request().url();
      const metodo = r.request().method();
      if (/\/catalogo$/.test(url)) return r.fallback();
      if (/\/c1\/factura$/.test(url)) return r.fulfill({ status: 200, contentType: 'application/pdf', body: PDF_VALIDO });
      if (/\/c1\/consultar$/.test(url) && metodo === 'POST') {
        return r.fulfill(json(fila(estado === 'certificado'
          ? { estado, comparacion: comparacion.map((c) => ({ ...c, valorRunt: c.valorFactura, resultado: 'coincide' })), certificadoEn: '2026-10-02T12:00:00Z' }
          : { estado, comparacion })));
      }
      if (metodo === 'GET' && /certificacion-directa$/.test(url)) return r.fulfill(json([fila()]));
      return r.fallback();
    });
    await page.goto('/flito/impuestos/certificar');
    await page.getByRole('row').filter({ hasText: 'ABC123' }).getByRole('button', { name: 'Abrir' }).click();

    await expect(page.getByRole('button', { name: 'Descargar factura' })).toHaveCount(0);
    const lupa = page.getByRole('button', { name: 'Ampliar factura' });
    await expect(lupa).toHaveAttribute('aria-pressed', 'false');
    await lupa.click();
    const reducir = page.getByRole('button', { name: 'Reducir factura' });
    await expect(reducir).toHaveAttribute('aria-pressed', 'true');
    await reducir.click();
    await expect(page.getByRole('button', { name: 'Ampliar factura' })).toHaveAttribute('aria-pressed', 'false');

    await page.getByRole('button', { name: 'Consultar RUNT' }).click();
    await expect(page.getByText('No coincide', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Comparación con el RUNT' })).toContainText('Difiere');
    await expect(page.getByRole('button', { name: 'Descargar certificado' })).toHaveCount(0);

    estado = 'certificado';
    await page.getByRole('button', { name: 'Consultar RUNT' }).click();
    await expect(page.getByText('Certificado', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Descargar certificado' })).toBeVisible();
  });

  test('7 · en móvil (<1024 px) no se monta la vista previa ni se pide la factura', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await irACertificar(page);
    let pidioFactura = false;
    await page.route(API, (r) => {
      const url = r.request().url();
      if (/\/c1\/factura$/.test(url)) { pidioFactura = true; return r.fulfill({ status: 200, contentType: 'application/pdf', body: PDF_VALIDO }); }
      if (r.request().method() === 'GET' && /certificacion-directa$/.test(url)) return r.fulfill(json([fila()]));
      return r.fallback();
    });
    await page.goto('/flito/impuestos/certificar');
    await page.getByRole('row').filter({ hasText: 'ABC123' }).getByRole('button', { name: 'Abrir' }).click();
    await expect(page.getByLabel(/^Placa/)).toHaveValue('ABC123');
    await page.waitForTimeout(500);
    expect(pidioFactura).toBe(false);
    await expect(page.getByRole('button', { name: 'Ampliar factura' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: /^Páginas de/ })).toHaveCount(0);
  });

  test('8 · alta sin propietario: se guarda, y el VIN sigue siendo obligatorio (la placa ya no)', async ({ page }) => {
    await irACertificar(page);
    await page.route(/\/certificacion-directa\/extraer$/, (r) => r.fulfill(json(LECTURA)));
    let cuerpo = '';
    await page.route(API, (r) => {
      const url = r.request().url();
      const metodo = r.request().method();
      if (metodo === 'POST' && /certificacion-directa$/.test(url)) {
        cuerpo = r.request().postDataBuffer()?.toString('latin1') ?? '';
        return r.fulfill(json(fila({ tipoDocumentoPropietario: null, documentoPropietario: null, nombrePropietario: null })));
      }
      if (metodo === 'GET' && /certificacion-directa$/.test(url)) return r.fulfill(json([]));
      if (/\/c1\/factura$/.test(url)) return r.fulfill({ status: 200, contentType: 'application/pdf', body: PDF_VALIDO });
      return r.fallback();
    });
    await nueva(page);
    await page.locator('input[type="file"]').setInputFiles(FACTURA);
    await expect(page.getByLabel('VIN', { exact: true })).toHaveValue(LECTURA.vin);

    // Todo llegó de la lectura: listo de inmediato, sin organismo que exigir (HU #14665).
    await expect(page.getByText('Listo para guardar.')).toBeVisible();
    await page.getByLabel(/^Placa/).fill('ABC123');

    // El propietario no cuenta y la placa ya no es obligatoria, pero el VIN sí.
    await page.getByLabel('VIN', { exact: true }).fill('');
    await expect(page.getByText(/1 dato para guardar\.$/)).toBeVisible();
    await expect(guardar(page)).toBeDisabled();
    await page.getByLabel('VIN', { exact: true }).fill(LECTURA.vin);
    await expect(page.getByText('Listo para guardar.')).toBeVisible();

    await guardar(page).click();
    await expect(page.getByText('El registro quedó guardado. Consulta el RUNT cuando quieras.')).toBeVisible();
    expect(cuerpo).toMatch(/name="documentoPropietario"\r\n\r\n\r\n/);
    expect(cuerpo).toMatch(/name="tipoDocumentoPropietario"\r\n\r\n\r\n/);
    expect(cuerpo).toMatch(/name="nombrePropietario"\r\n\r\n\r\n/);
    // El null del API llega al formulario como campo vacío, sin «null» ni aviso de obligatorio.
    await expect(page.getByLabel('Documento del propietario (opcional)')).toHaveValue('');
    await expect(page.getByLabel('Nombre del propietario (opcional)')).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Consultar RUNT' })).toBeEnabled();
  });

  test('9 · el formulario dice que el RUNT siempre se consulta por VIN', async ({ page }) => {
    await irACertificar(page);
    await page.route(/\/certificacion-directa\/extraer$/, (r) => r.fulfill(json(LECTURA)));
    await nueva(page);
    await page.locator('input[type="file"]').setInputFiles(FACTURA);
    const ayuda = 'El RUNT se consulta siempre por VIN. El documento y el nombre son datos informativos que '
      + 'se guardan con el registro y aparecen en el certificado cuando estén diligenciados.';
    await expect(page.getByText(ayuda)).toBeVisible();
    await expect(page.getByLabel('Documento del propietario (opcional)')).toHaveAccessibleDescription(ayuda);
    await expect(page.getByLabel('Tipo de documento', { exact: true })).toHaveAccessibleDescription(ayuda);
    await expect(page.getByText('Con documento, elige el tipo', { exact: false })).toHaveCount(0);
    await expect(page.getByText('placa y documento', { exact: false })).toHaveCount(0);
  });

  test('10 · sin nombre, la columna Propietario muestra un marcador', async ({ page }) => {
    await irACertificar(page);
    await page.route(API, (r) => {
      if (r.request().method() === 'GET' && /certificacion-directa$/.test(r.request().url())) {
        return r.fulfill(json([fila({ nombrePropietario: null, documentoPropietario: null })]));
      }
      return r.fallback();
    });
    await page.goto('/flito/impuestos/certificar');
    // Índice 3: la casilla de selección (HU #14665, AC7/AC8) ocupa la columna 0.
    const celdas = page.getByRole('row').filter({ hasText: 'ABC123' }).getByRole('cell');
    await expect(celdas.nth(3)).toHaveText('—');
    await expect(page.getByText('null')).toHaveCount(0);
  });

  const FALTA_TIPO = 'Falta el tipo de documento del propietario';
  const tipoDoc = (page: Page) => page.getByLabel('Tipo de documento', { exact: true });
  const documento = (page: Page) => page.getByLabel('Documento del propietario (opcional)');

  /** Alta con la factura leída y lo obligatorio diligenciado; el propietario queda para cada caso. */
  async function altaCompleta(page: Page) {
    await nueva(page);
    await page.locator('input[type="file"]').setInputFiles(FACTURA);
    await expect(page.getByLabel('VIN', { exact: true })).toHaveValue(LECTURA.vin);
    await page.getByLabel(/^Placa/).fill('ABC123');
    await expect(page.getByText('Listo para guardar.')).toBeVisible();
  }

  /** Listado con una fila, su factura y, opcionalmente, una respuesta para consultar. */
  async function conFila(page: Page, base: ReturnType<typeof fila>, alConsultar?: () => { status: number; contentType: string; body: string }) {
    await page.route(API, (r) => {
      const url = r.request().url();
      const metodo = r.request().method();
      if (/\/c1\/factura$/.test(url)) return r.fulfill({ status: 200, contentType: 'application/pdf', body: PDF_VALIDO });
      if (/\/c1\/consultar$/.test(url) && metodo === 'POST' && alConsultar) return r.fulfill(alConsultar());
      if (metodo === 'GET' && /certificacion-directa$/.test(url)) return r.fulfill(json([base]));
      return r.fallback();
    });
    await page.goto('/flito/impuestos/certificar');
    await page.getByRole('row').filter({ hasText: 'ABC123' }).getByRole('button', { name: 'Abrir' }).click();
  }

  test('12 · con documento y sin tipo no se guarda: el tipo cuenta como dato faltante', async ({ page }) => {
    await irACertificar(page);
    await page.route(/\/certificacion-directa\/extraer$/, (r) => r.fulfill(json(LECTURA)));
    await page.route(API, (r) => (r.request().method() === 'GET' && /certificacion-directa$/.test(r.request().url()) ? r.fulfill(json([])) : r.fallback()));
    await altaCompleta(page);

    // Sin documento el tipo es opcional y no se marca como obligatorio vacío.
    await expect(tipoDoc(page)).not.toHaveAttribute('required');
    await expect(guardar(page)).toBeEnabled();

    await documento(page).fill('10101010');
    await expect(page.getByText('Faltan 1 dato para guardar.')).toBeVisible();
    await expect(tipoDoc(page)).toHaveAttribute('required');
    await expect(guardar(page)).toBeDisabled();

    await tipoDoc(page).selectOption('CC');
    await expect(page.getByText('Listo para guardar.')).toBeVisible();
    await expect(guardar(page)).toBeEnabled();
  });

  test('13 · el tipo elegido viaja en el POST con su valor de UI, no con el código RUNT', async ({ page }) => {
    await irACertificar(page);
    await page.route(/\/certificacion-directa\/extraer$/, (r) => r.fulfill(json(LECTURA)));
    let cuerpo = '';
    await page.route(API, (r) => {
      const url = r.request().url();
      const metodo = r.request().method();
      if (metodo === 'POST' && /certificacion-directa$/.test(url)) {
        cuerpo = r.request().postDataBuffer()?.toString('latin1') ?? '';
        return r.fulfill(json(fila({ tipoDocumentoPropietario: 'CE' })));
      }
      if (metodo === 'GET' && /certificacion-directa$/.test(url)) return r.fulfill(json([]));
      if (/\/c1\/factura$/.test(url)) return r.fulfill({ status: 200, contentType: 'application/pdf', body: PDF_VALIDO });
      return r.fallback();
    });
    await altaCompleta(page);
    await documento(page).fill('10101010');
    await tipoDoc(page).selectOption('CE');
    await guardar(page).click();

    await expect(page.getByText('El registro quedó guardado. Consulta el RUNT cuando quieras.')).toBeVisible();
    expect(cuerpo).toMatch(/name="tipoDocumentoPropietario"\r\n\r\nCE\r\n/);
    await expect(tipoDoc(page)).toHaveValue('CE');
  });

  test('14 · borrar el documento limpia el tipo, y sin documento se puede guardar', async ({ page }) => {
    await irACertificar(page);
    await page.route(/\/certificacion-directa\/extraer$/, (r) => r.fulfill(json(LECTURA)));
    await page.route(API, (r) => (r.request().method() === 'GET' && /certificacion-directa$/.test(r.request().url()) ? r.fulfill(json([])) : r.fallback()));
    await altaCompleta(page);
    await documento(page).fill('10101010');
    await tipoDoc(page).selectOption('NIT');
    await expect(tipoDoc(page)).toHaveValue('NIT');

    await documento(page).fill('');
    await expect(tipoDoc(page)).toHaveValue('');
    await expect(page.getByText('Listo para guardar.')).toBeVisible();
    await expect(guardar(page)).toBeEnabled();
  });

  test('15 · registro antiguo con documento y sin tipo: pide el tipo y no deja consultar hasta elegirlo', async ({ page }) => {
    await irACertificar(page);
    let consultas = 0;
    await conFila(page, fila({ tipoDocumentoPropietario: null }), () => { consultas += 1; return json(fila()); });

    await expect(page.getByText('Faltan 1 dato para guardar.')).toBeVisible();
    await expect(tipoDoc(page)).toHaveValue('');
    const consultarRunt = page.getByRole('button', { name: 'Consultar RUNT' });
    await expect(consultarRunt).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Guardar cambios' })).toBeDisabled();
    expect(consultas).toBe(0);

    await tipoDoc(page).selectOption('CC');
    await expect(page.getByText('Listo para guardar.')).toBeVisible();
    await expect(consultarRunt).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Guardar cambios' })).toBeEnabled();
  });

  test('16 · el 400 por falta de tipo se muestra tal cual y el registro sigue editable', async ({ page }) => {
    await irACertificar(page);
    // El API aún lo ve sin tipo aunque la fila diga otra cosa (otra pestaña, otro usuario).
    await conFila(page, fila(), () => json({ error: FALTA_TIPO }, 400));
    await page.getByRole('button', { name: 'Consultar RUNT' }).click();
    await expect(page.getByRole('alert').filter({ hasText: FALTA_TIPO })).toHaveText(FALTA_TIPO);
    await expect(tipoDoc(page)).toBeEnabled();
  });

  test('17 · un certificado antiguo sin tipo no pide nada: el selector está deshabilitado y sin marcar', async ({ page }) => {
    await irACertificar(page);
    await conFila(page, fila({ tipoDocumentoPropietario: null, estado: 'certificado', certificadoEn: '2026-10-02T12:00:00Z' }));
    await expect(page.getByRole('button', { name: 'Descargar certificado' })).toBeVisible();
    await expect(tipoDoc(page)).toBeDisabled();
    await expect(tipoDoc(page).locator('option:checked')).toHaveText('—');
    await expect(page.getByText(/para guardar\.$/)).toHaveCount(0);
  });

  test('18 · nueva certificación tras volver de un certificado: el formulario queda editable y con Guardar', async ({ page }) => {
    await irACertificar(page);
    await page.route(/\/certificacion-directa\/extraer$/, (r) => r.fulfill(json(LECTURA)));
    await conFila(page, fila({ estado: 'certificado', certificadoEn: '2026-10-02T12:00:00Z' }));
    await expect(page.getByLabel(/^Placa/)).toBeDisabled();

    await page.getByRole('button', { name: 'Volver al listado' }).click();
    await page.getByRole('button', { name: 'Nueva certificación' }).click();
    await page.locator('input[type="file"]').setInputFiles(FACTURA);
    await expect(page.getByLabel('VIN', { exact: true })).toHaveValue(LECTURA.vin);

    // Nada del certificado anterior: campos vacíos, habilitados y sin su estado ni su descarga.
    await expect(page.getByLabel(/^Placa/)).toBeEnabled();
    await expect(page.getByLabel(/^Placa/)).toHaveValue('');
    await expect(documento(page)).toBeEnabled();
    await expect(documento(page)).toHaveValue('');
    await expect(tipoDoc(page)).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Descargar certificado' })).toHaveCount(0);
    await page.getByLabel(/^Placa/).fill('XYZ987');
    await expect(guardar(page)).toBeEnabled();
  });

  const chip = (zona: Page | ReturnType<Page['getByRole']>, texto: string) => zona.getByText(texto, { exact: true });
  const SIN_DOCUMENTO = { documentoPropietario: null, tipoDocumentoPropietario: null };

  // Desde la HU #14665 la consulta RUNT es SIEMPRE por VIN: el documento ya no cambia el chip ni el
  // texto del resultado (reemplaza al Bug #14406, que sí distinguía «con documento»/«sin documento»).
  for (const caso of [
    { nombre: 'con documento', extra: {} },
    { nombre: 'sin documento', extra: SIN_DOCUMENTO },
  ]) {
    test(`19 · sin vehículo: el chip siempre dice «Sin vehículo» (${caso.nombre})`, async ({ page }) => {
      await irACertificar(page);
      await conFila(page, fila({ estado: 'sin_vehiculo', ...caso.extra }));
      await expect(chip(page, 'Sin vehículo')).toBeVisible();
      await expect(chip(page, 'No encontrado')).toHaveCount(0);

      await page.getByRole('button', { name: 'Volver al listado' }).click();
      const filaLista = page.getByRole('row').filter({ hasText: 'ABC123' });
      await expect(chip(filaLista, 'Sin vehículo')).toBeVisible();
      await expect(chip(filaLista, 'No encontrado')).toHaveCount(0);
    });
  }

  for (const caso of [
    { nombre: 'sin vehículo nombra el VIN (con o sin documento)', extra: { estado: 'sin_vehiculo' }, aviso: 'El RUNT no tiene registro de este VIN.' },
    { nombre: 'sin respuesta invita a consultar de nuevo (con o sin documento)', extra: { estado: 'sin_respuesta', ...SIN_DOCUMENTO }, aviso: 'El RUNT no respondió. El registro quedó guardado. Puedes consultar de nuevo.' },
    { nombre: 'no coincide pide corregir y consultar', extra: { estado: 'sin_coincidencia' }, aviso: 'Los datos no coinciden con el RUNT. Corrige y vuelve a consultar.' },
  ]) {
    test(`21 · al abrir el registro reaparece el aviso, informativo y no de error: ${caso.nombre}`, async ({ page }) => {
      await irACertificar(page);
      await conFila(page, fila(caso.extra));
      await expect(page.getByRole('status').filter({ hasText: caso.aviso })).toHaveText(caso.aviso);
      await expect(page.getByRole('alert').filter({ hasText: caso.aviso })).toHaveCount(0);

      // Al cambiar de vista se limpia, y no viaja a la siguiente pantalla.
      await page.getByRole('button', { name: 'Volver al listado' }).click();
      await expect(page.getByRole('button', { name: 'Nueva certificación' })).toBeVisible();
      await expect(page.getByText(caso.aviso)).toHaveCount(0);
      await page.getByRole('button', { name: 'Nueva certificación' }).click();
      await expect(page.locator('input[type="file"]')).toHaveCount(1);
      await expect(page.getByText(caso.aviso)).toHaveCount(0);
    });
  }

  for (const caso of [
    { nombre: 'guardado', extra: { estado: 'radicado' }, chipEstado: 'Guardado', aviso: 'El registro quedó guardado. Consulta el RUNT cuando quieras.' },
    { nombre: 'certificado', extra: { estado: 'certificado', certificadoEn: '2026-10-02T12:00:00Z' }, chipEstado: 'Certificado', aviso: 'Los datos coincidieron. Puedes descargar el certificado.' },
  ]) {
    test(`22 · al abrir un registro ${caso.nombre} no aparece aviso`, async ({ page }) => {
      await irACertificar(page);
      await conFila(page, fila(caso.extra));
      // El detalle ya está pintado (su chip) antes de comprobar la ausencia.
      await expect(chip(page, caso.chipEstado)).toBeVisible();
      await expect(page.getByText(caso.aviso)).toHaveCount(0);
    });
  }

  // El aviso tras consultar ya no depende del documento (HU #14665: la consulta siempre es por VIN),
  // así que `fila()` se deja con su documento por defecto y el resultado es el mismo con o sin él.
  for (const caso of [
    { nombre: 'sin vehículo', estado: 'sin_vehiculo', aviso: 'El RUNT no tiene registro de este VIN.' },
    { nombre: 'sin respuesta', estado: 'sin_respuesta', aviso: 'El RUNT no respondió. El registro quedó guardado. Puedes consultar de nuevo.' },
  ]) {
    test(`11 · aviso tras consultar: ${caso.nombre}`, async ({ page }) => {
      await irACertificar(page);
      const base = fila();
      await page.route(API, (r) => {
        const url = r.request().url();
        const metodo = r.request().method();
        if (/\/c1\/factura$/.test(url)) return r.fulfill({ status: 200, contentType: 'application/pdf', body: PDF_VALIDO });
        if (/\/c1\/consultar$/.test(url) && metodo === 'POST') return r.fulfill(json({ ...base, estado: caso.estado }));
        if (metodo === 'GET' && /certificacion-directa$/.test(url)) return r.fulfill(json([base]));
        return r.fallback();
      });
      await page.goto('/flito/impuestos/certificar');
      await page.getByRole('row').filter({ hasText: 'ABC123' }).getByRole('button', { name: 'Abrir' }).click();
      await page.getByRole('button', { name: 'Consultar RUNT' }).click();
      const aviso = page.getByRole('status').filter({ hasText: caso.aviso });
      await expect(aviso).toHaveText(caso.aviso);
    });
  }

  // --- HU #14665: placa opcional, prellenado del propietario, eliminar y descarga masiva ---

  test('23 · guardar sin placa: se guarda, la lista muestra «Sin placa» y se puede consultar', async ({ page }) => {
    await irACertificar(page);
    await page.route(/\/certificacion-directa\/extraer$/, (r) => r.fulfill(json(LECTURA)));
    let guardada: ReturnType<typeof fila> | null = null;
    await page.route(API, (r) => {
      const url = r.request().url();
      const metodo = r.request().method();
      if (metodo === 'POST' && /certificacion-directa$/.test(url)) {
        guardada = fila({ placa: null });
        return r.fulfill(json(guardada));
      }
      if (metodo === 'GET' && /certificacion-directa$/.test(url)) return r.fulfill(json(guardada ? [guardada] : []));
      if (/\/c1\/consultar$/.test(url) && metodo === 'POST') return r.fulfill(json({ ...guardada, estado: 'sin_vehiculo' }));
      return r.fallback();
    });
    await nueva(page);
    await page.locator('input[type="file"]').setInputFiles(FACTURA);
    await expect(page.getByLabel('VIN', { exact: true })).toHaveValue(LECTURA.vin);
    // La placa ya no es obligatoria: sin ella «Listo para guardar.» y sin `required` en el campo.
    await expect(page.getByLabel(/^Placa/)).not.toHaveAttribute('required');
    await expect(page.getByText('Listo para guardar.')).toBeVisible();

    await guardar(page).click();
    await expect(page.getByText('El registro quedó guardado. Consulta el RUNT cuando quieras.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Consultar RUNT' })).toBeEnabled();
    await page.getByRole('button', { name: 'Consultar RUNT' }).click();
    await expect(page.getByText('El RUNT no tiene registro de este VIN.')).toBeVisible();

    await page.getByRole('button', { name: 'Volver al listado' }).click();
    const filaLista = page.getByRole('row').filter({ hasText: LECTURA.vin });
    // Índice 1: la casilla de selección ocupa la columna 0, el Vehículo la 1 (HU #14665).
    await expect(filaLista.getByRole('cell').nth(1)).toContainText('Sin placa');
  });

  test('24 · la extracción prellena tipo de documento, documento y nombre del propietario', async ({ page }) => {
    await irACertificar(page);
    const CON_PROPIETARIO = {
      ...LECTURA, tipoDocumentoPropietario: 'CC', documentoPropietario: '900123456', nombrePropietario: 'Carlos Gómez',
    };
    await page.route(/\/certificacion-directa\/extraer$/, (r) => r.fulfill(json(CON_PROPIETARIO)));
    await nueva(page);
    await page.locator('input[type="file"]').setInputFiles(FACTURA);

    await expect(page.getByLabel('VIN', { exact: true })).toHaveValue(LECTURA.vin);
    await expect(page.getByLabel('Tipo de documento', { exact: true })).toHaveValue('CC');
    await expect(page.getByLabel('Documento del propietario (opcional)')).toHaveValue('900123456');
    await expect(page.getByLabel('Nombre del propietario (opcional)')).toHaveValue('Carlos Gómez');
  });

  test('25 · eliminar desde la fila: pide confirmación y la fila desaparece de la lista', async ({ page }) => {
    await irACertificar(page);
    let listado = [fila()];
    let borrados = 0;
    await page.route(API, (r) => {
      const url = r.request().url();
      const metodo = r.request().method();
      if (metodo === 'DELETE' && /\/c1$/.test(url)) { borrados += 1; listado = []; return r.fulfill({ status: 204 }); }
      if (metodo === 'GET' && /certificacion-directa$/.test(url)) return r.fulfill(json(listado));
      return r.fallback();
    });
    await page.goto('/flito/impuestos/certificar');
    await expect(page.getByRole('row').filter({ hasText: 'ABC123' })).toBeVisible();

    page.once('dialog', (d) => d.accept());
    await page.getByRole('row').filter({ hasText: 'ABC123' }).getByRole('button', { name: 'Eliminar', exact: true }).click();

    await expect(page.getByText('Certificación eliminada.')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'ABC123' })).toHaveCount(0);
    expect(borrados).toBe(1);
  });

  test('26 · un registro certificado no ofrece «Eliminar», ni en la fila ni en el detalle', async ({ page }) => {
    await irACertificar(page);
    await conFila(page, fila({ estado: 'certificado', certificadoEn: '2026-10-02T12:00:00Z' }));
    await expect(page.getByRole('button', { name: 'Eliminar', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Descargar certificado' })).toBeVisible();

    await page.getByRole('button', { name: 'Volver al listado' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'ABC123' }).getByRole('button', { name: 'Eliminar', exact: true })).toHaveCount(0);
  });

  test('27 · selección múltiple: eliminar seleccionados respeta lo certificado y avisa', async ({ page }) => {
    await irACertificar(page);
    let listado = [
      fila({ id: 'c1', placa: 'ABC123' }),
      fila({ id: 'c2', placa: 'DEF456', vin: 'VIN0000000000002' }),
      fila({ id: 'c3', placa: 'GHI789', vin: 'VIN0000000000003', estado: 'certificado', certificadoEn: '2026-10-02T12:00:00Z' }),
    ];
    await page.route(API, (r) => {
      const url = r.request().url();
      const metodo = r.request().method();
      if (metodo === 'POST' && /eliminar-lote$/.test(url)) {
        const cuerpo = r.request().postDataJSON() as { ids: string[] };
        expect(new URL(url).search).toBe(''); // los ids viajan en el cuerpo, nunca en la URL
        const omitidos = cuerpo.ids.filter((id) => id === 'c3');
        const eliminados = cuerpo.ids.filter((id) => id !== 'c3');
        listado = listado.filter((f) => !eliminados.includes(f.id));
        return r.fulfill(json({ eliminados, omitidos }));
      }
      if (metodo === 'GET' && /certificacion-directa$/.test(url)) return r.fulfill(json(listado));
      return r.fallback();
    });
    await page.goto('/flito/impuestos/certificar');
    await expect(page.getByRole('row').filter({ hasText: 'ABC123' })).toBeVisible();

    await page.getByLabel('Seleccionar certificación ABC123').check();
    await page.getByLabel('Seleccionar certificación DEF456').check();
    await page.getByLabel('Seleccionar certificación GHI789').check();
    await expect(page.getByText('3 seleccionado(s)')).toBeVisible();

    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Eliminar seleccionados (3)' }).click();

    await expect(page.getByText('Se eliminaron 2 registros. 1 ya estaban certificados o ya no existían y no se eliminaron.')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'ABC123' })).toHaveCount(0);
    await expect(page.getByRole('row').filter({ hasText: 'DEF456' })).toHaveCount(0);
    await expect(page.getByRole('row').filter({ hasText: 'GHI789' })).toBeVisible();
  });

  test('28 · descargar certificados en lote: sin ninguno certificado avisa y no descarga', async ({ page }) => {
    await irACertificar(page);
    await page.route(API, (r) => {
      const url = r.request().url();
      const metodo = r.request().method();
      if (metodo === 'POST' && /certificados\/zip$/.test(url)) {
        return r.fulfill({
          status: 409, contentType: 'application/json',
          body: JSON.stringify({
            error: 'x', codigo: 'zip_sin_certificados',
            omitidos: [{ identificador: 'c1', causa: 'sin_certificacion_vigente' }],
          }),
        });
      }
      if (metodo === 'GET' && /certificacion-directa$/.test(url)) return r.fulfill(json([fila()]));
      return r.fallback();
    });
    await page.goto('/flito/impuestos/certificar');
    await page.getByLabel('Seleccionar certificación ABC123').check();

    const [descarga] = await Promise.all([
      page.waitForEvent('download', { timeout: 1_000 }).catch(() => null),
      page.getByRole('button', { name: /^Descargar certificados RUNT/ }).click(),
    ]);
    expect(descarga).toBeNull();
    await expect(page.getByRole('alert').filter({ hasText: 'No se descargó nada' }))
      .toContainText('La fila marcada no tiene un certificado para descargar.');
  });

  test('29 · descargar certificados en lote: con alguno certificado dispara la descarga', async ({ page }) => {
    await irACertificar(page);
    await page.route(API, (r) => {
      const url = r.request().url();
      const metodo = r.request().method();
      if (metodo === 'POST' && /certificados\/zip$/.test(url)) {
        const cuerpo = r.request().postDataJSON() as { ids: string[] };
        expect(cuerpo.ids).toEqual(['c1']);
        return r.fulfill({
          status: 200, contentType: 'application/zip',
          headers: { 'content-disposition': 'attachment; filename="certificados-runt_20991231-2359.zip"' },
          body: 'PKFLITO-E2E',
        });
      }
      if (metodo === 'GET' && /certificacion-directa$/.test(url)) {
        return r.fulfill(json([fila({ estado: 'certificado', certificadoEn: '2026-10-02T12:00:00Z' })]));
      }
      return r.fallback();
    });
    await page.goto('/flito/impuestos/certificar');
    await page.getByLabel('Seleccionar certificación ABC123').check();

    const [descarga] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /^Descargar certificados RUNT/ }).click(),
    ]);
    expect(descarga.suggestedFilename()).toBe('certificados-runt_20991231-2359.zip');
    // `[data-tono]` y no el texto a secas: el mismo aviso existe también en una región sr-only (role="status").
    const tarjeta = page.locator('[data-tono]').filter({ hasText: 'ZIP descargado' });
    await expect(tarjeta).toContainText('certificados-runt_20991231-2359.zip');
  });
  // ── HU #14665: patrón unificado de colas (embudo, búsqueda, vacío por filtro, selección, cabecera) ──
  const CINCO = () => [
    fila({ id: 'c1', placa: 'ZZA101', vin: '9ZZDEMO0000000101', nombrePropietario: 'Ana Ejemplo Ruiz', estado: 'radicado' }),
    fila({
      id: 'c2', placa: 'ZZB202', vin: '9ZZDEMO0000000202', nombrePropietario: 'Carlos Demo Pardo', estado: 'sin_coincidencia',
      comparacion: [
        { campo: 'marca', valorFactura: 'A', valorRunt: 'B', resultado: 'difiere' },
        { campo: 'linea', valorFactura: 'A', valorRunt: 'B', resultado: 'difiere' },
        { campo: 'anio', valorFactura: '2026', valorRunt: '2026', resultado: 'coincide' },
      ],
    }),
    fila({ id: 'c3', placa: 'ZZC303', vin: '9ZZDEMO0000000303', nombrePropietario: 'Beatriz Núñez', estado: 'certificado', certificadoEn: '2026-10-02T12:00:00Z' }),
    fila({ id: 'c4', placa: null, vin: '9ZZDEMO0000000404', nombrePropietario: null, estado: 'sin_respuesta' }),
  ];
  async function conLista(page: Page, filas: unknown[]) {
    await page.route(API, (r) => (r.request().method() === 'GET' && /certificacion-directa$/.test(r.request().url())
      ? r.fulfill(json(filas)) : r.fallback()));
    await page.goto('/flito/impuestos/certificar');
  }
  const filaCon = (page: Page, t: string) => page.getByRole('row').filter({ hasText: t });
  const buscar = (page: Page) => page.getByRole('searchbox', { name: 'Buscar placa, VIN o propietario' });
  const embudo = (page: Page) => page.getByRole('group', { name: 'Estados de la certificación' });

  test('30 · «Nueva certificación» va en la cabecera del módulo; en el detalle, «Volver al listado»', async ({ page }) => {
    await irACertificar(page);
    await conLista(page, CINCO());
    const cabecera = page.locator('.page-header');
    await expect(cabecera.getByText('Certifica ante el RUNT los vehículos que no tienen trámite en FLITO.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Nueva certificación' })).toHaveCount(1);
    await expect(cabecera.getByRole('button', { name: 'Nueva certificación' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Certificar sin trámite' })).toBeAttached();
    await expect(page.getByText('Quien tiene el permiso ve los registros')).toHaveCount(0);
    // Sin panel propio: no hay botón «Filtros» que abriría un panel vacío.
    await expect(page.getByRole('button', { name: 'Filtros', exact: true })).toHaveCount(0);

    await filaCon(page, 'ZZA101').getByRole('button', { name: 'Abrir' }).click();
    await expect(cabecera.getByRole('button', { name: 'Volver al listado' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Nueva certificación' })).toHaveCount(0);

    // La cola de Impuestos conserva su propio subtítulo.
    await page.getByRole('tab', { name: 'Impuestos', exact: true }).click();
    await expect(cabecera.getByText('Cola de pago del impuesto vehicular: de Pendiente a Pagado.')).toBeVisible();
  });

  test('31 · celdas: Vehículo con placa/VIN/marca, «n datos no coinciden» y fecha de certificado', async ({ page }) => {
    await irACertificar(page);
    await conLista(page, CINCO());
    await expect(filaCon(page, 'ZZA101')).toContainText('Chevrolet Onix · 2026');
    await expect(filaCon(page, 'ZZB202')).toContainText('2 datos no coinciden');
    await expect(filaCon(page, 'ZZC303')).toContainText('Certificado 02/10/2026');
    await expect(filaCon(page, '9ZZDEMO0000000404')).toContainText('Sin placa');
    await expect(filaCon(page, 'ZZA101')).toContainText('01/10/2026');
  });

  test('32 · el embudo filtra por estado y la búsqueda por placa, VIN o propietario (sin tildes), sin tocar la URL', async ({ page }) => {
    await irACertificar(page);
    let pedidas = 0;
    await page.route(API, (r) => {
      if (r.request().method() === 'GET' && /certificacion-directa$/.test(r.request().url())) { pedidas += 1; return r.fulfill(json(CINCO())); }
      return r.fallback();
    });
    await page.goto('/flito/impuestos/certificar');
    await expect(filaCon(page, 'ZZA101')).toBeVisible();
    const antes = pedidas;

    await embudo(page).getByRole('button', { name: 'No coincide' }).click();
    await expect(filaCon(page, 'ZZB202')).toBeVisible();
    await expect(filaCon(page, 'ZZA101')).toHaveCount(0);
    await embudo(page).getByRole('button', { name: 'Todos' }).click();
    await expect(filaCon(page, 'ZZA101')).toBeVisible();

    await buscar(page).fill('zza-1');
    await expect(filaCon(page, 'ZZA101')).toBeVisible();
    await expect(filaCon(page, 'ZZB202')).toHaveCount(0);

    await buscar(page).fill('0000000303');
    await expect(filaCon(page, 'ZZC303')).toBeVisible();
    await expect(filaCon(page, 'ZZA101')).toHaveCount(0);

    await buscar(page).fill('nunez');
    await expect(filaCon(page, 'Beatriz Núñez')).toBeVisible();
    await expect(filaCon(page, 'ZZB202')).toHaveCount(0);

    // Y lógico: propietario de un «Certificado» + embudo en «Guardado» → nada.
    await embudo(page).getByRole('button', { name: 'Guardado' }).click();
    await expect(filaCon(page, 'ZZC303')).toHaveCount(0);

    expect(pedidas).toBe(antes); // filtra en el navegador: ninguna petición nueva
    expect(page.url()).not.toMatch(/nunez|zza|0000000303/i); // Ley 1581: nada buscado en la URL
  });

  test('33 · vacío por filtro con «Limpiar filtros»; con 100 filas, la nota del tope', async ({ page }) => {
    await irACertificar(page);
    const cien = Array.from({ length: 100 }, (_, i) => fila({ id: `x${i}`, placa: `ZZX${String(i).padStart(3, '0')}`, vin: `9ZZDEMO${String(i).padStart(10, '0')}` }));
    await conLista(page, cien);
    await expect(page.getByText('Se muestran las 100 certificaciones más recientes.')).toBeVisible();

    await buscar(page).fill('NOEXISTE');
    await expect(page.getByText('Ninguna certificación coincide con los filtros.', { exact: false })).toBeVisible();
    await expect(page.getByText('La búsqueda solo cubre las 100 certificaciones más recientes.')).toBeVisible();
    await expect(page.getByText('Todavía no hay certificaciones.', { exact: false })).toHaveCount(0);

    await page.getByRole('button', { name: 'Limpiar filtros' }).click();
    await expect(buscar(page)).toHaveValue('');
    await expect(filaCon(page, 'ZZX000')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Limpiar filtros' })).toHaveCount(0);
  });

  test('34 · con menos de 100 filas no hay nota del tope', async ({ page }) => {
    await irACertificar(page);
    await conLista(page, CINCO());
    await expect(filaCon(page, 'ZZA101')).toBeVisible();
    await expect(page.getByText('Se muestran las 100 certificaciones más recientes.')).toHaveCount(0);
  });

  test('35 · al filtrar, la selección se recorta a las filas visibles', async ({ page }) => {
    await irACertificar(page);
    await conLista(page, CINCO());
    await page.getByLabel('Seleccionar certificación ZZA101').check();
    await page.getByLabel('Seleccionar certificación ZZB202').check();
    await expect(page.getByRole('button', { name: 'Eliminar seleccionados (2)' })).toBeVisible();

    await buscar(page).fill('ZZB');
    await expect(page.getByRole('button', { name: 'Eliminar seleccionados (1)' })).toBeVisible();
    // Quitar el filtro no devuelve la marca oculta: se recortó.
    await page.getByRole('button', { name: 'Limpiar filtros' }).click();
    await expect(page.getByRole('button', { name: 'Eliminar seleccionados (1)' })).toBeVisible();
    await expect(page.getByLabel('Seleccionar certificación ZZA101')).not.toBeChecked();

    // La casilla del encabezado marca solo lo visible.
    await embudo(page).getByRole('button', { name: 'Sin respuesta' }).click();
    await page.getByLabel('Seleccionar las filas de esta página').check();
    await expect(page.getByText('1 seleccionado(s)')).toBeVisible();
  });
});
