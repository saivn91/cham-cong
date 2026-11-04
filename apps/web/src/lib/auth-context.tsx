import React, { createContext, useContext, useEffect, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from './supabase';

export type UserRole = 'employee' | 'manager' | 'admin' | 'kiosk' | null;

interface AuthContextType {
  session: Session | null;
  user: User | null;
  role: UserRole;
  loading: boolean;
  authError: string | null;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<{ error: Error | null }>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);
const AUTH_TIMEOUT_MS = 10000;

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<UserRole>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    // Bộ đếm thế hệ yêu cầu giúp chặn kết quả truy vấn cũ ghi đè trạng thái phiên mới
    let requestGeneration = 0;
    let activeTimeoutId: ReturnType<typeof setTimeout> | undefined;

    // Dọn bộ đếm timeout hiện tại khi hoàn tất xử lý hoặc khi chuyển sang thế hệ mới
    const clearAuthTimeout = () => {
      if (activeTimeoutId !== undefined) {
        clearTimeout(activeTimeoutId);
        activeTimeoutId = undefined;
      }
    };

    // Khởi tạo timeout theo từng generation để tránh treo loading ở bất kỳ lần chuyển trạng thái nào
    const startAuthTimeout = (generation: number) => {
      clearAuthTimeout();
      activeTimeoutId = setTimeout(() => {
        if (!isMounted || generation !== requestGeneration) return;
        // Tăng generation để vô hiệu hóa các kết quả bất đồng bộ trả về muộn sau khi đã timeout
        requestGeneration += 1;
        setAuthError('Quá thời gian kiểm tra phiên đăng nhập. Vui lòng thử tải lại trang.');
        setLoading(false);
      }, AUTH_TIMEOUT_MS);
    };

    const resolveRole = async (currentSession: Session | null, generation: number) => {
      if (!currentSession?.user) {
        if (isMounted && generation === requestGeneration) {
          clearAuthTimeout();
          setRole(null);
          setAuthError(null);
          setLoading(false);
        }
        return;
      }

      try {
        // Bảng employees là nguồn chuẩn cho role nhân sự; chỉ dùng JWT app_metadata cho kiosk
        const { data: employee, error } = await supabase
          .from('employees')
          .select('role')
          .eq('id', currentSession.user.id)
          .maybeSingle();

        // Bỏ qua kết quả nếu component đã unmount hoặc đã có sự kiện auth mới hơn
        if (!isMounted || generation !== requestGeneration) return;

        clearAuthTimeout();
        if (!error && employee?.role) {
          setRole(employee.role as UserRole);
          setAuthError(null);
        } else if (currentSession.user.app_metadata?.role === 'kiosk') {
          setRole('kiosk');
          setAuthError(null);
        } else {
          setRole(null);
          setAuthError(error ? 'Không thể kiểm tra quyền truy cập của tài khoản.' : null);
        }
      } catch (error) {
        if (!isMounted || generation !== requestGeneration) return;
        clearAuthTimeout();
        console.error('Lỗi truy vấn vai trò người dùng:', error);
        if (currentSession.user.app_metadata?.role === 'kiosk') {
          setRole('kiosk');
          setAuthError(null);
        } else {
          setRole(null);
          setAuthError('Không thể kết nối máy chủ để kiểm tra quyền truy cập.');
        }
      } finally {
        if (isMounted && generation === requestGeneration) {
          clearAuthTimeout();
          setLoading(false);
        }
      }
    };

    const applyAuthSession = (nextSession: Session | null) => {
      const currentGeneration = ++requestGeneration;
      setSession(nextSession);
      setUser(nextSession?.user ?? null);
      setAuthError(null);
      setLoading(true);
      startAuthTimeout(currentGeneration);
      void resolveRole(nextSession, currentGeneration);
    };

    // Đặt timeout bảo vệ ngay từ lúc chờ getSession ban đầu (generation 0)
    startAuthTimeout(requestGeneration);

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!isMounted) return;
      applyAuthSession(nextSession);
    });

    supabase.auth
      .getSession()
      .then(({ data: { session: initialSession }, error }) => {
        // Chỉ áp dụng getSession nếu listener hoặc timeout chưa chuyển sang generation mới
        if (!isMounted || requestGeneration > 0) return;
        if (error) {
          requestGeneration += 1;
          clearAuthTimeout();
          console.error('Lỗi đọc phiên đăng nhập:', error);
          setAuthError('Không thể đọc phiên đăng nhập hiện tại.');
          setLoading(false);
          return;
        }
        applyAuthSession(initialSession);
      })
      .catch((error: unknown) => {
        if (!isMounted || requestGeneration > 0) return;
        requestGeneration += 1;
        clearAuthTimeout();
        console.error('Lỗi khởi tạo xác thực:', error);
        setAuthError('Không thể khởi tạo trạng thái xác thực.');
        setLoading(false);
      });

    // Hủy đăng ký lắng nghe sự kiện khi unmount
    return () => {
      isMounted = false;
      requestGeneration += 1;
      clearAuthTimeout();
      subscription.unsubscribe();
    };
  }, []);

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error };
  };

  const signOut = async () => {
    const { error } = await supabase.auth.signOut();
    return { error };
  };

  return (
    <AuthContext.Provider
      value={{
        session,
        user,
        role,
        loading,
        authError,
        signIn,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
