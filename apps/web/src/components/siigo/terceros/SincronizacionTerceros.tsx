// Bloque D — sincronizar los terceros con Siigo, y decir qué pasó con cada cliente (AC2, AC6, AC7).
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
// LO QUE HAY DE VERDAD DETRÁS DEL BOTÓN
//
//   · **No existe endpoint de lote.** Solo `POST /siigo/terceros/cliente/:clienteId`, uno por
//     cliente. La «tanda» de esta pantalla es un bucle del navegador, no una operación del servidor.
//   · **Limitador: 60 sincronizaciones por 15 minutos y por usuario**, y cada llamada puede gastar
//     hasta TRES peticiones de la ventana de 100/minuto que la empresa **comparte con la emisión de
//     facturas**. Por eso el bucle es secuencial, con pausa, y con tope de 25.
//   · **El selector «Ambiente» de la cabecera NO gobierna esto.** `asegurarTercero` lee
//     `env.SIIGO_AMBIENTE` en el servidor y ni siquiera acepta un parámetro de ambiente. Alguien que
//     ponga «Producción» arriba y pulse sincronizar creería que escribió en producción. Por eso el
//     encabezado de este bloque pinta el ambiente que devuelve `GET /siigo/compuerta` SIN parámetro
//     —el del servidor— y lo dice con todas las letras.
//
// Y el desenlace que no se puede disimular: el servicio devuelve CINCO, no los cuatro del AC. El
// quinto es `sin_cambios` («la huella coincide, no se llamó a Siigo»); plegarlo dentro de
// «actualizado» sería afirmar una escritura que no ocurrió.
// ══════════════════════════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { VeredictoCliente } from '@operaciones/shared-types';
import { api, errorMessage } from '../../../lib/api';
import StatusChip from '../../flit/StatusChip';
import { FlitCard, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondarySm, flitBtnSecondaryStyle } from '../../flit/flitPageKit';
import BotonAccion from './BotonAccion';
import FaltantesCliente from './FaltantesCliente';
import {
  DESENLACE, ORDEN_DESENLACE, esDemasiadasSeguidas, esSinRespuesta, rechazoDeFicha,
  type DesenlaceTercero, type RechazoDeFicha, type ResultadoTercero,
} from './tipos';

/** Cabe tres veces en la ventana de 60/15 min y deja margen para reintentos. */
const TANDA_MAXIMA = 25;

/**
 * Pausa entre llamadas. Mantiene el ritmo por debajo de ~20 por minuto: cada sincronización puede
 * costar tres peticiones de la ventana que se comparte con la emisión de facturas, así que ir a
 * fondo aquí es una forma silenciosa de dejar sin cuota justo a lo que factura.
 */
const PAUSA_MS = 3_000;

const espera = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

interface Fallo {
  mensaje: string;
  rechazo: RechazoDeFicha | null;
  sinRespuesta: boolean;
}

interface Linea {
  clienteId: number;
  nombre: string;
  resultado: ResultadoTercero | null;
  fallo: Fallo | null;
}

interface Props {
  version: number;
  /** Escribir el tercero en Siigo: admin y financiera, igual que `exigirAccionSiigo('emitir')`. */
  puedeSincronizar: boolean;
  explicacionPermisoId: string;
  simulado: boolean;
  ambienteServidor: string | null;
  onAbrirFicha: (clienteId: number, nombre: string) => void;
  onCambio: () => void;
  tituloRef: RefObject<HTMLHeadingElement>;
}

export default function SincronizacionTerceros({
  version, puedeSincronizar, explicacionPermisoId, simulado, ambienteServidor,
  onAbrirFicha, onCambio, tituloRef,
}: Props) {
  const [candidatos, setCandidatos] = useState<VeredictoCliente[]>([]);
  const [noFacturables, setNoFacturables] = useState(0);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [seleccion, setSeleccion] = useState<number[]>([]);
  const [corriendo, setCorriendo] = useState(false);
  const [progreso, setProgreso] = useState<{ hechos: number; total: number } | null>(null);
  const [lineas, setLineas] = useState<Linea[]>([]);
  const [errorTanda, setErrorTanda] = useState<string | null>(null);
  const detener = useRef(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      // Una sola consulta para las dos cifras: el informe ya trae el veredicto de cada cliente, así
      // que separar «los facturables» de «los que no» es un filtro, no otra petición.
      const r = await api.get<{ total: number; data: VeredictoCliente[] }>(
        '/siigo/clientes/validacion/detalle?incluirFacturables=true&limit=500',
      );
      const data = r.data ?? [];
      setCandidatos(data.filter((c) => c.facturable));
      setNoFacturables(data.filter((c) => !c.facturable).length);
    } catch (e) {
      setError(errorMessage(e));
      setCandidatos([]);
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => { void cargar(); }, [cargar, version]);

  // La selección se limpia si la cartera cambió: un identificador que ya no está en la lista se
  // habría sincronizado a ciegas.
  useEffect(() => {
    setSeleccion((previa) => previa.filter((id) => candidatos.some((c) => c.clienteId === id)));
  }, [candidatos]);

  const alternar = (clienteId: number) => {
    setSeleccion((previa) => (previa.includes(clienteId)
      ? previa.filter((id) => id !== clienteId)
      : [...previa, clienteId]));
  };

  const sincronizar = async () => {
    const tanda = seleccion.slice(0, TANDA_MAXIMA);
    if (tanda.length === 0) return;
    detener.current = false;
    setCorriendo(true);
    setErrorTanda(null);
    setLineas([]);
    setProgreso({ hechos: 0, total: tanda.length });

    const hechas: Linea[] = [];
    const hechos = new Set<number>();
    for (let i = 0; i < tanda.length; i += 1) {
      if (detener.current) break;
      const clienteId = tanda[i];
      const nombre = candidatos.find((c) => c.clienteId === clienteId)?.nombre ?? `Cliente ${clienteId}`;
      try {
        const r = await api.post<ResultadoTercero>(`/siigo/terceros/cliente/${clienteId}`);
        hechas.push({ clienteId, nombre, resultado: r, fallo: null });
        hechos.add(clienteId);
      } catch (e) {
        if (esDemasiadasSeguidas(e)) {
          // El limitador corta la TANDA, no un cliente: seguir llamando solo consume la ventana.
          setErrorTanda(`${errorMessage(e)} Lo ya sincronizado queda sincronizado.`);
          break;
        }
        hechas.push({
          clienteId,
          nombre,
          resultado: null,
          fallo: { mensaje: errorMessage(e), rechazo: rechazoDeFicha(e), sinRespuesta: esSinRespuesta(e) },
        });
        // Un fallo de ficha no se reintenta solo, pero tampoco se quita de la selección: quien
        // corrija la ficha querrá volver a lanzarlo.
      }
      setLineas([...hechas]);
      setProgreso({ hechos: i + 1, total: tanda.length });
      if (i < tanda.length - 1 && !detener.current) await espera(PAUSA_MS);
    }

    setSeleccion((previa) => previa.filter((id) => !hechos.has(id)));
    setCorriendo(false);
    setProgreso(null);
    if (hechos.size > 0) onCambio();
  };

  const seleccionados = seleccion.length;
  const enTanda = Math.min(seleccionados, TANDA_MAXIMA);
  const tandas = Math.ceil(seleccionados / TANDA_MAXIMA);
  const conResultado = lineas.length > 0;

  return (
    <FlitCard>
      <h3
        ref={tituloRef}
        tabIndex={-1}
        className="flit-focus rounded text-base font-semibold"
        style={{ color: 'var(--flit-text-primary)' }}
      >
        Sincronizar terceros con Siigo
      </h3>

      {/* La trampa del selector de ambiente: se desactiva diciéndola, no heredándola. */}
      <p className="mt-1 text-sm" style={{ color: 'var(--flit-text-muted)' }}>
        Se sincroniza contra el ambiente <strong>{ambienteServidor ?? '—'}</strong> que tiene
        configurado el servidor. El selector de arriba no cambia esto: solo afecta al mapeo de
        conceptos y a la compuerta.
      </p>

      {simulado && (
        <p className="mt-1 text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
          <span aria-hidden="true">🧪 </span>
          SIMULADO — nada de lo que salga aquí llegó a Siigo Nube.
        </p>
      )}

      {!puedeSincronizar && (
        <p id={explicacionPermisoId} className="mt-2 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
          Sincronizar escribe en Siigo: lo hacen administración y financiera. Tu rol puede ver qué
          clientes están listos.
        </p>
      )}

      {cargando && (
        <p role="status" className="mt-3 text-sm" style={{ color: 'var(--flit-text-muted)' }}>
          Buscando los clientes listos para facturar…
        </p>
      )}

      {!cargando && error !== null && (
        <div className="mt-3">
          <p role="alert" className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
            <span aria-hidden="true" style={{ color: 'var(--flit-danger)' }}>⚠ </span>
            No se pudo traer la lista de clientes listos: {error}
          </p>
          <button type="button" onClick={() => { void cargar(); }} className={`${flitBtnSecondary} mt-3`} style={flitBtnSecondaryStyle}>
            Reintentar
          </button>
        </div>
      )}

      {!cargando && error === null && candidatos.length === 0 && (
        <p className="mt-3 text-sm" style={{ color: 'var(--flit-text-primary)' }}>
          No hay clientes que sincronizar.
          {noFacturables > 0 && ' Los que hay todavía no se pueden facturar: corrígelos arriba.'}
        </p>
      )}

      {!cargando && error === null && candidatos.length > 0 && (
        <div className="mt-3 space-y-3">
          {/* AC6 — un cliente no facturable NO se puede seleccionar. No aparece en esta lista, y se
              dice por qué en vez de dejar que alguien lo busque. */}
          {noFacturables > 0 && (
            <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
              {noFacturables} clientes no se pueden seleccionar todavía porque les faltan datos.
              Están arriba, en «Clientes que todavía no».
            </p>
          )}

          <fieldset disabled={corriendo}>
            <legend className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
              Clientes listos para facturar ({candidatos.length})
            </legend>
            <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto pr-1">
              {candidatos.map((c) => (
                <li key={c.clienteId}>
                  <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--flit-text-primary)' }}>
                    <input
                      type="checkbox"
                      className="flit-focus"
                      checked={seleccion.includes(c.clienteId)}
                      onChange={() => alternar(c.clienteId)}
                    />
                    <span>{c.nombre}</span>
                    <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
                      {c.documento ?? ''}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>

          {/* El vacío de la selección no es «no hay nada»: es «todavía no has marcado a nadie». */}
          {seleccionados === 0 && (
            <p className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
              Marca los clientes que quieras sincronizar.
            </p>
          )}

          {seleccionados > 0 && (
            <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
              Se sincronizan de {TANDA_MAXIMA} en {TANDA_MAXIMA}. Con {seleccionados} seleccionados
              {tandas === 1 ? ' es 1 tanda.' : ` son ${tandas} tandas.`}
            </p>
          )}

          {corriendo && progreso !== null && (
            <p role="status" className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
              {progreso.hechos} de {progreso.total} · aproximadamente{' '}
              {Math.max(1, Math.round(((progreso.total - progreso.hechos) * (PAUSA_MS + 2000)) / 60_000))}{' '}
              minuto(s)
            </p>
          )}

          {/* El botón NUNCA se pinta con 0 seleccionados: así se evita el `disabled:opacity-50` del
              primario, que baja el contraste por debajo de 4,5:1. */}
          <div className="flex flex-wrap items-center gap-2">
            {seleccionados > 0 && puedeSincronizar && (
              <button
                type="button"
                onClick={() => { void sincronizar(); }}
                disabled={corriendo}
                className={flitBtnPrimary}
                style={flitBtnPrimaryStyle}
              >
                {corriendo
                  ? 'Sincronizando…'
                  : `Sincronizar ${enTanda} en ${ambienteServidor ?? 'el ambiente del servidor'}`}
              </button>
            )}
            {seleccionados > 0 && !puedeSincronizar && (
              <BotonAccion permitido={false} explicacionId={explicacionPermisoId} onClick={() => {}}>
                Sincronizar {enTanda}
              </BotonAccion>
            )}
            {corriendo && (
              <button
                type="button"
                onClick={() => { detener.current = true; }}
                className={flitBtnSecondary}
                style={flitBtnSecondaryStyle}
              >
                Detener
              </button>
            )}
          </div>
        </div>
      )}

      {errorTanda !== null && (
        <p role="alert" className="mt-3 text-sm" style={{ color: 'var(--flit-text-primary)' }}>
          <span aria-hidden="true" style={{ color: 'var(--flit-danger)' }}>⚠ </span>
          {errorTanda}
        </p>
      )}

      {conResultado && (
        <Resultados
          lineas={lineas}
          simulado={simulado}
          terminada={!corriendo}
          onAbrirFicha={onAbrirFicha}
        />
      )}
    </FlitCard>
  );
}

/**
 * El panel de resultados: **agrupado por desenlace y con los fallos arriba**.
 *
 * Lo que exige que alguien actúe va primero; el éxito se comprueba en el encabezado de dos números
 * y no leyendo fila a fila. Ningún grupo con cero se pinta.
 *
 * En modo simulado la marca «(simulado)» viaja EN CADA ENCABEZADO, y no solo en el banner de
 * arriba: un aviso arriba y un «Creado en Siigo» abajo, en una captura de pantalla recortada, dicen
 * cosas opuestas.
 */
function Resultados({ lineas, simulado, terminada, onAbrirFicha }: {
  lineas: Linea[];
  simulado: boolean;
  /** La tanda ya no corre: da igual si terminó sola o si alguien pulsó «Detener». */
  terminada: boolean;
  onAbrirFicha: (clienteId: number, nombre: string) => void;
}) {
  const fallidas = lineas.filter((l) => l.fallo !== null);
  const logradas = lineas.filter((l) => l.resultado !== null);
  const marca = simulado ? ' (simulado)' : '';

  return (
    <section aria-labelledby="resultado-sincronizacion" className="mt-4 border-t pt-4" style={{ borderColor: 'var(--flit-border-soft)' }}>
      <h4 id="resultado-sincronizacion" className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
        Sincronización · {lineas.length} clientes{marca}
      </h4>
      <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>
        {logradas.length} sincronizados · {fallidas.length} no se pudieron
      </p>
      {terminada && (
        <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
          Lo ya sincronizado queda sincronizado: no hay deshacer.
        </p>
      )}

      {fallidas.length > 0 && (
        <details open className="mt-3">
          <summary className="flit-focus cursor-pointer rounded text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            <span aria-hidden="true">⛔ </span>No se pudo ({fallidas.length})
          </summary>
          <ul className="mt-2 space-y-2">
            {fallidas.map((l) => (
              <li key={l.clienteId} className="rounded-[10px] px-3 py-2" style={{ background: 'var(--flit-bg-app)' }}>
                <p className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{l.nombre}</p>
                {l.fallo?.rechazo != null ? (
                  <>
                    <FaltantesCliente
                      faltantes={l.fallo.rechazo.faltantes}
                      mensajeSinLista={l.fallo.rechazo.mensaje}
                    />
                    <button
                      type="button"
                      onClick={() => onAbrirFicha(l.clienteId, l.nombre)}
                      className={`${flitBtnSecondarySm} mt-2`}
                      style={flitBtnSecondaryStyle}
                    >
                      Completar ficha
                    </button>
                  </>
                ) : (
                  <p className="text-xs" style={{ color: 'var(--flit-text-primary)' }}>
                    {l.fallo?.mensaje}
                    {l.fallo?.sinRespuesta === true && (
                      <span className="block" style={{ color: 'var(--flit-text-muted)' }}>
                        No hubo respuesta. Puede que el tercero sí se haya creado en Siigo. Vuelve a
                        sincronizar ese cliente para comprobarlo: si ya existía, el resultado dirá
                        «Ya estaba al día» o «Vinculado».
                      </span>
                    )}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {ORDEN_DESENLACE.map((desenlace) => (
        <GrupoDesenlace
          key={desenlace}
          desenlace={desenlace}
          lineas={logradas.filter((l) => l.resultado?.desenlace === desenlace)}
          marca={marca}
        />
      ))}
    </section>
  );
}

function GrupoDesenlace({ desenlace, lineas, marca }: {
  desenlace: DesenlaceTercero;
  lineas: Linea[];
  marca: string;
}) {
  // Ningún grupo con cero se pinta: una lista de cinco encabezados vacíos no informa de nada.
  if (lineas.length === 0) return null;
  const d = DESENLACE[desenlace];

  return (
    <details open={desenlace === 'creado' || desenlace === 'vinculado_existente'} className="mt-3">
      <summary className="flit-focus cursor-pointer rounded text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
        <span aria-hidden="true">{d.simbolo} </span>
        {d.titulo}{marca} ({lineas.length})
      </summary>
      <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>{d.frase}</p>
      <ul className="mt-2 space-y-1">
        {lineas.map((l) => (
          <li key={l.clienteId} className="flex flex-wrap items-center gap-2 text-sm" style={{ color: 'var(--flit-text-primary)' }}>
            <StatusChip tone={d.tono}>{d.titulo}{marca}</StatusChip>
            <span>{l.nombre}</span>
            <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
              id {l.resultado?.siigoCustomerId}
            </span>
            {/* La verificación se ofrece SOLO en `vinculado_existente`, y la razón es literal: es el
                único desenlace donde la ficha contable del tercero no la puso FLITO. */}
            {/* Copiar no escribe en ningún sitio: está disponible para los dos roles. Sin enlace
                profundo, además, porque FLITO no conoce la URL del tercero en Siigo Nube y
                fabricarla sería mandar a una página que puede no existir. */}
            {d.verificable && (
              <button
                type="button"
                className={flitBtnSecondarySm}
                style={flitBtnSecondaryStyle}
                onClick={() => { void navigator.clipboard?.writeText(l.resultado?.siigoCustomerId ?? ''); }}
              >
                Copiar el id para buscarlo en Siigo
              </button>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
