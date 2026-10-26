import { useId, useState, type FormEvent, type Ref } from 'react';
import { flitBtnPrimary, flitBtnPrimaryStyle, flitInp } from '../flit/flitPageKit';
import { MAX_PREGUNTA } from '../../lib/drFlitConversacion';

// Dr. Flit — caja «Escriba su pregunta» del pie (HU #13766 AC6/AC9; spec UX «Tengo una pregunta»).
// Vacía o solo espacios: Enviar no envía (ni con Enter). `maxLength` = 300 y contador desde 250.
// `aria-disabled` y no `disabled` en Enviar: al vaciarse la caja tras enviar, el foco no cae al `body`.
// El texto nunca sale de aquí salvo por `onEnviar` (nada a red ni a consola, AC7).

const CONTADOR_DESDE = 250;

export interface DrFlitPreguntaProps {
  /** Recibe el texto ya recortado y no vacío. */
  onEnviar: (texto: string) => void;
  /** Dr. Flit está buscando: la caja sigue editable, Enviar no envía. */
  ocupado: boolean;
  inputRef?: Ref<HTMLInputElement>;
  /** HU #13836 («Volver a consultar»): pista sobre la caja hasta el próximo envío. */
  pista?: string;
  /**
   * HU #13857 (IA.3): líneas bajo la caja (privacidad y cupo de la IA), ligadas a la caja por
   * `aria-describedby` junto al contador. Sin IA en uso no se pasa nada (AC10).
   */
  notas?: readonly string[];
  /** HU #13942: rótulo de la caja; sin IA ni gestión es «Buscar en los manuales». */
  etiqueta?: string;
}

export default function DrFlitPregunta({
  onEnviar, ocupado, inputRef, pista, notas = [], etiqueta = 'Escriba su pregunta',
}: DrFlitPreguntaProps) {
  const [texto, setTexto] = useState('');
  const id = useId();
  const idCampo = `${id}-pregunta`;
  const idContador = `${id}-contador`;
  const idPista = `${id}-pista`;
  const limpio = texto.trim();
  const inactivo = ocupado || !limpio;
  const largo = texto.length;
  const idsNotas = notas.map((_, i) => `${id}-nota-${i}`);
  const describe = [pista ? idPista : '', ...idsNotas, largo >= CONTADOR_DESDE ? idContador : '']
    .filter(Boolean).join(' ');

  const enviar = (e: FormEvent) => {
    e.preventDefault();
    if (inactivo) return;
    onEnviar(limpio.slice(0, MAX_PREGUNTA));
    setTexto('');
  };

  return (
    <form onSubmit={enviar} className="w-full" noValidate>
      <label htmlFor={idCampo} className="mb-1 block text-xs font-medium text-flit-secondary">
        {etiqueta}
      </label>
      {pista && (
        <p id={idPista} className="mb-2 text-xs text-flit-secondary">
          {pista}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          id={idCampo}
          type="text"
          value={texto}
          onChange={(e) => setTexto(e.target.value.slice(0, MAX_PREGUNTA))}
          maxLength={MAX_PREGUNTA}
          autoComplete="off"
          aria-describedby={describe || undefined}
          className={`${flitInp} h-10 min-w-0 flex-1 basis-48 py-0`}
          // 16 px: evita el zoom automático de iOS al enfocar (spec UX, móvil).
          style={{ fontSize: '16px' }}
        />
        <button
          type="submit"
          aria-disabled={inactivo || undefined}
          className={`${flitBtnPrimary} shrink-0 justify-center max-[340px]:w-full`}
          style={flitBtnPrimaryStyle}
        >
          Enviar
        </button>
      </div>
      {notas.map((nota, i) => (
        <p key={idsNotas[i]} id={idsNotas[i]} className="mt-1 break-words text-xs text-flit-secondary">
          {nota}
        </p>
      ))}
      {largo >= CONTADOR_DESDE && (
        <p id={idContador} className="mt-1 text-xs text-flit-secondary">
          {largo}/{MAX_PREGUNTA}
        </p>
      )}
      <p aria-live="polite" className="text-xs text-flit-secondary">
        {largo >= MAX_PREGUNTA ? `Llegó al máximo de ${MAX_PREGUNTA} caracteres.` : ''}
      </p>
    </form>
  );
}
