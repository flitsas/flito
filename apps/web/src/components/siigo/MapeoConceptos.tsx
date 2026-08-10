// Facturación electrónica — mapeo de conceptos (HU #11287, Feature #11240).
//
// Extraído de `pages/SiigoParametrizacion.tsx` cuando la HU #11288 añadió la segunda pestaña: las
// dos historias comparten página, ruta y permiso, y meterlas en un solo archivo lo habría llevado
// por encima del techo de 800 líneas del repo.
//
// Tres cosas que conviene no perder de vista al tocar este archivo:
//
//   1. **La pantalla no decide permisos, solo los refleja.** El servidor ya rechaza a quien no
//      corresponde; lo que se hace aquí es no ofrecer botones que van a devolver 403. Ocultar sin
//      que el backend rechace sería seguridad de mentira, y rechazar sin ocultar sería una interfaz
//      que invita a fallar.
//   2. **El valor anterior se conserva hasta que el guardado tiene éxito** (AC4). La validación
//      contra Siigo puede rechazar, y una fila que ya se pintó con el valor nuevo dejaría a quien
//      parametriza sin saber qué había antes.
//   3. **La confirmación de contabilidad es frágil a propósito** y la pantalla lo avisa ANTES de
//      guardar (AC5). Que se caiga sin aviso es lo que hace que la gente deje de confiar en ella.

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import toast from 'react-hot-toast';
import {
  CLASIFICACIONES_TRIBUTARIAS,
  CLASIFICACION_TRIBUTARIA_LABEL,
  CODIGO_PRODUCTO_SIIGO_RE,
  CONCEPTO_FACTURABLE_LABEL,
  codigoSugeridoDeConcepto,
  type ClasificacionTributaria,
} from '@operaciones/shared-types';
import { api, errorMessage } from '../../lib/api';
import GradientButton from '../flit/GradientButton';
import StatusChip from '../flit/StatusChip';
import FlitModal from '../flit/FlitModal';
import { CARD, fecha, inputCls } from './estilos';

interface Impuesto { id: number; nombre?: string | null; porcentaje?: number | null }

interface MapeoConcepto {
  id: string;
  ambiente: string;
  concepto: string;
  tipoTramite: string | null;
  codigoProducto: string | null;
  nombreProducto: string | null;
  clasificacionTributaria: ClasificacionTributaria | null;
  impuestos: Impuesto[];
  unidadMedida: string | null;
  ingresoParaTerceros: boolean;
  lineaPropiaPendiente: boolean;
  confirmadoContabilidad: boolean;
  confirmadoPorId: number | null;
  confirmadoEn: string | null;
  validacionEstado: string;
  validacionMensaje: string | null;
  listoParaFacturar: boolean;
}

type Ambiente = 'pruebas' | 'produccion';

/** Los tres estados que el AC3 pide distinguir de un vistazo. */
type EstadoFila = 'sin_mapear' | 'sin_confirmar' | 'confirmado';

function estadoDeFila(m: MapeoConcepto): EstadoFila {
  if (m.codigoProducto === null) return 'sin_mapear';
  return m.confirmadoContabilidad ? 'confirmado' : 'sin_confirmar';
}

const ESTADO_CHIP: Record<EstadoFila, { tono: 'draft' | 'warning' | 'success'; texto: string }> = {
  sin_mapear: { tono: 'draft', texto: 'Sin mapear' },
  sin_confirmar: { tono: 'warning', texto: 'Sin confirmar' },
  confirmado: { tono: 'success', texto: 'Confirmado' },
};

export default function MapeoConceptos({ ambiente, puedeEditar, puedeConfirmar, onCambio }: {
  ambiente: Ambiente;
  puedeEditar: boolean;
  puedeConfirmar: boolean;
  /** Avisa al caparazón para que reevalúe la compuerta: lo que se edita aquí la mueve. */
  onCambio: () => void;
}) {
  const [filas, setFilas] = useState<MapeoConcepto[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editando, setEditando] = useState<MapeoConcepto | null>(null);
  const [creando, setCreando] = useState<MapeoConcepto | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const mapeo = await api.get<{ data: MapeoConcepto[] }>(`/siigo/mapeo-conceptos?ambiente=${ambiente}`);
      setFilas(mapeo.data ?? []);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setCargando(false);
    }
  }, [ambiente]);

  useEffect(() => { void cargar(); }, [cargar]);

  const [confirmandoId, setConfirmandoId] = useState<string | null>(null);

  const confirmar = async (m: MapeoConcepto) => {
    setConfirmandoId(m.id);
    try {
      await api.post(`/siigo/mapeo-conceptos/${m.id}/confirmar`);
      toast.success('Confirmación de contabilidad registrada');
      await cargar();
      onCambio();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setConfirmandoId(null);
    }
  };

  const genericas = useMemo(() => filas.filter((f) => f.tipoTramite === null), [filas]);
  const especificas = useMemo(() => filas.filter((f) => f.tipoTramite !== null), [filas]);

  return (
    <div className="space-y-5">
      <section className="bg-white" style={CARD}>
        <header className="flex items-center justify-between border-b px-6 py-4" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <h2 className="text-base font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            Conceptos facturables
          </h2>
          {!cargando && !error && (
            <span className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>
              {genericas.filter((f) => f.confirmadoContabilidad).length} de {genericas.length} confirmados
            </span>
          )}
        </header>

        {/* AC2 — los cuatro estados. */}
        {cargando && (
          <p className="px-6 py-10 text-center text-sm" role="status" style={{ color: 'var(--flit-text-muted)' }}>
            Cargando la parametrización…
          </p>
        )}

        {!cargando && error && (
          <div className="px-6 py-10 text-center">
            {/* `role="alert"` porque el `role="status"` de la carga se desmonta al aparecer el
                error: sin esto, un fallo tras pulsar «Reintentar» no se anuncia. */}
            <p role="alert" className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
              <span aria-hidden="true" style={{ color: 'var(--flit-danger)' }}>⚠ </span>{error}
            </p>
            <button
              type="button"
              onClick={() => { void cargar(); }}
              className="flit-focus mt-4 rounded-[10px] border px-4 py-2 text-sm font-semibold"
              style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}
            >
              Reintentar
            </button>
          </div>
        )}

        {!cargando && !error && filas.length === 0 && (
          <div className="px-6 py-10 text-center">
            <p className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
              Todavía no hay conceptos en este ambiente.
            </p>
            <p className="mt-1 text-sm" style={{ color: 'var(--flit-text-muted)' }}>
              Los seis conceptos facturables se crean con la migración de la base de datos. Si esta
              lista está vacía, el primer paso es aplicar las migraciones pendientes en este ambiente.
            </p>
          </div>
        )}

        {!cargando && !error && filas.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">
                Mapeo de conceptos facturables a productos de Siigo en el ambiente {ambiente}
              </caption>
              <thead>
                <tr style={{ color: 'var(--flit-text-muted)' }}>
                  <th scope="col" className="px-4 py-3 text-left font-semibold">Concepto</th>
                  <th scope="col" className="px-4 py-3 text-left font-semibold">Producto en Siigo</th>
                  <th scope="col" className="px-4 py-3 text-left font-semibold">Clasificación</th>
                  <th scope="col" className="px-4 py-3 text-left font-semibold">Unidad</th>
                  <th scope="col" className="px-4 py-3 text-left font-semibold">Terceros</th>
                  <th scope="col" className="px-4 py-3 text-left font-semibold">Estado</th>
                  <th scope="col" className="px-4 py-3 text-right font-semibold">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {[...genericas, ...especificas].map((m) => (
                  <FilaMapeo
                    key={m.id}
                    m={m}
                    puedeEditar={puedeEditar}
                    puedeConfirmar={puedeConfirmar}
                    confirmando={confirmandoId === m.id}
                    onEditar={() => setEditando(m)}
                    onCrearProducto={() => setCreando(m)}
                    onConfirmar={() => { void confirmar(m); }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editando && (
        <ModalEditar
          m={editando}
          onCerrar={() => setEditando(null)}
          onGuardado={async () => { setEditando(null); await cargar(); onCambio(); }}
        />
      )}

      {creando && (
        <ModalCrearProducto
          m={creando}
          ambiente={ambiente}
          onCerrar={() => setCreando(null)}
          onCreado={async () => { setCreando(null); await cargar(); onCambio(); }}
        />
      )}
    </div>
  );
}

// ── Fila ────────────────────────────────────────────────────────────────────

function FilaMapeo({ m, puedeEditar, puedeConfirmar, confirmando, onEditar, onCrearProducto, onConfirmar }: {
  m: MapeoConcepto;
  puedeEditar: boolean;
  puedeConfirmar: boolean;
  /** true mientras el POST está en vuelo: sin esto, un doble clic deja dos entradas en la
      auditoría contable, que es un registro con valor probatorio. */
  confirmando: boolean;
  onEditar: () => void;
  onCrearProducto: () => void;
  onConfirmar: () => void;
}) {
  const estado = estadoDeFila(m);
  const chip = ESTADO_CHIP[estado];
  const etiqueta = CONCEPTO_FACTURABLE_LABEL[m.concepto as keyof typeof CONCEPTO_FACTURABLE_LABEL]
    ?? m.concepto;

  return (
    <tr className="border-t" style={{ borderColor: 'var(--flit-border-soft)' }}>
      <th scope="row" className="px-4 py-3 text-left font-medium" style={{ color: 'var(--flit-text-primary)' }}>
        {etiqueta}
        {m.tipoTramite !== null && (
          <span className="ml-2 text-xs font-normal" style={{ color: 'var(--flit-text-muted)' }}>
            · {m.tipoTramite}
          </span>
        )}
      </th>
      <td className="px-4 py-3">
        {m.codigoProducto === null
          ? <span style={{ color: 'var(--flit-text-muted)' }}>— sin producto —</span>
          : (
            <>
              <span className="font-mono">{m.codigoProducto}</span>
              {m.nombreProducto && (
                <span className="block text-xs" style={{ color: 'var(--flit-text-muted)' }}>
                  {m.nombreProducto}
                </span>
              )}
              {/* El resultado de la última validación contra Siigo (HU #11283). */}
              {(m.validacionEstado === 'no_existe' || m.validacionEstado === 'inactivo') && (
                <span className="block text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
                  <span aria-hidden="true" style={{ color: 'var(--flit-danger)' }}>⚠ </span>
                  {m.validacionMensaje ?? 'El producto dejó de ser válido en Siigo.'}
                </span>
              )}
            </>
          )}
      </td>
      <td className="px-4 py-3">
        {m.clasificacionTributaria === null
          ? <span style={{ color: 'var(--flit-text-muted)' }}>sin declarar</span>
          : CLASIFICACION_TRIBUTARIA_LABEL[m.clasificacionTributaria]}
      </td>
      <td className="px-4 py-3">{m.unidadMedida ?? '—'}</td>
      <td className="px-4 py-3">{m.ingresoParaTerceros ? 'Sí' : 'No'}</td>
      <td className="px-4 py-3">
        <StatusChip tone={chip.tono}>{chip.texto}</StatusChip>
        {m.confirmadoContabilidad && (
          // AC5 — quién y cuándo, visible en la pantalla.
          <span className="mt-1 block text-xs" style={{ color: 'var(--flit-text-muted)' }}>
            Usuario {m.confirmadoPorId ?? '—'} · {fecha(m.confirmadoEn)}
          </span>
        )}
      </td>
      <td className="px-4 py-3">
        <div className="flex justify-end gap-2">
          {puedeEditar && m.codigoProducto === null && (
            <button
              type="button"
              onClick={onCrearProducto}
              className="flit-focus rounded-[10px] border px-3 py-1.5 text-xs font-semibold"
              style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}
              // Seis botones «Editar» idénticos no dan contexto a quien navega por lista de
              // botones; solo lo da la navegación por tabla.
              aria-label={`Crear producto de ${etiqueta}`}
            >
              Crear producto
            </button>
          )}
          {puedeEditar && (
            <button
              type="button"
              onClick={onEditar}
              className="flit-focus rounded-[10px] border px-3 py-1.5 text-xs font-semibold"
              style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}
              aria-label={`Editar ${etiqueta}`}
            >
              Editar
            </button>
          )}
          {puedeConfirmar && !m.confirmadoContabilidad && m.codigoProducto !== null && (
            <button
              type="button"
              onClick={onConfirmar}
              disabled={confirmando}
              // Texto oscuro sobre blanco y el verde solo en el borde. Blanco sobre
              // `--flit-success` daba 1.97:1, muy por debajo del 4.5:1 que la regla 12 exige — y
              // es el ÚNICO afordance de escritura del rol `financiera` en toda la pantalla.
              className="flit-focus rounded-[10px] border-2 px-3 py-1.5 text-xs font-semibold disabled:opacity-60"
              style={{ borderColor: 'var(--flit-success)', color: 'var(--flit-text-primary)' }}
              aria-label={`Confirmar contabilidad de ${etiqueta}`}
            >
              {confirmando ? 'Confirmando…' : 'Confirmar'}
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

// ── Edición ─────────────────────────────────────────────────────────────────

function ModalEditar({ m, onCerrar, onGuardado }: {
  m: MapeoConcepto;
  onCerrar: () => void;
  onGuardado: () => Promise<void>;
}) {
  const [codigoProducto, setCodigoProducto] = useState(m.codigoProducto ?? '');
  const [clasificacion, setClasificacion] = useState<ClasificacionTributaria | ''>(
    m.clasificacionTributaria ?? '',
  );
  const [unidadMedida, setUnidadMedida] = useState(m.unidadMedida ?? '');
  const [terceros, setTerceros] = useState(m.ingresoParaTerceros);
  const [guardando, setGuardando] = useState(false);
  const [fallo, setFallo] = useState<string | null>(null);

  /** AC5 — ¿este cambio tumbaría la confirmación? Se avisa ANTES de guardar. */
  const tumbaConfirmacion = m.confirmadoContabilidad && (
    codigoProducto !== (m.codigoProducto ?? '')
    || clasificacion !== (m.clasificacionTributaria ?? '')
    || terceros !== m.ingresoParaTerceros
  );

  const formatoValido = codigoProducto === '' || CODIGO_PRODUCTO_SIIGO_RE.test(codigoProducto);

  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    if (!formatoValido) return;
    setGuardando(true);
    setFallo(null);
    try {
      await api.patch(`/siigo/mapeo-conceptos/${m.id}`, {
        codigoProducto: codigoProducto === '' ? null : codigoProducto,
        clasificacionTributaria: clasificacion === '' ? null : clasificacion,
        unidadMedida: unidadMedida === '' ? null : unidadMedida,
        ingresoParaTerceros: terceros,
      });
      toast.success('Mapeo actualizado');
      await onGuardado();
    } catch (e2) {
      // AC4 — el mensaje que se muestra es el TRADUCIDO POR EL SERVIDOR: es quien sabe si el
      // producto no existe, está inactivo o si Siigo no respondió. Y no se cierra el modal: el
      // valor anterior sigue en pantalla hasta que el guardado tiene éxito.
      setFallo(errorMessage(e2));
    } finally {
      setGuardando(false);
    }
  };

  return (
    <FlitModal title={`Editar ${CONCEPTO_FACTURABLE_LABEL[m.concepto as keyof typeof CONCEPTO_FACTURABLE_LABEL] ?? m.concepto}`} onClose={onCerrar}>
      <form onSubmit={guardar} className="space-y-4">
        <Campo etiqueta="Código de producto en Siigo" htmlFor="codigo-producto">
          <input
            id="codigo-producto"
            className={inputCls}
            value={codigoProducto}
            onChange={(e) => setCodigoProducto(e.target.value)}
            placeholder="FLIT-LOGISTICA"
            aria-invalid={!formatoValido}
            aria-describedby={formatoValido ? undefined : 'codigo-producto-error'}
          />
          {!formatoValido && (
            <p id="codigo-producto-error" className="mt-1 text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
              Alfanumérico (admite punto, guion y guion bajo), sin espacios y máximo 30 caracteres.
            </p>
          )}
          {m.codigoProducto && (
            <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
              Valor actual: <span className="font-mono">{m.codigoProducto}</span>
            </p>
          )}
        </Campo>

        <Campo etiqueta="Clasificación tributaria" htmlFor="clasificacion">
          <select
            id="clasificacion"
            className={inputCls}
            value={clasificacion}
            onChange={(e) => setClasificacion(e.target.value as ClasificacionTributaria | '')}
          >
            <option value="">Sin declarar</option>
            {CLASIFICACIONES_TRIBUTARIAS.map((c) => (
              <option key={c} value={c}>{CLASIFICACION_TRIBUTARIA_LABEL[c]}</option>
            ))}
          </select>
        </Campo>

        <Campo etiqueta="Unidad de medida" htmlFor="unidad">
          <input
            id="unidad"
            className={inputCls}
            value={unidadMedida}
            onChange={(e) => setUnidadMedida(e.target.value)}
            placeholder="94"
          />
        </Campo>

        <div className="flex items-center gap-2">
          <input
            id="terceros"
            type="checkbox"
            className="flit-focus h-4 w-4"
            checked={terceros}
            onChange={(e) => setTerceros(e.target.checked)}
          />
          <label htmlFor="terceros" className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
            Es un ingreso recibido para terceros
          </label>
        </div>

        {tumbaConfirmacion && (
          <p
            role="alert"
            className="rounded-[10px] px-4 py-3 text-sm"
            // El naranja se queda en el borde y el fondo; el TEXTO va oscuro. `--flit-warning`
            // sobre su propio tinte da 3.00:1, y este es justo el aviso que el AC5 exige que se
            // lea antes de guardar: uno que no se lee no cumple el criterio.
            style={{
              background: 'rgba(240, 90, 53, 0.10)',
              borderLeft: '4px solid var(--flit-warning)',
              color: 'var(--flit-text-primary)',
            }}
          >
            Este cambio toca un campo que contabilidad ya firmó, así que <strong>la confirmación se
            perderá</strong> y habrá que volver a pedirla. Quién la dio y cuándo se conservan.
          </p>
        )}

        {fallo && (
          <p role="alert" className="rounded-[10px] px-4 py-3 text-sm"
            // Mismo criterio que el aviso de arriba: el rojo marca, el texto oscuro se lee.
            style={{
              background: 'rgba(228, 61, 48, 0.10)',
              borderLeft: '4px solid var(--flit-danger)',
              color: 'var(--flit-text-primary)',
            }}
          >
            {fallo}
          </p>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onCerrar}
            className="flit-focus rounded-[10px] border px-4 py-2 text-sm font-semibold"
            style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}
          >
            Cancelar
          </button>
          <GradientButton type="submit" disabled={guardando || !formatoValido}>
            {guardando ? 'Guardando…' : 'Guardar'}
          </GradientButton>
        </div>
      </form>
    </FlitModal>
  );
}

// ── Creación de producto ────────────────────────────────────────────────────

interface CatalogoElemento { codigo: string; nombre: string; activo: boolean }

function ModalCrearProducto({ m, ambiente, onCerrar, onCreado }: {
  m: MapeoConcepto;
  ambiente: Ambiente;
  onCerrar: () => void;
  onCreado: () => Promise<void>;
}) {
  // AC6 — se propone el código y se puede ajustar antes de confirmar.
  const [codigo, setCodigo] = useState(codigoSugeridoDeConcepto(m.concepto));
  const [grupos, setGrupos] = useState<CatalogoElemento[]>([]);
  const [grupo, setGrupo] = useState('');
  const [creando, setCreando] = useState(false);
  const [fallo, setFallo] = useState<string | null>(null);

  useEffect(() => {
    // `GET /catalogos/:tipo` devuelve el catálogo directo, sin envolver en `data`.
    api.get<{ elementos: CatalogoElemento[] }>(
      `/siigo/parametrizacion/catalogos/account_group?ambiente=${ambiente}`,
    )
      .then((r) => setGrupos((r.elementos ?? []).filter((g) => g.activo)))
      .catch(() => setGrupos([]));
  }, [ambiente]);

  const formatoValido = CODIGO_PRODUCTO_SIIGO_RE.test(codigo);

  const crear = async (e: FormEvent) => {
    e.preventDefault();
    if (!formatoValido || grupo === '') return;
    setCreando(true);
    setFallo(null);
    try {
      const r = await api.post<{ desenlace: string; codigo: string }>(
        `/siigo/mapeo-conceptos/${m.id}/producto`,
        { codigo, grupoInventarioCodigo: grupo },
      );
      toast.success(r.desenlace === 'creado'
        ? `Producto ${r.codigo} creado en Siigo y vinculado`
        : `El producto ${r.codigo} ya existía en Siigo: se vinculó sin crear uno nuevo`);
      await onCreado();
    } catch (e2) {
      setFallo(errorMessage(e2));
    } finally {
      setCreando(false);
    }
  };

  return (
    <FlitModal title="Crear el producto en Siigo" onClose={onCerrar}>
      <form onSubmit={crear} className="space-y-4">
        <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>
          Se creará en Siigo un producto de tipo servicio con la clasificación tributaria y los
          impuestos que ya tiene este concepto. <strong>La confirmación de contabilidad no se marca
          automáticamente</strong>: crear el producto es un acto técnico, firmarlo es contable.
        </p>

        <Campo etiqueta="Código del producto" htmlFor="codigo-nuevo">
          <input
            id="codigo-nuevo"
            className={inputCls}
            value={codigo}
            onChange={(e) => setCodigo(e.target.value)}
            aria-invalid={!formatoValido}
            aria-describedby={formatoValido ? undefined : 'codigo-nuevo-error'}
          />
          {!formatoValido && (
            <p id="codigo-nuevo-error" className="mt-1 text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
              Alfanumérico (admite punto, guion y guion bajo), sin espacios y máximo 30 caracteres.
            </p>
          )}
        </Campo>

        <Campo etiqueta="Grupo de inventario" htmlFor="grupo-inventario">
          <select
            id="grupo-inventario"
            className={inputCls}
            value={grupo}
            onChange={(e) => setGrupo(e.target.value)}
            required
          >
            <option value="">Elige uno del catálogo…</option>
            {grupos.map((g) => (
              <option key={g.codigo} value={g.codigo}>{g.nombre}</option>
            ))}
          </select>
          <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
            No se puede cambiar una vez que el producto tenga movimiento en Siigo.
          </p>
          {grupos.length === 0 && (
            <p className="mt-1 text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
              No hay grupos de inventario sincronizados en este ambiente. Sincroniza los catálogos
              antes de crear productos.
            </p>
          )}
        </Campo>

        {fallo && (
          <p role="alert" className="rounded-[10px] px-4 py-3 text-sm"
            // Mismo criterio que el aviso de arriba: el rojo marca, el texto oscuro se lee.
            style={{
              background: 'rgba(228, 61, 48, 0.10)',
              borderLeft: '4px solid var(--flit-danger)',
              color: 'var(--flit-text-primary)',
            }}
          >
            {fallo}
          </p>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onCerrar}
            className="flit-focus rounded-[10px] border px-4 py-2 text-sm font-semibold"
            style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}
          >
            Cancelar
          </button>
          <GradientButton type="submit" disabled={creando || !formatoValido || grupo === ''}>
            {creando ? 'Creando…' : 'Crear y vincular'}
          </GradientButton>
        </div>
      </form>
    </FlitModal>
  );
}

/** Etiqueta asociada a su control: accesibilidad bloqueante (regla 12 de AGENTS.md). */
function Campo({ etiqueta, htmlFor, children }: {
  etiqueta: string; htmlFor: string; children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>
        {etiqueta}
      </label>
      {children}
    </div>
  );
}

