## Qué es

Pantalla **Integración con Siigo**: con qué usuario se conecta FLITO a Siigo en cada ambiente (pruebas y producción) para la **emisión electrónica**. Es la pantalla del entorno, no la del día a día: se abre al conectar pruebas, al conectar producción y cuando Siigo rota una llave. La access key se cifra al guardar y no se puede volver a consultar desde aquí.

## Para quién

Quien tenga la página **Facturación electrónica — Credenciales**. De partida, solo el Administrador; se reparte desde **Roles y permisos**. Consultar, registrar, probar y desactivar requieren además el permiso de administración de Siigo (de partida, el Administrador; se reparte desde **Roles y permisos**): si a un usuario se le da la página sin ese permiso, entra, pero la pantalla le dice que su usuario no tiene permiso para ver las credenciales.

## Cómo se entra

En el menú lateral, sección **Administración**, ítem **Integración con Siigo**. También desde este capítulo de la ayuda, con **Ir a la pantalla**. Distíngala de **Credenciales RNDC**, que vive en la sección RNDC y es otra integración, y de **Facturación electrónica · Parametrización** y **Operación**, que están en Finanzas.

## Pasos

1. Entre a **Integración con Siigo**. Usted verá una tarjeta por ambiente con su estado: **Activa** o **Sin configurar**. La tarjeta con credencial activa muestra **Usuario**, **Access key** (oculta), **Versión de llave**, **Registrada** y **Notas**.
2. Para conectar un ambiente, pulse **Registrar nueva credencial** (o **Registrar otra credencial** si ya hay una activa). Escriba el usuario y la access key (**Mostrar** / **Ocultar** la deja ver mientras escribe) y, si quiere, una nota para recordar de qué cuenta es; no escriba ahí la clave. Pulse **Guardar y cifrar** (el botón pasa a **Guardando…**). En producción, el formulario le recuerda que desde que guarde es la credencial con la que FLITO emitirá facturas ante la DIAN.
3. Para comprobar que la credencial activa funciona, pulse **Probar conexión** (mientras tanto dice **Probando…**); la tarjeta le muestra el resultado. Si hizo demasiadas pruebas seguidas, espere un minuto antes de repetir.
4. Para retirar una credencial, pulse **Desactivar** y confírmelo en el diálogo (**Desactivando…** mientras se aplica). El registro no se borra: queda en el historial de ese ambiente con la fecha del día. Mientras no registre otra, FLITO no podrá conectarse a Siigo en ese ambiente.
5. Al terminar una acción, un aviso en la parte superior le confirma lo que pasó. Las credenciales anteriores están en **Historial de este ambiente (N)**, que se abre y se cierra, con **Usuario**, **Estado**, **Llave**, **Registrada** y **Desactivada**.
6. Si lo que usted necesita son las credenciales del RNDC, vaya al menú **RNDC**, ítem **Credenciales RNDC**. No es esta pantalla.

## Estados

- Cargando: dos tarjetas grises y el texto **Consultando las credenciales configuradas…**.
- Error: una banda roja con el mensaje y **Reintentar**. Si su usuario no tiene permiso, la banda lo dice y no ofrece reintentar, porque fallaría igual. Con error no se dibuja ninguna tarjeta, para no invitarle a registrar encima de una credencial que quizá sí existe.
- Vacío: la tarjeta del ambiente dice **Sin configurar** y **En este ambiente no hay credenciales.**, con lo que eso implica (en producción, que ninguna factura puede emitirse ante la DIAN hasta que registre una).
- Lleno: las dos tarjetas con su credencial activa y su historial. Si falta la llave maestra de cifrado del servidor, encima aparece **No se pueden registrar credenciales**: es un problema del entorno, no de sus datos, y lo resuelve quien administra el servidor.

## Qué no hace

- No muestra la access key guardada: una vez cifrada, no se puede volver a consultar.
- No borra credenciales: desactivar las deja en el historial.
- No es **Credenciales RNDC**.
- No sustituye a **Facturación electrónica · Parametrización** ni a **Operación**, ni es un alias de ellas.
- No **Factura** liquidaciones ni hace **emisión electrónica**: solo guarda con qué usuario se conecta FLITO.
