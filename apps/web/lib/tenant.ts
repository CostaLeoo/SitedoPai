'use client';
const KEY = 'sitedopai.tenant';

export const getTenant = () => (typeof window === 'undefined' ? null : window.localStorage.getItem(KEY));
export const setTenant = (id: string) => window.localStorage.setItem(KEY, id);
export const clearTenant = () => window.localStorage.removeItem(KEY);
