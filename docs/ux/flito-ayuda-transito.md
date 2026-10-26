# UX slim — HU #13775 — grupo Tránsito y Tablero general (Feature #13692)

> Anexo de [`flito-ayuda.md`](flito-ayuda.md). Superficie: índice y ficha de Ayuda FLITO. Sin ruta, componente ni renderizador nuevo. Tono: **usted**.

**Delta de claridad.** Quien abre el índice busca la ficha de una pantalla que ya puede abrir. Esta HU añade dos fichas, y la densidad no cambia porque cada usuario ve solo las suyas.
- **Orden de grupos** (`GRUPOS_ORDEN`): General · Gestión · **Tránsito** · Finanzas · Administración. Tránsito va junto a Gestión porque también es operación, y antes de las áreas de soporte.
- **Grupo `transito`**, con la etiqueta «Tránsito». Tiene una sola ficha: «Organismos de tránsito» (`transito_organismos`, ruta `/transito/organismos`, permiso `transito_organismos`). Esa etiqueta es la de `PAGES`. Igual que los demás grupos, el grupo vacío no se pinta. Por URL directa, sin el permiso, se ve el `NoAccess` de esa pantalla.
- **Anterior/Siguiente** sigue el orden del índice. La última ficha visible de Gestión lleva a «Tránsito · Organismos de tránsito», y esa ficha lleva a la primera visible de Finanzas. Las fichas que el usuario no ve se saltan.
- Esto revoca la línea «Fuera de alcance … (PESV, LAFT, RNDC, Tránsito)» de #11893, **solo para Tránsito**.

**Etiqueta de la ficha `dashboard`: «Tablero de control», no «Tablero general».** El menú muestra para `/` el nombre «Tablero de control» (`PAGES.dashboard`, sin etiqueta propia en `NAV_ENTRADAS`), y ese es el nombre que el usuario reconoce. «Tablero general» solo aparece en el título de la HU. Dentro de General el orden es: «Tablero» (`flito_tablero`, conserva su posición) y luego «Tablero de control». Quien tiene los dos permisos ve las dos fichas, y los nombres las distinguen.

**AC2, inicio con Tablero FLITO: un aviso `> [!NOTA]` al final de «Cómo se entra».**
- Ese es el sitio donde la persona pregunta «¿por qué no veo esto al entrar?».
- El aviso destaca la excepción sin mezclarla con los pasos del Panel operativo, y no exige ninguna UI nueva (HU #13706).
- Se descarta un párrafo suelto porque se pierde entre el texto. También se descarta «Aplica para»: se calcula automáticamente (P9-2c), no se escribe a mano, y habla de roles, no del destino de entrada.
- Copy:
  > [!NOTA]
  > Si su usuario también tiene el Tablero FLITO, al entrar a FLITO verá ese tablero en lugar del Panel operativo. Para saber cómo se usa, consulte la ficha [Tablero](/flito/ayuda/flito_tablero).
- El enlace sigue la regla de enlaces internos: solo se pinta con `hasPage('flito_tablero')`. Esa es exactamente la condición del aviso, y sin ese permiso queda texto plano que sigue leyéndose bien.
- **Ir a la pantalla** (`/`) no cambia. Con `flito_tablero` lleva al Tablero FLITO, y el aviso ya lo explica. Por eso no se condiciona el botón.

**Estados.** Sin estados nuevos: el índice y la ficha mantienen sus 4 (cargando, error con **Reintentar**, vacío con **Volver al inicio**, lleno). La búsqueda muestra «Tránsito» como etiqueta de grupo, igual que los demás grupos. **Responsive:** sin cambios: el grupo nuevo se apila como los demás. **Feedback:** filas y Anterior/Siguiente reutilizan el hover y el `flit-focus` existentes. **Notificación:** ninguna. **Primaria:** sin cambio. **Ir a la pantalla** sigue como única acción de la ficha.

**Permiso/slug.** Se usan `transito_organismos` y `dashboard`, que ya existen. Ninguno es nuevo. El gate de Ayuda es derivado: si el rol `transito` tiene `transito_organismos` por defecto, **pasa a ver** el menú Ayuda FLITO. Eso es AC1 y obliga a corregir la fila de la matriz de roles de #11893.

**Notas para QA**
1. `admin`: el índice muestra los grupos en el orden General, Gestión, Tránsito, Finanzas, Administración (`flito-ayuda-indice.spec.ts`).
2. Sin `transito_organismos`: no aparece el h2 «Tránsito». `/flito/ayuda/transito_organismos` devuelve el `NoAccess` de «Organismos de tránsito».
3. Desde la última ficha de Gestión, Siguiente lleva a «Tránsito · Organismos de tránsito», y desde ahí a la primera de Finanzas. Anterior funciona al revés (`flito-ayuda-navegacion.spec.ts`).
4. `dr-flit-modulos.spec.ts`: actualizar el orden esperado de los grupos, con `transito` entre `gestion` y `finanzas`.
5. Ficha «Tablero de control»: el título y la fila del índice dicen «Tablero de control». El aviso «Nota» está en «Cómo se entra».
6. Usuario con `flito_tablero`: el aviso enlaza a la ficha «Tablero». Usuario sin ese permiso: texto sin enlace.
7. Rol `transito` por defecto: comprobar si ahora ve el menú Ayuda (depende de `ROLE_DEFAULT_PAGES`).
