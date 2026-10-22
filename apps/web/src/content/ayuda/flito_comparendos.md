---
resumen: Lo que SIMIT y los municipios reportan de los NIT vigilados.
palabras_clave:
  - comparendos
  - SIMIT
  - multas
  - NIT vigilados
consultas:
  - cómo consulto los comparendos de una empresa
  - qué reporta SIMIT de un NIT
version: 1.1
fecha: 2026-10-22
---
## Qué es

Monitoreo de lo que SIMIT y los municipios reportan de los NIT vigilados (**Comparendos monitoreados**). Los datos de fuente no se editan aquí: lo único que usted registra es la causal y la observación de gestión. No es el gate SIMIT de un traspaso ni un incidente PESV.

## Para quién

Administrador. El Auditor, el Proveedor, el Gestor de Impuestos y el Mensajero no tienen esta pantalla por defecto.

## Cómo se entra

En la barra de navegación al pie de la pantalla, pulse **Gestión** y, en el panel que se abre, en el grupo **Comparendos**, el ítem **Comparendos**. Si la ventana es estrecha, la barra deja solo los iconos y el nombre de cada sección aparece al pasar el cursor por encima; en pantallas pequeñas, use el botón de menú de la barra superior. También puede pulsar **Ctrl + K** (**Command + K** en Mac) y escribir «comparendos».

La pantalla tiene tres pestañas: **Registros** (el visor, la que se abre), **Sincronización** y **Configuración**.

## Pasos

1. En **Registros**, filtre con **Todos**, **Activos** o **Inactivos**, y con **Municipio**, **Fuente** y **Causal de gestión** («Sin causal asignada» es la cola de lo que falta por mirar). Para buscar uno concreto, escriba el **N.º de comparendo** (desde 3 caracteres), el **NIT monitoreado** (exacto, desde 5 dígitos) o la **Placa** (exacta) y pulse **Buscar**; **Limpiar** quita la búsqueda. El NIT y la placa no viajan solos al escribir.

   ![Pestaña Registros con los filtros, la búsqueda por número, NIT o placa y la tabla de comparendos](./flito_comparendos/01-registros.png)

2. Pulse el número de un comparendo para abrir su detalle. Arriba están los **Datos de la fuente** (no se editan aquí); más abajo, en **Gestión del comparendo**, elija la causal, escriba la observación y pulse **Guardar gestión**.

   ![Detalle del comparendo con su estado, origen y los datos de la fuente](./flito_comparendos/02-detalle.png)

3. Si el visor está vacío porque aún no hay sincronización, pulse **Ir a la sincronización**.
4. En **Sincronización**, en **Sincronizar ahora**, elija el **Alcance** (**Todos los NIT activos** o **Solo estos NIT**) y pulse **Sincronizar**. No hay corrida automática. La corrida puede tardar más de un minuto; no cierre la pestaña. Debajo, el **Historial de sincronizaciones** muestra cada corrida con su estado y su resumen; **Ver detalle** abre el resultado por fuente.

   ![Pestaña Sincronización con el alcance, el botón Sincronizar y el historial de corridas completadas](./flito_comparendos/03-sincronizacion.png)

5. En **Configuración**, use **Agregar NIT** (con su alias), **Agregar municipio** y **Agregar causal**; cada fila trae sus acciones (**Editar alias**, **Desactivar**, **Eliminar**…). Al final está el **Token SIMIT** (**Guardar token**). En **Registros**, **Exportar a Excel** (arriba) se lleva el conjunto filtrado completo; el botón pasa a **Preparando el archivo…**.

   ![Pestaña Configuración con los NIT monitoreados y los municipios fuente, cada uno con sus acciones](./flito_comparendos/04-configuracion.png)

![Diagrama: Configuración, luego Sincronización, luego Registros y el detalle con causal y observación; el historial guarda cada corrida](./flito_comparendos/ciclo-monitoreo.svg)

## Estados

- Cargando: el visor muestra la espera del listado; la exportación, **Preparando el archivo…**.
- Error: avisos al fallar la búsqueda, la sincronización o la configuración.
- Vacío: el visor explica que no hay registros (y ofrece **Ir a la sincronización** cuando aplica) o que el filtro no arroja nada.
- Lleno: tabla de registros consolidados (activo o inactivo según las fuentes) y paneles de detalle. Si la tabla no cabe a lo ancho, el borde derecho se sombrea para avisar de que hay más columnas: desplácela en horizontal o use el tabulador para entrar en ella.

## Qué no hace

- No paga comparendos ni sustituye la gestión del trámite de traspaso.
- No es el pre-vuelo de un trámite ni el incidente PESV llamado comparendo.
- No **Factura** ni hace **emisión electrónica**.
- Inactivo no significa «pagado»: significa que las fuentes dejaron de reportarlo con cobertura completa.
