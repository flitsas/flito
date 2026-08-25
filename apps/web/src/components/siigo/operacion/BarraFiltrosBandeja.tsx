// AC3 — filtros por motivo, cliente, antigüedad y fuente.
//
// **Los cuatro viajan en el CUERPO del POST y ninguno en la dirección del navegador.** El de cliente
// no puede ir a la query: es cuasi-PII y AGENTS.md §14 lo prohíbe sin ADR. Los otros sí podrían —son
// códigos de catálogo— y aun así no van, por una razón de producto: si parte del filtro se conserva
// al navegar y parte no, un enlace compartido reproduce una vista PARECIDA PERO DISTINTA a la que vio
// quien lo mandó, sin decirlo. Un filtro a medias es peor que ninguno.
//
// Los controles **aplican al cambiar**: son un gesto único y deliberado, no hay tecleo que
// amortiguar. Y **no hay campo de texto libre**: es la puerta por la que el NIT y la placa vuelven a
// la URL y al registro de acceso. Quien busca *una* factura concreta va al reporte de costos.

import { useId, type ReactNode } from 'react';
import {
  SIIGO_BANDEJA_FUENTE_ETIQUETA, SIIGO_BANDEJA_FUENTES,
} from '@operaciones/shared-types';
import type { SiigoBandejaFuente, SiigoBandejaResumen } from '@operaciones/shared-types';
import {
  FlitPillButton, FlitPillGroup, flitBtnSecondarySm, flitBtnSecondaryStyle,
} from '../../flit/flitPageKit';
import FlitSelect from '../../flit/FlitSelect';
import { CRITERIOS_VACIOS, hayFiltros, type CriteriosBandeja } from './tipos';

export interface ClienteConCasos { id: number; nombre: string }

const ANTIGUEDADES: { valor: number | null; etiqueta: string }[] = [
  { valor: null, etiqueta: 'Toda' },
  { valor: 2, etiqueta: 'Más de 2 días' },
  { valor: 5, etiqueta: 'Más de 5 días' },
];

interface Props {
  criterios: CriteriosBandeja;
  onCambiar: (c: CriteriosBandeja) => void;
  resumen: SiigoBandejaResumen | null;
  resumenError: string | null;
  onReintentarResumen: () => void;
  /** Clientes con casos en la página que se está viendo. Ver la nota de `ayuda` del selector. */
  clientes: ClienteConCasos[];
}

export default function BarraFiltrosBandeja(
  { criterios, onCambiar, resumen, resumenError, onReintentarResumen, clientes }: Props,
) {
  const cambiar = (parcial: Partial<CriteriosBandeja>) => onCambiar({ ...criterios, ...parcial });
  const conFiltros = hayFiltros(criterios);

  const opcionesMotivo = [
    { valor: '', etiqueta: 'Todos los motivos' },
    ...(resumen?.porCodigo ?? []).map((m) => ({
      valor: m.codigo,
      etiqueta: `${m.etiqueta} (${m.total})`,
    })),
  ];

  const opcionesCliente = [
    { valor: '', etiqueta: 'Todos los clientes' },
    ...clientes.map((c) => ({ valor: String(c.id), etiqueta: c.nombre })),
  ];

  return (
    <div
      className="flex flex-col gap-4 bg-white p-4"
      style={{
        borderRadius: 'var(--flit-radius-card)',
        border: '1px solid var(--flit-border-soft)',
        boxShadow: 'var(--flit-shadow-card)',
      }}
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Grupo etiqueta="Filtrar por fuente">
          <FlitPillButton
            active={criterios.fuente === null}
            pressed={criterios.fuente === null}
            onClick={() => cambiar({ fuente: null })}
          >
            Todas
          </FlitPillButton>
          {SIIGO_BANDEJA_FUENTES.map((f: SiigoBandejaFuente) => (
            <FlitPillButton
              key={f}
              active={criterios.fuente === f}
              pressed={criterios.fuente === f}
              onClick={() => cambiar({ fuente: f })}
            >
              {SIIGO_BANDEJA_FUENTE_ETIQUETA[f]}
              {resumen ? ` (${resumen.porFuente[f]})` : ''}
            </FlitPillButton>
          ))}
        </Grupo>

        <Grupo etiqueta="Filtrar por antigüedad">
          {ANTIGUEDADES.map((a) => (
            <FlitPillButton
              key={a.etiqueta}
              active={criterios.antiguedadDiasMin === a.valor}
              pressed={criterios.antiguedadDiasMin === a.valor}
              onClick={() => cambiar({ antiguedadDiasMin: a.valor })}
            >
              {a.etiqueta}
            </FlitPillButton>
          ))}
        </Grupo>

        {/* No son dos conjuntos disjuntos: el contrato ofrece `incluirDescartados`, que AÑADE. El
            rótulo dice lo que hace, no lo que sería más simétrico. */}
        <Grupo etiqueta="Qué se muestra">
          <FlitPillButton
            active={criterios.vista === 'pendientes'}
            pressed={criterios.vista === 'pendientes'}
            onClick={() => cambiar({ vista: 'pendientes' })}
          >
            Solo lo pendiente
          </FlitPillButton>
          <FlitPillButton
            active={criterios.vista === 'con_descartados'}
            pressed={criterios.vista === 'con_descartados'}
            onClick={() => cambiar({ vista: 'con_descartados' })}
          >
            Con los dados por perdidos
          </FlitPillButton>
        </Grupo>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <FlitSelect
          label="Motivo"
          value={criterios.codigo ?? ''}
          opciones={opcionesMotivo}
          onChange={(v) => cambiar({ codigo: v === '' ? null : v })}
          ayuda="Se agrupa por el código del error, no por la frase."
          mensaje={resumenError ? 'No se pudo cargar el catálogo de motivos.' : null}
          fallo={Boolean(resumenError)}
          disabled={Boolean(resumenError)}
          onReintentar={onReintentarResumen}
          textoReintento="Volver a cargar los motivos"
        />
        <FlitSelect
          label="Cliente"
          value={criterios.clienteId === null ? '' : String(criterios.clienteId)}
          opciones={opcionesCliente}
          onChange={(v) => cambiar({ clienteId: v === '' ? null : Number(v) })}
          // Honesto sobre su alcance: el resumen del servidor no entrega catálogo de clientes, así
          // que la lista sale de los casos de la página que se está viendo.
          ayuda={clientes.length > 0
            ? 'Los clientes con casos en esta página.'
            : 'No hay clientes que ofrecer con lo que se está viendo.'}
          disabled={clientes.length === 0 && criterios.clienteId === null}
        />
        <div className="flex items-end">
          <button
            type="button"
            onClick={() => onCambiar(CRITERIOS_VACIOS)}
            disabled={!conFiltros}
            className={flitBtnSecondarySm}
            style={flitBtnSecondaryStyle}
          >
            Limpiar los filtros
          </button>
        </div>
      </div>

      <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
        Los filtros no viajan en la dirección del navegador.
      </p>
    </div>
  );
}

/**
 * `role="group"` con nombre: sin él, un lector anuncia varios botones idénticos sin decir de qué
 * grupo son. El nombre se toma del rótulo VISIBLE (`aria-labelledby`) y no de un `aria-label`
 * paralelo, para que lo que se ve y lo que se oye no puedan separarse.
 *
 * El `role` va en este envoltorio y no en `FlitPillGroup` porque la prop `role` del kit solo admite
 * `tablist` —estas pills son un filtro, no una navegación por pestañas— y cambiar el kit por una
 * pantalla movería todas las pills del producto.
 */
function Grupo({ etiqueta, children }: { etiqueta: string; children: ReactNode }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col gap-1">
      <span id={id} className="text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
        {etiqueta}
      </span>
      <FlitPillGroup>{children}</FlitPillGroup>
    </div>
  );
}
