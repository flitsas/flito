---
resumen: Recogidas y entregas asignadas al mensajero.
palabras_clave:
  - mi ruta
  - recogidas
  - entregas
  - mensajero
consultas:
  - qué entregas tengo asignadas
  - cómo marco una recogida como hecha
version: 1.4
fecha: 2026-10-28
---
## Qué es

Pantalla de campo del Mensajero: escanear las licencias de tránsito en el organismo y entregarlas firmadas en la compañía. Con señal envía al momento; sin señal encola el cambio.

## Para quién

Quien tenga el permiso de **Mi ruta**; de partida, el Mensajero (se reparte desde **Roles y permisos**). El Administrador despacha desde **Logística**; no usa esta vista como consola.

## Cómo se entra

En el menú lateral, sección **Gestión**, ítem **Mi ruta** (visible para quien tenga el permiso de **Mi ruta**; de partida, el Mensajero).

## Pasos

1. En **Recoger licencias**, pulse **Escanear LT** (o **Escanear otra LT**) y apunte al código de barras del reverso. Si no hay cámara o el código no se lee, pulse **Ingresar a mano** y escriba la **Placa**, el **N.º de licencia de tránsito (frente)** y el **N.º de sustrato (reverso)**, que siempre empieza por **LT**. Al escribir la placa aparece **Confirma que es el vehículo** (VIN, organismo y vehículo); si dice **Esta placa no coincide con ningún trámite.**, no se puede agregar. Pulse **Agregar LT**.
2. Cada tarjeta muestra la placa, el N.º de LT y el estado: **Lista**, **Con novedad**, **Ya registrada**, **Sin trámite**, **No la recoge FLITO**, **Pendiente de trámite** o **Sin validar** (sin señal). Las ingresadas a mano llevan además **A mano**. **Ver datos** muestra VIN, licencia, combustible y propietario. Si la placa tiene varios trámites se abre **Elige el trámite**: toque el que corresponda, **No sé cuál: dejar pendiente** o **Cancelar (quitar esta LT)**.
3. Pulse **Continuar a la firma (N)**. Revise las LT por compañía (se genera 1 acta por compañía), escriba **Nombre** y **Cédula** del funcionario del organismo, haga que firme en **Firma** y pulse **Confirmar recogida**. Verá **Recogida confirmada** con las actas generadas. Para confirmar necesita señal. Si el funcionario no puede firmar, **Confirmar sin firma** deja las LT escaneadas con el acta pendiente de firma; luego pulse **Firmar acta**. Quien tenga el permiso de confirmar recogidas ve también **Mis recogidas** (cédula del funcionario enmascarada): arriba aparecen las LT **Pendientes de firma** (placa, N.º LT, compañía y organismo; «Pendiente de trámite» si Operaciones aún no elige el trámite) con el aviso **Falta firma**; márquelas y pulse **Firmar N LT** para firmarlas, y las recogidas ya firmadas muestran **Firmada**; sin ese permiso puede escanear y guardar, pero no confirmar.
4. En **Entregas**, cada acta despachada es una tarjeta con la empresa, la dirección y sus licencias. Pulse **Entregar**, capture **Nombre del receptor**, **Documento del receptor** y **Firma del receptor**; si quiere, **Adjuntar foto (opcional)**. Pulse **Confirmar entrega**: el equipo pide la ubicación de la entrega. ![Acta por entregar abierta con nombre y documento del receptor, firma trazada y el botón Confirmar entrega](./flito_logistica_ruta/04-entregar.png)
5. Si el receptor no recibe, pulse **Devolver** en la tarjeta y escriba el motivo de la devolución.
6. Sin red verá **Trabajando offline** o **Sin conexión · N cambio(s) sin sincronizar**: lo que registre queda en cola. Con señal, pulse **Reintentar** (verá **Sincronizando…**). ![Aviso Sin conexión · 1 cambio(s) sin sincronizar y una LT En cola](./flito_logistica_ruta/05-sin-conexion.png)

![Recorrido del mensajero: escanear la licencia, ver el resultado de la validación, confirmar la recogida, y en la entrega firmar con el receptor o devolver; sin señal los cambios quedan en cola hasta sincronizar](./flito_logistica_ruta/recorrido-mensajero.svg)

## Estados

- Cargando: el encabezado **Mi ruta** se ve; **Entregas** aparece al llegar la ruta.
- Error: banda roja con el mensaje; en la tarjeta o en el paso de firma, un aviso con **Reintentar**.
- Vacío: **Aún no has escaneado licencias.** en la recogida; **No tienes actas despachadas.** si aún no hay entregas.
- Lleno: tarjetas de LT recogidas y actas por entregar. Mensaje verde al guardar (**Guardado sin conexión — se enviará al recuperar señal.**).

## Qué no hace

- No lista todos los trámites de Operaciones: usted no elige el trámite; el cruce es por placa y VIN.
- No genera actas ni elige mensajero: eso es **Logística**.
- No gestiona SOAT, impuestos ni comparendos.
- De partida, el Auditor y el Administrador no tienen el permiso de **Mi ruta** (el Administrador opera la consola **Logística**); el Administrador puede repartirlo desde **Roles y permisos**.
