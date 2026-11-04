-- 0003_rls.sql
-- Mô tả: RLS, hàm hỗ trợ SECURITY DEFINER, RPC danh mục và trigger audit/khóa.
-- PostgreSQL 17 / Supabase

CREATE SCHEMA IF NOT EXISTS private;

-- ============================================================================
-- 1. Hàm hỗ trợ SECURITY DEFINER (schema private)
-- ============================================================================

CREATE OR REPLACE FUNCTION private.my_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
  SELECT role
  FROM public.employees
  WHERE id = auth.uid()
    AND is_active = true;
$$;

CREATE OR REPLACE FUNCTION private.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
  SELECT COALESCE(private.my_role() = 'admin', false);
$$;

CREATE OR REPLACE FUNCTION private.my_branches()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
  SELECT COALESCE(array_agg(branch_id), '{}'::uuid[])
  FROM public.manager_branches
  WHERE manager_id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION private.is_manager_of(p_branch_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.manager_branches mb
    WHERE mb.manager_id = auth.uid()
      AND mb.branch_id = p_branch_id
  );
$$;

REVOKE ALL ON SCHEMA private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA private TO authenticated, service_role;

-- ============================================================================
-- 2. RPC danh mục nhân viên cho Manager và Admin (schema public)
-- ============================================================================
-- Cho phép Manager & Admin xem danh mục nhân viên (mã, tên, role, is_active)
-- mà không làm lộ hourly_rate và fixed_allowance.

CREATE OR REPLACE FUNCTION public.employee_directory()
RETURNS TABLE (
  id uuid,
  employee_code text,
  full_name text,
  role text,
  is_active boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_role text;
BEGIN
  v_role := COALESCE(private.my_role(), '');

  IF v_role NOT IN ('admin', 'manager') THEN
    RAISE EXCEPTION 'Access denied: manager or admin role required'
      USING ERRCODE = '42501';
  END IF;

  IF v_role = 'admin' THEN
    RETURN QUERY
    SELECT
      e.id,
      e.employee_code,
      e.full_name,
      e.role,
      e.is_active
    FROM public.employees e
    ORDER BY e.employee_code ASC;
    RETURN;
  END IF;

  -- Manager chỉ được xem hồ sơ của chính mình hoặc nhân sự có ca làm / chấm công thuộc chi nhánh được phân công
  RETURN QUERY
  SELECT
    e.id,
    e.employee_code,
    e.full_name,
    e.role,
    e.is_active
  FROM public.employees e
  WHERE e.id = auth.uid()
     OR EXISTS (
       SELECT 1
       FROM public.shifts s
       WHERE s.employee_id = e.id
         AND s.branch_id = ANY(private.my_branches())
     )
     OR EXISTS (
       SELECT 1
       FROM public.punches p
       WHERE p.employee_id = e.id
         AND p.branch_id = ANY(private.my_branches())
     )
  ORDER BY e.employee_code ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.employee_directory() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.employee_directory() TO authenticated, service_role;

-- ============================================================================
-- 3. Bật Row Level Security cho toàn bộ 14 bảng
-- ============================================================================

ALTER TABLE public.branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.manager_branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_pairings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shift_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.punches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monthly_allowances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.holidays ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 4. Chính sách RLS
-- ============================================================================

-- ---- 4.1 branches ----
DROP POLICY IF EXISTS branches_select_authenticated ON public.branches;
CREATE POLICY branches_select_authenticated ON public.branches
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS branches_all_admin ON public.branches;
CREATE POLICY branches_all_admin ON public.branches
  FOR ALL TO authenticated
  USING (private.is_admin())
  WITH CHECK (private.is_admin());

-- ---- 4.2 employees ----
DROP POLICY IF EXISTS employees_select_own ON public.employees;
CREATE POLICY employees_select_own ON public.employees
  FOR SELECT TO authenticated
  USING (id = auth.uid());

DROP POLICY IF EXISTS employees_all_admin ON public.employees;
CREATE POLICY employees_all_admin ON public.employees
  FOR ALL TO authenticated
  USING (private.is_admin())
  WITH CHECK (private.is_admin());

-- ---- 4.3 employee_pins ----
-- Không tạo policy nào: Chỉ các hàm SECURITY DEFINER (như kiosk_punch, change_pin, reset_pin) mới được truy cập.

-- ---- 4.4 manager_branches ----
DROP POLICY IF EXISTS manager_branches_select_own ON public.manager_branches;
CREATE POLICY manager_branches_select_own ON public.manager_branches
  FOR SELECT TO authenticated
  USING (manager_id = auth.uid());

DROP POLICY IF EXISTS manager_branches_all_admin ON public.manager_branches;
CREATE POLICY manager_branches_all_admin ON public.manager_branches
  FOR ALL TO authenticated
  USING (private.is_admin())
  WITH CHECK (private.is_admin());

-- ---- 4.5 devices ----
DROP POLICY IF EXISTS devices_select_own ON public.devices;
CREATE POLICY devices_select_own ON public.devices
  FOR SELECT TO authenticated
  USING (auth_user_id = auth.uid());

DROP POLICY IF EXISTS devices_all_admin ON public.devices;
CREATE POLICY devices_all_admin ON public.devices
  FOR ALL TO authenticated
  USING (private.is_admin())
  WITH CHECK (private.is_admin());

-- ---- 4.6 device_pairings ----
DROP POLICY IF EXISTS device_pairings_all_admin ON public.device_pairings;
CREATE POLICY device_pairings_all_admin ON public.device_pairings
  FOR ALL TO authenticated
  USING (private.is_admin())
  WITH CHECK (private.is_admin());

-- ---- 4.7 shift_templates ----
-- Ca mẫu là danh mục dùng chung toàn hệ thống: mọi người dùng đã xác thực đều được đọc,
-- chỉ Admin mới có quyền thêm/sửa/xóa (Manager không được tự ý sửa ca mẫu chung).
DROP POLICY IF EXISTS shift_templates_select_authenticated ON public.shift_templates;
CREATE POLICY shift_templates_select_authenticated ON public.shift_templates
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS shift_templates_all_admin ON public.shift_templates;
CREATE POLICY shift_templates_all_admin ON public.shift_templates
  FOR ALL TO authenticated
  USING (private.is_admin())
  WITH CHECK (private.is_admin());

-- ---- 4.8 shifts ----
DROP POLICY IF EXISTS shifts_select_own ON public.shifts;
CREATE POLICY shifts_select_own ON public.shifts
  FOR SELECT TO authenticated
  USING (employee_id = auth.uid());

DROP POLICY IF EXISTS shifts_insert_own ON public.shifts;
CREATE POLICY shifts_insert_own ON public.shifts
  FOR INSERT TO authenticated
  WITH CHECK (
    employee_id = auth.uid()
    AND status = 'pending'
    AND start_at > now()
  );

DROP POLICY IF EXISTS shifts_delete_own ON public.shifts;
CREATE POLICY shifts_delete_own ON public.shifts
  FOR DELETE TO authenticated
  USING (
    employee_id = auth.uid()
    AND status = 'pending'
    AND start_at > now()
  );

DROP POLICY IF EXISTS shifts_select_manager ON public.shifts;
CREATE POLICY shifts_select_manager ON public.shifts
  FOR SELECT TO authenticated
  USING (
    private.my_role() = 'manager'
    AND branch_id = ANY(private.my_branches())
  );

DROP POLICY IF EXISTS shifts_all_admin ON public.shifts;
CREATE POLICY shifts_all_admin ON public.shifts
  FOR ALL TO authenticated
  USING (private.is_admin())
  WITH CHECK (private.is_admin());

-- ---- 4.9 punches ----
DROP POLICY IF EXISTS punches_select_own ON public.punches;
CREATE POLICY punches_select_own ON public.punches
  FOR SELECT TO authenticated
  USING (employee_id = auth.uid());

DROP POLICY IF EXISTS punches_select_manager ON public.punches;
CREATE POLICY punches_select_manager ON public.punches
  FOR SELECT TO authenticated
  USING (
    private.my_role() = 'manager'
    AND branch_id = ANY(private.my_branches())
  );

DROP POLICY IF EXISTS punches_all_admin ON public.punches;
CREATE POLICY punches_all_admin ON public.punches
  FOR ALL TO authenticated
  USING (private.is_admin())
  WITH CHECK (private.is_admin());

-- ---- 4.10 payroll_periods ----
DROP POLICY IF EXISTS payroll_periods_select_authenticated ON public.payroll_periods;
CREATE POLICY payroll_periods_select_authenticated ON public.payroll_periods
  FOR SELECT TO authenticated
  USING (true);

-- Admin chỉ được mở mới hoặc xóa kỳ đang 'open'; không cấp policy UPDATE trực tiếp
-- và thu hồi quyền UPDATE của authenticated để ép mọi thao tác chốt kỳ phải đi qua
-- RPC approve_timesheet (SECURITY DEFINER) nhằm bảo đảm luôn ghi snapshot bảng payroll.
DROP POLICY IF EXISTS payroll_periods_all_admin ON public.payroll_periods;
DROP POLICY IF EXISTS payroll_periods_insert_admin ON public.payroll_periods;
CREATE POLICY payroll_periods_insert_admin ON public.payroll_periods
  FOR INSERT TO authenticated
  WITH CHECK (
    private.is_admin()
    AND status = 'open'
    AND approved_by IS NULL
    AND approved_at IS NULL
  );

DROP POLICY IF EXISTS payroll_periods_delete_admin ON public.payroll_periods;
CREATE POLICY payroll_periods_delete_admin ON public.payroll_periods
  FOR DELETE TO authenticated
  USING (
    private.is_admin()
    AND status = 'open'
  );

REVOKE UPDATE ON TABLE public.payroll_periods FROM PUBLIC, anon, authenticated;

-- ---- 4.11 monthly_allowances ----
-- Nhân viên chỉ được đọc phụ cấp của chính mình khi kỳ lương đã được duyệt (approved).
-- Admin được đọc phụ cấp ở cả kỳ open và approved, nhưng chỉ được phép ghi (INSERT/UPDATE/DELETE)
-- khi kỳ lương đang ở trạng thái open.
DROP POLICY IF EXISTS monthly_allowances_select_admin ON public.monthly_allowances;
CREATE POLICY monthly_allowances_select_admin ON public.monthly_allowances
  FOR SELECT TO authenticated
  USING (private.is_admin());

DROP POLICY IF EXISTS monthly_allowances_select_own ON public.monthly_allowances;
CREATE POLICY monthly_allowances_select_own ON public.monthly_allowances
  FOR SELECT TO authenticated
  USING (
    employee_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.payroll_periods pp
      WHERE pp.id = monthly_allowances.period_id
        AND pp.status = 'approved'
    )
  );

DROP POLICY IF EXISTS monthly_allowances_all_admin ON public.monthly_allowances;
DROP POLICY IF EXISTS monthly_allowances_insert_admin ON public.monthly_allowances;
CREATE POLICY monthly_allowances_insert_admin ON public.monthly_allowances
  FOR INSERT TO authenticated
  WITH CHECK (
    private.is_admin()
    AND EXISTS (
      SELECT 1 FROM public.payroll_periods pp
      WHERE pp.id = monthly_allowances.period_id
        AND pp.status = 'open'
    )
  );

DROP POLICY IF EXISTS monthly_allowances_update_admin ON public.monthly_allowances;
CREATE POLICY monthly_allowances_update_admin ON public.monthly_allowances
  FOR UPDATE TO authenticated
  USING (
    private.is_admin()
    AND EXISTS (
      SELECT 1 FROM public.payroll_periods pp
      WHERE pp.id = monthly_allowances.period_id
        AND pp.status = 'open'
    )
  )
  WITH CHECK (
    private.is_admin()
    AND EXISTS (
      SELECT 1 FROM public.payroll_periods pp
      WHERE pp.id = monthly_allowances.period_id
        AND pp.status = 'open'
    )
  );

DROP POLICY IF EXISTS monthly_allowances_delete_admin ON public.monthly_allowances;
CREATE POLICY monthly_allowances_delete_admin ON public.monthly_allowances
  FOR DELETE TO authenticated
  USING (
    private.is_admin()
    AND EXISTS (
      SELECT 1 FROM public.payroll_periods pp
      WHERE pp.id = monthly_allowances.period_id
        AND pp.status = 'open'
    )
  );

-- ---- 4.12 payroll ----
DROP POLICY IF EXISTS payroll_select_own ON public.payroll;
CREATE POLICY payroll_select_own ON public.payroll
  FOR SELECT TO authenticated
  USING (
    employee_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.payroll_periods pp
      WHERE pp.id = payroll.period_id
        AND pp.status = 'approved'
    )
  );

DROP POLICY IF EXISTS payroll_select_admin ON public.payroll;
CREATE POLICY payroll_select_admin ON public.payroll
  FOR SELECT TO authenticated
  USING (private.is_admin());

-- ---- 4.13 holidays ----
DROP POLICY IF EXISTS holidays_select_authenticated ON public.holidays;
CREATE POLICY holidays_select_authenticated ON public.holidays
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS holidays_all_admin ON public.holidays;
CREATE POLICY holidays_all_admin ON public.holidays
  FOR ALL TO authenticated
  USING (private.is_admin())
  WITH CHECK (private.is_admin());

-- ---- 4.14 audit_log ----
DROP POLICY IF EXISTS audit_log_select_manager ON public.audit_log;
CREATE POLICY audit_log_select_manager ON public.audit_log
  FOR SELECT TO authenticated
  USING (
    private.my_role() = 'manager'
    AND branch_id = ANY(private.my_branches())
  );

DROP POLICY IF EXISTS audit_log_select_admin ON public.audit_log;
CREATE POLICY audit_log_select_admin ON public.audit_log
  FOR SELECT TO authenticated
  USING (private.is_admin());

-- ============================================================================
-- 5. TRIGGER: KHÓA KỲ LƯƠNG VÀ CHẶN SỬA DỮ LIỆU KHI KỲ ĐÃ APPROVED
-- ============================================================================

-- Khóa dòng payroll_periods (FOR UPDATE) theo thứ tự thời gian (year, month) nhất quán
-- trước khi kiểm tra status nhằm tuần tự hóa hoàn toàn với approve_timesheet và tránh deadlock.
-- Nếu kỳ lương (year, month) chưa được mở trong bảng payroll_periods thì vẫn cho phép chấm công;
-- nếu đã tồn tại dòng kỳ lương thì bắt buộc khóa FOR UPDATE và chặn khi status = 'approved'.
CREATE OR REPLACE FUNCTION private.check_punch_period_not_approved()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_old_date date;
  v_new_date date;
  v_old_y int;
  v_old_m int;
  v_new_y int;
  v_new_m int;
  v_rec record;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    v_old_date := (OLD.at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
    v_old_y := EXTRACT(YEAR FROM v_old_date)::int;
    v_old_m := EXTRACT(MONTH FROM v_old_date)::int;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    v_new_date := (NEW.at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
    v_new_y := EXTRACT(YEAR FROM v_new_date)::int;
    v_new_m := EXTRACT(MONTH FROM v_new_date)::int;
  END IF;

  -- Khóa tất cả các kỳ lương liên quan (cả OLD và NEW nếu UPDATE đổi tháng) theo thứ tự (year, month) tăng dần
  FOR v_rec IN
    SELECT pp.id, pp.year, pp.month, pp.status
    FROM public.payroll_periods pp
    WHERE (v_old_y IS NOT NULL AND pp.year = v_old_y AND pp.month = v_old_m)
       OR (v_new_y IS NOT NULL AND pp.year = v_new_y AND pp.month = v_new_m)
    ORDER BY pp.year ASC, pp.month ASC, pp.id ASC
    FOR UPDATE
  LOOP
    IF v_rec.status = 'approved' THEN
      RAISE EXCEPTION 'Cannot % punch: payroll period %-% is already approved',
        TG_OP, v_rec.year, v_rec.month
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_punches_check_period ON public.punches;
CREATE TRIGGER trg_punches_check_period
  BEFORE INSERT OR UPDATE OR DELETE ON public.punches
  FOR EACH ROW
  EXECUTE FUNCTION private.check_punch_period_not_approved();

-- Khóa dòng payroll_periods (FOR UPDATE) khi INSERT/UPDATE/DELETE trên monthly_allowances
-- để serialize với approve_timesheet; đồng thời kiểm tra kỳ lương phải tồn tại và đang 'open'.
CREATE OR REPLACE FUNCTION private.check_allowance_period_not_approved()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_old_period_id uuid;
  v_new_period_id uuid;
  v_rec record;
  v_found_old boolean := false;
  v_found_new boolean := false;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    v_old_period_id := OLD.period_id;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    v_new_period_id := NEW.period_id;
  END IF;

  FOR v_rec IN
    SELECT pp.id, pp.year, pp.month, pp.status
    FROM public.payroll_periods pp
    WHERE pp.id IN (v_old_period_id, v_new_period_id)
    ORDER BY pp.year ASC, pp.month ASC, pp.id ASC
    FOR UPDATE
  LOOP
    IF v_rec.id = v_old_period_id THEN
      v_found_old := true;
    END IF;
    IF v_rec.id = v_new_period_id THEN
      v_found_new := true;
    END IF;

    IF v_rec.status <> 'open' THEN
      RAISE EXCEPTION 'Cannot % monthly_allowances: payroll period %-% is already approved',
        TG_OP, v_rec.year, v_rec.month
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  IF (v_old_period_id IS NOT NULL AND NOT v_found_old)
     OR (v_new_period_id IS NOT NULL AND NOT v_found_new) THEN
    RAISE EXCEPTION 'PAYROLL_PERIOD_NOT_FOUND'
      USING ERRCODE = 'P0002';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_monthly_allowances_check_period ON public.monthly_allowances;
CREATE TRIGGER trg_monthly_allowances_check_period
  BEFORE INSERT OR UPDATE OR DELETE ON public.monthly_allowances
  FOR EACH ROW
  EXECUTE FUNCTION private.check_allowance_period_not_approved();

-- Bảo vệ tính bất biến và chu trình trạng thái của kỳ lương (payroll_periods):
-- 1. INSERT: Chỉ cho phép tạo kỳ ở trạng thái 'open' với approved_by IS NULL và approved_at IS NULL.
-- 2. UPDATE: Ngoài việc REVOKE quyền UPDATE trực tiếp từ authenticated và không có RLS UPDATE policy
--    (chỉ hàm SECURITY DEFINER approve_timesheet thực thi được UPDATE với quyền owner),
--    trigger bảo đảm thêm:
--    - Kỳ đang 'approved' thì bất biến tuyệt đối (không thể sửa bất kỳ cột nào hay hạ về 'open').
--    - Không được đổi id, year, month, created_at của kỳ lương đã tạo.
--    - Khi chuyển sang 'approved' bắt buộc phải có approved_at (và approved_by khi có auth.uid());
--      khi ở 'open' thì approved_by và approved_at đều phải NULL.
-- 3. DELETE: Chặn xóa kỳ đã 'approved'.
CREATE OR REPLACE FUNCTION private.check_payroll_period_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'open'
       OR NEW.approved_by IS NOT NULL
       OR NEW.approved_at IS NOT NULL THEN
      RAISE EXCEPTION 'New payroll period must have status = open and null approval metadata'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'approved' THEN
      RAISE EXCEPTION 'Cannot delete an approved payroll period (%-%)', OLD.year, OLD.month
        USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'approved' THEN
      RAISE EXCEPTION 'Cannot modify an approved payroll period (%-%)', OLD.year, OLD.month
        USING ERRCODE = '42501';
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.year IS DISTINCT FROM OLD.year
       OR NEW.month IS DISTINCT FROM OLD.month
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'Cannot change immutable identifiers or year/month of a payroll period'
        USING ERRCODE = '42501';
    END IF;

    IF NEW.status = 'approved' THEN
      IF NEW.approved_at IS NULL
         OR (auth.uid() IS NOT NULL AND NEW.approved_by IS DISTINCT FROM auth.uid()) THEN
        RAISE EXCEPTION 'Approved payroll period requires consistent approval metadata'
          USING ERRCODE = '42501';
      END IF;
    ELSIF NEW.status = 'open' THEN
      IF NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL THEN
        RAISE EXCEPTION 'Open payroll period cannot have approval metadata'
          USING ERRCODE = '42501';
      END IF;
    ELSE
      RAISE EXCEPTION 'Invalid payroll period status: %', NEW.status
        USING ERRCODE = '22023';
    END IF;

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payroll_periods_immutable ON public.payroll_periods;
CREATE TRIGGER trg_payroll_periods_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_periods
  FOR EACH ROW
  EXECUTE FUNCTION private.check_payroll_period_immutable();

-- Bảo vệ vai trò 'admin' trên bảng public.employees trước các thao tác từ ứng dụng (auth.role() = 'authenticated'):
-- - Chặn INSERT tạo nhân sự có role = 'admin' (hoặc ngoài 'employee', 'manager').
-- - Chặn UPDATE nâng quyền lên 'admin' hoặc hạ quyền từ 'admin' sang vai trò khác.
-- - Chặn DELETE xóa tài khoản có role = 'admin'.
-- - Vẫn cho phép Admin chỉnh sửa các thông tin khác (như home_branch_id, lương, phụ cấp) của tài khoản admin nếu giữ nguyên role.
-- - Không ảnh hưởng tới thao tác quản trị thủ công qua SQL Editor của PostgreSQL hoặc service_role.
CREATE OR REPLACE FUNCTION private.protect_admin_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF COALESCE(auth.role(), '') = 'authenticated' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.role = 'admin' OR NEW.role NOT IN ('employee', 'manager') THEN
        RAISE EXCEPTION 'ADMIN_ROLE_PROTECTED: Không được tạo tài khoản có vai trò admin từ ứng dụng.'
          USING ERRCODE = '42501';
      END IF;
    ELSIF TG_OP = 'UPDATE' THEN
      IF OLD.role IS DISTINCT FROM NEW.role THEN
        IF OLD.role = 'admin' OR NEW.role = 'admin' OR NEW.role NOT IN ('employee', 'manager') THEN
          RAISE EXCEPTION 'ADMIN_ROLE_PROTECTED: Không được cấp mới hoặc thay đổi vai trò admin từ ứng dụng.'
            USING ERRCODE = '42501';
        END IF;
      END IF;
    ELSIF TG_OP = 'DELETE' THEN
      IF OLD.role = 'admin' THEN
        RAISE EXCEPTION 'ADMIN_ROLE_PROTECTED: Không được xóa tài khoản có vai trò admin từ ứng dụng.'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.protect_admin_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.protect_admin_role() TO authenticated, service_role;

DROP TRIGGER IF EXISTS trg_employees_protect_admin_role ON public.employees;
CREATE TRIGGER trg_employees_protect_admin_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.employees
  FOR EACH ROW
  EXECUTE FUNCTION private.protect_admin_role();

-- ============================================================================
-- 6. TRIGGER: AUTOMATIC AUDIT LOGGING
-- ============================================================================

CREATE OR REPLACE FUNCTION private.audit_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_row_id uuid := NULL;
  v_branch_id uuid := NULL;
  v_old jsonb := NULL;
  v_new jsonb := NULL;
  v_ref jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_new := to_jsonb(NEW);
    v_ref := v_new;
  ELSIF TG_OP = 'UPDATE' THEN
    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
    v_ref := v_new;
  ELSIF TG_OP = 'DELETE' THEN
    v_old := to_jsonb(OLD);
    v_ref := v_old;
  END IF;

  IF v_ref ? 'id' THEN
    v_row_id := NULLIF(v_ref->>'id', '')::uuid;
  END IF;

  IF TG_TABLE_NAME = 'branches' AND (v_ref ? 'id') THEN
    v_branch_id := NULLIF(v_ref->>'id', '')::uuid;
  ELSIF v_ref ? 'branch_id' THEN
    v_branch_id := NULLIF(v_ref->>'branch_id', '')::uuid;
  END IF;

  INSERT INTO public.audit_log (
    actor_id,
    branch_id,
    table_name,
    row_id,
    action,
    old_data,
    new_data
  ) VALUES (
    auth.uid(),
    v_branch_id,
    TG_TABLE_NAME,
    v_row_id,
    TG_OP,
    v_old,
    v_new
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_employees ON public.employees;
CREATE TRIGGER trg_audit_employees
  AFTER INSERT OR UPDATE OR DELETE ON public.employees
  FOR EACH ROW EXECUTE FUNCTION private.audit_row();

DROP TRIGGER IF EXISTS trg_audit_shifts ON public.shifts;
CREATE TRIGGER trg_audit_shifts
  AFTER INSERT OR UPDATE OR DELETE ON public.shifts
  FOR EACH ROW EXECUTE FUNCTION private.audit_row();

DROP TRIGGER IF EXISTS trg_audit_branches ON public.branches;
CREATE TRIGGER trg_audit_branches
  AFTER INSERT OR UPDATE OR DELETE ON public.branches
  FOR EACH ROW EXECUTE FUNCTION private.audit_row();

DROP TRIGGER IF EXISTS trg_audit_payroll_periods ON public.payroll_periods;
CREATE TRIGGER trg_audit_payroll_periods
  AFTER INSERT OR UPDATE OR DELETE ON public.payroll_periods
  FOR EACH ROW EXECUTE FUNCTION private.audit_row();
