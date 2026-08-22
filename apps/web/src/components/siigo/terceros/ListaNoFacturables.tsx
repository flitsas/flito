// Bloque B — los clientes que todavía no se pueden facturar (HU #11299, AC2, AC4 y AC6).
//
// Cómo se prioriza cuando a un cliente le faltan seis datos: **no se prioriza dentro del cliente**
// —hay que llenarlos todos— sino ENTRE clientes, desde el resumen de arriba. Por eso esta lista no
// lleva números de prioridad ni colores por campo: sería una jerarquía inventada.
//
// «Llevar a su ficha en Clientes» se resuelve REUSANDO el modal `FichaFiscal`, no navegando: hoy
// `/clients` no tiene enlace profundo (guarda el cliente abierto en estado local), así que navegar
// significaría aterrizar en un listado de 500 y buscar a mano — y además metería un identificador
// de cliente en la URL, que es justo lo que el §14 de AGENTS.md prohíbe.
//
// **Sincronizar se ofrece también aquí, a clientes NO facturables, y es deliberado.**
// `asegurarTercero` exige facturabilidad solo en las ramas que ESCRIBEN en Siigo; la rama que
// VINCULA un tercero que Siigo ya tiene funciona con la ficha local incompleta y encima rellena los
// huecos con lo que Siigo sabe. Esconder el botón mataría justo el camino que rescata estas fichas.
// Lo que no se ofrece es meterlos en la tanda del bloque D: eso lo prohíbe el AC6.

import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react';
import {
  MOTIVOS_NO_FACTURABLE,
  type MotivoNoFacturable,
  type VeredictoCliente,
} from '@operaciones/shared-types';
import { api, errorMessage } from '../../../lib/api';
import Paginacion from '../../flit/Paginacion';
import StatusChip from '../../flit/StatusChip';
import { FlitCard, flitBtnSecondary, flitBtnSecondarySm, flitBtnSecondaryStyle } from '../../flit/flitPageKit';
import BotonAccion from './BotonAccion';
import FaltantesCliente from './FaltantesCliente';
import {
  DESENLACE, agruparFaltantes, esSinRespuesta, rechazoDeFicha,
  type RechazoDeFicha, type ResultadoTercero,
} from './tipos';

const POR_PAGINA = 50;

/**
 * La explicación del permiso se escribe UNA vez por bloque y todos los botones la referencian con
 * `aria-describedby`: repetirla en cincuenta filas serían cincuenta anuncios idénticos.
 */
const ID_EXPLICACION_PERMISO = 'permiso-terceros-lista';

/** El desenlace de sincronizar UNA fila, o su fallo. Vive en la fila y no en un toast que se va. */
type EstadoFila =
  | { fase: 'corriendo' }
  | { fase: 'ok'; resultado: ResultadoTercero }
  | { fase: 'ficha'; rechazo: RechazoDeFicha }
  | { fase: 'error'; mensaje: string; sinRespuesta: boolean };

interface Props {
  version: number;
  motivo: MotivoNoFacturable | null;
  onQuitarFiltro: () => void;
  puedeSincronizar: boolean;
  simulado: boolean;
  onAbrirFicha: (clienteId: number, nombre: string) => void;
  onCambio: () => void;
  tituloRef: RefObject<HTMLHeadingElement>;
}

export default function ListaNoFacturables({
  version, motivo, onQuitarFiltro, puedeSincronizar,
  simulado, onAbrirFicha, onCambio, tituloRef,
}: Props) {
  const [filas, setFilas] = useState<VeredictoCliente[]>([]);
  const [total, setTotal] = useState(0);
  const [pagina, setPagina] = useState(1);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [abierta, setAbierta] = useState<number | null>(null);
  const [sincronizacion, setSincronizacion] = useState<Record<number, EstadoFila>>({});
  const [duplicados, setDuplicados] = useState<{ texto: string; alerta: boolean } | null>(null);

  // El filtro cambia la lista entera: seguir en la página 4 mostraría un vacío que no lo es.
  useEffect(() => { setPagina(1); }, [motivo]);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const offset = (pagina - 1) * POR_PAGINA;
      // `motivo` es un código de catálogo, no un dato de nadie: puede viajar en la query del API.
      // El nombre y el documento NO — por eso no hay búsqueda por texto contra el servidor.
      const filtro = motivo === null ? '' : `&motivo=${encodeURIComponent(motivo)}`;
      const r = await api.get<{ total: number; data: VeredictoCliente[] }>(
        `/siigo/clientes/validacion/detalle?limit=${POR_PAGINA}&offset=${offset}${filtro}`,
      );
      setFilas(r.data ?? []);
      setTotal(r.total ?? 0);
    } catch (e) {
      setError(errorMessage(e));
      setFilas([]);
    } finally {
      setCargando(false);
    }
  }, [motivo, pagina]);

  useEffect(() => { void cargar(); }, [cargar, version]);

  const totalPaginas = Math.max(1, Math.ceil(total / POR_PAGINA));

  const sincronizar = async (clienteId: number) => {
    setSincronizacion((p) => ({ ...p, [clienteId]: { fase: 'corriendo' } }));
    try {
      const r = await api.post<ResultadoTercero>(`/siigo/terceros/cliente/${clienteId}`);
      setSincronizacion((p) => ({ ...p, [clienteId]: { fase: 'ok', resultado: r } }));
      onCambio();
    } catch (e) {
      const ficha = rechazoDeFicha(e);
      setSincronizacion((p) => ({
        ...p,
        [clienteId]: ficha !== null
          ? { fase: 'ficha', rechazo: ficha }
          : { fase: 'error', mensaje: errorMessage(e), sinRespuesta: esSinRespuesta(e) },
      }));
    }
  };

  /**
   * Volver a revisar los conflictos de identidad (acción secundaria del motivo «identificación
   * duplicada»).
   *
   * Es idempotente y **quita** marcas de conflictos ya resueltos: sin él ese contador no baja nunca
   * y la lista deja de mirarse. La interfaz NUNCA dice con qué otro cliente choca —el backend
   * tampoco lo dice—: son datos de un tercero que no es el que se está mirando.
   */
  const recalcularDuplicados = async () => {
    setDuplicados(null);
    try {
      const r = await api.post<{ marcados: number; desmarcados: number }>(
        '/siigo/clientes/validacion/recalcular-duplicados',
      );
      setDuplicados({ texto: `Se marcaron ${r.marcados} y se quitaron ${r.desmarcados}.`, alerta: false });
      onCambio();
    } catch (e) {
      setDuplicados({ texto: `No se pudo revisar los duplicados: ${errorMessage(e)}`, alerta: true });
    }
  };

  return (
    <FlitCard>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3
          ref={tituloRef}
          tabIndex={-1}
          className="flit-focus rounded text-base font-semibold"
          style={{ color: 'var(--flit-text-primary)' }}
        >
          Clientes que todavía no
        </h3>
        {motivo !== null && (
          <button type="button" onClick={onQuitarFiltro} className={flitBtnSecondarySm} style={flitBtnSecondaryStyle}>
            Quitar filtro
          </button>
        )}
      </div>

      {motivo !== null && (
        <p className="mt-1 text-sm" style={{ color: 'var(--flit-text-muted)' }}>
          Filtrado por: {MOTIVOS_NO_FACTURABLE[motivo]}
        </p>
      )}

      {!puedeSincronizar && (
        <p id={ID_EXPLICACION_PERMISO} className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
          Sincronizar escribe en Siigo y volver a revisar los duplicados reescribe las marcas de la
          ficha: los hace administración. Tu rol puede revisar la lista y corregir lo que falte.
        </p>
      )}

      {motivo === 'identificacion_duplicada' && (
        <div className="mt-2">
          <BotonAccion
            compacto
            permitido={puedeSincronizar}
            explicacionId={ID_EXPLICACION_PERMISO}
            onClick={() => { void recalcularDuplicados(); }}
          >
            Volver a revisar los duplicados
          </BotonAccion>
          {duplicados !== null && (
            <p
              role={duplicados.alerta ? 'alert' : 'status'}
              className="mt-1 text-xs"
              style={{ color: 'var(--flit-text-primary)' }}
            >
              {duplicados.texto}
            </p>
          )}
        </div>
      )}

      {cargando && (
        <div aria-busy="true" className="mt-4 space-y-2">
          <p role="status" className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>
            Cargando la lista de clientes…
          </p>
          {[0, 1, 2].map((i) => (
            <div key={i} aria-hidden="true" className="h-12 animate-pulse rounded-[10px]" style={{ background: 'var(--flit-bg-app)' }} />
          ))}
        </div>
      )}

      {/* El error va antes que el vacío: con la consulta caída nadie sabe si hay algo. */}
      {!cargando && error !== null && (
        <div className="mt-4">
          <p role="alert" className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
            <span aria-hidden="true" style={{ color: 'var(--flit-danger)' }}>⚠ </span>
            No se pudo traer la lista: {error}
          </p>
          <button type="button" onClick={() => { void cargar(); }} className={`${flitBtnSecondary} mt-3`} style={flitBtnSecondaryStyle}>
            Reintentar
          </button>
        </div>
      )}

      {/* Los dos vacíos no dicen lo mismo y no comparten copy: uno es «no queda trabajo», el otro es
          «el filtro te dejó fuera lo que buscabas». */}
      {!cargando && error === null && filas.length === 0 && motivo === null && (
        <p className="mt-4 text-sm" style={{ color: 'var(--flit-text-primary)' }}>
          Ningún cliente activo tiene datos pendientes.
        </p>
      )}

      {!cargando && error === null && filas.length === 0 && motivo !== null && (
        <div className="mt-4">
          <p className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
            Ningún cliente tiene pendiente «{MOTIVOS_NO_FACTURABLE[motivo]}». Quita el filtro para
            ver el resto.
          </p>
          <button type="button" onClick={onQuitarFiltro} className={`${flitBtnSecondary} mt-3`} style={flitBtnSecondaryStyle}>
            Quitar filtro
          </button>
        </div>
      )}

      {!cargando && error === null && filas.length > 0 && (
        <>
          <ul className="mt-4 space-y-2">
            {filas.map((f) => (
              <FilaCliente
                key={f.clienteId}
                veredicto={f}
                abierta={abierta === f.clienteId}
                onAlternar={() => setAbierta(abierta === f.clienteId ? null : f.clienteId)}
                estado={sincronizacion[f.clienteId]}
                puedeSincronizar={puedeSincronizar}
                simulado={simulado}
                onFicha={() => onAbrirFicha(f.clienteId, f.nombre)}
                onSincronizar={() => { void sincronizar(f.clienteId); }}
              />
            ))}
          </ul>
          <div className="mt-4">
            <Paginacion
              total={total}
              page={pagina}
              totalPaginas={totalPaginas}
              onPrev={() => setPagina((p) => Math.max(1, p - 1))}
              onNext={() => setPagina((p) => Math.min(totalPaginas, p + 1))}
              sustantivo="clientes pendientes"
            />
          </div>
        </>
      )}
    </FlitCard>
  );
}

function FilaCliente({
  veredicto, abierta, onAlternar, estado, puedeSincronizar, simulado,
  onFicha, onSincronizar,
}: {
  veredicto: VeredictoCliente;
  abierta: boolean;
  onAlternar: () => void;
  estado: EstadoFila | undefined;
  puedeSincronizar: boolean;
  simulado: boolean;
  onFicha: () => void;
  onSincronizar: () => void;
}) {
  const { decidir, capturar } = useMemo(
    () => agruparFaltantes(veredicto.faltantes), [veredicto.faltantes],
  );
  const idDetalle = `faltantes-cliente-${veredicto.clienteId}`;

  return (
    <li className="rounded-[10px] border p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-expanded={abierta}
          aria-controls={abierta ? idDetalle : undefined}
          onClick={onAlternar}
          className="flit-focus rounded text-left text-sm font-semibold"
          style={{ color: 'var(--flit-text-primary)' }}
        >
          <span aria-hidden="true">{abierta ? '▾ ' : '▸ '}</span>
          {veredicto.nombre}
        </button>
        <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
          {veredicto.documento ?? 'Sin identificación'}
        </span>

        {decidir.length > 0 && (
          <StatusChip tone="warning">
            {decidir.length === 1 ? 'Falta decidir 1' : `Falta decidir ${decidir.length}`}
          </StatusChip>
        )}
        {capturar.length > 0 && (
          <StatusChip tone="danger">
            {capturar.length === 1 ? 'Falta 1 dato' : `Faltan ${capturar.length} datos`}
          </StatusChip>
        )}

        <span className="ml-auto flex flex-wrap gap-2">
          <button type="button" onClick={onFicha} className={flitBtnSecondarySm} style={flitBtnSecondaryStyle}>
            Completar ficha
          </button>
          <BotonAccion
            compacto
            permitido={puedeSincronizar}
            explicacionId={ID_EXPLICACION_PERMISO}
            bloqueadoPorEstado={estado?.fase === 'corriendo'}
            onClick={onSincronizar}
          >
            {estado?.fase === 'corriendo' ? 'Sincronizando…' : 'Sincronizar'}
          </BotonAccion>
        </span>
      </div>

      {/* Por qué se ofrece sincronizar a un cliente incompleto: no es un descuido de la pantalla. */}
      {puedeSincronizar && estado === undefined && abierta && (
        <p className="mt-2 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
          Puede que Siigo ya lo tenga completo. Sincronizar lo vincula y, de paso, completa lo que
          falte aquí con lo que haya allá.
        </p>
      )}

      {abierta && (
        <div id={idDetalle} className="mt-3">
          <FaltantesCliente faltantes={veredicto.faltantes} />
        </div>
      )}

      {estado?.fase === 'ok' && (
        <p role="status" className="mt-2 flex flex-wrap items-center gap-2 text-xs" style={{ color: 'var(--flit-text-primary)' }}>
          <StatusChip tone={DESENLACE[estado.resultado.desenlace].tono}>
            {DESENLACE[estado.resultado.desenlace].titulo}{simulado ? ' (simulado)' : ''}
          </StatusChip>
          <span>{DESENLACE[estado.resultado.desenlace].frase}</span>
          <span style={{ color: 'var(--flit-text-muted)' }}>id {estado.resultado.siigoCustomerId}</span>
        </p>
      )}

      {estado?.fase === 'ficha' && (
        <div role="alert" className="mt-2 rounded-[10px] px-3 py-2" style={{ background: 'var(--flit-bg-app)' }}>
          <p className="text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            No se pudo sincronizar: hay que corregir la ficha.
          </p>
          <div className="mt-2">
            <FaltantesCliente faltantes={estado.rechazo.faltantes} mensajeSinLista={estado.rechazo.mensaje} />
          </div>
          <button type="button" onClick={onFicha} className={`${flitBtnSecondarySm} mt-2`} style={flitBtnSecondaryStyle}>
            Completar ficha
          </button>
        </div>
      )}

      {estado?.fase === 'error' && (
        <div role="alert" className="mt-2 text-xs" style={{ color: 'var(--flit-text-primary)' }}>
          <span aria-hidden="true" style={{ color: 'var(--flit-danger)' }}>⚠ </span>
          {estado.mensaje}
          {estado.sinRespuesta && (
            <span className="block" style={{ color: 'var(--flit-text-muted)' }}>
              No hubo respuesta. Puede que el tercero sí se haya creado en Siigo. Vuelve a
              sincronizar este cliente para comprobarlo: si ya existía, el resultado dirá «Ya estaba
              al día» o «Vinculado».
            </span>
          )}
          <BotonAccion
            compacto
            className="mt-2"
            permitido={puedeSincronizar}
            explicacionId={ID_EXPLICACION_PERMISO}
            onClick={onSincronizar}
          >
            Reintentar este
          </BotonAccion>
        </div>
      )}
    </li>
  );
}
