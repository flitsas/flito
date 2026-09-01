// FLITO — SOAT e Impuestos: filtro «Creado en FLITO» y descarga en Excel (HU #11909).
//
// Lo que este archivo protege es una **igualdad** y una **ausencia**.
//
// La igualdad: lo que se descarga tiene que ser lo que se está viendo. El fallo que persigue no es
// «el export no manda los filtros» —eso se nota— sino sus versiones silenciosas: que mande MENOS de
// los puestos (200 con un archivo más ancho, con nombres y documentos de compradores que nadie
// pidió) o que mande la PÁGINA (un archivo con 50 filas donde el operador esperaba el conjunto).
//
// La ausencia: el botón que el auditor no puede tener **no existe en su DOM**. Escrito como
// `toBeDisabled()` este test daría por bueno un botón pintado y apagado, que es otra cosa —y otra
// promesa, la de un atributo que se quita desde la consola—. `toHaveCount(0)` es lo que lo mata.
//
// Y una tercera clase, que es de reparto: el buscador de estas dos colas admite **nombre y documento
// del comprador**, así que su texto no puede tocar la URL (AGENTS.md §14). En el export va en el
// CUERPO del POST; en la query acabaría en el historial, en el `Referer` y en el access log.
//
// Los datos son SINTÉTICOS. Ni un dato real entra en un spec.
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import {
  loginAs, AUDITOR_USER, CLIENTE_USER, GESTOR_IMPUESTOS_USER, OPERACIONES_USER, PROVEEDOR_USER,
} from '../helpers/auth';
import { instrumentarObjectUrls, leerUrls } from '../helpers/object-urls';

/** `content-type` de un xlsx. Es lo que hace que `request()` devuelva un blob y no intente JSON. */
const CT_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** Firma de un ZIP. Un xlsx lo es; sirve para comprobar que lo descargado es el archivo. */
const CUERPO_XLSX = 'PKFLITO-E2E';

/**
 * El sello del nombre que devuelve el servidor: **una fecha que el reloj del cliente no puede
 * producir**. Si el mock devolviera «hoy», un nombre inventado en el navegador pasaría el test sin
 * que nadie lo notara — que es justo el defecto que la decisión 4 de la HU cierra.
 *
 * Futura y no pasada: el guardia valida además que el año caiga en un rango sensato (2020–2100).
 */
const NOMBRE_SOAT = 'soat_20991231-2359.xlsx';
const NOMBRE_IMPUESTOS = 'impuestos_20991231-2359.xlsx';

// ───────────────────────────── Fechas del filtro «Creado en FLITO» ──────────────────────────────
//
// El calendario de `RangoFechas` abre por el mes ACTUAL, así que los días que el test pincha tienen
// que ser de ese mes: cualquier fecha fija obligaría a navegar meses y se rompería sola al pasar el
// tiempo. La fila que queda FUERA se fecha un año atrás, que nunca cae dentro del mes visible.
const HOY = new Date();
const dia = (d: number) =>
  `${HOY.getFullYear()}-${String(HOY.getMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const DESDE = dia(10);
const DENTRO = dia(15);
const HASTA = dia(20);
const FUERA = `${HOY.getFullYear() - 1}-06-15`;

// ─────────────────────────────────────── Fixtures de cola ───────────────────────────────────────

const SOAT = [
  {
    id: 's1', vin: 'VIN0000000000001', placa: 'ABC123', marca: 'Chevrolet', linea: 'Onix',
    cilindraje: '1598', carroceria: 'SEDAN', tipoServicio: 'Particular',
    estado: 'pendiente', esMultiplePropietario: false, companiaNombre: 'Concesionario Norte',
    organismoNombre: 'STT Manizales', proveedorSoatId: null, proveedorSoatNombre: null,
    compradores: [{ nombreCompleto: 'Ana Pérez', numeroDocumento: '10101010', orden: 0, porcentajeParticipacion: null }],
    tramitesFlit: ['FLIT-1001'], tipoTramite: 'Matricula',
    fechaAprobacion: null, fechaCreacion: '2026-03-28T10:00:00Z',
    enviadoPorNombre: null, enviadoEn: null, pagadoEn: null, valorPagado: null,
    estancado: false, motivoRechazo: null, gestionOperaciones: false,
    // La fila que el rango DEJA DENTRO.
    creadoEn: `${DENTRO}T12:00:00Z`,
  },
  {
    id: 's2', vin: 'VIN0000000000002', placa: 'XYZ789', marca: 'Renault', linea: 'Kwid',
    cilindraje: '220', carroceria: 'DOBLE CABINA CON PLATON', tipoServicio: 'Publico',
    estado: 'solicitado', esMultiplePropietario: false, companiaNombre: 'Concesionario Sur',
    organismoNombre: 'STT Pereira', proveedorSoatId: 'p1', proveedorSoatNombre: 'Seguros Alfa',
    compradores: [{ nombreCompleto: 'Luis Gómez', numeroDocumento: '20202020', orden: 0, porcentajeParticipacion: null }],
    tramitesFlit: ['FLIT-1002'], tipoTramite: 'Traspaso',
    fechaAprobacion: '2026-04-03T12:00:00Z', fechaCreacion: '2026-04-01T10:00:00Z',
    enviadoPorNombre: 'Operaciones E2E', enviadoEn: '2026-04-02T12:00:00Z',
    pagadoEn: null, valorPagado: null, estancado: false, motivoRechazo: null, gestionOperaciones: false,
    // La fila que el rango DEJA FUERA. Es la que hace que el aserto del contador signifique algo.
    creadoEn: `${FUERA}T12:00:00Z`,
  },
];

const FACETAS_SOAT = {
  companias: [{ id: 1, nombre: 'Concesionario Norte' }, { id: 2, nombre: 'Concesionario Sur' }],
  organismos: [{ codigo: '17001', nombre: 'STT Manizales' }, { codigo: '66001', nombre: 'STT Pereira' }],
  proveedores: [{ id: 'p1', nombre: 'Seguros Alfa' }],
};

const IMPUESTOS = [
  {
    id: 'i1', tramiteId: 't1', idFlit: 'FLIT-1001', placa: 'ABC123', vin: 'VIN0000000000001',
    marca: 'Chevrolet', linea: 'Onix', tipoTramite: 'Matricula', fechaAprobacion: null,
    fechaCreacion: '2026-03-28T10:00:00Z',
    estado: 'pendiente', compradorNombre: 'Ana Pérez', compradorDocumento: '10101010',
    companiaNombre: 'Concesionario Norte', organismoCodigo: 'STT-MZL', organismoNombre: 'STT Manizales',
    valorLiquidado: 120000, valorPagado: null, marcadoPorDiferencia: false, tieneFacturaVenta: true,
    enviadoPorNombre: null, enviadoEn: null, pagadoEn: null, estancado: false, motivoRechazo: null,
    gestionOperaciones: false, certificacion: null,
    creadoEn: `${DENTRO}T12:00:00Z`,
  },
  {
    id: 'i2', tramiteId: 't2', idFlit: 'FLIT-1002', placa: 'XYZ789', vin: 'VIN0000000000002',
    marca: 'Renault', linea: 'Kwid', tipoTramite: 'Traspaso', fechaAprobacion: null,
    fechaCreacion: '2026-04-01T10:00:00Z',
    estado: 'solicitado', compradorNombre: 'Luis Gómez', compradorDocumento: '20202020',
    companiaNombre: 'Concesionario Sur', organismoCodigo: 'STT-PER', organismoNombre: 'STT Pereira',
    valorLiquidado: 200000, valorPagado: null, marcadoPorDiferencia: false, tieneFacturaVenta: true,
    enviadoPorNombre: 'Operaciones E2E', enviadoEn: '2026-04-02T12:00:00Z', pagadoEn: null,
    estancado: false, motivoRechazo: null, gestionOperaciones: false, certificacion: null,
    creadoEn: `${FUERA}T12:00:00Z`,
  },
];

const FACETAS_IMPUESTOS = {
  companias: [{ id: 1, nombre: 'Concesionario Norte' }, { id: 2, nombre: 'Concesionario Sur' }],
  organismos: [{ codigo: '05001', nombre: 'STT Medellín' }, { codigo: '05266', nombre: 'STT Envigado' }],
};

// ────────────────────────────────────── Mocks con traza ─────────────────────────────────────────

interface TrazaCola {
  /** `search` de cada petición de la COLA (no del export). */
  busquedas: string[];
  /** Total que anuncia la respuesta. `null` = el número de filas devueltas. */
  totalForzado: number | null;
}

interface Modulo {
  ruta: '/flito/soat' | '/flito/impuestos';
  cola: RegExp;
  facetas: RegExp;
  export: RegExp;
  filas: Array<{ creadoEn: string }>;
  datosFacetas: unknown;
  nombreServidor: string;
  respaldo: string;
  sustantivo: string;
  anuncioOcupado: string;
}

const SOAT_MOD: Modulo = {
  ruta: '/flito/soat',
  cola: /\/api\/flito\/soat\?/,
  facetas: /\/api\/flito\/soat\/facetas/,
  export: /\/api\/flito\/soat\/export$/,
  filas: SOAT,
  datosFacetas: FACETAS_SOAT,
  nombreServidor: NOMBRE_SOAT,
  respaldo: 'soat.xlsx',
  sustantivo: 'SOAT',
  anuncioOcupado: 'Preparando el archivo de SOAT.',
};

const IMPUESTOS_MOD: Modulo = {
  ruta: '/flito/impuestos',
  cola: /\/api\/flito\/impuestos\?/,
  facetas: /\/api\/flito\/impuestos\/facetas/,
  export: /\/api\/flito\/impuestos\/export$/,
  filas: IMPUESTOS,
  datosFacetas: FACETAS_IMPUESTOS,
  nombreServidor: NOMBRE_IMPUESTOS,
  respaldo: 'impuestos.xlsx',
  sustantivo: 'impuestos',
  anuncioOcupado: 'Preparando el archivo de impuestos.',
};

/**
 * Mock de la cola. **Filtra de verdad por `creadoDesde`/`creadoHasta`**: sin eso, el aserto de que
 * la fila desaparece pasaría con un filtro que no llega a viajar.
 */
async function mockCola(page: Page, m: Modulo): Promise<TrazaCola> {
  const traza: TrazaCola = { busquedas: [], totalForzado: null };
  await page.route(m.facetas, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(m.datosFacetas) }));
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route(m.cola, (route: Route) => {
    const url = new URL(route.request().url());
    traza.busquedas.push(url.search);
    const desde = url.searchParams.get('creadoDesde');
    const hasta = url.searchParams.get('creadoHasta');
    const items = m.filas.filter((f) => {
      const d = f.creadoEn.slice(0, 10);
      return (!desde || d >= desde) && (!hasta || d <= hasta);
    });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items,
        total: traza.totalForzado ?? items.length,
        page: Number(url.searchParams.get('page') ?? 1),
        pageSize: 1,
      }),
    });
  });
  return traza;
}

interface RespuestaExport {
  status: number;
  contentType?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface TrazaExport {
  peticiones: Array<{ search: string; cuerpo: string; metodo: string }>;
  respuesta: RespuestaExport;
}

/** Mock del export. Se registra DESPUÉS de la cola, que es lo que le da precedencia en Playwright. */
async function mockExport(page: Page, m: Modulo, inicial: RespuestaExport = { status: 200 }) {
  const traza: TrazaExport = { peticiones: [], respuesta: inicial };
  await page.route(m.export, (route: Route) => {
    const req = route.request();
    traza.peticiones.push({
      search: new URL(req.url()).search, cuerpo: req.postData() ?? '', metodo: req.method(),
    });
    const r = traza.respuesta;
    return route.fulfill({
      status: r.status,
      contentType: r.contentType ?? CT_XLSX,
      headers: r.headers ?? { 'content-disposition': `attachment; filename="${m.nombreServidor}"` },
      body: r.body ?? CUERPO_XLSX,
    });
  });
  return traza;
}

// ───────────────────────────────────────── Localizadores ────────────────────────────────────────

const botonExportar = (page: Page) => page.getByRole('button', { name: 'Exportar a Excel', exact: true });
/** El disparador del rango. Es un `<summary>`, que no expone su `aria-label` como etiqueta. */
const rango = (page: Page, etiqueta: string) => page.locator('summary').filter({ hasText: etiqueta });
const panelRango = (page: Page, etiqueta: string) =>
  page.locator('details').filter({ has: page.locator('summary').filter({ hasText: etiqueta }) });

/** Deja puesto el rango del filtro nuevo, pinchando los dos extremos del mes visible. */
async function ponerRangoCreado(page: Page) {
  await rango(page, 'Creado en FLITO').click();
  const panel = panelRango(page, 'Creado en FLITO');
  await panel.getByRole('button', { name: DESDE, exact: true }).click();
  await panel.getByRole('button', { name: HASTA, exact: true }).click();
  await expect(rango(page, 'Creado en FLITO')).toContainText('→');
  // Se cierra el calendario, que es lo que hace cualquiera al terminar de elegir. Además el panel
  // flota sobre la barra de filtros y taparía «Limpiar filtros»: dejarlo abierto convertiría un
  // aserto de comportamiento en uno de solapamiento.
  await rango(page, 'Creado en FLITO').click();
  await expect(panel).not.toHaveAttribute('open', '');
}

/**
 * El contador y el «Siguiente». **Van con `.first()` porque hay DOS paginaciones por pantalla**, una
 * encima de la tabla y otra debajo: sin él, el modo estricto de Playwright rompe el test por dos
 * coincidencias y el fallo no habla de lo que se estaba comprobando.
 */
const contador = (page: Page, texto: string) => page.getByText(texto).first();
const siguiente = (page: Page) => page.getByRole('button', { name: 'Siguiente →' }).first();

/** Lo que la cola pidió la última vez, como pares ordenados. */
const pares = (search: string) => [...new URLSearchParams(search).entries()]
  .map(([k, v]) => `${k}=${v}`).sort();

// ══════════════════════════════════ AC6 — quién ve el botón ═════════════════════════════════════

test.describe('HU #11909 — quién ve «Exportar a Excel» (AC6)', () => {
  for (const m of [SOAT_MOD, IMPUESTOS_MOD]) {
    test(`${m.ruta} — el auditor NO tiene el botón, pero SÍ tiene el filtro`, async ({ page }) => {
      await loginAs(page, AUDITOR_USER);
      await mockCola(page, m);
      await page.goto(m.ruta);
      await expect(page.getByText('ABC123')).toBeVisible();

      // **`toHaveCount(0)` y no `toBeDisabled()`**: un botón pintado y apagado pasaría el segundo y
      // sigue siendo una acción que el auditor no puede tener, a un `removeAttribute` de distancia.
      await expect(botonExportar(page)).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Preparando el archivo…' })).toHaveCount(0);
      // Y la banda tampoco se monta: un `role="alert"` que no puede dispararse sigue apareciendo en
      // el árbol de accesibilidad y en los conteos de QA.
      await expect(page.getByText('Se exporta el conjunto filtrado que estás viendo, no solo esta página.'))
        .toHaveCount(0);

      // **El segundo aserto es el que impide «esconder toda la barra de filtros»**, que haría pasar
      // al primero sin cumplir nada: filtrar es leer, y el auditor lee.
      await expect(rango(page, 'Creado en FLITO')).toBeVisible();
      await expect(rango(page, 'Creado en FLITO')).toContainText('Cualquier fecha');
    });
  }

  // El lado positivo, o el test de arriba no prueba nada: un `{false && …}` lo dejaría verde.
  for (const caso of [
    { rol: 'admin', usuario: OPERACIONES_USER, modulo: SOAT_MOD },
    { rol: 'admin', usuario: OPERACIONES_USER, modulo: IMPUESTOS_MOD },
    { rol: 'proveedor', usuario: PROVEEDOR_USER, modulo: SOAT_MOD },
    { rol: 'gestor_impuestos', usuario: GESTOR_IMPUESTOS_USER, modulo: IMPUESTOS_MOD },
  ]) {
    test(`${caso.modulo.ruta} — ${caso.rol} SÍ tiene el botón`, async ({ page }) => {
      await loginAs(page, caso.usuario);
      await mockCola(page, caso.modulo);
      await page.goto(caso.modulo.ruta);

      // `esOperaciones && …` a secas dejaría al gestor sin su botón, y eso solo se ve probando con él.
      await expect(botonExportar(page)).toHaveCount(1);
      await expect(botonExportar(page)).toBeEnabled();
      await expect(page.getByText('Se exporta el conjunto filtrado que estás viendo, no solo esta página.'))
        .toBeVisible();
    });
  }

  test('/flito/soat — al cliente tampoco se le ofrece (decisión 2 del UX)', async ({ page }) => {
    await loginAs(page, CLIENTE_USER);
    await mockCola(page, SOAT_MOD);
    await page.goto('/flito/soat');
    await expect(page.getByRole('heading', { name: 'SOAT', exact: true })).toBeVisible();

    // Cae fuera de `esOperaciones || esGestor` por construcción, y es lo correcto: el backend le
    // recorta de cada fila el proveedor, quién despachó y lo que FLITO pagó, así que su export sería
    // otro archivo con otras columnas. Es HU aparte, no una condición más.
    await expect(botonExportar(page)).toHaveCount(0);
  });
});

// ═════════════════════════════ AC3 — el filtro «Creado en FLITO» ════════════════════════════════

test.describe('HU #11909 — el filtro «Creado en FLITO» (AC3)', () => {
  for (const m of [SOAT_MOD, IMPUESTOS_MOD]) {
    test(`${m.ruta} — acota la cola, baja el contador y saca «Limpiar filtros»`, async ({ page }) => {
      await loginAs(page, OPERACIONES_USER);
      const cola = await mockCola(page, m);
      await page.goto(m.ruta);

      await expect(page.getByText('XYZ789')).toBeVisible();
      await expect(contador(page, `2 ${m.sustantivo} · página 1`)).toBeVisible();
      // Antes de tocar nada no hay filtros: si esto ya saliera, el aserto de abajo sería vacuo.
      await expect(page.getByRole('button', { name: 'Limpiar filtros' })).toHaveCount(0);

      await ponerRangoCreado(page);

      await expect(page.getByText('XYZ789')).toHaveCount(0);
      await expect(page.getByText('ABC123')).toBeVisible();
      await expect(contador(page, `1 ${m.sustantivo} · página 1`)).toBeVisible();
      // **Este es el aserto que mata el mutante de olvidar `creado` en `hayFiltros`.** Sin él, la
      // fila desaparece igual —el aserto obvio pasa— pero el vacío filtrado mentiría («No hay … en
      // esta vista. Sincroniza desde el Tablero…») y no habría salida.
      await expect(page.getByRole('button', { name: 'Limpiar filtros' })).toBeVisible();

      // Y viaja con los nombres que ya usa el producto (`FlitoTramites`), en `yyyy-mm-dd`.
      expect(pares(cola.busquedas.at(-1) ?? '')).toContain(`creadoDesde=${DESDE}`);
      expect(pares(cola.busquedas.at(-1) ?? '')).toContain(`creadoHasta=${HASTA}`);
    });

    test(`${m.ruta} — «Limpiar filtros» lo quita y la cola vuelve entera`, async ({ page }) => {
      await loginAs(page, OPERACIONES_USER);
      const cola = await mockCola(page, m);
      await page.goto(m.ruta);
      await ponerRangoCreado(page);
      await expect(page.getByText('XYZ789')).toHaveCount(0);

      await page.getByRole('button', { name: 'Limpiar filtros' }).click();

      await expect(rango(page, 'Creado en FLITO')).toContainText('Cualquier fecha');
      await expect(page.getByText('XYZ789')).toBeVisible();
      await expect.poll(() => cola.busquedas.at(-1) ?? '').not.toContain('creadoDesde');
    });
  }

  test('/flito/soat — acotar desde la página 3 devuelve a la 1', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const cola = await mockCola(page, SOAT_MOD);
    // `pageSize` es 1 en el mock: con dos filas hay dos páginas y «Siguiente» está vivo.
    await page.goto('/flito/soat');
    await siguiente(page).click();
    await expect.poll(() => cola.busquedas.at(-1) ?? '').toContain('page=2');

    await ponerRangoCreado(page);

    // Sin esta puntada el usuario se queda en una página que ya no existe y ve un vacío que no lo es.
    await expect.poll(() => new URLSearchParams(cola.busquedas.at(-1) ?? '').get('page')).toBe('1');
  });
});

// ═════════════════════════════ AC1..AC2 — la petición del export ════════════════════════════════

test.describe('HU #11909 — qué manda el export', () => {
  for (const m of [SOAT_MOD, IMPUESTOS_MOD]) {
    test(`${m.ruta} — todo va en el CUERPO del POST, nada en la URL`, async ({ page }) => {
      await loginAs(page, OPERACIONES_USER);
      const cola = await mockCola(page, m);
      const exportado = await mockExport(page, m);
      await page.goto(m.ruta);

      // El placeholder de estas dos colas ofrece buscar por COMPRADOR: este texto es un dato personal.
      await page.getByPlaceholder(/^Buscar/).fill('Ana Pérez');
      // El buscador va con debounce de 300 ms: sin esperar a que la COLA lo haya pedido, el export
      // saldría con el `buscar` anterior y el aserto de abajo mediría otra cosa.
      await expect.poll(() => pares(cola.busquedas.at(-1) ?? '')).toContain('buscar=Ana Pérez');
      await ponerRangoCreado(page);

      await Promise.all([page.waitForEvent('download'), botonExportar(page).click()]);

      expect(exportado.peticiones).toHaveLength(1);
      const peticion = exportado.peticiones[0];
      expect(peticion.metodo).toBe('POST');
      // **La línea del §14.** Ni el texto del buscador ni ningún otro filtro tocan la URL: en la
      // query acabarían en el historial del navegador, en el `Referer` y en el access log del proxy.
      expect(peticion.search, 'el export escribió filtros en la URL').toBe('');
      expect(peticion.search).not.toContain('Ana');

      const cuerpo = JSON.parse(peticion.cuerpo) as Record<string, unknown>;
      expect(cuerpo.buscar).toBe('Ana Pérez');
      expect(cuerpo.creadoDesde).toBe(DESDE);
      expect(cuerpo.creadoHasta).toBe(HASTA);
    });

    test(`${m.ruta} — los tipos del cuerpo son los que el esquema \`.strict()\` admite`, async ({ page }) => {
      await loginAs(page, OPERACIONES_USER);
      await mockCola(page, m);
      const exportado = await mockExport(page, m);
      await page.goto(m.ruta);

      // El multiselect guarda `String(c.id)` porque un `<input>` no tiene enteros. En la QUERY de la
      // cola da igual —allí todo es texto—, pero el cuerpo del export lo valida
      // `z.array(z.number())` con `.strict()`: `["1"]` no es un filtro que se ignore, es un 400.
      // Se localiza por lo que CONTIENE y no por el texto del `summary`: ese texto cambia a
      // «1 seleccionado(s)» en cuanto se marca una, y un localizador por rótulo dejaría de resolver
      // justo cuando hace falta para volver a cerrarlo.
      // `hasText` y no `has: getByRole(...)`: con el `<details>` cerrado la casilla está en el DOM
      // pero fuera del árbol de accesibilidad, así que un localizador por rol no la encuentra —y el
      // filtro se quedaría esperando al elemento que tiene que abrir.
      const compania = page.locator('details').filter({ hasText: 'Concesionario Norte' });
      await compania.locator('summary').click();
      await page.getByRole('checkbox', { name: 'Concesionario Norte' }).check();
      await compania.locator('summary').click();
      // Y `estancado` es un booleano, no el `si` con el que viaja en la query de la cola.
      await page.getByRole('checkbox', { name: 'Solo sin gestión' }).check();

      await Promise.all([page.waitForEvent('download'), botonExportar(page).click()]);

      const cuerpo = JSON.parse(exportado.peticiones[0].cuerpo) as Record<string, unknown>;
      expect(cuerpo.companias, 'las compañías viajaron como texto').toEqual([1]);
      expect(cuerpo.estancado).toBe(true);
    });

    test(`${m.ruta} — un export no pagina: mismo cuerpo desde la página 1 y desde la 2`, async ({ page }) => {
      await loginAs(page, OPERACIONES_USER);
      const cola = await mockCola(page, m);
      const exportado = await mockExport(page, m);
      await page.goto(m.ruta);
      await expect(page.getByText('XYZ789')).toBeVisible();

      await Promise.all([page.waitForEvent('download'), botonExportar(page).click()]);

      await siguiente(page).click();
      await expect.poll(() => cola.busquedas.at(-1) ?? '').toContain('page=2');
      await Promise.all([page.waitForEvent('download'), botonExportar(page).click()]);

      expect(exportado.peticiones).toHaveLength(2);
      const [uno, dos] = exportado.peticiones.map((p) => JSON.parse(p.cuerpo) as Record<string, unknown>);
      // Mismo filtro, distinta página: si la página viajara, estos dos cuerpos no serían iguales.
      expect(dos).toEqual(uno);
      for (const clave of ['page', 'pageSize', 'cursor', 'limit']) {
        expect(Object.keys(dos), `el export mandó \`${clave}\``).not.toContain(clave);
      }
      expect(exportado.peticiones[1].search).toBe('');
    });
  }
});

// ═════════════════════════════════ Los cuatro estados de la acción ══════════════════════════════

test.describe('HU #11909 — los estados de la descarga', () => {
  test('/flito/soat — reposo → preparando → «Archivo descargado» → cerrado', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page, SOAT_MOD);
    const exportado = await mockExport(page, SOAT_MOD);
    let soltar = () => {};
    const retenido = new Promise<void>((r) => { soltar = r; });
    await page.route(SOAT_MOD.export, async (route) => { await retenido; return route.fallback(); });
    await page.goto('/flito/soat');

    await botonExportar(page).click();

    // Ocupado: el rótulo cambia y `aria-busy` lo dice; el cambio de nombre accesible no se anuncia
    // solo, y por eso además está la región polite siempre montada.
    const ocupado = page.getByRole('button', { name: 'Preparando el archivo…' });
    await expect(ocupado).toBeVisible();
    await expect(ocupado).toBeDisabled();
    await expect(ocupado).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByText(SOAT_MOD.anuncioOcupado)).toBeAttached();

    const [descarga] = await Promise.all([page.waitForEvent('download'), soltar()]);
    expect(descarga.suggestedFilename()).toBe(NOMBRE_SOAT);

    // La descarga del navegador no basta: con la barra de descargas oculta no hay ninguna señal.
    await expect(page.getByText(`Archivo descargado: ${NOMBRE_SOAT}`).first()).toBeVisible();
    // El éxito NO es un `role="alert"`: se anuncia por la región polite, sin interrumpir.
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(botonExportar(page)).toBeEnabled();

    await page.getByRole('button', { name: 'Cerrar el aviso' }).click();
    await expect(page.getByText(`Archivo descargado: ${NOMBRE_SOAT}`)).toHaveCount(0);
    expect(exportado.peticiones).toHaveLength(1);
  });

  test('/flito/impuestos — el anuncio nombra a SU cola', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page, IMPUESTOS_MOD);
    await mockExport(page, IMPUESTOS_MOD);
    await page.goto('/flito/impuestos');

    await Promise.all([page.waitForEvent('download'), botonExportar(page).click()]);
    await expect(page.getByText(`Archivo descargado: ${NOMBRE_IMPUESTOS}`).first()).toBeVisible();
  });

  test('/flito/soat — el doble clic NO sale dos veces a la red', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page, SOAT_MOD);
    const exportado = await mockExport(page, SOAT_MOD);
    let soltar = () => {};
    const retenido = new Promise<void>((r) => { soltar = r; });
    // Contador propio, incrementado ANTES de retener: mientras la petición está en vuelo —que es
    // justo cuando hay que contar— la traza del mock de abajo todavía está vacía.
    let salidas = 0;
    await page.route(SOAT_MOD.export, async (route) => {
      salidas += 1;
      await retenido;
      return route.fallback();
    });
    await page.goto('/flito/soat');
    await expect(botonExportar(page)).toBeEnabled();

    /**
     * **Los tres clics van en UNA sola evaluación, y ahí está todo el test.** Con tres
     * `page.evaluate()` seguidos, cada `await` es un viaje al navegador y en ese hueco React ya hizo
     * el commit que escribe `disabled`: lo que mediría el test sería el atributo, que es justo lo
     * que NO basta. En el mismo despacho síncrono, lo único que puede detener al segundo y al
     * tercero es la `ref`.
     */
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')]
        .find((x) => x.textContent?.includes('Exportar a Excel') || x.textContent?.includes('Preparando'));
      const boton = b as HTMLButtonElement;
      boton.click();
      boton.click();
      boton.click();
    });

    await expect(page.getByRole('button', { name: 'Preparando el archivo…' })).toBeVisible();
    // La afirmación va AQUÍ, antes de soltar: las peticiones que fueran a salir ya salieron.
    expect(salidas, 'el candado dejó pasar un segundo POST').toBe(1);

    await Promise.all([page.waitForEvent('download'), soltar()]);
    expect(exportado.peticiones).toHaveLength(1);
    // Y al terminar vuelve a reposo: el candado se suelta, no se queda puesto.
    await expect(botonExportar(page)).toBeEnabled();
  });
});

// ═══════════════════════════════════ AC4 — el tope, y los errores ═══════════════════════════════

test.describe('HU #11909 — el tope y los errores', () => {
  test('/flito/soat — el 422 del tope no descarga nada y no ofrece reintento', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page, SOAT_MOD);
    // El número lo escribe el SERVIDOR con la cifra de su entorno. Este mock usa una que la pantalla
    // no puede haber compilado.
    const mensajeServidor = 'El filtro aplicado supera las 1.234 filas que admite un export. '
      + 'Acota la búsqueda —por estado, por compañía, por organismo o por fecha de creación— '
      + 'y vuelve a intentarlo.';
    await mockExport(page, SOAT_MOD, {
      status: 422,
      contentType: 'application/json',
      headers: {},
      body: JSON.stringify({ error: mensajeServidor, codigo: 'export_demasiado_grande' }),
    });
    await page.goto('/flito/soat');

    let descargas = 0;
    page.on('download', () => { descargas += 1; });
    await botonExportar(page).click();

    const alerta = page.getByRole('alert');
    await expect(alerta).toContainText(mensajeServidor);
    await expect(alerta).toContainText('1.234');
    // La cifra la trae el 422: cualquier número compilado en el front miente el día que se mueva la
    // variable de entorno del API.
    expect(await page.locator('body').innerText(), 'la pantalla tiene su propia cifra escrita')
      .not.toContain('2.000');
    // Repetir la misma petición daría el mismo 422: lo que hay que cambiar es el filtro.
    await expect(alerta.getByRole('button', { name: /Reintentar/ })).toHaveCount(0);

    expect(descargas, 'un error acabó en la carpeta de descargas').toBe(0);
    // Y el botón vuelve a reposo, no se queda en «Preparando…».
    await expect(botonExportar(page)).toBeEnabled();
    await alerta.getByRole('button', { name: 'Cerrar el aviso' }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('/flito/impuestos — un 422 VESTIDO de xlsx tampoco se descarga', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page, IMPUESTOS_MOD);
    // `request()` mira el `content-type` ANTES que `res.ok`, así que un error con cabecera de xlsx
    // sale por la rama del blob: sin el guardia de `downloadPostNamed` acabaría en la carpeta de
    // descargas del usuario, con extensión `.xlsx` y un JSON de error dentro.
    await mockExport(page, IMPUESTOS_MOD, {
      status: 422,
      contentType: CT_XLSX,
      headers: { 'content-disposition': 'attachment; filename="trampa.xlsx"' },
      body: JSON.stringify({
        error: 'El filtro aplicado supera las 900 filas que admite un export.',
        codigo: 'export_demasiado_grande',
      }),
    });
    await instrumentarObjectUrls(page);
    await page.goto('/flito/impuestos');

    let descargas = 0;
    page.on('download', () => { descargas += 1; });
    await botonExportar(page).click();

    await expect(page.getByRole('alert')).toContainText('supera las 900 filas');
    expect(descargas, 'se descargó un JSON de error llamado .xlsx').toBe(0);
    const urls = await leerUrls(page);
    expect(urls.creados, 'se creó un object URL para un error').toHaveLength(0);
  });

  test('/flito/soat — el 429 sí ofrece «Reintentar la descarga», y funciona', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page, SOAT_MOD);
    const traza = await mockExport(page, SOAT_MOD, {
      status: 429,
      contentType: 'application/json',
      headers: {},
      body: JSON.stringify({ error: 'Demasiados exports seguidos, espere 1 minuto' }),
    });
    await page.goto('/flito/soat');

    await botonExportar(page).click();
    const alerta = page.getByRole('alert');
    await expect(alerta).toContainText('Demasiados exports seguidos, espere 1 minuto');

    // **«Reintentar la descarga», no «Reintentar» a secas.** En SOAT la banda de error de la COLA
    // tiene su propio «Reintentar» y puede estar en pantalla a la vez: dos botones con el mismo
    // nombre accesible y dos efectos distintos.
    await expect(alerta.getByRole('button', { name: 'Reintentar la descarga' })).toBeVisible();
    await expect(alerta.getByRole('button', { name: 'Reintentar', exact: true })).toHaveCount(0);

    traza.respuesta = { status: 200 };
    await Promise.all([
      page.waitForEvent('download'),
      alerta.getByRole('button', { name: 'Reintentar la descarga' }).click(),
    ]);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(traza.peticiones).toHaveLength(2);
  });

  test('/flito/soat — un 500 NO hace eco del texto del servidor', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page, SOAT_MOD);
    await mockExport(page, SOAT_MOD, {
      status: 500,
      contentType: 'application/json',
      headers: {},
      body: JSON.stringify({ error: 'Fallo consultando al comprador 10.101.010' }),
    });
    await page.goto('/flito/soat');

    await botonExportar(page).click();
    await expect(page.getByRole('alert')).toContainText('No se pudo generar el archivo');
    // El eco está acotado al tope y al limitador, que son frases FIJAS del servidor. Un 500 sí puede
    // llevar en su texto lo que se estaba consultando.
    expect(await page.content()).not.toContain('10.101.010');
  });
});

// ════════════════════════════ El nombre del archivo lo pone el servidor ═════════════════════════

test.describe('HU #11909 — el nombre del archivo', () => {
  test('/flito/soat — se acepta el del servidor, aunque el reloj local no pueda producirlo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page, SOAT_MOD);
    await mockExport(page, SOAT_MOD);
    await instrumentarObjectUrls(page);
    await page.goto('/flito/soat');

    const [descarga] = await Promise.all([page.waitForEvent('download'), botonExportar(page).click()]);

    // 2099: ningún `new Date()` de esta máquina lo produce. Un nombre fabricado en el navegador
    // llevaría la hora del equipo de quien descarga, no la de Colombia.
    expect(descarga.suggestedFilename()).toBe(NOMBRE_SOAT);
    await expect(page.getByText(`Archivo descargado: ${NOMBRE_SOAT}`).first()).toBeVisible();

    const urls = await leerUrls(page);
    expect(urls.creados).toHaveLength(1);
    // El object URL se libera DESPUÉS de la descarga, cediendo el turno: revocarlo en la misma
    // vuelta síncrona del clic cancela la descarga en algunos navegadores.
    expect(urls.revocados).toEqual(urls.creados);
    expect(urls.revocadosEnElMismoTurno, 'se revocó en la misma vuelta síncrona del clic').toBe(0);
  });

  for (const nombreHostil of [
    // Un documento de identidad con forma de nombre de archivo: es dígitos, como el sello.
    'soat_10101010.xlsx',
    // Ocho dígitos y cuatro: pasa la forma, pero mes 56 y día 78 no existen. Es una cédula.
    'soat_19345678-0304.xlsx',
    // De otra cola: el prefijo también forma parte de lo esperado.
    'impuestos_20260830-1412.xlsx',
    // Forma correcta, instante imposible: día 32 no existe. Es lo que distingue «esto es una marca
    // de tiempo» de «esto tiene doce dígitos».
    'soat_20260832-1412.xlsx',
  ]) {
    test(`/flito/soat — «${nombreHostil}» se rechaza y cae al respaldo`, async ({ page }) => {
      await loginAs(page, OPERACIONES_USER);
      await mockCola(page, SOAT_MOD);
      await mockExport(page, SOAT_MOD, {
        status: 200,
        headers: { 'content-disposition': `attachment; filename="${nombreHostil}"` },
      });
      await page.goto('/flito/soat');

      const [descarga] = await Promise.all([page.waitForEvent('download'), botonExportar(page).click()]);

      // El archivo se descarga igual —con un nombre peor—, pero el nombre raro no se propaga: ni al
      // disco, ni al «Archivo descargado: …» que esta pantalla pinta.
      expect(descarga.suggestedFilename()).toBe(SOAT_MOD.respaldo);
      await expect(page.getByText(`Archivo descargado: ${SOAT_MOD.respaldo}`).first()).toBeVisible();
      // El nombre rechazado no se propaga al «Archivo descargado: …» que la pantalla pinta.
      await expect(page.getByText(`Archivo descargado: ${nombreHostil}`)).toHaveCount(0);
    });
  }

  test('/flito/soat — un `filename` con ruta no puede proponer una carpeta', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page, SOAT_MOD);
    await mockExport(page, SOAT_MOD, {
      status: 200,
      headers: { 'content-disposition': 'attachment; filename="../../etc/soat_20991231-2359.xlsx"' },
    });
    await page.goto('/flito/soat');

    const [descarga] = await Promise.all([page.waitForEvent('download'), botonExportar(page).click()]);

    // `saneaNombreDeArchivo` (lib/api.ts) se queda con el último segmento ANTES de que el predicado
    // de forma lo vea, así que este nombre se acepta ya saneado: lo que no puede es llegar al disco
    // con separadores. Se comprueba lo que de verdad ocurre, no lo que parecería más estricto.
    expect(descarga.suggestedFilename()).toBe(NOMBRE_SOAT);
    expect(descarga.suggestedFilename()).not.toContain('/');
    expect(descarga.suggestedFilename()).not.toContain('..');
  });
});
