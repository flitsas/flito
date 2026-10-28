// HU #14019 — FLITO SOAT · Selector Inicial / Renovación en la solicitud individual (Feature #14012).
//
// Diseño: docs/ux/flito-soat-cliente-tipo-renovacion-slim.md. Se interceptan los endpoints del canal con
// `page.route` (nunca el RUNT real) y se afirma lo que VIAJÓ (cuerpo del POST) además de lo que se ve.
// Calca el estilo de `soat-cliente-solicitud.spec.ts`.
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { elegirTipoInicial, elegirTipoRenovacion } from '../helpers/soat-tipo';
import { loginAs, CLIENTE_CON_CANAL } from '../helpers/auth';

const PLACA = 'XYZ123';
const DOC = '1234567890';
const VIN = '9BWZZZ377VT004251';
const UUID_SOLICITUD = '11111111-2222-4333-8444-555555555555';

const RE_ALTA = /\/api\/flito\/soat\/cliente$/;
const RE_COLA = /\/api\/flito\/soat\?/;
const RE_PRECONSULTA = /\/api\/flito\/soat\/cliente\/preconsulta$/;
const RE_LECTURA = /\/api\/flito\/soat\/cliente\/factura\/lectura$/;
const RE_INCOMPLETAS = /\/api\/flito\/soat\/cliente\/incompletas\/buscar$/;

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** `yyyy-mm-dd` a `n` días de hoy en Bogotá (−05), sin depender del huso de la máquina. */
function aDias(n: number): string {
  const bogota = new Date(Date.now() - 5 * 3_600_000);
  return new Date(Date.UTC(bogota.getUTCFullYear(), bogota.getUTCMonth(), bogota.getUTCDate() + n)).toISOString().slice(0, 10);
}

const SIN_FLITO = {
  yaEnFlito: false, abierto: false, estadoAbierto: null, soatId: null, diasVigencia: null, venceEl: null,
  fuenteVigencia: null, renovable: false,
};
const enFlito = (dias: number, over: Record<string, unknown> = {}) => ({
  yaEnFlito: true, abierto: false, estadoAbierto: null, soatId: UUID_SOLICITUD, diasVigencia: dias,
  venceEl: aDias(dias), fuenteVigencia: 'runt', renovable: dias <= 30, ...over,
});

const RUNT_OK = (flito: unknown = SIN_FLITO) => ({
  vehiculo: {
    placa: PLACA, vin: VIN, marca: 'RENAULT', linea: 'LOGAN', modelo: '2026', clase: 'AUTOMOVIL',
    cilindraje: '1600', tipoServicio: 'Particular', carroceria: 'SEDAN', pasajerosSentados: '5', puertas: '4',
  },
  organismo: { codigo: '05001', nombre: 'STRIA TTEyTTO MEDELLIN' },
  propietario: null, vigenciaProxima: null, flito,
});

type Respuesta = { status: number; cuerpo: unknown };

async function montar(
  page: Page,
  o: { preconsulta?: Respuesta; alta?: Respuesta; cola?: unknown[]; incompletas?: unknown[] } = {},
) {
  const preconsultas: string[] = [];
  const altas: string[] = [];
  await page.route(RE_COLA, (route) => json(route, 200, { items: o.cola ?? [], total: (o.cola ?? []).length, page: 1, pageSize: 50 }));
  await page.route(/\/api\/flito\/soat\/facetas/, (route) => json(route, 200, { companias: [], organismos: [], proveedores: [] }));
  await page.route(RE_INCOMPLETAS, (route) => json(route, 200, {
    items: o.incompletas ?? [], total: (o.incompletas ?? []).length,
    conteos: { incompleta: (o.incompletas ?? []).length, descartada: 0 },
  }));
  await page.route(/\/api\/flito\/soat\/cliente\/companias$/, (route) =>
    json(route, 200, { fija: true, companias: [{ id: 7, nombre: 'Transportes Andinos S.A.S.' }] }));
  await page.route(RE_LECTURA, (route) => json(route, 200, { extraccion: {} }));
  await page.route(RE_PRECONSULTA, (route) => {
    preconsultas.push(route.request().postData() ?? '');
    return o.preconsulta ? json(route, o.preconsulta.status, o.preconsulta.cuerpo) : json(route, 200, RUNT_OK());
  });
  await page.route(RE_ALTA, (route) => {
    altas.push(route.request().postData() ?? '');
    return o.alta ? json(route, o.alta.status, o.alta.cuerpo) : json(route, 201, { id: UUID_SOLICITUD, estado: 'solicitado' });
  });
  return { preconsultas, altas };
}

const abrir = async (page: Page) => {
  await loginAs(page, CLIENTE_CON_CANAL);
  await page.goto('/flito/soat/solicitud');
};

const consultarRenovacion = async (page: Page, placa = PLACA, doc = DOC) => {
  await page.getByLabel('Placa').fill(placa);
  await page.getByLabel('Documento del propietario').fill(doc);
  await page.getByRole('button', { name: 'Consultar el RUNT' }).click();
};

const bloque1 = (page: Page) => page.getByRole('region', { name: '1 · Vehículo' });
const btnEnviar = (page: Page) => page.getByRole('button', { name: 'Enviar solicitud' });

async function llenarPropietario(page: Page) {
  await page.getByLabel('Tipo de documento').selectOption('CC');
  await page.getByLabel('Nombre/s').fill('MARÍA FERNANDA');
  await page.getByLabel('Apellido/s').fill('GÓMEZ RUIZ');
  await page.getByLabel('Correo electrónico').fill('contacto@ejemplo.co');
  await page.getByLabel('Celular').fill('3001234567');
  await page.getByLabel('Dirección').fill('Calle 1 # 2-3');
  await page.getByLabel('Municipio').fill('Medellín');
  await page.getByLabel('Departamento').fill('Antioquia');
}

// ═════════════════════════ AC1 · el tipo es obligatorio y no tiene valor por defecto ═════════════

test.describe('HU #14019 · AC1 — sin tipo no hay bloques ni consulta', () => {
  test('al abrir: ningún tipo marcado, subtítulo de arranque, sin bloques, sin barra y sin consulta', async ({ page }) => {
    const cap = await montar(page);
    await abrir(page);

    await expect(page.getByRole('radio', { name: /SOAT inicial/ })).not.toBeChecked();
    await expect(page.getByRole('radio', { name: /Renovación/ })).not.toBeChecked();
    await expect(page.getByText('Elija el tipo de SOAT para empezar.')).toBeVisible();
    await expect(bloque1(page)).toHaveCount(0);
    await expect(page.getByRole('region', { name: '3 · Propietario' })).toHaveCount(0);
    await expect(page.locator('[data-barra-envio]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Consultar/ })).toHaveCount(0);
    expect(cap.preconsultas).toHaveLength(0);
  });
});

// ═════════════════════════ AC2 · la renovación pide placa y documento ═══════════════════════════

test.describe('HU #14019 · AC2 — formulario de renovación', () => {
  test('placa + documento, sin tipo de documento en el bloque 1, factura opcional y subtítulo propio', async ({ page }) => {
    await montar(page);
    await abrir(page);
    await elegirTipoRenovacion(page);

    await expect(page.getByText('Escriba la placa y el documento del propietario, adjunte la factura si la tiene y complete el propietario.')).toBeVisible();
    await expect(bloque1(page).getByLabel('Placa')).toBeVisible();
    await expect(bloque1(page).getByLabel('Documento del propietario')).toBeVisible();
    await expect(bloque1(page).getByLabel('Tipo de documento')).toHaveCount(0);
    await expect(bloque1(page).getByLabel(/VIN/)).toHaveCount(0);
    await expect(page.getByRole('region', { name: '2 · Factura de venta (opcional)' })).toBeVisible();
    await expect(page.getByText('Si la adjunta, FLITO lee el propietario y lo llena. Si no, escríbalo.')).toBeVisible();
  });

  test('la consulta viaja en el CUERPO ({tipo, placa, numeroDocumento}), no en la URL; el número prellena el bloque 3 y es editable', async ({ page }) => {
    const cap = await montar(page);
    await abrir(page);
    await elegirTipoRenovacion(page);
    await page.getByLabel('Placa').fill('xyz-123');
    await page.getByLabel('Documento del propietario').fill(DOC);
    await expect(page.getByLabel('Número de documento')).toHaveValue(DOC);
    await page.getByLabel('Número de documento').fill('999888777');
    await page.getByRole('button', { name: 'Consultar el RUNT' }).click();

    await expect(page.getByRole('region', { name: 'Datos del RUNT' })).toBeVisible();
    expect(JSON.parse(cap.preconsultas[0])).toMatchObject({ tipo: 'renovacion', placa: PLACA, numeroDocumento: DOC });
    expect(page.url()).not.toContain(PLACA);
    expect(page.url()).not.toContain(DOC);
    // El VIN del RUNT no se muestra en renovación.
    await expect(page.getByRole('region', { name: 'Datos del RUNT' }).getByText('VIN', { exact: true })).toHaveCount(0);
    // Lo que el usuario editó en el bloque 3 no se pisa.
    await expect(page.getByLabel('Número de documento')).toHaveValue('999888777');
  });

  test('placa mal formada y documento vacío: aviso de campo bajo cada uno, sin consultar', async ({ page }) => {
    const cap = await montar(page);
    await abrir(page);
    await elegirTipoRenovacion(page);
    await page.getByLabel('Placa').fill('AB');
    await page.getByRole('button', { name: 'Consultar el RUNT' }).click();

    await expect(page.getByText('Escriba la placa sin espacios, por ejemplo ABC123.')).toBeVisible();
    await expect(page.getByText('Escriba el documento del propietario.')).toBeVisible();
    expect(cap.preconsultas).toHaveLength(0);
  });

  test('sin factura se envía: POST con tipo=renovacion y placa, sin VIN ni facturaVenta; la barra dice «Enviar solicitud»', async ({ page }) => {
    const cap = await montar(page);
    await abrir(page);
    await elegirTipoRenovacion(page);
    await consultarRenovacion(page);
    await expect(page.getByRole('region', { name: 'Datos del RUNT' })).toBeVisible();
    await llenarPropietario(page);

    await expect(btnEnviar(page)).not.toHaveAttribute('aria-disabled', 'true');
    await btnEnviar(page).click();
    await expect(page).toHaveURL(/\/flito\/soat$/);

    expect(cap.altas).toHaveLength(1);
    const cuerpo = cap.altas[0];
    expect(cuerpo).toContain('name="tipo"\r\n\r\nrenovacion');
    expect(cuerpo).toContain(`name="placa"\r\n\r\n${PLACA}`);
    expect(cuerpo).not.toContain('name="vin"');
    expect(cuerpo).not.toContain('name="facturaVenta"');
  });
});

// ═════════════════════════ AC3/AC4 · el vehículo ya está en FLITO ═══════════════════════════════

test.describe('HU #14019 · AC3 — tarjeta «Ya está en FLITO»', () => {
  const tarjeta = (page: Page) => page.locator('section[data-variante="renovar"]');

  for (const [dias, titulo, chip] of [
    [12, 'Ya está en FLITO · quedan 12 días', 'Puede renovarlo ya'],
    [1, 'Ya está en FLITO · queda 1 día', 'Puede renovarlo ya'],
    [0, 'Ya está en FLITO · vence hoy', 'Puede renovarlo ya'],
    [-5, 'Ya está en FLITO · venció', 'Renuévelo para dejarlo vigente'],
  ] as const) {
    test(`${dias} días → «${titulo}» con «Renovar» primaria; «Renovar» continúa sin consultar de nuevo`, async ({ page }) => {
      const cap = await montar(page, { preconsulta: { status: 200, cuerpo: RUNT_OK(enFlito(dias)) } });
      await abrir(page);
      await elegirTipoRenovacion(page);
      await consultarRenovacion(page);

      await expect(tarjeta(page)).toBeVisible();
      await expect(tarjeta(page).getByRole('heading', { name: titulo })).toBeVisible();
      await expect(tarjeta(page).getByText(chip)).toBeVisible();
      await expect(tarjeta(page).getByRole('button', { name: 'Consultar otro vehículo' })).toBeVisible();
      // Sin proceso ni barra hasta renovar.
      await expect(page.locator('[data-barra-envio]')).toHaveCount(0);

      await tarjeta(page).getByRole('button', { name: 'Renovar' }).click();
      await expect(tarjeta(page)).toHaveCount(0);
      await expect(page.getByRole('region', { name: '3 · Propietario' })).toBeVisible();
      await expect(page.locator('[data-barra-envio]')).toBeVisible();
      expect(cap.preconsultas).toHaveLength(1);
    });
  }

  test('90 días (fuera de ventana, sin proceso abierto): la misma tarjeta SIN «Renovar»', async ({ page }) => {
    await montar(page, { preconsulta: { status: 200, cuerpo: RUNT_OK(enFlito(90)) } });
    await abrir(page);
    await elegirTipoRenovacion(page);
    await consultarRenovacion(page);

    await expect(tarjeta(page).getByRole('heading', { name: 'Ya está en FLITO · quedan 90 días' })).toBeVisible();
    await expect(tarjeta(page).getByText('Podrá renovarlo cuando falten 30 días o menos.')).toBeVisible();
    await expect(tarjeta(page).getByRole('button', { name: 'Renovar' })).toHaveCount(0);
    await expect(tarjeta(page).getByRole('button', { name: 'Consultar otro vehículo' })).toBeVisible();
    await expect(page.locator('[data-barra-envio]')).toHaveCount(0);
  });
});

test.describe('HU #14019 · AC4 — SOAT abierto: modal con su estado y sin «Renovar»', () => {
  test('409 con proceso abierto en renovación → ModalVinEnCola con el estado', async ({ page }) => {
    await montar(page, {
      preconsulta: {
        status: 409,
        cuerpo: {
          error: 'Este vehículo ya está en un proceso de SOAT en FLITO.', codigo: 'vin_ya_tiene_soat',
          propia: true, id: UUID_SOLICITUD, estado: 'solicitado',
          flito: enFlito(40, { abierto: true, estadoAbierto: 'solicitado', renovable: false }),
        },
      },
    });
    await abrir(page);
    await elegirTipoRenovacion(page);
    await consultarRenovacion(page);

    const modal = page.getByRole('dialog', { name: 'Ese vehículo ya está en la cola de FLITO' });
    await expect(modal).toBeVisible();
    await expect(modal.getByText(/en estado Solicitado/)).toBeVisible();
    await expect(modal.getByRole('link', { name: 'Ver la solicitud' })).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Renovar' })).toHaveCount(0);
  });
});

// ═════════════════════════ AC5 · Inicial sobre un VIN propio ya en FLITO ════════════════════════

test.describe('HU #14019 · AC5 — «Renovar» desde el 409 de Inicial', () => {
  const conflicto = (extra: Record<string, unknown>) => ({
    status: 409,
    cuerpo: { error: 'Este vehículo ya tiene un SOAT en FLITO.', codigo: 'vin_ya_tiene_soat', ...extra },
  });

  test('contexto renovable: la frase y «Renovar» primaria cambian a Renovación, limpian y dejan el foco en «Placa»', async ({ page }) => {
    await montar(page, {
      preconsulta: conflicto({ propia: true, id: UUID_SOLICITUD, estado: 'pagado', flito: enFlito(12) }),
    });
    await abrir(page);
    await elegirTipoInicial(page);
    await page.getByLabel(/^VIN/).fill(VIN);
    await page.getByRole('button', { name: 'Consultar el RUNT' }).click();

    const modal = page.getByRole('dialog', { name: 'Ese vehículo ya está en la cola de FLITO' });
    await expect(modal.getByText('Este vehículo ya tiene SOAT en FLITO. Para un SOAT nuevo no hace falta pedir uno inicial: renueve el que tiene.')).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Renovar' })).toBeVisible();
    await expect(modal.getByRole('link', { name: 'Ver la solicitud' })).toBeVisible();
    await expect(modal.getByRole('link', { name: 'Volver a mis SOAT' })).toBeVisible();

    await modal.getByRole('button', { name: 'Renovar' }).click();
    await expect(modal).toHaveCount(0);
    await expect(page.getByRole('radio', { name: /Renovación/ })).toBeChecked();
    await expect(page.getByLabel('Placa')).toBeFocused();
    await expect(page.getByLabel('Placa')).toHaveValue('');
    await expect(page.getByLabel(/^VIN/)).toHaveCount(0);
  });

  test('vehículo ajeno (sin contexto) o no renovable: el modal de hoy, sin «Renovar»', async ({ page }) => {
    await montar(page, { preconsulta: conflicto({ propia: false }) });
    await abrir(page);
    await elegirTipoInicial(page);
    await page.getByLabel(/^VIN/).fill(VIN);
    await page.getByRole('button', { name: 'Consultar el RUNT' }).click();

    const modal = page.getByRole('dialog', { name: 'Ese vehículo ya está en la cola de FLITO' });
    await expect(modal).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Renovar' })).toHaveCount(0);
    await expect(modal.getByText(/renueve el que tiene/)).toHaveCount(0);
  });
});

// ═════════════════════════ AC6 · cambiar de tipo ════════════════════════════════════════════════

test.describe('HU #14019 · AC6 — cambiar el tipo con datos pide confirmación y limpia', () => {
  test('sin datos cambia directo; con datos: «Mantener» conserva y «Cambiar el tipo» limpia consulta y propietario', async ({ page }) => {
    await montar(page);
    await abrir(page);
    await elegirTipoInicial(page);
    // Sin datos: cambio directo, sin modal.
    await elegirTipoRenovacion(page);
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await consultarRenovacion(page);
    await expect(page.getByRole('region', { name: 'Datos del RUNT' })).toBeVisible();
    await page.getByLabel('Correo electrónico').fill('contacto@ejemplo.co');

    // `click` y no `check`: el radio es controlado y NO cambia hasta que se confirma (Playwright exige el cambio en `check`).
    await page.getByRole('radio', { name: /SOAT inicial/ }).click();
    const modal = page.getByRole('dialog', { name: '¿Cambiar el tipo de SOAT?' });
    await expect(modal).toBeVisible();
    await expect(modal.getByText('Se borrarán los datos que ya escribió o consultó.')).toBeVisible();

    await modal.getByRole('button', { name: 'Mantener' }).click();
    await expect(modal).toHaveCount(0);
    await expect(page.getByRole('radio', { name: /Renovación/ })).toBeChecked();
    await expect(page.getByLabel('Correo electrónico')).toHaveValue('contacto@ejemplo.co');

    await page.getByRole('radio', { name: /SOAT inicial/ }).click();
    await page.getByRole('dialog', { name: '¿Cambiar el tipo de SOAT?' }).getByRole('button', { name: 'Cambiar el tipo' }).click();
    await expect(page.getByRole('radio', { name: /SOAT inicial/ })).toBeChecked();
    await expect(page.getByLabel(/^VIN/)).toHaveValue('');
    await expect(page.getByLabel('Correo electrónico')).toHaveValue('');
    await expect(page.getByRole('region', { name: 'Datos del RUNT' })).toHaveCount(0);
  });
});

// ═════════════════════════ AC8 · mensajes de los 422 ════════════════════════════════════════════

test.describe('HU #14019 · AC8 — mensajes claros por los canales existentes', () => {
  test('422 soat_sin_anterior → BandaDesenlace con el siguiente paso, sin código ni texto crudo', async ({ page }) => {
    await montar(page, {
      preconsulta: { status: 422, cuerpo: { error: 'CRUDO-NO-DEBE-VERSE', codigo: 'soat_sin_anterior' } },
    });
    await abrir(page);
    await elegirTipoRenovacion(page);
    await consultarRenovacion(page);

    const banda = page.getByRole('alert').filter({ hasText: 'El RUNT no registra un SOAT anterior para esta placa' });
    await expect(banda).toBeVisible();
    await expect(banda.getByText('Si este vehículo nunca ha tenido SOAT, elija «SOAT inicial» arriba para solicitarlo.')).toBeVisible();
    await expect(page.getByText('CRUDO-NO-DEBE-VERSE')).toHaveCount(0);
    await expect(page.getByText('soat_sin_anterior')).toHaveCount(0);
  });

  test('422 runt_no_cuadra (documento): «El documento no corresponde…» y el foco va al documento', async ({ page }) => {
    await montar(page, {
      preconsulta: { status: 422, cuerpo: { error: 'x', codigo: 'runt_no_cuadra' } },
    });
    await abrir(page);
    await elegirTipoRenovacion(page);
    await consultarRenovacion(page);

    await expect(page.getByText('El documento no corresponde al propietario de esta placa')).toBeVisible();
    await expect(page.getByText('Revise el número del documento y vuelva a consultar.')).toBeVisible();
    await expect(page.getByLabel('Documento del propietario')).toBeFocused();
  });

  test('un código sin mapear cae en el genérico pulido, nunca el crudo', async ({ page }) => {
    await montar(page, {
      preconsulta: { status: 422, cuerpo: { error: 'ERROR-INTERNO-XYZ', codigo: 'codigo_que_no_existe' } },
    });
    await abrir(page);
    await elegirTipoRenovacion(page);
    await consultarRenovacion(page);

    await expect(page.getByText('No pudimos consultar el vehículo')).toBeVisible();
    await expect(page.getByText('Revise la placa y el documento, o inténtelo de nuevo en unos minutos.')).toBeVisible();
    await expect(page.getByText('ERROR-INTERNO-XYZ')).toHaveCount(0);
    await expect(page.getByText('codigo_que_no_existe')).toHaveCount(0);
  });
});

// ═════════════════════════ AC9 · la cola ════════════════════════════════════════════════════════

test.describe('HU #14019 · AC9 — pastilla de tipo en la cola', () => {
  const fila = (id: string, over: Record<string, unknown>) => ({
    id, vin: VIN, placa: PLACA, marca: 'RENAULT', linea: 'LOGAN', cilindraje: '1600', carroceria: 'SEDAN',
    tipoServicio: 'Particular', estado: 'solicitado', esMultiplePropietario: false, companiaNombre: 'Transportes Sur',
    organismoNombre: 'STRIA', compradores: [], tramitesFlit: [], tipoTramite: null, fechaAprobacion: null,
    fechaCreacion: '2026-08-01T10:00:00Z', enviadoEn: null, pagadoEn: null, estancado: false, motivoRechazo: null,
    creadoEn: '2026-08-01T10:00:00Z', ...over,
  });

  test('«Inicial» / «Renovación» junto al identificador; la fila de trámite no lleva pastilla', async ({ page }) => {
    await montar(page, {
      cola: [
        fila('aaaaaaaa-0000-4000-8000-000000000001', { placa: 'AAA111', tipoSoat: 'INICIAL' }),
        fila('aaaaaaaa-0000-4000-8000-000000000002', { placa: 'BBB222', tipoSoat: 'RENOVACION' }),
        fila('aaaaaaaa-0000-4000-8000-000000000003', { placa: 'CCC333', tipoSoat: null }),
      ],
    });
    await loginAs(page, CLIENTE_CON_CANAL);
    await page.goto('/flito/soat');

    const filaDe = (placa: string) => page.getByRole('row').filter({ hasText: placa });
    await expect(filaDe('AAA111').locator('[data-tipo-soat="INICIAL"]')).toHaveText('Inicial');
    await expect(filaDe('BBB222').locator('[data-tipo-soat="RENOVACION"]')).toHaveText('Renovación');
    await expect(filaDe('CCC333').locator('[data-tipo-soat]')).toHaveCount(0);
  });

  test('vacío del Cliente con el copy nuevo', async ({ page }) => {
    await montar(page, { cola: [] });
    await loginAs(page, CLIENTE_CON_CANAL);
    await page.goto('/flito/soat');

    await expect(page.getByText('Solicite el primero con el VIN del vehículo, o con la placa si es una renovación.')).toBeVisible();
  });
});

// ═════════════════════════ AC7 · Por validar con renovación ═════════════════════════════════════

test.describe('HU #14019 · AC7 — renovación con RUNT caído en «Por validar»', () => {
  const incompleta = {
    id: 'bbbbbbbb-0000-4000-8000-000000000001', estado: 'incompleta', vin: null, companiaId: 7, companiaNombre: 'Transportes Sur',
    placa: PLACA, tipoSoat: 'RENOVACION', modalidadConsulta: 'placa', motivoPendiente: 'runt_sin_respuesta',
    marca: null, linea: null, titular: null, solicitadoPorNombre: 'Cliente E2E', solicitadoEn: '2026-08-01T10:00:00Z',
    intentos: 1, ultimoIntentoRuntEn: '2026-08-01T10:00:00Z', descarte: null, soatId: null,
  };

  test('la fila se identifica por la placa, con pastilla de tipo y «El RUNT no respondió»', async ({ page }) => {
    await montar(page, { incompletas: [incompleta] });
    await loginAs(page, CLIENTE_CON_CANAL);
    await page.goto('/flito/soat', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /Por validar/ }).click();

    const fila = page.getByRole('row').filter({ hasText: PLACA });
    await expect(fila.locator('[data-tipo-soat="RENOVACION"]')).toHaveText('Renovación');
    await expect(fila.getByText('El RUNT no respondió')).toBeVisible();
  });
});

// ═════════════════════════ AC10 · la barra anclada y el rótulo ═════════════════════════════════

test.describe('HU #14019 — barra de envío anclada al borde inferior y rótulo «Enviar solicitud»', () => {
  test('≥ lg: banda de ancho completo con su borde inferior sobre el menú flotante; rótulo «Enviar solicitud» (y no «Enviar al gestor»)', async ({ page }) => {
    await montar(page);
    await page.setViewportSize({ width: 1366, height: 768 });
    await abrir(page);
    await elegirTipoInicial(page);

    const barra = page.locator('[data-barra-envio]');
    await expect(barra).toBeVisible();
    await expect(btnEnviar(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enviar al gestor' })).toHaveCount(0);

    const caja = (await barra.boundingBox())!;
    expect(caja.width).toBeGreaterThan(1366 - 20);
    // 5,5 rem = 88 px por encima del borde: el sitio del menú flotante.
    expect(Math.abs(768 - (caja.y + caja.height) - 88)).toBeLessThanOrEqual(2);

    // Al llegar al final es la MISMA barra (una sola) y no tapa el último campo.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(barra).toHaveCount(1);
    const ultimo = (await page.getByLabel('Departamento').boundingBox())!;
    const final = (await barra.boundingBox())!;
    expect(ultimo.y + ultimo.height).toBeLessThanOrEqual(final.y + 1);
  });

  test('< lg: apilada, la primaria arriba, luego «Cancelar», y la barra pegada al borde', async ({ page }) => {
    await montar(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await abrir(page);
    await elegirTipoInicial(page);

    const barra = page.locator('[data-barra-envio]');
    const caja = (await barra.boundingBox())!;
    expect(Math.abs(812 - (caja.y + caja.height))).toBeLessThanOrEqual(2);
    const primaria = (await btnEnviar(page).boundingBox())!;
    const cancelar = (await barra.getByRole('button', { name: 'Cancelar' }).boundingBox())!;
    expect(primaria.y).toBeLessThan(cancelar.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
