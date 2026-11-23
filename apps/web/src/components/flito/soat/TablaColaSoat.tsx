// Tabla de la cola SOAT con su paginación (HU 12819). La selección vive en la página (la usan la
// barra de envío y el ZIP).
//
// Orden de columnas desde la HU 12819 (§5.4): Vehículo · **Estado** · Compañía · Gestiona ·
// Solicitado · Pagado · Valor · acciones. El Estado sube de 5.ª a 2.ª porque es lo que decide si se
// abre la fila, y a 375 px placa + estado caben en la primera vista. La columna «Fechas» (creado y
// aprobado del TRÁMITE en FLIT) pasó al detalle (P-2): es un dato de consulta, no de decisión.
//
// Épica #14560 (`docs/ux/flito-soat-impuestos-patron-unificado.md` §3.5, disposición A): la tabla es el
// `DataTable` del kit, como la de Impuestos — mismos 4 estados y el mismo modo tarjeta por debajo de
// 900 px. Sin cambio de comportamiento: mismas columnas por rol, misma fila marcada (velo + filete),
// las solicitudes incompletas ANTES de los SOAT (`filasPrevias`) y los mismos nombres accesibles.

import { EstadoSoat, type SolicitudIncompletaFila } from '@operaciones/shared-types';
import StatusChip from '../../flit/StatusChip';
import { Icono } from '../../flit/kit/Icono';
import AntiguedadPill from '../../flit/AntiguedadPill';
import ChipSinGestion from '../../flit/ChipSinGestion';
import Paginacion from '../../flit/Paginacion';
import DataTable, { type ColumnaTabla } from '../../flit/DataTable';
import CeldaVehiculoSoat from '../CeldaVehiculoSoat';
import { CeldaVigenciaSoat } from '../VigenciaSoat';
import { CasillaSoat } from '../BarraEnvioSoat';
import { BotonComprobanteFila, type EstadoDescargaComprobante } from '../DescargarComprobanteSoat';
import { flitBtnSecondarySm } from '../../flit/flitPageKit';
import ChipEstadoSoat from './ChipEstadoSoat';
import FilaIncompletaSoat from './FilaIncompletaSoat';
import { fecha, pesos, type ColaSoat, type SoatItem } from './tipos';

export interface TablaColaSoatProps {
  /** La página que se pinta: la de la cola o, en «Por validar»/«Descartadas», la de las incompletas. */
  data: Pick<ColaSoat, 'total' | 'page'>; filas: SoatItem[]; totalPaginas: number;
  /**
   * Solicitudes aparcadas porque el RUNT no respondió (HU 12997). Van ANTES de los SOAT: en «Todos»
   * son la cabeza de la primera página, y en sus pastillas son lo único que hay.
   */
  incompletas?: SolicitudIncompletaFila[];
  puedeVerIncompleta?: boolean;
  onVerIncompleta?: (f: SolicitudIncompletaFila) => void;
  /** HU 12998: reintento de la consulta al RUNT (sin la función, ni se pinta). */
  puedeReintentarIncompleta?: boolean;
  /** `soat.solicitud.crear` (HU 14137). */
  puedeCompletarIncompleta?: boolean;
  incompletasEnVuelo?: Record<string, unknown>;
  onReintentarIncompleta?: (f: SolicitudIncompletaFila) => void;
  /** Lo que cuenta la paginación: «SOAT» o, en las pastillas nuevas, «solicitudes». */
  sustantivo?: string;
  /** «1 solicitud»: el sustantivo en singular para `Paginacion`. */
  sustantivoSingular?: string;
  onPrev: () => void; onNext: () => void;
  conCasillas: boolean; seleccion: Set<string>; setSeleccion: (s: Set<string>) => void;
  seleccionables: SoatItem[]; toggle: (id: string) => void;
  esCliente: boolean; puedeDescargar: boolean; descargaComprobante: EstadoDescargaComprobante;
  /** Compañía se pinta al Cliente solo si su cola tiene más de una (§3). */
  conCompania: boolean;
  onVer: (id: string) => void;
}

export default function TablaColaSoat({
  data, filas, totalPaginas, onPrev, onNext, conCasillas, seleccion, setSeleccion, seleccionables, toggle,
  esCliente, puedeDescargar, descargaComprobante, conCompania, onVer,
  incompletas = [], puedeVerIncompleta = false, onVerIncompleta = () => {}, sustantivo = 'SOAT', sustantivoSingular,
  puedeReintentarIncompleta = false, puedeCompletarIncompleta = false, incompletasEnVuelo = {}, onReintentarIncompleta,
}: TablaColaSoatProps) {
  const paginacion = { total: data.total, page: data.page, totalPaginas, sustantivo, singular: sustantivoSingular, onPrev, onNext };

  // Rótulos literales y NO `ENCABEZADOS_COMUNES.slice(1)`: atar los encabezados de esta cola a una
  // posición dentro de un array de otras tres pantallas los cambiaría en silencio el día que alguien
  // lo reordene.
  const columnas: ColumnaTabla<SoatItem>[] = [
    // Cuelga del PERMISO y no de «hay filas accionables»: para el auditor aquel cálculo daba vacío por
    // casualidad, y lo que se quiere sostener es la afirmación (AC7). El nombre accesible cambia con
    // el sentido: ya no marca «los pendientes».
    ...(conCasillas ? [{
      key: 'sel', etiqueta: 'Seleccionar', className: 'w-10 transition-colors hover:bg-[var(--kit-hover)]',
      header: (
        <CasillaSoat cabecera etiqueta="Seleccionar las filas de esta página"
          marcada={seleccion.size > 0 && seleccion.size === seleccionables.length}
          onCambio={(m) => setSeleccion(m ? new Set(seleccionables.map((f) => f.id)) : new Set())} />
      ),
      // `cabecera` aquí solo quiere decir «sin `<td>` propio»: la celda la pone el `DataTable`.
      render: (f: SoatItem) => (
        <CasillaSoat cabecera etiqueta={`Seleccionar ${f.placa ?? f.vin}`} marcada={seleccion.has(f.id)} onCambio={() => toggle(f.id)} />
      ),
    }] : []),
    {
      key: 'vehiculo', header: 'Vehículo',
      render: (f) => (
        <CeldaVehiculoSoat placa={f.placa} vin={f.vin} marca={f.marca} linea={f.linea}
          cilindraje={f.cilindraje} carroceria={f.carroceria} tipoServicio={f.tipoServicio}
          multiplePropietario={f.esMultiplePropietario} tipoSoat={f.tipoSoat} />
      ),
    },
    {
      // La vigencia entra AQUÍ y no en una columna nueva: esta celda es, desde la HU 11905, donde viven
      // las señales temporales de riesgo del mismo SOAT, y una columna más devolvería la tabla a 11 y
      // con ella el desborde a 1280 px que aquella HU quitó. Las dos ocupaciones son casi disjuntas
      // —«sin gestión» solo sale en `solicitado` estancado y la vigencia solo en filas con
      // comprobante—, así que la celda sigue teniendo como mucho dos pastillas.
      key: 'estado', header: 'Estado',
      render: (f) => (
        <div className="flex flex-col items-start gap-1">
          <ChipEstadoSoat estado={f.estado} />
          {f.estancado && <ChipSinGestion desde={f.enviadoEn} />}
          {!esCliente && <CeldaVigenciaSoat vigencia={f.vigencia} />}
        </div>
      ),
    },
    ...(conCompania ? [{ key: 'compania', header: 'Compañía', render: (f: SoatItem) => <span className="text-sm">{f.companiaNombre}</span> }] : []),
    ...(!esCliente ? [{ key: 'gestiona', header: 'Gestiona', render: (f: SoatItem) => <CeldaGestion soat={f} /> }] : []),
    {
      key: 'solicitado', header: 'Solicitado',
      render: (f) => (
        <div className="text-sm">
          <div className="tabular-nums">{f.enviadoEn ? fecha(f.enviadoEn) : '—'}</div>
          {/* Ya pagado: los días transcurridos desde la solicitud dejan de ser una señal de riesgo y
              solo ensucian. El chip de sin gestión ya desaparece al pagar. */}
          {f.enviadoEn && f.estado !== EstadoSoat.PAGADO && (
            <div className="mt-1"><AntiguedadPill desde={f.enviadoEn} /></div>
          )}
        </div>
      ),
    },
    { key: 'pago', header: 'Pagado', render: (f) => <span className="text-sm tabular-nums">{f.pagadoEn ? fecha(f.pagadoEn) : '—'}</span> },
    ...(!esCliente ? [{
      key: 'valor', header: 'Valor', align: 'right' as const,
      render: (f: SoatItem) => <span className="whitespace-nowrap text-sm tabular-nums">{pesos(f.valorPagado)}</span>,
    }] : []),
    {
      key: 'acciones', header: <span className="sr-only">Acciones</span>, acciones: true,
      render: (f) => (
        <div className="flex items-center gap-2 whitespace-nowrap">
          {puedeDescargar && <BotonComprobanteFila soat={f} descarga={descargaComprobante} />}
          {/* `h-7`, el compacto del kit: dentro de la celda el botón no manda más que el dato.
              El chevrón dice que abre algo; el nombre accesible sigue siendo «Ver». */}
          <button type="button" className={flitBtnSecondarySm} onClick={() => onVer(f.id)}>
            Ver
            <Icono nombre="derecha" size={16} className="-mr-1 shrink-0" />
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <Paginacion {...paginacion} />
      {/* `regionDesplazable`: la región «Pólizas SOAT» que ya nombraba `FlitTable` (la usan los E2E y
          el lector de pantalla). La paginación va fuera, arriba y abajo, como antes de la migración. */}
      <DataTable ariaLabel="Pólizas SOAT" regionDesplazable="Pólizas SOAT" columnas={columnas} filas={filas} getKey={(f) => f.id}
        filaMarcada={(f) => seleccion.has(f.id)}
        filasPrevias={incompletas.map((f) => (
          <FilaIncompletaSoat key={`inc-${f.id}`} fila={f} conCasillas={conCasillas} conCompania={conCompania}
            esCliente={esCliente} puedeVer={puedeVerIncompleta} onVer={onVerIncompleta}
            puedeReintentar={puedeReintentarIncompleta} puedeCompletar={puedeCompletarIncompleta} consultando={f.id in incompletasEnVuelo}
            onReintentar={onReintentarIncompleta} />
        ))} />
      <Paginacion {...paginacion} />
    </div>
  );
}

/**
 * Quién gestiona el SOAT. Reutiliza la columna del proveedor en vez de añadir una nueva: la cola ya
 * va ancha. En los que Operaciones retomó se dice de quién, que es el dato que hace útil el botón
 * de devolver. El distintivo lleva texto y no solo color.
 */
function CeldaGestion({ soat }: { soat: SoatItem }) {
  if (!soat.gestionOperaciones) {
    return <span className="text-sm">{soat.proveedorSoatNombre ?? '—'}</span>;
  }
  return (
    <div className="text-sm">
      <StatusChip tone="warning">Operaciones</StatusChip>
      {soat.proveedorSoatNombre && (
        <div className="mt-0.5 text-xs text-[color:var(--color-text-tertiary)]">
          retomado de {soat.proveedorSoatNombre}
        </div>
      )}
    </div>
  );
}
