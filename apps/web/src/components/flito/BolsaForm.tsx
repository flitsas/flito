// Formulario único de bolsa: alta y edición (HU #13901, Feature #13886; spec `docs/ux/flito-bolsas.md`
// Pantalla 2).
//
// Una sola página, NO un wizard: el alcance es el primer bloque y el resto aparece debajo según lo
// elegido. El `switch (alcance)` tiene dos ramas; la de tránsito es hoy `RamaTransitoProvisional`
// (una nota y «Continuar», que abre el `BolsaTransitoForm` de siempre). La HU-G (#13908) solo cambia
// esa rama: el bloque de alcance, el pie y la validación común no se tocan.
//
// Reglas que este archivo hace cumplir y no debe perder:
//   - GMF no se ofrece (CONCEPTOS_BOLSA_COMPANIA ya lo excluye) y ningún concepto viene marcado:
//     qué se descuenta de la plata de un cliente es una decisión explícita, no un valor por defecto.
//   - AC3: si la compañía ya tiene bolsa (aunque esté inactiva) se avisa al elegirla, con enlace a
//     esa bolsa; el 409 `bolsa_compania_existe` del servidor pinta el mismo aviso. Nunca el error crudo.
//   - AC10: los conceptos autogestionados llevan su marca y un aviso, pero se pueden marcar igual.
//   - Sin sección de documentos (contrato (a)/(b) con #13407).

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Info } from 'lucide-react';
import {
  CONCEPTO_BOLSA_LABEL, CONCEPTOS_BOLSA_COMPANIA, CodigoErrorBolsa,
  type AlcanceBolsa, type BolsaDetalleDto, type ConceptoBolsa,
} from '@operaciones/shared-types';
import { api, bolsasApi } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { hasPage } from '../../lib/permissions';
import { avisoAutogestion, errorBolsa, type ClienteOpcion } from '../../lib/bolsas';
import FlitModal from '../flit/FlitModal';
import StatusChip from '../flit/StatusChip';
import { flitInp, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle } from '../flit/flitPageKit';

type ConceptoCompania = (typeof CONCEPTOS_BOLSA_COMPANIA)[number];

/** Bolsa existente de una compañía, para el aviso AC3. */
interface BolsaExistente { bolsaId: string; activa: boolean }

const ENLACE = 'flit-focus rounded-sm font-semibold underline transition-colors hover:text-[color:var(--flit-blue-ink)]';

interface Props {
  /** `undefined` = alta. Con bolsa = edición de sus conceptos (solo compañía en esta HU). */
  bolsa?: BolsaDetalleDto;
  /** Alta desde «Crea la bolsa primero»: la compañía ya viene elegida. */
  companiaInicial?: number | null;
  onClose: () => void;
  /** Alta o edición guardada. El padre refresca el listado y abre / refresca el detalle. */
  onGuardada: (bolsa: BolsaDetalleDto) => void;
  /** AC3: «Ver su bolsa». El padre cierra el formulario y abre el detalle. */
  onVerBolsa: (bolsaId: string) => void;
  /** Rama tránsito (provisional hasta la HU-G): abre el formulario de tránsito de siempre. */
  onContinuarTransito: () => void;
}

export default function BolsaForm({ bolsa, companiaInicial = null, onClose, onGuardada, onVerBolsa, onContinuarTransito }: Props) {
  const { user, hasFuncion } = useAuth();
  const edicion = bolsa !== undefined;
  const puedeCompania = hasFuncion('bolsas.bolsa.crear');
  const puedeTransito = hasFuncion('bolsas.transito.crear');

  const [alcance, setAlcance] = useState<AlcanceBolsa>(edicion || puedeCompania ? 'compania' : 'transito');

  const titulo = edicion ? `Editar la bolsa de ${bolsa.nombre}` : 'Crear bolsa';

  return (
    <FlitModal title={titulo} onClose={onClose} wide>
      {edicion ? (
        <RamaCompania bolsa={bolsa} companiaInicial={null} user={user} onClose={onClose}
          onGuardada={onGuardada} onVerBolsa={onVerBolsa}
          cabecera={(
            <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
              <span className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Alcance</span>
              {' '}Compañía · {bolsa.nombre}
            </p>
          )} />
      ) : (
        (() => {
          const bloqueAlcance = <BloqueAlcance alcance={alcance} onCambio={setAlcance}
            puedeCompania={puedeCompania} puedeTransito={puedeTransito} />;
          switch (alcance) {
            case 'compania':
              return (
                <RamaCompania companiaInicial={companiaInicial} user={user} onClose={onClose}
                  onGuardada={onGuardada} onVerBolsa={onVerBolsa} cabecera={bloqueAlcance} />
              );
            case 'transito':
              return <RamaTransitoProvisional cabecera={bloqueAlcance} onClose={onClose} onContinuar={onContinuarTransito} />;
          }
        })()
      )}
    </FlitModal>
  );
}

// ─────────────────────────────── Alcance ─────────────────────────────────────

const OPCIONES_ALCANCE: Array<{ valor: AlcanceBolsa; titulo: string; texto: string }> = [
  { valor: 'compania', titulo: 'Compañía', texto: 'Saldo prepago de un cliente.' },
  { valor: 'transito', titulo: 'Tránsito', texto: 'Saldo que FLIT precarga para pagar en secretarías.' },
];

function BloqueAlcance({ alcance, onCambio, puedeCompania, puedeTransito }: {
  alcance: AlcanceBolsa;
  onCambio: (a: AlcanceBolsa) => void;
  puedeCompania: boolean;
  puedeTransito: boolean;
}) {
  // Con una sola opción, un radio no pregunta nada: se dice como texto fijo.
  if (!(puedeCompania && puedeTransito)) {
    return (
      <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
        <span className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Alcance</span>
        {' '}{puedeTransito && !puedeCompania ? 'Bolsa de tránsito' : 'Bolsa de compañía'}
      </p>
    );
  }
  return (
    <fieldset>
      <legend className="mb-2 text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
        ¿De quién es la bolsa?
      </legend>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {OPCIONES_ALCANCE.map((o) => {
          const activa = alcance === o.valor;
          return (
            <label key={o.valor}
              className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-[var(--flit-bg-hover)] has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[color:var(--flit-blue-text)]"
              style={{
                borderColor: activa ? 'var(--flit-blue-text)' : 'var(--flit-border-soft)',
                background: activa ? 'var(--flit-bg-app)' : undefined,
              }}>
              <input type="radio" name="alcance-bolsa" value={o.valor} checked={activa}
                className="mt-1" onChange={() => onCambio(o.valor)} />
              <span>
                <span className="block text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{o.titulo}</span>
                <span className="block text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{o.texto}</span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

// ─────────────────────── Rama tránsito (provisional) ─────────────────────────

/** HU-B: las bolsas de tránsito se siguen creando con su formulario propio. La HU-G sustituye esto. */
function RamaTransitoProvisional({ cabecera, onClose, onContinuar }: {
  cabecera: React.ReactNode;
  onClose: () => void;
  onContinuar: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      {cabecera}
      <p role="note" className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
        Las bolsas de tránsito se crean, por ahora, con su formulario propio: nombre, secretarías y cobros.
      </p>
      <Pie>
        <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose}>Cancelar</button>
        <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={onContinuar}>Continuar</button>
      </Pie>
    </div>
  );
}

function Pie({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap justify-end gap-2 pt-1">{children}</div>;
}

// ─────────────────────────────── Compañía ────────────────────────────────────

type EstadoLista = 'cargando' | 'error' | 'lista';
type EstadoAuto = { tipo: 'nada' } | { tipo: 'cargando' } | { tipo: 'error' } | { tipo: 'lista'; conceptos: ConceptoBolsa[] };

function RamaCompania({ bolsa, companiaInicial, user, cabecera, onClose, onGuardada, onVerBolsa }: {
  bolsa?: BolsaDetalleDto;
  companiaInicial: number | null;
  user: ReturnType<typeof useAuth>['user'];
  cabecera: React.ReactNode;
  onClose: () => void;
  onGuardada: (b: BolsaDetalleDto) => void;
  onVerBolsa: (bolsaId: string) => void;
}) {
  const edicion = bolsa !== undefined;
  const idCompania = useId();
  const idErrorConceptos = useId();
  const verClientes = hasPage(user, 'clients');

  const [clientes, setClientes] = useState<ClienteOpcion[]>([]);
  const [existentes, setExistentes] = useState<Map<number, BolsaExistente>>(new Map());
  const [estadoLista, setEstadoLista] = useState<EstadoLista>(edicion ? 'lista' : 'cargando');
  const [reintentoLista, setReintentoLista] = useState(0);

  const [companiaId, setCompaniaId] = useState<number | null>(edicion ? bolsa.companiaId : companiaInicial);
  const [auto, setAuto] = useState<EstadoAuto>(
    edicion ? { tipo: 'lista', conceptos: bolsa.conceptosAutogestionados } : { tipo: 'nada' },
  );
  const [reintentoAuto, setReintentoAuto] = useState(0);
  const [existenteServidor, setExistenteServidor] = useState<BolsaExistente | null>(null);

  const inicial = useMemo(() => new Set<string>(edicion ? bolsa.conceptos : []), [edicion, bolsa]);
  const [conceptos, setConceptos] = useState<Set<string>>(inicial);
  const [tocado, setTocado] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Compañías y bolsas ya existentes (mapa companiaId → bolsa), para el aviso preventivo AC3.
  useEffect(() => {
    if (edicion) return;
    let vigente = true;
    setEstadoLista('cargando');
    Promise.all([api.get<ClienteOpcion[]>('/clients'), bolsasApi.buscar({ alcance: 'compania' })])
      .then(([c, b]) => {
        if (!vigente) return;
        setClientes(Array.isArray(c) ? c.map((x) => ({ id: x.id, name: x.name })) : []);
        const mapa = new Map<number, BolsaExistente>();
        for (const x of Array.isArray(b) ? b : []) {
          if (x.companiaId !== null) mapa.set(x.companiaId, { bolsaId: x.id, activa: x.activa });
        }
        setExistentes(mapa);
        setEstadoLista('lista');
      })
      .catch(() => { if (vigente) setEstadoLista('error'); });
    return () => { vigente = false; };
  }, [edicion, reintentoLista]);

  // Autogestión de la compañía elegida (AC10). Informativa: su error no bloquea crear (D15).
  useEffect(() => {
    if (edicion || companiaId === null) return;
    let vigente = true;
    setAuto({ tipo: 'cargando' });
    bolsasApi.estadoCompania(companiaId)
      .then((r) => { if (vigente) setAuto({ tipo: 'lista', conceptos: r.conceptosAutogestionados ?? [] }); })
      .catch(() => { if (vigente) setAuto({ tipo: 'error' }); });
    return () => { vigente = false; };
  }, [edicion, companiaId, reintentoAuto]);

  const existente = existenteServidor ?? (companiaId !== null && !edicion ? existentes.get(companiaId) ?? null : null);
  const autogestionados = auto.tipo === 'lista' ? auto.conceptos : [];
  const nombreCompania = edicion
    ? bolsa.nombre
    : clientes.find((c) => c.id === companiaId)?.name ?? 'la compañía';

  const sinCambios = edicion && conceptos.size === inicial.size && [...conceptos].every((c) => inicial.has(c));
  const puedeGuardar = !enviando && companiaId !== null && conceptos.size > 0 && existente === null
    && !sinCambios && (edicion || estadoLista === 'lista');

  const alternar = (c: ConceptoCompania) => {
    setTocado(true);
    setConceptos((prev) => {
      const n = new Set(prev);
      if (n.has(c)) n.delete(c); else n.add(c);
      return n;
    });
  };

  const guardar = useCallback(async () => {
    if (!puedeGuardar || companiaId === null) return;
    setEnviando(true);
    setError(null);
    const lista = CONCEPTOS_BOLSA_COMPANIA.filter((c) => conceptos.has(c));
    try {
      if (edicion) {
        const r = await bolsasApi.editar(bolsa.id, { alcance: 'compania', conceptos: lista });
        toast.success('Conceptos de la bolsa actualizados.');
        onGuardada(r);
      } else {
        const r = await bolsasApi.crear({ alcance: 'compania', companiaId, conceptos: lista });
        toast.success(`Bolsa de ${r.nombre || nombreCompania} creada.`);
        onGuardada(r);
      }
    } catch (e) {
      const { status, codigo, datos } = errorBolsa(e);
      if (codigo === CodigoErrorBolsa.BOLSA_COMPANIA_EXISTE && typeof datos.bolsaId === 'string') {
        setExistenteServidor({ bolsaId: datos.bolsaId, activa: datos.activa !== false });
      } else if (codigo === CodigoErrorBolsa.BOLSA_INACTIVA) {
        setError('Reactiva la bolsa primero para cambiar sus conceptos.');
      } else if (status === 404) {
        setError('Esa compañía ya no existe. Elige otra.');
      } else if (codigo === CodigoErrorBolsa.DATOS_INVALIDOS) {
        setError('Revisa los conceptos marcados e intenta de nuevo.');
      } else {
        setError(edicion ? 'No pudimos guardar los cambios. Intenta de nuevo.' : 'No pudimos crear la bolsa. Intenta de nuevo.');
      }
    } finally {
      setEnviando(false);
    }
  }, [puedeGuardar, companiaId, conceptos, edicion, bolsa, nombreCompania, onGuardada]);

  const aviso = avisoAutogestion(autogestionados);

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void guardar(); }}>
      {cabecera}

      {!edicion && (
        <div>
          <label htmlFor={idCompania} className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            Compañía *
          </label>
          {estadoLista === 'error' ? (
            <div role="alert" className="flex flex-wrap items-center gap-3 text-sm" style={{ color: 'var(--flit-danger-ink)' }}>
              <span>No pudimos cargar las compañías.</span>
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
                onClick={() => setReintentoLista((n) => n + 1)}>
                Reintentar
              </button>
            </div>
          ) : estadoLista === 'lista' && clientes.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
              No hay compañías registradas. Créala primero en{' '}
              {verClientes
                ? <Link to="/clients" className={ENLACE} style={{ color: 'var(--flit-blue-text)' }}>Clientes y proveedores</Link>
                : 'Clientes y proveedores'}.
            </p>
          ) : (
            <select id={idCompania} className={flitInp} required disabled={estadoLista === 'cargando'}
              value={companiaId ?? ''}
              onChange={(e) => {
                setExistenteServidor(null);
                setError(null);
                setCompaniaId(e.target.value ? Number(e.target.value) : null);
              }}>
              <option value="">{estadoLista === 'cargando' ? 'Cargando compañías…' : 'Elige una compañía…'}</option>
              {clientes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
        </div>
      )}

      {existente && (
        <div role="alert" data-testid="aviso-bolsa-existente"
          className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm"
          style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-app)', color: 'var(--flit-text-secondary)' }}>
          <Info size={16} aria-hidden="true" />
          <span>{existente.activa ? 'Esta compañía ya tiene bolsa.' : 'Esta compañía ya tiene bolsa (inactiva).'}</span>
          <button type="button" className={ENLACE} style={{ color: 'var(--flit-blue-text)' }}
            onClick={() => onVerBolsa(existente.bolsaId)}>
            Ver su bolsa
          </button>
        </div>
      )}

      <fieldset aria-describedby={tocado && conceptos.size === 0 ? idErrorConceptos : undefined}>
        <legend className="mb-2 text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
          ¿Qué conceptos descuenta? *
        </legend>
        {auto.tipo === 'cargando' && (
          <p role="status" className="mb-2 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
            Consultando la autogestión de la compañía…
          </p>
        )}
        {auto.tipo === 'error' && (
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
            <span>No pudimos consultar la autogestión de esta compañía.</span>
            <button type="button" className={ENLACE} style={{ color: 'var(--flit-blue-text)' }}
              onClick={() => setReintentoAuto((n) => n + 1)}>
              Reintentar
            </button>
          </div>
        )}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {CONCEPTOS_BOLSA_COMPANIA.map((c) => (
            <label key={c}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-[var(--flit-bg-hover)]">
              <input type="checkbox" className="flit-focus" checked={conceptos.has(c)} onChange={() => alternar(c)} />
              <span>{CONCEPTO_BOLSA_LABEL[c]}</span>
              {autogestionados.includes(c) && <StatusChip tone="neutral">Autogestionado</StatusChip>}
            </label>
          ))}
        </div>
        {tocado && conceptos.size === 0 && (
          <p id={idErrorConceptos} className="mt-1 text-xs" style={{ color: 'var(--flit-danger-ink)' }}>
            Marca al menos un concepto.
          </p>
        )}
      </fieldset>

      {aviso && <AvisoAutogestion texto={aviso} verClientes={verClientes} />}

      {error && <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>{error}</p>}

      <Pie>
        <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose}>Cancelar</button>
        <button type="submit" className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={!puedeGuardar}>
          {edicion ? (enviando ? 'Guardando…' : 'Guardar cambios') : (enviando ? 'Creando…' : 'Crear bolsa')}
        </button>
      </Pie>
    </form>
  );
}

/** Aviso de autogestión (AC10). `role="note"`: informa, no es un error. Lo reutiliza el detalle. */
export function AvisoAutogestion({ texto, verClientes }: { texto: string; verClientes: boolean }) {
  return (
    <div role="note" data-testid="aviso-autogestion"
      className="flex items-start gap-2 rounded-lg border px-3 py-2 text-sm"
      style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-app)', color: 'var(--flit-text-secondary)' }}>
      <Info size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
      <p className="min-w-0">
        {texto}{' '}
        {verClientes ? (
          <Link to="/clients" className={ENLACE} style={{ color: 'var(--flit-blue-text)' }}>
            Cambiarlo en Clientes y proveedores
          </Link>
        ) : (
          'Lo cambia Operaciones en Clientes y proveedores.'
        )}
      </p>
    </div>
  );
}
