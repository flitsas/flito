# ADR-0025 — Árbol de permisos en tres niveles: nodos en el catálogo, acciones que expanden operaciones

- **Estado:** Propuesto (lo aprueba el Líder Técnico; ningún agente lo marca Aceptado)
- **Fecha:** 2026-10-09
- **Feature:** #13416 (Épica #13411, Fase 3) — HUs #12873, #13427, #13428, #13429, #13430, #13431
- **Relacionados:** ADR-0022 (admin editable + anti-bloqueo), ADR-0023 (legacy por página por ítem + transitorio `.administrar`), ADR-0024 (frontera por enlace). No supersede ninguno; **retira** el transitorio de ADR-0023 (lo prevé su propio texto como paso de F3).
- **Diseño operativo:** `docs/arquitectura/feature-13416-catalogo-tres-niveles.md`

## Contexto

Hoy el permiso es plano: `permisos_funciones` tiene una fila por página (`pagina.<slug>`) y una por
operación (`<modulo>.<objeto>.<accion>`, ~230 guardas FLITO + ~380 legacy), y el panel las agrupa por
`modulo`. Cada `exigirFuncion('<op>')` de una ruta pide exactamente una fila del catálogo.

El PO aprobó (7-oct) un panel de tres niveles —elemento del menú → ítem → acción— con nombres de
pantalla, acciones que **agrupan** varias operaciones («Ver listado» = listado + detalle + filtros +
historial), anidamiento («Exportar con datos de pago» bajo «Exportar»), marcas que se **conservan**
ocultas al desmarcar un padre, y ítems legacy que llegan solo al nivel 2. Hay que decidir dónde vive el
árbol y cómo se relaciona con las guardas existentes sin romper `exigirFuncion` / `hasFuncion`.

## Alternativas

### Opción 1 — Nodos en `permisos_funciones` (columna `padre_codigo`) + acciones que **expanden** a operaciones en el resolver (recomendada)

El árbol se define en código (shared-types: nombres/estructura; API: acción → operaciones) y se siembra
en `permisos_funciones` con `padre_codigo`/`nivel`/`orden`. Las marcas se guardan en las tablas de hoy
(`permisos_rol_funcion`, `permisos_usuario_funcion`) sobre cualquier nodo. Las **operaciones dejan de
ser concedibles** (salen de `permisos_funciones` por área) pero siguen siendo lo que piden las guardas:
`resolverPermisos` expande nodo efectivo → operaciones.

- **Pros:** cero cambios en ~610 guardas y en los `hasFuncion` de la web (el conjunto efectivo sigue
  conteniendo los códigos de operación); «desmarcar conserva» sale gratis (se borra solo la fila del
  padre); excepciones por usuario en cualquier nivel con la tabla actual; la comprobación de arranque
  (`CatalogoIncoherenteError`) se conserva; coexistencia por área durante la cadena (un área migrada
  expande, una no migrada sigue concediendo operaciones directas).
- **Contras:** dos vocabularios (acción = permiso, operación = identificador interno de guarda); la
  bitácora del 403 registra la operación y necesita traducirla a la acción que la concede.
- **Esfuerzo:** M (schema 3 columnas + resolver + generador de SQL; el grueso es el mapeo por área).
- **Riesgos:** mapeo acción→operaciones incompleto (lo cierra el test AC6 en doble sentido); una
  operación de apoyo en varias acciones (se admite N:M, declarado).

### Opción 2 — Renombrar las guardas: cada `exigirFuncion` pide directamente el código de acción

- **Pros:** un solo vocabulario; resolver sin expansión.
- **Contras:** reescribe ~610 guardas, `inventario.generado.ts`, `catalogo-operaciones*.ts` y los
  `hasFuncion` de ~40 pantallas; diffs enormes por HU (gate ≤800 líneas en `catalogo-operaciones.ts` ya
  en 429 + 485 legado); una operación compartida por dos acciones («listas de apoyo») obliga a guardas
  con OR. Pierde la llave `<fichero> <MÉTODO> <ruta>` que hoy da la comprobación de doble sentido.
- **Esfuerzo:** L. **Riesgos:** regresiones de acceso por ruta, conflictos con toda rama en vuelo.

### Opción 3 — Tabla nueva `permisos_nodos` (árbol editable en base) + tabla `permisos_nodo_operacion`

- **Pros:** el árbol es dato; se podría reordenar sin deploy.
- **Contras:** nadie pidió editar el árbol en runtime; dos fuentes de verdad (código y base) que la
  comprobación de arranque tendría que reconciliar; FKs nuevas desde `permisos_rol_funcion` o una
  segunda tabla de marcas; más superficie para db-review.
- **Esfuerzo:** L. **Riesgos:** deriva código↔base, duplicar el modelo de marcas.

## Decisión (propuesta)

**Opción 1.** El árbol es catálogo (código, comparado con la base al arrancar); las marcas son las
filas de siempre; las guardas no cambian. Reglas:

1. **Prefijos de código** (discriminan sin consultar la base, como `pagina.` hoy):
   `menu.<elemento>` (nivel 1) · `pagina.<slug>` (nivel 2 = ítem, **se reutiliza** la página actual) ·
   `accion.<item>.<accion>` (nivel 3; hija anidada: `padre_codigo` = la acción madre). Ninguna operación
   empieza por `accion.` ni `menu.` (lo asegura un test).
2. **Efectivo de un nodo** = `marcado(n) ∧ marcado(padre(n)) ∧ … ∧ marcado(raíz)`, con
   `marcado(n) = (rol ∪ conceder) \ revocar` evaluado **por nodo** (la excepción puede estar en
   cualquier nivel; revocar gana).
3. **Expansión:** operación efectiva ⇔ existe una acción efectiva que la contiene, **o** su ítem legacy
   (`legado: true`) es efectivo, **o** es una operación aún concedible (área no migrada) y está marcada.
   Páginas: `pagina.<slug>` efectiva ⇔ nodo efectivo (desde #13429 exige su `menu.*`).
4. **Paso «todos»:** una acción A con `predecesores(A)` (por defecto, sus operaciones no-de-apoyo) se
   concede al rol/usuario que tenía **todos** los predecesores en su conjunto efectivo viejo.
5. **Admin sin literal:** no hay regla especial; admin tiene todos los predecesores y recibe todo por la
   regla 4. Nodos sin predecesor (`menu.*`, Perfil) heredan de un predecesor declarado (p. ej. `menu.x` ←
   cualquier ítem marcado dentro). El reporte en seco verifica «el rol con todo sigue con todo».

## Consecuencias

- `permisos_funciones` gana `padre_codigo` (FK a sí misma, `ON DELETE RESTRICT`), `nivel smallint`,
  `orden integer`; `tipo` admite `elemento` y `accion`. db-review-agent obligatorio en #12873 y #13429.
- Las operaciones absorbidas se borran de `permisos_funciones` y de las tablas de marcas en la misma
  migración de reparto; `catalogoCompleto()` deja de emitirlas.
- `usuariosConFuncion`, `filtrarPorFuncion` y el anti-bloqueo (ADR-0022) pasan a evaluar el **conjunto
  expandido**; el anti-bloqueo sigue definido en operaciones/páginas (`pagina.users`,
  `usuarios.usuario.editar`, `pagina.roles_permisos`, `permisos.cuadro.guardar`), lo que lo hace inmune
  a reagrupaciones del catálogo y cubre automáticamente «desmarcar Administración» (AC8 #13429).
- El transitorio `<item>.administrar` de ADR-0023 se retira en #13429: la guarda legacy queda en la
  página del ítem + operaciones expandidas.
- Revisión: si en el futuro el PO quiere permisos finos en legacy, se añaden `accion.*` bajo el ítem y
  se apaga `legado`; no hace falta otro modelo.
