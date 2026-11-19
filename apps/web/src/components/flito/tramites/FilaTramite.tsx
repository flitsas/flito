// FLITO — Trámites: una fila de la bandeja. JSX movido desde `pages/FlitoTramites.tsx` al partirla
// (rediseño UI Kit 2026, Épica #14560). Sin estado propio: todo llega por props y los handlers son
// los de la página.

import StatusChip from '../../flit/StatusChip';
import AntiguedadPill from '../../flit/AntiguedadPill';
import Placa from '../../flit/Placa';
import { FlitTr } from '../../flit/flitPageKit';
import { documentoConTipo } from '../../flit/columnasComunes';
import { CeldaFuenteTramite } from '../../flito-tramites/FuenteTramite';
import { CeldaFacturaVenta, CeldaImpuesto, CeldaSoat, TrackingLogistica } from './CeldasTramite';
import { fecha, pesos, type TramiteFila } from './tiposTramites';
import { claseBoton } from '../../flit/GradientButton';
import { atributoVer } from './detalle/useDetalleTramite';

const tenue = 'text-[color:var(--color-text-tertiary)]';
const enlace = 'flit-focus rounded text-xs font-semibold text-[color:var(--color-action)] underline transition-colors hover:text-[color:var(--color-text-primary)]';

export interface FilaTramiteProps {
  f: TramiteFila;
  esOperaciones: boolean;
  seleccionada: boolean;
  onAlternar: () => void;
  onHistorial: (f: TramiteFila) => void;
  onFactura: (f: TramiteFila) => void;
  onDesbloqueo: (f: TramiteFila) => void;
  onCrearEmpresa: (f: TramiteFila) => void;
  onSolicitarSoat?: () => void;
  onSolicitarImpuesto?: () => void;
  onSoportes: () => void;
  /** ADR-0046: abre el detalle del trámite en modal. Sin prop, la columna no se pinta. */
  onVer?: () => void;
  /** Vista de columnas activa (ADR-0045): `false` oculta la celda de esa clave. Sin prop, todas. */
  ver?: (clave: string) => boolean;
}

const todas = () => true;

export default function FilaTramite({
  f, esOperaciones, seleccionada, onAlternar, onHistorial, onFactura, onDesbloqueo, onCrearEmpresa,
  onSolicitarSoat, onSolicitarImpuesto, onSoportes, onVer, ver = todas,
}: FilaTramiteProps) {
  return (
    <FlitTr marcada={seleccionada}>
      {esOperaciones && (
        <td className="px-3 py-2">
          {/* Sin `disabled` desde la HU #11910: el que estaba dejaba fuera a los
              Entregados, que son justo los que tienen la evidencia completa que alguien
              va a buscar. Lo que la fila admite lo dice ahora el rótulo de las acciones. */}
          <input type="checkbox" aria-label={`Seleccionar ${f.vehiculo.placa}`}
            checked={seleccionada}
            onChange={onAlternar} />
        </td>
      )}
      {onVer && (
        <td className="px-3 py-2 align-top">
          <button type="button" {...{ [atributoVer]: f.tramiteId }} onClick={onVer}
            aria-label={`Ver el detalle del trámite ${f.idFlit}`} className={claseBoton('secondary', 'sm')}>Ver</button>
        </td>
      )}
      {ver('tramite') && (
        <td className="px-3 py-2 align-top">
          <div className={`text-xs tabular-nums ${tenue}`}>{f.idFlit}</div>
          {f.tipoTramite && <div className="text-xs text-[color:var(--color-text-secondary)]">{f.tipoTramite}</div>}
          {/* Estado del trámite: al hacer click abre el historial (cursor pointer + hover). */}
          <button type="button" onClick={() => onHistorial(f)} title="Ver historial del trámite"
            className="flit-focus mt-1 block cursor-pointer rounded transition-opacity hover:opacity-80">
            <StatusChip tone={f.asignado ? 'active' : 'neutral'}>{f.estado}</StatusChip>
          </button>
          {f.listoParaEntregar && <div className="mt-1"><StatusChip tone="success">Listo para entregar</StatusChip></div>}
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
          <div className="font-medium">{f.vehiculo.placa ? <Placa placa={f.vehiculo.placa} formatear={false} /> : '—'}</div>
          <div className={`mt-1 text-xs ${tenue}`}>{f.vehiculo.marca} {f.vehiculo.linea}{f.vehiculo.tipoVehiculo ? ` · ${f.vehiculo.tipoVehiculo}` : ''}</div>
          <div className={`text-xs tabular-nums ${tenue}`}>{f.vehiculo.vin}</div>
          <div className="mt-1"><CeldaFacturaVenta fila={f} onVer={onFactura} /></div>
        </td>
      )}
      {ver('comprador') && (
        <td className="px-3 py-2 text-sm">
          {f.compradorPrincipal ? (
            <>
              <div>{f.compradorPrincipal.nombreCompleto}</div>
              <div className={`text-xs tabular-nums ${tenue}`}>{documentoConTipo(f.compradorPrincipal.tipoDocumento, f.compradorPrincipal.numeroDocumento)}</div>
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
      {/* Empresa gestora (CompaniaGestora de FLIT ↔ cliente FLITO): nombre arriba, NIT abajo. */}
      {ver('empresa_gestora') && (
        <td className="px-3 py-2 text-sm align-top">
          {f.empresaExiste ? (
            <>
              <div>{f.companiaNombre}</div>
              {f.empresaNit && <div className={`text-xs tabular-nums ${tenue}`}>NIT {f.empresaNit}</div>}
              {/* Solo cuando hay algo que desbloquear o que revocar: en la inmensa mayoría
                  de filas la compañía no autogestiona nada y el botón sería ruido. */}
              {esOperaciones && (f.soatAutogestionado || f.impuestosAutogestionado || f.excepcionesAutogestion.length > 0) && (
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
              {esOperaciones && f.empresaNit && (
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
          <button type="button" className={enlace} onClick={onSoportes}>
            Ver soportes
          </button>
        </td>
      )}
    </FlitTr>
  );
}
