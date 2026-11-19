// FLITO — canal Cliente del SOAT: la barra de envío de la solicitud, ANCLADA al borde inferior (HU #14019,
// docs/ux/flito-soat-cliente-tipo-renovacion-slim.md §3.5 y §3.6).
//
// Antes era una tarjeta flotante (`sticky bottom-2 lg:bottom-[5.5rem]`) que tapaba contenido al entrar.
// Ahora es una banda de ANCHO COMPLETO del área de contenido (rompe el padding de `<main>` con márgenes
// negativos) que se pega al borde inferior del viewport y, en `lg`, queda por ENCIMA del menú flotante del
// shell (`FlitNavBar`: `fixed bottom-0 pb-5` + cápsula de ~56 px → 5,5 rem). Es `sticky` y no `fixed`: ocupa
// su sitio al final del formulario, así que el espacio al pie está reservado por construcción y, al llegar
// al final, es la MISMA barra en su lugar (no aparece una segunda). `scroll-padding-bottom` evita que el
// foco por teclado quede oculto tras la banda.
//
// <lg se apila con la primaria arriba, luego «Cancelar» y la frase de lo que falta.

import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Save, Send } from 'lucide-react';
import {
  flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../../flit/flitPageKit';
import { useDrFlitVisible } from '../../drflit/useDrFlitVisible';

/** Id de la línea que enumera lo que falta, para el `aria-describedby` del primario. */
export const ID_FALTANTES = 'sol-falta';

/**
 * El rótulo del primario de la SOLICITUD (HU #14019, decisión final del humano): «Enviar solicitud».
 * El Cliente no «envía al gestor» (jerga del proceso interno): envía una solicitud. Solo esta pantalla:
 * la cola (`BarraEnvioSoat`) y Impuestos conservan el suyo.
 */
export const ROTULO_ENVIAR = 'Enviar solicitud';
/** HU #12996 (UX §2.2, literal): rótulo del primario en «modo RUNT caído». */
export const ROTULO_GUARDAR = 'Guardar pendiente de validar';

export default function BarraEnvioSolicitud({
  colaHref, envioIncierto, avisoEnvio, modoCaido, enviando, textoEnviandoAdicionales, fraseFaltantes,
  bloqueado, onCancelar, onEnviar,
}: {
  colaHref: string;
  envioIncierto: boolean;
  avisoEnvio: string | null;
  modoCaido: boolean;
  enviando: boolean;
  /** Con documentos adicionales el envío es largo: el texto de progreso reemplaza al anuncio mudo. */
  textoEnviandoAdicionales: string | null;
  fraseFaltantes: string | null;
  bloqueado: boolean;
  onCancelar: () => void;
  onEnviar: () => void;
}) {
  // <lg el botón flotante de Dr. Flit vive en la esquina inferior derecha: la banda le reserva el sitio (como `<main>`).
  const reservaDrFlit = useDrFlitVisible();
  // El foco por teclado no debe quedar tras la banda: reserva la altura de la banda + el dock del shell.
  useEffect(() => {
    const raiz = document.documentElement;
    const previo = raiz.style.scrollPaddingBottom;
    raiz.style.scrollPaddingBottom = '12rem';
    return () => { raiz.style.scrollPaddingBottom = previo; };
  }, []);

  return (
    <div data-barra-envio className="sticky bottom-0 z-20 -mx-4 sm:-mx-6 lg:-mx-8 lg:bottom-[5.5rem]">
      <div
        className={`bg-flit-card px-4 py-3 sm:px-6 lg:px-8 ${reservaDrFlit ? 'max-lg:pr-20' : ''}`}
        style={{ borderTop: '1px solid var(--flit-border-soft)', borderBottom: '1px solid var(--flit-border-soft)' }}
      >
        {envioIncierto
          ? (
            <div className="space-y-2">
              <p role="alert" className="text-sm font-semibold" style={{ color: 'var(--flit-danger-text)' }}>
                No sabemos si la solicitud llegó a FLITO. Vuelva a sus SOAT y busque ese VIN antes de volver a enviarla.
              </p>
              <Link to={colaHref} className={flitBtnSecondary} style={flitBtnSecondaryStyle}>Volver a mis SOAT</Link>
            </div>
          )
          : (
            <div className="space-y-2">
              {avisoEnvio && (
                <p role="alert" className="text-sm font-semibold" style={{ color: 'var(--flit-danger-text)' }}>{avisoEnvio}</p>
              )}
              {enviando && (textoEnviandoAdicionales
                ? <p role="status" className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{textoEnviandoAdicionales}</p>
                : <span role="status" className="sr-only">{modoCaido ? 'Guardando…' : 'Enviando…'}</span>)}
              <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between lg:gap-4">
                {/* **Texto plano con `id`, no una región viva.** El botón la referencia con
                    `aria-describedby` mientras está bloqueado, así que el lector anuncia «Enviar
                    solicitud, no disponible, Para enviar falta: …» cuando el foco LLEGA al botón, que
                    es cuando importa. Una `role="status"` aquí se reanunciaría con cada pulsación de
                    tecla del formulario. En <lg va al final (order-3); en lg, a la izquierda. */}
                <div className="order-3 min-w-0 space-y-0.5 lg:order-1 lg:flex-1">
                  {fraseFaltantes && (
                    <p id={ID_FALTANTES} className="line-clamp-2 text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
                      {fraseFaltantes}
                    </p>
                  )}
                  {!modoCaido && (
                    <p className="hidden text-[11px] sm:block" style={{ color: 'var(--flit-text-secondary)' }}>
                      No se guarda como borrador: al enviarla, entra en gestión.
                    </p>
                  )}
                </div>
                {/* DOM: Cancelar y luego el primario (orden de tabulación de siempre). <lg se invierte
                    la columna para que la primaria quede ARRIBA. */}
                <div className="order-1 flex flex-col-reverse gap-2 lg:order-2 lg:flex-row">
                  <button type="button" className={`${flitBtnSecondary} w-full justify-center lg:w-auto`} style={flitBtnSecondaryStyle} onClick={onCancelar}>
                    Cancelar
                  </button>
                  {/* **`aria-disabled` y no `disabled`, y es una decisión de accesibilidad.** Un botón
                      `disabled` sale del recorrido de tabulación: quien navega con teclado llega al
                      final del formulario y el primario simplemente NO EXISTE, sin explicación. Con
                      `aria-disabled` el lector anuncia «no disponible», el foco lo alcanza y al
                      pulsarlo la pantalla lo lleva a la acción que sí toca. La atenuación va EXPLÍCITA
                      porque `aria-disabled` no dispara las variantes `disabled:` de Tailwind. */}
                  <button
                    type="button" className={`${flitBtnPrimary} w-full justify-center lg:w-auto`}
                    style={bloqueado ? { ...flitBtnPrimaryStyle, opacity: 0.5, cursor: 'not-allowed' } : flitBtnPrimaryStyle}
                    aria-disabled={bloqueado ? true : undefined}
                    aria-describedby={bloqueado && fraseFaltantes ? ID_FALTANTES : undefined}
                    disabled={enviando} onClick={onEnviar}
                  >
                    {modoCaido
                      ? <Save size={16} aria-hidden="true" className="shrink-0" />
                      : <Send size={16} aria-hidden="true" className="shrink-0" />}
                    {enviando ? (modoCaido ? 'Guardando…' : 'Enviando…') : (modoCaido ? ROTULO_GUARDAR : ROTULO_ENVIAR)}
                  </button>
                </div>
              </div>
            </div>
          )}
      </div>
    </div>
  );
}
