import OcrUpload from '../components/OcrUpload';
import PageHeaderCard from '../components/flit/PageHeaderCard';

export default function TaxReader() {
  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Lectura de impuestos"
        subtitle="Sube declaraciones de impuesto vehicular en PDF y extrae los datos automáticamente."
      />
      <OcrUpload />
    </div>
  );
}
