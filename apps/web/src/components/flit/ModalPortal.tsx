// Saca un overlay del árbol de la página y lo cuelga de <body>.
//
// ── El fallo que esto arregla ────────────────────────────────────────────────
//
// El shell es `<div class="flex">` con dos hijos: la barra de navegación
// (`position: sticky; z-index: 20`) y `<main>`. Los modales se renderizaban dentro de `<main>`.
//
// `<main>` es, por tanto, un ITEM FLEX. La especificación de Flexbox (§ Painting Order) dice que
// los items se pintan «exactamente igual que un inline-block», es decir de forma ATÓMICA. Eso
// significa que nada de su interior puede pintarse por encima de un hermano flex con z-index
// positivo — ni siquiera un `position: fixed`, ni con el z-index que sea.
//
// Comprobado en el navegador: con el overlay a `z-index: 9999` la barra seguía tapándolo, y solo
// dejaba de taparlo al quitarle a la barra su z-index. El z-index del modal era irrelevante, que es
// justo la pista de que el problema no era de apilamiento sino de a qué árbol pertenece.
//
// El síntoma que se veía: en cuanto un modal crecía —el historial de estados desplegado, el visor
// de documentos a pantalla completa— su cabecera quedaba debajo de la barra y el botón de cerrar
// se volvía invisible e inalcanzable.
//
// ── Por qué un portal y no subir el z-index ─────────────────────────────────
//
// Porque subirlo NO funciona, como se acaba de ver. Y aunque funcionara, la alternativa sería dar
// z-index a `<main>`, lo que pondría TODO el contenido de la página por encima de la barra de
// navegación: los desplegables del menú quedarían tapados por las tablas. El portal deja el modal
// como hijo directo de `<body>`, en el contexto de apilamiento raíz, donde su z-index sí compite de
// tú a tú con la barra (z-20) y el topbar (z-30).
//
// No lleva contenedor propio ni `useEffect`: `document.body` ya existe cuando React monta, y crear
// un nodo por modal solo añadiría basura al DOM y un ciclo de montaje que puede parpadear.

import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

export default function ModalPortal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}
