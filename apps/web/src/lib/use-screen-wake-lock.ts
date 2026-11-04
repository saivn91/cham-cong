import { useEffect, useState } from 'react';

export interface ScreenWakeLockState {
  supported: boolean;
  active: boolean;
}

// Quản lý vòng đời Screen Wake Lock API: giữ màn hình sáng khi trang hiển thị, tự giải phóng khi ẩn/hủy
export function useScreenWakeLock(enabled = true): ScreenWakeLockState {
  const [supported] = useState(
    () => typeof window !== 'undefined' && 'wakeLock' in navigator && typeof navigator.wakeLock?.request === 'function',
  );
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!enabled || !supported || typeof document === 'undefined') {
      setActive(false);
      return;
    }

    let disposed = false;
    let requesting = false;
    let sentinel: WakeLockSentinel | null = null;
    let shouldReacquire = true;

    const releaseLock = async () => {
      const current = sentinel;
      sentinel = null;
      if (!disposed) setActive(false);
      if (current && !current.released) {
        try {
          await current.release();
        } catch {
          // Bỏ qua lỗi giải phóng trên trình duyệt không ổn định
        }
      }
    };

    const requestLock = async () => {
      if (disposed || requesting || sentinel || document.visibilityState !== 'visible') return;
      requesting = true;
      try {
        const lock = await navigator.wakeLock.request('screen');
        // Chống rò rỉ khóa bất đồng bộ nếu component đã unmount hoặc tab bị ẩn trong lúc chờ
        if (disposed || document.visibilityState !== 'visible') {
          await lock.release().catch(() => {});
          return;
        }
        sentinel = lock;
        shouldReacquire = true;
        setActive(true);
        lock.addEventListener('release', () => {
          if (sentinel === lock) sentinel = null;
          if (!disposed) setActive(false);
        });
      } catch {
        // Trình duyệt từ chối (ví dụ: chế độ tiết kiệm pin hoặc chính sách iPad Safari)
        if (!disposed) setActive(false);
      } finally {
        requesting = false;
      }
    };

    // Thu hồi khóa khi tab ẩn và cấp lại khi hiển thị trở lại nếu trước đó đang bật
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        if (shouldReacquire) void requestLock();
      } else {
        void releaseLock();
      }
    };

    void requestLock();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      disposed = true;
      shouldReacquire = false;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      void releaseLock();
    };
  }, [enabled, supported]);

  return { supported, active };
}