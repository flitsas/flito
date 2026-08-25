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
// rotuladas en la misma celda, y «Municipio» pasa a «Municipio u organismo» y muestra el organismo
// —diciendo que lo es— en las filas cuyo `municipioFuente` es `null`. **Sigue en 14 columnas con
// «Inactivado» puesto y 10 por debajo de 1280 px.** El coste es una línea más de alto en cada una de
// las dos celdas, que en esta tabla ya estaba pagada: desde la #11777 la celda de estado envuelve a
// 14 rem, y el alias del NIT y la segunda línea de «Gestión» ya rompían el alto uniforme.
//
// El precio de NO añadir columna es el rótulo dentro de la celda, y por eso el rótulo no es
// decoración: es lo único que impide que dos datos distintos se lean como uno.

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
 * «Municipio u organismo», desde la HU #11795. Una sola columna con DOS rótulos posibles.
 *
 * `municipioFuente` es el municipio al que se le PREGUNTÓ —lo escribe el sync con el `codigoFuente`
 * de la consulta municipal— y en una fila que solo vio el SIMIT es `null` por construcción: la celda
 * decía «—» teniendo `organismo` guardado y a mano en la misma fila del contrato. Ahora, **si y solo
 * si** `municipioFuente` es `null`, se muestra el organismo **diciendo que es el organismo**. Nunca
 * los dos a la vez: pintarlos juntos sería reponer la columna «Organismo» dentro de otra celda.
 *
 * «u» y no «/»: «Municipio / organismo» se anuncia «municipio barra organismo» en unos lectores y se
 * come el separador en otros. Y «u» y no «o», por la o- inicial de «organismo».
 */
const TH_MUNICIPIO_U_ORGANISMO = 'Municipio u organismo';

const COLUMNAS_A = [
  'N.º comparendo',
  // Segunda, pegada al número, porque es parte de la IDENTIDAD de la fila: dice qué es. Es el mismo
  // sitio que ocupa en el archivo de export (HU #11712).
  'Tipo',
  'Placa',
  'NIT monitoreado',
  TH_FECHAS,
  'Infracción',
  TH_MUNICIPIO_U_ORGANISMO,
  'Monto',
  // Se llamaba «Estado» hasta la HU #11713. NO es el estado del proveedor: es el de MONITOREO. Con
  // «Estado en la fuente» ya en la misma tabla, dos cabeceras que empiezan por la misma palabra se
  // oyen casi iguales —en modo tabla un lector anuncia la cabecera al cambiar de celda: «Estado…
  // Activo» y «Estado en la fuente… Se adeuda»—. «Monitoreo» se distingue desde la primera sílaba,
  // y es la palabra que `docs/dominio.md` ya usa para esto.
  'Monitoreo',
  'Gestión',
] as const;

/**
 * Nivel B: se colapsa por debajo de 1280 px. «Organismo» SALIÓ de la tabla en la HU #11713 —quince
 * columnas eran demasiadas y el dato está entero en el panel de detalle—; su sitio lo ocupa «Estado
 * en la fuente».
 *
 * «Estado en la fuente» va aquí y no pegada a «Monitoreo», que es donde el contraste entre las dos
 * se vería mejor: pegarla empujaría ~11 rem a la derecha una columna de nivel A dentro de un
 * `overflow-x-auto` que a 1280 px ya desplaza.
 */
const COLUMNAS_B = ['Estado en la fuente', 'Origen', 'Registrado'] as const;

/** Condicional: solo con el filtro «Inactivos» puesto. Cierra el bloque B. */
const COLUMNA_B_INACTIVADO = 'Inactivado';

/**
 * Las columnas de nivel A cuya celda mide DOS líneas (HU #11795), derivadas de las mismas constantes
 * que las cabeceras para que renombrarlas no pueda desincronizar el esqueleto.
 *
 * En las ocho filas fantasma llevan **dos barras apiladas**, no una: con una sola barra la fila
 * CRECERÍA de alto al llegar los datos, que es exactamente el defecto que el esqueleto existe para
 * evitar y el que la #11713 corrigió en las cabeceras.
 */
const COLUMNAS_A_DE_DOS_LINEAS: ReadonlySet<string> = new Set([TH_FECHAS, TH_MUNICIPIO_U_ORGANISMO]);

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
        {/* HU #11795. La cabecera son tres palabras y no puede decir cuál de los dos datos trae cada
            fila; el `caption` sí, y es el único texto que un lector anuncia con seguridad al entrar
            en la tabla. Es además donde queda escrita la consecuencia contraintuitiva del filtro. */}
        {' '}«Municipio u organismo» dice a qué municipio se consultó; cuando el comparendo solo lo
        reportó SIMIT, la celda muestra el organismo que lo impuso, rotulado como tal.
      </caption>
      <thead>
        <CabecerasComparendos mostrarInactivado={mostrarInactivado} />
      </thead>
      <tbody>
        {items.map((c) => {
          const alias = catalogos.alias[c.nitMonitoreado];
          const causal = c.causalId ? catalogos.causales[c.causalId] : null;
          // Si el catálogo no cargó, se pinta el código crudo: «ITAGUI» sigue siendo cierto.
          const municipio = c.municipioFuente
            ? catalogos.municipios[c.municipioFuente] ?? c.municipioFuente
            : null;
          /**
           * La regla de contenido de «Municipio u organismo», en una línea (HU #11795):
           * `municipioFuente` traducido por el catálogo si lo hay; **si y solo si** es `null`, el
           * `organismo`; si tampoco hay organismo, «—».
           *
           * El rótulo NO es cosmético: es lo que dice QUÉ es el valor. Y no se deduce nada — no se
           * convierte «Medellin» en el `codigoFuente` `MEDELLIN`, no se busca en el catálogo de
           * municipios y no se escribe nada en `municipioFuente`. La prohibición del requerimiento 4
           * de la spec era contra INVENTAR el campo y sigue entera; lo que se publica aquí es un
           * campo que el contrato ya trae, con su nombre verdadero.
           */
          const lugar: { rotulo: string; valor: string } | null = municipio !== null
            ? { rotulo: 'Municipio', valor: municipio }
            : (c.organismo ? { rotulo: 'Organismo', valor: c.organismo } : null);
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
              {/* «Municipio u organismo» (HU #11795). Cuatro decisiones que no se ven en dos líneas
                  de JSX:

                    · **El rótulo va PRIMERO, en su propia línea, encima del valor.** Es la única
                      posición que desambigua ANTES de leer: con el rótulo debajo —el patrón del
                      alias del NIT y del «cuándo/quién» de la gestión— el ojo lee «Medellin»,
                      concluye «municipio», y el rótulo llega tarde a corregir una conclusión ya
                      tomada.
                    · **Nunca un valor sin su rótulo**, tampoco en la fila municipal, que es el caso
                      común: si solo se rotulara el de SIMIT, un valor desnudo significaría
                      «municipio» por omisión, que es fundir los dos rótulos por la puerta de atrás.
                    · **Sin ninguno de los dos, un «—» SIN rótulo.** Aquí sí se diferencia de la
                      celda «Fechas», a propósito: allí hay dos ranuras que siempre existen y se sabe
                      QUÉ falta; aquí no se sabe cuál de los dos falta, y escribir «Municipio —»
                      afirmaría una categoría que nadie puede afirmar. La cabecera ya cubre la celda.
                    · **El organismo se pinta TAL CUAL.** «Medellin» sin tilde y «Bogota D.C.» se
                      pintan así: son lo que dijo la fuente y el operador puede tener que
                      citárselos. Ni `capitalize`, ni `uppercase`, ni tildes puestas por nosotros —
                      la misma regla que la #11713 y la #11777 fijaron para `estadoFuente`.
                      `municipioFuente` SÍ se traduce, porque ahí la traducción la hace NUESTRO
                      catálogo, que es un dato y no una suposición.

                  Y la celda **envuelve**, con el tratamiento que la #11777 dejó medido: `organismo`
                  es `varchar(120)` —el triple que `municipioFuente`, que es `varchar(40)`— y
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
                  en la base no convierta una fila en veinte líneas sin que nadie se entere. */}
              <Celda>
                {lugar === null ? <SinDato /> : (
                  <>
                    <span className="block text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
                      {lugar.rotulo}
                    </span>
                    <span className="line-clamp-[12] block min-w-[11rem] max-w-[11rem] wrap-anywhere">
                      {lugar.valor}
                    </span>
                  </>
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

                  Y **no vuelve con la HU #11795**, que es lo que hay que leer aquí antes de
                  reponerlo: sería la quince y reabriría la decisión del supervisor con el mismo
                  argumento que sigue siendo cierto. Lo que la #11795 hace es publicar su VALOR
                  dentro de la celda «Municipio u organismo» —una celda que ya existía— y solo en las
                  filas cuyo `municipioFuente` es `null`. En las filas municipales el organismo sigue
                  exactamente donde la #11713 lo dejó: el detalle y el export.

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
              <CeldaB>
                <span className="line-clamp-6 min-w-[14rem] max-w-[14rem] wrap-anywhere">{c.estadoFuente ?? SIN_DATO}</span>
              </CeldaB>
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
                  {/* Las dos columnas de dos líneas llevan DOS barras (HU #11795): una corta arriba,
                      que es el sitio del rótulo, y una más larga debajo, que es el del valor. Con
                      una sola barra la fila crece de alto en cuanto llega la respuesta. */}
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
