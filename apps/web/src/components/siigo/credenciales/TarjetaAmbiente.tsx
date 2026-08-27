// Tarjeta de un ambiente (HU #11890). Hay exactamente dos: Pruebas y Producción.
//
// Por qué dos tarjetas y no la tabla plana de `RndcAdminCredenciales.tsx`: el índice único parcial
// garantiza como mucho UNA credencial activa por ambiente y los ambientes son dos, así que la
// pregunta que trae al administrador no es «¿qué credenciales hay?» sino «¿producción está lista?».
// En una tabla ordenada por `ambiente, id DESC` esa respuesta queda enterrada en el historial.
//
// El beneficio que no se ve hasta que se dibuja: **el ambiente deja de ser un campo del formulario
// y pasa a ser el contexto desde el que se abre**, lo que elimina de raíz el error más caro de esta
// pantalla —registrar en producción una llave de pruebas por dejar el `<select>` como estaba—.

import { useRef, useState } from 'react';
import { ApiError, api, errorMessage } from '../../../lib/api';
import GradientButton from '../../flit/GradientButton';
import StatusChip from '../../flit/StatusChip';
import { FlitTable, FlitTh, FlitTr, flitBtnSecondary, flitBtnSecondarySm, flitBtnSecondaryStyle } from '../../flit/flitPageKit';
import { CARD, fecha } from '../estilos';
import DialogoDesactivar from './DialogoDesactivar';
import ModalRegistrar from './ModalRegistrar';
import PanelResultado from './PanelResultado';
import {
  AMBIENTE_EN_FRASE, ETIQUETA_AMBIENTE, ID_BANNER_LLAVE, NOTA_MASCARA,
  chipDeCredencial, type Ambiente, type ResultadoDiagnostico, type SiigoCredencialPublica,
} from './tipos';

interface Props {
  ambiente: Ambiente;
  /** TODAS las filas de este ambiente, activas e inactivas. El historial nunca pierde filas. */
  credenciales: SiigoCredencialPublica[];
  llaveMaestraConfigurada: boolean;
  /** Recarga el listado sin volver al esqueleto. */
  onRecargar: () => void | Promise<void>;
  /** Texto para la región de cortesía de la página. */
  onAviso: (texto: string) => void;
  onLlaveMaestraRota: () => void;
}

interface FalloPrueba { mensaje: string; reintentable: boolean }

export default function TarjetaAmbiente(
  { ambiente, credenciales, llaveMaestraConfigurada, onRecargar, onAviso, onLlaveMaestraRota }: Props,
) {
  const [probando, setProbando] = useState(false);
  const [resultado, setResultado] = useState<{ dato: ResultadoDiagnostico; en: string } | null>(null);
  const [falloPrueba, setFalloPrueba] = useState<FalloPrueba | null>(null);
  // Nace plegado —es contexto, no la respuesta que se vino a buscar— salvo cuando NO hay activa: ahí
  // el historial es lo único que explica por qué este ambiente está vacío.
  const [historialAbierto, setHistorialAbierto] = useState(
    () => credenciales.length > 0 && !credenciales.some((c) => c.activo),
  );
  const [registrando, setRegistrando] = useState(false);
  const [desactivando, setDesactivando] = useState<SiigoCredencialPublica | null>(null);

  const refTitulo = useRef<HTMLHeadingElement>(null);
  const refProbar = useRef<HTMLButtonElement>(null);

  // Se pinta la PRIMERA activa. Lo que NO se hace en ningún sitio es descartar las inactivas: un
  // `filter(c => c.activo)` sobre el listado haría desaparecer el historial que el backend conserva
  // a propósito (el alta y la baja son soft delete), y con él la única prueba de qué pasó aquí.
  const activas = credenciales.filter((c) => c.activo);
  const activa = activas[0] ?? null;
  const idTitulo = `amb-${ambiente}-titulo`;
  const idHistorial = `historial-${ambiente}`;
  const etiqueta = ETIQUETA_AMBIENTE[ambiente];
  const enFrase = AMBIENTE_EN_FRASE[ambiente];

  // Una inactiva que el servidor desactivó SOLO porque la llave maestra ya no la abre. No es
  // «alguien la desactivó», y la acción correcta es otra: generar una llave nueva en Siigo Nube.
  const noDescifrable = credenciales.find((c) => !c.activo && c.descifradoFallidoEn) ?? null;

  // El historial es EL RESTO: la activa ya está arriba, con todo su detalle. Repetirla abajo la
  // pondría dos veces en la pantalla y obligaría a preguntarse si son la misma.
  const historial = credenciales.filter((c) => c !== activa);

  const probar = async () => {
    // `aria-disabled` en vez de `disabled`: deshabilitar el botón que se acaba de pulsar mueve el
    // foco a <body> en algunos navegadores. El manejador ignora las pulsaciones repetidas.
    if (probando) return;
    setProbando(true);
    setFalloPrueba(null);
    try {
      // El ambiente viaja EXPLÍCITO: sin él el backend cae al de la configuración global y «probar
      // este ambiente» sería mentira.
      const dato = await api.post<ResultadoDiagnostico>(
        '/siigo/credenciales/probar-conexion', { ambiente },
      );
      // 200 siempre. `ok:false` no es un error: es un diagnóstico que terminó bien.
      setResultado({ dato, en: new Date().toISOString() });
    } catch (e) {
      // Esto sí es un fallo de la PETICIÓN: no hay veredicto, hay ausencia de veredicto.
      const status = e instanceof ApiError ? e.status : null;
      setResultado(null);
      if (status === 403) {
        setFalloPrueba({ mensaje: 'Tu usuario no tiene permiso para probar la conexión.', reintentable: false });
      } else if (status === 429) {
        setFalloPrueba({
          mensaje: 'No se pudo ejecutar la prueba: demasiadas pruebas seguidas. Espera un minuto, '
            + 'que el control de tasa lo comparten las facturas.',
          reintentable: true,
        });
      } else if (status === 0) {
        setFalloPrueba({
          mensaje: 'No se pudo ejecutar la prueba: no hubo respuesta del servidor. No se sabe si '
            + 'la prueba llegó a ejecutarse.',
          reintentable: true,
        });
      } else {
        setFalloPrueba({ mensaje: `No se pudo ejecutar la prueba: ${errorMessage(e)}.`, reintentable: true });
      }
    } finally {
      setProbando(false);
    }
  };

  const cerrarResultado = () => {
    setResultado(null);
    setFalloPrueba(null);
    refProbar.current?.focus();
  };

  // Las mismas acciones en los dos estados de la tarjeta. Viven DENTRO del elemento de la
  // credencial cuando hay una activa: «desactivar» sin decir a cuál no significa nada.
  const acciones = (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <button
        type="button"
        ref={refProbar}
        onClick={() => { void probar(); }}
        aria-disabled={probando}
        aria-busy={probando}
        className={flitBtnSecondary}
        style={flitBtnSecondaryStyle}
      >
        {/* El nombre accesible NO cambia mientras la prueba vuela: sustituirlo por «Probando…»
            convierte el control en otro distinto a ojos de un lector de pantalla —y de cualquiera
            que lo busque por su nombre— justo mientras está esperando su respuesta. El estado se
            añade, no reemplaza, y lo respaldan `aria-busy` y `aria-disabled`. */}
        Probar conexión{probando && ' · Probando…'}
        <span className="sr-only"> de {enFrase}</span>
      </button>

      {/* Sin llave maestra no se puede cifrar nada, así que registrar queda deshabilitado — y un
          botón deshabilitado no puede explicarse solo: `aria-describedby` lleva al banner.
          «Probar conexión» y «Desactivar» NO se deshabilitan: diagnosticar y retirar una credencial
          inservible siguen siendo útiles justo cuando algo va mal. */}
      <GradientButton
        type="button"
        onClick={() => setRegistrando(true)}
        disabled={!llaveMaestraConfigurada}
        aria-describedby={llaveMaestraConfigurada ? undefined : ID_BANNER_LLAVE}
      >
        {activa ? 'Registrar otra credencial' : 'Registrar nueva credencial'}
        <span className="sr-only"> de {enFrase}</span>
      </GradientButton>

      {activa && (
        <button
          type="button"
          onClick={() => setDesactivando(activa)}
          className="flit-focus ml-auto inline-flex h-10 items-center rounded-[999px] border bg-white px-5 text-sm font-semibold"
          style={{ borderColor: 'var(--flit-danger)', color: 'var(--flit-danger-ink)' }}
        >
          Desactivar
          <span className="sr-only"> la credencial de {enFrase}</span>
        </button>
      )}
    </div>
  );

  return (
    <section aria-labelledby={idTitulo} className="bg-white px-5 py-4" style={CARD}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 ref={refTitulo} tabIndex={-1} id={idTitulo} className="text-base font-bold outline-none" style={{ color: 'var(--flit-blue-text)' }}>
          {etiqueta}
        </h2>
        <StatusChip tone={activa ? 'success' : 'warning'}>{activa ? 'Activa' : 'Sin configurar'}</StatusChip>
      </div>

      {/* El backend no desempata dos activas del mismo ambiente (`ambiente_ambiguo`): elegir en
          silencio taparía justo lo que va a fallar. */}
      {activas.length > 1 && (
        <p role="alert" className="mt-3 text-sm font-semibold" style={{ color: 'var(--flit-danger-ink)' }}>
          <span aria-hidden="true">⚠ </span>
          Hay más de una credencial activa en este ambiente. La integración rechazará las peticiones
          hasta que se desactive una.
        </p>
      )}

      {/* La credencial vigente se pinta como ELEMENTO DE LISTA con sus acciones dentro, y el
          historial como filas de tabla. Cada usuario aparece en UNA sola estructura semántica —la
          activa nunca se repite en el historial (§4.2 del diseño)—, que es lo que permite señalar
          «la fila de fulano» sin ambigüedad, en la pantalla y en una prueba. */}
      {activa ? (
        <ul className="mt-3 list-none">
          <li>
            <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[10rem_1fr]">
              <dt className="font-medium" style={{ color: 'var(--flit-text-secondary)' }}>Usuario</dt>
              <dd style={{ color: 'var(--flit-text-primary)' }}>{activa.username}</dd>

              <dt className="font-medium" style={{ color: 'var(--flit-text-secondary)' }}>Access key</dt>
              <dd style={{ color: 'var(--flit-text-primary)' }}>
                {/* Se pinta LO QUE LLEGÓ del servidor, no una máscara calculada aquí: la web nunca
                    ve el valor real, ni siquiera para enmascararlo. Los puntos se ocultan al lector
                    de pantalla —«bala bala bala…» no comunica nada— y en su lugar se anuncia
                    «oculta». No hay botón de revelar: no hay nada que revelar. */}
                <span aria-hidden="true">{activa.accessKey}</span>
                <span className="sr-only">oculta</span>
                {' '}· guardada y cifrada
                <span className="mt-0.5 block text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
                  {NOTA_MASCARA}
                </span>
              </dd>

              <dt className="font-medium" style={{ color: 'var(--flit-text-secondary)' }}>Versión de llave</dt>
              <dd style={{ color: 'var(--flit-text-primary)' }}>v{activa.keyVersion}</dd>

              <dt className="font-medium" style={{ color: 'var(--flit-text-secondary)' }}>Registrada</dt>
              <dd style={{ color: 'var(--flit-text-primary)' }}>{fecha(activa.createdAt)}</dd>

              {/* La fila de notas no se oculta cuando están vacías: su ausencia también es un dato. */}
              <dt className="font-medium" style={{ color: 'var(--flit-text-secondary)' }}>Notas</dt>
              <dd style={{ color: 'var(--flit-text-primary)' }}>{activa.notas ?? '—'}</dd>
            </dl>
            {acciones}
          </li>
        </ul>
      ) : (
        <div className="mt-3 text-sm" style={{ color: 'var(--flit-text-primary)' }}>
          {/* «no hay credenciales» dicho con esas palabras: es la frase que distingue el vacío del
              error y de la carga, y la que no puede aparecer mientras el GET sigue en vuelo. */}
          <p>En este ambiente no hay credenciales.</p>
          {/* La consecuencia es distinta en cada ambiente y decirla es la mitad del valor. */}
          <p>
            {ambiente === 'produccion'
              ? 'Ninguna factura puede emitirse ante la DIAN hasta que registres una.'
              : 'FLITO no puede conectarse a Siigo en pruebas hasta que registres una.'}
          </p>
          <p className="mt-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
            La access key se genera en Siigo Nube, en Configuración › API.
          </p>

          {noDescifrable && (
            <p className="mt-3 font-semibold" style={{ color: 'var(--flit-danger-ink)' }}>
              <span aria-hidden="true">⚠ </span>
              La llave maestra ya no abre la última credencial de este ambiente
              ({noDescifrable.descifradoFallidoMotivo ?? 'sin motivo registrado'},{' '}
              {fecha(noDescifrable.descifradoFallidoEn)}). FLITO la desactivó sola. Registra una
              credencial nueva.
            </p>
          )}

          {acciones}
        </div>
      )}

      {/* El veredicto vive DENTRO de su tarjeta: nunca hay un resultado flotando que no diga a qué
          ambiente pertenece. */}
      {resultado && (
        <div className="mt-4">
          <PanelResultado
            ambiente={ambiente}
            resultado={resultado.dato}
            probadaEn={resultado.en}
            onCerrar={cerrarResultado}
          />
        </div>
      )}

      {falloPrueba && (
        <div
          role="alert"
          className="mt-4 px-4 py-3 text-sm"
          style={{ ...CARD, borderLeft: '4px solid var(--flit-danger)', color: 'var(--flit-text-primary)' }}
        >
          <p className="font-semibold" style={{ color: 'var(--flit-danger-ink)' }}>
            <span aria-hidden="true">⚠ </span>{falloPrueba.mensaje}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {falloPrueba.reintentable && (
              <button type="button" onClick={() => { void probar(); }} className={flitBtnSecondarySm} style={flitBtnSecondaryStyle}>
                Reintentar
                <span className="sr-only"> la prueba de {enFrase}</span>
              </button>
            )}
            <button type="button" onClick={cerrarResultado} className={flitBtnSecondarySm} style={flitBtnSecondaryStyle}>
              Cerrar
              <span className="sr-only"> el aviso de la prueba de {enFrase}</span>
            </button>
          </div>
        </div>
      )}

      {historial.length > 0 && (
        <div className="mt-4">
          <button
            type="button"
            aria-expanded={historialAbierto}
            aria-controls={historialAbierto ? idHistorial : undefined}
            onClick={() => setHistorialAbierto((v) => !v)}
            className={flitBtnSecondarySm}
            style={flitBtnSecondaryStyle}
          >
            <span aria-hidden="true">{historialAbierto ? '▾ ' : '▸ '}</span>
            {/* Con dos tarjetas en pantalla, dos botones «Historial de este ambiente» son
                indistinguibles por su nombre accesible. */}
            <span className="sr-only">{etiqueta}: </span>
            Historial de este ambiente ({historial.length})
          </button>

          {historialAbierto && (
            <div id={idHistorial} className="mt-2">
              <FlitTable label={`Historial de credenciales de ${enFrase}`}>
                <thead>
                  <tr>
                    <FlitTh>Usuario</FlitTh>
                    <FlitTh>Estado</FlitTh>
                    <FlitTh>Llave</FlitTh>
                    <FlitTh>Registrada</FlitTh>
                    <FlitTh>Desactivada</FlitTh>
                  </tr>
                </thead>
                <tbody>
                  {historial.map((c) => {
                    const chip = chipDeCredencial(c);
                    return (
                      <FlitTr key={c.id}>
                        <td className="px-4 py-2.5 text-sm" style={{ color: 'var(--flit-text-primary)' }}>{c.username}</td>
                        <td className="px-4 py-2.5"><StatusChip tone={chip.tono}>{chip.etiqueta}</StatusChip></td>
                        <td className="px-4 py-2.5 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>v{c.keyVersion}</td>
                        <td className="px-4 py-2.5 text-sm" style={{ color: 'var(--flit-text-muted)' }}>{fecha(c.createdAt)}</td>
                        {/* `updatedAt` solo significa «cuándo se desactivó» en una fila inactiva. */}
                        <td className="px-4 py-2.5 text-sm" style={{ color: 'var(--flit-text-muted)' }}>
                          {c.activo ? '—' : fecha(c.updatedAt)}
                        </td>
                      </FlitTr>
                    );
                  })}
                </tbody>
              </FlitTable>
            </div>
          )}
        </div>
      )}

      {registrando && (
        <ModalRegistrar
          ambiente={ambiente}
          activa={activa}
          restoreFocusRef={refTitulo}
          onCerrar={() => setRegistrando(false)}
          onRegistrada={() => {
            setRegistrando(false);
            // La anterior acaba de bajar al historial: se deja abierto, igual que tras una baja.
            if (activa) setHistorialAbierto(true);
            onAviso(`Credencial de ${enFrase} registrada y cifrada.`);
            void onRecargar();
          }}
          onLlaveMaestraRota={onLlaveMaestraRota}
        />
      )}

      {desactivando && (
        <DialogoDesactivar
          ambiente={ambiente}
          credencial={desactivando}
          restoreFocusRef={refTitulo}
          onCerrar={() => setDesactivando(null)}
          onDesactivada={(aviso) => {
            setDesactivando(null);
            // La fila baja al historial y se deja ABIERTO: acaba de pasar algo ahí dentro.
            setHistorialAbierto(true);
            onAviso(aviso);
            void onRecargar();
          }}
        />
      )}
    </section>
  );
}
