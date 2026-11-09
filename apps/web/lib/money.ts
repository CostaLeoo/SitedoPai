export const brl = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const date = (d: string | null) => (d ? new Date(d).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : '—');
export const TENANT_STATUS: Record<string, string> = {
  ACTIVE: 'Ativa', GRACE_PERIOD: 'Em tolerância', READ_ONLY: 'Somente consulta', CLOSED: 'Encerrada',
};
export const INVOICE_STATUS: Record<string, string> = { OPEN: 'Em aberto', PAID: 'Paga', FAILED: 'Falhou', VOID: 'Anulada' };
export const SUB_STATUS: Record<string, string> = { ACTIVE: 'Em dia', PAST_DUE: 'Em atraso', CANCELED: 'Cancelada' };
