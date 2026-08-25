import { test, expect, type Page } from '@playwright/test';
import { loginAs, ADMIN_USER, FINANCIERA_USER, AUDITOR_USER, CONDUCTOR_USER } from '../helpers/auth';

// Facturación electrónica — Operación: la bandeja de fallidos (HU #11345, Feature #11244).
//
// Backend mockeado. **Los cinco mocks se ponen SIEMPRE**, aunque un caso solo afirme sobre uno: un
// mock que cubre solo lo que el test mira deja el resto en un estado que nadie eligió, y entonces lo
// que falla no es lo que se estaba probando.

const REF_EMISION = 'aaaaaaaa-1111-4111-8111-111111111111';
const REF_DIAN = 'bbbbbbbb-2222-4222-8222-222222222222';
const REF_CORREO = 'cccccccc-3333-4333-8333-333333333333';
const REF_PERDIDO = 'dddddddd-4444-4444-8444-444444444444';
const TRAMITE = 'eeeeeeee-5555-4555-8555-555555555555';

function guia(parcial: Record<string, unknown> = {}) {
  return {
    codigo: 'parameter_required',
    descripcion: 'Falta el código de ciudad del cliente.',
    accion: 'Complétalo en la ficha fiscal del cliente y vuelve a intentarlo.',
    responsable: 'contabilidad',
    responsableEtiqueta: 'contabilidad, en Siigo Nube',
    reintentable: false,
    reintentoManual: true,
    sirveReintentar: true,
    conocido: true,
    texto: 'Falta el código de ciudad del cliente.',
    ...parcial,
  };
}

const CASO_EMISION = {
  fuente: 'emision',
  refId: REF_EMISION,
  facturaId: 'f1111111-1111-4111-8111-111111111111',
  facturaNumero: null,
  ocurridoEn: '2026-08-12T09:14:00.000Z',
  antiguedadDias: 11,
  codigo: 'parameter_required',
  guia: guia(),
  detalle: null,
  estado: { cola: 'error', dian: null, correo: null },
  colaId: 'c1111111-1111-4111-8111-111111111111',
  intentos: 3,
  maxIntentos: 5,
  tramites: [{ tramiteId: TRAMITE, idFlit: 'FLIT-2044' }],
  clienteId: 41,
  clienteNombre: 'Transportes del Norte S.A.S.',
  descarte: null,
};

const CASO_DIAN = {
  ...CASO_EMISION,
  fuente: 'dian',
  refId: REF_DIAN,
  facturaId: 'f2222222-2222-4222-8222-222222222222',
  ocurridoEn: '2026-08-17T09:14:00.000Z',
  antiguedadDias: 6,
  estado: { cola: null, dian: 'rechazada', correo: null },
  guia: guia({
    codigo: 'dian_rechazo',
    descripcion: 'La DIAN rechazó la resolución de facturación.',
    accion: 'Renuévala en Siigo Nube y vuelve a emitir.',
    sirveReintentar: false,
    reintentoManual: false,
  }),
  tramites: [{ tramiteId: TRAMITE, idFlit: 'FLIT-2019' }],
  clienteId: 42,
  clienteNombre: 'Logística Andina Ltda.',
};

const CASO_CORREO = {
  ...CASO_EMISION,
  fuente: 'correo',
  refId: REF_CORREO,
  facturaId: 'f3333333-3333-4333-8333-333333333333',
  ocurridoEn: '2026-08-21T09:14:00.000Z',
  antiguedadDias: 2,
  estado: { cola: null, dian: null, correo: 'no_realizado' },
  guia: guia({
    codigo: 'sin_correo',
    descripcion: 'El cliente no tiene correo en su ficha.',
    accion: 'Complétalo desde la ficha del cliente.',
    sirveReintentar: false,
    reintentoManual: false,
  }),
  tramites: [{ tramiteId: TRAMITE, idFlit: 'FLIT-2007' }],
  clienteId: 43,
  clienteNombre: 'Comercial del Sur S.A.',
};

const CASO_PERDIDO = {
  ...CASO_EMISION,
  refId: REF_PERDIDO,
  facturaId: 'f4444444-4444-4444-8444-444444444444',
  estado: { cola: 'fallido_definitivo', dian: null, correo: null },
  tramites: [{ tramiteId: TRAMITE, idFlit: 'FLIT-2033' }],
  descarte: {
    motivo: 'tramite_anulado',
    motivoEtiqueta: 'El trámite se anuló',
    nota: null,
    usuarioId: 7,
    marcadoEn: '2026-08-20T10:00:00.000Z',
  },
};

const RESUMEN = {
  ambiente: 'produccion',
  total: 23,
  porFuente: { emision: 14, dian: 3, correo: 6 },
  porResponsable: { operacion: 4, contabilidad: 17, soporte: 2, automatico: 0 },
  porCodigo: [
    { codigo: 'parameter_required', etiqueta: 'Falta el código de ciudad', total: 7, reintentable: false },
    { codigo: 'dian_rechazo', etiqueta: 'Rechazo de la DIAN', total: 3, reintentable: false },
  ],
};

const FRENO_LIBRE = {
  ambiente: 'produccion', modo: 'real', ventanaHoras: 168, umbral: 0.8, minimoOperaciones: 20,
  desde: '2026-08-16T00:00:00.000Z', hasta: '2026-08-23T00:00:00.000Z',
  total: 120, errores: 4, erroresDeDatos: 1, proporcion: 0.03,
  muestraSuficiente: true, superaUmbral: false,
  frenoActivo: true, frenada: false, frenadaDesde: null, ultimaReactivacion: null,
};

const FRENO_ACTIVO = {
  ...FRENO_LIBRE,
  errores: 100, proporcion: 0.83, superaUmbral: true,
  frenada: true, frenadaDesde: '2026-08-22T14:05:00.000Z',
};

interface Opciones {
  items?: unknown[];
  hayMas?: boolean;
  buscarStatus?: number;
  resumenStatus?: number;
  freno?: unknown;
  demoraBuscarMs?: number;
}

/** Los CINCO mocks de la pantalla, siempre. */
async function mockBandeja(page: Page, o: Opciones = {}) {
  const items = o.items ?? [CASO_EMISION, CASO_DIAN, CASO_CORREO];

  await page.route(/\/api\/siigo\/bandeja\/buscar/, async (route) => {
    if (o.demoraBuscarMs) await new Promise((r) => setTimeout(r, o.demoraBuscarMs));
    if (o.buscarStatus && o.buscarStatus !== 200) {
      await route.fulfill({
        status: o.buscarStatus, contentType: 'application/json',
        body: JSON.stringify({ error: 'La consulta de la bandeja reventó' }),
      });
      return;
    }
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        ambiente: 'produccion', items, limite: 25, offset: 0, hayMas: o.hayMas ?? false,
      }),
    });
  });

  await page.route(/\/api\/siigo\/bandeja\/resumen/, (route) => route.fulfill({
    status: o.resumenStatus ?? 200,
    contentType: 'application/json',
    body: JSON.stringify(o.resumenStatus && o.resumenStatus !== 200
      ? { error: 'El resumen no se pudo calcular' } : RESUMEN),
  }));

  await page.route(/\/api\/siigo\/freno(\?|$)/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify(o.freno ?? FRENO_LIBRE),
  }));

  await page.route(/\/api\/siigo\/linea-tiempo\//, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      tramiteId: TRAMITE, facturacionIniciada: true, facturaId: CASO_EMISION.facturaId,
      hitos: [
        { fuente: 'liquidacion', tipo: 'sellada', detalle: 'Liquidación sellada', resultado: 'ok', ocurridoEn: '2026-08-02T15:04:00.000Z', usuarioId: 7 },
        { fuente: 'siigo', tipo: 'encolada', detalle: 'Encolada para emitir', resultado: 'informativo', ocurridoEn: '2026-08-03T13:00:00.000Z', usuarioId: null },
        { fuente: 'siigo', tipo: 'crear_factura', detalle: 'parameter_required — city_code', resultado: 'error', ocurridoEn: '2026-08-12T14:14:00.000Z', usuarioId: null },
      ],
    }),
  }));

  await page.route(/\/api\/siigo\/correcciones\/factura\//, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      puedeCorregirse: true, via: 'registro_externo',
      viaTexto: 'Se corrige en Siigo Nube y se registra aquí.', antiguedadHoras: 240,
      yaCorregida: false,
      opciones: [
        { tipo: 'anulacion', admisible: true, automatizable: false, ejecutores: ['manual'], motivo: 'La factura existe y admite anulación.' },
        { tipo: 'borrado', admisible: false, automatizable: false, ejecutores: [], motivo: 'ya pasaron más de 24 horas' },
        { tipo: 'otra', admisible: true, automatizable: false, ejecutores: ['manual'], motivo: 'Siempre se puede registrar lo que se hizo.' },
      ],
    }),
  }));
}

// ── AC1 — acceso y permisos ─────────────────────────────────────────────────

test.describe('AC1 — acceso y permisos por rol', () => {
  test('sin la clave de página no se ve en el menú y el enlace directo se rechaza', async ({ page }) => {
    await loginAs(page, CONDUCTOR_USER);
    await mockBandeja(page);
    await page.goto('/siigo/operacion');

    await expect(page.getByRole('heading', { name: /No tienes acceso/ })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Transportes del Norte S.A.S.' })).toHaveCount(0);
    await expect(page.getByRole('navigation')
      .getByRole('link', { name: 'Facturación electrónica · Operación' })).toHaveCount(0);
  });

  test('financiera entra, ve el ítem del menú y tiene las acciones', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockBandeja(page);
    await page.goto('/siigo/operacion');

    await expect(page.getByRole('heading', { name: 'Facturación electrónica — Operación' })).toBeVisible();
    // El menú agrupa por sección y la de Finanzas nace plegada: hay que abrirla para ver el ítem.
    await page.getByRole('navigation').getByRole('button', { name: /Finanzas/ }).click();
    await expect(page.getByRole('navigation')
      .getByRole('link', { name: 'Facturación electrónica · Operación' })).toBeVisible();
    // Y la que ya existía cambió de nombre: dos «Facturación electrónica» iguales sería una trampa.
    await expect(page.getByRole('navigation')
      .getByRole('link', { name: 'Facturación electrónica · Parametrización' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Seleccionar FLIT-2044' })).toBeVisible();
    await expect(page.getByText('Tu rol es de consulta')).toHaveCount(0);
  });

  test('auditor lo ve TODO y no tiene NINGUNA acción', async ({ page }) => {
    const escrituras: string[] = [];
    page.on('request', (r) => {
      const u = r.url();
      if (/\/(reintentar|reenviar-correo|descartar|reactivar|correcciones)/.test(u) && r.method() === 'POST') {
        escrituras.push(u);
      }
    });
    await loginAs(page, AUDITOR_USER);
    await mockBandeja(page);
    await page.goto('/siigo/operacion');

    await expect(page.getByText('Tu rol es de consulta: ves todo y no hay acciones disponibles.')).toBeVisible();
    // Cero casillas y cero columna de selección: un botón inhabilitado ES una acción presente.
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: /Seleccionar/ })).toHaveCount(0);

    // Pero el detalle y la línea de tiempo están enteros.
    await page.getByRole('button', { name: 'Ver el caso FLIT-2044' }).click();
    await expect(page.getByRole('heading', { name: 'Línea de tiempo' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Dar por perdido' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Registrar una corrección' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Reintentar la emisión/ })).toHaveCount(0);
    expect(escrituras).toEqual([]);
  });
});

// ── AC2 — los cuatro estados ────────────────────────────────────────────────

test.describe('AC2 — los cuatro estados', () => {
  test('cargando: esqueleto anunciado y los filtros SIGUEN habilitados', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockBandeja(page, { demoraBuscarMs: 1500 });
    await page.goto('/siigo/operacion');

    await expect(page.getByText('Buscando lo que quedó detenido…')).toBeVisible();
    // Quien acaba de poner un filtro y ve que tarda, lo primero que hace es corregirlo.
    await expect(page.getByRole('button', { name: /^Todas$/ })).toBeEnabled();
  });

  test('error: alerta con el mensaje del servidor, reintento, y NADA de tabla', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockBandeja(page, { buscarStatus: 500 });
    await page.goto('/siigo/operacion');

    await expect(page.getByRole('alert')
      .filter({ hasText: 'La consulta de la bandeja reventó' })).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);

    // El reintento vuelve a llamar: se devuelve un 200 y la tabla aparece.
    await page.unroute(/\/api\/siigo\/bandeja\/buscar/);
    await mockBandeja(page);
    await page.getByRole('button', { name: 'Reintentar la búsqueda' }).click();
    await expect(page.getByRole('cell', { name: 'Transportes del Norte S.A.S.' })).toBeVisible();
  });

  test('vacío SIN filtros: celebra', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockBandeja(page, { items: [] });
    await page.goto('/siigo/operacion');

    await expect(page.getByText('No hay nada detenido. Buen día.')).toBeVisible();
  });

  test('vacío CON filtro: NO celebra, y lo dice con el total', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockBandeja(page, { items: [] });
    await page.goto('/siigo/operacion');
    await page.getByRole('button', { name: /Rechazada por la DIAN/ }).click();

    await expect(page.getByText('Ningún caso coincide con este filtro.')).toBeVisible();
    await expect(page.getByText(/Hay 23 casos detenidos en total/)).toBeVisible();
    // La afirmación que NO se puede hacer con un filtro puesto.
    await expect(page.getByText('No hay nada detenido. Buen día.')).toHaveCount(0);
  });

  test('el resumen falla y la lista se pinta igual, con su propio reintento', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockBandeja(page, { resumenStatus: 500 });
    await page.goto('/siigo/operacion');

    await expect(page.getByRole('cell', { name: 'Transportes del Norte S.A.S.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Volver a calcular el resumen' })).toBeVisible();
  });
});

// ── AC3 — motivo, acción, responsable y filtros ─────────────────────────────

test.describe('AC3 — el motivo, la acción y quién lo resuelve', () => {
  test('los tres textos se pintan LITERALES, con el estado nativo de cada fuente', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockBandeja(page);
    await page.goto('/siigo/operacion');

    await expect(page.getByText('Falta el código de ciudad del cliente.').first()).toBeVisible();
    await expect(page.getByText('→ Complétalo en la ficha fiscal del cliente y vuelve a intentarlo.')).toBeVisible();
    await expect(page.getByText('Responsable: contabilidad, en Siigo Nube').first()).toBeVisible();

    // Cada fuente con la etiqueta de SU catálogo, no un estado común inventado.
    await expect(page.getByText('Con error, se reintentará')).toBeVisible();
    await expect(page.getByText('Rechazada', { exact: true })).toBeVisible();
    await expect(page.getByText('No se llegó a enviar')).toBeVisible();
    await expect(page.getByText('intento 3 de 5')).toBeVisible();
  });

  test('lo que no se arregla reintentando está señalado EN TEXTO y no se puede marcar', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockBandeja(page);
    await page.goto('/siigo/operacion');

    await expect(page.getByText('No se arregla reintentando').first()).toBeVisible();
    // El de emisión sí es marcable; el de la DIAN y el del correo sin dirección, no.
    await expect(page.getByRole('checkbox', { name: 'Seleccionar FLIT-2044' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Seleccionar FLIT-2019' })).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: 'Seleccionar FLIT-2007' })).toHaveCount(0);
  });

  test('los filtros viajan en el CUERPO y la URL no cambia ni lleva PII', async ({ page }) => {
    const cuerpos: unknown[] = [];
    await loginAs(page, ADMIN_USER);
    await mockBandeja(page);
    page.on('request', (r) => {
      if (r.url().includes('/bandeja/buscar')) cuerpos.push(r.postDataJSON());
    });
    await page.goto('/siigo/operacion');
    await expect(page.getByRole('cell', { name: 'Transportes del Norte S.A.S.' })).toBeVisible();

    await page.getByRole('button', { name: /No se pudo emitir/ }).click();
    await page.getByLabel('Motivo').selectOption('parameter_required');
    await page.getByLabel('Cliente').selectOption('41');
    await page.getByRole('button', { name: 'Más de 5 días' }).click();

    await expect.poll(() => cuerpos.length).toBeGreaterThan(4);
    const ultimo = cuerpos[cuerpos.length - 1] as Record<string, unknown>;
    expect(ultimo).toMatchObject({
      fuentes: ['emision'], codigos: ['parameter_required'], clientes: [41], antiguedadDiasMin: 5,
    });

    // La dirección sigue siendo la misma, sin query y sin un solo dato de nadie.
    expect(new URL(page.url()).pathname).toBe('/siigo/operacion');
    expect(new URL(page.url()).search).toBe('');
    expect(page.url()).not.toContain('Transportes');
    expect(page.url()).not.toContain('@');
  });

  test('un motivo no catalogado se señala, y el crudo SOLO aparece en el detalle', async ({ page }) => {
    const crudo = 'RAW_SIIGO: unknown_error_9182 en /v1/invoices';
    await loginAs(page, ADMIN_USER);
    await mockBandeja(page, {
      items: [{ ...CASO_EMISION, guia: guia({ conocido: false, texto: crudo }) }],
    });
    await page.goto('/siigo/operacion');

    await expect(page.getByText('Motivo no catalogado')).toBeVisible();
    await expect(page.getByText(crudo)).toHaveCount(0);

    await page.getByRole('button', { name: 'Ver el caso FLIT-2044' }).click();
    await expect(page.getByRole('heading', { name: 'Lo que respondió Siigo' })).toBeVisible();
    await expect(page.getByText(crudo)).toBeVisible();
  });
});

// ── AC4 — el lote sin sorpresas ─────────────────────────────────────────────

test.describe('AC4 — reintentar en lote', () => {
  test('la previsualización no emite NINGUNA petición y explica cada exclusión', async ({ page }) => {
    const llamadas: string[] = [];
    await loginAs(page, ADMIN_USER);
    await mockBandeja(page, { items: [CASO_EMISION, CASO_DIAN, CASO_CORREO, CASO_PERDIDO] });
    page.on('request', (r) => {
      if (/\/(reintentar|reenviar-correo)/.test(r.url())) llamadas.push(r.url());
    });
    await page.goto('/siigo/operacion');

    await page.getByRole('checkbox', { name: 'Seleccionar todos los casos accionables de esta página' }).check();
    await page.getByRole('button', { name: /^Reintentar 1 casos$/ }).click();

    // Solo el de emisión es accionable: los otros tres ni siquiera se pueden marcar.
    await expect(page.getByText('Se van a intentar 1 de los 1 seleccionados.')).toBeVisible();
    expect(llamadas).toEqual([]);
  });

  test('con una selección mixta: dos peticiones, /reintentar primero', async ({ page }) => {
    const orden: string[] = [];
    const CORREO_OK = { ...CASO_CORREO, guia: guia({ codigo: 'smtp', descripcion: 'El envío falló.', accion: 'Vuelve a mandarlo.' }) };
    await loginAs(page, ADMIN_USER);
    await mockBandeja(page, { items: [CASO_EMISION, CORREO_OK] });

    await page.route(/\/api\/siigo\/bandeja\/reintentar/, (route) => {
      orden.push('reintentar');
      return route.fulfill({
        status: 202, contentType: 'application/json',
        body: JSON.stringify({
          ambiente: 'produccion',
          items: [{ facturaId: CASO_EMISION.facturaId, resultado: 'encolado', motivo: null, guia: null, colaId: 'x', loteId: null, estado: 'pendiente' }],
          resumen: { total: 1, encolados: 1, yaEstaban: 0, descartados: 0, porResultado: { encolado: 1, reactivado: 0, ya_en_cola: 0, ya_enviado: 0, fallido_definitivo: 0, descartado_datos: 0, no_aplica: 0, error: 0 } },
        }),
      });
    });
    await page.route(/\/api\/siigo\/bandeja\/reenviar-correo/, (route) => {
      orden.push('reenviar-correo');
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          ambiente: 'produccion',
          items: [{ facturaId: CORREO_OK.facturaId, resultado: 'fallido', motivo: 'Siigo rechazó la dirección', guia: null, envioId: 'e1', destinatarios: 1 }],
          resumen: { total: 1, enviados: 0, descartados: 1, porResultado: { enviado: 0, fallido: 1, no_realizado: 0, descartado_datos: 0, error: 0 } },
        }),
      });
    });

    await page.goto('/siigo/operacion');
    await page.getByRole('checkbox', { name: 'Seleccionar todos los casos accionables de esta página' }).check();
    await page.getByRole('button', { name: /^Reintentar 2 casos$/ }).click();
    await expect(page.getByText('Se van a intentar 2 de los 2 seleccionados.')).toBeVisible();
    await page.getByRole('button', { name: /^Reintentar 2 casos$/ }).last().click();

    await expect(page.getByRole('heading', { name: 'Reintento en lote · resultado' })).toBeVisible();
    expect(orden).toEqual(['reintentar', 'reenviar-correo']);

    // Lo encolado NO se canta como éxito: lo que salió fue la orden, no la factura.
    await expect(page.getByText(/En cola para emitir/)).toBeVisible();
    await expect(page.getByText(/Reintentados con éxito/)).toHaveCount(0);
    await expect(page.getByText(/Siigo rechazó el envío/)).toBeVisible();
  });

  test('si el bloque de emisión falla, el de correo se ejecuta IGUAL', async ({ page }) => {
    const CORREO_OK = { ...CASO_CORREO, guia: guia({ codigo: 'smtp', descripcion: 'El envío falló.', accion: 'Vuelve a mandarlo.' }) };
    let correoLlamado = false;
    await loginAs(page, ADMIN_USER);
    await mockBandeja(page, { items: [CASO_EMISION, CORREO_OK] });
    await page.route(/\/api\/siigo\/bandeja\/reintentar/, (route) => route.fulfill({
      status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'la cola se cayó' }),
    }));
    await page.route(/\/api\/siigo\/bandeja\/reenviar-correo/, (route) => {
      correoLlamado = true;
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          ambiente: 'produccion',
          items: [{ facturaId: CORREO_OK.facturaId, resultado: 'enviado', motivo: null, guia: null, envioId: 'e1', destinatarios: 1 }],
          resumen: { total: 1, enviados: 1, descartados: 0, porResultado: { enviado: 1, fallido: 0, no_realizado: 0, descartado_datos: 0, error: 0 } },
        }),
      });
    });

    await page.goto('/siigo/operacion');
    await page.getByRole('checkbox', { name: 'Seleccionar todos los casos accionables de esta página' }).check();
    await page.getByRole('button', { name: /^Reintentar 2 casos$/ }).click();
    await page.getByRole('button', { name: /^Reintentar 2 casos$/ }).last().click();

    await expect(page.getByRole('alert').filter({ hasText: 'la cola se cayó' })).toBeVisible();
    expect(correoLlamado).toBe(true);
    await expect(page.getByText(/Correo: Enviados/)).toBeVisible();
  });

  test('la integración frenada inhabilita el lote y EXPLICA por qué', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockBandeja(page, { freno: FRENO_ACTIVO });
    await page.goto('/siigo/operacion');

    await expect(page.getByText('La integración con Siigo está frenada')).toBeVisible();
    await page.getByRole('checkbox', { name: 'Seleccionar FLIT-2044' }).check();

    const boton = page.getByRole('button', { name: /^Reintentar 1 casos$/ });
    await expect(boton).toBeDisabled();
    // El motivo vive en el banner, que sí es legible: `disabled` saca el botón del tabulador.
    const id = await boton.getAttribute('aria-describedby');
    expect(id).toBeTruthy();
    await expect(page.locator(`#${id}`)).toContainText('umbral');

    // Y dar por perdido SIGUE disponible: no sale hacia Siigo.
    await page.getByRole('button', { name: 'Ver el caso FLIT-2044' }).click();
    await expect(page.getByRole('button', { name: 'Dar por perdido' })).toBeEnabled();
  });
});

// ── AC5 — dar por perdido y registrar una corrección ────────────────────────

test.describe('AC5 — las dos acciones que exigen motivo', () => {
  test('dar por perdido: nace inhabilitado, manda la CLAVE y refleja la fila sin recargar', async ({ page }) => {
    let cuerpo: Record<string, unknown> | null = null;
    await loginAs(page, ADMIN_USER);
    await mockBandeja(page);
    await page.route(/\/api\/siigo\/bandeja\/descartar/, (route) => {
      cuerpo = route.request().postDataJSON();
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          fuente: 'emision', refId: REF_EMISION, facturaId: CASO_EMISION.facturaId,
          colaId: CASO_EMISION.colaId, estado: 'fallido_definitivo',
          descarte: {
            motivo: 'tramite_anulado', motivoEtiqueta: 'El trámite se anuló',
            nota: 'sin datos personales', usuarioId: 1, marcadoEn: '2026-08-23T12:00:00.000Z',
          },
        }),
      });
    });

    await page.goto('/siigo/operacion');
    await page.getByRole('button', { name: 'Ver el caso FLIT-2044' }).click();
    // Se toma DESPUÉS de abrir el caso: `?caso=` es lo único que esta pantalla escribe en la URL, y
    // lo que se afirma es que dar por perdido no navega ni recarga.
    const urlAntes = page.url();
    await page.getByRole('button', { name: 'Dar por perdido' }).click();

    const confirmar = page.getByRole('button', { name: 'Dar por perdido' }).last();
    await expect(confirmar).toBeDisabled();
    await expect(page.getByText('Elige un motivo para poder confirmar.')).toBeVisible();

    await page.getByRole('radio', { name: 'El trámite se anuló' }).check();
    await page.getByLabel('Nota (opcional)').fill('sin datos personales');
    await expect(confirmar).toBeEnabled();
    await confirmar.click();

    // La CLAVE del catálogo, nunca la etiqueta visible.
    await expect.poll(() => cuerpo).not.toBeNull();
    expect(cuerpo!).toMatchObject({ fuente: 'emision', refId: REF_EMISION, motivo: 'tramite_anulado' });

    // Sin recargar: misma URL, misma pantalla, la fila ya lo dice.
    await expect(page.getByText(/Dado por perdido el/).first()).toBeVisible();
    await expect(page.getByText('El trámite se anuló').first()).toBeVisible();
    expect(page.url()).toBe(urlAntes);
  });

  test('la nota avisa de los datos personales ANTES del campo y se corta en 200', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockBandeja(page);
    await page.goto('/siigo/operacion');
    await page.getByRole('button', { name: 'Ver el caso FLIT-2044' }).click();
    await page.getByRole('button', { name: 'Dar por perdido' }).click();

    await expect(page.getByText(/No escribas nombres, cédulas, NIT, teléfonos ni correos/)).toBeVisible();
    await page.getByLabel('Nota (opcional)').fill('x'.repeat(500));
    await expect(page.getByText('200/200')).toBeVisible();
  });

  test('el catálogo de motivos NO tiene «Otro»', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockBandeja(page);
    await page.goto('/siigo/operacion');
    await page.getByRole('button', { name: 'Ver el caso FLIT-2044' }).click();
    await page.getByRole('button', { name: 'Dar por perdido' }).click();

    await expect(page.getByRole('radio', { name: /^Otro/ })).toHaveCount(0);
    await expect(page.getByRole('radio')).toHaveCount(5);
  });

  test('un rechazo de la DIAN no ofrece «dar por perdido»: se corrige', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockBandeja(page);
    await page.goto('/siigo/operacion');
    await page.getByRole('button', { name: 'Ver el caso FLIT-2019' }).click();

    await expect(page.getByRole('button', { name: 'Dar por perdido' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Registrar una corrección' })).toBeVisible();
  });

  test('la corrección: motivo corto no se envía, y la opción no admisible lleva SU motivo', async ({ page }) => {
    let hubo = false;
    await loginAs(page, ADMIN_USER);
    await mockBandeja(page);
    await page.route(/\/api\/siigo\/correcciones\/factura\//, async (route) => {
      if (route.request().method() === 'POST') { hubo = true; return route.abort(); }
      return route.fallback();
    });
    await page.goto('/siigo/operacion');
    await page.getByRole('button', { name: 'Ver el caso FLIT-2019' }).click();
    await page.getByRole('button', { name: 'Registrar una corrección' }).click();

    // Una opción no admisible se pinta INHABILITADA con su motivo al lado, no se oculta.
    const borrado = page.getByRole('radio', { name: /Borrado/ });
    await expect(borrado).toBeDisabled();
    await expect(page.getByText('ya pasaron más de 24 horas')).toBeVisible();

    await page.getByRole('radio', { name: /Anulación/ }).check();
    await page.getByLabel('Documento en Siigo (obligatorio)').fill('NC-991');
    await page.getByLabel(/^Motivo \(obligatorio/).fill('corto');
    await page.getByRole('button', { name: 'Registrar la corrección' }).click();

    await expect(page.getByRole('alert').filter({ hasText: 'al menos 10 caracteres' })).toBeVisible();
    expect(hubo).toBe(false);
  });
});

// ── AC6 — la línea de tiempo ────────────────────────────────────────────────

test.describe('AC6 — la línea de tiempo', () => {
  test('los hitos van en orden con fecha, resultado y origen; lo que no fue llamada dice FLITO', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockBandeja(page);
    await page.goto('/siigo/operacion');
    await page.getByRole('button', { name: 'Ver el caso FLIT-2044' }).click();

    const hitos = page.getByRole('listitem');
    await expect(hitos).toHaveCount(3);
    await expect(hitos.nth(0)).toContainText('Liquidación');
    await expect(hitos.nth(0)).toContainText('Correcto');
    // `encolada` no salió a la red: pintarla como «Siigo» diría que hubo una petición que no hubo.
    await expect(hitos.nth(1)).toContainText('FLITO');
    await expect(hitos.nth(2)).toContainText('Con error');
    await expect(hitos.nth(2)).toContainText('parameter_required — city_code');
  });

  test('un trámite sin facturación iniciada LO DICE', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockBandeja(page);
    await page.unroute(/\/api\/siigo\/linea-tiempo\//);
    await page.route(/\/api\/siigo\/linea-tiempo\//, (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ tramiteId: TRAMITE, facturacionIniciada: false, facturaId: null, hitos: [] }),
    }));
    await page.goto('/siigo/operacion');
    await page.getByRole('button', { name: 'Ver el caso FLIT-2044' }).click();

    await expect(page.getByText('Este trámite nunca se envió a facturación electrónica.')).toBeVisible();
  });

  test('con factura y sin hitos el mensaje es OTRO: es una laguna, no un trámite sin actividad', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockBandeja(page);
    await page.unroute(/\/api\/siigo\/linea-tiempo\//);
    await page.route(/\/api\/siigo\/linea-tiempo\//, (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ tramiteId: TRAMITE, facturacionIniciada: true, facturaId: 'f', hitos: [] }),
    }));
    await page.goto('/siigo/operacion');
    await page.getByRole('button', { name: 'Ver el caso FLIT-2044' }).click();

    await expect(page.getByText(/Es un dato incompleto del registro/)).toBeVisible();
    await expect(page.getByText('Este trámite nunca se envió a facturación electrónica.')).toHaveCount(0);
  });

  test('si la línea de tiempo falla, las acciones del detalle SIGUEN disponibles', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockBandeja(page);
    await page.unroute(/\/api\/siigo\/linea-tiempo\//);
    await page.route(/\/api\/siigo\/linea-tiempo\//, (route) => route.fulfill({
      status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'la bitácora no responde' }),
    }));
    await page.goto('/siigo/operacion');
    await page.getByRole('button', { name: 'Ver el caso FLIT-2044' }).click();

    await expect(page.getByRole('alert').filter({ hasText: 'la bitácora no responde' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Volver a cargar la línea de tiempo' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Dar por perdido' })).toBeEnabled();
  });
});

// ── AC7 y PII ───────────────────────────────────────────────────────────────

test.describe('AC7 — no repite el reporte de costos, y la PII no se escapa', () => {
  test('no hay costos ni totales de dinero: solo lo detenido', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockBandeja(page);
    await page.goto('/siigo/operacion');
    await expect(page.getByRole('cell', { name: 'Transportes del Norte S.A.S.' })).toBeVisible();

    const texto = (await page.getByRole('table').innerText()).toLowerCase();
    for (const palabra of ['valor', 'costo', 'liquidar', 'subtotal', 'iva', '$']) {
      expect(texto).not.toContain(palabra);
    }
    // Y el enlace explícito a donde SÍ está eso.
    await expect(page.getByRole('link', { name: /Ve al reporte de costos/ })).toBeVisible();
  });

  test('ni la lista ni la URL llevan NIT, correo ni teléfono', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockBandeja(page);
    await page.goto('/siigo/operacion');
    await expect(page.getByRole('cell', { name: 'Transportes del Norte S.A.S.' })).toBeVisible();

    const texto = await page.getByRole('table').innerText();
    expect(texto).not.toMatch(/\d{6,}/);
    expect(texto).not.toContain('@');

    await page.getByRole('button', { name: 'Ver el caso FLIT-2044' }).click();
    // El enlace del caso es un uuid opaco y nada más.
    expect(new URL(page.url()).search).toBe(`?caso=${REF_EMISION}`);
    expect(page.url()).not.toContain('@');
    expect(page.url()).not.toContain('Transportes');
  });
});
