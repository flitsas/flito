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
import type { CatalogosComparendos } from './useComparendosLista';

/** Guion de ausencia. `null` es información: hay fuentes que no traen la placa, la fecha o el monto. */
const SIN_DATO = '—';

/**
 * Monto en pesos colombianos (AC1). Se formatea sobre `Number(monto)` **solo para mostrar**.
 */
export function pesos(monto: string | null): string {
  if (monto === null || monto.trim() === '') return SIN_DATO;
  const n = Number(monto);
  if (!Number.isFinite(n)) return SIN_DATO;
  return n.toLocaleString('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
}

/**
 * `YYYY-MM-DD` → «12 jul 2026».
 *
 * Se parte la cadena a mano en vez de pasar por `new Date(fecha)`: esa forma la interpreta como
 * medianoche UTC y, al pintarla en hora de Colombia (UTC−5), retrocede un día — el comparendo decía
 * 12 y la tabla mostraba 11. Es una fecha de calendario, sin hora que convertir.
 */
export function fechaCorta(fecha: string | null): string {
  if (!fecha) return SIN_DATO;
  const [y, m, d] = fecha.split('-').map(Number);
  if (!y || !m || !d) return fecha;
  return new Date(y, m - 1, d)
    .toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Instante (columna `timestamptz`) en **hora de Colombia** (AC1), no en la del navegador.
 *
 * La zona va explícita: un operador con el portátil en otra zona —o un runner de CI en UTC— vería
 * «03:12» convertido a su hora local y creería que la corrida pasó a otra hora de la que pasó.
 */
export function fechaHoraColombia(instante: string | null): string {
  if (!instante) return SIN_DATO;
  const t = new Date(instante);
  if (Number.isNaN(t.getTime())) return SIN_DATO;
  return t.toLocaleDateString('es-CO', {
    timeZone: 'America/Bogota', day: 'numeric', month: 'short', year: 'numeric',
  });
}

const ETIQUETA_ORIGEN: Record<ComparendoRegistro['origenMerge'], string> = {
  simit: 'SIMIT',
  municipal: 'Municipal',
  ambos: 'Ambos',
};

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
}

export default function TablaComparendos({ items, catalogos, mostrarInactivado }: Props) {
  return (
    <FlitTable>
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
              <Celda clase="whitespace-nowrap font-medium">{c.numeroComparendo}</Celda>
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
                {/* Cuándo y quién, cuando los hay. Hoy llegan siempre en `null` —nadie ha gestionado
                    todavía, el PATCH es de la HU #11557— y por eso esta línea no se ve: se pinta lo
                    que el registro trae, no un hueco reservado. `gestionActualizadaPor` es el ID del
                    usuario, no su nombre; resolverlo a un nombre es otra consulta y otra HU. */}
                {c.gestionActualizadaEn && (
                  <span className="mt-0.5 block text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
                    {fechaHoraColombia(c.gestionActualizadaEn)}
                    {c.gestionActualizadaPor !== null && ` · usuario ${c.gestionActualizadaPor}`}
                  </span>
                )}
              </td>
              {/* Mismo recorte que la infracción y por el mismo motivo: «Secretaría de Movilidad
                  de …» ocupa cuatro líneas en una columna estrecha y arrastra el alto de toda la
                  fila. Es contexto útil, no un dato que haya que leer entero aquí. */}
              <CeldaB><span className="line-clamp-1 max-w-[13rem]">{c.organismo ?? SIN_DATO}</span></CeldaB>
              <CeldaB clase="whitespace-nowrap">{ETIQUETA_ORIGEN[c.origenMerge]}</CeldaB>
              <CeldaB clase="whitespace-nowrap">{fechaHoraColombia(c.primeraVistoEn)}</CeldaB>
              {mostrarInactivado && (
                <CeldaB clase="whitespace-nowrap">{fechaHoraColombia(c.inactivadoEn)}</CeldaB>
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
      <FlitTable>
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
