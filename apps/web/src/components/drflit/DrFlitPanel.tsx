import { useEffect, useMemo, useRef, useState, type Ref } from 'react';
import { Link } from 'react-router-dom';
import { flitBtnSecondarySm } from '../flit/flitPageKit';
import { useAuth } from '../../lib/auth';
import { capitulosEnOrdenDeIndice, entradaAyudaPorClave, puedeVerEntradaAyuda } from '../../lib/ayudaFlito';
import type { FichaParseada } from '../../lib/ayudaFicha';
import type { EntradaAyuda } from '../../content/ayuda/catalogo';
import { agregar, nuevoIdMensaje, type MensajeDrFlit } from '../../lib/drFlitConversacion';
import DrFlitMensaje, { BurbujaDrFlit, DrFlitBuscando, DrFlitErrorModulo, ENLACE_DRFLIT } from './DrFlitMensaje';
import DrFlitModulos, { DRFLIT_MODULOS_ID } from './DrFlitModulos';
import { cargarFichaDrFlit } from './cargarFichaDrFlit';

// Dr. Flit — contenido del panel (HU #13764, Feature #13694). Se carga con `lazy()` solo tras el
// primer clic en «Abrir Dr. Flit» (AC8); el marco (cabecera, «Cerrar», carga y error) vive en el
// chunk del Layout (`DrFlitMarco`).
// HU #13765: «¿Por dónde empezamos?» + «Explícame un módulo» (saludo y pie), lista transitoria y
// conversación en memoria con la forma del slim (`lib/drFlitConversacion.ts`).
// Enganches pendientes (`docs/diseno/feature-13694-dr-flit-panel-slim.md`):
// - HU #13766: «Tengo una pregunta» + caja «Escriba su pregunta» en el pie.
// - HU #13767: conversación restaurada de `sessionStorage` en lugar de la memoria del panel.

export interface DrFlitPanelProps {
  /** Se llama al seguir un enlace del panel: en <lg el montaje cierra el panel para ver la página. */
  onNavegar: () => void;
}

/** Elección en curso: la ficha se está cargando o falló (el mensaje del usuario ya está en la conversación). */
type Pendiente = { clave: string; estado: 'cargando' | 'error'; intento: number };

export default function DrFlitPanel({ onNavegar }: DrFlitPanelProps) {
  const { user } = useAuth();
  const modulos = useMemo(() => capitulosEnOrdenDeIndice(user), [user]);
  const [mensajes, setMensajes] = useState<MensajeDrFlit[]>([]);
  const [fichas, setFichas] = useState<ReadonlyMap<string, FichaParseada | null>>(() => new Map());
  const [listaAbierta, setListaAbierta] = useState(false);
  const [pendiente, setPendiente] = useState<Pendiente | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const botonPieRef = useRef<HTMLButtonElement>(null);
  const vivo = useRef(true);
  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);

  // La respuesta nueva queda a la vista sin mover el foco (AC5).
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [mensajes.length, pendiente, listaAbierta]);

  const buscando = pendiente?.estado === 'cargando';

  const cargar = (clave: string, intento: number) => {
    setPendiente({ clave, estado: 'cargando', intento });
    cargarFichaDrFlit(clave, intento).then(
      (ficha) => {
        if (!vivo.current) return;
        setFichas((prev) => new Map(prev).set(clave, ficha));
        setMensajes((prev) =>
          agregar(prev, { id: nuevoIdMensaje(), ts: Date.now(), de: 'drflit', tipo: 'explicacion', ref: { clave } }),
        );
        setPendiente(null);
      },
      () => {
        if (vivo.current) setPendiente({ clave, estado: 'error', intento });
      },
    );
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
    if (pendiente) cargar(pendiente.clave, pendiente.intento + 1);
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

  const etiquetaPendiente = pendiente ? entradaAyudaPorClave(pendiente.clave)?.etiqueta ?? 'este módulo' : '';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
              <Link to="/flito/ayuda" onClick={onNavegar} className={ENLACE_DRFLIT}>
                Abrir la Ayuda FLITO
                <span aria-hidden="true">→</span>
              </Link>
            </div>
          </BurbujaDrFlit>
          {mensajes.map((m) => (
            <DrFlitMensaje key={m.id} mensaje={m} user={user} fichas={fichas} onNavegar={onNavegar} />
          ))}
          {pendiente?.estado === 'cargando' && <DrFlitBuscando />}
          {pendiente?.estado === 'error' && <DrFlitErrorModulo etiqueta={etiquetaPendiente} onReintentar={reintentar} />}
        </div>
        {/* Paso transitorio, fuera del `log`: no se anuncia ni se guarda como mensaje. */}
        {listaAbierta && (
          <div className="mt-3">
            <DrFlitModulos modulos={modulos} onElegir={elegir} onCancelar={cancelarLista} />
          </div>
        )}
      </div>
      <div
        className="flex flex-wrap items-center gap-2 border-t border-flit-soft px-4 pt-3"
        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
      >
        {botonExplicame(botonPieRef)}
      </div>
    </div>
  );
}
