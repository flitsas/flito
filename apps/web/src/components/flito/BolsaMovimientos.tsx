// Detalle de movimientos de una bolsa, con filtros, exportación y soportes (HU #11128).
//
// El periodo lo filtra el servidor (es lo que acota el libro que se descarga); el resto —rango de
// fechas, OT y concepto— se aplica sobre lo ya cargado. Es deliberado: la exportación tiene que
// contener EXACTAMENTE las filas que se están viendo (AC3), y eso solo se puede garantizar si el
// filtro y el archivo se calculan sobre la misma lista, no sobre dos consultas distintas.

import { useMemo, useState } from 'react';
import {
  CONCEPTO_BOLSA_LABEL, OrigenMovimientoBolsa, TipoMovimientoBolsa,
  type ConceptoBolsa, type MovimientoBolsaDto,
} from '@operaciones/shared-types';
import {
  abrirSoporteBolsa, descargarCsv, etiquetaOrganismo, etiquetaPeriodo, fechaDia, fechaHora,
  pesos, pesosConSigno,
} from '../../lib/bolsas';
import FiltrosInteligentes, { type Preset } from '../flit/FiltrosInteligentes';
import RangoFechas from '../flit/RangoFechas';
import StatusChip, { type ChipTone } from '../flit/StatusChip';
import ThFiltroMulti from '../flit/ThFiltroMulti';
import {
  FlitCard, FlitEmpty, FlitTable, FlitTh, FlitTr, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../flit/flitPageKit';

/** Cómo se nombra y se pinta el origen del movimiento. Un ajuste a mano no puede verse igual que
 *  una salida que generó el sistema al sellar la liquidación. */
const ORIGEN: Record<OrigenMovimientoBolsa, { label: string; tono: ChipTone }> = {
  recarga: { label: 'Recarga', tono: 'success' },
  automatico: { label: 'Automático', tono: 'neutral' },
  manual: { label: 'Manual', tono: 'warning' },
  // Feature #11623: salida asentada al conciliar una boleta de pago externo. Tono propio a
  // propósito — no es «automático»: no cuelga de ningún trámite (la columna Trámite sale con «—») y
  // el reverso de la liquidación no lo devuelve. Este mismo mapa alimenta el filtro de origen y la
  // exportación, así que con esta entrada quedan los tres.
  conciliacion: { label: 'Conciliación', tono: 'active' },
};

interface Filtros {
  organismos: string[];
  conceptos: string[];
  origenes: string[];
  desde: string;
  hasta: string;
}

const SIN_FILTROS: Filtros = { organismos: [], conceptos: [], origenes: [], desde: '', hasta: '' };

/**
 * Las dos preguntas que se traen a esta tabla y que NO son un filtro suelto.
 *
 * «Sin soporte» es la que importa de verdad: un movimiento de dinero sin comprobante detrás es lo
 * que rompe una conciliación, y encontrarlos a ojo en un libro de doscientas filas no es viable.
 */
const PRESETS: Array<Preset<{ soloManuales: boolean; soloSinSoporte: boolean }>> = [
  {
    nombre: 'Ajustes manuales',
    descripcion: 'Lo que registró una persona, no el sellado de una liquidación.',
    filtros: { soloManuales: true, soloSinSoporte: false },
  },
  {
    nombre: 'Sin soporte',
    descripcion: 'Movimientos sin comprobante adjunto. Son los que no se pueden conciliar.',
    filtros: { soloManuales: false, soloSinSoporte: true },
  },
];

interface Props {
  companiaNombre: string;
  periodo: string;
  /** Etiqueta del periodo elegido, o vacío si se están mirando todos. */
  todosLosPeriodos: boolean;
  movimientos: MovimientoBolsaDto[] | null;
  error: string | null;
  onReintentar: () => void;
}

export default function BolsaMovimientos({
  companiaNombre, periodo, todosLosPeriodos, movimientos, error, onReintentar,
}: Props) {
  const [filtros, setFiltros] = useState<Filtros>(SIN_FILTROS);
  const [preset, setPreset] = useState<string | null>(null);
  const [soloManuales, setSoloManuales] = useState(false);
  const [soloSinSoporte, setSoloSinSoporte] = useState(false);

  const limpiar = () => {
    setFiltros(SIN_FILTROS);
    setSoloManuales(false);
    setSoloSinSoporte(false);
    setPreset(null);
  };

  const lista = useMemo(() => movimientos ?? [], [movimientos]);

  // Las opciones salen de lo que hay en el libro, no del catálogo entero: ofrecer un organismo que
  // este cliente no ha usado nunca solo sirve para llegar a una tabla vacía.
  const organismosDisponibles = useMemo(
    () => [...new Set(lista.map((m) => m.organismoCodigo).filter((c): c is string => c !== null))].sort(),
    [lista],
  );
  const conceptosDisponibles = useMemo(
    () => [...new Set(lista.map((m) => m.concepto).filter((c): c is ConceptoBolsa => c !== null))].sort(),
    [lista],
  );

  const filtrados = useMemo(() => lista.filter((m) => {
    if (filtros.organismos.length && !(m.organismoCodigo && filtros.organismos.includes(m.organismoCodigo))) return false;
    if (filtros.conceptos.length && !(m.concepto && filtros.conceptos.includes(m.concepto))) return false;
    if (filtros.origenes.length && !filtros.origenes.includes(m.origen)) return false;
    // Comparación de texto sobre 'YYYY-MM-DD': ordenan igual que las fechas y no pasan por Date, que
    // en Colombia (UTC−5) desplazaría el día.
    if (filtros.desde && m.fecha.slice(0, 10) < filtros.desde) return false;
    if (filtros.hasta && m.fecha.slice(0, 10) > filtros.hasta) return false;
    if (soloManuales && m.origen !== OrigenMovimientoBolsa.MANUAL) return false;
    if (soloSinSoporte && m.soporteId !== null) return false;
    return true;
  }), [lista, filtros, soloManuales, soloSinSoporte]);

  // El total se recalcula sobre lo filtrado (AC2): un total de la lista completa debajo de una tabla
  // filtrada es peor que ningún total, porque parece que cuadra.
  const totales = useMemo(() => ({
    entradas: filtrados.filter((m) => m.tipo === TipoMovimientoBolsa.ENTRADA).reduce((s, m) => s + m.valor, 0),
    salidas: filtrados.filter((m) => m.tipo === TipoMovimientoBolsa.SALIDA).reduce((s, m) => s + m.valor, 0),
  }), [filtrados]);

  const hayFiltro = filtros.organismos.length > 0 || filtros.conceptos.length > 0
    || filtros.origenes.length > 0 || filtros.desde !== '' || filtros.hasta !== ''
    || soloManuales || soloSinSoporte;

  const exportar = () => {
    descargarCsv(
      `bolsa-${companiaNombre.replace(/[^\w-]+/g, '_')}-${todosLosPeriodos ? 'todo' : periodo}.csv`,
      ['Cliente', 'Fecha', 'Organismo', 'Trámite', 'Concepto', 'Tipo', 'Origen', 'Valor',
        'Saldo resultante', 'Periodo', 'Usuario', 'Observación', 'Soporte'],
      filtrados.map((m) => [
        companiaNombre,
        fechaDia(m.fecha),
        m.organismoCodigo ? etiquetaOrganismo(m.organismoCodigo) : '',
        m.idFlit ?? '',
        m.concepto ? CONCEPTO_BOLSA_LABEL[m.concepto] : '',
        m.tipo === TipoMovimientoBolsa.ENTRADA ? 'Entrada' : 'Salida',
        ORIGEN[m.origen].label,
        // Con el formato de moneda, no en crudo (AC3): el archivo se abre para leerlo y para
        // pegarlo en una conciliación, no para volver a formatearlo a mano.
        pesosConSigno(m.valor, m.tipo === TipoMovimientoBolsa.ENTRADA),
        pesos(m.saldoResultante),
        m.periodo,
        m.registradoPorNombre,
        m.observacion ?? '',
        m.soporteId ? 'Sí' : 'No',
      ]),
    );
  };

  if (error) {
    return (
      <FlitCard>
        <p className="text-sm" style={{ color: 'var(--flit-danger)' }}>{error}</p>
        <button type="button" className={`${flitBtnSecondary} mt-3`} style={flitBtnSecondaryStyle} onClick={onReintentar}>
          Reintentar
        </button>
      </FlitCard>
    );
  }

  if (movimientos === null) {
    return (
      <FlitCard>
        <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando los movimientos…</p>
      </FlitCard>
    );
  }

  return (
    <FlitCard>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>
          Movimientos · {todosLosPeriodos ? 'todos los periodos' : etiquetaPeriodo(periodo)}
        </h3>
        <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
          disabled={filtrados.length === 0} onClick={exportar}>
          Exportar CSV ({filtrados.length})
        </button>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <FiltrosInteligentes presets={PRESETS} activo={preset}
          onAplicar={(p) => {
            // Sobre el estado limpio y no sobre el actual: un preset debe dar siempre lo mismo.
            setFiltros(SIN_FILTROS);
            setSoloManuales(p.filtros.soloManuales);
            setSoloSinSoporte(p.filtros.soloSinSoporte);
            setPreset(p.nombre);
          }}
          onQuitar={limpiar} />
        <RangoFechas etiqueta="Fecha" valor={{ desde: filtros.desde, hasta: filtros.hasta }}
          onCambio={(r) => setFiltros((f) => ({ ...f, desde: r.desde, hasta: r.hasta }))} />
        <ThFiltroMulti seleccion={filtros.organismos} placeholder="Organismo"
          vacio="Ningún movimiento tiene organismo"
          opciones={organismosDisponibles.map((c) => ({ value: c, label: etiquetaOrganismo(c) }))}
          onCambio={(v) => setFiltros((f) => ({ ...f, organismos: v }))} />
        <ThFiltroMulti seleccion={filtros.conceptos} placeholder="Concepto"
          vacio="Ningún movimiento tiene concepto"
          opciones={conceptosDisponibles.map((c) => ({ value: c, label: CONCEPTO_BOLSA_LABEL[c] }))}
          onCambio={(v) => setFiltros((f) => ({ ...f, conceptos: v }))} />
        <ThFiltroMulti seleccion={filtros.origenes} placeholder="Origen" vacio="Sin orígenes"
          opciones={Object.entries(ORIGEN).map(([v, o]) => ({ value: v, label: o.label }))}
          onCambio={(v) => setFiltros((f) => ({ ...f, origenes: v }))} />
        {hayFiltro && (
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={limpiar}>
            Limpiar filtros
          </button>
        )}
      </div>

      {lista.length === 0 ? (
        <FlitEmpty>
          Esta bolsa no tiene movimientos en {todosLosPeriodos ? 'ningún periodo' : etiquetaPeriodo(periodo)}.
        </FlitEmpty>
      ) : filtrados.length === 0 ? (
        <FlitEmpty>
          <p>Ningún movimiento cumple los filtros aplicados.</p>
          <button type="button" className={`${flitBtnSecondary} mt-3`} style={flitBtnSecondaryStyle} onClick={limpiar}>
            Limpiar filtros
          </button>
        </FlitEmpty>
      ) : (
        // Con nombre: en esta pantalla conviven tres tablas —los dos desgloses del extracto y el
        // libro—, y varias comparten rótulo de columna. Sin la región, «la columna Concepto» es
        // ambigua tanto para un lector de pantalla como para quien navega por teclado.
        <section aria-label="Movimientos de la bolsa">
        <FlitTable>
          <thead>
            <tr>
              <FlitTh>Cliente</FlitTh>
              <FlitTh>Fecha</FlitTh>
              <FlitTh>Organismo</FlitTh>
              <FlitTh>Trámite</FlitTh>
              <FlitTh>Concepto</FlitTh>
              <FlitTh>Origen</FlitTh>
              <FlitTh center>Valor</FlitTh>
              <FlitTh center>Saldo resultante</FlitTh>
              <FlitTh>Usuario</FlitTh>
              <FlitTh center>Soporte</FlitTh>
            </tr>
          </thead>
          <tbody>
            {filtrados.map((m) => {
              const entrada = m.tipo === TipoMovimientoBolsa.ENTRADA;
              return (
                <FlitTr key={m.id}>
                  <td className="px-4 py-2 align-top text-sm">{companiaNombre}</td>
                  <td className="px-4 py-2 align-top text-sm whitespace-nowrap">
                    <div>{fechaDia(m.fecha)}</div>
                    <div className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
                      {fechaHora(m.createdAt)}
                    </div>
                  </td>
                  <td className="px-4 py-2 align-top text-sm">
                    {m.organismoCodigo ? etiquetaOrganismo(m.organismoCodigo) : '—'}
                  </td>
                  {/* El id de FLIT, que es como nombra Operaciones al trámite. El UUID queda en el
                      `title` para quien tenga que rastrearlo contra la base. */}
                  <td className="px-4 py-2 align-top text-sm tabular-nums" title={m.tramiteId ?? undefined}>
                    {m.idFlit ?? (m.tramiteId
                      ? 'Sin id de FLIT'
                      // La raya es el DATO, no un fallo: una recarga no pasa por ningún trámite, y
                      // un movimiento de conciliación tampoco (Feature #11623) —su dinero sale de
                      // una boleta de pago externo, que la fila nombra en la observación—. Lleva su
                      // `sr-only` detrás porque un guion suelto no se escucha, que es como esa
                      // celda se convertía en un hueco sin explicación para quien no la ve.
                      : <>—<span className="sr-only">Sin trámite</span></>)}
                  </td>
                  <td className="px-4 py-2 align-top text-sm">
                    {m.concepto ? CONCEPTO_BOLSA_LABEL[m.concepto] : '—'}
                    {m.observacion && (
                      <div className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{m.observacion}</div>
                    )}
                  </td>
                  <td className="px-4 py-2 align-top">
                    <StatusChip tone={ORIGEN[m.origen].tono}>{ORIGEN[m.origen].label}</StatusChip>
                  </td>
                  <td className="px-4 py-2 align-top text-right text-sm font-semibold tabular-nums whitespace-nowrap"
                    style={{ color: entrada ? 'var(--flit-success)' : 'var(--flit-warning)' }}>
                    {pesosConSigno(m.valor, entrada)}
                  </td>
                  <td className="px-4 py-2 align-top text-right text-sm tabular-nums">{pesos(m.saldoResultante)}</td>
                  <td className="px-4 py-2 align-top text-xs">{m.registradoPorNombre}</td>
                  <td className="px-4 py-2 align-top text-center">
                    {m.soporteId ? (
                      <button type="button" className="text-xs font-semibold underline"
                        style={{ color: 'var(--flit-blue)' }}
                        aria-label={`Abrir el soporte del movimiento del ${fechaDia(m.fecha)}`}
                        onClick={() => abrirSoporteBolsa(m.soporteId!)}>
                        Ver soporte
                      </button>
                    ) : (
                      // Decirlo, no ofrecer un enlace roto (AC4).
                      <span className="text-xs italic" style={{ color: 'var(--flit-text-muted)' }}>Sin soporte</span>
                    )}
                  </td>
                </FlitTr>
              );
            })}
          </tbody>
          <tfoot>
            <FlitTr>
              <td className="px-4 py-2 text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
                Totales de lo filtrado ({filtrados.length} de {lista.length})
              </td>
              <td colSpan={5} />
              <td className="px-4 py-2 text-right text-sm font-bold tabular-nums whitespace-nowrap">
                <div style={{ color: 'var(--flit-success)' }}>{pesosConSigno(totales.entradas, true)}</div>
                <div style={{ color: 'var(--flit-warning)' }}>{pesosConSigno(totales.salidas, false)}</div>
              </td>
              <td className="px-4 py-2 text-right text-sm font-bold tabular-nums" style={{ color: 'var(--flit-blue-text)' }}>
                {pesos(totales.entradas - totales.salidas)}
              </td>
              <td colSpan={2} />
            </FlitTr>
          </tfoot>
        </FlitTable>
        </section>
      )}
    </FlitCard>
  );
}
