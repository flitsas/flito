// Certificar un impuesto ante el RUNT sin trámite. La factura se carga aquí.
// El certificado se genera al descargar y no se archiva.
import { useCallback, useEffect, useState } from 'react';
import { CAMPO_COMPARACION_FACTURA_RUNT_LABEL, type ComparacionCampoFacturaRunt } from '@operaciones/shared-types';
import CertificarEditor, { type Borrador, type Catalogo, type CampoLeido } from './FlitoImpuestosCertificarEditor';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import { BarraAccion } from '../components/flit/Bloques';
import GradientButton from '../components/flit/GradientButton';
import InlineAlert from '../components/flit/InlineAlert';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import { FlitCard } from '../components/flit/flitPageKit';
import { AvisoCertificadosZip, DescargarCertificadosZip } from '../components/flito/DescargarCertificadosZip';
import { useDescargaCertificadosDirecta } from '../components/flito/DescargarCertificadosCertificacionDirecta';
import { api, errorMessage } from '../lib/api';

const BASE = '/flito/impuestos/certificacion-directa';

type Estado = 'radicado' | 'sin_respuesta' | 'sin_vehiculo' | 'sin_coincidencia' | 'certificado';

interface Fila {
  id: string;
  organismoCodigo: string;
  organismoNombre: string;
  /** Opcional desde la HU #14665: la consulta RUNT ya no depende de la placa, solo del VIN. */
  placa: string | null;
  tipoDocumentoPropietario: string | null;
  documentoPropietario: string | null;
  nombrePropietario: string | null;
  vin: string;
  marca: string;
  linea: string;
  anio: string;
  color: string;
  cilindrada: string;
  estado: Estado;
  comparacion: ComparacionCampoFacturaRunt[] | null;
  certificadoEn: string | null;
  createdAt: string;
}

const VACIO: Borrador = {
  organismoCodigo: '', placa: '', tipoDocumentoPropietario: '', documentoPropietario: '', nombrePropietario: '',
  vin: '', marca: '', linea: '', anio: '', color: '', cilindrada: '',
};

const ESTADO: Record<Estado, { texto: string; tono: ChipTone; aviso: string }> = {
  radicado: { texto: 'Guardado', tono: 'draft', aviso: 'El registro quedó guardado. Consulta el RUNT cuando quieras.' },
  sin_respuesta: { texto: 'Sin respuesta', tono: 'warning', aviso: 'El RUNT no respondió. El registro quedó guardado. Puedes consultar de nuevo.' },
  sin_vehiculo: { texto: 'Sin vehículo', tono: 'warning', aviso: 'El RUNT no tiene registro de este VIN.' },
  sin_coincidencia: { texto: 'No coincide', tono: 'danger', aviso: 'Los datos no coinciden con el RUNT. Corrige y vuelve a consultar.' },
  certificado: { texto: 'Certificado', tono: 'success', aviso: 'Los datos coincidieron. Puedes descargar el certificado.' },
};

// Resultados de consulta que dejan algo por hacer: su aviso reaparece al reabrir el registro.
const CON_AVISO_AL_ABRIR = new Set<Estado>(['sin_respuesta', 'sin_vehiculo', 'sin_coincidencia']);

const INFORMATIVO = new Set<string>([
  ...Object.values(ESTADO).map((e) => e.aviso),
  'No se pudo leer la factura. Completa los datos del vehículo.',
  'Leímos la factura. Revisa los datos antes de guardar.',
  'Certificación eliminada.',
]);

const RESULTADO: Record<ComparacionCampoFacturaRunt['resultado'], string> = {
  coincide: 'Coincide',
  difiere: 'Difiere',
  no_verificable: 'No reportado por el RUNT',
};

function avisoDe(e: unknown): string {
  return errorMessage(e);
}

function desdeFila(f: Fila): Borrador {
  return {
    organismoCodigo: f.organismoCodigo, placa: f.placa ?? '',
    tipoDocumentoPropietario: f.tipoDocumentoPropietario ?? '',
    documentoPropietario: f.documentoPropietario ?? '', nombrePropietario: f.nombrePropietario ?? '',
    vin: f.vin, marca: f.marca, linea: f.linea, anio: f.anio, color: f.color, cilindrada: f.cilindrada,
  };
}

function camposDe(b: Borrador): Record<string, string> {
  return { ...b };
}

const COLUMNAS_COMPARACION: ColumnaTabla<ComparacionCampoFacturaRunt>[] = [
  { key: 'dato', header: 'Dato', render: (c) => CAMPO_COMPARACION_FACTURA_RUNT_LABEL[c.campo] },
  { key: 'factura', header: 'Factura', render: (c) => c.valorFactura ?? '—' },
  { key: 'runt', header: 'RUNT', render: (c) => c.valorRunt ?? '—' },
  { key: 'resultado', header: 'Resultado', render: (c) => RESULTADO[c.resultado] },
];

export default function FlitoImpuestosCertificar() {
  const [vista, setVista] = useState<'lista' | 'alta' | 'detalle'>('lista');
  const [filas, setFilas] = useState<Fila[] | null>(null);
  const [errorLista, setErrorLista] = useState<string | null>(null);
  const [fila, setFila] = useState<Fila | null>(null);
  const [catalogo, setCatalogo] = useState<Catalogo | null>(null);
  const [borrador, setBorrador] = useState<Borrador>(VACIO);
  const [pdf, setPdf] = useState<File | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [leyendo, setLeyendo] = useState(false);
  const [fallaLectura, setFallaLectura] = useState<string | null>(null);
  const [leidos, setLeidos] = useState<Partial<Record<CampoLeido, string>>>({});
  const [versionFactura, setVersionFactura] = useState(0);
  const [leidosN, setLeidosN] = useState<number | null>(null);
  // Selección y acciones en lote (HU #14665, AC6-AC8): solo existen en la vista de lista.
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
  const [eliminandoId, setEliminandoId] = useState<string | null>(null);
  const [eliminandoLote, setEliminandoLote] = useState(false);
  const [avisoLote, setAvisoLote] = useState<{ tono: 'info' | 'danger'; texto: string } | null>(null);
  // El hook se llama SIEMPRE (regla de los hooks); la barra decide si la acción existe.
  const descargaCert = useDescargaCertificadosDirecta();

  const cargarLista = useCallback(async () => {
    setErrorLista(null);
    setFilas(null);
    try {
      setFilas(await api.get<Fila[]>(BASE));
    } catch (e) {
      setFilas([]);
      setErrorLista(avisoDe(e));
    }
  }, []);

  useEffect(() => { void cargarLista(); }, [cargarLista]);

  /** La placa de una fila seleccionada, o su VIN si no tiene (muchos registros aquí no tienen placa). */
  const placaDe = useCallback((id: string): string | null => {
    const f = filas?.find((x) => x.id === id);
    return f?.placa || f?.vin || null;
  }, [filas]);

  async function eliminar(f: Fila) {
    if (!window.confirm(`¿Eliminar la certificación de ${f.placa || f.vin}? Esta acción no se puede deshacer.`)) return;
    setEliminandoId(f.id);
    try {
      await api.delete(`${BASE}/${f.id}`);
      setSeleccion((s) => {
        if (!s.has(f.id)) return s;
        const n = new Set(s);
        n.delete(f.id);
        return n;
      });
      if (vista === 'detalle' && fila?.id === f.id) { setVista('lista'); setFila(null); }
      setAviso('Certificación eliminada.');
      void cargarLista();
    } catch (e) {
      setAviso(avisoDe(e));
    } finally {
      setEliminandoId(null);
    }
  }

  async function eliminarLote() {
    const ids = [...seleccion];
    if (ids.length === 0) return;
    if (!window.confirm(`¿Eliminar ${ids.length} certificaciones seleccionadas? Las que ya estén certificadas no se eliminarán. Esta acción no se puede deshacer.`)) return;
    setEliminandoLote(true);
    setAvisoLote(null);
    try {
      const r = await api.post<{ eliminados: string[]; omitidos: string[] }>(`${BASE}/eliminar-lote`, { ids });
      setSeleccion(new Set());
      void cargarLista();
      const sustantivo = (n: number) => (n === 1 ? 'registro' : 'registros');
      setAvisoLote({
        tono: 'info',
        texto: r.omitidos.length === 0
          ? `Se eliminaron ${r.eliminados.length} ${sustantivo(r.eliminados.length)}.`
          : `Se eliminaron ${r.eliminados.length} ${sustantivo(r.eliminados.length)}. ${r.omitidos.length} ya estaban certificados o ya no existían y no se eliminaron.`,
      });
    } catch (e) {
      setAvisoLote({ tono: 'danger', texto: avisoDe(e) });
    } finally {
      setEliminandoLote(false);
    }
  }

  async function abrirAlta() {
    // «Volver al listado» conserva la fila: heredada, un certificado dejaría el alta en solo lectura.
    setFila(null);
    setAviso(null);
    setPdf(null);
    setFallaLectura(null);
    setLeidos({});
    setLeidosN(null);
    setBorrador(VACIO);
    setVista('alta');
    if (!catalogo) {
      try { setCatalogo(await api.get<Catalogo>(`${BASE}/catalogo`)); }
      catch (e) { setAviso(avisoDe(e)); }
    }
  }

  function abrirDetalle(f: Fila) {
    setFila(f);
    setBorrador(desdeFila(f));
    setPdf(null);
    setFallaLectura(null);
    setLeidos({});
    setLeidosN(null);
    setAviso(CON_AVISO_AL_ABRIR.has(f.estado) ? ESTADO[f.estado].aviso : null);
    setVista('detalle');
    if (!catalogo) {
      void api.get<Catalogo>(`${BASE}/catalogo`).then(setCatalogo).catch((e) => setAviso(avisoDe(e)));
    }
  }

  // Lectura automática al elegir el PDF. Solo rellena campos que siguen vacíos: lo que el gestor
  // ya escribió a mano no se pisa. Si falla o viene parcial, el formulario sigue disponible.
  async function leerFactura(archivo: File) {
    setLeyendo(true);
    setAviso(null);
    setFallaLectura(null);
    setLeidosN(null);
    try {
      const s = await api.upload<{
        vin: string; marca: string; linea: string; anio: string; color: string; cilindrada: string;
        tipoDocumentoPropietario: string; documentoPropietario: string; nombrePropietario: string;
        aviso: string | null;
      }>(`${BASE}/extraer`, archivo, 'factura');
      setBorrador((b) => ({
        ...b,
        vin: b.vin || s.vin, marca: b.marca || s.marca, linea: b.linea || s.linea,
        anio: b.anio || s.anio, color: b.color || s.color, cilindrada: b.cilindrada || s.cilindrada,
        // Datos del propietario (HU #14665): mismo criterio, solo si el formulario sigue vacío.
        // `|| ''` de respaldo: una respuesta sin estos campos (mock viejo, OCR parcial) no debe
        // dejar el borrador con `undefined` en un campo que es `string`.
        tipoDocumentoPropietario: b.tipoDocumentoPropietario || s.tipoDocumentoPropietario || '',
        documentoPropietario: b.documentoPropietario || s.documentoPropietario || '',
        nombrePropietario: b.nombrePropietario || s.nombrePropietario || '',
      }));
      const vals = { vin: s.vin, marca: s.marca, linea: s.linea, anio: s.anio, color: s.color, cilindrada: s.cilindrada };
      setLeidos(vals);
      setLeidosN(Object.values(vals).filter(Boolean).length);
      const faltan = ([['VIN', s.vin], ['marca', s.marca], ['línea', s.linea], ['año', s.anio], ['color', s.color], ['cilindraje', s.cilindrada]] as const)
        .filter(([, v]) => !v).map(([n]) => n);
      if (faltan.length === 6) setFallaLectura('No pudimos leer datos de esta factura. Completa el formulario a mano o reintenta la lectura.');
      else if (faltan.length) setFallaLectura(`No pudimos leer: ${faltan.join(', ')}. Complétalos a mano o reintenta la lectura.`);
      else setAviso('Leímos la factura. Revisa los datos antes de guardar.');
    } catch {
      setFallaLectura('No pudimos leer la factura. Completa los datos del vehículo o reintenta la lectura.');
    } finally { setLeyendo(false); }
  }

  function elegirPdf(archivo: File | null) {
    setPdf(archivo);
    if (archivo && vista === 'alta') void leerFactura(archivo);
  }

  async function persistir(esNuevo: boolean): Promise<Fila | null> {
    if (esNuevo && !pdf) { setAviso('Falta la factura de venta.'); return null; }
    if (!/^\d{4}$/.test(borrador.anio)) { setAviso('El año debe tener cuatro dígitos.'); return null; }
    const guardada = esNuevo
      ? await api.upload<Fila>(BASE, pdf!, 'factura', camposDe(borrador))
      : await api.patchForm<Fila>(`${BASE}/${fila!.id}`, camposDe(borrador), pdf, 'factura');
    setFila(guardada);
    setBorrador(desdeFila(guardada));
    setVista('detalle');
    if (pdf) setVersionFactura((n) => n + 1);
    setPdf(null);
    return guardada;
  }

  async function guardar(esNuevo: boolean) {
    setOcupado(true);
    setAviso(null);
    try {
      const guardada = await persistir(esNuevo);
      if (!guardada) return;
      setAviso(ESTADO[guardada.estado].aviso);
      void cargarLista();
    } catch (e) { setAviso(avisoDe(e)); }
    finally { setOcupado(false); }
  }

  async function consultar() {
    if (!fila) return;
    setOcupado(true);
    setAviso(null);
    try {
      const sucio = pdf != null || JSON.stringify(borrador) !== JSON.stringify(desdeFila(fila));
      const base = sucio ? await persistir(false) : fila;
      if (!base) return;
      const actual = await api.post<Fila>(`${BASE}/${base.id}/consultar`);
      setFila(actual);
      setBorrador(desdeFila(actual));
      setAviso(ESTADO[actual.estado].aviso);
      void cargarLista();
    } catch (e) { setAviso(avisoDe(e)); }
    finally { setOcupado(false); }
  }

  async function bajar(cual: 'certificado') {
    if (!fila) return;
    setAviso(null);
    try {
      await api.download(`${BASE}/${fila.id}/${cual}`, `${cual}-${fila.placa || fila.vin}.pdf`);
    } catch (e) { setAviso(avisoDe(e)); }
  }

  const certificado = fila?.estado === 'certificado';

  const columnasLista: ColumnaTabla<Fila>[] = [
    { key: 'placa', header: 'Placa', render: (f) => f.placa || '—' },
    { key: 'vin', header: 'VIN', render: (f) => <span className="break-all">{f.vin}</span> },
    { key: 'propietario', header: 'Propietario', render: (f) => f.nombrePropietario || '—' },
    { key: 'estado', header: 'Estado', render: (f) => <StatusChip tone={ESTADO[f.estado].tono}>{ESTADO[f.estado].texto}</StatusChip> },
    {
      key: 'acciones', header: 'Acciones', acciones: true,
      render: (f) => (
        <div className="flex items-center justify-end gap-2 whitespace-nowrap">
          {/* AC6: lo certificado no se puede eliminar, así que la acción ni se ofrece. */}
          {f.estado !== 'certificado' && (
            <GradientButton variant="alerta" size="sm" disabled={eliminandoId === f.id} onClick={() => void eliminar(f)}>
              {eliminandoId === f.id ? 'Eliminando…' : 'Eliminar'}
            </GradientButton>
          )}
          <GradientButton variant="secondary" size="sm" onClick={() => abrirDetalle(f)}>Abrir</GradientButton>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* Sección dentro del shell de Impuestos: la h1 es la cabecera del módulo; aquí va una h2. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-72">
          <h2 className="m-0 text-xl font-bold text-[color:var(--color-text-primary)]">Certificar sin trámite</h2>
          <p className="mt-1 text-sm text-[color:var(--color-text-secondary)]">
            Carga la factura de venta, completa los datos y consulta el RUNT. Quien tiene el permiso ve los registros de esta pantalla.
          </p>
        </div>
        {vista === 'lista' ? (
          <GradientButton onClick={() => void abrirAlta()}>
            Nueva certificación
          </GradientButton>
        ) : (
          <GradientButton variant="secondary" onClick={() => { setVista('lista'); setAviso(null); }}>
            Volver al listado
          </GradientButton>
        )}
      </div>

      {aviso && (
        <InlineAlert tono={INFORMATIVO.has(aviso) ? 'info' : 'danger'}>{aviso}</InlineAlert>
      )}

      {vista === 'lista' && (
        <>
          {/* HU #14665 (AC7/AC8): barra de selección, igual patrón que la cola de Impuestos. */}
          {seleccion.size > 0 && (
            <BarraAccion accion={(
              <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                <GradientButton
                  variant="alerta" className="w-full justify-center sm:w-auto"
                  disabled={eliminandoLote} onClick={() => void eliminarLote()}
                >
                  {eliminandoLote ? 'Eliminando…' : `Eliminar seleccionados (${seleccion.size})`}
                </GradientButton>
                <DescargarCertificadosZip
                  ids={[...seleccion]}
                  ocupado={descargaCert.ocupado}
                  onDescargar={(ids) => descargaCert.descargar(ids, placaDe)}
                  llenaEnMovil
                />
              </div>
            )}>
              <strong>{seleccion.size} seleccionado(s)</strong>
            </BarraAccion>
          )}
          {avisoLote && <InlineAlert tono={avisoLote.tono}>{avisoLote.texto}</InlineAlert>}
          <AvisoCertificadosZip
            ocupado={descargaCert.ocupado}
            marcadas={descargaCert.marcadas}
            aviso={descargaCert.aviso}
            onReintentar={descargaCert.reintentar}
            onDescartar={descargaCert.descartar}
          />
          <DataTable
            ariaLabel="Certificaciones sin trámite"
            columnas={columnasLista}
            filas={filas ?? []}
            getKey={(f) => f.id}
            status={errorLista ? 'error' : filas === null ? 'loading' : 'ready'}
            errorMessage={errorLista ?? undefined}
            onRetry={() => void cargarLista()}
            emptyMessage="Todavía no hay certificaciones. Carga una factura de venta para empezar."
            seleccion={{
              seleccionados: seleccion,
              onCambio: setSeleccion,
              etiquetaFila: (id) => `Seleccionar certificación ${placaDe(id) ?? ''}`.trim(),
            }}
          />
        </>
      )}

      {vista !== 'lista' && (
        <CertificarEditor
          vista={vista}
          borrador={borrador}
          onBorrador={setBorrador}
          catalogo={catalogo}
          pdf={pdf}
          onPdf={elegirPdf}
          leyendo={leyendo}
          leidos={leidos}
          leidosN={leidosN}
          fallaLectura={fallaLectura}
          onReintentar={() => pdf && void leerFactura(pdf)}
          certificado={certificado}
          ocupado={ocupado}
          dirty={vista === 'detalle' && fila != null && (pdf != null || JSON.stringify(borrador) !== JSON.stringify(desdeFila(fila)))}
          onSubmit={() => void guardar(vista === 'alta')}
          onConsultar={() => void consultar()}
          cargarFactura={fila ? () => api.get<Blob>(`${BASE}/${fila.id}/factura`) : undefined}
          claveFactura={fila ? `${fila.id}:${versionFactura}` : undefined}
          debajo={vista === 'detalle' && fila ? (
            <FlitCard>
              <div className="flex flex-col gap-3">
                <div><StatusChip tone={ESTADO[fila.estado].tono}>{ESTADO[fila.estado].texto}</StatusChip></div>
                {certificado && (
                  <div>
                    <GradientButton onClick={() => void bajar('certificado')}>
                      Descargar certificado
                    </GradientButton>
                  </div>
                )}
                {/* AC6: lo certificado no se puede eliminar, así que el botón ni se ofrece. */}
                {!certificado && (
                  <div>
                    <GradientButton variant="alerta" disabled={eliminandoId === fila.id} onClick={() => void eliminar(fila)}>
                      {eliminandoId === fila.id ? 'Eliminando…' : 'Eliminar'}
                    </GradientButton>
                  </div>
                )}
                {fila.comparacion && fila.comparacion.length > 0 && (
                  <section aria-label="Comparación con el RUNT">
                    <DataTable
                      ariaLabel="Comparación con el RUNT"
                      columnas={COLUMNAS_COMPARACION}
                      filas={fila.comparacion}
                      getKey={(c) => c.campo}
                    />
                  </section>
                )}
              </div>
            </FlitCard>
          ) : undefined}
        />
      )}
    </div>
  );
}
