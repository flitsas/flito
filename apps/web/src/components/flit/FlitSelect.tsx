// Kit FLIT — el selector etiquetado que al kit le faltaba (HU #11561, AC7).
//
// El kit tenía input (`flitInp` + `FlitField`), pills, tabla, tarjeta y modal, pero **ningún
// selector**: `FlitOrganismoCombobox` es un buscador con lista desplegable atado a un dominio,
// `ThFiltroMulti` es un menú de casillas dentro de un `<th>` y `FiltrosInteligentes` es una barra de
// chips. Los `<select>` sueltos que hay por el producto —incluido el de causal de
// `FormularioGestion`— repiten a mano la etiqueta, el `flitInp` y nada más; ninguno sabe decir por
// qué está vacío.
//
// Esto es lo que este componente añade sobre un `<select>` con clase:
//
//   · **Etiqueta asociada de verdad**, con `htmlFor`/`id` propios (`useId`). El resto del kit usa
//     `FlitField`, que asocia envolviendo; aquí hace falta el `id` de todas formas para colgar el
//     `aria-describedby` del mensaje, y con `id` la asociación explícita es la que no se rompe si
//     alguien mueve el control fuera del `<label>`.
//   · **Un estado inhabilitado que EXPLICA**. Un selector gris y vacío no dice si el catálogo está
//     cargando, si falló o si de verdad no hay nada; los tres se ven igual y solo uno tiene arreglo.
//     El mensaje va enlazado con `aria-describedby`, no solo puesto al lado.
//   · **La región del mensaje se monta SIEMPRE**, aunque esté vacía, y solo cambia su contenido.
//     Una `role="status"` que aparece ya rellena no dispara anuncio en varios lectores de pantalla:
//     lo que se anuncia es un CAMBIO de contenido dentro de una región que ya estaba en el árbol.
//     Montándola con el texto dentro, el AC se cumpliría en el DOM y no en el oído.
//   · **La salida del callejón es el botón de reintento, y es deliberada.** Un `<select disabled>`
//     no recibe foco, así que quien navega con teclado o con lector NO LLEGA al control y su
//     `aria-describedby` es inalcanzable por ese camino: lo que lo salva es que el mensaje se anuncia
//     por la región viva y que junto a él hay un botón que sí es enfocable. Queda escrito porque hoy
//     funcionaría igual por accidente, y un accidente se pierde en el siguiente refactor: **todo
//     selector que pueda quedar inhabilitado tiene que traer `onReintentar`**.
//   · **Foco visible y contraste**, con lo aprendido en el Bug #11604: `.flit-focus` sin prefijo de
//     scope (llega también a lo que cuelga de `<body>` por `ModalPortal`) y colores de TINTA
//     —`--flit-danger-ink`, `--flit-text-secondary`— y no de superficie, que es lo que no llegaba al
//     4,5:1 al usarlos como color de letra.
//
// Lo que deliberadamente NO hace: buscar dentro de las opciones, permitir selección múltiple ni
// abrir un panel propio. Para eso ya está `FlitOrganismoCombobox`; un `<select>` nativo se lleva
// gratis el teclado, el lector de pantalla y el desplegable del sistema operativo en móvil.

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { flitInp } from './flitPageKit';

export interface FlitSelectOpcion {
  valor: string;
  etiqueta: string;
  /**
   * Matiz sobre la opción —«inactivo», «fuera del catálogo»— que se pinta entre paréntesis.
   *
   * Va en el TEXTO y no en un color por dos motivos: un `<option>` no se puede estilar de forma
   * fiable entre navegadores, y aunque se pudiera, el color no puede cargar solo con la información.
   */
  nota?: string;
}

interface Props {
  label: string;
  value: string;
  opciones: FlitSelectOpcion[];
  onChange: (valor: string) => void;
  /** Texto de ayuda bajo el control. Se enlaza con `aria-describedby`. */
  ayuda?: ReactNode;
  /**
   * Qué ha pasado con las opciones: sustituye a la ayuda y se anuncia.
   *
   * Va con `role="status"` y no con `role="alert"`: que un catálogo de etiquetas no cargue no
   * interrumpe lo que el usuario esté haciendo —la tabla se pinta igual— y `assertive` le cortaría
   * la lectura por algo que no le impide seguir.
   */
  mensaje?: string | null;
  /** `true` pinta el mensaje en tinta de error. */
  fallo?: boolean;
  disabled?: boolean;
  /** Si viene, se pinta un botón de reintento junto al mensaje. Es el AC2 de la HU #11561. */
  onReintentar?: () => void;
  /**
   * Rótulo del botón de reintento. **Tiene que nombrar QUÉ se vuelve a cargar.**
   *
   * No es cosmético: en una pantalla con una banda de error propia ya hay un botón «Reintentar», y
   * dos controles con el mismo nombre accesible dejan a quien navega con lector eligiendo a ciegas
   * entre «reintentar la consulta» y «reintentar este catálogo», que son cosas distintas. Por
   * defecto se compone con la etiqueta del selector.
   */
  textoReintento?: string;
  /**
   * Aditivo (HU #11913). Baja tal cual al `<select>`: validación NATIVA, no simulada.
   *
   * Es la diferencia con `FlitOrganismoCombobox`, cuyo `required` es un `<input>` de 0×0 con
   * `opacity-0` y `tabIndex={-1}` — un control que ni se enfoca de forma fiable ni se puede
   * afirmar en un test. Los 5 usos anteriores del kit no lo pasan y quedan idénticos.
   */
  required?: boolean;
  /**
   * Aditivo (HU #11913). El mensaje de VALIDACIÓN — distinto de `mensaje`, que explica el estado
   * del catálogo.
   *
   * Cuando viene: se pinta en un `<p role="alert">` (interrumpe, porque impide continuar, mientras
   * que un catálogo que no carga no lo hace), el `<select>` recibe `aria-invalid="true"` y su
   * `aria-describedby` suma el id del error, y **el foco se mueve al control**. Al control y no al
   * mensaje: es donde se corrige el problema, y enfocarlo hace que el lector anuncie etiqueta,
   * estado inválido y descripción de una vez.
   */
  error?: string | null;
  /**
   * Aditivo (HU #11913). Se llama cuando la validación NATIVA rechaza el control.
   *
   * Hace falta porque con `required` el navegador bloquea el envío ANTES de que corra el
   * `onSubmit` del formulario: sin este puente, el mensaje en español de `error` no llegaría a
   * pintarse nunca y lo único que se vería sería el globo del navegador, que ni está en el idioma
   * del producto ni se puede afirmar en un test. Se suprime ese globo (`preventDefault`) y se deja
   * que el consumidor ponga su propio texto.
   */
  onInvalido?: () => void;
}

/**
 * Mismo `flitInp` que los `<input>` del kit, más el estado inhabilitado.
 *
 * **La flecha del desplegable se deja la del navegador** (nada de `appearance-none`): quitarla exige
 * dibujar una, y una flecha dibujada es un icono decorativo más que mantener en dos temas. La nativa
 * ya cumple contraste y es la que el usuario reconoce como «esto se despliega».
 */
const CLASE_SELECT = `${flitInp} disabled:cursor-not-allowed `
  + 'disabled:bg-[color:var(--flit-bg-table-header)] disabled:text-[color:var(--flit-text-secondary)]';

export default function FlitSelect({
  label, value, opciones, onChange, ayuda, mensaje, fallo, disabled, onReintentar, textoReintento,
  required, error, onInvalido,
}: Props) {
  const id = useId();
  const idMensaje = `${id}-mensaje`;
  const idError = `${id}-error`;
  const refSelect = useRef<HTMLSelectElement>(null);

  // El foco va al control en cuanto aparece el error de validación. Depende del TEXTO y no de un
  // booleano para que un mensaje distinto vuelva a llevar el foco; repetir el mismo no lo roba dos
  // veces (y en el camino nativo el navegador ya lo había puesto ahí).
  useEffect(() => { if (error) refSelect.current?.focus(); }, [error]);

  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1 block text-[11px] font-semibold"
        style={{ color: 'var(--flit-text-primary)' }}
      >
        {label}
      </label>
      <select
        id={id}
        ref={refSelect}
        className={CLASE_SELECT}
        value={value}
        disabled={disabled}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${idMensaje} ${idError}` : idMensaje}
        onInvalid={(e) => { if (onInvalido) { e.preventDefault(); onInvalido(); } }}
        onChange={(e) => onChange(e.target.value)}
      >
        {opciones.map((o) => (
          <option key={o.valor} value={o.valor}>
            {o.nota ? `${o.etiqueta} (${o.nota})` : o.etiqueta}
          </option>
        ))}
      </select>
      {/* El contenedor y la región viva se montan siempre; lo único que cambia es el texto. El
          botón queda FUERA de la región a propósito: un control dentro de una `role="status"` se
          reanuncia entero con cada cambio del mensaje. */}
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
        <span
          id={idMensaje}
          role="status"
          style={{ color: mensaje && fallo ? 'var(--flit-danger-ink)' : 'var(--flit-text-secondary)' }}
        >
          {mensaje ?? ayuda}
        </span>
        {mensaje && onReintentar && (
          <button
            type="button"
            onClick={onReintentar}
            className="flit-focus rounded-[999px] border bg-flit-card px-2 py-0.5 text-xs font-medium"
            style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}
          >
            {textoReintento ?? `Volver a cargar ${label.toLowerCase()}`}
          </button>
        )}
      </div>
      {error && (
        <p id={idError} role="alert" className="mt-1 text-xs" style={{ color: 'var(--flit-danger-ink)' }}>
          {error}
        </p>
      )}
    </div>
  );
}
