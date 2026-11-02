-- Migration: 0004_functions.sql
-- Description: Core RPC functions for Kiosk, Shifts, Punches, PIN management, Device Pairing, and Payroll.
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
    v_current_state text;
BEGIN
    SELECT id, full_name
    INTO v_employee_id, v_full_name
    FROM public.employees
    WHERE employee_code = p_employee_code;

    IF NOT FOUND THEN
        RETURN json_build_object(
            'ok', false,
            'error', 'EMPLOYEE_NOT_FOUND'
        );
    END IF;

    SELECT type::text
    INTO v_last_punch_type
    FROM public.punches
    WHERE employee_id = v_employee_id
      AND voided_at IS NULL
    ORDER BY at DESC
    LIMIT 1;

    v_current_state := CASE v_last_punch_type
        WHEN 'clock_in'    THEN 'working'
        WHEN 'break_end'   THEN 'working'
        WHEN 'break_start' THEN 'on_break'
        WHEN 'clock_out'   THEN 'off'
        ELSE 'off'
    END;

    RETURN json_build_object(
        'ok', true,
        'employee_id', v_employee_id,
        'full_name', v_full_name,
        'current_state', v_current_state
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
    v_now timestamptz := now();
BEGIN
    -- 1. Lấy employee theo code
    SELECT id INTO v_employee_id
    FROM public.employees
    WHERE employee_code = p_employee_code;

    IF NOT FOUND THEN
        RETURN json_build_object(
            'ok', false,
            'error', 'EMPLOYEE_NOT_FOUND'
        );
    END IF;

    -- 2. Lấy employee_pins và kiểm tra khóa PIN
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

    IF v_pin_record.pin_lock_until IS NOT NULL AND v_pin_record.pin_lock_until > v_now THEN
        RETURN json_build_object(
            'ok', false,
            'error', 'PIN_LOCKED',
            'unlock_at', v_pin_record.pin_lock_until
        );
    END IF;

    -- 3. So sánh PIN bằng crypt()
    IF v_pin_record.pin_hash IS NULL OR crypt(p_pin, v_pin_record.pin_hash) <> v_pin_record.pin_hash THEN
        v_failed_count := v_pin_record.pin_failed + 1;
        v_lock_until := CASE
            WHEN v_failed_count >= 5 THEN v_now + interval '15 minutes'
            ELSE v_pin_record.pin_lock_until
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

    -- 4. Nếu PIN đúng: reset bộ đếm lỗi
    IF v_pin_record.pin_failed > 0 OR v_pin_record.pin_lock_until IS NOT NULL THEN
        UPDATE public.employee_pins
        SET pin_failed = 0,
            pin_lock_until = NULL
        WHERE employee_id = v_employee_id;
    END IF;

    -- 5. Lấy device từ auth.uid()
    SELECT id, branch_id
    INTO v_device_id, v_branch_id
    FROM public.devices
    WHERE auth_user_id = auth.uid()
      AND revoked_at IS NULL;

    IF NOT FOUND THEN
        RETURN json_build_object(
            'ok', false,
            'error', 'DEVICE_REVOKED'
        );
    END IF;

    -- 6. Ghi nhận punch
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
        'at', v_now
    );
END;
$$;

-- ============================================================================
-- 3. public.approve_shifts
-- ============================================================================
CREATE OR REPLACE FUNCTION public.approve_shifts(p_shift_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
    IF COALESCE(private.my_role(), '') NOT IN ('manager', 'admin') THEN
        RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
    END IF;

    UPDATE public.shifts
    SET status = 'approved',
        approved_by = auth.uid(),
        approved_at = now()
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
BEGIN
    IF COALESCE(private.my_role(), '') NOT IN ('manager', 'admin') THEN
        RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
    END IF;

    SELECT *
    INTO v_old_punch
    FROM public.punches
    WHERE id = p_punch_id
      AND voided_at IS NULL
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'PUNCH_NOT_FOUND_OR_ALREADY_VOIDED' USING ERRCODE = 'P0002';
    END IF;

    -- Chặn tự sửa punch của chính mình và kiểm tra phân quyền chi nhánh đối với manager
    IF v_old_punch.employee_id = auth.uid() THEN
        RAISE EXCEPTION 'CANNOT_CORRECT_OWN_PUNCH' USING ERRCODE = '42501';
    END IF;

    IF NOT private.is_admin() AND NOT (v_old_punch.branch_id = ANY(private.my_branches())) THEN
        RAISE EXCEPTION 'FORBIDDEN_BRANCH' USING ERRCODE = '42501';
    END IF;

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
        p_reason,
        p_punch_id
    )
    RETURNING id INTO v_new_punch_id;

    RETURN v_new_punch_id;
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
    v_now timestamptz := now();
BEGIN
    IF v_uid IS NULL THEN
        RETURN json_build_object(
            'ok', false,
            'error', 'UNAUTHORIZED'
        );
    END IF;

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

    IF v_pin_record.pin_lock_until IS NOT NULL AND v_pin_record.pin_lock_until > v_now THEN
        RETURN json_build_object(
            'ok', false,
            'error', 'PIN_LOCKED',
            'unlock_at', v_pin_record.pin_lock_until
        );
    END IF;

    IF v_pin_record.pin_hash IS NULL OR crypt(p_old_pin, v_pin_record.pin_hash) <> v_pin_record.pin_hash THEN
        v_failed_count := v_pin_record.pin_failed + 1;
        v_lock_until := CASE
            WHEN v_failed_count >= 5 THEN v_now + interval '15 minutes'
            ELSE v_pin_record.pin_lock_until
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

    UPDATE public.employee_pins
    SET pin_hash = crypt(p_new_pin, gen_salt('bf')),
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
    IF NOT private.is_admin() THEN
        RETURN json_build_object(
            'ok', false,
            'error', 'FORBIDDEN'
        );
    END IF;

    INSERT INTO public.employee_pins (
        employee_id,
        pin_hash,
        pin_failed,
        pin_lock_until
    ) VALUES (
        p_employee_id,
        crypt(p_new_pin, gen_salt('bf')),
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
-- 8. Payroll Calculations
-- ============================================================================
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
    total_allowance numeric,
    total_salary numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
    v_start timestamptz;
    v_end   timestamptz;
BEGIN
    SELECT make_timestamptz(pp.year, pp.month, 1, 0, 0, 0, 'Asia/Ho_Chi_Minh')
    INTO v_start
    FROM public.payroll_periods pp
    WHERE pp.id = p_period_id;

    IF v_start IS NULL THEN
        RAISE EXCEPTION 'PAYROLL_PERIOD_NOT_FOUND: %', p_period_id;
    END IF;

    v_end := v_start + interval '1 month';

    RETURN QUERY
    WITH paired_punches AS (
        SELECT
            p.employee_id,
            p.type,
            p.at AS in_at,
            LEAD(p.at) OVER (PARTITION BY p.employee_id ORDER BY p.at) AS out_at,
            LEAD(p.type) OVER (PARTITION BY p.employee_id ORDER BY p.at) AS next_type
        FROM public.punches p
        WHERE p.voided_at IS NULL
          AND p.at >= v_start AND p.at < v_end
          AND (p_employee_id IS NULL OR p.employee_id = p_employee_id)
    ),
    valid_sessions AS (
        SELECT
            pp.employee_id,
            pp.in_at,
            pp.out_at,
            (pp.in_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS work_date,
            EXTRACT(EPOCH FROM (pp.out_at - pp.in_at)) / 60.0 AS session_minutes,
            (EXTRACT(HOUR FROM (pp.in_at AT TIME ZONE 'Asia/Ho_Chi_Minh')) >= 22
             OR EXTRACT(HOUR FROM (pp.out_at AT TIME ZONE 'Asia/Ho_Chi_Minh')) <= 6) AS is_night,
            EXISTS (
                SELECT 1 FROM public.holidays h
                WHERE h.date = (pp.in_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
            ) AS is_holiday
        FROM paired_punches pp
        WHERE pp.type = 'clock_in' AND pp.next_type = 'clock_out'
          AND pp.out_at > pp.in_at
          AND pp.out_at <= pp.in_at + interval '24 hours'
    ),
    summary AS (
        SELECT
            vs.employee_id,
            COALESCE(SUM(CASE WHEN NOT vs.is_holiday AND NOT vs.is_night THEN LEAST(vs.session_minutes, 480)::int ELSE 0 END), 0) AS reg_day,
            COALESCE(SUM(CASE WHEN NOT vs.is_holiday AND vs.is_night THEN LEAST(vs.session_minutes, 480)::int ELSE 0 END), 0) AS reg_night,
            COALESCE(SUM(CASE WHEN NOT vs.is_holiday AND NOT vs.is_night THEN GREATEST(vs.session_minutes - 480, 0)::int ELSE 0 END), 0) AS ot_day,
            COALESCE(SUM(CASE WHEN NOT vs.is_holiday AND vs.is_night THEN GREATEST(vs.session_minutes - 480, 0)::int ELSE 0 END), 0) AS ot_night,
            COALESCE(SUM(CASE WHEN vs.is_holiday AND NOT vs.is_night THEN vs.session_minutes::int ELSE 0 END), 0) AS hol_day,
            COALESCE(SUM(CASE WHEN vs.is_holiday AND vs.is_night THEN vs.session_minutes::int ELSE 0 END), 0) AS hol_night
        FROM valid_sessions vs
        GROUP BY vs.employee_id
    ),
    allowances AS (
        SELECT ma.employee_id, SUM(ma.amount) AS total_amount
        FROM public.monthly_allowances ma
        WHERE ma.period_id = p_period_id
          AND (p_employee_id IS NULL OR ma.employee_id = p_employee_id)
        GROUP BY ma.employee_id
    )
    SELECT
        e.id AS employee_id,
        COALESCE(e.hourly_rate, 0) AS hourly_rate_snapshot,
        COALESCE(e.fixed_allowance, 0) AS fixed_allowance_snapshot,
        COALESCE(s.reg_day, 0) AS minutes_regular_day,
        COALESCE(s.reg_night, 0) AS minutes_regular_night,
        COALESCE(s.ot_day, 0) AS minutes_ot_day,
        COALESCE(s.ot_night, 0) AS minutes_ot_night,
        COALESCE(s.hol_day, 0) AS minutes_holiday_day,
        COALESCE(s.hol_night, 0) AS minutes_holiday_night,
        COALESCE(al.total_amount, 0) AS total_allowance,
        ROUND(
            (
                (COALESCE(s.reg_day, 0) / 60.0 * 1.0) +
                (COALESCE(s.reg_night, 0) / 60.0 * 1.3) +
                (COALESCE(s.ot_day, 0) / 60.0 * 1.5) +
                (COALESCE(s.ot_night, 0) / 60.0 * 1.8) +
                (COALESCE(s.hol_day, 0) / 60.0 * 2.0) +
                (COALESCE(s.hol_night, 0) / 60.0 * 2.3)
            ) * COALESCE(e.hourly_rate, 0)
            + COALESCE(e.fixed_allowance, 0)
            + COALESCE(al.total_amount, 0)
        , 0) AS total_salary
    FROM public.employees e
    LEFT JOIN summary s ON s.employee_id = e.id
    LEFT JOIN allowances al ON al.employee_id = e.id
    WHERE (p_employee_id IS NULL OR e.id = p_employee_id)
      AND (s.employee_id IS NOT NULL OR al.employee_id IS NOT NULL OR e.fixed_allowance > 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.preview_timesheet(
    p_period_id uuid,
    p_employee_id uuid DEFAULT NULL
)
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
    SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json)
    FROM public.fn_calculate_payroll_base(p_period_id, p_employee_id) t;
$$;

CREATE OR REPLACE FUNCTION public.approve_timesheet(p_period_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
    v_status text;
BEGIN
    IF NOT private.is_admin() THEN
        RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
    END IF;

    SELECT status INTO v_status
    FROM public.payroll_periods
    WHERE id = p_period_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'PERIOD_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;

    IF v_status = 'approved' THEN
        RAISE EXCEPTION 'PERIOD_ALREADY_APPROVED' USING ERRCODE = 'P0001';
    END IF;

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
        now()
    FROM public.fn_calculate_payroll_base(p_period_id, NULL)
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

-- Permissions
REVOKE ALL ON FUNCTION public.kiosk_lookup(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kiosk_lookup(text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.kiosk_punch(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kiosk_punch(text, text, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.approve_shifts(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_shifts(uuid[]) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.correct_punch(uuid, timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.correct_punch(uuid, timestamptz, text) TO authenticated, service_role;

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
