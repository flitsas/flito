// Reporte de costos — las celdas del grupo «Costo de proveedor» (ADR-0041 §13, Épica #13763).
//
// Es lo que FLITO le PAGA al proveedor por el trámite, y nunca se suma al cobro al cliente. La
// pantalla no calcula nada: cada concepto llega con su estado (`CostoProveedorConcepto`) y el total
// llega hecho (`costoProveedorTotal`).
//
// Retoques del humano al aprobar la maqueta (spec `flito-reporte-costos-rediseno.md`, final):
//   · Sin etiquetas pegadas al importe: ni «estimado» ni «parcial». La celda muestra el valor y
//     nada más; el matiz va al `title` y al nombre accesible, donde no se suma con la vista.
//   · Los estados SIN importe siguen siendo el contenido de la celda («Sin configurar», «Sin
//     proveedor», «Gestionado por Operaciones», «Ya contado en el trámite N»).
//   · El nombre del proveedor no se recorta: la columna crece y la tabla desplaza en el scroll del kit.
//
// Sin rojo: ningún estado bloquea la liquidación, así que todos usan la tinta tenue de `Monto`.

import type { CSSProperties } from 'react';
import { ETIQUETA_ESTADO_COSTO_PROVEEDOR, type CostoProveedorConcepto } from '@operaciones/shared-types';
import { pesos, type Fila } from './tiposReporteCostos';

const TENUE = { color: 'var(--flit-text-muted)' } as const;

export type ConceptoCosto = 'soat' | 'logistica';

/** La tabla añade el borde de grupo y el `sticky` con `cloneElement`: las celdas lo dejan pasar. */
interface Paso { className?: string; style?: CSSProperties }

const NOMBRE: Record<ConceptoCosto, string> = { soat: 'SOAT', logistica: 'logística' };

export const costoDe = (f: Fila, c: ConceptoCosto): CostoProveedorConcepto =>
  c === 'soat' ? f.costoProveedorSoat : f.costoProveedorLogistica;

/** El texto de un estado sin importe. `ya_contado` lleva el trámite donde se contó (C6). */
export function textoEstadoCosto(c: CostoProveedorConcepto): string {
  if (c.estado === 'ya_contado') {
    return ETIQUETA_ESTADO_COSTO_PROVEEDOR.ya_contado.replace('{idFlit}', c.contadoEnIdFlit ?? '—');
  }
  return ETIQUETA_ESTADO_COSTO_PROVEEDOR[c.estado];
}

/** Por qué el estado es el que es: va al `title` y al nombre accesible, nunca pegado al valor. */
function explicacion(c: CostoProveedorConcepto, f: Fila): string | null {
  switch (c.estado) {
    case 'estimado': return 'estimado: el trámite se liquidó antes de que FLITO guardara este costo';
    case 'costo': return f.sellada ? null : 'estimado: puede cambiar hasta que se liquide';
    case 'sin_configurar': return 'El proveedor no tiene costo configurado. No impide liquidar.';
    case 'sin_proveedor': return 'Este trámite no tuvo entrega con proveedor.';
    case 'gestionado_operaciones': return 'SOAT en contingencia: lo gestiona Operaciones.';
    case 'ya_contado': return `El SOAT es compartido y su costo se cargó al trámite ${c.contadoEnIdFlit ?? ''}.`.trim();
  }
}

/** «Costo proveedor SOAT: $ 48.000, Seguros Demo, estimado: puede cambiar hasta que se liquide». */
export function accesibleCosto(f: Fila, concepto: ConceptoCosto): string {
  const c = costoDe(f, concepto);
  const valor = c.valor !== null ? pesos(c.valor) : textoEstadoCosto(c);
  const partes = [`Costo proveedor ${NOMBRE[concepto]}: ${valor}`];
  if (c.proveedor) partes.push(c.proveedor);
  const porque = explicacion(c, f);
  if (porque && c.valor !== null) partes.push(porque);
  return partes.join(', ') + (porque && c.valor === null ? `. ${porque}` : '');
}

/** La celda «Costo SOAT» / «Costo logística»: el valor, o el estado cuando no lo hay. */
export function CeldaCosto({ fila, concepto, className = '', style }: { fila: Fila; concepto: ConceptoCosto } & Paso) {
  const c = costoDe(fila, concepto);
  const nombre = accesibleCosto(fila, concepto);
  return (
    <td className={`px-3 py-2 text-right tabular-nums whitespace-nowrap ${className}`} aria-label={nombre} title={nombre}
      data-estado-costo={c.estado} style={style}>
      {c.valor !== null
        ? pesos(c.valor)
        : <span className="text-xs italic" style={TENUE}>{textoEstadoCosto(c)}</span>}
    </td>
  );
}

/** «Proveedor SOAT» / «Proveedor logística»: el nombre entero, sin recortar (la columna crece); «—» si no hay. */
export function CeldaProveedor({ fila, concepto, className = '', style }: { fila: Fila; concepto: ConceptoCosto } & Paso) {
  const c = costoDe(fila, concepto);
  return (
    <td className={`px-3 py-2 whitespace-nowrap ${className}`} style={style}>
      {c.proveedor ?? <span style={TENUE}>—</span>}
    </td>
  );
}

/**
 * «Total costos»: la suma que manda el API. Sin «parcial» ni «estimado» junto al número (retoque
 * 4): si falta un concepto, se dice en el `title` y en el nombre accesible. Sin ningún valor, el
 * estado («Sin configurar» si alguno lo está; si no, «—»).
 */
export function CeldaTotalCostos({ fila, className = '', style }: { fila: Fila } & Paso) {
  const conceptos = [fila.costoProveedorSoat, fila.costoProveedorLogistica];
  const sinConfigurar = (['soat', 'logistica'] as const).filter((k) => costoDe(fila, k).estado === 'sin_configurar');
  const v = fila.costoProveedorTotal;
  const falta = sinConfigurar.length
    ? `falta el costo ${sinConfigurar.map((k) => NOMBRE[k]).join(' y ')} (sin configurar)`
    : null;
  const estimado = !fila.sellada || conceptos.some((c) => c.estado === 'estimado');
  let nombre: string;
  if (v !== null) {
    nombre = `Total costos de proveedor: ${pesos(v)}`;
    if (falta) nombre += `, parcial: ${falta}`;
    if (estimado) nombre += ', estimado';
  } else {
    nombre = `Total costos de proveedor: ${sinConfigurar.length ? 'Sin configurar' : 'sin costo'}`;
  }
  return (
    <td className={`px-3 py-2 text-right tabular-nums whitespace-nowrap ${className}`} aria-label={nombre} title={nombre}
      style={{ color: 'var(--flit-text-primary)', ...style }}>
      {v !== null
        ? <span className="font-semibold">{pesos(v)}</span>
        : <span className="text-xs italic" style={TENUE}>{sinConfigurar.length ? 'Sin configurar' : '—'}</span>}
    </td>
  );
}
