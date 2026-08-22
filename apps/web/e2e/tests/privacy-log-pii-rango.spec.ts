// Privacy — el log de accesos PII bajo filtro de rango (HU #11276, AC4 y control del AC2).
//
// ██ LOS CUATRO DEFECTOS QUE ESTE ARCHIVO DOCUMENTABA ESTÁN CORREGIDOS (Bug #11772). ██
//
// Nacieron con `test.fail()`: mientras el defecto siguió vivo el runner los contaba como ÉXITO y CI
// quedaba en verde. La anotación se retiró al corregir `PesvLogPii.tsx`, que es el cierre del Bug
// #11772, y desde entonces los cuatro son guardianes en la dirección normal: si alguno de los
// cuatro arreglos se revierte, su test se pone ROJO. Comprobado por mutación, uno por uno.
//
// ── Los cuatro defectos y el arreglo que hoy los sostiene ──────────────────────────────────────
//
// La raíz de los tres primeros era el `catch` del `load`:
//
//     try { const r = await api.get(...); setRows(r.rows); setTotal(r.total); }
//     catch (e) { toast.error(errorMessage(e)); }
//
// No tocaba `rows` ni `total`. El toast dura unos segundos y se va; lo que queda en pantalla, no.
// Hoy el `catch` escribe `error`, el `tbody` tiene los cuatro estados y el pie limpia su total.
//
//   1. **Un 500 en la primera carga se leía como «no hubo accesos».** `rows` seguía en `[]` y la
//      tabla entraba en su rama de vacío y escribía «Sin accesos para los filtros». En el log de
//      Ley 1581 art. 17 —la prueba documental de quién miró datos personales— «no pude leer el
//      registro» y «nadie accedió» son conclusiones OPUESTAS y se veían idénticas. Una cierra una
//      inspección; la otra obliga a reintentar, y no había reintento: la única salida era recargar.
//      ARREGLO: `setError(...)` en el `catch`, la rama de error del `tbody` con `role="alert"` y el
//      botón `[Reintentar]`, que vuelve a llamar al `load` con el filtro y el offset vigentes.
//   2. **Un 500 al cambiar el filtro dejaba las filas anteriores bajo el filtro nuevo.** El auditor
//      veía accesos que NO pertenecían al filtro que acababa de aplicar, sin ninguna señal de que la
//      consulta hubiera fallado.
//      ARREGLO: la guarda `!loading && !error` del `rows.map` — el mismo patrón de `LaftAuditPlan`,
//      `LaftManual` y `LaftOfficer`. NO se limpia `rows` además: sería una segunda mecánica para lo
//      mismo, y la mutación demostró que con la guarda puesta nadie puede distinguirla.
//   3. **`total` sobrevivía al fallo.** El pie seguía anunciando el total de la consulta ANTERIOR,
//      que el usuario lee como «hay N accesos que cumplen mi filtro».
//      ARREGLO: el pie ENTERO —total, «página X de Y» y los dos botones— bajo la misma guarda
//      `!loading && !error` que el `tbody`. Y NO `setTotal(0)`, que fue el primer intento y está
//      mal: `Total: 0` ES «nadie accedió», o sea la afirmación que da título a este Bug. La cura
//      para un dato que no se puede afirmar no es afirmar cero, es NO AFIRMAR. Mismo defecto en
//      `LaftUnusual.tsx` y `Laft.tsx` (Bug #11768): la tabla se movió al cuarto estado y el
//      contador se quedó afirmando cero.
//   4. **`offset` no se reiniciaba al filtrar, y este no involucraba ningún error.** Los `onChange`
//      solo tocaban su campo; el `useEffect` reacciona a `[filter, offset]` y volvía a pedir con el
//      `offset` que hubiera. Estando en la página 2, aplicar un rango con menos de 100 registros
//      mandaba `offset=100`, el backend respondía `rows: []` CORRECTAMENTE —un 200 OK, no hay nada
//      en ese desplazamiento— y la pantalla decía que no hay accesos. Había registros y la vista lo
//      negaba, sin un error de por medio que avisara. Era el peor de los cuatro justamente por eso:
//      los otros tres al menos parpadeaban un toast.
//      ARREGLO: `aplicarFiltro()` — todo `onChange` de filtro hace `setOffset(0)` junto al
//      `setFilter`. Un filtro nuevo estrena paginación.
//
// El aserto central del cuarto lee el `URLSearchParams` de la petición y exige `offset === '0'`: la
// causa, no el síntoma. Afirmar solo sobre la pantalla lo dejaría atado a un fixture concreto.
//
// ── Y una carencia, registrada de forma ejecutable: el AC2 ─────────────────────────────────────
//
// El AC2 pedía descargar el reporte de accesos con el rango filtrado. Está RETIRADO del alcance por
// decisión del humano, porque no existe ni en la UI ni en el API:
//
//   · `PesvLogPii.tsx` no tiene control de descarga. Sus únicos botones son los dos de paginación,
//     «← Anterior» y «Siguiente →», más el `[Reintentar]` que solo existe en el estado de error
//     (Bug #11772). Ninguno descarga nada.
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
// ── Nota de montaje · el mock discrimina por la PETICIÓN, nunca por el número de llamada ───────
//
// `main.tsx` envuelve la app en `<React.StrictMode>`, que en dev monta, desmonta y vuelve a montar:
// el montaje de esta vista gasta DOS llamadas al listado (y dos al resumen), comprobado contando
// peticiones reales. Un mock del tipo `llamada === 1 ? filas : 500` le entrega el 500 a la SEGUNDA
// petición del montaje —que aún no lleva filtro— y no a la del filtro, que es la que el test cree
// estar midiendo. Con el defecto vivo eso no se notaba, porque el código descartaba el error; con
// la pantalla corregida el montaje termina en estado de error y el test se cae en su propio
// preámbulo. Por eso los cuatro escenarios discriminan por `url.searchParams`, que es además lo que
// documenta `mockLogPii`: responder «como respondería el backend de verdad» ante ese rango o ese
// desplazamiento.
//
// ── Nota de montaje · localizadores ────────────────────────────────────────────────────────────
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

  test('AC4 [GUARDIÁN · defecto 1/4] — un 500 en la primera carga se pinta como estado VACÍO', async ({ page }) => {
    // Guardián del defecto 1 (ver cabecera): se pone ROJO si se revierte el estado de error.
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

  test('AC4 [GUARDIÁN · defecto 2/4] — un 500 al filtrar deja las filas anteriores bajo el filtro nuevo', async ({ page }) => {
    // Guardián del defecto 2 (ver cabecera): se pone ROJO si se quita la guarda `!error` del `tbody`.
    await entrar(page, COMPLIANCE_PRIVACY_USER);
    await mockLogPii(page, {
      // Carga bien y falla al aplicar el filtro: el escenario real de un backend que se cae un
      // momento, y el único que enseña el defecto.
      //
      // Se discrimina por la QUERY y no por el número de llamada — ver «El montaje discrimina por
      // la petición» en la cabecera: `<React.StrictMode>` monta dos veces en dev, así que el
      // montaje gasta DOS llamadas y un `llamada === 1` le entregaría el 500 a la segunda del
      // montaje, no a la del filtro.
      log: ({ url }) => (url.searchParams.get('accion') === 'export'
        ? { status: 500, cuerpo: { error: ERROR_SINTETICO } }
        : { cuerpo: LOG_CON_FILAS }),
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

  test('AC4 [GUARDIÁN · defecto 3/4] — tras un fallo, el pie sigue anunciando el total anterior', async ({ page }) => {
    // Guardián del defecto 3 (ver cabecera): se pone ROJO si se quita el `setTotal(0)` del `catch`.
    // El total se escribe con `total.toLocaleString()`; se usa 999 a propósito, que no lleva
    // separador de millares en ninguna configuración regional y deja el aserto libre de la locale.
    await entrar(page, COMPLIANCE_PRIVACY_USER);
    await mockLogPii(page, {
      // Por la QUERY y no por el número de llamada, por el mismo motivo que el defecto 2/4.
      log: ({ url }) => (url.searchParams.get('accion') === 'export'
        ? { status: 500, cuerpo: { error: ERROR_SINTETICO } }
        : { cuerpo: { ...LOG_CON_FILAS, total: 999 } }),
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

    // Y que el 999 se vaya NO basta, que fue el primer intento de arreglo de este Bug: sustituirlo
    // por `Total: 0` cambia una afirmación falsa por otra, y encima por LA del título del Bug —
    // «Total: 0» ES «nadie accedió». Bajo el cartel de error el pie no puede afirmar NINGÚN total.
    await expect(
      page.getByText(/Total:/),
      'bajo el cartel de error el pie sigue afirmando un total: si dice «Total: 0» está diciendo «nadie accedió a estos datos personales», que es justo lo que el fallo NO permite concluir',
    ).toHaveCount(0);
    // Los dos botones se van con él: su `disabled` se calcula sobre `total`, así que bajo un fallo
    // ofrecen una paginación que no describe ningún resultado.
    await expect(
      page.getByRole('button', { name: /Anterior|Siguiente/ }),
      'bajo el cartel de error sigue habiendo paginación, y pagina sobre el total de otra consulta',
    ).toHaveCount(0);
    // Control de que el localizador SÍ sabe ver el pie cuando lo hay: el cuarto estado está puesto.
    await expect(page.getByRole('button', { name: 'Reintentar' })).toBeVisible();
  });

  test('AC4 [GUARDIÁN · defecto 4/4] — al filtrar no se reinicia el offset: falso vacío con 200 OK', async ({ page }) => {
    // Guardián del defecto 4 (ver cabecera): se pone ROJO si `aplicarFiltro` deja de reiniciar el
    // offset. Es el único de los cuatro que no involucra ningún error: el backend responde
    // correctamente y la pantalla igual mentía.
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
