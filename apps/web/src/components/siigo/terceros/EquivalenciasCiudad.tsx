// Bloque C — equivalencias de ciudad, confirmadas una a una (HU #11299, AC2 y AC5).
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
// LO QUE NO HAY, Y ES LA DECISIÓN PRINCIPAL DEL BLOQUE
//
//   · **No se muestra el `puntaje`.** Es `1 − distancia/(longitud+1)`, un artefacto de la distancia
//     de edición. Pintarlo como «87 % de confianza» inventa una precisión que el cálculo no tiene y
//     convierte un dato dudoso en uno con apariencia de verificado. La certeza se comunica con el
//     NOMBRE del estado y una frase que dice qué hizo el sistema, que sí es información verdadera.
//   · **No hay «confirmar todas», ni siquiera «confirmar todas las exactas».** Es la misma acción
//     masiva que el AC5 prohíbe con otro nombre y con el mismo efecto: nadie miró esas cincuenta.
//     Cada municipio sale impreso en una factura ante la DIAN.
//
// Lo que sí se hace para que confirmar cincuenta veces no sea un castigo: la cola se ordena de lo
// barato a lo caro (`exacta → aproximada → ambigua → sin_equivalencia`) y al confirmar una fila el
// foco salta al `[Confirmar]` de la siguiente pendiente. Cincuenta confirmaciones son cincuenta
// `Enter`. **Y el automatismo se rompe a propósito donde importa**: las ambiguas no traen nada
// preseleccionado y su botón no está disponible hasta elegir, así que la mano se detiene sola —sin
// un diálogo de confirmación que nadie leería—.
//
// Cada confirmación es un `POST` independiente: si la número 31 falla, las 30 anteriores están
// confirmadas y no se pierden. La fila fallida se queda con su error y su `[Reintentar]`.
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// Coste, dicho sin adornos: `/estado` calcula internamente las propuestas de toda la cartera, así
// que pedirlo junto a `/propuestas` es hacer el mismo barrido dos veces. Mitigación de esta HU: el
// bloque **nace plegado** y solo pide `/propuestas` al abrirse. La salida de verdad es de backend
// (paginar `/propuestas` y que `/estado` no recalcule), y está pedida en la spec de UX §R3-c.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, errorMessage } from '../../../lib/api';
import StatusChip, { type ChipTone } from '../../flit/StatusChip';
import { FlitCard, flitBtnSecondary, flitBtnSecondarySm, flitBtnSecondaryStyle, flitInp } from '../../flit/flitPageKit';
import BotonAccion from './BotonAccion';
import {
  ORDEN_CERTEZA,
  type CandidataCiudad, type CertezaEquivalencia, type EquivalenciaObsoleta,
  type EstadoMapeoCiudades, type PropuestaCliente,
} from './tipos';

/** País de la propuesta: el mismo por defecto que aplica el servidor. */
const PAIS = 'Co';

const ID_EXPLICACION_PERMISO = 'permiso-ciudades';

/**
 * Cuatro nombres, cero porcentajes. El color no carga solo: cada fila lleva chip **con texto**, una
 * frase que dice qué hizo el sistema y un control distinto.
 */
const CERTEZA: Record<CertezaEquivalencia, { tono: ChipTone; etiqueta: string; frase: string }> = {
  exacta: {
    tono: 'success',
    etiqueta: 'Coincide',
    frase: 'El texto escrito y el nombre del catálogo son el mismo, sin tildes ni puntuación.',
  },
  aproximada: {
    tono: 'warning',
    etiqueta: 'Se parece',
    frase: 'Difiere en una o dos letras. Puede ser una tilde o un dedazo — o puede ser otro municipio.',
  },
  ambigua: {
    tono: 'draft',
    etiqueta: 'Hay varios posibles',
    frase: 'El mismo nombre existe en varios departamentos. Elige cuál es.',
  },
  sin_equivalencia: {
    tono: 'danger',
    etiqueta: 'Sin equivalencia',
    frase: 'Lo escrito no se parece a ningún municipio: puede ser una dirección, una abreviatura o estar vacío. Búscalo.',
  },
};

/** ¿El fallo es «el catálogo está vacío» o cualquier otra cosa? Son dos problemas distintos. */
function esCatalogoVacio(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  const cuerpo = e.rawDetails as { codigo?: unknown } | null | undefined;
  return cuerpo?.codigo === 'catalogo_vacio';
}

interface Props {
  version: number;
  puedeConfirmar: boolean;
  onConfirmada: () => void;
}

type EstadoFila =
  | { fase: 'confirmada'; cityName: string }
  | { fase: 'corriendo' }
  | { fase: 'error'; mensaje: string };

export default function EquivalenciasCiudad({ version, puedeConfirmar, onConfirmada }: Props) {
  const [abierto, setAbierto] = useState(false);
  const [estado, setEstado] = useState<EstadoMapeoCiudades | null>(null);
  const [propuestas, setPropuestas] = useState<PropuestaCliente[] | null>(null);
  const [obsoletas, setObsoletas] = useState<EquivalenciaObsoleta[]>([]);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<{ mensaje: string; catalogoVacio: boolean } | null>(null);
  const [elegidas, setElegidas] = useState<Record<number, CandidataCiudad>>({});
  const [filas, setFilas] = useState<Record<number, EstadoFila>>({});
  const [confirmadasSesion, setConfirmadasSesion] = useState(0);
  const [anuncio, setAnuncio] = useState('');
  /** A qué botón saltar tras confirmar. Se resuelve en un efecto: el DOM aún no existe al guardar. */
  const [focoSiguiente, setFocoSiguiente] = useState<number | null>(null);
  const yaCargado = useRef(false);

  // `/estado` se pide UNA vez al entrar a la pestaña: son los seis contadores del encabezado.
  useEffect(() => {
    let vivo = true;
    void (async () => {
      try {
        const r = await api.get<EstadoMapeoCiudades>(`/siigo/clientes-ciudades/estado?pais=${PAIS}`);
        if (vivo) setEstado(r);
      } catch {
        // El encabezado se queda sin contadores; el bloque sigue usable y su propio error —el que
        // importa— lo dará `/propuestas` al abrirlo.
        if (vivo) setEstado(null);
      }
    })();
    return () => { vivo = false; };
  }, [version]);

  const cargarPropuestas = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const [p, o] = await Promise.all([
        api.get<{ total: number; data: PropuestaCliente[] }>(`/siigo/clientes-ciudades/propuestas?pais=${PAIS}`),
        api.get<{ total: number; data: EquivalenciaObsoleta[] }>('/siigo/clientes-ciudades/obsoletas')
          .catch(() => ({ total: 0, data: [] as EquivalenciaObsoleta[] })),
      ]);
      const ordenadas = [...(p.data ?? [])].sort(
        (a, b) => ORDEN_CERTEZA.indexOf(a.propuesta.certeza) - ORDEN_CERTEZA.indexOf(b.propuesta.certeza),
      );
      setPropuestas(ordenadas);
      setObsoletas(o.data ?? []);
    } catch (e) {
      setPropuestas(null);
      setError({ mensaje: errorMessage(e), catalogoVacio: esCatalogoVacio(e) });
    } finally {
      setCargando(false);
    }
  }, []);

  const alternar = () => {
    const siguiente = !abierto;
    setAbierto(siguiente);
    if (siguiente && !yaCargado.current) {
      yaCargado.current = true;
      void cargarPropuestas();
    }
  };

  useEffect(() => {
    if (focoSiguiente === null) return;
    document.getElementById(`confirmar-ciudad-${focoSiguiente}`)?.focus();
    setFocoSiguiente(null);
  }, [focoSiguiente, filas]);

  const pendientes = (propuestas ?? []).filter((p) => filas[p.clienteId]?.fase !== 'confirmada');

  const confirmar = async (p: PropuestaCliente) => {
    const candidata = candidataDe(p, elegidas);
    if (candidata === undefined) return;
    setFilas((previas) => ({ ...previas, [p.clienteId]: { fase: 'corriendo' } }));
    try {
      const r = await api.post<{ clienteId: number; cityCode: string; cityName: string }>(
        `/siigo/clientes-ciudades/${p.clienteId}/confirmar`,
        { countryCode: candidata.countryCode, stateCode: candidata.stateCode, cityCode: candidata.cityCode },
      );
      // La fila se resuelve EN LOCAL con la respuesta: recargar la cartera entera tras cada
      // confirmación son cuarenta barridos del catálogo para pintar cuarenta líneas.
      setFilas((previas) => ({ ...previas, [p.clienteId]: { fase: 'confirmada', cityName: r.cityName } }));
      setConfirmadasSesion((n) => n + 1);
      const quedan = pendientes.filter((otra) => otra.clienteId !== p.clienteId);
      setAnuncio(`${r.cityName} confirmada. Quedan ${quedan.length}.`);
      // El foco NO se anuncia: eso ya lo dice el lector al llegar al control.
      setFocoSiguiente(quedan.length > 0 ? quedan[0].clienteId : null);
      onConfirmada();
    } catch (e) {
      setFilas((previas) => ({ ...previas, [p.clienteId]: { fase: 'error', mensaje: errorMessage(e) } }));
    }
  };

  return (
    <FlitCard>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="text-base font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
          Equivalencias de ciudad
        </h3>
        <button
          type="button"
          aria-expanded={abierto}
          onClick={alternar}
          className={flitBtnSecondarySm}
          style={flitBtnSecondaryStyle}
        >
          <span aria-hidden="true">{abierto ? '▾ ' : '▸ '}</span>
          {abierto ? 'Ocultar las propuestas' : 'Revisar las propuestas'}
        </button>
      </div>

      {estado !== null && (
        <p className="mt-1 text-sm" style={{ color: 'var(--flit-text-primary)' }}>
          Ciudad en códigos de Siigo · {estado.pendientes} clientes sin confirmar
          <span className="block" style={{ color: 'var(--flit-text-muted)' }}>
            {estado.proponibles} con propuesta directa · {estado.ambiguos} ambiguas ·{' '}
            {estado.sinEquivalencia} sin equivalencia
          </span>
        </p>
      )}

      <p className="mt-2 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
        No hay «confirmar todas»: cada municipio sale impreso en una factura ante la DIAN.
      </p>

      {/* La explicación del permiso se escribe UNA vez por bloque; los botones la referencian. */}
      {!puedeConfirmar && (
        <p id={ID_EXPLICACION_PERMISO} className="mt-2 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
          Confirmar una ciudad fija el municipio que se imprime en la factura ante la DIAN: lo hace
          administración. Tu rol puede revisar las propuestas y avisar qué falta.
        </p>
      )}

      {abierto && (
        <div className="mt-4">
          <p aria-live="polite" role="status" className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
            {anuncio}
          </p>
          {confirmadasSesion > 0 && (
            <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
              Confirmadas en esta sesión: {confirmadasSesion}
            </p>
          )}

          {cargando && (
            <p role="status" className="mt-3 text-sm" style={{ color: 'var(--flit-text-muted)' }}>
              Comparando las ciudades escritas con el catálogo…
            </p>
          )}

          {/* Dos mensajes distintos porque son dos problemas distintos: sin esta separación, un
              catálogo vacío se leería como «ningún cliente tiene equivalencia» y mandaría a
              corregir cuatrocientas fichas a mano en vez de a cargar un archivo. */}
          {!cargando && error !== null && (
            <div className="mt-3">
              <p role="alert" className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
                <span aria-hidden="true" style={{ color: 'var(--flit-danger)' }}>⚠ </span>
                {error.catalogoVacio
                  ? 'El catálogo de ubicaciones no tiene ciudades activas. Cárgalo antes de proponer equivalencias.'
                  : `No se pudieron calcular las equivalencias: ${error.mensaje}`}
              </p>
              <button type="button" onClick={() => { void cargarPropuestas(); }} className={`${flitBtnSecondary} mt-3`} style={flitBtnSecondaryStyle}>
                Reintentar
              </button>
            </div>
          )}

          {!cargando && error === null && propuestas !== null && propuestas.length === 0 && (
            <p className="mt-3 text-sm" style={{ color: 'var(--flit-text-primary)' }}>
              Todas las ciudades están confirmadas en códigos de Siigo.
            </p>
          )}

          {!cargando && error === null && propuestas !== null && propuestas.length > 0 && (
            <ul className="mt-3 space-y-2">
              {propuestas.map((p) => (
                <li key={p.clienteId} className="rounded-[10px] border p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <FilaPropuesta
                    propuesta={p}
                    estado={filas[p.clienteId]}
                    elegida={elegidas[p.clienteId]}
                    onElegir={(c) => setElegidas((previas) => ({ ...previas, [p.clienteId]: c }))}
                    puedeConfirmar={puedeConfirmar}
                    onConfirmar={() => { void confirmar(p); }}
                  />
                </li>
              ))}
            </ul>
          )}

          {/* No lo pedía el AC: sin esto, una corrección posterior de la ciudad deja los códigos
              apuntando a la anterior y el síntoma es una factura con el municipio viejo. */}
          {obsoletas.length > 0 && (
            <details className="mt-4 text-sm">
              <summary className="flit-focus cursor-pointer rounded" style={{ color: 'var(--flit-text-primary)' }}>
                {obsoletas.length} clientes cambiaron su ciudad escrita después de confirmarse
              </summary>
              <p className="mt-2 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
                Los códigos que viajan a Siigo son los viejos. Vuelve a confirmarlos desde la ficha
                de cada cliente.
              </p>
              <ul className="mt-2 list-disc pl-5 text-xs" style={{ color: 'var(--flit-text-primary)' }}>
                {obsoletas.map((o) => (
                  <li key={o.clienteId}>
                    {o.nombre}: dice «{o.ciudadActual ?? ''}», se confirmó con «{o.textoConfirmado ?? ''}»
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </FlitCard>
  );
}

/** La candidata que se va a confirmar: la única de las directas, o la elegida a mano. */
function candidataDe(
  p: PropuestaCliente, elegidas: Record<number, CandidataCiudad>,
): CandidataCiudad | undefined {
  const directa = p.propuesta.certeza === 'exacta' || p.propuesta.certeza === 'aproximada';
  // Las ambiguas NUNCA traen preselección, aunque tengan candidatas: es lo que rompe la cadena de
  // «Enter» y obliga a mirar.
  return directa ? p.propuesta.candidatas[0] : elegidas[p.clienteId];
}

function FilaPropuesta({ propuesta: p, estado, elegida, onElegir, puedeConfirmar, onConfirmar }: {
  propuesta: PropuestaCliente;
  estado: EstadoFila | undefined;
  elegida: CandidataCiudad | undefined;
  onElegir: (c: CandidataCiudad) => void;
  puedeConfirmar: boolean;
  onConfirmar: () => void;
}) {
  const certeza = CERTEZA[p.propuesta.certeza];
  const directa = p.propuesta.certeza === 'exacta' || p.propuesta.certeza === 'aproximada';
  const candidata = directa ? p.propuesta.candidatas[0] : elegida;
  const idFaltaElegir = `falta-elegir-${p.clienteId}`;

  if (estado?.fase === 'confirmada') {
    return (
      <p className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
        <span aria-hidden="true" style={{ color: 'var(--flit-success)' }}>✓ </span>
        {p.nombre} → {estado.cityName} (confirmada)
      </p>
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{p.nombre}</span>
        <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>«{p.ciudadTexto ?? ''}»</span>
        <StatusChip tone={certeza.tono}>
          {p.propuesta.certeza === 'ambigua'
            ? `Hay ${p.propuesta.candidatas.length} posibles`
            : certeza.etiqueta}
        </StatusChip>
      </div>
      <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>{certeza.frase}</p>

      {directa && candidata !== undefined && (
        <p className="mt-2 text-sm" style={{ color: 'var(--flit-text-primary)' }}>
          <span aria-hidden="true">→ </span>{candidata.cityName} · {candidata.stateName}
        </p>
      )}

      {p.propuesta.certeza === 'ambigua' && (
        <fieldset className="mt-2">
          <legend className="text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            Municipio de {p.nombre}
          </legend>
          <div className="mt-1 grid grid-cols-1 gap-1 sm:grid-cols-2">
            {p.propuesta.candidatas.map((c) => (
              <label key={`${c.stateCode}-${c.cityCode}`} className="flex items-center gap-2 text-sm" style={{ color: 'var(--flit-text-primary)' }}>
                <input
                  type="radio"
                  className="flit-focus"
                  name={`ciudad-${p.clienteId}`}
                  checked={elegida?.cityCode === c.cityCode && elegida?.stateCode === c.stateCode}
                  onChange={() => onElegir(c)}
                />
                {c.cityName} · {c.stateName}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {p.propuesta.certeza === 'sin_equivalencia' && (
        <BuscadorMunicipio clienteId={p.clienteId} elegida={elegida} onElegir={onElegir} />
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <BotonAccion
          compacto
          id={`confirmar-ciudad-${p.clienteId}`}
          permitido={puedeConfirmar}
          explicacionId={ID_EXPLICACION_PERMISO}
          bloqueadoPorEstado={candidata === undefined || estado?.fase === 'corriendo'}
          motivoBloqueoId={idFaltaElegir}
          onClick={onConfirmar}
        >
          {estado?.fase === 'corriendo' ? 'Confirmando…' : estado?.fase === 'error' ? 'Reintentar' : 'Confirmar'}
        </BotonAccion>
        {candidata === undefined && (
          <span id={idFaltaElegir} className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
            Elige un municipio para poder confirmar.
          </span>
        )}
      </div>

      {estado?.fase === 'error' && (
        <p role="alert" className="mt-1 text-xs" style={{ color: 'var(--flit-text-primary)' }}>
          <span aria-hidden="true" style={{ color: 'var(--flit-danger)' }}>⚠ </span>
          No se pudo confirmar: {estado.mensaje}
        </p>
      )}
    </>
  );
}

/**
 * Búsqueda en el catálogo de municipios.
 *
 * `?q=` SÍ lleva texto en la query y es correcto: es un nombre de municipio del catálogo público de
 * la DIAN, no un dato del titular. Lo que nunca viaja así es el nombre o el documento del cliente.
 */
function BuscadorMunicipio({ clienteId, elegida, onElegir }: {
  clienteId: number;
  elegida: CandidataCiudad | undefined;
  onElegir: (c: CandidataCiudad) => void;
}) {
  const [q, setQ] = useState('');
  const [resultados, setResultados] = useState<CandidataCiudad[]>([]);
  const [buscado, setBuscado] = useState(false);
  const [buscando, setBuscando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buscar = async () => {
    if (q.trim().length < 2) return;
    setBuscando(true);
    setError(null);
    try {
      const r = await api.get<{ data: CandidataCiudad[] }>(
        `/siigo/ciudades/buscar?q=${encodeURIComponent(q.trim())}&pais=${PAIS}`,
      );
      setResultados(r.data ?? []);
      setBuscado(true);
    } catch (e) {
      setError(errorMessage(e));
      setResultados([]);
      setBuscado(true);
    } finally {
      setBuscando(false);
    }
  };

  const idCampo = `buscar-municipio-${clienteId}`;
  return (
    <div className="mt-2">
      <label htmlFor={idCampo} className="block text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
        Buscar el municipio en el catálogo
      </label>
      <div className="mt-1 flex flex-wrap gap-2">
        <input
          id={idCampo}
          className={`${flitInp} max-w-xs`}
          value={q}
          placeholder="Al menos dos letras"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void buscar(); } }}
        />
        <button
          type="button"
          onClick={() => { void buscar(); }}
          disabled={q.trim().length < 2 || buscando}
          className={flitBtnSecondarySm}
          style={flitBtnSecondaryStyle}
        >
          {buscando ? 'Buscando…' : 'Buscar'}
        </button>
      </div>

      {error !== null && (
        <p role="alert" className="mt-1 text-xs" style={{ color: 'var(--flit-text-primary)' }}>
          No se pudo buscar: {error}
        </p>
      )}

      {resultados.length > 0 && (
        <fieldset className="mt-2">
          <legend className="text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            Resultados
          </legend>
          <div className="mt-1 grid grid-cols-1 gap-1 sm:grid-cols-2">
            {resultados.map((c) => (
              <label key={`${c.stateCode}-${c.cityCode}`} className="flex items-center gap-2 text-sm" style={{ color: 'var(--flit-text-primary)' }}>
                <input
                  type="radio"
                  className="flit-focus"
                  name={`ciudad-${clienteId}`}
                  checked={elegida?.cityCode === c.cityCode && elegida?.stateCode === c.stateCode}
                  onChange={() => onElegir(c)}
                />
                {c.cityName} · {c.stateName}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {!buscando && error === null && resultados.length === 0 && buscado && (
        <p role="status" className="mt-1 text-xs" style={{ color: 'var(--flit-text-primary)' }}>
          Ningún municipio del catálogo coincide con «{q.trim()}». Prueba con menos letras.
        </p>
      )}
    </div>
  );
}
