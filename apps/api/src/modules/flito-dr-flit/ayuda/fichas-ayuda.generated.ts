// ARCHIVO GENERADO — NO EDITAR A MANO (HU #13853, ADR-0027).
// Fuente: apps/web/src/content/ayuda/*.md + catalogo.ts. Regenerar con: npm run ayuda:drflit -w apps/api
// Si edita una ficha y no regenera, falla el test de deriva del API en CI.
// Autosuficiente: no importa nada del web (la imagen del API no copia apps/web).

export interface SeccionFichaAyuda {
  /** `id` del encabezado h1–h3 tal como lo emite `parseMarkdown` del web. */
  readonly ancla: string;
  readonly titulo: string;
  /** Texto plano de la sección (sin bloques de código). */
  readonly texto: string;
}

export interface FichaAyudaApi {
  readonly clave: string;
  /** PageSlug del catálogo: la ficha es visible con `pagina.<permiso>`. */
  readonly permiso: string;
  readonly etiqueta: string;
  readonly resumen: string;
  readonly version: string;
  readonly fecha: string;
  readonly palabrasClave: readonly string[];
  readonly consultas: readonly string[];
  readonly secciones: readonly SeccionFichaAyuda[];
}

export const FICHAS_AYUDA: readonly FichaAyudaApi[] = Object.freeze([
  {
    "clave": "flito_tablero",
    "permiso": "flito_tablero",
    "etiqueta": "Tablero",
    "resumen": "Retenciones, estancamientos y diferencias de operación.",
    "version": "1.2",
    "fecha": "2026-10-22",
    "palabrasClave": [
      "tablero",
      "retenciones",
      "estancamientos",
      "diferencias"
    ],
    "consultas": [
      "qué muestra el tablero",
      "dónde veo los trámites retenidos",
      "por qué un trámite está estancado"
    ],
    "secciones": [
      {
        "ancla": "que-es",
        "titulo": "Qué es",
        "texto": "Es el Tablero, la pantalla de inicio. Resume las retenciones, los estancamientos y las diferencias de la operación que el proceso por Excel y correo no dejaba ver. Las alertas operativas llevan a Gestión Trámites con el filtro ya aplicado, para que usted no rearme la búsqueda. Es de solo lectura: aquí no se ejecuta ninguna acción."
      },
      {
        "ancla": "para-quien",
        "titulo": "Para quién",
        "texto": "Quien tiene asignado el ítem Tablero en Roles y permisos: lo ve como pantalla de inicio. Los bloques de SOAT e Impuestos aparecen según las colas que usted puede ver. Si su rol tiene enlace Compañía, el tablero cuenta solo los trámites de su compañía. Con enlace Proveedor u Organismos el Tablero no está disponible."
      },
      {
        "ancla": "como-se-entra",
        "titulo": "Cómo se entra",
        "texto": "Es lo primero que ve al iniciar sesión. Para volver a él, en la barra de navegación al pie de la pantalla pulse el primer icono: sección General, ítem Tablero (en pantallas pequeñas, use el botón de menú de la barra superior). No lo confunda con Tablero ejecutivo PESV."
      },
      {
        "ancla": "pasos",
        "titulo": "Pasos",
        "texto": "Lea los cuatro indicadores: Revisiones pendientes y Fuera de ANS (cada uno dice debajo cuántos son de SOAT y cuántos de Impuestos), Diferencias de valor (pagados cuyo recibo no cuadra con lo liquidado) y Habilitados para entrega (SOAT e impuestos resueltos; falta ejecutar la entrega). Un indicador con valor en riesgo muestra el chip atención. En la segunda fila están las alertas operativas: Más de 5 días en borrador, Más de 2 días sin aprobar (ANS), SOAT solicitado sin gestión e Impuesto solicitado sin gestión. El chip Requiere atención marca las que tienen trámites. Pulse una tarjeta para abrir Gestión Trámites filtrado por esa alerta. Tablero con los cuatro indicadores arriba y las cuatro alertas operativas debajo, dos de ellas con el chip Requiere atención Más abajo, revise SOAT por estado e Impuestos por estado (Pendiente, Solicitado, Con novedad, Pagado), con el total de cada bloque. Cada bloque aparece solo si su rol puede ver esa cola; si no, el tablero lo omite y los indicadores que se parten por módulo cuentan solo el que usted ve. Bloques SOAT por estado e Impuestos por estado con el recuento de Pendiente, Solicitado, Con novedad y Pagado y el total de cada uno"
      },
      {
        "ancla": "estados",
        "titulo": "Estados",
        "texto": "Cargando: el encabezado Tablero se ve; los indicadores aún no. Error: mensaje en rojo sobre una tarjeta. Vacío: no hay un mensaje de «sin datos»; los recuentos aparecen en cero cuando no hay alertas. Lleno: cuatro indicadores, cuatro alertas operativas y los dos recuentos por estado."
      },
      {
        "ancla": "que-no-hace",
        "titulo": "Qué no hace",
        "texto": "No sincroniza trámites: FLITO los trae de FLIT y FLIT 2 solo, y el estado de esa lectura se ve en Gestión Trámites, tarjeta Sincronización. No es el listado para despachar: use Gestión Trámites. No es la cola SOAT ni Impuestos: sus bloques por estado solo cuentan. No Factura ni hace emisión electrónica. No es el Tablero ejecutivo PESV."
      }
    ]
  },
  {
    "clave": "dashboard",
    "permiso": "dashboard",
    "etiqueta": "Tablero de control",
    "resumen": "Panel operativo de inicio con los indicadores, las alertas y los atajos de los módulos que usted puede abrir.",
    "version": "1.0",
    "fecha": "2026-10-22",
    "palabrasClave": [
      "tablero de control",
      "panel operativo",
      "pantalla de inicio",
      "indicadores",
      "documentos por vencer",
      "atajos"
    ],
    "consultas": [
      "qué muestra el panel operativo",
      "qué veo al iniciar sesión",
      "por qué mi inicio no muestra indicadores",
      "dónde veo los documentos por vencer"
    ],
    "secciones": [
      {
        "ancla": "que-es",
        "titulo": "Qué es",
        "texto": "El Tablero de control es la pantalla de inicio de quien no tiene el Tablero FLITO. Arriba lo saluda con su nombre y la fecha, bajo el título Panel operativo. Reúne los indicadores de vehículos, SOAT, documentos de flota por vencer y errores de RNDC, las alertas que piden atención y atajos a Mantenimiento, RNDC y PESV. Cada bloque aparece solo si usted puede abrir la pantalla a la que lleva. Es de solo lectura: cada tarjeta lo lleva a la pantalla donde se actúa."
      },
      {
        "ancla": "para-quien",
        "titulo": "Para quién",
        "texto": "Quien tenga el ítem Tablero de control en Roles y permisos. De partida lo tienen todos los roles del sistema salvo Cliente. Lo que se ve dentro depende de los demás permisos: sin Vehículos, SOAT, Flota, RNDC, Mantenimiento ni PESV, el panel queda sin indicadores."
      },
      {
        "ancla": "como-se-entra",
        "titulo": "Cómo se entra",
        "texto": "Es lo primero que ve al iniciar sesión. Para volver a él, abra el menú General y pulse Tablero de control. Si su usuario también tiene el Tablero FLITO, al entrar a FLITO verá ese tablero en lugar del Panel operativo. Para saber cómo se usa, consulte la ficha Tablero."
      },
      {
        "ancla": "pasos",
        "titulo": "Pasos",
        "texto": "Lea el bloque Estado operativo: Vehículos (en operación), SOAT vigentes (porcentaje verificado del total), Por vencer 60d (documentos de flota) y RNDC errores (manifiestos con error de envío). A la derecha, Flota y Salud SOAT resumen lo mismo y abren su pantalla al pulsarlas. Panel operativo demo con el bloque Estado operativo, sus cuatro indicadores y las tarjetas Flota y Salud SOAT Pulse Por vencer 60d para abrir Flota en la pestaña de vencimientos. Los enlaces Ver vehículos, Tablero PESV, Rendimiento (RUM) y Métricas trámites abren esas pantallas. Revise Atención operativa: cada fila dice qué está pendiente (solicitudes SOAT pendientes de compra, documentos vencidos o por vencer en 60 días) y su botón Ir a SOAT o Ver vencimientos lo lleva a resolverlo. Debajo, los atajos Mantenimiento, RNDC, PESV y Tablero ejecutivo abren cada módulo. Atención operativa demo con una solicitud SOAT pendiente y documentos vencidos y por vencer, y la fila de atajos debajo Si un bloque dice «No pudimos cargar…», pulse Reintentar: repite solo esa consulta y los demás bloques siguen como están. Diagrama de qué ve al iniciar sesión: con el Tablero FLITO, ese tablero; con el Tablero de control, el Panel operativo; sin ninguno de los dos, la primera pantalla que su usuario puede abrir"
      },
      {
        "ancla": "estados",
        "titulo": "Estados",
        "texto": "Cargando: las cifras muestran un punto (·) mientras llegan. Error: por bloque, «No pudimos cargar…» con Reintentar. Si le quitaron el permiso de un bloque mientras lo miraba, ese bloque desaparece en vez de mostrar el error. Vacío: «Tu tablero no tiene indicadores con tus permisos actuales», con la indicación de usar el buscador (Ctrl K) o el menú para ir a sus secciones. Lleno: el bloque Estado operativo, las tarjetas de la derecha, Atención operativa cuando hay pendientes y la fila de atajos."
      },
      {
        "ancla": "que-no-hace",
        "titulo": "Qué no hace",
        "texto": "No ejecuta ninguna acción: cada indicador y cada alerta lo lleva a su pantalla. No es el Tablero de FLITO (retenciones, estancamientos y diferencias de la operación). No muestra cifras de módulos que usted no puede abrir."
      }
    ]
  },
  {
    "clave": "clients",
    "permiso": "clients",
    "etiqueta": "Clientes y proveedores",
    "resumen": "Empresas, servicios que gestiona FLITO y datos comerciales.",
    "version": "2.2",
    "fecha": "2026-10-26",
    "palabrasClave": [
      "clientes",
      "proveedores",
      "empresas",
      "servicios",
      "autogestión",
      "activos",
      "inactivos"
    ],
    "consultas": [
      "cómo creo un cliente",
      "dónde cambio los datos comerciales de una empresa",
      "qué es la autogestión",
      "qué significa marcar SOAT, Impuestos o Logística",
      "cómo elijo el proveedor de SOAT sin trámite de una compañía",
      "por qué el permiso de SOAT sin trámite no toma efecto",
      "cómo veo solo los clientes inactivos",
      "cómo desactivo un cliente",
      "cómo vuelvo a activar un cliente",
      "por qué dice que ya existe un cliente con ese NIT",
      "cómo elimino un cliente",
      "por qué no puedo eliminar un cliente",
      "cómo desactivo un proveedor de SOAT",
      "cómo vuelvo a activar un proveedor",
      "cómo veo solo los proveedores inactivos",
      "cómo elimino un proveedor de SOAT",
      "por qué no puedo eliminar un proveedor",
      "por qué dice que ya existe un proveedor con ese nombre"
    ],
    "secciones": [
      {
        "ancla": "que-es",
        "titulo": "Qué es",
        "texto": "Ficha de las compañías (clientes FLITO) con los servicios que FLITO les gestiona y sus datos comerciales, y de los proveedores de SOAT a los que se enrutan los trámites. La columna Facturación indica si la compañía está lista para una emisión electrónica posterior; no es Facturar en sentido FLITO (congelar la liquidación). Usted parametriza; no despacha."
      },
      {
        "ancla": "para-quien",
        "titulo": "Para quién",
        "texto": "Administrador (crea compañías, marca los servicios que gestiona FLITO y edita proveedores). Financiera (en gestión solo ve esta pantalla, además de finanzas). Auditor (consulta). El Proveedor y el Gestor de Impuestos no entran aquí."
      },
      {
        "ancla": "como-se-entra",
        "titulo": "Cómo se entra",
        "texto": "En la barra de navegación al pie de la pantalla, pulse Gestión y, en el panel que se abre, en el grupo Maestros, el ítem Clientes y proveedores. Si la ventana es estrecha, la barra deja solo los iconos y el nombre de cada sección aparece al pasar el cursor por encima; en pantallas pequeñas, use el botón de menú de la barra superior. También puede pulsar Ctrl + K (Command + K en Mac) y escribir «clientes»."
      },
      {
        "ancla": "pasos",
        "titulo": "Pasos",
        "texto": "Elija la pestaña Clientes o Proveedores. En Clientes, la columna Estado dice si cada compañía está Activo o Inactivo. Encima de la tabla, el filtro Estado tiene tres opciones: Todos (la de entrada), Activos e Inactivos; al pulsar una, la tabla muestra solo esas compañías y debajo se lee Mostrando X de Y (las que ve de las que hay). Si cambia de pestaña y vuelve, el filtro regresa a Todos. En Clientes, pulse Nuevo cliente, complete Nombre o razón social (obligatorio) y, si los tiene, NIT / Cédula, Sucursal (por defecto 0), Teléfono y Email, y pulse Guardar (o Cancelar). No puede haber dos clientes vigentes con el mismo NIT y la misma sucursal. En cada fila, marque SOAT, Impuestos y Logística para indicar que FLITO gestiona ese servicio para la compañía; si la casilla queda desmarcada, la compañía lo hace por su cuenta (autogestión). Debajo de la tabla, dos notas recuerdan qué significa cada casilla. Pestaña Clientes con tres compañías demo, el filtro Estado, la columna Estado, sus casillas de servicios, la columna SOAT sin trámite y el chip de Facturación Al final de las casillas, la columna SOAT sin trámite dice a qué proveedor salen las solicitudes de SOAT que los usuarios Cliente de esa compañía hacen sin un trámite abierto: el nombre del proveedor (por ejemplo, Aseguradora Demo Uno), el nombre seguido de (inactivo) si ese proveedor está desactivado, o Sin proveedor. Si su usuario tiene la acción Elegir proveedor de SOAT sin trámite (se reparte desde Roles y permisos), púlselo para abrir el cuadro SOAT sin trámite · (compañía), elija en Proveedor de SOAT sin trámite un proveedor activo o Sin proveedor, y pulse Guardar. Los proveedores desactivados aparecen en la lista con (Inactivo), apagados, y no se pueden elegir; si la compañía ya tenía uno que luego se desactivó, el cuadro lo conserva con esa marca y puede guardar sin cambiarlo. Con Sin proveedor, los usuarios de la compañía no pueden solicitar SOAT sin trámite. Si el cuadro muestra Tiene usuarios con permiso de SOAT sin trámite, pero no tiene proveedor elegido: el permiso no toma efecto hasta elegirlo., elija un proveedor para que ese permiso sirva. Es independiente de la casilla SOAT: marcar o desmarcar una no cambia la otra. Sin esa acción, la columna se lee pero no se cambia. Cuadro SOAT sin trámite de una compañía con la lista Proveedor de SOAT sin trámite Desplace la tabla a la derecha para ver las acciones de la fila. Pulse Tarifas para ir al configurador de valores de esa compañía (en Finanzas, Tarifas), con la compañía ya elegida; el botón solo lo ven quienes entran a esa pantalla. Pulse Datos fiscales para los datos de emisión electrónica. El chip de la columna Facturación (Lista, Por clasificar o Faltan con el número de datos que faltan) resume si la compañía puede emitirse después. Para sacar de operación a una compañía, o volver a ponerla, pulse el botón ⋮ al final de su fila (solo lo ve el Administrador, que tiene la acción Activar o desactivar clientes o Eliminar clientes). Si la compañía está Activo, el menú ofrece Desactivar; si está Inactivo, Activar. También puede abrirlo con el teclado (Intro, Espacio o las flechas) y cerrarlo con Esc. Desactivar abre el cuadro Desactivar «(compañía)», que primero revisa lo que la compañía tiene abierto y lo dice, por ejemplo Este cliente tiene 3 SOAT, 2 trámites en curso. (o No tiene procesos en curso.). Mientras esté inactivo no recibirá SOAT, impuestos ni trámites nuevos, y si tiene usuarios se cerrará su sesión. Pulse Desactivar para confirmar o Cancelar para dejarla como estaba. Al terminar verá Cliente desactivado. y la fila pasa a Inactivo. En una compañía Inactivo, Activar (desde el mismo ⋮) abre el cuadro Activar «(compañía)»: vuelve a recibir SOAT, impuestos y trámites, y se liberan los trámites que quedaron retenidos mientras estuvo inactiva. Pulse Activar; verá Cliente activado. y la fila pasa a Activo. Para quitar una compañía de FLITO, pulse ⋮ en su fila y elija Eliminar (al final del menú, separada por una línea; solo con la acción Eliminar clientes). Al abrir el menú, FLITO comprueba si se puede eliminar y, mientras tanto, bajo Eliminar se lee Comprobando…. Si no se puede, la opción aparece apagada y debajo dice por qué: Primero debe desactivarlo. (si sigue Activo), los procesos que tiene abiertos, o Su bolsa tiene saldo de $150.000; debe quedar en cero. (con el saldo real). Con el teclado, llegue a ella con las flechas y el motivo se lee igual. Si se puede, Eliminar abre el cuadro Eliminar «(compañía)»: Dejará de aparecer en FLITO. Su historial se conserva. No se puede deshacer. Pulse Eliminar para confirmar o Cancelar. Verá Cliente eliminado. y la compañía desaparece de la tabla con cualquier filtro. En Proveedores, la columna Estado dice si cada proveedor está Activo o Inactivo, y encima de la tabla está el mismo filtro Estado (Todos, Activos, Inactivos) con Mostrando X de Y debajo. Nuevo proveedor (o Editar en la fila): Nombre, Estrategia, Umbral OCR (0–1) y ANS pactado con el proveedor (horas). Guardar. El estado ya no se cambia aquí, sino con el ⋮ de la fila. El ANS de gestión es único para toda la operación: estas horas quedan como referencia de lo pactado. Pestaña Proveedores con dos gestores demo, el filtro Estado, su estado, estrategia, umbral OCR, ANS pactado y el botón Editar Para sacar de operación a un proveedor, o volver a ponerlo, pulse ⋮ al final de su fila (solo lo ve el Administrador, con la acción Activar o desactivar proveedores). Si está Activo, el menú ofrece Desactivar: el cuadro Desactivar «(proveedor)» dice lo que tiene en curso, por ejemplo 4 SOAT en curso, proveedor de SOAT sin trámite de 2 compañías. (o No tiene procesos en curso.). Mientras esté inactivo, sus usuarios no podrán ingresar a FLITO y no aparecerá entre los proveedores a elegir; si tiene usuarios, se cerrará su sesión. Pulse Desactivar; verá Proveedor desactivado. y la fila pasa a Inactivo. Si está Inactivo, Activar abre Activar «(proveedor)»; pulse Activar y verá Proveedor activado. Para quitar un proveedor de FLITO, pulse ⋮ en su fila y elija Eliminar (al final del menú, separada por una línea; solo con la acción Eliminar proveedores). Al abrir el menú, FLITO comprueba si se puede eliminar y, mientras tanto, bajo Eliminar se lee Comprobando…. Si no se puede, la opción aparece apagada y debajo dice por qué: Primero debe desactivarlo. (si sigue Activo), Tiene 4 SOAT en curso. (con el número real) o Es el proveedor de SOAT sin trámite de 2 compañías (Alfa, Beta). (con las compañías reales: elija otro proveedor para ellas en la columna SOAT sin trámite de Clientes). Si se puede, Eliminar abre el cuadro Eliminar «(proveedor)»: Dejará de aparecer en FLITO. Su historial se conserva. No se puede deshacer. Pulse Eliminar para confirmar o Cancelar. Verá Proveedor eliminado. y el proveedor desaparece de la tabla con cualquier filtro. Su nombre queda libre para un proveedor nuevo. Diagrama: en el cuadro se elige el proveedor de SOAT sin trámite; con Sin proveedor nadie de la compañía puede solicitar; con un proveedor activo, las solicitudes nuevas salen a él; si el proveedor está inactivo, quedan Gestionado por Operaciones"
      },
      {
        "ancla": "estados",
        "titulo": "Estados",
        "texto": "Cargando: Cargando compañías… mientras llega el listado de clientes; Cargando proveedores… en el listado de proveedores. Error: si el listado de compañías no llega, No pudimos cargar los clientes. (o No pudimos cargar los proveedores.) con Reintentar sobre la tarjeta; además, aviso al fallar el guardado (el listado no se cae si falla el informe de facturación). NIT repetido: si al guardar un cliente nuevo, o los datos fiscales de uno existente, ya hay otro cliente vigente con ese NIT y esa sucursal, bajo el campo del NIT se lee Ya existe un cliente con el NIT (número) y sucursal (número)., el cursor queda en ese campo y el formulario conserva lo escrito. Corrija el NIT o cambie la sucursal y vuelva a guardar: el aviso se quita en cuanto cambia cualquiera de los dos. Nombre de proveedor repetido: si al crear o renombrar un proveedor ya hay otro vigente con ese nombre, bajo el campo Nombre se lee Ya existe un proveedor SOAT con el nombre (nombre)., el cursor queda en ese campo y el formulario conserva lo escrito. El aviso se quita en cuanto cambia el nombre. Si el guardado falla por otra causa, el formulario sigue abierto y dice qué pasó (por ejemplo, No pudimos guardar el proveedor. Inténtelo de nuevo.). Si el guardado del cliente falla por otra causa, un aviso que puede cerrar dice No pudimos guardar el cliente. Intenta de nuevo. y el formulario sigue abierto. Vacío: No hay clientes. (si puede crearlos, añade Cree el primero con «Nuevo cliente».) / No hay proveedores. (si puede crearlos, añade Cree el primero con «Nuevo proveedor».) Vacío del filtro: si hay compañías (o proveedores) pero ninguno con el filtro elegido, No hay registros con este filtro. con Ver todos, que vuelve a Todos. No es un error. Lleno: tabla Empresa, Estado (Activo / Inactivo), Documento, Ciudad, Teléfono, Email, las casillas de servicios (SOAT, Impuestos, Logística: marcada = FLITO lo gestiona), SOAT sin trámite, Facturación y acciones. Si el proveedor de SOAT sin trámite de una compañía está desactivado, la columna lo dice —(proveedor) (inactivo)— y sus solicitudes nuevas quedan Gestionado por Operaciones. En el cuadro Desactivar, mientras revisa los procesos se lee Revisando procesos en curso… y Desactivar no se puede pulsar; si la revisión falla, No pudimos revisar los procesos en curso de este cliente. (o de este proveedor.) con Reintentar. Al confirmar Desactivar o Activar: si otro administrador ya cambió el estado, verá Otro administrador ya cambió su estado. y la fila se actualiza con el estado real; si se perdió la conexión, el cuadro dice No pudimos conectar con FLITO. Revise su conexión e inténtelo de nuevo. y el botón pasa a Reintentar (la fila no cambia); si su usuario no tiene permiso, No tiene permiso para esta acción. Al Eliminar: si la comprobación del menú falla, bajo Eliminar se lee No pudimos comprobar si se puede eliminar. Elíjala para reintentar.; al confirmar, si otro administrador ya cambió el estado, verá Otro administrador ya cambió su estado.; si se perdió la conexión, el cuadro lo dice y el botón pasa a Reintentar; sin permiso, No tiene permiso para esta acción. En ninguno de esos casos la fila cambia. La columna dice Sin proveedor cuando la compañía no tiene proveedor elegido: sus usuarios no ven Solicitar SOAT. No es un error; si la compañía lo necesita, elija un proveedor. En el cuadro de SOAT sin trámite, la lista tiene sus propios estados: Cargando proveedores…, No se pudieron cargar los proveedores. con Volver a cargar, y No hay proveedores de SOAT activos. Cree uno en la pestaña Proveedores. Mientras la lista no esté lista, Guardar no se puede pulsar. Si al guardar algo falla, el cuadro sigue abierto con su elección y le dice qué pasó (por ejemplo, Ese proveedor ya no está activo. Elija otro o «Sin proveedor».)."
      },
      {
        "ancla": "que-no-hace",
        "titulo": "Qué no hace",
        "texto": "No despacha trámites, SOAT ni impuestos: solo parametriza la compañía y el proveedor. No fija ni cambia tarifas: eso vive en Finanzas, Tarifas, a donde lleva el botón Tarifas de la fila. No Factura la liquidación de un trámite. Lista habla de emisión electrónica, no de Facturar. El filtro Estado no activa ni desactiva compañías ni proveedores: solo muestra u oculta filas. Eso se hace con el ⋮ de la fila. Desactivar no elimina: saca a la compañía de operación y puede volver a activarse. Eliminar sí la quita de FLITO (conserva su historial) y no se puede deshacer; exige que esté Inactivo, sin procesos abiertos y con la bolsa en cero. Con un proveedor pasa igual: Eliminar exige que esté Inactivo, sin SOAT en curso y sin compañías que lo tengan como proveedor de SOAT sin trámite. No es el catálogo de NIT vigilados de Comparendos (puede coincidir el NIT, pero es otro listado). Un Gestor de Impuestos o un Proveedor no administran compañías desde aquí. SOAT sin trámite solo dice a qué proveedor salen las solicitudes: no crea la solicitud ni compra el SOAT. Eso lo hace el usuario Cliente desde la cola SOAT. Cambiar el proveedor no reasigna nada de lo ya radicado: solo afecta a las solicitudes nuevas. Las que ya están en la cola conservan el proveedor que tienen. No da por sí solo el permiso de solicitar: ese se reparte en Roles y permisos. Hacen falta los dos, el proveedor y el permiso."
      }
    ]
  },
  {
    "clave": "flito_tramites",
    "permiso": "flito_tramites",
    "etiqueta": "Gestión Trámites",
    "resumen": "Cómo despachar SOAT, impuestos y entregas.",
    "version": "1.2",
    "fecha": "2026-10-22",
    "palabrasClave": [
      "trámites",
      "despachar",
      "SOAT",
      "impuestos",
      "entregas"
    ],
    "consultas": [
      "cómo despacho un trámite",
      "dónde entrego los trámites",
      "por qué no veo un trámite"
    ],
    "secciones": [
      {
        "ancla": "que-es",
        "titulo": "Qué es",
        "texto": "Centro de despacho de los trámites de FLIT: usted consulta el estado de los trámites que FLITO trae solo de FLIT y FLIT 2, y solicita SOAT e impuestos. Solo los trámites Asignados —con compañía y secretaría emparejadas— habilitan esas gestiones."
      },
      {
        "ancla": "para-quien",
        "titulo": "Para quién",
        "texto": "Administrador (opera, configura la lectura y despacha). Auditor (solo lectura). El Proveedor y el Gestor de Impuestos no entran aquí: cada uno trabaja en su propia cola."
      },
      {
        "ancla": "como-se-entra",
        "titulo": "Cómo se entra",
        "texto": "En la barra de navegación al pie de la pantalla, pulse Gestión y, en el grupo Trámites del panel que se abre, el ítem Gestión Trámites. En pantallas pequeñas, use el botón de menú de la barra superior; también puede pulsar Ctrl + K (Command + K en Mac) y escribir «trámites». También se entra desde el Tablero, al pulsar una alerta operativa (el listado llega con el filtro ya aplicado)."
      },
      {
        "ancla": "pasos",
        "titulo": "Pasos",
        "texto": "Bajo el título está la tarjeta Sincronización (los usuarios con enlace de compañía no la ven: sincronizar es una tarea interna). Aparece contraída cada vez que entra a la página y, en su cabecera, le resume cómo está cada fuente (por ejemplo, «FLIT 1: Encendida · FLIT 2: Apagada»). Si FLIT 2 necesita su atención —el acceso fue rechazado, la lectura está bloqueada, lleva más tiempo del esperado sin leer o FLIT 2 está enviando avisos con firma no válida—, junto a FLIT 2 verá Requiere atención con un ícono de advertencia. Pulse la cabecera (o use Enter o Espacio con el teclado) para desplegarla o volver a contraerla. Desplegada, tiene un grupo para FLIT 1 y otro para FLIT 2. En el grupo FLIT 1, FLITO lee FLIT 1 solo, sin que usted haga nada. Ya no hay un botón para sincronizar a mano. Junto a Última lectura verá la hora de la última lectura que salió bien. Cada noche, a las 02:00, FLITO relee un periodo más largo para recoger cambios de trámites más antiguos. Si FLIT 1 necesita su atención —falló la última lectura—, junto a FLIT 1 verá Requiere atención. En el grupo FLIT 2, los trámites llegan en tiempo real: FLIT 2 avisa a FLITO cada vez que un trámite se crea, cambia o se elimina (los borradores no entran), y FLITO lo trae en segundos. Además, FLITO hace una lectura de respaldo automática para recoger lo que haya quedado sin aviso. Junto a Conexión verá Conectado o Sin conexión (también Sin configurar o Apagada cuando aplique) y, junto a Última actualización, la hora más reciente en que llegó información de FLIT 2, por aviso o por lectura. Si dice Aún sin datos, todavía no ha llegado nada en este ambiente. Tarjeta Sincronización desplegada con los grupos FLIT 1 y FLIT 2, sus interruptores Encendida, la última lectura y los botones Parámetros de lectura y Acceso a FLIT 2 Interruptores de sincronización (solo quien tiene el permiso para configurar la sincronización; hoy, el Administrador): cada grupo tiene un interruptor Encendida / Apagada y, debajo, quién lo cambió y cuándo. FLIT 1 apagada: FLITO deja de leer FLIT 1 en este ambiente y el grupo lo dice. Al encenderla, la siguiente lectura recupera lo que faltó desde la última lectura buena. FLIT 2 apagada: FLITO deja de leer trámites nuevos de FLIT 2. Si había una lectura en curso, termina la página actual y se detiene. Al encenderla, la lectura sigue donde quedó. Mientras una fuente está apagada no entra nada de ella; lo que ya entró no cambia. Apagar pide confirmación; encender, no. El cambio se guarda para todos los usuarios del ambiente y verá Guardando… hasta que el servidor lo confirme. Lectura automática apagada en el servidor: si quien administra el ambiente apagó la lectura de FLIT 2 en el servidor, el grupo lo avisa y el interruptor no tiene efecto hasta que la enciendan allí, aunque usted lo vea Encendida. Parámetros de lectura (mismo permiso): en el grupo FLIT 1, pulse el botón Parámetros de lectura; se abre una ventana a la derecha donde ajusta Frecuencia (minutos) (cada cuánto lee), Ventana (días) (cuántos días hacia atrás revisa cada lectura), Ventana nocturna (días) (cuántos días relee cada noche; no puede ser menor que la ventana) y Fecha de arranque (FLITO no lee trámites anteriores a esa fecha). Debajo de cada campo verá su rango. Pulse Guardar parámetros: la ventana se cierra, verá un mensaje de confirmación y FLITO los usa desde la próxima lectura, sin reiniciar nada. Si un valor está fuera de rango, el campo le dice el motivo y no se guarda. Si el guardado falla, la ventana sigue abierta con lo que escribió y le ofrece Reintentar. Para salir sin guardar, cierre la ventana con la X o con Esc; los cambios no guardados se descartan. El botón solo aparece si su perfil puede configurar la sincronización. Sin ese permiso, usted no ve los interruptores ni puede cambiar los parámetros, pero cada grupo le dice en texto si la fuente está encendida o apagada; pídale a un administrador si hay que cambiarla. Busque por placa, VIN, id o comprador, o use Recién llegados sin gestionar. Filtre por Todas, Autogestionadas o No autogestionadas. La columna Fuente indica si el trámite llegó de FLIT o de FLIT 2; el filtro Fuente (Todas, FLIT, FLIT 2) muestra solo los de un sistema, y Limpiar filtros lo devuelve a Todas. No necesita recargar la página: si mientras trabaja llegan trámites nuevos de FLIT o FLIT 2 que cumplen sus filtros, o cambia alguno de los que está viendo, sobre la tabla aparece un aviso como Hay 3 trámites nuevos o Hay trámites actualizados. La tabla no se mueve hasta que usted pulse Ver; al hacerlo se actualiza con los mismos filtros, orden y página, y conserva los trámites que tenía marcados. Buscador, filtros de vista, fechas, autogestión y fuente sobre la tabla de trámites con su fuente, vehículo, comprador, empresa, tránsito y estado del SOAT Marque los trámites que necesite: la casilla ya no se limita a los Asignados, así que también puede marcar los ya entregados para llevarse sus soportes. Si ve Empresa no existe, pulse Crear empresa. Si ve Secretaría sin emparejar, empareje antes de despachar. Con la selección, pulse Solicitar SOAT, Solicitar Impuestos, Solicitar ambos o Entregar. Esas acciones aplican solo a los trámites Asignados con empresa y secretaría emparejadas, y los botones se lo dicen: con cuatro marcados de los que tres lo están, verá Solicitar SOAT (3 de 4) —el mismo número en los cuatro botones— y, debajo de la barra, una frase que lo explica. Entregar solo entrega las filas que muestran Listo para entregar. Barra de selección con cuatro trámites marcados y los botones Solicitar SOAT, Solicitar Impuestos, Solicitar ambos y Entregar con la cuenta 3 de 4, y Descargar soportes con 4 Con trámites marcados, pulse Descargar soportes (N). Se abre Documentos del ZIP, donde elige Factura de venta, Recibo del impuesto, Comprobante del SOAT o los que necesite, y obtiene un solo archivo ZIP con todo lo elegido. Cada trámite llega como un solo PDF con sus documentos en este orden: factura de venta, recibo del impuesto y comprobante del SOAT; el archivo se llama con la placa (por ejemplo, ABC123.pdf). Si un documento viene protegido y no se puede unir, va aparte, tal cual, como ABC123-2.pdf. Si un documento está dañado y no se puede leer, queda fuera y el aviso final le dice cuántos. Mientras se prepara verá Preparando el archivo…; con muchos trámites puede tardar unos minutos. Antes este botón traía solo las facturas de venta. Si ninguno de los trámites marcados tiene el documento que eligió, no se descarga un ZIP vacío: verá un aviso. En una fila, Crear empresa, el historial o Soportes abren el detalle de esa compañía o de ese trámite. Ventana Documentos del ZIP con Factura de venta, Recibo del impuesto y Comprobante del SOAT marcados y los botones Cancelar y Descargar Acceso a FLIT 2 (solo administradores): el botón del grupo FLIT 2 abre un panel con el usuario de servicio con el que FLITO entra a FLIT 2, quién lo guardó y desde cuándo. La contraseña no se muestra nunca. Si aún no hay acceso, el panel lo dice. Con permiso de guardar, escriba el usuario y la contraseña que entregó FLIT 2 y pulse Guardar acceso: los campos se vacían al guardar. Con un acceso ya guardado, Probar conexión comprueba si FLIT 2 lo acepta y deja el resultado en un aviso dentro del panel (conectado, sin permiso de datos personales, rechazado, bloqueado un rato, o FLIT 2 que no responde); el botón no aparece hasta que haya un acceso guardado. Sin ese permiso, solo verá el estado."
      },
      {
        "ancla": "entregar-tramites",
        "titulo": "Entregar trámites",
        "texto": "Entregar no es una pantalla aparte: es una acción de esta pantalla. Un trámite se puede entregar cuando está Asignado y tiene resueltos el SOAT y los impuestos. Esa fila muestra Listo para entregar. Que SOAT e impuestos estén resueltos es necesario, no suficiente: el trámite pasa a «Entregado» solo cuando usted lo marca y pulsa Entregar. Si una fila no muestra Listo para entregar, revise las columnas SOAT e Impuestos: ahí ve qué le falta. Puede marcar varios y entregarlos a la vez. El número del botón (por ejemplo, Entregar (3 de 4)) cuenta los marcados que están Asignados, no los que están listos: los que no muestran Listo para entregar no se entregan aunque entren en esa cuenta. Diagrama: el trámite llega de FLIT o FLIT 2; si no está Asignado, crear la empresa o emparejar la secretaría; asignado, solicitar SOAT e impuestos; resueltos, queda Listo para entregar y al pulsar Entregar pasa a Entregado"
      },
      {
        "ancla": "estados",
        "titulo": "Estados",
        "texto": "Cargando: la tabla aún no aparece mientras llega el listado. Error: el mensaje en rojo sobre la tarjeta si falla el listado. Si no se puede consultar el estado de la lectura de FLIT 1, el grupo FLIT 1 lo dice y ofrece Reintentar; si fallan los parámetros, lo dice la ventana Parámetros de lectura, también con Reintentar. Si no se pueden consultar los interruptores, la cabecera de Sincronización dice «estado no disponible» y, al desplegarla, la tarjeta lo explica con Reintentar; el resto de la zona sigue funcionando. Mientras se consulta, la cabecera dice «Cargando…». Aviso de FLIT 1: si falló la última lectura, aparece un aviso dentro del grupo FLIT 1 con la causa y qué hacer; se quita solo cuando vuelve una lectura buena. Si la lectura terminó pero algunos trámites no se pudieron aplicar, el aviso le pide revisarlos en la Bitácora: se reintentan en la siguiente lectura y en la nocturna. Aviso de FLIT 2: si FLIT 2 rechaza o bloquea el acceso, envía avisos con firma no válida, no responde o lleva más tiempo del esperado sin enviar información, Conexión dice Sin conexión y dentro del grupo FLIT 2 aparece el motivo (acceso rechazado, acceso bloqueado por un tiempo, sin información más tiempo del esperado, avisos con firma no válida o falló la última lectura) y qué hacer. FLITO vuelve a intentarlo solo; el aviso se quita cuando vuelve a llegar información. Si FLIT 2 envía varios avisos seguidos con firma no válida, FLITO no los tiene en cuenta y el aviso le pide avisar a quien administra el ambiente para revisar la clave compartida de los avisos; la lectura automática sigue funcionando aparte. Si algunos trámites llegaron sin los datos del comprador, el aviso lo dice: su SOAT e impuestos quedan en espera hasta que FLIT 2 habilite el permiso de datos personales. Si FLIT 2 aún no tiene acceso, verá FLIT 2 sin configurar. Si FLIT 2 rechazó el acceso, revíselo en Acceso a FLIT 2. Con FLIT 2 apagada (por el interruptor o en el servidor) no hay alerta de atraso: el grupo dice que la lectura automática está apagada y por qué. Vacío: No hay trámites. FLITO los trae de FLIT automáticamente. Un usuario con enlace de compañía ve No hay trámites de su compañía en esta vista. Si hay filtros: Ningún trámite coincide con el filtro. Lleno: tabla con trámite, fechas, vehículo, comprador, compañía, SOAT, impuestos, logística, derechos de tránsito y soportes. Un trámite listo muestra Listo para entregar. Si llegan trámites nuevos o cambian los visibles, verá el aviso con Ver encima de la tabla (o del mensaje de vacío)."
      },
      {
        "ancla": "que-no-hace",
        "titulo": "Qué no hace",
        "texto": "No es la cola del Proveedor (SOAT) ni la del Gestor de Impuestos (Impuestos). No carga recibos de derechos de tránsito ni resuelve OCR: eso vive en Derechos y Revisiones OCR. Facturar un trámite (congelar la liquidación) y la emisión electrónica no se hacen aquí. No entrega licencias de tránsito: eso es Logística / Mi ruta. El Auditor no descarga soportes en lote, aunque sí puede marcar trámites y usar todos los filtros. Si su rol está ligado a una compañía, la pantalla le muestra solo los trámites de esa compañía. Por eso no verá el filtro de compañía, ni Solicitar SOAT, Solicitar ambos o el Solicitar de la columna SOAT (escoger el proveedor del SOAT lo hace FLITO), ni + Trámite demo. Solicitar Impuestos, Entregar y Descargar soportes siguen disponibles si su rol tiene esas funciones."
      }
    ]
  },
  {
    "clave": "flito_derechos",
    "permiso": "flito_derechos",
    "etiqueta": "Derechos",
    "resumen": "Lo que el organismo cobra por radicar.",
    "version": "1.1",
    "fecha": "2026-10-22",
    "palabrasClave": [
      "derechos",
      "organismo de tránsito",
      "radicar",
      "pago de derechos"
    ],
    "consultas": [
      "cuánto cobra el organismo por radicar",
      "cómo registro el pago de derechos"
    ],
    "secciones": [
      {
        "ancla": "que-es",
        "titulo": "Qué es",
        "texto": "Registro de los recibos de derecho de tránsito que emite el organismo. El sistema lee placa, fecha y valor, y los asocia al trámite. El resultado de una carga no es un simple «ok»: cada archivo que usted sube cae en una canasta (Registrados, En revisión, Sin trámite asociado, Duplicados, Páginas omitidas, Fallidos)."
      },
      {
        "ancla": "para-quien",
        "titulo": "Para quién",
        "texto": "Administrador (carga, procesa el Drive y consulta). Auditor (consulta). Financiera no gestiona esta pantalla: los recibos los carga el Administrador."
      },
      {
        "ancla": "como-se-entra",
        "titulo": "Cómo se entra",
        "texto": "En la barra de navegación al pie de la pantalla, pulse Gestión y, en el grupo Trámites del panel que se abre, el ítem Derechos. En pantallas pequeñas, use el botón de menú de la barra superior; también puede pulsar Ctrl + K (Command + K en Mac) y escribir «Derechos»."
      },
      {
        "ancla": "pasos",
        "titulo": "Pasos",
        "texto": "En Cargar recibos, elija uno o varios archivos: PDF, imagen, ZIP o un PDF con varios recibos. El Organismo (opcional) es el código del organismo (por ejemplo, 05001) y solo afina la lectura; el trámite se determina por la placa del recibo. Pulse Cargar; el botón dice cuántos archivos eligió, por ejemplo Cargar (1), y mientras lee dice Procesando…. Al terminar, un aviso le dice cuántos derechos quedaron registrados y aparece Resultado de la carga: cada archivo en su canasta —Registrados, En revisión, Sin trámite asociado, Duplicados, Páginas omitidas o Fallidos—, con el archivo, la placa, el trámite, el valor y el detalle. Cerrar oculta el panel cuando termine. Resultado de la carga de un recibo demo: canastas Registrados, En revisión y Duplicados, cada una con archivo, placa, trámite, valor y detalle Lo En revisión (por ejemplo, una placa con varios trámites) se resuelve en Revisiones OCR, no aquí. En la pestaña Drive · Medellín están los consolidados que publica la secretaría en su Drive, con quién los modificó, el tamaño y si ya se procesaron (la fecha, Nunca o Dado por visto). Pulse Procesar, o Reprocesar si ya se había procesado; el resultado aparece en el mismo panel Resultado de la carga. Ver el registro muestra cada pasada, aunque el archivo ya no esté en el Drive. El barrido automático diario de las 9:00 no sustituye este botón. Pestaña Drive · Medellín con el registro de procesamientos abierto y la lista de consolidados demo con Procesar y Reprocesar En la pestaña Registrados, busque por placa o trámite y filtre por Secretaría, Origen o el rango Pagado; en Vista, Con advertencia deja solo los recibos cuyo concepto no coincide con el del trámite. Bajo el origen va el archivo y la página de donde salió cada recibo (o Archivo no registrado en los antiguos). Ver PDF abre el soporte y Ver todos abre los documentos del trámite (derecho, SOAT e impuesto). Una fila con duda muestra Con advertencia. Pestaña Registrados con el buscador, los filtros y tres derechos demo, uno de ellos Con advertencia Diagrama: los recibos entran por Cargar recibos o por Drive · Medellín, el sistema lee placa, fecha y valor, y cada uno cae en Registrados, En revisión, Sin trámite asociado, Duplicados, Páginas omitidas o Fallidos; lo En revisión se resuelve en Revisiones OCR"
      },
      {
        "ancla": "estados",
        "titulo": "Estados",
        "texto": "Cargando: Consultando el Drive… al listar los archivos del Drive; Cargando… en el registro de procesamientos; Procesando… en el botón mientras se lee una carga o un consolidado (no cierre la pestaña: se lee cada página). Error: aviso al fallar la carga o el procesamiento; en el Drive, el motivo queda además en una tarjeta. Vacío: Todavía no hay derechos de tránsito registrados. (el mismo texto sale cuando los filtros no encuentran nada). En el Drive: No hay PDF en la carpeta del Drive. o Todavía no se ha procesado ningún archivo. Lleno: listado con el trámite, el vehículo, las fechas, la empresa, el organismo, el concepto del recibo, el valor, la fecha de pago y el origen (Carga manual o Drive de la secretaría)."
      },
      {
        "ancla": "que-no-hace",
        "titulo": "Qué no hace",
        "texto": "No despacha SOAT ni impuestos, ni entrega el trámite. No resuelve ambigüedades de placa: eso es Revisiones OCR. No Factura ni hace emisión electrónica. No cubre secretarías que no publican en ese Drive: esas se cargan a mano desde Cargar recibos."
      }
    ]
  },
  {
    "clave": "flito_revisiones",
    "permiso": "flito_revisiones",
    "etiqueta": "Revisiones OCR",
    "resumen": "Cola de confirmación de campos leídos.",
    "version": "1.2",
    "fecha": "2026-10-22",
    "palabrasClave": [
      "revisiones",
      "OCR",
      "confirmar campos",
      "lectura de documentos"
    ],
    "consultas": [
      "cómo confirmo los campos que leyó el OCR",
      "por qué un documento quedó en revisión"
    ],
    "secciones": [
      {
        "ancla": "que-es",
        "titulo": "Qué es",
        "texto": "Cola de confirmación humana: todo documento leído por OCR que no superó la coincidencia cae aquí. Nada se da por válido sin que usted lo confirme."
      },
      {
        "ancla": "para-quien",
        "titulo": "Para quién",
        "texto": "Administrador (confirma o descarta). Auditor (ve la cola y los soportes, pero no los resuelve: Solo lectura · Auditoría ve la cola y los soportes, pero no los resuelve.)."
      },
      {
        "ancla": "como-se-entra",
        "titulo": "Cómo se entra",
        "texto": "En la barra de navegación al pie de la pantalla, pulse Gestión y, en el panel que se abre, en el grupo Trámites, el ítem Revisiones OCR. Si la ventana es estrecha, la barra deja solo los iconos y el nombre de cada sección aparece al pasar el cursor por encima; en pantallas pequeñas, use el botón de menú de la barra superior. También puede pulsar Ctrl + K (Command + K en Mac) y escribir «revisiones»."
      },
      {
        "ancla": "pasos",
        "titulo": "Pasos",
        "texto": "Elija el grupo: SOAT, Impuestos (incluye las facturas de venta) o Derechos de tránsito. Marque Incluir resueltas, arriba a la derecha, si necesita ver también las ya cerradas. En Cola, a la izquierda, pulse el archivo; la primera de la lista viene elegida. En el centro aparece el documento; si el visor no lo muestra, use Abrir el documento. A la derecha, el tipo de documento, el motivo por el que llegó (por ejemplo, Confianza del OCR bajo el umbral) y los campos leídos, cada uno con su confianza: confiable, no confiable o Sin lectura. Revisiones OCR con la cola de dos pólizas a la izquierda, el documento en el centro y los campos leídos con su porcentaje de confianza a la derecha En Trámite contra el que se concilia, elija el trámite (Selecciona el trámite…); el que coincide con la placa leída lo dice entre paréntesis. Aparece una tabla que compara Placa y VIN del trámite con lo Leído del PDF, con ✓ si cruzan y ✗ si no. Corrija en cada campo el valor que no corresponda. Trámite elegido en el selector y tabla que compara placa y VIN del trámite con lo leído del PDF, ambos con marca de coincidencia Pulse Confirmar y resolver (solo se habilita con un trámite elegido). Escriba en Deja constancia de qué validaste y pulse Resolver, o Cancelar para volver. Si el documento no corresponde a ningún trámite, pulse Descartar documento, escriba el Motivo del descarte (mín. 5 caracteres) y pulse Descartar. Recuadro Deja constancia de qué validaste con el botón Resolver y Cancelar debajo de los campos Al resolver o descartar, el documento sale de la cola. Una revisión ya cerrada (con Incluir resueltas) muestra Resuelta y sus campos no se editan. Diagrama: el documento en la cola, elegir el trámite y revisar los campos; si corresponde, Confirmar y resolver con constancia; si no, Descartar documento con motivo"
      },
      {
        "ancla": "estados",
        "titulo": "Estados",
        "texto": "Cargando: Cargando documento… en el visor mientras llega el archivo. Error: el recuadro de constancia o de descarte muestra el mensaje si falla la confirmación o el descarte. Vacío: No hay nada en revisión. Cuando una extracción no supere el umbral o su llave no cruce, el documento aparecerá aquí. El mismo mensaje se ve si la cola no se pudo consultar. Lleno: cola a la izquierda, documento al centro y campos a la derecha (en pantallas pequeñas, uno debajo del otro)."
      },
      {
        "ancla": "que-no-hace",
        "titulo": "Qué no hace",
        "texto": "No sustituye la carga masiva: los archivos entran desde SOAT, Impuestos o Derechos. No envía el SOAT al Proveedor ni el impuesto al gestor. No Factura ni hace emisión electrónica. El Auditor no confirma ni descarta."
      }
    ]
  },
  {
    "clave": "flito_bitacora",
    "permiso": "flito_bitacora",
    "etiqueta": "Bitácora",
    "resumen": "Rastro de movimientos de un trámite.",
    "version": "1.2",
    "fecha": "2026-10-22",
    "palabrasClave": [
      "bitácora",
      "historial",
      "movimientos",
      "trazabilidad"
    ],
    "consultas": [
      "dónde veo el historial de un trámite",
      "quién cambió el estado de un trámite"
    ],
    "secciones": [
      {
        "ancla": "que-es",
        "titulo": "Qué es",
        "texto": "Consulta de solo lectura del rastro de movimientos de un trámite: toda transición deja huella, incluidas las automáticas del sistema (actor sistema). Usted consulta; no edita."
      },
      {
        "ancla": "para-quien",
        "titulo": "Para quién",
        "texto": "Administrador y Auditor. Nadie edita ni borra movimientos desde esta pantalla."
      },
      {
        "ancla": "como-se-entra",
        "titulo": "Cómo se entra",
        "texto": "En la barra de navegación al pie de la pantalla, pulse Gestión y, en el panel que se abre, en el grupo Auditoría, el ítem Bitácora. Si la ventana es estrecha, la barra deja solo los iconos y el nombre de cada sección aparece al pasar el cursor por encima; en pantallas pequeñas, use el botón de menú de la barra superior. También puede pulsar Ctrl + K (Command + K en Mac) y escribir «bitácora»."
      },
      {
        "ancla": "pasos",
        "titulo": "Pasos",
        "texto": "Elija el recurso con las pastillas: Todas, SOAT, Impuesto, Trámite o Revisión. La tabla se vuelve a consultar con ese filtro. Ajuste Límite (de 1 a 500 filas; de partida, 100) si necesita una ventana más amplia o más corta. Lea Fecha, Recurso, Acción, Actor y Detalle, del más reciente al más antiguo. Un movimiento automático muestra el chip sistema en la columna Actor. El recurso y la acción se muestran con el nombre corto que guarda el sistema (por ejemplo, *soat* y *update*). Bitácora con las pastillas de recurso, el campo Límite y la tabla de movimientos, varios con el actor sistema"
      },
      {
        "ancla": "estados",
        "titulo": "Estados",
        "texto": "Cargando: la tabla aún no aparece (el encabezado y las pastillas sí). Error: mensaje en rojo dentro de la tarjeta. Vacío: Sin movimientos registrados. Cuando se sincronice, se tome o se pague algo, aparecerá aquí. Lleno: tabla Bitácora de movimientos con una fila por transición."
      },
      {
        "ancla": "que-no-hace",
        "titulo": "Qué no hace",
        "texto": "No corrige un SOAT, un impuesto ni un trámite: es rastro, no bandeja. No sustituye el historial puntual que abre una fila en Gestión Trámites. No registra comparendos ni actas de logística (esa trazabilidad vive en esas pantallas). No busca por placa ni por trámite: filtra solo por recurso y límite. No Factura ni hace emisión electrónica."
      }
    ]
  },
  {
    "clave": "flito_comparendos",
    "permiso": "flito_comparendos",
    "etiqueta": "Comparendos",
    "resumen": "Lo que SIMIT y los municipios reportan de los NIT vigilados.",
    "version": "1.2",
    "fecha": "2026-10-22",
    "palabrasClave": [
      "comparendos",
      "SIMIT",
      "multas",
      "NIT vigilados"
    ],
    "consultas": [
      "cómo consulto los comparendos de una empresa",
      "qué reporta SIMIT de un NIT"
    ],
    "secciones": [
      {
        "ancla": "que-es",
        "titulo": "Qué es",
        "texto": "Monitoreo de lo que SIMIT y los municipios reportan de los NIT vigilados (Comparendos monitoreados). Los datos de fuente no se editan aquí: lo único que usted registra es la causal y la observación de gestión. No es el gate SIMIT de un traspaso ni un incidente PESV."
      },
      {
        "ancla": "para-quien",
        "titulo": "Para quién",
        "texto": "Administrador. El Auditor, el Proveedor, el Gestor de Impuestos y el Mensajero no tienen esta pantalla por defecto."
      },
      {
        "ancla": "como-se-entra",
        "titulo": "Cómo se entra",
        "texto": "En la barra de navegación al pie de la pantalla, pulse Gestión y, en el panel que se abre, en el grupo Comparendos, el ítem Comparendos. Si la ventana es estrecha, la barra deja solo los iconos y el nombre de cada sección aparece al pasar el cursor por encima; en pantallas pequeñas, use el botón de menú de la barra superior. También puede pulsar Ctrl + K (Command + K en Mac) y escribir «comparendos». La pantalla tiene tres pestañas: Registros (el visor, la que se abre), Sincronización y Configuración."
      },
      {
        "ancla": "pasos",
        "titulo": "Pasos",
        "texto": "En Registros, filtre con Todos, Activos o Inactivos, y con Municipio, Fuente y Causal de gestión («Sin causal asignada» es la cola de lo que falta por mirar). Para buscar uno concreto, escriba el N.º de comparendo (desde 3 caracteres), el NIT monitoreado (exacto, desde 5 dígitos) o la Placa (exacta) y pulse Buscar; Limpiar quita la búsqueda. El NIT y la placa no viajan solos al escribir. Pestaña Registros con los filtros, la búsqueda por número, NIT o placa y la tabla de comparendos Pulse el número de un comparendo para abrir su detalle. Arriba están los Datos de la fuente (no se editan aquí); más abajo, en Gestión del comparendo, elija la causal, escriba la observación y pulse Guardar gestión. Detalle del comparendo con su estado, origen y los datos de la fuente Si el visor está vacío porque aún no hay sincronización, pulse Ir a la sincronización. En Sincronización, en Sincronizar ahora, elija el Alcance (Todos los NIT activos o Solo estos NIT) y pulse Sincronizar. No hay corrida automática. La corrida puede tardar más de un minuto; no cierre la pestaña. Debajo, el Historial de sincronizaciones muestra cada corrida con su estado y su resumen; Ver detalle abre el resultado por fuente. Pestaña Sincronización con el alcance, el botón Sincronizar y el historial de corridas completadas En Configuración, use Agregar NIT (con su alias), Agregar municipio y Agregar causal; cada fila trae sus acciones (Editar alias, Desactivar, Eliminar…). Al final está el Token SIMIT (Guardar token). En Registros, Exportar a Excel (arriba) se lleva el conjunto filtrado completo; el botón pasa a Preparando el archivo…. Pestaña Configuración con los NIT monitoreados y los municipios fuente, cada uno con sus acciones Diagrama: Configuración, luego Sincronización, luego Registros y el detalle con causal y observación; el historial guarda cada corrida"
      },
      {
        "ancla": "estados",
        "titulo": "Estados",
        "texto": "Cargando: el visor muestra la espera del listado; la exportación, Preparando el archivo…. Error: avisos al fallar la búsqueda, la sincronización o la configuración. Vacío: el visor explica que no hay registros (y ofrece Ir a la sincronización cuando aplica) o que el filtro no arroja nada. Lleno: tabla de registros consolidados (activo o inactivo según las fuentes) y paneles de detalle. Si la tabla no cabe a lo ancho, el borde derecho se sombrea para avisar de que hay más columnas: desplácela en horizontal o use el tabulador para entrar en ella."
      },
      {
        "ancla": "que-no-hace",
        "titulo": "Qué no hace",
        "texto": "No paga comparendos ni sustituye la gestión del trámite de traspaso. No es el pre-vuelo de un trámite ni el incidente PESV llamado comparendo. No Factura ni hace emisión electrónica. Inactivo no significa «pagado»: significa que las fuentes dejaron de reportarlo con cobertura completa."
      }
    ]
  },
  {
    "clave": "flito_logistica",
    "permiso": "flito_logistica",
    "etiqueta": "Logística",
    "resumen": "Actas, despacho y trazabilidad por documento.",
    "version": "1.1",
    "fecha": "2026-10-22",
    "palabrasClave": [
      "logística",
      "actas",
      "despacho",
      "mensajería",
      "trazabilidad"
    ],
    "consultas": [
      "cómo genero un acta de despacho",
      "dónde está un documento enviado"
    ],
    "secciones": [
      {
        "ancla": "que-es",
        "titulo": "Qué es",
        "texto": "Consola de las licencias de tránsito de trámites Aprobado: de la recogida en el organismo a la entrega firmada. Aquí usted genera actas por compañía y despacha al Mensajero."
      },
      {
        "ancla": "para-quien",
        "titulo": "Para quién",
        "texto": "Administrador (genera actas, firma y despacha, registra novedades). Auditor (consulta). El Mensajero no entra aquí: su trabajo es Mi ruta."
      },
      {
        "ancla": "como-se-entra",
        "titulo": "Cómo se entra",
        "texto": "En el menú lateral, sección Gestión, ítem Logística."
      },
      {
        "ancla": "pasos",
        "titulo": "Pasos",
        "texto": "En la pestaña Trámites, busque por placa, VIN o trámite FLIT y filtre por empresa y por estado: Pendiente de recogida, Registrada, Despachada, Entregada o Con novedad. Pestaña Trámites con el buscador, el filtro de empresas, los cinco estados y la tabla de licencias Pulse Detalle en una fila para ver el trámite, la sección Viajes adicionales y la Bitácora de la licencia. Si la licencia está Registrada y viene dañada o con datos que no cuadran, pulse Novedad en la fila, escriba el Motivo (obligatorio) y pulse Confirmar. Detalle de una licencia con sus datos, la sección Viajes adicionales y la bitácora En Viajes adicionales verá cuántos viajes lleva el trámite (el viaje 1 va incluido) y el total de los adicionales. Pulse Registrar viaje, elija el Motivo (obligatorio) —Devolución, Segunda entrega, Documento faltante u Otro; en «Otro» escriba el detalle, sin datos personales— y el Precio: Precio inicial copia la tarifa de logística vigente de la compañía y no se edita; Nuevo precio deja escribir un valor. Confirme con Registrar. Ventana Registrar viaje con el motivo elegido y la opción Precio inicial con la tarifa vigente Para retirar un viaje, pulse Quitar en su fila y confirme. Un viaje no se edita: se quita y se registra de nuevo. En la pestaña Generación de actas verá cada empresa con sus licencias registradas por el mensajero. Pulse Generar acta: se crea un acta por empresa y la pantalla pasa a la pestaña Actas. Pestaña Generación de actas con dos empresas, sus licencias registradas y el botón Generar acta En la pestaña Actas, pulse Ver para revisar las licencias, las firmas y la bitácora del despacho; dentro está Descargar PDF. Pestaña Actas con actas Generada, Despachada y Entregada y sus acciones Ver, Firmar y despachar y Devolver En un acta Generada, pulse Firmar y despachar. En la ventana Firmar entrega y despachar elija el Mensajero, escriba si quiere el Nombre de quien entrega (Operaciones), trace la Firma de quien entrega y pulse Firmar y despachar. Ventana Firmar entrega y despachar con el mensajero elegido y la firma trazada Si el receptor no recibió un acta Despachada, pulse Devolver, escriba el Motivo (obligatorio) y pulse Confirmar. Ciclo de una licencia de tránsito: Pendiente de recogida, Registrada cuando el mensajero la escanea, acta generada, Despachada al firmar y despachar, y Entregada con la firma del receptor; la novedad y la devolución la dejan Con novedad"
      },
      {
        "ancla": "estados",
        "titulo": "Estados",
        "texto": "Cargando: las pestañas se ven; las tablas aparecen al llegar los datos. En Viajes adicionales se ve la silueta de la lista mientras llega. Error: mensaje en rojo sobre la tarjeta. Si los viajes no cargan, el aviso trae Reintentar. Vacío en trámites: No hay trámites aprobados. Sincroniza desde FLIT: los trámites en estado «Aprobado» aparecen aquí a la espera de su licencia de tránsito. Con enlace de compañía: No hay trámites aprobados de su compañía en esta vista. seguido de la misma explicación. En actas: No hay LT registradas pendientes de acta… / Aún no hay actas. Ve a «Generación de actas»… En el detalle de una licencia aún no recogida: La licencia aún no se ha recogido. El mensajero la escaneará en el organismo. Lleno: listado con placa, propietario, empresa, secretaría, N.º LT y estado. Sin mensajeros: en Firmar entrega y despachar verá No hay mensajeros registrados. Crea un usuario con rol Mensajero. Viajes adicionales (en el detalle): sin viajes verá Sin viajes adicionales. El viaje 1 se cobra con la tarifa vigente. y Viajes: 1 (incluye el viaje 1); si el trámite ya está liquidado la sección es de solo lectura (Trámite liquidado: reversa la liquidación para registrar o quitar viajes.); si la compañía autogestiona la logística verá La logística de esta compañía la gestiona el cliente. y no podrá registrar; sin tarifa de logística vigente, Precio inicial queda deshabilitado (La compañía no tiene tarifa de logística vigente) y solo puede fijar Nuevo precio."
      },
      {
        "ancla": "que-no-hace",
        "titulo": "Qué no hace",
        "texto": "No es Mi ruta: el Administrador no escanea LT en el organismo desde aquí. No despacha SOAT ni impuestos, ni Factura, ni hace emisión electrónica. No crea el trámite: el origen es la sincronización en Gestión Trámites (o + Trámite demo en pruebas). Una compañía en autogestión de logística no aparece como trabajo de recogida de FLITO. Los viajes adicionales no aparecen en el acta ni en su PDF: su costo se consulta en Finanzas (Reporte de costos). Ver, registrar o quitar viajes requiere que el administrador le haya asignado esas funciones en Roles y permisos."
      }
    ]
  },
  {
    "clave": "flito_logistica_ruta",
    "permiso": "flito_logistica_ruta",
    "etiqueta": "Mi ruta",
    "resumen": "Recogidas y entregas asignadas al mensajero.",
    "version": "1.2",
    "fecha": "2026-10-22",
    "palabrasClave": [
      "mi ruta",
      "recogidas",
      "entregas",
      "mensajero"
    ],
    "consultas": [
      "qué entregas tengo asignadas",
      "cómo marco una recogida como hecha"
    ],
    "secciones": [
      {
        "ancla": "que-es",
        "titulo": "Qué es",
        "texto": "Pantalla de campo del Mensajero: escanear las licencias de tránsito en el organismo y entregarlas firmadas en la compañía. Con señal envía al momento; sin señal encola el cambio."
      },
      {
        "ancla": "para-quien",
        "titulo": "Para quién",
        "texto": "Quien tenga el permiso de Mi ruta; de partida, el Mensajero (se reparte desde Roles y permisos). El Administrador despacha desde Logística; no usa esta vista como consola."
      },
      {
        "ancla": "como-se-entra",
        "titulo": "Cómo se entra",
        "texto": "En el menú lateral, sección Gestión, ítem Mi ruta (visible para quien tenga el permiso de Mi ruta; de partida, el Mensajero)."
      },
      {
        "ancla": "pasos",
        "titulo": "Pasos",
        "texto": "En Recoger licencias, pulse Escanear LT (o Escanear otra LT). Si no hay cámara, abra Pega el contenido del código, complete N.º de LT (impreso bajo el código) y pulse Agregar. Mi ruta: Recoger licencias con el contenido del código pegado, el N.º de LT escrito y el botón Agregar Cada tarjeta muestra el resultado: Validando…, ✓ Relacionada, Novedad (VIN), Sin trámite, No gestionable, Ya registrada o Sin validar (offline). Dos tarjetas de LT: una Relacionada y otra Sin trámite con su motivo, y el botón Confirmar recogida (1) Pulse Confirmar recogida (N). El lote pasa a Registrando…, ✓ Registrada o En cola. La LT relacionada ya aparece como Registrada y el resumen dice 1 registrada(s) En Entregas, cada acta despachada es una tarjeta con la empresa, la dirección y sus licencias. Pulse Entregar, capture Nombre del receptor, Documento del receptor y Firma del receptor; si quiere, Adjuntar foto (opcional). Pulse Confirmar entrega: el equipo pide la ubicación de la entrega. Acta por entregar abierta con nombre y documento del receptor, firma trazada y el botón Confirmar entrega Si el receptor no recibe, pulse Devolver en la tarjeta y escriba el motivo de la devolución. Sin red verá Trabajando offline o Sin conexión · N cambio(s) sin sincronizar: lo que registre queda en cola. Con señal, pulse Reintentar (verá Sincronizando…). Aviso Sin conexión · 1 cambio(s) sin sincronizar y una LT En cola Recorrido del mensajero: escanear la licencia, ver el resultado de la validación, confirmar la recogida, y en la entrega firmar con el receptor o devolver; sin señal los cambios quedan en cola hasta sincronizar"
      },
      {
        "ancla": "estados",
        "titulo": "Estados",
        "texto": "Cargando: el encabezado Mi ruta se ve; Entregas aparece al llegar la ruta. Error: banda roja con el mensaje. No se reconoce el formato de la LT. si el pegado no es válido. Vacío: No tienes actas despachadas. si aún no hay entregas. Lleno: tarjetas de LT recogidas y actas por entregar. Mensaje verde al guardar (Guardado sin conexión — se enviará al recuperar señal.)."
      },
      {
        "ancla": "que-no-hace",
        "titulo": "Qué no hace",
        "texto": "No lista todos los trámites de Operaciones: usted no elige el trámite; el cruce es por placa y VIN. No genera actas ni elige mensajero: eso es Logística. No gestiona SOAT, impuestos ni comparendos. De partida, el Auditor y el Administrador no tienen el permiso de Mi ruta (el Administrador opera la consola Logística); el Administrador puede repartirlo desde Roles y permisos."
      }
    ]
  },
  {
    "clave": "soat",
    "permiso": "flito_soat",
    "etiqueta": "SOAT",
    "resumen": "Cola de pólizas del proveedor.",
    "version": "1.8",
    "fecha": "2026-10-28",
    "palabrasClave": [
      "SOAT",
      "pólizas",
      "factura",
      "VIN"
    ],
    "consultas": [
      "cómo solicito un SOAT",
      "cuándo pasa un SOAT a pagado",
      "cómo cargo la factura del SOAT"
    ],
    "secciones": [
      {
        "ancla": "que-es",
        "titulo": "Qué es",
        "texto": "Cola FLITO de adquisición del SOAT. El SOAT se ancla al VIN y solo pasa a Pagado cuando usted carga una factura validada. Esta es la cola con rótulo SOAT en Gestión. No es el módulo legado de pólizas."
      },
      {
        "ancla": "para-quien",
        "titulo": "Para quién",
        "texto": "Proveedor (ve Solicitado y Pagado de su cartera; nunca los Pendiente). Administrador (ve toda la cola, envía al gestor y puede asumir por contingencia). Auditor (de partida, solo lectura: Solo lectura · Auditoría observa, no ejecuta acciones.). Lo que cada uno puede hacer lo dan las funciones que el Administrador reparte en Roles y permisos; los perfiles de arriba son el reparto de partida. Cliente (usuario de una compañía: ve únicamente los SOAT de su compañía. Si su compañía tiene disponible el SOAT sin trámite, además puede solicitar el SOAT de un vehículo que todavía no tiene trámite en FLIT; no envía al gestor ni carga facturas). El proveedor al que salen las solicitudes de SOAT sin trámite de cada compañía (o Sin proveedor, que deja la opción cerrada) se elige en Clientes y proveedores, en la columna SOAT sin trámite."
      },
      {
        "ancla": "como-se-entra",
        "titulo": "Cómo se entra",
        "texto": "En la barra de navegación al pie de la pantalla, pulse Gestión y, en el grupo SOAT e Impuestos del panel que se abre, el ítem SOAT. En pantallas pequeñas, use el botón de menú de la barra superior; también puede pulsar Ctrl + K (Command + K en Mac) y escribir «SOAT»."
      },
      {
        "ancla": "pasos",
        "titulo": "Pasos",
        "texto": "Filtre con las pastillas Todos, Por validar, Pendiente, Solicitado, Con novedad, Pagado o Descartadas. El Proveedor no ve Todos ni Pendiente, y tampoco Por validar ni Descartadas. Por validar reúne las solicitudes que se guardaron porque el RUNT no respondió: todavía no llegan al gestor. Descartadas reúne las que el RUNT no dejó continuar; solo se ven en su pastilla. En Todos, la primera página muestra arriba las solicitudes por validar y debajo la cola de siempre. En esas dos pastillas no está Exportar a Excel ni aplican los filtros de Más filtros: se busca por VIN o documento en el buscador. Si su usuario tiene la función de reintentar la consulta al RUNT (de partida, solo el Administrador; se reparte desde Roles y permisos), cada solicitud por validar trae el botón Reintentar consulta, en la fila y en su detalle. Mientras consulta, esa fila dice Consultando… y el resto de la cola sigue disponible; en el detalle, la ventana no se cierra hasta que termine. Hay tres desenlaces, cada uno con un aviso: si el RUNT responde y no hay impedimento, la solicitud pasa a Solicitado, sale de Por validar y aparece en la cola normal (si el SOAT actual vence pronto, el aviso le da la fecha y el detalle muestra la tarjeta Este vehículo todavía tiene SOAT activo); si el vehículo ya tiene SOAT vigente, el RUNT no tiene ese VIN o el VIN ya tenía otra solicitud, queda en Descartadas; y si el RUNT sigue sin responder, sigue por validar y puede intentar más tarde. Si otra persona ya la resolvió, el aviso dice Esta solicitud ya había cambiado de estado. La lista se actualizó. Busque placa, VIN o comprador en el buscador de la primera fila. Los demás filtros están en Más filtros, que se abre y se cierra y le muestra entre paréntesis cuántos tiene puestos —Más filtros (2)—; ahí están, agrupados en Quién, Cuándo y Riesgo: Compañía, Organismo, Proveedor, los rangos de fechas (Creado en FLITO y los demás), Vigencia (Vencido, Sin SOAT en el RUNT o Sin verificar) y Solo sin gestión. Limpiar filtros los quita todos. En su propio renglón, las Vistas rápidas —Listos para enviar y Sin gestión— aplican de un clic los filtros más usados; el Cliente no las ve. Las fechas del trámite en FLIT ya no son una columna de la tabla: están en el detalle, como Trámite creado y Trámite aprobado. Cola SOAT con las pastillas de estado, el buscador, Más filtros y las vistas rápidas; arriba de la tabla, una solicitud Por validar con Reintentar consulta Para llevarse la cola a Excel, pulse Exportar a Excel en el encabezado. El archivo trae el conjunto filtrado completo, no solo la página que está viendo ni las filas que haya marcado. Mientras se genera, el botón dice Preparando el archivo…; al terminar, un aviso le confirma el nombre del archivo descargado y se quita con Cerrar el aviso. Si el filtro trae más filas de las que admite un archivo, no se descarga nada: verá un aviso pidiéndole acotar la búsqueda. Esta acción solo la ve quien tiene la función de exportar a Excel (de partida, el Administrador y el proveedor; se reparte desde Roles y permisos). Si su usuario tiene la función de exportar datos de pago (de partida, solo el Administrador; se reparte desde Roles y permisos), verá junto al botón la casilla Incluir datos de pago y trazabilidad: márquela y el archivo añadirá al final, después de las columnas del vehículo y el titular, el estado, la fecha de solicitud, la fecha y el valor del pago, el número de póliza, el gestor, el motivo de la novedad, la vigencia frente al RUNT, la fecha de creación y la de carga del comprobante. Las celdas de pago van vacías mientras el SOAT no esté pagado. Sin la casilla, o sin esa función, el archivo es el de siempre. Los usuarios con enlace (compañía, proveedor u organismos) no ven esta casilla: es de uso interno. Marque las filas que necesite. La columna de casillas aparece si su usuario puede descargar soportes o enviar al gestor; ya no se limita a las Pendiente. Como Administrador, elija Enviar a (Gestionado por Operaciones o un proveedor; un proveedor desactivado aparece con (Inactivo), apagado, y no se puede elegir) y pulse Enviar al gestor o Enviar a Operaciones. Esas acciones siguen aplicando solo a las filas que ya las admitían, y el botón se lo dice: si marcó ocho filas y tres son enviables, verá Enviar al gestor (3 de 8) y se envían esas tres. Mientras hay filas marcadas, la barra de selección queda fija arriba al desplazarse, y Quitar selección las desmarca todas. Al enviar, un aviso le confirma cuántos SOAT se enviaron; si algo falla, el aviso le dice qué pasó y la selección se conserva para que pueda reintentar. Barra de selección fija con tres filas marcadas, el selector Enviar a y los botones Enviar al gestor y Descargar soportes con la cuenta 1 de 3 Para bajar varios comprobantes a la vez, marque dos o más filas y pulse Descargar soportes. Solo se descargan los SOAT Pagado, que son los que tienen comprobante: si marcó cuatro filas y tres están pagadas, verá Descargar soportes (3 de 4) y se bajan esas tres. Con una sola fila marcada, o sin ninguna pagada, el botón aparece deshabilitado y le dice por qué. Obtendrá un ZIP con un PDF por SOAT, nombrado con la placa (por ejemplo, ABC123.pdf). Mientras se prepara, el botón dice Preparando el archivo…. Si lo marcado pesa más de lo que admite una descarga, marque menos filas y repita. Esta descarga solo la ve quien tiene la función de descargar soportes (de partida, el Administrador y el proveedor; el Administrador puede concederla desde Roles y permisos). Para un solo SOAT no hace falta marcarlo: pulse el icono de descarga de su fila, junto a Ver, y se guarda el comprobante con el nombre de la placa (por ejemplo, ABC123.pdf). En una fila que aún no está Pagado el icono aparece en gris y le dice Disponible cuando el SOAT esté pagado. Si la descarga falla, un aviso que puede cerrar le dice qué pasó y, cuando tiene sentido volver a intentar, le ofrece Reintentar; si sale bien, no hay aviso: el navegador ya se lo muestra. En una fila, pulse Ver. En adquisición, Cargar factura (un archivo) o, desde el encabezado, Cargar facturas (masivo), que solo aparece si su usuario tiene la función de carga masiva de facturas (se reparte desde Roles y permisos). Sueltos caben hasta 150 archivos; dentro de un ZIP, hasta 300, y cada archivo puede pesar hasta 15 MB. Al elegir un ZIP, FLITO lo abre en su computador y le dice cuántos comprobantes trae: el peso que ve (N archivos · X MB de 250 MB) es el de lo que va a subir, no el del ZIP comprimido. Lo que no sea PDF ni imagen se ignora y se lo dice. Si el ZIP está dañado, tiene contraseña o no trae comprobantes, no se envía nada. Y si un archivo del ZIP resulta pesar más de lo que el ZIP decía, FLITO para ahí y se lo dice: lo que ya subió se queda. FLITO sube los comprobantes de 5 en 5 y le muestra por cuál va. Según el caso: Rechazar, Reactivar, Reversar, Cambiar proveedor, Asumir en Operaciones o Devolver al proveedor. Cada acción del detalle —Cargar factura incluida— aparece solo si su usuario tiene la función de esa acción (se reparten desde Roles y permisos); las que no tiene no se muestran. Si el detalle no le ofrece ninguna acción, verá el aviso Solo lectura · Auditoría observa, no ejecuta acciones. El detalle se lee de arriba abajo: primero el estado y, si lo hay, el Motivo de la novedad; luego la acción que toca en ese estado (Cargar factura, Rechazar o Reactivar); después el Comprobante, con Ver soporte y, si tiene la función de descargar soportes, Descargar comprobante (guarda la póliza con el nombre de la placa; si el SOAT no está pagado aparece deshabilitado con la explicación); luego, si su usuario tiene la función de ver documentos adicionales (de partida, el Administrador y el proveedor; se reparte desde Roles y permisos), la sección Documentos adicionales, con la etiqueta, el tipo, el tamaño, la fecha y hora y quién lo cargó de cada documento, Ver para abrirlo en una pestaña nueva y el icono de descarga (los HEIC dicen Sin vista previa y solo se descargan). Si además tiene la función de cargar documentos adicionales (de partida, el Administrador y el proveedor), la sección trae Cargar documentos: abre ahí mismo un panel para elegir archivos con las mismas reglas del formulario (PDF, JPG, PNG, WEBP o HEIC; hasta 15 MB cada uno, 20 archivos y 250 MB por carga) y una etiqueta opcional por archivo; pulse Cargar y la lista se actualiza sin salir del detalle, o Cancelar para cerrarlo. Si alguno no se cargó (por ejemplo, porque ya estaba en la solicitud o era igual a la factura), la sección le dice cuál y por qué. Con la función de eliminar documentos adicionales, cada documento tiene un icono de papelera: al pulsarlo la fila pide confirmar —¿Eliminar «…»? Se borra de forma definitiva y no se puede recuperar.— y solo al pulsar Eliminar se borra; Cancelar o la tecla Esc lo dejan como estaba. Cargar y eliminar están disponibles en cualquier estado de la solicitud; los datos del SOAT y del trámite; y al final, bajo Corregir el caso, las correcciones de Operaciones (Reversar, Cambiar proveedor, Asumir en Operaciones, Devolver al proveedor) y el historial. Cada acción le confirma con un aviso cuando sale bien, y si falla le dice por qué ahí mismo. Una solicitud llegada por el canal SOAT sin trámite se trabaja igual que cualquier otro SOAT en gestión: tiene las mismas acciones y no hay ninguna revisión previa que hacerle. Detalle de un SOAT pagado con el estado, el comprobante con Ver soporte y Descargar comprobante, los documentos adicionales y los datos del SOAT y del trámite Como Cliente, si la opción está disponible para su compañía, pulse Solicitar SOAT en el encabezado. Si su rol no está ligado a una compañía pero tiene la función de solicitar el SOAT, también verá el botón, siempre que alguna compañía tenga disponible el SOAT sin trámite. Arriba del formulario está la sección Compañía: si su rol está ligado a una compañía, aparece ya escrita y no se cambia; si no, escójala en la lista, que solo trae las compañías que lo tienen disponible. Es lo primero que pide el formulario —junto con el tipo de SOAT—: sin ella no se consulta el RUNT, no se lee la factura ni se envía, y la frase Para enviar falta: empieza por escoger la compañía. Si la cambia después de consultar el RUNT, la consulta se retira y hay que volver a hacerla; lo que ya escribió se conserva. Si la lista no carga verá No pudimos cargar las compañías. con Reintentar, y si ninguna lo tiene, Ninguna compañía tiene habilitado el SOAT sin trámite. Debajo está el selector Tipo de SOAT: elija SOAT inicial (vehículo nuevo o que nunca ha tenido SOAT; se consulta por el VIN) o Renovación (el vehículo ya tuvo SOAT; se consulta por placa y documento del propietario). No hay tipo por defecto: hasta que elija uno no aparecen los bloques ni se puede consultar el RUNT, y el encabezado dice Elija el tipo de SOAT para empezar. Si lo cambia después de escribir o consultar algo, FLITO le pregunta ¿Cambiar el tipo de SOAT?: Cambiar el tipo borra lo escrito y lo consultado, y Mantener lo deja como está. Con el tipo elegido, el formulario sigue con cuatro bloques en este orden (lo que sigue describe el SOAT inicial; la renovación se explica más abajo): 1 · Vehículo, 2 · Factura de venta, 3 · Propietario y 4 · Documentos adicionales (opcional). Escriba el VIN (número de chasis): está en la tarjeta de propiedad y en la factura de venta, es obligatorio y es el único dato del vehículo que usted escribe. Pulse Consultar el RUNT. Mientras consulta, el botón dice Consultando el RUNT…; si el RUNT confirma el vehículo, el bloque queda marcado ✓ Consultado y aparece la ficha con la placa, el VIN, marca, línea, modelo, clase, carrocería, servicio, cilindraje, capacidad (pasajeros) y puertas, más el organismo de tránsito. Un dato en — es un dato que el RUNT no publica y no le impide enviar. Enviar solicitud no envía nada hasta ese momento: mientras falte algo, la pantalla se lo enumera —Para enviar falta: consultar el RUNT, VIN y 10 datos más.—, empezando por el RUNT y siguiendo por los campos pendientes con el nombre que tienen en el formulario. Si lo único que falta es la consulta, pulsar el botón le lleva al botón de consulta; si el RUNT ya está en verde, le lleva al primer campo que falte. Si después de consultar cambia el VIN, la ficha se retira y hay que Volver a consultar; lo que usted escribió no se borra, y corregir el documento del propietario ya no obliga a repetir la consulta. En una Renovación, el bloque 1 · Vehículo pide la placa y el documento del propietario (solo el número, sin tipo de documento), y la factura de venta es opcional: si la adjunta, FLITO lee el propietario y lo llena; si no, lo escribe usted, y el número que puso en el bloque 1 ya aparece en el bloque 3 · Propietario, donde puede corregirlo. Si el vehículo ya está en FLITO verá la tarjeta Ya está en FLITO con los días que le quedan: si le faltan 30 días o menos (o ya venció) pulse Renovar para seguir con el formulario; si faltan más de 30, solo puede Consultar otro vehículo. Si ya tiene una solicitud en proceso, el aviso le dice en qué estado está. Y si pidió un SOAT inicial para un vehículo que ya está en FLITO, el aviso le ofrece Renovar, que pasa a Renovación. Si el RUNT no registra un SOAT anterior para la placa, se lo dice y le sugiere elegir SOAT inicial. Formulario Solicitud de SOAT con la compañía fija, el campo VIN con Consultar el RUNT y, al pie, la frase Para enviar falta y el botón Enviar solicitud Con el vehículo confirmado, adjunte la factura de venta en PDF: un solo archivo, máximo 15 MB. Al adjuntarla, FLITO la lee sola —usted no pulsa nada— y llena con ella los datos del propietario. Mientras dura, el bloque dice Leyendo la factura… y el formulario sigue tecleable: puede seguir llenándolo sin esperar. Cuando termina, el bloque queda marcado ✓ Factura leída y le dice cuántos datos tomó —Tomamos 8 datos del propietario de esta factura y los escribimos abajo. Revíselos antes de enviar.—. La lectura es una ayuda, no una garantía: revise siempre lo que quedó escrito, porque lo que se envía es lo que usted deja en el formulario. Si se equivocó de archivo, Quitar el archivo lo retira sin borrar nada de lo que ya esté escrito; Volver a leer repite la lectura con el archivo adjunto. Revise y complete el propietario, que ahora es obligatorio entero. Los datos que la factura trajo aparecen ya escritos y se pueden corregir todos, tipo y número de documento incluidos: son campos normales, no hay nada bloqueado. El correo electrónico lo escribe usted: no está en la factura y la lectura no lo saca de ahí, así que tras una lectura buena es el único campo que queda vacío —no es un fallo—. Si el tipo de documento es NIT, escriba la razón social; en cualquier otro caso, nombre/s y apellido/s por separado. Correo, celular, dirección, municipio y departamento también son obligatorios: sin ellos no se envía, y el primer campo que falte queda marcado y enfocado. Los datos de los que el lector no quedó seguro salen marcados ⚠ Revise este dato: compruébelos y pulse Confirmar, o corríjalos —corregir ya cuenta como revisar—. Mientras queden marcas, el envío se lo enumera igual que los campos que faltan: Para enviar falta: revisar 2 datos leídos., y pulsar el botón le lleva al primero. El botón Enviar solicitud queda en una barra fija al pie del formulario, de lado a lado de la pantalla, mientras usted baja, con lo que falta por llenar; la solicitud no se guarda como borrador: al enviarla, entra en gestión. Pulse Enviar solicitud: la solicitud queda en Solicitado, sale al gestor por defecto de su compañía y usted vuelve a su cola. No pasa por ninguna revisión de FLITO. Usted no escribe placa, marca, línea, modelo ni organismo, y lo que muestra la ficha del RUNT es referencia: no se copia a ningún campo, ni siquiera el nombre del propietario que allí aparezca. Si la opción no está disponible para su compañía, no verá Solicitar SOAT; si entra por un enlace directo, verá la tarjeta Esta opción no está disponible por ahora para su compañía. Si la necesita, comuníquese con su asesor de FLITO. La cola sigue funcionando igual. Si la aseguradora pide más soportes, adjúntelos en 4 · Documentos adicionales (opcional), al final del formulario. Es opcional: sin él la solicitud se envía igual. Pulse Elegir archivos (después, Elegir más archivos) y escoja uno o varios: PDF, JPG, PNG, WEBP o HEIC, hasta 15 MB cada uno, hasta 20 archivos y 250 MB en total. Cada archivo aparece con su tipo y su tamaño y un campo Etiqueta (opcional) para decir qué es; si no la escribe, queda el nombre del archivo. Antes de enviar puede quitar cualquiera con su ✕. Lo que no cumple —otro formato, más de 15 MB, más de 20 archivos, más de 250 MB o un archivo que ya eligió— se aparta en No se van a adjuntar con el motivo, y no le impide enviar. Los documentos viajan con la solicitud al pulsar Enviar solicitud: si al guardarlos alguno no se pudo adjuntar, el aviso de confirmación le dice cuál y por qué. Si el envío falla, los archivos y sus etiquetas siguen en el formulario para reintentar. Si adjunta otra factura o pulsa Volver a leer después de haber escrito o corregido datos, FLITO no los pisa sin avisar: le muestra qué campos dicen otra cosa, con lo que usted escribió y lo que dice la factura, uno por línea y con su casilla marcada. Desmarque los que quiera conservar y pulse Reemplazar —el botón dice cuántos va a reemplazar— o Conservar lo que escribí para dejarlo todo como está. Lo que no acepte conserva su valor y sigue contando como escrito por usted. Un dato que la nueva lectura no traiga no borra el que ya había. Si el RUNT contesta otra cosa, el formulario se lo dice y no se radica nada. Son respuestas distintas y se leen distinto a propósito. Si el vehículo ya está cubierto, depende de cuánto le quede a esa vigencia. Si vence dentro de 30 días o menos, no se le corta el paso: en el bloque 1 · Vehículo aparece la tarjeta Este vehículo todavía tiene SOAT activo, con el chip Puede continuar y cuántos días le quedan, y usted sigue el formulario hasta Enviar solicitud; la solicitud queda como una renovación anticipada. Si le quedan más de 30 días, en el mismo lugar aparece la tarjeta Este vehículo ya tiene SOAT activo, con el chip No hace falta comprar otro y el botón Consultar otro vehículo, que limpia el VIN para probar con otro: no se envía la solicitud y no se compra nada. Las dos tarjetas muestran los datos de la póliza que el RUNT reporta: Aseguradora, Vence, Póliza, Inicio de vigencia, Fecha de expedición y Estado. El dato que el RUNT no envía aparece como —. Y si el RUNT dice que está vigente pero no dice hasta cuándo, tampoco se radica. Si el VIN no coincide con el del registro, verá Revise el VIN: no coincide con el que el RUNT tiene registrado y qué comprobar: la tarjeta de propiedad o la factura de venta. Si el RUNT no tiene ese VIN, se lo dice con esas palabras. Si el servicio no respondió, verá El RUNT no está respondiendo en este momento., que no es un problema de sus datos. Puede esperar un momento y pulsar Volver a consultar, o completar la factura y el propietario y pulsar Guardar pendiente de validar: lo que escribió no se pierde. Mientras falten datos, la pantalla le enumera lo que falta, igual que al enviar. Al guardar, el formulario se reemplaza por la tarjeta Su solicitud quedó guardada, pendiente de validar, con Ir a mis SOAT —que abre la cola con la pastilla Por validar ya puesta— y Solicitar otro SOAT. Los documentos adicionales que haya adjuntado sí se guardan con la solicitud pendiente de validar: la tarjeta le dice cuántos se guardaron y, si alguno no se adjuntó, cuál y por qué. Esa solicitud no llega al gestor hasta que el RUNT confirme el vehículo. Si usted puede reintentar la consulta, la tarjeta se lo dice: la consulta se repite desde Mis SOAT con Reintentar consulta. Lo mismo pasa si el RUNT respondió al consultar pero deja de responder justo cuando usted envía. Si cambia el VIN, la opción de guardar se cierra hasta volver a consultar. Y si ese VIN ya está en la cola de FLITO, el aviso se lo dice y le lleva a la solicitud que ya existe: el SOAT de un vehículo no se radica dos veces. Tampoco se puede radicar un VIN que ya tiene una solicitud pendiente de validar: el aviso se lo dice. Como Cliente, cuando su solicitud llega a Pagado, ábrala con Ver y pulse Ver soporte: ahí está la póliza en PDF, que puede abrir en una pestaña nueva o descargar. Si su usuario tiene la función de descargar soportes, también puede bajarla directo con Descargar comprobante en el detalle o con el icono de su fila, y marcar dos o más solicitudes pagadas para bajarlas juntas en un ZIP. Antes de Pagado la póliza todavía no existe. La factura de venta que usted cargó sí la ve en cualquier momento, que es lo que le permite comprobar cuál subió. Como Cliente, para renovar muchos vehículos a la vez, elija el tipo Renovación y, en Forma de cargar, la opción Masiva (Individual sigue siendo el formulario de siempre). Pulse Descargar plantilla, llene una fila por vehículo y suba el Excel .xlsx (hasta 200 filas) con Cargar renovaciones. Una tabla muestra cada placa con su estado (En cola, Consultando, Creada, Por validar o Rechazada) y los datos del vehículo conforme el RUNT responde, sin recargar. Puede salir de la página: el proceso sigue en FLITO, pero no hay pantalla para retomarlo. Al terminar, Resultado de la carga le dice cuántas quedaron creadas, en Por validar y rechazadas (con placa y motivo) y por qué están pendientes (esperan la factura de venta, faltan datos del propietario); pulse Descargar rechazadas para corregirlas, Ir a Por validar (cuando no hay rechazadas y quedan pendientes por completar) o Ver en Por validar para completarlas, o Cargar otro archivo. Solo puede haber una carga en curso por compañía. Por privacidad, las placas de las creadas y por validar se borran del servidor al terminar la carga, y el archivo de rechazadas deja de estar disponible unos minutos después de descargarlo. Para cargar muchos SOAT iniciales a la vez, elija el tipo SOAT inicial y, en Forma de cargar, la opción Masiva (Forma de cargar aparece con los dos tipos y la plantilla la define el Tipo de SOAT que eligió). Descargue la plantilla, escriba solo el VIN de cada vehículo y suba el Excel con Cargar vehículos (SOAT inicial en masa, hasta 200 filas). La factura de venta se carga después, en Por validar. Cada solicitud queda en Por validar con Falta factura de venta (o Faltan datos del propietario, en una renovación) y el botón Completar, que solo ve quien puede solicitar SOAT; los demás ven Ver. En Completar de un SOAT inicial elija la factura de venta en PDF (hasta 15 MB): se envía sola, FLITO muestra Leyendo la factura…, revisa que el VIN coincida y llena los datos del propietario. Revíselos, escriba lo que falte (el correo siempre) y pulse Crear solicitud: hasta ese clic la solicitud no sale al gestor. Avisos posibles: No pudimos confirmar el VIN de la factura; compárelo con el de la solicitud. (no la rechaza), No pudimos leer la factura, pero quedó guardada. Escriba los datos del propietario a mano. y El documento de la factura es distinto al que consultamos en el RUNT. Dejamos el del RUNT; revise que sea correcto. Si el VIN no coincide, verá El VIN de la factura no coincide con el de la solicitud. Cargue la factura correcta. y la solicitud sigue pendiente. En una renovación pendiente el formulario está desde el inicio y la factura es opcional. Al crear, un aviso dice Solicitud creada y enviada al gestor. y la fila sale de Por validar; si algo falla, Reintentar conserva lo escrito y el archivo. Diagrama: Pendiente pasa a Solicitado al enviar al gestor y a Pagado al cargar la factura; Rechazar lo deja en Con novedad y Reactivar lo devuelve; una solicitud del canal SOAT sin trámite entra en Solicitado si el RUNT responde, queda Por validar si no responde y va a Descartadas si el RUNT lo impide"
      },
      {
        "ancla": "estados",
        "titulo": "Estados",
        "texto": "Cargando: la tabla aún no aparece. En Solicitar SOAT, mientras se lee la factura el bloque 2 · Factura de venta muestra Leyendo la factura…; nada se bloquea y usted puede seguir llenando el formulario. Cargando, error y vacío de Documentos adicionales en el detalle: mientras carga se ven filas grises; si falla, No se pudieron cargar los documentos adicionales. con Reintentar; si la solicitud no tiene ninguno, Sin documentos adicionales. (y, si usted puede cargar, la invitación a usar Cargar documentos). Si una carga o una eliminación falla, el aviso lo explica y ofrece Reintentar cuando tiene sentido; la lista queda como estaba Error: si la cola no carga, una tarjeta le dice que no se pudo cargar la cola de SOAT y le ofrece Reintentar. Los errores de una acción (enviar, cargar, rechazar) ya no aparecen ahí: se los dice un aviso o el propio detalle. Si la lectura de la factura no sale, el bloque queda en No se pudo leer con Volver a leer la factura, y dice si fue el lector el que no respondió o si hizo varias lecturas seguidas y toca esperar. Si el archivo no es un PDF de verdad, la caja lo rechaza al adjuntarlo y no hay lectura que repetir. Vacío: en Por validar, No hay solicitudes por validar. Aquí quedan las que esperan al RUNT, la factura de venta o los datos del propietario.; en Descartadas, No hay solicitudes descartadas. Aquí quedan, sin borrarse, las que el RUNT no dejó continuar. En las demás: No hay SOAT en esta vista. Sincroniza desde el Tablero para traer trámites nuevos. Un usuario con enlace ve en su lugar No hay SOAT de su compañía en esta vista. (o asignados a su proveedor). Con filtros: Ningún SOAT coincide con los filtros., con la sugerencia de quitar alguno. El Proveedor y el Auditor tienen su propio mensaje de vacío, que les dice qué esperar. En Solicitar SOAT, una factura que se lee pero no trae datos del propietario se lo dice —No pudimos sacar los datos del propietario de esta factura. Escríbalos a mano: la solicitud se puede enviar igual.— y el formulario se llena como siempre. Carga masiva (renovaciones y SOAT inicial): mientras se recibe el archivo, Recibiendo el archivo… y Cargando…; mientras llega el primer avance, Preparando el avance…; en curso, Procesando: n de total filas con filas grises mientras llega el primer avance; si falla, No pudimos cargar el archivo o No pudimos actualizar el avance con Reintentar; terminada, Resultado de la carga con la tabla de filas. Lleno: una solicitud Por validar muestra el VIN con Datos del RUNT pendientes en lugar de la placa, el chip Por validar con Último intento: y la fecha, — en solicitado y pagado, y solo Ver; su detalle dice Pendiente de validar con el RUNT, con el VIN, la compañía, quién y cuándo la solicitó, el propietario y la factura. Una Descartada muestra su chip y Ver; el detalle da el Motivo, Cuándo y Quién la descartó —FLITO si fue alguien de fuera de su compañía— y aclara que la solicitud no se borra: queda aquí como constancia. Tabla Pólizas SOAT con vehículo, estado (con un icono por estado), compañía, quién gestiona, solicitado, pagado y valor. El Cliente ve la columna de compañía solo si su cola tiene más de una. Las filas marcadas se ven resaltadas. Junto a la placa y el VIN, cada fila le muestra también los datos del vehículo que llegan de FLIT: cilindraje, carrocería y tipo de servicio. El dato que FLIT no envía aparece como — y no es un error. Una fila asumida muestra el chip Operaciones. Las solicitudes que llegan por el canal SOAT sin trámite aparecen ya en Solicitado y con su gestor asignado: no pasan por revisión de Operaciones. El gestor es el proveedor que la compañía tenga elegido en Clientes y proveedores, columna SOAT sin trámite; si ese proveedor está inactivo, la solicitud queda Gestionado por Operaciones. Puede quedar alguna solicitud antigua de ese canal en Pendiente de revisión o Rechazada: son anteriores a este cambio y ya no tienen pastilla propia con la que filtrarlas. Cuando la póliza queda cargada, el SOAT pasa a Pagado y el documento queda disponible en Ver soporte para la compañía dueña de la solicitud. En las filas con comprobante cargado, junto al estado aparece la vigencia frente al RUNT —Vigente hasta, Venció el, Sin SOAT en el RUNT o No se pudo consultar— con la fecha de la última respuesta del RUNT. FLITO la comprueba sola cada madrugada; mientras no haya habido ninguna respuesta, la fila dice Sin verificar. Una fila sin comprobante cargado no se verifica y no muestra nada. El filtro Sin verificar trae las dos: las que se acaban de cargar y las que no se pudieron consultar. En Solicitar SOAT, si el vehículo ya tiene SOAT y le quedan 30 días o menos, el bloque 1 · Vehículo muestra la tarjeta Este vehículo todavía tiene SOAT activo con el chip Puede continuar y los datos de la póliza, sin bloquear el envío; no es un error y no hay nada que corregir."
      },
      {
        "ancla": "que-no-hace",
        "titulo": "Qué no hace",
        "texto": "No despacha el trámite ni solicita el SOAT desde aquí: eso se origina en Gestión Trámites. No liquida, no Factura en sentido FLITO (congelar liquidación) ni hace emisión electrónica. No gestiona impuestos, derechos de tránsito ni comparendos. El Proveedor no ve ni envía los Pendiente; esa frontera la resuelve el Administrador. Si su rol está ligado a una compañía, un proveedor o unas secretarías, no verá Enviar a ni Enviar al gestor, y en el detalle tampoco Cambiar proveedor ni Devolver al proveedor: escoger o cambiar el proveedor lo hace FLITO, aunque su rol tenga esas funciones. Los filtros de Más filtros le muestran solo las compañías, secretarías y proveedores de su propia cola. Rechazar deja el SOAT en Con novedad y lo resuelve FLITO con el gestor: no devuelve la solicitud a quien la radicó ni le pide corregir nada. El Cliente lo ve así en el detalle y no tiene que hacer nada. Esta pantalla no revisa ni aprueba solicitudes: una solicitud del canal SOAT sin trámite entra directamente en gestión. No hay Validar, ni causales de rechazo de solicitud, ni Corregir y reenviar. Una solicitud radicada no se edita. Si el VIN o el propietario están mal, la solicitud correcta es otra: avise a FLITO y radique la que corresponda. No se radica una solicitud del canal SOAT sin trámite sin consultar antes el RUNT: si el vehículo no aparece o si los datos no corresponden, la solicitud no se crea. Si el servicio no responde, la solicitud se puede guardar pendiente de validar, pero no se envía al gestor ni se compra nada hasta que el RUNT confirme el vehículo. Que el vehículo tenga SOAT vigente ya no lo impide siempre: solo bloquea si a esa vigencia le quedan más de 30 días, o si el RUNT no dice hasta cuándo vence. Consultar el RUNT no radica nada ni compra nada: solo comprueba. El margen para renovar por anticipado no lo decide esta pantalla ni usted: lo fija FLITO y hoy es de 30 días, contados desde el día de la consulta. La pantalla solo le muestra lo que el RUNT responde y si puede continuar o no. La tarjeta SOAT activo muestra la póliza que el RUNT reporta, pero no el NIT de la aseguradora: el RUNT no lo entrega, así que la aseguradora aparece por su nombre. El formulario no le pide la placa ni el documento del propietario para consultar el RUNT: desde el VIN, el registro devuelve la placa y la ficha técnica. La ficha del RUNT es de solo lectura y no se corrige aquí: si un dato no coincide con su vehículo, corríjalo ante su organismo de tránsito antes de pedir el SOAT. La consulta al RUNT no le rellena el propietario. Si el RUNT trae un nombre, se lo muestra como referencia y usted escribe el que va en la solicitud. Quien puede llenar esos campos es la factura de venta, no el registro. La lectura de la factura acelera el trabajo, pero no lo bloquea: si la factura no se deja leer, si el lector no responde o si vuelve sin datos, escriba el propietario a mano y envíe la solicitud igual. Ningún fallo de la lectura impide crear la solicitud, y ninguno añade un requisito nuevo para enviarla. La lectura no saca el correo electrónico de la factura —no está ahí— ni toca el VIN: lo que lee son los datos del comprador, y el vehículo lo sigue confirmando el RUNT. FLITO no da por buenos los datos leídos por usted: lo que se envía es lo que quede escrito en el formulario cuando pulse Enviar solicitud. El Cliente no ve los documentos internos de la operación: solo la póliza de su SOAT y la factura de venta que él mismo cargó. Los documentos adicionales que adjunta al solicitar los ve quien tenga la función de verlos; sin ella, la sección no aparece en el detalle. Los documentos adicionales no salen en Descargar soportes, ni en el ZIP, ni en Exportar a Excel. Después de enviada la solicitud, solo los agrega o quita desde el detalle quien tenga esas funciones; el Cliente no las tiene de partida. Eliminar un documento adicional es definitivo. Esta pantalla no envía la póliza por correo ni la adjunta a ningún mensaje: se descarga desde aquí. Exportar a Excel no se lleva la página que está viendo ni las filas marcadas: se lleva el conjunto filtrado completo. Si ese conjunto es demasiado grande, no entrega un archivo recortado; le pide acotar el filtro. Sin la función de exportar a Excel no verá Exportar a Excel. De partida la tienen el Administrador y el proveedor; el Auditor y el Cliente no, salvo que se les conceda desde Roles y permisos. Sin la función de descargar soportes (por ejemplo, el Auditor) no verá el botón Descargar soportes, ni el icono de descarga de las filas, ni Descargar comprobante en el detalle; puede usar todos los filtros y Ver soporte si tiene esa función. Salvo Reintentar consulta en una solicitud Por validar, no consulta el RUNT cuando usted lo pida: la verificación de vigencia la hace FLITO una vez al día y su resultado no se edita desde esta pantalla. La carga masiva no arregla un ZIP: si trae un archivo de más de 15 MB, hay que sacarlo del ZIP, comprimirlo de nuevo y volver a elegirlo. Desde el modal no se puede quitar."
      }
    ]
  },
  {
    "clave": "flito_impuestos",
    "permiso": "flito_impuestos",
    "etiqueta": "Impuestos",
    "resumen": "Cola de recibos del gestor de impuestos.",
    "version": "1.2",
    "fecha": "2026-10-22",
    "palabrasClave": [
      "impuestos",
      "recibos",
      "gestor de impuestos",
      "impuesto vehicular"
    ],
    "consultas": [
      "cómo cargo un recibo de impuestos",
      "qué recibos están pendientes"
    ],
    "secciones": [
      {
        "ancla": "que-es",
        "titulo": "Qué es",
        "texto": "Cola del impuesto vehicular por organismo. La factura de venta del trámite es precondición del envío; el pago se reconoce cuando usted valida el recibo. Facturar en FLITO (congelar la liquidación) no es esta pantalla, y tampoco es emisión electrónica."
      },
      {
        "ancla": "para-quien",
        "titulo": "Para quién",
        "texto": "Gestor de Impuestos (ve Solicitado y Pagado de los organismos que el Administrador le haya asignado —pueden ser varios—; nunca los Pendiente). Administrador (ve toda la cola y puede enviar o asumir). Auditor (solo lectura)."
      },
      {
        "ancla": "como-se-entra",
        "titulo": "Cómo se entra",
        "texto": "En la barra de navegación al pie de la pantalla, pulse Gestión y, en el grupo SOAT e Impuestos del panel que se abre, el ítem Impuestos. En pantallas pequeñas, use el botón de menú de la barra superior; también puede pulsar Ctrl + K (Command + K en Mac) y escribir «Impuestos»."
      },
      {
        "ancla": "pasos",
        "titulo": "Pasos",
        "texto": "Filtre con Todos, Pendiente, Solicitado, Con novedad o Pagado. El gestor no ve Todos ni Pendiente. Busque placa, VIN, trámite o comprador. Use Compañía, Organismo y Gestiona (Cualquiera, Operaciones o El organismo); en Vista, Listos para enviar, Sin gestión o Con alertas; los rangos Solicitado y Pagado, y Solo sin gestión si aplica. El gestor no ve Organismo, Gestiona ni Listos para enviar. Limpiar filtros los quita todos. Para acotar por la fecha en que el impuesto quedó registrado en FLITO, use el rango Creado en FLITO; es distinto de la columna Creado de la tabla, que muestra la fecha del trámite en FLIT. Cola de Impuestos con las pastillas de estado, el buscador, los filtros y cuatro impuestos demo con su estado, el documento cargado y el semáforo de la validación contra el RUNT Para llevarse la cola a Excel, pulse Exportar a Excel en el encabezado. El archivo trae el conjunto filtrado completo, no solo la página que está viendo ni las filas que haya marcado. Mientras se genera, el botón dice Preparando el archivo…; al terminar, un aviso le confirma el nombre del archivo descargado y se quita con Cerrar el aviso. Si el filtro trae más filas de las que admite un archivo, no se descarga nada: verá un aviso pidiéndole acotar la búsqueda. El Auditor no ve esta acción. Si su usuario tiene la función de exportar datos de pago (de partida, solo el Administrador; se reparte desde Roles y permisos), verá junto al botón la casilla Incluir datos de pago y trazabilidad: márquela y el archivo añadirá al final, después de las columnas del vehículo y el titular, el estado, la fecha de solicitud, la fecha y el valor de la liquidación, el valor y la fecha del pago, si quedó marcado por diferencia, la modalidad, el gestor, el motivo de la novedad y la fecha de creación. Las celdas de pago van vacías mientras el impuesto no esté pagado. Sin la casilla, o sin esa función, el archivo es el de siempre. Los usuarios con enlace (compañía u organismos) no ven esta casilla: es de uso interno. Con la casilla marcada, si el archivo incluye impuestos cuya dirección del comprador aún no se ha confirmado, el aviso de la descarga lo dice (por ejemplo, El archivo incluye 3 impuestos con dirección sin confirmar. Revísalos en su detalle antes de usar el archivo.). El archivo trae igual todas las filas; el aviso se quita con Cerrar el aviso. Si no hay ninguna, el aviso es el de siempre. Marque las filas que necesite: la casilla ya no se limita a las que admiten una acción. Enviar al gestor, Gestionar en Operaciones y Certificar siguen aplicando solo a las filas que ya las admitían, y el botón se lo dice: con ocho marcadas de las que tres son enviables, verá Enviar al gestor (3 de 8). Cuatro impuestos demo marcados: la barra ofrece Enviar al gestor (1 de 4), Gestionar en Operaciones (1 de 4), Certificar (2 de 4), Descargar soportes y Descargar certificados Con filas marcadas, pulse Descargar soportes (N). Se abre Documentos del ZIP, donde elige Factura de venta, Recibo del impuesto o los dos, y obtiene un solo archivo ZIP con lo elegido. Cada registro llega como un solo PDF con sus documentos en este orden: factura de venta y recibo del impuesto; el archivo se llama con la placa (por ejemplo, ABC123.pdf). Si un documento viene protegido y no se puede unir, va aparte, tal cual, como ABC123-2.pdf. Si un documento está dañado y no se puede leer, queda fuera y el aviso final le dice cuántos. Mientras se prepara verá Preparando el archivo…; con muchas filas puede tardar unos minutos. Si ninguna de las filas marcadas tiene el documento que eligió, no se descarga un ZIP vacío: verá un aviso. Si lo marcado pesa más de lo que admite una descarga, marque menos filas y repita. Con filas marcadas, pulse Descargar certificados (N), al lado de Descargar soportes, para llevarse en un solo ZIP el certificado RUNT en PDF de cada registro marcado, hasta 300 a la vez. Cada certificado se llama con la placa (por ejemplo, ABC123.pdf; una placa repetida sale como ABC123-2.pdf). Mientras se prepara, el botón dice Preparando certificados…. Al terminar, un aviso en la página le dice cuántas de las filas marcadas tenían certificado; las que no lo tenían quedan fuera y el ZIP trae el archivo omitidos.csv con cuáles y por qué. Si ninguna de las filas marcadas tiene certificado, no se descarga nada: el aviso le lista las que no tienen certificación vigente (certifíquelas y vuelva a descargar) y las que ya no están en su cola (actualice la página y vuelva a marcarlas). Si marca más de 300, el aviso le pide marcar menos; si descarga varias veces seguidas, le pide esperar un minuto y le ofrece Reintentar la descarga. Solo lo ve quien tiene la función de descargar certificados. El recibo del organismo se carga en dos fases. La liquidación es el documento de la hacienda sin sello: deja el impuesto Solicitado con su valor y su fecha de liquidación, sin pagarlo. El pago es el mismo documento con el sello de pagado: es la única vía a Pagado. En el encabezado, Cargar recibos (masivo) admite PDF, imágenes o un ZIP: hasta 150 archivos sueltos o 300 dentro de un ZIP, de máximo 15 MB cada uno. Elija la Fase del recibo (Pago viene marcado), elija los archivos y pulse Subir y procesar. Dentro de un ZIP manda la carpeta de cada recibo: liquidaciones_originales o sin marca es Liquidación; liquidaciones_pagadas, pagadas o con marca es Pago. Si una carpeta no dice ninguna de las dos, FLITO se lo avisa antes de enviar y esos recibos toman la fase que usted eligió. FLITO no adivina la fase por el documento. Al terminar, el resumen dice cuántos quedaron Liquidados, Conciliados, En revisión, Complementos, Duplicados, Sin asociar y Fase no coincide, y la lista indica el resultado de cada archivo. Fase no coincide significa que el sello del documento contradice la fase elegida (un pago sin sello, una liquidación con sello, o dos documentos de la misma placa que no se distinguen): esos recibos no se guardaron; vuelva a subirlos con la fase que el detalle le indica. Ventana Carga masiva de recibos de impuesto con los límites de archivos, la Fase del recibo en Pago y el botón Subir y procesar En la columna Estado, cada fila dice qué documento tiene el impuesto: Liquidación (falta el pago), Pago o Ambos; sin documento no muestra nada. Al posar el cursor sobre Liquidación ve la fecha en que se cargó. Para ver solo los Solicitados con liquidación cargada y sin pagar, marque Liquidado, pendiente de pago; se combina con los demás filtros y Limpiar filtros lo desmarca. Si combina esa casilla con Pagado no verá filas: el aviso se lo explica. Para pagar un impuesto puntual en ventanilla, abra su detalle con Ver y pulse Cargar recibo de caja, al lado de Ver soporte. Solo lo ve el Administrador (o quien tenga la función de recibos de caja), y solo en un impuesto Solicitado; si el impuesto no tiene liquidación cargada, el botón aparece deshabilitado y le dice por qué. Elija un solo archivo PDF, JPG o PNG de hasta 15 MB y pulse Cargar. Si FLITO lee el valor, el impuesto pasa a Pagado y verá el valor y la fecha leídos; si el valor pagado difiere del liquidado, la fila queda con Diferencia de valor. Si el valor no se pudo leer, el recibo queda guardado y pasa a Revisiones OCR; el impuesto sigue Solicitado hasta que se resuelva la revisión. Un archivo repetido, un impuesto que ya no está en gestión o un lector que no responde se le avisan en el mismo cuadro, con la opción de reintentar o de elegir otro archivo. Para cargar la liquidación o el pago de un impuesto puntual sin armar una carga masiva, abra su detalle con Ver y pulse Cargar comprobante, al lado de Ver soporte. Lo ve el Administrador y el Gestor de Impuestos (o quien tenga la función de cargar recibos), en un impuesto Solicitado o Pagado que aún no tenga los dos documentos; el Auditor no lo ve. En Fase del comprobante elija Liquidación o Pago: no viene ninguna marcada y la fase que ya está cargada aparece como Ya cargada. Elija un solo archivo PDF, JPG o PNG de hasta 15 MB y pulse Cargar; hasta tener la fase y el archivo, el botón le indica Elige la fase y el archivo para cargar. Mientras FLITO lee el documento, el botón dice Leyendo el comprobante…. El resultado aparece en el mismo cuadro: Liquidación cargada (con el valor liquidado; el impuesto sigue Solicitado), Pagado (con el valor pagado y, si difiere del liquidado, Diferencia de valor), En revisión (el pago quedó guardado pero el sello o el valor no se leyeron con claridad; pasa a Revisiones OCR) o Comprobante agregado (en un impuesto ya Pagado). Pulse Listo y el detalle se actualiza sin cerrarse. Si el cuadro dice No se guardó, el comprobante ya estaba registrado o es de otro vehículo (pulse Elegir otro archivo), o el documento no corresponde a la fase elegida (pulse Cambiar fase). Sin liquidación cargada, el botón Cargar recibo de caja le indica Este impuesto no tiene liquidación cargada. Cárgala primero con «Cargar comprobante». En una fila, pulse Ver. Revise Factura de venta (En FLIT · Ver / descargar o Sin factura en FLIT) y Liquidado el (la fecha de la liquidación, o — si no se ha cargado). Según el caso: Rechazar, Reactivar, Asumir en Operaciones, Devolver al gestor, Reversar o Ver soporte. Después de enviar un impuesto, FLITO compara su factura de venta con el RUNT. Mientras lo hace, la celda del trámite muestra Analizando con un indicador de carga; la fila se puede seguir usando. Al terminar aparece un icono de semáforo, sin recargar la página (la fila se actualiza sola en unos segundos; si tiene abierto el detalle, también se actualiza): ✓ verde (la factura cuadra con el RUNT), △ naranja (Con diferencias frente al RUNT) o ✕ rojo (Sin validar). Pase el cursor sobre el icono para leer el detalle; en rojo le dice el motivo: El RUNT no respondió o no tiene registro del vehículo o No se pudo leer la factura. Si el análisis no terminó, el icono rojo dice Sin validar: la validación no terminó. Al enviar varios a la vez, un aviso en la página le dice cuántos quedaron en análisis contra el RUNT. Pulse Actualizar la cola para ver los semáforos cuando terminen, o cierre el aviso con Cerrar aviso. Para ver solo los que tienen alertas, elija Con alertas en Vista: muestra los de semáforo naranja o rojo y se combina con los demás filtros. Limpiar filtros lo quita. Haga clic en el icono del semáforo para abrir la Validación factura ↔ RUNT sin salir de la cola. En verde o naranja verá un resumen (por ejemplo, 2 datos no coinciden: Color, Cilindraje.) y una tabla con lo que dice la factura (En factura) y lo que dice el RUNT (En RUNT) para VIN, Marca, Modelo (línea), Año, Color y Cilindraje, con un icono por fila: ✓ si coincide, △ si no. La fila Dirección del comprador muestra la dirección de la factura; en la columna del RUNT dice No aplica, porque ese dato no se compara. En rojo, la ventana le explica el motivo en lugar de la tabla. Desde ahí, Ver detalle abre el impuesto completo. Ventana Validación factura ↔ RUNT de un impuesto demo con diferencias: 2 datos no coinciden, Color y Cilindraje, con lo que dice la factura y lo que dice el RUNT El detalle del impuesto (Ver) incluye la sección Validación factura ↔ RUNT con el mismo resumen y la misma tabla. Si el impuesto aún no se ha enviado, la sección le indica que se valida al enviarlo al gestor. Detalle de un impuesto demo Solicitado con su liquidación: datos del trámite, factura de venta en FLIT, Ver soporte, Cargar comprobante, Cargar recibo de caja y la sección de validación contra el RUNT Si el semáforo quedó en rojo o la validación no terminó, y el impuesto no está certificado, pulse Reintentar validación: está en la ventana del semáforo (como botón principal) y en la sección Validación factura ↔ RUNT del detalle; no está en la fila, que conserva Certificar. Mientras se envía, el botón dice Reintentando…. Al quedar en cola, la ventana del semáforo se cierra (en el detalle, la sección pasa a La validación está en curso. El resultado aparece aquí en cuanto termine.), la fila pasa a Analizando y un aviso breve le dice Validación en cola. El semáforo se actualiza solo en cuanto termine.; ciérrelo con Cerrar aviso. Si no se pudo, el motivo aparece en la misma ventana o sección (por ejemplo, Esta validación ya está en curso. El semáforo se actualiza solo en cuanto termine. o Este impuesto no tiene una validación que reintentar., que es el caso de los impuestos enviados antes de que existiera la validación) y puede volver a pulsar el botón. Solo lo ve quien tiene la función de certificar impuestos; sin ella, el texto del rojo le indica Pide a quien certifica en tu equipo que reintente la validación. Cuando la validación sale bien, FLITO puede certificar el impuesto por su cuenta. La fila muestra entonces el chip Certificado en lugar de Certificar; al pasar el cursor dice Certificado automáticamente el y la fecha, y al pulsarlo descarga el certificado en PDF, igual que una certificación hecha por una persona. El certificado incluye el bloque Registro del vehículo (RUNT) (clasificación, color, cilindraje, servicio, organismo, estado, fecha de matrícula, motor, chasis y serie; lo que el RUNT no reporte sale como No reportado por el RUNT) y la fecha y hora de Consulta RUNT y certificación. Sin la función de descargar certificados, el chip se ve pero no descarga. Si la dirección del comprador leída de la factura está pendiente de revisión, el detalle del impuesto muestra arriba el aviso Dirección sin confirmar — revísala y guárdala. Pulse Revisar dirección para ir al campo. En la sección Dirección del comprador, revise Dirección, Municipio y Departamento (vienen con lo leído de la factura; los tres son obligatorios) y pulse Guardar dirección. Al guardar, un aviso breve le confirma Dirección guardada., el aviso de arriba desaparece y la sección indica que la confirmó usted (Confirmada por) y la tabla de la validación muestra la dirección nueva. Si no se pudo guardar, el motivo aparece bajo el botón y puede volver a pulsarlo. Mientras tenga abierta otra acción del detalle (Rechazar, Reversar…), la dirección no se puede editar: termine o cancele esa acción primero. Solo lo hace quien tiene la función de corregir la dirección del comprador (de partida, solo el Administrador); sin ella verá la dirección y el aviso Dirección sin confirmar. Debe revisarla alguien con permiso para corregir direcciones. Si el trámite viene de FLIT 2, el detalle del impuesto (Ver) muestra, junto a Soporte, la celda Comprobante en FLIT 2: le dice si FLITO ya le entregó el comprobante de pago al trámite en FLIT 2. El envío es automático cuando el impuesto queda Pagado; usted no tiene que pulsar nada. Los estados son Pendiente (en cola para enviarse), En espera de FLIT 2 (el trámite aún no admite el comprobante; FLITO lo enviará solo cuando lo admita), Enviado a FLIT 2 (con la fecha del envío), Ya lo cargó el gestor (el gestor de FLIT 2 subió el suyo antes y ese es el que vale), Error de envío (FLITO no pudo enviarlo; si el archivo estaba mal, reemplácelo) y Sin comprobante (se enviará cuando se cargue el comprobante de pago). Bajo el estado verá la fecha del último intento cuando la hay. Si el trámite viene de FLIT 1, la celda se llama Comprobante en FLIT 1 y funciona igual: FLITO deja el comprobante como documentación del trámite en FLIT 1 cuando el impuesto queda Pagado. Sus estados son Pendiente, Enviado a FLIT 1 (con la fecha del envío), Error de envío (FLITO no pudo enviarlo tras 3 intentos; si el archivo estaba mal, reemplácelo) y Sin comprobante. Si el trámite no viene de FLIT 1 ni de FLIT 2, la celda no aparece. Si no se pudo consultar, la celda dice No se pudo consultar el envío a FLIT 2. (o a FLIT 1.; al abrir el detalle por primera vez, No se pudo consultar el envío del comprobante.) y ofrece reintentar. Para corregir un comprobante de pago equivocado o ilegible, abra el detalle con Ver y pulse Reemplazar comprobante, en la celda Soporte. Solo aparece en un impuesto Pagado que ya tiene comprobante de pago (no basta con el recibo de caja) y solo si su usuario tiene la función de reemplazar comprobantes, que nace sin asignar a ningún rol, ni siquiera al Administrador: se concede desde Roles y permisos. En el cuadro, el aviso le recuerda que El comprobante de pago actual se descarta y queda el nuevo. El valor pagado y la fecha de pago no cambian. Elija un solo archivo PDF, JPG o PNG de hasta 15 MB y pulse Reemplazar comprobante. FLITO lo valida igual que Cargar comprobante. Si todo va bien, un aviso breve le confirma el reemplazo (por ejemplo, Comprobante reemplazado. FLITO enviará el nuevo a FLIT 2.), el detalle se actualiza y la celda Comprobante en FLIT 2 vuelve a Pendiente. En un trámite de FLIT 1 el aviso dice Comprobante reemplazado. FLITO enviará el nuevo a FLIT 1. y el nuevo pasa a ser el comprobante del trámite allá. Si el gestor ya había cargado el suyo en FLIT 2, el aviso le dice que el nuevo no se envía. Si el trámite no viene de FLIT 1 ni de FLIT 2, el aviso le dice que el comprobante queda solo en FLITO. Si el archivo es de otro vehículo, ya estaba cargado o no es un comprobante de pago, el cuadro se lo dice y El comprobante anterior sigue vigente. Diagrama: un impuesto Pendiente pasa a Solicitado al enviarlo; la liquidación lo deja Solicitado con su valor y el pago con sello lo lleva a Pagado; Rechazar lo deja Con novedad; al enviarlo, la factura se compara con el RUNT y el semáforo queda verde, naranja o rojo"
      },
      {
        "ancla": "estados",
        "titulo": "Estados",
        "texto": "Cargando: la tabla aún no aparece. Error: mensaje en rojo sobre la tarjeta. Vacío: No hay impuestos en esta vista. Sincroniza desde el Tablero para traer trámites nuevos. Un usuario con enlace ve en su lugar No hay impuestos de su compañía en esta vista. (o de sus secretarías). Con filtros: Ningún impuesto coincide con los filtros. Con Liquidado, pendiente de pago marcado: No hay impuestos liquidados pendientes de pago con estos filtros. Con Con alertas: Ningún impuesto tiene alertas con estos filtros. Quita el preset para ver toda la cola. Lleno: tabla con compañía, organismo, quién gestiona (Gestor del organismo u Operaciones), estado, fecha de solicitud con los días que lleva, fecha de pago, liquidado y pagado. Una diferencia de recibo muestra Diferencia de valor. Una fila asumida muestra Operaciones. El documento cargado se ve como Liquidación, Pago o Ambos bajo el estado. En la celda del trámite, Analizando o el semáforo de la validación contra el RUNT, y Certificar o el chip Certificado (también el automático)."
      },
      {
        "ancla": "que-no-hace",
        "titulo": "Qué no hace",
        "texto": "No es Gestión Trámites: aquí no se origina el envío masivo de trámites ni se entrega el trámite. No Factura la liquidación ni dispara emisión electrónica. No carga derechos de tránsito (eso es Derechos) ni resuelve OCR (eso es Revisiones OCR). El gestor no ve ni envía los Pendiente; esa frontera la resuelve el Administrador. Exportar a Excel no se lleva la página que está viendo ni las filas marcadas: se lleva el conjunto filtrado completo. Si ese conjunto es demasiado grande, no entrega un archivo recortado; le pide acotar el filtro. El Auditor no exporta: la exportación es del Administrador y del Gestor de Impuestos. El Auditor tampoco descarga soportes en lote, aunque sí puede marcar filas y usar todos los filtros. Descargar certificados no certifica: solo baja los certificados que ya existen. No consulta el RUNT de nuevo ni guarda el ZIP. La carga masiva no arregla un ZIP: si trae un archivo de más de 15 MB, hay que sacarlo del ZIP, comprimirlo de nuevo y volver a elegirlo. Desde el modal no se puede quitar. No deduce la fase leyendo el documento: la decide usted con el selector o la carpeta del ZIP. El recibo de caja es de uno en uno y desde Ver; no se carga en lote ni paga un impuesto que no tenga liquidación. Cargar comprobante tampoco adivina la fase: la elige usted. No reemplaza un documento ya cargado (para eso está Reemplazar comprobante, solo con el comprobante de pago) ni se ofrece en un impuesto Pendiente o Con novedad. Comprobante en FLIT 2 y Comprobante en FLIT 1 son solo lectura: no tienen botón para reintentar el envío ni dejan ver el motivo de un error. Reemplazar comprobante no cambia el valor ni la fecha del pago, no reemplaza el recibo de caja ni la liquidación, y no se envía a FLIT 2 si el gestor ya cargó el suyo, ni a FLIT 1 o FLIT 2 si el impuesto se pagó antes de que existiera el envío automático. Al reemplazar, FLITO no borra en FLIT 1 el comprobante anterior. El semáforo compara la factura con el RUNT, pero no corrige ninguno de los dos. Un dato que falta en uno de los dos lados aparece como Sin dato y no cuenta como coincidencia. Con alertas no incluye los impuestos que aún no se han analizado. El aviso de dirección sin confirmar no aparece en un impuesto que aún no se ha analizado o cuyo análisis está en curso, y esos impuestos tampoco se cuentan en el aviso de la descarga. Reintentar validación no aparece en un impuesto ya certificado ni en uno cuya validación está en curso, y no se ofrece en lote: es de uno en uno."
      }
    ]
  },
  {
    "clave": "transito_organismos",
    "permiso": "transito_organismos",
    "etiqueta": "Organismos de tránsito",
    "resumen": "Configuración de cada secretaría de tránsito, con su alias, su logo, la modalidad de gestión FLITO y la plantilla de documentos.",
    "version": "1.0",
    "fecha": "2026-10-22",
    "palabrasClave": [
      "organismos de tránsito",
      "secretaría de movilidad",
      "modalidad de gestión",
      "autogestionado",
      "logo del organismo",
      "plantilla de documentos"
    ],
    "consultas": [
      "cómo cambio la modalidad de un organismo",
      "cómo subo el logo de una secretaría",
      "qué documentos pide un organismo de tránsito",
      "qué organismos gestiona FLITO"
    ],
    "secciones": [
      {
        "ancla": "que-es",
        "titulo": "Qué es",
        "texto": "La pantalla Organismos de tránsito: una fila por secretaría de tránsito con su municipio, código, alias, Modalidad FLITO, los usuarios de tránsito que tiene asignados y su estado. La modalidad dice si FLITO gestiona ante ese organismo (Requiere gestión FLITO) o si el organismo lo hace por su cuenta (Autogestionado por el organismo). Desde Editar se configura su nombre corto, su logo, la modalidad, los parámetros de OCR y ANS, y los documentos que exige por tipo de trámite."
      },
      {
        "ancla": "para-quien",
        "titulo": "Para quién",
        "texto": "Quien tenga el ítem Organismos de tránsito. De partida, el Administrador. Cambiar la modalidad y guardar los parámetros de OCR y ANS pide además la acción de editar la configuración de tránsito. Sin ella, la pestaña Autogestión se ve en solo lectura."
      },
      {
        "ancla": "como-se-entra",
        "titulo": "Cómo se entra",
        "texto": "Menú Tránsito, ítem Organismos de tránsito."
      },
      {
        "ancla": "pasos",
        "titulo": "Pasos",
        "texto": "Entre a Organismos de tránsito. El encabezado cuenta cuántas secretarías tienen alias o logo propio. Escriba en el buscador parte de la ciudad, del nombre o del código para filtrar la tabla. Tabla demo de organismos de tránsito con municipio, código, alias, modalidad FLITO, usuarios y estado Pulse Editar en la fila del organismo. En la pestaña General escriba el Alias (el nombre corto que se ve en la bandeja), suba el logo con Subir logo (PNG, JPEG, WEBP o SVG de hasta 512 KB), marque o desmarque Organismo activo en FLIT y pulse Guardar. El logo subido tiene prioridad sobre la URL de un logo externo. Ventana Editar en la pestaña General con el alias, el logo, la URL externa y la casilla de organismo activo En la pestaña Autogestión elija la Modalidad, escriba el Motivo del cambio (mínimo 5 caracteres) y pulse Cambiar modalidad. El Historial de vigencias muestra desde y hasta cuándo rigió cada modalidad, quién la cambió y por qué. Pestaña Autogestión con la modalidad, el motivo, los parámetros de OCR y ANS y el historial de vigencias demo En la misma pestaña ajuste Umbral OCR (0–1), ANS pactado con el organismo (horas) y Marcar diferencia de valor de impuestos (D-5), y pulse Guardar parámetros. En la pestaña Plantilla documentos elija la Tipología. Sobre la lista nacional marque Ocultar en lo que ese organismo no pide, u Obligatorio en un documento opcional que sí exige; con Agregar anexo STT sume un documento propio. Pulse Guardar plantilla: el cambio aplica al asistente del trámite y al envío a tránsito. Pestaña Plantilla documentos con la tipología, la lista de documentos con Ocultar y Obligatorio y un anexo propio del organismo Diagrama del cambio de modalidad: se elige la modalidad, se escribe el motivo y se cambia; la vigencia anterior se cierra, la nueva queda en el historial y decide si FLITO gestiona ante el organismo Un organismo sin modalidad registrada se muestra como Autogestionado por el organismo. Cada cambio queda en el historial con su motivo."
      },
      {
        "ancla": "estados",
        "titulo": "Estados",
        "texto": "Cargando: la tabla dice «Cargando…». Error: si la lista no carga, aparece un aviso con el motivo y la tabla queda sin filas; recargue la página para intentarlo de nuevo. Vacío: «Sin resultados» cuando la búsqueda no coincide con ningún organismo. En Autogestión, «Sin vigencias registradas.» si la modalidad nunca se ha cambiado. Lleno: la tabla con Municipio, Código, Alias, Modalidad FLITO, Usuarios, Estado y Acciones."
      },
      {
        "ancla": "que-no-hace",
        "titulo": "Qué no hace",
        "texto": "No asigna usuarios a un organismo: eso se hace en Usuarios, con el rol Tránsito. No es la bandeja de trámites de tránsito: esa es el ítem Tránsito. No define bolsas por organismo: eso es Bolsas, en Finanzas."
      }
    ]
  },
  {
    "clave": "finanzas_reporte_costos",
    "permiso": "finanzas_reporte_costos",
    "etiqueta": "Reporte de costos",
    "resumen": "Costos por trámite para contabilidad y cobros.",
    "version": "1.1",
    "fecha": "2026-10-21",
    "palabrasClave": [
      "reporte de costos",
      "costos por trámite",
      "contabilidad",
      "cobros"
    ],
    "consultas": [
      "cuánto costó un trámite",
      "cómo exporto el reporte de costos"
    ],
    "secciones": [
      {
        "ancla": "que-es",
        "titulo": "Qué es",
        "texto": "Costos reales por trámite para contabilidad y cobros. Las filas Liquidadas muestran valores sellados; el resto, un Estimado con las tarifas vigentes. Desde aquí usted Liquida (sella), Factura en sentido FLITO (congela la liquidación ya sellada) y puede Enviar a facturación (emisión electrónica hacia Siigo/DIAN). Son tres verbos distintos: no los mezcle. La vista Consolidado pliega el mismo reporte por cliente y periodo para cerrar el mes."
      },
      {
        "ancla": "para-quien",
        "titulo": "Para quién",
        "texto": "Financiera y Administrador (liquidan, facturan y envían a emisión). Auditor (solo lectura: ve la tabla con sus tres secciones, el titular, la OT, el selector de Periodo, el Consolidado, los contadores y el detalle de Factura DIAN, y puede exportar a Excel; no hay casillas ni Liquidar / Facturar / Enviar a facturación)."
      },
      {
        "ancla": "como-se-entra",
        "titulo": "Cómo se entra",
        "texto": "En el menú lateral, sección Finanzas, ítem Reporte de costos. También desde Facturación electrónica · Operación, con el enlace ¿Buscas una factura concreta? Ve al reporte de costos."
      },
      {
        "ancla": "pasos",
        "titulo": "Pasos",
        "texto": "Al entrar, el reporte ya viene acotado a Aprobado y al mes en curso. Filtre por etapa: Todos, Listos para liquidar, Incompletos, Por facturar o Facturados. Opcional: Solo con soportes completos, Con diferencias (solo trámites con al menos una diferencia documental sin aceptar; las ya aceptadas dejan de salir), búsqueda, empresa, tipo, Estado y OT (organismo de tránsito, por su nombre). Limpiar filtros vuelve a Aprobado y al mes en curso y desmarca las dos casillas. Elija el Periodo: Mes o Trimestre, con su año y su índice. Elegirlo rellena el rango de Aprobación. Si edita el rango de Aprobación a mano, el selector dice Personalizado y no lo sobrescribe hasta que vuelva a elegir un mes o un trimestre. Creación es un rango aparte. Cabecera con Detalle, Consolidado y Exportar a Excel; las etapas con su cuenta, los filtros, el periodo Mes de octubre de 2026 y los contadores de Facturación electrónica Lea la tabla en tres secciones: Identificación, Datos del trámite y Valores. Arranca en vista compacta, pensada para caber en la pantalla de un portátil; si la pantalla es angosta, la tabla se desplaza a lo ancho y las acciones quedan en la última columna: empresa, Flit con su tipo de trámite debajo y placa; fecha de Aprobación y Factura DIAN; Total reintegro, Servicio, Total y Liquidación. Mostrar todas las columnas, sobre la tabla, enseña las 30: VIN, el titular con su Tipo y Documento, marca, línea, OT, Estado, las fechas de creación y aprobación, Mes, Trimestre, cada concepto (SOAT, impuesto, Trámite, GMF, logística y trámite digital), Viajes (número de viajes de logística, el 1 incluido) y Serv. adic. (importe y número de servicios adicionales del trámite). Compactar columnas vuelve a la vista corta. La elección se recuerda en este navegador. Para ver todos los campos a la vez, Exportar a Excel trae siempre las columnas completas, tenga la tabla como la tenga. Un concepto vacío se nombra: No configurado, Sin recibo, Sin pagar, Autogestiona o No aplica; nunca se pinta $0. Tabla en vista compacta con las secciones Identificación, Datos del trámite y Valores: un trámite Estimado, otro con Sin recibo y uno Liquidado En Valores, Total reintegro suma SOAT, impuesto, Trámite (derecho de tránsito), GMF y logística; Servicio suma el trámite digital y los servicios adicionales que lleve el trámite. Los dos vienen calculados del servidor, también en el pie de totales. Con Mostrar todas las columnas, el pie suma además la columna Serv. adic.; en la vista compacta esa columna no está, y su total tampoco. En esa misma vista, bajo el valor de Trámite digital y de Logística, un chip dice de dónde salió: Documento (lo dijo el comprobante de pago aplicado) o Tarifa (la tarifa negociada). Si el comprobante no cuadra con la tarifa, un segundo chip lo avisa con el importe y su signo: Difiere de tarifa +$5.000; si no había tarifa configurada, Sin tarifa configurada. En Serv. adic. el valor es la suma de los servicios asignados al trámite (un pago aplicado con su tipo de servicio entra con el valor del comprobante) y, si el comprobante no cuadra con el catálogo, el chip dice Difiere del catálogo −$20.000. Cuando alguien ya la aceptó, el chip pasa a Diferencia aceptada y, al enfocarlo o pasar el puntero, muestra quién, cuándo y por qué. Un concepto que la compañía autogestiona sigue en blanco. Lea los contadores de Facturación electrónica (pastillas por estado). Para sellar: marque filas o pulse Liquidar. El lote dice cuántos se pueden liquidar. Un estimado bloqueado muestra Falta: al lado del botón. Con estado Liquidado, pulse Facturar (congela; no emite ante la DIAN). Con estado Facturado, use la tarjeta Envío a facturación electrónica (su botón dice cuántos se pueden enviar, por ejemplo Enviar 1 a facturación electrónica) o Enviar a facturación en la fila; si no aplica, ¿Por qué no?. Soporte abre los documentos. Servicios abre el panel de servicios adicionales del trámite —los que FLITO cobra aparte—, con su total; el número del botón dice cuántos lleva. Desde ahí Añadir servicio toma uno del catálogo activo y Quitar lo retira, mientras el trámite no esté liquidado. Si ya lo está, el panel solo se lee: reversa la liquidación para cambiarlos. El Auditor siempre lo ve en solo lectura. El Administrador puede Reversar un liquidado (no un facturado). Viajes abre, en cualquier fila, un panel de solo lectura con el desglose de la logística: el viaje 1 incluido en la tarifa, cada viaje adicional con su precio, cómo se fijó, el motivo, quién lo registró y cuándo, y el Total logística que ve en la columna; el número del botón dice cuántos viajes lleva cuando hay más de uno. Aceptar diferencia aparece en la fila cuando algún concepto difiere de la tarifa o del catálogo y nadie lo ha aceptado: abre un diálogo con el valor del comprobante, la tarifa (o el catálogo) y la diferencia; escriba por qué se acepta (entre 5 y 500 caracteres, sin datos personales) y confirme. Con dos o tres diferencias en la misma fila, marque cuáles acepta con un solo motivo. Aceptar no cambia el valor ni la liquidación: deja constancia de quién, cuándo y por qué, y el chip pasa a Diferencia aceptada. Liquidar no se bloquea por tener diferencias. Columna de acciones de cada fila: Soporte, Servicios, Viajes y Liquidar; en la fila incompleta Liquidar está apagado con Falta: Impuesto, y en la liquidada aparece Facturar Conmute entre Detalle y Consolidado en la cabecera. El Consolidado agrupa por cliente y periodo (el tipo del selector) con los mismos filtros, y marca en Incompletos cuántos trámites de cada grupo tienen conceptos sin resolver. Vista Consolidado: una fila por cliente y periodo con trámites y totales por concepto, el pie Totales del filtro y el botón Exportar consolidado Exporte a Excel. En Detalle, Exportar a Excel descarga un archivo .xlsx con todos los trámites del filtro y del periodo puestos —no solo la página que ve— y con las 32 columnas del Excel de Financiero, con sus mismos nombres y orden (por ejemplo «Modelo» es la línea del vehículo, «Servicios adicionales» va justo después y «Columna1» es la logística), aunque en pantalla tenga columnas ocultas. En Consolidado, Exportar consolidado descarga el agrupado por cliente y periodo (sin fila de totales: los totales del filtro siguen en pantalla). Mientras se genera, el botón dice Generando… y no admite otro clic; al terminar, un aviso bajo la cabecera dice Archivo descargado: con el nombre (reporte-costos_AAAAMMDD-HHmm.xlsx o consolidado-costos_AAAAMMDD-HHmm.xlsx, hora de Colombia). Si el filtro supera el número de filas que admite un archivo, no se descarga nada y el aviso le pide acotar el periodo o el filtro. Si descarga varios archivos seguidos, espere un minuto y use Reintentar la descarga. Si la sesión venció, FLITO lo lleva a ingresar de nuevo; vuelva a la pantalla y exporte otra vez. Los tres verbos del reporte, de un vistazo: Diagrama: un trámite Estimado se liquida y queda Liquidado con valores sellados; se factura y queda Facturado con la liquidación congelada; enviar a facturación lo lleva a la emisión electrónica hacia Siigo y la DIAN; un liquidado se puede reversar y vuelve a Estimado"
      },
      {
        "ancla": "estados",
        "titulo": "Estados",
        "texto": "Cargando: filtros visibles; los contadores dicen Consultando el estado de la facturación electrónica…; la tarjeta de envío, Comprobando cuáles se pueden facturar…. En Consolidado, Calculando el consolidado…. Error: mensaje en rojo sobre la tarjeta. Los contadores: No se pudo consultar el estado de la facturación con Reintentar. En Consolidado: No se pudo calcular el consolidado con Reintentar. Al exportar, el aviso bajo la cabecera dice qué falló y ofrece Reintentar la descarga cuando repetir tiene sentido; Cerrar el aviso lo quita. Vacío: No hay trámites que coincidan con los filtros. Con Con diferencias marcada: No hay trámites con diferencias sin aceptar en este filtro. Desmarca «Con diferencias» o amplía el periodo. En Consolidado además ofrece Limpiar filtros. Contadores: ningún trámite del filtro se ha enviado todavía a facturación electrónica. El filtro OT sin organismos dice Sin organismos que ofrecer. Lleno: tabla compacta de nueve columnas en tres secciones, con Liquidación (Estimado / Liquidado / Facturado), Total reintegro, Servicio, Total, Factura DIAN y acciones; la OT, el Estado, la fecha de creación, los conceptos y Serv. adic., al pulsar Mostrar todas las columnas. En Serv. adic., un trámite sin servicios adicionales se pinta con un guion, y uno liquidado antes de esta versión dice Sin dato: no se sabe cuántos llevaba. Un total incompleto ofrece Ver cuáles. En Consolidado, una fila por cliente y periodo con su pie de totales; un periodo sin fecha de aprobación se rotula Sin aprobar. Viajes: en la vista ampliada, un trámite cuya compañía autogestiona la logística se pinta con un guion, y uno liquidado antes de que FLITO cobrara viajes adicionales dice Sin dato; el panel de ese trámite solo muestra el total sellado. Si la compañía autogestiona, el panel dice que no hay viajes que cobrar. Si el trámite ya no existe, ofrece Actualizar el reporte; si perdió el permiso, le pide volver a entrar."
      },
      {
        "ancla": "que-no-hace",
        "titulo": "Qué no hace",
        "texto": "Facturar no es emitir ante la DIAN: solo congela la liquidación. La emisión electrónica es Enviar a facturación. El Total reintegro de FLITO incluye la logística y por eso no coincide con el Total Reintegro del Excel manual, que la dejaba fuera. Los trámites viejos pueden salir sin OT o sin titular (nombres, apellidos, razón social o documento vacíos): FLIT no los traía. Un trámite sin OT queda fuera cuando se filtra por organismo. No calcula nada en el navegador: reintegro, servicio, mes, trimestre y el consolidado vienen del servidor. No carga boletas del portal: el chip de SOAT conciliado enlaza la boleta; el Excel se carga en Conciliación. No parametriza productos ni terceros de Siigo: eso es Facturación electrónica · Parametrización. No es la bandeja de casos detenidos: eso es Facturación electrónica · Operación. El panel de Servicios no crea ni tarifa tipos de servicio adicional: eso es Finanzas — Servicios adicionales. Tampoco cambia el valor de uno ya asignado: quítelo y vuelva a añadirlo. Un servicio con el chip Desde comprobante lo asignó un comprobante de pago aplicado: no se quita desde el panel. El Auditor observa; no liquida, no factura ni envía; el panel de Servicios lo ve siempre en solo lectura. El panel de Viajes no registra ni quita viajes: eso es la consola logística de Operaciones. Aquí solo se consulta lo que se cobró o se va a cobrar. Aceptar diferencia no corrige el valor ni el comprobante: si el documento está mal leído, corríjalo en Comprobantes. En servicios adicionales, lo que suma es aplicar el pago con su tipo de servicio. El Auditor ve los chips y usa el filtro, pero no acepta. El Excel no lleva columna de origen ni de diferencia: solo obedece el filtro, como los demás."
      }
    ]
  },
  {
    "clave": "finanzas_gastos_diarios",
    "permiso": "finanzas_gastos_diarios",
    "etiqueta": "Gastos diarios",
    "resumen": "Cuánto se pagó cada día por SOAT, impuestos, derechos, logística y servicios adicionales.",
    "version": "1.2",
    "fecha": "2026-10-22",
    "palabrasClave": [
      "gastos diarios",
      "pagos del día",
      "SOAT",
      "derechos",
      "logística"
    ],
    "consultas": [
      "cuánto se pagó hoy",
      "dónde veo los gastos de un día"
    ],
    "secciones": [
      {
        "ancla": "que-es",
        "titulo": "Qué es",
        "texto": "Cuánto se pagó cada día por SOAT, impuestos, derechos, logística y servicios adicionales, y cuánto suma el periodo con el GMF estimado. Es una pantalla de lectura: no liquida, no exporta y no abre trámites. Sirve para que usted cuadre caja o responda «¿cuánto salió esta semana?» sin reconstruirlo desde el Reporte de costos."
      },
      {
        "ancla": "para-quien",
        "titulo": "Para quién",
        "texto": "Administrador y, cuando se le concede la página desde Roles y permisos, Financiera y Auditor. Todos ven lo mismo: no hay acciones."
      },
      {
        "ancla": "como-se-entra",
        "titulo": "Cómo se entra",
        "texto": "En el menú lateral, sección Finanzas, ítem Gastos diarios, justo después de Reporte de costos."
      },
      {
        "ancla": "pasos",
        "titulo": "Pasos",
        "texto": "Al entrar, la pantalla muestra los últimos 30 días (hoy incluido) para Todas las empresas. La línea sobre las tarjetas dice el rango cubierto y la empresa. Si duda de qué cuenta cada tarjeta, el enlace ¿Qué cuenta cada categoría? de la cabecera lo explica. Lea las cinco tarjetas, siempre en este orden y con la cantidad y el valor en la misma línea (por ejemplo 12 · $ 3.450.000). Qué cuenta cada una y qué día se toma: SOAT pagados, pólizas pagadas, el día del pago del SOAT; Impuestos pagados, recibos pagados, el día del pago del impuesto; Derechos pagados, derechos de trámite con fecha de pago, ese día; Trámites con logística, trámites que llevan logística, el día de aprobación del trámite, con la tarifa vigente ese día; y Servicios asignados, cada servicio adicional asignado a un trámite, el día en que se asignó, con su valor de entonces. Lea el bloque Total del periodo: Suma de categorías, GMF (4×1000) estimado y Total con GMF. El GMF es un estimado calculado sobre la suma del periodo; el banco lo causa por movimiento, no por trámite, y el valor real está en el extracto. La liquidación lo calcula por trámite, así que puede diferir. Filtros Empresa, Periodo y Tipo de gasto; las cinco tarjetas con cantidad y valor, y el bloque Total del periodo con la suma, el GMF estimado y el total con GMF Filtre con Empresa (la misma lista del Reporte de costos) y Periodo (un solo calendario, con atajos de 7 y 30 días). Cambiar cualquiera de los dos vuelve a consultar. El periodo no puede superar 366 días ni terminar antes de empezar: si pasa, el aviso sale bajo el campo y no se consulta. Use Tipo de gasto para ocultar tarjetas: desmarcar Impuestos esconde su tarjeta sin consultar de nuevo. El Total del periodo sigue sumando las cinco categorías y lo dice: Incluye todas las categorías. Con las cinco desmarcadas, Ver los cinco las devuelve. Lea la gráfica Evolución diaria: una barra por día del periodo (los días sin gasto quedan vacíos en su sitio), apilada en el orden de las tarjetas. Pase el puntero por una barra —o entre con Tab y muévase con las flechas— para ver el día, la cantidad y el valor de cada categoría y la suma del día. Los botones de la leyenda hacen lo mismo que Tipo de gasto: ocultar una categoría la quita de las barras y reajusta el eje, sin consultar de nuevo. Ver como tabla abre la misma información en una tabla (día por fila); Ocultar tabla la cierra. Gráfica Evolución diaria con una barra apilada por día, la leyenda de las cinco categorías y el botón Ver como tabla Limpiar filtros vuelve a Todas las empresas, los últimos 30 días y las cinco categorías. Los filtros van en la dirección de la página: usted puede compartir el enlace y quien lo abra verá la misma vista. De dónde sale el dato: de cada pago o evento, no de la liquidación. Por eso puede no coincidir con el Reporte de costos, que agrupa por fecha de aprobación del trámite y usa los valores sellados: si una liquidación corrigió un valor, aquí sigue el del pago."
      },
      {
        "ancla": "estados",
        "titulo": "Estados",
        "texto": "Cargando: los filtros ya se pueden usar; en el lugar de las tarjetas y del total se ven cinco cuadros y una banda en gris. Error: No se pudo cargar el gasto diario. con el motivo debajo y Reintentar, que repite la misma consulta. Vacío: Sin gastos entre … para … con el rango y la empresa nombrados, y Últimos 30 días para volver al arranque. Si ya está en el arranque: Sin gastos en los últimos 30 días. Cambia el rango o la empresa arriba. Lleno: cinco tarjetas, la línea del rango, el bloque Total del periodo y, debajo, la gráfica Evolución diaria: una barra por día, apilada por categoría (cada categoría con su color y su trama, también en la leyenda). Si el rango no tiene gastos, la gráfica dice Sin gastos en el rango. Sin la página concedida: No tienes acceso a Finanzas — Gastos diarios."
      },
      {
        "ancla": "que-no-hace",
        "titulo": "Qué no hace",
        "texto": "No lista trámites, placas ni comprobantes: solo días, cantidades y sumas. No exporta a Excel ni liquida: para eso está el Reporte de costos. No lee la liquidación: si un sellado corrigió un valor, aquí sigue el del pago. El GMF no es el del extracto bancario: es un estimado sobre la suma del periodo."
      }
    ]
  },
  {
    "clave": "flito_bolsas",
    "permiso": "flito_bolsas",
    "etiqueta": "Bolsas",
    "resumen": "Saldos, alta de bolsas, recargas y cierres.",
    "version": "1.8",
    "fecha": "2026-10-26",
    "palabrasClave": [
      "bolsas",
      "saldos",
      "recargas",
      "cierres",
      "crear bolsa",
      "inactivar bolsa",
      "autogestión",
      "documentos",
      "expediente",
      "cámara de comercio",
      "rut",
      "certificado bancario"
    ],
    "consultas": [
      "cómo recargo una bolsa",
      "cuál es el saldo de una bolsa",
      "cómo cierro una bolsa",
      "cómo creo la bolsa de una compañía",
      "cómo inactivo o reactivo una bolsa",
      "por qué no puedo recargar una bolsa",
      "cómo cargo los documentos de la compañía",
      "por qué un documento dice vigencia vencida",
      "qué hago si no se pudo validar un documento",
      "cómo quito un documento que cargué por error",
      "cómo creo una bolsa de tránsito",
      "cómo cierro el mes de una bolsa de tránsito",
      "por qué no puedo reactivar una bolsa de tránsito"
    ],
    "secciones": [
      {
        "ancla": "que-es",
        "titulo": "Qué es",
        "texto": "El saldo que cada cliente tiene precargado con FLIT y el que FLIT mantiene ante las secretarías. Los KPI de Saldo total, Bolsas en riesgo y Conciliación pendiente encabezan la pantalla; debajo, dos acordeones (Compañías y Tránsitos). Usted crea la bolsa de una compañía o de tránsito, elige qué descuenta, la inactiva o la reactiva, y recarga, mueve, corrige y cierra periodos. No Factura la liquidación ni hace emisión electrónica."
      },
      {
        "ancla": "para-quien",
        "titulo": "Para quién",
        "texto": "Financiera y Administrador (operan el dinero). El Auditor no entra: a diferencia del resto de FLITO, las bolsas son solo de Administración y Financiera. Crear, editar e inactivar una bolsa son permisos propios: si no los tiene, esos botones no aparecen."
      },
      {
        "ancla": "como-se-entra",
        "titulo": "Cómo se entra",
        "texto": "En el menú lateral, sección Finanzas, ítem Bolsas."
      },
      {
        "ancla": "pasos",
        "titulo": "Pasos",
        "texto": "Arriba están Crear bolsa y los KPI Saldo total, Bolsas en riesgo y Conciliación pendiente. Use Buscar (compañía, bolsa o NIT), el filtro Alcance (Todas, Compañías, Tránsito) y el filtro Estado (Todas, Activas, Inactivas) para encontrar una bolsa. Con un alcance elegido solo se ve su acordeón. Cabecera de Bolsas con el botón Crear bolsa, los tres KPI y la barra con Buscar y los filtros Alcance y Estado En Compañías, cada fila dice el Estado (Activa o Inactiva), el Saldo, el Nivel y el Expediente: Docs completos si la compañía tiene válidos la Cámara de Comercio, el RUT, la cédula del representante legal y el certificado bancario, o Docs pendientes si falta alguno, está vencido o no se pudo validar. La columna Expediente solo aparece si usted puede ver documentos. Pulse Ver detalle en una fila o en una alerta de Alertas de saldo. En Tránsitos, cada fila dice la Bolsa, el Estado, el Saldo (con − si está en préstamo) y el Nivel (incluye En préstamo); pulse Ver detalle. Acordeón Compañías con una alerta de saldo crítico y la tabla de compañías con estado, saldo, nivel y Ver detalle; debajo, Tránsitos Para dar de alta una bolsa, pulse Crear bolsa y responda ¿De quién es la bolsa?. Con Compañía: elija la compañía (las inactivas aparecen con (Inactivo) y no se pueden elegir) y marque en ¿Qué conceptos descuenta? al menos uno (ninguno viene marcado y el GMF no se elige); luego Crear bolsa. Se abre el detalle de la bolsa nueva. Con Tránsito: escriba el Nombre, marque en ¿Qué cobros descuenta? al menos uno y elija las Secretarías a las que aplica; luego Crear bolsa. Se abre el detalle de la bolsa nueva. Si una secretaría ya la cubre otra bolsa activa para el mismo cobro, el formulario lo dice junto a la secretaría y con el nombre de esa bolsa: quítela o desmarque ese cobro para guardar. Formulario Crear bolsa con la opción Compañía, una compañía elegida, los seis conceptos, SOAT marcado como Autogestionado y el aviso de autogestión En el detalle de la compañía: el estado, el saldo y los conceptos que descuenta. Elija el Periodo contable y, si necesita el histórico, marque Ver el libro completo (todos los periodos). Las acciones son Registrar una recarga (valor y comprobante; Registrar recarga), Movimiento manual (Registrar movimiento), Corregir un movimiento (Asentar corrección) o Cerrar el periodo (el botón dice Cerrar y el nombre del mes; Confirmar el cierre; irreversible). Debajo, el consumo por organismo y por concepto, y los movimientos, que puede Exportar CSV. Un movimiento que revierte a otro lleva el enlace Revierte el movimiento del… y lo lleva hasta el original. Detalle de la bolsa de una compañía: Activa y Normal, Editar conceptos e Inactivar, el saldo, los conceptos que descuenta con SOAT autogestionado, el periodo contable y el extracto Para cambiar los conceptos, pulse Editar conceptos y luego Guardar cambios. Para dejar de usar una bolsa, pulse Inactivar, escriba el Motivo (mínimo 5 caracteres) y Inactivar bolsa. Para volver a usarla, Reactivar bolsa con su motivo. El saldo y los movimientos se conservan. Al final del detalle de una bolsa de compañía está la sección Documentos: Cámara de Comercio, RUT, Cédula del representante legal, Certificado bancario y Documento adicional (opcional). Pulse Cargar (o Reemplazar si ya hay uno) y elija un PDF, JPG o PNG de hasta 15 MB. La versión anterior queda en Historial, y con el icono de descarga baja la vigente. La Cámara de Comercio, el RUT y el certificado bancario quedan en Validando… mientras el sistema lee la fecha de expedición; si no la puede leer quedan en No se pudo validar: pulse Digitar fecha, escriba la fecha y Guardar fecha. Si la fecha leída está mal, use Corregir. Si el archivo vigente está mal (de otra compañía, otro documento o ilegible), pulse Quitar al final de la fila, escriba si quiere un motivo (opcional, sin datos personales) y confirme con Quitar versión: la fila vuelve a Pendiente con Cargar, y la versión queda en Historial como retirada, con quién la retiró, cuándo, el motivo y su descarga. Si era uno de los cuatro principales, el expediente pasa a Docs pendientes. Arriba de la sección, Docs completos indica que los cuatro principales están válidos y Docs pendientes que falta alguno. Sección Documentos del detalle de la bolsa: Docs pendientes, 2 de 4 principales válidos; Cámara de Comercio Válido, RUT Vigencia vencida, cédula Válido, certificado bancario No se pudo validar y documento adicional Pendiente, con Reemplazar, descargar, Historial, Quitar, Corregir, Digitar fecha y Cargar En el detalle de una bolsa de tránsito: el estado, el nivel, el saldo (y lo que se debe si está En préstamo), lo cargado y lo consumido, y la Cobertura (pulse Ver para la lista de secretarías y cobros). Las acciones son Cargar saldo (valor, fecha y soporte opcional; Registrar carga), Editar cobertura (Guardar cambios) e Inactivar. Debajo están los Movimientos y los Cierres del mes: con Cerrar un mes elija el Mes y pulse Cerrar con el nombre del mes; el cierre queda en la lista con el saldo inicial, las entradas, las salidas y el saldo final. Una compañía tiene una sola bolsa. Si al crearla ve Esta compañía ya tiene bolsa (o ya tiene bolsa (inactiva)), pulse Ver su bolsa: si está inactiva, reactívela en lugar de crear otra. Un documento con fecha de expedición vale 30 días: el día 31 pasa solo a Vigencia vencida y hay que cargar uno más reciente. La cédula y el documento adicional no vencen. Los documentos son de la compañía, no de la bolsa, y solo los ve el personal de FLIT. Si un concepto lleva la marca Autogestionado, la compañía lo gestiona por su cuenta: no llegarán movimientos a la bolsa por ese concepto salvo excepciones. Puede marcarlo igual. La autogestión se cambia en Clientes y proveedores (enlace Cambiarlo en Clientes y proveedores). En una bolsa de tránsito, una secretaría autogestionada para impuestos lleva el aviso este organismo es autogestionado para impuestos: no llegarán movimientos de impuesto a la bolsa salvo excepciones, en el detalle y al editar la cobertura. Puede guardar igual. Una bolsa de tránsito inactiva no recibe descuentos ni cargas: Cargar saldo se ve deshabilitado y el detalle avisa Reactiva la bolsa primero. Al inactivarla, sus secretarías quedan libres para otra bolsa; si al reactivarla otra bolsa activa ya cubre alguna, el detalle lo dice con la secretaría, el cobro y el enlace Ver a esa bolsa, y la bolsa sigue inactiva. Con la bolsa inactiva no se registran recargas, movimientos manuales ni correcciones, y los trámites no descuentan de ella. El detalle lo avisa con Reactiva la bolsa primero. El cierre del periodo sigue disponible. Los documentos se pueden ver y descargar, pero no cargar ni corregir hasta reactivarla. El ciclo de la bolsa de una compañía en un periodo, de un vistazo: Diagrama: se crea la bolsa y se eligen sus conceptos; durante el periodo hay recargas, consumos y movimientos manuales o correcciones; al cerrar el periodo y confirmar el cierre queda cerrado de forma irreversible y se descarga el reporte"
      },
      {
        "ancla": "estados",
        "titulo": "Estados",
        "texto": "Cargando: el encabezado Bolsas se ve; el tablero aún no (esqueleto). Error: No pudimos cargar las bolsas. Revisa tu conexión e intenta de nuevo. y Reintentar. Vacío: Todavía no hay bolsas. Crea la primera y elige si es de una compañía o de tránsito. con Crear bolsa. Si la búsqueda no encuentra nada: Ninguna bolsa coincide con… y Limpiar filtros. Lleno: KPI, alertas de saldo y la tabla de compañías con estado, saldo, nivel y expediente. Expediente en la tabla: mientras se consulta se ve una barra gris; si la consulta falla, la celda muestra — y arriba de la tabla aparece No pudimos cargar el estado de los documentos. con Reintentar. La tabla funciona igual. Documentos: mientras carga, Cargando el expediente; si falla, No pudimos cargar los documentos de la compañía. Intenta de nuevo. con Reintentar; sin documentos, Todavía no hay documentos. Carga los cuatro principales para dejar el expediente completo. Si solo puede ver documentos (o la bolsa está inactiva), no aparecen Cargar, Digitar fecha ni Quitar. En Historial, cada versión dice si es la vigente, si fue reemplazada por una carga nueva o si fue retirada con Quitar; las retiradas muestran Retirada por y el motivo, y se pueden descargar. Tránsito: si no hay ninguna, Todavía no hay bolsas de tránsito. Pulsa «Crear bolsa» y elige Tránsito. En el detalle, Movimientos y Cierres del mes cargan cada uno por su lado: si uno falla dice No pudimos cargar… con su propio Reintentar, y sin datos dice Esta bolsa todavía no tiene movimientos o Todavía no se ha cerrado ningún mes. Compañía sin bolsa: el detalle dice Crea la bolsa de la compañía primero con Crear bolsa (la compañía ya viene elegida). Si al recargar aparece ese mismo aviso, la bolsa no existe todavía."
      },
      {
        "ancla": "que-no-hace",
        "titulo": "Qué no hace",
        "texto": "No cuadra el Excel del portal SOAT: eso es Conciliación. Cargar o conciliar una boleta no se hace aquí. No Factura (congelar la liquidación) ni envía a emisión electrónica: eso vive en Reporte de costos y en Facturación electrónica · Operación. No es el listado de compañías ni cambia su autogestión: las tarifas, la ficha comercial y la autogestión están en Clientes y proveedores. No borra una bolsa: se inactiva y se puede reactivar. Quitar un documento no lo borra: la versión queda en Historial como retirada. Para restaurarla, vuelva a cargar el archivo. El Auditor, el Proveedor y el Gestor de Impuestos no operan bolsas."
      }
    ]
  },
  {
    "clave": "flito_tarifas",
    "permiso": "flito_tarifas",
    "etiqueta": "Tarifas",
    "resumen": "Cuánto se le cobra a cada cliente por trámite y logística.",
    "version": "1.2",
    "fecha": "2026-10-25",
    "palabrasClave": [
      "tarifas",
      "precios",
      "cobro por trámite",
      "logística"
    ],
    "consultas": [
      "cuánto se le cobra a un cliente",
      "cómo cambio la tarifa de un cliente"
    ],
    "secciones": [
      {
        "ancla": "que-es",
        "titulo": "Qué es",
        "texto": "La pantalla donde se fija cuánto cobra FLITO a cada cliente por el trámite digital —Matrícula, Traspaso y Otros— y por la logística. Cada valor tiene una vigencia: rige desde el momento en que usted lo guarda y hasta que lo cambie o deje de cobrarlo."
      },
      {
        "ancla": "para-quien",
        "titulo": "Para quién",
        "texto": "Administrador y Financiera. El Auditor, el Proveedor y el Gestor de Impuestos no entran aquí."
      },
      {
        "ancla": "como-se-entra",
        "titulo": "Cómo se entra",
        "texto": "En el menú, Finanzas → Tarifas. También desde Clientes y proveedores, con el botón Tarifas de la fila de una compañía, que abre esta pantalla con esa compañía ya elegida."
      },
      {
        "ancla": "pasos",
        "titulo": "Pasos",
        "texto": "Elija la compañía en la lista Clientes de la izquierda (o búsquela en Buscar cliente…). Las que tienen valores sin configurar muestran Falta 1 o Faltan N; con la pestaña Con faltantes ve solo esas. Un cliente inactivo aparece en gris con Inactivo y no se puede elegir. A la derecha, sus cuatro filas —Matrícula, Traspaso y Otros del trámite digital, y Logística— con el valor vigente, desde cuándo y quién lo fijó. Lista de clientes con Falta 1 y Faltan 4, y las cuatro filas de tarifas de un cliente: tres con valor y Logística Sin configurar Pulse Fijar valor en una fila que diga Sin configurar, o Cambiar en una que ya tenga valor. Escriba el número y pulse Guardar (o Cancelar). El tipo de trámite ya está en la fila: no se escribe. Fila Logística en edición con el valor escrito y los botones Guardar y Cancelar Si escribe 0, FLITO le pide confirmar: cero significa que el trámite se cobra a $0, no que está sin configurar. Para no cobrar un concepto, pulse Dejar de cobrar y confirme. La fila vuelve a Sin configurar y la vigencia queda cerrada en el historial, con su nombre y la hora. Pulse Historial en una fila, o Historial del cliente arriba, para abrir Historial de vigencias: valor, desde, hasta (o Vigente), quién la fijó y quién la cerró. Las pastillas filtran por trámite y Fijadas entre acota por fecha. Historial de vigencias con una tarifa Vigente y la anterior cerrada, con quién la fijó y quién la cerró Cómo cambia un valor y qué queda guardado, de un vistazo: Diagrama: una fila sin configurar pasa a vigente al fijar valor y guardar; cambiarla cierra la vigencia anterior y abre otra; dejar de cobrar la devuelve a sin configurar; todo queda en el historial con quién la fijó y quién la cerró"
      },
      {
        "ancla": "estados",
        "titulo": "Estados",
        "texto": "Cargando: un esqueleto en el lugar de la lista o de la matriz, con los botones apagados. Error: No se pudieron cargar los valores de… con Reintentar. FLITO no muestra $0 ni Sin configurar por un error: si ve una fila, es lo que hay guardado. Vacío: Todavía no hay clientes. cuando no existe ninguna compañía; Sin configurar en la fila a la que no se le ha fijado valor. Lleno: las cuatro filas del cliente con su valor, desde cuándo rige y quién lo fijó."
      },
      {
        "ancla": "que-no-hace",
        "titulo": "Qué no hace",
        "texto": "No cambia lo ya liquidado. Un trámite que ya se facturó conserva el valor con el que se liquidó, aunque usted cambie la tarifa después. Cada trámite vale lo que regía en su fecha de aprobación. Si hoy cambia un valor, aplica a los trámites que se aprueben desde hoy; los aprobados antes siguen con el valor de entonces. No borra ni «desactiva» tarifas: una vigencia se cierra y queda en el historial. No decide si el cliente autogestiona la logística: Gestiona FLITO o Autogestiona el cliente se lee aquí, pero se cambia en Clientes y proveedores. No muestra el reporte de costos ni lo que se cobró en cada trámite."
      }
    ]
  },
  {
    "clave": "flito_servicios_adicionales",
    "permiso": "flito_servicios_adicionales",
    "etiqueta": "Servicios adicionales",
    "resumen": "Catálogo de servicios cobrados aparte del trámite y su valor.",
    "version": "1.1",
    "fecha": "2026-10-21",
    "palabrasClave": [
      "servicios adicionales",
      "catálogo de servicios",
      "valor del servicio"
    ],
    "consultas": [
      "cómo creo un servicio adicional",
      "cuánto vale un servicio adicional"
    ],
    "secciones": [
      {
        "ancla": "que-es",
        "titulo": "Qué es",
        "texto": "El catálogo de lo que FLITO cobra aparte del trámite: paz y salvo de impuestos, diagnóstico, derecho de petición y los tipos que Financiera añada, cada uno con su valor en pesos. Es el mismo catálogo para todas las compañías: el valor no se fija por cliente."
      },
      {
        "ancla": "para-quien",
        "titulo": "Para quién",
        "texto": "Administrador y Financiera. Auditor, Proveedor, Gestor de Impuestos, Mensajero y Cliente no entran aquí."
      },
      {
        "ancla": "como-se-entra",
        "titulo": "Cómo se entra",
        "texto": "En el menú, Finanzas → Servicios adicionales, junto a Tarifas."
      },
      {
        "ancla": "pasos",
        "titulo": "Pasos",
        "texto": "Pulse Editar en la fila de un tipo para cambiar su nombre, su descripción o su valor, y luego Guardar cambios. Solo se envía lo que usted cambió; si no cambió nada, el botón queda apagado y la pantalla lo dice (No has cambiado nada.). Ventana Editar tipo con Nombre, Descripción (opcional) y Valor, y el botón Guardar cambios apagado porque no hay cambios Pulse Nuevo tipo para crear uno: escriba el nombre, una descripción si hace falta y el valor en pesos, y pulse Crear tipo. No puede haber dos tipos activos con el mismo nombre, aunque cambien tildes o mayúsculas: si ya existe, la pantalla se lo indica bajo el campo Nombre y conserva lo escrito. Ventana Nuevo tipo con los campos vacíos y el botón Crear tipo Pulse Dar de baja en la fila y confirme con Dar de baja para retirar un tipo. Desde ese momento deja de ofrecerse y no se puede reactivar; el nombre queda libre para un tipo nuevo. Marque Mostrar dados de baja para ver los tipos retirados junto a los activos, con su fecha de baja y sin acciones. Desmárquelo para volver a la lista de activos. Catálogo con Mostrar dados de baja marcado: los cuatro tipos activos y uno Dado de baja con su fecha y sin botones Los tres tipos iniciales aparecen a $ 0 con la marca Por tarifar hasta que usted les ponga valor con Editar; sobre la tabla, la pantalla dice cuántos siguen a $ 0. Catálogo de tipos activos con su descripción, valor y estado; uno a $ 0 con la marca Por tarifar El ciclo de un tipo de servicio, de un vistazo: Diagrama: un tipo nuevo queda activo y se ofrece al asignar; se puede editar; al darlo de baja queda dado de baja de forma definitiva, sin reactivar, y su nombre queda libre para un tipo nuevo"
      },
      {
        "ancla": "estados",
        "titulo": "Estados",
        "texto": "Cargando: un esqueleto en el lugar de la tabla. Nuevo tipo sigue disponible. Error: No se pudo cargar el catálogo de servicios adicionales. con Reintentar. Vacío: Aún no hay tipos de servicio adicional. con el botón Nuevo tipo. Lleno: la tabla con nombre, descripción, valor y estado (Activo o Dado de baja) de cada tipo, ordenada por nombre."
      },
      {
        "ancla": "que-no-hace",
        "titulo": "Qué no hace",
        "texto": "No borra ni reactiva un tipo: dar de baja es definitivo y el tipo queda visible solo marcando Mostrar dados de baja. No guarda historial de valores: al cambiar un valor, el anterior no se consulta desde aquí. No dice a qué trámites se cobró cada servicio ni cuánto se ha cobrado: eso no está en esta pantalla. No fija valores por cliente: el catálogo es el mismo para todas las compañías."
      }
    ]
  },
  {
    "clave": "flito_comprobantes",
    "permiso": "flito_comprobantes",
    "etiqueta": "Comprobantes",
    "resumen": "Cargue cualquier comprobante y revise lo que FLITO leyó.",
    "version": "1.3",
    "fecha": "2026-10-24",
    "palabrasClave": [
      "comprobantes",
      "cargar comprobante",
      "lectura",
      "OCR"
    ],
    "consultas": [
      "cómo cargo un comprobante",
      "qué leyó FLITO del comprobante"
    ],
    "secciones": [
      {
        "ancla": "que-es",
        "titulo": "Qué es",
        "texto": "La puerta única para los comprobantes de pago y los soportes de un trámite: facturas de SOAT, recibos de impuesto y de derechos de tránsito, facturas de servicios, transferencias y cualquier documento del trámite. FLITO lee cada documento y le muestra qué es, a qué llave corresponde (ID FLIT, placa o VIN) y qué valores trae, con la confianza de cada dato. Lo que cruza con un único trámite se aplica solo; el resto queda en Pendientes para que usted lo revise, lo asocie a su trámite y lo aplique como pago o lo adjunte como documentación."
      },
      {
        "ancla": "para-quien",
        "titulo": "Para quién",
        "texto": "Financiera y Administrador. El Auditor no entra a esta pantalla."
      },
      {
        "ancla": "como-se-entra",
        "titulo": "Cómo se entra",
        "texto": "En el menú lateral, sección Finanzas, ítem Comprobantes."
      },
      {
        "ancla": "pasos",
        "titulo": "Pasos",
        "texto": "Pulse Cargar comprobantes. Elija PDF o imágenes (JPG, PNG, WEBP). En una carga caben hasta 150 archivos, cada uno de hasta 15 MB. El modal le muestra cuántos archivos eligió y cuánto pesan frente al tope (por ejemplo 2 archivos · 0.0 MB de 250 MB); si se pasa, FLITO se lo dice y no envía nada: quite archivos y vuelva a intentar. Un PDF que traiga varios documentos seguidos se lee documento por documento: cada uno aparece con sus páginas (por ejemplo p. 3-4). Ventana Cargar comprobantes con dos imágenes elegidas, el contador de archivos y peso, y los botones Subir y procesar y Cancelar Pulse Subir y procesar. Con muchos archivos verá enviando X de N archivos. No cierre la ventana: lo que ya se envió queda guardado aunque cierre. Al terminar, lea el resultado por documento: Aplicado (FLITO lo cruzó con un único trámite y ya quedó en su concepto; el detalle dice cuál y por cuánto; el chip Aplicados cuenta cuántos fueron), Pendiente (leído, con el motivo por el que espera: sin llave de cruce, tipo o concepto sin identificar, lectura poco confiable, sin lectura…), Duplicado (ese archivo ya se había cargado; Ver el original lo abre) o Fallido (no es PDF ni imagen, o el PDF pasa de 150 páginas). Pulse Listo: la cola queda filtrada por esa carga; la ✕ del chip la quita. En la cola, cada carga va agrupada con su fecha, hora y quién la subió. Las pastillas Pendientes, Aplicados, Descartados y Todos cambian lo que ve; Solo esta carga filtra por esa carga; el selector Estado de asociación separa los pendientes de asociar de los rechazados como pago, y los aplicados automáticos de los manuales y de los adjuntados como documentación; los selectores Concepto y Motivo afinan lo que ve. En una fila con trámite, Ver trámite abre Gestión Trámites filtrada por esa placa en otra pestaña. Cola de comprobantes agrupada por carga: tres pendientes de asociar con su motivo y uno aplicado automático, con los filtros arriba Pulse Asociar en un pendiente (o Ver en un aplicado o descartado). A la izquierda verá el documento (abierto en su primera página); a la derecha, lo que FLITO leyó con la confianza de cada dato: Alta, Media, Baja o Sin lectura. FLITO nunca inventa un dato: si no lo leyó, el campo va vacío. Abrir el archivo original muestra el archivo completo en otra pestaña. En la cabecera, Ver soportes muestra todos los documentos que ese trámite ya tiene (SOAT, impuesto, derecho, logística y comprobantes), si su usuario puede verlos. Panel de asociación: a la izquierda el documento demo; a la derecha lo leído con su confianza, el trámite sugerido por placa, el concepto y los botones Descartar y Aplicar Si un documento quedó Sin lectura (OCR no disponible), pulse Releer: FLITO vuelve a intentarlo. Si el lector sigue sin estar disponible, se lo dice y el documento no cambia. El camino de un comprobante, de un vistazo: Diagrama: se cargan los comprobantes y FLITO lee cada documento; si cruza con un único trámite queda aplicado automático; si no, queda pendiente y se asocia para aplicarlo como pago o adjuntarlo como documentación, o se descarta con motivo"
      },
      {
        "ancla": "asociar-y-aplicar",
        "titulo": "Asociar y aplicar",
        "texto": "Diga qué es el documento: Comprobante de pago o Documentación del trámite. Si FLITO lo leyó con confianza, ya viene marcado; si no, márquelo usted. Elija el Trámite. FLITO sugiere los trámites que coinciden con lo leído (Sugerido · por placa, por VIN o por ID FLIT); con un solo sugerido ya viene puesto. Si el suyo no está, escriba al menos 3 caracteres del ID FLIT, la placa o el VIN y elija uno de los resultados. La ✕ Quitar trámite vacía el campo. Elija el Concepto. Junto a cada opción verá si ese trámite lo admite o por qué no (ya pagado, liquidado, no gestionado, ya documentado, estado no permitido). En un pago de Servicios adicionales, elija además el Tipo de servicio del catálogo activo: al aplicar, ese servicio queda asignado al trámite con el valor del comprobante. Si el tipo ya estaba asignado a mano, la lista lo marca Ya asignado · se actualizará el valor y el comprobante corrige ese valor. Si ya lo pagó otro comprobante, lo marca Ya tiene un comprobante aplicado y no se puede elegir: un tipo lleva un solo comprobante por trámite. Sin tipo, Aplicar no se habilita. Revise los datos leídos y corrija lo que haga falta. En un pago, el Valor es obligatorio (pesos, sin puntos ni signo); en documentación no se pide. Si cambió algo de lo leído (un dato, el trámite sugerido, el concepto o la marca de pago), escriba Por qué cambias lo leído (mínimo 5 caracteres): queda en la auditoría del comprobante. No escriba datos personales. Pulse Aplicar (pago) o Adjuntar (documentación). Si falta algo, FLITO se lo marca y no envía nada. Al terminar, la cola se actualiza y verá el mensaje Comprobante aplicado a … o Documentación adjuntada a …. Si el trámite no admite ese pago (por ejemplo, ya está pagado), FLITO se lo dice y le ofrece Adjuntar como documentación: el documento queda en el trámite sin contar como pago. Si ya había otro comprobante con ese valor, Reemplazar le pide un motivo, descarta el anterior y aplica este. Para sacar un documento de la cola, pulse Descartar, escriba el motivo (mínimo 5 caracteres) y confirme. El archivo deja de contar como duplicado: se podrá volver a cargar."
      },
      {
        "ancla": "corregir-un-comprobante-aplicado",
        "titulo": "Corregir un comprobante aplicado",
        "texto": "Si un comprobante quedó aplicado al trámite o con el concepto equivocado, ábralo con Ver: Desaplicar: elija si vuelve a la cola (para asociarlo otra vez) o se descarta, escriba el    motivo (mínimo 5 caracteres) y confirme. Se deshace lo que el comprobante registró en el trámite. Reemplazar: elija el comprobante pendiente que va en su lugar y escriba el motivo. El    original queda descartado y el nuevo se aplica al mismo trámite y concepto. Si no hay    pendientes, cargue primero el comprobante correcto. No siempre se puede corregir aquí: si el descuento cae en un periodo cerrado de la bolsa, si el pago se corrige en su propio módulo, si el trámite ya está liquidado o si es un pago de servicios adicionales que se corrige en Servicios adicionales, FLITO se lo explica y no cambia nada."
      },
      {
        "ancla": "estados",
        "titulo": "Estados",
        "texto": "Cargando: la tabla muestra su esqueleto; en el modal, Procesando… y enviando X de N archivos. Error: No se pudo cargar la cola de comprobantes con Reintentar. En la carga, si el servidor   no admite el peso o no termina a tiempo, FLITO se lo dice con el siguiente paso y conserva lo que sí   se procesó. Vacío: No hay comprobantes por asociar. Con filtros, **Ningún comprobante coincide con los   filtros y Limpiar filtros**. Lleno: una fila por documento, agrupadas por carga, con lo leído, la llave, el valor, el estado   (Pendiente de asociar, Rechazado como pago, Aplicado automático, Aplicado manual,   Adjuntado o Descartado) y su motivo, y Asociar (pendientes) o Ver (aplicados y   descartados). En el panel: Buscando… mientras busca trámites; Ningún trámite coincide con «…» si no hay   resultados; No se pudo buscar. Vuelve a intentarlo. si falla la búsqueda; Aplicando… o   Adjuntando… mientras envía."
      },
      {
        "ancla": "que-no-hace",
        "titulo": "Qué no hace",
        "texto": "No reparte un pago entre varios trámites: cada comprobante va a un solo trámite. No acepta diferencias de valor frente a la tarifa: eso se hace desde el reporte de costos. No abre archivos ZIP: suba los PDF o las imágenes sueltos. No carga SOAT del canal Cliente: esas solicitudes no tienen trámite y siguen su propio camino. No reemplaza la carga masiva de SOAT ni la de Impuestos: siguen en sus pantallas. Un   archivo que ya entró por ahí sale aquí como Duplicado. No muestra ni guarda datos de personas del documento: FLITO no los lee."
      }
    ]
  },
  {
    "clave": "flito_conciliacion",
    "permiso": "flito_conciliacion",
    "etiqueta": "Conciliación",
    "resumen": "Cruce del recaudo SOAT contra lo emitido.",
    "version": "1.2",
    "fecha": "2026-10-25",
    "palabrasClave": [
      "conciliación",
      "recaudo",
      "SOAT emitido",
      "cruce"
    ],
    "consultas": [
      "cómo concilio el recaudo SOAT",
      "por qué no cuadra la conciliación"
    ],
    "secciones": [
      {
        "ancla": "que-es",
        "titulo": "Qué es",
        "texto": "Bandeja de las boletas que Financiera pagó en el portal SOAT, cruzadas contra los SOAT pagados en FLITO. Cargar una boleta no mueve dinero: el descuento de las bolsas ocurre al conciliar, y solo si todo cuadra. Usted carga el Excel, revisa el cuadre y confirma. No es Facturar ni emisión electrónica."
      },
      {
        "ancla": "para-quien",
        "titulo": "Para quién",
        "texto": "Financiera y Administrador. Quien entra puede cargar y conciliar: no hay modo de solo lectura. El Auditor no entra a esta bandeja (su lectura del comprobante va por la cola SOAT)."
      },
      {
        "ancla": "como-se-entra",
        "titulo": "Cómo se entra",
        "texto": "En el menú lateral, sección Finanzas, ítem Conciliación. El detalle de una boleta abre en su propia página (con Abrir), no en una ventana encima, para que el reporte de costos pueda enlazarla."
      },
      {
        "ancla": "pasos",
        "titulo": "Pasos",
        "texto": "Pulse + Cargar boleta. En Cargar boleta del portal elija Cliente, Fecha del pago en el portal (la del pago, no la de hoy) y el Excel de la boleta (.xlsx), tal como lo descarga del portal. Pulse Cargar y cruzar. Cargar no pide confirmación: todavía no sale dinero. Un cliente inactivo aparece con (Inactivo) y no se puede elegir para una boleta nueva; el filtro Cliente de la bandeja sí lo ofrece, para consultar sus boletas. Ventana Cargar boleta del portal con Cliente, Fecha del pago en el portal, el Excel de la boleta y los botones Cancelar y Cargar y cruzar Filtre por Cliente, estado de la boleta (Todas, Por conciliar, Conciliadas, Descartadas) y Pagadas entre. Limpiar filtros restaura la bandeja. Los KPI dicen cuántas hay Por conciliar, cuántas Conciliadas y cuántas Líneas sin resolver; este último ofrece Revisar. Bandeja de Conciliación con los filtros, los tres KPI y tres boletas: una con una línea que no cuadra, otra con todas cuadradas y una conciliada En una fila, Abrir. El detalle dice cuántas líneas cuadran y, en la columna Resultado, qué pasó con cada una y qué hacer. Si hay líneas sin cuadrar, corrija y pulse Volver a cruzar (no mueve un peso). Descartar pide Sí, descartar: se pierde el cruce y el archivo se puede volver a cargar. Detalle de una boleta por conciliar: Conciliar boleta apagado porque 1 de 2 líneas no cuadra, y la línea con Valor distinto explicando la diferencia Cuando todas las líneas cuadran, pulse Conciliar boleta y, en el diálogo, Sí, conciliar. No se puede deshacer: el valor sale de la bolsa del cliente y de la de tránsito. Diálogo Conciliar con el número de SOAT, el cliente y el valor, el aviso No se puede deshacer y los botones Cancelar y Sí, conciliar Tras conciliar, adjunte el Comprobante del pago PSE (PDF, JPG o PNG, máximo 15 MB). Reemplazar sustituye el archivo. ‹ Volver a Conciliación regresa a la bandeja. Boleta conciliada: las líneas cuadradas y el bloque Comprobante del pago PSE para adjuntar el archivo El ciclo de una boleta, de un vistazo: Diagrama: se carga la boleta sin mover dinero y FLITO cruza cada línea; si alguna no cuadra se corrige y se vuelve a cruzar, o se descarta; si todas cuadran se concilia, se descuenta de las bolsas sin poder deshacerlo y se adjunta el comprobante del pago PSE"
      },
      {
        "ancla": "estados",
        "titulo": "Estados",
        "texto": "Cargando: esqueleto de la bandeja (o del detalle). Error: No se pudo cargar la lista de boletas. / No se pudo cargar la boleta. con Reintentar. Un 404: Esa boleta no existe o se descartó. Vacío: Todavía no hay boletas cargadas. Con filtros: Ninguna boleta con los filtros puestos. Lleno: KPI Por conciliar, Conciliadas y Líneas sin resolver, tabla Boletas de conciliación. En el detalle: cuadre, bloque de conciliar y comprobante."
      },
      {
        "ancla": "que-no-hace",
        "titulo": "Qué no hace",
        "texto": "No recarga ni cierra bolsas: eso es Bolsas. Conciliar sí descuenta de ellas. No Factura la liquidación ni hace emisión electrónica. No hay conciliación parcial: basta una línea que no cuadre para bloquear Conciliar boleta. El Auditor no opera esta bandeja. No busque aquí la cola SOAT."
      }
    ]
  },
  {
    "clave": "siigo_parametrizacion",
    "permiso": "siigo_parametrizacion",
    "etiqueta": "Facturación electrónica · Parametrización",
    "resumen": "Catálogos, mapeo de conceptos y emisión.",
    "version": "1.1",
    "fecha": "2026-10-21",
    "palabrasClave": [
      "facturación electrónica",
      "Siigo",
      "parametrización",
      "mapeo de conceptos"
    ],
    "consultas": [
      "cómo mapeo un concepto en Siigo",
      "cómo configuro la emisión de facturas"
    ],
    "secciones": [
      {
        "ancla": "que-es",
        "titulo": "Qué es",
        "texto": "Parametrización de la emisión electrónica con Siigo: a qué producto corresponde cada concepto de la liquidación, y revisión de terceros. Encabeza la pregunta de si se puede emitir en producción. Usted no Factura trámites aquí (eso congela la liquidación en Reporte de costos)."
      },
      {
        "ancla": "para-quien",
        "titulo": "Para quién",
        "texto": "Financiera (consulta el mapeo; sincroniza terceros). Administrador (edita el mapeo, confirma ciudades, recalcula duplicados). Auditor (solo lectura: ve mapeo, terceros y compuerta; no edita ni sincroniza)."
      },
      {
        "ancla": "como-se-entra",
        "titulo": "Cómo se entra",
        "texto": "En el menú lateral, sección Finanzas, ítem Facturación electrónica · Parametrización. Las pestañas Mapeo de conceptos y Terceros son secciones de la misma pantalla."
      },
      {
        "ancla": "pasos",
        "titulo": "Pasos",
        "texto": "Elija Ambiente (Pruebas o Producción). Lea la compuerta: La emisión en producción está bloqueada (con motivos) o La parametrización está completa: la emisión en producción está habilitada. Si ve Modo simulado, nada llega a Siigo ni a la DIAN. Cabecera con el selector Ambiente en Pruebas y el aviso La emisión en producción está bloqueada con su motivo En Mapeo de conceptos, tabla Conceptos facturables: cada concepto con su producto en Siigo, unidad, si es ingreso para terceros y su estado (Sin mapear, Mapeado, Mapeado y confirmado). Arriba a la derecha, cuántos están confirmados. El Administrador pulsa Editar en cualquier fila o Crear producto en una Sin mapear. Financiera ve la tabla; no tiene esos botones. Tabla Conceptos facturables con conceptos mapeados y confirmados, y GMF sin mapear con los botones Crear producto y Editar En Editar, elija el Producto en Siigo de la lista (o Escribir el código a mano), la Unidad de medida y si Es un ingreso recibido para terceros, y pulse Guardar. Si el cambio toca un campo que contabilidad ya firmó, la pantalla avisa antes de guardar que la confirmación se perderá. Ventana Editar Logística con el producto elegido, la unidad de medida y los botones Cancelar y Guardar Pase a Terceros. ¿A cuántos se les puede facturar? dice cuántos clientes pueden recibir factura electrónica. Use Ver los N que no pueden todavía o Ver los N que se pueden sincronizar; Por dónde empezar agrupa los pendientes por lo que les falta. Pestaña Terceros: tres clientes activos, dos pueden recibir factura y los botones para ver los pendientes y los sincronizables Corrija primero: en Clientes que todavía no, Completar ficha; en Equivalencias de ciudad, Confirmar cada municipio (solo Administrador). Después, en Sincronizar terceros con Siigo, marque los clientes de Clientes listos para facturar y pulse Sincronizar N en el ambiente que indica (Administrador y Financiera). Sincronizar antes de corregir produce fallidos evitables. Bloque Sincronizar terceros con Siigo con un cliente marcado y el botón Sincronizar 1 en pruebas El Auditor lee Sincronizar escribe en Siigo: lo hacen administración y financiera y no ve la acción. El camino hasta poder emitir en producción, de un vistazo: Diagrama: mapear conceptos, corregir fichas, confirmar ciudades y sincronizar terceros; si la compuerta tiene motivos, la emisión en producción sigue bloqueada y se corrige el motivo; si no, queda habilitada"
      },
      {
        "ancla": "estados",
        "titulo": "Estados",
        "texto": "Cargando: Cargando la parametrización… Error: aviso y Reintentar. Un fallo de la compuerta (No se pudo consultar el estado de la emisión) no tumba el mapeo. Vacío: Todavía no hay conceptos en este ambiente. Lleno: tabla de conceptos o bloques de terceros (resumen, no facturables, ciudades, sincronización). El modo simulado se señaliza de forma permanente."
      },
      {
        "ancla": "que-no-hace",
        "titulo": "Qué no hace",
        "texto": "No Factura ni Liquida trámites, ni reintenta facturas detenidas: eso es Reporte de costos y Facturación electrónica · Operación. No guarda las credenciales de la integración con Siigo: eso se hace en la sección Administración, y solo lo ve el Administrador. No edita el tratamiento tributario: lo aplica Siigo desde el producto. Comprobante, vendedor, forma de pago y centro de costo se eligen en cada envío, no aquí."
      }
    ]
  },
  {
    "clave": "siigo_operacion",
    "permiso": "siigo_operacion",
    "etiqueta": "Facturación electrónica · Operación",
    "resumen": "Bandeja de facturas y acciones del día a día.",
    "version": "1.2",
    "fecha": "2026-10-21",
    "palabrasClave": [
      "facturación electrónica",
      "Siigo",
      "bandeja de facturas",
      "facturas"
    ],
    "consultas": [
      "cómo emito una factura",
      "por qué falló una factura en Siigo"
    ],
    "secciones": [
      {
        "ancla": "que-es",
        "titulo": "Qué es",
        "texto": "Bandeja de lo que quedó detenido en el camino a la DIAN, con qué hacer en cada caso. Aquí usted reintenta, da por perdido o registra una corrección. No hay columnas de costos ni el listado completo de trámites: para buscar una factura concreta vaya al Reporte de costos. No es Facturar en sentido FLITO (congelar la liquidación): la emisión electrónica se dispara desde el reporte; esta pantalla arregla lo que no salió."
      },
      {
        "ancla": "para-quien",
        "titulo": "Para quién",
        "texto": "Financiera y Administrador (reintentan, reenvían correo, dan por perdido, corrigen). Auditor (consulta: Tu rol es de consulta: ves todo y no hay acciones disponibles. Sin casillas ni botones de acción)."
      },
      {
        "ancla": "como-se-entra",
        "titulo": "Cómo se entra",
        "texto": "En el menú lateral, sección Finanzas, ítem Facturación electrónica · Operación. En la cabecera: ¿Buscas una factura concreta? Ve al reporte de costos."
      },
      {
        "ancla": "pasos",
        "titulo": "Pasos",
        "texto": "Si aparece La integración con Siigo está frenada, no se puede reintentar ni reenviar correo. El Administrador pulsa Reactivar la integración con Siigo (afecta a toda la facturación). No lo confunda con Volver a intentarlo de un caso dado por perdido. Lea el resumen (Detenido en total y uno por fuente) y, debajo, quién lo resuelve. Filtre por fuente (Todas, No se pudo emitir, Rechazada por la DIAN, No le llegó al cliente), antigüedad (Toda, Más de 2 días, Más de 5 días) y Qué se muestra (Solo lo pendiente / Con los dados por perdidos). En Motivo elija un motivo concreto o Todos los motivos; cada opción trae entre paréntesis cuántos casos le corresponden, y se agrupa por el código del error, no por la frase. En Cliente, Todos los clientes o uno de los que tienen casos en esta página. Limpiar los filtros. Resumen de casos detenidos por fuente, filtros de fuente, antigüedad, qué se muestra, motivo y cliente, y el inicio de la tabla Casos detenidos En Casos detenidos, pulse Ver. Verá qué pasó y qué hacer, el responsable y la línea de tiempo del trámite. Según la fuente: Reintentar la emisión o Reenviar el correo; Dar por perdido; Registrar una corrección (un rechazo de la DIAN no se reintenta: emitiría un segundo documento); Copiar enlace. Detalle de un caso que no se pudo emitir: qué pasó y qué hacer, los botones Reintentar la emisión, Dar por perdido, Registrar una corrección y Copiar enlace, y la línea de tiempo Para varios casos: marque sus casillas y pulse Reintentar N casos. Quitar la selección limpia las casillas. Un rechazo de la DIAN no tiene casilla: dice No se arregla reintentando. Dos casos marcados, el contador 2 seleccionados y los botones Quitar la selección y Reintentar 2 casos; el caso rechazado por la DIAN no se puede marcar Un caso dado por perdido se devuelve a la cola con Volver a intentarlo, no con «reactivar». El camino de un caso detenido, de un vistazo: Diagrama: un caso detenido se reintenta, se corrige o se da por perdido; un caso dado por perdido vuelve a la cola con Volver a intentarlo"
      },
      {
        "ancla": "estados",
        "titulo": "Estados",
        "texto": "Cargando: Buscando lo que quedó detenido… Error: No se pudo cargar la bandeja y Reintentar la búsqueda. El error va antes que el vacío. Error solo del filtro: No se pudo cargar el catálogo de motivos. El selector Motivo queda inhabilitado y ofrece Volver a cargar los motivos; la tabla y los demás filtros siguen funcionando. Vacío: No hay nada detenido. Buen día. (sin filtros). Con filtro: Ningún caso coincide con este filtro. y Quitar los filtros. Lleno: resumen, filtros y tabla Casos detenidos (caso, cliente, fuente y estado, qué pasó y qué hacer, tiempo detenido, Ver)."
      },
      {
        "ancla": "que-no-hace",
        "titulo": "Qué no hace",
        "texto": "No Liquida ni Factura (congelar liquidación): eso es Reporte de costos. No parametriza productos ni terceros: Facturación electrónica · Parametrización. No lista todos los trámites ni totales de costos. Un vacío con filtros no celebra: puede haber casos fuera del filtro. El Auditor observa; no opera. Levantar el freno lo hace un Administrador."
      }
    ]
  },
  {
    "clave": "privacy_log_pii",
    "permiso": "privacy",
    "etiqueta": "Log accesos PII",
    "resumen": "Quién consultó datos personales, cuándo, qué campos y desde qué equipo. Solo se consulta.",
    "version": "1.0",
    "fecha": "2026-10-22",
    "palabrasClave": [
      "log de accesos PII",
      "accesos a datos personales",
      "auditoría de datos personales",
      "quién consultó",
      "Ley 1581",
      "habeas data"
    ],
    "consultas": [
      "quién consultó los datos personales de un conductor",
      "cómo reviso los accesos a datos personales",
      "dónde está el log de accesos PII"
    ],
    "secciones": [
      {
        "ancla": "que-es",
        "titulo": "Qué es",
        "texto": "El registro de cada consulta a datos personales dentro de FLITO: quién la hizo, cuándo, sobre qué registro, qué campos vio y desde qué dirección de red. Es la prueba que pide la Ley 1581 (artículo 17) cuando un titular o la autoridad preguntan quién miró sus datos. Nadie lo puede editar ni borrar: solo se consulta."
      },
      {
        "ancla": "para-quien",
        "titulo": "Para quién",
        "texto": "Quien tenga el ítem Privacidad y datos: este capítulo y el de Privacidad y datos van juntos. Leer el registro pide además la acción de ver el log de accesos a datos personales. De partida, el Administrador y Cumplimiento; se reparte desde Roles y permisos."
      },
      {
        "ancla": "como-se-entra",
        "titulo": "Cómo se entra",
        "texto": "Menú Administración, ítem Log accesos PII. La pantalla se titula Auditoría accesos a datos personales."
      },
      {
        "ancla": "pasos",
        "titulo": "Pasos",
        "texto": "Entre a Log accesos PII. Arriba verá dos resúmenes de los últimos 30 días: Top usuarios (últimos 30 días), con cuántos accesos hizo cada usuario (por su número y su rol), y Top recursos accedidos, con qué tipo de registro se consultó y de qué forma. Resumen del log con los usuarios y los recursos con más accesos, sobre datos demo Para acotar, use la fila de filtros: el número de usuario, el tipo de registro (por ejemplo, conductor o propietario), la acción (read es leer, decrypt es ver un dato cifrado, export es exportar y search es buscar) y el rango de fechas. Cada cambio de filtro vuelve a la primera página. Log filtrado por la acción de leer: dos accesos demo con fecha, usuario, registro, campos y dirección de ejemplo Lea la tabla: Fecha UTC (hora universal, cinco horas por delante de la de Colombia), User, Recurso, Acción, Campos e IP. Debajo, Total dice cuántos accesos cumplen los filtros; la tabla muestra 100 por página y se recorre con ← Anterior y Siguiente →. Si el registro no se puede leer, la pantalla lo dice y no muestra ningún total. Eso no significa que nadie haya accedido: pulse Reintentar antes de sacar una conclusión."
      },
      {
        "ancla": "estados",
        "titulo": "Estados",
        "texto": "Cargando: la tabla dice «Cargando...». Error: «No se pudo cargar el log de accesos: …» con Reintentar. No se pinta el total ni la paginación, para no afirmar un cero que no se pudo comprobar. Vacío: «Sin accesos para los filtros». Si en los últimos 30 días no hubo accesos, los resúmenes dicen «Sin accesos». Lleno: los dos resúmenes, la tabla y el pie «Total: N · página X de Y»."
      },
      {
        "ancla": "que-no-hace",
        "titulo": "Qué no hace",
        "texto": "No muestra el nombre de quien consultó: lo identifica por su número de usuario y su rol. No muestra el valor de los datos consultados, solo qué campos se vieron. No exporta el registro ni permite borrar o corregir una fila. Los resúmenes de arriba cubren siempre los últimos 30 días; no cambian con los filtros. No atiende solicitudes de los titulares: para eso está Privacidad y datos."
      }
    ]
  },
  {
    "clave": "users",
    "permiso": "users",
    "etiqueta": "Usuarios",
    "resumen": "Alta, edición, bloqueo y baja de las personas que entran a FLITO, con el historial de cambios.",
    "version": "1.3",
    "fecha": "2026-10-26",
    "palabrasClave": [
      "usuarios",
      "gestión de usuarios",
      "nuevo usuario",
      "contraseña",
      "dar de baja",
      "historial de cambios"
    ],
    "consultas": [
      "cómo creo un usuario",
      "cómo le cambio la contraseña a un usuario",
      "cómo desactivo o doy de baja a un usuario",
      "quién le cambió el rol a un usuario",
      "por qué no puedo darle a un usuario la función de eliminar clientes"
    ],
    "secciones": [
      {
        "ancla": "que-es",
        "titulo": "Qué es",
        "texto": "La pantalla Gestión de usuarios: las personas que pueden entrar a FLITO, su rol, su ámbito (compañía, proveedor u organismos, según el enlace del rol) y su estado. Desde aquí se crean, se editan, se les cambia la contraseña, se desactivan, se dan de baja y se reactivan. La pestaña Historial registra cada cambio en usuarios, roles y permisos."
      },
      {
        "ancla": "para-quien",
        "titulo": "Para quién",
        "texto": "Quien tenga el ítem Usuarios. De partida, el Administrador gestiona todo; el Auditor entra a la misma pantalla y solo ve el Historial. Descargar Excel pide además la acción de exportar usuarios. Todo se reparte desde Roles y permisos."
      },
      {
        "ancla": "como-se-entra",
        "titulo": "Cómo se entra",
        "texto": "Menú Administración, ítem Usuarios."
      },
      {
        "ancla": "pasos",
        "titulo": "Pasos",
        "texto": "Entre a Usuarios. En la pestaña Usuarios filtre por Rol y por Vista (En alta, Dados de baja o Todos); debajo, Usuarios por rol cuenta cuántos hay de cada rol y cuántos están activos e inactivos. Descargar Excel baja todas las coincidencias del filtro. Lista de usuarios demo con filtros, conteo por rol y acciones por fila Para crear a alguien pulse Nuevo usuario y complete Username (login), Nombre completo, Email (opcional), Contraseña (mínimo 8 caracteres con minúscula, mayúscula, número y un carácter especial) y Rol base; según el enlace del rol se pide la compañía, el proveedor o los organismos. Una compañía inactiva aparece con (Inactivo) y no se puede elegir; si el usuario ya estaba atado a una que se desactivó, el campo la conserva con esa marca y el resto del formulario se guarda igual. Con los proveedores de SOAT pasa lo mismo: uno desactivado aparece con (Inactivo), apagado, y no se puede elegir; si el usuario ya estaba atado a él, el campo lo conserva. Debajo, Permisos de este usuario muestra lo que trae el rol y permite añadir o quitar excepciones. Pulse Crear usuario. Formulario Nuevo usuario vacío con los campos y los permisos que trae el rol En la fila de una persona, Editar cambia sus datos, su rol, su ámbito y sus excepciones de permisos, y Contraseña le asigna una nueva. Cuatro funciones son exclusivas del Administrador y no admiten excepción: Activar o desactivar clientes, Eliminar clientes, Activar o desactivar proveedores y Eliminar proveedores. En una persona con otro rol aparecen apagadas con la nota Exclusiva del Administrador: solo la tiene quien tiene ese rol.; en un Administrador, marcadas por el rol con Exclusiva del Administrador: la da su rol y no se puede quitar. Para que alguien las tenga, cámbiele el Rol base a Administrador. Desactivar le impide entrar sin sacarla de la lista; Activar la devuelve. Usted no puede desactivarse ni darse de baja a sí mismo (su fila dice «(tú)»). Dar de baja la saca de la lista En alta; queda en Dados de baja, donde Reactivar la recupera. En la pestaña Historial filtre por Usuario, Recurso (Todos, Usuarios, Roles, Cuadro rol × función o Funciones por usuario) y fechas. Cada fila dice Cuándo, Quién, Qué y el Cambio (antes → después). Historial con dos cambios demo: una desactivación y un cambio de rol Diagrama del ciclo de un usuario: nuevo usuario activo, desactivar y activar, dar de baja y reactivar, con cada cambio en el historial Los permisos de cada rol se deciden en Roles y permisos. Aquí solo se añaden o quitan excepciones para una persona."
      },
      {
        "ancla": "estados",
        "titulo": "Estados",
        "texto": "Cargando: la tabla dice «Cargando...»; el historial, «Cargando el historial…». Error: «No se pudo cargar la lista de usuarios» con Reintentar; en la pestaña Historial, «No se pudo cargar el historial.». Vacío: «Sin usuarios» o, en Dados de baja, «Nadie dado de baja». El historial sin cambios dice que aparecerán a partir del primero. No se guardó: si al guardar FLITO rechaza una función exclusiva del Administrador (por ejemplo, porque otra persona cambió el rol mientras tanto), el cuadro lo dice con el nombre de la función, le pide cerrar y volver a abrir el usuario, y conserva lo que usted cambió. Lleno: la tabla con Usuario, Nombre, Email, Rol, Ámbito, Estado y Acciones; el historial, paginado."
      },
      {
        "ancla": "que-no-hace",
        "titulo": "Qué no hace",
        "texto": "No define qué puede hacer cada rol: eso es Roles y permisos. No borra a nadie de forma definitiva: dar de baja conserva a la persona y su historial. No muestra los accesos a datos personales de cada persona: eso es Log accesos PII."
      }
    ]
  },
  {
    "clave": "roles_permisos",
    "permiso": "roles_permisos",
    "etiqueta": "Roles y permisos",
    "resumen": "Qué puede hacer cada rol dentro de FLITO.",
    "version": "1.2",
    "fecha": "2026-10-25",
    "palabrasClave": [
      "roles",
      "permisos",
      "acceso",
      "usuarios"
    ],
    "consultas": [
      "qué puede hacer cada rol",
      "cómo doy acceso a una pantalla",
      "por qué no puedo marcar una función en un rol"
    ],
    "secciones": [
      {
        "ancla": "que-es",
        "titulo": "Qué es",
        "texto": "La pantalla donde se decide qué puede ver y hacer cada rol dentro de FLITO. Muestra la lista de roles con cuántos permisos tiene cada uno y, al lado, los Permisos del rol seleccionado, ordenados igual que el menú: cada elemento del menú (Gestión, Finanzas, Administración…) contiene sus ítems (las pantallas), y cada ítem sus acciones (ver, crear, exportar…). Todo lo que se reparte está dentro del menú: no hay permisos sueltos aparte. Desde aquí también se crean, editan y borran roles."
      },
      {
        "ancla": "para-quien",
        "titulo": "Para quién",
        "texto": "Quien tenga el permiso de ver Roles y permisos. Para cambiar las marcas hace falta además la acción Asignar permisos; para crear, editar o borrar roles, la acción correspondiente. Sin ellas la pantalla se ve en solo lectura."
      },
      {
        "ancla": "como-se-entra",
        "titulo": "Cómo se entra",
        "texto": "Menú Administración, ítem Roles y permisos, junto a Usuarios."
      },
      {
        "ancla": "pasos",
        "titulo": "Pasos",
        "texto": "Elija el rol en la lista de la izquierda (o en el selector Rol en pantallas pequeñas). A la derecha verá su enlace, cuántos usuarios lo tienen y sus Permisos del rol. Roles y permisos con el rol Gestor demo elegido en la lista y su cabecera Despliegue el elemento del menú y el ítem que quiera y marque o desmarque. Un permiso vale solo si están marcados el elemento, el ítem y la acción. Una casilla con unas marcas sí y otras no se ve como parcial. Árbol del rol desplegado en Gestión y SOAT, con elementos completos y parciales Si desmarca un elemento o un ítem, lo de adentro no se pierde: queda visible, apagado y con sus marcas, con la nota «… está desmarcado: lo de adentro no aplica, pero sus marcas se conservan para cuando lo vuelvas a marcar». Al volver a marcarlo, las marcas reaparecen activas. Pulse Guardar cambios. El cambio queda aplicado en la siguiente acción de cada usuario con ese rol; nadie tiene que volver a entrar. La barra Sin guardar cuenta lo pendiente y Descartar lo devuelve a lo guardado. Barra Sin guardar con una marca pendiente, Descartar y Guardar cambios Para repartirlo todo de una vez use Marcar todo, que marca todos los ítems y acciones del árbol, pero no los opcionales ni las funciones exclusivas del Administrador; Desmarcar todo quita todo (en el rol Administrador, menos sus funciones exclusivas). Ninguno de los dos guarda por sí solo. Nuevo rol abre el formulario: Nombre del rol, Descripción y Enlace, que decide qué datos ven las personas con ese rol (las cuatro opciones se explican debajo de esta lista). El rol nuevo nace con Perfil marcado (ver sus datos y cambiar su contraseña) para que nadie se quede sin poder cambiarla; si no lo quiere, desmárquelo y guarde. Formulario Nuevo rol vacío con las cuatro opciones de Enlace Editar rol permite corregir nombre, descripción, enlace y si Se puede asignar a usuarios nuevos. El enlace solo se puede cambiar mientras ningún usuario tenga el rol; si lo tiene alguien, el formulario lo avisa y hay que cambiarles el rol primero en Usuarios. Borrar rol solo está disponible cuando ningún usuario lo tiene y no es un rol del sistema; la cabecera dice por qué cuando no se puede. Diagrama del reparto de permisos: elegir el rol, desplegar, marcar elemento, ítem y acción, revisar lo pendiente y guardar o descartar; el guardado se rechaza si dejaría a FLITO sin administrador Las cuatro opciones de Enlace (cada una explica debajo lo que verá el rol): Ninguno (viene marcado): ve todos los datos de los módulos que el rol tenga marcados. Compañía: ve solo lo de su compañía en el Tablero, Gestión Trámites, SOAT, Impuestos, Bolsas, Comprobantes y Logística. No ve catálogos ni configuración; el resto le queda cerrado. Proveedor: ve solo lo asignado a su proveedor. Hoy aplica a SOAT. Organismos: ve solo lo de sus secretarías de tránsito en Impuestos, Derechos y la Bandeja de trámites. El resto le queda cerrado. La compañía, el proveedor o las secretarías concretas de cada persona se eligen en Usuarios, no aquí. El código del rol se genera del nombre y no se puede cambiar después. Algunos casos del árbol llevan su propia nota: Los ítems de módulos anteriores a FLITO no se dividen en acciones: marcarlos da acceso a todo lo de la pantalla. En PESV, crear y editar los registros pide además la acción Administrar. Las operaciones Opcional (por ejemplo, ver el documento del propietario sin enmascarar) no vienen con su ítem: se marcan aparte. Un ítem marcado sin ninguna acción avisa «Marcado sin ninguna acción: …»; marque al menos una o desmarque el ítem. Ayuda no se marca: cada usuario la ve sola, con los capítulos de lo que puede usar. Algunas funciones son exclusivas del Administrador (por ejemplo, Eliminar clientes): solo el rol Administrador las tiene. En cualquier otro rol salen desmarcadas y bloqueadas con la nota «Exclusiva del Administrador: no se puede dar a otro rol.», y no cuentan en el «k de n» del ítem. En el rol Administrador salen marcadas y bloqueadas con la nota «Exclusiva del Administrador: este rol siempre la tiene.». Si un rol las traía marcadas de antes, salen desmarcadas y el siguiente guardado las quita. En un rol con enlace, los ítems de las pantallas que ese enlace cierra salen deshabilitados con la nota «Cerrado por el enlace «Compañía»: este rol no lo verá aunque lo marque». Tampoco aparecen en el menú de quien tenga el rol, y Marcar todo no los marca. Algunas operaciones se usan desde varias pantallas y vienen con el módulo donde se usan, sin casilla propia: consultar vehículos viene con Vehículos, SOAT antiguo, Flota y Trámite Digital; consultar una persona en el RUNT, leer la cédula y buscar en Fasecolda vienen con Trámite Digital, que incluye Traspaso. Basta con marcar el ítem. El resumen de rendimiento de FLITO es el ítem Rendimiento de Administración: quien lo tenga lo verá en el menú, dentro de Administración."
      },
      {
        "ancla": "estados",
        "titulo": "Estados",
        "texto": "Cargando: esqueleto de dos columnas. Error: «No se pudo cargar el catálogo de roles y permisos. Revisa tu conexión y vuelve a intentarlo.» con Reintentar. Si falla solo el árbol del rol elegido, el aviso lo dice y ofrece Reintentar ahí mismo. Vacío: sin roles se ofrece Nuevo rol; si el catálogo llega vacío se ofrece Reintentar; un rol sin nada marcado avisa de que quien lo tenga no verá ningún elemento del menú al entrar. Lleno: lista de roles y árbol del rol seleccionado. La cabecera dice el enlace del rol y cuántos usuarios lo tienen. Con cambios pendientes aparece la barra Sin guardar con Descartar y Guardar cambios. Solo lectura: sin la acción Asignar permisos, un aviso lo explica y no hay casillas que cambiar. No se guardó por seguridad: si el cambio dejaría a FLITO sin ningún usuario activo que pueda administrar Usuarios y Roles y permisos, un aviso en la página lo explica, nombra lo que hay que volver a marcar con Mostrar dónde está, y sus cambios siguen ahí sin guardar. No se guardó por una función exclusiva: si el guardado intenta darle a otro rol una función exclusiva del Administrador (o quitársela al Administrador), un aviso en la página nombra la función, dice qué hacer y ofrece Mostrar dónde está; sus cambios siguen ahí sin guardar. Error al guardar: «No se pudieron guardar los permisos. Tus cambios siguen aquí; vuelve a intentarlo con «Guardar cambios».» Error al guardar el rol: el formulario muestra «No se pudo guardar el rol. Inténtalo de nuevo; si se repite, recarga la página.» sin cerrarse."
      },
      {
        "ancla": "que-no-hace",
        "titulo": "Qué no hace",
        "texto": "El menú lateral y la búsqueda rápida no avisan de cambios sin guardar. Si sale de la pantalla por ahí con cambios pendientes, se pierden. Sí avisa al cambiar de rol, al pulsar Volver y al cerrar o recargar la pestaña. Si dos administradores guardan el mismo rol a la vez, se aplica el último guardado sin aviso. No muestra ni edita usuarios: para cambiarle el rol a alguien vaya a Usuarios. No asigna permisos a una persona en particular ni muestra el historial de cambios; eso vive en Usuarios, con el mismo árbol. Allí una excepción que añade una acción a la que al rol de la persona le falta el elemento o el ítem se marca «Añadido · sin efecto»: no vale hasta que se añada también lo que falta. La dirección de la pantalla no lleva el rol seleccionado: al recargar se vuelve al primero de la lista."
      }
    ]
  },
  {
    "clave": "drive",
    "permiso": "drive",
    "etiqueta": "Google Drive",
    "resumen": "Carpetas y archivos de Google Drive compartidos con FLITO, y lectura de los PDF de cuentas de cobro.",
    "version": "1.0",
    "fecha": "2026-10-22",
    "palabrasClave": [
      "Google Drive",
      "carpetas",
      "archivos",
      "cuentas de cobro",
      "procesar PDF"
    ],
    "consultas": [
      "cómo proceso un PDF de cuentas de cobro",
      "dónde veo los archivos de Google Drive",
      "por qué no veo una carpeta de Drive"
    ],
    "secciones": [
      {
        "ancla": "que-es",
        "titulo": "Qué es",
        "texto": "Un visor de las carpetas de Google Drive compartidas con FLITO. Permite recorrerlas, buscar archivos, verlos sin salir de FLITO, descargarlos y procesar un PDF de cuentas de cobro: FLITO lee cada página y devuelve un resumen con placa, propietario, documento, vehículo, tipo de trámite y valor de cada cuenta, más un Excel."
      },
      {
        "ancla": "para-quien",
        "titulo": "Para quién",
        "texto": "Quien tenga el ítem Google Drive. De partida, solo el Administrador; se reparte desde Roles y permisos. Sus acciones (abrir, descargar y procesar) piden además la acción de administrar los archivos de Drive."
      },
      {
        "ancla": "como-se-entra",
        "titulo": "Cómo se entra",
        "texto": "Menú Administración, ítem Google Drive."
      },
      {
        "ancla": "pasos",
        "titulo": "Pasos",
        "texto": "Entre a Google Drive. Verá la Carpeta raíz con sus Carpetas (N) y Archivos (N); cada archivo muestra su tamaño y su fecha de cambio. Carpeta raíz de Drive con dos carpetas demo y un archivo demo Pulse una carpeta para abrirla. Arriba aparece la ruta y Atrás para volver a la carpeta anterior. Carpeta demo abierta con dos PDF de cuentas de cobro y una imagen, cada uno con Descargar y los PDF con Procesar Para buscar, escriba al menos dos letras en Buscar archivos... y pulse Buscar (o Enter). Limpiar vuelve a la carpeta. Pulse un archivo para verlo: los PDF se muestran página por página y las imágenes tal cual. Descargar lo guarda en su equipo. En un PDF de cuentas de cobro pulse Procesar. Mientras lee dice Procesando cuentas de cobro… (puede tardar unos minutos). Al terminar, Resultado del procesamiento muestra Páginas, Cuentas, Placas y Valor total, la tabla de cuentas con Descargar por cuenta y Descargar Excel resumen. Cerrar oculta el resultado. Resultado del procesamiento de un PDF demo: tres cuentas con placa, propietario, documento, vehículo, trámite y valor Diagrama del procesamiento: abrir la carpeta, elegir el PDF, procesar, revisar el resultado y descargar el Excel o cada cuenta Solo se procesa un PDF a la vez: mientras uno se lee, los demás botones dicen Espere…."
      },
      {
        "ancla": "estados",
        "titulo": "Estados",
        "texto": "Cargando: «Cargando Drive…» con un indicador de progreso. Error: un aviso arriba («Error cargando Drive», «Error de conexión», «Error procesando» o el motivo de la descarga). Vacío: «Carpeta vacía o sin acceso», con la sugerencia de recargar y, si persiste, compartir la carpeta con la cuenta de servicio de FLITO. Lleno: carpetas en tarjetas y archivos en lista, con sus acciones."
      },
      {
        "ancla": "que-no-hace",
        "titulo": "Qué no hace",
        "texto": "No sube, mueve, renombra ni borra archivos: eso se hace en Google Drive. No muestra carpetas que no estén compartidas con la cuenta de servicio de FLITO. No guarda el resultado del procesamiento: si lo cierra, hay que volver a procesar el PDF. No muestra vista previa de archivos que no sean PDF o imagen."
      }
    ]
  },
  {
    "clave": "privacy",
    "permiso": "privacy",
    "etiqueta": "Privacidad y datos",
    "resumen": "Derecho al olvido de la Ley 1581. Previsualice qué datos guarda FLITO de un documento y, si procede, anonimícelos.",
    "version": "1.0",
    "fecha": "2026-10-22",
    "palabrasClave": [
      "privacidad y datos",
      "derecho al olvido",
      "anonimizar",
      "anonimización",
      "titular de datos",
      "Ley 1581"
    ],
    "consultas": [
      "cómo atiendo una solicitud de derecho al olvido",
      "cómo anonimizo los datos de una persona",
      "qué datos guarda FLITO de un documento"
    ],
    "secciones": [
      {
        "ancla": "que-es",
        "titulo": "Qué es",
        "texto": "La pantalla para atender una solicitud de derecho al olvido (Ley 1581 de 2012): primero muestra cuántos registros guarda FLITO con un número de documento y, si la solicitud procede, los anonimiza. Anonimizar no borra: nombres, correos, teléfonos y direcciones se reemplazan por marcadores y el documento por un código que no se puede revertir. Los registros se conservan para la auditoría LAFT y de seguridad."
      },
      {
        "ancla": "para-quien",
        "titulo": "Para quién",
        "texto": "Quien tenga el ítem Privacidad y datos. Previsualizar pide la acción de previsualizar los datos de un titular (de partida, el Administrador y Cumplimiento). Anonimizar pide además la acción de administrar el olvido, que de partida solo tiene el Administrador. Ambas se reparten desde Roles y permisos."
      },
      {
        "ancla": "como-se-entra",
        "titulo": "Cómo se entra",
        "texto": "Menú Administración, ítem Privacidad y datos. La pantalla se titula Privacidad y datos personales."
      },
      {
        "ancla": "pasos",
        "titulo": "Pasos",
        "texto": "Lea el aviso Política de anonimización y escriba en Número de documento el documento de la persona que hizo la solicitud. Pantalla Privacidad y datos personales con la política y un documento demo escrito Pulse Previsualizar (dice Buscando... mientras tanto). La tarjeta dice «Documento … — N registros afectados» y cuántos hay de cada tipo: Clientes, Vehículos, Solicitudes SOAT, Trámites digitales, Contrapartes LAFT y Beneficiarios finales LAFT. Previsualizar no cambia nada. Previsualización de un documento demo con siete registros afectados repartidos por tipo, antes de anonimizar Si hay registros y usted puede ejecutar la anonimización, pulse Anonimizar este documento. Sin ese permiso la tarjeta dice «Solo administradores pueden ejecutar la anonimización.» En la ventana Confirmar anonimización escriba el Motivo (mínimo 10 caracteres; queda en la auditoría) y vuelva a escribir el documento exacto. Confirmar anonimización solo se habilita cuando el documento coincide. Al confirmar, el botón dice Anonimizando... y luego un aviso confirma «Anonimización completada: N registros». La pantalla queda lista para otra solicitud. Diagrama del derecho al olvido: escribir el documento, previsualizar, decidir si hay registros y si usted puede anonimizar, confirmar con motivo y documento, y anonimización registrada La anonimización no se puede deshacer. Antes de confirmar, compruebe que el documento es el de la persona que lo pidió y que la solicitud procede."
      },
      {
        "ancla": "estados",
        "titulo": "Estados",
        "texto": "Cargando: el botón dice Buscando... mientras se previsualiza y Anonimizando... mientras se aplica. Error: un aviso arriba explica qué falló y la pantalla conserva lo escrito; si el documento tiene menos de 3 caracteres avisa «Documento muy corto». Vacío: «No hay registros con este documento. Nada que anonimizar.» Lleno: la tarjeta con el total y el conteo por tipo; los tipos con registros se resaltan."
      },
      {
        "ancla": "que-no-hace",
        "titulo": "Qué no hace",
        "texto": "No elimina registros: los anonimiza y los conserva para auditoría. No muestra los datos de la persona, solo cuántos registros hay de cada tipo. No lista las solicitudes atendidas: cada anonimización queda en la auditoría con su motivo. No muestra quién consultó los datos de una persona: eso está en Log accesos PII."
      }
    ]
  },
  {
    "clave": "siigo_credenciales",
    "permiso": "siigo_credenciales",
    "etiqueta": "Integración con Siigo",
    "resumen": "Credenciales de la integración. Solo administración.",
    "version": "1.1",
    "fecha": "2026-10-22",
    "palabrasClave": [
      "Siigo",
      "credenciales",
      "integración"
    ],
    "consultas": [
      "cómo configuro las credenciales de Siigo",
      "por qué falla la conexión con Siigo"
    ],
    "secciones": [
      {
        "ancla": "que-es",
        "titulo": "Qué es",
        "texto": "Pantalla Integración con Siigo: con qué usuario se conecta FLITO a Siigo en cada ambiente (pruebas y producción) para la emisión electrónica. Es la pantalla del entorno, no la del día a día: se abre al conectar pruebas, al conectar producción y cuando Siigo rota una llave. La access key se cifra al guardar y no se puede volver a consultar desde aquí."
      },
      {
        "ancla": "para-quien",
        "titulo": "Para quién",
        "texto": "Quien tenga el ítem Integración con Siigo. De partida, solo el Administrador; se reparte desde Roles y permisos. Consultar, registrar, probar y desactivar requieren además el permiso de administración de Siigo (de partida, el Administrador; se reparte desde Roles y permisos): si a un usuario se le da la página sin ese permiso, entra, pero la pantalla le dice que su usuario no tiene permiso para ver las credenciales."
      },
      {
        "ancla": "como-se-entra",
        "titulo": "Cómo se entra",
        "texto": "En el menú lateral, sección Administración, ítem Integración con Siigo. También desde este capítulo de la ayuda, con Ir a la pantalla. Distíngala de Credenciales RNDC, que vive en la sección RNDC y es otra integración, y de Facturación electrónica · Parametrización y Operación, que están en Finanzas."
      },
      {
        "ancla": "pasos",
        "titulo": "Pasos",
        "texto": "Entre a Integración con Siigo. Usted verá una tarjeta por ambiente con su estado: Activa o Sin configurar. La tarjeta con credencial activa muestra Usuario, Access key (oculta), Versión de llave, Registrada y Notas. Tarjetas de pruebas con credencial demo Activa y de producción Sin configurar Para conectar un ambiente, pulse Registrar nueva credencial (o Registrar otra credencial si ya hay una activa). Escriba el usuario y la access key (Mostrar / Ocultar la deja ver mientras escribe) y, si quiere, una nota para recordar de qué cuenta es; no escriba ahí la clave. Pulse Guardar y cifrar (el botón pasa a Guardando…). En producción, el formulario le recuerda que desde que guarde es la credencial con la que FLITO emitirá facturas ante la DIAN. Formulario para registrar la credencial de producción, vacío y con el recordatorio de la DIAN Para comprobar que la credencial activa funciona, pulse Probar conexión (mientras tanto dice Probando…); la tarjeta le muestra el Resultado de la prueba. Si hizo demasiadas pruebas seguidas, espere un minuto antes de repetir. Resultado de la prueba con conexión correcta para el usuario demo de pruebas Para retirar una credencial, pulse Desactivar y confírmelo en el diálogo (Desactivando… mientras se aplica). El registro no se borra: queda en el historial de ese ambiente con la fecha del día. Mientras no registre otra, FLITO no podrá conectarse a Siigo en ese ambiente. Al terminar una acción, un aviso en la parte superior le confirma lo que pasó. Las credenciales anteriores están en Historial de este ambiente (N), que se abre y se cierra, con Usuario, Estado, Llave, Registrada y Desactivada. Historial del ambiente de pruebas abierto con una credencial demo anterior inactiva Si lo que usted necesita son las credenciales del RNDC, vaya al menú RNDC, ítem Credenciales RNDC. No es esta pantalla. Diagrama del ciclo de una credencial por ambiente: sin configurar, registrar y cifrar, activa, probar la conexión, registrar otra al rotar la llave o desactivarla dejándola en el historial"
      },
      {
        "ancla": "estados",
        "titulo": "Estados",
        "texto": "Cargando: dos tarjetas grises y el texto Consultando las credenciales configuradas…. Error: una banda roja con el mensaje y Reintentar. Si su usuario no tiene permiso, la banda lo dice y no ofrece reintentar, porque fallaría igual. Con error no se dibuja ninguna tarjeta, para no invitarle a registrar encima de una credencial que quizá sí existe. Vacío: la tarjeta del ambiente dice Sin configurar y En este ambiente no hay credenciales., con lo que eso implica (en producción, que ninguna factura puede emitirse ante la DIAN hasta que registre una). Lleno: las dos tarjetas con su credencial activa y su historial. Si falta la llave maestra de cifrado del servidor, encima aparece No se pueden registrar credenciales: es un problema del entorno, no de sus datos, y lo resuelve quien administra el servidor."
      },
      {
        "ancla": "que-no-hace",
        "titulo": "Qué no hace",
        "texto": "No muestra la access key guardada: una vez cifrada, no se puede volver a consultar. No borra credenciales: desactivar las deja en el historial. No es Credenciales RNDC. No sustituye a Facturación electrónica · Parametrización ni a Operación, ni es un alias de ellas. No Factura liquidaciones ni hace emisión electrónica: solo guarda con qué usuario se conecta FLITO."
      }
    ]
  }
] as FichaAyudaApi[]);
