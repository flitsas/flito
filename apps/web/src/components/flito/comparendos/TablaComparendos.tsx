// FLITO — Comparendos: la tabla del visor (HU #11560, AC1 y AC7; columnas «Tipo» y «Estado en
// la fuente» en la HU #11713).
//
// El reparto de columnas sale de la spec de UX y su criterio es uno solo: **arriba va lo que sirve
// para reconocer la fila; lo que se lee cuando ya se abrió una fila vive en el detalle** (HU del
// panel). El nivel B se oculta por debajo de 1280 px con las utilidades que el repo ya usa
// (`hidden xl:table-cell`), no con un selector de columnas configurable: eso sería un patrón nuevo,
// con estado por usuario, que ninguna otra pantalla de FLITO tiene.
//
// Dos cosas que la tabla NO hace, y las dos son deliberadas:
//   · **No suma.** `monto` es una cadena decimal (`numeric(14,2)`); sumar cincuenta en `double` es
//     exactamente cómo un importe pierde el último centavo, y el total de una página arbitraria no
//     responde ninguna pregunta. Quien necesite sumar, exporta (HU #11558).
//   · **No atenúa la fila inactiva.** Bajar la opacidad de una fila entera es cómo se pierden los
//     4.5:1 de golpe, y «inactivo» NO significa pagado ni resuelto: solo que las fuentes dejaron de
//     reportarlo. Eso lo dice el chip, con su etiqueta dentro, no el color de la fila.
//
// Y una tercera desde la HU #11713: **no hay selector de columnas ni preferencia persistida**. El
// reparto sigue siendo A/B por breakpoint, con las utilidades del repo. Un menú de columnas sería un
// patrón nuevo, con estado por usuario, que ninguna otra pantalla de FLITO tiene.
//
// ── HU #11795 · dos celdas rotuladas, CERO columnas nuevas ───────────────────────────────────────
// La tabla gana dos datos y no gana ninguna columna: «Fecha» pasa a «Fechas» con las dos fechas
// rotuladas en la misma celda, y la celda del lugar pasa a mostrar el organismo en las filas cuyo
// municipio faltaba. **Sigue en 14 columnas con «Inactivado» puesto y 10 por debajo de 1280 px.**
// (El segundo número lo cambia la #11900 — ver abajo. El primero no: subir una columna de B a A no
// añade ninguna, solo la mueve de bloque.)
//
// ── HU #11879 · la columna vuelve a llamarse «Municipio», y NINGUNA celda rotula ─────────────────
// La #11795 dejó una cabecera que anunciaba una DISYUNCIÓN —«Municipio u organismo»— y una celda que
// rotulaba cuál de las dos ramas traía. Era la única salida honesta mientras el dato de la tabla
// fuera `municipioFuente` —el municipio al que se PREGUNTÓ, `null` en toda fila que solo vio el
// SIMIT—, porque entonces la celda mostraba de verdad dos cosas distintas según la fila. La HU
// #11878 acabó con esa premisa: el contrato trae `municipioComparendo`, el municipio de donde ES el
// comparendo, que el SERVIDOR deriva (municipio que respondió; si no, el único `codigoFuente` del
// catálogo que aparece en el texto del organismo) y audita. Con una sola rama, el rótulo por celda
// sobra y una cabecera que dice «u» miente por exceso de cautela.
//
// Lo que NO se cae con esto: el organismo se sigue pintando TAL CUAL cuando el municipio no se pudo
// determinar, NUNCA los dos a la vez, «Organismo» no vuelve como columna (sería la quince, #11713),
// el front sigue sin deducir nada —el catálogo traduce un código, no adivina un municipio— y el
// ancho de la celda no se toca: el peor caso sigue siendo un organismo de `varchar(120)`. Lo que sí
// baja es el ALTO de la fila, una línea, y por eso el esqueleto pasa de dos barras a una en esa
// celda. Todo esto está escrito en `docs/ux/flito-comparendos-municipio.md`.
//
// ── HU #11900 · «Estado en la fuente» sube a nivel A ─────────────────────────────────────────────
// Una sola columna cambia de bloque: la que el PO llamó relevante para decidir si se abre una fila.
// **11 columnas por debajo de 1280 px** (antes 10) y **14 con «Inactivado» a ≥1280 px** (igual: no
// se añade ninguna columna, se mueve una de bloque). El esqueleto sigue el cambio SOLO porque
// deriva de estas mismas constantes — que es exactamente para lo que la #11713 las unificó.
//
// Lo que esta HU NO hace, y conviene leerlo antes de «completar» el cambio: las otras tres B siguen
// en B, «Organismo» sigue sin ser columna, no hay selector de columnas, no hay cards bajo 1280 y no
// hay preferencia persistida. El coste declarado es +14 rem de desplazamiento horizontal bajo 1280;
// se acepta a cambio de que la affordance de desborde de `FlitTable` (misma HU) anuncie que hay más
// a la derecha. Está escrito en `docs/ux/shell-tema-y-responsive.md` §4.

import type { ReactNode } from 'react';
import type { ComparendoRegistro } from '@operaciones/shared-types';
import { FlitTable, FlitTh, FlitTr } from '../../flit/flitPageKit';
import StatusChip from '../../flit/StatusChip';
// `fechaColombia` es la que hasta la HU #11562 se llamaba `fechaHoraColombia` y NO pinta hora: la
// tabla no la necesita —catorce columnas y una corrida diaria— y cambiarla habría movido tres
// columnas. La que sí lleva hora vive en `formato.ts` con ese nombre y la usa el panel de detalle.
import {
  SIN_DATO, etiquetaOrigen, etiquetaTipoRegistro, fechaColombia, fechaCorta, pesos,
} from './formato';
import type { CatalogosComparendos } from './useComparendosLista';



// `align-top` (HU #11777): desde que «Estado en la fuente» se muestra ENTERO, una celda puede medir
// varias líneas —cuatro con un estado real de 80 caracteres, medido—, y con el
// `vertical-align: middle` que la tabla traía por defecto el número del
// comparendo quedaba flotando a media altura. Va aquí y en los dos `<td>` que no usan `CELDA`
// —«Monitoreo» y «Gestión»—, para que una fila alta se lea como un bloque y no como columnas
// sueltas a distintas alturas. El ESQUELETO no lo lleva: todas sus celdas miden lo mismo y no
// cambiaría un píxel.
const CELDA = 'px-4 py-2.5 text-sm align-top';

function Celda({ children, clase = '' }: { children?: ReactNode; clase?: string }) {
  return (
    <td className={`${CELDA} ${clase}`} style={{ color: 'var(--flit-text-primary)' }}>{children}</td>
  );
}

/** Celda de nivel B: el mismo contenido, oculto por debajo de 1280 px. */
function CeldaB({ children, clase = '' }: { children?: ReactNode; clase?: string }) {
  return (
    <td className={`hidden xl:table-cell ${CELDA} ${clase}`} style={{ color: 'var(--flit-text-primary)' }}>
      {children}
    </td>
  );
}

/** Encabezado de nivel B. `FlitTh` ya pone `scope="col"`; aquí solo se le añade el colapso. */
function ThB({ children }: { children: ReactNode }) {
  return <FlitTh className="hidden xl:table-cell">{children}</FlitTh>;
}

/**
 * Los rótulos, en UN solo sitio, porque los pintan DOS componentes: la tabla llena y el esqueleto.
 *
 * Estaban duplicados hasta la HU #11713 y el resultado era el defecto que el esqueleto existía para
 * evitar: el esqueleto pintaba nueve cabeceras en duro y ni una `ThB`, así que a ≥1280 px el
 * encabezado SALTABA de nueve a trece columnas en cuanto llegaban los datos. Con una sola fuente,
 * añadir o quitar una columna ya no puede desincronizar los dos encabezados ni el número de celdas
 * fantasma de cada fila.
 */
/**
 * «Fechas», en PLURAL, desde la HU #11795. La columna agrupa las DOS fechas del comparendo —la del
 * hecho y la de su notificación— en una sola celda, cada una en su línea y con su nombre delante.
 *
 * **Ninguna columna puede llamarse solo «Fecha».** Es el criterio literal que la HU #11713 aplicó a
 * «Estado» → «Monitoreo»: con dos fechas en la misma celda, «Fecha» deja de identificar el dato, y
 * un lector de pantalla en modo tabla anunciaría «Fecha… 12 jul 2026» dos veces seguidas para dos
 * hechos distintos.
 *
 * Y NO es una columna nueva, a propósito: la #11713 tuvo que retirar «Organismo» para meter «Tipo» y
 * «Estado en la fuente», y una columna número quince reabriría esa decisión a los tres días. Las dos
 * fechas caben juntas porque responden la MISMA pregunta —«¿cuándo?»— sobre el mismo hecho, y
 * ninguna se lee sin la otra.
 */
const TH_FECHAS = 'Fechas';

/**
 * «Municipio», a secas, desde la HU #11879. Un SUSTANTIVO, no una disyunción.
 *
 * Se llamó «Municipio u organismo» durante la #11795, mientras la celda mostraba dos datos distintos
 * según la fila. Ya no: la celda pinta `municipioComparendo` —uno solo— y el organismo es su
 * respaldo cuando ese municipio no se pudo determinar, no una segunda categoría.
 *
 * La cabecera corta es además, por sí sola, una mejora de ESCUCHA: un lector en modo tabla anuncia
 * la cabecera cada vez que se cambia de celda, y con 50 filas «Municipio u organismo… Medellín» son
 * cinco palabras repetidas cincuenta veces para un dato de una.
 *
 * Y la discusión «u» contra «/» de la #11795 se cierra sola, que conviene dejarlo escrito porque
 * alguien va a querer «restaurarla»: sin disyunción no hay separador que pronunciar.
 */
const TH_MUNICIPIO = 'Municipio';

const COLUMNAS_A = [
  'N.º comparendo',
  // Segunda, pegada al número, porque es parte de la IDENTIDAD de la fila: dice qué es. Es el mismo
  // sitio que ocupa en el archivo de export (HU #11712).
  'Tipo',
  'Placa',
  'NIT monitoreado',
  TH_FECHAS,
  'Infracción',
  TH_MUNICIPIO,
  'Monto',
  // Se llamaba «Estado» hasta la HU #11713. NO es el estado del proveedor: es el de MONITOREO. Con
  // «Estado en la fuente» ya en la misma tabla, dos cabeceras que empiezan por la misma palabra se
  // oyen casi iguales —en modo tabla un lector anuncia la cabecera al cambiar de celda: «Estado…
  // Activo» y «Estado en la fuente… Se adeuda»—. «Monitoreo» se distingue desde la primera sílaba,
  // y es la palabra que `docs/dominio.md` ya usa para esto.
  'Monitoreo',
  'Gestión',
  // Nivel A desde la HU #11900; hasta entonces era la PRIMERA de `COLUMNAS_B`. El PO la llamó
  // relevante para decidir si se abre una fila, y bajo 1280 px el `hidden xl:table-cell` la
  // borraba del árbol: quien trabaja en un portátil de 1366 no la tenía, y sin selector de
  // columnas ni aviso, tampoco sabía que existía.
  //
  // Va la ÚLTIMA de A —y no pegada a «Monitoreo», que es donde el contraste entre las dos se
  // vería mejor— por el mismo argumento con el que la #11713 la dejó en B: mide 14 rem, y pegarla
  // empujaría esa distancia a la derecha DOS columnas de nivel A dentro de un `overflow-x-auto`
  // que a 1280 px ya desplaza. Al final de A no le cuesta un píxel a ninguna de las que ya
  // estaban, y queda en el mismo sitio donde el ojo la buscaba hasta ayer: justo antes de Origen.
  //
  // Es la ÚNICA B que sube: la spec del 26 ago 2026 relaja «no empujar A a la derecha» solo para
  // esta columna. Origen, Registrado e Inactivado siguen en B y «Organismo» no vuelve.
  'Estado en la fuente',
] as const;

/**
 * Nivel B: se colapsa por debajo de 1280 px. «Organismo» SALIÓ de la tabla en la HU #11713 —quince
 * columnas eran demasiadas y el dato está entero en el panel de detalle— y no vuelve.
 *
 * «Estado en la fuente» estuvo aquí desde la #11713 y salió a nivel A en la #11900 (arriba está el
 * porqué). Lo que queda es lo que se lee UNA VEZ ABIERTA la fila y no sirve para reconocerla:
 * `origen` dice qué fuente la trajo, `primeraVistoEn` cuándo se vio por primera vez e
 * `inactivadoEn` cuándo dejó de reportarse. Los tres siguen enteros en el panel de detalle, que es
 * lo que justifica esconderlos y no, por ejemplo, recortarlos.
 */
const COLUMNAS_B = ['Origen', 'Registrado'] as const;

/** Condicional: solo con el filtro «Inactivos» puesto. Cierra el bloque B. */
const COLUMNA_B_INACTIVADO = 'Inactivado';

/**
 * Las columnas de nivel A cuya celda mide DOS líneas (HU #11795), derivadas de las mismas constantes
 * que las cabeceras para que renombrarlas no pueda desincronizar el esqueleto.
 *
 * En las ocho filas fantasma llevan **dos barras apiladas**, no una: con una sola barra la fila
 * CRECERÍA de alto al llegar los datos, que es exactamente el defecto que el esqueleto existe para
 * evitar y el que la #11713 corrigió en las cabeceras.
 *
 * **«Municipio» SALIÓ de este `Set` en la HU #11879**, y no es una limpieza cosmética: al quitarle
 * el rótulo, su celda pasó a medir UNA línea. Dejarla aquí ponía el defecto con el signo cambiado
 * —la fila fantasma más alta que la fila con datos, o sea la tabla ENCOGIENDO al cargar—, que es
 * justo lo que el esqueleto existe para evitar. El `Set` se queda con una sola columna a propósito:
 * sigue siendo la lista, no una condición escrita a mano en el JSX del esqueleto.
 */
const COLUMNAS_A_DE_DOS_LINEAS: ReadonlySet<string> = new Set([TH_FECHAS]);

/** El «—» de una ausencia, con su `sr-only`: un guion solo se lee como un guion, o no se lee. */
function SinDato() {
  return <>{SIN_DATO}<span className="sr-only">Sin dato</span></>;
}

/**
 * Una línea de la celda «Fechas»: el rótulo y su valor, en la misma línea y **el rótulo delante**.
 *
 * Las dos etiquetas son **texto real en el DOM**: ni `title` —invisible al teclado y en táctil, ya
 * descartado para la infracción— ni `sr-only`, porque quien VE la pantalla tiene exactamente el
 * mismo problema de ambigüedad que quien la escucha.
 *
 * Y la línea se pinta SIEMPRE, también cuando el valor falta (estados 2 y 3 de la spec): ocultarla
 * dejaría filas de distinto alto en la misma tabla —se leería como un fallo de pintado, no como una
 * ausencia— y le quitaría al ojo la posición fija con la que compara una fila con la de al lado.
 * Nunca una línea sin etiqueta: si falta el valor falta el valor, no el rótulo.
 *
 * Devuelve dos `<span>` sueltos —no un contenedor— para que caigan como celdas del `grid` de la
 * celda: así los valores de las dos líneas alinean su margen izquierdo sin anchos escritos a mano.
 */
function LineaFecha({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <>
      <span className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{rotulo}</span>
      <span>{valor === SIN_DATO ? <SinDato /> : valor}</span>
    </>
  );
}

function CabecerasComparendos({ mostrarInactivado }: { mostrarInactivado: boolean }) {
  return (
    <FlitTr>
      {COLUMNAS_A.map((c) => <FlitTh key={c}>{c}</FlitTh>)}
      {COLUMNAS_B.map((c) => <ThB key={c}>{c}</ThB>)}
      {mostrarInactivado && <ThB>{COLUMNA_B_INACTIVADO}</ThB>}
    </FlitTr>
  );
}

interface Props {
  items: ComparendoRegistro[];
  catalogos: CatalogosComparendos;
  /**
   * Pinta la columna «Inactivado». Solo con el filtro «Inactivos» puesto: en la vista de activos es
   * una columna de guiones por definición (`inactivadoEn` es `null` mientras el registro está vivo).
   */
  mostrarInactivado: boolean;
  /** Abre el panel de detalle (HU #11562). Lo dispara el botón del número, y nada más de la fila. */
  onAbrir: (registro: ComparendoRegistro) => void;
}

export default function TablaComparendos({ items, catalogos, mostrarInactivado, onAbrir }: Props) {
  return (
    <FlitTable label="Comparendos monitoreados">
      {/* Largo a propósito (HU #11713, AC5). El `caption` es el ÚNICO texto que un lector de
          pantalla anuncia con seguridad al entrar en la tabla, así que es el único sitio donde
          caben las tres advertencias que la tabla necesita y que ninguna cabecera de once
          caracteres puede dar: que «Monitoreo» no habla de pagos, que «Estado en la fuente» no
          está normalizado —y puede venir vacío—, y qué separa un comparendo de una multa. */}
      <caption className="sr-only">
        Comparendos monitoreados. «Monitoreo» dice si las fuentes siguen reportándolo —«inactivo» no
        significa pagado—. «Estado en la fuente» es lo que dice el proveedor, sin normalizar, y puede
        venir vacío. «Tipo» distingue el comparendo de la multa, que es su etapa siguiente.
        {/* HU #11879. La cabecera es UNA palabra y no puede advertir del residuo —las filas cuyo
            municipio no se pudo determinar, donde la celda enseña el organismo sin decirlo—; el
            `caption` sí, y es el único texto que un lector anuncia con seguridad al entrar en la
            tabla. Aquí es donde se compensa que la celda NO lleve rótulo: la respuesta sirve igual a
            quien mira y a quien escucha, que es lo que un `sr-only` por celda no haría.

            Decía, hasta la #11795, que la columna «dice a qué municipio se consultó». Era cierto
            entonces y es FALSO desde la #11878: lo que se pinta es el municipio del comparendo, lo
            haya reportado SIMIT o el municipio. */}
        {' '}«Municipio» es el municipio donde se impuso el comparendo. Cuando no se pudo determinar,
        la celda muestra el organismo de tránsito que lo impuso.
      </caption>
      <thead>
        <CabecerasComparendos mostrarInactivado={mostrarInactivado} />
      </thead>
      <tbody>
        {items.map((c) => {
          const alias = catalogos.alias[c.nitMonitoreado];
          const causal = c.causalId ? catalogos.causales[c.causalId] : null;
          /**
           * El municipio del COMPARENDO (HU #11879), no el municipio al que se preguntó.
           *
           * `municipioComparendo` es un `codigoFuente` igual que `municipioFuente`, así que el
           * catálogo sirve sin tocarlo: es la misma búsqueda con OTRA clave. Si el catálogo no
           * cargó, se pinta el código crudo —«ITAGUI» sigue siendo cierto— y la tabla se pinta igual.
           */
          const municipio = c.municipioComparendo
            ? catalogos.municipios[c.municipioComparendo] ?? c.municipioComparendo
            : null;
          /**
           * La regla de contenido de «Municipio», en una línea (HU #11879): `municipioComparendo`
           * traducido por el catálogo si lo hay; **si y solo si** es `null`, el `organismo` TAL
           * CUAL; si tampoco hay organismo, «—».
           *
           * **Nunca los dos a la vez**: pintar «Medellín · STRIA DE TTOyTTE MEDELLIN» sería reponer
           * la columna «Organismo» dentro de otra celda, con la misma anchura y ninguna de las dos
           * decisiones de la #11713 respetada.
           *
           * Y aquí no se deduce NADA, que es la prohibición del requerimiento 4 de la spec y sigue
           * entera: no se busca «Medellin» en el catálogo de municipios, no se normaliza a
           * `codigoFuente` «a ver si coincide» y no se escribe nada. La deducción la hace el sync,
           * la persiste y la audita (HU #11878); el SPA pinta lo que le llegó.
           *
           * `||` y no `??` en el respaldo, a propósito: `estadoFuente` demostró que el proveedor
           * manda cadenas VACÍAS, y una celda vacía no se lee como una ausencia —se lee como un
           * fallo de pintado, y un lector no anuncia nada—. La cadena vacía cae al «—» con su
           * `sr-only`, igual que el `null`.
           */
          const lugar: string | null = municipio ?? (c.organismo || null);
          const infraccion = [c.codigoInfraccion, c.descripcionInfraccion].filter(Boolean).join(' · ');
          return (
            <FlitTr key={c.id}>
              {/* La ÚNICA parada de tabulador de la fila (HU #11562, AC1 y AC8). Es un `<button>` y
                  no un `<div onClick>`: se alcanza con teclado, se anuncia como acción y lleva su
                  propio nombre accesible, porque el texto visible —un número de catorce cifras— no
                  dice qué pasa al pulsarlo. Y es UNO por fila y no uno por celda: con 50 filas ×
                  14 columnas, celdas enfocables serían 700 paradas hasta la paginación. Las dos
                  celdas que añade la HU #11713 son `<td>` MUDOS, sin `tabIndex` ni control dentro:
                  esa proporción de una parada por fila no la toca esta HU. */}
              <Celda clase="whitespace-nowrap font-medium">
                <button
                  type="button"
                  onClick={() => onAbrir(c)}
                  aria-label={`Ver el comparendo ${c.numeroComparendo}`}
                  className="flit-focus rounded font-medium underline-offset-2 hover:underline"
                  style={{ color: 'var(--flit-blue-text)' }}
                >
                  {c.numeroComparendo}
                </button>
              </Celda>
              {/* TEXTO PLANO, no un chip, y esto NO es una omisión (HU #11713). Ningún `ChipTone`
                  del kit dice la verdad aquí: `warning`/`danger` editorializarían una etapa normal
                  del cobro, `success` sería perverso, `active` ya lo lleva «Monitoreo» en esta misma
                  fila y `draft`/`neutral` son los grises que en esta tabla significan «Inactivo» y
                  «Sin gestión» —o sea «no hay nada», que es lo contrario de una multa—. `origenMerge`,
                  que es el mismo tipo de dato, ya se pinta así. Y los dos valores van con el MISMO
                  peso tipográfico: una «Multa» en negrita sería color por otros medios. */}
              <Celda clase="whitespace-nowrap">{etiquetaTipoRegistro(c.tipoRegistro)}</Celda>
              <Celda clase="whitespace-nowrap">{c.placa ?? SIN_DATO}</Celda>
              <Celda clase="whitespace-nowrap">
                {c.nitMonitoreado}
                {alias && (
                  <span className="block text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{alias}</span>
                )}
              </Celda>
              {/* Las DOS fechas del comparendo en UNA celda (HU #11795). El `grid` de dos columnas
                  es lo que alinea los valores entre las dos líneas sin escribir ningún ancho a mano;
                  `items-baseline` asienta el rótulo pequeño sobre la misma línea base que su valor.

                  **`fechaNotificacion` se pinta TAL CUAL llega y no se aproxima con nada.** El
                  centinela `01/01/1900` que SIMIT manda «para comparendos no notificados» lo
                  normaliza el mapa v4 (HU #11794) en un solo sitio; el visor NO lo vuelve a filtrar.
                  Una segunda normalización aquí taparía una regresión del backend y haría que nadie
                  se entere nunca: si algún día se ve «1 de ene de 1900» en pantalla, el defecto está
                  en el mapa y se arregla allí. */}
              <Celda clase="whitespace-nowrap">
                <span className="grid grid-cols-[auto_auto] items-baseline justify-start gap-x-2">
                  <LineaFecha rotulo="Comparendo" valor={fechaCorta(c.fechaComparendo)} />
                  <LineaFecha rotulo="Notificación" valor={fechaCorta(c.fechaNotificacion)} />
                </span>
              </Celda>
              <Celda clase="min-w-[15rem]">
                {/* Una línea con recorte. El texto completo NO se pone en un `title`: no lo ve el
                    teclado, no lo anuncia bien un lector y no existe en táctil. Vive en el detalle.
                    El recorte es además lo que mantiene el ALTO de la fila: sin él, una descripción
                    de 300 caracteres —las hay— convierte una fila en cuatro. */}
                <span className="line-clamp-1 max-w-[22rem]">{infraccion || SIN_DATO}</span>
              </Celda>
              {/* «Municipio» (HU #11879). Cuatro decisiones que no se ven en dos líneas de JSX:

                    · **NINGÚN rótulo dentro de la celda.** Ni «Municipio», ni «Organismo», ni un
                      `sr-only` equivalente en la rama de respaldo: eso último sería dar a quien
                      escucha una desambiguación que a quien mira se le niega, y la asimetría al
                      revés ya se rechazó en la #11795 con este mismo argumento. La respuesta va en
                      el `caption` y en el panel de detalle, que sirven a los dos por igual.
                    · **El valor va SIEMPRE en `--flit-text-primary`, venga de donde venga.** El
                      organismo NO se atenúa con `--flit-text-muted` para «marcar que es el
                      respaldo»: no llega a 4.5:1 —es el gris de los guiones— y sería reponer el
                      rótulo por medio del color, que además ningún lector anuncia. Ni cursiva, ni
                      tamaño distinto, ni icono.
                    · **Sin ninguno de los dos, un «—»** con su `sr-only`: un guion solo se lee como
                      un guion, o no se lee.
                    · **El organismo se pinta TAL CUAL.** «Medellin» sin tilde y «Bogota D.C.» se
                      pintan así: son lo que dijo la fuente y el operador puede tener que
                      citárselos. Ni `capitalize`, ni `uppercase`, ni tildes puestas por nosotros, ni
                      traducido por el catálogo de MUNICIPIOS —que traduce códigos, no adivina
                      nombres—. Es la misma regla que la #11713 y la #11777 fijaron para
                      `estadoFuente`. `municipioComparendo` SÍ se traduce, porque ahí la traducción
                      la hace NUESTRO catálogo, que es un dato y no una suposición.

                  Y **sin `title` ni `aria-label`**, que tampoco es un olvido: un `title` no lo
                  alcanza el teclado, no existe en táctil y los lectores lo anuncian de forma
                  desigual; un `aria-label` sobre un `<td>` no es fiable —no es un elemento
                  etiquetable— y sustituiría en la escucha el texto visible por otro. Y no hacen
                  falta: la celda envuelve y muestra los 120 caracteres ENTEROS, así que no hay texto
                  escondido que un tooltip tenga que revelar.

                  La celda **envuelve**, con el tratamiento que la #11777 dejó medido y que la #11879
                  NO recalcula, porque el peor caso no cambió: `municipioComparendo` es un código
                  corto, pero la rama de respaldo sigue admitiendo un `organismo` de `varchar(120)` y
                  «STRIA DE TTOyTTE MEDELLIN» no es el peor caso. `wrap-anywhere` y no `break-words`
                  (es el único que no infla la contribución de tamaño MÍNIMO en una tabla de layout
                  automático), `min-w` **y** `max-w` —el techo solo aprieta la columna contra su
                  mínimo, que con `wrap-anywhere` es un carácter— y un `line-clamp` de AIRBAG por
                  encima del peor caso MEDIDO en el navegador, no calculado: los 120 caracteres de la
                  letra más ancha ocupan `scrollHeight` 200 px en una caja de `clientWidth` 176 px
                  —11 rem clavados, o sea que el `min-w` está haciendo su trabajo— y a 20 px de línea
                  eso son 10 líneas exactas, con `scrollWidth` 176 = `clientWidth` (nada cortado en
                  horizontal). Con `line-clamp-[12]` quedan DOS líneas de margen sobre el peor caso y
                  dentro de `varchar(120)` el airbag NUNCA actúa; existe para que ampliar la columna
                  en la base no convierta una fila en veinte líneas sin que nadie se entere.

                  Y **la columna no se estrecha «porque ahora casi siempre cabe Medellín»** (#11879):
                  eso optimizaría el caso común rompiendo el caso que la celda existe para no
                  esconder. 11 rem es el ancho, y el ancho no cambia: esta HU no añade ni un píxel de
                  scroll horizontal a 1280 px. */}
              <Celda>
                {lugar === null ? <SinDato /> : (
                  <span className="line-clamp-[12] block min-w-[11rem] max-w-[11rem] wrap-anywhere">
                    {lugar}
                  </span>
                )}
              </Celda>
              {/* Cifras tabulares y a la derecha: sin eso, dos montos no alinean sus unidades y
                  compararlos exige leerlos enteros. */}
              <Celda clase="whitespace-nowrap text-right tabular-nums">{pesos(c.monto)}</Celda>
              <td className="px-4 py-2.5 align-top">
                <StatusChip tone={c.estado === 'activo' ? 'active' : 'draft'}>
                  {c.estado === 'activo' ? 'Activo' : 'Inactivo'}
                </StatusChip>
              </td>
              <td className="whitespace-nowrap px-4 py-2.5 align-top">
                {causal
                  ? <StatusChip tone="success">{causal}</StatusChip>
                  : <StatusChip tone="draft">Sin gestión</StatusChip>}
                {/* Cuándo y quién, cuando los hay: se pinta lo que el registro trae, no un hueco
                    reservado. Desde la HU #11562 `gestionActualizadaPor` llega resuelto —`{ id,
                    nombre }`— y aquí se escribe el NOMBRE: antes era el id suelto y esta línea decía
                    «· usuario 5», que no responde «quién hizo la última gestión». */}
                {c.gestionActualizadaEn && (
                  <span className="mt-0.5 block text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
                    {fechaColombia(c.gestionActualizadaEn)}
                    {c.gestionActualizadaPor !== null && ` · ${c.gestionActualizadaPor.nombre}`}
                  </span>
                )}
              </td>
              {/* «Organismo» ESTABA aquí hasta la HU #11713 y se retiró: con «Tipo» y «Estado en la
                  fuente» la tabla llegaba a quince columnas, y el organismo casi siempre se deduce
                  del municipio. El dato no se pierde — está entero en el panel de detalle.

                  Y **no vuelve con la #11795 ni con la #11879**, que es lo que hay que leer aquí
                  antes de reponerlo: sería la quince y reabriría la decisión del supervisor con el
                  mismo argumento que sigue siendo cierto. Lo que esas dos HUs hacen es publicar su
                  VALOR dentro de la celda «Municipio» —una celda que ya existía— y **solo en las
                  filas cuyo `municipioComparendo` es `null`**, o sea aquellas cuyo municipio ni la
                  consulta municipal ni el catálogo pudieron determinar. En las demás el organismo
                  sigue exactamente donde la #11713 lo dejó: el detalle y el export.

                  El estado del proveedor se pinta TAL CUAL: sin `capitalize`, sin `uppercase` y sin
                  recortar el texto. El operador puede tener que citárselo al organismo, y un
                  «se adeuda» que la pantalla convirtió en «Se Adeuda» ya no es lo que dijo la
                  fuente. Y **sin `title`**, igual que la infracción y por lo mismo: un `title` no lo
                  ve el teclado, no lo anuncia bien un lector y no existe en táctil.

                  REVOCADO por la HU #11777 — aquí decía «Una línea con `line-clamp-1` —eso mantiene
                  el alto de la fila—». Era flojo como argumento y dañino como resultado: el alto
                  uniforme ya lo rompían el alias del NIT y la segunda línea de «Gestión», así que el
                  recorte no compraba uniformidad; solo ESCONDÍA, sin anunciarlo de ninguna manera,
                  el dato que el operador tiene que citarle al organismo. Se muestra entero,
                  envolviendo (docs/ux/flito-comparendos-estado-fuente.md):

                    · `wrap-anywhere` (Tailwind v4.1) y NO `break-words`: además de partir la palabra
                      que no cabe, es el único que no infla la contribución de tamaño MÍNIMO de la
                      celda, y esta tabla es de layout automático. Sin él, un estado de 80 caracteres
                      sin un solo espacio —los hay— queda cortado EN HORIZONTAL por el
                      `overflow: hidden` del clamp: medido, 734 px de texto en una caja de 224. Es
                      el mismo defecto que esta HU cierra, reaparecido de lado y aún más callado.
                    · `min-w-[14rem]` **y** `max-w-[14rem]`, y hacen falta LOS DOS. El `max-w` solo
                      pone un techo, y en una tabla de layout automático que ya desborda el reparto
                      aprieta cada columna contra su MÍNIMO — que con `wrap-anywhere` es un
                      carácter. Medido con solo el techo: la columna se quedaba en 49 px de
                      contenido y los 80 caracteres seguían recortados, o sea el defecto intacto. El
                      `min-w` es lo que hace que «14 rem» sea un ancho y no un deseo; el `max-w` es
                      lo que impide que a 2400 px el sobrante se lo lleve entero esta columna
                      (medido sin él: 734 px). Entre los dos, +48 px de scroll horizontal a 1280 px:
                      coste aceptado y declarado en la decisión de UX, no un descuido.
                    · `line-clamp-6` es un AIRBAG, no un recorte. La decisión de UX escribió `-4`
                      sobre la cuenta de que 80 caracteres caben en 3 líneas a 14 rem; MEDIDO en el
                      navegador son 4 líneas para un estado real y 5 para el peor caso que el
                      contrato admite (80 caracteres de la letra más ancha), así que un `-4` habría
                      recortado un dato legal y el AC1 sería falso. Con 6 queda una línea de margen
                      sobre el peor caso medido: dentro de `varchar(80)`
                      (apps/api/src/db/schema.ts:4388) NUNCA actúa. Existe para que ampliar la
                      columna en la base no convierta una fila en quince líneas sin que nadie se
                      entere; si algún día actuara, el valor completo sigue en el panel de detalle. */}
              {/* `Celda` y no `CeldaB` desde la HU #11900: sin `hidden xl:table-cell`, la columna
                  se pinta en TODOS los anchos. Lo único que cambia es el nivel; el tratamiento de
                  la #11777 que sigue debajo —14 rem, texto entero, `wrap-anywhere`, el airbag del
                  clamp, sin `title` y sin `text-transform`— NO se toca, y el `<td>` sigue mudo
                  (nada de `sr-only` por celda: la cabecera ya identifica el dato). */}
              <Celda>
                <span className="line-clamp-6 min-w-[14rem] max-w-[14rem] wrap-anywhere">{c.estadoFuente ?? SIN_DATO}</span>
              </Celda>
              <CeldaB clase="whitespace-nowrap">{etiquetaOrigen(c.origenMerge)}</CeldaB>
              <CeldaB clase="whitespace-nowrap">{fechaColombia(c.primeraVistoEn)}</CeldaB>
              {mostrarInactivado && (
                <CeldaB clase="whitespace-nowrap">{fechaColombia(c.inactivadoEn)}</CeldaB>
              )}
            </FlitTr>
          );
        })}
      </tbody>
    </FlitTable>
  );
}

/**
 * Filas fantasma: la tabla cargando, con su encabezado ya puesto.
 *
 * Ocho filas y no un spinner centrado: el spinner obliga a la tabla a saltar de alto cuando llegan
 * los datos, y ocho filas ya insinúan la forma de lo que viene.
 *
 * Hasta la HU #11713 el encabezado estaba escrito aquí a mano, con nueve cabeceras y ni una `ThB`,
 * y eso rompía justo lo que el esqueleto existe para evitar: a ≥1280 px el encabezado saltaba de
 * nueve a trece columnas en cuanto llegaba la respuesta. Ahora pinta `CabecerasComparendos`, la
 * misma que la tabla llena, y recibe `mostrarInactivado` por la misma razón: la columna condicional
 * depende del filtro, que ya se conoce ANTES de que la petición responda.
 */
export function TablaComparendosCargando({ mostrarInactivado = false }: { mostrarInactivado?: boolean }) {
  // Derivadas de los mismos arreglos que las cabeceras: una columna nueva no puede dejar el
  // esqueleto con una celda de menos.
  const celdasB = COLUMNAS_B.length + (mostrarInactivado ? 1 : 0);
  return (
    <div role="status" aria-busy="true" aria-label="Cargando comparendos">
      <FlitTable label="Comparendos monitoreados">
        <caption className="sr-only">Cargando comparendos monitoreados</caption>
        <thead>
          <CabecerasComparendos mostrarInactivado={mostrarInactivado} />
        </thead>
        <tbody className="animate-pulse motion-reduce:animate-none">
          {Array.from({ length: 8 }, (_, fila) => (
            <FlitTr key={fila}>
              {COLUMNAS_A.map((columna) => (
                <td key={columna} className="px-4 py-2.5">
                  {/* La columna de dos líneas —«Fechas», y desde la HU #11879 solo esa— lleva DOS
                      barras: una corta arriba, que es el sitio del rótulo, y una más larga debajo,
                      que es el del valor. Con una sola barra la fila crece de alto en cuanto llega
                      la respuesta; con dos donde la celda mide una línea, la fila fantasma queda MÁS
                      ALTA que la fila con datos y la tabla encoge al cargar, que es el mismo defecto
                      con el signo cambiado. Por eso esto se deriva del `Set` y no se escribe a
                      mano. */}
                  {COLUMNAS_A_DE_DOS_LINEAS.has(columna) ? (
                    <>
                      <div className="h-4 w-1/2" style={{ background: 'var(--flit-border-soft)', borderRadius: 8 }} />
                      <div className="mt-1 h-4" style={{ background: 'var(--flit-border-soft)', borderRadius: 8 }} />
                    </>
                  ) : (
                    <div className="h-4" style={{ background: 'var(--flit-border-soft)', borderRadius: 8 }} />
                  )}
                </td>
              ))}
              {Array.from({ length: celdasB }, (__, col) => (
                <td key={col} className="hidden xl:table-cell px-4 py-2.5">
                  <div className="h-4" style={{ background: 'var(--flit-border-soft)', borderRadius: 8 }} />
                </td>
              ))}
            </FlitTr>
          ))}
        </tbody>
      </FlitTable>
    </div>
  );
}
