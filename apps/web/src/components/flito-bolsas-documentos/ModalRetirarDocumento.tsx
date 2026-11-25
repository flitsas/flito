// Confirmación para quitar la versión vigente de un documento del expediente (HU #13964).
// Spec: docs/ux/hu-13964-quitar-version-vigente.md. Contrato: ADR-0028, adenda HU #13964 (E7).
//
// Los errores que se corrigen o reintentan aquí (400/403/429/red) van en línea con `role="alert"` y
// conservan el motivo. La carrera (409/404) cierra el modal, avisa por toast y relee el expediente.
// Se decide por `status`, nunca por el texto del API.
import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import {
  MOTIVO_RETIRO_DOCUMENTO_BOLSA_MAX, type DocumentoBolsaDto, type DocumentoExpedienteDto,
} from '@operaciones/shared-types';
import { bolsasDocumentosApi } from '../../lib/api';
import { errorBolsa } from '../../lib/bolsas';
import { nombreDocumento } from '../../lib/bolsasDocumentos';
import FlitModal from '../flit/FlitModal';
import { flitBtnPrimary, flitBtnSecondary, flitInp } from '../flit/flitPageKit';
import { toastError, toastOk } from '../flit/ToastFlito';

type ErrorRetiro = { texto: string; bloquea: boolean };

export interface ModalRetirarDocumentoProps {
  doc: DocumentoExpedienteDto;
  vigente: DocumentoBolsaDto;
  onCerrar: () => void;
  /** Retiro aceptado: la fila toma la respuesta de E7 sin releer. */
  onRetirado: (fila: DocumentoExpedienteDto) => void;
  /** 409/404: el documento o la bolsa cambiaron; relee el expediente. */
  onCarrera: () => void;
  /** Destino del foco si «Quitar» ya no está en el DOM (tras el éxito): el control «Cargar» de la fila. */
  focoRespaldoRef: RefObject<HTMLElement | null>;
}

const MAX = MOTIVO_RETIRO_DOCUMENTO_BOLSA_MAX;

export default function ModalRetirarDocumento(p: ModalRetirarDocumentoProps) {
  const { doc, vigente } = p;
  const nombre = nombreDocumento(doc.tipo);
  const id = useId();
  const idAyuda = `${id}-ayuda`;
  const idContador = `${id}-contador`;
  const idError = `${id}-error`;
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<ErrorRetiro | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const montado = useRef(true);

  // La trampa de foco del modal enfoca el diálogo en su efecto (que corre después del de este hijo):
  // el textarea toma el foco en el fotograma siguiente.
  useEffect(() => {
    montado.current = true;
    const raf = requestAnimationFrame(() => textarea.current?.focus());
    return () => { montado.current = false; cancelAnimationFrame(raf); };
  }, []);

  async function confirmar() {
    if (enviando) return;
    setEnviando(true);
    setError(null);
    const limpio = motivo.trim();
    try {
      const fila = await bolsasDocumentosApi.retirar(vigente.id, limpio ? { motivo: limpio } : {});
      toastOk(`${nombre} quedó pendiente. La versión ${vigente.version} queda en el historial como retirada.`,
        { id: `bolsa-doc-retiro-${doc.tipo}`, duracionMs: 6_000 });
      p.onRetirado(fila);
      p.onCerrar();
    } catch (e) {
      if (!montado.current) return;
      const { status } = errorBolsa(e);
      if (status === 409 || status === 404) {
        toastError('Algo cambió mientras quitabas la versión: el documento o la bolsa se actualizaron. Ya refrescamos el expediente; revísalo e intenta de nuevo.',
          undefined, { id: `bolsa-doc-retiro-${doc.tipo}`, duracionMs: 8_000 });
        p.onCerrar();
        p.onCarrera();
        return;
      }
      if (status === 400) setError({ texto: 'No pudimos guardar el motivo. Revisa que no pase de 300 caracteres e intenta de nuevo.', bloquea: false });
      else if (status === 403) setError({ texto: 'Ya no tienes permiso para quitar documentos.', bloquea: true });
      else if (status === 429) setError({ texto: 'Hiciste muchos cambios seguidos. Espera unos minutos e intenta de nuevo.', bloquea: false });
      else setError({ texto: 'No pudimos quitar la versión. Revisa tu conexión e intenta de nuevo.', bloquea: false });
      setEnviando(false);
    }
  }

  const describedBy = [idAyuda, idContador, error ? idError : null].filter(Boolean).join(' ');

  return (
    <FlitModal title="¿Quitar la versión vigente?" onClose={p.onCerrar} cierreBloqueado={enviando}
      restoreFocusRef={p.focoRespaldoRef}>
      <form noValidate data-testid="modal-retirar-documento"
        onSubmit={(e) => { e.preventDefault(); void confirmar(); }}>
        <p className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
          {nombre} queda pendiente hasta que cargues una nueva. La versión {vigente.version} se conserva en el
          historial como retirada y la puedes seguir descargando.
        </p>
        {!doc.opcional && (
          <p className="mt-2 text-sm" style={{ color: 'var(--flit-text-primary)' }}>
            El expediente de la compañía queda incompleto.
          </p>
        )}

        <label htmlFor={`${id}-motivo`} className="mb-1 mt-4 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
          Motivo (opcional)
        </label>
        <textarea ref={textarea} id={`${id}-motivo`} rows={3} maxLength={MAX} className={`${flitInp} resize-y`}
          value={motivo} readOnly={enviando}
          aria-describedby={describedBy} aria-invalid={error && !error.bloquea ? true : undefined}
          onChange={(e) => setMotivo(e.target.value.slice(0, MAX))} />
        <div className="mt-1 flex flex-wrap items-start justify-between gap-x-3 gap-y-1 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
          <p id={idAyuda} className="min-w-0 flex-1">Queda registrado en el historial. No escribas datos personales.</p>
          <p id={idContador} className="shrink-0 tabular-nums" data-testid="contador-motivo">{motivo.length}/{MAX}</p>
        </div>

        {error && (
          <p id={idError} role="alert" className="mt-3 text-sm" style={{ color: 'var(--flit-danger-text)' }}>{error.texto}</p>
        )}

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button type="button" className={flitBtnSecondary} disabled={enviando} onClick={p.onCerrar}>
            Cancelar
          </button>
          <button type="submit" className={flitBtnPrimary} style={{ background: 'var(--flit-gradient-danger)' }}
            // `aria-disabled` y no `disabled` mientras envía: así el foco se queda en el botón (spec) y
            // el candado de `confirmar` impide el doble envío.
            disabled={error?.bloquea ?? false} aria-disabled={enviando || undefined} aria-busy={enviando || undefined}>
            {enviando ? 'Quitando…' : 'Quitar versión'}
          </button>
        </div>
      </form>
    </FlitModal>
  );
}
