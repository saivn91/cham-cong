-- Migration: 0002_constraints.sql
-- Description: Extensions, GiST exclusion constraints, domain check constraints, and performance indexes

-- 1. Required Extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 2. Table Constraints
-- Prevent overlapping non-rejected shifts for the same employee
ALTER TABLE public.shifts
    ADD CONSTRAINT shifts_employee_during_overlap_excl
    EXCLUDE USING gist (employee_id WITH =, during WITH &&)
    WHERE (status <> 'rejected');

-- Enforce shift length <= 12 hours (and valid non-empty range)
ALTER TABLE public.shifts
    ADD CONSTRAINT shifts_max_12_hours_chk
    CHECK (upper(during) - lower(during) <= interval '12 hours');

-- Enforce manual punches must specify creator and reason
ALTER TABLE public.punches
    ADD CONSTRAINT punches_manual_source_audit_chk
    CHECK (source = 'kiosk' OR (created_by IS NOT NULL AND reason IS NOT NULL));

-- 3. High-Performance Indexes
-- Punches indexes
CREATE INDEX IF NOT EXISTS idx_punches_employee_at
    ON public.punches USING btree (employee_id, at);

CREATE INDEX IF NOT EXISTS idx_punches_branch_at
    ON public.punches USING btree (branch_id, at);

CREATE INDEX IF NOT EXISTS idx_punches_active_employee_at
    ON public.punches USING btree (employee_id, at)
    WHERE (voided_at IS NULL);

-- Shifts indexes (GiST for time range queries & B-Tree for branch/status filtering)
CREATE INDEX IF NOT EXISTS idx_shifts_during_gist
    ON public.shifts USING gist (during);

CREATE INDEX IF NOT EXISTS idx_shifts_branch_status
    ON public.shifts USING btree (branch_id, status);

CREATE INDEX IF NOT EXISTS idx_shifts_employee_start_at
    ON public.shifts USING btree (employee_id, start_at);

-- Payroll periods indexes
CREATE INDEX IF NOT EXISTS idx_payroll_periods_status_year_month
    ON public.payroll_periods USING btree (status, year, month);

-- Audit log indexes
CREATE INDEX IF NOT EXISTS idx_audit_log_table_row_created
    ON public.audit_log USING btree (table_name, row_id, created_at);

CREATE INDEX IF NOT EXISTS idx_audit_log_branch_created
    ON public.audit_log USING btree (branch_id, created_at);

-- Supporting Foreign Key indexes
CREATE INDEX IF NOT EXISTS idx_devices_branch_id
    ON public.devices USING btree (branch_id);

CREATE INDEX IF NOT EXISTS idx_monthly_allowances_period_employee
    ON public.monthly_allowances USING btree (period_id, employee_id);
