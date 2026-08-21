import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER, FINANCIERA_USER, CONDUCTOR_USER } from '../helpers/auth';

// Facturación electrónica — pestaña «Terceros»: revisar y sincronizar (HU #11299, Feature #11241).
//
// Backend mockeado, como en `siigo-parametrizacion.spec.ts`. Lo que se prueba es la pantalla: qué
// puede hacer cada rol, los cuatro estados con el ERROR antes que el vacío, que un cliente
// incompleto vea QUÉ le falta en vez de un «Error interno del servidor», que ninguna ciudad se
// pueda confirmar en bloque, y que en modo simulado la marca viaje también donde estaría la
// mentira — en los encabezados del resultado, no solo en el banner de arriba.
//
// La sincronización es SECUENCIAL y con pausa entre llamadas (tope del limitador de Siigo), así que
// los tests que lanzan una tanda amplían su tiempo a mano: el reloj lo pone el producto, no ellos.

type Page = import('@playwright/test').Page;

const RUTA = '/siigo/parametrizacion?seccion=terceros';

/** Un cliente listo para facturar. */
const listo = (clienteId: number, nombre: string, documento: string) => ({
  clienteId, nombre, documento, facturable: true, pendienteClasificacion: false, faltantes: [],
});

const CARGA_RAPIDA = {
  clienteId: 6,
  nombre: 'CARGA RÁPIDA',
  documento: '901.222.333',
  facturable: false,
  pendienteClasificacion: true,
  faltantes: [
    { motivo: 'tipo_persona_sin_clasificar', detalle: 'Falta clasificar si es empresa o persona natural.' },
    { motivo: 'responsabilidad_fiscal_faltante', detalle: 'Falta la responsabilidad fiscal ante la DIAN.', campo: 'fiscalResponsibilities' },
    { motivo: 'direccion_faltante', detalle: 'Falta la dirección.', campo: 'address' },
    { motivo: 'ubicacion_faltante', detalle: 'Falta el país, el departamento o la ciudad en códigos de Siigo.' },
    { motivo: 'telefono_faltante', detalle: 'Falta el teléfono separado en indicativo y número.' },
    { motivo: 'contacto_faltante', detalle: 'Falta el nombre de la persona de contacto.' },
  ],
};

const FACTURABLES = [
  listo(1, 'TRANSPORTES DEL SUR S.A.S.', '900.123.456'),
  listo(2, 'LOGÍSTICA ANDINA LTDA.', '830.111.222'),
  listo(3, 'CARLOS PÉREZ', '79.123.456'),
  listo(4, 'AGRÍCOLA EL ROBLE', '811.444.555'),
  listo(5, 'MINAS DEL NORTE', '900.777.888'),
];

const RESUMEN = {
  total: 6,
  facturables: 5,
  noFacturables: 1,
  pendientesClasificacion: 1,
  porMotivo: [
    { motivo: 'direccion_faltante', detalle: 'Falta la dirección.', clientes: 1 },
    { motivo: 'tipo_persona_sin_clasificar', detalle: 'Falta clasificar si es empresa o persona natural.', clientes: 1 },
    { motivo: 'identificacion_duplicada', detalle: 'Otro cliente tiene la misma identificación en la misma sucursal: en Siigo serían el mismo tercero.', clientes: 1 },
  ],
};

const PROPUESTAS = {
  total: 3,
  data: [
    {
      clienteId: 1,
      nombre: 'TRANSPORTES DEL SUR S.A.S.',
      ciudadTexto: 'BOGOTA D.C.',
      propuesta: {
        textoOrigen: 'BOGOTA D.C.',
        certeza: 'exacta',
        candidatas: [{ countryCode: 'Co', stateCode: '11', stateName: 'Bogotá D.C.', cityCode: '11001', cityName: 'Bogotá D.C.', puntaje: 1 }],
      },
    },
    {
      clienteId: 4,
      nombre: 'AGRÍCOLA EL ROBLE',
      ciudadTexto: 'San Pedro',
      propuesta: {
        textoOrigen: 'San Pedro',
        certeza: 'ambigua',
        candidatas: [
          { countryCode: 'Co', stateCode: '05', stateName: 'Antioquia', cityCode: '05664', cityName: 'San Pedro', puntaje: 1 },
          { countryCode: 'Co', stateCode: '70', stateName: 'Sucre', cityCode: '70717', cityName: 'San Pedro', puntaje: 1 },
          { countryCode: 'Co', stateCode: '76', stateName: 'Valle', cityCode: '76670', cityName: 'San Pedro', puntaje: 1 },
          { countryCode: 'Co', stateCode: '05', stateName: 'Antioquia', cityCode: '05665', cityName: 'San Pedro de Urabá', puntaje: 0.8 },
        ],
      },
    },
    {
      clienteId: 5,
      nombre: 'MINAS DEL NORTE',
      ciudadTexto: 'Km 5 vía Cota',
      propuesta: { textoOrigen: 'Km 5 vía Cota', certeza: 'sin_equivalencia', candidatas: [] },
    },
  ],
};

const ESTADO_CIUDADES = {
  total: 6, conCodigo: 3, pendientes: 3, proponibles: 1, ambiguos: 1, sinEquivalencia: 1,
};

/** El 422 del contrato: la petición está bien, lo que no se sostiene es el estado de los datos. */
const RECHAZO_422 = {
  error: 'El cliente no se puede facturar todavía: Falta la dirección. Falta el nombre de la persona de contacto.',
  codigo: 'cliente_no_facturable',
  clienteId: 5,
  faltantes: [
    { motivo: 'direccion_faltante', detalle: 'Falta la dirección.', campo: 'address' },
    { motivo: 'contacto_faltante', detalle: 'Falta el nombre de la persona de contacto.' },
  ],
};

interface OpcionesMock {
  modo?: 'mock' | 'real';
  resumen?: unknown;
  estadoResumen?: number;
  facturables?: unknown[];
  noFacturables?: unknown[];
  propuestas?: unknown;
  estadoPropuestas?: number;
}

const json = (body: unknown, status = 200) => ({
  status, contentType: 'application/json', body: JSON.stringify(body),
});

async function mockPanel(page: Page, o: OpcionesMock = {}) {
  const {
    modo = 'real', resumen = RESUMEN, estadoResumen = 200,
    facturables = FACTURABLES, noFacturables = [CARGA_RAPIDA],
    propuestas = PROPUESTAS, estadoPropuestas = 200,
  } = o;

  await page.route(/\/api\/siigo\/compuerta(\?|$)/, (route) => route.fulfill(json({
    ambiente: 'pruebas', modo, compuertaActiva: modo === 'real',
    emisionRealHabilitada: false, motivos: [], conceptosEvaluados: [],
  })));

  await page.route(/\/api\/siigo\/clientes\/validacion(\?|$)/, (route) => (
    estadoResumen === 200
      ? route.fulfill(json(resumen))
      : route.fulfill(json({ error: 'Se cayó la base' }, estadoResumen))));

  await page.route(/\/api\/siigo\/clientes\/validacion\/detalle/, (route) => {
    const url = new URL(route.request().url());
    // El bloque D pide TODOS (`incluirFacturables=true`) y filtra en memoria; el bloque B solo los
    // pendientes. Son dos consultas distintas al mismo endpoint.
    const todos = url.searchParams.get('incluirFacturables') === 'true';
    const data = todos ? [...facturables, ...noFacturables] : noFacturables;
    return route.fulfill(json({ total: data.length, data }));
  });

  await page.route(/\/api\/siigo\/clientes-ciudades\/estado/, (route) => route.fulfill(json(ESTADO_CIUDADES)));
  await page.route(/\/api\/siigo\/clientes-ciudades\/obsoletas/, (route) => route.fulfill(json({ total: 0, data: [] })));
  await page.route(/\/api\/siigo\/clientes-ciudades\/propuestas/, (route) => (
    estadoPropuestas === 200
      ? route.fulfill(json(propuestas))
      : route.fulfill(json({
        error: 'El catálogo de ubicaciones no tiene ciudades activas de Co.', codigo: 'catalogo_vacio',
      }, estadoPropuestas))));
}

/** Los desenlaces por cliente de una tanda: cuatro logrados y uno que no se pudo. */
async function mockSincronizacion(page: Page, alPedir?: (clienteId: number) => void) {
  const desenlaces: Record<number, string> = {
    1: 'creado', 2: 'vinculado_existente', 3: 'actualizado', 4: 'sin_cambios',
  };
  await page.route(/\/api\/siigo\/terceros\/cliente\/\d+$/, (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const id = Number(new URL(route.request().url()).pathname.split('/').pop());
    alPedir?.(id);
    const desenlace = desenlaces[id];
    if (desenlace === undefined) return route.fulfill(json(RECHAZO_422, 422));
    return route.fulfill(json({
      clienteId: id, siigoCustomerId: `siigo-${id}`, identificacion: '900', sucursal: 0, desenlace,
    }));
  });
}

test.describe('AC1 — acceso y permisos por rol', () => {
  test('un rol sin el permiso de la pantalla no entra ni por el enlace directo', async ({ page }) => {
    await loginAs(page, CONDUCTOR_USER);
    await mockPanel(page);
    await page.goto(RUTA);

    await expect(page.getByRole('heading', { name: /No tienes acceso/ })).toBeVisible();
    await expect(page.getByText('¿A cuántos se les puede facturar?')).toHaveCount(0);
  });

  test('financiera consulta el panel, alcanza los controles y no dispara ninguna escritura', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockPanel(page);
    let escrituras = 0;
    await page.route(/\/api\/siigo\/(terceros\/cliente|clientes-ciudades\/\d+\/confirmar)/, (route) => {
      if (route.request().method() === 'POST') escrituras += 1;
      return route.fulfill(json({}));
    });
    await page.goto(RUTA);

    // Ve los informes.
    await expect(page.getByText(/pueden recibir factura electrónica/)).toBeVisible();
    await expect(page.getByText('CARGA RÁPIDA')).toBeVisible();

    // El botón de sincronizar la fila EXISTE y se alcanza (no está `disabled`, que lo sacaría del
    // orden de tabulación junto con su explicación), pero está marcado como no disponible.
    const sincronizarFila = page.getByRole('button', { name: 'Sincronizar', exact: true });
    await expect(sincronizarFila).toHaveAttribute('aria-disabled', 'true');
    await sincronizarFila.focus();
    await expect(sincronizarFila).toBeFocused();
    // `force`: Playwright trata `aria-disabled` como inhabilitado y se niega a pulsarlo — que es
    // justo lo que se quiere comprobar. Se fuerza el clic para verificar además que, si alguien lo
    // pulsa de todos modos, no sale ninguna petición de escritura.
    await sincronizarFila.click({ force: true });

    // Y la explicación está escrita una sola vez y referenciada desde el botón.
    const idExplicacion = await sincronizarFila.getAttribute('aria-describedby');
    expect(idExplicacion).toBe('permiso-terceros-lista');
    await expect(page.locator(`#${idExplicacion}`)).toContainText(/lo(s)? hace administración/);

    // Lo mismo en la cola de ciudades.
    await page.getByRole('button', { name: /Revisar las propuestas/ }).click();
    const confirmar = page.getByRole('button', { name: 'Confirmar', exact: true }).first();
    await expect(confirmar).toHaveAttribute('aria-disabled', 'true');
    await confirmar.click({ force: true });

    expect(escrituras).toBe(0);
  });

  test('admin sí dispone de las dos acciones', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockPanel(page);
    await page.goto(RUTA);

    const sincronizarFila = page.getByRole('button', { name: 'Sincronizar', exact: true });
    await expect(sincronizarFila).not.toHaveAttribute('aria-disabled', 'true');

    await page.getByRole('button', { name: /Revisar las propuestas/ }).click();
    await expect(page.getByRole('button', { name: 'Confirmar', exact: true }).first())
      .not.toHaveAttribute('aria-disabled', 'true');
  });
});

test.describe('AC2 — los cuatro estados, con el error antes que el vacío', () => {
  test('cargando y lleno', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockPanel(page);
    let soltar: (() => void) | null = null;
    await page.route(/\/api\/siigo\/clientes\/validacion(\?|$)/, async (route) => {
      await new Promise<void>((r) => { soltar = r; });
      return route.fulfill(json(RESUMEN));
    });

    await page.goto(RUTA);
    await expect(page.getByText('Revisando la cartera…')).toBeVisible();

    soltar!();
    await expect(page.getByText(/pueden recibir factura electrónica/)).toBeVisible();
  });

  test('el error se dice, se reintenta, y no tumba los bloques de ciudades ni de sincronización', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockPanel(page);
    let intentos = 0;
    await page.route(/\/api\/siigo\/clientes\/validacion(\?|$)/, (route) => {
      intentos += 1;
      return intentos === 1
        ? route.fulfill(json({ error: 'Se cayó la base' }, 500))
        : route.fulfill(json(RESUMEN));
    });

    await page.goto(RUTA);
    await expect(page.getByText(/No se pudo revisar la cartera/)).toBeVisible();
    // Nunca «no hay clientes pendientes»: con la consulta caída nadie comprobó nada.
    await expect(page.getByText('Ningún cliente activo tiene datos pendientes.')).toHaveCount(0);
    // Un fallo del informe no tumba la pestaña.
    await expect(page.getByRole('heading', { name: 'Equivalencias de ciudad' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sincronizar terceros con Siigo' })).toBeVisible();

    await page.getByRole('button', { name: 'Reintentar' }).first().click();
    await expect(page.getByText(/pueden recibir factura electrónica/)).toBeVisible();
    expect(intentos).toBeGreaterThan(1);
  });

  test('el vacío no es «no hay nada»: es que toda la cartera está lista', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockPanel(page, {
      resumen: { total: 5, facturables: 5, noFacturables: 0, pendientesClasificacion: 0, porMotivo: [] },
      noFacturables: [],
    });
    await page.goto(RUTA);

    await expect(page.getByText(/Los 5 clientes activos pueden recibir factura electrónica/)).toBeVisible();
    await expect(page.getByText('No hay nada que corregir aquí.')).toBeVisible();
    // Y sin pendientes no se pinta la lista de pendientes.
    await expect(page.getByRole('heading', { name: 'Clientes que todavía no' })).toHaveCount(0);
  });
});

test.describe('AC3 y AC4 — el resumen encabeza, y el detalle dice qué falta', () => {
  test('las cifras llevan a su listado y la pastilla filtra por la petición, no por la URL', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockPanel(page);
    const consultas: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/validacion/detalle')) consultas.push(r.url());
    });

    await page.goto(RUTA);
    await expect(page.getByText('6', { exact: false }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Ver los 1 que no pueden todavía/ })).toBeVisible();

    await page.getByRole('button', { name: /Falta la dirección/ }).click();
    await expect(page.getByText('Filtrado por: Falta la dirección.')).toBeVisible();

    await expect.poll(() => consultas.some((u) => u.includes('motivo=direccion_faltante'))).toBe(true);
    // El filtro viaja en la petición; la URL del SPA sigue sin nada de nadie.
    expect(new URL(page.url()).search).toBe('?seccion=terceros');
  });

  test('seis carencias se pintan en DOS grupos, una por línea y con el texto del servidor', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockPanel(page);
    await page.goto(RUTA);

    await page.getByRole('button', { name: /CARGA RÁPIDA/ }).click();

    await expect(page.getByRole('heading', { name: 'Hay que decidir (1)' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Hay que capturar (5)' })).toBeVisible();
    // Acotado al detalle del cliente: la pastilla de filtro del resumen anuncia la MISMA frase.
    const detalle = page.locator('#faltantes-cliente-6');
    await expect(detalle.getByText('Falta clasificar si es empresa o persona natural.')).toBeVisible();
    await expect(detalle.getByText('Falta la responsabilidad fiscal ante la DIAN.')).toBeVisible();
    // Una lista de verdad: el lector anuncia «lista de 5 elementos».
    await expect(page.locator('#faltantes-cliente-6 li')).toHaveCount(6);
    // Y el aviso de que la lista puede CRECER al clasificar está antes, no después.
    await expect(page.getByText(/pueden aparecer datos nuevos/)).toBeVisible();
  });

  test('un cliente incompleto ve QUÉ le falta, no «Error interno del servidor»', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockPanel(page);
    await page.route(/\/api\/siigo\/terceros\/cliente\/6$/, (route) => (
      route.request().method() === 'POST'
        ? route.fulfill(json({ ...RECHAZO_422, clienteId: 6 }, 422))
        : route.continue()));

    await page.goto(RUTA);
    await page.getByRole('button', { name: 'Sincronizar', exact: true }).click();

    await expect(page.getByText('No se pudo sincronizar: hay que corregir la ficha.')).toBeVisible();
    await expect(page.getByText('Falta la dirección.').first()).toBeVisible();
    await expect(page.getByText('Error interno del servidor')).toHaveCount(0);
  });
});

test.describe('AC5 — las equivalencias se confirman una a una', () => {
  test('la ambigua no trae nada marcado y no se puede confirmar hasta elegir', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockPanel(page);
    await page.goto(RUTA);
    await page.getByRole('button', { name: /Revisar las propuestas/ }).click();

    await expect(page.getByText('Hay 4 posibles')).toBeVisible();
    // Ninguna candidata viene marcada: es lo que rompe la cadena de «Enter».
    const radios = page.getByRole('radio', { name: /San Pedro/ });
    await expect(radios.first()).not.toBeChecked();
    expect(await radios.count()).toBe(4);

    const fila = page.locator('li', { hasText: 'AGRÍCOLA EL ROBLE' });
    const confirmar = fila.getByRole('button', { name: 'Confirmar' });
    await expect(confirmar).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByText('Elige un municipio para poder confirmar.').first()).toBeVisible();

    await radios.first().check();
    await expect(confirmar).not.toHaveAttribute('aria-disabled', 'true');

    // Y en toda la pestaña no existe ningún control que confirme más de una a la vez.
    await expect(page.getByRole('button', { name: /confirmar todas/i })).toHaveCount(0);
    await expect(page.getByText('No hay «confirmar todas»: cada municipio sale impreso en una factura ante la DIAN.')).toBeVisible();
  });

  test('al confirmar, la fila se resuelve, se anuncia lo que queda y el foco salta a la siguiente', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockPanel(page);
    await page.route(/\/api\/siigo\/clientes-ciudades\/1\/confirmar/, (route) => route.fulfill(
      json({ clienteId: 1, cityCode: '11001', cityName: 'Bogotá D.C.' }),
    ));

    await page.goto(RUTA);
    await page.getByRole('button', { name: /Revisar las propuestas/ }).click();

    const primera = page.locator('li', { hasText: 'TRANSPORTES DEL SUR' }).getByRole('button', { name: 'Confirmar' });
    await primera.click();

    await expect(page.getByText(/Bogotá D\.C\. confirmada\. Quedan 2\./)).toBeVisible();
    await expect(page.getByText('TRANSPORTES DEL SUR S.A.S. → Bogotá D.C. (confirmada)')).toBeVisible();
    await expect(page.getByText('Confirmadas en esta sesión: 1')).toBeVisible();
    // El foco encadenado: la siguiente pendiente, sin ratón y sin volver a buscar dónde se estaba.
    await expect(page.locator('#confirmar-ciudad-4')).toBeFocused();
  });

  test('un catálogo vacío no se lee como «todas las ciudades están confirmadas»', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockPanel(page, { estadoPropuestas: 409 });
    await page.goto(RUTA);
    await page.getByRole('button', { name: /Revisar las propuestas/ }).click();

    await expect(page.getByText(/El catálogo de ubicaciones no tiene ciudades activas/)).toBeVisible();
    await expect(page.getByText('Todas las ciudades están confirmadas en códigos de Siigo.')).toHaveCount(0);
  });
});

test.describe('AC6 — la sincronización dice qué pasó con cada cliente', () => {
  test('un cliente no facturable no se puede seleccionar para la tanda', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockPanel(page);
    await page.goto(RUTA);

    await expect(page.getByRole('checkbox', { name: /TRANSPORTES DEL SUR/ })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: /CARGA RÁPIDA/ })).toHaveCount(0);
    await expect(page.getByText(/1 clientes no se pueden seleccionar todavía porque les faltan datos/)).toBeVisible();
  });

  test('cinco desenlaces distintos, los fallos arriba, y la acción inhabilitada mientras corre', async ({ page }) => {
    test.setTimeout(90_000);
    await loginAs(page, ADMIN_USER);
    await mockPanel(page);
    const pedidos: number[] = [];
    let simultaneas = 0;
    let maxSimultaneas = 0;
    await mockSincronizacion(page, (id) => {
      pedidos.push(id);
      simultaneas += 1;
      maxSimultaneas = Math.max(maxSimultaneas, simultaneas);
      setTimeout(() => { simultaneas -= 1; }, 10);
    });

    await page.goto(RUTA);
    for (const nombre of ['TRANSPORTES DEL SUR', 'LOGÍSTICA ANDINA', 'CARLOS PÉREZ', 'AGRÍCOLA EL ROBLE', 'MINAS DEL NORTE']) {
      await page.getByRole('checkbox', { name: new RegExp(nombre) }).check();
    }

    const boton = page.getByRole('button', { name: /^Sincronizar 5 en pruebas$/ });
    await boton.click();
    // Mientras corre no se puede pulsar dos veces.
    await expect(page.getByRole('button', { name: 'Sincronizando…' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Detener' })).toBeVisible();

    // Cinco grupos distintos: el fallo primero, y `sin_cambios` NO se cuenta como actualizado.
    await expect(page.getByText('No se pudo (1)')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Creado en Siigo (1)')).toBeVisible();
    await expect(page.getByText('Vinculado a uno que ya existía (1)')).toBeVisible();
    await expect(page.getByText('Actualizado en Siigo (1)')).toBeVisible();
    await expect(page.getByText('Ya estaba al día (1)')).toBeVisible();
    await expect(page.getByText('4 sincronizados · 1 no se pudieron')).toBeVisible();

    // El fallo del cliente incompleto nombra sus carencias y ofrece la ficha.
    await expect(page.getByText('Falta la dirección.').first()).toBeVisible();

    // `creado` y `vinculado` se distinguen también por tener o no verificación.
    await expect(page.getByRole('button', { name: 'Copiar el id para buscarlo en Siigo' })).toHaveCount(1);

    // Una a la vez, y exactamente cinco: ni una petición de más.
    expect(pedidos).toEqual([1, 2, 3, 4, 5]);
    expect(maxSimultaneas).toBe(1);
    // Nada de identificadores de cliente en la URL del SPA.
    expect(new URL(page.url()).search).toBe('?seccion=terceros');
  });
});

test.describe('AC7 — el modo simulado se señaliza', () => {
  test('el aviso es permanente, dice las dos cosas, y la marca viaja hasta los resultados', async ({ page }) => {
    test.setTimeout(60_000);
    await loginAs(page, ADMIN_USER);
    await mockPanel(page, { modo: 'mock' });
    await mockSincronizacion(page);
    await page.goto(RUTA);

    await expect(page.getByText(/los datos vienen del simulador/i)).toBeVisible();
    await expect(page.getByText(/no existen en Siigo\s+Nube/i)).toBeVisible();
    await expect(page.getByText(/SIMULADO — nada de lo que salga aquí llegó a Siigo Nube/)).toBeVisible();

    await page.getByRole('checkbox', { name: /TRANSPORTES DEL SUR/ }).check();
    await page.getByRole('button', { name: /^Sincronizar 1 en pruebas$/ }).click();

    // La marca va donde estaría la mentira: en el encabezado del grupo, no solo arriba.
    await expect(page.getByText('Creado en Siigo (simulado) (1)')).toBeVisible({ timeout: 30_000 });
  });

  test('en modo real no hay aviso de simulador, y el ambiente del bloque D no lo mueve el selector', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockPanel(page, { modo: 'real' });
    await page.goto(RUTA);

    await expect(page.getByText(/los datos vienen del simulador/i)).toHaveCount(0);
    await expect(page.getByText(/Se sincroniza contra el ambiente/)).toContainText('pruebas');

    // Cambiar el selector de la cabecera NO cambia contra qué ambiente se sincroniza: eso lo decide
    // el servidor, y la pantalla sigue diciendo el suyo.
    await page.getByLabel('Ambiente').selectOption('produccion');
    await expect(page.getByText(/Se sincroniza contra el ambiente/)).toContainText('pruebas');
    await expect(page.getByText(/El selector de arriba no cambia esto/)).toBeVisible();
  });
});
