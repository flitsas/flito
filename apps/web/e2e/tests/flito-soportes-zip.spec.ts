// FLITO — «Descargar soportes» en ZIP sobre las filas marcadas (HU #11910, Feature #11908).
//
// Este archivo protege tres cosas, y solo la primera es el ZIP.
//
// **1. Una ausencia.** El botón que el auditor no puede tener **no existe en su DOM**, y tampoco la
// columna de casillas. Escrito como `toBeDisabled()` el test daría por bueno un botón pintado y
// apagado, que es otra promesa —la de un atributo que se quita desde la consola—. `toHaveCount(0)`
// es lo que lo mata. Y con su contrapartida: el auditor **sí** sigue viendo la cola, porque
// «esconder media pantalla» también pasaría el primer aserto.
//
// **2. Una regla de reparto que esta HU INVIRTIÓ, y su precio.** Al abrir la casilla a cualquier
// fila (AC1), «Enviar» y «Certificar» dejan de exigir que la selección entera les encaje. El peligro
// que esa exigencia cubría es real —pulsar creyendo que se actúa sobre 8 y actuar sobre 3— y ahora
// lo cubren dos cosas: el rótulo, que dice «(3 de 8)», y **la petición, que lleva 3 ids**. El aserto
// que importa es el segundo: el rótulo se puede poner verde sin que el cuerpo cambie.
//
// **3. Que el diálogo no sea decorativo.** El mutante más probable de toda la HU es un diálogo que
// se pinta, se confirma y manda siempre todos los tipos. Por eso cada caso del diálogo afirma sobre
// el CUERPO interceptado y no sobre lo que se ve.
//
// Los datos son SINTÉTICOS. Ni un dato real entra en un spec.
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import {
  loginAs, AUDITOR_USER, GESTOR_IMPUESTOS_USER, OPERACIONES_USER, PROVEEDOR_USER,
} from '../helpers/auth';
import { instrumentarObjectUrls, leerUrls } from '../helpers/object-urls';
import { ZIP_SOPORTES_MAX_REGISTROS } from '@operaciones/shared-types';

/** `content-type` de un ZIP: es lo que hace que `request()` devuelva un blob y no intente JSON. */
const CT_ZIP = 'application/zip';
/** Firma de un ZIP. Sirve para comprobar que lo descargado es el archivo y no un JSON disfrazado. */
const CUERPO_ZIP = 'PKFLITO-E2E';
/**
 * El sello del nombre que devuelve el servidor: **una fecha que el reloj del cliente no puede
 * producir**. Si el mock devolviera «hoy», un nombre fabricado en el navegador pasaría el test sin
 * que nadie lo notara.
 */
const NOMBRE_ZIP = 'soportes_20991231-2359.zip';

// ─────────────────────────────────────── Fixtures de cola ───────────────────────────────────────

/** Una fila SOAT mínima con lo que la cola pinta. `estado` es lo que decide si es enviable. */
const filaSoat = (id: string, placa: string, estado: string) => ({
  id, vin: `VIN000000000000${id.slice(-1)}`, placa, marca: 'Chevrolet', linea: 'Onix',
  cilindraje: '1598', carroceria: 'SEDAN', tipoServicio: 'Particular',
  estado, esMultiplePropietario: false, companiaNombre: 'Concesionario Norte',
  organismoNombre: 'STT Manizales', proveedorSoatId: null, proveedorSoatNombre: null,
  compradores: [], tramitesFlit: [], tipoTramite: 'Matricula',
  fechaAprobacion: null, fechaCreacion: '2026-03-28T10:00:00Z',
  enviadoPorNombre: null, enviadoEn: null, pagadoEn: null, valorPagado: null,
  estancado: false, motivoRechazo: null, gestionOperaciones: false,
  creadoEn: '2026-03-28T10:00:00Z',
});

/** Un pendiente y dos pagados: la mezcla que antes no se podía ni marcar. */
const SOAT = [
  filaSoat('s1', 'ABC123', 'pendiente'),
  filaSoat('s2', 'XYZ789', 'pagado'),
  filaSoat('s3', 'DEF456', 'pagado'),
];

const filaImpuesto = (id: string, placa: string, estado: string) => ({
  id, tramiteId: `t${id}`, idFlit: `FLIT-10${id.slice(-1)}`, placa, vin: 'VIN0000000000001',
  marca: 'Chevrolet', linea: 'Onix', tipoTramite: 'Matricula', fechaAprobacion: null,
  fechaCreacion: '2026-03-28T10:00:00Z', estado, compradorNombre: null, compradorDocumento: null,
  companiaNombre: 'Concesionario Norte', organismoCodigo: 'STT-MZL', organismoNombre: 'STT Manizales',
  valorLiquidado: 120000, valorPagado: null, marcadoPorDiferencia: false, tieneFacturaVenta: true,
  enviadoPorNombre: null, enviadoEn: null, pagadoEn: null, estancado: false, motivoRechazo: null,
  gestionOperaciones: false, certificacion: null, creadoEn: '2026-03-28T10:00:00Z',
});

const IMPUESTOS = [
  filaImpuesto('i1', 'ABC123', 'pendiente'),
  filaImpuesto('i2', 'XYZ789', 'solicitado'),
  filaImpuesto('i3', 'DEF456', 'pagado'),
];

const filaTramite = (n: number, placa: string, estado: string, accionable: boolean) => ({
  fechaCreacion: '2026-08-01T12:00:00Z',
  tramiteId: `aaaaaaaa-0000-0000-0000-00000000000${n}`, idFlit: `FLIT-200${n}`, estado,
  asignado: accionable, tipoTramite: 'Traspaso', ciudad: 'Pereira',
  empresaExiste: true, empresaNit: '900222', secretariaEmparejada: true,
  transitoNombre: 'STT Pereira', facturaVentaFlitId: 'fac-xyz',
  companiaNombre: 'Concesionario Sur', organismoNombre: 'STT Pereira',
  vehiculo: { vin: `VIN000000000000${n}`, placa, marca: 'Renault', linea: 'Kwid' },
  compradorPrincipal: null, compradores: [],
  soat: { id: `s${n}`, estado: 'pagado', proveedorSoatNombre: 'Seguros Alfa', valorPagado: 450000 },
  excepcionesAutogestion: [], soatAutogestionado: false,
  impuesto: { id: `i${n}`, estado: 'pagado', tieneFacturaVenta: true, valorPagado: 120000 },
  listoParaEntregar: true,
});

/**
 * Dos accionables y **un Entregado**. El Entregado es la fila que esta HU añade al marcado: es la
 * que tiene la evidencia completa, y hasta ahora su casilla venía `disabled`.
 */
const TRAMITES = [
  filaTramite(1, 'ABC123', 'Asignado', true),
  filaTramite(2, 'XYZ789', 'Asignado', true),
  filaTramite(3, 'DEF456', 'Entregado', false),
];

// ─────────────────────────────────────── Descriptor de cola ─────────────────────────────────────

interface Pantalla {
  ruta: '/flito/soat' | '/flito/impuestos' | '/flito/tramites';
  zip: RegExp;
  /** Cuántos tipos ofrece: 1 = sin diálogo. */
  tipos: number;
  montar: (page: Page) => Promise<void>;
  /** Una placa que existe en la cola, para comprobar que el auditor la sigue viendo. */
  placaVisible: string;
}

const json = (route: Route, body: unknown) => route.fulfill({
  status: 200, contentType: 'application/json', body: JSON.stringify(body),
});

async function montarSoat(page: Page, items: unknown[] = SOAT) {
  await page.route(/\/api\/flito\/soat\/facetas/, (r) => json(r, { companias: [], organismos: [], proveedores: [] }));
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat/, (r) =>
    json(r, [{ id: 'p1', nombre: 'Seguros Alfa', activo: true }]));
  await page.route(/\/api\/flito\/soat\?/, (r) => json(r, { items, total: items.length, page: 1, pageSize: 50 }));
}

async function montarImpuestos(page: Page) {
  await page.route(/\/api\/flito\/impuestos\/facetas/, (r) => json(r, { companias: [], organismos: [] }));
  await page.route(/\/api\/flito\/impuestos\?/, (r) =>
    json(r, { items: IMPUESTOS, total: IMPUESTOS.length, page: 1, pageSize: 50 }));
}

async function montarTramites(page: Page, items: unknown[] = TRAMITES) {
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat/, (r) => json(r, []));
  await page.route(/\/api\/flito\/parametrizacion\/companias/, (r) => json(r, []));
  await page.route(/\/api\/flito\/sync\/estado/, (r) => json(r, { ultimaSincronizacion: '2026-08-30T10:00:00Z' }));
  await page.route(/\/api\/flito\/tramites\/facetas/, (r) =>
    json(r, { estados: ['Asignado', 'Entregado'], tramites: ['Traspaso'], ciudades: ['Pereira'], transitos: ['STT Pereira'] }));
  await page.route(/\/api\/flito\/tramites\?/, (r) =>
    json(r, { items, total: items.length, page: 1, pageSize: 50 }));
}

/** Cinco trámites accionables, para el caso de las dos cabeceras. */
const CINCO_TRAMITES = [1, 2, 3, 4, 5].map((n) => filaTramite(n, `MIX00${n}`, 'Asignado', true));

/** Uno más que el tope publicado: la selección que la pantalla tiene que rechazar sin preguntar. */
const SOBRE_EL_TOPE = [...Array(ZIP_SOPORTES_MAX_REGISTROS + 1)].map(
  (_, n) => filaSoat(`s${n + 100}`, `TOP${String(n).padStart(3, '0')}`, 'pagado'),
);

const P_SOAT: Pantalla = {
  ruta: '/flito/soat', zip: /\/api\/flito\/soat\/soportes\/zip$/, tipos: 1,
  montar: montarSoat, placaVisible: 'ABC123',
};
const P_IMPUESTOS: Pantalla = {
  ruta: '/flito/impuestos', zip: /\/api\/flito\/impuestos\/soportes\/zip$/, tipos: 2,
  montar: montarImpuestos, placaVisible: 'ABC123',
};
const P_TRAMITES: Pantalla = {
  ruta: '/flito/tramites', zip: /\/api\/flito\/tramites\/soportes\/zip$/, tipos: 3,
  montar: montarTramites, placaVisible: 'ABC123',
};

interface RespuestaZip {
  status: number;
  contentType?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface TrazaZip {
  peticiones: Array<{ search: string; cuerpo: unknown; metodo: string }>;
  respuesta: RespuestaZip;
}

/** Mock del ZIP, con traza del cuerpo. Se registra DESPUÉS de la cola: eso le da precedencia. */
async function mockZip(page: Page, p: Pantalla, inicial: RespuestaZip = { status: 200 }) {
  const traza: TrazaZip = { peticiones: [], respuesta: inicial };
  await page.route(p.zip, (route: Route) => {
    const req = route.request();
    traza.peticiones.push({
      search: new URL(req.url()).search, cuerpo: req.postDataJSON(), metodo: req.method(),
    });
    const r = traza.respuesta;
    return route.fulfill({
      status: r.status,
      contentType: r.contentType ?? CT_ZIP,
      headers: r.headers ?? { 'content-disposition': `attachment; filename="${NOMBRE_ZIP}"` },
      body: r.body ?? CUERPO_ZIP,
    });
  });
  return traza;
}

// ───────────────────────────────────────── Localizadores ────────────────────────────────────────

const botonZip = (page: Page) => page.getByRole('button', { name: /^Descargar soportes \(/ });
const casillaCabecera = (page: Page) =>
  page.getByRole('checkbox', { name: 'Seleccionar las filas de esta página' });
const dialogo = (page: Page) => page.getByRole('dialog');
const confirmarZip = (page: Page) => dialogo(page).getByRole('button', { name: 'Descargar', exact: true });
/**
 * La banda VISIBLE del resultado.
 *
 * El mismo texto sale DOS veces a propósito: una en la región `role="status"` sr-only —que es la que
 * lo anuncia— y otra en la tarjeta que se ve. `.last()` se queda con la segunda, que es la del orden
 * del DOM; comprobar solo la sr-only daría por bueno un éxito que nadie ve en pantalla.
 */
const bandaZip = (page: Page, texto: string) => page.getByText(texto).last();

/** Marca N filas por placa. */
async function marcar(page: Page, ...placas: string[]) {
  for (const placa of placas) await page.getByLabel(`Seleccionar ${placa}`).check();
}

// ═══════════════════════════════ AC7 — quién ve la acción y las casillas ════════════════════════

test.describe('HU #11910 — AC7: el auditor no la tiene, y no como botón apagado', () => {
  for (const p of [P_SOAT, P_IMPUESTOS, P_TRAMITES]) {
    test(`${p.ruta} — sin botón y sin casillas, pero con la cola entera`, async ({ page }) => {
      await loginAs(page, AUDITOR_USER);
      await p.montar(page);
      await page.goto(p.ruta);
      await expect(page.getByText(p.placaVisible).first()).toBeVisible();

      // `toHaveCount(0)` y no `toBeDisabled()`: un botón pintado y apagado pasaría el segundo y
      // sigue siendo una acción que el auditor no puede tener.
      await expect(botonZip(page)).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Preparando el ZIP…' })).toHaveCount(0);
      await expect(casillaCabecera(page)).toHaveCount(0);
      await expect(page.getByRole('checkbox', { name: /^Seleccionar [A-Z]{3}\d{3}$/ })).toHaveCount(0);

      // El segundo aserto es el que impide «esconder media pantalla», que haría pasar al primero
      // sin cumplir nada: el auditor lee, y las tres filas siguen ahí.
      await expect(page.getByText('DEF456').first()).toBeVisible();
    });
  }

  // El lado positivo, o el test de arriba no prueba nada: un `{false && …}` lo dejaría verde.
  for (const caso of [
    { rol: 'admin', usuario: OPERACIONES_USER, pantalla: P_SOAT },
    { rol: 'admin', usuario: OPERACIONES_USER, pantalla: P_IMPUESTOS },
    { rol: 'admin', usuario: OPERACIONES_USER, pantalla: P_TRAMITES },
    // Gana casillas que HOY no tiene: los comprobantes de sus SOAT son suyos.
    { rol: 'proveedor', usuario: PROVEEDOR_USER, pantalla: P_SOAT },
    { rol: 'gestor_impuestos', usuario: GESTOR_IMPUESTOS_USER, pantalla: P_IMPUESTOS },
  ]) {
    test(`${caso.pantalla.ruta} — ${caso.rol} SÍ marca filas y SÍ ve la acción`, async ({ page }) => {
      await loginAs(page, caso.usuario);
      await caso.pantalla.montar(page);
      await page.goto(caso.pantalla.ruta);

      // `esOperaciones && …` a secas dejaría al gestor y al proveedor sin casillas, y eso solo se
      // ve probando con ellos.
      await expect(casillaCabecera(page)).toHaveCount(1);
      await marcar(page, 'DEF456');
      await expect(botonZip(page)).toHaveCount(1);
      await expect(botonZip(page)).toBeEnabled();
    });
  }
});

// ═════════════════════ AC1 — marcar más filas no amplía lo que se envía ═════════════════════════

test.describe('HU #11910 — AC1: el marcado se abre, el alcance de las acciones no', () => {
  /**
   * *Mutantes:* (a) `seleccionables = filas.filter(estado === PENDIENTE)` — la fila Pagada no se
   * puede marcar y `marcar()` falla; (b) pasar `[...seleccion]` a `BarraEnvio` — el rótulo seguiría
   * diciendo «(1 de 3)» y solo el aserto del CUERPO lo caza.
   */
  test('/flito/soat — 3 marcadas y 1 Pendiente: «Enviar al gestor» manda UN id', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montarSoat(page);
    const cuerpos: unknown[] = [];
    await page.route(/\/api\/flito\/soat\/enviar$/, (route) => {
      cuerpos.push(route.request().postDataJSON());
      return json(route, { enviados: 1 });
    });

    await page.goto('/flito/soat');
    await casillaCabecera(page).check();
    await expect(page.getByText('3 seleccionado(s)')).toBeVisible();

    await expect(page.getByRole('button', { name: 'Enviar al gestor (1 de 3)' })).toBeVisible();
    await expect(page.getByText(/De las 3 filas marcadas, 1 están Pendientes/)).toBeVisible();
    // Y la acción nueva sí usa las 3: esa es la diferencia que hace comprensible el desajuste.
    await expect(page.getByRole('button', { name: 'Descargar soportes (3)' })).toBeVisible();

    await page.getByLabel('Enviar a').selectOption('p1');
    await page.getByRole('button', { name: 'Enviar al gestor (1 de 3)' }).click();

    await expect.poll(() => cuerpos.length).toBe(1);
    expect(cuerpos[0]).toEqual({ ids: ['s1'], proveedorSoatId: 'p1' });
  });

  /**
   * La misma corrección en Trámites, donde nadie la había escrito porque el `disabled` la tapaba.
   *
   * *Mutantes:* (a) devolver `disabled={!esAccionable(f)}` — la fila Entregada no se marca; (b)
   * dejar `entregar(ids())` — el cuerpo llevaría los tres y el último aserto cae.
   */
  test('/flito/tramites — una Entregada se puede marcar, y «Entregar» manda solo las 2 accionables', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montarTramites(page);
    const cuerpos: unknown[] = [];
    await page.route(/\/api\/flito\/tramites\/entregar$/, (route) => {
      cuerpos.push(route.request().postDataJSON());
      return json(route, { entregados: 2, noHabilitados: [] });
    });

    await page.goto('/flito/tramites');
    // Lo que mata el `disabled` heredado: si volviera, este `check()` fallaría por elemento inerte.
    await expect(page.getByLabel('Seleccionar DEF456')).toBeEnabled();
    await casillaCabecera(page).check();
    await expect(page.getByText('3 seleccionado(s)')).toBeVisible();

    await expect(page.getByRole('button', { name: 'Entregar (2 de 3)' })).toBeVisible();
    await expect(page.getByText(/De las 3 filas marcadas, 2 están Asignadas/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Descargar soportes (3)' })).toBeVisible();

    await page.getByRole('button', { name: 'Entregar (2 de 3)' }).click();
    await expect.poll(() => cuerpos.length).toBe(1);
    expect(cuerpos[0]).toEqual({
      tramiteIds: [TRAMITES[0].tramiteId, TRAMITES[1].tramiteId],
    });
  });

  test('/flito/tramites — el viejo «Descargar facturas (zip)» ya no existe', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montarTramites(page);
    await page.goto('/flito/tramites');
    await marcar(page, 'ABC123');

    // Dos caminos al mismo ZIP serían dos verdades, y la vieja miente en cuanto hay tres tipos.
    await expect(page.getByRole('button', { name: 'Descargar facturas (zip)' })).toHaveCount(0);
    await expect(botonZip(page)).toHaveCount(1);
  });
});

// ═══════════════════════════ AC3 — el diálogo decide, no decora ═════════════════════════════════

test.describe('HU #11910 — AC3: el diálogo de tipos', () => {
  test('/flito/impuestos — se abre con todas marcadas y manda SOLO lo elegido', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montarImpuestos(page);
    const zip = await mockZip(page, P_IMPUESTOS);

    await page.goto('/flito/impuestos');
    await marcar(page, 'ABC123', 'XYZ789');
    await botonZip(page).click();

    await expect(dialogo(page)).toBeVisible();
    await expect(page.getByText('Qué se descarga de las 2 filas marcadas')).toBeVisible();
    const facturaVenta = dialogo(page).getByRole('checkbox', { name: /Factura de venta/ });
    const recibo = dialogo(page).getByRole('checkbox', { name: /Recibo del impuesto/ });
    await expect(facturaVenta).toBeChecked();
    await expect(recibo).toBeChecked();

    // Se desmarca uno: si el diálogo fuera decorativo, el cuerpo llevaría los dos igual.
    await recibo.uncheck();
    const [descarga] = await Promise.all([
      page.waitForEvent('download'),
      confirmarZip(page).click(),
    ]);

    expect(zip.peticiones).toHaveLength(1);
    expect(zip.peticiones[0].metodo).toBe('POST');
    expect(zip.peticiones[0].cuerpo).toEqual({ ids: ['i1', 'i2'], tipos: ['factura_venta'] });
    // **Nada en el query string** (AGENTS.md §14): los ids viajan en el cuerpo y no hay variante GET.
    expect(zip.peticiones[0].search).toBe('');
    expect(descarga.suggestedFilename()).toBe(NOMBRE_ZIP);
    // El diálogo se cierra al confirmar: el trabajo se ve en el botón y en la banda, no reteniendo
    // la pantalla mientras el servidor comprime 100 PDF.
    await expect(dialogo(page)).toHaveCount(0);
  });

  test('/flito/impuestos — sin ningún tipo, «Descargar» se apaga y dice por qué', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montarImpuestos(page);
    const zip = await mockZip(page, P_IMPUESTOS);

    await page.goto('/flito/impuestos');
    await marcar(page, 'ABC123');
    await botonZip(page).click();

    for (const nombre of [/Factura de venta/, /Recibo del impuesto/]) {
      await dialogo(page).getByRole('checkbox', { name: nombre }).uncheck();
    }
    // Un `disabled` no dice por qué lo está, y por eso el motivo va en una región anunciada.
    await expect(confirmarZip(page)).toBeDisabled();
    await expect(page.getByText('Elige al menos un tipo de documento.')).toBeVisible();
    // No se cierra y no se manda nada.
    await expect(dialogo(page)).toBeVisible();
    expect(zip.peticiones).toHaveLength(0);
  });

  /** *Mutante:* abrir diálogo también en SOAT «por consistencia» — un clic que no decide nada. */
  test('/flito/soat — un solo tipo: el clic descarga, sin diálogo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montarSoat(page);
    const zip = await mockZip(page, P_SOAT);

    await page.goto('/flito/soat');
    await marcar(page, 'XYZ789');
    await expect(page.getByText('Se descargan los comprobantes de pago cargados en las filas marcadas.'))
      .toBeVisible();

    const [descarga] = await Promise.all([
      page.waitForEvent('download'),
      botonZip(page).click(),
    ]);

    await expect(dialogo(page)).toHaveCount(0);
    expect(zip.peticiones).toHaveLength(1);
    // **Sin `tipos`**: el esquema de ese endpoint es `z.object({ ids }).strict()`, así que mandarle
    // un `tipos` de cortesía sería un 400. Un solo tipo posible = nada que elegir.
    expect(zip.peticiones[0].cuerpo).toEqual({ ids: ['s2'] });
    expect(descarga.suggestedFilename()).toBe(NOMBRE_ZIP);
  });

  test('/flito/tramites — tres tipos, «Factura de venta» premarcada y una nota de transición', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montarTramites(page);
    const zip = await mockZip(page, P_TRAMITES);

    await page.goto('/flito/tramites');
    await marcar(page, 'DEF456');
    await botonZip(page).click();

    // Confirmar sin leer produce AL MENOS lo que producía el botón viejo.
    await expect(dialogo(page).getByRole('checkbox', { name: /Factura de venta/ })).toBeChecked();
    await expect(page.getByText('Antes este botón traía solo las facturas de venta. Ahora eliges qué documentos entran.'))
      .toBeVisible();

    await Promise.all([page.waitForEvent('download'), confirmarZip(page).click()]);
    expect(zip.peticiones[0].cuerpo).toEqual({
      ids: [TRAMITES[2].tramiteId],
      tipos: ['factura_venta', 'recibo_impuesto', 'factura_soat'],
    });
  });
});

// ══════════════════════════════ AC6 — no hay ZIP vacío en silencio ══════════════════════════════

test.describe('HU #11910 — AC6 y el caso parcial', () => {
  /**
   * *Mutantes:* entregar un ZIP de 0 bytes (habría descarga y `creados` ≥ 1); ofrecer reintento
   * (el último aserto cae).
   */
  test('/flito/impuestos — 409 `zip_sin_soportes`: nada se descarga, se avisa y no se ofrece reintento', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await instrumentarObjectUrls(page);
    await montarImpuestos(page);
    await mockZip(page, P_IMPUESTOS, {
      status: 409,
      contentType: 'application/json',
      headers: {},
      // El texto y el `codigo` tal y como los escribe `ZipSinSoportesError`. La pantalla decide por
      // el CÓDIGO y hace eco del texto: dos frases distintas no cambiarían ninguna decisión.
      body: JSON.stringify({
        error: 'Ninguno de los registros seleccionados tiene el documento que pediste. '
          + 'Revisa la selección o el tipo de documento y vuelve a intentarlo.',
        codigo: 'zip_sin_soportes',
      }),
    });

    await page.goto('/flito/impuestos');
    await marcar(page, 'ABC123', 'XYZ789');
    await botonZip(page).click();
    await dialogo(page).getByRole('checkbox', { name: /Factura de venta/ }).uncheck();
    await confirmarZip(page).click();

    await expect(page.getByRole('alert')).toContainText(
      'Ninguno de los registros seleccionados tiene el documento que pediste.',
    );
    // **No se creó ningún object URL**: no hubo archivo, ni de 0 bytes ni con el JSON dentro.
    expect((await leerUrls(page)).creados).toHaveLength(0);
    // Repetir da lo mismo; lo que hay que cambiar es la selección o el tipo.
    await expect(page.getByRole('button', { name: 'Reintentar la descarga' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cerrar el aviso' })).toBeVisible();
  });

  /**
   * *Mutante:* banda de éxito genérica sin cifras — verde hoy, y el día que falten 3 documentos
   * nadie se entera. Es la trampa del «Excel truncado» que la #11909 prohibió.
   */
  test('/flito/soat — parcial: se descarga, y el aviso trae las cifras', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montarSoat(page);
    await mockZip(page, P_SOAT, {
      status: 200,
      headers: {
        'content-disposition': `attachment; filename="${NOMBRE_ZIP}"`,
        // En SOAT las dos cifras coinciden —un SOAT aporta un documento—, así que aquí van iguales
        // a propósito: este caso NO puede distinguir cuál de las dos lee la pantalla. Quien lo
        // distingue es el de Trámites, justo debajo.
        'x-soportes-incluidos': '1',
        'x-soportes-registros': '1',
      },
    });

    await page.goto('/flito/soat');
    await casillaCabecera(page).check();
    await Promise.all([page.waitForEvent('download'), botonZip(page).click()]);

    await expect(bandaZip(
      page,
      `ZIP descargado: ${NOMBRE_ZIP} — 1 de las 3 filas marcadas tenían comprobante del SOAT; las otras 2 no.`,
    )).toBeVisible();
  });

  /**
   * **El caso que decide CUÁL de las dos cabeceras se lee**, y el único sitio donde se puede decidir.
   *
   * `X-Soportes-Incluidos` cuenta DOCUMENTOS y `X-Soportes-Registros` cuenta filas que aportaron
   * alguno. Un trámite aporta hasta tres documentos, así que aquí 5 marcadas dan 6 documentos de 3
   * filas. La frase habla de «filas marcadas», o sea que el número tiene que ser 3.
   *
   * *Mutante:* leer `incluidos` — el aviso diría **«6 de las 5 filas marcadas»**, una cifra falsa con
   * aspecto de cierta. En SOAT y en Impuestos ese mutante sobrevive; solo cae aquí.
   */
  test('/flito/tramites — el aviso cuenta REGISTROS, no documentos: nunca «6 de 5»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montarTramites(page, CINCO_TRAMITES);
    await mockZip(page, P_TRAMITES, {
      status: 200,
      headers: {
        'content-disposition': `attachment; filename="${NOMBRE_ZIP}"`,
        'x-soportes-incluidos': '6',
        'x-soportes-registros': '3',
      },
    });

    await page.goto('/flito/tramites');
    await casillaCabecera(page).check();
    await expect(page.getByText('5 seleccionado(s)')).toBeVisible();
    await botonZip(page).click();
    await Promise.all([page.waitForEvent('download'), confirmarZip(page).click()]);

    await expect(bandaZip(
      page,
      `ZIP descargado: ${NOMBRE_ZIP} — 3 de las 5 filas marcadas tenían los documentos que `
      + 'elegiste; las otras 2 no.',
    )).toBeVisible();
    await expect(page.getByText(/6 de las 5/)).toHaveCount(0);
  });

  test('/flito/soat — completo: el aviso NO inventa cifras que el servidor no declaró', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montarSoat(page);
    await mockZip(page, P_SOAT);

    await page.goto('/flito/soat');
    await marcar(page, 'ABC123');
    await Promise.all([page.waitForEvent('download'), botonZip(page).click()]);

    await expect(bandaZip(page, `ZIP descargado: ${NOMBRE_ZIP}`)).toBeVisible();
    await expect(page.getByText(/filas marcadas tenían/)).toHaveCount(0);
  });

  /**
   * **El tope de CANTIDAD se ataja antes de la petición.** Marcar 101 con «seleccionar todo» es lo
   * más fácil de hacer sin querer en esta tabla, y el viaje solo serviría para traer de vuelta un
   * número que ya está publicado en `shared-types`.
   *
   * *Mutantes:* quitar la guarda del hook (`peticiones` pasaría a 1); ofrecer reintento (repetir la
   * misma selección da lo mismo).
   */
  test('/flito/soat — 101 marcadas: se avisa SIN gastar la petición, y sin reintento', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montarSoat(page, SOBRE_EL_TOPE);
    const zip = await mockZip(page, P_SOAT);

    await page.goto('/flito/soat');
    await casillaCabecera(page).check();
    await expect(page.getByText(`${ZIP_SOPORTES_MAX_REGISTROS + 1} seleccionado(s)`)).toBeVisible();
    await botonZip(page).click();

    await expect(page.getByRole('alert')).toContainText(
      `Solo se pueden descargar los documentos de ${ZIP_SOPORTES_MAX_REGISTROS} registros a la vez.`,
    );
    expect(zip.peticiones).toHaveLength(0);
    await expect(page.getByRole('button', { name: 'Reintentar la descarga' })).toHaveCount(0);
  });

  /**
   * Los dos topes son casos distintos con salidas distintas, y el copy tiene que decirlo: el de PESO
   * se choca con tres filas si sus documentos son enormes, así que «marca menos filas» sería mandar a
   * probar a ciegas.
   *
   * *Mutante:* fundir las dos ramas en `avisoDeZip` — el texto del servidor se seguiría haciendo eco
   * y este test pasaría, pero el respaldo del cliente sería el mismo para los dos. Por eso el segundo
   * aserto va sobre el 400 CON código y SIN texto, que es donde manda el respaldo.
   */
  test('/flito/impuestos — peso y cantidad no se confunden: 422 y 400 dicen cosas distintas', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montarImpuestos(page);
    const zip = await mockZip(page, P_IMPUESTOS, {
      status: 422,
      contentType: 'application/json',
      headers: {},
      body: JSON.stringify({
        error: 'Los documentos seleccionados pesan más de los 50 MB que admite una descarga. '
          + 'Quita de la selección los registros con documentos más pesados y vuelve a intentarlo.',
        codigo: 'zip_demasiado_grande',
      }),
    });

    await page.goto('/flito/impuestos');
    await marcar(page, 'ABC123');
    await botonZip(page).click();
    await confirmarZip(page).click();

    // PESO: la salida es quitar los pesados, y la cifra la pone el servidor (es una perilla de
    // entorno: cualquier número compilado en el cliente mentiría al mover la variable).
    await expect(page.getByRole('alert')).toContainText('pesan más de los 50 MB');
    await expect(page.getByRole('alert')).toContainText('Quita de la selección los registros con documentos más pesados');
    await expect(page.getByRole('alert')).not.toContainText('Marca menos filas');
    await expect(page.getByRole('button', { name: 'Reintentar la descarga' })).toHaveCount(0);

    // CANTIDAD, con el servidor por debajo del tope compilado (desajuste de versiones) y **sin
    // texto propio**: manda el respaldo del cliente, que es otro y dice otra cosa.
    zip.respuesta = {
      status: 400,
      contentType: 'application/json',
      headers: {},
      body: JSON.stringify({ codigo: 'zip_demasiados_registros' }),
    };
    await page.getByRole('button', { name: 'Cerrar el aviso' }).click();
    await botonZip(page).click();
    await confirmarZip(page).click();

    await expect(page.getByRole('alert')).toContainText('Marca menos filas y vuelve a intentarlo.');
    await expect(page.getByRole('alert')).not.toContainText('pesan más');
  });

  test('/flito/soat — un nombre servido con forma de NIT no se propaga: se cae al respaldo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montarSoat(page);
    await mockZip(page, P_SOAT, {
      status: 200,
      // Un documento con forma de nombre de archivo. El guardia valida los COMPONENTES del sello.
      headers: { 'content-disposition': 'attachment; filename="soportes_900123456.zip"' },
    });

    await page.goto('/flito/soat');
    await marcar(page, 'ABC123');
    const [descarga] = await Promise.all([page.waitForEvent('download'), botonZip(page).click()]);

    expect(descarga.suggestedFilename()).toBe('soportes.zip');
    await expect(bandaZip(page, 'ZIP descargado: soportes.zip')).toBeVisible();
  });
});

// ══════════════════════════ El candado del doble clic y lo que NO cambia ════════════════════════

test.describe('HU #11910 — el candado y la selección', () => {
  /**
   * **Dos clics en el MISMO turno síncrono**, que es donde el `disabled` no puede ayudar: React lo
   * escribe en el commit siguiente al primero. `dblclick()` no serviría —entre sus dos clics hay
   * turnos de sobra— y dejaría pasar el mutante que quita la `ref`.
   */
  test('/flito/soat — dos clics síncronos = UNA sola petición', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montarSoat(page);
    const zip = await mockZip(page, P_SOAT);

    await page.goto('/flito/soat');
    await marcar(page, 'ABC123');
    await Promise.all([
      page.waitForEvent('download'),
      page.evaluate(() => {
        const boton = [...document.querySelectorAll('button')]
          .find((b) => /^Descargar soportes \(/.test(b.textContent ?? ''));
        boton?.click();
        boton?.click();
      }),
    ]);

    // Un ZIP de 100 PDF cuesta caro en el servidor: la segunda petición es trabajo real.
    expect(zip.peticiones).toHaveLength(1);
  });

  /**
   * *Mutante:* copiar el `limpiar()`/`refrescar()` de enviar y certificar «por simetría». Quien
   * descarga suele descargar dos veces seguidas, y perder 40 filas marcadas por haber pedido un ZIP
   * es caro y no lo pide ningún AC.
   */
  test('/flito/impuestos — tras descargar, la selección sigue marcada y la cola no se recargó', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montarImpuestos(page);
    await mockZip(page, P_IMPUESTOS);
    let colas = 0;
    page.on('request', (r) => { if (/\/api\/flito\/impuestos\?/.test(r.url())) colas += 1; });

    await page.goto('/flito/impuestos');
    await marcar(page, 'ABC123', 'XYZ789');
    await expect(page.getByText('2 seleccionado(s)')).toBeVisible();
    const antes = colas;

    await botonZip(page).click();
    await Promise.all([page.waitForEvent('download'), confirmarZip(page).click()]);
    await expect(bandaZip(page, `ZIP descargado: ${NOMBRE_ZIP}`)).toBeVisible();

    await expect(page.getByText('2 seleccionado(s)')).toBeVisible();
    await expect(botonZip(page)).toHaveText('Descargar soportes (2)');
    expect(colas).toBe(antes);
  });
});
