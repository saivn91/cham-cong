import React, { useState } from 'react';
import { createFileRoute, Navigate } from '@tanstack/react-router';
import { pairDevice } from '../../lib/kiosk';

export const Route = createFileRoute('/kiosk/pair')({
  component: KioskPair,
});

const PAIR_ERRORS: Record<string, string> = {
  INVALID_OR_EXPIRED_CODE: 'Mã ghép nối không đúng hoặc đã hết hạn. Vui lòng xin mã mới từ quản trị viên.',
  DEVICE_REVOKED:'Thiết bị đã bị thu hồi. Vui lòng liên hệ quản trị viên.',
}

// Bảo mật: Không lưu mã ghép nối vào bộ nhớ cục bộ; phiên kiosk do Worker cấp sau khi tiêu thụ mã.
function KioskPair() {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await pairDevice(code);
      setSuccess(true);
    } catch (err) {
      const key = err instanceof Error ? err.message : '';
      setError(PAIR_ERRORS[key] ??  'Ghép nối thất bại. Vui lòng kiểm tra lại.');
    } finally {
      setCode('');
      setSubmitting(false);
    }
  };

  if (success) {
    return <div><p>Ghép nối thành công!</p><Navigate to="/kiosk" /></div>;
  }

  return (
    <form onSubmit={handleSubmit} className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-bold">Ghép nối Kiosk</h1>
      <p className="text-sm text-gray-600">Nhập mã 6 số.</p>
      {error && <p className="rounded bg-red-50 p-3 text-red-600">{error}</p>}
      <input className="rounded border p-3 text-center text-2xl tracking-widest" type="text" inputMode="numeric"  autoComplete="one-time-code" placeholder="Mã 6 số" maxLength={6} pattern="\d{6}" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} disabled={submitting}  required />
      <button className="rounded bg-blue-600 p-3 font-medium text-white disabled:opacity-50" type="submit" disable={submitting || code.length !== 6}>{submitting ? 'Đang ghép nối...' : 'Ghép nối'}</button>
    </form>
  );
}
