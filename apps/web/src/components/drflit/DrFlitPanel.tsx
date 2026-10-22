import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { Link } from 'react-router-dom';
import { flitBtnSecondarySm } from '../flit/flitPageKit';
import { useAuth } from '../../lib/auth';
import { capitulosEnOrdenDeIndice, entradaAyudaPorClave, puedeVerEntradaAyuda } from '../../lib/ayudaFlito';
import type { FichaParseada } from '../../lib/ayudaFicha';
import type { EntradaAyuda } from '../../content/ayuda/catalogo';
import {
  agregar, estadoReferencia, nuevoIdMensaje, referenciasDe, restaurarConversacion, serializar, type MensajeDrFlit,
} from '../../lib/drFlitConversacion';
import { escribirCrudo, leerCrudo, limpiarConversacionDrFlit } from '../../lib/drFlitAlmacen';
import { detectarValorGestion } from '../../lib/drFlitGestion';
import { mensajesEnMemoria, olvidarGestion, recordarMensajes } from '../../lib/drFlitGestionConsulta';
import type { UsuarioAyuda } from '../../lib/ayudaFlito';
import { buscarSecciones, MAX_CITAS } from '../../lib/drFlitBusqueda';
import DrFlitMensaje, {
  ATRIBUTO_ABRIDOR_SOPORTE, BotonNecesitoSoporte, BurbujaDrFlit, DrFlitBuscando, DrFlitErrorModulo,
  DrFlitErrorPregunta, DrFlitErrorRestaurar, ENLACE_DRFLIT,
} from './DrFlitMensaje';
import DrFlitSoporte from './DrFlitSoporte';
import {
  abrirSoporte, asegurarUsuarioSoporte, consultarEstadoSoporte, consumirRadicado, useSoporteDrFlit,
} from '../../lib/drFlitSoporte';
import { camposIniciales } from '../../lib/drFlitSoporteModelo';
import { DRFLIT_TITULO_ID } from './DrFlitMarco';
import { DrFlitBotonTerminar, DrFlitConfirmarTerminar } from './DrFlitTerminar';
import DrFlitModulos, { DRFLIT_MODULOS_ID } from './DrFlitModulos';
import DrFlitPregunta from './DrFlitPregunta';
import { cargarFichaDrFlit, cargarFichasDrFlit } from './cargarFichaDrFlit';
import { MarcadorGestion, OfertaGestion } from './gestion/OfertaGestion';
import ResultadoGestion from './gestion/ResultadoGestion';
import { useGestionDrFlit } from './gestion/useGestionDrFlit';

// Dr. Flit — contenido del panel (HU #13764, Feature #13694). Se carga con `lazy()` solo tras el
// primer clic en «Abrir Dr. Flit» (AC8); el marco (cabecera, «Cerrar», carga y error) vive en el
// chunk del Layout (`DrFlitMarco`).
// HU #13765: «¿Por dónde empezamos?» + «Explícame un módulo» (saludo y pie), lista transitoria y
// conversación en memoria con la forma del slim (`lib/drFlitConversacion.ts`).
// Enganches pendientes (`docs/diseno/feature-13694-dr-flit-panel-slim.md`):
// HU #13766: «Tengo una pregunta» (saludo) + caja «Escriba su pregunta» en el pie; la primera
// pregunta carga las fichas VISIBLES una vez (nunca una sin permiso) y cita hasta 3 secciones.
// HU #13767: la conversación se restaura de `sessionStorage` al montar (`lib/drFlitAlmacen.ts`) y se
// guarda tras cada cambio; las referencias restauradas se verifican cargando SOLO las fichas visibles
// que citan (permiso primero, sin descargar las demás). «Terminar chat» la borra con confirmación.
// HU #13806 (Feature #13695): «Necesito soporte» (saludo y «sin resultados») abre el asistente de
// soporte, que toma el cuerpo del panel (`DrFlitSoporte`); su estado vive en memoria por encima del
// panel (`lib/drFlitSoporte.ts`). Al radicar, la conversación recibe `casoRadicado` con el número.
// HU #13836 (Feature #13834, F6): un mensaje con placa, VIN o id FLIT recibe la oferta «Consultar … en
// sus módulos» en vez de la Ayuda; el resultado vive en memoria (`lib/drFlitGestionConsulta.ts`) y el
// almacén solo guarda un marcador sin valor (`serializar`).

export interface DrFlitPanelProps {
  /** Se llama al seguir un enlace del panel: en <lg el montaje cierra el panel para ver la página. */
  onNavegar: () => void;
}

/**
 * Petición en curso: la(s) ficha(s) se están cargando o falló la carga (el mensaje del usuario ya
 * está en la conversación). `pregunta` guarda el id y el texto para reenviar la MISMA (AC8).
 */
type Pendiente =
  | { tipo: 'modulo'; clave: string; estado: 'cargando' | 'error'; intento: number }
  | { tipo: 'pregunta'; id: string; texto: string; estado: 'cargando' | 'error'; intento: number };

/** Verificación de una conversación restaurada: carga las fichas visibles que cita (HU #13767 AC5). */
type Verificacion = { claves: string[]; estado: 'cargando' | 'error'; intento: number };

/** Claves visibles referenciadas y aún sin cargar (las sin permiso ya son «no disponible»). */
function clavesPorVerificar(
  user: UsuarioAyuda | null, mensajes: readonly MensajeDrFlit[], fichas: ReadonlyMap<string, unknown>,
): string[] {
  const claves = referenciasDe(mensajes)
    .filter((r) => !fichas.has(r.clave) && estadoReferencia(user, r) === 'por-verificar')
    .map((r) => r.clave);
  return [...new Set(claves)];
}

export default function DrFlitPanel({ onNavegar }: DrFlitPanelProps) {
  const { user, hasFuncion } = useAuth();
  const modulos = useMemo(() => capitulosEnOrdenDeIndice(user), [user]);
  const userId = user?.id;
  // AC1/AC6: lo guardado en la pestaña (o nada, si está ilegible o el almacenamiento está bloqueado).
  // HU #13836: si la conversación en memoria sigue siendo la guardada, se retoma con sus valores y
  // resultados (cerrar y abrir el panel, cambiar de pantalla); si no, vale lo restaurado.
  const [mensajes, setMensajes] = useState<MensajeDrFlit[]>(() =>
    userId === undefined ? [] : mensajesEnMemoria(userId, leerCrudo(userId)) ?? restaurarConversacion(userId),
  );
  const [fichas, setFichas] = useState<ReadonlyMap<string, FichaParseada | null>>(() => new Map());
  const [listaAbierta, setListaAbierta] = useState(false);
  const [pendiente, setPendiente] = useState<Pendiente | null>(null);
  const [verificacion, setVerificacion] = useState<Verificacion | null>(() => {
    const claves = clavesPorVerificar(user, mensajes, new Map());
    return claves.length ? { claves, estado: 'cargando', intento: 0 } : null;
  });
  const [confirmando, setConfirmando] = useState(false);
  const [anuncio, setAnuncio] = useState('');
  /** «Volver a consultar»: pista sobre la caja hasta el próximo envío (UX F6.9). */
  const [pista, setPista] = useState(false);
  const botonTerminarRef = useRef<HTMLButtonElement>(null);
  /** Sube al terminar el chat: una carga en vuelo de la conversación anterior ya no responde. */
  const turno = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const botonPieRef = useRef<HTMLButtonElement>(null);
  const cajaRef = useRef<HTMLInputElement>(null);
  const vivo = useRef(true);
  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);

  // HU #13806: estado de soporte al montar el panel (el botón no se pinta mientras carga).
  const soporte = useSoporteDrFlit();
  const raizRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    asegurarUsuarioSoporte(userId);
    consultarEstadoSoporte();
  }, [userId]);
  // F5.8: si la consulta falla el botón SÍ se pinta (al pulsarlo se reconsulta con estados visibles).
  const soporteVisible = soporte.consulta.fase === 'error' || soporte.consulta.datos?.soporte.disponible === true;
  const abrirAsistente = (abridor: string) => {
    setListaAbierta(false);
    setConfirmando(false);
    abrirSoporte(abridor, camposIniciales(user));
  };

  // Caso radicado (aunque el panel estuviera cerrado): solo el número entra en la conversación.
  useEffect(() => {
    if (soporte.radicado === null) return;
    const numero = consumirRadicado();
    if (numero === null) return;
    setMensajes((prev) =>
      agregar(prev, { id: nuevoIdMensaje(), ts: Date.now(), de: 'drflit', tipo: 'casoRadicado', numero }),
    );
  }, [soporte.radicado]);

  // Foco al volver del asistente (F5.6): la caja o el «Necesito soporte» que lo abrió. Solo ante una
  // petición NUEVA: al montar el panel el foco es del marco.
  const focoVisto = useRef(soporte.foco.n);
  useEffect(() => {
    if (focoVisto.current === soporte.foco.n) return;
    focoVisto.current = soporte.foco.n;
    if (soporte.vista !== 'chat') return;
    if (soporte.foco.a === 'abridor' && soporte.abridor) {
      const abridor = raizRef.current?.querySelector<HTMLElement>(
        `[${ATRIBUTO_ABRIDOR_SOPORTE}="${CSS.escape(soporte.abridor)}"]`,
      );
      if (abridor) {
        abridor.focus();
        return;
      }
    }
    if (soporte.foco.a === 'abridor' || soporte.foco.a === 'caja') cajaRef.current?.focus();
  }, [soporte.foco, soporte.vista, soporte.abridor]);

  // Guardado tras cada cambio (AC1/AC7: `serializar` recorta a los 50 más recientes). Sin mensajes no
  // se escribe: «Terminar chat» ya barrió la clave.
  useEffect(() => {
    if (userId === undefined || mensajes.length === 0) return;
    const guardado = serializar(mensajes);
    escribirCrudo(userId, guardado);
    recordarMensajes(userId, mensajes, guardado);
  }, [userId, mensajes]);

  const gestion = useGestionDrFlit({ userId, user, hasFuncion, mensajes, setMensajes, anunciar: setAnuncio });

  // Verificación de las referencias restauradas: solo fichas visibles citadas (AC5).
  useEffect(() => {
    if (verificacion?.estado !== 'cargando') return;
    let activo = true;
    cargarFichasDrFlit(verificacion.claves, verificacion.intento).then(
      (cargadas) => {
        if (!activo) return;
        setFichas((prev) => new Map([...prev, ...cargadas]));
        setVerificacion(null);
      },
      () => {
        if (activo) setVerificacion((v) => (v ? { ...v, estado: 'error' } : v));
      },
    );
    return () => {
      activo = false;
    };
  }, [verificacion]);

  // La respuesta nueva queda a la vista sin mover el foco (AC5).
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [mensajes.length, pendiente, listaAbierta, verificacion, soporte.vista]);

  const verificando = verificacion?.estado === 'cargando';
  const buscando = pendiente?.estado === 'cargando' || verificando;

  const cargar = (clave: string, intento: number) => {
    setPendiente({ tipo: 'modulo', clave, estado: 'cargando', intento });
    const t = turno.current;
    cargarFichaDrFlit(clave, intento).then(
      (ficha) => {
        if (!vivo.current || t !== turno.current) return;
        setFichas((prev) => new Map(prev).set(clave, ficha));
        setMensajes((prev) =>
          agregar(prev, { id: nuevoIdMensaje(), ts: Date.now(), de: 'drflit', tipo: 'explicacion', ref: { clave } }),
        );
        setPendiente(null);
      },
      () => {
        if (vivo.current && t === turno.current) setPendiente({ tipo: 'modulo', clave, estado: 'error', intento });
      },
    );
  };

  /** Responde con las fichas visibles ya cargadas: citas (1..3) o «sin resultados». */
  const responder = (id: string, texto: string, cargadas: ReadonlyMap<string, FichaParseada | null>) => {
    const citas = buscarSecciones(
      modulos.map((entrada) => ({ entrada, ficha: cargadas.get(entrada.clave) ?? null })),
      texto,
      MAX_CITAS,
    );
    const base = { id: nuevoIdMensaje(), ts: Date.now(), de: 'drflit', respondeA: id } as const;
    setMensajes((prev) =>
      agregar(
        prev,
        citas.length
          ? { ...base, tipo: 'citas', refs: citas.map(({ clave, ancla }) => ({ clave, ancla })) }
          : { ...base, tipo: 'sinResultados' },
      ),
    );
  };

  const buscarPregunta = (id: string, texto: string, intento: number) => {
    // Las fichas visibles se cargan una vez por sesión de panel (las de «Explícame» ya cuentan).
    if (modulos.every((e) => fichas.has(e.clave))) {
      responder(id, texto, fichas);
      return;
    }
    setPendiente({ tipo: 'pregunta', id, texto, estado: 'cargando', intento });
    const t = turno.current;
    // Solo claves visibles (AC4): una ficha sin permiso no se descarga nunca.
    cargarFichasDrFlit(modulos.map((e) => e.clave), intento).then(
      (cargadas) => {
        if (!vivo.current || t !== turno.current) return;
        setFichas((prev) => new Map([...prev, ...cargadas]));
        setPendiente(null);
        responder(id, texto, cargadas);
      },
      () => {
        if (vivo.current && t === turno.current) {
          setPendiente({ tipo: 'pregunta', id, texto, estado: 'error', intento });
        }
      },
    );
  };

  const preguntar = (texto: string) => {
    if (buscando) return;
    setListaAbierta(false);
    setPista(false);
    const id = nuevoIdMensaje();
    // HU #13836 AC1/AC7: placa, VIN o id FLIT con algún módulo de consulta → oferta, nada se ejecuta.
    const detectado = detectarValorGestion(texto);
    const oferta: MensajeDrFlit | null = detectado && gestion.modulosPara(detectado.tipo).length > 0
      ? {
        id: nuevoIdMensaje(), ts: Date.now(), de: 'drflit', tipo: 'ofertaGestion',
        respondeA: id, valor: detectado.valor, tipoValor: detectado.tipo, estado: 'viva',
      }
      : null;
    setMensajes((prev) => {
      // Una sola oferta viva (F6.3): la anterior pierde sus botones y queda «No consulté …».
      const previos = prev.map((m) =>
        (m.tipo === 'ofertaGestion' && m.estado === 'viva' ? { ...m, estado: 'ignorada' as const } : m));
      const conPregunta = agregar(previos, { id, ts: Date.now(), de: 'usuario', tipo: 'pregunta', texto });
      return oferta ? agregar(conPregunta, oferta) : conPregunta;
    });
    if (!oferta) buscarPregunta(id, texto, 0);
  };

  /** «Buscar en los manuales»: la oferta pierde sus botones y corre la Ayuda con el mismo texto. */
  const aManuales = (ofertaId: string) => {
    if (buscando) return;
    const oferta = mensajes.find((m) => m.id === ofertaId);
    if (!oferta || oferta.tipo !== 'ofertaGestion' || oferta.estado !== 'viva') return;
    const pregunta = mensajes.find((m) => m.id === oferta.respondeA);
    setMensajes((prev) => prev.map((m) => (m.id === ofertaId && m.tipo === 'ofertaGestion' ? { ...m, estado: 'manuales' as const } : m)));
    botonPieRef.current?.focus();
    if (pregunta?.tipo === 'pregunta') buscarPregunta(pregunta.id, pregunta.texto, 0);
  };

  const volverAConsultar = () => {
    setPista(true);
    cajaRef.current?.focus();
  };

  const elegir = (entrada: EntradaAyuda) => {
    // Fail-closed: nunca se pide ni se cita una ficha sin permiso.
    if (!puedeVerEntradaAyuda(user, entrada)) return;
    setListaAbierta(false);
    // El botón elegido desaparece: el foco se queda en el panel (pie), no cae al `body` (AC5).
    botonPieRef.current?.focus();
    setMensajes((prev) =>
      agregar(prev, { id: nuevoIdMensaje(), ts: Date.now(), de: 'usuario', tipo: 'modulo', clave: entrada.clave }),
    );
    if (fichas.has(entrada.clave)) {
      setMensajes((prev) =>
        agregar(prev, {
          id: nuevoIdMensaje(), ts: Date.now(), de: 'drflit', tipo: 'explicacion', ref: { clave: entrada.clave },
        }),
      );
      return;
    }
    cargar(entrada.clave, 0);
  };

  const reintentar = () => {
    if (!pendiente) return;
    if (pendiente.tipo === 'modulo') cargar(pendiente.clave, pendiente.intento + 1);
    // Reenvía la misma pregunta sin duplicar el mensaje del usuario (AC8).
    else buscarPregunta(pendiente.id, pendiente.texto, pendiente.intento + 1);
  };

  const reintentarRestaurar = () => {
    setVerificacion((v) => (v ? { ...v, estado: 'cargando', intento: v.intento + 1 } : v));
  };

  const pedirTerminar = () => {
    setListaAbierta(false);
    setAnuncio('');
    setConfirmando(true);
  };

  const cancelarTerminar = () => {
    setConfirmando(false);
    botonTerminarRef.current?.focus();
  };

  /** AC2: borra el almacén y la memoria; vuelve el saludo. Sin toast: se anuncia en el panel. */
  const terminar = () => {
    turno.current += 1;
    limpiarConversacionDrFlit();
    olvidarGestion();
    setPista(false);
    setMensajes([]);
    setPendiente(null);
    setVerificacion(null);
    setListaAbierta(false);
    setConfirmando(false);
    setAnuncio('Conversación terminada.');
    document.getElementById(DRFLIT_TITULO_ID)?.focus();
  };

  // Esc cierra primero la confirmación (lo transitorio) y solo después el marco cierra el panel.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented || !confirmando) return;
    e.preventDefault();
    cancelarTerminar();
  };

  const cancelarLista = () => {
    setListaAbierta(false);
    botonPieRef.current?.focus();
  };

  // `aria-disabled` y no `disabled` mientras Dr. Flit busca: el foco que está en el botón del pie
  // no debe caer al `body` (AC5).
  const inactivo = buscando || modulos.length === 0;
  const botonExplicame = (ref?: Ref<HTMLButtonElement>) => (
    <button
      ref={ref}
      type="button"
      onClick={() => {
        if (!inactivo) setListaAbierta((v) => !v);
      }}
      aria-disabled={inactivo || undefined}
      aria-expanded={listaAbierta}
      aria-controls={listaAbierta ? DRFLIT_MODULOS_ID : undefined}
      className={flitBtnSecondarySm}
    >
      Explícame un módulo
    </button>
  );

  const etiquetaPendiente =
    pendiente?.tipo === 'modulo' ? entradaAyudaPorClave(pendiente.clave)?.etiqueta ?? 'este módulo' : '';
  const textos = new Map(mensajes.flatMap((m) => (m.tipo === 'pregunta' ? [[m.id, m.texto] as const] : [])));

  return (
    <div ref={raizRef} className="flex min-h-0 min-w-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      {/* «Terminar chat» se oculta mientras el asistente de soporte está a la vista (F5.1). */}
      {mensajes.length > 0 && soporte.vista === 'chat' && (
        <DrFlitBotonTerminar onPedir={pedirTerminar} expandido={confirmando} botonRef={botonTerminarRef} />
      )}
      {confirmando && mensajes.length > 0 && soporte.vista === 'chat' && (
        <DrFlitConfirmarTerminar
          onConfirmar={terminar}
          onCancelar={cancelarTerminar}
          conBorrador={soporte.borrador !== null}
        />
      )}
      <p role="status" className="sr-only">{anuncio}</p>
      {soporte.vista === 'soporte' ? <DrFlitSoporte /> : (
        <>
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {/* Conversación: los mensajes nuevos se anuncian por esta región, sin mover el foco. */}
            <div
              role="log"
              aria-live="polite"
              aria-relevant="additions"
              aria-label="Conversación con Dr. Flit"
              className="flex flex-col gap-3"
            >
              <BurbujaDrFlit>
                <p className="break-words">
                  Hola, soy Dr. Flit. Le ayudo a encontrar respuestas en los manuales de los módulos que usted usa.
                </p>
                <p className="mt-2">¿Por dónde empezamos?</p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {botonExplicame()}
                  <button type="button" onClick={() => cajaRef.current?.focus()} className={flitBtnSecondarySm}>
                    Tengo una pregunta
                  </button>
                  <Link to="/flito/ayuda" onClick={onNavegar} className={ENLACE_DRFLIT}>
                    Abrir la Ayuda FLITO
                    <span aria-hidden="true">→</span>
                  </Link>
                  {soporteVisible && (
                    <BotonNecesitoSoporte abridor="saludo" onClick={() => abrirAsistente('saludo')} />
                  )}
                </div>
              </BurbujaDrFlit>
              {mensajes.map((m) => (m.tipo === 'ofertaGestion' ? (
                <OfertaGestion key={m.id} mensaje={m} onConsultar={gestion.consultar} onManuales={aManuales} />
              ) : m.tipo === 'resultadoGestion' ? (
                <ResultadoGestion
                  key={m.id}
                  mensaje={m}
                  grupos={gestion.resultados.get(m.id) ?? {}}
                  onReintentar={gestion.reintentar}
                  onNavegar={onNavegar}
                />
              ) : m.tipo === 'marcadorGestion' ? (
                <MarcadorGestion key={m.id} mensaje={m} onVolver={volverAConsultar} />
              ) : (
                <DrFlitMensaje
                  key={m.id}
                  mensaje={m}
                  user={user}
                  fichas={fichas}
                  onNavegar={onNavegar}
                  textoRespondeA={m.tipo === 'sinResultados' ? textos.get(m.respondeA) : undefined}
                  verificando={verificando}
                  onSoporte={soporteVisible ? abrirAsistente : undefined}
                />
              )))}
              {verificacion?.estado === 'error' && <DrFlitErrorRestaurar onReintentar={reintentarRestaurar} />}
              {pendiente?.estado === 'cargando' && <DrFlitBuscando />}
              {pendiente?.estado === 'error' && pendiente.tipo === 'modulo' && (
                <DrFlitErrorModulo etiqueta={etiquetaPendiente} onReintentar={reintentar} />
              )}
              {pendiente?.estado === 'error' && pendiente.tipo === 'pregunta' && (
                <DrFlitErrorPregunta onReintentar={reintentar} />
              )}
            </div>
            {/* Paso transitorio, fuera del `log`: no se anuncia ni se guarda como mensaje. */}
            {listaAbierta && (
              <div className="mt-3">
                <DrFlitModulos modulos={modulos} onElegir={elegir} onCancelar={cancelarLista} />
              </div>
            )}
          </div>
          <div
            className="flex flex-col gap-3 border-t border-flit-soft px-4 pt-3"
            style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
          >
            <div className="flex flex-wrap items-center gap-2">{botonExplicame(botonPieRef)}</div>
            <DrFlitPregunta
              onEnviar={preguntar}
              ocupado={buscando}
              inputRef={cajaRef}
              pista={pista ? 'Escriba la placa, el VIN o el id FLIT que quiere consultar.' : undefined}
            />
          </div>
        </>
      )}
    </div>
  );
}
