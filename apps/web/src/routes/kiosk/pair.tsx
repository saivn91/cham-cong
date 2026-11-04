import React, { useState } from 'react';
import { createFileRoute, Navigate } from '@tanstack/react-router';
import { useAuth } from '../../lib/auth-context';
import { pairDevice } from '../../lib/kiosk';

export const Route = createFileRoute('/kiosk/pair')({
  component: KioskPair,
});

// Bảo mật: Không lưu mật khẩu hoặc mã ghép nối vào bộ nhớ cục bộ.
function KioskPair() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const { error } = await signIn(email, password);
      if (error) {
        throw error;
      }
      await pairDevice(code);
      setCode('');
      setSuccess(true);
    } catch (err: any) {
      setError(err?.message || 'Ghép nối thất bại. Vui lòng kiểm tra lại.');
    }
  };

  if (success) {
    return <div><p>Ghép nối thành công!</p><Navigate to="/kiosk" /></div>;
  }

  return (
    <form onSubmit={handleSubmit} className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-bold">Ghép nối Kiosk</h1>
      {error && <p className="rounded bg-red-50 p-3 text-red-600">{error}</p>}
      <input className="rounded border p-3" type="email" placeholder="Email Kiosk" value={email} onChange={(e) => setEmail(e.target.value)} required />
      <input className="rounded border p-3" type="password" placeholder="Mật khẩu" value={password} onChange={(e) => setPassword(e.target.value)} required />
      <input className="rounded border p-3 text-center text-2xl tracking-widest" type="text" inputMode="numeric" placeholder="Mã 6 số" maxLength={6} pattern="\d{6}" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} required />
      <button className="rounded bg-blue-600 p-3 font-medium text-white" type="submit">Ghép nối</button>
    </form>
  );
}
