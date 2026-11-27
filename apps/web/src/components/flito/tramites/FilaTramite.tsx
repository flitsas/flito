// FLITO — Trámites: una fila de la bandeja. JSX movido desde `pages/FlitoTramites.tsx` al partirla
// (rediseño UI Kit 2026, Épica #14560). Sin estado propio: todo llega por props y los handlers son
// los de la página.
//
// Épica #14707, bloque 4 (UX §5.3): sin columna «Ver»: el ID es un botón con aspecto de enlace que abre el
// detalle (conserva `atributoVer`, adonde vuelve el foco). El chip de estado abre el detalle en Historial.
// Vehículo (ajustes 14707): la placa con su variante (moto / servicio público) —sin placa, la placa VACÍA del
// kit—, y debajo «Marca Línea · tipo», el VIN y el servicio en texto. El documento del propietario va al
// detalle; la factura de venta, a Soportes. Fila muerta (14707 §3): chip Anulado/Revocado, casilla deshabilitada con el motivo,
// sin «Listo para entregar», Solicitar, Desbloquear ni Crear empresa. Sin atenuar la fila.

import StatusChip from '../../flit/StatusChip';
import AntiguedadPill from '../../flit/AntiguedadPill';
import Placa, { PlacaVacia, textoServicioVehiculo } from '../../flit/Placa';
import { FlitTr } from '../../flit/flitPageKit';
import { CeldaFuenteTramite } from '../../flito-tramites/FuenteTramite';
import { CeldaFacturaVenta, CeldaImpuesto, CeldaSoat, TrackingLogistica } from './CeldasTramite';
import { fecha, pesos, type TramiteFila } from './tiposTramites';
import { atributoVer } from './detalle/useDetalleTramite';
import { ChipVigenciaTramite } from './detalle/SeccionesDetalle';

const tenue = 'text-[color:var(--color-text-tertiary)]';
const enlace = 'flit-focus rounded text-xs font-semibold text-[color:var(--color-action)] underline transition-colors hover:text-[color:var(--color-text-primary)]';

export interface FilaTramiteProps {
  f: TramiteFila;
  esOperaciones: boolean;
  seleccionada: boolean;
  onAlternar: () => void;
  /** El chip de estado: abre el detalle en la sección Historial. */
  onHistorial: (f: TramiteFila) => void;
  onFactura: (f: TramiteFila) => void;
  onDesbloqueo: (f: TramiteFila) => void;
  onCrearEmpresa: (f: TramiteFila) => void;
  onSolicitarSoat?: () => void;
  onSolicitarImpuesto?: () => void;
  onSoportes: () => void;
  /** ADR-0046: abre el detalle del trámite en modal (el ID de la fila). */
  onVer: () => void;
  /** Vista de columnas activa (ADR-0045): `false` oculta la celda de esa clave. Sin prop, todas. */
  ver?: (clave: string) => boolean;
}

const todas = () => true;

export default function FilaTramite({
  f, esOperaciones, seleccionada, onAlternar, onHistorial, onFactura, onDesbloqueo, onCrearEmpresa,
  onSolicitarSoat, onSolicitarImpuesto, onSoportes, onVer, ver = todas,
}: FilaTramiteProps) {
  const vigencia = f.vigenciaTramite;
  const muerto = vigencia !== 'vigente';
  const motivoMuerto = vigencia === 'revocado' ? 'revocado' : 'anulado';
  const operable = esOperaciones && !muerto;
  const v = f.vehiculo;
  const servicio = textoServicioVehiculo(v.tipoServicio);
  const marcaLinea = [[v.marca, v.linea].filter(Boolean).join(' '), v.tipoVehiculo].filter(Boolean).join(' · ');
  // Sin placa el nombre accesible usa el ID del trámite: nunca «Seleccionar null».
  const quien = v.placa ?? `el trámite ${f.idFlit}`;
  const noSeleccionable = `No se puede seleccionar ${quien}: el trámite está ${motivoMuerto} en FLIT`;
  return (
    <FlitTr marcada={seleccionada}>
      {esOperaciones && (
        <td className="px-3 py-2">
          {/* HU #11910: la casilla se abre a toda fila VIVA (también las Entregadas). Una muerta (14707)
              queda deshabilitada con el motivo: conserva la alineación y lo dice. */}
          {muerto ? (
            <input type="checkbox" disabled checked={false} readOnly aria-label={noSeleccionable} title={noSeleccionable} className="cursor-not-allowed" />
          ) : (
            <input type="checkbox" aria-label={`Seleccionar ${quien}`} checked={seleccionada} onChange={onAlternar} />
          )}
        </td>
      )}
      {ver('tramite') && (
        <td className="px-3 py-2 align-top">
          <button type="button" {...{ [atributoVer]: f.tramiteId }} onClick={onVer} aria-label={`Ver el detalle del trámite ${f.idFlit}`}
            className="flit-focus rounded text-sm font-semibold tabular-nums text-[color:var(--color-action)] transition-colors hover:underline hover:underline-offset-2">
            {f.idFlit}
          </button>
          {f.tipoTramite && <div className="text-xs text-[color:var(--color-text-secondary)]">{f.tipoTramite}</div>}
          {/* El chip abre el detalle en Historial (consulta: también en un trámite muerto). */}
          <button type="button" onClick={() => onHistorial(f)} title="Ver historial del trámite"
            className="flit-focus mt-1 block cursor-pointer rounded transition-opacity hover:opacity-80">
            {muerto ? <ChipVigenciaTramite vigencia={vigencia} /> : <StatusChip tone={f.asignado ? 'active' : 'neutral'}>{f.estado}</StatusChip>}
          </button>
          {!muerto && f.listoParaEntregar && <div className="mt-1"><StatusChip tone="success">Listo para entregar</StatusChip></div>}
        </td>
      )}
      {ver('fuente') && <CeldaFuenteTramite fuente={f.fuente} />}
      {ver('creado') && (
        <td className="px-3 py-2 align-top">
          <div className="text-sm tabular-nums">{fecha(f.fechaCreacion)}</div>
          <div className="mt-1"><AntiguedadPill desde={f.fechaCreacion} /></div>
        </td>
      )}
      {ver('aprobado') && (
        <td className="px-3 py-2 align-top">
          {f.fechaAprobacion
            ? <div className="text-sm tabular-nums">{fecha(f.fechaAprobacion)}</div>
            : <span className={`text-xs italic ${tenue}`}>Sin aprobar</span>}
        </td>
      )}
      {ver('vehiculo') && (
        <td className="px-3 py-2 align-top">
          <div className="font-medium">
            {/* La línea del servicio ya lo dice en texto: la placa pública no lo repite al lector (1.4.1). */}
            {v.placa
              ? <Placa placa={v.placa} formatear={false} tipoServicio={v.tipoServicio} anunciarServicio={!servicio} />
              : <PlacaVacia />}
          </div>
          {marcaLinea && <div className="mt-1 text-xs text-[color:var(--color-text-secondary)]">{marcaLinea}</div>}
          {v.vin && <div className={`text-xs tabular-nums whitespace-nowrap ${tenue}`}>{v.vin}</div>}
          {servicio && <div className="text-xs text-[color:var(--color-text-secondary)]">{servicio}</div>}
        </td>
      )}
      {ver('comprador') && (
        <td className="px-3 py-2 text-sm align-top">
          {f.compradorPrincipal ? (
            <>
              <div>{f.compradorPrincipal.nombreCompleto}</div>
              {f.compradores.length > 1 && <span className={`text-xs ${tenue}`}>{f.compradores.length} propietarios</span>}
            </>
          ) : '—'}
        </td>
      )}
      {/* Columna propia: bajo el comprador el correo se leía como un dato más de su
          ficha, y es por donde se le escribe al responsable del trámite. */}
      {ver('correo') && (
        <td className="px-3 py-2 text-sm align-top">
          {f.compradorPrincipal?.correo
            ? (
              <a href={`mailto:${f.compradorPrincipal.correo}`}
                className="flit-focus rounded text-xs break-all text-[color:var(--color-action)] transition-colors hover:underline">{f.compradorPrincipal.correo}</a>
            )
            : <span className={`text-xs italic ${tenue}`}>Sin correo</span>}
        </td>
      )}
      {ver('nombre_gestor') && (
        <td className="px-3 py-2 text-sm align-top">{f.nombreGestor ?? '—'}</td>
      )}
      {ver('correo_gestor') && (
        <td className="px-3 py-2 text-sm align-top">
          {f.correoGestor
            ? (
              <a href={`mailto:${f.correoGestor}`}
                className="flit-focus rounded text-xs break-all text-[color:var(--color-action)] transition-colors hover:underline">{f.correoGestor}</a>
            )
            : '—'}
        </td>
      )}
      {/* Empresa gestora (CompaniaGestora de FLIT ↔ cliente FLITO): nombre arriba, NIT abajo. */}
      {ver('empresa_gestora') && (
        <td className="px-3 py-2 text-sm align-top">
          {f.empresaExiste ? (
            <>
              <div>{f.companiaNombre}</div>
              {f.empresaNit && <div className={`text-xs tabular-nums ${tenue}`}>NIT {f.empresaNit}</div>}
              {/* Solo cuando hay algo que desbloquear o que revocar: en la inmensa mayoría
                  de filas la compañía no autogestiona nada y el botón sería ruido. */}
              {operable && (f.soatAutogestionado || f.impuestosAutogestionado || f.excepcionesAutogestion.length > 0) && (
                <button className={`mt-1 block ${enlace}`}
                  onClick={() => onDesbloqueo(f)}>
                  {f.excepcionesAutogestion.length > 0 ? 'Autogestión desbloqueada' : 'Desbloquear'}
                </button>
              )}
            </>
          ) : (
            <>
              <div className={`text-xs tabular-nums ${tenue}`}>{f.empresaNit ? `NIT ${f.empresaNit}` : '—'}</div>
              <div className="mt-1"><StatusChip tone="danger">Empresa no existe</StatusChip></div>
              {operable && f.empresaNit && (
                <button className={`mt-1 block ${enlace}`}
                  onClick={() => onCrearEmpresa(f)}>Crear empresa</button>
              )}
            </>
          )}
        </td>
      )}
      {/* Tránsito (secretaría emparejada por ciudad→DIVIPOLA). */}
      {ver('transito') && (
        <td className="px-3 py-2 text-sm align-top">
          <div>{f.organismoNombre ?? '—'}</div>
          {!f.secretariaEmparejada && <div className="mt-1"><StatusChip tone="warning">Secretaría sin emparejar</StatusChip></div>}
        </td>
      )}
      {ver('ciudad') && <td className="px-3 py-2 text-xs align-top">{f.ciudad ?? '—'}</td>}
      {ver('soat') && <td className="px-3 py-2 align-top"><CeldaSoat fila={f} onSolicitar={onSolicitarSoat} /></td>}
      {ver('impuestos') && <td className="px-3 py-2 align-top"><CeldaImpuesto fila={f} onSolicitar={onSolicitarImpuesto} /></td>}
      {ver('logistica') && <td className="px-3 py-2 align-top"><TrackingLogistica estado={f.logistica?.estado ?? null} /></td>}
      {ver('derechos_transito') && (
        <td
          className={`px-3 py-2 text-sm align-top tabular-nums whitespace-nowrap ${f.derechoTramiteValor !== null ? '' : tenue}`}
          title={f.derechoTramiteValor !== null
            ? 'Valor leído del recibo del organismo'
            : 'Aún no se ha cargado el recibo del organismo'}
        >
          {/* Sin recibo NO se pinta un estimado. Antes salía «$ 75.000 *», una constante
              igual para todos los organismos: un número inventado que se lee como un
              cobro real y que el reporte de costos ya dejó de mostrar. Decir que falta
              obliga a cargarlo; inventarlo invita a darlo por bueno.
  
              Y dice «Sin recibo», no «No configurado»: el derecho de tránsito no se
              configura en ninguna pantalla. Es un desembolso real que se lee del recibo
              pagado, como el SOAT y el impuesto. El rótulo viejo mandaba a buscar una
              parametrización que no existe. */}
          {f.derechoTramiteValor !== null
            ? pesos(f.derechoTramiteValor)
            : <span className="text-xs italic">Sin recibo</span>}
        </td>
      )}
      {/* Los comprobantes de los tres conceptos —SOAT, impuesto y derecho de tránsito—
          más lo que dejó logística. Quien despacha desde aquí es quien tiene que
          comprobar que el papel existe antes de entregar, y hasta ahora para verlo
          había que irse al reporte de costos o a la tabla de derechos. */}
      {ver('soportes') && (
        <td className="px-3 py-2 align-top">
          <button type="button" className={`block ${enlace}`} onClick={onSoportes}>Ver soportes</button>
          <div className="mt-1"><CeldaFacturaVenta fila={f} onVer={onFactura} /></div>
        </td>
      )}
    </FlitTr>
  );
}
