// Una línea del panel de servicios adicionales del trámite: el servicio, quién lo asignó y —si se
// puede— la confirmación EN LÍNEA de «Quitar» con su DELETE (HU #12548, Feature #12544).
// Diseño: `docs/ux/finanzas-reporte-costos-servicios-adicionales.md` §6.3.
//
// La confirmación NO es un diálogo: es lo que ya hace «Reversar» en esta misma pantalla, que es una
// acción bastante más grave (§12-D2). Un `FlitModal` encima del panel sería el primer diálogo sobre
// diálogo de la pantalla, con dos trampas de foco y dos Esc para quitar una línea de una lista de
// dos. El bloque SUSTITUYE a la fila —no se apila debajo—, así que la lista no salta.

import { useEffect, useRef, useState } from 'react';
import type { TramiteServicioAdicional } from '@operaciones/shared-types';
import { api } from '../../lib/api';
import { falloDeEscritura, rutaServiciosDeTramite, type FalloEscritura } from '../../lib/serviciosAdicionalesTramite';
import { fechaHoraCorta } from '../../lib/tarifas';
import { flitBtnSecondarySm } from '../flit/flitPageKit';
import { pesos } from './tiposReporteCostos';

const SECUNDARIO = { color: 'var(--flit-text-secondary)' } as const;
/** La TINTA roja sobre el fondo de la tarjeta, no una superficie roja: así marca esta app lo delicado. */
const PELIGRO = { color: 'var(--flit-danger-ink)' } as const;

/** «Añadió Ana Pérez · 12 sep 2026, 9:14 a. m.»; sin nombre, solo la fecha (el usuario puede haberse ido). */
function trazabilidad(item: TramiteServicioAdicional): string {
  const cuando = fechaHoraCorta(item.asignadoEn);
  return item.asignadoPorNombre ? `Añadió ${item.asignadoPorNombre} · ${cuando}` : `Añadido ${cuando}`;
}

export default function FilaServicioAdicional({
  item, tramiteId, puedeQuitar, abierta, onAbrir, onCancelar, onQuitado, onFallo,
}: {
  item: TramiteServicioAdicional;
  tramiteId: string;
  /** `…quitar` Y el trámite sin liquidar. Sin las dos, el botón NO existe (no se pinta apagado). */
  puedeQuitar: boolean;
  /** Solo una confirmación abierta a la vez en el panel: el estado vive arriba. */
  abierta: boolean;
  onAbrir: () => void;
  onCancelar: () => void;
  /** 204: la fila sale, el total baja y la página refresca. El foco lo recoloca el panel. */
  onQuitado: (nombre: string) => void;
  onFallo: (fallo: FalloEscritura) => void;
}) {
  const [enviando, setEnviando] = useState(false);
  const quitarRef = useRef<HTMLButtonElement>(null);
  const cancelarRef = useRef<HTMLButtonElement>(null);
  // Al abrir la confirmación el botón que la abrió deja de existir: sin esto el foco cae en
  // `<body>`. Entra en «Cancelar» y no en el «Quitar» que confirma, que es la regla de las
  // confirmaciones destructivas: el foco no se pone por defecto sobre lo que no tiene vuelta.
  useEffect(() => { if (abierta) cancelarRef.current?.focus(); }, [abierta]);
  // Y al CANCELAR el foco vuelve a su «Quitar», que es de donde salió (§6.3). Solo tras haber
  // estado abierta: en el primer render no hay foco que devolver y robarlo sería un salto.
  //
  // `quitada` separa cancelar de CONSEGUIR quitarlo, y no es un detalle: entre el 204 y el GET que
  // lo confirma la fila sigue montada con la confirmación ya cerrada, así que sin esta guarda el
  // «Quitar» de una fila que está a punto de desaparecer se robaba el foco, y al desmontarse lo
  // dejaba en `<body>`. Tras quitarlo, el foco lo coloca el PANEL (en «Añadir servicio»).
  const estuvoAbierta = useRef(false);
  const quitada = useRef(false);
  useEffect(() => {
    if (!abierta && estuvoAbierta.current && !quitada.current) quitarRef.current?.focus();
    estuvoAbierta.current = abierta;
  }, [abierta]);

  const confirmar = async () => {
    setEnviando(true);
    try {
      // 204 sin cuerpo: `api.delete` no intenta parsearlo.
      await api.delete(`${rutaServiciosDeTramite(tramiteId)}/${item.id}`);
      quitada.current = true;
      onQuitado(item.nombre);
    } catch (e) {
      onFallo(falloDeEscritura(e, 'quitar'));
      setEnviando(false);
      onCancelar();
    }
  };

  // El `id` no se pinta nunca; queda en `data-id` para QA (UX §3).
  if (abierta) {
    return (
      <li className="py-3" data-id={item.id}
        // `useEscape` escucha en `window` y el portal del modal cuelga de <body>: parar la
        // propagación aquí es lo que hace que Esc cancele la confirmación y NO cierre el panel (§9).
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancelar(); } }}>
        <div className="rounded-lg border p-2" style={{ borderColor: 'var(--flit-border-input)' }}>
          <p className="text-sm">¿Quitar «{item.nombre}» ({pesos(item.valor)})?</p>
          <div className="mt-2 flex flex-wrap justify-end gap-2">
            <button type="button" ref={cancelarRef} className={flitBtnSecondarySm} disabled={enviando} onClick={onCancelar}>
              Cancelar
            </button>
            <button type="button" className={flitBtnSecondarySm} style={PELIGRO} disabled={enviando} onClick={confirmar}>
              Quitar
            </button>
          </div>
        </div>
      </li>
    );
  }

  return (
    <li className="py-3" data-id={item.id}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-semibold">{item.nombre}</span>
        <span className="text-sm tabular-nums">{pesos(item.valor)}</span>
      </div>
      <div className="mt-0.5 flex items-center justify-between gap-3">
        <span className="text-xs" style={SECUNDARIO}>{trazabilidad(item)}</span>
        {puedeQuitar && (
          <button type="button" ref={quitarRef} className={flitBtnSecondarySm}
            aria-label={`Quitar · ${item.nombre}`} onClick={onAbrir}>
            Quitar
          </button>
        )}
      </div>
    </li>
  );
}
