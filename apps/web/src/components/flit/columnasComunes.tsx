// Las tres columnas que TODAS las tablas de trámites enseñan igual: trámite, vehículo y fechas.
//
// Hasta ahora cada pantalla decidía por su cuenta. Gestión Trámites mostraba creación y aprobación;
// la cola de SOAT, ninguna de las dos; derechos enseñaba el concepto del recibo pero no el tipo del
// trámite; el reporte no decía el VIN. El resultado es que la misma pregunta —«¿de qué trámite
// estamos hablando?»— se contestaba distinto en cada sitio, y comparar dos pantallas obligaba a
// recordar qué faltaba en cuál.
//
// Se comparte el COMPONENTE, no una guía de estilo, porque una guía se cumple hasta que alguien
// añade una columna con prisa. Aquí, si mañana el vehículo gana un dato, lo ganan las cinco tablas
// a la vez o ninguna.

import type { ReactNode } from 'react';

/** Mismas opciones en todo el producto: dos formatos de fecha confunden más de lo que ahorran. */
export const fechaCorta = (iso: string | null): string =>
  (iso ? new Date(iso).toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: '2-digit' }) : '—');

const tenue = { color: 'var(--flit-text-muted)' };
const suave = { color: 'var(--flit-text-secondary)' };

/**
 * El trámite: su identificador y su tipo.
 *
 * `tipoTramite` puede ser null y no siempre por la misma razón. En SOAT significa que el registro
 * sirve a varios trámites que no coinciden —es por VIN, no por trámite (RN-01)—, y ahí «varios» es
 * la respuesta correcta, no un hueco. `varios` lo distingue de un dato que sencillamente falta.
 */
export function CeldaTramite({ idFlit, tipoTramite, varios, extra, accion }: {
  idFlit: string | null;
  tipoTramite: string | null;
  varios?: boolean;
  /** Segunda línea opcional de la pantalla que lo use (empresa, organismo…). */
  extra?: string | null;
  /**
   * Acción propia de la pantalla, bajo el tipo de trámite (impuestos pone ahí Certificar).
   *
   * Va aquí y no en una columna suya porque una acción que solo aplica a unas pocas filas se pasa la
   * tabla entera en blanco: la columna ocupa ancho en todas para servir a una minoría. Bajo el
   * trámite ocupa sitio únicamente donde hay algo que hacer. Es opcional: las demás tablas no la
   * pasan y quedan exactamente igual que antes.
   */
  accion?: ReactNode;
}) {
  return (
    <td className="px-4 py-2 align-top">
      <div className="text-sm font-medium tabular-nums">{idFlit ?? '—'}</div>
      <div className="text-xs" style={suave}>
        {tipoTramite ?? (varios ? 'Varios trámites' : '—')}
      </div>
      {extra && <div className="text-xs" style={tenue}>{extra}</div>}
      {accion && <div className="mt-1.5">{accion}</div>}
    </td>
  );
}

/**
 * El vehículo: placa, VIN y, cuando lo hay, marca y línea.
 *
 * Marca y línea salen vacías en la práctica totalidad de los registros y NO es un fallo de datos:
 * el adaptador real de FLIT no las envía —está anotado en `flit.port.ts`— y solo las produce el
 * mock. Se pintan igualmente para que el día que FLIT empiece a mandarlas aparezcan solas, sin
 * volver a tocar las cinco tablas. Mientras tanto, la placa y el VIN sí están siempre.
 */
export function CeldaVehiculo({ placa, vin, marca, linea }: {
  placa: string | null;
  vin: string | null;
  marca?: string | null;
  linea?: string | null;
}) {
  const vehiculo = [marca, linea].filter(Boolean).join(' ');
  return (
    <td className="px-4 py-2 align-top">
      <div className="text-sm font-semibold">{placa ?? '—'}</div>
      {/* El VIN en monoespaciado: son diecisiete caracteres que se comparan de un vistazo, y con
          tipografía proporcional dos VIN parecidos se leen igual. */}
      <div className="font-mono text-[11px]" style={suave}>{vin ?? '—'}</div>
      {vehiculo && <div className="text-xs" style={tenue}>{vehiculo}</div>}
    </td>
  );
}

/**
 * Las dos fechas del trámite, rotuladas.
 *
 * Van rotuladas y no en dos columnas sueltas porque «una fecha» sin decir cuál es exactamente el
 * problema que esto viene a resolver: había pantallas con una sola fecha y nadie sabía si era la de
 * creación o la de aprobación.
 *
 * `creado` es la fecha de FLIT, no la de ingesta del sync: en la carga masiva inicial todos los
 * históricos comparten el mismo día de `created_at`, así que esa no distingue nada.
 */
export function CeldaFechas({ creado, aprobado }: { creado: string | null; aprobado: string | null }) {
  return (
    <td className="px-4 py-2 align-top text-xs whitespace-nowrap" style={suave}>
      <div><span style={tenue}>Creado </span>{fechaCorta(creado)}</div>
      <div>
        <span style={tenue}>Aprob. </span>
        {/* Sin fecha de aprobación NO es un dato que falte: es que el trámite sigue esperando al
            organismo, que es un estado del negocio. Un guion los confundiría con los que sí están
            aprobados pero cuya fecha no llegó. El reporte ya lo decía así; ahora lo dicen las
            cinco tablas. */}
        {aprobado
          ? fechaCorta(aprobado)
          : <span className="italic" style={tenue}>Sin aprobar</span>}
      </div>
    </td>
  );
}

/** Las cabeceras que acompañan a las celdas de arriba, para que el rótulo no divirja del contenido. */
export const ENCABEZADOS_COMUNES = ['Trámite', 'Vehículo', 'Fechas'] as const;
