// Tablero de bolsas (HU #11127; reestructurado en la #11210; listado del catálogo en la #13901).
//
// Una sola vista para las dos caras del mismo negocio: lo que los clientes tienen precargado con
// FLIT y lo que FLIT tiene precargado para pagar ante las secretarías. Arriba los números, debajo
// dos acordeones (spec `docs/ux/flito-bolsas.md`, disposición A).
//
// HU #13901: el acordeón Compañías pasa de rejilla de tarjetas a `FlitTable` alimentada por
// `POST /buscar` (filtros en el BODY: el nombre y el NIT nunca van en la URL, Ley 1581). Las dos
// primarias de los acordeones se funden en «Crear bolsa», que vive en la cabecera de la página.
// HU #13908: el acordeón Tránsitos deja las tarjetas y pasa a `FlitTable` alimentada por el MISMO
// `POST /buscar` (una sola llamada; las filas se reparten por `alcance`). Filtro Alcance nuevo
// (Todas · Compañías · Tránsito). Las filas de tránsito NO tienen la celda del expediente #13407.
//
// El orden de las filas NO lo pone esta pantalla: llega del servidor, y reordenar aquí sería abrir
// la puerta a que dos vistas del mismo dato prioricen distinto.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  NIVEL_BOLSA_TRANSITO_LABEL, NIVEL_RIESGO_BOLSA_LABEL, NivelRiesgoBolsa,
  type AlertasBolsas, type BolsaResumenDto, type BuscarBolsasDto, type SaldoConsolidado,
} from '@operaciones/shared-types';
import { api, bolsasApi } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { errorBolsa, pesos, saldoConSigno, TONO_NIVEL, TONO_NIVEL_TRANSITO } from '../../lib/bolsas';
import { FUNCION_VER_DOCUMENTOS_BOLSA } from '../../lib/bolsasDocumentos';
import ChipExpediente from '../flito-bolsas-documentos/ChipExpediente';
import { useEstadoExpedientes } from '../flito-bolsas-documentos/useEstadoExpedientes';
import FiltroSegmentado from '../flit/FiltroSegmentado';
import FlitAcordeon from '../flit/FlitAcordeon';
import {
  FlitCard, FlitEmpty, FlitTable, FlitTh, FlitTr, flitInp,
  flitBtnSecondary, flitBtnSecondaryStyle, flitBtnSecondarySm,
} from '../flit/flitPageKit';
import KpiCard from '../flit/KpiCard';
import PageContentSkeleton from '../flit/PageContentSkeleton';
import StatusChip from '../flit/StatusChip';

type FiltroEstado = 'todas' | 'activas' | 'inactivas';

const OPCIONES_ESTADO = [
  { valor: 'todas', etiqueta: 'Todas' },
  { valor: 'activas', etiqueta: 'Activas' },
  { valor: 'inactivas', etiqueta: 'Inactivas' },
] as const;

type FiltroAlcance = 'todas' | 'compania' | 'transito';

const OPCIONES_ALCANCE = [
  { valor: 'todas', etiqueta: 'Todas' },
  { valor: 'compania', etiqueta: 'Compañías' },
  { valor: 'transito', etiqueta: 'Tránsito' },
] as const;

/** Espera tras la última tecla antes de buscar. */
const DEBOUNCE_MS = 300;

interface Props {
  /** Abre el detalle de una bolsa de compañía por su id. */
  onVerBolsa: (bolsa: { id: string; nombre: string }) => void;
  /** Abre el detalle por compañía (alertas de saldo, que solo conocen la compañía). */
  onVerCompania: (compania: { companiaId: number; nombre: string }) => void;
  onVerTransito: (bolsa: { id: string; nombre: string }) => void;
  /** `null` = el usuario no puede crear bolsas: el botón del vacío no se pinta (AC7). */
  onCrear: (() => void) | null;
  /** Cambia cuando algo movió saldos o estados y hay que releer. */
  nonce: number;
}

export default function BolsasTablero({ onVerBolsa, onVerCompania, onVerTransito, onCrear, nonce }: Props) {
  const { hasFuncion } = useAuth();
  /** `bolsas.transito.listar`: sin ella no hay acordeón Tránsitos ni opción «Tránsito» en Alcance. */
  const verTransito = hasFuncion('bolsas.transito.listar');
  const [consolidado, setConsolidado] = useState<SaldoConsolidado | null>(null);
  const [alertas, setAlertas] = useState<AlertasBolsas | null>(null);
  /** KPI «Bolsas en riesgo» sobre TODAS las compañías: no puede moverse con el buscador. */
  const [enRiesgo, setEnRiesgo] = useState(0);
  const [errorResumen, setErrorResumen] = useState(false);
  const [cargadoResumen, setCargadoResumen] = useState(false);

  const [texto, setTexto] = useState('');
  /** El texto que de verdad se busca: el del input tras el debounce y con ≥ 2 caracteres o vacío. */
  const [textoBuscado, setTextoBuscado] = useState('');
  const [estado, setEstado] = useState<FiltroEstado>('todas');
  const [alcanceFiltro, setAlcanceFiltro] = useState<FiltroAlcance>('todas');
  const alcance: FiltroAlcance = verTransito ? alcanceFiltro : 'compania';
  const [filas, setFilas] = useState<BolsaResumenDto[] | null>(null);
  /** La primera respuesta de `/buscar` ya llegó: a partir de ahí no se vuelve al esqueleto. */
  const [filasIniciales, setFilasIniciales] = useState(false);
  const [errorFilas, setErrorFilas] = useState<'permiso' | 'red' | null>(null);
  const [reintento, setReintento] = useState(0);

  const [verClientes, setVerClientes] = useState(true);
  const [verTransitos, setVerTransitos] = useState(true);

  useEffect(() => {
    let vigente = true;
    setErrorResumen(false);
    Promise.all([
      api.get<SaldoConsolidado>('/flito/bolsas/consolidado'),
      api.get<AlertasBolsas>('/flito/bolsas/alertas'),
      bolsasApi.buscar({ alcance: 'compania' }),
    ])
      .then(([c, a, todas]) => {
        if (!vigente) return;
        setConsolidado(c);
        setEnRiesgo((Array.isArray(todas) ? todas : []).filter(
          (b) => b.nivel === NivelRiesgoBolsa.CRITICO || b.nivel === NivelRiesgoBolsa.AGOTADA,
        ).length);
        setAlertas(a);
        setCargadoResumen(true);
      })
      .catch(() => { if (vigente) setErrorResumen(true); });
    return () => { vigente = false; };
  }, [nonce, reintento]);

  // Debounce del buscador. Con 1 carácter no se busca: casa con medio catálogo y no ayuda.
  const primeraVez = useRef(true);
  useEffect(() => {
    if (primeraVez.current) { primeraVez.current = false; return; }
    const limpio = texto.trim();
    if (limpio.length === 1) return;
    const t = window.setTimeout(() => setTextoBuscado(limpio), DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [texto]);

  useEffect(() => {
    let vigente = true;
    setErrorFilas(null);
    setFilas(null);
    // Filtros en el BODY (Ley 1581). «Todas» no manda alcance: una sola llamada trae los dos.
    const filtros: BuscarBolsasDto = {
      ...(alcance === 'todas' ? {} : { alcance }),
      ...(estado === 'todas' ? {} : { activa: estado === 'activas' }),
      ...(textoBuscado ? { texto: textoBuscado } : {}),
    };
    bolsasApi.buscar(filtros)
      .then((r) => { if (vigente) { setFilas(Array.isArray(r) ? r : []); setFilasIniciales(true); } })
      .catch((e) => {
        if (!vigente) return;
        setErrorFilas(errorBolsa(e).status === 403 ? 'permiso' : 'red');
        setFilasIniciales(true);
      });
    return () => { vigente = false; };
  }, [nonce, reintento, textoBuscado, estado, alcance]);

  const reintentar = () => setReintento((n) => n + 1);
  const hayFiltro = textoBuscado !== '' || estado !== 'todas' || (verTransito && alcanceFiltro !== 'todas');
  const limpiarFiltros = () => { setTexto(''); setTextoBuscado(''); setEstado('todas'); setAlcanceFiltro('todas'); };

  const filasCompania = useMemo(() => (filas === null ? null : filas.filter((f) => f.alcance !== 'transito')), [filas]);
  const filasTransito = useMemo(() => (filas === null ? null : filas.filter((f) => f.alcance === 'transito')), [filas]);
  const mostrarCompanias = alcance !== 'transito';
  const mostrarTransitos = verTransito && alcance !== 'compania';

  if (errorResumen) {
    return (
      <FlitCard>
        <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>
          No pudimos cargar las bolsas. Revisa tu conexión e intenta de nuevo.
        </p>
        <button type="button" className={`${flitBtnSecondary} mt-3`} style={flitBtnSecondaryStyle} onClick={reintentar}>
          Reintentar
        </button>
      </FlitCard>
    );
  }

  if (!cargadoResumen || !filasIniciales) return <PageContentSkeleton />;

  // Vacío total: ni compañías (sin filtros) ni tránsitos. Dos acordeones vacíos no dicen qué hacer;
  // esto sí.
  if (filas !== null && filas.length === 0 && !hayFiltro) {
    return (
      <FlitEmpty>
        <div data-testid="bolsas-vacio-total">
          <p>
            {onCrear
              ? 'Todavía no hay bolsas. Crea la primera y elige si es de una compañía o de tránsito.'
              : 'Todavía no hay bolsas. Pídele a Financiera que cree la primera.'}
          </p>
          {onCrear && (
            <button type="button" className={`${flitBtnSecondary} mt-3`} style={flitBtnSecondaryStyle} onClick={onCrear}>
              Crear bolsa
            </button>
          )}
        </div>
      </FlitEmpty>
    );
  }

  // Las tres cosas que hay que ir a cerrar, en un solo número (HU #11678, AC6).
  const conciliacionPendiente = (alertas?.conciliacion.soportesSinTramite ?? 0)
    + (alertas?.conciliacion.movimientosSinSoporte ?? 0)
    + (alertas?.conciliacion.boletasSinComprobante ?? 0);

  return (
    <div className="space-y-4">
      <section aria-label="Resumen de bolsas" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <KpiCard label="Saldo total" value={pesos(consolidado?.saldoTotal ?? 0)}
          hint={`${consolidado?.clientes ?? 0} cliente(s) con bolsa.`} />
        <KpiCard label="Bolsas en riesgo" value={enRiesgo}
          hint="Saldo crítico o agotado. Son las que frenan trámites."
          chip={enRiesgo > 0 ? { tone: 'danger', label: 'Requiere atención' } : undefined} />
        <KpiCard label="Conciliación pendiente"
          value={conciliacionPendiente}
          hint={`${alertas?.conciliacion.soportesSinTramite ?? 0} soporte(s) sin trámite · ${alertas?.conciliacion.movimientosSinSoporte ?? 0} movimiento(s) sin soporte · ${alertas?.conciliacion.boletasSinComprobante ?? 0} boleta(s) sin comprobante.`}
          chip={conciliacionPendiente > 0 ? { tone: 'warning', label: 'Revisar' } : undefined} />
      </section>

      <FlitCard>
        <div className="flex flex-wrap items-end gap-4">
          <label className="block w-full sm:w-80">
            <span className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
              Buscar
            </span>
            <input type="search" className={flitInp} value={texto} placeholder="Compañía, bolsa o NIT…"
              maxLength={120} onChange={(e) => setTexto(e.target.value)} />
          </label>
          {verTransito && (
            <div className="w-full sm:w-auto">
              <FiltroSegmentado opciones={OPCIONES_ALCANCE} valor={alcanceFiltro} onCambio={setAlcanceFiltro}
                ariaLabel="Alcance de la bolsa" rotulo="Alcance" />
            </div>
          )}
          <div className="w-full sm:w-auto">
            <FiltroSegmentado opciones={OPCIONES_ESTADO} valor={estado} onCambio={setEstado}
              ariaLabel="Estado de la bolsa" rotulo="Estado" />
          </div>
        </div>
      </FlitCard>

      {mostrarCompanias && (
      <FlitAcordeon
        titulo="Compañías"
        cantidad={filasCompania?.length}
        descripcion="Saldo que cada compañía tiene precargado con FLIT."
        abierto={verClientes}
        onToggle={() => setVerClientes((v) => !v)}
      >
        {alertas && alertas.saldo.length > 0 && (
          <div className="mb-4">
            <h3 className="mb-1 text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>
              Alertas de saldo ({alertas.saldo.length})
            </h3>
            <p className="mb-3 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
              Las compañías que ya no están en nivel normal. Quien nunca ha recargado no aparece aquí:
              no tiene un problema de saldo, todavía no ha empezado a operar.
            </p>
            <ul className="flex flex-col gap-2">
              {alertas.saldo.map((a) => (
                <li key={a.companiaId}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2"
                  style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusChip tone={TONO_NIVEL[a.nivel]}>{NIVEL_RIESGO_BOLSA_LABEL[a.nivel]}</StatusChip>
                      <span className="text-sm font-semibold">{a.companiaNombre}</span>
                    </div>
                    {/* El motivo lo redacta el servidor: es el mismo texto que verá quien reciba la
                        alerta por otro canal, y reescribirlo aquí lo haría divergir. */}
                    <p className="mt-0.5 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{a.mensaje}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-semibold tabular-nums">{pesos(a.saldo)}</span>
                    <button type="button" className={flitBtnSecondarySm}
                      aria-label={`Ver el detalle de la bolsa de ${a.companiaNombre} (compañía)`}
                      onClick={() => onVerCompania({ companiaId: a.companiaId, nombre: a.companiaNombre })}>
                      Ver detalle
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        <TablaCompanias filas={filasCompania} error={errorFilas} onReintentar={reintentar}
          texto={textoBuscado} estado={estado} hayFiltro={hayFiltro}
          onLimpiar={limpiarFiltros} onVerInactivas={() => setEstado('todas')}
          verExpediente={hasFuncion(FUNCION_VER_DOCUMENTOS_BOLSA)}
          onVer={(b) => onVerBolsa({ id: b.id, nombre: b.nombre })} />
      </FlitAcordeon>
      )}

      {mostrarTransitos && (
        <FlitAcordeon
          titulo="Tránsitos"
          cantidad={filasTransito?.length}
          descripcion="Saldo que FLIT precarga para pagar ante las secretarías."
          abierto={verTransitos}
          onToggle={() => setVerTransitos((v) => !v)}
        >
          <TablaTransito filas={filasTransito} error={errorFilas} onReintentar={reintentar}
            texto={textoBuscado} estado={estado} hayFiltro={hayFiltro} onLimpiar={limpiarFiltros}
            puedeVer={hasFuncion('bolsas.transito.ver')}
            onVer={(b) => onVerTransito({ id: b.id, nombre: b.nombre })} />
        </FlitAcordeon>
      )}
    </div>
  );
}

function TablaCompanias({
  filas, error, onReintentar, texto, estado, hayFiltro, onLimpiar, onVerInactivas, onVer, verExpediente,
}: {
  filas: BolsaResumenDto[] | null;
  error: 'permiso' | 'red' | null;
  onReintentar: () => void;
  texto: string;
  estado: FiltroEstado;
  hayFiltro: boolean;
  onLimpiar: () => void;
  onVerInactivas: () => void;
  onVer: (b: BolsaResumenDto) => void;
  /** #13893: `bolsas.documentos.ver`. Sin él (o con 403 del lote) la columna Expediente no existe. */
  verExpediente: boolean;
}) {
  // #13893: un solo lote por carga del listado; la tabla no lo espera.
  const companiaIds = useMemo(() => filas?.map((f) => f.companiaId) ?? null, [filas]);
  const { estado: lote, reintentar: reintentarLote } = useEstadoExpedientes(companiaIds, verExpediente);
  const conExpediente = verExpediente && lote.fase !== 'sin-permiso';

  if (error === 'permiso') {
    return (
      <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>
        No tienes permiso para ver el listado de bolsas. Pídeselo a un administrador.
      </p>
    );
  }
  if (error === 'red') {
    return (
      <div>
        <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>
          No pudimos cargar las bolsas. Revisa tu conexión e intenta de nuevo.
        </p>
        <button type="button" className={`${flitBtnSecondary} mt-3`} style={flitBtnSecondaryStyle} onClick={onReintentar}>
          Reintentar
        </button>
      </div>
    );
  }
  if (filas === null) {
    return <p role="status" className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>Buscando bolsas…</p>;
  }
  if (filas.length === 0) {
    if (!hayFiltro) {
      return (
        <FlitEmpty>
          <span data-testid="sin-bolsas-cliente">
            Ninguna compañía tiene bolsa todavía. Pulsa «Crear bolsa» y elige Compañía.
          </span>
        </FlitEmpty>
      );
    }
    const enQue = estado === 'activas' ? ' en las activas' : estado === 'inactivas' ? ' en las inactivas' : '';
    return (
      <FlitEmpty>
        <div data-testid="sin-bolsas-filtro">
          <p>{texto ? `Ninguna bolsa coincide con «${texto}»${enQue}.` : `No hay bolsas${enQue}.`}</p>
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onLimpiar}>
              Limpiar filtros
            </button>
            {estado === 'activas' && (
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onVerInactivas}>
                Ver también las inactivas
              </button>
            )}
          </div>
        </div>
      </FlitEmpty>
    );
  }

  return (
    <>
    {conExpediente && lote.fase === 'error' && (
      <div role="status" data-testid="aviso-expediente-lote"
        className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
        <span>No pudimos cargar el estado de los documentos.</span>
        <button type="button" className={flitBtnSecondarySm} onClick={reintentarLote}>Reintentar</button>
      </div>
    )}
    <FlitTable label="Bolsas de compañías">
      <thead>
        <tr>
          <FlitTh>Compañía</FlitTh>
          <FlitTh>Estado</FlitTh>
          <FlitTh className="!text-right">Saldo</FlitTh>
          <FlitTh>Nivel</FlitTh>
          {conExpediente && <FlitTh>Expediente<span className="sr-only"> documental</span></FlitTh>}
          <FlitTh><span className="sr-only">Acciones</span></FlitTh>
        </tr>
      </thead>
      <tbody>
        {filas.map((fila) => (
          <FlitTr key={fila.id}>
            <td className="max-w-[16rem] truncate px-4 py-2 text-sm font-semibold" title={fila.nombre}
              data-testid={`fila-bolsa-${fila.companiaId}`}>
              {fila.nombre}
            </td>
            <td className="px-4 py-2">
              <StatusChip tone={fila.activa ? 'success' : 'draft'}>{fila.activa ? 'Activa' : 'Inactiva'}</StatusChip>
            </td>
            <td className="whitespace-nowrap px-4 py-2 text-right text-sm font-semibold tabular-nums"
              style={{ color: fila.saldo < 0 ? 'var(--flit-danger-ink)' : 'var(--flit-text-primary)' }}>
              {fila.saldo < 0 ? `− ${pesos(Math.abs(fila.saldo))}` : pesos(fila.saldo)}
            </td>
            <td className="px-4 py-2">
              <StatusChip tone={TONO_NIVEL[fila.nivel]}>{NIVEL_RIESGO_BOLSA_LABEL[fila.nivel]}</StatusChip>
            </td>
            {conExpediente && (
              <td className="px-4 py-2">
                {fila.companiaId !== null && <ChipExpediente companiaId={fila.companiaId} lote={lote} />}
              </td>
            )}
            <td className="px-4 py-2 text-right">
              <button type="button" className={flitBtnSecondarySm}
                aria-label={`Ver el detalle de la bolsa de ${fila.nombre} (compañía)`}
                onClick={() => onVer(fila)}>
                Ver detalle
              </button>
            </td>
          </FlitTr>
        ))}
      </tbody>
    </FlitTable>
    </>
  );
}

/**
 * Tabla de bolsas de tránsito (HU #13908). Cuatro columnas y la acción: Bolsa, Estado, Saldo y Nivel
 * (en SU escala, con «En préstamo»). Sin columna de expediente: #13407 es solo de compañía.
 */
function TablaTransito({ filas, error, onReintentar, texto, estado, hayFiltro, onLimpiar, onVer, puedeVer }: {
  filas: BolsaResumenDto[] | null;
  error: 'permiso' | 'red' | null;
  onReintentar: () => void;
  texto: string;
  estado: FiltroEstado;
  hayFiltro: boolean;
  onLimpiar: () => void;
  onVer: (b: BolsaResumenDto) => void;
  /** `bolsas.transito.ver`: sin ella no hay «Ver detalle». */
  puedeVer: boolean;
}) {
  if (error === 'permiso') {
    return (
      <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>
        No tienes permiso para ver el listado de bolsas. Pídeselo a un administrador.
      </p>
    );
  }
  if (error === 'red') {
    return (
      <div>
        <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>
          No pudimos cargar las bolsas. Revisa tu conexión e intenta de nuevo.
        </p>
        <button type="button" className={`${flitBtnSecondary} mt-3`} style={flitBtnSecondaryStyle} onClick={onReintentar}>
          Reintentar
        </button>
      </div>
    );
  }
  if (filas === null) {
    return <p role="status" className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>Buscando bolsas…</p>;
  }
  if (filas.length === 0) {
    if (!hayFiltro) {
      return (
        <FlitEmpty>
          <span data-testid="sin-bolsas-transito">
            Todavía no hay bolsas de tránsito. Pulsa «Crear bolsa» y elige Tránsito.
          </span>
        </FlitEmpty>
      );
    }
    const enQue = estado === 'activas' ? ' en las activas' : estado === 'inactivas' ? ' en las inactivas' : '';
    return (
      <FlitEmpty>
        <div data-testid="sin-bolsas-transito-filtro">
          <p>{texto ? `Ninguna bolsa de tránsito coincide con «${texto}»${enQue}.` : `No hay bolsas de tránsito${enQue}.`}</p>
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onLimpiar}>
              Limpiar filtros
            </button>
          </div>
        </div>
      </FlitEmpty>
    );
  }

  return (
    <FlitTable label="Bolsas de tránsito">
      <thead>
        <tr>
          <FlitTh>Bolsa</FlitTh>
          <FlitTh>Estado</FlitTh>
          <FlitTh className="!text-right">Saldo</FlitTh>
          <FlitTh>Nivel</FlitTh>
          <FlitTh><span className="sr-only">Acciones</span></FlitTh>
        </tr>
      </thead>
      <tbody>
        {filas.map((fila) => {
          const nivel = fila.transito?.nivel ?? 'sin_cargas';
          return (
            <FlitTr key={fila.id}>
              <td className="max-w-[16rem] truncate px-4 py-2 text-sm font-semibold" title={fila.nombre}
                data-testid={`fila-bolsa-transito-${fila.id}`}>
                {fila.nombre}
              </td>
              <td className="px-4 py-2">
                <StatusChip tone={fila.activa ? 'success' : 'draft'}>{fila.activa ? 'Activa' : 'Inactiva'}</StatusChip>
              </td>
              <td className="whitespace-nowrap px-4 py-2 text-right text-sm font-semibold tabular-nums"
                style={{ color: fila.saldo < 0 ? 'var(--flit-danger-ink)' : 'var(--flit-text-primary)' }}>
                {saldoConSigno(fila.saldo)}
              </td>
              <td className="px-4 py-2">
                <StatusChip tone={TONO_NIVEL_TRANSITO[nivel]}>{NIVEL_BOLSA_TRANSITO_LABEL[nivel]}</StatusChip>
              </td>
              <td className="px-4 py-2 text-right">
                {puedeVer && (
                  <button type="button" className={flitBtnSecondarySm}
                    aria-label={`Ver el detalle de la bolsa ${fila.nombre} (tránsito)`}
                    onClick={() => onVer(fila)}>
                    Ver detalle
                  </button>
                )}
              </td>
            </FlitTr>
          );
        })}
      </tbody>
    </FlitTable>
  );
}
