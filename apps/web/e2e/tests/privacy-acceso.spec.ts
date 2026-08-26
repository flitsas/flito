// Privacy — la frontera de acceso a las DOS vistas de la superficie PII (HU #11276, AC3).
//
// Es el test que más pesa del módulo. `/privacy` ejecuta el derecho al olvido —anonimiza registros
// de seis tablas de forma irreversible— y `/privacy/log-pii` es el registro de QUIÉN miró datos
// personales de un conductor, con su IP y su motivo. Que un rol sin permiso vea o dispare
// cualquiera de las dos no es un fallo de navegación: es una divulgación en un caso y una
// destrucción de datos en el otro.
//
// ── Un solo slug para las dos rutas, y por qué el negativo se escribe sabiéndolo ────────────────
//
// `App.tsx:183` y `App.tsx:223` usan el MISMO `page="privacy"`. Aquí no existe el reparto fino que
// hacía interesante el negativo de LAFT (donde `auditor` entraba a 4 de las 7 rutas): una sola
// guarda cubre las dos vistas, así que un test que buscara «qué rol entra a una y no a la otra»
// estaría afirmando una frontera inventada. Lo que sí aportan DOS roles negativos es otra cosa:
//
//   · `conductor` es el rol más acotado del sistema (`dashboard`, `pesv`). Control de suelo.
//   · `auditor` es el rol con la superficie de LECTURA más ancha de FLITO —clientes, trámites,
//     SOAT, impuestos, derechos, bitácora, costos, facturación—. Que esa anchura se detenga
//     exactamente en la superficie PII es la afirmación que vale; que un conductor no entre no
//     prueba gran cosa, porque el conductor no entra casi a nada.
//
// ── Por qué el negativo no puede ser «no veo la tabla» ─────────────────────────────────────────
//
// Afirmar una AUSENCIA se cumple sola en cualquier test roto. Las piezas que la vuelven prueba:
//
//   1. **El endpoint se mockea CON datos, no se aborta.** Si la guarda se saltara, la PII estaría
//      servida y llegaría al DOM. Abortar dejaría la afirmación en «no se ve algo que nadie podía
//      traer», que no vale nada.
//   2. **Se espía la PETICIÓN, no la respuesta.** El catch-all de `helpers/fixtures.ts` responde
//      `200 []` a cualquier `/api/**`, así que una consulta fugada no deja huella en la interfaz. Y
//      si el componente monta, consulta y se desmonta, la respuesta se descarta pero la petición ya
//      salió con la sesión.
//   3. **El chunk tampoco se pide.** `React.lazy` dispara su `import()` al MONTAR, y
//      `ProtectedRoute` devuelve `NoAccess` en lugar de sus hijos. Ese aserto se pone rojo si
//      alguien mueve la guarda DENTRO de la página —la CAUSA de una fuga, no su síntoma— aunque ese
//      día la página no consultara nada. Es el único aserto que protege de verdad a `/privacy`,
//      que al montar no consulta nada (`Privacy.tsx` solo llama al API desde el `submit`).
//   4. **Se mira la URL y la CONSOLA**, que es lo que el AC3 nombra aparte del render, con un
//      colector de TODOS los mensajes (no solo errores) y su control positivo al final del archivo.
//   5. **El gemelo POSITIVO vive en este mismo archivo**, con los mismos helpers y predicados. Si
//      mañana el prefijo del API cambia o un pathname se escribe mal, el positivo se pone rojo y
//      delata que el negativo pasaba por vacío.
//
// ── Una desviación respecto al texto del AC, a propósito ───────────────────────────────────────
//
// El AC3 dice «la guarda lo bloquea». La guarda de este producto NO redirige: `ProtectedRoute`
// (`App.tsx:109`) renderiza `NoAccess` EN la ruta, conservando la URL y la navegación. Lo que el AC
// pide de fondo —no renderizar ni pedir contenido con PII— se cumple igual, y es lo que se afirma.
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { ADMIN_USER, CONDUCTOR_USER, AUDITOR_USER } from '../helpers/auth';
import {
  COMPLIANCE_PRIVACY_USER, VISTAS_PRIVACY, DOC_SINTETICO, PII_QUE_NO_DEBE_PINTARSE,
  CAMPOS_NO_PINTADOS, HUELLA_FILA_READ,
  entrar, espiarApiPrivacy, espiarChunks, chunkDe, huellas, mockLogPii, mockPreview, reposo,
  RUTA_LOG, RUTA_STATS, type VistaPrivacy,
} from '../helpers/privacy-fixtures';

const LOG_PII = VISTAS_PRIVACY.find((v) => v.ruta === '/privacy/log-pii')!;
const OLVIDO = VISTAS_PRIVACY.find((v) => v.ruta === '/privacy')!;

/**
 * Todo lo identificable que los fixtures ponen sobre la mesa. Ninguno puede aparecer en el DOM ni en
 * la consola cuando la guarda actúa. Se afirma sobre `page.content()` y no sobre texto VISIBLE: la
 * PII se cuela igual por un `title`, un `data-*` o un nodo con `display:none`.
 */
const HUELLA_PII = [
  ...Object.values(PII_QUE_NO_DEBE_PINTARSE),
  // Lo que la fila SÍ pinta con permiso: la IP de quien accedió y el recurso que miró. Son las dos
  // huellas que de verdad se pondrían rojas si la guarda fallara — el `requestId` no vale para esto
  // porque la tabla no lo pinta nunca (ver `CAMPOS_NO_PINTADOS`) y su ausencia sería una tautología.
  '203.0.113.7',
  HUELLA_FILA_READ,
  // El motivo llega del API en cada fila aunque hoy no se pinte: si la guarda fallara y alguien
  // hubiera añadido su columna, este es el texto libre que se publicaría.
  CAMPOS_NO_PINTADOS.motivo,
  DOC_SINTETICO,
];

/** Colector de TODOS los mensajes de consola — no solo los de tipo error. */
function vigilarConsola(page: Page): string[] {
  const mensajes: string[] = [];
  page.on('console', (msg) => mensajes.push(msg.text()));
  page.on('pageerror', (err) => mensajes.push(err.message));
  return mensajes;
}

/** Sirve las dos vistas CON datos: la guarda tiene que aguantar con la PII disponible detrás. */
async function servirTodoConDatos(page: Page) {
  await mockLogPii(page);
  await mockPreview(page);
}

test.describe('Privacy — la guarda de permisos aguanta (HU #11276, AC3)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  // ── Negativos: dos roles, las dos rutas ───────────────────────────────────────────────────────
  for (const usuario of [CONDUCTOR_USER, AUDITOR_USER]) {
    for (const vista of VISTAS_PRIVACY) {
      test(`AC3 — ${usuario.role}: ${vista.ruta} no monta, no consulta el API y no descarga el módulo`, async ({ page }) => {
        await entrar(page, usuario);
        const consola = vigilarConsola(page);
        const peticiones = espiarApiPrivacy(page);
        const chunks = espiarChunks(page);
        await servirTodoConDatos(page);

        await page.goto(vista.ruta);
        await expect(page.getByRole('heading', { name: `No tienes acceso a ${vista.etiqueta}` })).toBeVisible();
        await reposo(page);

        // 1 · Nada de la vista se pintó. El `<h1>` NO basta como sensor —`PageHeaderCard` lo saca
        //     fuera de todo condicional y `NoAccess` tiene el suyo—, así que además se exige la
        //     ausencia de una señal de CUERPO propia de la página.
        await expect(page.getByRole('heading', { level: 1, name: vista.titulo, exact: true })).toHaveCount(0);
        await expect(page.getByText(vista.huellaCuerpo)).toHaveCount(0);

        // 2 · Ni un dato identificable llegó al documento…
        const html = await page.content();
        for (const dato of HUELLA_PII) {
          expect(html, `${dato} llegó al DOM sin permiso`).not.toContain(dato);
        }
        // 3 · …ni a la consola, que es la otra mitad de lo que el AC3 nombra.
        for (const dato of HUELLA_PII) {
          expect(consola.join('|'), `${dato} se escribió en la consola sin permiso`).not.toContain(dato);
        }

        // 4 · Ninguna petición salió hacia `/api/privacy` — ni una que se descarte después.
        expect(huellas(peticiones)).toEqual([]);

        // 5 · Y el módulo ni se descargó: la guarda está ANTES del montaje, no dentro de la página.
        //     Para `/privacy` este es EL aserto: esa vista no consulta nada al montar, así que sin
        //     él su negativo sería verde incluso con la guarda arrancada de raíz.
        expect(chunkDe(chunks, vista), `se descargó el módulo de ${vista.componente}`).toEqual([]);

        // 6 · La URL no cambió (la guarda no redirige, ver cabecera) y no lleva nada identificable.
        expect(page.url()).toContain(vista.ruta);
        expect(new URL(page.url()).search).toBe('');
        expect(new URL(page.url()).hash).toBe('');
      });
    }
  }

  // ── Refuerzo del negativo de `/privacy`: la capacidad tampoco está ────────────────────────────
  //
  // En `/privacy` no hay dato que filtrar hasta que alguien pregunta por un documento: lo que la
  // guarda tiene que negar es la CAPACIDAD —el formulario que consulta y el botón que anonimiza—.
  // Sin este test, el negativo de esa ruta se apoyaría solo en ausencias genéricas.
  test('AC3 — sin permiso, `/privacy` no ofrece ni el formulario de consulta ni la anonimización', async ({ page }) => {
    await entrar(page, CONDUCTOR_USER);
    await servirTodoConDatos(page);

    await page.goto(OLVIDO.ruta);
    await expect(page.getByRole('heading', { name: `No tienes acceso a ${OLVIDO.etiqueta}` })).toBeVisible();

    await expect(page.getByLabel('Número de documento')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Previsualizar' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Anonimizar este documento' })).toHaveCount(0);
  });

  // ── Gemelo POSITIVO: sin él, todo lo de arriba podría estar pasando por vacío ──────────────────
  test('AC3 (gemelo positivo) — compliance entra a `/privacy/log-pii`, pide su chunk y consulta el API', async ({ page }) => {
    await entrar(page, COMPLIANCE_PRIVACY_USER);
    const peticiones = espiarApiPrivacy(page);
    const chunks = espiarChunks(page);
    await servirTodoConDatos(page);

    await page.goto(LOG_PII.ruta);
    await expect(page.getByRole('heading', { level: 1, name: LOG_PII.titulo, exact: true })).toBeVisible();
    await reposo(page);

    expect(huellas(peticiones)).toContain(`GET ${RUTA_LOG}`);
    expect(huellas(peticiones)).toContain(`GET ${RUTA_STATS}`);
    expect(chunkDe(chunks, LOG_PII), `no se pidió el módulo de ${LOG_PII.componente}`).not.toEqual([]);
    // Y los datos del fixture SÍ están aquí. Es lo que da valor al `not.toContain` del negativo:
    // demuestra que ese aserto sabe ponerse rojo.
    const html = await page.content();
    expect(html).toContain('203.0.113.7');
    expect(html).toContain(HUELLA_FILA_READ);
  });

  test('AC3 (gemelo positivo) — compliance entra a `/privacy` y su consulta llega al API', async ({ page }) => {
    await entrar(page, COMPLIANCE_PRIVACY_USER);
    const peticiones = espiarApiPrivacy(page);
    const chunks = espiarChunks(page);
    await servirTodoConDatos(page);

    await page.goto(OLVIDO.ruta);
    await expect(page.getByRole('heading', { level: 1, name: OLVIDO.titulo, exact: true })).toBeVisible();
    expect(chunkDe(chunks, OLVIDO), `no se pidió el módulo de ${OLVIDO.componente}`).not.toEqual([]);

    // `/privacy` no consulta nada al montar: su única llamada nace del formulario. Hay que
    // dispararla para que el positivo pruebe algo sobre el API.
    await page.getByLabel('Número de documento').fill(DOC_SINTETICO);
    await page.getByRole('button', { name: 'Previsualizar' }).click();
    // Señal de CUERPO, no de plantilla: «6» es la suma de los conteos del fixture (3+2+1).
    await expect(page.getByText(/6 registros afectados/)).toBeVisible();

    // El documento viaja EN LA RUTA (`Privacy.tsx:46`); el espía lo redacta antes de guardarlo.
    expect(huellas(peticiones)).toContain('GET /api/privacy/preview/:doc');
    // Y la URL del SPA sigue sin llevarlo: el documento no se convirtió en estado de navegación.
    expect(page.url()).not.toContain(DOC_SINTETICO);
    expect(new URL(page.url()).search).toBe('');
  });

  // ── El slug compartido, afirmado ──────────────────────────────────────────────────────────────
  //
  // `compliance` tiene `privacy` en `ROLE_DEFAULT_PAGES` y `allowedPages` VACÍO: no hay comodín que
  // lo tape. Si mañana alguien parte `/privacy/log-pii` a un slug propio y olvida concedérselo, este
  // test se pone rojo y nombra el motivo.
  test('AC3 — el permiso `privacy` abre las DOS rutas: comparten slug', async ({ page }) => {
    await entrar(page, COMPLIANCE_PRIVACY_USER);
    await servirTodoConDatos(page);

    for (const vista of VISTAS_PRIVACY) {
      await page.goto(vista.ruta);
      await expect(page.getByRole('heading', { level: 1, name: vista.titulo, exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: /No tienes acceso a/ })).toHaveCount(0);
    }
  });

  // ── Control POSITIVO del colector de consola ──────────────────────────────────────────────────
  //
  // Sin esto, los cuatro negativos comparten un punto ciego: `not.toContain` sobre `consola` es
  // verde tanto si no se escribió PII como si el colector nunca estuvo enchufado —un `page.on`
  // puesto después de navegar, un cambio de API de Playwright—. Aquí se provocan las dos clases de
  // mensaje a propósito y se exige que las vea.
  test('AC3 (canario) — el colector de consola SÍ ve un console.log y una excepción', async ({ page }) => {
    const consola = vigilarConsola(page);
    await entrar(page, ADMIN_USER);
    await servirTodoConDatos(page);
    await page.goto(LOG_PII.ruta);
    await expect(page.getByRole('heading', { level: 1, name: LOG_PII.titulo, exact: true })).toBeVisible();

    await page.evaluate(() => { console.log('canario-e2e-consola'); });
    await page.evaluate(() => { setTimeout(() => { throw new Error('canario-e2e-pageerror'); }, 0); });

    await expect.poll(() => consola.join('|')).toContain('canario-e2e-consola');
    await expect.poll(() => consola.join('|')).toContain('canario-e2e-pageerror');
  });
});

/** Referencia de tipo — mantiene el import de `VistaPrivacy` honesto ante el linter. */
export type _Vista = VistaPrivacy;
