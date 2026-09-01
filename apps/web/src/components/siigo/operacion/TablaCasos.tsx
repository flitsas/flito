// AC2 — los cuatro estados de la lista, **con el error ANTES que el vacío**.
//
// Si la consulta falló no se sabe si hay algo, y decir «no hay nada» sería afirmar algo que nadie
// comprobó. Celebrarlo, además, sería una mentira alegre.
//
// **DOS VACÍOS, Y SOLO UNO CELEBRA.** Sin filtros y sin casos se celebra, porque es cierto. Con un
// filtro puesto no se celebra: quien filtró por un cliente y lee «no hay nada detenido» cierra la
// pestaña con catorce facturas paradas. Es la peor mentira que esta pantalla puede contar.
//
// La casilla de selección **no se pinta en las filas que no admiten ninguna acción de lote**. No es
// un hueco: es que ahí no hay nada que marcar (ver `admiteLote`).

import { Link } from 'react-router-dom';
import { SIIGO_BANDEJA_FUENTE_ETIQUETA } from '@operaciones/shared-types';
import type { SiigoBandejaItem } from '@operaciones/shared-types';
import {
  FlitTable, FlitTh, FlitTr, flitBtnSecondarySm, flitBtnSecondaryStyle,
} from '../../flit/flitPageKit';
import StatusChip from '../../flit/StatusChip';
import AntiguedadPill from '../../flit/AntiguedadPill';
import EstadoNativoChip from './EstadoNativoChip';
import GuiaCaso, { MarcaNoCatalogado } from './GuiaCaso';
import { admiteLote } from './previsualizarLote';
import { claveCaso, etiquetaCaso } from './tipos';

const CELDA = 'px-4 py-3 align-top text-sm';

interface Props {
  items: SiigoBandejaItem[];
  cargando: boolean;
  error: string | null;
  onReintentarConsulta: () => void;
  /** Filas con un cambio ya confirmado por el servidor que la consulta todavía no ha releído. */
  tocados: Set<string>;
  conFiltros: boolean;
  /** Total de la bandeja SIN filtros, de `GET /resumen`. `null` si el resumen no cargó. */
  totalGlobal: number | null;
  onLimpiarFiltros: () => void;
  /** Vacío para quien no puede ejecutar nada: sin casillas, y sin columna de selección. */
  seleccion: Set<string>;
  onAlternar: (clave: string) => void;
  onSeleccionarPagina: (marcar: boolean) => void;
  puedeSeleccionar: boolean;
  onAbrir: (item: SiigoBandejaItem) => void;
  pagina: number;
  hayMas: boolean;
  onPagina: (p: number) => void;
}

export default function TablaCasos(p: Props) {
  if (p.cargando) return <Esqueleto />;
  if (p.error) return <BandaError mensaje={p.error} onReintentar={p.onReintentarConsulta} />;
  if (p.items.length === 0) {
    return p.conFiltros
      ? <VacioConFiltros total={p.totalGlobal} onLimpiar={p.onLimpiarFiltros} />
      : <VacioQueCelebra />;
  }

  const seleccionables = p.items.filter((it) => admiteLote(casoDe(it)));
  const todasMarcadas = seleccionables.length > 0
    && seleccionables.every((it) => p.seleccion.has(claveCaso(it)));

  return (
    <div className="flex flex-col gap-3">
      <FlitTable label="Casos detenidos">
        <thead>
          <tr>
            {p.puedeSeleccionar && (
              <FlitTh>
                <input
                  type="checkbox"
                  className="flit-focus"
                  aria-label="Seleccionar todos los casos accionables de esta página"
                  checked={todasMarcadas}
                  disabled={seleccionables.length === 0}
                  onChange={(e) => p.onSeleccionarPagina(e.target.checked)}
                />
              </FlitTh>
            )}
            <FlitTh>Caso</FlitTh>
            <FlitTh>Cliente</FlitTh>
            <FlitTh>Fuente y estado</FlitTh>
            <FlitTh>Qué pasó y qué hacer</FlitTh>
            <FlitTh>Detenido</FlitTh>
            <FlitTh>Detalle</FlitTh>
          </tr>
        </thead>
        <tbody>
          {p.items.map((item) => {
            const clave = claveCaso(item);
            const etiqueta = etiquetaCaso(item);
            const marcable = admiteLote(casoDe(item));
            return (
              <FlitTr key={clave}>
                {p.puedeSeleccionar && (
                  <td className={CELDA}>
                    {marcable && (
                      <input
                        type="checkbox"
                        className="flit-focus"
                        aria-label={`Seleccionar ${etiqueta}`}
                        checked={p.seleccion.has(clave)}
                        onChange={() => p.onAlternar(clave)}
                      />
                    )}
                  </td>
                )}
                <td className={CELDA}>
                  <span className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
                    {etiqueta}
                  </span>
                  {p.tocados.has(clave) && (
                    <span className="mt-1 block text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
                      Cambiado ahora mismo. Puede que ya no encaje con el filtro.
                    </span>
                  )}
                </td>
                {/* Se muestra el NOMBRE del cliente y nada más: ni NIT, ni cédula, ni teléfono, ni
                    la dirección de correo del destinatario. */}
                <td className={CELDA} style={{ color: 'var(--flit-text-primary)' }}>
                  {item.clienteNombre ?? '—'}
                </td>
                <td className={CELDA}>
                  <div className="flex flex-col items-start gap-1">
                    <StatusChip tone="neutral">{SIIGO_BANDEJA_FUENTE_ETIQUETA[item.fuente]}</StatusChip>
                    <EstadoNativoChip fuente={item.fuente} estado={item.estado} />
                    {item.fuente === 'emision' && item.maxIntentos > 0 && (
                      <span className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
                        intento {item.intentos} de {item.maxIntentos}
                      </span>
                    )}
                    <MarcaNoCatalogado guia={item.guia} />
                  </div>
                </td>
                <td className={`${CELDA} max-w-md`}>
                  <GuiaCaso guia={item.guia} descarte={item.descarte} />
                </td>
                <td className={CELDA}>
                  <AntiguedadPill desde={item.ocurridoEn} />
                </td>
                <td className={CELDA}>
                  <button
                    type="button"
                    onClick={() => p.onAbrir(item)}
                    aria-label={`Ver el caso ${etiqueta}`}
                    className={flitBtnSecondarySm}
                    style={flitBtnSecondaryStyle}
                  >
                    Ver
                  </button>
                </td>
              </FlitTr>
            );
          })}
        </tbody>
      </FlitTable>
      <Paginas pagina={p.pagina} hayMas={p.hayMas} onPagina={p.onPagina} />
    </div>
  );
}

function casoDe(item: SiigoBandejaItem) {
  return {
    fuente: item.fuente,
    descartado: item.descarte !== null,
    sirveReintentar: item.guia.sirveReintentar,
  };
}

/**
 * Cargando. **Los filtros NO se inhabilitan mientras carga** (eso lo decide quien pinta la barra):
 * quien acaba de poner un filtro y ve que tarda, lo primero que hace es corregirlo.
 */
function Esqueleto() {
  return (
    <div
      role="status"
      aria-busy="true"
      className="flex flex-col gap-3 bg-white p-4"
      style={{
        borderRadius: 'var(--flit-radius-card)',
        border: '1px solid var(--flit-border-soft)',
        boxShadow: 'var(--flit-shadow-card)',
      }}
    >
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="h-10 rounded" style={{ background: 'var(--flit-bg-app)' }} />
      ))}
      <p className="text-center text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
        Buscando lo que quedó detenido…
      </p>
    </div>
  );
}

/** No se pinta tabla, ni paginación, ni barra de selección: no hay nada que seleccionar. */
function BandaError({ mensaje, onReintentar }: { mensaje: string; onReintentar: () => void }) {
  return (
    <div
      className="flex flex-wrap items-center gap-3 bg-white p-5"
      style={{ borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-danger-ink)' }}
    >
      <p role="alert" className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
        <span aria-hidden="true">⚠ </span>No se pudo cargar la bandeja: {mensaje}
      </p>
      <button type="button" onClick={onReintentar} className={flitBtnSecondarySm} style={flitBtnSecondaryStyle}>
        Reintentar la búsqueda
      </button>
    </div>
  );
}

/** Caso A — sin filtros y sin casos. Aquí sí se celebra, porque es cierto. */
function VacioQueCelebra() {
  return (
    <div
      className="flex flex-col items-center gap-2 p-12 text-center"
      style={{
        borderRadius: 'var(--flit-radius-card)',
        border: '1px dashed var(--flit-border-input)',
        background: 'var(--flit-bg-card)',
      }}
    >
      <p className="text-lg font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
        <span aria-hidden="true">✓ </span>No hay nada detenido. Buen día.
      </p>
      <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
        Todo lo que se envió a facturación electrónica siguió su camino: nada espera una decisión tuya.
      </p>
      <Link
        to="/finanzas/reporte-costos"
        className={`${flitBtnSecondarySm} mt-2`}
        style={flitBtnSecondaryStyle}
      >
        Ver el reporte de costos
      </Link>
    </div>
  );
}

/** Caso B — con filtro puesto. **No celebra**, y dice cuánto hay en total fuera del filtro. */
function VacioConFiltros({ total, onLimpiar }: { total: number | null; onLimpiar: () => void }) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 p-6"
      style={{
        borderRadius: 'var(--flit-radius-card)',
        border: '1px dashed var(--flit-border-input)',
        background: 'var(--flit-bg-card)',
      }}
    >
      <p className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
        Ningún caso coincide con este filtro.
        {total !== null && ` Hay ${total.toLocaleString('es-CO')} casos detenidos en total.`}
      </p>
      <button type="button" onClick={onLimpiar} className={flitBtnSecondarySm} style={flitBtnSecondaryStyle}>
        Quitar los filtros
      </button>
    </div>
  );
}

/**
 * Anterior/Siguiente y el número de página, **sin total**.
 *
 * El contrato entrega `hayMas` y no un total: contar la unión entera en cada refresco cuesta lo
 * mismo que traerla. Por eso no se usa `Paginacion` del kit, que exige un total y un número de
 * páginas — pasarle el total del resumen sería contar una cosa y paginar otra.
 */
function Paginas({ pagina, hayMas, onPagina }: { pagina: number; hayMas: boolean; onPagina: (p: number) => void }) {
  const btn = 'flit-focus rounded-lg border px-3 py-1.5 text-sm font-semibold disabled:opacity-40';
  const estilo = { borderColor: 'var(--flit-border-input)', color: 'var(--flit-blue-text)' } as const;
  if (pagina === 0 && !hayMas) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>Página {pagina + 1}</span>
      <div className="flex gap-2">
        <button type="button" className={btn} style={estilo} disabled={pagina === 0} onClick={() => onPagina(pagina - 1)}>
          ← Anterior
        </button>
        <button type="button" className={btn} style={estilo} disabled={!hayMas} onClick={() => onPagina(pagina + 1)}>
          Siguiente →
        </button>
      </div>
    </div>
  );
}
