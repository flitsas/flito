// Certificar un impuesto ante el RUNT sin trámite. La factura se carga aquí.
// El certificado se genera al descargar y no se archiva.
import { useCallback, useEffect, useState } from 'react';
import { CAMPO_COMPARACION_FACTURA_RUNT_LABEL, type ComparacionCampoFacturaRunt } from '@operaciones/shared-types';
import PageContentSkeleton from '../components/flit/PageContentSkeleton';
import CertificarEditor, { type Borrador, type Catalogo, type CampoLeido } from './FlitoImpuestosCertificarEditor';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import {
  FlitCard, FlitEmpty, FlitTable, FlitTh, FlitTr,
  flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary,
} from '../components/flit/flitPageKit';
import { api, errorMessage } from '../lib/api';

const BASE = '/flito/impuestos/certificacion-directa';

type Estado = 'radicado' | 'sin_respuesta' | 'sin_vehiculo' | 'sin_coincidencia' | 'certificado';

interface Fila {
  id: string;
  organismoCodigo: string;
  organismoNombre: string;
  placa: string;
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
  organismoCodigo: '', placa: '', documentoPropietario: '', nombrePropietario: '',
  vin: '', marca: '', linea: '', anio: '', color: '', cilindrada: '',
};

const ESTADO: Record<Estado, { texto: string; tono: ChipTone; aviso: string }> = {
  radicado: { texto: 'Guardado', tono: 'draft', aviso: 'El registro quedó guardado. Consulta el RUNT cuando quieras.' },
  sin_respuesta: { texto: 'Sin respuesta', tono: 'warning', aviso: 'El RUNT no respondió. El registro quedó guardado. Puedes consultar de nuevo.' },
  sin_vehiculo: { texto: 'Sin vehículo', tono: 'warning', aviso: 'El RUNT no tiene registro de este VIN.' },
  sin_coincidencia: { texto: 'No coincide', tono: 'danger', aviso: 'Los datos no coinciden con el RUNT. Corrige y vuelve a consultar.' },
  certificado: { texto: 'Certificado', tono: 'success', aviso: 'Los datos coincidieron. Puedes descargar el certificado.' },
};

// Consulta por placa y documento: el aviso nombra esa modalidad y la salida de consultar por VIN.
const AVISO_CON_DOCUMENTO: Partial<Record<Estado, string>> = {
  sin_respuesta: 'El RUNT no respondió. El registro quedó guardado. Puedes consultar de nuevo o borrar el documento para consultar por VIN.',
  sin_vehiculo: 'El RUNT no encontró el vehículo con esa placa y ese documento. Corrige el documento o bórralo para consultar por VIN.',
};

/** Editar devuelve el registro a `radicado`: el documento de la fila es el de su última consulta. */
function avisoDeEstado(f: Fila): string {
  return (f.documentoPropietario && AVISO_CON_DOCUMENTO[f.estado]) || ESTADO[f.estado].aviso;
}

const INFORMATIVO = new Set<string>([
  ...Object.values(ESTADO).map((e) => e.aviso),
  ...Object.values(AVISO_CON_DOCUMENTO),
  'No se pudo leer la factura. Completa los datos del vehículo.',
  'Leímos la factura. Revisa los datos antes de guardar.',
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
    organismoCodigo: f.organismoCodigo, placa: f.placa,
    documentoPropietario: f.documentoPropietario ?? '', nombrePropietario: f.nombrePropietario ?? '',
    vin: f.vin, marca: f.marca, linea: f.linea, anio: f.anio, color: f.color, cilindrada: f.cilindrada,
  };
}

function camposDe(b: Borrador): Record<string, string> {
  return { ...b };
}

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

  async function abrirAlta() {
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
    setAviso(null);
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
      const s = await api.upload<{ vin: string; marca: string; linea: string; anio: string; color: string; cilindrada: string; aviso: string | null }>(
        `${BASE}/extraer`, archivo, 'factura',
      );
      setBorrador((b) => ({
        ...b,
        vin: b.vin || s.vin, marca: b.marca || s.marca, linea: b.linea || s.linea,
        anio: b.anio || s.anio, color: b.color || s.color, cilindrada: b.cilindrada || s.cilindrada,
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
      setAviso(avisoDeEstado(guardada));
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
      setAviso(avisoDeEstado(actual));
      void cargarLista();
    } catch (e) { setAviso(avisoDe(e)); }
    finally { setOcupado(false); }
  }

  async function bajar(cual: 'certificado') {
    if (!fila) return;
    setAviso(null);
    try {
      await api.download(`${BASE}/${fila.id}/${cual}`, `${cual}-${fila.placa}.pdf`);
    } catch (e) { setAviso(avisoDe(e)); }
  }

  const certificado = fila?.estado === 'certificado';

  return (
    <div className="flex flex-col gap-4">
      <PageHeaderCard
        title="Certificar sin trámite"
        subtitle="Carga la factura de venta, completa los datos y consulta el RUNT. Quien tiene el permiso ve los registros de esta pantalla."
        actions={vista === 'lista' ? (
          <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={() => void abrirAlta()}>
            Nueva certificación
          </button>
        ) : (
          <button type="button" className={flitBtnSecondary} onClick={() => { setVista('lista'); setAviso(null); }}>
            Volver al listado
          </button>
        )}
      />

      {aviso && (
        <p role={INFORMATIVO.has(aviso) ? 'status' : 'alert'} className="rounded-lg px-4 py-3 text-sm" style={{ color: INFORMATIVO.has(aviso) ? 'var(--flit-text-primary)' : 'var(--flit-danger-ink)', border: '1px solid var(--flit-border-soft)' }}>
          {aviso}
        </p>
      )}

      {vista === 'lista' && (
        errorLista ? (
          <FlitCard>
            <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>{errorLista}</p>
            <button type="button" className={`${flitBtnSecondary} mt-3`} onClick={() => void cargarLista()}>Reintentar</button>
          </FlitCard>
        ) : filas === null ? <PageContentSkeleton /> : filas.length === 0 ? (
          <FlitEmpty>Todavía no hay certificaciones. Carga una factura de venta para empezar.</FlitEmpty>
        ) : (
          <FlitTable label="Certificaciones sin trámite">
            <thead>
              <tr>
                <FlitTh>Placa</FlitTh>
                <FlitTh>VIN</FlitTh>
                <FlitTh>Propietario</FlitTh>
                <FlitTh>Estado</FlitTh>
                <FlitTh />
              </tr>
            </thead>
            <tbody>
              {filas.map((f) => (
                <FlitTr key={f.id}>
                  <td className="px-4 py-2 text-sm">{f.placa}</td>
                  <td className="px-4 py-2 text-sm">{f.vin}</td>
                  <td className="px-4 py-2 text-sm">{f.nombrePropietario || '—'}</td>
                  <td className="px-4 py-2 text-sm"><StatusChip tone={ESTADO[f.estado].tono}>{ESTADO[f.estado].texto}</StatusChip></td>
                  <td className="px-4 py-2 text-sm">
                    <button type="button" className={flitBtnSecondary} onClick={() => abrirDetalle(f)}>Abrir</button>
                  </td>
                </FlitTr>
              ))}
            </tbody>
          </FlitTable>
        )
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
                <StatusChip tone={ESTADO[fila.estado].tono}>{ESTADO[fila.estado].texto}</StatusChip>
                {certificado && (
                  <div>
                    <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={() => void bajar('certificado')}>
                      Descargar certificado
                    </button>
                  </div>
                )}
              {fila.comparacion && fila.comparacion.length > 0 && (
                <FlitTable label="Comparación con el RUNT">
                  <thead>
                    <tr>
                      <FlitTh>Dato</FlitTh>
                      <FlitTh>Factura</FlitTh>
                      <FlitTh>RUNT</FlitTh>
                      <FlitTh>Resultado</FlitTh>
                    </tr>
                  </thead>
                  <tbody>
                    {fila.comparacion.map((c) => (
                      <FlitTr key={c.campo}>
                        <td className="px-4 py-2 text-sm">{CAMPO_COMPARACION_FACTURA_RUNT_LABEL[c.campo]}</td>
                        <td className="px-4 py-2 text-sm">{c.valorFactura ?? '—'}</td>
                        <td className="px-4 py-2 text-sm">{c.valorRunt ?? '—'}</td>
                        <td className="px-4 py-2 text-sm">{RESULTADO[c.resultado]}</td>
                      </FlitTr>
                    ))}
                  </tbody>
                </FlitTable>
              )}
              </div>
            </FlitCard>
          ) : undefined}
        />
      )}
    </div>
  );
}
