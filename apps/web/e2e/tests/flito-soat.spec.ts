import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, AUDITOR_USER, PROVEEDOR_USER, CLIENTE_USER } from '../helpers/auth';

// FLITO — Portal SOAT (Fase 6). Cola de adquisición: envío atómico al gestor,
// detalle por VIN y solo-lectura para Auditoría. Backend mockeado.

const PROVEEDORES = [{ id: 'p1', nombre: 'Seguros Alfa', activo: true }];

const SOAT = [
  {
    id: 's1', vin: 'VIN0000000000001', placa: 'ABC123', marca: 'Chevrolet', linea: 'Onix',
    // HU #11906 — los tres datos del vehículo que trae FLIT. Valores reales del reporte FLIT: el
    // cilindraje viaja como texto, y estas cuatro cifras son las que delatan un `toLocaleString`
    // colado («1.598»).
    cilindraje: '1598', carroceria: 'SEDAN', tipoServicio: 'Particular',
    estado: 'pendiente', esMultiplePropietario: false, companiaNombre: 'Concesionario Norte',
    organismoNombre: 'STT Manizales', proveedorSoatId: null, proveedorSoatNombre: null,
    compradores: [{ nombreCompleto: 'Ana Pérez', numeroDocumento: '10101010', tipoDocumento: 'CC', orden: 0, porcentajeParticipacion: null }],
    tramitesFlit: ['FLIT-1001'], tipoTramite: 'Matricula',
    fechaAprobacion: null, fechaCreacion: '2026-03-28T10:00:00Z',
    enviadoPorNombre: null, enviadoEn: null,
    pagadoEn: null, valorPagado: null, estancado: false, motivoRechazo: null, creadoEn: '2026-04-01T12:00:00Z',
    gestionOperaciones: false,
  },
  {
    id: 's2', vin: 'VIN0000000000002', placa: 'XYZ789', marca: 'Renault', linea: 'Kwid',
    // Valores distintos a los de s1 a propósito: es la fila que ven los tres roles (el gestor solo
    // ve Solicitado), y con los tres registros iguales una celda que pintara siempre el mismo
    // vehículo pasaría el test. La carrocería es la más larga que manda FLIT, 23 caracteres.
    cilindraje: '220', carroceria: 'DOBLE CABINA CON PLATON', tipoServicio: 'Publico',
    estado: 'solicitado', esMultiplePropietario: false, companiaNombre: 'Concesionario Sur',
    organismoNombre: 'STT Pereira', proveedorSoatId: 'p1', proveedorSoatNombre: 'Seguros Alfa',
    compradores: [{ nombreCompleto: 'Luis Gómez', numeroDocumento: '20202020', tipoDocumento: 'NIT', orden: 0, porcentajeParticipacion: null }],
    tramitesFlit: ['FLIT-1002'], tipoTramite: 'Traspaso',
    fechaAprobacion: '2026-04-03T12:00:00Z', fechaCreacion: '2026-04-01T10:00:00Z',
    enviadoPorNombre: 'Operaciones E2E', enviadoEn: '2026-04-02T12:00:00Z',
    pagadoEn: null, valorPagado: null, estancado: false, motivoRechazo: null, creadoEn: '2026-04-02T12:00:00Z',
    gestionOperaciones: false,
  },
  {
    id: 's3', vin: 'VIN0000000000003', placa: 'PAG777', marca: 'Mazda', linea: 'CX-30',
    // AC2: FLIT omite dos de los tres. `null` viaja como `null` —el backend no lo convierte— y es
    // la interfaz la que pone «—». Con los tres registros completos este caso no existiría.
    cilindraje: null, carroceria: 'SUV', tipoServicio: null,
    estado: 'pagado', esMultiplePropietario: true, companiaNombre: 'Concesionario Sur',
    organismoNombre: 'STT Pereira', proveedorSoatId: 'p1', proveedorSoatNombre: 'Seguros Alfa',
    // HU #11947 (AC7): FLIT mandó un tipo que no está en la tabla del backend, así que el API
    // resuelve `null`. NO es un dato roto: el número se enseña igual, sin prefijo.
    compradores: [
      { nombreCompleto: 'Sara Ríos', numeroDocumento: '30303030', tipoDocumento: null, orden: 0, porcentajeParticipacion: null },
      // El segundo copropietario SÍ trae código: los dos casos conviven en la MISMA lista, que es
      // donde una regla de `null` escrita dos veces se delataría.
      { nombreCompleto: 'Iván Ríos', numeroDocumento: '40404040', tipoDocumento: 'PP', orden: 1, porcentajeParticipacion: null },
    ],
    tramitesFlit: ['FLIT-1003'], enviadoPorNombre: 'Operaciones E2E', enviadoEn: '2026-04-02T12:00:00Z',
    pagadoEn: '2026-04-05T12:00:00Z', valorPagado: 740800, estancado: false, motivoRechazo: null,
    gestionOperaciones: false,
    creadoEn: '2026-04-02T12:00:00Z',
  },
];

const FACETAS = {
  companias: [{ id: 1, nombre: 'Concesionario Norte' }, { id: 2, nombre: 'Concesionario Sur' }],
  organismos: [{ codigo: '17001', nombre: 'STT Manizales' }, { codigo: '66001', nombre: 'STT Pereira' }],
  proveedores: [{ id: 'p1', nombre: 'Seguros Alfa' }],
};

/** Guarda las URLs que pidió la página, para poder comprobar QUÉ filtros viajaron. */
const urlsPedidas: string[] = [];

async function mock(page: import('@playwright/test').Page) {
  urlsPedidas.length = 0;
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PROVEEDORES) }));
  await page.route(/\/api\/flito\/soat\/facetas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FACETAS) }));
  await page.route(/\/api\/flito\/soat\?/, (route) => {
    const url = new URL(route.request().url());
    urlsPedidas.push(url.search);
    const estado = url.searchParams.get('estado');
    const items = estado ? SOAT.filter((s) => s.estado === estado) : SOAT;
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ items, total: items.length, page: 1, pageSize: 50 }),
    });
  });
}

test.describe('FLITO — Portal SOAT', () => {
  test('operaciones lista, filtra y abre detalle', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);

    await page.goto('/flito/soat');
    await expect(page.getByRole('heading', { name: 'SOAT', exact: true })).toBeVisible();
    await expect(page.getByText('ABC123')).toBeVisible();
    await expect(page.getByText('XYZ789')).toBeVisible();

    await page.getByRole('button', { name: 'Solicitado', exact: true }).click();
    await expect(page.getByText('XYZ789')).toBeVisible();
    await expect(page.getByText('ABC123')).toHaveCount(0);

    await page.getByRole('button', { name: 'Ver' }).first().click();
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();
    await expect(modal.getByText('Seguros Alfa')).toBeVisible();
  });

  test('seleccionar pendientes envía al gestor', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    let enviado: unknown = null;
    await page.route(/\/api\/flito\/soat\/enviar$/, (route) => {
      enviado = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enviados: ['s1'], yaEnviados: [] }) });
    });

    await page.goto('/flito/soat');
    await page.getByLabel('Seleccionar ABC123').check();
    await expect(page.getByText('1 seleccionado(s)')).toBeVisible();

    // El proveedor es obligatorio desde que se retiraron las reglas de enrutamiento (HU #10979):
    // sin él el SOAT nacería sin proveedor y quedaría en la cola de nadie.
    const enviar = page.getByRole('button', { name: /Enviar al gestor/i });
    await expect(enviar).toBeDisabled();
    // Dos selectores en la página desde la HU #11157 (filtro «Gestiona» y destino del envío).
    await page.getByLabel('Enviar a').selectOption('p1');

    await enviar.click();
    await expect.poll(() => enviado).not.toBeNull();
    expect(enviado).toMatchObject({ proveedorSoatId: 'p1' });
  });

  test('auditor ve detalle en solo lectura', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mock(page);

    await page.goto('/flito/soat');
    await page.getByRole('button', { name: 'Ver' }).first().click();
    await expect(page.getByText(/Solo lectura · Auditoría/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rechazar' })).toHaveCount(0);
  });
  test('los filtros de la cola viajan al servidor', async ({ page }) => {
    // Se comprueba sobre la petición, no sobre las filas: el filtrado ocurre en SQL, así que lo
    // que importa es que el parámetro llegue.
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/soat');
    await expect(page.getByText('ABC123')).toBeVisible();

    await page.getByRole('checkbox', { name: 'Solo sin gestión' }).check();
    await expect.poll(() => urlsPedidas.at(-1) ?? '').toContain('estancado=si');

    // Cada rango es un calendario propio (HU #11026): el tramo viaja entero, no campo a campo.
    const rango = (etiqueta: string) => page.locator('summary').filter({ hasText: etiqueta });
    await rango('Solicitado').click();
    await page.getByRole('button', { name: '30 días' }).click();
    await expect.poll(() => urlsPedidas.at(-1) ?? '').toContain('solicitadoDesde=');
    expect(urlsPedidas.at(-1)).toContain('solicitadoHasta=');

    await rango('Pagado').click();
    await page.getByRole('button', { name: 'Hoy' }).click();
    await expect.poll(() => urlsPedidas.at(-1) ?? '').toContain('pagadoHasta=');
    // El rango de pago no pisa el de solicitud.
    expect(urlsPedidas.at(-1)).toContain('solicitadoDesde=');
  });

  test('la búsqueda consulta una vez tras la pausa, no en cada tecla', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/soat');
    await expect(page.getByText('ABC123')).toBeVisible();

    const antes = urlsPedidas.length;
    await page.getByPlaceholder('Buscar placa, VIN, comprador…').fill('ABC123');
    await expect.poll(() => urlsPedidas.at(-1) ?? '').toContain('buscar=ABC123');
    // Seis pulsaciones, una sola consulta: sin el retardo serían seis.
    expect(urlsPedidas.length - antes).toBe(1);
  });

  test('limpiar filtros los quita todos de la petición', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/soat');
    await page.getByRole('checkbox', { name: 'Solo sin gestión' }).check();
    await expect.poll(() => urlsPedidas.at(-1) ?? '').toContain('estancado=si');

    await page.getByRole('button', { name: 'Limpiar filtros' }).click();
    await expect.poll(() => urlsPedidas.at(-1) ?? '').not.toContain('estancado');
  });

  test('un SOAT pagado no muestra los días desde la solicitud', async ({ page }) => {
    // Ya pagado, la antigüedad deja de ser una señal de riesgo: el chip de sin gestión tampoco se
    // pinta, y dejar los días sueltos hacía parecer atrasado algo que ya está resuelto.
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/soat');

    const pendienteDeGestion = page.getByRole('row').filter({ hasText: 'XYZ789' });
    await expect(pendienteDeGestion.getByText(/^(Hoy|\d+ días?)$/)).toHaveCount(1);

    const pagado = page.getByRole('row').filter({ hasText: 'PAG777' });
    await expect(pagado.getByText(/^(Hoy|\d+ días?)$/)).toHaveCount(0);
  });

  test('el detalle cuenta por dónde ha pasado el SOAT, y quién lo movió', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    let pedido = 0;
    await page.route(/\/api\/flito\/soat\/[^/]+\/historial/, (route) => {
      pedido += 1;
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify([
          { id: 3, estadoAnterior: 'solicitado', estadoNuevo: 'pagado', motivo: 'Pago confirmado por factura.', usuario: 'Gestor Alfa', origen: 'usuario', creadoEn: '2026-04-05T15:00:00Z' },
          { id: 2, estadoAnterior: 'pendiente', estadoNuevo: 'solicitado', motivo: 'Envío al gestor', usuario: 'Operaciones E2E', origen: 'usuario', creadoEn: '2026-04-02T12:00:00Z' },
          { id: 1, estadoAnterior: null, estadoNuevo: 'pendiente', motivo: 'Alta desde FLIT (trámite FLIT-1002).', usuario: null, origen: 'sistema', creadoEn: '2026-04-01T09:00:00Z' },
        ]),
      });
    });

    await page.goto('/flito/soat');
    await page.getByRole('row').filter({ hasText: 'XYZ789' }).getByRole('button', { name: 'Ver' }).click();

    // Plegado por defecto: el detalle ya es largo y el historial es la segunda pregunta. Y no se
    // pide hasta abrirlo — precargarlo sería una consulta por fila de la cola.
    expect(pedido).toBe(0);
    await page.getByRole('button', { name: 'Ver el historial de estados' }).click();

    // Acotado a la entrada del historial: «Operaciones E2E» sale también en la fila de la cola y en
    // el «Enviado por» del detalle, y sin acotar la aserción no distinguiría de cuál habla.
    const envio = page.getByRole('listitem').filter({ hasText: 'Envío al gestor' });
    await expect(envio).toContainText('Operaciones E2E');
    await expect(envio).toContainText('Pendiente');
    await expect(envio).toContainText('Solicitado');

    // El alta no tiene estado de partida, y eso se rotula en vez de dejar un hueco.
    const alta = page.getByRole('listitem').filter({ hasText: 'Alta desde FLIT' });
    await expect(alta).toContainText('Alta');
    // Un cambio del sistema no puede parecer obra de una persona sin nombre.
    await expect(alta).toContainText('Sistema');
  });

  // HU #11905 — la cola dejó de girar sobre el trámite (RN-01: el SOAT es por VIN). Este test venía
  // afirmando lo contrario («la cola enseña tipo de trámite…») y se invierte, no se borra: lo que
  // sigue siendo verdad —el vehículo y las dos fechas— es justo la segunda mitad del AC1.
  test('la cola enseña vehículo y las dos fechas, y ya no el trámite', async ({ page }) => {
    // El fixture SIGUE trayendo el trámite porque la API sigue enviándolo: esta HU es solo de UI.
    // Sin esta guarda, vaciar el mock dejaría el test verde sin probar absolutamente nada.
    expect(SOAT[1].tramitesFlit).toContain('FLIT-1002');
    expect(SOAT[1].tipoTramite).toBe('Traspaso');

    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/soat');

    const tabla = page.getByRole('region', { name: 'Pólizas SOAT' });
    // El conteo va PRIMERO y es lo que ancla el aserto: «no está la columna Trámite» se cumple
    // también con la tabla sin cargar, vacía o en error, y ese es el falso verde barato de esta HU.
    await expect(tabla.getByRole('columnheader')).toHaveCount(10);
    await expect(tabla.getByRole('columnheader', { name: 'Trámite' })).toHaveCount(0);

    const fila = page.getByRole('row').filter({ hasText: 'XYZ789' });
    await expect(fila).not.toContainText('FLIT-1002');
    await expect(fila).not.toContainText('Traspaso');
    // `toHaveCount` cuenta nodos aunque estén ocultos: mata al mutante «esconderlo con hidden o
    // sr-only», que `toBeVisible()` dejaría pasar. El AC1 dice que no lo ve NADIE, tampoco un lector.
    await expect(tabla.getByText('FLIT-1002')).toHaveCount(0);

    // Lo que sí sigue: el vehículo y las dos fechas, que son la segunda cláusula del AC1.
    await expect(fila).toContainText('XYZ789');
    await expect(fila).toContainText('VIN0000000000002');
    await expect(fila).toContainText('Creado');
    // Un SOAT sin aprobar lo dice, en vez de un guion que se confunde con «no llegó la fecha».
    await expect(page.getByRole('row').filter({ hasText: 'ABC123' })).toContainText('Sin aprobar');

    // «Múltiple propietario» NO se va con la columna: es un atributo del SOAT que viajaba en la
    // celda del trámite solo porque allí había sitio. Sin este aserto, borrar el bloque de
    // `CeldaVehiculoSoat` no pondría rojo a nadie.
    await expect(page.getByRole('row').filter({ hasText: 'PAG777' })).toContainText('Múltiple propietario');
    await expect(fila).not.toContainText('Múltiple propietario');
  });

  // HU #11905 (AC2). Acotado al <dl> de la ficha y NO al diálogo entero. En ESTE test el aserto
  // laxo también pasaría —el historial no está mockeado y se carga plegado y perezoso—, así que el
  // acotado no lo exige el mock: lo exige producción. El historial real dice «Alta desde FLIT
  // (trámite FLIT-1002)» (flito-sync.service.ts:336) y un aserto sobre el diálogo entero saldría
  // rojo por un motivo que el AC no prohíbe; «arreglarlo» borrando esa traza destruiría
  // trazabilidad.
  test('el detalle ya no enseña los trámites FLIT, y conserva el resto de la ficha', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/soat');
    await page.getByRole('row').filter({ hasText: 'XYZ789' }).getByRole('button', { name: 'Ver' }).click();

    const ficha = page.getByRole('dialog').locator('dl');
    await expect(ficha).toBeVisible();
    await expect(ficha).not.toContainText('Trámites FLIT');
    await expect(ficha).not.toContainText('FLIT-1002');

    // «Gestiona» comparte renglón físico en el JSX con el dato que se fue: borrar la línea entera
    // en vez del elemento se lo lleva por delante, y es el error más probable de toda la HU.
    await expect(ficha).toContainText('Gestiona');
    await expect(ficha).toContainText('Seguros Alfa');
    await expect(ficha).toContainText('Enviado por');
    await expect(ficha).toContainText('Valor pagado');
    await expect(ficha.getByRole('button', { name: 'Ver soporte' })).toBeVisible();
  });

  // HU #11905 (AC3). Los tres roles en bucle, porque el mutante que hay que matar es una «vista
  // privilegiada» del tipo `{esOperaciones && <CeldaTramite …/>}`: probar solo con el gestor la
  // dejaría viva, y probar solo con admin dejaría viva la inversa.
  for (const caso of [
    // 10 columnas para quien puede DESCARGAR SOPORTES: la casilla de selección ya no cuelga de
    // «hay algún Pendiente» sino del permiso (HU #11910, AC7). El gestor la gana —los comprobantes
    // de sus SOAT son suyos— y Auditoría sigue en 9, que es lo que ese AC exige.
    { rol: 'admin', usuario: OPERACIONES_USER, columnas: 10 },
    { rol: 'auditor', usuario: AUDITOR_USER, columnas: 9 },
    { rol: 'proveedor', usuario: PROVEEDOR_USER, columnas: 10 },
  ]) {
    test(`${caso.rol} tampoco ve la columna Trámite: no hay vista privilegiada`, async ({ page }) => {
      await loginAs(page, caso.usuario);
      await mock(page);
      await page.goto('/flito/soat');

      const tabla = page.getByRole('region', { name: 'Pólizas SOAT' });
      await expect(tabla.getByRole('columnheader')).toHaveCount(caso.columnas);
      await expect(tabla.getByRole('columnheader', { name: 'Trámite' })).toHaveCount(0);
      await expect(tabla.getByText('FLIT-1002')).toHaveCount(0);
      // Y el vehículo sigue ahí para los tres: la columna que se va no se lleva a su vecina.
      await expect(tabla.getByRole('columnheader', { name: 'Vehículo' })).toHaveCount(1);
      await expect(page.getByRole('row').filter({ hasText: 'XYZ789' })).toContainText('VIN0000000000002');
    });
  }

  // HU #11906 (AC1) — cilindraje, carrocería y tipo de servicio llegan de FLIT y se ven en la fila
  // del vehículo. En bucle por los tres roles porque el AC los nombra a los tres: `LECTURA` los
  // cubre en la API y aquí no hay ni un condicional de rol, así que el mutante a matar es
  // exactamente el que lo introdujera.
  for (const caso of [
    // El conteo de columnas viaja con el aserto: los tres datos van DENTRO de la celda del vehículo.
    // Si esto sube a 11/12, alguien metió columnas nuevas y la tabla volvió a ser más ancha que antes
    // de la HU #11905. El 10 del gestor es de la #11910 (gana la casilla), no una columna de datos.
    { rol: 'admin', usuario: OPERACIONES_USER, columnas: 10 },
    { rol: 'auditor', usuario: AUDITOR_USER, columnas: 9 },
    { rol: 'proveedor', usuario: PROVEEDOR_USER, columnas: 10 },
  ]) {
    test(`${caso.rol} ve cilindraje, carrocería y tipo de servicio junto al vehículo`, async ({ page }) => {
      // Guarda del fixture: si alguien vacía estos tres campos del mock, el test de abajo se volvería
      // una comprobación de «—» que pasaría con la celda rota.
      expect(SOAT[1].cilindraje).toBe('220');
      expect(SOAT[1].carroceria).toBe('DOBLE CABINA CON PLATON');
      expect(SOAT[1].tipoServicio).toBe('Publico');

      await loginAs(page, caso.usuario);
      await mock(page);
      await page.goto('/flito/soat');

      const tabla = page.getByRole('region', { name: 'Pólizas SOAT' });
      await expect(tabla.getByRole('columnheader')).toHaveCount(caso.columnas);

      // XYZ789 es la única fila que ven los tres: al gestor la cola le abre en Solicitado.
      const fila = page.getByRole('row').filter({ hasText: 'XYZ789' });
      await expect(fila).toContainText('Cil. 220 · Carr. DOBLE CABINA CON PLATON · Serv. Publico');
      // Y en la misma celda que el vehículo, no en una columna aparte ni en otra fila.
      await expect(fila.getByRole('cell').filter({ hasText: 'VIN0000000000002' })).toContainText('Serv. Publico');
    });
  }

  test('el cilindraje se pinta tal como llega, sin formatearlo como número', async ({ page }) => {
    // La columna es `varchar` a propósito: «0» significa vehículo eléctrico y un futuro «220 CC» se
    // rompería en silencio al parsearlo. Un `toLocaleString` colado convertiría 1598 en «1.598».
    expect(SOAT[0].cilindraje).toBe('1598');

    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/soat');

    const fila = page.getByRole('row').filter({ hasText: 'ABC123' });
    await expect(fila).toContainText('Cil. 1598 · Carr. SEDAN · Serv. Particular');
    await expect(fila).not.toContainText('1.598');
    await expect(fila).not.toContainText('1,598');
  });

  // HU #11906 (AC2) — FLIT omite alguno de los tres.
  test('lo que FLIT no manda se pinta «—» en su sitio, y la cola no da error', async ({ page }) => {
    expect(SOAT[2].cilindraje).toBeNull();
    expect(SOAT[2].tipoServicio).toBeNull();
    expect(SOAT[2].carroceria).toBe('SUV');

    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/soat');

    // La línea NO se colapsa: las tres ranuras siguen ahí y el rótulo dice cuál falta. Sin rótulos,
    // esta fila diría «— · — · —» y no informaría de qué es lo que no llegó.
    const fila = page.getByRole('row').filter({ hasText: 'PAG777' });
    await expect(fila).toContainText('Cil. — · Carr. SUV · Serv. —');
    // Cadena vacía en vez de «—» dejaría «Cil.  · Carr. SUV · Serv.», que parece un renderizado roto.
    await expect(fila).not.toContainText('Cil. · Carr.');

    // Y no se muestra error: ni el mensaje rojo de la página ni el estado de error de la tabla.
    await expect(page.locator('p.text-red-600')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Pólizas SOAT' })).toBeVisible();
    // El resto de la fila sigue entera: un campo ausente no se lleva por delante a sus vecinos.
    await expect(fila).toContainText('Múltiple propietario');
    await expect(fila).toContainText('VIN0000000000003');
  });

  // HU #11947 (AC7). El código del tipo de documento llega YA RESUELTO del API —'CC', 'NIT', 'PP',
  // 'CE' o null— y esta pantalla solo lo antepone al número. Los tres casos van en bucle porque el
  // fallo a matar no es «no sale el código», que se ve al primer vistazo, sino el interpolado a pelo
  // `${tipo} ${numero}`: con código se lee idéntico y solo delata el espacio sobrante en el caso sin
  // código. Por eso también se comparan con `textContent` y no con `toHaveText`, que normaliza los
  // espacios y dejaría vivo justamente a ese mutante.
  for (const caso of [
    { placa: 'ABC123', titular: 'Ana Pérez', esperado: 'Ana Pérez · CC 10101010' },
    // Un segundo código distinto: con solo 'CC' en los datos, un prefijo constante pasaría el test.
    { placa: 'XYZ789', titular: 'Luis Gómez', esperado: 'Luis Gómez · NIT 20202020' },
    { placa: 'PAG777', titular: 'Sara Ríos', esperado: 'Sara Ríos · 30303030' },
  ]) {
    test(`AC7 — el comprador de ${caso.placa} enseña el documento tal como lo resolvió el API`, async ({ page }) => {
      await loginAs(page, OPERACIONES_USER);
      await mock(page);
      await page.goto('/flito/soat');
      await page.getByRole('row').filter({ hasText: caso.placa }).getByRole('button', { name: 'Ver' }).click();

      const linea = page.getByRole('dialog').getByRole('listitem')
        .filter({ hasText: caso.titular }).locator('span').first();
      await expect(linea).toBeVisible();
      expect(await linea.textContent()).toBe(caso.esperado);
    });
  }

  test('AC7 — con dos copropietarios, el que no trae código no contagia al que sí', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/soat');
    await page.getByRole('row').filter({ hasText: 'PAG777' }).getByRole('button', { name: 'Ver' }).click();

    const lineas = page.getByRole('dialog').getByRole('listitem');
    await expect(lineas).toHaveCount(2);
    expect(await lineas.nth(0).locator('span').first().textContent()).toBe('Sara Ríos · 30303030');
    expect(await lineas.nth(1).locator('span').first().textContent()).toBe('Iván Ríos · PP 40404040');
  });

  test('el filtro inteligente «listos para enviar» no se le ofrece al gestor', async ({ page }) => {
    // Los Pendiente quedan fuera de su frontera (CA-09): el preset le devolvería siempre una lista
    // vacía y parecería que no hay trabajo.
    await loginAs(page, PROVEEDOR_USER);
    await mock(page);
    await page.goto('/flito/soat');

    await page.locator('summary').filter({ hasText: 'Vista' }).click();
    await expect(page.getByRole('button', { name: /Listos para enviar/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Sin gestión/ })).toBeVisible();
  });

  test('aplicar un preset pone TODAS sus condiciones, no solo la primera', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const urls: string[] = [];
    await mock(page);
    await page.route(/\/api\/flito\/soat\?/, (route) => {
      urls.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], total: 0, page: 1, pageSize: 50 }) });
    });

    await page.goto('/flito/soat');
    await page.locator('summary').filter({ hasText: 'Vista' }).click();
    await page.getByRole('button', { name: /Sin gestión/ }).click();

    // Las dos condiciones a la vez. Que viaje solo una es justo el error que el preset evita.
    await expect.poll(() => urls.at(-1) ?? '').toContain('estado=solicitado');
    await expect.poll(() => urls.at(-1) ?? '').toContain('estancado=si');
  });

  // El soporte se carga desde esta pantalla y hasta ahora solo se podía consultar desde el reporte
  // de costos, al que el gestor del proveedor ni siquiera entra: quien abre un SOAT pagado quiere
  // ver la factura que lo pagó sin salir del detalle.
  test('desde el detalle de un SOAT pagado se ve su soporte', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.route(/\/api\/flito\/soat\/[^/]+\/soportes/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
        { id: 'sop-1', origen: 'soat', tipo: 'factura_soat', nombreArchivo: 'factura-soat.pdf', url: '/api/files?key=a', subidoEn: '2026-04-05T12:00:00Z' },
      ]) }));

    await page.goto('/flito/soat');
    await page.getByRole('row').filter({ hasText: 'PAG777' }).getByRole('button', { name: 'Ver' }).click();
    await page.getByRole('button', { name: 'Ver soporte' }).click();

    await expect(page.getByText('Documentos de SOAT PAG777')).toBeVisible();
    await expect(page.getByRole('button').filter({ hasText: 'factura-soat.pdf' })).toBeVisible();
  });

  test('un SOAT sin soporte lo dice, y cerrar el visor devuelve al detalle', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.route(/\/api\/flito\/soat\/[^/]+\/soportes/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/flito/soat');
    await page.getByRole('row').filter({ hasText: 'ABC123' }).getByRole('button', { name: 'Ver' }).click();
    await page.getByRole('button', { name: 'Ver soporte' }).click();
    await expect(page.getByText(/no tiene ninguna factura cargada todavía/)).toBeVisible();

    // Esc cierra SOLO el visor: el detalle que hay debajo sigue abierto. Con el listener en
    // `window` sin más, la misma tecla cerraba los dos de golpe.
    await page.keyboard.press('Escape');
    await expect(page.getByText(/no tiene ninguna factura cargada todavía/)).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: /SOAT · ABC123/ })).toBeVisible();
  });

  test('un SOAT sin movimientos lo dice, en vez de quedarse en blanco', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.route(/\/api\/flito\/soat\/[^/]+\/historial/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/flito/soat');
    await page.getByRole('row').filter({ hasText: 'ABC123' }).getByRole('button', { name: 'Ver' }).click();
    await page.getByRole('button', { name: 'Ver el historial de estados' }).click();
    await expect(page.getByText('Sin movimientos registrados.')).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HU #11157 — contingencia en la interfaz: elegir «Gestionado por Operaciones» al enviar, y asumir
// o devolver un SOAT que ya está con un proveedor.
//
// Este bloque monta su propio listado y registra sus rutas DESPUÉS de `mock()`, que en Playwright
// es lo que les da prioridad: así el fixture compartido no cambia y los 12 casos previos siguen
// contando lo mismo.

/** SOAT que Operaciones retomó del proveedor p1. Conserva el proveedor a propósito (HU #11153). */
const SOAT_CONTINGENCIA = {
  id: 'c1', vin: 'VIN0000000000009', placa: 'OPS001', marca: 'Kia', linea: 'Picanto',
  estado: 'solicitado', esMultiplePropietario: false, companiaNombre: 'Concesionario Sur',
  organismoNombre: 'STT Pereira', proveedorSoatId: 'p1', proveedorSoatNombre: 'Seguros Alfa',
  gestionOperaciones: true,
  compradores: [], tramitesFlit: ['FLIT-1009'], tipoTramite: 'Traspaso',
  fechaAprobacion: null, fechaCreacion: '2026-04-01T10:00:00Z',
  enviadoPorNombre: 'Operaciones E2E', enviadoEn: '2026-04-02T12:00:00Z',
  pagadoEn: null, valorPagado: null, estancado: false, motivoRechazo: null, creadoEn: '2026-04-02T12:00:00Z',
};

/** Cuerpos de los POST que hizo la página, para afirmar QUÉ se pidió y no solo que se pidió. */
interface PeticionCapturada { url: string; body: unknown }

async function mockContingencia(page: import('@playwright/test').Page, items: unknown[]) {
  const posts: PeticionCapturada[] = [];
  await page.route(/\/api\/flito\/soat\?/, (route) => {
    const url = new URL(route.request().url());
    urlsPedidas.push(url.search);
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ items, total: items.length, page: 1, pageSize: 50 }),
    });
  });
  await page.route(/\/api\/flito\/soat\/(enviar|.*\/(asumir-operaciones|devolver-gestor))/, (route) => {
    posts.push({ url: route.request().url(), body: route.request().postDataJSON() });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.route(/\/api\/flito\/soat\/[^/?]+\/historial/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  return posts;
}

test.describe('FLITO — Portal SOAT · contingencia (HU #11157)', () => {
  test('AC1 — «Gestionado por Operaciones» es una opción del selector y envía la contingencia', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    const posts = await mockContingencia(page, [SOAT[0]]); // el pendiente
    await page.goto('/flito/soat');

    await page.getByRole('checkbox', { name: 'Seleccionar ABC123' }).check();

    const destino = page.getByLabel('Enviar a');
    await expect(destino).toBeVisible();
    // El botón no se habilita hasta elegir destino: un envío sin dueño no debe poder construirse.
    await expect(page.getByRole('button', { name: /^Enviar/ })).toBeDisabled();

    await destino.selectOption({ label: 'Gestionado por Operaciones' });
    const enviar = page.getByRole('button', { name: 'Enviar a Operaciones' });
    await expect(enviar).toBeEnabled();
    await enviar.click();

    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0].body).toEqual({ ids: ['s1'], gestionOperaciones: true });
  });

  test('AC1 — elegir un proveedor sigue enviando el proveedor, sin marcar contingencia', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    const posts = await mockContingencia(page, [SOAT[0]]);
    await page.goto('/flito/soat');

    await page.getByRole('checkbox', { name: 'Seleccionar ABC123' }).check();
    await page.getByLabel('Enviar a').selectOption({ label: 'Seguros Alfa' });
    await page.getByRole('button', { name: 'Enviar al gestor' }).click();

    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0].body).toEqual({ ids: ['s1'], proveedorSoatId: 'p1' });
  });

  test('AC2 — la tabla dice quién gestiona y de quién se retomó', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await mockContingencia(page, [SOAT_CONTINGENCIA, SOAT[1]]);
    await page.goto('/flito/soat');

    const contingencia = page.getByRole('row', { name: /OPS001/ });
    await expect(contingencia).toContainText('Operaciones');
    await expect(contingencia).toContainText('retomado de Seguros Alfa');

    // El gestionado por un proveedor sigue mostrando su nombre, sin distintivo.
    const normal = page.getByRole('row', { name: /XYZ789/ });
    await expect(normal).toContainText('Seguros Alfa');
    await expect(normal).not.toContainText('retomado de');
  });

  test('AC3 — el filtro por quién gestiona viaja al servidor y se limpia', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await mockContingencia(page, [SOAT_CONTINGENCIA]);
    await page.goto('/flito/soat');

    await page.getByLabel('Gestiona').selectOption('operaciones');
    await expect.poll(() => urlsPedidas.at(-1)).toContain('gestion=operaciones');

    await page.getByRole('button', { name: 'Limpiar filtros' }).click();
    await expect.poll(() => urlsPedidas.at(-1)).not.toContain('gestion=');
  });

  test('AC4 y AC6 — asumir desde el detalle exige un motivo de al menos cinco caracteres', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    const posts = await mockContingencia(page, [SOAT[1]]); // solicitado, con proveedor
    await page.goto('/flito/soat');

    await page.getByRole('button', { name: 'Ver' }).first().click();
    await page.getByRole('button', { name: 'Asumir en Operaciones' }).click();

    const confirmar = page.getByRole('button', { name: 'Confirmar' });
    const campoMotivo = page.getByRole('textbox', { name: /Motivo para asumirlo/ });
    await expect(confirmar).toBeDisabled();
    await campoMotivo.fill('abc');
    await expect(confirmar).toBeDisabled();

    await campoMotivo.fill('el proveedor no responde');
    await expect(confirmar).toBeEnabled();
    await confirmar.click();

    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0].url).toContain('/s2/asumir-operaciones');
    expect(posts[0].body).toEqual({ motivo: 'el proveedor no responde' });
  });

  test('AC5 — devolver preselecciona el proveedor del que se retomó', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    const posts = await mockContingencia(page, [SOAT_CONTINGENCIA]);
    await page.goto('/flito/soat');

    await page.getByRole('button', { name: 'Ver' }).first().click();
    // Un SOAT que gestiona Operaciones no ofrece «asumir», ofrece «devolver».
    await expect(page.getByRole('button', { name: 'Asumir en Operaciones' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Devolver al proveedor' }).click();

    await expect(page.getByLabel('Proveedor que lo retoma')).toHaveValue('p1');

    await page.getByRole('textbox', { name: /Motivo de la devolución/ }).fill('ya puede retomarlo');
    await page.getByRole('button', { name: 'Confirmar' }).click();

    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0].url).toContain('/c1/devolver-gestor');
    expect(posts[0].body).toEqual({ proveedorSoatId: 'p1', motivo: 'ya puede retomarlo' });
  });

  test('AC8 — al proveedor no se le ofrece nada de la contingencia', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await mock(page);
    await mockContingencia(page, [SOAT[1]]);
    await page.goto('/flito/soat');

    await expect(page.getByLabel('Gestiona')).toHaveCount(0);
    await page.getByRole('button', { name: 'Ver' }).first().click();
    await expect(page.getByRole('button', { name: 'Asumir en Operaciones' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Devolver al proveedor' })).toHaveCount(0);
  });

  test('AC8 — auditoría ve quién gestiona, pero ninguna acción', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mock(page);
    await mockContingencia(page, [SOAT_CONTINGENCIA]);
    await page.goto('/flito/soat');

    await expect(page.getByRole('row', { name: /OPS001/ })).toContainText('Operaciones');
    await page.getByRole('button', { name: 'Ver' }).first().click();
    await expect(page.getByText('Solo lectura · Auditoría observa, no ejecuta acciones.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Asumir en Operaciones' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Devolver al proveedor' })).toHaveCount(0);
  });
});

// ─────────── HU #12097 · La vigencia del SOAT en la cola, con su antigüedad y sus filtros ───────────
//
// Eslabón 2 de 2 del Feature #12075. La pantalla NO consulta el RUNT: pinta lo que la corrida de las
// 00:10 dejó escrito y que `GET /flito/soat` proyecta en cada fila. Backend mockeado, como el resto
// del archivo.
//
// El reloj va FIJADO con `page.clock.setFixedTime` —que congela `Date` pero deja correr los
// temporizadores, así que React sigue programando— y las tres fechas del fixture están elegidas
// contra dos mutantes concretos: los cubos de 24 h y el olvido de la zona.

/** 02:00 en Bogotá del 7 de septiembre de 2026. Después de la medianoche, que es donde duele. */
const AHORA_VIG = new Date('2026-09-07T07:00:00Z');
/** La corrida de las 00:10 de HOY. */
const VERIF_HOY = '2026-09-07T05:10:00Z';
/** El reintento de las 03:10 de AYER: 22,8 h antes de `AHORA_VIG`, o sea «hoy» para `ms/86400000`. */
const VERIF_AYER = '2026-09-06T08:10:00Z';
/** La corrida del 4 de septiembre: tres días de calendario. */
const VERIF_3_DIAS = '2026-09-04T05:10:00Z';

/** Una fila `pagado` con comprobante, que es la única clase que entra en la verificación diaria. */
function filaVigencia(id: string, placa: string, vigencia: unknown) {
  return {
    ...SOAT[2], id, placa, vin: `VIN000000000${id}`, esMultiplePropietario: false,
    compradores: [], tramitesFlit: [], vigencia,
  };
}

const SOAT_VIGENCIA = [
  filaVigencia('v1', 'VIG001', { estado: 'vigente', verificadaEn: VERIF_HOY, venceEl: '2027-03-12' }),
  filaVigencia('v2', 'VEN002', { estado: 'vencido', verificadaEn: VERIF_AYER, venceEl: '2026-03-12' }),
  filaVigencia('v3', 'REG003', { estado: 'sin_registro', verificadaEn: VERIF_3_DIAS, venceEl: null }),
  filaVigencia('v4', 'NOC004', { estado: 'no_verificado', verificadaEn: VERIF_3_DIAS, venceEl: null }),
  // El caso que mata el `switch (estado)`: el estado dice `no_verificado` y la fecha dice que nunca
  // hubo respuesta. Manda la fecha.
  filaVigencia('v5', 'NUL005', { estado: 'no_verificado', verificadaEn: null, venceEl: null }),
  // Sin comprobante: no entra en la verificación y el bloque viaja `null`.
  { ...SOAT[0], id: 'v6', placa: 'PEN006', vin: 'VIN00000000000v6', compradores: [], tramitesFlit: [], vigencia: null },
];

/** Las URLs que pidió la cola en el test de vigencia, para comprobar QUÉ viajó. */
const urlsVigencia: string[] = [];

/**
 * Mock de la cola con vigencia. **Ignora la pastilla de estado a propósito** —los seis registros
 * salen siempre— para que los tres roles vean el mismo conjunto y el conteo de columnas se pueda
 * comprobar con estas filas y no con las de arriba.
 *
 * El filtro `vigencia` SÍ se aplica, y con el mismo universo que el servidor: solo las filas con
 * bloque de vigencia, y `no_verificado` trae las dos —la que tiene fecha y la que no—.
 */
async function mockVigencia(page: import('@playwright/test').Page) {
  urlsVigencia.length = 0;
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PROVEEDORES) }));
  await page.route(/\/api\/flito\/soat\/facetas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FACETAS) }));
  await page.route(/\/api\/flito\/soat\?/, (route) => {
    const url = new URL(route.request().url());
    urlsVigencia.push(url.search);
    const vigencia = url.searchParams.get('vigencia');
    const items = vigencia
      ? SOAT_VIGENCIA.filter((s) => (s.vigencia as { estado: string } | null)?.estado === vigencia)
      : SOAT_VIGENCIA;
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ items, total: items.length, page: 1, pageSize: 50 }),
    });
  });
}

/** La celda «Estado» de una fila: la única que contiene el rótulo del estado del SOAT. */
function celdaEstado(page: import('@playwright/test').Page, placa: string, rotulo: string) {
  return page.getByRole('row').filter({ hasText: placa }).getByRole('cell').filter({ hasText: rotulo });
}
/** Cuántas pastillas hay en una celda: el puntito `aria-hidden` es exactamente uno por `StatusChip`. */
function chipsDe(celda: ReturnType<typeof celdaEstado>) {
  return celda.locator('span[aria-hidden="true"].rounded-full');
}

test.describe('FLITO — SOAT · vigencia frente al RUNT (HU #12097)', () => {
  // AC1 + AC3, y los cuatro casos EN LA MISMA CORRIDA: probar uno solo dejaría vivo un `default`
  // que colapsara dos estados en la misma etiqueta.
  test('AC1/AC3 — las cuatro superficies se distinguen por TEXTO, y cada una trae su fecha', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockVigencia(page);
    await page.clock.setFixedTime(AHORA_VIG);
    await page.goto('/flito/soat');

    const fila = (placa: string) => page.getByRole('row').filter({ hasText: placa });

    // `vigente` — la fecha de vencimiento va DENTRO del chip: sin ella, «Vigente» no dice hasta cuándo.
    await expect(fila('VIG001')).toContainText('Vigente hasta 12/03/27');
    await expect(fila('VIG001')).toContainText('Verificado hoy');

    // `vencido` — lo deriva el servidor. La línea dice «ayer» aunque no hayan pasado 24 horas desde
    // el reintento de las 03:10: son días de calendario en Bogotá, no cubos de 24 h.
    await expect(fila('VEN002')).toContainText('Venció el 12/03/26');
    await expect(fila('VEN002')).toContainText('Verificado ayer');

    // `sin_registro` — problema DEL VEHÍCULO. A partir de dos días entra la fecha absoluta, y va
    // visible: nada en `title`, que no lo ve quien navega con teclado ni quien está en una tableta.
    await expect(fila('REG003')).toContainText('Sin SOAT en el RUNT');
    await expect(fila('REG003')).toContainText('Verificado hace 3 días (4/09/26)');

    // `no_verificado` con fecha — problema NUESTRO. Otra etiqueta y otra gramática en la línea.
    await expect(fila('NOC004')).toContainText('No se pudo consultar');
    await expect(fila('NOC004')).toContainText('Último dato: hace 3 días (4/09/26)');

    // Y el par que importa, cruzado: son cosas opuestas y ninguna de las dos se lee como la otra.
    await expect(fila('REG003')).not.toContainText('No se pudo consultar');
    await expect(fila('NOC004')).not.toContainText('Sin SOAT en el RUNT');
    // La línea de `no_verificado` es la de la ÚLTIMA RESPUESTA, no la del intento de hoy.
    await expect(fila('NOC004')).not.toContainText('Verificado hace');
  });

  // El sentinela de densidad de la #11905/#11906: la vigencia va DENTRO de la celda «Estado», así
  // que el conteo no se mueve. Si sube a 11/10/11, alguien implementó la columna propia.
  for (const caso of [
    { rol: 'admin', usuario: OPERACIONES_USER, columnas: 10 },
    { rol: 'auditor', usuario: AUDITOR_USER, columnas: 9 },
    { rol: 'proveedor', usuario: PROVEEDOR_USER, columnas: 10 },
  ]) {
    test(`${caso.rol} ve la vigencia sin que la tabla gane columnas (${caso.columnas})`, async ({ page }) => {
      await loginAs(page, caso.usuario);
      await mockVigencia(page);
      await page.clock.setFixedTime(AHORA_VIG);
      await page.goto('/flito/soat');

      const tabla = page.getByRole('region', { name: 'Pólizas SOAT' });
      await expect(tabla.getByRole('columnheader')).toHaveCount(caso.columnas);
      await expect(tabla.getByRole('columnheader', { name: 'Vigencia' })).toHaveCount(0);
      // Y está donde tiene que estar: en la misma celda que el estado del SOAT.
      await expect(celdaEstado(page, 'REG003', 'Pagado')).toContainText('Sin SOAT en el RUNT');
    });
  }

  test('AC1 — `verificadaEn` nulo pinta «Sin verificar» SIN pastilla, mande lo que mande el estado', async ({ page }) => {
    // El fixture dice `no_verificado` a propósito: con un `switch (estado)` esta fila diría «No se
    // pudo consultar» y afirmaría un fallo que puede no haber ocurrido —el comprobante se cargó
    // ayer y la primera corrida es esta madrugada—.
    expect((SOAT_VIGENCIA[4].vigencia as { estado: string; verificadaEn: string | null }).estado).toBe('no_verificado');
    expect((SOAT_VIGENCIA[4].vigencia as { verificadaEn: string | null }).verificadaEn).toBeNull();

    await loginAs(page, OPERACIONES_USER);
    await mockVigencia(page);
    await page.clock.setFixedTime(AHORA_VIG);
    await page.goto('/flito/soat');

    const celda = celdaEstado(page, 'NUL005', 'Pagado');
    await expect(celda).toContainText('Sin verificar');
    await expect(celda).not.toContainText('No se pudo consultar');
    await expect(celda).not.toContainText('todavía');
    // Una sola pastilla, la del estado del SOAT: aquí no hay ninguna afirmación que hacer.
    await expect(chipsDe(celda)).toHaveCount(1);
    // Y la que sí tiene fecha lleva las dos: la del estado y la azul de la vigencia.
    await expect(chipsDe(celdaEstado(page, 'NOC004', 'Pagado'))).toHaveCount(2);
  });

  test('AC1 — la fila SIN comprobante no gana nada: ni chip, ni línea, ni «—»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockVigencia(page);
    await page.clock.setFixedTime(AHORA_VIG);
    await page.goto('/flito/soat');

    const celda = celdaEstado(page, 'PEN006', 'Pendiente');
    await expect(celda).not.toContainText('Verificado');
    await expect(celda).not.toContainText('Sin verificar');
    await expect(celda).not.toContainText('No se pudo consultar');
    await expect(chipsDe(celda)).toHaveCount(1);
  });

  test('AC2 — el filtro viaja como valor máquina, sin placa ni VIN ni documento', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockVigencia(page);
    await page.clock.setFixedTime(AHORA_VIG);
    await page.goto('/flito/soat');

    // El nombre accesible del control es su rótulo visible, igual que el de «Gestiona».
    await page.getByLabel('Vigencia').selectOption('no_verificado');

    await expect.poll(() => urlsVigencia.at(-1)).toContain('vigencia=no_verificado');
    // La etiqueta visible NO viaja: lo que el servidor valida es el valor máquina.
    expect(urlsVigencia.at(-1)).not.toContain('Sin+verificar');
    // Y nada de identificadores en la URL del SPA.
    const query = urlsVigencia.at(-1)!;
    for (const dato of ['VIG001', 'NUL005', 'VIN000000000v5', '30303030', 'buscar=']) {
      expect(query).not.toContain(dato);
    }
    expect([...new URLSearchParams(query).keys()].sort()).toEqual(['page', 'vigencia']);

    // Y la lista «Sin verificar» trae LAS DOS, que es lo que dice su nombre: la que falló hoy y la
    // que nunca ha tenido respuesta. Acotar el universo con `verificada_en IS NOT NULL` vaciaría la
    // lista de fallos justo durante la avería que existe para hacerlos visibles.
    await expect(page.getByRole('row').filter({ hasText: 'NOC004' })).toContainText('No se pudo consultar');
    await expect(page.getByRole('row').filter({ hasText: 'NUL005' })).toContainText('Sin verificar');
    await expect(page.getByRole('row').filter({ hasText: 'VIG001' })).toHaveCount(0);
  });

  test('AC2 — «Vencido» y «Sin SOAT en el RUNT» devuelven cada uno su conjunto', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockVigencia(page);
    await page.clock.setFixedTime(AHORA_VIG);
    await page.goto('/flito/soat');

    await page.getByLabel('Vigencia').selectOption('vencido');
    await expect.poll(() => urlsVigencia.at(-1)).toContain('vigencia=vencido');
    await expect(page.getByRole('row').filter({ hasText: 'VEN002' })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'REG003' })).toHaveCount(0);

    await page.getByLabel('Vigencia').selectOption('sin_registro');
    await expect.poll(() => urlsVigencia.at(-1)).toContain('vigencia=sin_registro');
    await expect(page.getByRole('row').filter({ hasText: 'REG003' })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'VEN002' })).toHaveCount(0);
  });

  // Guarda de REGRESIÓN del gate B: `vigencia?: string` en `FiltrosExportCola` es una declaración
  // INERTE —TypeScript no comprueba propiedades excedentes en un spread, así que quitarla pasa el
  // typecheck y no rompe ningún test—. Lo único que de verdad transporta el filtro al archivo es la
  // línea del spread de `filtrosExport`, y hasta aquí no había nada que la sujetara: borrarla no
  // daba error ni rojo, solo un `.xlsx` con MÁS filas de las que la pantalla enseña. En un archivo
  // de datos personales eso es sobre-exportación silenciosa, que es el peor de los dos modos de
  // fallo. El aserto es sobre el CUERPO que sale, no sobre el tipo.
  test('AC2 — el Excel se lleva el mismo filtro: `vigencia` viaja en el cuerpo del POST', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockVigencia(page);
    await page.clock.setFixedTime(AHORA_VIG);

    const exportado: Array<{ search: string; cuerpo: string; metodo: string }> = [];
    // Se registra DESPUÉS del mock de la cola, que es lo que le da precedencia en Playwright.
    await page.route(/\/api\/flito\/soat\/export$/, (route) => {
      const req = route.request();
      exportado.push({ search: new URL(req.url()).search, cuerpo: req.postData() ?? '', metodo: req.method() });
      return route.fulfill({
        status: 200,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        headers: { 'content-disposition': 'attachment; filename="soat_20991231-2359.xlsx"' },
        body: 'PKFLITO-E2E',
      });
    });

    await page.goto('/flito/soat');
    await page.getByLabel('Vigencia').selectOption('vencido');
    // Se espera a que la COLA ya haya pedido con el filtro: sin esto, el export podría salir con el
    // estado anterior y el aserto mediría otra cosa.
    await expect.poll(() => urlsVigencia.at(-1)).toContain('vigencia=vencido');

    await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Exportar a Excel', exact: true }).click(),
    ]);

    expect(exportado).toHaveLength(1);
    expect(exportado[0].metodo).toBe('POST');
    const cuerpo = JSON.parse(exportado[0].cuerpo) as Record<string, unknown>;
    // El valor MÁQUINA, que es lo que valida el esquema `.strict()` del endpoint: mandar el rótulo
    // visible no sería un filtro ignorado, sería un 400 —y el archivo dejaría de existir—.
    expect(cuerpo.vigencia, 'el export no se llevó el filtro de vigencia').toBe('vencido');
    expect(cuerpo.vigencia).not.toBe('Vencido');
    // Y sigue sin tocar la URL: todo va en el cuerpo (AGENTS.md §14).
    expect(exportado[0].search).toBe('');
  });

  test('AC2 — el vacío del filtro ofrece «Limpiar filtros», y limpiarlo quita `vigencia`', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockVigencia(page);
    await page.clock.setFixedTime(AHORA_VIG);
    // Respuesta vacía para el filtro: es el caso de «ningún SOAT ha vencido», que no es un fallo.
    await page.route(/\/api\/flito\/soat\?.*vigencia=vencido/, (route) => {
      urlsVigencia.push(new URL(route.request().url()).search);
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ items: [], total: 0, page: 1, pageSize: 50 }),
      });
    });
    await page.goto('/flito/soat');

    await page.getByLabel('Vigencia').selectOption('vencido');

    // Sin el filtro en `hayFiltros`, aquí saldría «No hay SOAT en esta vista. Sincroniza desde el
    // Tablero…» —falso— y el botón, que es la única salida, no aparecería.
    await expect(page.getByText('Ningún SOAT coincide con los filtros.')).toBeVisible();
    const limpiar = page.getByRole('button', { name: 'Limpiar filtros' });
    await expect(limpiar).toBeVisible();

    await limpiar.click();
    await expect(page.getByLabel('Vigencia')).toHaveValue('');
    await expect.poll(() => urlsVigencia.at(-1)).not.toContain('vigencia=');
  });

  test('AC4 — no hay «verificar ahora» en ninguna parte, y el dato no se edita', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockVigencia(page);
    await page.clock.setFixedTime(AHORA_VIG);
    await page.goto('/flito/soat');

    await expect(page.getByRole('button', { name: /Verificar/i })).toHaveCount(0);

    await page.getByRole('row').filter({ hasText: 'REG003' }).getByRole('button', { name: 'Ver' }).click();
    const ficha = page.getByRole('dialog').locator('dl');
    // Los dos datos del modal, de solo lectura. El rótulo es el mismo en los cuatro estados.
    await expect(ficha).toContainText('Vigencia');
    await expect(ficha).toContainText('Sin SOAT en el RUNT');
    await expect(ficha).toContainText('Último dato del RUNT');
    await expect(page.getByRole('dialog').getByRole('button', { name: /Verificar/i })).toHaveCount(0);
    // Ni un campo editable con el dato del RUNT dentro.
    await expect(ficha.locator('input, select, textarea')).toHaveCount(0);
    // Y el número de póliza del RUNT no está: no lo pide ningún AC y es cuasi-PII.
    await expect(ficha).not.toContainText('Póliza');
  });

  test('AC4 — la fila sin comprobante enseña «—» en el modal, que es donde sí se pinta', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockVigencia(page);
    await page.clock.setFixedTime(AHORA_VIG);
    await page.goto('/flito/soat');

    await page.getByRole('row').filter({ hasText: 'PEN006' }).getByRole('button', { name: 'Ver' }).click();
    const vigencia = page.getByRole('dialog').locator('dl div').filter({ hasText: /^Vigencia/ });
    await expect(vigencia).toContainText('—');
  });

  // AC5 + compatibilidad hacia atrás: en DEV el merge ES el deploy, así que el bundle puede ir por
  // delante del API. Este es el mock de arriba, que NO trae el campo `vigencia`.
  test('AC5 — una respuesta sin el campo `vigencia` se pinta como antes de la HU, sin reventar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/soat');

    await expect(page.getByRole('region', { name: 'Pólizas SOAT' })).toBeVisible();
    const celda = celdaEstado(page, 'PAG777', 'Pagado');
    await expect(celda).not.toContainText('Verificado');
    await expect(celda).not.toContainText('Sin verificar');
    await expect(celda).not.toContainText('Invalid Date');
    await expect(chipsDe(celda)).toHaveCount(1);
    // Y el filtro sigue ofreciéndose: la pantalla no depende de que la respuesta traiga el campo.
    await expect(page.getByLabel('Vigencia')).toBeVisible();
  });

  test('AC5 — el error de la cola sigue siendo uno solo, con su reintento', async ({ page }) => {
    // Un fallo de la vigencia ES un fallo de `GET /flito/soat`: no hay superficie de error nueva ni
    // una segunda llamada que pueda caerse por su cuenta.
    await loginAs(page, OPERACIONES_USER);
    await mockVigencia(page);
    let fallos = 0;
    await page.route(/\/api\/flito\/soat\?/, (route) => {
      fallos += 1;
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'No se pudo cargar la cola.' }) });
    });
    await page.goto('/flito/soat');

    await expect(page.getByRole('alert')).toBeVisible();
    await page.getByRole('button', { name: 'Reintentar' }).click();
    await expect.poll(() => fallos).toBeGreaterThan(1);
  });

  test('el Cliente no ve nada de esta HU: ni el filtro, ni el chip, ni la línea', async ({ page }) => {
    // El backend ya le quita `vigencia` de cada fila (`CAMPOS_SOLO_INTERNOS`) y le ignora el filtro;
    // la pantalla no se apoya en eso y lo esconde también. Son el estado de un proceso interno de
    // FLITO: le dirían que su póliza está en duda sin que él pueda hacer nada.
    await loginAs(page, CLIENTE_USER);
    await page.route(/\/api\/flito\/soat\/facetas/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ companias: [], organismos: [], proveedores: [] }) }));
    await page.route(/\/api\/flito\/soat\?/, (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      // Sin el campo, que es como llega la fila del cliente.
      body: JSON.stringify({ items: [filaVigencia('c1', 'CLI007', undefined)], total: 1, page: 1, pageSize: 50 }),
    }));
    await page.clock.setFixedTime(AHORA_VIG);
    await page.goto('/flito/soat');

    await expect(page.getByRole('row').filter({ hasText: 'CLI007' })).toBeVisible();
    await expect(page.getByLabel('Vigencia')).toHaveCount(0);
    await expect(page.getByText('Sin verificar')).toHaveCount(0);
    await expect(page.getByText('No se pudo consultar')).toHaveCount(0);
    await expect(page.getByText(/^Verificado /)).toHaveCount(0);
  });
});
