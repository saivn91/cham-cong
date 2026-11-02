-- Migration: 0001_tables.sql
-- Description: Core 14 tables for Attendance & Payroll System (PostgreSQL 17 / Supabase)

-- 1. branches
CREATE TABLE IF NOT EXISTS public.branches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code text UNIQUE,
    name text,
    address text,
    created_at timestamptz DEFAULT now()
);

-- 2. employees
CREATE TABLE IF NOT EXISTS public.employees (
    id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    employee_code text UNIQUE,
    full_name text,
    role text DEFAULT 'employee' CHECK (role IN ('employee', 'manager', 'admin')),
    hourly_rate numeric NOT NULL DEFAULT 0 CHECK (hourly_rate >= 0),
    fixed_allowance numeric NOT NULL DEFAULT 0 CHECK (fixed_allowance >= 0),
    is_active boolean DEFAULT true,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- 3. employee_pins
CREATE TABLE IF NOT EXISTS public.employee_pins (
    employee_id uuid PRIMARY KEY REFERENCES public.employees(id) ON DELETE CASCADE,
    pin_hash text,
    pin_failed int DEFAULT 0,
    pin_lock_until timestamptz,
    updated_at timestamptz DEFAULT now()
);

-- 4. manager_branches
CREATE TABLE IF NOT EXISTS public.manager_branches (
    manager_id uuid REFERENCES public.employees(id) ON DELETE CASCADE,
    branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
    PRIMARY KEY (manager_id, branch_id)
);

-- 5. devices
CREATE TABLE IF NOT EXISTS public.devices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
    branch_id uuid NOT NULL REFERENCES public.branches(id),
    name text,
    revoked_at timestamptz,
    created_at timestamptz DEFAULT now()
);

-- 6. device_pairings
CREATE TABLE IF NOT EXISTS public.device_pairings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code_hash text UNIQUE NOT NULL,
    device_id uuid REFERENCES public.devices(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
    used_at timestamptz,
    created_at timestamptz DEFAULT now()
);

-- 7. shift_templates
CREATE TABLE IF NOT EXISTS public.shift_templates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id uuid REFERENCES public.branches(id),
    name text,
    start_time time NOT NULL,
    end_time time NOT NULL,
    created_at timestamptz DEFAULT now()
);

-- 8. shifts
CREATE TABLE IF NOT EXISTS public.shifts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
    branch_id uuid NOT NULL REFERENCES public.branches(id),
    during tstzrange NOT NULL,
    start_at timestamptz GENERATED ALWAYS AS (lower(during)) STORED,
    end_at timestamptz GENERATED ALWAYS AS (upper(during)) STORED,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    note text,
    approved_by uuid REFERENCES auth.users(id),
    approved_at timestamptz,
    created_at timestamptz DEFAULT now()
);

-- 9. punches
CREATE TABLE IF NOT EXISTS public.punches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id uuid NOT NULL REFERENCES public.employees(id),
    device_id uuid REFERENCES public.devices(id),
    branch_id uuid NOT NULL REFERENCES public.branches(id),
    type text NOT NULL CHECK (type IN ('clock_in', 'break_start', 'break_end', 'clock_out')),
    at timestamptz NOT NULL DEFAULT now(),
    source text NOT NULL CHECK (source IN ('kiosk', 'manual')),
    created_by uuid REFERENCES auth.users(id),
    reason text,
    corrects_punch_id uuid REFERENCES public.punches(id),
    voided_at timestamptz,
    voided_by uuid REFERENCES auth.users(id),
    created_at timestamptz DEFAULT now()
);

-- 10. payroll_periods
CREATE TABLE IF NOT EXISTS public.payroll_periods (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    year int NOT NULL,
    month int NOT NULL,
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved')),
    approved_by uuid REFERENCES auth.users(id),
    approved_at timestamptz,
    created_at timestamptz DEFAULT now(),
    UNIQUE (year, month)
);

-- 11. monthly_allowances
CREATE TABLE IF NOT EXISTS public.monthly_allowances (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    period_id uuid NOT NULL REFERENCES public.payroll_periods(id),
    employee_id uuid NOT NULL REFERENCES public.employees(id),
    amount numeric NOT NULL CHECK (amount > 0),
    reason text NOT NULL CHECK (reason <> ''),
    created_by uuid REFERENCES auth.users(id),
    created_at timestamptz DEFAULT now()
);

-- 12. payroll
CREATE TABLE IF NOT EXISTS public.payroll (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    period_id uuid NOT NULL REFERENCES public.payroll_periods(id),
    employee_id uuid NOT NULL REFERENCES public.employees(id),
    hourly_rate_snapshot numeric NOT NULL,
    fixed_allowance_snapshot numeric NOT NULL,
    minutes_regular_day int NOT NULL DEFAULT 0,
    minutes_regular_night int NOT NULL DEFAULT 0,
    minutes_ot_day int NOT NULL DEFAULT 0,
    minutes_ot_night int NOT NULL DEFAULT 0,
    minutes_holiday_day int NOT NULL DEFAULT 0,
    minutes_holiday_night int NOT NULL DEFAULT 0,
    total_allowance numeric NOT NULL DEFAULT 0,
    total_salary numeric NOT NULL,
    calculated_at timestamptz DEFAULT now(),
    UNIQUE (period_id, employee_id)
);

-- 13. holidays
CREATE TABLE IF NOT EXISTS public.holidays (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    date date NOT NULL UNIQUE,
    name text NOT NULL,
    rate numeric NOT NULL DEFAULT 2.0,
    created_at timestamptz DEFAULT now()
);

-- 14. audit_log
CREATE TABLE IF NOT EXISTS public.audit_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    table_name text NOT NULL,
    row_id uuid,
    action text NOT NULL,
    old_data jsonb,
    new_data jsonb,
    actor_id uuid REFERENCES auth.users(id),
    branch_id uuid REFERENCES public.branches(id),
    created_at timestamptz DEFAULT now()
);
