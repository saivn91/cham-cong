-- 0003_rls.sql
-- Row Level Security, Security Definer Helpers, Directory RPC & Audit/Lock Triggers
-- PostgreSQL 17 / Supabase

CREATE SCHEMA IF NOT EXISTS private;

-- ============================================================================
-- 1. SECURITY DEFINER HELPER FUNCTIONS (private schema)
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
-- 2. EMPLOYEE DIRECTORY RPC FOR MANAGERS & ADMINS (public schema)
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
SET search_path = public, pg_temp
AS $$
BEGIN
  IF COALESCE(private.my_role(), '') NOT IN ('admin', 'manager') THEN
    RAISE EXCEPTION 'Access denied: manager or admin role required'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    e.id,
    e.employee_code,
    e.full_name,
    e.role,
    e.is_active
  FROM public.employees e
  ORDER BY e.employee_code ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.employee_directory() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.employee_directory() TO authenticated, service_role;

-- ============================================================================
-- 3. ENABLE ROW LEVEL SECURITY ON ALL 14 TABLES
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
-- 4. RLS POLICIES
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
DROP POLICY IF EXISTS shift_templates_select_authenticated ON public.shift_templates;
CREATE POLICY shift_templates_select_authenticated ON public.shift_templates
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS shift_templates_all_admin ON public.shift_templates;
CREATE POLICY shift_templates_all_admin ON public.shift_templates
  FOR ALL TO authenticated
  USING (private.is_admin() OR (private.my_role() = 'manager' AND branch_id = ANY(private.my_branches())))
  WITH CHECK (private.is_admin() OR (private.my_role() = 'manager' AND branch_id = ANY(private.my_branches())));

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

DROP POLICY IF EXISTS payroll_periods_all_admin ON public.payroll_periods;
CREATE POLICY payroll_periods_all_admin ON public.payroll_periods
  FOR ALL TO authenticated
  USING (private.is_admin())
  WITH CHECK (private.is_admin());

-- ---- 4.11 monthly_allowances ----
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
CREATE POLICY monthly_allowances_all_admin ON public.monthly_allowances
  FOR ALL TO authenticated
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
-- 5. TRIGGER: BLOCK PUNCH MODIFICATION IN APPROVED PAYROLL PERIOD
-- ============================================================================

CREATE OR REPLACE FUNCTION private.check_punch_period_not_approved()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_date date;
  v_locked boolean;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    v_date := (OLD.at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
    SELECT EXISTS (
      SELECT 1
      FROM public.payroll_periods
      WHERE status = 'approved'
        AND year = EXTRACT(YEAR FROM v_date)::int
        AND month = EXTRACT(MONTH FROM v_date)::int
    ) INTO v_locked;

    IF v_locked THEN
      RAISE EXCEPTION 'Cannot % punch: payroll period %-% is already approved',
        TG_OP, EXTRACT(YEAR FROM v_date)::int, EXTRACT(MONTH FROM v_date)::int
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    v_date := (NEW.at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
    SELECT EXISTS (
      SELECT 1
      FROM public.payroll_periods
      WHERE status = 'approved'
        AND year = EXTRACT(YEAR FROM v_date)::int
        AND month = EXTRACT(MONTH FROM v_date)::int
    ) INTO v_locked;

    IF v_locked THEN
      RAISE EXCEPTION 'Cannot % punch: payroll period %-% is already approved',
        TG_OP, EXTRACT(YEAR FROM v_date)::int, EXTRACT(MONTH FROM v_date)::int
        USING ERRCODE = '42501';
    END IF;
  END IF;

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
