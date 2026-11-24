// Torre de Control (Épica #14590) — Umbrales y alertas, en Administración (spec UX §7.5). Molde de tabla del kit:
// pestañas por grupo y `DataTable` con GET `/flito/torre/umbrales`. «Editar» (acción de fila, sin primaria de página)
// abre un modal con «Guardar» → PUT `/umbrales/:clave`. Solo con la función `torre.umbrales.editar`; sin ella, la
// tabla es de solo lectura y un aviso en página lo explica.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  GRUPOS_UMBRAL_TORRE, UMBRALES_TORRE, UMBRAL_TORRE_VALOR_MAX,
  type GrupoUmbralTorre, type UmbralTorre, type UnidadUmbralTorre,
} from '@operaciones/shared-types';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import PageHeaderCard from '../../components/flit/PageHeaderCard';
import Pestanas from '../../components/flit/Pestanas';
import DataTable, { type ColumnaTabla } from '../../components/flit/DataTable';
import InlineAlert from '../../components/flit/InlineAlert';
import FlitModal from '../../components/flit/FlitModal';
import GradientButton from '../../components/flit/GradientButton';
import { toastOk } from '../../components/flit/ToastFlito';
import type { EstadoUi } from '../../components/flit/Cargador';
import { fechaCorta } from '../../components/torre/formatoTorre';

export const FUNCION_EDITAR_UMBRALES = 'torre.umbrales.editar';

const NOMBRE_UMBRAL: Record<string, string> = {
  horas_sin_gestion: 'Horas sin gestión',
  dias_borrador_abandonado: 'Borrador abandonado',
  horas_soat_impuesto_sin_soporte: 'SOAT o impuesto sin soporte',
  dias_respuesta_ot: 'Respuesta del organismo de tránsito',
  pct_caida_volumen: 'Caída de volumen',
  dias_ventana_fuga: 'Ventana de fuga',
  dias_cobertura_amarillo: 'Cobertura en atención',
  dias_cobertura_rojo: 'Cobertura crítica',
  meta_mensual_aprobados: 'Meta mensual de aprobados',
};
const UNIDAD: Record<UnidadUmbralTorre, string> = { dias: 'días', horas: 'horas', porcentaje: '%', cop: 'pesos', conteo: 'trámites' };
const GRUPO: Record<GrupoUmbralTorre, string> = { comercial: 'Comercial', operativo: 'Operativa', financiero: 'Financiera', general: 'General' };
const ORDEN_GRUPOS: GrupoUmbralTorre[] = ['comercial', 'operativo', 'financiero', 'general'];
const grupoDe = (clave: string): GrupoUmbralTorre => UMBRALES_TORRE.find((u) => u.clave === clave)?.grupo ?? 'general';
const maximoDe = (u: UnidadUmbralTorre) => (u === 'porcentaje' ? 100 : UMBRAL_TORRE_VALOR_MAX);
const valorTexto = (u: UmbralTorre) => u.valor.toLocaleString('es-CO', { maximumFractionDigits: 2 });

export default function TorreUmbrales() {
  const { hasFuncion } = useAuth();
  const puedeEditar = hasFuncion(FUNCION_EDITAR_UMBRALES);
  const [filas, setFilas] = useState<UmbralTorre[]>([]);
  const [status, setStatus] = useState<EstadoUi>('loading');
  const [grupo, setGrupo] = useState<GrupoUmbralTorre>('comercial');
  const [editando, setEditando] = useState<UmbralTorre | null>(null);
  const botonEditar = useRef<HTMLElement | null>(null);

  const cargar = useCallback(() => {
    setStatus('loading');
    api.get<UmbralTorre[]>('/flito/torre/umbrales')
      .then((u) => { setFilas(u); setStatus(u.length === 0 ? 'empty' : 'ready'); })
      .catch(() => setStatus('error'));
  }, []);
  useEffect(() => { cargar(); }, [cargar]);

  const delGrupo = filas.filter((u) => grupoDe(u.clave) === grupo);
  const columnas: ColumnaTabla<UmbralTorre>[] = [
    { key: 'nombre', header: 'Umbral', render: (u) => <strong>{NOMBRE_UMBRAL[u.clave] ?? u.clave}</strong> },
    { key: 'valor', header: 'Valor', align: 'right', render: (u) => <span className="tabular-nums">{valorTexto(u)}</span> },
    { key: 'unidad', header: 'Unidad', render: (u) => UNIDAD[u.unidad] },
    { key: 'descripcion', header: 'Descripción', render: (u) => u.descripcion },
    {
      key: 'modificacion', header: 'Última modificación',
      render: (u) => (u.actualizadoEn ? `${u.actualizadoPor?.nombre ?? 'Sistema'} · ${fechaCorta(u.actualizadoEn)}` : 'Valor de fábrica'),
    },
    ...(puedeEditar ? [{
      key: 'acciones', header: <span className="sr-only">Acciones</span>, acciones: true,
      render: (u: UmbralTorre) => (
        <GradientButton variant="ghost" size="sm" aria-label={`Editar ${NOMBRE_UMBRAL[u.clave] ?? u.clave}`}
          onClick={(e) => { botonEditar.current = e.currentTarget; setEditando(u); }}>
          Editar
        </GradientButton>
      ),
    }] : []),
  ];

  const presentes = ORDEN_GRUPOS.filter((g) => GRUPOS_UMBRAL_TORRE.includes(g));
  return (
    <div className="flex flex-col gap-4" data-torre="umbrales">
      <PageHeaderCard title="Umbrales y alertas" miga={[{ etiqueta: 'Administración' }]}
        subtitle="Los límites que usan los tableros de la Torre para marcar algo en atención o en crítico." />
      {!puedeEditar && (
        <InlineAlert tono="info">Usted puede consultar los umbrales; para cambiarlos, pida a un administrador.</InlineAlert>
      )}
      <Pestanas etiqueta="Grupos de umbrales" activa={grupo} onElegir={(id) => setGrupo(id as GrupoUmbralTorre)}
        pestanas={presentes.map((g) => ({ id: g, etiqueta: GRUPO[g], cuenta: status === 'ready' ? filas.filter((u) => grupoDe(u.clave) === g).length : undefined }))} />
      <DataTable ariaLabel={`Umbrales ${GRUPO[grupo]}`} columnas={columnas} filas={delGrupo} getKey={(u) => u.clave}
        status={status === 'ready' && delGrupo.length === 0 ? 'empty' : status} onRetry={cargar}
        errorMessage="No pudimos cargar los umbrales. Intente de nuevo."
        emptyMessage="Aún no hay umbrales configurados."
        emptyDetalle="Ejecute la migración de la Torre o pida ayuda a soporte." />
      {editando && (
        <ModalUmbral umbral={editando} restoreFocusRef={botonEditar} onCerrar={() => setEditando(null)}
          onGuardado={(u) => { setFilas((fs) => fs.map((f) => (f.clave === u.clave ? u : f))); setEditando(null); toastOk('Umbral actualizado.', { id: 'torre-umbral' }); }} />
      )}
    </div>
  );
}

function ModalUmbral({ umbral, onCerrar, onGuardado, restoreFocusRef }: {
  umbral: UmbralTorre; onCerrar: () => void; onGuardado: (u: UmbralTorre) => void;
  restoreFocusRef: React.RefObject<HTMLElement | null>;
}) {
  const [texto, setTexto] = useState(String(umbral.valor));
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const id = useId();
  const max = maximoDe(umbral.unidad);
  const nombre = NOMBRE_UMBRAL[umbral.clave] ?? umbral.clave;

  const validar = (): number | null => {
    const n = Number(texto.replace(',', '.'));
    if (texto.trim() === '' || !Number.isFinite(n)) { setError('Escriba un número.'); return null; }
    if (n < 0) { setError('El valor no puede ser negativo.'); return null; }
    if (n > max) { setError(`El valor no puede pasar de ${max.toLocaleString('es-CO')}.`); return null; }
    setError(null);
    return n;
  };
  const guardar = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = validar();
    if (n === null) return;
    setGuardando(true);
    try {
      const u = await api.put<UmbralTorre>(`/flito/torre/umbrales/${encodeURIComponent(umbral.clave)}`, { valor: n });
      onGuardado(u);
    } catch {
      setError('No pudimos guardar el umbral. Revise el valor e intente de nuevo.');
    } finally {
      setGuardando(false);
    }
  };

  return (
    <FlitModal title="Editar umbral" antetitulo={nombre} onClose={onCerrar} restoreFocusRef={restoreFocusRef} cierreBloqueado={guardando}>
      <form noValidate onSubmit={guardar} className="flex flex-col gap-4">
        <p className="m-0 text-sm" style={{ color: 'var(--color-text-secondary)' }}>{umbral.descripcion}</p>
        <p className="m-0 text-sm">Valor actual: <strong className="tabular-nums">{valorTexto(umbral)} {UNIDAD[umbral.unidad]}</strong></p>
        <div className="campo">
          <label htmlFor={id}>Nuevo valor ({UNIDAD[umbral.unidad]})</label>
          <input id={id} className="control" type="number" inputMode="decimal" min={0} max={max} step="any" value={texto}
            aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined}
            onChange={(e) => { setTexto(e.target.value); if (error) setError(null); }} onBlur={() => { if (texto !== '') validar(); }} />
          {error && <p id={`${id}-error`} className="error mt-1 text-sm" role="alert" style={{ color: 'var(--flit-danger-ink)' }}>{error}</p>}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <GradientButton type="button" variant="ghost" onClick={onCerrar} disabled={guardando}>Cancelar</GradientButton>
          <GradientButton type="submit" ocupado={guardando}>Guardar</GradientButton>
        </div>
      </form>
    </FlitModal>
  );
}
