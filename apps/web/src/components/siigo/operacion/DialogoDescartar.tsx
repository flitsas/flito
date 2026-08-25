// AC5 — «dar por perdido exige motivo, y no se confirma sin él».
//
// EL MOTIVO ES UN CATÁLOGO CERRADO, NO TEXTO LIBRE. No es una preferencia de estilo:
// `siigo_operaciones` es WORM por disparador desde la migración `0126` —prohíbe UPDATE y DELETE—, así
// que un NIT, un nombre o un teléfono tecleados ahí NO SE PUEDEN RECTIFICAR NI SUPRIMIR JAMÁS, y eso
// deja sin efecto los derechos del titular de la Ley 1581 art. 8 (lits. d y e). El servidor valida
// contra el MISMO array (`z.enum(SIIGO_BANDEJA_MOTIVOS_DESCARTE)`), así que la pantalla no es la
// única defensa; lo que no puede es debilitarla ofreciendo algo que el catálogo no tiene.
//
// **No hay opción «Otro», y es deliberado** (lo dice el propio contrato): un cajón «otro» con una
// nota al lado es texto libre con otro nombre. Si falta un motivo se añade al catálogo, que es
// ADITIVO; quitarlo después, cuando ya hay filas que nadie puede tocar, no lo es.
//
// **Radios y no un `<select>`.** Con cinco opciones que tienen consecuencias distintas, un
// desplegable esconde cuatro de cinco justo en el momento de decidir. Y sin preselección: una opción
// marcada por defecto es una respuesta que nadie dio.

import { useId, useState } from 'react';
import {
  SIIGO_BANDEJA_MOTIVO_DESCARTE_ETIQUETA, SIIGO_BANDEJA_MOTIVOS_DESCARTE, SIIGO_BANDEJA_NOTA_MAX,
} from '@operaciones/shared-types';
import type {
  SiigoBandejaItem, SiigoBandejaMotivoDescarte, SiigoBandejaRespuestaDescarte,
} from '@operaciones/shared-types';
import type { RefObject } from 'react';
import { api, errorMessage } from '../../../lib/api';
import FlitModal from '../../flit/FlitModal';
import {
  flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../../flit/flitPageKit';
import { inputCls } from '../estilos';
import { etiquetaCaso } from './tipos';

interface Props {
  caso: SiigoBandejaItem;
  onCerrar: () => void;
  onHecho: (respuesta: SiigoBandejaRespuestaDescarte) => void;
  restoreFocusRef: RefObject<HTMLElement | null>;
}

export default function DialogoDescartar({ caso, onCerrar, onHecho, restoreFocusRef }: Props) {
  const [motivo, setMotivo] = useState<SiigoBandejaMotivoDescarte | null>(null);
  const [nota, setNota] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idNota = useId();
  const idAvisoNota = `${idNota}-aviso`;
  const idExigencia = `${idNota}-exigencia`;

  const enviar = async () => {
    if (!motivo) return;
    setEnviando(true);
    setError(null);
    try {
      // El cuerpo lleva la CLAVE del catálogo, nunca la etiqueta visible.
      const r = await api.post<SiigoBandejaRespuestaDescarte>('/siigo/bandeja/descartar', {
        fuente: caso.fuente,
        refId: caso.refId,
        motivo,
        ...(nota.trim() ? { nota: nota.trim() } : {}),
      });
      onHecho(r);
    } catch (e) {
      setError(errorMessage(e));
      setEnviando(false);
    }
  };

  return (
    <FlitModal
      title={`Dar por perdido · ${etiquetaCaso(caso)}`}
      onClose={onCerrar}
      wide
      restoreFocusRef={restoreFocusRef}
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
          Este caso deja de reintentarse. Se puede volver a poner en la cola más adelante, pero el
          registro de por qué se dio por perdido <strong>no se podrá editar ni borrar nunca</strong>.
        </p>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            Motivo (obligatorio)
          </legend>
          {SIIGO_BANDEJA_MOTIVOS_DESCARTE.map((m) => (
            <label key={m} className="flex items-start gap-2 text-sm" style={{ color: 'var(--flit-text-primary)' }}>
              <input
                type="radio"
                name="motivo-descarte"
                className="flit-focus mt-0.5"
                value={m}
                checked={motivo === m}
                onChange={() => setMotivo(m)}
              />
              <span>{SIIGO_BANDEJA_MOTIVO_DESCARTE_ETIQUETA[m]}</span>
            </label>
          ))}
        </fieldset>

        <div>
          <label htmlFor={idNota} className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            Nota (opcional)
          </label>
          <textarea
            id={idNota}
            className={inputCls}
            rows={2}
            maxLength={SIIGO_BANDEJA_NOTA_MAX}
            value={nota}
            aria-describedby={idAvisoNota}
            onChange={(e) => setNota(e.target.value)}
          />
          {/* El aviso va JUNTO al campo y antes del contador: se lee antes de escribir, no después. */}
          <p id={idAvisoNota} className="mt-1 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
            <span aria-hidden="true">⚠ </span>
            No escribas nombres, cédulas, NIT, teléfonos ni correos: esta nota queda grabada para
            siempre y no se puede corregir. {nota.length}/{SIIGO_BANDEJA_NOTA_MAX}
          </p>
        </div>

        {error && (
          <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>{error}</p>
        )}

        {/*
          Un botón `disabled` no puede explicarse solo: sale del orden de tabulación, así que su
          `title` y su `aria-describedby` son inalcanzables por teclado y por lector. La exigencia
          vive en una región VIVA que se monta siempre y solo cambia de contenido —el mismo patrón
          que documenta `FlitSelect`—, así que elegir un motivo se anuncia como un cambio de estado
          en vez de esperar a un clic que el botón inhabilitado nunca va a recibir.
        */}
        <div className="flex flex-wrap items-center justify-end gap-3">
          <span id={idExigencia} role="status" className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
            {motivo
              ? 'Motivo elegido: ya se puede confirmar.'
              : 'Elige un motivo para poder confirmar.'}
          </span>
          <button type="button" onClick={onCerrar} className={flitBtnSecondary} style={flitBtnSecondaryStyle}>
            Cancelar
          </button>
          {/* La acción irreversible, siempre la última en el orden de foco. */}
          <button
            type="button"
            onClick={enviar}
            disabled={!motivo || enviando}
            aria-describedby={idExigencia}
            className={flitBtnPrimary}
            style={flitBtnPrimaryStyle}
          >
            {enviando ? 'Guardando…' : 'Dar por perdido'}
          </button>
        </div>
      </div>
    </FlitModal>
  );
}
