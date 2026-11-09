'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';

/** Mesmo tamanho de página da API. */
export const PAGE_SIZE = 100;

/** Lista paginada por cursor (data + id do último item). */
export function usePaged<T extends { id: string }>(path: string, cursorField: keyof T & string) {
  const [rows, setRows] = useState<T[] | null>(null);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(async (after: T | null) => {
    setLoading(true);
    try {
      const qs = after ? `?before=${encodeURIComponent(String(after[cursorField]))}&beforeId=${after.id}` : '';
      const page = await api<T[]>(`${path}${qs}`);
      setRows((prev) => (after && prev ? [...prev, ...page] : page));
      setMore(page.length === PAGE_SIZE);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Erro ao carregar.');
    } finally {
      setLoading(false);
    }
  }, [path, cursorField]);

  useEffect(() => {
    fetchPage(null);
  }, [fetchPage]);

  return { rows, more, loading, error, loadMore: () => rows && rows.length && fetchPage(rows[rows.length - 1]!) };
}
