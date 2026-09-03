import JSZip from 'jszip';
import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER } from '../helpers/auth';

// HU #12056 — el navegador abre el ZIP y sus entradas viajan por las MISMAS tandas de 5.
//
// Hermano de `flito-soat-impuestos-carga-tandas.spec.ts` (HU #12051), que ya vigila el partir de 5
// en 5, la fusión y el fallo parcial. Aquí se vigila lo que esta HU añade y que NINGÚN otro sitio
// puede vigilar:
//
//   · de UN archivo elegido salen N POST de a 5 (antes salía uno solo con el ZIP dentro);
//   · cada tanda lleva `rutas` con un valor POR ARCHIVO, en el mismo orden. Esto es lo delicado:
//     si el emparejamiento se rompe el API NO falla —descarta la lista entera, responde 200 y
//     archiva todo con el defecto del checkbox—, así que un desajuste no se ve en pantalla ni en
//     el estado. El único sitio donde se puede ver es aquí, leyendo el multipart.
//   · el `filename` que viaja es el nombre BASE (multer no admite «/» en `originalname`);
//   · lo que el ZIP trae y no se puede procesar se le dice al operador ANTES de enviar;
//   · un ZIP que no abre no manda NADA;
//   · y el índice del ZIP —del que sale el conteo y la validación— es un DICHO: una entrada que
//     declara 1 KB y trae 200 MB se corta por presupuesto al descomprimirla, no se infla entera.

const FACETAS_SOAT = {
  companias: [{ id: 1, nombre: 'Concesionario Norte' }],
  organismos: [{ codigo: '17001', nombre: 'STT Manizales' }],
  proveedores: [{ id: 'p1', nombre: 'Seguros Alfa' }],
};

const FACETAS_IMP = {
  companias: [{ id: 1, nombre: 'Concesionario Norte' }],
  organismos: [{ codigo: '17001', nombre: 'STT Manizales' }],
};

const VACIO = { items: [], total: 0, page: 1, pageSize: 50 };

const OK_RECIBOS = { conciliados: [], enRevision: [], complementos: [], duplicados: [], noAsociados: [] };
const OK_SOAT = { pagados: [], enRevision: [], duplicados: [], noAsociados: [] };

/**
 * ZIP de verdad, comprimido en el proceso de test: el navegador lo abre con su propio JSZip.
 * `comprimir` solo hace falta cuando el contenido es grande — sin él JSZip guarda en STORE y el
 * buffer que hay que empujar al navegador pesaría lo mismo que su contenido.
 */
async function zipCon(entradas: Record<string, string>, comprimir = false): Promise<Buffer> {
  const zip = new JSZip();
  for (const [ruta, contenido] of Object.entries(entradas)) zip.file(ruta, contenido);
  return Buffer.from(await zip.generateAsync(
    comprimir
      ? { type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 1 } }
      : { type: 'nodebuffer' },
  ));
}

/**
 * 216 MB repartidos en 18 recibos: por encima de los 200 MB de `CARGA_MASIVA_MAX_BYTES_CRUDOS`.
 * Se arma una sola vez porque comprimirlo cuesta segundos, y el navegador no lo descomprime: le
 * basta el índice para contar y validar.
 */
let zipPesado: Promise<Buffer> | null = null;
function zipDe216MB(): Promise<Buffer> {
  if (!zipPesado) {
    const doce = 'x'.repeat(12 * 1024 * 1024);
    const entradas: Record<string, string> = {};
    for (let i = 1; i <= 18; i++) entradas[`SIN MARCA/recibo-${i}.pdf`] = doce;
    zipPesado = zipCon(entradas, true);
  }
  return zipPesado;
}

function archivoZip(nombre: string, buffer: Buffer) {
  return { name: nombre, mimeType: 'application/zip' as const, buffer };
}

/**
 * Reescribe el tamaño DESCOMPRIMIDO que una entrada declara en el **directorio central** del ZIP.
 * Es el único sitio del que JSZip lo saca (`readCentralPart`), y es un campo que escribe quien
 * fabrica el archivo: cualquiera puede poner ahí lo que quiera.
 *
 * Se recorre el directorio desde el EOCD, no buscando la firma por todo el búfer: la firma
 * `PK\x01\x02` aparece por casualidad dentro de datos comprimidos y parchear ahí sería parchear
 * basura. `compressedSize` NO se toca — es con ese con el que JSZip recorta los bytes de la
 * entrada, así que moverlo rompería el ZIP en vez de hacerlo mentir.
 */
function declararTamano(zip: Buffer, ruta: string, declarado: number): Buffer {
  const salida = Buffer.from(zip);
  let eocd = -1;
  for (let i = salida.length - 22; i >= 0 && eocd < 0; i--) {
    if (salida.readUInt32LE(i) === 0x0605_4b50 && i + 22 + salida.readUInt16LE(i + 20) === salida.length) eocd = i;
  }
  if (eocd < 0) throw new Error('el ZIP de la prueba no tiene EOCD');

  let p = salida.readUInt32LE(eocd + 16);
  let parcheadas = 0;
  for (let n = salida.readUInt16LE(eocd + 10); n > 0; n--) {
    if (salida.readUInt32LE(p) !== 0x0201_4b50) throw new Error('directorio central ilegible');
    const largoNombre = salida.readUInt16LE(p + 28);
    const nombre = salida.toString('utf8', p + 46, p + 46 + largoNombre);
    if (nombre === ruta) { salida.writeUInt32LE(declarado, p + 24); parcheadas++; }
    p += 46 + largoNombre + salida.readUInt16LE(p + 30) + salida.readUInt16LE(p + 32);
  }
  if (parcheadas !== 1) throw new Error(`se parchearon ${parcheadas} entradas «${ruta}», se esperaba 1`);
  return salida;
}

const MENTIROSO = 'SIN MARCA/mentiroso.pdf';

/**
 * El ZIP hostil: ocho entradas, y la sexta —la primera de la tanda 2— trae 200 MB reales de
 * deflate a ~1000:1 mientras su índice declara 1 KB. Es el archivo con el que el `security-agent`
 * midió el agujero: `tamanoDeclarado` devuelve 1024, `validarCargaMasiva` la deja pasar y la
 * descompresión se come 200 MB en la pestaña del operador.
 *
 * Se arma una sola vez: comprimir 200 MB cuesta segundos y el resultado son ~200 KB.
 */
let zipHostil: Promise<Buffer> | null = null;
function zipMentirosoDe200MB(): Promise<Buffer> {
  if (!zipHostil) {
    zipHostil = (async () => {
      const zip = new JSZip();
      for (let i = 1; i <= 5; i++) zip.file(`SIN MARCA/recibo-${i}.pdf`, `%PDF-1.4 recibo ${i}`);
      zip.file(MENTIROSO, Buffer.alloc(200 * 1024 * 1024));
      for (let i = 6; i <= 7; i++) zip.file(`SIN MARCA/recibo-${i}.pdf`, `%PDF-1.4 recibo ${i}`);
      const crudo = Buffer.from(await zip.generateAsync({
        type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 1 },
      }));
      return declararTamano(crudo, MENTIROSO, 1024);
    })();
  }
  return zipHostil;
}

/**
 * `archivos` (por su `filename`) y `rutas` (por su valor), CADA UNO EN SU ORDEN DE APARICIÓN en el
 * cuerpo multipart. Emparejarlos por índice es exactamente lo que hace multer al otro lado.
 */
function multipart(postData: string | null): { archivos: string[]; rutas: string[]; sinMarca: string } {
  const cuerpo = postData ?? '';
  const archivos = [...cuerpo.matchAll(/name="archivos";\s*filename="([^"]*)"/g)].map((m) => m[1]);
  // `([^\r\n]*)` con `*`, no `+`: el valor de un archivo suelto es la cadena VACÍA y tiene que
  // contarse como un valor más, no desaparecer del array. Si desapareciera, este helper mentiría
  // justo en el caso que más duele: la cardinalidad.
  const rutas = [...cuerpo.matchAll(/name="rutas"\r?\n\r?\n([^\r\n]*)/g)].map((m) => m[1]);
  const sinMarca = /name="sinMarcaDeAgua"\r?\n\r?\n([^\r\n]*)/.exec(cuerpo)?.[1] ?? '';
  return { archivos, rutas, sinMarca };
}

async function mockSoat(page: import('@playwright/test').Page) {
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));
  await page.route(/\/api\/flito\/soat\/facetas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FACETAS_SOAT) }));
  await page.route(/\/api\/flito\/soat\?/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(VACIO) }));
}

async function mockImpuestos(page: import('@playwright/test').Page) {
  await page.route(/\/api\/flito\/impuestos\/facetas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FACETAS_IMP) }));
  await page.route(/\/api\/flito\/impuestos\?/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(VACIO) }));
}

async function abrirModalImpuestos(page: import('@playwright/test').Page) {
  await loginAs(page, OPERACIONES_USER);
  await mockImpuestos(page);
  await page.goto('/flito/impuestos');
  await page.getByRole('button', { name: 'Cargar recibos (masivo)' }).click();
  return page.getByRole('dialog');
}

// 12 recibos repartidos en dos carpetas: la carpeta es lo que el API lee para decidir si la copia
// lleva marca de agua, así que la ruta de cada uno tiene que llegar pegada a SU archivo.
const DOCE_RECIBOS: Record<string, string> = {};
for (let i = 1; i <= 12; i++) {
  const carpeta = i % 2 === 0 ? 'CON MARCA' : 'SIN MARCA';
  DOCE_RECIBOS[`${carpeta}/recibo-${i}.pdf`] = `%PDF-1.4 recibo ${i}`;
}
const RUTAS_ESPERADAS = Object.keys(DOCE_RECIBOS);

test.describe('HU #12056 — el ZIP se abre en el navegador', () => {
  test('Impuestos: UN ZIP de 12 recibos sale en 3 POST de 5, 5 y 2', async ({ page }) => {
    const modal = await abrirModalImpuestos(page);
    const tandas: ReturnType<typeof multipart>[] = [];
    await page.route(/\/api\/flito\/impuestos\/recibos$/, async (route) => {
      tandas.push(multipart(route.request().postData()));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OK_RECIBOS) });
    });

    await modal.locator('input[type="file"]').setInputFiles([archivoZip('agosto.zip', await zipCon(DOCE_RECIBOS))]);
    await expect(modal.getByText(/^12 archivos de «agosto\.zip» · /)).toBeVisible();
    await modal.getByRole('button', { name: 'Subir y procesar' }).click();
    await expect(modal.getByRole('button', { name: 'Listo' })).toBeVisible();

    expect(tandas.map((t) => t.archivos.length)).toEqual([5, 5, 2]);
  });

  test('Impuestos: cada tanda lleva una ruta POR ARCHIVO, en el mismo orden y con la misma cardinalidad', async ({ page }) => {
    const modal = await abrirModalImpuestos(page);
    const tandas: ReturnType<typeof multipart>[] = [];
    await page.route(/\/api\/flito\/impuestos\/recibos$/, async (route) => {
      tandas.push(multipart(route.request().postData()));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OK_RECIBOS) });
    });

    await modal.locator('input[type="file"]').setInputFiles([archivoZip('agosto.zip', await zipCon(DOCE_RECIBOS))]);
    await modal.getByRole('button', { name: 'Subir y procesar' }).click();
    await expect(modal.getByRole('button', { name: 'Listo' })).toBeVisible();

    for (const tanda of tandas) {
      // Cardinalidad: el API descarta la lista ENTERA si no cuadra, y lo hace con un 200.
      expect(tanda.rutas).toHaveLength(tanda.archivos.length);
      for (const [i, ruta] of tanda.rutas.entries()) {
        // La ruta de la posición i tiene que ser la del archivo de la posición i, no la de otro.
        expect(ruta).toBe(`${ruta.split('/')[0]}/${tanda.archivos[i]}`);
        // Y su carpeta es la que decide la marca de agua: recibo par → CON MARCA, impar → SIN MARCA.
        const n = Number(/recibo-(\d+)\.pdf$/.exec(tanda.archivos[i])![1]);
        expect(ruta.split('/')[0]).toBe(n % 2 === 0 ? 'CON MARCA' : 'SIN MARCA');
      }
      // El `filename` que ve multer es el nombre BASE: un originalname con «/» no es válido.
      for (const nombre of tanda.archivos) expect(nombre).not.toContain('/');
    }
    expect(tandas.flatMap((t) => t.rutas)).toEqual(RUTAS_ESPERADAS);
  });

  // AC3 — el checkbox es el defecto de lo que NO trae carpeta, y un suelto no trae carpeta.
  test('Impuestos: en selección mixta el suelto manda ruta VACÍA, no su nombre', async ({ page }) => {
    const modal = await abrirModalImpuestos(page);
    const tandas: ReturnType<typeof multipart>[] = [];
    await page.route(/\/api\/flito\/impuestos\/recibos$/, async (route) => {
      tandas.push(multipart(route.request().postData()));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OK_RECIBOS) });
    });

    const zip = await zipCon({
      'SIN MARCA/recibo-1.pdf': '%PDF-1.4 uno', 'SIN MARCA/recibo-2.pdf': '%PDF-1.4 dos',
      'SIN MARCA/recibo-3.pdf': '%PDF-1.4 tres', 'SIN MARCA/recibo-4.pdf': '%PDF-1.4 cuatro',
    });
    await modal.getByRole('checkbox', { name: /sin marca de agua/i }).check();
    // «pagado.pdf» es un nombre corriente de recibo y casa con la regex /pagad/ de
    // `esSinMarcaDeAgua`. Si su nombre viajara como ruta, el API lo archivaría CON marca de agua
    // pese al checkbox: 200, sin error, y el comprobante en la carpeta equivocada.
    await modal.locator('input[type="file"]').setInputFiles([
      archivoZip('agosto.zip', zip),
      { name: 'pagado.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 suelto') },
      { name: 'otro.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 otro') },
    ]);

    // Tercera forma del contador: total, y entre paréntesis lo que puso el ZIP.
    await expect(modal.getByText(/^6 archivos \(4 de «agosto\.zip»\) · /)).toBeVisible();
    await modal.getByRole('button', { name: 'Subir y procesar' }).click();
    await expect(modal.getByRole('button', { name: 'Listo' })).toBeVisible();

    // Tanda 1 mixta (4 del ZIP + 1 suelto) y tanda 2 con SOLO el suelto: en las dos, un valor de
    // `rutas` por archivo. Omitir el del suelto haría que el API descartase la lista ENTERA y
    // perdiera también la carpeta de los cuatro del ZIP.
    expect(tandas.map((t) => t.archivos.length)).toEqual([5, 1]);
    for (const tanda of tandas) expect(tanda.rutas).toHaveLength(tanda.archivos.length);

    expect(tandas[0].rutas).toEqual([
      'SIN MARCA/recibo-1.pdf', 'SIN MARCA/recibo-2.pdf',
      'SIN MARCA/recibo-3.pdf', 'SIN MARCA/recibo-4.pdf',
      '', // ← pagado.pdf: sin carpeta que declarar, decide el checkbox
    ]);
    expect(tandas[1].rutas).toEqual(['']);

    // Lo que persiste el recibo suelto: `esSinMarcaDeAgua('', true) === true` (ninguna regex casa,
    // cae al defecto), así que con el checkbox encendido se archiva SIN marca de agua.
    expect(tandas.every((t) => t.sinMarca === 'true')).toBe(true);
    expect(tandas.flatMap((t) => t.rutas)).not.toContain('pagado.pdf');
  });

  test('SOAT: el mismo ZIP sale en tandas y SIN el campo rutas', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockSoat(page);
    const tandas: ReturnType<typeof multipart>[] = [];
    await page.route(/\/api\/flito\/soat\/facturas$/, async (route) => {
      tandas.push(multipart(route.request().postData()));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OK_SOAT) });
    });

    await page.goto('/flito/soat');
    await page.getByRole('button', { name: 'Cargar facturas (masivo)' }).click();
    const modal = page.getByRole('dialog');
    await modal.locator('input[type="file"]').setInputFiles([archivoZip('agosto.zip', await zipCon(DOCE_RECIBOS))]);
    await modal.getByRole('button', { name: 'Subir y procesar' }).click();
    await expect(modal.getByRole('button', { name: 'Listo' })).toBeVisible();

    expect(tandas.map((t) => t.archivos.length)).toEqual([5, 5, 2]);
    // SOAT no lee `req.body`: mandar rutas ahí sería peso muerto en cada una de las tandas.
    expect(tandas.flatMap((t) => t.rutas)).toEqual([]);
  });

  test('Impuestos: el ruido del ZIP no se cuenta y lo no procesable se avisa antes de enviar', async ({ page }) => {
    const modal = await abrirModalImpuestos(page);
    const posts: string[] = [];
    await page.route(/\/api\/flito\/impuestos\/recibos$/, async (route) => {
      posts.push(...multipart(route.request().postData()).archivos);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OK_RECIBOS) });
    });

    const buffer = await zipCon({
      'SIN MARCA/recibo-1.pdf': '%PDF-1.4 uno',
      'SIN MARCA/recibo-2.png': 'png',
      '__MACOSX/SIN MARCA/._recibo-1.pdf': 'basura de macOS',
      '.DS_Store': 'basura de macOS',
      'notas.txt': 'texto',
      'lista.docx': 'documento',
    });
    await modal.locator('input[type="file"]').setInputFiles([archivoZip('agosto.zip', buffer)]);

    // Se cuentan 2, no 6: carpetas, `__MACOSX/` y ocultos no son documentos y no se mencionan.
    await expect(modal.getByText(/^2 archivos de «agosto\.zip» · /)).toBeVisible();
    await expect(modal.getByText(
      'Del ZIP se ignoraron 2 archivos que no son PDF ni imagen: «notas.txt», «lista.docx».',
    )).toBeVisible();
    await expect(modal.getByText(/MACOSX|DS_Store/)).toHaveCount(0);

    await modal.getByRole('button', { name: 'Subir y procesar' }).click();
    await expect(modal.getByRole('button', { name: 'Listo' })).toBeVisible();
    expect(posts).toEqual(['recibo-1.pdf', 'recibo-2.png']);
  });

  test('Impuestos: un ZIP que no abre no manda ninguna tanda', async ({ page }) => {
    const modal = await abrirModalImpuestos(page);
    await page.route(/\/api\/flito\/impuestos\/recibos$/, async () => {
      throw new Error('no debía salir ningún POST');
    });

    await modal.locator('input[type="file"]').setInputFiles([
      { name: 'roto.zip', mimeType: 'application/zip', buffer: Buffer.from('esto no es un ZIP') },
    ]);

    await expect(modal.getByRole('alert')).toHaveText(
      'No se pudo abrir «roto.zip»: está dañado o no es un ZIP. Vuelve a comprimirlo y elígelo otra vez.',
    );
    await expect(modal.getByRole('button', { name: 'Subir y procesar' })).toBeDisabled();
    await expect(modal.getByText(/de 250 MB/)).toHaveCount(0);
  });

  test('Impuestos: un ZIP sin PDF ni imágenes no manda ninguna tanda', async ({ page }) => {
    const modal = await abrirModalImpuestos(page);
    await page.route(/\/api\/flito\/impuestos\/recibos$/, async () => {
      throw new Error('no debía salir ningún POST');
    });

    await modal.locator('input[type="file"]').setInputFiles([
      archivoZip('vacio.zip', await zipCon({ 'notas.txt': 'texto', '.DS_Store': 'basura' })),
    ]);

    await expect(modal.getByRole('alert')).toHaveText(
      '«vacio.zip» no trae PDF ni imágenes. Revisa el ZIP o elige los archivos sueltos.',
    );
    await expect(modal.getByRole('button', { name: 'Subir y procesar' })).toBeDisabled();
  });

  test('Impuestos: los 15 MB se miden contra cada entrada, no contra el ZIP', async ({ page }) => {
    const modal = await abrirModalImpuestos(page);
    await page.route(/\/api\/flito\/impuestos\/recibos$/, async () => {
      throw new Error('no debía salir ningún POST');
    });

    // Un ZIP cuyo CONTENIDO pesa 18 MB comprimidos a casi nada: como archivo pasaría los 15 MB de
    // largo, y ese era justamente el bloqueo que esta HU vino a quitar. Lo que se mide es la entrada.
    const grande = 'x'.repeat(18 * 1024 * 1024);
    await modal.locator('input[type="file"]').setInputFiles([
      archivoZip('agosto.zip', await zipCon({ 'SIN MARCA/gordo.pdf': grande, 'SIN MARCA/ok.pdf': '%PDF-1.4' })),
    ]);

    await expect(modal.getByRole('alert')).toContainText(
      '«SIN MARCA/gordo.pdf», dentro de «agosto.zip», pesa 18.0 MB y el máximo por archivo son 15 MB',
    );
    // Y no se salta la entrada gorda para subir el resto: se bloquea la carga entera.
    await expect(modal.getByRole('button', { name: 'Subir y procesar' })).toBeDisabled();
  });

  test('Impuestos: 216 MB dentro de un ZIP no bloquean la carga', async ({ page }) => {
    const modal = await abrirModalImpuestos(page);
    await page.route(/\/api\/flito\/impuestos\/recibos$/, async () => {
      throw new Error('este caso no envía nada');
    });

    // Los 200 MB de CARGA_MASIVA_MAX_BYTES_CRUDOS eran la pared de cuando todo iba en UNA
    // petición. Con tandas ninguna pasa de 5 × 15 = 75 MB, así que un ZIP no se bloquea por su
    // suma: su techo son las 300 entradas y los 15 MB de cada una. Bloquearlo aquí sería pedir
    // «quite archivos» sobre un ZIP, que es justo el trabajo que esta HU vino a quitar.
    await modal.locator('input[type="file"]').setInputFiles([archivoZip('agosto.zip', await zipDe216MB())]);

    await expect(modal.getByText('18 archivos de «agosto.zip» · 216.0 MB de 250 MB')).toBeVisible();
    await expect(modal.getByRole('alert')).toHaveCount(0);
    await expect(modal.getByRole('button', { name: 'Subir y procesar' })).toBeEnabled();
  });

  test('Impuestos: el progreso cuenta archivos, no tandas', async ({ page }) => {
    const modal = await abrirModalImpuestos(page);
    let posts = 0;
    let release!: () => void;
    const retenida = new Promise<void>((r) => { release = r; });
    await page.route(/\/api\/flito\/impuestos\/recibos$/, async (route) => {
      posts += 1;
      if (posts === 1) await retenida;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OK_RECIBOS) });
    });

    const entradas: Record<string, string> = {};
    for (let i = 1; i <= 20; i++) entradas[`SIN MARCA/recibo-${i}.pdf`] = `%PDF-1.4 recibo ${i}`;
    await modal.locator('input[type="file"]').setInputFiles([archivoZip('agosto.zip', await zipCon(entradas))]);
    await modal.getByRole('button', { name: 'Subir y procesar' }).click();

    // 20 archivos son 4 tandas: «tanda 1 de 4» obligaría a multiplicar por 5 para saber por dónde va.
    await expect(modal.getByText('enviando 1 de 20 archivos')).toBeVisible();
    await expect(modal.getByText(/tanda/i)).toHaveCount(0);
    release();
    await expect(modal.getByRole('button', { name: 'Listo' })).toBeVisible();
    expect(posts).toBe(4);
  });

  /**
   * El agujero que cerró el code-review: el índice del ZIP decide qué entra en los 15 MB, y ese
   * índice lo escribe quien fabrica el archivo. Medido por el `security-agent` contra este mismo
   * jszip 3.10.1: una entrada de 400 MB reales que declara 1024 bytes pasa la validación y, al
   * tocarle su tanda, se infla ENTERA — 419 430 400 bytes, RSS 81 → 497 MB, 1,75 s de event loop
   * bloqueado— hasta que JSZip se queja del desajuste. Con la pestaña congelada el operador no
   * tiene nada que hacer salvo esperar a que Chrome la mate.
   *
   * Este test no comprueba un camino feliz: comprueba qué hace la carga con un archivo HOSTIL.
   * Su discriminante es el copy del corte, porque es el único observable que separa las dos
   * historias posibles — cortar en 15 MB, o inflar 200 MB y que JSZip lo note al final (que sale
   * por `fraseEntradaIlegible`, «No se pudo leer …»).
   */
  test('Impuestos: una entrada que miente en el índice se corta por presupuesto, no se infla entera', async ({ page }) => {
    // Fabricar los 200 MB de deflate cuesta ~5 s en el proceso de test, y el resto del caso corre
    // en lo de siempre. Los 30 s del config no dan margen para eso.
    test.setTimeout(60_000);
    const modal = await abrirModalImpuestos(page);
    let posts = 0;
    await page.route(/\/api\/flito\/impuestos\/recibos$/, async (route) => {
      posts += 1;
      if (posts > 1) throw new Error('la tanda 2 no debía llegar a salir');
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...OK_RECIBOS, conciliados: [{ archivo: 'recibo-1.pdf', detalle: 'placa de la tanda 1' }],
        }),
      });
    });

    await modal.locator('input[type="file"]').setInputFiles([
      archivoZip('hostil.zip', await zipMentirosoDe200MB()),
    ]);

    // Premisa del hallazgo, y por eso se afirma en vez de darse por supuesta: la SELECCIÓN se lo
    // cree. Ocho archivos, peso ridículo, primaria viva y ni una frase de tope, porque los 15 MB
    // se midieron contra el 1 KB que la entrada declara. Eso está bien —es lo que hace barata la
    // selección—; lo que no puede pasar es que la descompresión herede esa credulidad.
    await expect(modal.getByText('8 archivos de «hostil.zip» · 0.0 MB de 250 MB')).toBeVisible();
    await expect(modal.getByRole('alert')).toHaveCount(0);
    await expect(modal.getByRole('button', { name: 'Subir y procesar' })).toBeEnabled();

    await modal.getByRole('button', { name: 'Subir y procesar' }).click();

    // El corte. Nombra el archivo y dice que el ZIP no es de fiar: no es «ilegible», es que trajo
    // otra cosa de la que declaró.
    await expect(modal.getByRole('alert')).toHaveText(
      '«SIN MARCA/mentiroso.pdf», dentro de «hostil.zip», trae más de 15 MB descomprimido y el índice '
      + 'del ZIP no lo declaraba así. FLITO paró de descomprimirlo ahí: ese ZIP no es de fiar. Vuelve '
      + 'a comprimirlo y elígelo otra vez, o sube los archivos sueltos.',
    );
    // Ni el mensaje crudo de JSZip ni el copy del «no se pudo leer»: los dos significarían que la
    // entrada se infló hasta el final antes de que nadie la parara.
    await expect(modal.getByText(/uncompressed data size mismatch/i)).toHaveCount(0);
    await expect(modal.getByText(/No se pudo leer/)).toHaveCount(0);

    // AC6: revienta a mitad de las tandas y se comporta como cualquier otro fallo parcial — lo de
    // la tanda 1 queda, la tanda 2 ni se llega a armar y el operador cierra con Listo.
    await expect(modal.getByText('Conciliados 1')).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Listo' })).toBeVisible();
    expect(posts).toBe(1);
  });
});
