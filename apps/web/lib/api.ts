'use client';
import { accessToken } from './auth';
import { API_URL } from './config';
import { getTenant } from './tenant';

export interface Issue { code: string; message: string; questionId?: string; stepId?: string; hazardId?: string }

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields: { field: string; message: string }[] = [],
    readonly blocking: Issue[] = [],
  ) {
    super(message);
  }
}

const OFFLINE = 'Sem conexão. O que você preencheu continua na tela; tente salvar de novo quando o sinal voltar.';

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await accessToken();
  if (!token) {
    window.location.assign('/entrar');
    throw new ApiError(401, 'UNAUTHENTICATED', 'Faça login para continuar.');
  }
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  const tenant = getTenant();
  if (tenant) headers.set('X-Tenant-Id', tenant);
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, 'OFFLINE', OFFLINE);
  }
  if (!res.ok) {
    let body: Record<string, unknown> = {};
    try {
      body = await res.json();
    } catch {
      /* corpo vazio */
    }
    // 401 por sessão expirada leva à entrada. Pedido de login recente para
    // ASSINAR (REAUTH_REQUIRED) fica na tela, que oferece entrar de novo.
    if (res.status === 401 && body.code !== 'REAUTH_REQUIRED') {
      window.location.assign('/entrar');
      throw new ApiError(401, 'UNAUTHENTICATED', 'Sua sessão expirou. Entre de novo.');
    }
    throw new ApiError(
      res.status,
      String(body.code ?? 'ERROR'),
      String(body.message ?? 'Não foi possível concluir. Tente novamente.'),
      (body.fields as ApiError['fields']) ?? [],
      (body.blocking as Issue[]) ?? [],
    );
  }
  return res;
}

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await request(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.status === 204 ? (undefined as T) : res.json();
}

export async function uploadPhoto(aprId: string, questionId: string, file: Blob, name: string) {
  const form = new FormData();
  form.append('file', file, name);
  const res = await request(`/aprs/${aprId}/questions/${questionId}/photos`, { method: 'POST', body: form });
  return (await res.json()) as { id: string; sha256: string };
}

/** Busca a foto com o token e devolve uma URL local (blob:) para exibir. */
export async function photoUrl(aprId: string, photoId: string): Promise<string> {
  const res = await request(`/aprs/${aprId}/photos/${photoId}`);
  return URL.createObjectURL(await res.blob());
}

/** Baixa um PDF emitido (com o token) e dispara o download no navegador. */
export async function downloadDocument(id: string, fallbackName: string) {
  const res = await request(`/documents/${id}/file`);
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
