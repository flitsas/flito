// Reporte de costos — el detalle de facturación electrónica de un trámite (HU #11331, AC2 y AC7).
//
// **Por qué existe, si ya estaba `FichaFacturacion`.** Aquella pinta el CONTENIDO: da por hecho que
// hay una factura y la describe. Este componente es lo que le faltaba alrededor —los otros tres
// estados del AC2— y el sitio donde se decide cuál toca:
//
//   cargando → un indicador, porque el detalle ya no viaja en el lote de la tabla: se pide al abrir;
//   vacío    → «a este trámite todavía no se le ha pedido factura». NO es «no hay datos»;
//   error    → «no se pudo consultar», con reintento. NO es «no hay datos» tampoco;
//   contenido→ la ficha de siempre, más lo que esta historia añade (el fallo y la revisión).
//
// **Los dos «no» de arriba son el criterio, no una precaución.** Antes, la ficha de la fila salía
// del lote que carga la tabla y ese lote se tragaba su error con un mapa vacío: si la consulta
// fallaba, TODAS las filas quedaban exactamente igual que las que nunca se enviaron. Un fallo
// pintado como ausencia es la afirmación más cara que puede hacer una pantalla de control, porque
// no parece un fallo: parece trabajo que no existe. De ahí que aquí cada caso tenga su estado, y
// que el de error se compruebe ANTES que el de vacío.
//
// **Se pide al abrir y no se hereda de la tabla**, aunque la tabla ya tenga una copia. El detalle se
// abre sobre UN trámite y quien lo abre suele venir de ver algo raro: darle lo que se cargó hace
// diez minutos —o lo que no se cargó, si aquella petición falló— es servirle una foto vieja justo
// cuando pregunta por lo de ahora.

import { useCallback, useEffect, useState } from 'react';
import {
  SIIGO_ESTADO_REPORTE_ETIQUETA,
  type SiigoColaItem, type SiigoEstadoReporte,
} from '@operaciones/shared-types';
import { api, errorMessage } from '../../lib/api';
import FlitModal from '../flit/FlitModal';
import StatusChip from '../flit/StatusChip';
import { flitBtnSecondarySm } from '../flit/flitPageKit';
import FichaFacturacion from './FichaFacturacion';
import FalloEmision from './FalloEmision';
import MarcaRevisionFactura from './MarcaRevisionFactura';
import { TONO_CHIP_ESTADO, type FacturacionTramite } from './tiposFacturacion';

interface Props {
  tramiteId: string;
  idFlit: string;
  /**
   * El estado que el REPORTE trae en la fila. Es el que manda cuando no hay factura todavía: la
   * consulta de fichas solo devuelve trámites CON documento, así que sin esto un trámite en cola y
   * uno que nadie ha tocado llegarían aquí igual de vacíos.
   */
  estadoFila: SiigoEstadoReporte;
  /** `siigo_facturas.requiere_revision` de la fila (AC6). Se pinta; no se recalcula aquí. */
  requiereRevision: boolean;
  /** Separa lectura de escritura (AC1): los roles de solo lectura ven el detalle entero, sin acciones. */
  puedeOperar: boolean;
  onClose: () => void;
  onCambio?: () => void;
}

type Fase = 'cargando' | 'error' | 'listo';

export default function DetalleFacturacion({
  tramiteId, idFlit, estadoFila, requiereRevision, puedeOperar, onClose, onCambio,
}: Props) {
  const [fase, setFase] = useState<Fase>('cargando');
  const [error, setError] = useState<string | null>(null);
  const [ficha, setFicha] = useState<FacturacionTramite | null>(null);
  const [cola, setCola] = useState<SiigoColaItem | null>(null);

  // `useCallback` y no un `eslint-disable`: la función la usan el efecto Y el botón de reintentar,
  // así que declararla estable es lo correcto y no un rodeo para callar al linter.
  const cargar = useCallback(async () => {
    setFase('cargando');
    setError(null);
    try {
      // `URLSearchParams` y no interpolar: el identificador viene del servidor y hoy es un UUID,
      // pero el día que ese campo cambie de forma un `&` suelto partiría la consulta en dos.
      const q = new URLSearchParams({ ids: tramiteId });
      const r = await api.get<{ items: FacturacionTramite[] }>(`/siigo/facturacion/tramites?${q}`);
      // Por `tramiteId` y no `items[0]`: la ruta responde a una lista y devolver de más es
      // barato para ella y caro aquí — enseñar la factura de otro trámite en esta ficha sería
      // indistinguible de un dato correcto.
      const encontrada = r.items.find((i) => i.tramiteId === tramiteId) ?? null;

      // La cola se consulta SOLO cuando hay un fallo que explicar (AC5). Es una segunda petición y
      // solo paga la pena en el caso en que aporta: para una factura aceptada, saber en qué punto
      // quedó su fila de cola no le dice nada a nadie.
      const estado = encontrada?.estado ?? estadoFila;
      setCola(estado === 'fallido' ? await colaDe(tramiteId) : null);

      setFicha(encontrada);
      setFase('listo');
    } catch (e) {
      // El fallo NO se traga con una ficha vacía: «no se pudo consultar» y «nunca se envió» son
      // cosas distintas, y decir la segunda cuando pasó la primera es afirmar algo que nadie sabe.
      setError(errorMessage(e));
      setFase('error');
    }
  }, [tramiteId, estadoFila]);

  useEffect(() => { void cargar(); }, [cargar]);

  const titulo = `Facturación electrónica · ${idFlit}`;

  if (fase === 'cargando') {
    return (
      <FlitModal title={titulo} onClose={onClose} wide>
        <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }} role="status">
          Consultando el estado de la facturación electrónica de este trámite…
        </p>
      </FlitModal>
    );
  }

  if (fase === 'error') {
    return (
      <FlitModal title={titulo} onClose={onClose} wide>
        <div className="space-y-3 text-sm">
          <p style={{ color: 'var(--flit-danger-ink)' }} role="alert">
            No se pudo consultar la facturación electrónica de este trámite: {error}
          </p>
          {/* Con reintento, y por eso el error es un estado y no un aviso: el fallo más común aquí
              es de red, y volver a pedirlo cuesta un clic frente a cerrar y repetir el camino. */}
          <button type="button" className={flitBtnSecondarySm}
            style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}
            onClick={() => void cargar()}>
            Reintentar
          </button>
        </div>
      </FlitModal>
    );
  }

  // Lo que esta historia añade al contenido de la ficha. Va arriba del todo porque es lo accionable:
  // si algo hay que mirar o arreglar, se ve sin desplazarse.
  const extra = (
    <>
      <MarcaRevisionFactura requiereRevision={requiereRevision} />
      {(ficha?.estado ?? estadoFila) === 'fallido' && <FalloEmision cola={cola} />}
    </>
  );

  if (ficha) {
    return (
      <FichaFacturacion ficha={ficha} idFlit={idFlit} puedeOperar={puedeOperar}
        extra={extra} onClose={onClose} onCambio={onCambio} />
    );
  }

  return (
    <FlitModal title={titulo} onClose={onClose} wide>
      <div className="space-y-3 text-sm">
        {estadoFila === 'no_enviado' ? (
          // El estado VACÍO del AC2, y dice «aún no se ha enviado» en vez de «no hay datos»: son
          // dos frases distintas y solo una es cierta. La segunda haría pensar en algo que se
          // perdió; lo que pasa es que este trámite todavía no ha llegado a ese punto del ciclo.
          <>
            <p style={{ color: 'var(--flit-text-primary)' }}>
              A este trámite <strong>todavía no se le ha pedido factura electrónica</strong>.
            </p>
            <p style={{ color: 'var(--flit-text-secondary)' }}>
              No es un fallo ni un dato que falte: es el punto del ciclo en el que está. La emisión
              se pide desde el reporte, con «Enviar a facturación electrónica», y solo sobre
              trámites ya liquidados y marcados como facturados.
            </p>
          </>
        ) : (
          // Hay estado pero no hay documento: el caso de un trámite en cola. Se dice lo que se
          // sabe —que la orden ya salió— en vez de enseñar el vacío de «nunca se pidió», que aquí
          // sería falso.
          <>
            <StatusChip tone={TONO_CHIP_ESTADO[estadoFila]}>
              {SIIGO_ESTADO_REPORTE_ETIQUETA[estadoFila]}
            </StatusChip>
            <p style={{ color: 'var(--flit-text-secondary)' }}>
              La orden ya salió y todavía no hay documento en Siigo, así que no hay ficha que
              mostrar. En cuanto la factura exista, este detalle se llena solo.
            </p>
            {extra}
          </>
        )}
      </div>
    </FlitModal>
  );
}

/** La fila de cola del trámite, o `null` si no tiene ninguna. Un 200 con lista vacía es normal. */
async function colaDe(tramiteId: string): Promise<SiigoColaItem | null> {
  const q = new URLSearchParams({ tramiteIds: tramiteId });
  const r = await api.get<{ items: { tramiteId: string; cola: SiigoColaItem }[] }>(
    `/siigo/facturacion?${q}`);
  return r.items.find((i) => i.tramiteId === tramiteId)?.cola ?? null;
}
