// Facturación electrónica — credenciales de la integración con Siigo (HU #11890, Feature #11240).
//
// Es la pantalla del ENTORNO, no la del día a día: se entra tres veces —cuando se conecta pruebas,
// cuando se conecta producción y cuando Siigo rota una llave— y el resto del año no se abre. Lo que
// se parametriza (a qué producto corresponde cada concepto) está en `/siigo/parametrizacion`, y lo
// que se opera (qué facturas quedaron detenidas) en `/siigo/operacion`.
//
// **Una sola persona la usa: `admin`.** No es una elección de diseño, es el router:
// `credenciales.routes.ts` monta `authMiddleware, requireRole('admin')` sobre las CUATRO
// operaciones, la de probar conexión incluida. Por eso el slug `siigo_credenciales` no se reparte a
// ningún otro rol. Pero el permiso de página y la autoridad del router son dos puertas distintas:
// si alguien concede el slug a un usuario `financiera` desde la pantalla de Usuarios, ese usuario
// ENTRA y recibe 403 en el `GET` — de ahí que el estado de error distinga el 403 y no lo meta en el
// saco de «no se pudo cargar», que ofrecería reintentar algo que va a fallar igual.
//
// Diseño completo, con los cuatro wireframes y el copy: `docs/ux/siigo-credenciales-integracion.md`.
// El backend NO se toca en esta HU: los cuatro endpoints existen desde la #11247.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import { flitBtnSecondary, flitBtnSecondaryStyle } from '../components/flit/flitPageKit';
import { CARD } from '../components/siigo/estilos';
import TarjetaAmbiente from '../components/siigo/credenciales/TarjetaAmbiente';
import {
  AMBIENTES, ID_BANNER_LLAVE,
  type RespuestaCredenciales, type SiigoCredencialPublica,
} from '../components/siigo/credenciales/tipos';

interface ErrorCarga { mensaje: string; esPermiso: boolean }

export default function SiigoCredenciales() {
  const [credenciales, setCredenciales] = useState<SiigoCredencialPublica[]>([]);
  const [llaveMaestraConfigurada, setLlaveMaestraConfigurada] = useState(true);
  /** Un 503 `codigo:'llave_maestra'` del alta enciende el banner sin esperar a otro `GET`. */
  const [llaveRota, setLlaveRota] = useState(false);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<ErrorCarga | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [cargado, setCargado] = useState(false);

  const refReintentar = useRef<HTMLButtonElement>(null);

  /**
   * `silencioso` es la diferencia entre la carga inicial y la recarga que sigue a una acción: tras
   * registrar o desactivar, volver al esqueleto haría desaparecer las dos tarjetas y parecería que
   * la página se recargó entera. El AC4 pide justo lo contrario.
   */
  const cargar = useCallback(async (silencioso = false) => {
    if (!silencioso) { setCargando(true); setLlaveRota(false); }
    setError(null);
    try {
      const r = await api.get<RespuestaCredenciales>('/siigo/credenciales');
      setCredenciales(r.data ?? []);
      // `!== false` y no un booleano a secas: si el campo no llegara, encender un banner de entorno
      // sería afirmar algo que nadie comprobó.
      setLlaveMaestraConfigurada(r.llaveMaestraConfigurada !== false);
      setCargado(true);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : null;
      setError(status === 403
        ? { mensaje: 'Tu usuario no tiene permiso para ver las credenciales de Siigo.', esPermiso: true }
        : { mensaje: `No se pudieron cargar las credenciales: ${errorMessage(e)}.`, esPermiso: false });
      setCargado(false);
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => { void cargar(); }, [cargar]);

  // La banda de error es lo único accionable de la página: el foco va ahí. Con un 403 no hay botón
  // —reintentar daría 403 otra vez— y no se mueve nada.
  useEffect(() => { if (error && !error.esPermiso) refReintentar.current?.focus(); }, [error]);

  const llaveOk = llaveMaestraConfigurada && !llaveRota;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <PageHeaderCard
        title="Integración con Siigo"
        subtitle="Con qué usuario se conecta FLITO a Siigo en cada ambiente. La access key se cifra al guardar y no se puede volver a consultar desde aquí."
      />

      {/* Cortesía, no urgencia: lo que confirma un alta o una baja no roba el foco. Se monta solo
          cuando hay algo que decir —patrón del resto del módulo— para no dejar una región viva
          permanente compitiendo con el esqueleto y con el panel de resultado, que también lo son. */}
      {aviso && (
        <p role="status" className="bg-white px-5 py-3 text-sm font-semibold" style={{ ...CARD, borderLeft: '4px solid var(--flit-success)', color: 'var(--flit-text-primary)' }}>
          {aviso}
        </p>
      )}

      {/* CARGANDO — dos esqueletos de tarjeta y no un spinner: la forma de lo que viene ya se conoce
          (siempre son dos ambientes) y anticiparla evita el salto de maquetación. */}
      {cargando && (
        <div role="status" aria-busy="true" className="flex flex-col gap-5">
          {AMBIENTES.map((a) => (
            <div key={a} className="bg-white px-5 py-4" style={CARD}>
              <div className="flex items-center justify-between gap-4">
                <span className="block h-4 w-32 rounded animate-pulse" style={{ background: 'var(--flit-bg-app)' }} />
                <span className="block h-5 w-24 rounded animate-pulse" style={{ background: 'var(--flit-bg-app)' }} />
              </div>
              <span className="mt-4 block h-3 w-2/3 rounded animate-pulse" style={{ background: 'var(--flit-bg-app)' }} />
              <span className="mt-2 block h-3 w-1/2 rounded animate-pulse" style={{ background: 'var(--flit-bg-app)' }} />
              <span className="mt-2 block h-3 w-1/3 rounded animate-pulse" style={{ background: 'var(--flit-bg-app)' }} />
            </div>
          ))}
          <p className="text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>
            Consultando las credenciales configuradas…
          </p>
        </div>
      )}

      {/* ERROR — no se pinta NINGUNA tarjeta. Si la consulta falló no se sabe si hay credenciales, y
          dibujar dos «Sin configurar» empujaría a registrar una encima de una activa que sí existe. */}
      {!cargando && error && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 bg-white px-5 py-4 text-sm"
          style={{ ...CARD, borderLeft: '4px solid var(--flit-danger)', color: 'var(--flit-text-primary)' }}
        >
          <p className="font-semibold" style={{ color: 'var(--flit-danger-ink)' }}>
            <span aria-hidden="true">⚠ </span>{error.mensaje}
          </p>
          {!error.esPermiso && (
            <button
              type="button"
              ref={refReintentar}
              onClick={() => { void cargar(); }}
              className={flitBtnSecondary}
              style={flitBtnSecondaryStyle}
            >
              Reintentar
            </button>
          )}
        </div>
      )}

      {/* AC5 — el banner de entorno encabeza las tarjetas. `role="status"` y no `alert`: es una
          condición del servidor presente AL CARGAR, no un suceso; cuando aparece a raíz del 503 del
          alta, la alerta la da el modal, que sí lo es. */}
      {!cargando && !error && !llaveOk && (
        <section
          id={ID_BANNER_LLAVE}
          role="status"
          aria-labelledby={`${ID_BANNER_LLAVE}-titulo`}
          className="bg-white px-5 py-4 text-sm"
          style={{ ...CARD, borderLeft: '4px solid var(--flit-danger)', color: 'var(--flit-text-primary)' }}
        >
          <h2 id={`${ID_BANNER_LLAVE}-titulo`} className="font-semibold" style={{ color: 'var(--flit-danger-ink)' }}>
            <span aria-hidden="true">⚠ </span>No se pueden registrar credenciales
          </h2>
          {/* «no lo causa lo que escribiste» y no «no es un problema de tus datos»: un banner de
              ENTORNO que contiene la palabra «datos» se confunde —a ojo y en una búsqueda de
              texto— con el error de validación del formulario, que es justo de lo que este aviso
              tiene que distinguirse. */}
          <p className="mt-2">
            Falta la llave maestra de cifrado del servidor. Es un problema del entorno: no lo causa
            lo que escribiste, ni tus credenciales.
          </p>
          {/* Se nombra la variable: no es un secreto ni un dato personal, y es exactamente lo que
              hay que trasladar a quien opera el servidor. «Falta una configuración» obligaría a
              abrir un ticket solo para averiguar cuál. */}
          <p className="mt-2">
            La variable SIIGO_ENC_KEY no está configurada en este servidor. Sin ella FLITO no puede
            cifrar una access key nueva —y tampoco puede descifrar las que ya están guardadas, así
            que la integración no funciona en ningún ambiente.
          </p>
          <p className="mt-2">
            Lo resuelve quien administra el servidor. Desde esta pantalla no hay nada que corregir.
          </p>
        </section>
      )}

      {!cargando && !error && cargado && AMBIENTES.map((ambiente) => (
        <TarjetaAmbiente
          key={ambiente}
          ambiente={ambiente}
          // Sin filtrar por `activo`: el historial de cada ambiente se ve entero.
          credenciales={credenciales.filter((c) => c.ambiente === ambiente)}
          // La que decide si se puede REGISTRAR es la del servidor. El banner encendido por un 503
          // suelto es contexto —el servidor acaba de decir que no pudo cifrar— pero no cierra la
          // pantalla: el que se bloquea es el botón de guardar DENTRO del modal, que es donde está
          // el bucle de reintentos. Bloquear también la tarjeta dejaría al administrador sin forma
          // de volver a intentarlo cuando el entorno se arregle sin recargar.
          llaveMaestraConfigurada={llaveMaestraConfigurada}
          onRecargar={() => cargar(true)}
          onAviso={setAviso}
          onLlaveMaestraRota={() => setLlaveRota(true)}
        />
      ))}
    </div>
  );
}
