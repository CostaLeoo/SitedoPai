import type { Pt } from '@/lib/types';
import { fmt, PT_STATUS } from './labels';

/** Faixa que responde, sem ambiguidade, se a PT vale como autorização agora. */
export function ValidityBanner({ pt }: { pt: Pt }) {
  if (pt.validity.valid) {
    return (
      <div role="status" className="rounded-xl border-4 border-ok bg-ok-bg p-4 text-ok">
        <p className="text-2xl font-black">PT VÁLIDA</p>
        <p className="font-semibold">{PT_STATUS[pt.status]} · vale até {fmt(pt.ends_at)}</p>
      </div>
    );
  }
  const live = pt.status === 'RELEASED' || pt.status === 'IN_EXECUTION' || pt.status === 'SUSPENDED' || pt.status === 'EXPIRED';
  return (
    <div role={live ? 'alert' : 'status'} className={`rounded-xl border-4 p-4 ${live ? 'border-danger bg-danger-bg text-danger' : 'border-line bg-surface text-ink'}`}>
      <p className="text-2xl font-black">NÃO VALE COMO AUTORIZAÇÃO</p>
      <p className="font-semibold">{PT_STATUS[pt.status]}{pt.validity.reason ? ` · ${pt.validity.reason}` : ''}</p>
      {pt.status_reason && <p>Motivo: {pt.status_reason}</p>}
    </div>
  );
}
