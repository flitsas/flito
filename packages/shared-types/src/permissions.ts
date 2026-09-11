// FUENTE ÚNICA de roles, catálogo de páginas y permisos por defecto.
// Consumido por API (apps/api/src/shared/permissions.ts) y web
// (apps/web/src/lib/permissions.ts). NO duplicar estas tablas en ningún otro lado:
// el test de paridad (permissions.authz.test.ts) falla si vuelven a divergir.
//
// Módulo PURO (sin zod ni side-effects) para que el web pueda importar el catálogo
// sin arrastrar zod al bundle. La validación de `role` en endpoints usa z.enum(ALL_ROLES).

// ============================================================================
// Roles del sistema
// ============================================================================
// ── LA FRONTERA (HU #12169) ──────────────────────────────────────────────────
// El código de SISTEMA se tipa con `UserRole`; los roles que crea el administrador
// son DATO y se leen de `permisos_roles`, nunca de un tipo.
//
// Desde la migración 0178 esta tupla YA NO es la fuente de verdad de qué roles
// existen: eso es la tabla `permisos_roles`, y `users.role` es un varchar con FK a
// ella. Lo que esta tupla sigue siendo —y por eso no se toca— es la lista de los
// doce códigos que el CÓDIGO conoce por su nombre, y la que da exhaustividad en
// compilación a los tres `Record<UserRole, …>` (ROLE_LABELS, ROLE_DEFAULT_PAGES y
// ROLES_POR_ACCION de siigo-permisos.ts).
//
// Añadir aquí un rol nuevo NO lo crea: crearlo es insertar una fila (CF-03). Esta
// tupla solo crece cuando el código va a tratar ese rol por su nombre, y entonces
// hay que sembrar también su fila en `permisos_roles`.
//
// Para leer el rol de UN USUARIO usa `RoleCode`, no `UserRole`: puede ser un código
// que el administrador acaba de crear y que no tiene entrada en ninguna tabla de
// este archivo.
//
// Tupla canónica. UserRole y ALL_ROLES se derivan de aquí para que no puedan
// desincronizarse (antes vivían en 3 sitios con conteos distintos: 8/7/4).
export const USER_ROLES = [
  'admin',
  'proveedor',
  'transito',
  'compliance',
  'lider_pesv',
  'supervisor_flota',
  'conductor',
  'auditor',
  // FLITO (migración packages/ → Operaciones): gestor de impuestos (atado a un organismo).
  // El operador FLITO ES el admin (despliegue FLITO-only); gestor SOAT reutiliza `proveedor`;
  // auditoría reutiliza `auditor`. El antiguo rol `operaciones` se fusionó en `admin`.
  'gestor_impuestos',
  // FLITO Logística: mensajero de campo. Usa la PWA y solo ve su ruta asignada (CA-11).
  // Las tareas de Coordinador (armar/despachar actas, asignar rutas) las asume `admin`.
  'mensajero',
  // Finanzas: usuarios del área financiera (contabilidad, facturación, cobros). Hoy solo el reporte de costos.
  'financiera',
  // FLITO — Cliente (Feature #11912): usuario de una COMPAÑÍA cliente, no de la operación. Es el
  // primer rol del producto que no pertenece a FLIT: entra desde fuera, ve una sola pantalla
  // (`flito_soat`) y solo lo de su compañía. Esa atadura es obligatoria y va en la base
  // (`users.compania_id` + CHECK), no en este catálogo: un `cliente` sin compañía no debe existir,
  // y si existiera, `contextoSoat()` le devuelve cola vacía (ADR-0008 §3).
  // NO reabre el difunto rol `operaciones`: aquel era un superusuario del dominio y se fusionó en
  // `admin`; este es lo contrario, el rol más acotado del sistema.
  'cliente',
] as const;

export type UserRole = (typeof USER_ROLES)[number];

/**
 * El rol de un usuario TAL COMO VIAJA: el código de una fila de `permisos_roles` (HU #12169).
 *
 * Los doce de sistema (`UserRole`) siguen en el autocompletado; cualquier otro código es un rol que
 * creó el administrador y NO tiene entrada en ninguna tabla de este archivo. Un `Record<UserRole,…>`
 * NO se puede indexar con esto: usa `paginasPorDefecto()`.
 *
 * Honestidad sobre lo que este tipo NO da: `string & {}` mantiene el autocompletado sin cerrar el
 * tipo, pero no protege contra un literal mal escrito — `role === 'admn'` compila. Esa protección se
 * pierde con el catálogo editable y la recuperan la FK `users_role_fkey` (un código inventado no
 * entra en la base) y la validación contra el catálogo de `users.routes.ts` (ADR-0015 §Decisión 4).
 */
export type RoleCode = UserRole | (string & {});

// Roles asignables al crear/editar un usuario. Hoy = todos los roles del sistema
// (incluye `auditor`, que antes faltaba y volvía el rol inasignable por el producto).
export const ALL_ROLES = USER_ROLES;

// Etiqueta legible en español por rol. Capa de presentación; única fuente para la UI.
export const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Administrador',
  compliance: 'Cumplimiento (LAFT)',
  transito: 'Tránsito',
  proveedor: 'Proveedor',
  lider_pesv: 'Líder PESV',
  supervisor_flota: 'Supervisor de flota',
  conductor: 'Conductor',
  auditor: 'Auditor (revisor fiscal)',
  gestor_impuestos: 'Gestor de Impuestos',
  mensajero: 'Mensajero',
  financiera: 'Financiera',
  // Etiqueta exacta del copy de UX (docs/ux/identidad-rol-cliente-y-soat-sin-tramite.md §1.4).
  cliente: 'Cliente',
};

// ============================================================================
// Catálogo de páginas (slug → label visible)
// ============================================================================
export const PAGES = {
  dashboard: 'Tablero de control',
  vehicles: 'Vehículos',
  clients: 'Clientes y proveedores',
  soat: 'SOAT',
  tramite: 'Trámite Digital',
  tax_reader: 'Lectura de Impuestos',
  drive: 'Google Drive',
  users: 'Usuarios',
  laft: 'Cumplimiento LAFT',
  laft_unusual: 'Operaciones inusuales',
  laft_trainings: 'Capacitaciones',
  laft_manual: 'LAFT — Manual SARLAFT',
  laft_oficial: 'LAFT — Oficial cumplimiento',
  laft_audit_plan: 'LAFT — Plan de auditorías',
  laft_dashboard: 'LAFT — Tablero',
  transito: 'Tránsito',
  transito_organismos: 'Organismos de tránsito',
  privacy: 'Privacidad y datos',
  fleet: 'Flota',
  maintenance: 'Mantenimiento',
  pesv: 'PESV — Conductores',
  rndc: 'RNDC y manifiestos',
  rndc_admin: 'Catálogos RNDC',
  pesv_raci: 'PESV — Matriz RACI',
  pesv_normativa: 'PESV — Tracker normativo',
  pesv_retencion: 'PESV — Retención documental',
  // FLITO (migración packages/ → Operaciones). El resto son nuevos.
  //
  // El portal SOAT de FLITO (`/flito/soat`) TENÍA el slug `soat` prestado del módulo legacy
  // (`/soat`), porque para los tres titulares de esa llave —`admin`, `proveedor`, `auditor`— las dos
  // pantallas tienen la misma respuesta. Desde el Feature #11912 ya no: `cliente` es el primer rol
  // para el que la respuesta es opuesta (SÍ al portal, NO al legado), y una llave no puede dar dos
  // respuestas. Ver `flito_soat`, unas líneas más abajo, y ADR-0008 §4.
  flito_tramites: 'FLITO — Trámites',
  // Portal SOAT de FLITO (`/flito/soat`). Clave PROPIA desde el Feature #11912, y no la `soat` de
  // arriba, que sigue siendo la del módulo legacy (`/soat`, `Soat.tsx`).
  //
  // El precedente es el de `flito_comparendos`, `flito_conciliacion` y `siigo_credenciales`: el
  // permiso de página y la autoridad del router son dos puertas distintas. Aquí además son dos
  // PANTALLAS distintas bajo la misma llave, que es lo que deja de sostenerse en cuanto un rol
  // necesita entrar a una y no a la otra.
  //
  // El cambio es ADITIVO: `proveedor` y `auditor` reciben este slug ADEMÁS de `soat`, así que su
  // comportamiento no cambia (y la migración 0167 se lo materializa a quien tuviera `soat`
  // concedido a mano). El único que lo tiene SIN `soat` es `cliente`, y de ahí sale el AC4 de la
  // HU #11913 **por construcción**: no hay que escribir en ningún router una regla que nombre al
  // rol `cliente` para que el legado le quede cerrado — sencillamente no tiene la llave. Una regla
  // así sería una lista negra, y se rompería en silencio con el siguiente rol que reciba `soat`.
  flito_soat: 'FLITO — SOAT',
  flito_impuestos: 'FLITO — Impuestos',
  // Derechos de tránsito: lo que el organismo cobra por radicar (HU #10950/#10951).
  flito_derechos: 'FLITO — Derechos de tránsito',
  flito_revisiones: 'FLITO — Revisión OCR',
  flito_compuerta: 'FLITO — Compuerta de entrega',
  flito_tablero: 'FLITO — Tablero',
  flito_bitacora: 'FLITO — Bitácora',
  // FLITO Logística: consola de Operaciones (trazabilidad por documento, actas, despacho).
  flito_logistica: 'FLITO — Logística',
  // FLITO Logística — ruta del mensajero (PWA de campo, Fase 2): recogidas y entregas asignadas.
  flito_logistica_ruta: 'FLITO — Mi ruta (mensajero)',
  // Monitoreo de comparendos (Feature #11495, 17b): el visor de lo que SIMIT y los municipios
  // reportan de los NIT vigilados. Clave PROPIA y no una sub-vista de `flito_tramites`: quien opera
  // comparendos no tiene por qué entrar al resto del sistema, y ese es justo el permiso que esta
  // pantalla concede. NO se añade a `ROLE_DEFAULT_PAGES` en ninguna fila —`admin` la obtiene por
  // tenerlas todas—; en particular NO se le da a `auditor`, que sí entra al resto de FLITO en
  // lectura: el router de `/flito/comparendos` exige `admin` entero, así que darle la página sería
  // regalarle una pantalla que responde 403 en cada petición.
  flito_comparendos: 'FLITO — Comparendos',
  // Bolsas prepago del cliente (Feature #11120): saldo, movimientos, cierres y estado de cuenta de
  // los organismos. Es dinero, así que solo la ven Administración y Financiera — ni siquiera
  // auditoría, a diferencia del resto de vistas FLITO.
  flito_bolsas: 'FLITO — Bolsas prepago',
  // Conciliación de recaudo SOAT (Feature #11623): la carga del .xlsx del portal, el cuadre contra
  // lo emitido y el cierre con su comprobante. Es dinero de terceros, así que sigue el reparto de
  // `flito_bolsas` y NO el del resto de FLITO: solo Administración y Financiera. `auditor` queda
  // fuera a propósito —el router de `/flito/conciliacion` exige `admin`/`financiera` entero, y su
  // lectura del comprobante ya va por la ruta suya de `/flito/soat` (HU #11678)—.
  flito_conciliacion: 'FLITO — Conciliación',
  // Finanzas — reporte de costos por trámite (contabilidad / facturación / cobros).
  finanzas_reporte_costos: 'Finanzas — Reporte de costos',
  // Facturación electrónica (Feature #11240): parametrización de la integración con Siigo —
  // catálogos, mapeo de conceptos a productos y configuración global de emisión. UNA sola clave
  // para toda la parametrización: son pantallas del mismo trabajo y de la misma persona, y
  // partirla obligaría a conceder dos permisos para completar una tarea.
  siigo_parametrizacion: 'Facturación electrónica — Parametrización',
  // Facturación electrónica (Feature #11244): la pantalla de OPERACIÓN — bandeja de facturas,
  // línea de tiempo de cada una y las acciones de emitir, reintentar, reenviar o corregir.
  // Clave PROPIA y distinta de `siigo_parametrizacion` y de `finanzas_reporte_costos` a propósito:
  // parametrizar es decidir cómo se factura (se hace una vez y casi no se toca), operar es empujar
  // facturas todos los días, y el reporte de costos es otro trabajo con otra audiencia. Unirlas
  // obligaría a conceder la operación diaria a quien solo debe parametrizar, o al revés.
  siigo_operacion: 'Facturación electrónica — Operación',
  // Parametrización — configurador de tarifas (Feature #12365, HU #12375): el cuadro de valores por
  // compañía y el historial de vigencias de cada concepto. Clave PROPIA y en «Finanzas», no en el
  // grupo FLITO: las tarifas son de donde salen los valores del reporte de costos y quien las fija
  // es Financiera. Mismo reparto que las operaciones `parametrizacion.tarifas.*` que la pantalla
  // consume (0182): `admin` y `financiera`. `auditor` queda fuera a propósito —la 0182 le retiró
  // `parametrizacion.tarifas.listar` (AC16 de la HU #12373)— y concederle la página sería regalarle
  // una pantalla que responde 403 en cada petición.
  flito_tarifas: 'Finanzas — Tarifas',
  // Facturación electrónica (HU #11890): las CREDENCIALES de la integración — con qué usuario se
  // conecta FLITO a Siigo en cada ambiente, y la prueba de conexión.
  //
  // Clave PROPIA, y **NO se añade a ninguna fila de `ROLE_DEFAULT_PAGES`**: `admin` la obtiene por
  // `Object.keys(PAGES)` y nadie más debe tenerla. El precedente literal es `flito_comparendos`:
  // `credenciales.routes.ts` monta `authMiddleware, requireRole('admin')` sobre las CUATRO
  // operaciones —listar incluida—, así que conceder la página a `financiera` o a `auditor` sería
  // regalarles una pantalla que responde 403 en cada petición. El permiso de página y la autoridad
  // del router son dos puertas distintas, y aquí solo se puede abrir una.
  siigo_credenciales: 'Facturación electrónica — Credenciales',
  // Roles y permisos (Feature #12072, HU #12085): el panel de administración del motor de permisos —
  // el cuadro rol × función, la creación de roles y su mantenimiento. Clave PROPIA en «Administración»
  // y, como `siigo_credenciales`, **NO se añade a ninguna fila de `ROLE_DEFAULT_PAGES`**: `admin` la
  // obtiene por el catálogo (`rolesQueConcedenLaPagina` → `['admin']`) y nadie más la recibe por
  // defecto. Las siete operaciones `permisos.*` que la pantalla consume (0186) son solo de `admin`;
  // conceder la página a otro rol sería regalarle una pantalla que responde 403 en cada petición.
  // Lo siembra la 0187 (`pagina.roles_permisos`, reparto `admin`).
  roles_permisos: 'Roles y permisos',
  // Ayuda FLITO (HU #11893): contenedor del índice in-app. El slug existe SOLO para el label de
  // NoAccess y el ítem de nav. NO entra en `PAGE_GROUPS` (Users no debe ofrecer concederlo a mano)
  // ni en ninguna fila de `ROLE_DEFAULT_PAGES`: la visibilidad es derivada (`hasPage` de ≥1 slug
  // del catálogo de fichas). `admin` lo obtiene por `Object.keys(PAGES)`, pero el gate de ruta
  // NO usa `hasPage(..., 'flito_ayuda')` — eso dejaría la pantalla solo al admin.
  // La clave `siigo_credenciales` de su catálogo de ayuda se lista solo si `user.role === 'admin'`;
  // el PageSlug lo añadió la HU #11890, justo encima.
  flito_ayuda: 'Ayuda FLITO',
} as const satisfies Record<string, string>;

export type PageSlug = keyof typeof PAGES;

export const PAGE_GROUPS: { label: string; pages: PageSlug[] }[] = [
  { label: 'General', pages: ['dashboard'] },
  { label: 'Operaciones', pages: ['vehicles', 'soat', 'tramite', 'tax_reader', 'transito', 'drive'] },
  { label: 'Flota', pages: ['fleet'] },
  { label: 'Mantenimiento', pages: ['maintenance'] },
  { label: 'PESV', pages: ['pesv', 'pesv_raci', 'pesv_normativa', 'pesv_retencion'] },
  { label: 'RNDC', pages: ['rndc', 'rndc_admin'] },
  { label: 'Cumplimiento LAFT', pages: ['laft', 'laft_unusual', 'laft_trainings', 'laft_manual', 'laft_oficial', 'laft_audit_plan', 'laft_dashboard'] },
  { label: 'Tránsito', pages: ['transito', 'transito_organismos'] },
  // El portal FLITO lista `flito_soat` y NO `soat`: aquella clave es la del módulo legacy, que ya
  // aparece arriba en «Operaciones». Hasta el Feature #11912 la misma clave salía en los dos
  // grupos —una rareza que nadie sabía explicar— porque el portal la tenía prestada.
  { label: 'FLITO (SOAT e Impuestos)', pages: ['flito_tramites', 'flito_soat', 'flito_impuestos', 'flito_derechos', 'flito_revisiones', 'flito_compuerta', 'clients', 'flito_tablero', 'flito_bitacora', 'flito_logistica', 'flito_logistica_ruta', 'flito_bolsas', 'flito_comparendos', 'flito_conciliacion'] },
  { label: 'Finanzas', pages: ['finanzas_reporte_costos', 'siigo_parametrizacion', 'siigo_operacion', 'flito_tarifas'] },
  { label: 'Administración', pages: ['users', 'privacy', 'siigo_credenciales', 'roles_permisos'] },
];

// ============================================================================
// Permisos por defecto por rol — base que se UNE con allowedPages del usuario.
//
// Aquí decía «Admin tiene acceso a TODO independiente del campo allowed_pages», y desde la HU #12081
// es FALSO: esa frase describía el comodín que el AC4 retiró. `admin` ya no tiene fila en esta tabla
// —el objeto de abajo es total sobre los otros once y volver a escribir `admin:` no compila— y sus 43
// páginas se las da el reparto sembrado en `permisos_rol_funcion`, una a una. El acceso total pasó de
// ser una rama del programa a ser configuración (CF-13, RN-A1, ADR-0015 §Decisión 4).
//
// Quien las resuelve en el servidor es `paginasEfectivasDeUsuario` (apps/api/src/shared/
// permisos-efectivos.ts); esta tabla es lo que el navegador conoce, y el navegador ya no sabe nada
// especial de `admin`.
// ============================================================================
const DEFAULTS_POR_ROL: Record<Exclude<UserRole, 'admin'>, readonly PageSlug[]> = {
  compliance: ['dashboard', 'laft', 'laft_unusual', 'laft_trainings', 'laft_manual', 'laft_oficial', 'laft_audit_plan', 'laft_dashboard', 'privacy', 'pesv', 'pesv_raci', 'pesv_normativa', 'pesv_retencion'],
  // Líder PESV: gestión completa del PESV pero NO acceso a SOAT/RNDC/LAFT.
  lider_pesv: ['dashboard', 'pesv', 'fleet', 'maintenance', 'pesv_raci', 'pesv_normativa', 'pesv_retencion'],
  // Supervisor de flota: ve flota+PESV+mantenimiento, opera incidentes/checklists.
  supervisor_flota: ['dashboard', 'pesv', 'fleet', 'maintenance', 'vehicles'],
  // Conductor: ve solo su jornada propia + reporta incidentes desde móvil.
  conductor: ['dashboard', 'pesv'],
  transito: ['dashboard', 'transito'],
  // Proveedor = Gestor SOAT de FLITO: ve su cola SOAT (filtrada por proveedor en el servidor).
  // `flito_soat` se SUMA a `soat` (Feature #11912): conserva las dos pantallas que ya abría, así
  // que para él este cambio es cero. Quitarle `soat` sería otra HU y otra discusión.
  proveedor: ['dashboard', 'soat', 'flito_soat'],
  // Auditor: read-only LAFT + vistas FLITO de solo lectura (migración D-2). No se le
  // incluye en ningún requireRole de mutación FLITO — solo lectura.
  auditor: ['dashboard', 'laft_manual', 'laft_oficial', 'laft_audit_plan', 'laft_dashboard',
    // `flito_soat` se SUMA a `soat` (Feature #11912) por lo mismo que en `proveedor`: aditivo, para
    // que el auditor siga leyendo exactamente las dos pantallas que leía.
    'flito_tramites', 'soat', 'flito_soat', 'flito_impuestos', 'flito_derechos', 'flito_revisiones', 'flito_compuerta', 'clients', 'flito_tablero', 'flito_bitacora', 'flito_logistica',
    // El reporte de costos consolida datos que el auditor ya ve uno a uno (SOAT, impuestos,
    // derechos). Negarle la vista agregada no protegía nada: solo le obligaba a reconstruirla.
    'finanzas_reporte_costos',
    // Parametrización de facturación electrónica: el backend concede lectura a `auditor` en las
    // tres rutas (mapeo, configuración y compuerta) porque ver la parametrización que respalda una
    // factura emitida es parte de auditar. La pantalla no le deja escribir nada.
    'siigo_parametrizacion',
    // Operación de facturación electrónica: VER la bandeja, la línea de tiempo y el estado de cada
    // factura es exactamente lo que audita un revisor fiscal. Las acciones que mueven una factura
    // (emitir, reintentar, corregir…) le están negadas en el servidor por la tabla de
    // `siigo.permisos.ts`, que solo le concede `consultar`. Ver y operar no son el mismo permiso.
    'siigo_operacion',
    // HU #12171 — el historial de cambios de usuarios, roles y permisos vive en la pantalla de
    // usuarios y el auditor tiene que poder abrirlo (AC3). La PÁGINA sí; las operaciones de listar
    // usuarios y ver el resumen NO (son PII de todo el censo, AC4): la 0185 le siembra solo
    // `usuarios.auditoria.ver` y `usuarios.auditoria.filtrar`, y la pantalla le monta solo el historial.
    'users'],
  // FLITO — el operador del dominio ES el admin (despliegue FLITO-only): admin ya obtiene TODAS
  // las páginas arriba, así que no hay una fila `operaciones` aparte.
  // FLITO — Gestor de Impuestos: solo su portal (filtrado por organismo en el servidor).
  gestor_impuestos: ['dashboard', 'flito_impuestos'],
  // FLITO Logística — Mensajero: su ruta de campo (PWA). No accede a la consola de Operaciones.
  mensajero: ['dashboard', 'flito_logistica_ruta'],
  // Finanzas — usuarios financieros: el reporte de costos y la administración comercial del
  // cliente (sus tarifas), que es de donde salen los valores de ese reporte. Los derechos de
  // tránsito NO son suyos: los gestiona Operaciones, que es quien carga los recibos.
  // Las bolsas prepago SÍ son suyas: es el dinero del cliente que Financiera recarga, mueve y
  // cierra. El backend (`/flito/bolsas`) solo admite admin y financiera, así que la página va aquí
  // y NO en `auditor`, que en el resto de FLITO lee todo pero de los movimientos crudos queda fuera.
  // La parametrización de facturación electrónica es suya: `financiera` es quien FIRMA la
  // confirmación de contabilidad de cada concepto (AC8 de la HU #11282). Ve la pantalla completa,
  // pero el backend solo le admite el endpoint de confirmar; el resto de la edición es de `admin`.
  // La operación de facturación electrónica también es suya: `financiera` es quien emite, reintenta
  // y corrige el día a día (valor conservador de hoy en `siigo.permisos.ts`: escritura para `admin`
  // y `financiera`). Si mañana se decide que solo emite `admin`, se edita esa tabla y esta línea.
  // La conciliación del recaudo SOAT es suya por el mismo motivo que las bolsas: es plata del
  // cliente que Financiera cuadra y cierra. El router de `/flito/conciliacion` solo admite
  // `admin` y `financiera` (CF-08), así que la página va aquí y NO en `auditor`.
  // El configurador de tarifas (HU #12375) es suyo por lo mismo que `clients`: fijar el valor de cada
  // concepto es la administración comercial del cliente, y el router de `parametrizacion.tarifas.*`
  // ya le admite (0182). Si esta línea no está, el catálogo del código diría «solo admin» y la
  // migración 0184 que la siembra a `financiera` chocaría con la paridad de migracion-0179.test.ts.
  financiera: ['dashboard', 'finanzas_reporte_costos', 'clients', 'flito_bolsas', 'flito_conciliacion', 'siigo_parametrizacion', 'siigo_operacion', 'flito_tarifas'],
  // FLITO — Cliente (Feature #11912): UNA sola página, y a propósito SIN `dashboard`.
  //
  // El tablero es de la operación: consolida trámites, SOAT e impuestos de TODAS las compañías, así
  // que dárselo sería enseñarle lo ajeno o mantener una segunda versión filtrada del tablero. La
  // consecuencia es que el `cliente` no tiene página de inicio, y eso NO se tapa aquí: lo resuelve
  // `rutaInicio(user)` en el web, que manda a la primera página permitida (ADR-0008 §4-C).
  //
  // Tampoco lleva `soat`: esa es la del módulo legacy y es justo la llave que el AC4 de la HU
  // #11913 le niega. Esto se aparta de una línea del refinamiento —que decía `['soat']`— y la
  // desviación está razonada y aceptada en el ADR-0008 §4.
  cliente: ['flito_soat'],
};

/**
 * Páginas por defecto de cada rol de sistema. **PARCIAL, y `admin` NO tiene fila** (HU #12081, AC4).
 *
 * Hasta la 0179 la primera entrada era `admin: Object.keys(PAGES)`, y era uno de los DOS atajos que
 * le daban todo. Los dos se retiran juntos —este y el `role === 'admin'` de `getEffectivePages`—
 * porque retirar solo uno no cambia nada: el otro se lo vuelve a dar. Quien repone sus páginas es el
 * reparto sembrado en `permisos_rol_funcion`, donde `admin` tiene las 43 marcadas UNA A UNA: el
 * acceso total pasa a ser configuración y no una rama cableada (CF-13, RN-A1, ADR-0015 §Decisión 4).
 *
 * El tipo es `Partial<Record<UserRole, …>>` de cara afuera, pero el objeto de dentro es total sobre
 * `Exclude<UserRole, 'admin'>`: los otros once siguen dando error de compilación si a un rol nuevo
 * se le olvida su fila, y volver a escribir `admin:` aquí tampoco compila. Esa es la única parte de
 * esta decisión que el tipo puede sostener.
 *
 * OJO — quien lee esto en el SERVIDOR no debe usarlo para resolver las páginas de un usuario: eso es
 * `paginasEfectivasDeUsuario()` (apps/api/src/shared/permisos-efectivos.ts), que las lee de la base.
 * Esta tabla es lo que el navegador conoce, y el navegador no sabe nada de `admin` desde esta HU.
 */
export const ROLE_DEFAULT_PAGES: Partial<Record<UserRole, readonly PageSlug[]>> = DEFAULTS_POR_ROL;

// Helpers de permisos PESV: en endpoints de gestión PESV, lider_pesv tiene los mismos
// derechos que admin. Para el resto del sistema, sigue siendo rol limitado.
export const PESV_ADMIN_ROLES: readonly UserRole[] = ['admin', 'lider_pesv'];
// Para inspecciones/checklists/incidentes el supervisor_flota también puede mutar.
export const FLEET_OPS_ROLES: readonly UserRole[] = ['admin', 'lider_pesv', 'supervisor_flota'];

export function isValidPage(slug: string): slug is PageSlug {
  return slug in PAGES;
}

/**
 * Páginas por defecto del rol (HU #12169). Un rol que creó el administrador no tiene fila en
 * `ROLE_DEFAULT_PAGES`, y entonces son `[]`: sus páginas serán exactamente sus `allowedPages`, ni una
 * más. El fallo por defecto es «no ve nada» —la misma dirección que el `return null` de
 * `contextoSoat()` (ADR-0008 §3)—: un rol nuevo nace sin pantallas y el admin le concede, nunca al revés.
 *
 * Encapsula la indexación porque `ROLE_DEFAULT_PAGES` es total sobre `UserRole` y un `RoleCode` no es
 * indexable con seguridad: el `?? []` de aquí era código muerto hasta esta HU y ahora hace su trabajo.
 */
export function paginasPorDefecto(role: RoleCode): readonly PageSlug[] {
  return (ROLE_DEFAULT_PAGES as Record<string, readonly PageSlug[] | undefined>)[role] ?? [];
}

/**
 * Combina los defaults del rol con las páginas personalizadas del usuario.
 * Admin siempre obtiene TODO. Otros roles: union(rol_defaults, user.allowedPages válidas).
 *
 * `role` es `RoleCode` desde la HU #12169: puede ser un rol creado por el administrador, que aporta
 * `[]` de defaults.
 *
 * **YA NO HAY COMODÍN DE `admin`** (HU #12081, AC4). Aquí vivía `if (user.role === 'admin') return
 * Object.keys(PAGES)`, el segundo de los dos atajos cableados; el otro era su fila en
 * `ROLE_DEFAULT_PAGES`. Los dos se retiraron a la vez que la migración 0179 sembró sus 43 páginas
 * una a una en `permisos_rol_funcion`.
 *
 * La consecuencia práctica, y hay que saberla: para `admin` esta función devuelve exactamente sus
 * `allowedPages`. En el navegador eso basta porque el sobre de `/login` y `/me` trae ya la lista
 * RESUELTA CONTRA LA BASE (`paginasEfectivasDeUsuario`), no la columna cruda. Llamar a esta función
 * en el servidor con la fila pelada de `users` para decidir si un admin entra a algo devolvería `[]`.
 *
 * **La SPA ya no la llama** (HU #12087): `effectivePages` del web devuelve exactamente lo que trae
 * `/me` (resuelto contra la base), sin unir los defaults compilados. Unirlos volvía a pintar en el
 * menú una página que el administrador quitó del cuadro del rol o revocó al usuario. Esta función
 * queda como el oráculo de catálogo en tiempo de compilación que usan el seed (`catalogo.ts`) y los
 * tests de paridad; su cuerpo no cambia.
 */
export function getEffectivePages(user: { role: RoleCode; allowedPages?: string[] | null }): PageSlug[] {
  const fromRole = paginasPorDefecto(user.role);
  const fromUser = (user.allowedPages ?? []).filter(isValidPage);
  return Array.from(new Set([...fromRole, ...fromUser]));
}
