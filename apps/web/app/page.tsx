'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { currentUser } from '@/lib/auth';

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    currentUser().then((u) => router.replace(u ? '/aprs' : '/entrar'));
  }, [router]);
  return null;
}
