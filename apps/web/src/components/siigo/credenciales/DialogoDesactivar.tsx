// Baja de una credencial de Siigo (HU #11890, AC4).
//
// `FlitModal` y no `window.confirm()` —como sí hace `RndcAdminCredenciales.tsx`—: allí la pregunta
// cabía en una línea; aquí hacen falta tres párrafos con jerarquía (la consecuencia, el ambiente y
// la promesa de que el historial sobrevive), y `confirm()` no da formato, ni foco restaurado, ni
// tono visual, ni una frase distinta según el ambiente.
//
// El foco inicial va a **Cancelar**: es una acción destructiva y la tecla Intro por inercia no
// puede ejecutarla.

import { useEffect, useRef, useState, type RefObject } from 'react';
import { ApiError, api, errorMessage } from '../../../lib/api';
import FlitModal from '../../flit/FlitModal';
import { flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';
import { AMBIENTE_EN_FRASE, ETIQUETA_AMBIENTE, type Ambiente, type SiigoCredencialPublica } from './tipos';

interface Props {
  ambiente: Ambiente;
  credencial: SiigoCredencialPublica;
  onCerrar: () => void;
  /** Desactivada (o ya no existía): la pantalla recarga el listado y anuncia el resultado. */
  onDesactivada: (aviso: string) => void;
  restoreFocusRef: RefObject<HTMLElement | null>;
}

export default function DialogoDesactivar(
  { ambiente, credencial, onCerrar, onDesactivada, restoreFocusRef }: Props,
) {
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refCancelar = useRef<HTMLButtonElement>(null);

  useEffect(() => { refCancelar.current?.focus(); }, []);

  const desactivar = async () => {
    if (enviando) return;
    setEnviando(true);
    setError(null);
    try {
      await api.delete(`/siigo/credenciales/${credencial.id}`);
      onDesactivada(`Credencial de ${AMBIENTE_EN_FRASE[ambiente]} desactivada.`);
    } catch (e) {
      // 404 no es un error de quien pulsa: es que la lista estaba vieja. Se recarga y se dice.
      if (e instanceof ApiError && e.status === 404) {
        onDesactivada('No se pudo desactivar: esta credencial ya no existe. Se actualizó la lista.');
        return;
      }
      setError(`No se pudo desactivar: ${errorMessage(e)}.`);
    } finally {
      setEnviando(false);
    }
  };

  return (
    <FlitModal
      title={`Desactivar la credencial de ${ETIQUETA_AMBIENTE[ambiente]}`}
      onClose={onCerrar}
      restoreFocusRef={restoreFocusRef}
    >
      <div className="flex flex-col gap-3 text-sm" style={{ color: 'var(--flit-text-primary)' }}>
        {/* El usuario va en un nodo de TEXTO: suele ser un correo, y los informes de axe de este
            repo arrastran valores de atributo (AGENTS.md §14). */}
        <p>Usuario: {credencial.username}</p>
        <p>
          {ambiente === 'produccion'
            ? 'Desde que la desactives, FLITO no podrá emitir ninguna factura en producción hasta que registres otra credencial.'
            : 'Desde que la desactives, FLITO no podrá conectarse a Siigo en pruebas hasta que registres otra credencial.'}
        </p>
        <p>El registro no se borra: queda en el historial de este ambiente con la fecha de hoy.</p>

        {error && (
          <p role="alert" className="text-sm font-semibold" style={{ color: 'var(--flit-danger-ink)' }}>
            <span aria-hidden="true">⚠ </span>{error}
          </p>
        )}

        <div className="mt-1 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            ref={refCancelar}
            onClick={onCerrar}
            className={flitBtnSecondary}
            style={flitBtnSecondaryStyle}
          >
            Cancelar
          </button>
          {/* Tinta de peligro (no `--flit-danger`, que es para bordes) y `flit-focus` explícito: el
              botón equivalente de RNDC es un `text-xs hover:underline` SIN foco visible, y ese
              defecto conocido no se importa a una pantalla nueva. */}
          <button
            type="button"
            onClick={() => { void desactivar(); }}
            disabled={enviando}
            className="flit-focus inline-flex h-10 items-center rounded-[999px] border bg-white px-5 text-sm font-semibold disabled:opacity-50"
            style={{ borderColor: 'var(--flit-danger)', color: 'var(--flit-danger-ink)' }}
          >
            {enviando ? 'Desactivando…' : 'Desactivar'}
          </button>
        </div>
      </div>
    </FlitModal>
  );
}
