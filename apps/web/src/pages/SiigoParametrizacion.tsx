// Facturación electrónica — parametrización (HU #11287, Feature #11240).
//
// Queda una sola pregunta que parametrizar: **a qué producto de Siigo corresponde cada concepto de
// la liquidación**. Todo lo demás que vivía aquí desapareció el 2026-08-13, y conviene saber por qué
// al leer esta pantalla tan corta:
//
//   · La **configuración global de emisión** —comprobante, vendedor, forma de pago y centro de
//     costo— se quitó: se eligen en cada envío, por empresa. Una configuración global significaba
//     que cambiar el vendedor de una empresa lo cambiaba para todas.
//   · Los **catálogos y su botón de sincronizar** se quitaron con ella: los cuatro de emisión se
//     leen de Siigo en el momento de elegir, así que no hay copia que refrescar a mano.
//   · El **tratamiento tributario** se fue antes (A7): lo aplica Siigo desde el producto.
//
// Por eso ya no hubo pestañas entre la #11287 y la #11299. Cuando solo queda una sección, una barra
// de pestañas es un adorno que sugiere que hay algo más en alguna parte.
//
// **Vuelven a estar, y ese razonamiento no se contradice: se cumple.** La HU #11299 añade la
// revisión y sincronización de los terceros de Siigo, así que otra vez son dos secciones de verdad.
// Reutilizan ruta, slug (`siigo_parametrizacion`) y guarda: ni ítem de menú nuevo ni migración de
// otorgamientos. `?seccion=terceros` es estado de NAVEGACIÓN —no es un dato de nadie (AGENTS.md
// §14)— y es lo ÚNICO que esta pantalla escribe en la query: ningún nombre, documento ni
// identificador de cliente pasa por la URL.
//
// **La compuerta encabeza la pantalla** (AC6). Es la única pregunta que importa de verdad aquí: ¿se
// puede facturar en producción, y si no, qué falta? Enterrarla abajo obligaría a buscarla, y lo que
// no se ve no se corrige.

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import { FlitPillGroup, flitPillBtn, flitPillBtnClase } from '../components/flit/flitPageKit';
import MapeoConceptos from '../components/siigo/MapeoConceptos';
import PanelTerceros from '../components/siigo/PanelTerceros';
import { CARD, inputCls } from '../components/siigo/estilos';

type Ambiente = 'pruebas' | 'produccion';

type Seccion = 'conceptos' | 'terceros';

const SECCIONES: { valor: Seccion; etiqueta: string }[] = [
  { valor: 'conceptos', etiqueta: 'Mapeo de conceptos' },
  { valor: 'terceros', etiqueta: 'Terceros' },
];

const PARAM_SECCION = 'seccion';

/** Un valor desconocido cae al mapeo, que es la pantalla que ya existía. No abre un vacío. */
function leerSeccion(valor: string | null): Seccion {
  return SECCIONES.some((s) => s.valor === valor) ? (valor as Seccion) : 'conceptos';
}

interface MotivoCompuerta {
  tipo: string;
  detalle: string;
  conceptos?: string[];
  campos?: string[];
}

interface EstadoCompuerta {
  ambiente: string;
  modo: string;
  compuertaActiva: boolean;
  emisionRealHabilitada: boolean;
  motivos: MotivoCompuerta[];
}

export default function SiigoParametrizacion() {
  const { user } = useAuth();
  const puedeEditar = user?.role === 'admin';

  const [ambiente, setAmbiente] = useState<Ambiente>('pruebas');
  const [compuerta, setCompuerta] = useState<EstadoCompuerta | null>(null);
  const [errorCompuerta, setErrorCompuerta] = useState<string | null>(null);

  const [params, setParams] = useSearchParams();
  const seccion = leerSeccion(params.get(PARAM_SECCION));
  const tituloPanel = useRef<HTMLHeadingElement>(null);
  const pestanaActiva = useRef<HTMLButtonElement>(null);
  /** A dónde va el foco tras cambiar de sección; `null` = a ningún sitio (carga inicial). */
  const [foco, setFoco] = useState<'panel' | 'pestana' | null>(null);

  const irA = useCallback((destino: Seccion, comoEnfocar: 'panel' | 'pestana') => {
    setFoco(comoEnfocar);
    setParams((previos) => {
      const siguientes = new URLSearchParams(previos);
      // El default OMITE el parámetro: la URL de diario es la corta.
      if (destino === 'conceptos') siguientes.delete(PARAM_SECCION);
      else siguientes.set(PARAM_SECCION, destino);
      return siguientes;
    // `replace`: las pestañas son secciones de la misma pantalla, no sitios distintos; apilar
    // historial obligaría a pulsar «atrás» dos veces para salir de una pantalla que se visitó una.
    }, { replace: true });
  }, [setParams]);

  useEffect(() => {
    if (foco === 'panel') tituloPanel.current?.focus();
    else if (foco === 'pestana') pestanaActiva.current?.focus();
    setFoco(null);
  }, [foco, seccion]);

  const alTeclear = (e: KeyboardEvent<HTMLButtonElement>, indice: number) => {
    const salto = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const destino = salto !== 0
      ? (indice + salto + SECCIONES.length) % SECCIONES.length
      : e.key === 'Home' ? 0
        : e.key === 'End' ? SECCIONES.length - 1
          : -1;
    if (destino < 0) return;
    // Sin esto, ←/→ desplazarían la página además de cambiar de pestaña.
    e.preventDefault();
    irA(SECCIONES[destino].valor, 'pestana');
  };

  const cargarCompuerta = useCallback(async () => {
    setErrorCompuerta(null);
    try {
      setCompuerta(await api.get<EstadoCompuerta>(`/siigo/compuerta?ambiente=${ambiente}`));
    } catch (e) {
      // El fallo de la compuerta NO tumba la pantalla: sin ella se sigue pudiendo parametrizar.
      setCompuerta(null);
      setErrorCompuerta(errorMessage(e));
    }
  }, [ambiente]);

  useEffect(() => { void cargarCompuerta(); }, [cargarCompuerta]);

  return (
    <div className="space-y-5">
      <PageHeaderCard
        title="Facturación electrónica — Parametrización"
        subtitle="Catálogos, mapeo de conceptos y configuración de emisión de la integración con Siigo."
        actions={(
          <div className="flex items-center gap-3">
            <label htmlFor="ambiente-siigo" className="text-sm font-medium" style={{ color: 'var(--flit-text-muted)' }}>
              Ambiente
            </label>
            <select
              id="ambiente-siigo"
              className={`${inputCls} w-40`}
              value={ambiente}
              onChange={(e) => setAmbiente(e.target.value as Ambiente)}
            >
              <option value="pruebas">Pruebas</option>
              <option value="produccion">Producción</option>
            </select>
          </div>
        )}
      />

      {/* AC7 — el modo simulado se señaliza de forma permanente, no en un toast que se va. */}
      {compuerta?.modo === 'mock' && (
        <div
          role="status"
          className="flex items-start gap-3 bg-white px-5 py-4 text-sm"
          style={{ ...CARD, borderLeft: '4px solid var(--flit-warning)' }}
        >
          <span aria-hidden="true" className="text-lg leading-none">🧪</span>
          <div>
            <p className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
              Modo simulado: los datos vienen del simulador, no de Siigo.
            </p>
            <p style={{ color: 'var(--flit-text-muted)' }}>
              Nada de lo que se haga aquí llega a Siigo ni a la DIAN, y la compuerta que impide
              emitir sin confirmación de contabilidad <strong>no aplica</strong> en este modo.
            </p>
            {/* AC7 de la #11299 — la frase depende de la pestaña porque la mentira que hay que
                impedir es de esta: un «Creado en Siigo» abajo y un banner genérico arriba, en una
                captura recortada, dicen cosas opuestas. El banner es de la página y no se duplica. */}
            {seccion === 'terceros' && (
              <p style={{ color: 'var(--flit-text-muted)' }}>
                Los terceros que aparezcan como creados o vinculados <strong>no existen en Siigo
                Nube</strong>: no se creó ni se modificó nada allá. Cuando se conecte el ambiente
                real habrá que volver a sincronizarlos.
              </p>
            )}
          </div>
        </div>
      )}

      {/* AC6 — el estado de la compuerta encabeza la pantalla. */}
      {compuerta && !compuerta.emisionRealHabilitada && (
        <section
          aria-labelledby="compuerta-titulo"
          className="bg-white px-5 py-4"
          style={{ ...CARD, borderLeft: '4px solid var(--flit-danger)' }}
        >
          <h2 id="compuerta-titulo" className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            <span aria-hidden="true" style={{ color: 'var(--flit-danger)' }}>⚠ </span>
            La emisión en producción está bloqueada
          </h2>
          <ul className="mt-2 space-y-1.5">
            {/* `?? []` y no `compuerta.motivos` a secas: una respuesta incompleta —un despliegue a
                medias, un proxy que recorta— no puede tumbar toda la pantalla de parametrización
                por un banner informativo. */}
            {/* Ya no hay «ir a corregirlo»: al quedar una sola sección, el sitio donde se corrige
                es lo que hay justo debajo de este aviso. */}
            {(compuerta.motivos ?? []).map((m) => (
              <li key={m.tipo} className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
                {m.detalle}
              </li>
            ))}
          </ul>
        </section>
      )}

      {compuerta?.emisionRealHabilitada && compuerta.compuertaActiva && (
        <p
          role="status"
          className="bg-white px-5 py-4 text-sm font-semibold"
          style={{ ...CARD, borderLeft: '4px solid var(--flit-success)', color: 'var(--flit-text-primary)' }}
        >
          La parametrización está completa: la emisión en producción está habilitada.
        </p>
      )}

      {errorCompuerta && (
        <p role="alert" className="bg-white px-5 py-4 text-sm" style={{ ...CARD, color: 'var(--flit-text-primary)' }}>
          <span aria-hidden="true" style={{ color: 'var(--flit-danger)' }}>⚠ </span>
          No se pudo consultar el estado de la emisión: {errorCompuerta}
        </p>
      )}

      {/* Patrón de pestañas ya resuelto en `flito/comparendos/navegacionComparendos.tsx`: `tablist`
          con nombre, `tab` con `aria-selected`, `tabIndex` itinerante (una sola parada de tabulador
          antes del contenido), flechas ←/→ e Inicio/Fin, y `aria-controls` SOLO en la activa —el
          panel de la otra no existe en el DOM y apuntar a un `id` ausente es una referencia rota—. */}
      <FlitPillGroup role="tablist" label="Secciones de la parametrización">
        {SECCIONES.map((s, indice) => {
          const activa = s.valor === seccion;
          return (
            <button
              key={s.valor}
              ref={activa ? pestanaActiva : undefined}
              type="button"
              role="tab"
              id={`tab-${s.valor}`}
              aria-selected={activa}
              aria-controls={activa ? `panel-${s.valor}` : undefined}
              tabIndex={activa ? 0 : -1}
              onClick={() => irA(s.valor, 'panel')}
              onKeyDown={(e) => alTeclear(e, indice)}
              className={flitPillBtnClase}
              style={flitPillBtn(activa)}
            >
              {s.etiqueta}
            </button>
          );
        })}
      </FlitPillGroup>

      <div
        role="tabpanel"
        id={`panel-${seccion}`}
        aria-labelledby={`tab-${seccion}`}
        className="space-y-5"
      >
        {/* Destino del foco al cambiar de pestaña: dice DÓNDE se ha llegado. `sr-only` porque la
            cabecera ya nombra la pantalla, y `focus:not-sr-only` porque un elemento enfocado que no
            se ve incumple «foco visible» para quien navega con teclado sin lector. */}
        <h2
          ref={tituloPanel}
          tabIndex={-1}
          className="flit-focus sr-only rounded focus:not-sr-only focus:block focus:text-sm focus:font-semibold"
          style={{ color: 'var(--flit-text-primary)' }}
        >
          {SECCIONES.find((s) => s.valor === seccion)?.etiqueta}
        </h2>

        {seccion === 'conceptos' ? (
          <MapeoConceptos
            ambiente={ambiente}
            puedeEditar={puedeEditar}
            onCambio={() => { void cargarCompuerta(); }}
          />
        ) : (
          <PanelTerceros />
        )}
      </div>
    </div>
  );
}
