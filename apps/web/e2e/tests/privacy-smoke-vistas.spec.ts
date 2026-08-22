// Privacy — las DOS vistas montan y no pintan valores de PII (HU #11276, AC1).
//
// ██ LEER ANTES DE DAR EL AC1 POR CUBIERTO ██
//
// El AC1 pide: «los campos PII se muestran **redactados o enmascarados según su rol**». Eso, hoy,
// no existe, y no se cubre inventándolo:
//
//   · **No hay enmascarado, ni por rol ni general.** No existe una función de máscara en
//     `Privacy.tsx`, en `PesvLogPii.tsx` ni en `lib/`. La única lectura de rol de toda la superficie
//     es `Privacy.tsx:37` (`isAdmin = user?.role === 'admin'`), y lo único que decide es si se pinta
//     el botón «Anonimizar este documento» (:158-166) o el aviso «Solo administradores pueden
//     ejecutar la anonimización.» (:168). Eso es gating de una ACCIÓN, no redacción de un campo.
//   · **El `docNumber` se pinta EN CLARO e idéntico para los dos roles** (`Privacy.tsx:135` y :219).
//     No hay rama de rol alrededor.
//   · El copy que induce a error es `Privacy.tsx:70` («nombres, emails, teléfonos y direcciones se
//     reemplazan por marcadores»): describe lo que el BACKEND escribe en la base de datos al
//     anonimizar, no lo que esta pantalla pinta.
//
// Lo que sí existe, y es lo que este archivo cubre, son dos cosas distintas y ambas verificables:
//
//   1. **La diferencia por rol que hay de verdad**: admin ve el botón que ejecuta, compliance ve el
//      aviso y NO el botón. Es la frontera real de esta pantalla y hoy no la vigilaba nadie.
//   2. **La no exposición de valores por diseño**: `/privacy` solo recibe conteos —el contrato
//      `PreviewResponse` (:10-20) es `docNumber` + seis enteros, no viajan nombres ni correos— y
//      `/privacy/log-pii` pinta los NOMBRES de los campos accedidos (`camposAccedidos`), nunca sus
//      valores. Esa es la redacción efectiva de la superficie, y el test la fija.
//
// El aserto (2) no es una tautología, y esa es la parte que importa: `pii-access.routes.ts:34` hace
// `db.select().from(piiAccessLog)` —un `SELECT *` sin proyección—, así que el día que la tabla gane
// una columna con el valor accedido o con el titular, esa columna saldrá hacia el navegador sola,
// sin que nadie toque el frontend. El fixture ya trae esas cuatro claves (`PII_QUE_NO_DEBE_PINTARSE`)
// y el test exige que no lleguen al DOM: se pondrá rojo justo el día en que eso pase.
//
// ── Los tres sensores que aquí NO valen solos ──────────────────────────────────────────────────
//
//   1. **El `<h1>` no prueba nada.** `PageHeaderCard:37` lo pinta FUERA de cualquier condicional, y
//      `NoAccess` también tiene el suyo: un aserto de encabezado pasa con la vista atascada en
//      «Cargando…» Y pasa sin permiso. Cada test añade una huella del CUERPO que sale del fixture,
//      la ausencia de «Cargando...» y la ausencia del encabezado de `NoAccess`.
//   2. **El mock que no intercepta no se nota.** El catch-all de `helpers/fixtures.ts` responde
//      `200 []` a todo `/api/**`. El seguro es el espía de peticiones REALES sobre el pathname.
//   3. **Un colector de consola sin control positivo pasa siempre.** El canario está al final.
//
// Y un cuarto, propio de esta pantalla: **`PesvLogPii` no tiene estado de carga**. `rows` arranca en
// `[]`, así que la tabla escribe «Sin accesos para los filtros» ANTES de que llegue la respuesta.
// Todo aserto sobre su cuerpo espera primero a la respuesta (`esperarLog` / `esperarStats`); sin eso
// el vacío sería verde por accidente, midiendo el instante previo a la carga.
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { ADMIN_USER } from '../helpers/auth';
import {
  COMPLIANCE_PRIVACY_USER, VISTAS_PRIVACY, DOC_SINTETICO, PII_QUE_NO_DEBE_PINTARSE, CAMPOS_ACCEDIDOS,
  CAMPOS_NO_PINTADOS, HUELLA_FILA_READ, HUELLA_FILA_EXPORT,
  LOG_CON_FILAS, LOG_VACIO, STATS_CON_DATOS, STATS_VACIO, VACIO_LOG, VACIO_STATS,
  PREVIEW_CON_REGISTROS, PREVIEW_SIN_REGISTROS,
  entrar, espiarApiPrivacy, huellas, mockLogPii, mockPreview, esperarLog, esperarStats,
  RUTA_LOG, RUTA_STATS,
} from '../helpers/privacy-fixtures';

const LOG_PII = VISTAS_PRIVACY.find((v) => v.ruta === '/privacy/log-pii')!;
const OLVIDO = VISTAS_PRIVACY.find((v) => v.ruta === '/privacy')!;
/** El aviso de `Privacy.tsx:168`. Se compara con `exact: true` — ver la trampa documentada abajo. */
const AVISO_SOLO_ADMIN = 'Solo administradores pueden ejecutar la anonimización.';

/** Acumula lo que el navegador considera un error, venga de `console.error` o de una excepción. */
function vigilarErrores(page: Page): string[] {
  const errores: string[] = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errores.push(`console: ${msg.text()}`); });
  page.on('pageerror', (err) => { errores.push(`pageerror: ${err.message}`); });
  return errores;
}

/** Lo que distingue «montada» de «montada a medias» o «montada sin permiso». */
async function noEstaNiCargandoNiBloqueada(page: Page): Promise<void> {
  await expect(page.getByText(/^Cargando\.\.\.$/)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /No tienes acceso a/ })).toHaveCount(0);
}

test.describe('Privacy — las dos vistas montan sin pintar valores de PII (HU #11276, AC1)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  // ── `/privacy/log-pii` ────────────────────────────────────────────────────────────────────────

  test('AC1 — /privacy/log-pii renderiza su estado CARGADO sin errores de consola', async ({ page }) => {
    const errores = vigilarErrores(page);
    const peticiones = espiarApiPrivacy(page);
    await entrar(page, COMPLIANCE_PRIVACY_USER);
    await mockLogPii(page, { log: { cuerpo: LOG_CON_FILAS }, stats: { cuerpo: STATS_CON_DATOS } });

    const log = esperarLog(page);
    const stats = esperarStats(page);
    await page.goto(LOG_PII.ruta);
    await Promise.all([log, stats]);

    // 1 · No es una pantalla en blanco…
    await expect(page.getByRole('heading', { level: 1, name: LOG_PII.titulo, exact: true })).toBeVisible();
    // 2 · …y lo que se ve viene del CUERPO de la respuesta, no del microcopy de la plantilla.
    await expect(page.getByText(HUELLA_FILA_READ)).toBeVisible();
    await expect(page.getByText(HUELLA_FILA_EXPORT)).toBeVisible();
    await expect(page.getByText('203.0.113.7').first()).toBeVisible();
    await expect(page.getByText(LOG_PII.huellaCuerpo)).toBeVisible();
    // 3 · El vacío NO está: el cargado es un cargado.
    await expect(page.getByText(VACIO_LOG)).toHaveCount(0);
    await noEstaNiCargandoNiBloqueada(page);
    // 4 · Y el dato salió de los endpoints que se creen, medido sobre la petición real.
    expect(huellas(peticiones), 'no se consultó el listado').toContain(`GET ${RUTA_LOG}`);
    expect(huellas(peticiones), 'no se consultó el resumen').toContain(`GET ${RUTA_STATS}`);

    expect(errores, 'errores de consola en /privacy/log-pii').toEqual([]);
  });

  test('AC1 — el log pinta los NOMBRES de los campos accedidos y ningún VALOR de PII', async ({ page }) => {
    await entrar(page, COMPLIANCE_PRIVACY_USER);
    await mockLogPii(page);

    const log = esperarLog(page);
    await page.goto(LOG_PII.ruta);
    await log;
    await expect(page.getByText(HUELLA_FILA_READ)).toBeVisible();

    // 1 · Lo que la columna «Campos» muestra son NOMBRES de campo. Es la redacción real de esta
    //     pantalla: dice QUÉ se miró, nunca QUÉ decía. Son DOS filas y las dos lo pintan: se afirma
    //     el recuento y no `toBeVisible()`, que en modo estricto reventaría con dos coincidencias.
    await expect(page.getByText(CAMPOS_ACCEDIDOS.join(', '))).toHaveCount(2);

    // 2 · Y los valores que viajaban en la MISMA fila no llegaron al documento. Se afirma sobre
    //     `page.content()` y no sobre texto visible: la PII se cuela igual por un `title`, un
    //     `data-*` o un nodo oculto. Este es el aserto que se pondrá rojo el día que el `SELECT *`
    //     de `pii-access.routes.ts:34` arrastre una columna nueva con el titular o el valor.
    const html = await page.content();
    for (const [clave, valor] of Object.entries(PII_QUE_NO_DEBE_PINTARSE)) {
      expect(html, `el log pintó ${clave} (${valor}): eso es un valor de PII, no un nombre de campo`)
        .not.toContain(valor);
    }

    // 3 · Y las tres columnas que el API SÍ manda hoy y la tabla omite siguen omitidas. `motivo` es
    //     la que importa: texto libre escrito por un operador, el campo del log con más papeletas
    //     para acabar conteniendo un nombre o una cédula. Añadirle una columna «Motivo» —petición
    //     razonable para una auditoría— lo publicaría en pantalla; este aserto obliga a pensarlo.
    for (const [clave, valor] of Object.entries(CAMPOS_NO_PINTADOS)) {
      expect(html, `el log pintó ${clave}, que hoy no tiene columna y llega del API en cada fila`)
        .not.toContain(valor);
    }
  });

  test('AC1 — /privacy/log-pii renderiza su estado VACÍO sin errores de consola', async ({ page }) => {
    const errores = vigilarErrores(page);
    const peticiones = espiarApiPrivacy(page);
    await entrar(page, COMPLIANCE_PRIVACY_USER);
    await mockLogPii(page, { log: { cuerpo: LOG_VACIO }, stats: { cuerpo: STATS_VACIO } });

    const log = esperarLog(page);
    const stats = esperarStats(page);
    await page.goto(LOG_PII.ruta);
    await Promise.all([log, stats]);

    await expect(page.getByRole('heading', { level: 1, name: LOG_PII.titulo, exact: true })).toBeVisible();
    await expect(page.getByText(VACIO_LOG)).toBeVisible();
    // Las dos tarjetas de resumen tienen su propio vacío, y también es un estado que puede romperse.
    // `exact: true` NO es adorno: «Sin accesos» es PREFIJO de «Sin accesos para los filtros», así
    // que sin él el localizador se traga también la fila vacía de la tabla y cuenta 3.
    await expect(page.getByText(VACIO_STATS, { exact: true })).toHaveCount(2);
    // El vacío es un vacío, no un cargado a medias: la huella del fixture con filas NO está.
    await expect(page.getByText(HUELLA_FILA_READ)).toHaveCount(0);
    await noEstaNiCargandoNiBloqueada(page);
    expect(huellas(peticiones)).toContain(`GET ${RUTA_LOG}`);
    expect(huellas(peticiones)).toContain(`GET ${RUTA_STATS}`);

    expect(errores, 'errores de consola en el vacío de /privacy/log-pii').toEqual([]);
  });

  // ── `/privacy` ────────────────────────────────────────────────────────────────────────────────

  test('AC1 — /privacy monta sin consultar nada y sin errores de consola', async ({ page }) => {
    const errores = vigilarErrores(page);
    const peticiones = espiarApiPrivacy(page);
    await entrar(page, COMPLIANCE_PRIVACY_USER);
    await mockPreview(page);

    await page.goto(OLVIDO.ruta);

    await expect(page.getByRole('heading', { level: 1, name: OLVIDO.titulo, exact: true })).toBeVisible();
    await expect(page.getByText(OLVIDO.huellaCuerpo)).toBeVisible();
    await expect(page.getByLabel('Número de documento')).toBeVisible();
    await noEstaNiCargandoNiBloqueada(page);

    // Esta vista no lee nada al montar: su única llamada nace del `submit` (`Privacy.tsx:46`).
    // Afirmarlo protege una propiedad real —abrir la pantalla del derecho al olvido no consulta
    // datos de nadie— y además es el control de que el espía no está midiendo de más.
    expect(huellas(peticiones), '/privacy consultó el API solo por montarse').toEqual([]);

    expect(errores, 'errores de consola en /privacy').toEqual([]);
  });

  test('AC1 — la previsualización pinta CONTEOS por tabla, no datos de la persona', async ({ page }) => {
    await entrar(page, COMPLIANCE_PRIVACY_USER);
    await mockPreview(page, { cuerpo: PREVIEW_CON_REGISTROS });

    await page.goto(OLVIDO.ruta);
    await page.getByLabel('Número de documento').fill(DOC_SINTETICO);
    await page.getByRole('button', { name: 'Previsualizar' }).click();

    // 3 + 2 + 1 = 6. Sale del fixture, no de la plantilla.
    await expect(page.getByText(/6 registros afectados/)).toBeVisible();
    // Las seis tablas del contrato `PreviewResponse`, con su rótulo. Lo que se entrega es el
    // RECUENTO del impacto; el titular nunca se nombra.
    for (const rotulo of ['Clientes', 'Vehículos', 'Solicitudes SOAT', 'Trámites digitales',
      'Contrapartes LAFT', 'Beneficiarios finales LAFT']) {
      await expect(page.getByText(rotulo, { exact: true })).toBeVisible();
    }
    // Y ningún dato de persona: el contrato no los trae y la pantalla no los inventa.
    const html = await page.content();
    for (const [clave, valor] of Object.entries(PII_QUE_NO_DEBE_PINTARSE)) {
      expect(html, `la previsualización pintó ${clave}`).not.toContain(valor);
    }
  });

  test('AC1 — sin registros para el documento, la previsualización lo dice y no ofrece anonimizar', async ({ page }) => {
    await entrar(page, ADMIN_USER);
    await mockPreview(page, { cuerpo: PREVIEW_SIN_REGISTROS });

    await page.goto(OLVIDO.ruta);
    await page.getByLabel('Número de documento').fill(DOC_SINTETICO);
    await page.getByRole('button', { name: 'Previsualizar' }).click();

    await expect(page.getByText('No hay registros con este documento. Nada que anonimizar.')).toBeVisible();
    // Es un admin: si hubiera algo que anonimizar vería el botón (lo prueba el test de abajo). Que
    // no esté aquí es la afirmación — no se ofrece una acción destructiva sobre cero registros.
    await expect(page.getByRole('button', { name: 'Anonimizar este documento' })).toHaveCount(0);
  });

  // ── La ÚNICA diferencia por rol que esta superficie tiene hoy ──────────────────────────────────
  //
  // Los dos tests son gemelos a propósito: mismo fixture, mismo flujo, distinto rol. Es lo que hace
  // que ninguno de los dos pueda pasar por vacío — si el localizador del botón se escribiera mal, el
  // positivo se pondría rojo y delataría que el negativo no estaba probando nada.
  //
  // ██ TRAMPA DE SENSOR, cazada al escribir estos tests ██
  //
  // La frase «Solo administradores pueden ejecutar la anonimización» está en la pantalla DOS veces:
  //   · `Privacy.tsx:72`, como viñeta de la política — se pinta SIEMPRE, para cualquier rol, sin
  //     previsualización de por medio, y sigue con «Compliance puede consultar la previsualización.»
  //   · `Privacy.tsx:168`, como el aviso que SUSTITUYE al botón cuando el rol no es admin.
  // Un `getByText(...)` a secas encuentra la viñeta y da por buena la diferenciación por rol aunque
  // el aviso de :168 no existiera. Por eso se usa `exact: true`: la viñeta es una frase más larga y
  // deja de casar, y el localizador apunta solo al aviso que de verdad depende del rol.

  test('AC1 (rol) — admin SÍ ve la acción de anonimizar', async ({ page }) => {
    await entrar(page, ADMIN_USER);
    await mockPreview(page);

    await page.goto(OLVIDO.ruta);
    await page.getByLabel('Número de documento').fill(DOC_SINTETICO);
    await page.getByRole('button', { name: 'Previsualizar' }).click();
    await expect(page.getByText(/6 registros afectados/)).toBeVisible();

    await expect(page.getByRole('button', { name: 'Anonimizar este documento' })).toBeVisible();
    await expect(page.getByText(AVISO_SOLO_ADMIN, { exact: true })).toHaveCount(0);
  });

  test('AC1 (rol) — compliance ve la previsualización pero NO la acción de anonimizar', async ({ page }) => {
    await entrar(page, COMPLIANCE_PRIVACY_USER);
    await mockPreview(page);

    await page.goto(OLVIDO.ruta);
    await page.getByLabel('Número de documento').fill(DOC_SINTETICO);
    await page.getByRole('button', { name: 'Previsualizar' }).click();
    // Ve exactamente lo mismo que el admin: el conteo del impacto. La diferencia NO es de datos.
    await expect(page.getByText(/6 registros afectados/)).toBeVisible();

    await expect(page.getByRole('button', { name: 'Anonimizar este documento' })).toHaveCount(0);
    await expect(page.getByText(AVISO_SOLO_ADMIN, { exact: true })).toBeVisible();
  });

  // ── La brecha del AC1 original, dejada como constancia ejecutable ─────────────────────────────

  test('AC1 [ROJO A PROPÓSITO] — el documento se pinta ÍNTEGRO e idéntico para los dos roles', async ({ page }) => {
    // Rojo esperado. NO documenta un defecto: documenta que el enmascarado que pedía la redacción
    // original del AC1 («los campos PII se muestran redactados o enmascarados según su rol») NO
    // existe. `Privacy.tsx:135` pinta `preview.docNumber` en claro, sin ninguna rama de rol
    // alrededor, y `:219` lo repite dentro del modal de confirmación.
    //
    // Se deja en `test.fail()` y no como un test que pase porque un test verde que dijera «el
    // documento se ve entero» normalizaría la carencia. Así, el día que alguien implemente el
    // enmascarado, este test se pondrá ROJO y obligará a reescribirlo como el AC1 de verdad.
    //
    // (Que el AC1 pedía algo inexistente se verificó y se declaró; el humano reescribió el AC en
    // ADO para que apunte al diferenciador que sí hay —la ACCIÓN de anonimizar—, cubierto por los
    // dos tests de rol de arriba.)
    test.fail();
    await entrar(page, COMPLIANCE_PRIVACY_USER);
    await mockPreview(page);

    await page.goto(OLVIDO.ruta);
    await page.getByLabel('Número de documento').fill(DOC_SINTETICO);
    await page.getByRole('button', { name: 'Previsualizar' }).click();
    await expect(page.getByText(/6 registros afectados/)).toBeVisible();

    // Lo que un enmascarado por rol implicaría: que un rol que solo CONSULTA no vea el documento
    // completo. Hoy lo ve tal cual lo tecleó, y el admin exactamente igual.
    //
    // Se afirma sobre el localizador y NO sobre `page.content()` a propósito. Este test está bajo
    // `test.fail()`, así que la aserción lanza en CADA ejecución: con `page.content()` el
    // formateador de `expect` volcaría el DOM entero al mensaje de fallo, y de ahí al informe que
    // el job nocturno sube como artefacto durante 7 días. Hoy sería inocuo —todo es sintético—,
    // pero el día que alguien apunte la suite a un backend real eso sería PII retenida. El
    // localizador falla con un conteo, no con el documento.
    await expect(
      page.getByText(DOC_SINTETICO),
      'el documento se pinta en claro: no hay enmascarado por rol',
    ).toHaveCount(0);
  });

  /**
   * Control POSITIVO del colector de errores.
   *
   * Sin este test, los de arriba comparten un punto ciego: `expect(errores).toEqual([])` es verde
   * cuando no hubo errores Y también cuando el colector no estaba escuchando —un `page.on` puesto
   * después de navegar, un cambio de API de Playwright, un filtro de tipo que deja de casar—. Aquí
   * se provocan las dos clases a propósito y se exige que las vea.
   */
  test('AC1 (canario) — el colector de errores SÍ ve un console.error y una excepción', async ({ page }) => {
    const errores = vigilarErrores(page);
    await entrar(page, COMPLIANCE_PRIVACY_USER);
    await mockLogPii(page);
    await page.goto(LOG_PII.ruta);
    await expect(page.getByRole('heading', { level: 1, name: LOG_PII.titulo, exact: true })).toBeVisible();

    await page.evaluate(() => { console.error('canario-e2e-console'); });
    await page.evaluate(() => { setTimeout(() => { throw new Error('canario-e2e-pageerror'); }, 0); });

    await expect.poll(() => errores.join('|')).toContain('canario-e2e-console');
    await expect.poll(() => errores.join('|')).toContain('canario-e2e-pageerror');
  });
});
