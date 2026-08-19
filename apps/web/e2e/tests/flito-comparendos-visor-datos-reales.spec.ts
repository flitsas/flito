// FLITO — Comparendos · visor contra el STACK REAL (HU #11560, modo B).
//
// Todo lo demás del módulo se prueba con mocks, y está bien: un mock es la única forma de fijar la
// respuesta rara. Pero un mock no puede desmentir a la implementación sobre la FORMA de los datos
// —un cursor base64url de verdad, un `numeric(14,2)` de verdad, un `timestamptz` de verdad— porque
// el mock lo escribe la misma persona que escribió el código. Este archivo pide de verdad.
//
// Se apoya en el perfil sembrado en el entorno local (125 comparendos):
//   · 125 en total → páginas 50 / 50 / 25 (última página PARCIAL);
//   · `fuente=municipal` con exactamente 100 → última página LLENA con `nextCursor: null`, que es
//     la otra forma del fin de lista y donde vive el off-by-one del `LIMIT n+1`;
//   · el NIT 900123456 con 60 → dos páginas por `POST /registros/buscar`;
//   · 10 inactivos, y entre ellos las filas-borde: `QA-0081` con monto `0.00`, `QA-0082` con
//     `232100.99`, `QA-0083` con `1234567.89`, `QA-0084` con descripción de más de 200 caracteres y
//     `QA-0085` con placa, monto, fecha y municipio en `null`;
//   · instantes a `03:12Z` y a `20:00Z`, que caen en días DISTINTOS en Bogotá.
//
// Dos avisos de operación:
//   1. `test` se importa de `@playwright/test` y NO del fixture del repo: ese fixture instala un
//      catch-all sobre `**/api/**` que responde `200 []`, y con él puesto ninguna petición llegaría
//      al 3005.
//   2. **Un solo login por corrida.** `authLimiter` deja **10 autenticaciones cada 15 minutos por
//      IP** (`apps/api/src/shared/middleware/rateLimiter.ts:39`), no 10 por test. La primera
//      versión de este archivo se autenticaba en cada test y a la segunda corrida seguida el
//      entorno devolvía `429 Demasiados intentos de autenticacion` — un fallo que parece del
//      producto y es del test. El token se pide UNA vez por worker y se reinyecta en cada página.
//   3. El limitador de LECTURA del módulo es de 60 peticiones por minuto y usuario, y aquí todos
//      los tests usan el mismo `admin`. Por eso este archivo tiene pocos tests y camina lo justo.
//   4. **Guardia de entorno.** Este archivo depende de un API vivo Y de un conjunto de datos
//      concreto. Sin la guardia, quien corriera `npx playwright test` sin ese entorno vería cuatro
//      rojos que no dicen nada del producto y perdería media hora antes de entender que le faltan
//      filas. El `beforeAll` comprueba las dos cosas y, si no están, **salta** con el motivo exacto
//      y el perfil que hay que sembrar. Un spec que solo pasa en una máquina y no lo dice es peor
//      que no tenerlo.
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

const USUARIO = 'admin';
const CLAVE = 'Admin2026!';
const NIT_SEMBRADO = '900123456';

/**
 * Origen del API para la guardia. El `beforeAll` no puede pedir el fixture `baseURL` —es de ámbito
 * de test— así que se declara aquí, con la misma dirección que `playwright.config.ts` levanta.
 * Se puede apuntar a otro entorno con `QA_API_BASE`.
 */
const API_BASE = process.env.QA_API_BASE ?? 'http://localhost:5175';

/** Filas-borde que el perfil tiene que traer. Sin ellas, tres de los cuatro tests no afirman nada. */
const FILAS_BORDE = ['QA-0081', 'QA-0082', 'QA-0083', 'QA-0084', 'QA-0085'];

/** Cómo se reproduce el entorno. Va en el mensaje del skip, no en un README que nadie abre. */
const COMO_SEMBRAR = [
  'Este spec necesita el API en ' + API_BASE + '/api y el perfil de QA de la HU #11560:',
  '  · 125 comparendos en total → páginas 50 / 50 / 25',
  '  · `fuente=municipal` con exactamente 100 (última página LLENA)',
  '  · el NIT 900123456 con 60 (dos páginas por POST /registros/buscar)',
  '  · 10 con estado `inactivo` y `inactivadoEn` no nulo, y entre ellos:',
  '      QA-0081 monto 0.00 · QA-0082 monto 232100.99 · QA-0083 monto 1234567.89',
  '      QA-0084 descripción de más de 200 caracteres',
  '      QA-0085 con placa, monto, fechaComparendo y municipioFuente en NULL',
  '  · instantes `primeraVistoEn` a 2026-08-17T03:12:00Z y 2026-08-17T20:00:00Z',
  '    (cruzan la medianoche de Bogotá en las dos direcciones)',
  'No hay script de siembra en el repo: `flito:seed` no toca comparendos. El conjunto lo sembró el',
  'Líder Técnico en el entorno local. Reprodúcelo con ese perfil o pídeselo antes de correr esto.',
].join('\n');

/** Token real, uno por worker. Ver el aviso 2 de la cabecera. */
let tokenReal: string | null = null;

/** Motivo por el que hay que saltar, o `null` si el entorno está. Lo calcula el `beforeAll`. */
let motivoSkip: string | null = null;

/**
 * Sesión de verdad: `POST /api/auth/login` y el token que devuelve el servidor.
 *
 * `loginAs` de los helpers no sirve aquí: mockea `/api/auth/me` y escribe `token: 'fake.jwt.e2e'`,
 * que contra el API real es un 401 en la primera consulta.
 */
async function loginReal(page: Page, request: APIRequestContext) {
  if (!tokenReal) {
    const r = await request.post('/api/auth/login', { data: { username: USUARIO, password: CLAVE } });
    expect(r.status(), `login real (429 = se agotó authLimiter: 10 / 15 min / IP)`).toBe(200);
    tokenReal = (await r.json()).token as string;
    expect(tokenReal, 'el login real devuelve un token').toBeTruthy();
  }
  // `addInitScript` corre antes que cualquier script de la página, así que la sesión ya está puesta
  // cuando `useAuth()` mira el `localStorage` en el primer render.
  await page.addInitScript((t) => window.localStorage.setItem('token', t), tokenReal);
}

/** Colector de TODAS las peticiones al módulo: URL, verbo, cuerpo y `Referer`. */
function colector(page: Page) {
  const peticiones: { metodo: string; url: string; cuerpo: string | null; referer: string }[] = [];
  page.on('request', (r) => {
    if (!r.url().includes('/api/flito/comparendos')) return;
    peticiones.push({
      metodo: r.method(), url: r.url(), cuerpo: r.postData(), referer: r.headers().referer ?? '',
    });
  });
  return peticiones;
}

const boton = (page: Page, nombre: string) => page.getByRole('button', { name: nombre, exact: true });
const normalizar = (s: string) => s.replace(/\u00A0/g, ' ').trim();

/** Los números de comparendo pintados ahora mismo, en orden. */
async function numerosEnPantalla(page: Page): Promise<string[]> {
  const filas = page.getByRole('row');
  const n = await filas.count();
  const salida: string[] = [];
  for (let i = 1; i < n; i += 1) {
    const celda = filas.nth(i).getByRole('cell').first();
    salida.push((await celda.innerText()).trim());
  }
  return salida;
}

test.describe('FLITO — Comparendos · visor contra datos reales (HU #11560)', () => {
  test.use({ viewport: { width: 1600, height: 900 } });

  /**
   * Guardia de entorno. Comprueba las DOS cosas de las que este archivo depende y que no puede
   * fabricar: que haya un API vivo con una sesión válida, y que el perfil de datos esté sembrado.
   *
   * Se hace en `beforeAll` y no test a test porque cuesta un login y tres consultas, y el login es
   * el recurso escaso (10 / 15 min / IP). De paso deja el token puesto: los tests NO se vuelven a
   * autenticar, así que una corrida completa gasta UNA sola autenticación.
   *
   * Distingue tres motivos distintos y los dice por su nombre, porque llevan a acciones distintas:
   * «no hay API», «el limitador se agotó, espera» y «faltan los datos, siémbralos así».
   */
  test.beforeAll(async ({ playwright }) => {
    // `baseURL` es un fixture de ámbito de test y aquí no está disponible: ver `API_BASE`.
    const api = await playwright.request.newContext({ baseURL: API_BASE });
    try {
      const sesion = await api.post('/api/auth/login', { data: { username: USUARIO, password: CLAVE } });
      if (sesion.status() === 429) {
        motivoSkip = `El API rechaza el login con 429: se agotó \`authLimiter\` (10 autenticaciones `
          + `cada 15 minutos por IP, apps/api/src/shared/middleware/rateLimiter.ts:39). No es un fallo `
          + `del producto ni faltan datos: espera unos minutos y vuelve a correr.`;
        return;
      }
      if (!sesion.ok()) {
        motivoSkip = `El API de ${API_BASE} respondió ${sesion.status()} al login con «${USUARIO}». `
          + `Revisa que el stack esté levantado y que ese usuario exista.\n${COMO_SEMBRAR}`;
        return;
      }
      tokenReal = (await sesion.json()).token as string;

      // Se camina el listado entero: es lo único que puede afirmar «125 en 50/50/25» y, de paso,
      // comprueba que la paginación real responde. Tope de vueltas por si algo no terminara nunca.
      const cabeceras = { Authorization: `Bearer ${tokenReal}` };
      const tamanos: number[] = [];
      const numeros: string[] = [];
      let cursor: string | null = null;
      for (let vuelta = 0; vuelta < 6; vuelta += 1) {
        const ruta = '/api/flito/comparendos/registros'
          + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
        const r = await api.get(ruta, { headers: cabeceras });
        if (!r.ok()) {
          motivoSkip = `El listado real respondió ${r.status()} en la vuelta ${vuelta + 1}.`
            + `\n${COMO_SEMBRAR}`;
          return;
        }
        const pagina = await r.json();
        tamanos.push(pagina.items.length);
        for (const item of pagina.items) numeros.push(item.numeroComparendo);
        cursor = pagina.nextCursor;
        if (!cursor) break;
      }

      const faltan = FILAS_BORDE.filter((n) => !numeros.includes(n));
      if (numeros.length !== 125 || faltan.length > 0) {
        motivoSkip = `El entorno responde, pero NO tiene el perfil de QA de la #11560: se leyeron `
          + `${numeros.length} comparendos en páginas [${tamanos.join(', ')}]`
          + (faltan.length ? ` y faltan las filas-borde ${faltan.join(', ')}` : '')
          + `.\n${COMO_SEMBRAR}`;
      }
    } catch (e) {
      // Solo la primera línea: Playwright cuelga un «Call log» de veinte líneas del mensaje y
      // ahogaría las instrucciones, que es lo único accionable de todo esto.
      const causa = (e as Error).message.split('\n')[0];
      motivoSkip = `No se pudo hablar con el API en ${API_BASE}: ${causa} `
        + `¿Está levantado el stack (API en :3005 y front en :5175)?\n${COMO_SEMBRAR}`;
    } finally {
      await api.dispose();
      // El motivo se imprime además por consola: la anotación del `skip` solo se ve en algunos
      // reporters, y este mensaje es justo lo que la próxima persona necesita leer.
      //
      // Va DENTRO del `finally` y no después, y no es un detalle de estilo: las ramas de arriba
      // salen con `return`, que ejecuta el `finally` y devuelve — cualquier línea posterior al
      // bloque nunca correría. La primera versión imprimía el motivo de «faltan datos» pero se
      // callaba justo el del 429, que es el que más desconcierta.
      if (motivoSkip) console.log(`\n[QA #11560 · datos reales] SE SALTA\n${motivoSkip}\n`);
    }
  });

  // Se salta con el motivo entero, que es lo que la próxima persona necesita leer. NUNCA rojo por
  // un entorno que falta: un rojo así no dice nada del producto y se acaba ignorando.
  test.beforeEach(() => {
    test.skip(motivoSkip !== null, motivoSkip ?? '');
  });

  test('TC42 — se camina la paginación real de punta a punta: 50 / 50 / 25, sin repetir ni saltarse una fila', async ({ page, request }) => {
    test.slow();
    await loginReal(page, request);
    const peticiones = colector(page);
    await page.goto('/flito/comparendos');
    await expect(page.getByRole('table')).toBeVisible();
    await expect(page.getByText(/comparendos en esta página · página 1/)).toBeVisible();

    const anterior = boton(page, '← Anterior');
    const siguiente = boton(page, 'Siguiente →');
    await expect(anterior, 'en la primera página no se puede retroceder').toBeDisabled();

    const paginas: string[][] = [];
    // Tope de vueltas: si la implementación no llegara nunca a `nextCursor: null`, el test tiene que
    // fallar por su cuenta y no colgar el runner.
    for (let vuelta = 0; vuelta < 6; vuelta += 1) {
      paginas.push(await numerosEnPantalla(page));
      if (!(await siguiente.isEnabled())) break;
      const primeroAntes = paginas[paginas.length - 1][0];
      await siguiente.click();
      await expect(page.getByText(new RegExp(`página ${paginas.length + 1}`))).toBeVisible();
      // La página se REEMPLAZA (spec, y decisión del Líder Técnico sobre el AC5): la primera fila
      // de la página anterior ya no está en pantalla.
      await expect(page.getByRole('cell', { name: primeroAntes, exact: true })).toHaveCount(0);
    }

    expect(paginas.map((p) => p.length), 'el perfil sembrado son 125 filas: 50 / 50 / 25').toEqual([50, 50, 25]);
    const todos = paginas.flat();
    expect(todos, '125 filas en total').toHaveLength(125);
    expect(new Set(todos).size, 'ni una fila repetida entre páginas').toBe(125);

    // Fin de lista: el control se queda, inhabilitado. No desaparece (decisión sobre el AC5).
    await expect(siguiente).toBeVisible();
    await expect(siguiente).toBeDisabled();
    await expect(anterior).toBeEnabled();

    // Y se vuelve andando hacia atrás, desapilando cursores, hasta la primera página real.
    await anterior.click();
    await expect(page.getByText(/página 2/)).toBeVisible();
    expect(await numerosEnPantalla(page), 'la página 2 se reconstruye idéntica').toEqual(paginas[1]);
    await anterior.click();
    await expect(page.getByText(/página 1/)).toBeVisible();
    expect(await numerosEnPantalla(page)).toEqual(paginas[0]);
    await expect(anterior).toBeDisabled();

    // El cursor real es base64url SIN relleno: no lleva `=`, `+` ni `/`, así que una doble
    // codificación NO se ve en la URL. Se comprueba sobre el valor decodificado UNA vez, y que
    // ninguna consulta pida `limit`.
    const cursores = peticiones
      .map((p) => new URL(p.url).searchParams.get('cursor'))
      .filter((c): c is string => c !== null);
    expect(cursores.length, 'se pidieron páginas con cursor').toBeGreaterThan(0);
    for (const c of cursores) {
      expect(c, 'el cursor llega decodificado limpio, sin %25 de una doble codificación').not.toContain('%');
      expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    for (const p of peticiones) expect(p.url).not.toContain('limit=');
  });

  test('TC35+TC42 — buscar por NIT real pagina por POST, con el NIT SIEMPRE en el cuerpo', async ({ page, request }) => {
    await loginReal(page, request);
    const peticiones = colector(page);
    await page.goto('/flito/comparendos');
    await expect(page.getByRole('table')).toBeVisible();

    // Se escribe con puntos, que es como lo escribe una persona y como el campo lo conserva.
    await page.getByLabel('NIT monitoreado').fill('900.123.456');
    await boton(page, 'Buscar').click();
    await expect(page.getByText(/50 comparendos en esta página · página 1/)).toBeVisible();

    const p1 = await numerosEnPantalla(page);
    await boton(page, 'Siguiente →').click();
    await expect(page.getByText(/página 2/)).toBeVisible();
    const p2 = await numerosEnPantalla(page);
    expect(p1.length + p2.length, 'el NIT sembrado tiene 60 comparendos').toBe(60);
    expect(new Set([...p1, ...p2]).size).toBe(60);
    await expect(boton(page, 'Siguiente →')).toBeDisabled();

    // TODAS las peticiones del módulo, incluida la de la segunda página: el NIT solo puede estar en
    // el cuerpo. Se buscan las dos formas —cruda con puntos y normalizada— y sus codificaciones.
    const formas = [NIT_SEMBRADO, '900.123.456', encodeURIComponent('900.123.456')];
    const busquedas = peticiones.filter((p) => p.url.includes('/registros/buscar'));
    expect(busquedas.length, 'la búsqueda y su paginación son POST').toBeGreaterThanOrEqual(2);
    for (const p of peticiones) {
      for (const forma of formas) {
        expect(p.url, `«${forma}» en la URL de ${p.metodo} ${p.url}`).not.toContain(forma);
        expect(p.referer, `«${forma}» en el Referer`).not.toContain(forma);
      }
      expect(p.url).not.toContain('nit=');
    }
    for (const p of busquedas) {
      expect(p.metodo).toBe('POST');
      expect(JSON.parse(p.cuerpo ?? '{}'), 'el NIT viaja normalizado en el cuerpo')
        .toMatchObject({ nit: NIT_SEMBRADO });
    }
    // La segunda página lleva cursor en la query y el NIT en el cuerpo, no al revés.
    const conCursor = busquedas.filter((p) => new URL(p.url).searchParams.has('cursor'));
    expect(conCursor.length, 'la página 2 de una búsqueda por identidad lleva su cursor').toBe(1);

    // Y ni la barra de direcciones ni nada que sobreviva a la pestaña lo vio.
    const rastro = await page.evaluate(() => ({
      url: location.href, titulo: document.title,
      sesion: JSON.stringify(sessionStorage), local: JSON.stringify(localStorage),
    }));
    for (const forma of formas) {
      expect(rastro.url).not.toContain(forma);
      expect(rastro.titulo).not.toContain(forma);
      expect(rastro.sesion).not.toContain(forma);
      expect(rastro.local).not.toContain(forma);
    }
    expect(rastro.url).toMatch(/\/flito\/comparendos$/);
    // El campo sigue mostrando los puntos: la normalización es del envío, no del tecleo.
    await expect(page.getByLabel('NIT monitoreado')).toHaveValue('900.123.456');
  });

  test('TC11 — las filas-borde reales se pintan bien: cero pesos, el centavo, los nulos y la descripción larga', async ({ page, request }) => {
    await loginReal(page, request);
    await page.goto('/flito/comparendos');
    await expect(page.getByRole('table')).toBeVisible();

    // Las cinco filas-borde están entre los 10 inactivos: una sola página y una sola consulta.
    await boton(page, 'Inactivos').click();
    await expect(page.getByText(/10 comparendos en esta página · página 1/)).toBeVisible();
    // La columna «Inactivado» solo existe con este filtro puesto: en la vista de activos sería una
    // columna de guiones por definición.
    await expect(page.getByRole('columnheader', { name: 'Inactivado', exact: true })).toBeVisible();

    const monto = async (numero: string) => {
      const fila = page.getByRole('row').filter({ hasText: numero });
      return normalizar(await fila.locator('td.tabular-nums').innerText());
    };

    // `0.00` es un dato, no una ausencia. `Number('0.00')` es falsy y es donde un `monto ? … : '—'`
    // presenta un comparendo de cero pesos como un comparendo sin monto.
    const cero = await monto('QA-0081');
    expect(cero, 'un comparendo de cero pesos NO es un dato ausente').not.toBe('—');
    expect(cero.replace(/[^\d.]/g, '')).toBe('0');
    expect(cero).toContain('$');
    // `maximumFractionDigits: 0` REDONDEA: un `Math.floor` daría 232.100 y pasaría con todos los
    // montos terminados en `.00`, que son todos los demás.
    expect((await monto('QA-0082')).replace(/[^\d.]/g, '')).toBe('232.101');
    expect((await monto('QA-0083')).replace(/[^\d.]/g, '')).toBe('1.234.568');
    // La fila con placa, monto, fecha y municipio en `null`: cuatro guiones y la fila entera sigue
    // de pie, con su número y su estado legibles.
    const nula = page.getByRole('row').filter({ hasText: 'QA-0085' });
    expect((await nula.innerText()).split('—').length - 1, 'los nulos se pintan «—»').toBeGreaterThanOrEqual(4);
    await expect(nula).toContainText('Inactivo');

    // Descripción de más de 200 caracteres: se recorta a una línea y NO se cuelga de un `title`
    // (que no ve el teclado, no anuncia bien un lector y no existe en táctil).
    const larga = page.getByRole('row').filter({ hasText: 'QA-0084' });
    const recorte = larga.locator('span.line-clamp-1').first();
    await expect(recorte).toBeVisible();
    await expect(recorte).not.toHaveAttribute('title', /./);
    // Y el alto de esa fila no se dispara respecto a las demás: es lo que el recorte protege.
    const altoLargo = (await larga.boundingBox())?.height ?? 0;
    const altoNormal = (await page.getByRole('row').filter({ hasText: 'QA-0081' }).boundingBox())?.height ?? 0;
    expect(altoLargo, 'una descripción larga no puede convertir una fila en cuatro')
      .toBeLessThanOrEqual(altoNormal * 1.5);

    // El municipio se pinta con el catálogo real («ITAGUI» → «Itagüí»), no con el código del sync.
    await expect(page.getByRole('table')).not.toContainText('ITAGUI');
  });

  test.describe('TC11 · fechas reales, con el navegador en Tokio (UTC+9)', () => {
    test.use({ timezoneId: 'Asia/Tokyo', locale: 'es-CO' });

    test('los instantes sembrados cruzan la medianoche de Bogotá en las dos direcciones', async ({ page, request }) => {
      await loginReal(page, request);
      await page.goto('/flito/comparendos');
      await expect(page.getByRole('table')).toBeVisible();
      expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe('Asia/Tokyo');

      await boton(page, 'Inactivos').click();
      await expect(page.getByText(/10 comparendos en esta página · página 1/)).toBeVisible();

      // Se afirma CELDA a celda y no sobre la fila entera: con el filtro «Inactivos» hay DOS
      // columnas de instante —«Registrado» (11) e «Inactivado» (12)— y un `not.toContainText`
      // sobre la fila las mezcla. La primera versión de este test falló justo por eso, y el fallo
      // era del test: «17 de ago» era el `inactivadoEn`, correcto.
      const celda = (numero: string, indice: number) =>
        page.getByRole('row').filter({ hasText: numero }).getByRole('cell').nth(indice);
      const REGISTRADO = 11;
      const INACTIVADO = 12;

      // `QA-0082`: `primeraVistoEn` 2026-08-17T03:12Z = 16 ago 22:12 en Bogotá (día ANTERIOR);
      //            `inactivadoEn`   2026-08-18T03:12Z = 17 ago 22:12 en Bogotá (día ANTERIOR).
      // En Tokio serían 17 y 18: las dos celdas se moverían a la vez.
      await expect(celda('QA-0082', REGISTRADO), '«Registrado» va en hora de Colombia')
        .toHaveText('16 de ago de 2026');
      await expect(celda('QA-0082', INACTIVADO), '«Inactivado» también')
        .toHaveText('17 de ago de 2026');

      // `QA-0081`: `primeraVistoEn` 2026-08-17T20:00Z = 17 ago 15:00 en Bogotá (MISMO día).
      // En Tokio sería el 18. Con los dos casos juntos, un desfase constante no puede pasar.
      await expect(celda('QA-0081', REGISTRADO)).toHaveText('17 de ago de 2026');
      await expect(celda('QA-0081', INACTIVADO)).toHaveText('17 de ago de 2026');
    });
  });
});
