## Qué es

Pantalla de campo del Mensajero: escanear las licencias de tránsito en el organismo y entregarlas firmadas en la compañía. Con señal envía al momento; sin señal encola el cambio.

## Para quién

Mensajero. El Administrador despacha desde **Logística**; no usa esta vista como consola.

## Cómo se entra

En el menú lateral, sección **Gestión**, ítem **Mi ruta** (visible para el rol Mensajero). Ruta `/flito/ruta`.

## Pasos

1. En **Recoger licencias**, pulse **Escanear LT** (o **Escanear otra LT**). Si no hay cámara, abra **Pega el contenido del código**, complete **N.º de LT (impreso bajo el código)** y pulse **Agregar**.
2. Cada tarjeta muestra el resultado: **Validando…**, **✓ Relacionada**, **Novedad (VIN)**, **Sin trámite**, **No gestionable**, **Ya registrada** o **Sin validar (offline)**.
3. Pulse **Confirmar recogida (N)**. El lote pasa a **Registrando…**, **✓ Registrada** o **En cola**.
4. En **Entregas**, abra el acta despachada y pulse **Entregar**. Capture **Nombre del receptor**, **Documento del receptor** y **Firma del receptor**.
5. Si está sin red, verá **Trabajando offline** o **N cambio(s) sin sincronizar**. Con señal, **Reintentar** (o **Sincronizando…**).

## Estados

- Cargando: el encabezado **Mi ruta** se ve; **Entregas** aparece al llegar la ruta.
- Error: banda roja con el mensaje. **No se reconoce el formato de la LT.** si el pegado no es válido.
- Vacío: **No tienes actas despachadas.** si aún no hay entregas.
- Lleno: tarjetas de LT recogidas y actas por entregar. Mensaje verde al guardar (**Guardado sin conexión — se enviará al recuperar señal.**).

## Qué no hace

- No lista todos los trámites de Operaciones: usted no elige el trámite; el cruce es por placa y VIN.
- No genera actas ni elige mensajero: eso es **Logística**.
- No gestiona SOAT, impuestos ni comparendos.
- El Auditor y el Administrador no tienen esta pantalla por defecto (el Administrador opera la consola **Logística**).
