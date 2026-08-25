// AC4, segunda mitad — «si la integración está frenada, la acción aparece deshabilitada EXPLICANDO
// por qué».
//
// **Este banner es la explicación.** Un `disabled` saca el control del orden de tabulación, así que
// un `title` con el motivo es invisible para quien navega con teclado o con lector de pantalla. Lo
// que sí funciona es un texto permanente, visible y anunciado, y que el botón inhabilitado lo señale
// con `aria-describedby={ID_FRENO}`.
//
// **Los dos «reactivar» no comparten rótulo, y es la confusión más cara de esta pantalla:**
//   · «Reactivar la integración con Siigo» = levantar el freno. Afecta a TODA la facturación de la
//     empresa y solo lo puede un administrador (`requireRole('admin')` en `freno.routes.ts`).
//   · «Volver a intentarlo» = devolver a la cola UN caso dado por perdido (`POST /bandeja/reactivar`).
// Nunca aparecen las dos con el mismo nombre.

import { useState } from 'react';
import type { EstadoFrenoSiigo } from '@operaciones/shared-types';
import { api, errorMessage } from '../../../lib/api';
import { flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';
import { fecha } from '../estilos';

/** El `id` al que apuntan los `aria-describedby` de todo lo que el freno inhabilita. */
export const ID_FRENO = 'siigo-operacion-freno-motivo';

export default function BannerFreno(
  { freno, esAdmin, onReactivado }:
  { freno: EstadoFrenoSiigo | null; esAdmin: boolean; onReactivado: () => void },
) {
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sin freno —o con la consulta del freno caída— no se pinta nada y no se inhabilita nada. Un fallo
  // al PREGUNTAR por el freno no puede paralizar la operación: si de verdad está frenada, el POST
  // devolverá 503 con su motivo y ahí se dirá con la respuesta en la mano.
  if (!freno?.frenada) return null;

  const reactivar = async () => {
    setEnviando(true);
    setError(null);
    try {
      await api.post('/siigo/freno/reactivar', {});
      onReactivado();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setEnviando(false);
    }
  };

  const porcentaje = Math.round(freno.proporcion * 100);
  const umbral = Math.round(freno.umbral * 100);

  return (
    <div
      role="status"
      className="flex flex-col gap-2 p-4"
      style={{
        borderRadius: 'var(--flit-radius-card)',
        border: '1px solid var(--flit-warning-ink)',
        background: '#FDE8E3',
      }}
    >
      <p className="text-sm font-semibold" style={{ color: 'var(--flit-warning-ink)' }}>
        <span aria-hidden="true">⚠ </span>La integración con Siigo está frenada
      </p>
      <p id={ID_FRENO} className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
        {freno.frenadaDesde ? `Desde el ${fecha(freno.frenadaDesde)}. ` : ''}
        Falló el {porcentaje} % de las últimas {freno.total.toLocaleString('es-CO')} operaciones y el
        umbral es {umbral} %. Mientras esté frenada no se puede reintentar la emisión ni reenviar
        correos. Dar por perdido y registrar correcciones sí funcionan: no salen hacia Siigo.
        {esAdmin ? '' : ' Levantarlo lo hace un administrador.'}
      </p>
      {error && (
        <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>{error}</p>
      )}
      {esAdmin && (
        <div>
          <button
            type="button"
            onClick={reactivar}
            disabled={enviando}
            className={flitBtnSecondary}
            style={flitBtnSecondaryStyle}
          >
            {enviando ? 'Reactivando…' : 'Reactivar la integración con Siigo'}
          </button>
        </div>
      )}
    </div>
  );
}
