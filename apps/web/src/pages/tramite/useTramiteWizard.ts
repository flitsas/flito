// TRAM-ARCH-01d — hook con TODO el estado y la lógica del wizard de trámites.
//
// Migra el cuerpo que vivía en TramiteDigital.tsx (state + handlers VIN/RUNT,
// pre-vuelo, OCR upload, FUR/envío a tránsito, polling de identidad, organismo
// de tránsito). El shell (TramiteWizardShell) y la página (TramiteDigital)
// consumen lo que necesitan. NO cambia contratos API ni comportamiento.

import { useState, useEffect, useRef } from 'react';
import { api, errorMessage } from '../../lib/api';
import { parseTramiteConflict, type TramiteConflictPayload } from './tramiteConflict';
import toast from 'react-hot-toast';
import { computeChecklist, vendedorRequerido, normalizarDocumentoTraspaso, resolverValidacionVigentePorDocumento } from '@operaciones/shared-types';
import { DOC_TYPES, CIUDADES_CO } from '../../constants/tramite';
import type { PreflightSnapshot } from './PreflightPanel';
import type { CedulaOcrData } from '../../components/identidad/CedulaCaptureOverlay';
import type {
  VehiculoData, RuntData, RuntConsultaVehiculoResponse, CompradorData, RuntPersonaResponse,
  OcrResult, ArchivoData, ValidationStatus, ValidacionIniciarResponse, ValidacionEstadoResponse,
  TramiteFull, TramiteCreatedResponse, OrgTransito, VendedorData,
} from './wizard/types';

// Resolución de "validación vigente" por documento: fuente única en shared-types
// (resolverValidacionVigentePorDocumento), con tests. Centraliza el bug recurrente
// de elegir la fila por índice/recencia.

const EMPTY_COMPRADOR: CompradorData = { nombre: '', tipoDoc: 'CC', documento: '', email: '', telefono: '', direccion: '', ciudad: '' };
const EMPTY_VENDEDOR: VendedorData = { nombre: '', tipoDoc: 'CC', documento: '' };
const EMPTY_ORG: OrgTransito = { nombre: '', ciudad: '', codigo: '' };

export function useTramiteWizard(onClose: () => void) {
  const [wizardOpen, setWizardOpen] = useState(false);
  const [duplicateConflict, setDuplicateConflict] = useState<TramiteConflictPayload | null>(null);
  const [step, setStep] = useState(1);
  const [tramiteId, setTramiteId] = useState<number | null>(null);
  const [estadoTramite, setEstadoTramite] = useState<string>('borrador');

  // Step 1
  const [vin, setVin] = useState('');
  const [vinLoading, setVinLoading] = useState(false);
  const [vehiculo, setVehiculo] = useState<VehiculoData | null>(null);
  const [runtData, setRuntData] = useState<RuntData | null>(null);

  // A1: pre-vuelo (semáforo SOAT/SIMIT/RUNT). overall=red exige asumir riesgo.
  const [preflight, setPreflight] = useState<PreflightSnapshot | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [riesgoAceptado, setRiesgoAceptado] = useState(false);
  const preflightVinRef = useRef<string | null>(null);

  // A5: tipología + checklist (catálogo en shared-types; gate revalidado en backend)
  const [tipologiaCodigo, setTipologiaCodigo] = useState<string | null>(null);
  const [checklistEstado, setChecklistEstado] = useState<Record<string, boolean>>({});

  // Modal secretaría de tránsito
  const [showOrgModal, setShowOrgModal] = useState(false);
  const [orgTransito, setOrgTransito] = useState<OrgTransito>(EMPTY_ORG);

  // Step 2
  const [archivos, setArchivos] = useState<ArchivoData[]>([]);
  const [uploading, setUploading] = useState<Record<string, boolean>>({});
  const [ocrResults, setOcrResults] = useState<Record<string, OcrResult>>({});

  // Step 3
  const [comprador, setComprador] = useState<CompradorData>(EMPTY_COMPRADOR);
  const [compradorLoading, setCompradorLoading] = useState(false);
  const [compradorRunt, setCompradorRunt] = useState<RuntPersonaResponse | null>(null);
  // TRAM-TIPO-01: vendedor (parte saliente) — solo se exige en `traspaso_standard`.
  const [vendedor, setVendedor] = useState<VendedorData>(EMPTY_VENDEDOR);
  const [vendedorLoading, setVendedorLoading] = useState(false);
  const [vendedorRunt, setVendedorRunt] = useState<RuntPersonaResponse | null>(null);
  const [ciudadFilter, setCiudadFilter] = useState('');
  const [showCiudades, setShowCiudades] = useState(false);
  const [cedulaOverlayOpen, setCedulaOverlayOpen] = useState(false);

  // Step 4: Identidad — flujo por email
  const [emailSent, setEmailSent] = useState(false);
  const [enlaceManual, setEnlaceManual] = useState<string | null>(null);
  const [emailSending, setEmailSending] = useState(false);
  const [validationStatus, setValidationStatus] = useState<ValidationStatus | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const filteredCiudades = ciudadFilter.length >= 2 ? CIUDADES_CO.filter((c) => c.toLowerCase().includes(ciudadFilter.toLowerCase())).slice(0, 8) : [];

  const ejecutarPreflight = async (vinArg?: string) => {
    const vinClean = (vinArg ?? vin).trim().toUpperCase();
    if (!vinClean) return;
    setPreflightLoading(true);
    try {
      const snap = await api.post<PreflightSnapshot>('/tramites/preflight', {
        vin: vinClean,
        placa: vehiculo?.placa || vehiculo?.noPlaca || undefined,
        compradorDoc: comprador.documento || undefined,
        compradorTipoDoc: comprador.tipoDoc || undefined,
        compradorNombre: comprador.nombre || undefined, // B6: screening LAFT
        // TRAM-TIPO-01/02: pre-vuelo del vendedor SOLO si la tipología lo exige
        // (traspaso_standard). Importación/remate/sucesión → sin RUNT vendedor.
        vendedorDoc: vendedorRequerido(tipologiaCodigo) ? (vendedor.documento || undefined) : undefined,
        vendedorTipoDoc: vendedorRequerido(tipologiaCodigo) ? (vendedor.tipoDoc || undefined) : undefined,
        vendedorNombre: vendedorRequerido(tipologiaCodigo) ? (vendedor.nombre || undefined) : undefined,
        tramiteId: tramiteId ?? undefined,
      });
      setPreflight(snap);
      setRiesgoAceptado(false);
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setPreflightLoading(false); }
  };

  // PRE-02: telemetría de click en CTA del pre-vuelo (best-effort; requiere trámite).
  const registrarPreflightCta = (checkKey: string, ctaId: string) => {
    if (!tramiteId) return;
    api.post(`/tramites/${tramiteId}/preflight/cta`, { checkKey, ctaId, overall: preflight?.overall }).catch(() => {});
  };

  // Cambiar tipología (persiste si el trámite ya existe; si no, se guarda en paso 1).
  const cambiarTipologia = (codigo: string) => {
    setTipologiaCodigo(codigo);
    if (tramiteId) api.patch(`/tramites/${tramiteId}`, { tipologiaCodigo: codigo }).catch(() => {});
  };
  const toggleChecklistItem = (itemId: string, checked: boolean) => {
    setChecklistEstado((prev) => {
      const next = { ...prev, [itemId]: checked };
      if (tramiteId) api.patch(`/tramites/${tramiteId}`, { checklistEstado: next }).catch(() => {});
      return next;
    });
  };

  // A (CRÍTICO-2): un trámite ya enviado a tránsito NO debe editarse desde el wizard.
  // Sus pasos (comprador, documentos, identidad) son editables solo en estados de
  // borrador. Guard centralizado: bloquea las mutaciones con aviso claro.
  const estadoEditable = ['borrador', 'rechazado'].includes(estadoTramite);
  const bloqueadoPorEstado = (): boolean => {
    if (tramiteId && !estadoEditable) {
      toast.error('Este trámite ya fue enviado a tránsito; no se puede editar.');
      return true;
    }
    return false;
  };

  const enviarEmailValidacion = async () => {
    if (!tramiteId) return;
    if (bloqueadoPorEstado()) return;
    if (!comprador.email) { toast.error('El comprador no tiene email registrado'); return; }
    setEmailSending(true);
    try {
      const res = await api.post<ValidacionIniciarResponse>('/validacion-identidad/iniciar', { tramiteId });
      if (res.ok) {
        setEmailSent(true);
        if (res.fallback && res.link) {
          setEnlaceManual(res.link);
          toast.error('No se pudo enviar el correo. Copia el enlace y envíalo al comprador.');
        } else {
          setEnlaceManual(null);
          toast.success(`Email enviado a ${res.email}`);
        }
        startPolling();
      } else { toast.error(res.error || 'Error enviando email'); }
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setEmailSending(false); }
  };

  // C3: Siempre limpiar interval anterior antes de crear nuevo
  const stopPolling = () => { if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; } };
  const startPolling = () => {
    stopPolling();
    pollingRef.current = setInterval(async () => {
      if (!tramiteId) return;
      try {
        const res = await api.get<ValidacionEstadoResponse>(`/validacion-identidad/estado/${tramiteId}`);
        if (res.ok && res.validaciones && res.validaciones.length > 0) {
          const v = resolverValidacionVigentePorDocumento(res.validaciones, comprador.documento);
          if (!v) return;
          setValidationStatus(v);
          if (v.estado === 'aprobado' || v.estado === 'rechazado') {
            if (pollingRef.current) clearInterval(pollingRef.current);
            if (v.estado === 'aprobado') toast.success(`Identidad verificada — Score: ${v.score}`);
          }
        }
      } catch { /* silent */ }
    }, 5000);
  };

  useEffect(() => { return () => { if (pollingRef.current) clearInterval(pollingRef.current); }; }, []);

  // Si el comprador cambia de PERSONA (documento distinto), la validación previa
  // ya no aplica: limpiarla y dejar de pollear la del comprador anterior. Guarda
  // con ref para NO disparar al hidratar el trámite (primer valor) ni en RUNT
  // (que cambia nombre, no documento).
  const prevCompradorDocRef = useRef<string>('');
  useEffect(() => {
    const cur = normalizarDocumentoTraspaso(comprador.documento);
    if (prevCompradorDocRef.current && cur !== prevCompradorDocRef.current) {
      setValidationStatus(null);
      setEmailSent(false);
      stopPolling();
    }
    prevCompradorDocRef.current = cur;
  }, [comprador.documento]);

  // Abrir modal de organismo al entrar al paso 5 sin organismo — solo si no tiene nombre
  useEffect(() => { if (step === 5 && !orgTransito.nombre) setShowOrgModal(true); }, [step, orgTransito.nombre]);

  const consultarComprador = async () => {
    if (!comprador.documento.trim()) { toast.error('Ingresa el numero de documento'); return; }
    setCompradorLoading(true); setCompradorRunt(null);
    try {
      const res = await api.post<RuntPersonaResponse>('/runt/consulta-persona', {
        documento: comprador.documento.trim(),
      });
      if (res.ok && res.persona) {
        setCompradorRunt(res);
        const p = res.persona;
        const fullName = [p.nombres, p.apellidos].filter(Boolean).join(' ');
        if (fullName) setComprador((prev) => ({ ...prev, nombre: fullName }));
        toast.success(`${fullName || 'Persona'} encontrado en RUNT`);
      } else { toast.error(res.message || 'Persona no encontrada en el RUNT'); }
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setCompradorLoading(false); }
  };

  // TRAM-TIPO-01: consulta RUNT del vendedor (parte saliente), espejo del comprador.
  const consultarVendedor = async () => {
    if (!vendedor.documento.trim()) { toast.error('Ingresa el documento del vendedor'); return; }
    setVendedorLoading(true); setVendedorRunt(null);
    try {
      const res = await api.post<RuntPersonaResponse>('/runt/consulta-persona', { documento: vendedor.documento.trim() });
      if (res.ok && res.persona) {
        setVendedorRunt(res);
        const p = res.persona;
        const fullName = [p.nombres, p.apellidos].filter(Boolean).join(' ');
        if (fullName) setVendedor((prev) => ({ ...prev, nombre: fullName }));
        toast.success(`${fullName || 'Persona'} encontrado en RUNT`);
      } else { toast.error(res.message || 'Persona no encontrada en el RUNT'); }
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setVendedorLoading(false); }
  };

  const leerCedula = () => setCedulaOverlayOpen(true);

  const handleCedulaCaptured = (d: CedulaOcrData) => {
    const fullName = [d.firstName, d.secondName, d.lastName, d.secondLastName].filter(Boolean).join(' ');
    setComprador((prev) => ({
      ...prev,
      nombre: fullName || prev.nombre,
      documento: d.documentNumber || prev.documento,
      tipoDoc: d.documentType?.startsWith('cc') ? 'CC' : d.documentType === 'tarjeta_identidad' ? 'TI' : d.documentType === 'cedula_extranjeria' ? 'CE' : prev.tipoDoc,
    }));
  };

  const consultarVin = async () => {
    if (!vin.trim()) { toast.error('Ingresa un VIN'); return; }
    setVinLoading(true); setVehiculo(null); setRuntData(null);
    setPreflight(null); setRiesgoAceptado(false);
    try {
      const res = await api.post<RuntConsultaVehiculoResponse>('/runt/consulta-vehiculo', { vin: vin.trim() });
      if (res.ok && res.data) {
        setRuntData(res.data);
        const v: VehiculoData = res.data.vehiculo || {};
        setVehiculo(v);
        toast.success(`${v.marca || ''} ${v.linea || ''} — ${v.placa || 'Sin placa'}`);
        // A1: pre-vuelo automático tras consultar el VIN (una vez por VIN).
        const vinClean = vin.trim().toUpperCase();
        if (preflightVinRef.current !== vinClean) {
          preflightVinRef.current = vinClean;
          ejecutarPreflight(vinClean);
        }
      } else { toast.error(res.message || 'No encontrado en RUNT'); }
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setVinLoading(false); }
  };

  // C4: Crear y avanzar en un solo PATCH cuando ya existe
  const guardarPaso1 = async () => {
    if (!vehiculo) { toast.error('Consulta un VIN primero'); return; }
    // A1: si el pre-vuelo está en rojo, exigir confirmación explícita de riesgo.
    if (preflight?.overall === 'red' && !riesgoAceptado) {
      toast.error('El pre-vuelo está en rojo. Marca "Asumo el riesgo de rechazo" para continuar.');
      return;
    }
    try {
      const soat = runtData?.soat ? (Array.isArray(runtData.soat) ? runtData.soat[0] : runtData.soat) : null;
      const vehData = { ...vehiculo, soat, solicitudes: runtData?.solicitudes, tipoDocPropietario: runtData?.tipoDocPropietario, datosTecnicos: runtData?.datosTecnicos };
      const vinClean = vin.trim().toUpperCase();
      const placaVal = vehiculo.placa || vehiculo.noPlaca || '';

      if (tramiteId) {
        // Si el VIN cambió, es un trámite nuevo — limpiar datos de pasos anteriores
        const tramiteActual = await api.get<TramiteFull>(`/tramites/${tramiteId}`);
        const vinAnterior = (tramiteActual.vin || '').toUpperCase();
        if (vinAnterior && vinAnterior !== vinClean) {
          // VIN cambió — crear trámite nuevo en vez de editar el anterior
          const t = await api.post<TramiteCreatedResponse>('/tramites', { vin: vinClean, placa: placaVal, vehiculo: vehData });
          setTramiteId(t.id);
          await api.patch(`/tramites/${t.id}`, { paso: 2, tipologiaCodigo, checklistEstado });
          // Limpiar todos los datos de pasos siguientes
          setArchivos([]);
          setOcrResults({});
          setComprador(EMPTY_COMPRADOR);
          setCompradorRunt(null);
          setEmailSent(false);
          setValidationStatus(null);
          setOrgTransito(EMPTY_ORG);
          toast.success('Nuevo trámite creado para el vehículo');
        } else {
          await api.patch(`/tramites/${tramiteId}`, { vin: vinClean, placa: placaVal, vehiculo: vehData, paso: 2 });
          toast.success('Datos del vehículo actualizados');
        }
      } else {
        const t = await api.post<TramiteCreatedResponse>('/tramites', { vin: vinClean, placa: placaVal, vehiculo: vehData });
        setTramiteId(t.id);
        await api.patch(`/tramites/${t.id}`, { paso: 2, tipologiaCodigo, checklistEstado });
        toast.success('Datos del vehículo guardados');
      }
      setStep(2);
    } catch (err) {
      const conflict = parseTramiteConflict(err);
      if (conflict) {
        setDuplicateConflict(conflict);
        return;
      }
      toast.error(errorMessage(err));
    }
  };

  const subirDoc = async (tipo: string, fileOrig: File) => {
    let file: File = fileOrig;
    if (!tramiteId) return;
    if (bloqueadoPorEstado()) return;
    // Limpiar resultado OCR previo de este tipo al cargar uno nuevo
    setOcrResults((p) => { const n = { ...p }; delete n[tipo]; return n; });
    setUploading((p) => ({ ...p, [tipo]: true }));
    const token = localStorage.getItem('token');
    try {
      // OCR: analizar documento primero (solo para tipos con prompt)
      const ocrTipos = ['factura', 'aduana', 'impronta', 'soat'];
      if (ocrTipos.includes(tipo)) {
        toast.loading(`Analizando ${tipo}...`, { id: `ocr-${tipo}` });
        const ocrForm = new FormData();
        ocrForm.append('file', file);
        const ocrRes = await fetch(`/api/tramites/ocr/${tipo}`, {
          method: 'POST',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: ocrForm,
        });
        if (ocrRes.ok) {
          const ocrData = await ocrRes.json();
          if (ocrData.ok && ocrData.data) {
            const d = ocrData.data;

            // Validar que sea el tipo correcto de documento
            const esValido = d.es_factura_valida ?? d.es_valido ?? false;
            if (!esValido) {
              toast.error(`El documento cargado NO es una ${tipo} valida. Quedara marcado como rechazado.`, { id: `ocr-${tipo}`, duration: 6000 });
              d._rechazado = true;
              d._motivo = 'Tipo de documento incorrecto';
            }

            // Cruzar VIN: verificar que el documento corresponde al vehiculo del tramite
            if (!d._rechazado) {
              const vinTramite = vin.toUpperCase().replace(/[^A-Z0-9]/g, '');
              const vinDoc = (d.vehiculo_vin || d.vehiculo_chasis || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
              if (vinTramite && vinDoc && vinDoc !== vinTramite) {
                toast.error(`VIN no coincide: documento=${vinDoc}, tramite=${vinTramite}. Quedara marcado como rechazado.`, { id: `ocr-${tipo}`, duration: 8000 });
                d._rechazado = true;
                d._motivo = `VIN no coincide: documento=${vinDoc}, tramite=${vinTramite}`;
              }
            }

            // F2: Si se extrajeron paginas, descargar PDF recortado del servidor
            if (d._extracted_filename) {
              try {
                const extRes = await fetch(`/api/tramites/ocr-extracted/${d._extracted_filename}`, {
                  headers: token ? { Authorization: `Bearer ${token}` } : {},
                });
                if (extRes.ok) {
                  const blob = await extRes.blob();
                  file = new File([blob], `${tipo}_extraido.pdf`, { type: 'application/pdf' });
                }
              } catch { /* usar archivo original si falla */ }
            }
            setOcrResults((p) => ({ ...p, [tipo]: d }));
            toast.success(`${tipo} verificado${d._paginas_extraidas ? ` (${d.paginas_documento?.length} de ${d._paginas_originales} paginas extraidas)` : ''}`, { id: `ocr-${tipo}` });
          } else {
            toast.error(ocrData.message || 'No se pudo analizar el documento', { id: `ocr-${tipo}` });
            return; // NO subir si no se pudo analizar
          }
        } else {
          // F4: Si OCR HTTP falla, rechazar — no subir sin validar
          toast.error('Error analizando documento. Intenta de nuevo.', { id: `ocr-${tipo}` });
          return;
        }
      }
      // Subir archivo (solo si paso validaciones)
      const form = new FormData();
      form.append('file', file);
      form.append('tipo', tipo);
      const res = await fetch(`/api/tramites/${tramiteId}/documentos`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form,
      });
      if (!res.ok) throw new Error('Error subiendo archivo');
      const doc = await res.json();
      // C2: Reemplazar documento del mismo tipo en vez de acumular
      setArchivos((prev) => [...prev.filter((a) => a.tipo !== tipo), doc]);
      toast.success(`${tipo} cargado`);
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setUploading((p) => ({ ...p, [tipo]: false })); }
  };

  const guardarPaso2 = async () => {
    if (!tramiteId) return;
    if (bloqueadoPorEstado()) return;
    const required = DOC_TYPES.filter((d) => d.required).map((d) => d.key);
    const missing = required.filter((key) => !archivos.some((a) => a.tipo === key));
    if (missing.length > 0) {
      const labels = missing.map((k) => DOC_TYPES.find((d) => d.key === k)?.label || k);
      toast.error(`Faltan documentos obligatorios: ${labels.join(', ')}`);
      return;
    }
    try {
      await api.patch(`/tramites/${tramiteId}`, { paso: 3 });
      setStep(3);
    } catch (err) { toast.error(errorMessage(err)); }
  };

  const guardarPaso3 = async () => {
    if (!tramiteId) return;
    if (bloqueadoPorEstado()) return;
    if (!comprador.nombre || !comprador.documento) { toast.error('Nombre y documento son obligatorios'); return; }
    // TRAM-TIPO-01: journey diferenciado — traspaso_standard exige al vendedor.
    const exigeVendedor = vendedorRequerido(tipologiaCodigo);
    if (exigeVendedor && (!vendedor.nombre.trim() || !vendedor.documento.trim())) {
      toast.error('Esta tipología exige los datos del vendedor (titular saliente).');
      return;
    }
    try {
      // Persistir vendedor en el JSONB del vehículo (patrón `_orgTransito`).
      const patch: Record<string, unknown> = { comprador, paso: 4 };
      if (exigeVendedor) patch.vehiculo = { ...(vehiculo || {}), _vendedor: vendedor };
      await api.patch(`/tramites/${tramiteId}`, patch);
      // Refrescar el pre-vuelo con el vendedor (comparendos/LAFT) — best-effort.
      if (exigeVendedor) ejecutarPreflight();
      setStep(4);
      toast.success('Datos de las partes guardados');
    } catch (err) { toast.error(errorMessage(err)); }
  };

  const reenviarValidacion = () => { stopPolling(); setEmailSent(false); setValidationStatus(null); };

  const cerrarConflictoDuplicado = () => setDuplicateConflict(null);

  const abrirTramiteExistente = async () => {
    if (!duplicateConflict) return;
    const id = duplicateConflict.existingTramite.id;
    setDuplicateConflict(null);
    try {
      const t = await api.get<TramiteFull>(`/tramites/${id}`);
      await continuarTramite(t);
    } catch (err) { toast.error(errorMessage(err)); }
  };

  const abrirNuevo = () => {
    setDuplicateConflict(null);
    setWizardOpen(true); setStep(1); setTramiteId(null); setEstadoTramite('borrador');
    setVin(''); setVehiculo(null); setRuntData(null);
    setPreflight(null); setRiesgoAceptado(false); preflightVinRef.current = null;
    setTipologiaCodigo(null); setChecklistEstado({});
    setArchivos([]); setComprador(EMPTY_COMPRADOR);
    setVendedor(EMPTY_VENDEDOR); setVendedorRunt(null);
    setOcrResults({});
    setCompradorRunt(null);
    setEmailSent(false);
    setValidationStatus(null);
    setOrgTransito(EMPTY_ORG);
  };

  const continuarTramite = async (t: TramiteFull) => {
    // F8: Limpiar polling previo
    if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
    let full = t;
    try {
      full = await api.get<TramiteFull>(`/tramites/${t.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
      return;
    }
    setTramiteId(full.id);
    setEstadoTramite(full.estado || 'borrador');
    setVin(full.vin || '');
    setVehiculo(full.vehiculo || null);
    setRuntData(full.vehiculo ? { vehiculo: full.vehiculo } : null);
    setTipologiaCodigo(full.tipologiaCodigo ?? null);
    setChecklistEstado(full.checklistEstado || {});
    setPreflight(null); setRiesgoAceptado(false); preflightVinRef.current = (full.vin || '').toUpperCase() || null;
    try { const pf = await api.get<{ preflight: PreflightSnapshot | null }>(`/tramites/${full.id}/preflight`); if (pf.preflight) setPreflight(pf.preflight); } catch { /* sin pre-vuelo previo */ }
    setComprador(full.comprador || EMPTY_COMPRADOR);
    // TRAM-TIPO-01: restaurar vendedor persistido en el JSONB del vehículo.
    setVendedor(full.vehiculo?._vendedor || EMPTY_VENDEDOR);
    setVendedorRunt(null);
    // Restaurar organismo de tránsito si fue guardado
    if (full.vehiculo?._orgTransito?.nombre) {
      setOrgTransito(full.vehiculo._orgTransito);
    } else {
      setOrgTransito(EMPTY_ORG);
    }
    setStep(full.paso || 1);
    // F7: Restaurar estado de validacion al retomar
    setEmailSent(false);
    setValidationStatus(null);
    if (full.paso >= 4) {
      try {
        const vRes = await api.get<ValidacionEstadoResponse>(`/validacion-identidad/estado/${full.id}`);
        if (vRes.ok && vRes.validaciones && vRes.validaciones.length > 0) {
          // FIX: antes leía [length-1] = la fila MÁS VIEJA (endpoint ordena DESC id),
          // mostrando la validación de un comprador anterior / invalidada al retomar.
          const last = resolverValidacionVigentePorDocumento(vRes.validaciones, full.comprador?.documento);
          if (last) setValidationStatus(last);
          // Solo pollear si el trámite sigue en fase de identidad. En estados
          // avanzados (ya enviado a tránsito) una fila 'enviado' colgada haría
          // polling perpetuo sin sentido.
          const faseIdentidad = ['borrador', 'documentos', 'identidad', 'aprobado'].includes(full.estado || '');
          if (last && faseIdentidad && (last.estado === 'enviado' || last.estado === 'en_proceso')) {
            setEmailSent(true);
            startPolling();
          }
        }
      } catch { /* sin validacion previa */ }
    }
    try { const docs = await api.get<ArchivoData[]>(`/tramites/${full.id}/documentos`); setArchivos(docs); } catch { setArchivos([]); }
    setWizardOpen(true);
  };

  // Cierre del wizard (vuelve a la lista + refresca).
  const closeWizard = () => { setWizardOpen(false); onClose(); };

  // Persistir organismo elegido en el trámite (no se pierde al recargar).
  const confirmarOrg = () => {
    if (!orgTransito.nombre) { toast.error('Seleccione un organismo de tránsito'); return; }
    setShowOrgModal(false);
    if (tramiteId) {
      api.patch(`/tramites/${tramiteId}`, { vehiculo: { ...vehiculo, _orgTransito: orgTransito } }).catch(() => {});
    }
  };

  // Step 5: guardar como borrador.
  const guardarBorrador = async () => {
    try {
      if (tramiteId) await api.patch(`/tramites/${tramiteId}`, { estado: 'borrador', paso: 5 });
      toast.success('Guardado como borrador');
      closeWizard();
    } catch (err) { toast.error(errorMessage(err)); }
  };

  // TRAM-PRE-01: navegar a un paso desde CTAs del pre-vuelo (ej. Subir SOAT → paso 2).
  const irAPaso = (targetStep: number) => {
    if (targetStep === 2 && !tramiteId) {
      toast('Guarda el paso 1 con «Guardar y continuar» para subir el SOAT en Documentos.', { icon: 'ℹ️' });
      return;
    }
    if (targetStep >= 1 && targetStep <= 5) setStep(targetStep);
  };

  // Step 5: enviar a tránsito (gate `todoListo` se valida en el componente).
  const enviarATransito = async (todoListo: boolean) => {
    if (!todoListo) {
      toast.error('Todos los documentos deben estar validados y la identidad aprobada para enviar a transito');
      return;
    }
    try {
      if (tramiteId) await api.patch(`/tramites/${tramiteId}`, { estado: 'enviado_transito', paso: 5 });
      setEstadoTramite('enviado_transito');
      toast.success('Tramite enviado a tránsito');
      closeWizard();
    } catch (err) { toast.error(errorMessage(err)); }
  };

  return {
    // navegación / estado base
    wizardOpen, step, setStep, tramiteId, estadoTramite,
    // step 1
    vin, setVin, vinLoading, vehiculo, runtData, preflight, preflightLoading,
    riesgoAceptado, setRiesgoAceptado, tipologiaCodigo, checklistEstado,
    consultarVin, ejecutarPreflight, irAPaso, registrarPreflightCta, cambiarTipologia, toggleChecklistItem, guardarPaso1,
    // step 2
    archivos, uploading, ocrResults, setOcrResults, subirDoc, guardarPaso2,
    // step 3
    comprador, setComprador, compradorLoading, compradorRunt, consultarComprador,
    vendedor, setVendedor, vendedorLoading, vendedorRunt, consultarVendedor,
    leerCedula, cedulaOverlayOpen, setCedulaOverlayOpen, handleCedulaCaptured,
    showCiudades, setShowCiudades, setCiudadFilter, filteredCiudades, guardarPaso3,
    // step 4
    enlaceManual, emailSent, emailSending, validationStatus, enviarEmailValidacion,
    reenviarValidacion, stopPolling,
    // step 5 / organismo
    showOrgModal, setShowOrgModal, orgTransito, setOrgTransito, confirmarOrg,
    guardarBorrador, enviarATransito,
    // apertura / cierre
    abrirNuevo, continuarTramite, closeWizard,
    duplicateConflict, cerrarConflictoDuplicado, abrirTramiteExistente,
  };
}

export type TramiteWizardApi = ReturnType<typeof useTramiteWizard>;
