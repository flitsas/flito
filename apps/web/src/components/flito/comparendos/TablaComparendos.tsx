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



const CELDA = 'px-4 py-2.5 text-sm';

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
const COLUMNAS_A = [
  'N.º comparendo',
  // Segunda, pegada al número, porque es parte de la IDENTIDAD de la fila: dice qué es. Es el mismo
  // sitio que ocupa en el archivo de export (HU #11712).
  'Tipo',
  'Placa',
  'NIT monitoreado',
  'Fecha',
  'Infracción',
  'Municipio',
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
            : SIN_DATO;
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
              <Celda clase="whitespace-nowrap">{fechaCorta(c.fechaComparendo)}</Celda>
              <Celda clase="min-w-[15rem]">
                {/* Una línea con recorte. El texto completo NO se pone en un `title`: no lo ve el
                    teclado, no lo anuncia bien un lector y no existe en táctil. Vive en el detalle.
                    El recorte es además lo que mantiene el ALTO de la fila: sin él, una descripción
                    de 300 caracteres —las hay— convierte una fila en cuatro. */}
                <span className="line-clamp-1 max-w-[22rem]">{infraccion || SIN_DATO}</span>
              </Celda>
              <Celda clase="whitespace-nowrap">{municipio}</Celda>
              {/* Cifras tabulares y a la derecha: sin eso, dos montos no alinean sus unidades y
                  compararlos exige leerlos enteros. */}
              <Celda clase="whitespace-nowrap text-right tabular-nums">{pesos(c.monto)}</Celda>
              <td className="px-4 py-2.5">
                <StatusChip tone={c.estado === 'activo' ? 'active' : 'draft'}>
                  {c.estado === 'activo' ? 'Activo' : 'Inactivo'}
                </StatusChip>
              </td>
              <td className="whitespace-nowrap px-4 py-2.5">
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

                  El estado del proveedor se pinta TAL CUAL: sin `capitalize`, sin `uppercase` y sin
                  recortar el texto. El operador puede tener que citárselo al organismo, y un
                  «se adeuda» que la pantalla convirtió en «Se Adeuda» ya no es lo que dijo la
                  fuente. Una línea con `line-clamp-1` —eso mantiene el alto de la fila— y **sin
                  `title`**, igual que la infracción y por lo mismo: un `title` no lo ve el teclado,
                  no lo anuncia bien un lector y no existe en táctil. */}
              <CeldaB><span className="line-clamp-1 max-w-[11rem]">{c.estadoFuente ?? SIN_DATO}</span></CeldaB>
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
                  <div className="h-4" style={{ background: 'var(--flit-border-soft)', borderRadius: 8 }} />
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
