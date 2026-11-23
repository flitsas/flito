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
  id: 'c1', organismoCodigo: 'STT-MZL', organismoNombre: 'STT Manizales', placa: 'ABC123',
  tipoDocumentoPropietario: 'CC', documentoPropietario: '10101010', nombrePropietario: 'Ana Pérez', ...LECTURA, aviso: undefined,
  estado: 'radicado', comparacion: null, certificadoEn: null, createdAt: '2026-10-01T12:00:00Z', ...extra,
});

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Cola de impuestos (la pestaña por defecto) y catálogo del módulo de certificar. */
async function mockBase(page: Page) {
  await page.route(/\/api\/flito\/impuestos\/facetas/, (r) => r.fulfill(json({ companias: [], organismos: [] })));
  await page.route(/\/api\/flito\/impuestos\?/, (r) => r.fulfill(json({ items: [], total: 0, page: 1, pageSize: 50 })));
  await page.route(/\/certificacion-directa\/catalogo$/, (r) => r.fulfill(json({ organismos: [{ codigo: 'STT-MZL', nombre: 'STT Manizales' }] })));
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

    for (const col of ['Placa', 'VIN', 'Propietario', 'Estado']) {
      await expect(page.getByRole('columnheader', { name: col })).toBeVisible();
    }
    await expect(page.getByRole('columnheader', { name: 'Compañía' })).toHaveCount(0);
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
    await expect(page.getByLabel('Placa')).toHaveCount(0);

    await page.locator('input[type="file"]').setInputFiles(FACTURA);
    await expect(page.getByText('Leyendo la factura…')).toBeVisible();
    soltar();
    await expect(page.getByText('Leímos la factura. Revisa los datos antes de guardar.')).toBeVisible();
    expect(lecturas).toBe(1);
    await expect(page.getByRole('button', { name: 'Leer factura' })).toHaveCount(0);
    await expect(page.getByText('Leído', { exact: true })).toHaveCount(6);
    await expect(page.getByLabel('VIN', { exact: true })).toHaveValue(LECTURA.vin);
    await expect(page.getByText('Compañía')).toHaveCount(0);

    await expect(page.getByText('Faltan 2 datos para guardar.')).toBeVisible();
    await expect(guardar(page)).toBeDisabled();
    await page.getByLabel('Organismo', { exact: true }).selectOption('STT-MZL');
    await page.getByLabel('Placa', { exact: true }).fill('ABC123');
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
    await expect(page.getByLabel('Placa', { exact: true })).toHaveValue('ABC123');
    await page.waitForTimeout(500);
    expect(pidioFactura).toBe(false);
    await expect(page.getByRole('button', { name: 'Ampliar factura' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: /^Páginas de/ })).toHaveCount(0);
  });

  test('8 · alta sin propietario: se guarda, y placa, VIN y organismo siguen siendo obligatorios', async ({ page }) => {
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

    // Solo faltan organismo y placa: el propietario no cuenta, y sin VIN no se puede guardar.
    await expect(page.getByText('Faltan 2 datos para guardar.')).toBeVisible();
    await expect(guardar(page)).toBeDisabled();
    await page.getByLabel('Organismo', { exact: true }).selectOption('STT-MZL');
    await page.getByLabel('Placa', { exact: true }).fill('ABC123');
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

  test('9 · el formulario explica cómo se consultará el RUNT según haya documento o no', async ({ page }) => {
    await irACertificar(page);
    await page.route(/\/certificacion-directa\/extraer$/, (r) => r.fulfill(json(LECTURA)));
    await nueva(page);
    await page.locator('input[type="file"]').setInputFiles(FACTURA);
    const ayuda = 'Con documento, elige el tipo: el RUNT se consulta por placa y documento. Sin documento, por VIN.';
    await expect(page.getByText(ayuda)).toBeVisible();
    await expect(page.getByLabel('Documento del propietario (opcional)')).toHaveAccessibleDescription(ayuda);
    await expect(page.getByLabel('Tipo de documento', { exact: true })).toHaveAccessibleDescription(ayuda);
    await expect(page.getByText('El RUNT se consulta por VIN.')).toHaveCount(0);
    await expect(page.getByText(/consulta el RUNT por VIN/)).toHaveCount(0);
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
    const celdas = page.getByRole('row').filter({ hasText: 'ABC123' }).getByRole('cell');
    await expect(celdas.nth(2)).toHaveText('—');
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
    await page.getByLabel('Organismo', { exact: true }).selectOption('STT-MZL');
    await page.getByLabel('Placa', { exact: true }).fill('ABC123');
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
    await expect(page.getByLabel('Placa', { exact: true })).toBeDisabled();

    await page.getByRole('button', { name: 'Volver al listado' }).click();
    await page.getByRole('button', { name: 'Nueva certificación' }).click();
    await page.locator('input[type="file"]').setInputFiles(FACTURA);
    await expect(page.getByLabel('VIN', { exact: true })).toHaveValue(LECTURA.vin);

    // Nada del certificado anterior: campos vacíos, habilitados y sin su estado ni su descarga.
    await expect(page.getByLabel('Placa', { exact: true })).toBeEnabled();
    await expect(page.getByLabel('Placa', { exact: true })).toHaveValue('');
    await expect(documento(page)).toBeEnabled();
    await expect(documento(page)).toHaveValue('');
    await expect(tipoDoc(page)).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Descargar certificado' })).toHaveCount(0);
    await page.getByLabel('Organismo', { exact: true }).selectOption('STT-MZL');
    await page.getByLabel('Placa', { exact: true }).fill('XYZ987');
    await expect(guardar(page)).toBeEnabled();
  });

  const CHIP_CON_DOCUMENTO = 'No encontrado';
  const CHIP_SIN_DOCUMENTO = 'Sin vehículo';
  const AVISO_CORREGIR_O_BORRAR = 'El RUNT no encontró el vehículo con esa placa y ese documento. Corrige el documento o bórralo para consultar por VIN.';
  const chip = (zona: Page | ReturnType<Page['getByRole']>, texto: string) => zona.getByText(texto, { exact: true });
  const SIN_DOCUMENTO = { documentoPropietario: null, tipoDocumentoPropietario: null };

  test('19 · sin vehículo con documento: el chip dice «No encontrado» en la lista y en el detalle', async ({ page }) => {
    await irACertificar(page);
    await conFila(page, fila({ estado: 'sin_vehiculo' }));
    await expect(chip(page, CHIP_CON_DOCUMENTO)).toBeVisible();
    await expect(chip(page, CHIP_SIN_DOCUMENTO)).toHaveCount(0);
    // Editar sin guardar no cambia el resultado de la consulta: el chip sigue siendo el de la fila guardada.
    await documento(page).fill('');
    await expect(chip(page, CHIP_CON_DOCUMENTO)).toBeVisible();
    await expect(chip(page, CHIP_SIN_DOCUMENTO)).toHaveCount(0);

    await page.getByRole('button', { name: 'Volver al listado' }).click();
    const filaLista = page.getByRole('row').filter({ hasText: 'ABC123' });
    await expect(chip(filaLista, CHIP_CON_DOCUMENTO)).toBeVisible();
    await expect(chip(filaLista, CHIP_SIN_DOCUMENTO)).toHaveCount(0);
  });

  test('20 · sin vehículo sin documento: el chip conserva «Sin vehículo» en la lista y en el detalle', async ({ page }) => {
    await irACertificar(page);
    await conFila(page, fila({ estado: 'sin_vehiculo', ...SIN_DOCUMENTO }));
    await expect(chip(page, CHIP_SIN_DOCUMENTO)).toBeVisible();
    await expect(chip(page, CHIP_CON_DOCUMENTO)).toHaveCount(0);
    // Escribir un documento sin guardar no cambia el chip: aún no se ha consultado con él.
    await documento(page).fill('10101010');
    await expect(chip(page, CHIP_SIN_DOCUMENTO)).toBeVisible();
    await expect(chip(page, CHIP_CON_DOCUMENTO)).toHaveCount(0);

    await page.getByRole('button', { name: 'Volver al listado' }).click();
    const filaLista = page.getByRole('row').filter({ hasText: 'ABC123' });
    await expect(chip(filaLista, CHIP_SIN_DOCUMENTO)).toBeVisible();
    await expect(chip(filaLista, CHIP_CON_DOCUMENTO)).toHaveCount(0);
  });

  for (const caso of [
    { nombre: 'sin vehículo con documento pide corregirlo o borrarlo', extra: { estado: 'sin_vehiculo' }, aviso: AVISO_CORREGIR_O_BORRAR },
    { nombre: 'sin vehículo sin documento nombra el VIN', extra: { estado: 'sin_vehiculo', ...SIN_DOCUMENTO }, aviso: 'El RUNT no tiene registro de este VIN.' },
    { nombre: 'sin respuesta con documento ofrece consultar por VIN', extra: { estado: 'sin_respuesta' }, aviso: 'El RUNT no respondió. El registro quedó guardado. Puedes consultar de nuevo o borrar el documento para consultar por VIN.' },
    { nombre: 'sin respuesta sin documento invita a consultar de nuevo', extra: { estado: 'sin_respuesta', ...SIN_DOCUMENTO }, aviso: 'El RUNT no respondió. El registro quedó guardado. Puedes consultar de nuevo.' },
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
      await expect(page.getByText(AVISO_CORREGIR_O_BORRAR)).toHaveCount(0);
    });
  }

  for (const caso of [
    {
      nombre: 'con documento nombra la placa y el documento, y ofrece consultar por VIN',
      documentoPropietario: '10101010',
      estado: 'sin_vehiculo',
      aviso: 'El RUNT no encontró el vehículo con esa placa y ese documento. Corrige el documento o bórralo para consultar por VIN.',
    },
    {
      nombre: 'sin documento conserva el mensaje del VIN',
      documentoPropietario: null,
      estado: 'sin_vehiculo',
      aviso: 'El RUNT no tiene registro de este VIN.',
    },
    {
      nombre: 'sin respuesta con documento también ofrece consultar por VIN',
      documentoPropietario: '10101010',
      estado: 'sin_respuesta',
      aviso: 'El RUNT no respondió. El registro quedó guardado. Puedes consultar de nuevo o borrar el documento para consultar por VIN.',
    },
    {
      nombre: 'sin respuesta y sin documento solo invita a consultar de nuevo',
      documentoPropietario: null,
      estado: 'sin_respuesta',
      aviso: 'El RUNT no respondió. El registro quedó guardado. Puedes consultar de nuevo.',
    },
  ]) {
    test(`11 · aviso tras consultar: ${caso.nombre}`, async ({ page }) => {
      await irACertificar(page);
      const base = fila({ documentoPropietario: caso.documentoPropietario, tipoDocumentoPropietario: caso.documentoPropietario ? 'CC' : null });
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
});
