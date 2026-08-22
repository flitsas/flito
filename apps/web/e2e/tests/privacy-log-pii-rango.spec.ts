// Privacy — el log de accesos PII bajo filtro de rango (HU #11276, AC4 y control del AC2).
//
// ██ ESTE ARCHIVO CONTIENE CUATRO TESTS QUE FALLAN A PROPÓSITO. NO SE ROMPIERON. ██
//
// Los cuatro llevan `test.fail()` y documentan CUATRO defectos distintos de `PesvLogPii.tsx`, todos
// verificados en el código antes de escribirlos. El runner los cuenta como ÉXITO mientras el defecto
// siga vivo, así que CI queda en verde; y siguen siendo guardianes en las dos direcciones: el día
// que se corrijan y alguien olvide quitar la anotación, se pondrán ROJOS y lo dirán. Misma
// convención que `laft-unusual-error.spec.ts` (Bug #11768), que documenta el mismo patrón en LAFT.
//
// No se corrigió ninguno aquí porque es código de producción y esa decisión es del humano.
//
// ── Los cuatro defectos, con su línea ──────────────────────────────────────────────────────────
//
// La raíz de los tres primeros es el `catch` de `PesvLogPii.tsx:36-41`:
//
//     try { const r = await api.get(...); setRows(r.rows); setTotal(r.total); }
//     catch (e) { toast.error(errorMessage(e)); }
//
// No toca `rows` ni `total`. El toast dura unos segundos y se va; lo que queda en pantalla, no.
//
//   1. **Un 500 en la primera carga se lee como «no hubo accesos».** `rows` sigue en `[]` y la tabla
//      entra en su rama de vacío y escribe «Sin accesos para los filtros» (`:106`). En el log de
//      Ley 1581 art. 17 —la prueba documental de quién miró datos personales— «no pude leer el
//      registro» y «nadie accedió» son conclusiones OPUESTAS y hoy se ven idénticas. Una cierra una
//      inspección; la otra obliga a reintentar. Y no hay reintento: la única salida es recargar.
//   2. **Un 500 al cambiar el filtro deja las filas anteriores bajo el filtro nuevo.** El auditor ve
//      accesos que NO pertenecen al filtro que acaba de aplicar, sin ninguna señal de que la
//      consulta falló.
//   3. **`total` sobrevive al fallo.** El pie sigue anunciando el total de la consulta ANTERIOR
//      (`:123`), que el usuario lee como «hay N accesos que cumplen mi filtro».
//   4. **`offset` no se reinicia al filtrar, y este no involucra ningún error.** Los `onChange` de
//      `:86-96` solo tocan su campo; el `useEffect` de `:50` reacciona a `[filter, offset]` y vuelve
//      a pedir con el `offset` que hubiera. Estando en la página 2, aplicar un rango con menos de
//      100 registros manda `offset=100`, el backend responde `rows: []` CORRECTAMENTE —un 200 OK, no
//      hay nada en ese desplazamiento— y la pantalla dice que no hay accesos. Hay registros y la
//      vista lo niega, sin un error de por medio que avise. Es el peor de los cuatro justamente por
//      eso: los otros tres al menos parpadean un toast.
//
// El aserto central del cuarto lee el `URLSearchParams` de la petición y exige `offset === '0'`: la
// causa, no el síntoma. Afirmar solo sobre la pantalla lo dejaría atado a un fixture concreto.
//
// ── Y una carencia, registrada de forma ejecutable: el AC2 ─────────────────────────────────────
//
// El AC2 pedía descargar el reporte de accesos con el rango filtrado. Está RETIRADO del alcance por
// decisión del humano, porque no existe ni en la UI ni en el API:
//
//   · `PesvLogPii.tsx` no tiene control de descarga. Sus únicos botones son «← Anterior» y
//     «Siguiente →» (`:125-126`).
//   · `apps/api/src/modules/privacy/pii-access.routes.ts` publica exactamente dos rutas: `GET /`
//     (`:15`) y `GET /stats` (`:39`). No hay export, ni CSV, ni `Content-Disposition`.
//
// El test de ausencia de más abajo deja la carencia registrada para que nadie la certifique por
// error. **Se escribe con `getByRole`, nunca con `getByText`**: `PesvLogPii.tsx:92` tiene un
// `<option value="export">export</option>` —un valor del filtro de la columna `accion`, no una
// exportación— y un `getByText(/export/)` lo encontraría y daría por buena una descarga inexistente.
//
// La OTRA mitad del AC2 —«con el rango filtrado»— sí es verificable y sí se cubre: el primer test
// comprueba que las fechas del filtro llegan al API como `from`/`to`.
//
// ── Nota de montaje ────────────────────────────────────────────────────────────────────────────
//
// Los filtros de `:86-96` no tienen `<label>` ni `aria-label`; los dos `input[type=date]` no tienen
// siquiera `placeholder`. No hay nombre accesible por el que localizarlos, así que aquí se usan
// localizadores CSS. Es una carencia de accesibilidad real de la pantalla (queda declarada en el
// HANDOFF), no una preferencia de este spec.
import { test, expect } from '../helpers/fixtures';
import {
  COMPLIANCE_PRIVACY_USER, LOG_CON_FILAS, LOG_VACIO, STATS_CON_DATOS, STATS_VACIO, VACIO_LOG,
  HUELLA_FILA_READ,
  entrar, espiarApiPrivacy, mockLogPii, esperarLog, esperarLogCon, type PeticionPrivacy,
} from '../helpers/privacy-fixtures';

const RUTA = '/privacy/log-pii';
const TITULO = 'Auditoría accesos a datos personales';
/**
 * Huella del estado CARGADO: la celda «Recurso» de la fila cuya acción es `read`. Sale del fixture,
 * así que no puede aparecer por casualidad — y al ser la fila `read`, NO puede pertenecer a una
 * consulta filtrada por `accion=export` bajo ninguna respuesta correcta del backend.
 * (El `requestId` no serviría: la tabla no lo pinta.)
 */
const FILA_CARGADA = HUELLA_FILA_READ;
/** Lo que `statusToMessage` escribe ante un 5xx sin cuerpo reconocible; útil como control negativo. */
const ERROR_SINTETICO = 'Fallo sintético del log de accesos PII';

const DESDE = '2026-05-01';
const HASTA = '2026-05-31';

/** Localizadores CSS: los filtros no tienen nombre accesible (ver cabecera). */
const fechaDesde = (page: import('@playwright/test').Page) => page.locator('input[type="date"]').first();
const fechaHasta = (page: import('@playwright/test').Page) => page.locator('input[type="date"]').nth(1);
const selectAccion = (page: import('@playwright/test').Page) => page.locator('select');

/** La última petición al listado — la que corresponde al filtro recién aplicado. */
function ultimaAlListado(peticiones: PeticionPrivacy[]): PeticionPrivacy {
  const alListado = peticiones.filter((p) => p.huella.endsWith('/api/privacy/pii-access-log'));
  expect(alListado.length, 'no salió ninguna petición al listado').toBeGreaterThan(0);
  return alListado[alListado.length - 1];
}

test.describe('Privacy — log PII: el rango filtrado (HU #11276, AC4)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  // ── AC4, el camino que SÍ funciona ────────────────────────────────────────────────────────────

  test('AC4 — un rango sin registros muestra el estado VACÍO, no un error', async ({ page }) => {
    const errores: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errores.push(m.text()); });
    await entrar(page, COMPLIANCE_PRIVACY_USER);
    const peticiones = espiarApiPrivacy(page);

    // El mock responde como respondería el backend: con filas si no hay rango, y vacío dentro de un
    // rango en el que no hubo accesos. Nunca un error — el AC4 va justo de distinguir esas dos cosas.
    await mockLogPii(page, {
      log: ({ url }) => (url.searchParams.get('from')
        ? { cuerpo: LOG_VACIO }
        : { cuerpo: LOG_CON_FILAS }),
      stats: { cuerpo: STATS_CON_DATOS },
    });

    const primera = esperarLog(page);
    await page.goto(RUTA);
    await primera;
    // Punto de partida real: hay filas ANTES de filtrar. Sin esto, el vacío de después no probaría
    // nada — la vista arranca vacía y no tiene estado de carga que lo distinga.
    await expect(page.getByText(FILA_CARGADA)).toBeVisible();

    // Se espera a la consulta que lleva LAS DOS fechas: rellenar el primer `input[type=date]` ya
    // dispara una con `from` puesto y `to` vacío, y esperar «la siguiente» a secas mediría esa.
    const filtrada = esperarLogCon(page, { from: DESDE, to: HASTA });
    await fechaDesde(page).fill(DESDE);
    await fechaHasta(page).fill(HASTA);
    await filtrada;

    // 1 · El rango llegó al API como `from`/`to`. Esta es la mitad verificable del AC2 («con el
    //     rango filtrado») y la premisa del AC4: sin ella el vacío sería el de otra consulta.
    const ultima = ultimaAlListado(peticiones);
    expect(ultima.params.from, 'la fecha «desde» no llegó al API').toBe(DESDE);
    expect(ultima.params.to, 'la fecha «hasta» no llegó al API').toBe(HASTA);

    // 2 · Y la pantalla dice VACÍO, que es lo que el AC4 exige…
    await expect(page.getByText(VACIO_LOG)).toBeVisible();
    await expect(page.getByText(FILA_CARGADA)).toHaveCount(0);
    // 3 · …y no un error: ni el mensaje del backend ni el genérico de `statusToMessage` aparecen.
    await expect(page.getByText(ERROR_SINTETICO)).toHaveCount(0);
    await expect(page.getByText('Error del servidor — intente más tarde')).toHaveCount(0);
    expect(errores, 'el vacío del rango dejó errores en consola').toEqual([]);
  });

  // ── AC2 — control de AUSENCIA de la descarga ──────────────────────────────────────────────────

  test('AC2 [CARENCIA REGISTRADA] — la vista NO ofrece descarga del reporte de accesos', async ({ page }) => {
    await entrar(page, COMPLIANCE_PRIVACY_USER);
    await mockLogPii(page);

    const carga = esperarLog(page);
    await page.goto(RUTA);
    await carga;
    await expect(page.getByRole('heading', { level: 1, name: TITULO, exact: true })).toBeVisible();
    await expect(page.getByText(FILA_CARGADA)).toBeVisible();

    // Por ROL, nunca por texto: `:92` tiene un `<option value="export">` que es un valor del filtro
    // de la columna `accion`. Un `getByText(/export/)` lo encontraría y certificaría una exportación
    // que no existe.
    const nombre = /descarg|export|csv|xlsx|reporte|informe/i;
    await expect(page.getByRole('button', { name: nombre })).toHaveCount(0);
    await expect(page.getByRole('link', { name: nombre })).toHaveCount(0);
    // Control de que el localizador SABE encontrar botones en esta pantalla: los dos que sí hay.
    await expect(page.getByRole('button', { name: /Anterior|Siguiente/ })).toHaveCount(2);

    // Cuando se implemente la descarga, este test se pondrá ROJO. Es intencionado: obliga a
    // sustituirlo por el AC2 de verdad en vez de dejar la carencia certificada por inercia.
  });

  // ── Los cuatro defectos ───────────────────────────────────────────────────────────────────────

  test('AC4 [ROJO A PROPÓSITO · defecto 1/4] — un 500 en la primera carga se pinta como estado VACÍO', async ({ page }) => {
    // Rojo esperado: documenta el defecto 1 (ver cabecera). `test.fail()` mantiene CI en verde y
    // sigue siendo guardián: se pondrá ROJO el día que se corrija y no se quite esto.
    test.fail();
    await entrar(page, COMPLIANCE_PRIVACY_USER);
    const peticiones = espiarApiPrivacy(page);
    await mockLogPii(page, {
      log: { status: 500, cuerpo: { error: ERROR_SINTETICO } },
      stats: { cuerpo: STATS_VACIO },
    });

    const carga = esperarLog(page);
    await page.goto(RUTA);
    await carga;
    await expect(page.getByRole('heading', { level: 1, name: TITULO, exact: true })).toBeVisible();
    // El 500 salió DE VERDAD: si el mock no interceptara, el catch-all respondería `200 []` y el
    // vacío de abajo sería legítimo. Este aserto separa «falla el sensor» de «falla la pantalla».
    expect(ultimaAlListado(peticiones).huella).toBe('GET /api/privacy/pii-access-log');

    // La afirmación central: un backend caído NO puede decir «no hubo accesos a datos personales».
    await expect(
      page.getByText(VACIO_LOG),
      'un 500 se está pintando como estado VACÍO: «nadie accedió» y «no pude leer el registro» son conclusiones opuestas',
    ).toHaveCount(0);
    // Y lo que sí tendría que haber: el cuarto estado, con su mensaje y su salida.
    await expect(page.getByRole('alert')).toContainText(/no se pudo cargar|error/i);
    await expect(page.getByRole('button', { name: 'Reintentar' })).toBeVisible();
  });

  test('AC4 [ROJO A PROPÓSITO · defecto 2/4] — un 500 al filtrar deja las filas anteriores bajo el filtro nuevo', async ({ page }) => {
    // Rojo esperado: documenta el defecto 2 (ver cabecera).
    test.fail();
    await entrar(page, COMPLIANCE_PRIVACY_USER);
    await mockLogPii(page, {
      // Carga bien y falla al aplicar el filtro: el escenario real de un backend que se cae un
      // momento, y el único que enseña el defecto.
      log: ({ llamada }) => (llamada === 1
        ? { cuerpo: LOG_CON_FILAS }
        : { status: 500, cuerpo: { error: ERROR_SINTETICO } }),
      stats: { cuerpo: STATS_CON_DATOS },
    });

    const primera = esperarLog(page);
    await page.goto(RUTA);
    await primera;
    await expect(page.getByText(FILA_CARGADA)).toBeVisible();

    // Se filtra por acción `export`. La fila `conductor#9701` es de acción `read`: no puede
    // pertenecer a ese filtro bajo ninguna respuesta correcta del backend.
    const filtrada = esperarLog(page);
    await selectAccion(page).selectOption('export');
    await filtrada;

    await expect(
      page.getByText(FILA_CARGADA),
      'la consulta filtrada falló y la tabla sigue mostrando las filas del filtro anterior: el auditor lee accesos que no pertenecen al filtro que aplicó',
    ).toHaveCount(0);
  });

  test('AC4 [ROJO A PROPÓSITO · defecto 3/4] — tras un fallo, el pie sigue anunciando el total anterior', async ({ page }) => {
    // Rojo esperado: documenta el defecto 3 (ver cabecera). El total se escribe con
    // `total.toLocaleString()` (`:123`); se usa 999 a propósito, que no lleva separador de millares
    // en ninguna configuración regional y deja el aserto libre de la locale del runner.
    test.fail();
    await entrar(page, COMPLIANCE_PRIVACY_USER);
    await mockLogPii(page, {
      log: ({ llamada }) => (llamada === 1
        ? { cuerpo: { ...LOG_CON_FILAS, total: 999 } }
        : { status: 500, cuerpo: { error: ERROR_SINTETICO } }),
      stats: { cuerpo: STATS_CON_DATOS },
    });

    const primera = esperarLog(page);
    await page.goto(RUTA);
    await primera;
    await expect(page.getByText(/Total: 999/)).toBeVisible();

    const filtrada = esperarLog(page);
    await selectAccion(page).selectOption('export');
    await filtrada;

    await expect(
      page.getByText(/Total: 999/),
      'la consulta filtrada falló y el pie sigue diciendo «Total: 999»: es el total de OTRA consulta, y se lee como el del filtro actual',
    ).toHaveCount(0);
  });

  test('AC4 [ROJO A PROPÓSITO · defecto 4/4] — al filtrar no se reinicia el offset: falso vacío con 200 OK', async ({ page }) => {
    // Rojo esperado: documenta el defecto 4 (ver cabecera). Es el único de los cuatro que no
    // involucra ningún error: el backend responde correctamente y la pantalla igual miente.
    test.fail();
    await entrar(page, COMPLIANCE_PRIVACY_USER);
    const peticiones = espiarApiPrivacy(page);

    // El mock se comporta como el backend REAL: aplica el `offset` que le llega. Con el rango
    // puesto solo hay 2 accesos, así que pedir el desplazamiento 100 devuelve `rows: []` — y eso es
    // una respuesta CORRECTA, no un fallo.
    await mockLogPii(page, {
      log: ({ url }) => {
        const offset = Number(url.searchParams.get('offset') ?? '0');
        const enRango = url.searchParams.get('from') !== null;
        if (enRango) {
          return { cuerpo: { ...LOG_CON_FILAS, rows: offset === 0 ? LOG_CON_FILAS.rows : [], total: 2 } };
        }
        return { cuerpo: { ...LOG_CON_FILAS, total: 250 } };
      },
      stats: { cuerpo: STATS_CON_DATOS },
    });

    const primera = esperarLog(page);
    await page.goto(RUTA);
    await primera;
    await expect(page.getByText(/Total: 250/)).toBeVisible();

    // Se pasa a la página 2 — algo que un auditor hace a diario en un log de 250 accesos.
    const segunda = esperarLog(page);
    await page.getByRole('button', { name: /Siguiente/ }).click();
    await segunda;
    await expect(page.getByText(/página 2 de 3/)).toBeVisible();

    // Y AHORA se aplica el rango. Un filtro nuevo estrena paginación: tiene que pedir desde el
    // principio. Hoy conserva `offset=100` y se trae la nada.
    const filtrada = esperarLogCon(page, { from: DESDE, to: HASTA });
    await fechaDesde(page).fill(DESDE);
    await fechaHasta(page).fill(HASTA);
    await filtrada;

    // La CAUSA, medida sobre la petición real y no sobre el fixture: aplicar un filtro tiene que
    // reiniciar el desplazamiento.
    expect(
      ultimaAlListado(peticiones).params.offset,
      'aplicar un filtro no reinició el offset: la consulta pide un desplazamiento que pertenecía al filtro anterior',
    ).toBe('0');

    // El SÍNTOMA que ve el auditor, y la razón de que esto no sea cosmético: la tabla niega que haya
    // accesos en el rango mientras el pie afirma que hay 2. La pantalla se contradice sola, con un
    // 200 OK y sin un solo mensaje de error.
    await expect(page.getByText(VACIO_LOG)).toHaveCount(0);
    await expect(page.getByText(FILA_CARGADA)).toBeVisible();
  });
});
