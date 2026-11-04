-- Migration: 0004_functions.sql
-- Description: Core RPC functions for Kiosk, Shifts, Punches, PIN management, Device Pairing, and Payroll.
-- Author: Argon
-- PostgreSQL 17 / Supabase

-- ============================================================================
-- 1. public.kiosk_lookup
-- ============================================================================
CREATE OR REPLACE FUNCTION public.kiosk_lookup(p_employee_code text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
    v_employee_id uuid;
    v_full_name text;
    v_last_punch_type text;
    v_last_punch_at timestamptz;
    v_session_start_at timestamptz;
    v_current_state text;
    v_warning text;
BEGIN
    -- Kiểm tra device hợp lệ và chưa bị thu hồi.
    IF NOT EXISTS (
        SELECT 1
        FROM public.devices
        WHERE auth_user_id = auth.uid()
          AND revoked_at IS NULL
    ) THEN
        RETURN json_build_object('ok', false, 'error', 'DEVICE_REVOKED');
    END IF;

    SELECT id, full_name
    INTO v_employee_id, v_full_name
    FROM public.employees
    WHERE employee_code = p_employee_code
      AND is_active = true;

    IF NOT FOUND THEN
        RETURN json_build_object(
            'ok', false,
            'error', 'EMPLOYEE_NOT_FOUND'
        );
    END IF;

    WITH events AS (
        SELECT p.type::text, p.at, p.id,
               SUM(CASE WHEN p.type = 'clock_in' THEN 1 ELSE 0 END)
                 OVER (ORDER BY p.at, p.id) AS session_no
        FROM public.punches p
        WHERE p.employee_id = v_employee_id AND p.voided_at IS NULL
    ), latest AS (
        SELECT * FROM events ORDER BY at DESC, id DESC LIMIT 1
    ), bounds AS (
        SELECT session_no, max(at) FILTER (WHERE type = 'clock_in') AS clock_in_at
        FROM events GROUP BY session_no
    )
    SELECT l.type, l.at, b.clock_in_at
    INTO v_last_punch_type, v_last_punch_at, v_session_start_at
    FROM latest l JOIN bounds b USING (session_no);

    v_current_state := CASE v_last_punch_type
        WHEN 'clock_in'    THEN 'working'
        WHEN 'break_end'   THEN 'working'
        WHEN 'break_start' THEN 'on_break'
        WHEN 'clock_out'   THEN 'off'
        ELSE 'off'
    END;

    -- Một phiên mở quá lâu không được khoá kiosk sang ngày hôm sau. Đây chỉ
    -- là cảnh báo/đường thoát vận hành; punch cũ vẫn phải được Manager sửa.
    IF v_session_start_at IS NOT NULL
       AND v_session_start_at < clock_timestamp() - interval '16 hours'
       AND v_last_punch_type IN ('clock_in', 'break_start', 'break_end') THEN
        v_warning := CASE WHEN v_last_punch_type = 'break_start'
                          THEN 'MISSING_BREAK_END'
                          ELSE 'MISSING_CLOCK_OUT' END;
        v_current_state := 'off';
    END IF;

    RETURN json_build_object(
        'ok', true,
        'employee_id', v_employee_id,
        'full_name', v_full_name,
        'current_state', v_current_state,
        'warning', v_warning
    );
END;
$$;

-- ============================================================================
-- 2. public.kiosk_punch
-- ============================================================================
CREATE OR REPLACE FUNCTION public.kiosk_punch(
    p_employee_code text,
    p_pin text,
    p_action text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, extensions, pg_temp
AS $$
DECLARE
    v_employee_id uuid;
    v_pin_record record;
    v_device_id uuid;
    v_branch_id uuid;
    v_failed_count int;
    v_lock_until timestamptz;
    v_last_punch_type text;
    v_last_punch_at timestamptz;
    v_session_start_at timestamptz;
    v_current_state text;
    v_now timestamptz;
    v_warning text;
BEGIN
    -- 1. Xác thực device (FOR SHARE) và khoá employee/PIN (FOR UPDATE) để tuần tự hoá mọi thao tác chấm công.
    SELECT id, branch_id
    INTO v_device_id, v_branch_id
    FROM public.devices
    WHERE auth_user_id = auth.uid()
      AND revoked_at IS NULL
    FOR SHARE;

    IF NOT FOUND THEN
        RETURN json_build_object('ok', false, 'error', 'DEVICE_REVOKED');
    END IF;

    SELECT id INTO v_employee_id
    FROM public.employees
    WHERE employee_code = p_employee_code
      AND is_active = true
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN json_build_object(
            'ok', false,
            'error', 'EMPLOYEE_NOT_FOUND'
        );
    END IF;

    SELECT pin_hash, COALESCE(pin_failed, 0) AS pin_failed, pin_lock_until
    INTO v_pin_record
    FROM public.employee_pins
    WHERE employee_id = v_employee_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN json_build_object(
            'ok', false,
            'error', 'WRONG_PIN'
        );
    END IF;

    v_now := clock_timestamp();

    IF v_pin_record.pin_lock_until IS NOT NULL AND v_pin_record.pin_lock_until > v_now THEN
        RETURN json_build_object(
            'ok', false,
            'error', 'PIN_LOCKED',
            'unlock_at', v_pin_record.pin_lock_until
        );
    END IF;

    -- 2. Xác thực bcrypt PIN; khoá tạm 15 phút nếu sai liên tiếp 5 lần, reset bộ đếm khi đúng.
    IF v_pin_record.pin_hash IS NULL OR extensions.crypt(p_pin, v_pin_record.pin_hash) <> v_pin_record.pin_hash THEN
        v_failed_count := CASE
            WHEN v_pin_record.pin_lock_until IS NOT NULL
             AND v_pin_record.pin_lock_until <= v_now THEN 1
            ELSE v_pin_record.pin_failed + 1
        END;
        v_lock_until := CASE
            WHEN v_failed_count >= 5 THEN v_now + interval '15 minutes'
            ELSE NULL
        END;

        UPDATE public.employee_pins
        SET pin_failed = v_failed_count,
            pin_lock_until = v_lock_until
        WHERE employee_id = v_employee_id;

        RETURN json_build_object(
            'ok', false,
            'error', 'WRONG_PIN'
        );
    END IF;

    IF v_pin_record.pin_failed > 0 OR v_pin_record.pin_lock_until IS NOT NULL THEN
        UPDATE public.employee_pins
        SET pin_failed = 0,
            pin_lock_until = NULL
        WHERE employee_id = v_employee_id;
    END IF;

    -- 3. Kiểm tra state machine, tự động mở lối cho phiên treo > 16h kèm cảnh báo, rồi ghi punch mới.
    WITH events AS (
        SELECT p.type::text, p.at, p.id,
               SUM(CASE WHEN p.type = 'clock_in' THEN 1 ELSE 0 END)
                 OVER (ORDER BY p.at, p.id) AS session_no
        FROM public.punches p
        WHERE p.employee_id = v_employee_id AND p.voided_at IS NULL
    ), latest AS (
        SELECT * FROM events ORDER BY at DESC, id DESC LIMIT 1
    ), bounds AS (
        SELECT session_no, max(at) FILTER (WHERE type = 'clock_in') AS clock_in_at
        FROM events GROUP BY session_no
    )
    SELECT l.type, l.at, b.clock_in_at
    INTO v_last_punch_type, v_last_punch_at, v_session_start_at
    FROM latest l JOIN bounds b USING (session_no);

    v_current_state := CASE v_last_punch_type
        WHEN 'clock_in' THEN 'working'
        WHEN 'break_end' THEN 'working'
        WHEN 'break_start' THEN 'on_break'
        ELSE 'off'
    END;

    IF v_session_start_at IS NOT NULL
       AND v_session_start_at < v_now - interval '16 hours'
       AND v_last_punch_type IN ('clock_in', 'break_start', 'break_end') THEN
        v_warning := CASE WHEN v_last_punch_type = 'break_start'
                          THEN 'MISSING_BREAK_END'
                          ELSE 'MISSING_CLOCK_OUT' END;
        v_current_state := 'off';
    END IF;

    IF (
        (v_current_state = 'off' AND p_action = 'clock_in') OR
        (v_current_state = 'working' AND p_action IN ('break_start', 'clock_out')) OR
        (v_current_state = 'on_break' AND p_action = 'break_end')
    ) IS NOT TRUE THEN
        RETURN json_build_object(
            'ok', false,
            'error', 'INVALID_ACTION',
            'current_state', v_current_state
        );
    END IF;

    v_now := clock_timestamp();
    IF v_last_punch_at IS NOT NULL AND v_now <= v_last_punch_at THEN
        RETURN json_build_object('ok', false, 'error', 'PUNCH_TIME_CONFLICT');
    END IF;

    -- Ghi nhận punch sau khi state machine và thời điểm đã hợp lệ.
    INSERT INTO public.punches (
        employee_id,
        device_id,
        branch_id,
        type,
        at,
        source
    ) VALUES (
        v_employee_id,
        v_device_id,
        v_branch_id,
        p_action,
        v_now,
        'kiosk'
    );

    RETURN json_build_object(
        'ok', true,
        'at', v_now,
        'warning', v_warning
    );
END;
$$;

-- ============================================================================
-- 3. Shifts Self-Registration Trigger & Approval RPCs
-- ============================================================================

-- Trigger BEFORE INSERT trên bảng shifts: buộc ca tự đăng ký (employee_id = auth.uid(),
-- bao gồm employee, manager và admin khi tự đăng ký cho chính mình) luôn lấy
-- employees.home_branch_id hiện tại. Không gắn vào UPDATE để không làm đổi branch_id của ca cũ.
CREATE OR REPLACE FUNCTION private.enforce_self_shift_home_branch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
    v_home_branch_id uuid;
BEGIN
    IF auth.uid() IS NOT NULL AND NEW.employee_id = auth.uid() THEN
        SELECT e.home_branch_id
        INTO v_home_branch_id
        FROM public.employees e
        WHERE e.id = auth.uid();

        IF v_home_branch_id IS NULL THEN
            RAISE EXCEPTION 'HOME_BRANCH_REQUIRED'
                USING ERRCODE = 'P0001';
        END IF;

        NEW.branch_id := v_home_branch_id;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_shifts_enforce_home_branch ON public.shifts;
CREATE TRIGGER trg_shifts_enforce_home_branch
    BEFORE INSERT ON public.shifts
    FOR EACH ROW
    EXECUTE FUNCTION private.enforce_self_shift_home_branch();

-- RPC duyệt danh sách ca làm việc kèm tùy chọn điều chuyển chi nhánh đích trong cùng giao dịch.
CREATE OR REPLACE FUNCTION public.approve_shifts_at_branch(
    p_shift_ids uuid[],
    p_branch_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
    v_actor_id uuid;
    v_role text;
    v_target_ids uuid[];
    v_expected_count int;
    v_locked_count int := 0;
    v_shift record;
    v_now timestamptz := now();
BEGIN
    -- Chặn người dùng ẩn danh (anonymous / unauthenticated)
    v_actor_id := auth.uid();
    IF v_actor_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING ERRCODE = '42501';
    END IF;

    -- Chỉ cho phép nhân sự đang hoạt động có vai trò manager hoặc admin
    v_role := COALESCE(private.my_role(), '');
    IF v_role NOT IN ('manager', 'admin') THEN
        RAISE EXCEPTION 'Access denied: manager or admin role required'
            USING ERRCODE = '42501';
    END IF;

    -- Kiểm tra danh sách ID ca cần duyệt không rỗng và không chứa phần tử NULL
    IF p_shift_ids IS NULL OR COALESCE(cardinality(p_shift_ids), 0) = 0 THEN
        RAISE EXCEPTION 'p_shift_ids cannot be empty'
            USING ERRCODE = '22023';
    END IF;

    IF array_position(p_shift_ids, NULL) IS NOT NULL THEN
        RAISE EXCEPTION 'p_shift_ids cannot contain NULL'
            USING ERRCODE = '22023';
    END IF;

    -- Chuẩn hóa danh sách ID duy nhất theo thứ tự tăng dần
    SELECT array_agg(DISTINCT u.id ORDER BY u.id ASC)
    INTO v_target_ids
    FROM unnest(p_shift_ids) AS u(id);

    v_expected_count := COALESCE(cardinality(v_target_ids), 0);

    -- Nếu có truyền chi nhánh đích, kiểm tra chi nhánh tồn tại và quyền của manager trên chi nhánh đích
    IF p_branch_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1
            FROM public.branches b
            WHERE b.id = p_branch_id
        ) THEN
            RAISE EXCEPTION 'Target branch not found: %', p_branch_id
                USING ERRCODE = '23503';
        END IF;

        IF v_role = 'manager' AND NOT private.is_manager_of(p_branch_id) THEN
            RAISE EXCEPTION 'Access denied: manager is not authorized for target branch'
                USING ERRCODE = '42501';
        END IF;
    END IF;

    -- Khóa tất cả dòng shifts liên quan theo thứ tự id tăng dần để tránh deadlock
    FOR v_shift IN
        SELECT s.id, s.employee_id, s.branch_id, s.status
        FROM public.shifts s
        WHERE s.id = ANY(v_target_ids)
        ORDER BY s.id ASC
        FOR UPDATE
    LOOP
        v_locked_count := v_locked_count + 1;
    END LOOP;

    -- Đảm bảo tất cả ID được yêu cầu đều tồn tại (không duyệt một phần âm thầm)
    IF v_locked_count <> v_expected_count THEN
        RAISE EXCEPTION 'One or more shifts were not found'
            USING ERRCODE = 'P0002';
    END IF;

    -- Kiểm tra trạng thái pending và quyền hạn trên từng ca đã khóa theo thứ tự id
    FOR v_shift IN
        SELECT s.id, s.employee_id, s.branch_id, s.status
        FROM public.shifts s
        WHERE s.id = ANY(v_target_ids)
        ORDER BY s.id ASC
    LOOP
        IF v_shift.status <> 'pending' THEN
            RAISE EXCEPTION 'Shift % is not in pending status', v_shift.id
                USING ERRCODE = '22023';
        END IF;

        IF v_role = 'manager' THEN
            -- Manager không được tự duyệt ca của chính mình
            IF v_shift.employee_id = v_actor_id THEN
                RAISE EXCEPTION 'Access denied: manager cannot approve own shift'
                    USING ERRCODE = '42501';
            END IF;

            -- Manager phải có quyền quản lý chi nhánh nguồn của ca
            IF NOT private.is_manager_of(v_shift.branch_id) THEN
                RAISE EXCEPTION 'Access denied: manager is not authorized for source branch'
                    USING ERRCODE = '42501';
            END IF;
        END IF;
    END LOOP;

    -- Cập nhật trạng thái duyệt và chi nhánh (nếu p_branch_id khác NULL) trong cùng câu lệnh UPDATE.
    -- Trigger AFTER UPDATE trg_audit_shifts sẽ tự động ghi nhận thay đổi vào audit_log.
    UPDATE public.shifts s
    SET branch_id = COALESCE(p_branch_id, s.branch_id),
        status = 'approved',
        approved_by = v_actor_id,
        approved_at = v_now
    WHERE s.id = ANY(v_target_ids);
END;
$$;

-- Wrapper giữ tương thích cho các lời gọi approve_shifts(p_shift_ids) giữ nguyên chi nhánh hiện tại của ca.
CREATE OR REPLACE FUNCTION public.approve_shifts(p_shift_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
    PERFORM public.approve_shifts_at_branch(p_shift_ids, NULL);
END;
$$;

-- ============================================================================
-- 4. public.correct_punch
-- ============================================================================
CREATE OR REPLACE FUNCTION public.correct_punch(
    p_punch_id uuid,
    p_new_at timestamptz,
    p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
    v_old_punch public.punches%ROWTYPE;
    v_new_punch_id uuid;
    v_old_date date;
    v_new_date date;
    v_rec record;
BEGIN
    IF COALESCE(private.my_role(), '') NOT IN ('manager', 'admin') THEN
        RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    IF p_new_at IS NULL OR NULLIF(btrim(p_reason), '') IS NULL THEN
        RAISE EXCEPTION 'REASON_AND_TIME_REQUIRED' USING ERRCODE = '22023';
    END IF;

    SELECT *
    INTO v_old_punch
    FROM public.punches
    WHERE id = p_punch_id
      AND voided_at IS NULL;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'PUNCH_NOT_FOUND_OR_ALREADY_VOIDED' USING ERRCODE = 'P0002';
    END IF;

    -- Khoá theo thứ tự employee -> punch giống kiosk_punch để tránh deadlock và kiểm tra quyền RBAC.
    PERFORM 1
    FROM public.employees
    WHERE id = v_old_punch.employee_id
    FOR UPDATE;

    SELECT *
    INTO v_old_punch
    FROM public.punches
    WHERE id = p_punch_id
      AND voided_at IS NULL
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'PUNCH_NOT_FOUND_OR_ALREADY_VOIDED' USING ERRCODE = 'P0002';
    END IF;

    IF private.my_role() = 'manager' AND v_old_punch.employee_id = auth.uid() THEN
        RAISE EXCEPTION 'CANNOT_CORRECT_OWN_PUNCH' USING ERRCODE = '42501';
    END IF;

    IF NOT private.is_admin() AND NOT (v_old_punch.branch_id = ANY(private.my_branches())) THEN
        RAISE EXCEPTION 'FORBIDDEN_BRANCH' USING ERRCODE = '42501';
    END IF;

    -- Khóa FOR UPDATE các kỳ lương liên quan (cả tháng cũ và tháng mới theo thứ tự year, month tăng dần)
    -- trước khi kiểm tra trạng thái để serialize với approve_timesheet và tránh deadlock.
    v_old_date := (v_old_punch.at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
    v_new_date := (p_new_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;

    FOR v_rec IN
        SELECT pp.id, pp.year, pp.month, pp.status
        FROM public.payroll_periods pp
        WHERE (pp.year = EXTRACT(YEAR FROM v_old_date)::int AND pp.month = EXTRACT(MONTH FROM v_old_date)::int)
           OR (pp.year = EXTRACT(YEAR FROM v_new_date)::int AND pp.month = EXTRACT(MONTH FROM v_new_date)::int)
        ORDER BY pp.year ASC, pp.month ASC, pp.id ASC
        FOR UPDATE
    LOOP
        IF v_rec.status = 'approved' THEN
            RAISE EXCEPTION 'PERIOD_ALREADY_APPROVED' USING ERRCODE = 'P0001';
        END IF;
    END LOOP;

    UPDATE public.punches
    SET voided_at = now(),
        voided_by = auth.uid()
    WHERE id = p_punch_id;

    INSERT INTO public.punches (
        employee_id,
        device_id,
        branch_id,
        type,
        at,
        source,
        created_by,
        reason,
        corrects_punch_id
    ) VALUES (
        v_old_punch.employee_id,
        v_old_punch.device_id,
        v_old_punch.branch_id,
        v_old_punch.type,
        p_new_at,
        'manual',
        auth.uid(),
        btrim(p_reason),
        p_punch_id
    )
    RETURNING id INTO v_new_punch_id;

    INSERT INTO public.audit_log (table_name, row_id, action, old_data, new_data, actor_id, branch_id)
    VALUES ('punches', p_punch_id, 'correct_punch', row_to_json(v_old_punch),
            json_build_object('new_id', v_new_punch_id, 'new_at', p_new_at,
                              'reason', btrim(p_reason)),
            auth.uid(), v_old_punch.branch_id);

    RETURN v_new_punch_id;
END;
$$;

-- ============================================================================
-- 5. public.add_manual_punch / public.void_punch
-- ============================================================================
CREATE OR REPLACE FUNCTION public.add_manual_punch(
    p_employee_id uuid,
    p_branch_id uuid,
    p_type text,
    p_at timestamptz,
    p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
    v_employee public.employees%ROWTYPE;
    v_punch_id uuid;
    v_punch_date date;
    v_rec record;
BEGIN
    -- Kiểm tra RBAC, chi nhánh và khóa employee trước khi thêm punch thủ công.
    IF COALESCE(private.my_role(), '') NOT IN ('manager', 'admin') THEN
        RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    IF p_type IS NULL OR p_type NOT IN ('clock_in', 'break_start', 'break_end', 'clock_out')
       OR p_at IS NULL OR NULLIF(btrim(p_reason), '') IS NULL THEN
        RAISE EXCEPTION 'INVALID_MANUAL_PUNCH' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_employee
    FROM public.employees
    WHERE id = p_employee_id AND is_active = true
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'EMPLOYEE_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
    IF private.my_role() = 'manager'
       AND (p_employee_id = auth.uid() OR NOT (p_branch_id = ANY(private.my_branches()))) THEN
        RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.id = p_branch_id) THEN
        RAISE EXCEPTION 'BRANCH_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;

    -- Khóa FOR UPDATE kỳ lương liên quan trước khi kiểm tra trạng thái để serialize với approve_timesheet.
    v_punch_date := (p_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
    FOR v_rec IN
        SELECT pp.id, pp.year, pp.month, pp.status
        FROM public.payroll_periods pp
        WHERE pp.year = EXTRACT(YEAR FROM v_punch_date)::int
          AND pp.month = EXTRACT(MONTH FROM v_punch_date)::int
        ORDER BY pp.year ASC, pp.month ASC, pp.id ASC
        FOR UPDATE
    LOOP
        IF v_rec.status = 'approved' THEN
            RAISE EXCEPTION 'PERIOD_ALREADY_APPROVED' USING ERRCODE = 'P0001';
        END IF;
    END LOOP;

    INSERT INTO public.punches (
        employee_id, branch_id, type, at, source, created_by, reason
    ) VALUES (
        p_employee_id, p_branch_id, p_type, p_at, 'manual', auth.uid(), btrim(p_reason)
    ) RETURNING id INTO v_punch_id;

    INSERT INTO public.audit_log (table_name, row_id, action, new_data, actor_id, branch_id)
    VALUES ('punches', v_punch_id, 'add_manual_punch',
            json_build_object('employee_id', p_employee_id, 'type', p_type,
                              'at', p_at, 'reason', btrim(p_reason)),
            auth.uid(), p_branch_id);
    RETURN v_punch_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.void_punch(
    p_punch_id uuid,
    p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
    v_punch public.punches%ROWTYPE;
    v_punch_date date;
    v_rec record;
BEGIN
    IF COALESCE(private.my_role(), '') NOT IN ('manager', 'admin') THEN
        RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    IF NULLIF(btrim(p_reason), '') IS NULL THEN
        RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023';
    END IF;

    -- Giữ thứ tự khóa employee -> punch như kiosk_punch để tránh deadlock.
    SELECT * INTO v_punch
    FROM public.punches
    WHERE id = p_punch_id AND voided_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'PUNCH_NOT_FOUND_OR_ALREADY_VOIDED' USING ERRCODE = 'P0002';
    END IF;
    PERFORM 1 FROM public.employees WHERE id = v_punch.employee_id FOR UPDATE;
    SELECT * INTO v_punch
    FROM public.punches
    WHERE id = p_punch_id AND voided_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'PUNCH_NOT_FOUND_OR_ALREADY_VOIDED' USING ERRCODE = 'P0002';
    END IF;
    IF private.my_role() = 'manager'
       AND (v_punch.employee_id = auth.uid()
            OR NOT (v_punch.branch_id = ANY(private.my_branches()))) THEN
        RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
    END IF;

    -- Khóa FOR UPDATE kỳ lương liên quan trước khi kiểm tra trạng thái để serialize với approve_timesheet.
    v_punch_date := (v_punch.at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
    FOR v_rec IN
        SELECT pp.id, pp.year, pp.month, pp.status
        FROM public.payroll_periods pp
        WHERE pp.year = EXTRACT(YEAR FROM v_punch_date)::int
          AND pp.month = EXTRACT(MONTH FROM v_punch_date)::int
        ORDER BY pp.year ASC, pp.month ASC, pp.id ASC
        FOR UPDATE
    LOOP
        IF v_rec.status = 'approved' THEN
            RAISE EXCEPTION 'PERIOD_ALREADY_APPROVED' USING ERRCODE = 'P0001';
        END IF;
    END LOOP;

    UPDATE public.punches
    SET voided_at = clock_timestamp(), voided_by = auth.uid()
    WHERE id = p_punch_id;
    INSERT INTO public.audit_log (table_name, row_id, action, old_data, new_data, actor_id, branch_id)
    VALUES ('punches', p_punch_id, 'void_punch', row_to_json(v_punch),
            json_build_object('reason', btrim(p_reason)), auth.uid(), v_punch.branch_id);
END;
$$;

-- ============================================================================
-- 5. public.change_pin
-- ============================================================================
CREATE OR REPLACE FUNCTION public.change_pin(
    p_old_pin text,
    p_new_pin text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, extensions, pg_temp
AS $$
DECLARE
    v_uid uuid := auth.uid();
    v_pin_record record;
    v_failed_count int;
    v_lock_until timestamptz;
    v_now timestamptz;
BEGIN
    IF v_uid IS NULL THEN
        RETURN json_build_object(
            'ok', false,
            'error', 'UNAUTHORIZED'
        );
    END IF;

    IF p_new_pin IS NULL OR p_new_pin !~ '^[0-9]{4,6}$' THEN
        RAISE EXCEPTION 'INVALID_PIN' USING ERRCODE = '22023';
    END IF;

    -- Khóa dòng PIN, kiểm tra lockout và xác thực PIN cũ bằng bcrypt.
    SELECT pin_hash, COALESCE(pin_failed, 0) AS pin_failed, pin_lock_until
    INTO v_pin_record
    FROM public.employee_pins
    WHERE employee_id = v_uid
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN json_build_object(
            'ok', false,
            'error', 'EMPLOYEE_PIN_NOT_FOUND'
        );
    END IF;

    v_now := clock_timestamp();

    IF v_pin_record.pin_lock_until IS NOT NULL AND v_pin_record.pin_lock_until > v_now THEN
        RETURN json_build_object(
            'ok', false,
            'error', 'PIN_LOCKED',
            'unlock_at', v_pin_record.pin_lock_until
        );
    END IF;

    IF v_pin_record.pin_hash IS NULL OR extensions.crypt(p_old_pin, v_pin_record.pin_hash) <> v_pin_record.pin_hash THEN
        v_failed_count := CASE
            WHEN v_pin_record.pin_lock_until IS NOT NULL
             AND v_pin_record.pin_lock_until <= v_now THEN 1
            ELSE v_pin_record.pin_failed + 1
        END;
        v_lock_until := CASE
            WHEN v_failed_count >= 5 THEN v_now + interval '15 minutes'
            ELSE NULL
        END;

        UPDATE public.employee_pins
        SET pin_failed = v_failed_count,
            pin_lock_until = v_lock_until
        WHERE employee_id = v_uid;

        RETURN json_build_object(
            'ok', false,
            'error', 'WRONG_PIN'
        );
    END IF;

    -- Cập nhật hash PIN mới và xóa bộ đếm nhập sai.
    UPDATE public.employee_pins
    SET pin_hash = extensions.crypt(p_new_pin, extensions.gen_salt('bf')),
        pin_failed = 0,
        pin_lock_until = NULL
    WHERE employee_id = v_uid;

    RETURN json_build_object('ok', true);
END;
$$;

-- ============================================================================
-- 6. public.reset_pin
-- ============================================================================
CREATE OR REPLACE FUNCTION public.reset_pin(
    p_employee_id uuid,
    p_new_pin text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, extensions, pg_temp
AS $$
BEGIN
    -- Chỉ Admin được reset PIN; hash mới đồng thời mở khóa bộ đếm thất bại.
    IF NOT private.is_admin() THEN
        RETURN json_build_object(
            'ok', false,
            'error', 'FORBIDDEN'
        );
    END IF;

    IF p_new_pin IS NULL OR p_new_pin !~ '^[0-9]{4,6}$' THEN
        RAISE EXCEPTION 'INVALID_PIN' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.employee_pins (
        employee_id,
        pin_hash,
        pin_failed,
        pin_lock_until
    ) VALUES (
        p_employee_id,
        extensions.crypt(p_new_pin, extensions.gen_salt('bf')),
        0,
        NULL
    )
    ON CONFLICT (employee_id) DO UPDATE
    SET pin_hash = EXCLUDED.pin_hash,
        pin_failed = 0,
        pin_lock_until = NULL;

    RETURN json_build_object('ok', true);
END;
$$;

-- ============================================================================
-- 7. Device Pairing RPCs
-- ============================================================================
CREATE OR REPLACE FUNCTION public.new_pairing_code(
    p_code_hash text,
    p_branch_id uuid,
    p_device_name text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
    v_device_id uuid;
    v_pairing_id uuid;
    v_expires_at timestamptz := now() + interval '10 minutes';
BEGIN
    -- Admin tạo device chờ ghép nối; chỉ lưu hash mã pairing, hết hạn sau 10 phút.
    IF NOT private.is_admin() THEN
        RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
    END IF;

    INSERT INTO public.devices (branch_id, name, auth_user_id, revoked_at)
    VALUES (p_branch_id, p_device_name, NULL, NULL)
    RETURNING id INTO v_device_id;

    INSERT INTO public.device_pairings (code_hash, device_id, expires_at, used_at)
    VALUES (p_code_hash, v_device_id, v_expires_at, NULL)
    RETURNING id INTO v_pairing_id;

    RETURN json_build_object(
        'ok', true,
        'device_id', v_device_id,
        'pairing_id', v_pairing_id,
        'expires_at', v_expires_at
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.consume_pairing_code(
    p_code_hash text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
    v_uid uuid := auth.uid();
    v_pairing_id uuid;
    v_device_id uuid;
BEGIN
    -- Mã pairing dùng một lần; khóa SKIP LOCKED chống hai kiosk cùng tiêu thụ một mã.
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000';
    END IF;

    SELECT id, device_id
    INTO v_pairing_id, v_device_id
    FROM public.device_pairings
    WHERE code_hash = p_code_hash
      AND used_at IS NULL
      AND expires_at > now()
    FOR UPDATE SKIP LOCKED
    LIMIT 1;

    IF v_pairing_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_OR_EXPIRED_CODE' USING ERRCODE = 'P0002';
    END IF;

    UPDATE public.device_pairings
    SET used_at = now()
    WHERE id = v_pairing_id;

    UPDATE public.devices
    SET auth_user_id = v_uid
    WHERE id = v_device_id
      AND revoked_at IS NULL;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'DEVICE_REVOKED_OR_MISSING' USING ERRCODE = 'P0002';
    END IF;

    RETURN json_build_object(
        'ok', true,
        'device_id', v_device_id
    );
END;
$$;

-- ============================================================================
-- 8. Payroll Calculations (Block 15p, 48h/tuần, Tuần vắt tháng)
-- ============================================================================

-- Hàm kiểm tra tính hợp lệ nghiêm ngặt của chuỗi sự kiện chấm công (state machine)
-- cho từng nhân viên theo thứ tự thời gian:
--   clock_in -> 0 hoặc nhiều cặp (break_start -> break_end) -> clock_out.
-- Phát hiện mọi trường hợp:
--   - Sự kiện mồ côi đứng trước clock_in (session_no = 0) hoặc đứng sau clock_out trong cùng session
--   - Thiếu clock_out, hoặc có nhiều hơn 1 clock_out
--   - break_start lặp hoặc không được đóng bởi break_end liền kề, hoặc break_end không có break_start liền trước
--   - Hai sự kiện trùng hoặc lùi thời điểm (next_at <= at)
--   - Phiên kéo dài quá 24 giờ (clock_out > clock_in + 24h) hoặc các sự kiện vượt quá 24h kể từ clock_in
--   - Tổng số block nghỉ (làm tròn lên 15 phút mỗi lần nghỉ) vượt quá tổng số block làm việc đã làm tròn của ca (overdraw)
-- Chỉ xét các phiên bắt đầu trong khoảng [v_lookback_start, v_end) (bao gồm phần tuần vắt từ tháng trước
-- dùng để đếm ngưỡng 192 block = 48h/tuần và toàn bộ các phiên bắt đầu trong kỳ lương) cũng như các punch
-- mồ côi rơi vào khoảng này.
CREATE OR REPLACE FUNCTION private.fn_find_orphaned_punches(
    p_period_id uuid,
    p_employee_id uuid DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
    v_start          timestamptz;
    v_end            timestamptz;
    v_lookback_start timestamptz;
    v_orphans        json;
BEGIN
    SELECT make_timestamptz(pp.year, pp.month, 1, 0, 0, 0, 'Asia/Ho_Chi_Minh')
    INTO v_start
    FROM public.payroll_periods pp
    WHERE pp.id = p_period_id;

    IF v_start IS NULL THEN
        RAISE EXCEPTION 'PAYROLL_PERIOD_NOT_FOUND: %', p_period_id;
    END IF;

    v_end := v_start + interval '1 month';
    v_lookback_start := (date_trunc('week', v_start AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh');

    WITH events AS (
        -- Quét rộng hơn về trước 48h để nếu có clock_in hợp lệ bắt đầu trước v_lookback_start
        -- mà kéo dài sang v_lookback_start thì các sự kiện con của nó không bị hiểu nhầm là session_no = 0.
        SELECT p.employee_id,
               p.type::text AS type,
               p.at,
               p.id,
               SUM(CASE WHEN p.type = 'clock_in' THEN 1 ELSE 0 END)
                 OVER (PARTITION BY p.employee_id ORDER BY p.at, p.id) AS session_no
        FROM public.punches p
        WHERE p.voided_at IS NULL
          AND p.at >= v_lookback_start - interval '48 hours'
          AND p.at < v_end + interval '24 hours'
          AND (p_employee_id IS NULL OR p.employee_id = p_employee_id)
    ),
    ordered_events AS (
        SELECT e.*,
               ROW_NUMBER() OVER (PARTITION BY e.employee_id, e.session_no ORDER BY e.at, e.id) AS rn,
               COUNT(*) OVER (PARTITION BY e.employee_id, e.session_no) AS cnt,
               LAG(e.type) OVER (PARTITION BY e.employee_id, e.session_no ORDER BY e.at, e.id) AS prev_type,
               LAG(e.at) OVER (PARTITION BY e.employee_id, e.session_no ORDER BY e.at, e.id) AS prev_at,
               LEAD(e.type) OVER (PARTITION BY e.employee_id, e.session_no ORDER BY e.at, e.id) AS next_type,
               LEAD(e.at) OVER (PARTITION BY e.employee_id, e.session_no ORDER BY e.at, e.id) AS next_at
        FROM events e
    ),
    session_validation AS (
        SELECT
            oe.employee_id,
            oe.session_no,
            MIN(oe.at) FILTER (WHERE oe.type = 'clock_in') AS clock_in_at,
            MIN(oe.at) FILTER (WHERE oe.type = 'clock_out') AS clock_out_at,
            MAX(oe.at) AS last_event_at,
            (ARRAY_AGG(oe.type ORDER BY oe.at DESC, oe.id DESC))[1] AS last_event_type,
            MAX(oe.at) FILTER (WHERE oe.at >= v_lookback_start AND oe.at < v_end) AS last_in_window_at,
            (ARRAY_AGG(oe.type ORDER BY oe.at DESC, oe.id DESC)
                FILTER (WHERE oe.at >= v_lookback_start AND oe.at < v_end))[1] AS last_in_window_type,
            COUNT(*) AS event_count,
            COUNT(*) FILTER (WHERE oe.type = 'clock_in') AS clock_in_count,
            COUNT(*) FILTER (WHERE oe.type = 'clock_out') AS clock_out_count,
            -- Kiểm tra từng bước chuyển trạng thái hợp lệ trong một phiên có clock_in (session_no > 0)
            BOOL_AND(
                CASE
                    WHEN oe.session_no = 0 THEN false
                    WHEN oe.rn = 1 THEN
                        oe.type = 'clock_in'
                        AND oe.next_type IN ('break_start', 'clock_out')
                        AND oe.next_at > oe.at
                    WHEN oe.rn = oe.cnt THEN
                        oe.type = 'clock_out'
                        AND oe.prev_type IN ('clock_in', 'break_end')
                        AND oe.at > oe.prev_at
                    WHEN oe.type = 'break_start' THEN
                        oe.prev_type IN ('clock_in', 'break_end')
                        AND oe.next_type = 'break_end'
                        AND oe.at > oe.prev_at
                        AND oe.next_at > oe.at
                    WHEN oe.type = 'break_end' THEN
                        oe.prev_type = 'break_start'
                        AND oe.next_type IN ('break_start', 'clock_out')
                        AND oe.at > oe.prev_at
                        AND oe.next_at > oe.at
                    ELSE false
                END
            ) AS transitions_valid,
            COALESCE(SUM(
                CASE
                    WHEN oe.type = 'break_start' AND oe.next_type = 'break_end' AND oe.next_at > oe.at
                    THEN CEIL(EXTRACT(EPOCH FROM (oe.next_at - oe.at)) / 900.0)::int
                    ELSE 0
                END
            ), 0)::int AS total_break_blocks
        FROM ordered_events oe
        GROUP BY oe.employee_id, oe.session_no
    ),
    invalid_sessions AS (
        SELECT
            sv.employee_id,
            sv.session_no,
            CASE WHEN sv.session_no = 0 THEN sv.last_in_window_type ELSE sv.last_event_type END AS report_type,
            CASE WHEN sv.session_no = 0 THEN sv.last_in_window_at   ELSE sv.last_event_at   END AS report_at
        FROM session_validation sv
        WHERE
            -- 1. Các punch mồ côi xuất hiện trước bất kỳ clock_in nào nhưng nằm trong cửa sổ kiểm tra [v_lookback_start, v_end)
            (sv.session_no = 0 AND sv.last_in_window_at IS NOT NULL)
            OR
            -- 2. Phiên bắt đầu trong cửa sổ [v_lookback_start, v_end) nhưng vi phạm quy tắc chuỗi hoặc thời lượng
            (
                sv.session_no > 0
                AND sv.clock_in_at >= v_lookback_start
                AND sv.clock_in_at < v_end
                AND (
                    NOT sv.transitions_valid
                    OR sv.event_count < 2
                    OR sv.clock_in_count <> 1
                    OR sv.clock_out_count <> 1
                    OR sv.clock_out_at IS NULL
                    OR sv.clock_out_at <= sv.clock_in_at
                    OR sv.clock_out_at > sv.clock_in_at + interval '24 hours'
                    OR sv.last_event_at > sv.clock_in_at + interval '24 hours'
                    -- Chặn overdraw: tổng số block nghỉ (làm tròn lên 15m) không được vượt quá tổng số block ca làm việc đã làm tròn
                    OR sv.total_break_blocks > GREATEST(
                        0,
                         FLOOR(
                            EXTRACT(
                                EPOCH FROM (
                                    date_bin('15 minutes', sv.clock_out_at, timestamptz '2000-01-01 00:00:00+00')
                                    - CASE
                                        WHEN sv.clock_in_at - date_bin('15 minutes', sv.clock_in_at, timestamptz '2000-01-01 00:00:00+00') < interval '2 minutes'
                                        THEN date_bin('15 minutes', sv.clock_in_at, timestamptz '2000-01-01 00:00:00+00')
                                        ELSE date_bin('15 minutes', sv.clock_in_at, timestamptz '2000-01-01 00:00:00+00') + interval '15 minutes'
                                      END
                                )
                            ) / 900.0
                        )::int
                    )
                )
            )
            OR
            -- 3. Phiên bắt đầu trước v_lookback_start nhưng có sự kiện mồ côi (sau clock_out hoặc quá 24h) tràn vào [v_lookback_start, v_end)
            (
                sv.session_no > 0
                AND sv.clock_in_at < v_lookback_start
                AND sv.last_in_window_at IS NOT NULL
                AND (
                    NOT sv.transitions_valid
                    OR sv.clock_out_count <> 1
                    OR sv.last_event_at > sv.clock_in_at + interval '24 hours'
                )
            )
    )
    SELECT json_agg(
               json_build_object(
                   'employee_id', i.employee_id,
                   'employee_code', e.employee_code,
                   'full_name', e.full_name,
                   'last_type', i.report_type,
                   'last_punch_at', i.report_at
               )
               ORDER BY e.employee_code, i.report_at
           )
    INTO v_orphans
    FROM invalid_sessions i
    JOIN public.employees e ON e.id = i.employee_id;

    RETURN v_orphans;
END;
$$;

-- Xóa hàm cũ trước khi định nghĩa lại do thay đổi cấu trúc cột trả về (TABLE OUT signature).
DROP FUNCTION IF EXISTS public.fn_calculate_payroll_base(uuid, uuid);

-- Nguồn chân lý duy nhất (Single Source of Truth) cho toàn bộ tính toán bảng lương,
-- phân loại từng block 15 phút, tổng hợp phụ cấp và xuất chi tiết minh bạch (block_details)
-- phục vụ cả màn Preview lẫn chốt kỳ lương (approve_timesheet).
-- Nguyên tắc gán kỳ và tuần:
--   1. Mọi thời điểm đều quy chiếu theo múi giờ 'Asia/Ho_Chi_Minh'.
--   2. Phiên làm việc (session) có clock_in thuộc tuần nào (bắt đầu Thứ Hai 00:00 giờ VN)
--      thì toàn bộ các block của phiên đó thuộc về tuần đó khi đếm ngưỡng 192 block (48h).
--   3. Phiên có clock_in thuộc tháng/kỳ nào thì toàn bộ giờ công được trả lương ở kỳ đó
--      (in_target_period = true). Các phiên thuộc phần tuần vắt từ tháng trước sang đầu tháng này
--      chỉ tham gia đếm tích lũy ngưỡng 192 block/tuần, tuyệt đối không được trả lại hay xuất
--      vào block_details của kỳ mới.
CREATE OR REPLACE FUNCTION public.fn_calculate_payroll_base(
    p_period_id uuid,
    p_employee_id uuid DEFAULT NULL
)
RETURNS TABLE (
    employee_id uuid,
    hourly_rate_snapshot numeric,
    fixed_allowance_snapshot numeric,
    minutes_regular_day int,
    minutes_regular_night int,
    minutes_ot_day int,
    minutes_ot_night int,
    minutes_holiday_day int,
    minutes_holiday_night int,
    hourly_pay_subtotal numeric,
    total_allowance numeric,
    total_salary numeric,
    block_details jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
    v_start          timestamptz;
    v_end            timestamptz;
    v_lookback_start timestamptz;
    v_orphans        json;
BEGIN
    SELECT make_timestamptz(pp.year, pp.month, 1, 0, 0, 0, 'Asia/Ho_Chi_Minh')
    INTO v_start
    FROM public.payroll_periods pp
    WHERE pp.id = p_period_id;

    IF v_start IS NULL THEN
        RAISE EXCEPTION 'PAYROLL_PERIOD_NOT_FOUND: %', p_period_id;
    END IF;

    v_end := v_start + interval '1 month';

    -- Lùi về Thứ Hai 00:00 (giờ VN) của tuần chứa ngày đầu tháng để đếm đủ 48h cho tuần vắt 2 tháng
    v_lookback_start := (date_trunc('week', v_start AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh');

    -- Bắt buộc kiểm tra chuỗi chấm công hợp lệ trước khi tính công; từ chối tính âm thầm nếu có punch lỗi/mồ côi.
    v_orphans := private.fn_find_orphaned_punches(p_period_id, p_employee_id);
    IF v_orphans IS NOT NULL THEN
        RAISE EXCEPTION 'ORPHANED_PUNCHES'
            USING ERRCODE = 'P0001', DETAIL = v_orphans::text;
    END IF;

    RETURN QUERY
    WITH events AS (
        SELECT p.employee_id, p.type, p.at, p.id,
               SUM(CASE WHEN p.type = 'clock_in' THEN 1 ELSE 0 END)
                 OVER (PARTITION BY p.employee_id ORDER BY p.at, p.id) AS session_no
        FROM public.punches p
        WHERE p.voided_at IS NULL
          -- Mở rộng biên để thu thập trọn vẹn các phiên hợp lệ quanh ranh giới tuần vắt và cuối kỳ
          AND p.at >= v_lookback_start - interval '48 hours'
          AND p.at < v_end + interval '24 hours'
          AND (p_employee_id IS NULL OR p.employee_id = p_employee_id)
    ),
    ordered_events AS (
        SELECT e.*,
               ROW_NUMBER() OVER (PARTITION BY e.employee_id, e.session_no ORDER BY e.at, e.id) AS rn,
               COUNT(*) OVER (PARTITION BY e.employee_id, e.session_no) AS cnt,
               LEAD(e.type) OVER (PARTITION BY e.employee_id, e.session_no ORDER BY e.at, e.id) AS next_type,
               LEAD(e.at) OVER (PARTITION BY e.employee_id, e.session_no ORDER BY e.at, e.id) AS next_at
        FROM events e
    ),
    -- Danh sách từng khoảng nghỉ kèm thời lượng làm tròn lên 15 phút và tâm điểm thực tế của kỳ nghỉ
    raw_breaks AS (
        SELECT
            oe.employee_id,
            oe.session_no,
            ROW_NUMBER() OVER (PARTITION BY oe.employee_id, oe.session_no ORDER BY oe.at, oe.id)::int AS break_no,
            oe.at AS break_start_at,
            oe.next_at AS break_end_at,
            CEIL(EXTRACT(EPOCH FROM (oe.next_at - oe.at)) / 900.0)::int AS break_blocks,
            date_bin('15 minutes', oe.at, timestamptz '2000-01-01 00:00:00+00') AS break_grid_start,
            date_bin('15 minutes', oe.at, timestamptz '2000-01-01 00:00:00+00')
              + (CEIL(EXTRACT(EPOCH FROM (oe.next_at - oe.at)) / 900.0) * interval '15 minutes') AS break_grid_end
        FROM ordered_events oe
        WHERE oe.session_no > 0
          AND oe.type = 'break_start'
          AND oe.next_type = 'break_end'
          AND oe.next_at > oe.at
    ),
    -- Trải phẳng từng đơn vị block nghỉ (1..break_blocks) theo thứ tự thời gian thực tế:
    -- mỗi đơn vị thứ k có mốc mục tiêu (target_block_start) đặt tại break_grid_start + (k - 1)*15 phút,
    -- giúp định vị chính xác từng block 15 phút cần khấu trừ ngay tại thời điểm nghỉ mà không
    -- làm tất cả các block ngoài khung nghỉ bị đồng hạng khoảng cách.
    break_units AS (
        SELECT
            rb.employee_id,
            rb.session_no,
            ROW_NUMBER() OVER (
                PARTITION BY rb.employee_id, rb.session_no
                ORDER BY rb.break_no ASC, u.k ASC
            )::int AS unit_idx,
            rb.break_grid_start + ((u.k - 1) * interval '15 minutes') AS target_block_start,
            rb.break_start_at + ((rb.break_end_at - rb.break_start_at) / 2.0) AS break_midpoint
        FROM raw_breaks rb
        CROSS JOIN LATERAL generate_series(1, rb.break_blocks) AS u(k)
    ),
    session_summary AS (
        SELECT
            oe.employee_id,
            oe.session_no,
            MIN(oe.at) FILTER (WHERE oe.rn = 1 AND oe.type = 'clock_in') AS raw_in_at,
            MIN(oe.at) FILTER (WHERE oe.rn = oe.cnt AND oe.type = 'clock_out') AS raw_out_at,
            COUNT(*) FILTER (WHERE oe.type = 'clock_in') AS clock_in_count,
            COUNT(*) FILTER (WHERE oe.type = 'clock_out') AS clock_out_count,
            COALESCE(SUM(
                CASE WHEN oe.type = 'break_start' AND oe.next_type = 'break_end' AND oe.next_at > oe.at
                     THEN CEIL(EXTRACT(EPOCH FROM (oe.next_at - oe.at)) / 900.0)::int
                     ELSE 0 END
            ), 0)::int AS total_break_blocks
        FROM ordered_events oe
        WHERE oe.session_no > 0
        GROUP BY oe.employee_id, oe.session_no
    ),
    -- Làm tròn giờ vào/ra theo lưới 15 phút; giữ grace period 2 phút đầu block khi vào ca
    rounded_sessions AS (
        SELECT
            ss.employee_id,
            ss.session_no,
            ss.raw_in_at,
            ss.raw_out_at,
            CASE
                WHEN ss.raw_in_at - date_bin('15 minutes', ss.raw_in_at, timestamptz '2000-01-01 00:00:00+00')
                         < interval '2 minutes'
                THEN date_bin('15 minutes', ss.raw_in_at, timestamptz '2000-01-01 00:00:00+00')
                ELSE date_bin('15 minutes', ss.raw_in_at, timestamptz '2000-01-01 00:00:00+00') + interval '15 minutes'
            END AS rounded_in_at,
            date_bin('15 minutes', ss.raw_out_at, timestamptz '2000-01-01 00:00:00+00') AS rounded_out_at,
            ss.total_break_blocks,
            -- Mục 9.3: Toàn bộ phiên làm thuộc tuần chứa giờ clock_in (Thứ Hai 00:00 giờ VN)
            date_trunc('week', ss.raw_in_at AT TIME ZONE 'Asia/Ho_Chi_Minh') AS week_start_vn,
            to_char(ss.raw_in_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM') AS session_started_month,
            -- Phiên bắt đầu ở tháng nào thì toàn bộ giờ công được trả ở kỳ đó;
            -- phiên thuộc phần tuần vắt từ tháng trước chỉ dùng để đếm ngưỡng 192 block (48h)
            (ss.raw_in_at >= v_start AND ss.raw_in_at < v_end) AS in_target_period,
            -- Đánh dấu ca vắt qua ranh giới tháng (clock_in và clock_out khác tháng theo giờ VN)
            (
                date_trunc('month', ss.raw_in_at AT TIME ZONE 'Asia/Ho_Chi_Minh')
                <> date_trunc('month', ss.raw_out_at AT TIME ZONE 'Asia/Ho_Chi_Minh')
            ) AS is_cross_month
        FROM session_summary ss
        WHERE ss.raw_in_at >= v_lookback_start
          AND ss.raw_in_at < v_end
          AND ss.raw_out_at IS NOT NULL
          AND ss.clock_in_count = 1
          AND ss.clock_out_count = 1
          AND ss.raw_out_at > ss.raw_in_at
          AND ss.raw_out_at <= ss.raw_in_at + interval '24 hours'
    ),
    -- Tách phiên làm việc thành từng block 15 phút
    session_blocks_raw AS (
        SELECT
            rs.employee_id,
            rs.session_no,
            rs.raw_in_at,
            rs.raw_out_at,
            rs.rounded_in_at,
            rs.rounded_out_at,
            rs.week_start_vn,
            rs.session_started_month,
            rs.in_target_period,
            rs.is_cross_month,
            rs.total_break_blocks,
            gs.block_start
        FROM rounded_sessions rs
        CROSS JOIN LATERAL generate_series(
            rs.rounded_in_at,
            rs.rounded_out_at - interval '15 minutes',
            interval '15 minutes'
        ) AS gs(block_start)
        WHERE rs.rounded_out_at > rs.rounded_in_at
    ),
    -- Phân bổ khấu trừ block nghỉ hoàn toàn tất định (deterministic):
    -- Sử dụng đệ quy theo từng đơn vị nghỉ (unit_idx = 1..total_break_blocks).
    -- Tại mỗi bước, chọn duy nhất 1 block làm việc chưa bị trừ có khoảng cách thời gian tuyệt đối
    -- gần nhất với target_block_start của đơn vị nghỉ đó; nếu có 2 block cách đều target_block_start,
    -- ưu tiên block có tâm (block_start + 7.5 phút) gần tâm thực tế của kỳ nghỉ (break_midpoint) hơn,
    -- rồi mới đến block_start tăng dần. Không bao giờ nhảy cóc sang cuối ca (như ca đêm/ngày lễ ở xa).
    break_removal_step AS (
        WITH RECURSIVE picked AS (
            SELECT
                bu.employee_id,
                bu.session_no,
                bu.unit_idx,
                (
                    SELECT sbr.block_start
                    FROM session_blocks_raw sbr
                    WHERE sbr.employee_id = bu.employee_id
                      AND sbr.session_no = bu.session_no
                    ORDER BY
                        ABS(EXTRACT(EPOCH FROM (sbr.block_start - bu.target_block_start))) ASC,
                        ABS(EXTRACT(EPOCH FROM ((sbr.block_start + interval '7 minutes 30 seconds') - bu.break_midpoint))) ASC,
                        sbr.block_start ASC
                    LIMIT 1
                ) AS removed_block_start,
                ARRAY[
                    (
                        SELECT sbr.block_start
                        FROM session_blocks_raw sbr
                        WHERE sbr.employee_id = bu.employee_id
                          AND sbr.session_no = bu.session_no
                        ORDER BY
                            ABS(EXTRACT(EPOCH FROM (sbr.block_start - bu.target_block_start))) ASC,
                            ABS(EXTRACT(EPOCH FROM ((sbr.block_start + interval '7 minutes 30 seconds') - bu.break_midpoint))) ASC,
                            sbr.block_start ASC
                        LIMIT 1
                    )
                ]::timestamptz[] AS removed_list
            FROM break_units bu
            WHERE bu.unit_idx = 1

            UNION ALL

            SELECT
                bu.employee_id,
                bu.session_no,
                bu.unit_idx,
                next_pick.block_start AS removed_block_start,
                p.removed_list || next_pick.block_start
            FROM picked p
            JOIN break_units bu
              ON bu.employee_id = p.employee_id
             AND bu.session_no = p.session_no
             AND bu.unit_idx = p.unit_idx + 1
            CROSS JOIN LATERAL (
                SELECT sbr.block_start
                FROM session_blocks_raw sbr
                WHERE sbr.employee_id = bu.employee_id
                  AND sbr.session_no = bu.session_no
                  AND NOT (sbr.block_start = ANY(p.removed_list))
                ORDER BY
                    ABS(EXTRACT(EPOCH FROM (sbr.block_start - bu.target_block_start))) ASC,
                    ABS(EXTRACT(EPOCH FROM ((sbr.block_start + interval '7 minutes 30 seconds') - bu.break_midpoint))) ASC,
                    sbr.block_start ASC
                LIMIT 1
            ) next_pick
        )
        SELECT p.employee_id, p.session_no, p.removed_block_start
        FROM picked p
        WHERE p.removed_block_start IS NOT NULL
    ),
    -- Loại bỏ đúng các block đã được đánh dấu nghỉ (chỉ giữ lại các block còn được trả lương)
    active_blocks AS (
        SELECT
            sbr.employee_id,
            sbr.session_no,
            sbr.raw_in_at,
            sbr.raw_out_at,
            sbr.rounded_in_at,
            sbr.rounded_out_at,
            sbr.week_start_vn,
            sbr.session_started_month,
            sbr.in_target_period,
            sbr.is_cross_month,
            sbr.total_break_blocks,
            sbr.block_start,
            (h.date IS NOT NULL) AS is_holiday,
            (
                EXTRACT(HOUR FROM (sbr.block_start AT TIME ZONE 'Asia/Ho_Chi_Minh')) >= 22
                OR EXTRACT(HOUR FROM (sbr.block_start AT TIME ZONE 'Asia/Ho_Chi_Minh')) < 6
            ) AS is_night
        FROM session_blocks_raw sbr
        LEFT JOIN break_removal_step brs
            ON brs.employee_id = sbr.employee_id
           AND brs.session_no = sbr.session_no
           AND brs.removed_block_start = sbr.block_start
        LEFT JOIN public.holidays h
            ON h.date = (sbr.block_start AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
        WHERE brs.removed_block_start IS NULL
    ),
    -- Đếm thứ tự block không phải ngày lễ trong từng tuần (192 block đầu = thường, từ 193 = OT)
    classified_blocks AS (
        SELECT
            ab.*,
            CASE
                WHEN NOT ab.is_holiday THEN
                    ROW_NUMBER() OVER (
                        PARTITION BY ab.employee_id, ab.week_start_vn, ab.is_holiday
                        ORDER BY ab.block_start, ab.session_no
                    )
                ELSE NULL
            END AS weekly_regular_seq
        FROM active_blocks ab
    ),
    -- Gán nhãn bucket duy nhất cho từng block để dùng chung cho cả tổng số phút (summary) và chi tiết (block_details)
    labeled_blocks AS (
        SELECT
            cb.*,
            CASE
                WHEN cb.is_holiday AND NOT cb.is_night THEN 'holiday_day'
                WHEN cb.is_holiday AND cb.is_night     THEN 'holiday_night'
                WHEN cb.weekly_regular_seq <= 192 AND NOT cb.is_night THEN 'regular_day'
                WHEN cb.weekly_regular_seq <= 192 AND cb.is_night     THEN 'regular_night'
                WHEN cb.weekly_regular_seq > 192  AND NOT cb.is_night THEN 'ot_day'
                ELSE 'ot_night'
            END AS bucket
        FROM classified_blocks cb
    ),
    -- Chỉ tổng hợp số phút và danh sách chi tiết của các phiên thuộc tháng đang tính (in_target_period = true)
    summary AS (
        SELECT
            lb.employee_id,
            (COUNT(*) FILTER (WHERE lb.bucket = 'regular_day')   * 15)::int AS reg_day,
            (COUNT(*) FILTER (WHERE lb.bucket = 'regular_night') * 15)::int AS reg_night,
            (COUNT(*) FILTER (WHERE lb.bucket = 'ot_day')        * 15)::int AS ot_day,
            (COUNT(*) FILTER (WHERE lb.bucket = 'ot_night')      * 15)::int AS ot_night,
            (COUNT(*) FILTER (WHERE lb.bucket = 'holiday_day')   * 15)::int AS hol_day,
            (COUNT(*) FILTER (WHERE lb.bucket = 'holiday_night') * 15)::int AS hol_night,
            COALESCE(
                jsonb_agg(
                    jsonb_build_object(
                        'session_no', lb.session_no,
                        'block_start', lb.block_start,
                        'block_start_vn', to_char(lb.block_start AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD"T"HH24:MI:SS'),
                        'weekly_start_vn', to_char(lb.week_start_vn, 'YYYY-MM-DD"T"HH24:MI:SS'),
                        'minutes', 15,
                        'bucket', lb.bucket,
                        'weekly_regular_seq', lb.weekly_regular_seq,
                        'is_cross_month', lb.is_cross_month,
                        'session_started_month', lb.session_started_month,
                        'session_clock_in', lb.raw_in_at,
                        'session_clock_out', lb.raw_out_at,
                        'session_rounded_in', lb.rounded_in_at,
                        'session_rounded_out', lb.rounded_out_at,
                        'break_blocks', lb.total_break_blocks,
                        'break_minutes', lb.total_break_blocks * 15
                    )
                    ORDER BY lb.block_start ASC, lb.session_no ASC
                ),
                '[]'::jsonb
            ) AS block_details
        FROM labeled_blocks lb
        WHERE lb.in_target_period = true
        GROUP BY lb.employee_id
    ),
    allowances AS (
        SELECT ma.employee_id, SUM(ma.amount) AS total_amount
        FROM public.monthly_allowances ma
        WHERE ma.period_id = p_period_id
          AND (p_employee_id IS NULL OR ma.employee_id = p_employee_id)
        GROUP BY ma.employee_id
    ),
    calculated AS (
        SELECT
            e.id AS employee_id,
            COALESCE(e.hourly_rate, 0) AS hourly_rate_snapshot,
            COALESCE(e.fixed_allowance, 0) AS fixed_allowance_snapshot,
            COALESCE(s.reg_day, 0)::int AS minutes_regular_day,
            COALESCE(s.reg_night, 0)::int AS minutes_regular_night,
            COALESCE(s.ot_day, 0)::int AS minutes_ot_day,
            COALESCE(s.ot_night, 0)::int AS minutes_ot_night,
            COALESCE(s.hol_day, 0)::int AS minutes_holiday_day,
            COALESCE(s.hol_night, 0)::int AS minutes_holiday_night,
            (
                (COALESCE(s.reg_day, 0) / 60.0 * 1.0) +
                (COALESCE(s.reg_night, 0) / 60.0 * 1.3) +
                (COALESCE(s.ot_day, 0) / 60.0 * 1.5) +
                (COALESCE(s.ot_night, 0) / 60.0 * 1.8) +
                (COALESCE(s.hol_day, 0) / 60.0 * 2.0) +
                (COALESCE(s.hol_night, 0) / 60.0 * 2.3)
            ) * COALESCE(e.hourly_rate, 0) AS raw_hourly_pay,
            ROUND(
                (
                    (COALESCE(s.reg_day, 0) / 60.0 * 1.0) +
                    (COALESCE(s.reg_night, 0) / 60.0 * 1.3) +
                    (COALESCE(s.ot_day, 0) / 60.0 * 1.5) +
                    (COALESCE(s.ot_night, 0) / 60.0 * 1.8) +
                    (COALESCE(s.hol_day, 0) / 60.0 * 2.0) +
                    (COALESCE(s.hol_night, 0) / 60.0 * 2.3)
                ) * COALESCE(e.hourly_rate, 0),
                0
            ) AS hourly_pay_subtotal,
            COALESCE(al.total_amount, 0) AS total_allowance,
            COALESCE(s.block_details, '[]'::jsonb) AS block_details
        FROM public.employees e
        LEFT JOIN summary s ON s.employee_id = e.id
        LEFT JOIN allowances al ON al.employee_id = e.id
        WHERE (p_employee_id IS NULL OR e.id = p_employee_id)
          AND (s.employee_id IS NOT NULL OR al.employee_id IS NOT NULL OR e.fixed_allowance > 0)
    )
    SELECT
        c.employee_id,
        c.hourly_rate_snapshot,
        c.fixed_allowance_snapshot,
        c.minutes_regular_day,
        c.minutes_regular_night,
        c.minutes_ot_day,
        c.minutes_ot_night,
        c.minutes_holiday_day,
        c.minutes_holiday_night,
        c.hourly_pay_subtotal,
        c.total_allowance,
        ROUND(
            c.raw_hourly_pay
            + c.fixed_allowance_snapshot
            + c.total_allowance,
            0
        ) AS total_salary,
        c.block_details
    FROM calculated c;
END;
$$;

CREATE OR REPLACE FUNCTION public.preview_timesheet(
    p_period_id uuid,
    p_employee_id uuid DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
    v_result json;
BEGIN
    -- Nhân viên chỉ xem preview (gồm cả block_details) của chính mình; Admin được xem toàn bộ kỳ lương.
    -- Khi Admin gọi overview (p_employee_id IS NULL), lược bỏ block_details để giữ payload nhẹ (lazy-load).
    IF NOT private.is_admin()
       AND p_employee_id IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
    END IF;

    SELECT COALESCE(
        jsonb_agg(
            CASE
                WHEN p_employee_id IS NULL THEN to_jsonb(t) - 'block_details'
                ELSE to_jsonb(t)
            END
        )::json,
        '[]'::json
    )
    INTO v_result
    FROM public.fn_calculate_payroll_base(p_period_id, p_employee_id) t;
    RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_timesheet(p_period_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
    v_status text;
    v_orphans json;
BEGIN
    -- Khóa kỳ trước khi chốt và chặn mọi session orphan trước khi ghi payroll.
    IF NOT private.is_admin() THEN
        RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
    END IF;

    SELECT status
    INTO v_status
    FROM public.payroll_periods
    WHERE id = p_period_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'PERIOD_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;

    IF v_status = 'approved' THEN
        RAISE EXCEPTION 'PERIOD_ALREADY_APPROVED' USING ERRCODE = 'P0001';
    END IF;

    -- Kiểm tra toàn bộ chuỗi sự kiện chấm công trong kỳ và phần tuần vắt đầu tháng bằng bộ kiểm tra nghiêm ngặt.
    -- Danh sách trả trong DETAIL để UI hiển thị đúng người cần sửa.
    v_orphans := private.fn_find_orphaned_punches(p_period_id, NULL);

    IF v_orphans IS NOT NULL THEN
        RAISE EXCEPTION 'ORPHANED_PUNCHES'
            USING ERRCODE = 'P0001', DETAIL = v_orphans::text;
    END IF;

    -- Snapshot đơn giá/phụ cấp vào bảng persistent public.payroll (chỉ chọn các cột lưu trữ, bỏ qua hourly_pay_subtotal và block_details)
    -- và chuyển kỳ sang approved.
    INSERT INTO public.payroll (
        period_id,
        employee_id,
        hourly_rate_snapshot,
        fixed_allowance_snapshot,
        minutes_regular_day,
        minutes_regular_night,
        minutes_ot_day,
        minutes_ot_night,
        minutes_holiday_day,
        minutes_holiday_night,
        total_allowance,
        total_salary,
        calculated_at
    )
    SELECT
        p_period_id,
        calc.employee_id,
        calc.hourly_rate_snapshot,
        calc.fixed_allowance_snapshot,
        calc.minutes_regular_day,
        calc.minutes_regular_night,
        calc.minutes_ot_day,
        calc.minutes_ot_night,
        calc.minutes_holiday_day,
        calc.minutes_holiday_night,
        calc.total_allowance,
        calc.total_salary,
        now()
    FROM public.fn_calculate_payroll_base(p_period_id, NULL) AS calc
    ON CONFLICT (period_id, employee_id)
    DO UPDATE SET
        hourly_rate_snapshot     = EXCLUDED.hourly_rate_snapshot,
        fixed_allowance_snapshot  = EXCLUDED.fixed_allowance_snapshot,
        minutes_regular_day      = EXCLUDED.minutes_regular_day,
        minutes_regular_night    = EXCLUDED.minutes_regular_night,
        minutes_ot_day           = EXCLUDED.minutes_ot_day,
        minutes_ot_night         = EXCLUDED.minutes_ot_night,
        minutes_holiday_day      = EXCLUDED.minutes_holiday_day,
        minutes_holiday_night    = EXCLUDED.minutes_holiday_night,
        total_allowance          = EXCLUDED.total_allowance,
        total_salary             = EXCLUDED.total_salary,
        calculated_at            = now();

    UPDATE public.payroll_periods
    SET status = 'approved',
        approved_by = auth.uid(),
        approved_at = now()
    WHERE id = p_period_id;
END;
$$;

-- ============================================================================
-- 9. Atomic employee profile + PIN creation
-- ============================================================================
-- Worker tạo auth.users trước rồi gọi RPC này; hai bản ghi DB commit/rollback
-- cùng transaction, còn Worker bù trừ auth.users nếu RPC hoặc mạng thất bại.
CREATE OR REPLACE FUNCTION public.admin_create_employee_with_pin(
    p_id uuid,
    p_employee_code text,
    p_full_name text,
    p_role text,
    p_hourly_rate numeric,
    p_fixed_allowance numeric,
    p_pin text,
    p_home_branch_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, extensions, pg_temp
AS $$
BEGIN
    -- Kiểm tra quyền: chỉ cho phép gọi từ service_role (Worker) hoặc Admin.
    IF auth.role() <> 'service_role' AND NOT private.is_admin() THEN
        RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
    END IF;

    -- Chỉ cho phép tạo nhân sự với vai trò 'employee' hoặc 'manager' qua RPC (kể cả khi caller là service_role).
    -- Tài khoản 'admin' chỉ được tạo thủ công trực tiếp trên Supabase.
    IF p_role IS NULL OR p_role NOT IN ('employee', 'manager') THEN
        RAISE EXCEPTION 'INVALID_EMPLOYEE_ROLE' USING ERRCODE = '22023';
    END IF;

    -- Xác thực định dạng mã nhân viên: chuỗi số từ 4 đến 6 chữ số và không bắt đầu bằng 0.
    IF p_employee_code IS NULL OR btrim(p_employee_code) !~ '^[1-9][0-9]{3,5}$' THEN
        RAISE EXCEPTION 'INVALID_EMPLOYEE_CODE' USING ERRCODE = '22023';
    END IF;

    -- Xác thực định dạng mã PIN từ 4 đến 6 chữ số.
    IF p_pin IS NULL OR p_pin !~ '^[0-9]{4,6}$' THEN
        RAISE EXCEPTION 'INVALID_PIN' USING ERRCODE = '22023';
    END IF;

    -- Lưu hồ sơ nhân viên cùng chi nhánh chính (nếu có) trong cùng giao dịch với bảng PIN.
    INSERT INTO public.employees (
        id, employee_code, full_name, role, hourly_rate, fixed_allowance, is_active, home_branch_id
    ) VALUES (
        p_id, btrim(p_employee_code), p_full_name, p_role, p_hourly_rate,
        COALESCE(p_fixed_allowance, 0), true, p_home_branch_id
    );

    INSERT INTO public.employee_pins (
        employee_id, pin_hash, pin_failed, pin_lock_until
    ) VALUES (
        p_id, extensions.crypt(p_pin, extensions.gen_salt('bf')), 0, NULL
    );
END;
$$;

COMMENT ON FUNCTION public.admin_create_employee_with_pin(uuid, text, text, text, numeric, numeric, text, uuid) IS
    'Tạo nguyên tử hồ sơ nhân viên (chỉ cho phép vai trò employee/manager, kèm home_branch_id tùy chọn) và mã PIN chấm công; chỉ cho phép service_role thực thi.';

-- Hàm gợi ý mã nhân viên số hợp lệ tiếp theo (max + 1, sàn 1001, trần 999999); chỉ dành cho Admin đang hoạt động.
CREATE OR REPLACE FUNCTION public.suggest_next_employee_code()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
    v_max_code int;
    v_next_code int;
BEGIN
    -- Chỉ cho phép Admin đang hoạt động (is_admin kiểm tra role = 'admin' và is_active = true) thực thi.
    IF NOT COALESCE(private.is_admin(), false) THEN
        RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
    END IF;

    SELECT MAX(e.employee_code::int)
    INTO v_max_code
    FROM public.employees e
    WHERE e.employee_code ~ '^[1-9][0-9]{3,5}$';

    v_next_code := GREATEST(COALESCE(v_max_code, 1000) + 1, 1001);

    IF v_next_code > 999999 THEN
        RAISE EXCEPTION 'EMPLOYEE_CODE_EXHAUSTED' USING ERRCODE = 'P0001';
    END IF;

    RETURN v_next_code::text;
END;
$$;

COMMENT ON FUNCTION public.suggest_next_employee_code() IS
    'Gợi ý mã nhân viên số tiếp theo (max + 1, tối thiểu 1001, tối đa 999999) cho Admin đang hoạt động; không khóa hay giữ chỗ mã.';

-- Permissions
REVOKE ALL ON FUNCTION private.fn_find_orphaned_punches(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.fn_find_orphaned_punches(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.fn_calculate_payroll_base(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_calculate_payroll_base(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION private.enforce_self_shift_home_branch() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.enforce_self_shift_home_branch() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.kiosk_lookup(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kiosk_lookup(text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.kiosk_punch(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kiosk_punch(text, text, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.approve_shifts_at_branch(uuid[], uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_shifts_at_branch(uuid[], uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.approve_shifts(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_shifts(uuid[]) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.correct_punch(uuid, timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.correct_punch(uuid, timestamptz, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.add_manual_punch(uuid, uuid, text, timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_manual_punch(uuid, uuid, text, timestamptz, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.void_punch(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_punch(uuid, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.change_pin(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.change_pin(text, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.reset_pin(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reset_pin(uuid, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.new_pairing_code(text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.new_pairing_code(text, uuid, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.consume_pairing_code(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consume_pairing_code(text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.preview_timesheet(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_timesheet(uuid, uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.approve_timesheet(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_timesheet(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.admin_create_employee_with_pin(uuid, text, text, text, numeric, numeric, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_employee_with_pin(uuid, text, text, text, numeric, numeric, text, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.suggest_next_employee_code() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.suggest_next_employee_code() TO authenticated, service_role;


-- ============================================================================
-- 10. Phase 6: Phân công Manager cho Chi nhánh (Atomic RPC & Audit Log)
-- ============================================================================
-- Bảo mật: Hàm SECURITY DEFINER với search_path cố định, chỉ cho phép Admin thực thi.
-- Tính nguyên tử: Xóa phân công cũ, chèn phân công mới và ghi audit_log trong cùng một transaction.

CREATE OR REPLACE FUNCTION public.set_branch_managers(
  p_branch_id uuid,
  p_manager_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_old_ids uuid[];
  v_new_ids uuid[];
BEGIN
  -- 1. Kiểm tra quyền Admin
  IF NOT COALESCE(private.is_admin(), false) THEN
    RAISE EXCEPTION 'FORBIDDEN: Chỉ Admin mới có quyền phân công quản lý chi nhánh.';
  END IF;

  -- 2. Kiểm tra dữ liệu đầu vào: mảng NULL hoặc phần tử NULL không hợp lệ (mảng rỗng được phép)
  IF p_manager_ids IS NULL OR array_position(p_manager_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'INVALID_INPUT: Danh sách manager_ids không được NULL hoặc chứa giá trị NULL.';
  END IF;

  -- 3. Kiểm tra chi nhánh tồn tại
  IF p_branch_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.branches b WHERE b.id = p_branch_id
  ) THEN
    RAISE EXCEPTION 'NOT_FOUND: Chi nhánh không tồn tại.';
  END IF;

  -- Chuẩn hóa danh sách manager_ids (loại bỏ trùng lặp, giữ thứ tự ổn định)
  v_new_ids := COALESCE(
    ARRAY(SELECT DISTINCT m_id FROM unnest(p_manager_ids) AS m_id ORDER BY m_id),
    '{}'::uuid[]
  );

  -- 4. Xác thực tất cả nhân sự được chọn đều đang hoạt động và có vai trò manager
  IF EXISTS (
    SELECT 1
    FROM unnest(v_new_ids) AS m_id
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.employees e
      WHERE e.id = m_id
        AND e.role = 'manager'
        AND e.is_active = true
    )
  ) THEN
    RAISE EXCEPTION 'INVALID_MANAGER: Tất cả nhân sự được gán phải là manager đang hoạt động (is_active = true).';
  END IF;

  -- 5. Lấy danh sách manager_ids hiện tại của chi nhánh để ghi log
  SELECT COALESCE(array_agg(mb.manager_id ORDER BY mb.manager_id), '{}'::uuid[])
  INTO v_old_ids
  FROM public.manager_branches mb
  WHERE mb.branch_id = p_branch_id;

  -- 6. Thay thế toàn bộ phân công trong cùng transaction (nguyên tử)
  DELETE FROM public.manager_branches
  WHERE branch_id = p_branch_id;

  INSERT INTO public.manager_branches (branch_id, manager_id)
  SELECT p_branch_id, m_id
  FROM unnest(v_new_ids) AS m_id;

  -- 7. Ghi nhận lịch sử thay đổi vào audit_log
  INSERT INTO public.audit_log (actor_id, branch_id, action, old_data, new_data)
  VALUES (
    auth.uid(),
    p_branch_id,
    'assign_managers',
    to_jsonb(v_old_ids),
    to_jsonb(v_new_ids)
  );
END;
$$;

-- Phân quyền thực thi hàm: thu hồi từ PUBLIC/anon và chỉ cấp cho authenticated
REVOKE ALL ON FUNCTION public.set_branch_managers(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_branch_managers(uuid, uuid[]) TO authenticated;

-- ============================================================================
-- 11. Phase 6: RPC từ chối ca làm việc đang chờ duyệt (pending)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reject_shifts(p_shift_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
    -- RBAC: Chỉ Admin hoặc Manager mới được phép từ chối ca.
    IF COALESCE(private.my_role(), '') NOT IN ('manager', 'admin') THEN
        RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
    END IF;

    IF p_shift_ids IS NULL OR COALESCE(array_length(p_shift_ids, 1), 0) = 0 THEN
        RETURN;
    END IF;

    -- Manager chỉ được xử lý ca thuộc chi nhánh mình quản lý và không tự từ chối ca của chính mình.
    UPDATE public.shifts
    SET status = 'rejected'
    WHERE id = ANY(p_shift_ids)
      AND status = 'pending'
      AND (
          private.is_admin()
          OR (
              branch_id = ANY(private.my_branches())
              AND employee_id <> auth.uid()
          )
      );
END;
$$;

REVOKE ALL ON FUNCTION public.reject_shifts(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reject_shifts(uuid[]) TO authenticated, service_role;
