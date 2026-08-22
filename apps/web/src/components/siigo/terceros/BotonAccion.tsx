// Un control que EXISTE pero no está disponible para este rol (HU #11299, AC1).
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
// ESTO NO ES UN CONTROL DE SEGURIDAD. Es una guía de interfaz.
//
// Quien decide es el servidor, y no decide lo mismo para todas las acciones de esta pestaña:
//
//   · `POST /api/siigo/terceros/cliente/:id` → `exigirAccionSiigo('emitir')` = admin + financiera.
//   · `POST /api/siigo/clientes-ciudades/:id/confirmar` → `requireRole('admin')`.
//   · `POST /api/siigo/clientes/validacion/recalcular-duplicados` → `requireRole('admin')`.
//
// Por eso `permitido` llega POR ACCIÓN y nunca de una bandera «es admin» compartida. Cuando las dos
// primeras colgaban del mismo booleano, la pantalla le negaba a financiera una sincronización que
// el endpoint le aceptaba; el AC1 zanjó la divergencia a favor del servidor (decisión de PO del
// 2026-08-22): financiera sincroniza, y confirmar la ciudad sigue siendo solo de administración
// porque fija el municipio que se imprime en la factura ante la DIAN.
//
// Corolario: inhabilitar un control no protege nada —protege la guarda del servidor—. Esto solo
// evita pulsar para recibir un 403, y por eso mismo tiene que decir la verdad sobre quién puede.
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
  /** `false` = el rol no puede ESTA acción: el botón se pinta, se alcanza con Tab y no dispara
   *  nada. Cada bloque pasa la capacidad que corresponde a su endpoint, no una genérica. */
  permitido: boolean;
  /** `id` del párrafo que explica por qué no está disponible (uno por acción de cada bloque). */
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
