// FLITO — Comparendos: la tabla del visor (HU #11560, AC1 y AC7).
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

import type { ReactNode } from 'react';
import type { ComparendoRegistro } from '@operaciones/shared-types';
import { FlitTable, FlitTh, FlitTr } from '../../flit/flitPageKit';
import StatusChip from '../../flit/StatusChip';
// `fechaColombia` es la que hasta la HU #11562 se llamaba `fechaHoraColombia` y NO pinta hora: la
// tabla no la necesita —trece columnas y una corrida diaria— y cambiarla habría movido tres
// columnas. La que sí lleva hora vive en `formato.ts` con ese nombre y la usa el panel de detalle.
import { SIN_DATO, etiquetaOrigen, fechaColombia, fechaCorta, pesos } from './formato';
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
      <caption className="sr-only">
        Comparendos monitoreados. Activo o inactivo es lo que dicen las fuentes, no si está pagado:
        «inactivo» significa que dejaron de reportarlo.
      </caption>
      <thead>
        <FlitTr>
          <FlitTh>N.º comparendo</FlitTh>
          <FlitTh>Placa</FlitTh>
          <FlitTh>NIT monitoreado</FlitTh>
          <FlitTh>Fecha</FlitTh>
          <FlitTh>Infracción</FlitTh>
          <FlitTh>Municipio</FlitTh>
          <FlitTh>Monto</FlitTh>
          <FlitTh>Estado</FlitTh>
          <FlitTh>Gestión</FlitTh>
          <ThB>Organismo</ThB>
          <ThB>Origen</ThB>
          <ThB>Registrado</ThB>
          {mostrarInactivado && <ThB>Inactivado</ThB>}
        </FlitTr>
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
                  13 columnas, celdas enfocables serían 650 paradas hasta la paginación. */}
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
              {/* Mismo recorte que la infracción y por el mismo motivo: «Secretaría de Movilidad
                  de …» ocupa cuatro líneas en una columna estrecha y arrastra el alto de toda la
                  fila. Es contexto útil, no un dato que haya que leer entero aquí. */}
              <CeldaB><span className="line-clamp-1 max-w-[13rem]">{c.organismo ?? SIN_DATO}</span></CeldaB>
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
 */
export function TablaComparendosCargando() {
  return (
    <div role="status" aria-busy="true" aria-label="Cargando comparendos">
      <FlitTable label="Comparendos monitoreados">
        <caption className="sr-only">Cargando comparendos monitoreados</caption>
        <thead>
          <FlitTr>
            <FlitTh>N.º comparendo</FlitTh>
            <FlitTh>Placa</FlitTh>
            <FlitTh>NIT monitoreado</FlitTh>
            <FlitTh>Fecha</FlitTh>
            <FlitTh>Infracción</FlitTh>
            <FlitTh>Municipio</FlitTh>
            <FlitTh>Monto</FlitTh>
            <FlitTh>Estado</FlitTh>
            <FlitTh>Gestión</FlitTh>
          </FlitTr>
        </thead>
        <tbody className="animate-pulse motion-reduce:animate-none">
          {Array.from({ length: 8 }, (_, fila) => (
            <FlitTr key={fila}>
              {Array.from({ length: 9 }, (__, col) => (
                <td key={col} className="px-4 py-2.5">
                  <div
                    className="h-4"
                    style={{ background: 'var(--flit-border-soft)', borderRadius: 8 }}
                  />
                </td>
              ))}
            </FlitTr>
          ))}
        </tbody>
      </FlitTable>
    </div>
  );
}
