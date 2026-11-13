import OcrUpload from '../components/OcrUpload';
import PageHeaderCard from '../components/flit/PageHeaderCard';

export default function TaxReader() {
  return (
    <div className="flex min-w-0 flex-col gap-4 lg:gap-6">
      <PageHeaderCard
        title="Lectura de impuestos"
        icono="flito-impuestos"
        subtitle="Sube declaraciones de impuesto vehicular en PDF y extrae los datos automáticamente."
      />
      <OcrUpload />
    </div>
  );
}
