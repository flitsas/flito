// Tabla de la cola SOAT con su paginación (HU #12819, fase 0): movida tal cual desde
// `pages/FlitoSoat.tsx`. La selección vive en la página (la usan la barra de envío y el ZIP).

import { EstadoSoat } from '@operaciones/shared-types';
import StatusChip from '../../flit/StatusChip';
import AntiguedadPill from '../../flit/AntiguedadPill';
import ChipSinGestion from '../../flit/ChipSinGestion';
import Paginacion from '../../flit/Paginacion';
import { CeldaFechas } from '../../flit/columnasComunes';
import CeldaVehiculoSoat from '../CeldaVehiculoSoat';
import { CeldaVigenciaSoat } from '../VigenciaSoat';
import { CasillaSoat } from '../BarraEnvioSoat';
import { BotonComprobanteFila, type EstadoDescargaComprobante } from '../DescargarComprobanteSoat';
import { FlitCard, FlitTable, FlitTh, FlitTr, flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';
import ChipEstadoSoat from './ChipEstadoSoat';
import { fecha, pesos, type ColaSoat, type SoatItem } from './tipos';

export interface TablaColaSoatProps {
  data: ColaSoat; filas: SoatItem[]; totalPaginas: number;
  onPrev: () => void; onNext: () => void;
  conCasillas: boolean; seleccion: Set<string>; setSeleccion: (s: Set<string>) => void;
  seleccionables: SoatItem[]; toggle: (id: string) => void;
  esCliente: boolean; puedeDescargar: boolean; descargaComprobante: EstadoDescargaComprobante;
  onVer: (id: string) => void;
}

export default function TablaColaSoat({
  data, filas, totalPaginas, onPrev, onNext, conCasillas, seleccion, setSeleccion, seleccionables, toggle,
  esCliente, puedeDescargar, descargaComprobante, onVer,
}: TablaColaSoatProps) {
  return (
        <FlitCard>
          <div className="mb-3">
            <Paginacion total={data.total} page={data.page} totalPaginas={totalPaginas} sustantivo="SOAT"
              onPrev={onPrev} onNext={onNext} />
          </div>
          <FlitTable label="Pólizas SOAT">
            <thead>
              <FlitTr>
                {/* Cuelga del PERMISO y no de «hay filas accionables»: para el auditor aquel
                    cálculo daba vacío por casualidad, y lo que se quiere sostener es la afirmación
                    (AC7). El nombre accesible cambia con el sentido: ya no marca «los pendientes». */}
                {conCasillas && (
                  <FlitTh>
                    <CasillaSoat cabecera etiqueta="Seleccionar las filas de esta página"
                      marcada={seleccion.size > 0 && seleccion.size === seleccionables.length}
                      onCambio={(m) => setSeleccion(m ? new Set(seleccionables.map((f) => f.id)) : new Set())} />
                  </FlitTh>
                )}
                {/* Rótulos literales y NO `ENCABEZADOS_COMUNES.slice(1)`: atar los encabezados de
                    esta cola a una posición dentro de un array de otras tres pantallas los cambiaría
                    en silencio el día que alguien lo reordene. */}
                <FlitTh>Vehículo</FlitTh><FlitTh>Fechas</FlitTh>
                <FlitTh>Compañía</FlitTh>
                {!esCliente && <FlitTh>Gestiona</FlitTh>}
                <FlitTh>Estado</FlitTh>
                <FlitTh>Solicitado</FlitTh><FlitTh>Pagado</FlitTh>
                {!esCliente && <FlitTh>Valor</FlitTh>}
                <FlitTh />
              </FlitTr>
            </thead>
            <tbody>
              {filas.map((f) => (
                <FlitTr key={f.id}>
                  {conCasillas && (
                    <CasillaSoat etiqueta={`Seleccionar ${f.placa ?? f.vin}`} marcada={seleccion.has(f.id)}
                      onCambio={() => toggle(f.id)} />
                  )}
                  <CeldaVehiculoSoat placa={f.placa} vin={f.vin} marca={f.marca} linea={f.linea}
                    cilindraje={f.cilindraje} carroceria={f.carroceria} tipoServicio={f.tipoServicio}
                    multiplePropietario={f.esMultiplePropietario} />
                  <CeldaFechas creado={f.fechaCreacion} aprobado={f.fechaAprobacion} />
                  <td className="px-3 py-2 text-sm">{f.companiaNombre}</td>
                  {!esCliente && <CeldaGestion soat={f} />}
                  {/* La vigencia entra AQUÍ y no en una columna nueva: esta celda es, desde la HU
                      #11905, donde viven las señales temporales de riesgo del mismo SOAT, y una
                      columna más devolvería la tabla a 11 y con ella el desborde a 1280 px que
                      aquella HU quitó. Las dos ocupaciones son casi disjuntas —«sin gestión» solo
                      sale en `solicitado` estancado y la vigencia solo en filas con comprobante—,
                      así que la celda sigue teniendo como mucho dos pastillas. */}
                  <td className="px-3 py-2">
                    <div className="flex flex-col items-start gap-1">
                      <ChipEstadoSoat estado={f.estado} />
                      {f.estancado && <ChipSinGestion desde={f.enviadoEn} />}
                      {!esCliente && <CeldaVigenciaSoat vigencia={f.vigencia} />}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-sm">
                    <div className="tabular-nums">{f.enviadoEn ? fecha(f.enviadoEn) : '—'}</div>
                    {/* Ya pagado: los días transcurridos desde la solicitud dejan de ser una señal
                        de riesgo y solo ensucian. El chip de sin gestión ya desaparece al pagar. */}
                    {f.enviadoEn && f.estado !== EstadoSoat.PAGADO && (
                      <div className="mt-1"><AntiguedadPill desde={f.enviadoEn} /></div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-sm tabular-nums">{f.pagadoEn ? fecha(f.pagadoEn) : '—'}</td>
                  {!esCliente && <td className="px-3 py-2 text-sm tabular-nums">{pesos(f.valorPagado)}</td>}
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2 whitespace-nowrap">
                      {puedeDescargar && <BotonComprobanteFila soat={f} descarga={descargaComprobante} />}
                      <button className={flitBtnSecondary} style={flitBtnSecondaryStyle}
                        onClick={() => onVer(f.id)}>Ver</button>
                    </div>
                  </td>
                </FlitTr>
              ))}
            </tbody>
          </FlitTable>
          <div className="mt-3">
            <Paginacion total={data.total} page={data.page} totalPaginas={totalPaginas} sustantivo="SOAT"
              onPrev={onPrev} onNext={onNext} />
          </div>
        </FlitCard>
  );
}

/**
 * Quién gestiona el SOAT. Reutiliza la columna del proveedor en vez de añadir una nueva: la cola ya
 * va ancha. En los que Operaciones retomó se dice de quién, que es el dato que hace útil el botón
 * de devolver. El distintivo lleva texto y no solo color.
 */
function CeldaGestion({ soat }: { soat: SoatItem }) {
  if (!soat.gestionOperaciones) {
    return <td className="px-3 py-2 text-sm">{soat.proveedorSoatNombre ?? '—'}</td>;
  }
  return (
    <td className="px-3 py-2 text-sm">
      <StatusChip tone="warning">Operaciones</StatusChip>
      {soat.proveedorSoatNombre && (
        <div className="mt-0.5 text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
          retomado de {soat.proveedorSoatNombre}
        </div>
      )}
    </td>
  );
}
