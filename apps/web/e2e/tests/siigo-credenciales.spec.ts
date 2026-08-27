// Siigo — administrar credenciales de la integración (HU #11890). TCs 01-13, 16, 17 y 18.
//
// El backend de esta HU YA EXISTE y no se toca: `apps/api/src/modules/siigo/credenciales.routes.ts`
// y `credenciales.service.ts`. Los fixtures copian su contrato real (ver `helpers/siigo-fixtures.ts`),
// así que lo que este spec prueba es la PANTALLA contra el backend que hay, no contra uno imaginado.
//
// ── Qué se le exige a la pantalla y por qué así ─────────────────────────────────────────────────
//
// 1. **Los cuatro estados se leen por su rol accesible.** `role="status"` con `aria-busy` para la
//    carga, `role="alert"` con «Reintentar» para el error, un texto propio para el vacío y la tabla
//    para el lleno. No es una invención de este spec: es el contrato ya establecido del repo
//    (`flito-comparendos-cascaron.spec.ts`, `flito-comparendos-pills-config.spec.ts`). Y es lo que
//    hace que «se distinguen los cuatro estados» (AC6) sea comprobable en vez de opinable.
//
// 2. **Los controles se localizan por su nombre accesible con expresión regular.** El copy exacto lo
//    decide el `ux-agent` en paralelo; que exista un campo alcanzable por su label y un botón con
//    nombre, no — es literalmente la segunda mitad del AC6.
//
// 3. **El enlace de navegación se busca por HREF**, nunca por su etiqueta (AC7): el enunciado pide
//    que la página sea alcanzable, no que el enlace se llame de una forma.
//
// 4. **Las ausencias se afirman con su gemelo positivo al lado.** «El access key no aparece» y «no
//    sale ninguna petición» se cumplen solos en un test roto, así que cada uno tiene su gemelo en
//    este mismo archivo, con los mismos helpers: si el fixture deja de montar o el glob se escribe
//    mal, el positivo se pone rojo y delata que el negativo pasaba por vacío.
//
// ── Estado esperado hoy (2026-08-26) ────────────────────────────────────────────────────────────
// La pantalla NO existe todavía: estos TCs se escribieron en modo A, antes de la implementación, y
// deben fallar en rojo por «no existe la ruta» hasta que el `frontend-agent` la construya. Ninguno
// está escrito de forma que pueda pasar sin pantalla — eso sería certificar humo.
import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER, FINANCIERA_USER, AUDITOR_USER } from '../helpers/auth';
import {
  ACCESS_KEY_ENMASCARADA, CODIGOS_DIAGNOSTICO, COMPONENTE, RUTA_API, RUTA_PAGINA,
  abrirFormulario, abrirHistorial, alerta, botonGuardar, botonProbar, botonRegistrar,
  botonReintentar, campoAccessKey, campoNotas, campoUsuario, capturarConsola, cargando, credencial,
  enlaceEnNavegacion, espiar, leerAlmacenamiento, leerConsola, modal, montarApiSiigo, reposo,
  veredicto,
} from '../helpers/siigo-fixtures';

/** Access key sintético del camino feliz. Ni una credencial real entra en un spec (AGENTS.md §14). */
const CLAVE_FIXTURE = 'CLAVE-SINTETICA-DE-FIXTURE-01';
/** Centinela del TC-05: irrepetible, para poder contar sus apariciones sin falsos positivos. */
const CENTINELA = 'QA-SENTINEL-7f3a91cbd2';

/**
 * La fila de una credencial, por el usuario que la identifica. Se admite tabla o lista: las dos son
 * estructuras semánticas legítimas; una sopa de `div` sin rol no lo es, y ahí este localizador
 * falla, que es lo correcto para el AC6.
 */
function fila(page: Page, username: string): Locator {
  return page.getByRole('row').filter({ hasText: username })
    .or(page.getByRole('listitem').filter({ hasText: username }));
}

const INACTIVA = /inactiv|desactivad/i;

test.use({ viewport: { width: 1440, height: 900 } });

test.describe('Siigo — credenciales de la integración (HU #11890)', () => {
  // ══ AC1 — Registrar la credencial de un ambiente ══════════════════════════════════════════════

  test('TC-01 · AC1 — registrar la credencial de «pruebas» manda ese ambiente y la fila queda activa', async ({ page }) => {
    const estado = await montarApiSiigo(page, { credenciales: [] });
    await loginAs(page, ADMIN_USER);
    await page.goto(RUTA_PAGINA);

    // El alta se abre DESDE la tarjeta del ambiente: ahí es donde vive la elección de ambiente en
    // este diseño. Lo que se afirma sigue siendo lo mismo —que viaje `ambiente:'pruebas'`—.
    await abrirFormulario(page, 'pruebas');
    await campoUsuario(page).fill('qa_siigo_pruebas');
    await campoAccessKey(page).fill(CLAVE_FIXTURE);
    if (await campoNotas(page).count() > 0) await campoNotas(page).first().fill('Alta de fixture E2E');

    const getsAntes = estado.gets;
    await botonGuardar(page).click();

    // 1 · La fila aparece con el usuario registrado…
    await expect(fila(page, 'qa_siigo_pruebas')).toBeVisible();
    // 2 · …marcada como activa, no como inactiva.
    await expect(fila(page, 'qa_siigo_pruebas')).not.toContainText(INACTIVA);
    // 3 · El AMBIENTE viajó en el cuerpo. Sin esto, una pantalla con el ambiente cableado a
    //     «produccion» pintaría lo mismo y el AC1 quedaría verde escribiendo en el ambiente que no es.
    expect(estado.altas).toHaveLength(1);
    expect(estado.altas[0].ambiente).toBe('pruebas');
    expect(estado.altas[0].username).toBe('qa_siigo_pruebas');
    expect(estado.altas[0].longitudAccessKey).toBe(CLAVE_FIXTURE.length);
    // 4 · Y la pantalla RELEYÓ el listado en lugar de fabricarse la fila. Es lo que separa «la
    //     pantalla dice la verdad» de «la pantalla dice lo que ella misma acaba de escribir».
    expect(estado.gets, 'no se volvió a consultar el listado tras el alta').toBeGreaterThan(getsAntes);
  });

  test('TC-02 · AC1 — reemplazar la activa deja la anterior en el historial como inactiva, no la borra', async ({ page }) => {
    const estado = await montarApiSiigo(page, {
      credenciales: [credencial({ id: 8001, ambiente: 'pruebas', username: 'qa_siigo_vieja', activo: true })],
    });
    await loginAs(page, ADMIN_USER);
    await page.goto(RUTA_PAGINA);
    await expect(fila(page, 'qa_siigo_vieja')).toBeVisible();

    await abrirFormulario(page, 'pruebas');
    await campoUsuario(page).fill('qa_siigo_nueva');
    await campoAccessKey(page).fill(CLAVE_FIXTURE);
    await botonGuardar(page).click();

    // La nueva, activa.
    await expect(fila(page, 'qa_siigo_nueva')).toBeVisible();
    await expect(fila(page, 'qa_siigo_nueva')).not.toContainText(INACTIVA);
    // Y la ANTERIOR sigue ahí, en el historial de su tarjeta, marcada inactiva. Este es el aserto
    // que mata al mutante más
    // cómodo —pintar `data.filter(c => c.activo)`—, con el que el AC1 se veía cumplido mientras el
    // historial que el backend conserva a propósito desaparecía de la vista.
    await abrirHistorial(page, 'pruebas');
    await expect(fila(page, 'qa_siigo_vieja')).toBeVisible();
    await expect(fila(page, 'qa_siigo_vieja')).toContainText(INACTIVA);
    // Y el backend simulado hizo lo que hace el real: desactivar, no borrar.
    expect(estado.credenciales.map((c) => `${c.username}:${c.activo}`).sort())
      .toEqual(['qa_siigo_nueva:true', 'qa_siigo_vieja:false']);
  });

  test('TC-03 · AC1 — 7 caracteres de access key no salen de la pantalla; 8 sí', async ({ page }) => {
    const estado = await montarApiSiigo(page, { credenciales: [] });
    await loginAs(page, ADMIN_USER);
    await page.goto(RUTA_PAGINA);

    await abrirFormulario(page, 'pruebas');
    await campoUsuario(page).fill('qa_siigo_pruebas');

    // ── 7 caracteres: uno por debajo del `min(8)` del backend ──
    await campoAccessKey(page).fill('1234567');
    await botonGuardar(page).click();
    await reposo(page);
    expect(estado.altas, 'salió un POST con un access key de 7 caracteres').toHaveLength(0);
    // Y se dice POR QUÉ, en la superficie que un lector de pantalla anuncia: el campo queda
    // `aria-invalid` y su texto de ayuda se convierte en `role="alert"`.
    //
    // Aquí había un aserto MÁS DÉBIL —`getByText(/8|ocho/)`— y era una prueba que mentía: el texto
    // de ayuda del campo dice «Entre 8 y 500 caracteres» ANTES de fallar nada, así que se cumplía
    // sola con el formulario recién abierto. Se endurece, no se relaja.
    await expect(campoAccessKey(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(modal(page).getByRole('alert').filter({ hasText: /access key/i })).toHaveCount(1);

    // ── 8 caracteres: la frontera, del lado bueno. Sin este gemelo, un formulario que nunca envía
    //    nada dejaría el aserto de arriba en verde para siempre.
    await campoAccessKey(page).fill('12345678');
    await botonGuardar(page).click();
    await expect.poll(() => estado.altas.length, {
      message: 'con 8 caracteres el alta debería salir: la validación se pasó de estricta',
    }).toBe(1);
    expect(estado.altas[0].longitudAccessKey).toBe(8);

    // ── Y el usuario tiene su propia frontera (min 3 en el backend) ──
    await abrirFormulario(page, 'pruebas');
    await campoUsuario(page).fill('ab');
    await campoAccessKey(page).fill(CLAVE_FIXTURE);
    await botonGuardar(page).click();
    await reposo(page);
    expect(estado.altas, 'salió un POST con un usuario de 2 caracteres').toHaveLength(1);
    await expect(campoUsuario(page)).toHaveAttribute('aria-invalid', 'true');
  });

  // ══ AC2 — El access key nunca vuelve a la pantalla ════════════════════════════════════════════

  test('TC-04 · AC2 — el listado pinta el enmascarado del endpoint, no una máscara propia', async ({ page }) => {
    await montarApiSiigo(page, {
      credenciales: [credencial({ id: 8010, ambiente: 'produccion', username: 'qa_siigo_pdn' })],
    });
    await loginAs(page, ADMIN_USER);
    await page.goto(RUTA_PAGINA);

    // El valor EXACTO que devuelve el backend (`ACCESS_KEY_ENMASCARADA`), no `***` ni «últimos 4»:
    // el endpoint no manda los últimos 4 de nada, así que una pantalla que los muestre se los está
    // inventando o los está sacando de otro sitio.
    await expect(fila(page, 'qa_siigo_pdn')).toContainText(ACCESS_KEY_ENMASCARADA);
  });

  test('TC-05 · AC2 — el access key en claro no aparece en el DOM, ni en la URL, ni en la consola, ni en storage', async ({ page }) => {
    const estado = await montarApiSiigo(page, { credenciales: [] });
    await capturarConsola(page);          // antes de `loginAs`: envuelve la consola antes de la app
    await loginAs(page, ADMIN_USER);
    const espia = espiar(page, CENTINELA);
    await page.goto(RUTA_PAGINA);

    await abrirFormulario(page, 'pruebas');
    await campoUsuario(page).fill('qa_siigo_centinela');
    await campoAccessKey(page).fill(CENTINELA);
    await botonGuardar(page).click();
    await expect(fila(page, 'qa_siigo_centinela')).toBeVisible();
    await reposo(page);

    // 1 · El centinela viajó EXACTAMENTE una vez, y por donde debe: el cuerpo del POST de alta.
    //     Este es el gemelo positivo de los cuatro asertos siguientes: demuestra que el centinela
    //     existía y era detectable, así que un `not.toContain` que pase no puede estar pasando
    //     porque el valor nunca llegó a tecleares.
    expect(espia.centinelaEnCuerpo).toEqual([`POST ${RUTA_API}`]);
    // 2 · …y por ningún otro sitio de la red. Ni en la URL de una sola petición.
    expect(espia.centinelaEnUrl, 'el access key viajó dentro de una URL').toEqual([]);
    expect(page.url()).not.toContain(CENTINELA);
    // 3 · No quedó en el documento (ni en una fila optimista, ni en un atributo, ni en un `title`).
    expect(await page.content(), 'el access key en claro llegó al DOM').not.toContain(CENTINELA);
    // 4 · Ni en la consola del navegador —incluidos los `console.log(objeto)`, que `msg.text()` no
    //     sabe leer y por eso esta suite envuelve la consola desde `addInitScript`—.
    const consola = await leerConsola(page);
    expect(consola.filter((l) => l.includes(CENTINELA)), 'el access key se imprimió en consola').toEqual([]);
    // 5 · Ni guardado en el navegador: el AC2 dice «ni recibe ni GUARDA el valor en claro».
    expect(await leerAlmacenamiento(page), 'el access key quedó en localStorage/sessionStorage').not.toContain(CENTINELA);
    // 6 · Y el input quedó limpio. React pone el valor como PROPIEDAD, no como atributo, así que
    //     esto no lo cubre el `page.content()` de arriba: hay que preguntárselo al campo.
    await abrirFormulario(page, 'pruebas');
    expect(await campoAccessKey(page).inputValue()).not.toContain(CENTINELA);
    // 7 · Y lo que la fila muestra es la máscara del servidor, no lo que se tecleó.
    await expect(fila(page, 'qa_siigo_centinela')).toContainText(ACCESS_KEY_ENMASCARADA);
    expect(estado.altas[0].longitudAccessKey).toBe(CENTINELA.length);
  });

  // ══ AC3 — Probar la conexión y ver el veredicto ═══════════════════════════════════════════════

  test('TC-06 · AC3 — probar conexión manda el ambiente elegido y pinta el veredicto completo', async ({ page }) => {
    const estado = await montarApiSiigo(page, {
      credenciales: [credencial({ id: 8020, ambiente: 'pruebas', username: 'qa_siigo_pruebas' })],
      veredicto: veredicto({
        ok: true, codigo: 'ok', mensaje: 'Veredicto de fixture [ok]: token obtenido.',
        tokenObtenido: true, duracionMs: 842, username: 'qa_siigo_pruebas',
      }),
    });
    await loginAs(page, ADMIN_USER);
    await page.goto(RUTA_PAGINA);

    await botonProbar(page, 'pruebas').click();

    // 1 · El veredicto del CUERPO se pinta: mensaje, token y duración.
    await expect(page.getByText('Veredicto de fixture [ok]: token obtenido.')).toBeVisible();
    await expect(page.getByText(/842/)).toBeVisible();
    await expect(page.getByText(/token/i).first()).toBeVisible();
    // 2 · Y el ambiente ELEGIDO viajó en la petición. Si no se envía, el backend cae al ambiente de
    //     la configuración global (`credenciales.routes.ts:65-71`) y la pantalla estaría diciendo
    //     «probé pruebas» mientras el servidor probaba otra cosa. Se comprueba aparte de lo pintado
    //     a propósito: el mock NO hace eco del ambiente, así que son dos afirmaciones independientes.
    expect(estado.pruebas).toHaveLength(1);
    expect(estado.pruebas[0].ambiente).toBe('pruebas');
  });

  test('TC-07 · AC3 — un veredicto negativo con HTTP 200 se lee como veredicto, no como caída', async ({ page }) => {
    // Los SIETE códigos del diagnóstico, no solo el que se ve hoy en DEV. `probar-conexion` responde
    // 200 SIEMPRE: la pantalla que mire `res.ok` o meta la llamada en un `catch` genérico convierte
    // «Siigo rechazó tus credenciales» en «error de red», que es la confusión que el AC3 prohíbe.
    const estado = await montarApiSiigo(page, {
      credenciales: [credencial({ id: 8030, ambiente: 'pruebas', username: 'qa_siigo_pruebas' })],
    });
    await loginAs(page, ADMIN_USER);
    await page.goto(RUTA_PAGINA);

    for (const v of CODIGOS_DIAGNOSTICO) {
      estado.veredicto = v;
      await botonProbar(page, 'pruebas').click();

      // 1 · El mensaje del cuerpo, tal cual. Lleva el código dentro, así que no puede aparecer por
      //     casualidad ni confundirse con el del veredicto anterior.
      await expect(page.getByText(v.mensaje), `no se pintó el mensaje del código ${v.codigo}`).toBeVisible();
      // 2 · Y NO se pinta como el estado de error del listado: el listado cargó bien.
      await expect(alerta(page).filter({ hasText: /no se pudieron cargar/i })).toHaveCount(0);
    }

    // 3 · El positivo y el negativo se distinguen entre sí. Si la pantalla pintara los siete igual,
    //     todo lo de arriba seguiría verde y el operador no sabría si puede facturar.
    estado.veredicto = CODIGOS_DIAGNOSTICO[0];                       // ok
    await botonProbar(page, 'pruebas').click();
    await expect(page.getByText(CODIGOS_DIAGNOSTICO[0].mensaje)).toBeVisible();
    const conOk = await page.content();
    estado.veredicto = CODIGOS_DIAGNOSTICO[4];                       // credenciales_rechazadas
    await botonProbar(page, 'pruebas').click();
    await expect(page.getByText(CODIGOS_DIAGNOSTICO[4].mensaje)).toBeVisible();
    const conFallo = await page.content();
    expect(conOk, 'el veredicto bueno y el malo se pintan idénticos').not.toEqual(conFallo);

    // 4 · La desviación que el impl declaró: de `sin_credenciales` recorta SOLO la frase
    //     autorreferencial («Regístralas en Administración › Integración con Siigo»), que leída en
    //     esta pantalla manda a donde ya se está. Se comprueba con el mensaje REAL del backend
    //     (`siigo.diagnostico.service.ts:181`), no con el del fixture: lo que sobrevive tiene que
    //     salir literal. Si el recorte se comiera el mensaje entero, esto se pone rojo.
    estado.veredicto = veredicto({
      ok: false,
      codigo: 'sin_credenciales',
      tokenObtenido: false,
      username: null,
      mensaje: 'No hay credenciales de Siigo activas para el ambiente "pruebas". '
        + 'Regístralas en la administración de la integración.',
    });
    await botonProbar(page, 'pruebas').click();
    await expect(page.getByText('No hay credenciales de Siigo activas para el ambiente "pruebas".')).toBeVisible();
  });

  // P2 — deseable, no bloqueante del gate.
  test('TC-08 · AC3 (P2) — dos clics seguidos no disparan dos pruebas contra Siigo', async ({ page }) => {
    const estado = await montarApiSiigo(page, {
      credenciales: [credencial({ id: 8040, ambiente: 'pruebas', username: 'qa_siigo_pruebas' })],
      retrasoProbarMs: 1500,
    });
    await loginAs(page, ADMIN_USER);
    await page.goto(RUTA_PAGINA);

    const boton = botonProbar(page, 'pruebas');
    await boton.click();
    // Mientras vuela, el control no admite una segunda prueba (deshabilitado o `aria-busy`).
    await boton.click({ force: true, timeout: 3_000 }).catch(() => { /* deshabilitado: correcto */ });
    await reposo(page);

    expect(estado.pruebas, 'se dispararon dos diagnósticos contra Siigo con un doble clic').toHaveLength(1);
  });

  // ══ AC4 — Desactivar una credencial ═══════════════════════════════════════════════════════════

  test('TC-09 · AC4 — desactivar confirma, llama al DELETE de ESA fila y el historial sigue ahí', async ({ page }) => {
    const estado = await montarApiSiigo(page, {
      credenciales: [
        credencial({ id: 8051, ambiente: 'pruebas', username: 'qa_siigo_pruebas', activo: true }),
        credencial({ id: 8052, ambiente: 'produccion', username: 'qa_siigo_pdn', activo: true }),
      ],
    });
    page.on('dialog', (d) => { void d.accept(); });        // `window.confirm`, patrón del RNDC
    await loginAs(page, ADMIN_USER);
    await page.goto(RUTA_PAGINA);

    await fila(page, 'qa_siigo_pdn').getByRole('button', { name: /desactivar/i }).click();
    await confirmarEnModal(page, /desactivar|confirmar/i);

    // 1 · El DELETE fue al id de ESA fila. Un `desactivar(data[0].id)` cableado desactivaría la de
    //     pruebas —la primera— y todo lo demás de este test seguiría igual de verde.
    await expect.poll(() => estado.bajas).toEqual([8052]);
    // 2 · La fila sigue en pantalla, marcada inactiva: es un soft delete y el historial no se borra.
    //     Se despliega el historial de ESA tarjeta: al desactivarse, la credencial deja el bloque de
    //     la activa y pasa a la tabla de historial. Desplegarlo es navegación, no una rebaja del
    //     aserto — lo que se exige sigue siendo que la credencial EXISTA y se lea inactiva.
    await abrirHistorial(page, 'produccion');
    await expect(fila(page, 'qa_siigo_pdn')).toBeVisible();
    await expect(fila(page, 'qa_siigo_pdn')).toContainText(INACTIVA);
    // 3 · Y la otra credencial no se movió.
    await expect(fila(page, 'qa_siigo_pruebas')).not.toContainText(INACTIVA);
  });

  test('TC-10 · AC4 — cancelar no llama al DELETE, y un 404 no deja la fila desactivada en pantalla', async ({ page }) => {
    const estado = await montarApiSiigo(page, {
      credenciales: [credencial({ id: 8060, ambiente: 'pruebas', username: 'qa_siigo_pruebas', activo: true })],
    });
    let respuestaDialogo: 'aceptar' | 'cancelar' = 'cancelar';
    page.on('dialog', (d) => { void (respuestaDialogo === 'aceptar' ? d.accept() : d.dismiss()); });
    await loginAs(page, ADMIN_USER);
    await page.goto(RUTA_PAGINA);

    // ── Cancelar: ni una petición ──
    await fila(page, 'qa_siigo_pruebas').getByRole('button', { name: /desactivar/i }).click();
    await cancelarEnModal(page);
    await reposo(page);
    expect(estado.bajas, 'se desactivó una credencial que el usuario canceló').toEqual([]);
    await expect(fila(page, 'qa_siigo_pruebas')).not.toContainText(INACTIVA);

    // ── 404: la fila NO puede quedar pintada como desactivada ──
    respuestaDialogo = 'aceptar';
    estado.deleteRespuesta = { status: 404, body: { error: 'No encontrada' } };
    await fila(page, 'qa_siigo_pruebas').getByRole('button', { name: /desactivar/i }).click();
    await confirmarEnModal(page, /desactivar|confirmar/i);

    await expect.poll(() => estado.bajas).toEqual([8060]);
    // El aserto que mata la desactivación optimista: el servidor dijo que no y la pantalla no puede
    // afirmar lo contrario. Si la fila se pinta inactiva sin respaldo, el operador cree que dejó de
    // facturar por ese ambiente cuando la credencial sigue viva.
    await expect(fila(page, 'qa_siigo_pruebas')).not.toContainText(INACTIVA);
    await expect(page.getByText(/no encontrada|no se pudo desactivar/i).first()).toBeVisible();
  });

  // ══ AC5 — Falta la llave maestra ══════════════════════════════════════════════════════════════

  test('TC-11 · AC5 — sin llave maestra se advierte y guardar no sale de la pantalla', async ({ page }) => {
    const estado = await montarApiSiigo(page, { credenciales: [], llaveMaestraConfigurada: false });
    await loginAs(page, ADMIN_USER);
    await page.goto(RUTA_PAGINA);

    // 1 · Se advierte, y se nombra la causa: sin esto el operador rellena el formulario y se estrella
    //     contra un 503 que no sabe leer.
    await expect(page.getByText(/llave maestra/i).first()).toBeVisible();

    // 2 · Y el alta no se puede ni abrir: el disparador de CADA tarjeta queda deshabilitado. El
    //     mutante que este aserto mata es el cómodo: pintar el aviso y dejar el formulario operativo.
    for (const ambiente of ['pruebas', 'produccion'] as const) {
      await expect(botonRegistrar(page, ambiente)).toBeDisabled();
      // Y forzando el clic tampoco se abre: un `disabled` que solo es opacidad no cuenta.
      await botonRegistrar(page, ambiente).click({ force: true, timeout: 3_000 })
        .catch(() => { /* deshabilitado: correcto */ });
      await expect(modal(page)).toHaveCount(0);
    }
    await reposo(page);
    expect(estado.altas, 'se intentó registrar una credencial sin llave maestra').toHaveLength(0);
  });

  test('TC-12 · AC5 — el 503 de llave maestra y el 400 de datos inválidos no dicen lo mismo', async ({ page }) => {
    // Los dos son legibles desde la pantalla sin tocar `lib/api.ts`: la rama de error de `request`
    // (api.ts:239-249) construye el `ApiError` con el CUERPO completo en `rawDetails` —de ahí sale
    // `codigo: 'llave_maestra'`— y `statusToMessage` antepone el `error` del backend a su genérico.
    const estado = await montarApiSiigo(page, { credenciales: [], llaveMaestraConfigurada: true });
    await loginAs(page, ADMIN_USER);
    await page.goto(RUTA_PAGINA);

    const rellenar = async () => {
      await abrirFormulario(page, 'pruebas');
      await campoUsuario(page).fill('qa_siigo_pruebas');
      await campoAccessKey(page).fill(CLAVE_FIXTURE);
      await botonGuardar(page).click();
    };
    // Los dos avisos salen por la MISMA superficie —el RESUMEN del modal—, así que compararlos es
    // comparar lo que el administrador lee en el mismo sitio, no dos nodos elegidos a dedo.
    //
    // `form > [role="alert"]`: el resumen es hijo directo del formulario, mientras que los avisos de
    // cada campo cuelgan del `div` de su campo. Sin acotarlo, el 400 —que además marca el campo—
    // deja DOS `role="alert"` dentro del modal y el localizador rompe en modo estricto. Es la
    // estructura que el propio diseño describe: «resumen SIEMPRE, y el detalle bajo cada campo».
    const avisoDelModal = () => modal(page).locator('form > [role="alert"]');

    // ── 503: problema de ENTORNO ──
    estado.postRespuesta = {
      status: 503,
      body: { error: 'La llave maestra de cifrado (SIIGO_ENC_KEY) no está configurada.', codigo: 'llave_maestra' },
    };
    await rellenar();
    await expect(avisoDelModal()).toBeVisible();
    const textoEntorno = ((await avisoDelModal().textContent()) ?? '').trim();

    // Tras el 503, «Guardar» queda bloqueado dentro del modal (desviación declarada del impl: el
    // disparador de la tarjeta NO se bloquea, para poder reintentar cuando el entorno se arregle sin
    // recargar la página). Se cierra y se vuelve a abrir: que eso sea posible es parte de lo que se
    // comprueba aquí — si el 503 hubiera cerrado también la tarjeta, este paso se pondría rojo.
    await modal(page).getByRole('button', { name: /cancelar/i }).click();
    await expect(modal(page)).toHaveCount(0);

    // ── 400: problema de DATOS ──
    estado.postRespuesta = {
      status: 400,
      body: { error: 'Datos inválidos', details: { fieldErrors: { username: ['String must contain at least 3 character(s)'] } } },
    };
    await rellenar();
    await expect(avisoDelModal()).toBeVisible();
    const textoDatos = ((await avisoDelModal().textContent()) ?? '').trim();

    // El aserto que no se puede cumplir colapsando todo en `errorMessage(e)`: los dos textos tienen
    // que ser distintos. Un 503 de entorno leído como «revisa los datos» manda al administrador a
    // corregir un formulario que estaba bien mientras la variable de entorno sigue sin configurarse.
    expect(textoEntorno, 'el 503 de entorno y el 400 de datos se muestran con el mismo texto')
      .not.toEqual(textoDatos);
    expect(textoEntorno.toLowerCase()).toContain('llave maestra');
    // Y al revés: el de datos no puede hablar de la llave maestra. Sin esta mitad, un texto que
    // dijera las dos cosas a la vez pasaría los dos asertos y no distinguiría nada.
    expect(textoDatos.toLowerCase(), 'el 400 de datos menciona la llave maestra').not.toContain('llave maestra');
  });

  // ══ AC6 — Cuatro estados ══════════════════════════════════════════════════════════════════════

  test('TC-13 · AC6 — los cuatro estados se distinguen y el error ofrece reintentar de verdad', async ({ page }) => {
    // ── 1 · CARGANDO ── la respuesta se retiene: el estado de carga es observable porque nadie la
    //        suelta hasta que el test lo dice. Sin `waitForTimeout` en ningún punto.
    let soltar: () => void = () => {};
    const retenida = new Promise<void>((resolve) => { soltar = resolve; });
    const estado = await montarApiSiigo(page, { credenciales: [], retenerGet: retenida });
    await loginAs(page, ADMIN_USER);
    await page.goto(RUTA_PAGINA);

    const enCarga = cargando(page).first();
    await expect(enCarga).toBeVisible();
    await expect(enCarga).toHaveAttribute('aria-busy', 'true');
    // Y mientras carga NO se miente con el vacío ni con el error. Es el fallo clásico del
    // `data.length === 0 ? vacío : tabla`: el operador ve «no hay credenciales» y registra una
    // segunda encima de la que sí existía.
    await expect(alerta(page)).toHaveCount(0);
    await expect(page.getByText(/no hay credenciales|sin credenciales|ninguna credencial/i)).toHaveCount(0);

    // ── 2 · VACÍO ──
    soltar();
    await expect(page.getByText(/no hay credenciales|sin credenciales|ninguna credencial|registra la primera/i).first()).toBeVisible();
    await expect(alerta(page)).toHaveCount(0);

    // ── 3 · ERROR, con reintento que reintenta de verdad ──
    estado.getStatus = 500;
    await page.reload();
    await expect(alerta(page).first()).toBeVisible();
    await expect(cargando(page)).toHaveCount(0);

    const getsAntes = estado.gets;
    estado.getStatus = 200;
    estado.credenciales = [credencial({ id: 8070, ambiente: 'pruebas', username: 'qa_siigo_pruebas' })];
    await botonReintentar(page).click();

    // ── 4 · LLENO ── y el reintento consultó otra vez: un botón que solo limpia el error es
    //        decoración, y deja al operador pulsándolo sin que nada pase.
    await expect(fila(page, 'qa_siigo_pruebas')).toBeVisible();
    await expect(alerta(page)).toHaveCount(0);
    expect(estado.gets, 'el botón «Reintentar» no volvió a consultar el API').toBeGreaterThan(getsAntes);
  });

  // ══ AC7 — Registro de la página ═══════════════════════════════════════════════════════════════
  //
  // La primera mitad del AC7 —que exista el `PageSlug 'siigo_credenciales'`— la cierra el
  // typecheck y no un E2E: `<ProtectedRoute page="siigo_credenciales">` NO COMPILA si el slug falta
  // del union `PageSlug` de `packages/shared-types/src/permissions.ts`. Ese es el TC-15 y su comando
  // es `npm run typecheck -w apps/web`.

  test('TC-16 · AC7 — admin llega desde la navegación, monta el módulo y consulta el API', async ({ page }) => {
    await montarApiSiigo(page, {
      credenciales: [credencial({ id: 8080, ambiente: 'pruebas', username: 'qa_siigo_pruebas' })],
    });
    await loginAs(page, ADMIN_USER);
    const espia = espiar(page);
    await page.goto(RUTA_PAGINA);

    await expect(fila(page, 'qa_siigo_pruebas')).toBeVisible();
    await reposo(page);

    // 1 · La página consultó su endpoint y su módulo se descargó.
    expect(espia.alApi).toContain(`GET ${RUTA_API}`);
    expect(espia.alChunk, `no se pidió el módulo de ${COMPONENTE}`).not.toEqual([]);

    // 2 · Y es ALCANZABLE desde la navegación. Por href, no por etiqueta: el copy lo decide el
    //     `ux-agent` y el AC7 no pide una etiqueta concreta, pide una entrada que lleve allí.
    const { encontrado, seccion } = await enlaceEnNavegacion(page, RUTA_PAGINA);
    expect(encontrado, `ningún módulo del dock ofrece un enlace a ${RUTA_PAGINA}`).toBe(true);
    expect(seccion).not.toBeNull();

    await page.locator(`a[href="${RUTA_PAGINA}"]`).first().click();
    await expect(page).toHaveURL(new RegExp(`${RUTA_PAGINA}$`));
  });

  // Los dos roles que SÍ tienen los OTROS slugs de Siigo (`siigo_parametrizacion`,
  // `siigo_operacion` en `ROLE_DEFAULT_PAGES`). La mutación plausible de esta HU es copiar esa línea
  // y colar `siigo_credenciales` en una de las dos, y el backend de la ruta es `requireRole('admin')`
  // entero (`credenciales.routes.ts:16`): quien la vea, verá una pantalla que solo sabe dar 403. Los
  // dos usuarios llevan `allowedPages: []` a propósito — se ejerce el permiso REAL del rol, no un
  // comodín.
  //
  // Un test POR ROL y no un bucle dentro de uno solo: cada uno necesita su propia sesión, y la
  // página del fixture es la que trae el catch-all de `/api/**`. Abrir una pestaña con
  // `context().newPage()` la dejaba fuera de ese catch-all y la aplicación no llegaba a pintar
  // —pantalla en blanco—, que es un fallo del andamiaje y no de la guarda de permisos.
  for (const usuario of [FINANCIERA_USER, AUDITOR_USER]) {
    test(`TC-17 · AC7 — ${usuario.role} no ve la entrada ni la página`, async ({ page }) => {
      // Servido CON datos a propósito: si la guarda se saltara, el listado estaría disponible.
      await montarApiSiigo(page, {
        credenciales: [credencial({ id: 8090, ambiente: 'produccion', username: 'qa_siigo_pdn' })],
      });
      // El `as` no relaja nada de la prueba: `loginAs` infiere el tipo de su parámetro del valor por
      // defecto (`ADMIN_USER`), así que su firma solo admite usuarios con `role: 'admin'`. Es una
      // limitación PREEXISTENTE de `helpers/auth.ts` que arrastra todo el repo —`laft-acceso.spec.ts`
      // tiene el mismo error con `compliance` y `conductor`— y que nadie ve porque `tsconfig.json`
      // no incluye `e2e/`. No se corrige aquí: es un helper compartido y no es alcance de esta HU.
      await loginAs(page, usuario as unknown as typeof ADMIN_USER);
      const espia = espiar(page);
      await page.goto(RUTA_PAGINA);

      // 1 · `NoAccess` en la ruta, conservando la URL (la guarda no redirige: `NoAccess.tsx`).
      await expect(page.getByRole('heading', { name: /^No tienes acceso a/ })).toBeVisible();
      await reposo(page);
      expect(page.url()).toContain(RUTA_PAGINA);

      // 2 · Ni una petición al API de credenciales, ni siquiera una cuya respuesta se descarte: la
      //     petición ya habría salido con la cookie de sesión.
      expect(espia.alApi, `${usuario.role} consultó el API de credenciales de Siigo`).toEqual([]);
      // 3 · Y el módulo ni se descargó: la guarda está ANTES del montaje, no dentro de la página.
      expect(espia.alChunk, `${usuario.role} descargó el módulo ${COMPONENTE}`).toEqual([]);
      // 4 · Ni el usuario del fixture llegó al documento.
      expect(await page.content()).not.toContain('qa_siigo_pdn');
      // 5 · Y la navegación no le ofrece la entrada por ninguno de sus módulos.
      const { encontrado } = await enlaceEnNavegacion(page, RUTA_PAGINA);
      expect(encontrado, `el dock le ofrece ${RUTA_PAGINA} a ${usuario.role}`).toBe(false);
    });
  }

  // ══ Hueco de AC (P2) ══════════════════════════════════════════════════════════════════════════

  test('TC-18 · (P2, hueco de AC) — la credencial con descifrado fallido se distingue de una inactiva normal', async ({ page }) => {
    // Ningún AC de la HU nombra este estado, pero el contrato lo devuelve: un ciphertext que no
    // verifica DESACTIVA la credencial sola (`credenciales.service.ts:12-13`) y el listado trae
    // `descifradoFallidoEn` y `descifradoFallidoMotivo`. Sin pintarlos, el operador ve exactamente
    // lo mismo que si alguien la hubiera desactivado a mano, y la factura que no salió no tiene
    // explicación en pantalla. Queda como P2 y escalado al PO, no como Bug (estamos en desarrollo).
    await montarApiSiigo(page, {
      credenciales: [
        credencial({ id: 8101, ambiente: 'pruebas', username: 'qa_siigo_a_mano', activo: false }),
        credencial({
          id: 8102, ambiente: 'produccion', username: 'qa_siigo_corrupta', activo: false,
          descifradoFallidoEn: '2026-08-20T09:15:00.000Z',
          descifradoFallidoMotivo: 'El ciphertext no verifica (motivo de fixture)',
        }),
      ],
    });
    await loginAs(page, ADMIN_USER);
    await page.goto(RUTA_PAGINA);
    // Las dos están inactivas, así que las dos viven en el historial de su tarjeta.
    await abrirHistorial(page, 'pruebas');
    await abrirHistorial(page, 'produccion');

    await expect(fila(page, 'qa_siigo_corrupta')).toContainText(/descifr|corrupt|no verifica/i);
    await expect(fila(page, 'qa_siigo_a_mano')).not.toContainText(/descifr|corrupt|no verifica/i);
  });
});

/**
 * Confirma la baja cuando la pantalla usa un modal propio en vez de `window.confirm`. Con
 * `window.confirm` el manejador de `page.on('dialog')` ya la aceptó y aquí no hay nada que hacer.
 */
async function confirmarEnModal(page: Page, nombre: RegExp): Promise<void> {
  const modal = page.getByRole('dialog');
  if (await modal.count() === 0) return;
  await modal.getByRole('button', { name: nombre }).first().click();
}

/** Gemela de la anterior para el camino de cancelar. */
async function cancelarEnModal(page: Page): Promise<void> {
  const modal = page.getByRole('dialog');
  if (await modal.count() === 0) return;
  await modal.getByRole('button', { name: /cancelar|volver|cerrar/i }).first().click();
}
