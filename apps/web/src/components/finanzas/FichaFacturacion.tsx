// Reporte de costos — la ficha de facturación electrónica de un trámite (HU #11337).
//
// Cubre los AC3 a AC6: en qué punto está ante la DIAN, por qué la rechazaron si la rechazaron,
// reenviar el correo y descargar el PDF y el XML.
//
// DOS DECISIONES QUE SE NOTAN AL USARLA
//
//   1. **La verificación ante la DIAN no es un botón que espera.** La DIAN no responde al instante:
//      entre el envío y su respuesta pasan minutos u horas. Un botón «Consultar estado» que se
//      quedara girando mentiría sobre lo que hace y bloquearía a quien lo pulsó. Lo que la pantalla
//      muestra es CUÁNDO se comprobó por última vez y que la comprobación corre sola — que es la
//      verdad, y además la única respuesta útil.
//   2. **Lo que no se puede hacer se explica, no se esconde.** Un botón ausente obliga a adivinar
//      por qué falta. Uno deshabilitado con su motivo dice qué hay que arreglar para habilitarlo.

import { useCallback, useEffect, useState } from 'react';
import { SIIGO_ESTADO_REPORTE_ETIQUETA } from '@operaciones/shared-types';
import { api, errorMessage } from '../../lib/api';
import FlitModal from '../flit/FlitModal';
import StatusChip from '../flit/StatusChip';
import { flitBtnSecondarySm } from '../flit/flitPageKit';
import { fechaCorta, type FacturacionTramite, type ResumenEnvios } from './tiposFacturacion';

interface Props {
  ficha: FacturacionTramite;
  idFlit: string;
  /** Separa lectura de escritura, como ya hace la pantalla con `puedeLiquidar` (AC1). */
  puedeOperar: boolean;
  onClose: () => void;
  /** Para que la fila del reporte se entere de que el envío cambió el historial. */
  onCambio?: () => void;
}

export default function FichaFacturacion({ ficha, idFlit, puedeOperar, onClose, onCambio }: Props) {
  const [envios, setEnvios] = useState<ResumenEnvios | null>(null);
  const [cargandoEnvios, setCargandoEnvios] = useState(true);
  const [errorEnvios, setErrorEnvios] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  // `useCallback` y no un `eslint-disable`: la función se usa en el efecto Y en el botón de
  // reintentar, así que declararla estable es lo correcto, no un rodeo para callar al linter. Un
  // `disable` aquí habría escondido que la dependencia faltaba de verdad.
  const cargarEnvios = useCallback(async () => {
    setCargandoEnvios(true);
    setErrorEnvios(null);
    try {
      // `encodeURIComponent` aunque el backend valide el UUID: el escapado en el punto donde se
      // construye la ruta no depende de que quien la reciba siga validando igual mañana.
      setEnvios(await api.get<ResumenEnvios>(
        `/siigo/envios/factura/${encodeURIComponent(ficha.facturaId)}`));
    } catch (e) {
      // El fallo NO se traga con una lista vacía: «no se pudo consultar» y «nunca se envió» son
      // cosas distintas, y decir la segunda cuando pasó la primera es afirmar algo que nadie sabe.
      setErrorEnvios(errorMessage(e));
    } finally {
      setCargandoEnvios(false);
    }
  }, [ficha.facturaId]);

  useEffect(() => { void cargarEnvios(); }, [cargarEnvios]);

  async function reenviar() {
    setEnviando(true);
    setAviso(null);
    try {
      const acta = await api.post<{ resultado: string; motivo: string | null }>(
        `/siigo/envios/factura/${encodeURIComponent(ficha.facturaId)}`, {},
      );
      // El servidor responde 200 aunque el acta diga que no salió: la operación de REGISTRAR sí
      // ocurrió. Así que aquí se lee el resultado, no el código HTTP.
      setAviso(acta.resultado === 'enviado'
        ? 'La factura se envió al cliente.'
        : acta.motivo ?? 'El envío no se pudo realizar.');
      await cargarEnvios();
      onCambio?.();
    } catch (e) {
      setAviso(errorMessage(e));
    } finally {
      setEnviando(false);
    }
  }

  const emitida = ficha.estadoEmision === 'emitida';
  const sinDocumentos = !ficha.documentos.pdf && !ficha.documentos.xml;

  return (
    <FlitModal title={`Facturación electrónica · ${idFlit}`} onClose={onClose} wide>
      <div className="space-y-4 text-sm">

        {/* Estado y AC3 — cuándo se comprobó, sin prometer una consulta en vivo. */}
        <section className="flex flex-wrap items-center gap-3">
          <StatusChip tone={ficha.estado === 'aceptado' ? 'success'
            : ficha.estado === 'rechazado' || ficha.estado === 'fallido' ? 'danger'
              : ficha.estado === 'no_enviado' ? 'draft' : 'active'}>
            {SIIGO_ESTADO_REPORTE_ETIQUETA[ficha.estado]}
          </StatusChip>
          {ficha.numero && (
            <span style={{ color: 'var(--flit-text-secondary)' }}>Factura {ficha.numero}</span>
          )}
          <span className="ml-auto text-xs" style={{ color: 'var(--flit-text-muted)' }}>
            {ficha.verificadoEn
              ? `Última verificación ante la DIAN: ${fechaCorta(ficha.verificadoEn)}`
              : 'Todavía no se ha verificado ante la DIAN'}
          </span>
        </section>

        {/* AC3 — se dice que la comprobación corre sola, en vez de ofrecer un botón que espera. */}
        {emitida && ficha.estadoDian !== 'aceptada' && ficha.estadoDian !== 'rechazada' && (
          <p className="rounded-lg px-3 py-2 text-xs"
            style={{ background: 'rgba(79, 116, 201, 0.08)', color: 'var(--flit-blue-text)' }}>
            La verificación ante la DIAN está en curso y se repite sola cada pocos minutos. La DIAN
            no responde al instante, así que el estado se actualizará aquí en cuanto conteste — no
            hace falta esperar en esta pantalla.
          </p>
        )}

        {/* AC4 — un rechazo se explica; si el motivo no está, se dice. */}
        {ficha.estado === 'rechazado' && (
          <section className="rounded-lg px-3 py-2"
            style={{ background: 'rgba(228, 61, 48, 0.08)' }}>
            <div className="mb-1 text-xs font-semibold" style={{ color: 'var(--flit-danger)' }}>
              Motivo del rechazo
            </div>
            {ficha.motivo
              ? <p style={{ color: 'var(--flit-text-primary)' }}>{ficha.motivo}</p>
              : ficha.motivoPendiente
                ? (
                  <p style={{ color: 'var(--flit-text-secondary)' }}>
                    El detalle todavía no se ha podido consultar en Siigo. Se reintenta solo; si
                    urge, el motivo está en Siigo Nube.
                  </p>
                )
                : (
                  <p style={{ color: 'var(--flit-text-secondary)' }}>
                    La DIAN la rechazó sin devolver detalle del error.
                  </p>
                )}
          </section>
        )}

        {/* AC5 — reenviar el correo, diciendo antes a dónde va. */}
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide"
            style={{ color: 'var(--flit-text-muted)' }}>Entrega al cliente</h3>

          {cargandoEnvios && <p style={{ color: 'var(--flit-text-secondary)' }}>Consultando envíos…</p>}

          {errorEnvios && (
            <div className="flex items-center gap-2">
              <span style={{ color: 'var(--flit-danger)' }}>No se pudo consultar: {errorEnvios}</span>
              <button type="button" className={flitBtnSecondarySm}
                style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}
                onClick={() => void cargarEnvios()}>Reintentar</button>
            </div>
          )}

          {!cargandoEnvios && !errorEnvios && envios && (
            <>
              <p style={{ color: 'var(--flit-text-secondary)' }}>
                {envios.vecesEnviado > 0
                  ? `Enviada ${envios.vecesEnviado} vez(ces). La última, el ${fechaCorta(envios.ultimoEnviado?.creadoEn ?? null)}.`
                  : 'Todavía no se ha entregado por correo.'}
              </p>

              {/* A dónde va, ANTES de confirmar. Sale del último acta: es lo que de verdad se usó. */}
              {envios.ultimo?.destinatarios?.length ? (
                <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
                  Se enviará a: {envios.ultimo.destinatarios.map((d) => d.correo).join(', ')}
                </p>
              ) : (
                <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
                  Se enviará al correo registrado en la ficha del cliente.
                </p>
              )}

              {puedeOperar && (
                <button
                  type="button"
                  className={`${flitBtnSecondarySm} mt-2`}
                  style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}
                  disabled={!emitida || enviando}
                  // El motivo del deshabilitado va en el `title`: un botón apagado sin explicación
                  // obliga a adivinar, y quien adivina suele culpar al sistema.
                  title={emitida
                    ? 'Vuelve a enviarle la factura al cliente'
                    : 'La factura todavía no existe en Siigo: primero tiene que emitirse'}
                  onClick={() => void reenviar()}
                >
                  {enviando ? 'Enviando…' : 'Reenviar correo'}
                </button>
              )}

              {aviso && (
                <p className="mt-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }} role="status">
                  {aviso}
                </p>
              )}
            </>
          )}
        </section>

        {/* AC6 — los documentos, o por qué todavía no están. */}
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide"
            style={{ color: 'var(--flit-text-muted)' }}>Documentos</h3>

          {sinDocumentos ? (
            <p style={{ color: 'var(--flit-text-secondary)' }}>
              {ficha.estado === 'aceptado'
                ? 'La DIAN ya la aceptó; el PDF y el XML se archivan solos en los próximos minutos.'
                : 'El PDF y el XML se archivan cuando la DIAN acepta la factura.'}
            </p>
          ) : (
            <p style={{ color: 'var(--flit-text-secondary)' }}>
              Archivados como soportes del trámite: {[
                ficha.documentos.pdf ? 'PDF' : null,
                ficha.documentos.xml ? 'XML' : null,
              ].filter(Boolean).join(' y ')}. Se descargan desde los soportes del trámite.
            </p>
          )}
        </section>

        {ficha.cufe && (
          <p className="break-all text-xs" style={{ color: 'var(--flit-text-muted)' }}>
            CUFE: {ficha.cufe}
          </p>
        )}
      </div>
    </FlitModal>
  );
}
