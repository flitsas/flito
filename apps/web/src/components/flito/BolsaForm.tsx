// Formulario único de bolsa: alta y edición (HU #13901, Feature #13886; spec `docs/ux/flito-bolsas.md`
// Pantalla 2).
//
// Una sola página, NO un wizard: el alcance es el primer bloque y el resto aparece debajo según lo
// elegido. El `switch (alcance)` tiene dos ramas. La de tránsito (HU #13908) es `RamaTransito`: nombre,
// cobros y secretarías, y sirve también para editar una bolsa de tránsito. El 409 `cobertura_ocupada`
// señala cada pareja en conflicto con el nombre de la bolsa que la tiene y conserva lo escrito.
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
  CONCEPTO_BOLSA_LABEL, CONCEPTO_BOLSA_TRANSITO_LABEL, CONCEPTOS_BOLSA_COMPANIA, CONCEPTOS_BOLSA_TRANSITO,
  CodigoErrorBolsa,
  type AlcanceBolsa, type BolsaDetalleDto, type ConceptoBolsa, type ConceptoBolsaTransito, type ParCoberturaOcupada,
} from '@operaciones/shared-types';
import { api, bolsasApi } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { hasPage } from '../../lib/permissions';
import {
  avisoAutogestion, avisoAutogestionTransito, cobroTransito, errorBolsa, nombreSecretaria, paresOcupados,
  type ClienteOpcion,
} from '../../lib/bolsas';
import FlitModal from '../flit/FlitModal';
import { toastOk } from '../flit/ToastFlito';
import StatusChip from '../flit/StatusChip';
import { opcionesConEstado } from '../flit/opcionesConEstado';
import { flitInp, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle } from '../flit/flitPageKit';

type ConceptoCompania = (typeof CONCEPTOS_BOLSA_COMPANIA)[number];

/** Bolsa existente de una compañía, para el aviso AC3. */
interface BolsaExistente { bolsaId: string; activa: boolean }

const ENLACE = 'flit-focus rounded-sm font-semibold underline transition-colors hover:text-[color:var(--flit-blue-ink)]';

interface Props {
  /** `undefined` = alta. Con bolsa = edición (de compañía: sus conceptos; de tránsito: nombre y cobertura). */
  bolsa?: BolsaDetalleDto;
  /** Alta desde «Crea la bolsa primero»: la compañía ya viene elegida. */
  companiaInicial?: number | null;
  onClose: () => void;
  /** Alta o edición guardada. El padre refresca el listado y abre / refresca el detalle. */
  onGuardada: (bolsa: BolsaDetalleDto) => void;
  /** AC3: «Ver su bolsa». El padre cierra el formulario y abre el detalle. */
  onVerBolsa: (bolsaId: string) => void;
  /**
   * Obsoleto desde la HU #13908 (la rama tránsito ya guarda sola). Se acepta y se ignora para no tocar
   * a quien aún lo pasa (`BolsaDetalleCompania`, fuera del alcance de esta HU).
   */
  onContinuarTransito?: () => void;
}

export default function BolsaForm({ bolsa, companiaInicial = null, onClose, onGuardada, onVerBolsa }: Props) {
  const { user, hasFuncion } = useAuth();
  const edicion = bolsa !== undefined;
  const puedeCompania = hasFuncion('bolsas.bolsa.crear');
  const puedeTransito = hasFuncion('bolsas.transito.crear');

  const [alcance, setAlcance] = useState<AlcanceBolsa>(edicion || puedeCompania ? 'compania' : 'transito');

  const titulo = edicion
    ? (bolsa.alcance === 'transito' ? `Editar la bolsa ${bolsa.nombre}` : `Editar la bolsa de ${bolsa.nombre}`)
    : 'Crear bolsa';

  return (
    <FlitModal title={titulo} onClose={onClose} wide>
      {edicion && bolsa.alcance === 'transito' ? (
        <RamaTransito bolsa={bolsa} onClose={onClose} onGuardada={onGuardada}
          cabecera={(
            <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
              <span className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Alcance</span>
              {' '}Tránsito
            </p>
          )} />
      ) : edicion ? (
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
              return <RamaTransito cabecera={bloqueAlcance} onClose={onClose} onGuardada={onGuardada} />;
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
        setClientes(Array.isArray(c) ? c.map((x) => ({ id: x.id, name: x.name, active: x.active })) : []);
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
              {/* HU #13950: inactiva = en gris, «(Inactivo)» en texto y no elegible. */}
              {opcionesConEstado(clientes.map((c) => ({ id: c.id, nombre: c.name, activo: c.active })), String(companiaId ?? ''))
                .map((o) => (
                  <option key={o.valor} value={o.valor} disabled={o.deshabilitada || undefined} aria-disabled={o.deshabilitada || undefined}>
                    {o.nota ? `${o.etiqueta} (${o.nota})` : o.etiqueta}
                  </option>
                ))}
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

// ─────────────────────────────── Tránsito ────────────────────────────────────

/** Una secretaría del catálogo de Tránsito (`/transito/organismos-config`, no es ruta de bolsas). */
interface SecretariaOpcion {
  codigo: string;
  nombre: string;
  ciudad: string;
  alias: string | null;
}

const etiquetaSecretaria = (o: SecretariaOpcion): string => o.alias?.trim() || `${o.ciudad} — ${o.nombre}`;

const mismoConjunto = (a: Iterable<string>, b: Iterable<string>): boolean => {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
};

/**
 * Rama tránsito del formulario único (HU #13908): alta y edición de nombre, cobros y secretarías.
 *
 * La regla «una secretaría no repite cobro entre bolsas activas» la impone el servidor (409
 * `cobertura_ocupada` con las parejas y la bolsa que las tiene). Aquí solo se pinta: duplicarla en el
 * navegador sería arriesgar que un día la pantalla diga que sí y el servidor que no.
 */
function RamaTransito({ bolsa, cabecera, onClose, onGuardada }: {
  bolsa?: BolsaDetalleDto;
  cabecera: React.ReactNode;
  onClose: () => void;
  onGuardada: (b: BolsaDetalleDto) => void;
}) {
  const edicion = bolsa !== undefined;
  const idNombre = useId();
  const idErrNombre = useId();
  const idErrCobros = useId();
  const idErrSecretarias = useId();
  const idBusqueda = useId();

  const inicialOrganismos = useMemo(
    () => (edicion ? [...new Set(bolsa.cobertura.map((c) => c.organismoCodigo))] : []), [edicion, bolsa],
  );
  const inicialConceptos = useMemo(() => {
    if (!edicion) return [] as string[];
    return bolsa.conceptos.length > 0 ? bolsa.conceptos : [...new Set(bolsa.cobertura.map((c) => c.concepto))];
  }, [edicion, bolsa]);

  const [nombre, setNombre] = useState(edicion ? bolsa.nombre : '');
  const [conceptos, setConceptos] = useState<Set<string>>(() => new Set(inicialConceptos));
  const [organismos, setOrganismos] = useState<string[]>(inicialOrganismos);
  const [catalogo, setCatalogo] = useState<SecretariaOpcion[]>([]);
  const [estadoCat, setEstadoCat] = useState<EstadoLista>('cargando');
  const [reintentoCat, setReintentoCat] = useState(0);
  const [busqueda, setBusqueda] = useState('');
  const [tocado, setTocado] = useState({ nombre: false, cobros: false, secretarias: false });
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nombreEnUso, setNombreEnUso] = useState(false);
  const [ocupados, setOcupados] = useState<ParCoberturaOcupada[]>([]);

  useEffect(() => {
    let vigente = true;
    setEstadoCat('cargando');
    api.get<SecretariaOpcion[]>('/transito/organismos-config')
      .then((o) => { if (vigente) { setCatalogo(Array.isArray(o) ? o : []); setEstadoCat('lista'); } })
      .catch(() => { if (vigente) setEstadoCat('error'); });
    return () => { vigente = false; };
  }, [reintentoCat]);

  const etiquetaDe = useCallback((codigo: string): string => {
    const o = catalogo.find((c) => c.codigo === codigo);
    return o ? etiquetaSecretaria(o) : nombreSecretaria(codigo);
  }, [catalogo]);

  const q = busqueda.trim().toLowerCase();
  const visibles = q
    ? catalogo.filter((o) => etiquetaSecretaria(o).toLowerCase().includes(q) || o.codigo.includes(q))
    : catalogo;

  // La lista del 409 se recalcula contra la selección actual: lo que el usuario desmarca sale del aviso.
  const vigentes = ocupados.filter((p) => organismos.includes(p.organismoCodigo) && conceptos.has(p.concepto));

  const nombreCorto = nombre.trim().length < 3;
  const sinCambios = edicion && nombre.trim() === bolsa.nombre
    && mismoConjunto(conceptos, inicialConceptos) && mismoConjunto(organismos, inicialOrganismos);
  const puedeGuardar = !enviando && !nombreCorto && conceptos.size > 0 && organismos.length > 0
    && estadoCat === 'lista' && vigentes.length === 0 && !sinCambios;

  // AC9 (solo edición): parejas (secretaría, impuesto) autogestionadas que siguen marcadas. No bloquea.
  const avisoAuto = edicion && conceptos.has('impuesto')
    ? avisoAutogestionTransito((bolsa.paresAutogestionados ?? [])
      .filter((p) => organismos.includes(p.organismoCodigo))
      .map((p) => etiquetaDe(p.organismoCodigo)))
    : null;

  const alternarCobro = (c: string) => {
    setTocado((t) => ({ ...t, cobros: true }));
    setConceptos((prev) => {
      const n = new Set(prev);
      if (n.has(c)) n.delete(c); else n.add(c);
      return n;
    });
  };
  const alternarSecretaria = (codigo: string) => {
    setTocado((t) => ({ ...t, secretarias: true }));
    setOrganismos((prev) => (prev.includes(codigo) ? prev.filter((v) => v !== codigo) : [...prev, codigo]));
  };

  const guardar = useCallback(async () => {
    if (!puedeGuardar) return;
    setEnviando(true);
    setError(null);
    setOcupados([]);
    const cuerpo = {
      alcance: 'transito' as const,
      nombre: nombre.trim(),
      organismos,
      conceptos: CONCEPTOS_BOLSA_TRANSITO.filter((c) => conceptos.has(c)),
    };
    try {
      if (edicion) {
        const r = await bolsasApi.editar(bolsa.id, cuerpo);
        toastOk('Cobertura de la bolsa actualizada.');
        onGuardada(r);
      } else {
        const r = await bolsasApi.crear(cuerpo);
        toastOk(`Bolsa ${r.nombre || cuerpo.nombre} creada.`);
        onGuardada(r);
      }
    } catch (e) {
      const { codigo, datos } = errorBolsa(e);
      if (codigo === CodigoErrorBolsa.COBERTURA_OCUPADA) {
        setOcupados(paresOcupados(datos));
      } else if (codigo === CodigoErrorBolsa.NOMBRE_EN_USO) {
        setNombreEnUso(true);
      } else if (codigo === CodigoErrorBolsa.DATOS_INVALIDOS) {
        setError('Revisa el nombre, los cobros y las secretarías e intenta de nuevo.');
      } else if (codigo === CodigoErrorBolsa.BOLSA_INACTIVA) {
        setError('Reactiva la bolsa primero para cambiar su cobertura.');
      } else {
        setError(edicion ? 'No pudimos guardar los cambios. Intenta de nuevo.' : 'No pudimos crear la bolsa. Intenta de nuevo.');
      }
    } finally {
      setEnviando(false);
    }
  }, [puedeGuardar, nombre, organismos, conceptos, edicion, bolsa, onGuardada]);

  const errNombre = nombreEnUso
    ? 'Ya hay una bolsa con ese nombre. Elige otro.'
    : tocado.nombre && nombreCorto ? 'Escribe un nombre de al menos 3 caracteres.' : null;
  const errCobros = tocado.cobros && conceptos.size === 0;
  const errSecretarias = tocado.secretarias && organismos.length === 0;

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void guardar(); }}>
      {cabecera}

      <div>
        <label htmlFor={idNombre} className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
          Nombre *
        </label>
        <input id={idNombre} type="text" className={flitInp} value={nombre} maxLength={120}
          placeholder="Ej. Bolsa Centro" aria-invalid={errNombre ? true : undefined}
          aria-describedby={errNombre ? idErrNombre : undefined}
          onChange={(e) => { setNombre(e.target.value); setNombreEnUso(false); }}
          onBlur={() => setTocado((t) => ({ ...t, nombre: true }))} />
        {errNombre && (
          <p id={idErrNombre} className="mt-1 text-xs" style={{ color: 'var(--flit-danger-ink)' }}>{errNombre}</p>
        )}
      </div>

      <fieldset aria-describedby={errCobros ? idErrCobros : undefined}>
        <legend className="mb-2 text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
          ¿Qué cobros descuenta? *
        </legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {CONCEPTOS_BOLSA_TRANSITO.map((c) => (
            <label key={c}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-[var(--flit-bg-hover)]">
              <input type="checkbox" className="flit-focus" checked={conceptos.has(c)} onChange={() => alternarCobro(c)} />
              <span>{CONCEPTO_BOLSA_TRANSITO_LABEL[c as ConceptoBolsaTransito]}</span>
            </label>
          ))}
        </div>
        {errCobros && (
          <p id={idErrCobros} className="mt-1 text-xs" style={{ color: 'var(--flit-danger-ink)' }}>Marca al menos un cobro.</p>
        )}
      </fieldset>

      <fieldset aria-describedby={errSecretarias ? idErrSecretarias : undefined}>
        <legend className="mb-2 text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
          Secretarías a las que aplica *{' '}
          <span className="font-normal" style={{ color: 'var(--flit-text-secondary)' }}>
            ({organismos.length} seleccionada{organismos.length === 1 ? '' : 's'})
          </span>
        </legend>
        <label htmlFor={idBusqueda} className="sr-only">Buscar secretaría</label>
        <input id={idBusqueda} type="search" className={`${flitInp} mb-2`} value={busqueda}
          placeholder="Buscar secretaría…" disabled={estadoCat !== 'lista' || catalogo.length === 0}
          onChange={(e) => setBusqueda(e.target.value)} />
        <div className="max-h-56 overflow-y-auto rounded-lg border p-2" style={{ borderColor: 'var(--flit-border-soft)' }}>
          {estadoCat === 'cargando' && (
            <p role="status" className="p-2 text-xs" style={{ color: 'var(--flit-text-muted)' }}>Cargando secretarías…</p>
          )}
          {estadoCat === 'error' && (
            <div role="alert" className="flex flex-wrap items-center gap-3 p-2 text-sm" style={{ color: 'var(--flit-danger-ink)' }}>
              <span>No pudimos cargar las secretarías.</span>
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
                onClick={() => setReintentoCat((n) => n + 1)}>
                Reintentar
              </button>
            </div>
          )}
          {estadoCat === 'lista' && catalogo.length === 0 && (
            <p className="p-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
              No hay secretarías configuradas. Configúralas en Tránsito.
            </p>
          )}
          {estadoCat === 'lista' && catalogo.length > 0 && visibles.length === 0 && (
            <p className="p-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
              Ninguna secretaría coincide con «{busqueda.trim()}».
            </p>
          )}
          {estadoCat === 'lista' && visibles.length > 0 && (
            <ul className="flex flex-col gap-0.5">
              {visibles.map((o) => {
                const choques = vigentes.filter((p) => p.organismoCodigo === o.codigo);
                const idChoque = `choque-${o.codigo}`;
                return (
                  <li key={o.codigo} data-testid={`secretaria-${o.codigo}`}>
                    <label className="flex min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-[var(--flit-bg-hover)]">
                      <input type="checkbox" className="flit-focus" checked={organismos.includes(o.codigo)}
                        aria-describedby={choques.length > 0 ? idChoque : undefined}
                        onChange={() => alternarSecretaria(o.codigo)} />
                      <span className="min-w-0 truncate" title={etiquetaSecretaria(o)}>{etiquetaSecretaria(o)}</span>
                    </label>
                    {choques.length > 0 && (
                      <p id={idChoque} className="pb-1 pl-8 text-xs" style={{ color: 'var(--flit-danger-ink)' }}>
                        {choques.map((p) => `Ya la cubre «${p.bolsaNombre}» para ${cobroTransito(p.concepto)}.`).join(' ')}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {errSecretarias && (
          <p id={idErrSecretarias} className="mt-1 text-xs" style={{ color: 'var(--flit-danger-ink)' }}>
            Elige al menos una secretaría.
          </p>
        )}
      </fieldset>

      {vigentes.length > 0 && (
        <div role="alert" data-testid="aviso-cobertura-ocupada" className="rounded-lg border px-3 py-2 text-sm"
          style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-app)', color: 'var(--flit-danger-ink)' }}>
          <p>
            Estas secretarías ya las cubre otra bolsa activa para el mismo cobro. Quítalas o desmarca ese cobro para guardar:
          </p>
          <ul className="mt-1 list-disc pl-5">
            {vigentes.map((p) => (
              <li key={`${p.organismoCodigo}-${p.concepto}`}>
                {etiquetaDe(p.organismoCodigo)} · {cobroTransito(p.concepto)} — en «{p.bolsaNombre}»
              </li>
            ))}
          </ul>
        </div>
      )}

      {avisoAuto && <AvisoAutogestionTransito texto={avisoAuto} />}

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

/** Aviso de autogestión de impuestos en tránsito (AC9). Sin enlace a Clientes: eso es de compañía. */
export function AvisoAutogestionTransito({ texto }: { texto: string }) {
  return (
    <div role="note" data-testid="aviso-autogestion-transito"
      className="flex items-start gap-2 rounded-lg border px-3 py-2 text-sm"
      style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-app)', color: 'var(--flit-text-secondary)' }}>
      <Info size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
      <p className="min-w-0">{texto}</p>
    </div>
  );
}
