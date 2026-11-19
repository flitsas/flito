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
version: 1.2
fecha: 2026-10-22
---
## Qué es

Pantalla de campo del Mensajero: escanear las licencias de tránsito en el organismo y entregarlas firmadas en la compañía. Con señal envía al momento; sin señal encola el cambio.

## Para quién

Quien tenga el permiso de **Mi ruta**; de partida, el Mensajero (se reparte desde **Roles y permisos**). El Administrador despacha desde **Logística**; no usa esta vista como consola.

## Cómo se entra

En el menú lateral, sección **Gestión**, ítem **Mi ruta** (visible para quien tenga el permiso de **Mi ruta**; de partida, el Mensajero).

## Pasos

1. En **Recoger licencias**, pulse **Escanear LT** (o **Escanear otra LT**). Si no hay cámara, abra **Pega el contenido del código**, complete **N.º de LT (impreso bajo el código)** y pulse **Agregar**. ![Mi ruta: Recoger licencias con el contenido del código pegado, el N.º de LT escrito y el botón Agregar](./flito_logistica_ruta/01-recoger-licencias.png)
2. Cada tarjeta muestra el resultado: **Validando…**, **✓ Relacionada**, **Novedad (VIN)**, **Sin trámite**, **No gestionable**, **Ya registrada** o **Sin validar (offline)**. ![Dos tarjetas de LT: una Relacionada y otra Sin trámite con su motivo, y el botón Confirmar recogida (1)](./flito_logistica_ruta/02-resultado-validacion.png)
3. Pulse **Confirmar recogida (N)**. El lote pasa a **Registrando…**, **✓ Registrada** o **En cola**. ![La LT relacionada ya aparece como Registrada y el resumen dice 1 registrada(s)](./flito_logistica_ruta/03-confirmar-recogida.png)
4. En **Entregas**, cada acta despachada es una tarjeta con la empresa, la dirección y sus licencias. Pulse **Entregar**, capture **Nombre del receptor**, **Documento del receptor** y **Firma del receptor**; si quiere, **Adjuntar foto (opcional)**. Pulse **Confirmar entrega**: el equipo pide la ubicación de la entrega. ![Acta por entregar abierta con nombre y documento del receptor, firma trazada y el botón Confirmar entrega](./flito_logistica_ruta/04-entregar.png)
5. Si el receptor no recibe, pulse **Devolver** en la tarjeta y escriba el motivo de la devolución.
6. Sin red verá **Trabajando offline** o **Sin conexión · N cambio(s) sin sincronizar**: lo que registre queda en cola. Con señal, pulse **Reintentar** (verá **Sincronizando…**). ![Aviso Sin conexión · 1 cambio(s) sin sincronizar y una LT En cola](./flito_logistica_ruta/05-sin-conexion.png)

![Recorrido del mensajero: escanear la licencia, ver el resultado de la validación, confirmar la recogida, y en la entrega firmar con el receptor o devolver; sin señal los cambios quedan en cola hasta sincronizar](./flito_logistica_ruta/recorrido-mensajero.svg)

## Estados

- Cargando: el encabezado **Mi ruta** se ve; **Entregas** aparece al llegar la ruta.
- Error: banda roja con el mensaje. **No se reconoce el formato de la LT.** si el pegado no es válido.
- Vacío: **No tienes actas despachadas.** si aún no hay entregas.
- Lleno: tarjetas de LT recogidas y actas por entregar. Mensaje verde al guardar (**Guardado sin conexión — se enviará al recuperar señal.**).

## Qué no hace

- No lista todos los trámites de Operaciones: usted no elige el trámite; el cruce es por placa y VIN.
- No genera actas ni elige mensajero: eso es **Logística**.
- No gestiona SOAT, impuestos ni comparendos.
- De partida, el Auditor y el Administrador no tienen el permiso de **Mi ruta** (el Administrador opera la consola **Logística**); el Administrador puede repartirlo desde **Roles y permisos**.
