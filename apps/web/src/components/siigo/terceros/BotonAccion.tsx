// Un control que EXISTE pero no está disponible para este rol (HU #11299, AC1).
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
// ESTO NO ES UN CONTROL DE SEGURIDAD. Es una guía de interfaz.
//
// El AC1 dice que confirmar una ciudad y sincronizar terceros los hace **administración**. El
// servidor no dice exactamente eso: `POST /api/siigo/terceros/cliente/:id` está guardado con
// `exigirAccionSiigo('emitir')`, que resuelve a `['admin', 'financiera']`, así que financiera SÍ
// puede sincronizar llamando al endpoint. La pantalla implementa el AC —es el sentido seguro— y
// queda constancia de que es más estricta que el servidor. Cerrar esa divergencia (¿el endpoint
// pasa a exigir `admin`, o el AC admite a financiera?) es decisión de tech-lead/PO y está
// pendiente: **no se resuelve escondiendo botones**. Confirmar la ciudad sí coincide, porque
// `/clientes-ciudades/:id/confirmar` ya usa `requireRole('admin')`.
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// Por qué `aria-disabled` y no `disabled`: `disabled` saca el botón del orden de tabulación, así
// que quien navega con teclado o con lector nunca llega al control **ni a su explicación**. Con
// `aria-disabled` el botón se alcanza, se anuncia como no disponible y su `aria-describedby` dice
// por qué. La explicación se escribe UNA vez por bloque y todos sus botones la referencian:
// repetirla en cincuenta filas serían cincuenta anuncios idénticos.
//
// El estilo tampoco es el `disabled:opacity-50` del botón primario: al 50 % el texto blanco sobre
// el degradado no llega a 4,5:1. Se usa el secundario con `--flit-text-muted`, que sí cumple.

import type { CSSProperties, ReactNode } from 'react';
import { flitBtnSecondary, flitBtnSecondarySm, flitBtnSecondaryStyle } from '../../flit/flitPageKit';

interface Props {
  /** `id` del botón. Lo usa la cola de ciudades para encadenar el foco sin `forwardRef`. */
  id?: string;
  /** `false` = el rol no puede: el botón se pinta, se alcanza con Tab y no dispara nada. */
  permitido: boolean;
  /** `id` del párrafo que explica por qué no está disponible (uno por bloque). */
  explicacionId: string;
  onClick: () => void;
  children: ReactNode;
  /** Inhabilitado por el ESTADO y no por el rol (p. ej. una ambigua sin municipio elegido). */
  bloqueadoPorEstado?: boolean;
  /** `id` del texto que explica el bloqueo por estado, cuando lo hay. */
  motivoBloqueoId?: string;
  compacto?: boolean;
  className?: string;
  style?: CSSProperties;
}

export default function BotonAccion({
  id, permitido, explicacionId, onClick, children,
  bloqueadoPorEstado = false, motivoBloqueoId, compacto = false, className = '', style,
}: Props) {
  const disponible = permitido && !bloqueadoPorEstado;
  const base = compacto ? flitBtnSecondarySm : flitBtnSecondary;
  const describedBy = !permitido ? explicacionId : bloqueadoPorEstado ? motivoBloqueoId : undefined;

  return (
    <button
      id={id}
      type="button"
      aria-disabled={disponible ? undefined : true}
      aria-describedby={describedBy}
      // Sin `onClick` cuando no está disponible: neutralizarlo dentro del manejador dejaría un
      // control que parece responder. Aquí, sencillamente, no hay nada que pulsar.
      onClick={disponible ? onClick : undefined}
      className={`${base} ${className}`}
      style={{
        ...flitBtnSecondaryStyle,
        ...(disponible ? null : { color: 'var(--flit-text-muted)' }),
        ...style,
      }}
    >
      {children}
    </button>
  );
}
