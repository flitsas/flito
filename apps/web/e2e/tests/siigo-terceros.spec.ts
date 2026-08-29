import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER, AUDITOR_USER, FINANCIERA_USER, CONDUCTOR_USER } from '../helpers/auth';

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

/**
 * La tercera cifra del AC3. `totalClientes` repite a propósito el total de `RESUMEN`: en el
 * servidor sale del mismo criterio de cliente activo, y una tarjeta con dos totales distintos sería
 * una contradicción a la vista.
 */
const RESUMEN_TERCEROS = { totalClientes: 6, conTercero: 2 };

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
  resumenTerceros?: unknown;
  estadoResumenTerceros?: number;
}

const json = (body: unknown, status = 200) => ({
  status, contentType: 'application/json', body: JSON.stringify(body),
});

async function mockPanel(page: Page, o: OpcionesMock = {}) {
  const {
    modo = 'real', resumen = RESUMEN, estadoResumen = 200,
    facturables = FACTURABLES, noFacturables = [CARGA_RAPIDA],
    propuestas = PROPUESTAS, estadoPropuestas = 200,
    resumenTerceros = RESUMEN_TERCEROS, estadoResumenTerceros = 200,
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

  // El conteo de terceros vinculados (AC3). Va aquí y no en cada test porque el panel lo pide al
  // abrirse: sin este mock, la tarjeta arrancaría con la tercera cifra en error en los 16 tests que
  // no hablan de ella.
  await page.route(/\/api\/siigo\/terceros\/resumen(\?|$)/, (route) => (
    estadoResumenTerceros === 200
      ? route.fulfill(json(resumenTerceros))
      : route.fulfill(json({ error: 'Se cayó la base' }, estadoResumenTerceros))));

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

/**
 * Lo que el modal de ficha fiscal pide al abrirse. Va aparte de `mockPanel` porque solo lo necesita
 * el test que abre la ficha: en los demás el modal ni se monta.
 *
 * La fila que devuelve `/clients` son las 26 columnas de `COLUMNAS_LISTADO` (`clients.pii.ts`), ni
 * una más: el AC8 recortó esa respuesta y `notes` y `active` —que este doble seguía entregando— ya
 * no salen de ahí. Un doble que simula lo que el producto dejó de devolver no falla hoy, pero
 * mañana le dice a quien lo lea que la ruta entrega la fila entera, que es justo lo que esta HU
 * quitó.
 *
 * `pedidos` recoge los `clienteId` cuya validación se consultó. Es lo que permite afirmar que la
 * ficha abierta es la del cliente de la fila y no solo que el título lo diga.
 */
async function mockFichaFiscal(page: Page, pedidos: number[]) {
  await page.route(/\/api\/clients(\?|$)/, (route) => (
    route.request().method() === 'GET'
      ? route.fulfill(json([{
        id: CARGA_RAPIDA.clienteId, name: CARGA_RAPIDA.nombre, document: '901222333',
        documentType: 'NIT', phone: null, email: null, address: null, city: 'Km 5 vía Cota',
        soatAutogestionable: false, soatSinTramite: false, impuestosAutogestionable: false,
        logisticaAutogestionable: false, logisticaPermiteParcial: false,
        personType: null, idType: null, checkDigit: null, fiscalResponsibilities: [],
        countryCode: null, stateCode: null, cityCode: null, commercialName: null, branchOffice: 0,
        contactFirstName: null, contactLastName: null, contactEmail: null,
        phoneIndicative: null, phoneNumber: null,
      }]))
      : route.continue()));

  await page.route(/\/api\/siigo\/clientes\/\d+\/validacion/, (route) => {
    const id = Number(/clientes\/(\d+)\/validacion/.exec(route.request().url())![1]);
    pedidos.push(id);
    return route.fulfill(json({ ...CARGA_RAPIDA, clienteId: id }));
  });

  // El catálogo de ubicaciones de la cascada. Sin esto el modal pinta la cascada vacía y el aviso
  // de «catálogo no cargado», que no es lo que este test mira.
  await page.route(/\/api\/siigo\/ciudades$/, (route) => route.fulfill(
    json({ cargado: true, total: 4605, activas: 4605, version: '2026-08-06' }),
  ));
  await page.route(/\/api\/siigo\/ciudades\/paises/, (route) => route.fulfill(
    json({ data: [{ codigo: 'Co', nombre: 'Colombia' }] }),
  ));
  await page.route(/\/api\/siigo\/ciudades\/Co\/departamentos/, (route) => route.fulfill(
    json({ data: [{ codigo: '11', nombre: 'Bogotá D.C' }] }),
  ));
  await page.route(/\/api\/siigo\/ciudades\/Co\/\d+\/ciudades/, (route) => route.fulfill(
    json({ data: [{ codigo: '11001', nombre: 'Bogotá D.C.' }] }),
  ));
  await page.route(/\/api\/siigo\/clientes-ciudades\/\d+\/propuesta$/, (route) => route.fulfill(
    json({ textoOrigen: 'Km 5 vía Cota', certeza: 'sin_equivalencia', candidatas: [] }),
  ));
}

test.describe('AC1 — acceso y permisos por rol', () => {
  test('un rol sin el permiso de la pantalla no entra ni por el enlace directo', async ({ page }) => {
    await loginAs(page, CONDUCTOR_USER);
    await mockPanel(page);
    await page.goto(RUTA);

    await expect(page.getByRole('heading', { name: /No tienes acceso/ })).toBeVisible();
    await expect(page.getByText('¿A cuántos se les puede facturar?')).toHaveCount(0);
  });

  test('financiera dispara la sincronización de terceros: la petición sale, no solo el botón', async ({ page }) => {
    // Esta prueba afirmaba lo contrario —«financiera no dispara ninguna escritura»— y el AC1 se
    // reescribió (decisión de PO del 2026-08-22) para decir lo que el servidor ya hacía:
    // `POST /siigo/terceros/cliente/:id` está guardado con `exigirAccionSiigo('emitir')`, que
    // resuelve a admin + financiera. Que el botón esté habilitado no prueba que llame, así que la
    // petición se intercepta y se CUENTA, como hace el AC5 con las confirmaciones.
    await loginAs(page, FINANCIERA_USER);
    await mockPanel(page);
    const sincronizados: number[] = [];
    await mockSincronizacion(page, (id) => { sincronizados.push(id); });
    await page.goto(RUTA);

    // Ve los informes.
    await expect(page.getByText(/pueden recibir factura electrónica/)).toBeVisible();

    // Bloque D — una tanda de uno. Sin `force` a propósito: si el control estuviera marcado como no
    // disponible, Playwright se negaría a pulsarlo y el test caería aquí.
    await page.getByRole('checkbox', { name: /TRANSPORTES DEL SUR/ }).check();
    await page.getByRole('button', { name: /^Sincronizar 1 en pruebas$/ }).click();
    await expect(page.getByText('Creado en Siigo (1)')).toBeVisible({ timeout: 30_000 });
    expect(sincronizados).toEqual([1]);

    // Bloque B — el otro sitio donde se sincroniza: la fila suelta de un cliente incompleto.
    const sincronizarFila = page.getByRole('button', { name: 'Sincronizar', exact: true });
    await expect(sincronizarFila).not.toHaveAttribute('aria-disabled', 'true');
    await sincronizarFila.click();
    await expect(page.getByText('No se pudo sincronizar: hay que corregir la ficha.')).toBeVisible();
    expect(sincronizados).toEqual([1, CARGA_RAPIDA.clienteId]);

    // Y ningún control le anuncia que no puede lo que acaba de hacer.
    await expect(page.getByText(/Sincronizar escribe en Siigo/)).toHaveCount(0);
  });

  test('financiera NO confirma equivalencias de ciudad: alcanza el control, se le dice por qué, y no sale ni una confirmación', async ({ page }) => {
    // El contraste con la prueba anterior es el AC1 entero: el MISMO rol dispara una escritura y no
    // la otra. Mientras las dos colgaron de un único booleano, esto no se podía ni escribir.
    await loginAs(page, FINANCIERA_USER);
    await mockPanel(page);
    let confirmaciones = 0;
    await page.route(/\/api\/siigo\/clientes-ciudades\/\d+\/confirmar/, (route) => {
      if (route.request().method() === 'POST') confirmaciones += 1;
      return route.fulfill(json({ clienteId: 1, cityCode: '11001', cityName: 'Bogotá D.C.' }));
    });
    await page.goto(RUTA);

    // Por el nombre que NO cambia al abrirse: al plegarse dice «Ocultar las propuestas».
    const plegador = page.getByRole('button', { name: /las propuestas$/ });
    await plegador.click();

    const confirmar = page.locator('#confirmar-ciudad-1');
    await expect(confirmar).toHaveAttribute('aria-disabled', 'true');

    // Se alcanza con Tab: `disabled` lo sacaría del orden de tabulación y con él su explicación, así
    // que quien navega con teclado o con lector no sabría siquiera que la acción existe.
    await expect(plegador).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(confirmar).toBeFocused();

    // Y anuncia por qué, con el texto de SU acción y no con el de sincronizar.
    const idExplicacion = await confirmar.getAttribute('aria-describedby');
    expect(idExplicacion).toBe('permiso-ciudades');
    await expect(page.locator(`#${idExplicacion}`)).toContainText(/Confirmar una ciudad.*lo hace administración/s);

    // `force`: Playwright trata `aria-disabled` como inhabilitado y se niega a pulsarlo — que es
    // justo lo que se quiere. Se fuerza para comprobar que, si alguien lo pulsa de todos modos, no
    // sale ninguna petición.
    await confirmar.click({ force: true });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    expect(confirmaciones).toBe(0);
    await expect(page.getByText(/→ Bogotá D\.C\. \(confirmada\)/)).toHaveCount(0);
  });

  test('admin dispara las dos acciones: sincroniza y confirma', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockPanel(page);
    const sincronizados: number[] = [];
    const confirmados: number[] = [];
    await mockSincronizacion(page, (id) => { sincronizados.push(id); });
    await page.route(/\/api\/siigo\/clientes-ciudades\/\d+\/confirmar/, (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      confirmados.push(Number(/clientes-ciudades\/(\d+)\/confirmar/.exec(route.request().url())![1]));
      return route.fulfill(json({ clienteId: 1, cityCode: '11001', cityName: 'Bogotá D.C.' }));
    });
    await page.goto(RUTA);

    await page.getByRole('checkbox', { name: /TRANSPORTES DEL SUR/ }).check();
    await page.getByRole('button', { name: /^Sincronizar 1 en pruebas$/ }).click();
    await expect(page.getByText('Creado en Siigo (1)')).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: /Revisar las propuestas/ }).click();
    await page.locator('#confirmar-ciudad-1').click();
    await expect(page.getByText('TRANSPORTES DEL SUR S.A.S. → Bogotá D.C. (confirmada)')).toBeVisible();

    expect(sincronizados).toEqual([1]);
    expect(confirmados).toEqual([1]);
  });

  test('el rol de solo consulta no puede ninguna de las dos, y cada explicación dice quién sí', async ({ page }) => {
    // `auditor` es el único rol que llega a la pestaña sin poder sincronizar. Sin este caso, el
    // texto «lo hacen administración y financiera» no lo comprobaría nadie y podría quedarse
    // diciéndole a financiera que no puede lo que sí puede.
    await loginAs(page, AUDITOR_USER);
    await mockPanel(page);
    let escrituras = 0;
    await page.route(/\/api\/siigo\/(terceros\/cliente|clientes-ciudades\/\d+\/confirmar)/, (route) => {
      if (route.request().method() === 'POST') escrituras += 1;
      return route.fulfill(json({}));
    });
    await page.goto(RUTA);

    await expect(page.getByText('CARGA RÁPIDA')).toBeVisible();

    const sincronizarFila = page.getByRole('button', { name: 'Sincronizar', exact: true });
    await expect(sincronizarFila).toHaveAttribute('aria-disabled', 'true');
    await sincronizarFila.click({ force: true });
    const idSincronizar = await sincronizarFila.getAttribute('aria-describedby');
    expect(idSincronizar).toBe('permiso-terceros-lista');
    await expect(page.locator(`#${idSincronizar}`))
      .toContainText('lo hacen administración y financiera');

    await page.getByRole('button', { name: /Revisar las propuestas/ }).click();
    const confirmar = page.locator('#confirmar-ciudad-1');
    await expect(confirmar).toHaveAttribute('aria-disabled', 'true');
    await confirmar.click({ force: true });
    await expect(page.locator('#permiso-ciudades')).toContainText('lo hace administración');

    expect(escrituras).toBe(0);
  });

  test('recalcular los duplicados sigue siendo solo de administración, también para financiera', async ({ page }) => {
    // El tercer permiso del bloque B: `POST /validacion/recalcular-duplicados` está guardado con
    // `requireRole('admin')`, así que NO se movió con el AC1. Si volviera a colgar del permiso de
    // sincronizar, financiera vería un botón habilitado que el servidor le devuelve con un 403.
    await loginAs(page, FINANCIERA_USER);
    await mockPanel(page);
    let recalculos = 0;
    await page.route(/\/api\/siigo\/clientes\/validacion\/recalcular-duplicados/, (route) => {
      if (route.request().method() === 'POST') recalculos += 1;
      return route.fulfill(json({ marcados: 0, desmarcados: 0 }));
    });
    await page.goto(RUTA);

    await page.getByRole('button', { name: /Otro cliente tiene la misma identificación/ }).click();
    await expect(page.getByText(/Filtrado por: Otro cliente tiene la misma identificación/)).toBeVisible();
    const revisar = page.getByRole('button', { name: 'Volver a revisar los duplicados' });
    await expect(revisar).toHaveAttribute('aria-disabled', 'true');
    expect(await revisar.getAttribute('aria-describedby')).toBe('permiso-terceros-duplicados');
    await expect(page.locator('#permiso-terceros-duplicados'))
      .toContainText('reescribe las marcas de identificación de las fichas');

    await revisar.click({ force: true });
    await page.waitForTimeout(200);
    expect(recalculos).toBe(0);
  });

  test('financiera abre la ficha fiscal desde el panel y la ve en solo lectura: del modal no sale ni una escritura', async ({ page }) => {
    // La cuarta capacidad del panel, `editarFicha`. `PATCH /clients/:id` está guardado con
    // `requireRole('admin')`, así que un formulario editable para financiera no sería un permiso de
    // más: sería ofrecerle teclear la ficha entera para que el servidor se la devuelva con un 403
    // cuando pulse guardar.
    //
    // Se afirma por CONDUCTA y no por un atributo del formulario: un `disabled` que se cayera de un
    // campo, o un control de guardar llamado de otra forma, pasarían por debajo de cualquier
    // aserción sobre atributos. Lo que el AC protege es que de este modal no salga ni un PATCH
    // hacia la ficha, así que las escrituras se interceptan y se cuentan, como en el AC5 con las
    // confirmaciones.
    await loginAs(page, FINANCIERA_USER);
    await mockPanel(page);
    const fichasPedidas: number[] = [];
    await mockFichaFiscal(page, fichasPedidas);
    const escrituras: string[] = [];
    await page.route(/\/api\/clients\/\d+$/, (route) => {
      const metodo = route.request().method();
      if (metodo !== 'GET') escrituras.push(`${metodo} ${new URL(route.request().url()).pathname}`);
      return route.fulfill(json({ id: CARGA_RAPIDA.clienteId }));
    });

    await page.goto(RUTA);
    await page.locator('li', { hasText: 'CARGA RÁPIDA' })
      .getByRole('button', { name: 'Completar ficha' }).click();

    // La ve: el modal es el del cliente de la fila y trae sus datos, no una pantalla vacía ni un
    // «no tienes acceso». Consultar la ficha sí lo puede.
    const ficha = page.getByRole('dialog', { name: 'Datos fiscales · CARGA RÁPIDA' });
    const razonSocial = ficha.getByRole('textbox', { name: 'Razón social' });
    await expect(razonSocial).toHaveValue('CARGA RÁPIDA');
    await expect(ficha.getByText('Falta la dirección.')).toBeVisible();

    // Barrido del modal: se pulsa TODO lo que ofrece —salvo los cierres, que se llevarían por
    // delante lo que queda por barrer— y se comprueba tras cada pulsación que no salió nada. Un
    // control que guarde cae aquí aunque se llame de otro modo.
    const botones = ficha.getByRole('button');
    for (let i = 0; i < await botones.count(); i += 1) {
      const boton = botones.nth(i);
      // El aria-label primero: la «X» de la cabecera no tiene texto, solo su etiqueta.
      const nombre = (await boton.getAttribute('aria-label')) ?? (await boton.innerText()).trim();
      if (nombre === 'Cerrar') continue;
      // `force`: los inhabilitados también se pulsan a propósito — lo que se comprueba es que no
      // mandan nada, no que Playwright se niegue a pulsarlos.
      await boton.click({ force: true });
      await page.waitForTimeout(200);
      expect(escrituras, `«${nombre}» escribió en la ficha desde un rol que no la puede editar`).toEqual([]);
    }

    // La otra puerta es el teclado: «Enter» dentro de un formulario lo envía si hay un control de
    // envío, sin que nadie tenga que verlo ni pulsarlo. `force` porque los campos están
    // inhabilitados y Playwright se negaría a teclear en ellos.
    await razonSocial.press('Enter', { force: true });
    await page.waitForTimeout(200);
    expect(escrituras).toEqual([]);

    // El rótulo va al final a propósito: primero se comprueba que la ficha no escribe y solo
    // después que lo DICE. Al revés, cualquier deriva del permiso moriría en el rótulo y el
    // barrido —que es lo que de verdad guarda el AC— no llegaría a correr nunca.
    await expect(ficha.getByText('Tu rol puede consultar estos datos, no modificarlos.')).toBeVisible();

    // Y la lectura que sí hizo fue la de ESE cliente y ningún otro.
    expect([...new Set(fichasPedidas)]).toEqual([CARGA_RAPIDA.clienteId]);
  });

  test('admin abre la misma ficha y sí la guarda: el PATCH sale, y sale uno solo', async ({ page }) => {
    // El contrapeso, y lo que impide que el caso anterior sea trivial: si la ficha se montara en
    // solo lectura para todo el mundo —o dejara de montarse—, «financiera no escribe» pasaría en
    // verde sin decir nada de nadie. El MISMO botón del MISMO panel abre para admin una ficha que
    // guarda de verdad.
    await loginAs(page, ADMIN_USER);
    await mockPanel(page);
    const fichasPedidas: number[] = [];
    await mockFichaFiscal(page, fichasPedidas);
    const escrituras: string[] = [];
    await page.route(/\/api\/clients\/\d+$/, (route) => {
      const metodo = route.request().method();
      if (metodo !== 'GET') escrituras.push(`${metodo} ${new URL(route.request().url()).pathname}`);
      return route.fulfill(json({ id: CARGA_RAPIDA.clienteId }));
    });

    await page.goto(RUTA);
    await page.locator('li', { hasText: 'CARGA RÁPIDA' })
      .getByRole('button', { name: 'Completar ficha' }).click();

    const ficha = page.getByRole('dialog', { name: 'Datos fiscales · CARGA RÁPIDA' });
    const direccion = ficha.getByRole('textbox', { name: 'Dirección' });
    await expect(direccion).toBeEditable();
    await expect(ficha.getByText('Tu rol puede consultar estos datos, no modificarlos.')).toHaveCount(0);

    await direccion.fill('CALLE 100 # 15-20');
    await ficha.getByRole('button', { name: 'Guardar datos fiscales' }).click();

    await expect(page.getByText('Datos fiscales guardados')).toBeVisible();
    expect(escrituras).toEqual([`PATCH /api/clients/${CARGA_RAPIDA.clienteId}`]);
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

  test('si lo que se cae es el LISTADO, el listado lo dice y no se cuela «ningún cliente tiene datos pendientes»', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockPanel(page);
    // Se cae SOLO `/validacion/detalle`. El resumen de arriba sigue en pie y sigue diciendo que hay
    // 1 pendiente: es el escenario en el que el vacío mentiría mejor, porque la pantalla no se ve
    // rota por ninguna parte. Con el resumen caído —el otro test— la lista tiene filas de todos
    // modos y el vacío no llegaría a pintarse ni aunque el error no lo tapara.
    let caido = true;
    await page.route(/\/api\/siigo\/clientes\/validacion\/detalle/, (route) => {
      if (caido) return route.fulfill(json({ error: 'Se cayó la base' }, 500));
      const todos = new URL(route.request().url()).searchParams.get('incluirFacturables') === 'true';
      const data = todos ? [...FACTURABLES, CARGA_RAPIDA] : [CARGA_RAPIDA];
      return route.fulfill(json({ total: data.length, data }));
    });

    await page.goto(RUTA);

    await expect(page.getByText(/No se pudo traer la lista: Se cayó la base/)).toBeVisible();
    // Nunca «ningún cliente tiene datos pendientes»: la consulta que lo sabría no respondió. Y
    // encima contradiría al resumen de al lado, que sí cargó y dice que hay 1.
    await expect(page.getByText('Ningún cliente activo tiene datos pendientes.')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Ver los 1 que no pueden todavía/ })).toBeVisible();

    // El bloque D pide el mismo endpoint: su vacío tampoco puede aparecer en lugar del error.
    await expect(page.getByText(/No se pudo traer la lista de clientes listos/)).toBeVisible();
    await expect(page.getByText('No hay clientes que sincronizar.')).toHaveCount(0);

    // Y el error no es un callejón: reintentar trae la lista.
    caido = false;
    await page.getByRole('button', { name: 'Reintentar' }).first().click();
    await expect(page.getByRole('button', { name: 'CARGA RÁPIDA' })).toBeVisible();
    await expect(page.getByText(/No se pudo traer la lista: /)).toHaveCount(0);
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

  test('la tercera cifra dice cuántos clientes ya tienen tercero en Siigo y lleva a donde ese número se mueve', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockPanel(page);
    await page.goto(RUTA);

    // El número va dentro de la frase, no suelto: es lo que lee un lector de pantalla de corrido.
    await expect(page.getByText(/2 de los 6 clientes activos ya tienen tercero vinculado en Siigo/))
      .toBeVisible();

    // No hay listado de vinculados —costaría una petición por cliente y se descartó—, así que la
    // cifra lleva al único sitio donde ese número cambia: el bloque de sincronización.
    await page.getByRole('button', { name: 'Ir a sincronizar terceros' }).click();
    await expect(page.getByRole('heading', { name: 'Sincronizar terceros con Siigo' })).toBeFocused();
    expect(new URL(page.url()).search).toBe('?seccion=terceros');
  });

  test('cero vinculados no se cuenta como un dato que falta, sino como una cartera que nadie ha sincronizado', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockPanel(page, { resumenTerceros: { totalClientes: 6, conTercero: 0 } });
    await page.goto(RUTA);

    await expect(page.getByText(/Ninguno de los 6 clientes activos tiene todavía tercero vinculado en Siigo/))
      .toBeVisible();
    // Y dice qué hacer con eso, en la misma frase.
    await expect(page.getByText(/el vínculo se crea al sincronizar/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ir a sincronizar terceros' })).toBeVisible();
  });

  test('si se cae el conteo de terceros, las otras dos cifras se siguen viendo y solo se reintenta el que falló', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockPanel(page);
    let intentosTerceros = 0;
    await page.route(/\/api\/siigo\/terceros\/resumen(\?|$)/, (route) => {
      intentosTerceros += 1;
      return intentosTerceros === 1
        ? route.fulfill(json({ error: 'Se cayó la base' }, 500))
        : route.fulfill(json(RESUMEN_TERCEROS));
    });
    let consultasCartera = 0;
    page.on('request', (r) => {
      if (/\/clientes\/validacion(\?|$)/.test(r.url())) consultasCartera += 1;
    });

    await page.goto(RUTA);

    await expect(page.getByText(/No se pudo contar los terceros vinculados en Siigo/)).toBeVisible();
    // Son dos consultas sobre dos tablas distintas: una caída no se lleva a la otra por delante.
    await expect(page.getByText(/pueden recibir factura electrónica/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Ver los 1 que no pueden todavía/ })).toBeVisible();
    // Y nunca «ninguno tiene tercero»: con la consulta caída nadie contó nada.
    await expect(page.getByText(/tiene todavía tercero vinculado/)).toHaveCount(0);

    // El reintento pide lo que falló, no toda la tarjeta. Se compara ANTES contra DESPUÉS y no
    // contra un número fijo: en desarrollo `StrictMode` monta dos veces y duplica las peticiones de
    // arranque, que es ruido del entorno y no conducta del producto.
    const carteraAntesDelReintento = consultasCartera;
    await page.getByRole('button', { name: 'Reintentar el conteo de terceros' }).click();
    await expect(page.getByText(/2 de los 6 clientes activos ya tienen tercero vinculado en Siigo/))
      .toBeVisible();
    expect(consultasCartera).toBe(carteraAntesDelReintento);
  });

  test('y al revés: con la cartera caída, la cifra de terceros se sigue viendo', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockPanel(page, { estadoResumen: 500 });
    await page.goto(RUTA);

    await expect(page.getByText(/No se pudo revisar la cartera/)).toBeVisible();
    await expect(page.getByText(/2 de los 6 clientes activos ya tienen tercero vinculado en Siigo/))
      .toBeVisible();
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

  test('«Completar ficha» abre la ficha del cliente de la fila, y la URL del SPA no gana ningún identificador', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockPanel(page);
    const fichasPedidas: number[] = [];
    await mockFichaFiscal(page, fichasPedidas);

    await page.goto(RUTA);
    await page.locator('li', { hasText: 'CARGA RÁPIDA' })
      .getByRole('button', { name: 'Completar ficha' }).click();

    // Se abre la ficha DEL CLIENTE DE LA FILA. No basta el título: la ficha pidió la validación del
    // 6 y pinta los datos del 6.
    const ficha = page.getByRole('dialog', { name: 'Datos fiscales · CARGA RÁPIDA' });
    await expect(ficha).toBeVisible();
    await expect(ficha.getByRole('textbox', { name: 'Razón social' })).toHaveValue('CARGA RÁPIDA');
    await expect(ficha.getByText('Falta la dirección.')).toBeVisible();
    // Los identificadores DISTINTOS que se consultaron, no cuántas veces: en desarrollo
    // `StrictMode` monta dos veces y duplica la petición de arranque. Lo que se afirma es que solo
    // se pidió la ficha de ese cliente y de ningún otro.
    expect([...new Set(fichasPedidas)]).toEqual([CARGA_RAPIDA.clienteId]);

    // La otra mitad, que es la que protege el §14 de AGENTS.md: esto ABRE UN MODAL, no navega. Ni
    // el identificador del cliente ni su documento pueden acabar en la URL del SPA —donde los
    // guardan el historial del navegador, los marcadores y los logs del proxy—, y eso vale al
    // abrir y también al cerrar.
    const url = new URL(page.url());
    expect(url.pathname).toBe('/siigo/parametrizacion');
    expect(url.search).toBe('?seccion=terceros');
    expect(url.hash).toBe('');

    // La «X» de la cabecera del modal; abajo hay otro «Cerrar», que es el del formulario.
    await ficha.getByLabel('Cerrar').click();
    await expect(ficha).toHaveCount(0);
    expect(new URL(page.url()).search).toBe('?seccion=terceros');
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

    // La pantalla además DICE por qué no hay acción masiva. Que de verdad no la haya se comprueba
    // pulsando, no leyendo rótulos: eso es el test siguiente.
    await expect(page.getByText('No hay «confirmar todas»: cada municipio sale impreso en una factura ante la DIAN.')).toBeVisible();
  });

  test('ningún control del bloque confirma dos municipios de una vez: se cuentan las peticiones, no los rótulos', async ({ page }) => {
    // Atarlo al nombre del botón («no existe ninguno que se llame "confirmar todas"») no prueba el
    // AC5: una acción masiva llamada de otra forma pasaría. Lo que el AC prohíbe es la CONDUCTA —
    // que una sola pulsación confirme municipios que nadie miró—, así que se interceptan las
    // confirmaciones y se cuentan.
    await loginAs(page, ADMIN_USER);
    await mockPanel(page);
    const confirmados: number[] = [];
    await page.route(/\/api\/siigo\/clientes-ciudades\/\d+\/confirmar/, (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const id = Number(/clientes-ciudades\/(\d+)\/confirmar/.exec(route.request().url())![1]);
      confirmados.push(id);
      return route.fulfill(json({ clienteId: id, cityCode: '11001', cityName: 'Bogotá D.C.' }));
    });

    await page.goto(RUTA);
    await page.getByRole('button', { name: /Revisar las propuestas/ }).click();

    const bloque = page.getByRole('heading', { name: 'Equivalencias de ciudad' })
      .locator('xpath=ancestor::div[contains(@class,"bg-white")][1]');
    // Ancla del alcance: si este localizador dejara de resolver la tarjeta, el barrido de abajo no
    // recorrería nada y la prueba pasaría sin haber pulsado nada.
    await expect(bloque.getByRole('button', { name: 'Confirmar', exact: true })).toHaveCount(3);

    // Barrido: se pulsa TODO lo que hay en el bloque —salvo el «Confirmar» de una fila, que es la
    // acción legítima y se prueba justo después, y el plegador, que sacaría del DOM lo que queda
    // por barrer— y sin marcar ni un radio, es decir sin elegir municipio en ninguna parte. De ahí
    // no puede salir ni una sola confirmación.
    const botones = bloque.getByRole('button');
    for (let i = 0; i < await botones.count(); i += 1) {
      const boton = botones.nth(i);
      const nombre = (await boton.innerText()).trim();
      if (nombre === 'Confirmar' || /las propuestas$/.test(nombre)) continue;
      // `force`: los inhabilitados por estado también se pulsan a propósito — lo que se comprueba
      // es que no mandan nada, no que Playwright se niegue a pulsarlos.
      await boton.click({ force: true });
      await page.waitForTimeout(200);
      expect(confirmados, `«${nombre}» disparó confirmaciones sin que nadie eligiera municipio`).toEqual([]);
    }

    // Lo único que confirma es el «Confirmar» de UNA fila, y confirma esa fila y nada más: las
    // otras dos propuestas del bloque siguen sin tocar.
    await bloque.locator('li', { hasText: 'TRANSPORTES DEL SUR' }).getByRole('button', { name: 'Confirmar' }).click();
    await expect(page.getByText('TRANSPORTES DEL SUR S.A.S. → Bogotá D.C. (confirmada)')).toBeVisible();
    expect(confirmados).toEqual([1]);

    // Y las dos que quedan siguen sin municipio elegido: forzar su botón no manda nada.
    for (const fila of ['AGRÍCOLA EL ROBLE', 'MINAS DEL NORTE']) {
      await bloque.locator('li', { hasText: fila }).getByRole('button', { name: 'Confirmar' }).click({ force: true });
      await page.waitForTimeout(200);
    }
    expect(confirmados).toEqual([1]);
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
