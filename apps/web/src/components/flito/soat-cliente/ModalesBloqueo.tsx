// FLITO — canal Cliente: los DOS modales que paran una solicitud (HU #11914, AC3 y AC4).
//
// ── Por qué son dos componentes y no una plantilla con el texto cambiado ────────────────────────
//
// |                      | AC3 · SOAT vigente        | AC4 · VIN ya en la cola                    |
// |----------------------|---------------------------|--------------------------------------------|
// | Quién lo dice        | El RUNT                   | FLITO (RN-01, `vin UNIQUE`)                |
// | Qué significa        | El vehículo ESTÁ CUBIERTO | El vehículo YA ESTÁ EN TRÁMITE con nosotros |
// | ¿Buena noticia?      | Sí                        | Depende: si es suya y está rechazada, hay trabajo |
// | Tono / chip          | `success`                 | `warning`                                  |
// | Qué puede hacer      | Nada, y está bien         | Abrir la que ya existe, o hablar con FLIT  |
// | Vuelve a poder pedir | Cuando la póliza venza    | Cuando esa solicitud termine su ciclo      |
//
// Fundirlos en «este vehículo no se puede solicitar» es lo que el AC4 prohíbe con estas palabras: el
// usuario tiene que entender POR QUÉ se le detiene, y las dos causas no tienen nada que ver.
//
// El TÍTULO de cada uno es la frase que explica el bloqueo y no un «Aviso» genérico: `FlitModal` lo
// usa como `aria-label` del diálogo, así que es lo primero que anuncia el lector al entrar. Un
// título genérico gastaría ese anuncio en no decir nada.
//
// Ninguno de los dos dispara una segunda llamada: se abren con los datos ya en la mano, en la misma
// respuesta de la preconsulta. Por eso no tienen estado de carga ni de error — cerrarlos devuelve al
// bloque 1 con lo tecleado intacto.

import type { RefObject } from 'react';
import { Link } from 'react-router-dom';
import { ESTADO_SOAT_LABEL, EstadoSoat } from '@operaciones/shared-types';
import FlitModal from '../../flit/FlitModal';
import StatusChip from '../../flit/StatusChip';
import { flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';

const COLA = '/flito/soat';

/** Fecha larga y legible; solo se usa cuando de verdad hay fecha. */
const fechaLarga = (iso: string) => new Date(iso).toLocaleDateString('es-CO', { dateStyle: 'short' });

interface ComunProps {
  placa: string;
  onClose: () => void;
  /**
   * Dónde dejar el foco al cerrar. `FlitModal` lo devuelve al disparador si sigue vivo, pero
   * «Consultar otro vehículo» LIMPIA los campos y desmonta el botón que abrió el modal: sin este
   * respaldo el foco se cae a `<body>`.
   */
  restoreFocusRef?: RefObject<HTMLElement | null>;
}

// ───────────────────────────── AC3 · «Ya tiene SOAT vigente» ─────────────────────────────────────

/**
 * El chip va en `success` y **no** en rojo, y es una decisión: para el usuario esto es una BUENA
 * noticia —su vehículo está cubierto—, no un fallo suyo. Un modal rojo le diría que hizo algo mal.
 */
export function ModalSoatVigente(
  { placa, fechaVencimiento, onConsultarOtro, onClose, restoreFocusRef }: ComunProps & {
    /** Del RUNT, **si viene**. Ver `FalloCanal.fechaVencimiento`: hoy el 409 no la trae. */
    fechaVencimiento?: string;
    onConsultarOtro: () => void;
  },
) {
  return (
    <FlitModal title="Este vehículo ya tiene SOAT vigente" onClose={onClose} restoreFocusRef={restoreFocusRef}>
      <div className="space-y-3 text-sm">
        <StatusChip tone="success">No hace falta comprar otro</StatusChip>

        {/* Dos frases enteras y NO una con la fecha interpolada: sin fecha, «vigente hasta el .» es
            lo que sale de rellenar un hueco vacío. Nunca se inventa una fecha ni se escribe «—» en
            medio de una oración. */}
        <p>
          {fechaVencimiento
            ? `Según el RUNT, la póliza del vehículo ${placa} está vigente hasta el ${fechaLarga(fechaVencimiento)}.`
            : `Según el RUNT, el vehículo ${placa} tiene una póliza SOAT vigente.`}
        </p>

        {/* Ni la aseguradora ni el número de póliza, aunque el RUNT los traiga: no hacen falta para
            la decisión y son datos de un contrato con un tercero que este canal no persiste. */}
        <p>
          FLITO no radica solicitudes de vehículos con SOAT vigente. Puede volver cuando la póliza
          esté por vencerse.
        </p>

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={onConsultarOtro}>
            Consultar otro vehículo
          </button>
          <Link to={COLA} className={flitBtnSecondary} style={flitBtnSecondaryStyle}>Volver a mis SOAT</Link>
        </div>
      </div>
    </FlitModal>
  );
}

// ───────────────────────────── AC4 · «Ya está en la cola de FLITO» ───────────────────────────────

/**
 * Tres variantes, y la tercera es una FRONTERA, no una cortesía.
 *
 * `flito_soat.vin` es único **en toda la tabla**, así que el choque puede ser contra un SOAT de otra
 * compañía. Si el modal dijera el estado, la fecha o el nombre de esa solicitud, un Cliente podría
 * sondear VINs —los de una flota son consecutivos— y deducir con quién más trabaja FLIT. El servidor
 * ya recorta el 409 (`propia: false`, sin `id` y sin `estado`) y `leerFallo` no lee esos campos
 * salvo que `propia === true`; esto es la tercera cerradura: **sin `estado` no se escribe estado**.
 */
export function ModalVinEnCola(
  { placa, propia, estado, id, onClose, restoreFocusRef }: ComunProps & {
    propia: boolean;
    estado?: EstadoSoat;
    id?: string;
  },
) {
  const rechazada = propia && estado === EstadoSoat.RECHAZADA;
  return (
    <FlitModal title="Ese vehículo ya está en la cola de FLITO" onClose={onClose} restoreFocusRef={restoreFocusRef}>
      <div className="space-y-3 text-sm">
        <StatusChip tone="warning">No se puede crear otra solicitud</StatusChip>

        <p>
          {propia && estado
            ? `El vehículo ${placa} ya tiene una solicitud de SOAT en FLITO, en estado ${ESTADO_SOAT_LABEL[estado]}. Cada vehículo puede tener una sola.`
            : `El vehículo ${placa} ya tiene una solicitud de SOAT en FLITO. Cada vehículo puede tener una sola.`}
        </p>

        <p>
          {rechazada
            ? 'Esa solicitud fue rechazada. Para volver a enviarla, corrija lo que se le indica en ella; no cree una nueva.'
            : propia
              ? 'Puede seguir su estado desde sus SOAT.'
              : 'Escríbale a su contacto en FLIT si cree que es un error.'}
        </p>

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          {/* El destino lleva el uuid OPACO en el path y nada más: ni la placa ni el VIN viajan por
              query «para ahorrar una llamada» (AGENTS.md §14). */}
          {rechazada && id && (
            <Link to={`${COLA}/solicitud/${id}`} className={flitBtnPrimary} style={flitBtnPrimaryStyle}>
              Abrir la solicitud rechazada
            </Link>
          )}
          {propia && !rechazada && id && (
            // Sin dirección propia: el detalle de la cola es un modal. El id viaja en el estado de
            // navegación —no en la URL— y la cola lo abre si esa fila está en la página cargada.
            <Link to={COLA} state={{ verSoatId: id }} className={flitBtnPrimary} style={flitBtnPrimaryStyle}>
              Ver la solicitud
            </Link>
          )}
          <Link to={COLA} className={flitBtnSecondary} style={flitBtnSecondaryStyle}>Volver a mis SOAT</Link>
        </div>
      </div>
    </FlitModal>
  );
}
