import { Component, Suspense, lazy, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import DrFlitBoton from '../drflit/DrFlitBoton';
import DrFlitMarco, { DRFLIT_PANEL_ID, DrFlitCargando, DrFlitErrorCarga } from '../drflit/DrFlitMarco';
import { useDrFlitVisible } from '../drflit/useDrFlitVisible';

// Montaje global de Dr. Flit (HU #13764, Feature #13694). Va en `Layout.tsx` FUERA del `div` con
// `key={location.pathname}`, así el panel sobrevive a la navegación (AC6). Botón y marco son eager
// (chunk del Layout); el contenido `DrFlitPanel` va con `lazy()` y solo se instancia tras el primer
// clic (AC8). `React.lazy` cachea la promesa rechazada, por eso «Reintentar» crea un `lazy()` nuevo
// (AC9; slim `docs/diseno/feature-13694-dr-flit-panel-slim.md` §2).

// Chromium cachea también el fallo de un `import()` dinámico: repetir la misma URL devuelve el mismo
// error sin volver a pedirla. El reintento pide el chunk con una query única; la URL sale del mensaje
// del error («Failed to fetch dynamically imported module: <url>»). Sin URL, repite el import normal.
type ModuloPanel = typeof import('../drflit/DrFlitPanel');
let urlFallida: string | null = null;
const URL_EN_ERROR = /(https?:\/\/[^\s?#]+\.(?:m?js|tsx?))/;

// Solo se reintenta una URL del propio origen: el mensaje de error no es una fuente de confianza y
// un `import()` de otro origen sería carga de código de terceros. Otro origen → import normal.
function esDeEsteOrigen(url: string): boolean {
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

const crearPanel = (reintento = 0) => lazy(async (): Promise<ModuloPanel> => {
  try {
    if (reintento > 0 && urlFallida) {
      return (await import(/* @vite-ignore */ `${urlFallida}?reintento=${reintento}`)) as ModuloPanel;
    }
    return await import('../drflit/DrFlitPanel');
  } catch (e) {
    const url = e instanceof Error ? URL_EN_ERROR.exec(e.message)?.[1] : undefined;
    if (url && esDeEsteOrigen(url)) urlFallida = url;
    throw e;
  }
});
type PanelLazy = ReturnType<typeof crearPanel>;

/** Boundary local (no el `ErrorBoundary` de página): solo captura el fallo de carga del panel. */
class LimiteCargaPanel extends Component<{ fallback: ReactNode; children: ReactNode }, { fallo: boolean }> {
  state = { fallo: false };
  static getDerivedStateFromError() {
    return { fallo: true };
  }
  render() {
    return this.state.fallo ? this.props.fallback : this.props.children;
  }
}

const esMovil = () => typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 1023.98px)').matches;

export default function DrFlitMontaje() {
  const visible = useDrFlitVisible();
  if (!visible) return null;
  return <DrFlitVisible />;
}

function DrFlitVisible() {
  const [abierto, setAbierto] = useState(false);
  const [Panel, setPanel] = useState<PanelLazy | null>(null);
  const [intento, setIntento] = useState(0);
  const botonRef = useRef<HTMLButtonElement>(null);
  const tituloRef = useRef<HTMLHeadingElement>(null);
  const [focoAlAbrir, setFocoAlAbrir] = useState(0);

  const abrir = useCallback(() => {
    setPanel((p: PanelLazy | null) => p ?? crearPanel());
    setAbierto(true);
    setFocoAlAbrir((n) => n + 1);
  }, []);

  const cerrar = useCallback(() => {
    setAbierto(false);
    // El botón está oculto en <lg mientras el panel está abierto: se enfoca tras el render.
    requestAnimationFrame(() => botonRef.current?.focus());
  }, []);

  // <lg: seguir un enlace del panel lo cierra para que se vea la página; el foco lo gestiona el destino.
  const alNavegar = useCallback(() => {
    if (esMovil()) setAbierto(false);
  }, []);

  const reintentar = useCallback(() => {
    const siguiente = intento + 1;
    setPanel(crearPanel(siguiente));
    setIntento(siguiente);
  }, [intento]);

  // AC3: al abrir (o pulsar el botón con el panel abierto) el foco pasa al encabezado del panel.
  useEffect(() => {
    if (focoAlAbrir > 0) tituloRef.current?.focus();
  }, [focoAlAbrir]);

  return (
    <>
      <DrFlitBoton ref={botonRef} abierto={abierto} panelId={DRFLIT_PANEL_ID} onAbrir={abrir} />
      {Panel && (
        <DrFlitMarco ref={tituloRef} abierto={abierto} onCerrar={cerrar}>
          <LimiteCargaPanel key={intento} fallback={<DrFlitErrorCarga onReintentar={reintentar} />}>
            <Suspense fallback={<DrFlitCargando />}>
              <Panel onNavegar={alNavegar} />
            </Suspense>
          </LimiteCargaPanel>
        </DrFlitMarco>
      )}
    </>
  );
}
